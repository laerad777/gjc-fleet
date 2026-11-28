import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Fleet, retainedResult } from "../src/fleet";
import { FleetStore } from "../src/store";
import { getDashboardState } from "../src/dashboard";
import { digest, observationDigest } from "../src/core";
import { repositoryFixture } from "./fixtures/coordinator";
import { run, sha256 } from "../src/workspace";

const cleanups: (() => Promise<void>)[] = [];
/** Passing commands over an incomplete export: still `completed_unverified`, never verified, review pending. */
const PENDING_REVIEW = {
	phase: "completed_unverified",
	result: { verified: false, executionTerminal: true, exportIncomplete: { subject: expect.anything(), reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/), requiredAt: expect.any(String) } },
};
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(unknownVerifier = false, collectResult = true, settled: "completed_unverified" | "failed" = "completed_unverified", infoExclude?: string, cleanupList: (() => Promise<void>)[] = cleanups) {
	const repo = await repositoryFixture("fleet-result-upgrade-");
	// Operator rules are snapshotted when the workspace is prepared.
	if (infoExclude !== undefined) {
		await mkdir(join(repo.repo, ".git", "info"), { recursive: true });
		await writeFile(join(repo.repo, ".git", "info", "exclude"), infoExclude);
	}
	cleanupList.push(() => rm(repo.dir, { recursive: true, force: true }));
	const db = join(repo.dir, "fleet.sqlite");
	let store = new FleetStore(db);
	cleanupList.push(async () => store.close());
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	store.putNode({ id: "local", os: process.platform, arch: process.arch,
		roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], operations: [], transport: { command: process.execPath,
			args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } });
	let fleet = new Fleet(store, { localNodeId: "local" });
	const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "upgrade", caller: "controlled",
		repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled artifact verification", required: {} }).id);
	const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: settled,
		terminal: true, evidence: { injected: "not provider settlement proof" } };
	store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
	let original;
	if (unknownVerifier) {
		store.claimOperation(task.id, "verify-test", { argv: ["unknown-original-verifier"] });
		// Simulate an already retained artifact beside an interrupted earlier test claim.
		original = await (fleet as any).node(task, { action: "collect", identity: task.workspace, tests: [] });
		store.saveResult(task.id, original);
	} else if (collectResult) original = await fleet.result(task.id);
	const counter = join(repo.dir, "verifier-count");
	const argv = [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},'once\\n');console.log('artifact receipt, not CLEAN')`];
	function reopen() { store.close(); store = new FleetStore(db); fleet = new Fleet(store, { localNodeId: "local" }); }
	return { ...repo, db, task, original, argv, counter, reopen, get store() { return store; }, get fleet() { return fleet; } };
}

test("cached not_run upgrades with explicit once-only artifact verification while collected bytes stay immutable", async () => {
	const f = await fixture();
	expect(f.original.status).toBe("not_run");
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	expect(upgraded.status).toBe("verified");
	expect(upgraded.tests[0].argv).toEqual(f.argv);
	expect(upgraded.tests[0].stdout).toBe("artifact receipt, not CLEAN\n");
	expect({ ...upgraded, tests: [], status: "not_run" }).toEqual(f.original);
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
	expect(f.store.task(f.task.id)).toMatchObject({ attemptId: f.task.attemptId, phase: "succeeded", result: { verified: true } });
	expect(f.store.getOperation(f.task.id, "result-test")?.receipt).toBeDefined();
	const corrupt = structuredClone(f.store.getOperation(f.task.id, "result-test")!);
	(corrupt.receipt as any).beforeDigest = "0".repeat(64);
	expect(() => retainedResult(f.store.task(f.task.id)!, f.argv, corrupt)).toThrow("binding mismatch");
	f.reopen();
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(upgraded);
	expect(await f.fleet.result(f.task.id)).toEqual(upgraded);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	await expect(f.fleet.result(f.task.id, [process.execPath, "--eval", "console.log('different')"])).rejects.toThrow();
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
});

test("excluded deliverables retain passing test evidence without verified task status and bind completeness", async () => {
	const f = await fixture(false, false);
	const root = (f.task.workspace as any).path;
	await mkdir(join(root, "deliverable"));
	expect((await run(["git", "init", join(root, "deliverable")], f.dir)).exit).toBe(0);
	await writeFile(join(root, "deliverable/answer.txt"), "hidden answer");
	const original = await f.fleet.result(f.task.id);
	expect(original.exportComplete).toBe(false);
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified"); // command outcome only
	expect(result.exportComplete).toBe(false);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	const proof = structuredClone(f.store.getOperation(f.task.id, "result-test")!);
	const tampered = structuredClone(f.store.task(f.task.id)!);
	(tampered.resultManifest as any).exportComplete = true;
	expect(() => retainedResult(tampered, f.argv, proof)).toThrow();
	f.reopen();
	expect(await f.fleet.result(f.task.id)).toEqual(result);
	expect(f.store.task(f.task.id)?.result?.verified).toBe(false);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
});

describe("unknown result-test effect after execution cannot rerun across reopen", () => {
	// Cycle 1 (the lost verifier response) runs once; each test adds one cycle so each stays fast.
	const local: (() => Promise<void>)[] = [];
	let f: Awaited<ReturnType<typeof fixture>>;
	beforeAll(async () => {
		f = await fixture(false, true, "completed_unverified", undefined, local);
		const original = (f.fleet as any).node.bind(f.fleet);
		(f.fleet as any).node = async (task: unknown, request: any) => {
			const value = await original(task, request);
			if (request.action === "test") throw Error("lost real verifier response");
			return value;
		};
		await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("lost real verifier response");
		f.reopen();
	});
	afterAll(async () => { for (const cleanup of local.splice(0).reverse()) await cleanup(); });
	test("a retained unknown effect reads back TEST_UNKNOWN, never a rerun", async () => {
		await expect(f.fleet.result(f.task.id, f.argv)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
	});
	test("a different argv is refused and the verifier still ran exactly once", async () => {
		await expect(f.fleet.result(f.task.id, ["different"])).rejects.toThrow();
		expect(await readFile(f.counter, "utf8")).toBe("once\n");
	});
	test("the stored task keeps its original manifest and stays unverified", () => {
		expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
		expect(f.store.task(f.task.id)?.result?.verified).toBe(false);
	});
});

test("verifier mutation cannot be attributed to cached artifact bytes", async () => {
	const f = await fixture();
	const argv = [process.execPath, "--eval", "await Bun.write('changed.txt','mutated after collection')"];
	await expect(f.fleet.result(f.task.id, argv)).rejects.toThrow("ARTIFACT_CHANGED");
	expect(f.store.getOperation(f.task.id, "result-test")?.receipt).toBeUndefined();
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
	expect(f.store.task(f.task.id)?.result?.verified).toBe(false);
	await expect(f.fleet.result(f.task.id, argv)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
});

test("workspace drift before verifier refuses execution and preserves immutable manifest", async () => {
	const f = await fixture();
	await writeFile(join((f.task.workspace as any).path, "changed.txt"), "drift");
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("ARTIFACT_CHANGED");
	expect(await Bun.file(f.counter).exists()).toBe(false);
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
});

test("failed explicit verifier is retained without success or replay", async () => {
	const f = await fixture();
	const argv = [process.execPath, "--eval", "console.error('artifact test failed');process.exit(9)"];
	const failed = await f.fleet.result(f.task.id, argv);
	expect(failed.status).toBe("tests_failed");
	expect(failed.tests[0].exit).toBe(9);
	f.reopen();
	expect(await f.fleet.result(f.task.id, argv)).toEqual(failed);
	expect(f.store.task(f.task.id)?.result?.verified).toBe(false);
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
});

test("receipt-before-accept crash recovers without rerun, including cache-only reader", async () => {
	const f = await fixture();
	f.store.verifyResult = () => { throw Error("lost accept ACK"); };
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("lost accept ACK");
	f.reopen();
	const current = f.store.task(f.task.id)!;
	const recovered = retainedResult(current, f.argv, f.store.getOperation(f.task.id, "result-test"));
	expect(recovered.status).toBe("verified");
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(recovered);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	expect(digest(f.store.task(f.task.id)!.resultManifest)).toBe(digest(f.original));
});

test("rollback blocks new cached-result verifier claims but preserves retained upgrade receipt", async () => {
	const f = await fixture();
	f.store.enterRollback();
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("rollback");
	expect(await Bun.file(f.counter).exists()).toBe(false);
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
});

test("existing unknown verify-test cannot be bypassed by result-test under any argv", async () => {
	const f = await fixture(true);
	expect(() => f.store.claimResultTest(f.task.id, f.argv)).toThrow("never bypass");
	for (const argv of [f.argv, ["unknown-original-verifier"]])
		await expect(f.fleet.result(f.task.id, argv)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	expect(await Bun.file(f.counter).exists()).toBe(false);
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
});

test("concurrent cached-result upgrades execute the explicit verifier once", async () => {
	const f = await fixture();
	const results = await Promise.allSettled([f.fleet.result(f.task.id, f.argv), f.fleet.result(f.task.id, f.argv)]);
	expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
	expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	expect((await f.fleet.result(f.task.id, f.argv)).status).toBe("verified");
});

test("already claimed result-test may retain late evidence after rollback without new effects", async () => {
	const f = await fixture();
	const node = (f.fleet as any).node.bind(f.fleet);
	(f.fleet as any).node = async (task: unknown, request: any) => {
		const value = await node(task, request);
		if (request.action === "test") f.store.enterRollback();
		return value;
	};
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified");
	f.reopen();
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(result);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(f.original);
});

test("read-only store rejects fresh upgrade without verifier effects", async () => {
	const f = await fixture();
	const readonly = new FleetStore(f.db, 2, { readOnly: true });
	try {
		const fleet = new Fleet(readonly, { localNodeId: "local" });
		await expect(fleet.result(f.task.id, f.argv)).rejects.toMatchObject({ code: "READ_ONLY" });
		expect(await Bun.file(f.counter).exists()).toBe(false);
		expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	} finally { readonly.close(); }
});

test("caller mutation after result starts cannot change the durably authorized verifier", async () => {
	const f = await fixture();
	const approved = [...f.argv];
	const pending = f.fleet.result(f.task.id, f.argv);
	f.argv.splice(0, f.argv.length, "must-not-execute");
	const result = await pending;
	expect(result.tests[0].argv).toEqual(approved);
	expect((f.store.getOperation(f.task.id, "result-test")!.payload as any).argv).toEqual(approved);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
});

test("missing explicit workspace route cannot consume the once-only upgrade claim", async () => {
	const f = await fixture();
	const implicit = new Fleet(f.store);
	await expect(implicit.result(f.task.id, f.argv)).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_TRANSPORT_REQUIRED" });
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	expect(await Bun.file(f.counter).exists()).toBe(false);
	expect((await f.fleet.result(f.task.id, f.argv)).status).toBe("verified");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
});

test("missing explicit workspace route cannot consume the initial verifier claim", async () => {
	const f = await fixture(false, false);
	const implicit = new Fleet(f.store);
	await expect(implicit.result(f.task.id, f.argv)).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_TRANSPORT_REQUIRED" });
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeUndefined();
	expect(f.store.task(f.task.id)?.resultManifest).toBeUndefined();
	expect(await Bun.file(f.counter).exists()).toBe(false);
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified");
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeDefined();
	f.reopen();
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(result);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
});

test("unknown initial verifier effects cannot rerun after route restoration or reopen", async () => {
	const f = await fixture(false, false);
	const node = (f.fleet as any).node.bind(f.fleet);
	(f.fleet as any).node = async (task: unknown, request: any) => {
		const value = await node(task, request);
		if (request.action === "test") throw Error("lost initial verifier response");
		return value;
	};
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("lost initial verifier response");
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeDefined();
	const implicit = new Fleet(f.store);
	await expect(implicit.result(f.task.id, f.argv)).rejects.toThrow("TEST_UNKNOWN");
	f.reopen();
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("TEST_UNKNOWN");
	await expect(f.fleet.result(f.task.id, ["different"])).rejects.toThrow("TEST_UNKNOWN");
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
});

// ---- Re-review 95958066 findings 2 and 3 -----------------------------------
const LEGACY_KEYS = ["files", "identity", "outputHead", "patch", "patchDigest", "producer", "schemaVersion", "status", "tests"];
/** A real old-shape manifest: exactly the keys the reviewed base collector produced. */
async function legacyManifest(f: Awaited<ReturnType<typeof fixture>>, tests: unknown[] = []) {
	const fresh = await (f.fleet as any).node(f.task, { action: "collect", identity: f.task.workspace, tests });
	const { exclusions, exportComplete, ignored, junk, ...legacy } = fresh;
	expect(exclusions).toEqual([]);
	expect(exportComplete).toBe(true);
	expect(ignored).toEqual({ count: 0, unlisted: 0, paths: [] });
	expect(junk).toEqual({ count: 0, unlisted: 0, paths: [] });
	expect(Object.keys(legacy).sort()).toEqual(LEGACY_KEYS);
	return legacy;
}
const fleetModule = await import("../src/fleet");
async function incompleteVerified() {
	const f = await fixture(false, false);
	const root = (f.task.workspace as any).path;
	await mkdir(join(root, "fixtures", "repo"), { recursive: true });
	expect((await run(["git", "init", join(root, "fixtures", "repo")], f.dir)).exit).toBe(0);
	await writeFile(join(root, "fixtures", "repo", "fixture.txt"), "review fixture");
	await writeFile(join(root, "deliverable.txt"), "outer deliverable");
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified");
	expect(result.exclusions).toEqual([{ path: "fixtures/repo", reason: "nested_repository", outerTrackedEntries: 0 }]);
	return { f, result };
}

test("incomplete export with passing tests stays completed_unverified under a pending export review (result.exportIncomplete)", async () => {
	const { f, result } = await incompleteVerified();
	const task = f.store.task(f.task.id)!;
	expect(task).toMatchObject(PENDING_REVIEW);
	expect(task.result?.exportIncomplete).toMatchObject({ subject: { taskId: f.task.id, attemptId: f.task.attemptId, completeness: "incomplete", exclusions: result.exclusions, manifestDigest: digest(result), artifactSchema: "exclusions-v1" } });
	expect(task.result?.exportIncomplete?.acceptance).toBeUndefined();
	expect(f.store.events(f.task.id).some(event => event.kind === "export_review_required")).toBe(true);
	f.reopen();
	expect(await f.fleet.result(f.task.id)).toEqual(result);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	const review = (f.fleet as any).exportReview(f.task.id);
	expect(review).toMatchObject({ taskId: f.task.id, attemptId: f.task.attemptId, phase: "completed_unverified", required: true, completeness: "incomplete", exclusions: result.exclusions, manifestDigest: digest(result), accepted: null });
	expect(review.reviewDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("operator acceptance of an incomplete export is explicit, audited and bound to the reviewed exclusion digest", async () => {
	const { f, result } = await incompleteVerified();
	const fleet = f.fleet as any;
	const review = fleet.exportReview(f.task.id);
	for (const [acceptance, code] of [
		[{ operator: "ops@example", reviewDigest: "0".repeat(64) }, "EXPORT_REVIEW_CHANGED"],
		[{ operator: "ops@example", reviewDigest: (fleetModule as any).exportReviewDigest({ ...review.subject, exclusions: [] }) }, "EXPORT_REVIEW_CHANGED"],
		[{ operator: "ops@example", reviewDigest: (fleetModule as any).exportReviewDigest({ ...review.subject, attemptId: "other-attempt" }) }, "EXPORT_REVIEW_CHANGED"],
		[{ operator: "", reviewDigest: review.reviewDigest }, "INVALID_INPUT"],
		[{ operator: "bad\noperator", reviewDigest: review.reviewDigest }, "INVALID_INPUT"],
		[{ reviewDigest: review.reviewDigest }, "INVALID_INPUT"],
	] as const) {
		expect(() => fleet.acceptIncompleteExport(f.task.id, acceptance)).toThrow(expect.objectContaining({ code }));
		expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	}
	const accepted = fleet.acceptIncompleteExport(f.task.id, { operator: "ops@example", reviewDigest: review.reviewDigest });
	expect(accepted).toMatchObject({ phase: "succeeded", result: { verified: true } });
	// Verification evidence keeps the shape earlier releases re-derive; the acceptance is export evidence.
	expect(accepted.result.verificationEvidence).toEqual({ manifestDigest: digest(result), testCount: result.tests.length, trust: "trusted node command evidence, not remote attestation" });
	const evidence = accepted.result.exportEvidence;
	expect(evidence).toMatchObject({ manifestDigest: digest(result), exportComplete: false, completeness: "incomplete", exclusions: result.exclusions, reviewDigest: review.reviewDigest, acceptance: { operator: "ops@example", reviewDigest: review.reviewDigest } });
	expect(Number.isFinite(Date.parse(evidence.acceptance.acceptedAt))).toBe(true);
	const audit = f.store.events(f.task.id).filter(event => event.kind === "incomplete_export_accepted");
	expect(audit).toHaveLength(1);
	expect(audit[0]!.data).toMatchObject({ operator: "ops@example", reviewDigest: review.reviewDigest, manifestDigest: digest(result), exclusions: 1 });
	f.reopen();
	const again = (f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops@example", reviewDigest: review.reviewDigest });
	expect(again.result.exportEvidence).toEqual(evidence);
	expect(again.result.verificationEvidence).toEqual(accepted.result.verificationEvidence);
	expect(() => (f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "someone-else", reviewDigest: review.reviewDigest })).toThrow(expect.objectContaining({ code: "VERIFICATION_CONFLICT" }));
	expect(await f.fleet.result(f.task.id)).toEqual(result);
	expect(f.store.task(f.task.id)?.phase).toBe("succeeded");
	expect((f.fleet as any).exportReview(f.task.id).accepted).toMatchObject({ operator: "ops@example" });
	expect(() => f.store.verifyResult(f.task.id, { manifestDigest: digest(result), exportComplete: true })).toThrow();
});

test("acceptance is refused when no export review is required", async () => {
	const complete = await fixture();
	await complete.fleet.result(complete.task.id, complete.argv);
	expect(complete.store.task(complete.task.id)?.phase).toBe("succeeded");
	expect(() => (complete.fleet as any).acceptIncompleteExport(complete.task.id, { operator: "ops", reviewDigest: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "EXPORT_REVIEW_NOT_REQUIRED" }));
	expect((complete.fleet as any).exportReview(complete.task.id)).toMatchObject({ completeness: "complete", reviewDigest: null });
	// Incomplete export without passing tests is not an export-review case.
	const f = await fixture(false, false);
	const root = (f.task.workspace as any).path;
	expect((await run(["git", "init", join(root, "nested")], f.dir)).exit).toBe(0);
	const notRun = await f.fleet.result(f.task.id);
	expect(notRun).toMatchObject({ status: "not_run", exportComplete: false });
	expect(f.store.task(f.task.id)?.phase).toBe("completed_unverified");
	expect(() => (f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "EXPORT_REVIEW_NOT_REQUIRED" }));
});

test("thin CLI verbs review and accept an incomplete export with exact exits", async () => {
	const { f } = await incompleteVerified();
	const cli = (...args: string[]) => {
		const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--db", f.db, ...args], { stdout: "pipe", stderr: "pipe" });
		return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
	};
	const review = cli("export", "review", f.task.id);
	expect(review.exit).toBe(0);
	const parsed = JSON.parse(review.stdout);
	expect(parsed).toMatchObject({ phase: "completed_unverified", required: true, completeness: "incomplete" });
	const refused = cli("export", "accept", f.task.id, "0".repeat(64), "--operator", "ops@example");
	expect(refused.exit).toBe(1);
	expect(JSON.parse(refused.stderr)).toEqual({ ok: false, error: "EXPORT_REVIEW_CHANGED" });
	expect(cli("export", "accept", f.task.id, parsed.reviewDigest).exit).toBe(1);
	const ok = cli("export", "accept", f.task.id, parsed.reviewDigest, "--operator", "ops@example");
	expect(ok.exit).toBe(0);
	expect(JSON.parse(ok.stdout)).toMatchObject({ phase: "succeeded", result: { verified: true } });
	f.reopen();
	expect(f.store.task(f.task.id)?.phase).toBe("succeeded");
});

test("legacy not_run manifest is verified under its own artifact schema, not ARTIFACT_CHANGED", async () => {
	const f = await fixture(false, false);
	const legacy = await legacyManifest(f);
	f.store.saveResult(f.task.id, legacy);
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	expect(upgraded.status).toBe("verified");
	expect("exclusions" in upgraded || "exportComplete" in upgraded).toBe(false);
	expect(f.store.task(f.task.id)?.resultManifest).toEqual(legacy);
	const receipt = f.store.getOperation(f.task.id, "result-test")!.receipt as any;
	expect(receipt).toMatchObject({ artifactSchema: "legacy-v1", observedExclusions: [] });
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "succeeded", result: { verified: true, exportEvidence: { exportComplete: true, artifactSchema: "legacy-v1" } } });
	// Byte-compatible with earlier releases, which re-derive and compare it on every `result` read.
	expect(Object.keys(f.store.task(f.task.id)!.result!.verificationEvidence as object).sort()).toEqual(["manifestDigest", "testCount", "trust"]);
	f.reopen();
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(upgraded);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	const corrupt = structuredClone(f.store.getOperation(f.task.id, "result-test")!);
	(corrupt.receipt as any).observedExclusions = [{ path: "../x", reason: "nested_repository", outerTrackedEntries: 0 }];
	expect(() => retainedResult(f.store.task(f.task.id)!, f.argv, corrupt)).toThrow();
});

test("legacy manifest upgrade still detects real byte changes", async () => {
	const f = await fixture(false, false);
	f.store.saveResult(f.task.id, await legacyManifest(f));
	await writeFile(join((f.task.workspace as any).path, "changed.txt"), "drift");
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("ARTIFACT_CHANGED");
	expect(await Bun.file(f.counter).exists()).toBe(false);
});

test("legacy manifest upgrade that observes a nested repository requires export review instead of success", async () => {
	const f = await fixture(false, false);
	f.store.saveResult(f.task.id, await legacyManifest(f));
	const root = (f.task.workspace as any).path;
	expect((await run(["git", "init", join(root, "nested")], f.dir)).exit).toBe(0);
	// The nested repository is opaque, so legacy-schema artifact bytes are unchanged.
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	expect(upgraded.status).toBe("verified");
	// Held with the review, not as the claim's receipt, until acceptance (review fx-093cc54b F1).
	expect(f.store.getOperation(f.task.id, "result-test")!.receipt).toBeUndefined();
	const receipt = f.store.getOperation(f.task.id, "result-test")!.held as any;
	expect(receipt.observedExclusions).toEqual([{ path: "nested", reason: "nested_repository", outerTrackedEntries: 0 }]);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	expect((f.fleet as any).exportReview(f.task.id)).toMatchObject({ completeness: "incomplete", exclusions: receipt.observedExclusions });
});

test("legacy verified manifest with unknown completeness reaches export review and can be accepted explicitly", async () => {
	const f = await fixture(false, false);
	const evidence = await (f.fleet as any).node(f.task, { action: "test", identity: f.task.workspace, argv: f.argv });
	const legacy = await legacyManifest(f, [evidence]);
	expect(legacy.status).toBe("verified");
	f.store.saveResult(f.task.id, legacy);
	expect(await f.fleet.result(f.task.id)).toEqual(legacy);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	const review = (f.fleet as any).exportReview(f.task.id);
	expect(review).toMatchObject({ completeness: "unknown", exclusions: null });
	const accepted = (f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest });
	expect(accepted).toMatchObject({ phase: "succeeded", result: { verified: true, exportEvidence: { completeness: "unknown", exportComplete: false } } });
	expect(Object.keys(accepted.result.verificationEvidence).sort()).toEqual(["manifestDigest", "testCount", "trust"]);
});

test("verification receipts recorded before observation fields remain valid; legacy completeness is then unknown", async () => {
	const f = await fixture(false, false);
	const legacy = await legacyManifest(f);
	f.store.saveResult(f.task.id, legacy);
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	const operation = f.store.getOperation(f.task.id, "result-test")!;
	const { artifactSchema, observedExclusions, ...oldShape } = operation.receipt as any;
	expect(artifactSchema).toBe("legacy-v1");
	expect(observedExclusions).toEqual([]);
	const old = { ...operation, receipt: oldShape };
	expect(retainedResult(f.store.task(f.task.id)!, f.argv, old)).toEqual(upgraded);
	expect(() => retainedResult(f.store.task(f.task.id)!, f.argv, { ...operation, receipt: { ...oldShape, artifactSchema: "exclusions-v1", observedExclusions: [] } })).toThrow(expect.objectContaining({ code: "VERIFICATION_CONFLICT" }));
	expect(() => retainedResult(f.store.task(f.task.id)!, f.argv, { ...operation, receipt: { ...oldShape, artifactSchema: "legacy-v1" } })).toThrow(expect.objectContaining({ code: "VERIFICATION_CONFLICT" }));
	// Review fx-9abb2530 F5: "observed nothing" (null) is only the receipt of a workspace without a snapshot.
	expect(() => retainedResult(f.store.task(f.task.id)!, f.argv, { ...operation, receipt: { ...oldShape, artifactSchema: "legacy-v1", observedExclusions: null } })).toThrow(expect.objectContaining({ code: "VERIFICATION_CONFLICT" }));
});

test("failed executions with incomplete exports keep their failed phase and need no export review", async () => {
	const f = await fixture(false, false, "failed");
	const root = (f.task.workspace as any).path;
	expect((await run(["git", "init", join(root, "nested")], f.dir)).exit).toBe(0);
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result).toMatchObject({ status: "verified", exportComplete: false });
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "failed", result: { verified: false } });
	expect(f.store.task(f.task.id)?.result?.exportIncomplete).toBeUndefined();
	expect(() => (f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "EXPORT_REVIEW_NOT_REQUIRED" }));
});

// ---- Re-review 5cf4c1e0 HIGH-1, LOW-3 and LOW-4 --------------------------------
test("a file ignored only through info/exclude is never stored and puts the task under export review", async () => {
	const f = await fixture(false, false, "completed_unverified", "local-settings.json\n");
	const root = (f.task.workspace as any).path;
	await writeFile(join(root, "local-settings.json"), '{"apiToken":"INFO_EXCLUDE_SECRET_TOKEN"}');
	await writeFile(join(root, "deliverable.txt"), "outer deliverable");
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified");
	expect(result.exclusions).toEqual([{ path: "local-settings.json", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" }]);
	expect(result.files.map((file) => file.path)).toEqual(["deliverable.txt"]);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	expect(JSON.stringify(f.store.task(f.task.id))).not.toContain("INFO_EXCLUDE_SECRET_TOKEN");
	const review = (f.fleet as any).exportReview(f.task.id);
	expect(review).toMatchObject({ completeness: "incomplete", exclusions: result.exclusions, required: true });
	expect((f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops@example", reviewDigest: review.reviewDigest })).toMatchObject({ phase: "succeeded" });
});

test("review LOW-3: a fresh collection without completeness fields is refused, never stored as legacy-v1", async () => {
	const f = await fixture(false, false);
	const node = (f.fleet as any).node.bind(f.fleet);
	(f.fleet as any).node = async (task: unknown, request: any) => {
		const value = await node(task, request);
		if (request.action !== "collect") return value;
		const { exclusions, exportComplete, ignored, junk, ...legacy } = value;
		return legacy;
	};
	await expect(f.fleet.result(f.task.id)).rejects.toMatchObject({ code: "RESULT_SCHEMA" });
	expect(f.store.task(f.task.id)?.resultManifest).toBeUndefined();
});

test("review LOW-4: store-level review and verification are bound to the stored passing result", async () => {
	const f = await fixture(false, false);
	const root = (f.task.workspace as any).path;
	expect((await run(["git", "init", join(root, "nested")], f.dir)).exit).toBe(0);
	const notRun = await f.fleet.result(f.task.id);
	expect(notRun.status).toBe("not_run");
	expect(f.store.task(f.task.id)?.phase).toBe("completed_unverified");
	const honest = { taskId: f.task.id, attemptId: f.task.attemptId!, manifestDigest: digest(notRun), artifactSchema: "exclusions-v1", completeness: "incomplete", exclusions: notRun.exclusions };
	const forged = { ...honest, manifestDigest: "0".repeat(64), exclusions: [] };
	const require = (subject: any) => f.store.requireExportReview(f.task.id, subject, fleetModule.exportReviewDigest(subject));
	// Commands not run: no subject can be recorded, honest or forged.
	for (const subject of [forged, honest]) expect(() => require(subject)).toThrow("describe the stored passing result");
	// An incomplete stored export cannot be verified directly at the store either.
	expect(() => f.store.verifyResult(f.task.id, { forged: true })).toThrow("EXPORT_REVIEW_REQUIRED");
	// A failing verifier: the effective result is tests_failed and cannot be promoted.
	const failed = await f.fleet.result(f.task.id, [process.execPath, "--eval", "process.exit(3)"]);
	expect(failed.status).toBe("tests_failed");
	expect(() => require({ ...honest, manifestDigest: digest(failed) })).toThrow("describe the stored passing result");
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
	expect(f.store.task(f.task.id)?.result?.exportIncomplete).toBeUndefined();
});

test("review LOW-4: a forged subject on a passing result is refused while the honest subject is accepted", async () => {
	const f = await fixture(false, false);
	const root = (f.task.workspace as any).path;
	expect((await run(["git", "init", join(root, "nested")], f.dir)).exit).toBe(0);
	const fleet = f.fleet as any;
	const accept = fleet.acceptResult.bind(fleet);
	fleet.acceptResult = () => {};
	const passed = await f.fleet.result(f.task.id, f.argv);
	fleet.acceptResult = accept;
	expect(passed.status).toBe("verified");
	const honest = { taskId: f.task.id, attemptId: f.task.attemptId!, manifestDigest: digest(passed), artifactSchema: "exclusions-v1", completeness: "incomplete", exclusions: passed.exclusions };
	for (const forged of [
		{ ...honest, manifestDigest: "0".repeat(64) },
		{ ...honest, exclusions: [] },
		{ ...honest, completeness: "unknown" },
		{ ...honest, artifactSchema: "legacy-v1" },
		{ ...honest, extra: true },
	])
		expect(() => f.store.requireExportReview(f.task.id, forged as any, fleetModule.exportReviewDigest(forged as any))).toThrow("describe the stored passing result");
	expect(f.store.requireExportReview(f.task.id, honest as any, fleetModule.exportReviewDigest(honest as any))).toMatchObject(PENDING_REVIEW);
});

test("review LOW-5: tasks awaiting export review are counted in dashboard summary and outcome totals", async () => {
	const { f } = await incompleteVerified();
	const state = getDashboardState(f.store);
	expect(state.summary.exportIncompleteTasks).toBe(1);
	expect(state.pipeline.outcome.exportIncomplete).toBe(1);
	const { succeeded, unverified, exportIncomplete, troubled, cancelled, approval } = state.pipeline.outcome;
	expect(succeeded + unverified + (exportIncomplete ?? 0) + troubled + cancelled + approval).toBe(state.summary.totalTasks);
});

// ---- Review fx-bef2673f findings F2 and F5 ----------------------------------
test("review fx-9abb2530 F5: a legacy not_run result whose workspace predates collection snapshots verifies once with completeness unknown and needs operator acceptance", async () => {
	const f = await fixture(false, false);
	const manifest = await legacyManifest(f);
	// The task as the previous release prepared it: identity and marker without a snapshot.
	const { collectionSnapshot: _snapshot, ...identity } = f.task.workspace as any;
	await writeFile(join(identity.path, ".fleet-identity.json"), JSON.stringify(identity), { mode: 0o600 });
	await writeFile(join(identity.path, "deliverable.txt"), "legacy deliverable");
	const { Database } = await import("bun:sqlite");
	const db = new Database(f.db);
	db.query("UPDATE tasks SET data=json_remove(data,'$.workspace.collectionSnapshot') WHERE id=?").run(f.task.id);
	db.close();
	f.reopen();
	const stored = await (f.fleet as any).node(f.store.task(f.task.id), { action: "collect", identity, tests: [], exportCompleteness: "exclusions-v1" });
	// The node reports a legacy-v1 manifest: no completeness fields, so completeness is unknown.
	expect(Object.keys(stored).sort()).toEqual(LEGACY_KEYS);
	expect(stored.files.map((file: any) => file.path)).toEqual(["deliverable.txt"]);
	f.store.saveResult(f.task.id, stored);
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	expect(upgraded.status).toBe("verified");
	expect((await readFile(f.counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
	// Held with the review, not as the claim's receipt, until acceptance (review fx-093cc54b F1).
	expect(f.store.getOperation(f.task.id, "result-test")!.receipt).toBeUndefined();
	const held = f.store.getOperation(f.task.id, "result-test")!.held;
	expect(held).toEqual(expect.objectContaining({ artifactSchema: "legacy-v1", observedExclusions: null }));
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	const review = (f.fleet as any).exportReview(f.task.id);
	expect(review).toMatchObject({ completeness: "unknown", exclusions: null });
	expect((f.fleet as any).acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest })).toMatchObject({ phase: "succeeded" });
	expect(f.store.getOperation(f.task.id, "result-test")!.receipt).toEqual(held);
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(upgraded);
	expect((await readFile(f.counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
	void manifest;
});

test("review fx-093cc54b F3: a legacy not_run result an earlier release collected after a worker commit is verified explicitly (completeness unknown)", async () => {
	const f = await fixture(false, false);
	// The task as the previous release prepared it: identity and marker without a snapshot.
	const { collectionSnapshot: _snapshot, ...identity } = f.task.workspace as any;
	await writeFile(join(identity.path, ".fleet-identity.json"), JSON.stringify(identity), { mode: 0o600 });
	const { Database } = await import("bun:sqlite");
	const db = new Database(f.db);
	db.query("UPDATE tasks SET data=json_remove(data,'$.workspace.collectionSnapshot') WHERE id=?").run(f.task.id);
	db.close();
	f.reopen();
	// The worker commits a new file, as agents routinely do.
	await writeFile(join(identity.path, "committed.txt"), "committed by the worker\n");
	const git = (...args: string[]) => run(["git", "-c", "user.name=Worker", "-c", "user.email=w@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", identity.path, ...args], f.dir);
	expect((await git("add", "--", "committed.txt")).exit).toBe(0);
	expect((await git("commit", "-qm", "worker commit")).exit).toBe(0);
	const head = (await git("rev-parse", "HEAD")).stdout.trim();
	expect(head).not.toBe(identity.baseCommit);
	// The stored manifest as the earlier release's collector derived it: `outputHead` is the
	// workspace HEAD and the patch is `git diff <baseCommit>` of the worktree (commits included).
	const fresh = await (f.fleet as any).node(f.store.task(f.task.id), { action: "collect", identity, tests: [], exportCompleteness: "exclusions-v1" });
	expect(Object.keys(fresh).sort()).toEqual(LEGACY_KEYS);
	const patch = (await git("diff", "--no-ext-diff", "--no-textconv", "--binary", identity.baseCommit, "--", ".", ":(exclude).fleet-identity.json")).stdout;
	expect(patch).toContain("committed.txt");
	const stored = { ...fresh, outputHead: head, patch, patchDigest: sha256(patch) };
	// Production keeps `outputHead` as the workspace HEAD; the patch still differs (diff of the base tree only).
	expect({ outputHead: stored.outputHead === fresh.outputHead, patch: stored.patch === fresh.patch }).toEqual({ outputHead: true, patch: false });
	f.store.saveResult(f.task.id, stored);
	const upgraded = await f.fleet.result(f.task.id, f.argv);
	expect(upgraded.status).toBe("verified");
	expect((await readFile(f.counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
	expect(f.store.task(f.task.id)).toMatchObject(PENDING_REVIEW);
	expect((f.fleet as any).exportReview(f.task.id)).toMatchObject({ completeness: "unknown", exclusions: null });
	// The exported files still decide: changed bytes are refused, as before.
	const again = await fixture(false, false);
	const { collectionSnapshot: _again, ...againIdentity } = again.task.workspace as any;
	await writeFile(join(againIdentity.path, ".fleet-identity.json"), JSON.stringify(againIdentity), { mode: 0o600 });
	const againDb = new Database(again.db);
	againDb.query("UPDATE tasks SET data=json_remove(data,'$.workspace.collectionSnapshot') WHERE id=?").run(again.task.id);
	againDb.close();
	again.reopen();
	const collected = await (again.fleet as any).node(again.store.task(again.task.id), { action: "collect", identity: againIdentity, tests: [], exportCompleteness: "exclusions-v1" });
	again.store.saveResult(again.task.id, collected);
	await writeFile(join(againIdentity.path, "drift.txt"), "drift");
	await expect(again.fleet.result(again.task.id, again.argv)).rejects.toThrow("ARTIFACT_CHANGED");
	expect(await Bun.file(again.counter).exists()).toBe(false);
}, 20_000);

test("review F5: a fresh collection with a malformed ignored summary is refused RESULT_IGNORED and audited", async () => {
	const f = await fixture(false, false);
	const original = (f.fleet as any).node.bind(f.fleet);
	(f.fleet as any).node = async (task: unknown, request: any) => {
		const value = await original(task, request);
		return request.action === "collect" ? { ...value, ignored: { count: 2, unlisted: 0, paths: ["b", "a"] } } : value;
	};
	await expect(f.fleet.result(f.task.id)).rejects.toMatchObject({ code: "RESULT_IGNORED" });
	const rejected = f.store.events(f.task.id).filter((event) => event.kind === "result_validation_rejected");
	expect(rejected.map((event) => (event.data as any).code)).toEqual(["RESULT_IGNORED"]);
	expect(f.store.task(f.task.id)?.resultManifest).toBeUndefined();
});

// ---- Review fx-9abb2530 F1 (claim order) and F3 (no schema additions) -------
test("review fx-9abb2530 F1: claim first; a before-collection refusal releases the claim unsent, so the verifier runs exactly once later", async () => {
	const f = await fixture(false, false);
	const original = await f.fleet.result(f.task.id);
	expect(original.status).toBe("not_run");
	const fleet = f.fleet as any;
	const node = fleet.node.bind(fleet);
	const claims: unknown[] = [];
	fleet.node = async (task: unknown, request: any) => {
		claims.push(f.store.getOperation(f.task.id, "result-test") ?? null);
		const value = await node(task, request);
		if (request.action !== "collect") return value;
		const { exclusions, exportComplete, ignored, junk, ...legacy } = value;
		return legacy;
	};
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toMatchObject({ code: "RESULT_SCHEMA" });
	// The claim existed while collecting (claim first), and was released unsent afterwards.
	expect(claims.length).toBe(1);
	expect(claims[0]).not.toBeNull();
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	expect(await Bun.file(f.counter).exists()).toBe(false);
	fleet.node = node;
	expect((await f.fleet.result(f.task.id, f.argv)).status).toBe("verified");
	expect(await f.fleet.result(f.task.id, f.argv)).toMatchObject({ status: "verified" });
	expect((await readFile(f.counter, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

test("review fx-9abb2530 F3: a read-write open adds no table, index or trigger beyond the production schema", async () => {
	const f = await fixture(false, false);
	f.store.close();
	const { Database } = await import("bun:sqlite");
	const db = new Database(f.db);
	const names = (db.query("SELECT type, name FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string }[]).map((row) => row.type + ":" + row.name);
	db.close();
	f.reopen();
	expect(names.filter((name) => /collection_pin|export_review_fence|insert_fence|delete_fence/.test(name))).toEqual([]);
});
