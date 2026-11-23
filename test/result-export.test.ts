import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { publishStaging } from "../src/result-export";
import { FleetStore } from "../src/store";
import { run } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

const root = join(import.meta.dir, "..");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A real task started on the controlled local node; the lane's deliverables are written into its workspace. */
async function fixture() {
	const repo = await repositoryFixture("fleet-result-export-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const db = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(db);
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	store.putNode({ id: "local", os: process.platform, arch: process.arch,
		roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], operations: [], transport: { command: process.execPath,
			args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } });
	const fleet = new Fleet(store, { localNodeId: "local" });
	const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "export", caller: "controlled",
		repoId: "repo", baseCommit: repo.baseCommit, prompt: "Deliver RESULT.md and a patch", required: {} }).id);
	await fleet.close();
	store.close();
	const workspace = (task.workspace as unknown as { path: string }).path;
	const write = async (path: string, text: string) => {
		await mkdir(join(workspace, ...path.split("/").slice(0, -1)), { recursive: true });
		await writeFile(join(workspace, ...path.split("/")), text);
	};
	/** Authoritative settlement of the exact session/turn, as the poll path records it. */
	const settle = () => {
		const s = new FleetStore(db);
		try {
			const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const,
				terminal: true, evidence: { injected: "controlled settlement" } };
			s.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
		} finally {
			s.close();
		}
	};
	const stored = () => {
		const s = new FleetStore(db);
		try {
			return s.task(task.id)!;
		} finally {
			s.close();
		}
	};
	return { ...repo, db, task, workspace, write, settle, stored };
}

async function cli(db: string, args: string[]) {
	const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "--db", db, "--local-node-id", "local", ...args],
		{ cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	let json: any;
	try {
		json = JSON.parse(stdout);
	} catch {
		json = undefined;
	}
	return { exit, stdout, stderr, json };
}

const leftovers = (dir: string) => readdirSync(dir).filter((name) => name.includes(".partial-"));

test("export before settlement is refused and writes nothing; after settlement it exports the final bytes once collected", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "draft: still writing\n");
	const early = join(f.dir, "early");
	const refused = await cli(f.db, ["export", f.task.id, early, "--require", "RESULT.md"]);
	expect(refused.exit).toBe(1);
	expect(refused.json).toMatchObject({ ok: false, taskId: f.task.id, code: "RESULT_NOT_READY" });
	expect(existsSync(early)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
	expect(f.stored().resultManifest).toBeUndefined();

	// The lane finishes its file, then the turn settles: the only copy Fleet can ever export is the final one.
	const final = "# Result\nfinal text\n";
	await f.write("RESULT.md", final);
	await f.write("fix.patch", "diff --git a/x b/x\n");
	await f.write("tracked.txt", "changed bytes\n");
	await rm(join(f.workspace, "deleted.txt"));
	f.settle();
	const dest = join(f.dir, "out");
	const done = await cli(f.db, ["export", f.task.id, dest, "--require", "RESULT.md", "--require", "*.patch"]);
	expect(done.stderr).toBe("");
	expect(done.exit).toBe(0);
	expect(done.json).toMatchObject({
		ok: true,
		taskId: f.task.id,
		source: "collected",
		manifestStatus: "not_run",
		exportCompleteness: "complete",
		exportReview: null,
	});
	expect(await readFile(join(dest, "RESULT.md"), "utf8")).toBe(final);
	expect(await readFile(join(dest, "tracked.txt"), "utf8")).toBe("changed bytes\n");
	// A deleted path has no bytes to deliver.
	expect(existsSync(join(dest, "deleted.txt"))).toBe(false);
	const task = f.stored();
	const record = JSON.parse(await readFile(join(dest, "fleet-export.json"), "utf8"));
	expect(record).toMatchObject({ schemaVersion: 1, taskId: f.task.id, attemptId: f.task.attemptId, nodeId: "local", repoId: "repo",
		baseCommit: f.baseCommit, source: "collected", required: ["RESULT.md", "*.patch"], manifestDigest: digest(task.resultManifest),
		manifestStatus: "not_run", exportCompleteness: "complete", exportReview: null });
	expect(record.files).toEqual([
		{ path: "RESULT.md", bytes: Buffer.byteLength(final), sha256: sha256(final) },
		{ path: "fix.patch", bytes: 19, sha256: sha256("diff --git a/x b/x\n") },
		{ path: "tracked.txt", bytes: 14, sha256: sha256("changed bytes\n") },
	]);
	expect(done.json.files).toEqual(record.files);
	expect(done.json.recordSha256).toBe(sha256(await readFile(join(dest, "fleet-export.json"))));
	// The digest `tasks` lists for the stored result is the one the export names.
	const listing = await cli(f.db, ["tasks"]);
	expect(listing.json.find((t: any) => t.id === f.task.id).resultManifest.digest).toBe(record.manifestDigest);
	// Export is not verification: phase and verified stay as collection left them.
	expect(task.phase).toBe("completed_unverified");
	expect(task.result?.verified).toBe(false);
}, 120_000);

