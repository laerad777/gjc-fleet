import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { exportReviewDigest, FleetStore } from "../src/store";
import { readAnchoredFile } from "../src/safe-reader";
import { collectResult, excluded, prepareWorkspace, run, sha256 } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

// Review fx-6f923f88 findings (round r6).

const pass = [process.execPath, "--eval", "console.log('pass')"];
const directories: string[] = [];
const stores: FleetStore[] = [];
afterEach(async () => {
	// A failed test leaves its store open; close it so its directory can be removed (Windows).
	for (const store of stores.splice(0))
		try {
			store.close();
		} catch {}
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const sh = async (argv: string[], cwd: string) => {
	const r = await run(argv, cwd);
	if (r.exit !== 0) throw new Error("fixture failed: " + r.stderr);
	return r.stdout.trimEnd();
};
const gitIn = (path: string, ...args: string[]) =>
	sh(["git", "-c", "user.name=Worker", "-c", "user.email=w@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", path, ...args], path);

/** A hub store with one local node, and settled tasks whose workspaces Fleet prepared. */
async function hub(prefix: string) {
	const f = await repositoryFixture(prefix);
	directories.push(f.dir);
	const db = join(f.dir, "fleet.sqlite");
	const transport = { command: process.execPath, args: [] };
	const h = { f, db, store: new FleetStore(db, 8), fleet: undefined as unknown as Fleet };
	h.fleet = new Fleet(h.store, { localNodeId: "local" });
	stores.push(h.store);
	h.store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport, sdkTransport: transport });
	const reopen = () => {
		h.store.close();
		h.store = new FleetStore(db, 8);
		stores.push(h.store);
		h.fleet = new Fleet(h.store, { localNodeId: "local" });
	};
	const settled = async (key: string) => {
		const task = h.store.reserve(h.store.submit({ schemaVersion: 1 as const, key, caller: "controlled", repoId: "repo", baseCommit: f.baseCommit, prompt: key, required: {} }).id);
		const identity = await prepareWorkspace({ taskId: task.id, attemptId: task.attemptId!, nodeId: "local", inputDigest: task.inputDigest, repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		h.store.setWorkspace(task.id, identity as any);
		const sessionId = "session-" + key;
		const create = h.store.claimOperation(task.id, "create", { cwd: identity.path })!;
		h.store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
		h.store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
		h.store.recordTurn(task.id, "turn-" + key);
		const body = { sessionId, turnId: "turn-" + key, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
		h.store.observe(task.id, { ...body, eventId: "settle-" + key, digest: observationDigest(body) });
		return { id: task.id, path: identity.path };
	};
	/** The task as production main (303285c) prepared it: identity and marker without a collection snapshot. */
	const legacyPrepared = async (id: string) => {
		const { collectionSnapshot: _snapshot, ...identity } = h.store.task(id)!.workspace as any;
		await writeFile(join(identity.path, ".fleet-identity.json"), JSON.stringify(identity), { mode: 0o600 });
		const raw = new Database(db);
		raw.query("UPDATE tasks SET data=json_remove(data,'$.workspace.collectionSnapshot') WHERE id=?").run(id);
		raw.close();
		reopen();
		return identity;
	};
	const rowBytes = (table: "tasks" | "operations", where: string, ...args: string[]) => {
		const raw = new Database(db, { readonly: true });
		try {
			return (raw.query(`SELECT data FROM ${table} WHERE ${where}`).all(...args) as any[]).map((row) => Buffer.byteLength(row.data));
		} finally {
			raw.close();
		}
	};
	return Object.assign(h, { settled, legacyPrepared, reopen, rowBytes });
}

/** A manifest entry for a file exactly as production main's collector exported it (an ordinary file). */
async function productionEntry(root: string, path: string) {
	// Bytes and mode as that collector read them (its anchored reader; review fx-1091e277 F2 compares both).
	const { bytes, mode } = readAnchoredFile(root, path.split("/"), 4 * 1024 * 1024);
	return { path, bytes: bytes.length, sha256: sha256(bytes), contentBase64: bytes.toString("base64"), deleted: false, mode, type: "regular" };
}
async function regularFiles(root: string, under: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of (await readdir(join(root, under), { recursive: true, withFileTypes: true })) as any[])
		if (entry.isFile()) out.push(join(entry.parentPath ?? entry.path, entry.name).slice(root.length + 1).split("\\").join("/"));
	return out;
}

// ---- F2: a legacy result holding what this collector withholds stays verifiable ----

describe("F2: a production-main-collected not_run result over content now withheld at a boundary", () => {
	async function legacyTask(prefix: string) {
		const h = await hub(prefix);
		const task = await h.settled("legacy");
		const identity = await h.legacyPrepared(task.id);
		await writeFile(join(task.path, "d.txt"), "deliverable");
		// An untracked bare repository and a directory whose `.git` file is not a repository.
		await sh(["git", "init", "-q", "--bare", join(task.path, "fixture.git")], h.f.dir);
		await mkdir(join(task.path, "odd"));
		await writeFile(join(task.path, "odd", ".git"), "not a repository\n");
		await writeFile(join(task.path, "odd", "keep.txt"), "keep");
		// What this release's node collects for that identity (legacy-v1): the withheld content is absent.
		const fresh: any = await (h.fleet as any).node(h.store.task(task.id), { action: "collect", identity, tests: [], exportCompleteness: "exclusions-v1" });
		expect(fresh.files.map((file: any) => file.path)).toEqual(["d.txt"]);
		// Production main exported both directories as ordinary files, except names its `excluded` rule
		// (unchanged since) drops, such as `odd/.git`: 20 files here (probed against 303285c's collector).
		const extra = [...(await regularFiles(task.path, "fixture.git")), ...(await regularFiles(task.path, "odd"))].filter((path) => !excluded(path));
		const files = [...fresh.files, ...(await Promise.all(extra.map((path) => productionEntry(task.path, path))))].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return { h, task, identity, fresh, stored: { ...fresh, files } };
	}

	test("explicit verification records the withholding boundaries and awaits export review (not ARTIFACT_CHANGED); acceptance verifies it", async () => {
		const { h, task, stored } = await legacyTask("fleet-r6-f2-");
		expect(stored.files.some((file: any) => file.path === "fixture.git/HEAD")).toBe(true);
		expect(stored.files.some((file: any) => file.path === "odd/keep.txt")).toBe(true);
		h.store.saveResult(task.id, stored);
		const upgraded: any = await h.fleet.result(task.id, pass);
		expect(upgraded.status).toBe("verified");
		expect(h.store.task(task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
		const boundaries = [
			{ path: "fixture.git", reason: "nested_repository", outerTrackedEntries: 0 },
			{ path: "odd", reason: "nested_repository", outerTrackedEntries: 0 },
		];
		const review = (h.fleet as any).exportReview(task.id);
		expect(review).toMatchObject({ artifactSchema: "legacy-v1", completeness: "incomplete", exclusions: boundaries, required: true });
		h.fleet.acceptIncompleteExport(task.id, { operator: "ops", reviewDigest: review.reviewDigest });
		expect(h.store.task(task.id)).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect((h.store.getOperation(task.id, "result-test")!.receipt as any).observedExclusions).toEqual(boundaries);
		// The stored manifest is still the production one, with every file it held.
		expect((h.store.task(task.id)!.resultManifest as any).files.length).toBe(stored.files.length);
		h.store.close();
	}, 180_000);

	test("a stored file missing outside every boundary is still ARTIFACT_CHANGED and the verifier never runs", async () => {
		const { h, task, stored } = await legacyTask("fleet-r6-f2-changed-");
		await writeFile(join(task.path, "gone.txt"), "gone");
		const gone = await productionEntry(task.path, "gone.txt");
		await unlink(join(task.path, "gone.txt"));
		h.store.saveResult(task.id, { ...stored, files: [...stored.files, gone].sort((a: any, b: any) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) });
		const counter = join(h.f.dir, "verifier-ran");
		await expect(h.fleet.result(task.id, [process.execPath, "--eval", `require("fs").writeFileSync(${JSON.stringify(counter)}, "ran")`])).rejects.toThrow("ARTIFACT_CHANGED: workspace no longer matches collected bytes");
		expect(await Bun.file(counter).exists()).toBe(false);
		// Refused before the verifier was sent: the claim is released, nothing is held.
		expect(h.store.getOperation(task.id, "result-test")).toBeUndefined();
		expect(h.store.task(task.id)!.result!.exportIncomplete).toBeUndefined();
		h.store.close();
	}, 180_000);

	// Review fx-1091e277 F2: the stored bytes below a boundary are compared with the workspace too.
	test("a stored file below a boundary whose workspace bytes changed is ARTIFACT_CHANGED and the verifier never runs", async () => {
		const { h, task, stored } = await legacyTask("fleet-r7-f2-before-");
		h.store.saveResult(task.id, stored);
		await writeFile(join(task.path, "odd", "keep.txt"), "rewritten after collection");
		const counter = join(h.f.dir, "verifier-ran");
		await expect(h.fleet.result(task.id, [process.execPath, "--eval", `require("fs").writeFileSync(${JSON.stringify(counter)}, "ran")`])).rejects.toThrow("ARTIFACT_CHANGED: workspace no longer matches collected bytes");
		expect(await Bun.file(counter).exists()).toBe(false);
		expect(h.store.getOperation(task.id, "result-test")).toBeUndefined();
		expect(h.store.task(task.id)!.result!.exportIncomplete).toBeUndefined();
		h.store.close();
	}, 180_000);

	test("a verifier that rewrites a stored file below a boundary is ARTIFACT_CHANGED; nothing awaits export review", async () => {
		const { h, task, stored } = await legacyTask("fleet-r7-f2-after-");
		h.store.saveResult(task.id, stored);
		const target = join(task.path, "odd", "keep.txt");
		await expect(h.fleet.result(task.id, [process.execPath, "--eval", `require("fs").writeFileSync(${JSON.stringify(target)}, "verifier")`])).rejects.toThrow("ARTIFACT_CHANGED: verifier changed collected artifact bytes");
		expect(await readFile(target, "utf8")).toBe("verifier");
		expect(h.store.task(task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
		expect(h.store.task(task.id)!.result!.exportIncomplete).toBeUndefined();
		h.store.close();
	}, 180_000);

	// Review b7481b8b F1: the two `legacyWithheld` catch sites (docs/failure-diagnostics.md, N row).
	// Malformed node evidence gives no withheld set: the caller refuses ARTIFACT_CHANGED before the
	// verifier is sent, recorded by the verifier-claim release row (operation_claim_released).
	for (const [name, malformed] of [
		["file evidence that is not canonical JSON", (reply: any) => ({ ...reply, withheldFiles: reply.withheldFiles.map((entry: any) => ({ ...entry, bytes: Number.POSITIVE_INFINITY })) })],
		["boundary evidence that is not a valid exclusion list", (reply: any) => ({ ...reply, withheldBoundaries: [{ path: 7, reason: "nested_repository", outerTrackedEntries: 0 }] })],
	] as const)
		test(`malformed node ${name} is ARTIFACT_CHANGED before the verifier is sent, with the claim release recorded (review b7481b8b F1)`, async () => {
			const { h, task, stored } = await legacyTask("fleet-r8-f1-");
			h.store.saveResult(task.id, stored);
			const node = (h.fleet as any).node.bind(h.fleet);
			let replaced = 0;
			(h.fleet as any).node = async (t: any, request: any) => {
				const reply = await node(t, request);
				if (request.action !== "collect" || !Array.isArray(reply?.withheldFiles) || reply.withheldFiles.length === 0) return reply;
				replaced++;
				return malformed(reply);
			};
			const counter = join(h.f.dir, "verifier-ran");
			await expect(h.fleet.result(task.id, [process.execPath, "--eval", `require("fs").writeFileSync(${JSON.stringify(counter)}, "ran")`])).rejects.toThrow("ARTIFACT_CHANGED: workspace no longer matches collected bytes");
			expect(replaced).toBe(1);
			expect(await Bun.file(counter).exists()).toBe(false);
			expect(h.store.getOperation(task.id, "result-test")).toBeUndefined();
			expect(h.store.task(task.id)!.result!.exportIncomplete).toBeUndefined();
			const released = h.store.events(task.id).filter((event) => event.kind === "operation_claim_released");
			expect(released).toHaveLength(1);
			expect((released[0]!.data as any).failureDiagnostic).toMatchObject({ source: "Fleet.result", phase: "call", errorClass: "FleetError" });
			h.store.close();
		}, 180_000);
});

// ---- F3: the held verifier receipt is stored once, outside the task row ----------

describe("F3: a held result-test receipt is never duplicated into tasks.data", () => {
	test("2,000,000 bytes of verifier stdout: the task row stays small before and after acceptance; the receipt is held once", async () => {
		const h = await hub("fleet-r6-f3-");
		const task = await h.settled("big");
		await mkdir(join(task.path, "fx"));
		await sh(["git", "init", "-q", join(task.path, "fx")], h.f.dir);
		await writeFile(join(task.path, "d.txt"), "d");
		expect(((await h.fleet.result(task.id)) as any).status).toBe("not_run");
		const big = [process.execPath, "--eval", "process.stdout.write('x'.repeat(2000000))"];
		const upgraded: any = await h.fleet.result(task.id, big);
		expect(upgraded.status).toBe("verified");
		const limit = 64 * 1024;
		const sizes = () => ({ task: h.rowBytes("tasks", "id=?", task.id)[0]!, operations: h.rowBytes("operations", "task_id=?", task.id).sort((a, b) => b - a) });
		const pending = sizes();
		expect(pending.task).toBeLessThan(limit);
		// One operations row (the claim) holds the receipt; every other row is small.
		expect(pending.operations[0]!).toBeGreaterThan(2_000_000);
		expect(pending.operations.slice(1).every((bytes) => bytes < limit)).toBe(true);
		const held = h.store.getOperation(task.id, "result-test")!;
		expect(held.receipt).toBeUndefined();
		expect(h.store.task(task.id)!.result!.exportIncomplete).toMatchObject({ resultTestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
		expect(h.store.task(task.id)!.result!.exportIncomplete).not.toHaveProperty("resultTest");
		const review = (h.fleet as any).exportReview(task.id);
		h.fleet.acceptIncompleteExport(task.id, { operator: "ops", reviewDigest: review.reviewDigest });
		expect(h.store.task(task.id)).toMatchObject({ phase: "succeeded", result: { verified: true } });
		const accepted = sizes();
		expect(accepted.task).toBeLessThan(limit);
		expect(accepted.operations[0]!).toBeGreaterThan(2_000_000);
		expect(accepted.operations.slice(1).every((bytes) => bytes < limit)).toBe(true);
		const claim = h.store.getOperation(task.id, "result-test")!;
		expect(claim.receipt).toEqual(held.held);
		expect(claim).not.toHaveProperty("held");
		h.reopen();
		expect(((await h.fleet.result(task.id, big)) as any).status).toBe("verified");
		h.store.close();
	}, 180_000);
});

// ---- F4: the outputHead read is bounded and non-fatal ------------------------------

describe("F4: outputHead is the workspace HEAD Git reports, else the base commit", () => {
	test("a worker commit is reported; a garbage or deleted workspace .git collects with outputHead = baseCommit", async () => {
		const f = await repositoryFixture("fleet-r6-f4-");
		directories.push(f.dir);
		const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: "a".repeat(64), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		await writeFile(join(identity.path, "committed.txt"), "c");
		await gitIn(identity.path, "add", "--", "committed.txt");
		await gitIn(identity.path, "commit", "-qm", "worker commit");
		const head = await gitIn(identity.path, "rev-parse", "HEAD");
		expect(head).not.toBe(f.baseCommit);
		const reported = await collectResult(identity, []);
		expect(reported.outputHead).toBe(head);
		await rm(join(identity.path, ".git"), { recursive: true, force: true });
		await writeFile(join(identity.path, ".git"), "garbage\n");
		const garbage = await collectResult(identity, []);
		expect({ outputHead: garbage.outputHead, files: garbage.files.map((file) => file.path) }).toEqual({ outputHead: f.baseCommit, files: reported.files.map((file) => file.path) });
		await rm(join(identity.path, ".git"), { force: true });
		const deleted = await collectResult(identity, []);
		expect({ outputHead: deleted.outputHead, patch: deleted.patch }).toEqual({ outputHead: f.baseCommit, patch: reported.patch });
	}, 120_000);
});

// ---- F6: behaviour tests for the older-hub refusal and the store's acceptance check ---

describe("F6: surviving mutants M6 and M7", () => {
	test("M6: a tracked directory whose only tracked file was deleted and that now holds only .git is refused to an older hub", async () => {
		const f = await repositoryFixture("fleet-r6-m6-");
		directories.push(f.dir);
		await mkdir(join(f.repo, "sub"));
		await writeFile(join(f.repo, "sub", "only.txt"), "tracked\n");
		await f.git("add", "--", "sub/only.txt");
		await f.git("commit", "-m", "tracked directory");
		const baseCommit = await f.git("rev-parse", "HEAD");
		const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: "a".repeat(64), repo: f.repo, baseCommit, workspaceRoot: f.workspaceRoot });
		await unlink(join(identity.path, "sub", "only.txt"));
		await sh(["git", "init", "-q", join(identity.path, "sub")], f.dir);
		expect(await readdir(join(identity.path, "sub"))).toEqual([".git"]);
		const current = await collectResult(identity, [], true);
		expect({ exclusions: current.exclusions, exportComplete: current.exportComplete }).toEqual({ exclusions: [{ path: "sub", reason: "nested_repository", outerTrackedEntries: 1 }], exportComplete: false });
		// An older hub would verify the export as complete without the deletion of sub/only.txt.
		await expect(collectResult(identity, [], false)).rejects.toThrow(/^unsafe_result_entry:export_completeness$/);
	}, 120_000);

	test("M7: store acceptIncompleteExport refuses a self-consistent review that no longer describes the stored result", async () => {
		const h = await hub("fleet-r6-m7-");
		const task = await h.settled("m7");
		await mkdir(join(task.path, "fx"));
		await sh(["git", "init", "-q", join(task.path, "fx")], h.f.dir);
		await writeFile(join(task.path, "d.txt"), "d");
		expect(((await h.fleet.result(task.id, pass)) as any).status).toBe("verified");
		const review = h.store.task(task.id)!.result!.exportIncomplete!;
		// The recorded review is rewritten with its digest recomputed: the digest check alone accepts it.
		const subject = { ...(review.subject as any), exclusions: [] };
		const reviewDigest = exportReviewDigest(subject);
		const raw = new Database(h.db);
		const data = JSON.parse((raw.query("SELECT data FROM tasks WHERE id=?").get(task.id) as any).data);
		data.result.exportIncomplete = { ...data.result.exportIncomplete, subject, reviewDigest };
		raw.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(data), task.id);
		raw.close();
		h.reopen();
		const evidence = { manifestDigest: subject.manifestDigest, testCount: 1, trust: "test" };
		expect(() => h.store.acceptIncompleteExport(task.id, "ops", reviewDigest, evidence)).toThrow("Export review subject must describe the stored passing result");
		expect(h.store.task(task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
		h.store.close();
	}, 180_000);
});

// ---- F7: a junction Git follows is a stable refusal ------------------------------

describe.if(process.platform === "win32")("F7: a Windows junction to a directory holding .git", () => {
	test("refuses with unsafe_result_entry:link on every attempt, not result_changed_during_collection", async () => {
		const f = await repositoryFixture("fleet-r6-f7-");
		directories.push(f.dir);
		const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: "a".repeat(64), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		const outside = await realpath(await mkdtemp(join(tmpdir(), "fleet-r6-f7-outside-")));
		directories.push(outside);
		await sh(["git", "init", "-q", outside], f.dir);
		await writeFile(join(outside, "secret.txt"), "outside");
		await symlink(outside, join(identity.path, "jn"), "junction");
		await writeFile(join(identity.path, "d.txt"), "d");
		for (let attempt = 0; attempt < 2; attempt++) await expect(collectResult(identity, [])).rejects.toThrow(/^unsafe_result_entry:link$/);
	}, 120_000);
});
