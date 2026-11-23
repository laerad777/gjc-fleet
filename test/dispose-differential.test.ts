import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson } from "../src/core";

// Differential of every pre-existing CLI command, task-dispose lane: the real CLI process of this tree and of the
// production base this change applies to (FLEET_BASE_TREE: an extract of production main plus its test-only
// commit), each on its own copy of the same database seeded by the BASE code (test/fixtures/cli-differential-seed.ts
// of that tree) with 0, 1 and 2 tasks in every phase. Exit code, stdout and stderr must be identical, and so must
// the logical database content each command leaves (normalised for the call time). The only allowed difference is
// the help text, which may only gain lines (the new task dispose usage and the tasks --disposition flag), and the
// `placement` record of the queue-unplaceable lane: allowed only on never-admitted queued task rows (tasks.data) and
// their CLI summaries (allowPlacement); everything else, including those rows without it, is compared byte for byte.
// Not run: commands that contact a real node or service (start, poll, answer, ordinary, result, cancel, stop,
// return*, submit, input, ui); queue reconsider runs with recorded stale samples, so it admits nothing.
const root = resolve(import.meta.dir, "..");
const baseTree = process.env.FLEET_BASE_TREE ? resolve(process.env.FLEET_BASE_TREE) : undefined;
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const PHASES = ["queued", "preparing", "dispatching", "active", "approval_required", "blocked_unknown", "cancel_unknown",
	"completed_unverified", "succeeded", "failed", "archived", "cancelled"] as const;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const age = (s: string) => s.replace(/\t\d+s\t/g, "\t<AGE>\t");
const norm = (s: string) => age(s.replace(ISO, "<NOW>"));