test("a second export uses the stored result only: later workspace changes and a vanished workspace change nothing", async () => {
	const f = await fixture();
	await f.write("REVIEW.md", "VERDICT: CLEAN\n");
	await f.write("review/deep/notes.txt", "n\n");
	f.settle();
	const first = await cli(f.db, ["export", f.task.id, join(f.dir, "one")]);
	expect(first.exit).toBe(0);
	expect(first.json.source).toBe("collected");
	// The workspace is rewritten and then removed: any node collection would now differ or fail.
	await f.write("REVIEW.md", "VERDICT: NOT CLEAN\n");
	await rm(f.workspace, { recursive: true, force: true });
	const second = await cli(f.db, ["export", f.task.id, join(f.dir, "two")]);
	expect(second.stderr).toBe("");
	expect(second.exit).toBe(0);
	expect(second.json).toMatchObject({ source: "stored", manifestDigest: first.json.manifestDigest, files: first.json.files });
	expect(await readFile(join(f.dir, "two", "REVIEW.md"), "utf8")).toBe("VERDICT: CLEAN\n");
	expect(await readFile(join(f.dir, "two", "review", "deep", "notes.txt"), "utf8")).toBe("n\n");
}, 120_000);

test("the exported SHA-256 closes the task through the one-shot result test without a poisoned first attempt", async () => {
	const f = await fixture();
	await f.write("REVIEW.md", "VERDICT: CLEAN — reviewed\n");
	f.settle();
	const dest = join(f.dir, "out");
	expect((await cli(f.db, ["export", f.task.id, dest, "--require", "REVIEW.md"])).exit).toBe(0);
	const { files } = JSON.parse(await readFile(join(dest, "fleet-export.json"), "utf8"));
	const expected = files.find((file: any) => file.path === "REVIEW.md").sha256;
	const check = [process.execPath, "--eval",
		`const h=new Bun.CryptoHasher('sha256').update(require('node:fs').readFileSync('REVIEW.md')).digest('hex');process.exit(h===${JSON.stringify(expected)}?0:1)`];
	const argv = join(f.dir, "argv.json");
	await writeFile(argv, JSON.stringify(check));
	const verified = await cli(f.db, ["result", f.task.id, argv]);
	expect(verified.exit).toBe(0);
	expect(verified.json.status).toBe("verified");
	expect(f.stored().phase).toBe("succeeded");
}, 120_000);

test("--require and --include: refusal writes nothing; selection follows Bun.Glob paths", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	await f.write("a.patch", "p\n");
	await f.write("sub/b.patch", "q\n");
	await f.write("review/x.json", "{}\n");
	await f.write("review/y/z.md", "z\n");
	f.settle();
	const missing = join(f.dir, "missing");
	const refused = await cli(f.db, ["export", f.task.id, missing, "--require", "RESULT.md", "--require", "review.json", "--require", "*.diff"]);
	expect(refused.exit).toBe(1);
	expect(refused.json).toMatchObject({ ok: false, code: "EXPORT_REQUIRED_MISSING" });
	expect(refused.json.error).toContain("review.json, *.diff");
	expect(existsSync(missing)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
	// The refusal happened after collection: the result is stored once and the next export reuses it.
	expect(f.stored().resultManifest).toBeDefined();
	const dest = join(f.dir, "picked");
	const picked = await cli(f.db, ["export", f.task.id, dest, "--include", "review/**", "--require", "*.patch"]);
	expect(picked.exit).toBe(0);
	expect(picked.json.source).toBe("stored");
	// `*` does not cross `/`: sub/b.patch is neither included nor required.
	expect(picked.json.files.map((file: any) => file.path)).toEqual(["a.patch", "review/x.json", "review/y/z.md"]);
	expect(readdirSync(dest).sort()).toEqual(["a.patch", "fleet-export.json", "review"]);
}, 120_000);

