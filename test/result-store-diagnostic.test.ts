// Result-store conversion sites under main's deny-by-default failure-diagnostic rule (docs/failure-diagnostics.md,
// "store.ts: result store"). Every place where result-store code turns an error into a persisted `refused` record
// goes through the Store.transaction refusal writer; this file drives each of them with the completeness guard
// (test/diagnostic-guard.ts) installed and checks the persisted diagnostic: Store.transaction/record, the error
// class, and for Fleet's own errors an allowlisted code (never `unclassified`), with no error text stored.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/core";
import { DIAGNOSTIC_TEXT, failureDiagnostic } from "../src/diagnostic";
import { FleetStore } from "../src/store";
import { type DiagnosticGuard, installDiagnosticGuard } from "./diagnostic-guard";

let guard: DiagnosticGuard;
beforeAll(() => {
	guard = installDiagnosticGuard(FleetStore);
});
afterAll(() => {
	guard.uninstall();
});
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "result-store-diagnostic-"));
	dirs.push(dir);
	return join(dir, "fleet.sqlite");
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const node = {
	id: "node", os: "linux", arch: "arm64", roots: { repo: "/repos/repo" }, workspaceRoot: "/work", maxConcurrency: 1,
	enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"],
	transport: { command: "gjc", args: ["acp"] }, operations: ["read", "write"],
};
const input = (key: string) => ({ schemaVersion: 1, key, caller: "actor", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} });
function running(store: FleetStore, key: string): string {
	store.putNode(node as any);
	const task = store.reserve(store.submit(input(key) as any).id)!;
	store.recordSession(task.id, `session-${key}`);
	store.recordTurn(task.id, `turn-${key}`);
	return task.id;
}
function rewriteRow(path: string, id: string, change: (row: any) => any): void {
	const db = new Database(path);
	try {
		const row = JSON.parse((db.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string }).data);
		db.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson(change(row)), id);
	} finally {
		db.close();
	}
}
const enable = (store: FleetStore) => store.enableResultStore({ actor: "tester", reason: "result-store diagnostic test" });
function codeOf(fn: () => unknown): string {
	try {
		fn();
		return "ok";
	} catch (error) {
		return (error as { code?: string }).code ?? "uncoded";
	}
}
const expected = (errorClass: string, code: string) => ({
	version: 1, use: "diagnostic_only_not_evidence", source: "Store.transaction", phase: "record", errorClass, code, message: DIAGNOSTIC_TEXT.get(code)!,
});
/** The latest `refused` event for `action` (task-bound or not). */
function refused(store: FleetStore, action: string, taskId?: string): any {
	const events = taskId ? store.events(taskId) : (store as any).db.query("SELECT kind, data FROM audit WHERE task_id IS NULL ORDER BY sequence").all().map((row: any) => ({ kind: row.kind, data: JSON.parse(row.data) }));
	const event = events.filter((e: any) => e.kind === "refused" && e.data.action === action).at(-1);
	expect(event).toBeDefined();
	return event.data;
}
/** Converting events and violations the guard saw for one case; no violation is allowed. */
function guarded(): { event: string; source?: string; code?: string }[] {
	const { events, violations } = guard.take();
	expect(violations).toEqual([]);
	return events;
}

test("result-store switch refusals (enable/disable with invalid input) record Store.transaction/record fleet:invalid_input", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		guard.take();
		const long = "r".repeat(1001);
		expect(codeOf(() => store.enableResultStore({ actor: "tester", reason: long }))).toBe("INVALID_INPUT");
		expect(codeOf(() => store.disableResultStore({ actor: "tester", reason: long }))).toBe("INVALID_INPUT");
		for (const action of ["enableResultStore", "disableResultStore"]) {
			const data = refused(store, action);
			expect(data).toMatchObject({ action, code: "INVALID_INPUT", certainty: "local_transaction_rolled_back" });
			expect(data.failureDiagnostic).toEqual(expected("FleetError", "fleet:invalid_input"));
			expect(JSON.stringify(data)).not.toContain(long);
		}
		expect(guarded().map((e) => `${e.event} ${e.source} ${e.code}`)).toEqual([
			"refused Store.transaction fleet:invalid_input",
			"refused Store.transaction fleet:invalid_input",
		]);
	} finally {
		store.close();
	}
});