function seed(perPhase: number) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dispose-diff-"));
	dirs.push(dir);
	const db = join(dir, "seed.sqlite");
	const run = Bun.spawnSync([process.execPath, join(baseTree!, "test", "fixtures", "cli-differential-seed.ts"), baseTree!, db, String(perPhase), dir], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	if (run.exitCode !== 0) throw new Error(`seed failed: ${run.stderr.toString()}`);
	writeFileSync(join(dir, "stale.json"), JSON.stringify(Object.fromEntries(["n1", "n2"].map((id) => [id, {
		ok: true, at: "2020-01-01T00:00:00.000Z", cpuPct: 1, memTotal: 64 * 1024 ** 3, memUsed: 1024 ** 3, disks: [{ path: "/", total: 1024 ** 4, used: 0 }],
	}]))));
	writeFileSync(join(dir, "node.json"), JSON.stringify({ id: "n3", os: process.platform, arch: process.arch, roots: { repo: "/repos/repo" }, workspaceRoot: "/work",
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], transport: { command: "/usr/bin/false", args: [] }, operations: ["read"] }));
	for (const key of ["archived-0", "completed_unverified-0", "queued-0"])
		writeFileSync(join(dir, `${key}.json`), JSON.stringify({ schemaVersion: 1, key, caller: "differential", repoId: "repo", baseCommit: "a".repeat(40), prompt: `private ${key}`, required: {} }));
	writeFileSync(join(dir, "notes.json"), JSON.stringify({ differential: true }));
	return { dir, db, ids: JSON.parse(run.stdout.toString()).ids as Record<string, string> };
}
/** Every table's rows (a plain connection: a cold WAL copy cannot be opened read-only); it only reads. */
function logical(path: string): string {
	const db = new Database(path);
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
		return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
	} finally { db.close(); }
}
async function cli(tree: string, base: { dir: string; db: string }, label: string, args: string[]) {
	const work = join(base.dir, `${label}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(work);
	const db = join(work, "fleet.sqlite");
	copyFileSync(base.db, db);
	const hub = args.includes("--read-only") ? new Database(db) : undefined;
	hub?.query("SELECT count(*) FROM tasks").get();
	try {
		const child = Bun.spawn([process.execPath, join(tree, "src", "cli.ts"), "--db", db, ...args.map((a) => a.replaceAll("<WORK>", work).replaceAll("<SEED>", base.dir))],
			{ cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
		const timer = setTimeout(() => child.kill(), 60_000);
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		clearTimeout(timer);
		// Each path raw, JSON-escaped and doubly escaped (JSON text inside a JSON row): Windows backslashes are doubled.
		const esc = (path: string) => JSON.stringify(path).slice(1, -1);
		const swap = (s: string, path: string, tag: string) => [esc(esc(path)), esc(path), path].reduce((out, form) => out.replaceAll(form, tag), s);
		const clean = (s: string) => norm(swap(swap(swap(s, work, "<WORK>"), base.dir, "<SEED>"), `/private${work}`, "<WORK>"));
		return { exit, stdout: clean(stdout), stderr: clean(stderr), state: norm(swap(logical(db), work, "<WORK>")) };
	} finally { hub?.close(); }
}
/** A task row or summary that may carry the placement record: a never-admitted queued task. */
const neverAdmittedQueued = (task: any) => !!task && typeof task === "object" && task.phase === "queued" && !task.attemptId;
/**
 * The one allowed difference of the queue-unplaceable lane: `placement` removed from never-admitted queued task
 * rows and their CLI summaries only, each re-encoded exactly as written (a row or output that does not round-trip
 * fails the test instead of being normalised). `stripped` counts removals; `left` counts any placement field
 * still present anywhere in a task row or summary afterwards (it must be none).
 */
function allowPlacement(run: { stdout: string; state: string }) {
	let stripped = 0, left = 0;
	const exact = (text: string, encode: (value: unknown) => string) => {
		const value = JSON.parse(text);
		expect(encode(value)).toBe(text);
		return value;
	};
	/** true when `task` lost its placement here; counts any placement field left on it. */
	const strip = (task: any) => {
		const removed = neverAdmittedQueued(task) && Object.hasOwn(task, "placement");
		if (removed) { delete task.placement; stripped++; }
		if (task && typeof task === "object" && Object.hasOwn(task, "placement")) left++;
		return removed;
	};
	let state = run.state;
	const tables = JSON.parse(state) as [string, any[]][];
	let rowsChanged = false;
	for (const [name, rows] of tables)
		if (name === "tasks") for (const row of rows) {
			let task: any;
			try { task = JSON.parse(row.data); } catch { continue; }
			const text = row.data;
			if (strip(task)) {
				// Only a row written as canonical JSON (FleetStore.encodeTask of a queued task) is re-encoded.
				exact(text, canonicalJson);
				row.data = canonicalJson(task);
				rowsChanged = true;
			}
		}
	if (rowsChanged) {
		exact(state, (value) => JSON.stringify(value));
		state = JSON.stringify(tables);
	}
	let stdout = run.stdout;
	const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
	let parsed: unknown;
	try { parsed = JSON.parse(stdout); } catch { parsed = undefined; }
	if (parsed !== null && typeof parsed === "object") {
		let changed = false;
		for (const task of Array.isArray(parsed) ? parsed : [parsed]) changed = strip(task) || changed;
		if (changed) {
			exact(stdout, pretty);
			stdout = pretty(parsed);
		}
	}
	return { ...run, stdout, state, stripped, left };
}
function cases(ids: Record<string, string>, perPhase: number): string[][] {
	const keys = (phase: string) => Array.from({ length: Math.min(perPhase, 2) }, (_, i) => `${phase}-${i}`);
	const read: string[][] = [
		["tasks"], ["tasks", "--compact"], ...PHASES.flatMap((p) => [["tasks", "--phase", p], ["tasks", "--phase", p, "--compact"]]),
		["tasks", "--node", "n1"], ["tasks", "--key-prefix", "archived-"], ["tasks", "--since", "2000-01-01T00:00:00.000Z", "--compact"], ["tasks", "--bogus"], ["tasks", "--phase", "nope"],
		...PHASES.flatMap((p) => keys(p).flatMap((k) => [["show", ids[k]!], ["events", ids[k]!]])),
		["show", "00000000-0000-4000-8000-000000000000"], ["observability"], ["node", "list"], ["results", "status"], ["results", "check"],
	];
	return [
		...read, ...read.map((c) => ["--read-only", ...c]),
		["unknown-command"], ["task"], ["task", "bogus"], ["task", "archive"],
		["results", "gc"], ["migrate", "results"], ["--resources", "<SEED>/stale.json", "queue", "reconsider"],
		["watch", "--all-active", "--interval", "10", "--max-polls", "2"],
		["node", "drain", "n1"], ["node", "enable", "n2"], ["node", "disable", "n1"], ["node", "remove", "n2"], ["node", "add", "<SEED>/node.json"],
		["rollback"], ["backup", "<WORK>/backup.sqlite"],
		["results", "enable", "--confirm-one-way", "--reason", "differential"], ["results", "disable", "--reason", "differential"],
		...(perPhase ? [
			["task", "archive", ids["blocked_unknown-0"]!, "--notes", "<SEED>/notes.json"],
			["task", "archive", ids["completed_unverified-0"]!], ["task", "archive", ids["archived-0"]!],
			["task", "accept-late-receipt", ids["failed-0"]!, "--reason", "differential"],
			["run", "<SEED>/archived-0.json"], ["run", "<SEED>/archived-0.json", "--wait"], ["run", "<SEED>/completed_unverified-0.json"],
			["watch", ids["archived-0"]!, "--interval", "10"], ["watch", ids["succeeded-0"]!, "--interval", "10"],
		] : []),
	];
}

for (const perPhase of [0, 1, 2])
	test.skipIf(!baseTree)(`every existing command, ${perPhase} task(s) per phase: exit, stdout, stderr and resulting database equal the production base`, async () => {
		const base = seed(perPhase);
		const list = cases(base.ids, perPhase);
		let placements = 0;
		for (const args of list) {
			const [rawOld, rawNow] = await Promise.all([cli(baseTree!, base, "base", args), cli(root, base, "patched", args)]);
			const { stripped: oldStripped, left: oldLeft, ...old } = allowPlacement(rawOld);
			const { stripped, left, ...now } = allowPlacement(rawNow);
			// The base never writes or prints the field; this tree only on never-admitted queued rows and summaries.
			expect({ args, oldStripped, oldLeft, left }).toEqual({ args, oldStripped: 0, oldLeft: 0, left: 0 });
			if (stripped) expect(args.at(-1)).toBe("reconsider");
			placements += stripped;
			expect({ args, ...now }).toEqual({ args, ...old });
		}
		// Positive: with queued tasks, queue reconsider records and prints the placement of each queued task it rejects.
		if (perPhase) expect(placements).toBeGreaterThanOrEqual(2 * Math.min(perPhase, 2));
		else expect(placements).toBe(0);
	}, 600_000);

test.skipIf(!baseTree)("help: the base help text plus only the new task dispose and tasks --disposition lines", async () => {
	const base = seed(0);
	const [old, now] = await Promise.all([cli(baseTree!, base, "base", ["--help"]), cli(root, base, "patched", ["--help"])]);
	expect({ exit: now.exit, stderr: now.stderr }).toEqual({ exit: old.exit, stderr: old.stderr });
	const oldLines = old.stdout.split("\n"), newLines = now.stdout.split("\n");
	// Every base line appears in order; the only changed base line is the tasks usage line, which gains the flag.
	let j = 0;
	const added: string[] = [];
	for (const line of newLines) {
		const expected = oldLines[j];
		if (line === expected) j++;
		else if (expected?.startsWith("  tasks [--phase") && line === expected.replace("[--since ISO] ", "[--since ISO] [--disposition K[,K]] ")) j++;
		else added.push(line);
	}
	expect(j).toBe(oldLines.length);
	expect(added.length).toBeGreaterThan(0);
	expect(added.every((line) => /task dispose|^ {6,}/.test(line))).toBe(true);
});