test("refusals before any collection: existing DEST, missing parent, unknown task, usage", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	f.settle();
	const taken = join(f.dir, "taken");
	await mkdir(taken);
	const exists = await cli(f.db, ["export", f.task.id, taken]);
	expect(exists.json).toMatchObject({ ok: false, code: "EXPORT_DEST_EXISTS" });
	expect(readdirSync(taken)).toEqual([]);
	const orphan = await cli(f.db, ["export", f.task.id, join(f.dir, "no-such-parent", "out")]);
	expect(orphan.json).toMatchObject({ ok: false, code: "EXPORT_DEST_PARENT" });
	// Neither refusal collected anything.
	expect(f.stored().resultManifest).toBeUndefined();
	const unknown = await cli(f.db, ["export", "no-such-task", join(f.dir, "u")]);
	expect(unknown.json).toMatchObject({ ok: false, code: "TASK_NOT_FOUND" });
	const usage = await cli(f.db, ["export", f.task.id, join(f.dir, "v"), "--only", "x"]);
	expect(usage.exit).toBe(1);
	expect(JSON.parse(usage.stderr).error).toBe("usage_export_TASK_ID_DEST_[--include_GLOB]..._[--require_GLOB]...");
	const readOnly = await cli(f.db, ["--read-only", "export", f.task.id, join(f.dir, "w")]);
	expect(readOnly.exit).toBe(1);
	expect(JSON.parse(readOnly.stderr).error).toBe("READ_ONLY");
	expect(existsSync(join(f.dir, "w"))).toBe(false);
}, 120_000);

test("a failure while writing leaves neither DEST nor a staging directory behind", async () => {
	const f = await fixture();
	f.settle();
	// A stored manifest whose paths cannot coexist on a filesystem (a file and a directory named x): git never
	// produces it, but every per-file check passes, so the failure happens inside the staging directory.
	const s = new FleetStore(f.db);
	const fleet = new Fleet(s, { localNodeId: "local" });
	try {
		const task = s.task(f.task.id)!;
		const collected = await (fleet as any).node(task, { action: "collect", identity: task.workspace, tests: [] });
		const file = (path: string, text: string) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text),
			contentBase64: Buffer.from(text).toString("base64"), deleted: false, mode: 0o644, type: "regular" });
		s.saveResult(task.id, { ...collected, files: [file("x", "file\n"), file("x/y", "child\n")] });
	} finally {
		await fleet.close();
		s.close();
	}
	const dest = join(f.dir, "out");
	const failed = await cli(f.db, ["export", f.task.id, dest]);
	expect(failed.exit).toBe(1);
	expect(failed.stdout).toBe("");
	expect(existsSync(dest)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
}, 120_000);

test("a collected file at the reserved record path is refused, not overwritten", async () => {
	const f = await fixture();
	await f.write("fleet-export.json", "{\"planted\":true}\n");
	f.settle();
	const dest = join(f.dir, "out");
	const refused = await cli(f.db, ["export", f.task.id, dest]);
	expect(refused.json).toMatchObject({ ok: false, code: "EXPORT_PATH_CONFLICT" });
	expect(existsSync(dest)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
	// Excluding it is the explicit way out.
	await f.write("RESULT.md", "late\n"); // the stored result is final: this file never appears
	const ok = await cli(f.db, ["export", f.task.id, dest, "--include", "*.md"]);
	expect(ok.exit).toBe(0);
	expect(ok.json.files).toEqual([]);
	expect(readdirSync(dest)).toEqual(["fleet-export.json"]);
}, 120_000);

test("a disposed task is refused with ARCHIVED_TASK even when its result is stored, like result", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	f.settle();
	expect((await cli(f.db, ["export", f.task.id, join(f.dir, "before")])).exit).toBe(0);
	expect(f.stored().resultManifest).toBeDefined();
	// Dispose without node contact: the registry node is disabled and unregistered, so --node-retired applies.
	const s = new FleetStore(f.db);
	try {
		s.putNode({ ...s.nodes().find((node) => node.id === "local")!, enabled: false });
		s.unregisterNode("local");
	} finally {
		s.close();
	}
	const disposed = await cli(f.db, ["task", "dispose", f.task.id, "--as", "discarded", "--reason", "rehearsal", "--node-retired", "fixture node gone"]);
	expect(disposed.exit).toBe(0);
	expect(f.stored().disposition).toBeDefined();
	const result = await cli(f.db, ["result", f.task.id]);
	expect(result.exit).not.toBe(0);
	expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: "ARCHIVED_TASK" });
	const dest = join(f.dir, "after");
	const refused = await cli(f.db, ["export", f.task.id, dest]);
	expect(refused.exit).toBe(1);
	expect(refused.json).toMatchObject({ ok: false, taskId: f.task.id, code: "ARCHIVED_TASK" });
	expect(existsSync(dest)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
}, 120_000);