test("a damaged externalised result: saveResult and a state conversion on that task are refused with fleet:result_integrity", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		enable(store);
		const damaged = running(store, "damaged");
		store.saveResult(damaged, { patch: "c".repeat(5000), status: "verified" });
		rmSync(join(`${path}.results`, hash("c".repeat(5000))), { recursive: true });
		guard.take();
		// Result-store code (decodeTask) throws RESULT_INTEGRITY inside the transaction; the refusal is recorded.
		expect(codeOf(() => store.saveResult(damaged, { patch: "other" }))).toBe("RESULT_INTEGRITY");
		const save = refused(store, "saveResult", damaged);
		expect(save).toMatchObject({ code: "RESULT_INTEGRITY", certainty: "local_transaction_rolled_back" });
		expect(save.failureDiagnostic).toEqual(expected("FleetError", "fleet:result_integrity"));
		// A main conversion method (markUnknown, with its own valid diagnostic) on the damaged task: the read of the
		// result inside requireTask refuses the transaction; the refusal carries the result-store code, classified.
		const diagnostic = failureDiagnostic(new Error("controlled"), { source: "Fleet.inspect.observe", phase: "record" });
		expect(codeOf(() => store.markUnknown(damaged, "controlled_unknown", undefined, diagnostic))).toBe("RESULT_INTEGRITY");
		const mark = refused(store, "markUnknown", damaged);
		expect(mark.failureDiagnostic).toEqual(expected("FleetError", "fleet:result_integrity"));
		expect(JSON.stringify(mark)).not.toContain("result:");
		expect(guarded().map((e) => `${e.event} ${e.source} ${e.code}`)).toEqual([
			"refused Store.transaction fleet:result_integrity",
			"refused Store.transaction fleet:result_integrity",
		]);
	} finally {
		store.close();
	}
});

test("results gc --apply with unreadable references is refused with fleet:result_integrity", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		enable(store);
		const id = running(store, "refs");
		store.saveResult(id, { patch: "g".repeat(5000), status: "verified" });
		rewriteRow(path, id, (row) => ({ ...row, resultExternal: { ...row.resultExternal, blobs: [{ sha256: "not-a-digest", bytes: -1 }] } }));
		guard.take();
		expect(codeOf(() => store.collectResults(true))).toBe("RESULT_INTEGRITY");
		const data = refused(store, "collectResults");
		expect(data.failureDiagnostic).toEqual(expected("FleetError", "fleet:result_integrity"));
		expect(guarded().map((e) => `${e.event} ${e.source} ${e.code}`)).toEqual(["refused Store.transaction fleet:result_integrity"]);
	} finally {
		store.close();
	}
});

test("migrate results --apply: a row whose result directory is not a plain directory is refused with fleet:result_integrity", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		const id = running(store, "legacy");
		store.saveResult(id, { patch: "m".repeat(5000), status: "verified" });
		enable(store);
		// The result directory is replaced by a regular file: the result store refuses it inside the transaction.
		rmSync(`${path}.results`, { recursive: true, force: true });
		writeFileSync(`${path}.results`, "not a directory");
		guard.take();
		const report = store.migrateResults(true);
		expect(report.migrated).toBe(0);
		expect(report.failed.map((entry) => [entry.taskId, entry.code])).toEqual([[id, "RESULT_INTEGRITY"]]);
		const data = refused(store, "migrateResults", id);
		expect(data).toMatchObject({ code: "RESULT_INTEGRITY", certainty: "local_transaction_rolled_back" });
		expect(data.failureDiagnostic).toEqual(expected("FleetError", "fleet:result_integrity"));
		expect(JSON.stringify(data)).not.toContain(path);
		expect(guarded().map((e) => `${e.event} ${e.source} ${e.code}`)).toEqual(["refused Store.transaction fleet:result_integrity"]);
	} finally {
		store.close();
	}
});

test("results check on a writable store whose result directory is not a plain directory is refused with fleet:result_integrity", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		writeFileSync(`${path}.results`, "not a directory");
		guard.take();
		expect(codeOf(() => store.resultInventory())).toBe("RESULT_INTEGRITY");
		const data = refused(store, "resultListing");
		expect(data).toMatchObject({ code: "RESULT_INTEGRITY", certainty: "local_transaction_rolled_back" });
		expect(data.failureDiagnostic).toEqual(expected("FleetError", "fleet:result_integrity"));
		expect(JSON.stringify(data)).not.toContain(path);
		expect(guarded().map((e) => `${e.event} ${e.source} ${e.code}`)).toEqual(["refused Store.transaction fleet:result_integrity"]);
	} finally {
		store.close();
	}
});

test("every FleetError code the result store throws is in the diagnostic code table", () => {
	for (const code of ["RESULT_INTEGRITY", "RESULT_STORE_OFF", "MIGRATION_NOT_APPLIED", "BACKUP_LEFTOVER", "STORE_ERROR"])
		expect(DIAGNOSTIC_TEXT.has("fleet:" + code.toLowerCase())).toBe(true);
	expect(guard.allViolations).toEqual([]);
});
