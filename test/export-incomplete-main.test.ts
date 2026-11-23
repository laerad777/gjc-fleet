import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { getDashboardState } from "../src/dashboard";
import { observationDigest } from "../src/core";
import { repositoryFixture } from "./fixtures/coordinator";
import { run } from "../src/workspace";

// Port of the export-completeness change onto production main: how an incomplete
// export awaiting operator acceptance (`completed_unverified` + `result.exportIncomplete`)
// meets the main-only receipt-less settlement, deferred terminal release (resource
// return), the archived phase and the schema-v2 store.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A settled task whose passing verifier ran over an export with a nested repository (export review pending). */
async function exportIncomplete(options: { deferTerminalRelease?: boolean } = {}) {
	const repo = await repositoryFixture("fleet-export-incomplete-main-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const db = join(repo.dir, "fleet.sqlite");
	let store = new FleetStore(db, 2, options);
	cleanups.push(async () => store.close());
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	store.putNode({ id: "local", os: process.platform, arch: process.arch,
		roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], operations: [], transport: { command: process.execPath,
			args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } });
	let fleet = new Fleet(store, { localNodeId: "local" });
	const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "export-incomplete-main", caller: "controlled",
		repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled incomplete export", required: {} }).id);
	const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const,
		terminal: true, evidence: { injected: "not provider settlement proof" } };
	store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
	const root = (task.workspace as any).path;
	await mkdir(join(root, "fixtures", "repo"), { recursive: true });
	expect((await run(["git", "init", join(root, "fixtures", "repo")], repo.dir)).exit).toBe(0);
	await writeFile(join(root, "fixtures", "repo", "fixture.txt"), "review fixture");
	await writeFile(join(root, "deliverable.txt"), "outer deliverable");
	const result = await fleet.result(task.id, [process.execPath, "--eval", "console.log('passing verifier')"]);
	expect(result.status).toBe("verified");
	expect(store.task(task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false, exportIncomplete: { reviewDigest: expect.any(String) } } });
	/** Rewrite the stored task record (a state the public API cannot produce), then reopen. */
	function forge(change: (task: any) => void) {
		store.close();
		const raw = new Database(db);
		const row = raw.query<{ data: string }, [string]>("SELECT data FROM tasks WHERE id=?").get(task.id)!;
		const value = JSON.parse(row.data);
		change(value);
		raw.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(value), task.id);
		raw.close();
		store = new FleetStore(db, 2, options);
		fleet = new Fleet(store, { localNodeId: "local" });
	}
	return { db, task, result, forge, get store() { return store; }, get fleet() { return fleet; } };
}
const settlement = {
	kind: "ended_without_receipt",
	receiptState: "missing",
	cause: "turn ended without a runtime receipt",
	settledAt: "2026-11-12T00:00:00.000Z",
	lateObservationUntil: "2026-11-12T00:10:00.000Z",
};

test("an incomplete export with a receipt-less settlement is never accepted as success, like verifyResult", async () => {
	const f = await exportIncomplete();
	const review = f.fleet.exportReview(f.task.id);
	f.forge((task) => { task.result.settlement = settlement; });
	for (const accept of [
		() => f.fleet.acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest! }),
		() => f.store.acceptIncompleteExport(f.task.id, "ops", review.reviewDigest!, { manifestDigest: review.manifestDigest, testCount: 1, trust: "trusted node command evidence, not remote attestation" }),
	])
		expect(accept).toThrow(expect.objectContaining({ code: "RECEIPTLESS_UNVERIFIABLE" }));
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
	expect(f.store.task(f.task.id)?.result?.exportIncomplete?.acceptance).toBeUndefined();
	expect(f.store.events(f.task.id).some((event) => event.kind === "incomplete_export_accepted")).toBe(false);
	// An operator-accepted genuine late receipt makes the settlement verifiable again (main's rule).
	f.forge((task) => {
		task.result.lateReceipt = { status: "terminal_ok", digest: "a".repeat(64), terminalAt: 1, outcome: {}, sessionId: task.sessionId, turnId: task.turnId,
			runtimeCommandId: "c", runtimeTurnId: "t", observedAt: settlement.settledAt, settlementKind: settlement.kind,
			acceptance: { at: settlement.settledAt, actor: "ops", reason: "genuine late receipt", evidenceDigest: "b".repeat(64) } };
	});
	expect(f.fleet.acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest! })).toMatchObject({ phase: "succeeded", result: { verified: true } });
});

test("with deferred terminal release, a pending export review and its acceptance keep the slot held for resource return", async () => {
	const f = await exportIncomplete({ deferTerminalRelease: true });
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified", held: true, result: { executionTerminal: true, verified: false, exportIncomplete: { reviewDigest: expect.any(String) } } });
	const state = getDashboardState(f.store);
	expect(state.summary.exportIncompleteTasks).toBe(1);
	expect(state.summary.heldTasks).toBe(1);
	const review = f.fleet.exportReview(f.task.id);
	expect(f.fleet.acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest! })).toMatchObject({ phase: "succeeded", held: true, result: { verified: true } });
	expect(f.store.events(f.task.id).filter((event) => event.kind === "released")).toEqual([]);
});

test("without deferred release the slot is released at settlement, before review", async () => {
	const f = await exportIncomplete();
	expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified", held: false, result: { exportIncomplete: { reviewDigest: expect.any(String) } } });
});

test("export review and acceptance are task data in the schema-v2 store: no schema change, user_version stays 2", async () => {
	const f = await exportIncomplete();
	const review = f.fleet.exportReview(f.task.id);
	f.fleet.acceptIncompleteExport(f.task.id, { operator: "ops", reviewDigest: review.reviewDigest! });
	f.store.close();
	const raw = new Database(f.db, { readonly: true });
	try {
		expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(2);
		expect(raw.query<{ schema_version: number }, []>("SELECT schema_version FROM fleet_meta").get()!.schema_version).toBe(2);
		const phases = raw.query<{ data: string }, []>("SELECT data FROM audit WHERE kind IN ('export_review_required','incomplete_export_accepted') ORDER BY sequence").all();
		expect(phases).toHaveLength(2);
	} finally {
		raw.close();
	}
});