test("negated patterns are refused before collection; a deleted path never satisfies --require; a refusal is one stdout line", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	await rm(join(f.workspace, "deleted.txt"));
	f.settle();
	for (const flag of ["--require", "--include"]) {
		const dest = join(f.dir, `negated${flag}`);
		const negated = await cli(f.db, ["export", f.task.id, dest, flag, "!REVIEW.md"]);
		expect(negated.exit).toBe(1);
		expect(negated.json).toMatchObject({ ok: false, taskId: f.task.id, code: "INVALID_INPUT" });
		expect(negated.stdout.endsWith("\n")).toBe(true);
		expect(negated.stdout.trimEnd().split("\n")).toHaveLength(1);
		expect(existsSync(dest)).toBe(false);
	}
	expect(f.stored().resultManifest).toBeUndefined();
	const dest = join(f.dir, "deleted");
	const missing = await cli(f.db, ["export", f.task.id, dest, "--require", "deleted.txt"]);
	expect(missing.json).toMatchObject({ ok: false, code: "EXPORT_REQUIRED_MISSING" });
	expect(missing.json.error).toContain("deleted.txt");
	expect(existsSync(dest)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
	// The deleted path is in the stored manifest, as a deletion.
	expect((f.stored().resultManifest as any).files.find((file: any) => file.path === "deleted.txt")?.deleted).toBe(true);
}, 120_000);

test("CLI export refusal keeps code and redacts credential-shaped --require text on one JSON stdout line", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	f.settle();
	const dest = join(f.dir, "cred-require");
	// Missing --require patterns are echoed into the public error string; stacked on #48 so
	// assignment-form secrets and URL userinfo both redact through boundedText.
	const refused = await cli(f.db, [
		"export",
		f.task.id,
		dest,
		"--require",
		"password=hunter2-secret",
		"--require",
		"https://deploy:S3cr3tPw@git.example/missing",
	]);
	expect(refused.exit).toBe(1);
	expect(refused.stdout.endsWith("\n")).toBe(true);
	expect(refused.stdout.trimEnd().split("\n")).toHaveLength(1);
	expect(refused.json).toMatchObject({
		ok: false,
		taskId: f.task.id,
		code: "EXPORT_REQUIRED_MISSING",
	});
	expect(refused.json.error).toContain("password=[redacted]");
	expect(refused.json.error).not.toContain("hunter2");
	// Stacked on #48: URL userinfo is redacted through the same boundedText pipe.
	expect(refused.json.error).toContain("https://[redacted]@git.example/missing");
	expect(refused.json.error).not.toContain("S3cr3tPw");
	expect(refused.json.error).not.toContain("deploy:");
	expect(existsSync(dest)).toBe(false);
	expect(leftovers(f.dir)).toEqual([]);
}, 120_000);

test("DEST names of 239, 240 and 255 characters export; the staging name does not depend on DEST", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	f.settle();
	for (const length of [239, 240, 255]) {
		const dest = join(f.dir, "d".repeat(length));
		const done = await cli(f.db, ["export", f.task.id, dest]);
		expect(done.stderr).toBe("");
		expect(done.exit).toBe(0);
		expect(await readFile(join(dest, "RESULT.md"), "utf8")).toBe("r\n");
		expect(leftovers(f.dir)).toEqual([]);
	}
}, 120_000);

