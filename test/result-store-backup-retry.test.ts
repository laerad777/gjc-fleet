// L-1 regression: a backup killed at any step leaves nothing that silently blocks a retry to the same
// destination. The retry removes only the leftovers it can prove a dead backup of this tool created (staging
// `DEST.backup-<token>` with an intact ownership record naming that token and DEST, and the unpublished
// DEST.results whose identity that record holds); for anything else it refuses with BACKUP_LEFTOVER naming
// exactly what to remove. It never overwrites or removes an existing destination.
import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "backup-retry-"));
	dirs.push(dir);
	return dir;
}
const child = join(import.meta.dir, "fixtures", "result-crash-child.ts");
const node = { id: "node", os: "linux", arch: "arm64", roots: { repo: "/repos/repo" }, workspaceRoot: "/work", maxConcurrency: 1, enabled: true, draining: false,
	reachable: true, sdkReady: true, modelReady: true, models: ["model"], transport: { command: "gjc", args: ["acp"] }, operations: ["read", "write"] };
const input = (key: string) => ({ schemaVersion: 1, key, caller: "actor", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} });
/** A source with two results: inline (switch off, production v2) or externalised (after the one-way step, v3). */
function source(dir: string, mode: "off" | "v3"): string {
	const path = join(dir, `source-${mode}.sqlite`);
	const store = new FleetStore(path);
	try {
		if (mode === "v3") store.enableResultStore({ actor: "tester", reason: "backup retry test" });
		store.putNode(node as any);
		for (const key of ["a", "b"]) {
			const task = store.reserve(store.submit(input(key) as any).id)!;
			store.recordSession(task.id, `session-${key}`);
			store.recordTurn(task.id, `turn-${key}`);
			store.saveResult(task.id, { status: "verified", patch: `+${key}\n`.repeat(3000) });
		}
		store.submit(input("queued") as any);
	} finally {
		store.close();
	}
	return path;
}
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const code = (fn: () => unknown): { code: string; message: string } => {
	try {
		fn();
		return { code: "ok", message: "" };
	} catch (error) {
		return { code: (error as { code?: string }).code ?? String(error), message: (error as Error).message };
	}
};
const named = (message: string): string[] => JSON.parse(message.slice(message.indexOf("remove exactly ") + "remove exactly ".length));
/** Every path below a directory with its bytes, "dir" or its link target: proves what a call did not touch. */
function tree(path: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (p: string) => {
		const stat = lstatSync(p);
		if (stat.isSymbolicLink()) out[p] = `link:${readlinkSync(p)}`;
		else if (stat.isDirectory()) {
			out[p] = "dir";
			for (const name of readdirSync(p)) walk(join(p, name));
		} else out[p] = sha(p);
	};
	if (existsSync(path)) walk(path);
	return out;
}
/** DEST is a complete, openable backup of the source: equal tasks (results read and verified), single link. */
function complete(dest: string, expected: unknown, mode: "off" | "v3"): void {
	expect(statSync(dest).nlink).toBe(1);
	expect(existsSync(`${dest}.results`)).toBe(mode === "v3");
	const copy = new FleetStore(dest, 2, { readOnly: true });
	try {
		expect(copy.tasks()).toEqual(expected as any);
		expect(copy.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [], unreferenced: [], temporary: [], unknown: [] });
	} finally {
		copy.close();
	}
}

