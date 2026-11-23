import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { prepareWorkspace, run } from "../src/workspace";
import { getDashboardState } from "../src/dashboard";
import { runTask, taskExit, watchTasks } from "../src/operator-commands";
import { returnResources } from "../src/resource-return";
import { reconsiderQueue } from "../src/index";
import { repositoryFixture } from "./fixtures/coordinator";

// Round-8 review (92d27e99) MEDIUM-2: an incomplete export must not introduce state that an
// older release cannot open, list or operate on. Design (a): no new phase; the task stays
// completed_unverified and result.exportIncomplete blocks verification until audited acceptance.
// FLEET_ROLLBACK_TREE names an extracted older release (e.g. fleet-main-cb1b744/); the reader
// runs that release's own modules against a database this release wrote.

const ROLLBACK_TREE = process.env.FLEET_ROLLBACK_TREE;
const pass = [process.execPath, "--eval", "console.log('pass')"];
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A database whose tasks met an incomplete export (nested repository) and await operator review. */
async function pendingReviewDatabase(deferTerminalRelease: boolean) {
	const f = await repositoryFixture("fleet-export-rollback-");
	directories.push(f.dir);
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db, 4, { deferTerminalRelease });
	const transport = { command: process.execPath, args: [] };
	store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport, sdkTransport: transport });
	const fleet = new Fleet(store, { localNodeId: "local" });
	const input = (key: string) => ({ schemaVersion: 1 as const, key, caller: "controlled", repoId: "repo", baseCommit: f.baseCommit, prompt: key, required: {} });
	const pending = [];
	for (const key of ["rollback-a", "rollback-b"]) {
		// An exclusively owned ephemeral SDK session with its broker authority, settled with a receipt.
		const task = store.reserve(store.submit(input(key)).id);
		const identity = await prepareWorkspace({ taskId: task.id, attemptId: task.attemptId!, nodeId: "local", inputDigest: task.inputDigest, repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		store.setWorkspace(task.id, identity as any);
		const sessionId = "session-" + key;
		const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
		store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
		store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
		store.recordTurn(task.id, "turn-" + key);
		const body = { sessionId, turnId: "turn-" + key, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
		store.observe(task.id, { ...body, eventId: "settle-" + key, digest: observationDigest(body) });
		// The worker left a nested repository: the export is incomplete.
		await mkdir(join(identity.path, "fx"));
		await run(["git", "init", "-q", join(identity.path, "fx")], f.dir);
		await writeFile(join(identity.path, "d.txt"), "d");
		// rollback-a verifies at its first collection (retained verifier receipt); rollback-b is
		// collected first and verified explicitly afterwards (result-test claim).
		if (key === "rollback-b") expect((await fleet.result(task.id)).status).toBe("not_run");
		const manifest = await fleet.result(task.id, pass);
		expect({ status: manifest.status, exportComplete: (manifest as any).exportComplete }).toEqual({ status: "verified", exportComplete: false });
		expect(store.task(task.id)!.phase).toBe("completed_unverified");
		pending.push({ id: task.id, input: input(key), reviewDigest: fleet.exportReview(task.id).reviewDigest! });
	}
	// A node on which the older release starts new work through the controlled coordinator.
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const freshNode = { id: "node-fresh", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
	const drain = [{ ...store.nodes().find((node) => node.id === "local")!, draining: true }];
	store.close();
	return { f, db, pending, fresh: { input: input("rollback-fresh"), argv: pass, node: freshNode, drain } };
}

/** Review e265ea63 MEDIUM-B: a database with one verified complete export and one accepted incomplete export. */
async function verifiedDatabase() {
	const f = await repositoryFixture("fleet-verified-rollback-");
	directories.push(f.dir);
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db, 4);
	const transport = { command: process.execPath, args: [] };
	store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport, sdkTransport: transport });
	const fleet = new Fleet(store, { localNodeId: "local" });
	const tasks = [];
	for (const [key, incomplete, explicit] of [["verified-complete", false, false], ["verified-accepted", true, false], ["verified-accepted-explicit", true, true]] as const) {
		const task = store.reserve(store.submit({ schemaVersion: 1 as const, key, caller: "controlled", repoId: "repo", baseCommit: f.baseCommit, prompt: key, required: {} }).id);
		const identity = await prepareWorkspace({ taskId: task.id, attemptId: task.attemptId!, nodeId: "local", inputDigest: task.inputDigest, repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		store.setWorkspace(task.id, identity as any);
		const sessionId = "session-" + key;
		const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
		store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
		store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
		store.recordTurn(task.id, "turn-" + key);
		const body = { sessionId, turnId: "turn-" + key, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
		store.observe(task.id, { ...body, eventId: "settle-" + key, digest: observationDigest(body) });
		await writeFile(join(identity.path, "d.txt"), "d");
		if (incomplete) {
			await mkdir(join(identity.path, "fx"));
			await run(["git", "init", "-q", join(identity.path, "fx")], f.dir);
		}
		if (explicit) expect((await fleet.result(task.id)).status).toBe("not_run");
		const manifest = await fleet.result(task.id, pass);
		if (incomplete) fleet.acceptIncompleteExport(task.id, { operator: "ops", reviewDigest: fleet.exportReview(task.id).reviewDigest! });
		expect({ status: manifest.status, phase: store.task(task.id)!.phase }).toEqual({ status: "verified", phase: "succeeded" });
		tasks.push({ id: task.id, key, digest: digest(await fleet.result(task.id)), stored: digest(store.task(task.id)!.resultManifest as any), evidence: store.task(task.id)!.result!.verificationEvidence });
	}
	store.close();
	return { db, tasks };
}

describe("export review is rollback-safe (design a: completed_unverified + result.exportIncomplete)", () => {
	test("the pending task is persisted in a phase every release knows, with the review on its result", async () => {
		const { db, pending } = await pendingReviewDatabase(false);
		const raw = new Database(db, { readonly: true });
		for (const { id, reviewDigest } of pending) {
			const row = raw.query("SELECT json_extract(data,'$.phase') AS phase, json_extract(data,'$.result.verified') AS verified, json_extract(data,'$.result.exportIncomplete.reviewDigest') AS digest FROM tasks WHERE id=?").get(id) as any;
			expect(row).toEqual({ phase: "completed_unverified", verified: 0, digest: reviewDigest });
		}
		// Nothing in the database names a phase the previous release lacks.
		expect((raw.query("SELECT count(*) AS n FROM tasks WHERE data LIKE '%export_incomplete%' OR json_extract(data,'$.phase') NOT IN ('queued','preparing','dispatching','active','approval_required','blocked_unknown','cancel_unknown','completed_unverified','succeeded','failed','archived','cancelled')").get() as any).n).toBe(0);
		raw.close();
	});

	test("review fx-093cc54b F1: a pending review persists no passing result an earlier release verifies on a read; acceptance never rewrites the stored manifest (fx-397df5a5 F1)", async () => {
		const { db, pending } = await pendingReviewDatabase(false);
		const raw = new Database(db, { readonly: true });
		const stored = (id: string) => {
			const row = raw.query("SELECT json_extract(data,'$.resultManifest.status') AS status, json_array_length(data,'$.resultManifest.tests') AS tests FROM tasks WHERE id=?").get(id) as any;
			const claim = raw.query("SELECT json_extract(data,'$.receipt') AS receipt FROM operations WHERE task_id=? AND kind='result-test'").get(id) as any;
			return { ...row, claimReceipt: claim ? claim.receipt !== null : null };
		};
		// Earlier releases verify a stored `verified` manifest, or a result-test claim's passing receipt, on every read.
		expect(pending.map(({ id }) => stored(id))).toEqual([
			{ status: "not_run", tests: 0, claimReceipt: null },
			{ status: "not_run", tests: 0, claimReceipt: false },
		]);
		raw.close();
		const store = new FleetStore(db, 4);
		try {
			for (const { id, reviewDigest } of pending) {
				const fleet = new Fleet(store, { localNodeId: store.task(id)!.nodeId });
				const before = await fleet.result(id, pass);
				expect(before.status).toBe("verified");
				fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest });
				expect(await fleet.result(id, pass)).toEqual(before);
			}
		} finally {
			store.close();
		}
		const after = new Database(db, { readonly: true });
		const accepted = (id: string) => ({
			status: (after.query("SELECT json_extract(data,'$.resultManifest.status') AS s FROM tasks WHERE id=?").get(id) as any).s,
			claimReceipt: (after.query("SELECT json_extract(data,'$.receipt.test.exit') AS exit FROM operations WHERE task_id=? AND kind='result-test'").get(id) as any)?.exit ?? null,
		});
		// The held receipt joins the stored manifest on read (no claim) or becomes the claim's receipt.
		expect(pending.map(({ id }) => accepted(id))).toEqual([{ status: "not_run", claimReceipt: null }, { status: "not_run", claimReceipt: 0 }]);
		after.close();
	});

	test("the store refuses verifying a pending review without its exact acceptance (review fx-9abb2530 F3: no schema trigger)", async () => {
		const { db, pending } = await pendingReviewDatabase(true);
		const [{ id, reviewDigest }] = pending;
		const store = new FleetStore(db, 4, { deferTerminalRelease: true });
		try {
			const fleet = new Fleet(store, { localNodeId: store.task(id)!.nodeId });
			expect(() => store.verifyResult(id, { forged: true })).toThrow("EXPORT_REVIEW_REQUIRED");
			expect(() => fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "EXPORT_REVIEW_CHANGED" }));
			expect(() => store.acceptIncompleteExport(id, "ops", "0".repeat(64), { forged: true })).toThrow("EXPORT_REVIEW_CHANGED");
			expect(store.task(id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
			// Acceptance of the exact digest verifies the recorded passing verifier in the same write.
			expect(fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest }).phase).toBe("succeeded");
			expect(store.task(id)!.result!.exportIncomplete!.acceptance).toMatchObject({ operator: "ops", reviewDigest });
		} finally {
			store.close();
		}
	});

	test("every consumer of this release treats a pending review as an unverified completion that is not success", async () => {
		const { f, db, pending } = await pendingReviewDatabase(true);
		const store = new FleetStore(db, 4, { deferTerminalRelease: true });
		try {
			const fleet = new Fleet(store, { localNodeId: "local" });
			const [{ id, input, reviewDigest }] = pending;
			// Operator run/watch: one exit-code table row (0) for every completed_unverified task; settled, never re-run.
			expect(taskExit(store.task(id)!)).toBe(0);
			const ran = await runTask(fleet, input, { sample: async () => new Map(), localNodeId: "local" });
			expect({ code: ran.code, phase: ran.task.phase, reused: ran.reused }).toEqual({ code: 0, phase: "completed_unverified", reused: true });
			const emitted: any[] = [];
			expect(await watchTasks(fleet, { ids: [id], maxPolls: 2, interval: 10, emit: (value) => emitted.push(value), sleep: async () => {} })).toBe(0);
			expect(emitted.at(-1)).toMatchObject({ observation: "summary", exit: 0, tasks: { [id]: 0 } });
			// Archive: like every completed_unverified task it is never archived (ARCHIVE_PHASE admits failed and
			// unknown phases only, unchanged from main; here the original-node query refuses first).
			await expect(fleet.archive(id, { noSessionConfirmation: { kind: "never_started", reason: "review pending" } })).rejects.toThrow();
			expect(store.task(id)!.phase).toBe("completed_unverified");
			// Queue reconsider: only unattempted queued tasks are candidates.
			expect(await reconsiderQueue(fleet, async () => new Map())).toEqual([]);
			// Dashboard: counted as awaiting export review, not as unverified.
			const dashboard = getDashboardState(store);
			expect({ review: dashboard.summary.exportIncompleteTasks, outcome: dashboard.pipeline.outcome }).toMatchObject({ review: 2, outcome: { exportIncomplete: 2, unverified: 0, succeeded: 0 } });
			expect(dashboard.tasks.find((task: any) => task.id === id)).toMatchObject({ phase: "completed_unverified", exportReview: "required" });
			// Backup: the copy keeps the pending review, unverified (review fx-9abb2530 F3: no schema trigger).
			const copy = join(f.dir, "backup.sqlite");
			store.backup(copy);
			const backup = new Database(copy, { readonly: true });
			expect((backup.query("SELECT json_extract(data,'$.result.exportIncomplete.reviewDigest') AS digest FROM tasks WHERE id=?").get(id) as any).digest).toBe(reviewDigest);
			expect(backup.query("SELECT json_extract(data,'$.phase') AS phase, json_extract(data,'$.result.verified') AS verified FROM tasks WHERE id=?").get(id)).toEqual({ phase: "completed_unverified", verified: 0 });
			backup.close();
			// Resource return: a settled pending review returns its session and slot; the review stays pending.
			let indexSeq = 0;
			const connect = async () => ({ list: async () => ({ type: "broker_response", ok: true, result: { indexSeq: ++indexSeq, sessions: [] } }), fencedClose: async () => { throw new Error("no close expected"); }, close() {} });
			expect((await returnResources(store, [id], { connect, paceMs: 0 }))[0]).toMatchObject({ state: "returned" });
			expect(store.task(id)).toMatchObject({ phase: "completed_unverified", held: false, result: { verified: false, exportIncomplete: { reviewDigest } } });
			expect(fleet.exportReview(id)).toMatchObject({ required: true, reviewDigest });
			// Acceptance after return still verifies; reading the result is idempotent afterwards.
			expect(fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest })).toMatchObject({ phase: "succeeded", held: false });
			expect((await fleet.result(id)).status).toBe("verified");
		} finally {
			store.close();
		}
	});

	test.skipIf(!ROLLBACK_TREE || !existsSync(join(ROLLBACK_TREE ?? "", "src/store.ts")))(
		"an older release (FLEET_ROLLBACK_TREE) opens, lists and operates on a database with pending export reviews and never verifies them",
		async () => {
			for (const deferTerminalRelease of [false, true]) {
				const made = await pendingReviewDatabase(deferTerminalRelease);
				const reader = Bun.spawnSync(
					[process.execPath, join(import.meta.dir, "fixtures/rollback-reader.ts"), ROLLBACK_TREE!, JSON.stringify({ db: made.db, cap: 4, deferTerminalRelease, pending: made.pending, fresh: made.fresh })],
					{ stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_FLEET_LOCAL_NODE_ID: "" } },
				);
				const stderr = reader.stderr.toString();
				expect({ exit: reader.exitCode, stderr: reader.exitCode === 0 ? "" : stderr }).toEqual({ exit: 0, stderr: "" });
				const report = JSON.parse(reader.stdout.toString().trim().split("\n").at(-1)!);
				if (process.env.FLEET_ROLLBACK_REPORT) await writeFile(process.env.FLEET_ROLLBACK_REPORT + "." + deferTerminalRelease + ".json", JSON.stringify(report, null, 2) + "\n");
				// Opens and lists.
				expect(report.opened).toBe(true);
				expect(report.listed.map((task: any) => task.phase)).toEqual(["completed_unverified", "completed_unverified"]);
				expect(report.cliTasks).toEqual({ exit: 0, lines: 2 });
				expect(report.cliShow).toEqual({ exit: 0, phase: "completed_unverified" });
				expect(report.dashboard.summary.totalTasks).toBe(2);
				expect(report.dashboard.outcome).toMatchObject({ succeeded: 0, unverified: 2 });
				for (const entry of report.pending) {
					expect(entry.validateResult.ok).toBe(true);
					// Run reports it like any unverified completion (exit 0 row of the table).
					expect(entry.taskExit).toBe(0);
					expect(entry.run).toMatchObject({ ok: true, phase: "completed_unverified", status: 0 });
					// Review fx-093cc54b F1: nothing persisted is a passing result to the older release. It reads
					// the stored result as never tested, refuses to run a verifier again (the original verifier's
					// outcome is retained), and neither the API nor `result ID` turns it into success.
					expect(entry.result).toEqual({ ok: true, phase: null, status: "not_run" });
					expect(entry.resultWithArgv).toMatchObject({ ok: false, code: "TEST_UNKNOWN" });
					expect(entry.cliResult).toEqual({ exit: 0, stderr: "" });
					expect(entry.after).toMatchObject({ phase: "completed_unverified", verified: false });
					expect(entry.after.exportIncomplete).toEqual(entry.before.exportIncomplete);
					expect(made.pending.map((p) => p.reviewDigest)).toContain(entry.after.exportIncomplete.reviewDigest);
					expect(entry.after.exportIncomplete.acceptance).toBeUndefined();
					// A deferred-release reservation is still returned by the older release.
					expect(entry.before.held).toBe(deferTerminalRelease);
					if (deferTerminalRelease) expect({ state: entry.resourceReturn, held: entry.afterReturn.held }).toEqual({ state: "returned", held: false });
				}
				// Operates normally on new work in the same database.
				expect(report.fresh).toMatchObject({ ok: true, phase: "succeeded" });
				// Roll forward: this release still sees the reviews pending and can accept them.
				const store = new FleetStore(made.db, 4, { deferTerminalRelease });
				for (const { id, reviewDigest } of made.pending) {
					const fleet = new Fleet(store, { localNodeId: store.task(id)!.nodeId });
					expect(fleet.exportReview(id).required).toBe(true);
					fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest });
					await fleet.result(id, pass);
					expect(store.task(id)!.phase).toBe("succeeded");
				}
				store.close();
			}
		},
		120_000,
	);
	test.skipIf(!ROLLBACK_TREE || !existsSync(join(ROLLBACK_TREE ?? "", "src/store.ts")))(
		"review e265ea63 MEDIUM-B: an older release (FLEET_ROLLBACK_TREE) reads the result of every task this release verified, complete or accepted",
		async () => {
			const made = await verifiedDatabase();
			const reader = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "fixtures/rollback-result-reader.ts"), ROLLBACK_TREE!, JSON.stringify({ db: made.db, cap: 4, argv: pass, tasks: made.tasks })],
				{ stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_FLEET_LOCAL_NODE_ID: "" } },
			);
			expect({ exit: reader.exitCode, stderr: reader.exitCode === 0 ? "" : reader.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
			const report = JSON.parse(reader.stdout.toString().trim().split("\n").at(-1)!);
			if (process.env.FLEET_ROLLBACK_REPORT) await writeFile(process.env.FLEET_ROLLBACK_REPORT + ".verified.json", JSON.stringify(report, null, 2) + "\n");
			for (const [index, entry] of report.entries()) {
				const made_ = made.tasks[index]!;
				if (made_.key === "verified-accepted") {
					// Acceptance never rewrites the stored manifest (review fx-397df5a5 F1): the older release reads the held
					// `not_run` manifest (its passing receipt is joined only by this release), refuses to re-run its verifier,
					// and never claims a success the stored manifest does not record.
					expect(entry.result).toEqual({ ok: true, status: "not_run", digest: made_.stored });
					expect(entry.resultWithArgv).toMatchObject({ ok: false, code: "TEST_UNKNOWN" });
					expect(entry.cliResult).toEqual({ exit: 0, stderr: "", digest: made_.stored });
				} else {
					for (const read of [entry.result, entry.resultWithArgv]) expect(read).toEqual({ ok: true, status: "verified", digest: made_.digest });
					expect(entry.cliResult).toEqual({ exit: 0, stderr: "", digest: made_.digest });
				}
				// Nothing was rewritten: the stored evidence is the one this release recorded.
				expect(entry.after).toEqual({ phase: "succeeded", verified: true, evidence: made_.evidence });
			}
		},
		120_000,
	);
});