test("a DEST whose parent is a symlink to a directory exports into the link target", async () => {
	const f = await fixture();
	await f.write("RESULT.md", "r\n");
	f.settle();
	const real = join(f.dir, "real");
	await mkdir(real);
	const link = join(f.dir, "link");
	symlinkSync(real, link, "dir");
	const done = await cli(f.db, ["export", f.task.id, join(link, "out")]);
	expect(done.stderr).toBe("");
	expect(done.exit).toBe(0);
	expect(await readFile(join(real, "out", "RESULT.md"), "utf8")).toBe("r\n");
	expect(leftovers(real)).toEqual([]);
	expect(leftovers(f.dir)).toEqual([]);
}, 120_000);

test("the record names the collected manifest's status as manifestStatus, not the task's later verification", async () => {
	const f = await fixture();
	await f.write("REVIEW.md", "VERDICT: CLEAN\n");
	f.settle();
	expect((await cli(f.db, ["export", f.task.id, join(f.dir, "first")])).exit).toBe(0);
	const argv = join(f.dir, "argv.json");
	await writeFile(argv, JSON.stringify([process.execPath, "--eval", "process.exit(0)"]));
	const verified = await cli(f.db, ["result", f.task.id, argv]);
	expect(verified.json.status).toBe("verified");
	const dest = join(f.dir, "second");
	const again = await cli(f.db, ["export", f.task.id, dest]);
	expect(again.exit).toBe(0);
	expect(again.json.manifestStatus).toBe("not_run");
	expect(again.json.resultStatus).toBeUndefined();
	expect(again.json).toMatchObject({ exportCompleteness: "complete", exportReview: null });
	const record = JSON.parse(await readFile(join(dest, "fleet-export.json"), "utf8"));
	expect(record.manifestStatus).toBe("not_run");
	expect(record.resultStatus).toBeUndefined();
	expect(record).toMatchObject({ exportCompleteness: "complete", exportReview: null });
}, 120_000);

test("legacy manifest with observed exclusions exports incomplete, matching export review", async () => {
	// Legacy without exportComplete still judges complete/incomplete from the
	// result-test observation receipt; fleet-export.json must not say unknown.
	const f = await fixture();
	await f.write("RESULT.md", "legacy bytes\n");
	f.settle();
	const collect = await cli(f.db, ["export", f.task.id, join(f.dir, "seed")]);
	expect(collect.exit).toBe(0);
	// Strip completeness fields so the stored manifest is legacy-v1, then upgrade with a nested repo.
	const raw = new Database(f.db);
	const row = raw.query<{ data: string }, [string]>("SELECT data FROM tasks WHERE id=?").get(f.task.id)!;
	const data = JSON.parse(row.data);
	const { exclusions: _e, exportComplete: _c, ignored: _i, junk: _j, ...legacy } = data.resultManifest;
	data.resultManifest = legacy;
	raw.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(data), f.task.id);
	raw.close();
	expect((await run(["git", "init", join(f.workspace, "nested")], f.dir)).exit).toBe(0);
	const argv = join(f.dir, "legacy-argv.json");
	await writeFile(argv, JSON.stringify([process.execPath, "--eval", "console.log('legacy verify')"]));
	const upgraded = await cli(f.db, ["result", f.task.id, argv]);
	expect(upgraded.exit).toBe(0);
	expect(upgraded.json.status).toBe("verified");
	const review = await cli(f.db, ["export", "review", f.task.id]);
	expect(review.exit).toBe(0);
	expect(review.json.completeness).toBe("incomplete");
	// While review is required the observation receipt sits in the held slot, not receipt.
	const store = new FleetStore(f.db);
	try {
		const op = store.getOperation(f.task.id, "result-test")!;
		expect(op.receipt).toBeUndefined();
		const held = op.held as { observedExclusions?: unknown } | undefined;
		expect(Array.isArray(held?.observedExclusions)).toBe(true);
		expect(held?.observedExclusions).toEqual(
			expect.arrayContaining([expect.objectContaining({ reason: "nested_repository" })]),
		);
	} finally {
		store.close();
	}
	const dest = join(f.dir, "legacy-out");
	const done = await cli(f.db, ["export", f.task.id, dest]);
	expect(done.exit).toBe(0);
	expect(done.json).toMatchObject({
		exportCompleteness: "incomplete",
		exportReview: "required",
		manifestStatus: "not_run",
	});
	const record = JSON.parse(await readFile(join(dest, "fleet-export.json"), "utf8"));
	expect(record.exportCompleteness).toBe(review.json.completeness);
	expect(record.exportCompleteness).toBe("incomplete");
	expect(record.exportReview).toBe("required");

	const accepted = await cli(f.db, [
		"export",
		"accept",
		f.task.id,
		review.json.reviewDigest,
		"--operator",
		"ops",
	]);
	expect(accepted.exit).toBe(0);
	const afterReview = await cli(f.db, ["export", "review", f.task.id]);
	expect(afterReview.exit).toBe(0);
	expect(afterReview.json.completeness).toBe("incomplete");
	const afterDest = join(f.dir, "legacy-accepted");
	const after = await cli(f.db, ["export", f.task.id, afterDest]);
	expect(after.exit).toBe(0);
	expect(after.json).toMatchObject({
		exportCompleteness: "incomplete",
		exportReview: "accepted",
		manifestStatus: "not_run",
	});
	const afterRecord = JSON.parse(await readFile(join(afterDest, "fleet-export.json"), "utf8"));
	expect(afterRecord.exportCompleteness).toBe(afterReview.json.completeness);
	expect(afterRecord.exportCompleteness).toBe("incomplete");
	expect(afterRecord.exportReview).toBe("accepted");
}, 120_000);