for (const mode of ["off", "v3"] as const) {
	test(`L-1 (${mode}): a backup killed before or after every fs/SQLite step is retried to the same destination: cleaned and completed, or refused naming exactly what to remove; never overwritten`, () => {
		const dir = fixture();
		const src = source(dir, mode);
		const store = new FleetStore(src);
		const expected = store.tasks();
		try {
			const dry = join(dir, "dry");
			mkdirSync(dry);
			const counted = Bun.spawnSync([process.execPath, child, src, join(dry, "b.sqlite")], {
				env: { ...process.env, RESULT_MODE: "backup", RESULT_POINT: "none", RESULT_STEP: "0" }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
			expect(counted.exitCode).toBe(0);
			const steps = Number(/STEPS (\d+)/.exec(counted.stdout.toString())?.[1]);
			expect(steps).toBeGreaterThan(mode === "off" ? 20 : 40);
			const outcomes: Record<string, number> = {};
			const refusals: Record<number, string[]> = {};
			let cleanedResults = 0;
			let cleanedStaging = 0;
			for (let k = 1; k <= steps; k++) {
				const parent = join(dir, `k${k}`);
				mkdirSync(parent);
				const dest = join(parent, "b.sqlite");
				// Decoys a retry must never touch: a non-token name with the staging prefix, another
				// destination's staging directory, an unrelated file.
				writeFileSync(`${dest}.backup-notes`, "operator notes");
				const otherToken = randomUUID();
				mkdirSync(join(parent, `other.sqlite.backup-${otherToken}`));
				writeFileSync(join(parent, `other.sqlite.backup-${otherToken}`, "owner.json"), JSON.stringify({ tool: "gjc-fleet-backup", token: otherToken, destination: join(parent, "other.sqlite"), host: hostname(), pid: 999999 }));
				writeFileSync(join(parent, "unrelated.txt"), "keep");
				const run = Bun.spawnSync([process.execPath, child, src, dest], {
					env: { ...process.env, RESULT_MODE: "backup", RESULT_POINT: "none", RESULT_STEP: String(k) }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
				expect(`${mode}/${k}:${run.exitCode}`).toBe(`${mode}/${k}:137`);
				const decoys = { notes: sha(`${dest}.backup-notes`), others: readdirSync(parent).filter((n) => n.startsWith("other.sqlite.backup-")), unrelated: sha(join(parent, "unrelated.txt")) };
				const published = existsSync(dest) ? sha(dest) : undefined;
				const leftStaging = readdirSync(parent).filter((n) => n.startsWith("b.sqlite.backup-") && n !== "b.sqlite.backup-notes");
				const orphanResults = !published && existsSync(`${dest}.results`);
				const beforeRetry = tree(parent);
				let attempt = code(() => store.backup(dest));
				let outcome = attempt.code;
				if (attempt.code === "BACKUP_LEFTOVER") {
					const paths = named(attempt.message);
					refusals[k] = paths.map((p) => p.slice(parent.length + 1));
					expect(paths.length).toBeGreaterThan(0);
					// Only staging names of this destination or DEST.results are ever named, each untouched.
					for (const p of paths) {
						expect(p === `${dest}.results` || /^b\.sqlite\.backup-[0-9a-f-]{36}$/.test(p.slice(parent.length + 1))).toBe(true);
						for (const [q, value] of Object.entries(beforeRetry)) if (q === p || q.startsWith(`${p}/`)) expect(tree(parent)[q]).toBe(value);
					}
					for (const p of paths) rmSync(p, { recursive: true });
					attempt = code(() => store.backup(dest));
					outcome = `BACKUP_LEFTOVER→${attempt.code}`;
				}
				if (published) {
					// Published by the killed run (after its exclusive link): kept byte-identical, never overwritten.
					expect(`${k}:${attempt.code}`).toBe(`${k}:BACKUP_EXISTS`);
					expect(sha(dest)).toBe(published);
				} else expect(`${k}:${attempt.code}`).toBe(`${k}:ok`);
				if (leftStaging.length > 0 && !refusals[k]) cleanedStaging++;
				if (orphanResults && !refusals[k]) cleanedResults++;
				outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
				complete(dest, expected, mode);
				// Nothing of the killed run is left, and every decoy is untouched.
				expect(readdirSync(parent).filter((n) => n.startsWith("b.sqlite.backup-") && n !== "b.sqlite.backup-notes")).toEqual([]);
				expect({ notes: sha(`${dest}.backup-notes`), others: readdirSync(parent).filter((n) => n.startsWith("other.sqlite.backup-")), unrelated: sha(join(parent, "unrelated.txt")) }).toEqual(decoys);
				// A further retry never overwrites the completed destination.
				const done = sha(dest);
				expect(code(() => store.backup(dest)).code).toBe("BACKUP_EXISTS");
				expect(sha(dest)).toBe(done);
			}
			expect(outcomes.ok).toBeGreaterThan(0);
			expect(outcomes.BACKUP_EXISTS).toBeGreaterThan(0);
			expect(cleanedStaging).toBeGreaterThan(0);
			if (mode === "v3") expect(cleanedResults).toBeGreaterThan(0);
			console.log(`BACKUP-KILL-SUMMARY ${mode} ${JSON.stringify({ steps, outcomes, cleanedStaging, cleanedResults, refusals })}`);
		} finally {
			store.close();
		}
	}, 600_000);
}

test("L-1: only provably owned leftovers are removed; possibly live, foreign, altered or unrecorded ones are named and left untouched", () => {
	const dir = fixture();
	const src = source(dir, "v3");
	const store = new FleetStore(src);
	const expected = store.tasks();
	const dead = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"], { stdout: "pipe" });
	const deadPid = Number(dead.stdout.toString().trim());
	const live = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60000)"], { stdout: "ignore" });
	try {
		let n = 0;
		type Scenario = { parent: string; dest: string; staging: string };
		const scenario = (setup: (s: Scenario, owner: (patch?: Record<string, unknown>) => void) => void): Scenario => {
			const parent = join(dir, `s${n++}`);
			mkdirSync(parent);
			const dest = join(parent, "b.sqlite");
			const token = randomUUID();
			const staging = `${dest}.backup-${token}`;
			mkdirSync(staging, { mode: 0o700 });
			writeFileSync(join(staging, "snapshot.sqlite"), "partial snapshot");
			const owner = (patch: Record<string, unknown> = {}) =>
				writeFileSync(join(staging, "owner.json"), JSON.stringify({ tool: "gjc-fleet-backup", token, destination: dest, host: hostname(), pid: deadPid, ...patch }));
			const s = { parent, dest, staging };
			setup(s, owner);
			return s;
		};
		const results = (s: Scenario, record: "match" | "none" | "other") => {
			writeFileSync(join(s.staging, "results.intent"), "");
			mkdirSync(`${s.dest}.results`, { mode: 0o700 });
			mkdirSync(join(`${s.dest}.results`, "f".repeat(64)));
			const stat = lstatSync(`${s.dest}.results`, { bigint: true });
			if (record === "match") writeFileSync(join(s.staging, "results.owner"), `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
			if (record === "other") writeFileSync(join(s.staging, "results.owner"), `${stat.dev}:${stat.ino + 1n}:${stat.birthtimeNs}`);
		};
		const refused = (s: Scenario, paths: string[]) => {
			const before = tree(s.parent);
			const r = code(() => store.backup(s.dest));
			expect(r.code).toBe("BACKUP_LEFTOVER");
			expect(named(r.message)).toEqual(paths);
			expect(r.message).toContain("make sure no backup is running");
			expect(tree(s.parent)).toEqual(before);
			expect(existsSync(s.dest)).toBe(false);
		};
		// Proven: a dead process's record for this token and destination, only backup-written files.
		const proven = scenario((_s, owner) => owner());
		expect(code(() => store.backup(proven.dest)).code).toBe("ok");
		expect(existsSync(proven.staging)).toBe(false);
		complete(proven.dest, expected, "v3");
		// Proven with its recorded, unpublished DEST.results (identity matches): both removed, then completed.
		const orphan = scenario((s, owner) => (owner(), results(s, "match")));
		expect(code(() => store.backup(orphan.dest)).code).toBe("ok");
		expect(existsSync(orphan.staging)).toBe(false);
		complete(orphan.dest, expected, "v3");
		// Named exactly, nothing touched.
		const cases: [string, (s: Scenario, owner: (patch?: Record<string, unknown>) => void) => void, (s: Scenario) => string[]][] = [
			["live pid", (_s, owner) => owner({ pid: live.pid }), (s) => [s.staging]],
			["this process", (_s, owner) => owner({ pid: process.pid }), (s) => [s.staging]],
			["other host", (_s, owner) => owner({ host: `${hostname()}-other` }), (s) => [s.staging]],
			["other destination", (s, owner) => owner({ destination: join(s.parent, "c.sqlite") }), (s) => [s.staging]],
			["other token", (_s, owner) => owner({ token: randomUUID() }), (s) => [s.staging]],
			["other tool", (_s, owner) => owner({ tool: "something-else" }), (s) => [s.staging]],
			["no record", () => {}, (s) => [s.staging]],
			["torn record", (s) => writeFileSync(join(s.staging, "owner.json"), '{"tool":"gjc-fleet-ba'), (s) => [s.staging]],
			["unexpected file", (s, owner) => (owner(), writeFileSync(join(s.staging, "operator.txt"), "mine")), (s) => [s.staging]],
			["unexpected directory", (s, owner) => (owner(), mkdirSync(join(s.staging, "snapshot.sqlite-wal"))), (s) => [s.staging]],
			["results created, identity not recorded", (s, owner) => (owner(), results(s, "none")), (s) => [`${s.dest}.results`, s.staging]],
			["results replaced after the record", (s, owner) => (owner(), results(s, "other")), (s) => [`${s.dest}.results`, s.staging]],
			["live pid with results intent", (s, owner) => (owner({ pid: live.pid }), results(s, "match")), (s) => [`${s.dest}.results`, s.staging]],
		];
		for (const [name, setup, paths] of cases) {
			const s = scenario(setup);
			try {
				refused(s, paths(s));
			} catch (error) {
				throw new Error(`${name}: ${(error as Error).message}`);
			}
		}
		// A staging name that is not this tool's token shape is not considered at all (never named or removed).
		const parent = join(dir, "shape");
		mkdirSync(parent);
		mkdirSync(join(parent, "b.sqlite.backup-old"));
		expect(code(() => store.backup(join(parent, "b.sqlite"))).code).toBe("ok");
		expect(existsSync(join(parent, "b.sqlite.backup-old"))).toBe(true);
		// A DEST.results without any staging directory is refused as before and never merged or removed.
		const foreign = join(dir, "foreign");
		mkdirSync(join(foreign, "b.sqlite.results"), { recursive: true });
		writeFileSync(join(foreign, "b.sqlite.results", "keep"), "operator");
		expect(code(() => store.backup(join(foreign, "b.sqlite")))).toEqual({ code: "BACKUP_EXISTS", message: "backup_destination_exists" });
		expect(readFileSync(join(foreign, "b.sqlite.results", "keep"), "utf8")).toBe("operator");
	} finally {
		live.kill();
		store.close();
	}
});

/**
 * A dead backup's leftovers for DEST in their own directory: its staging directory with an intact ownership
 * record (dead pid), and the DEST.results it recorded creating (identity matching), holding `blobs`.
 */
function deadLeftover(parent: string, blobs: Record<string, Buffer | null>, publishIntent = false) {
	mkdirSync(parent);
	const dest = join(parent, "b.sqlite");
	const token = randomUUID();
	const staging = `${dest}.backup-${token}`;
	const dead = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"], { stdout: "pipe" });
	mkdirSync(staging, { mode: 0o700 });
	writeFileSync(join(staging, "owner.json"), JSON.stringify({ tool: "gjc-fleet-backup", token, destination: dest, host: hostname(), pid: Number(dead.stdout.toString().trim()) }));
	writeFileSync(join(staging, "snapshot.sqlite"), "partial snapshot");
	writeFileSync(join(staging, "results.intent"), "");
	const results = `${dest}.results`;
	mkdirSync(results, { mode: 0o700 });
	const stat = lstatSync(results, { bigint: true });
	writeFileSync(join(staging, "results.owner"), `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`);
	if (publishIntent) writeFileSync(join(staging, "publish.intent"), "");
	for (const [name, bytes] of Object.entries(blobs)) {
		mkdirSync(join(results, name));
		if (bytes) writeFileSync(join(results, name, "data"), bytes);
	}
	return { parent, dest, staging, results };
}
const blob = (text: string) => {
	const bytes = Buffer.from(text);
	return { [createHash("sha256").update(bytes).digest("hex")]: bytes };
};

test("L-2: a retry removes a dead backup's unpublished DEST.results only entry by entry, and only when it holds nothing but the blobs backup writes", () => {
	const dir = fixture();
	const src = source(dir, "v3");
	const store = new FleetStore(src);
	const expected = store.tasks();
	try {
		// Only backup-written entries: published blobs, an empty blob directory and a killed write's temporary
		// directory (with and without its partial data): all removed, then the backup completes.
		const own = deadLeftover(join(dir, "own"), { ...blob("first"), ...blob("second"), ["e".repeat(64)]: null, [`${"c".repeat(64)}.tmp-Ab12Cd`]: Buffer.from("par"), [`${"d".repeat(64)}.tmp-Zz9900`]: null });
		expect(code(() => store.backup(own.dest)).code).toBe("ok");
		expect(existsSync(own.staging)).toBe(false);
		complete(own.dest, expected, "v3");
		// Anything else inside it: refused naming exactly DEST.results and the staging directory; nothing touched.
		const outside = join(dir, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "user.txt"), "operator file");
		mkdirSync(join(outside, "user-dir"));
		writeFileSync(join(outside, "user-dir", "keep.txt"), "operator dir");
		const one = Object.keys(blob("first"))[0]!;
		const cases: [string, (results: string) => void][] = [
			["foreign file", (r) => writeFileSync(join(r, "added-by-user"), "mine")],
			["foreign directory", (r) => (mkdirSync(join(r, "notes")), writeFileSync(join(r, "notes", "n.txt"), "mine"))],
			["empty foreign directory", (r) => mkdirSync(join(r, "notes"))],
			["symlink to a directory", (r) => symlinkSync(join(outside, "user-dir"), join(r, "link"))],
			["symlink with a blob name to a directory", (r) => symlinkSync(join(outside, "user-dir"), join(r, "a".repeat(64)))],
			["symlink as a blob's data", (r) => (mkdirSync(join(r, "b".repeat(64))), symlinkSync(join(outside, "user.txt"), join(r, "b".repeat(64), "data")))],
			["blob data of other bytes", (r) => writeFileSync(join(r, one, "data"), "not these bytes")],
			["foreign file inside a blob directory", (r) => writeFileSync(join(r, one, "extra"), "mine")],
			["foreign directory as a blob's data", (r) => mkdirSync(join(r, "9".repeat(64), "data"), { recursive: true })],
			["foreign file inside a temporary directory", (r) => (mkdirSync(join(r, `${"c".repeat(64)}.tmp-Ab12Cd`)), writeFileSync(join(r, `${"c".repeat(64)}.tmp-Ab12Cd`, "other"), "mine"))],
		];
		let n = 0;
		for (const [name, add] of cases) {
			const s = deadLeftover(join(dir, `case${n++}`), blob("first"));
			add(s.results);
			const before = { ...tree(s.parent), ...tree(outside) };
			const r = code(() => store.backup(s.dest));
			expect({ name, code: r.code, named: r.code === "BACKUP_LEFTOVER" ? named(r.message) : [] }).toEqual({ name, code: "BACKUP_LEFTOVER", named: [s.results, s.staging] });
			expect({ name, tree: { ...tree(s.parent), ...tree(outside) } }).toEqual({ name, tree: before });
			expect(existsSync(s.dest)).toBe(false);
		}
	} finally {
		store.close();
	}
});

test("I-5: a DEST published from a dead backup's staging and then moved away keeps its DEST.results: the retry refuses naming it, never deletes it", () => {
	const dir = fixture();
	const src = source(dir, "v3");
	const store = new FleetStore(src);
	try {
		// Recorded publish intent, DEST absent: refused, nothing touched.
		const s = deadLeftover(join(dir, "intent"), blob("first"), true);
		const before = tree(s.parent);
		const r = code(() => store.backup(s.dest));
		expect({ code: r.code, named: named(r.message) }).toEqual({ code: "BACKUP_LEFTOVER", named: [s.results, s.staging] });
		expect(r.message).toContain(`${s.results} may hold the results of a published backup whose database was moved away: keep it with that database (move it, do not delete it)`);
		expect(tree(s.parent)).toEqual(before);
		// A real backup killed after publishing DEST (exclusive link) and before removing its staging; the
		// operator then moves DEST away without its results (review S6).
		const dry = join(dir, "dry");
		mkdirSync(dry);
		const counted = Bun.spawnSync([process.execPath, child, src, join(dry, "b.sqlite")], {
			env: { ...process.env, RESULT_MODE: "backup", RESULT_POINT: "none", RESULT_STEP: "0" }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
		const steps = Number(/STEPS (\d+)/.exec(counted.stdout.toString())?.[1]);
		let found = 0;
		for (let k = 1; k <= steps; k++) {
			const parent = join(dir, `k${k}`);
			mkdirSync(parent);
			const dest = join(parent, "b.sqlite");
			const run = Bun.spawnSync([process.execPath, child, src, dest], {
				env: { ...process.env, RESULT_MODE: "backup", RESULT_POINT: "none", RESULT_STEP: String(k) }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
			expect(run.exitCode).toBe(137);
			const staging = readdirSync(parent).filter((name) => name.startsWith("b.sqlite.backup-"));
			if (!existsSync(dest) || staging.length !== 1 || !existsSync(join(parent, staging[0]!, "results.owner"))) continue;
			found++;
			const moved = join(parent, "moved.sqlite");
			renameSync(dest, moved);
			const kept = tree(`${dest}.results`);
			const retry = code(() => store.backup(dest));
			expect({ k, code: retry.code, named: named(retry.message) }).toEqual({ k, code: "BACKUP_LEFTOVER", named: [`${dest}.results`, join(parent, staging[0]!)] });
			expect(retry.message).toContain("do not delete it");
			expect(tree(`${dest}.results`)).toEqual(kept);
			// The operator follows the message: the results go with the moved DEST, which is then the complete
			// backup; the staging directory is removed and a retry to DEST completes.
			renameSync(`${dest}.results`, `${moved}.results`);
			rmSync(join(parent, staging[0]!), { recursive: true });
			complete(moved, store.tasks(), "v3");
			expect(code(() => store.backup(dest)).code).toBe("ok");
			complete(dest, store.tasks(), "v3");
		}
		expect(found).toBeGreaterThan(0);
	} finally {
		store.close();
	}
}, 600_000);
