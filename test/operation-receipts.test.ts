import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { digest } from "../src/core";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "fleet-operation-receipts-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "fleet.sqlite");
	let store = new FleetStore(path);
	cleanups.push(async () => store.close());
	store.putNode({
		id: "controlled", os: process.platform, arch: process.arch,
		roots: { repo: dir }, workspaceRoot: join(dir, "workspaces"),
		enabled: true, draining: false, reachable: true, sdkReady: true,
		modelReady: true, models: [], operations: [],
		transport: { command: "must-not-execute", args: [] },
	});
	function task(key: string) {
		return store.reserve(store.submit({
			schemaVersion: 1, key, caller: "controlled", repoId: "repo",
			baseCommit: "a".repeat(40), prompt: "Receipt persistence only", required: {},
		}).id);
	}
	const original = task("original");
	const other = task("other");
	const claim = store.claimOperation(original.id, "approval-attach", { context: "original" })!;
	function reopen() { store.close(); store = new FleetStore(path); return store; }
	return { path, original, other, claim, reopen, get store() { return store; } };
}

test("operation receipt durably binds the exact task/attempt/claim and only identical receipt replays", async () => {
	const f = await fixture();
	const receipt = { registered: true, requestKey: f.claim.key, nested: { a: 1, b: 2 } };
	const saved = f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, receipt);
	expect(saved).toEqual({ ...f.claim, receipt });
	expect(saved.digest).toBe(digest(saved.payload));
	receipt.nested.a = 99;
	f.reopen();
	const original = f.store.getOperation(f.original.id, f.claim.kind)!;
	expect(original.receipt).toEqual({ registered: true, requestKey: f.claim.key, nested: { a: 1, b: 2 } });
	expect(f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, {
		nested: { b: 2, a: 1 }, requestKey: f.claim.key, registered: true,
	})).toEqual(original);
	expect(() => f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, { changed: true })).toThrow("immutable");
	for (const [id, kind, claim] of [
		[f.other.id, f.claim.kind, f.claim.id],
		[f.original.id, "prompt", f.claim.id],
		[f.original.id, f.claim.kind, "wrong-claim"],
		["missing-task", f.claim.kind, f.claim.id],
	]) expect(() => f.store.recordOperationReceipt(id, kind, claim, { proof: true })).toThrow();
	expect(f.store.getOperation(f.original.id, f.claim.kind)).toEqual(original);
	expect(f.store.getOperation(f.other.id, f.claim.kind)).toBeUndefined();
	expect(f.store.events(f.original.id).filter(event => event.kind === "operation_receipt")).toHaveLength(1);
});

test("rollback retains first late receipt and identical replay, never grants new effect claims; read-only refuses both", async () => {
	const f = await fixture();
	f.store.enterRollback();
	const receipt = { registered: true, requestKey: f.claim.key };
	const recorded = f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, receipt);
	expect(recorded.receipt).toEqual(receipt);
	expect(f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, receipt)).toEqual(recorded);
	expect(() => f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, { changed: true })).toThrow("immutable");
	expect(() => f.store.claimOperation(f.original.id, "prompt", {})).toThrow("rollback");
	expect(f.store.task(f.original.id)).toMatchObject({ held: true, attemptId: f.original.attemptId });
	f.reopen();
	expect(f.store.getOperation(f.original.id, f.claim.kind)).toEqual(recorded);
	const readonly = new FleetStore(f.path, 2, { readOnly: true });
	try {
		expect(readonly.getOperation(f.original.id, f.claim.kind)).toEqual(recorded);
		for (const value of [receipt, { different: true }])
			expect(() => readonly.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, value)).toThrow("read-only");
	} finally { readonly.close(); }
});

test("receipt write validates stored attempt identity and atomically rolls back failed persistence", async () => {
	const f = await fixture();
	const db = new Database(f.path);
	try {
		const corrupt = { ...f.claim, attemptId: f.other.attemptId! };
		db.query("UPDATE operations SET data=? WHERE id=?").run(JSON.stringify(corrupt), f.claim.id);
		expect(() => f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, { proof: true })).toThrow();
		db.query("UPDATE operations SET data=? WHERE id=?").run(JSON.stringify(f.claim), f.claim.id);
		db.exec("CREATE TRIGGER reject_receipt BEFORE UPDATE ON operations BEGIN SELECT RAISE(ABORT,'controlled_receipt_failure'); END;");
		expect(() => f.store.recordOperationReceipt(f.original.id, f.claim.kind, f.claim.id, { proof: true })).toThrow("controlled_receipt_failure");
		expect(f.store.getOperation(f.original.id, f.claim.kind)).toEqual(f.claim);
		expect(f.store.events(f.original.id).filter(event => event.kind === "operation_receipt")).toEqual([]);
	} finally { db.close(); }
});