test("first-collect and stored re-export fill the same completeness and review fields", async () => {
	// When export collects for the first time, fields come from the post-collect
	// re-read task and the exported manifest — identical to a later stored export.
	const f = await fixture();
	await mkdir(join(f.workspace, "fixtures", "repo"), { recursive: true });
	expect((await run(["git", "init", join(f.workspace, "fixtures", "repo")], f.dir)).exit).toBe(0);
	await f.write("fixtures/repo/fixture.txt", "nested");
	await f.write("RESULT.md", "outer\n");
	f.settle();
	expect(f.stored().resultManifest).toBeUndefined();

	const firstDest = join(f.dir, "first");
	const first = await cli(f.db, ["export", f.task.id, firstDest]);
	expect(first.exit).toBe(0);
	expect(first.json.source).toBe("collected");
	const firstRecord = JSON.parse(await readFile(join(firstDest, "fleet-export.json"), "utf8"));
	expect(first.json).toMatchObject({
		exportCompleteness: firstRecord.exportCompleteness,
		exportReview: firstRecord.exportReview,
	});
	expect(firstRecord).toMatchObject({
		exportCompleteness: "incomplete",
		exportReview: null,
		manifestStatus: "not_run",
	});

	const secondDest = join(f.dir, "second");
	const second = await cli(f.db, ["export", f.task.id, secondDest]);
	expect(second.exit).toBe(0);
	expect(second.json.source).toBe("stored");
	const secondRecord = JSON.parse(await readFile(join(secondDest, "fleet-export.json"), "utf8"));
	expect({
		exportCompleteness: second.json.exportCompleteness,
		exportReview: second.json.exportReview,
		manifestStatus: second.json.manifestStatus,
	}).toEqual({
		exportCompleteness: first.json.exportCompleteness,
		exportReview: first.json.exportReview,
		manifestStatus: first.json.manifestStatus,
	});
	expect({
		exportCompleteness: secondRecord.exportCompleteness,
		exportReview: secondRecord.exportReview,
		manifestStatus: secondRecord.manifestStatus,
	}).toEqual({
		exportCompleteness: firstRecord.exportCompleteness,
		exportReview: firstRecord.exportReview,
		manifestStatus: firstRecord.manifestStatus,
	});
}, 120_000);

test("export record keeps incompleteness after operator acceptance; review is separate from manifestStatus", async () => {
	const f = await fixture();
	await mkdir(join(f.workspace, "fixtures", "repo"), { recursive: true });
	expect((await run(["git", "init", join(f.workspace, "fixtures", "repo")], f.dir)).exit).toBe(0);
	await f.write("fixtures/repo/fixture.txt", "nested");
	await f.write("RESULT.md", "outer\n");
	f.settle();
	// Passing verifier over an incomplete export opens result.exportIncomplete without rewriting completeness.
	const argv = join(f.dir, "argv.json");
	await writeFile(argv, JSON.stringify([process.execPath, "--eval", "console.log('passing verifier')"]));
	const verified = await cli(f.db, ["result", f.task.id, argv]);
	expect(verified.exit).toBe(0);
	expect(verified.json.status).toBe("verified");
	expect(f.stored()).toMatchObject({
		phase: "completed_unverified",
		result: { verified: false, exportIncomplete: { reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
	});

	const pendingDest = join(f.dir, "pending");
	const pending = await cli(f.db, ["export", f.task.id, pendingDest]);
	expect(pending.exit).toBe(0);
	expect(pending.json).toMatchObject({
		manifestStatus: "not_run",
		exportCompleteness: "incomplete",
		exportReview: "required",
	});
	const pendingRecord = JSON.parse(await readFile(join(pendingDest, "fleet-export.json"), "utf8"));
	expect(pendingRecord).toMatchObject({
		manifestStatus: "not_run",
		exportCompleteness: "incomplete",
		exportReview: "required",
	});

	const review = await cli(f.db, ["export", "review", f.task.id]);
	expect(review.exit).toBe(0);
	expect(review.json.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
	const accepted = await cli(f.db, [
		"export",
		"accept",
		f.task.id,
		review.json.reviewDigest,
		"--operator",
		"ops",
	]);
	expect(accepted.exit).toBe(0);

	const acceptedDest = join(f.dir, "accepted");
	const again = await cli(f.db, ["export", f.task.id, acceptedDest]);
	expect(again.exit).toBe(0);
	// Operator acceptance must not rewrite completeness to complete.
	expect(again.json).toMatchObject({
		manifestStatus: "not_run",
		exportCompleteness: "incomplete",
		exportReview: "accepted",
	});
	const acceptedRecord = JSON.parse(await readFile(join(acceptedDest, "fleet-export.json"), "utf8"));
	expect(acceptedRecord).toMatchObject({
		manifestStatus: "not_run",
		exportCompleteness: "incomplete",
		exportReview: "accepted",
	});
}, 120_000);

test("review 17aa5da6 F1: a DEST that appears after the last check refuses EXPORT_DEST_EXISTS, never a raw OS error with the staging path", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-export-race-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const refusal = (dest: string) => {
		const staging = mkdtempSync(join(dir, "staging-"));
		writeFileSync(join(staging, "RESULT.md"), "final");
		try {
			publishStaging(staging, dest);
			return undefined;
		} catch (error) {
			return error as Error & { code?: string };
		}
	};
	// The loser of two exports of one DEST: the winner's non-empty directory is already there.
	const taken = join(dir, "taken");
	mkdirSync(taken);
	writeFileSync(join(taken, "RESULT.md"), "winner");
	const loser = refusal(taken);
	expect([loser?.name, loser?.code]).toEqual(["FleetError", "EXPORT_DEST_EXISTS"]);
	expect(loser!.message).not.toContain("staging-");
	expect(await readFile(join(taken, "RESULT.md"), "utf8")).toBe("winner");
	// POSIX: a file at DEST is never replaced either. (Windows rename replaces a file with the directory: the documented limit.)
	if (process.platform !== "win32") {
		const file = join(dir, "file");
		writeFileSync(file, "other");
		const overFile = refusal(file);
		expect([overFile?.name, overFile?.code]).toEqual(["FleetError", "EXPORT_DEST_EXISTS"]);
		expect(await readFile(file, "utf8")).toBe("other");
	} else {
		// Windows: a directory at DEST is never replaced, even an empty one.
		const empty = join(dir, "empty");
		mkdirSync(empty);
		const overEmpty = refusal(empty);
		expect([overEmpty?.name, overEmpty?.code]).toEqual(["FleetError", "EXPORT_DEST_EXISTS"]);
		expect(readdirSync(empty)).toEqual([]);
	}
	// A free DEST is published; a failure that is not "DEST exists" (missing parent) stays the original error.
	expect(refusal(join(dir, "free"))).toBeUndefined();
	expect(await readFile(join(dir, "free", "RESULT.md"), "utf8")).toBe("final");
	const other = refusal(join(dir, "missing-parent", "x"));
	expect(other).toBeDefined();
	expect(other!.code).not.toBe("EXPORT_DEST_EXISTS");
});
