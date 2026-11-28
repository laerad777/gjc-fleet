import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_UI_APPROVAL_CONTRACT } from "../src/approval";
import type { NodeConfig, TaskResult } from "../src/contracts";
import { Fleet } from "../src/fleet";
import type { StdioRpc } from "../src/rpc";
import { FleetStore } from "../src/store";

class OfflineFleet extends Fleet {
	readonly calls: Array<{ nodeId: string; required: string[] }> = [];
	closes = 0;

	protected override async connect(node: NodeConfig, required: string[]): Promise<StdioRpc> {
		this.calls.push({ nodeId: node.id, required: [...required] });
		// The probe may inspect capability names and close, but never call a tool.
		return { close: () => { this.closes++; } } as Pick<StdioRpc, "close"> as StdioRpc;
	}
}

test("observation preflight selects only required capabilities and leaves the journal unchanged", async () => {
	const dir = mkdtempSync(join(tmpdir(), "observation-preflight-"));
	const path = join(dir, "fleet.db");
	const store = new FleetStore(path);
	const db = new Database(path);
	try {
		const now = Date.parse("2026-02-01T12:00:00Z");
		const node: NodeConfig = {
			id: "fixture-node", os: "linux", arch: "x64", roots: { repo: "/repo" }, workspaceRoot: "/work",
			enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
			models: [], operations: [], maxConcurrency: 4, transport: { command: "fixture-not-executed", args: [] },
		};
		store.putNode(node);
		const admit = (key: string, approval = false) => {
			const task = store.reserve(store.submit({
				schemaVersion: 1, key, caller: "fixture", repoId: "repo",
				baseCommit: "a".repeat(40), prompt: "test", required: {},
				...(approval ? { approvalContract: SDK_UI_APPROVAL_CONTRACT } : {}),
			}).id);
			store.recordSession(task.id, "session-" + key);
			store.recordTurn(task.id, "turn-" + key);
			return task.id;
		};
		const ordinary = admit("ordinary");
		const approval = admit("approval", true);
		const late = admit("late");
		const expired = admit("expired");
		const settle = (taskId: string, until: number) => {
			const result: TaskResult = {
				status: "failed", evidence: { source: "fixture" }, verified: false, executionTerminal: true,
				settlement: {
					kind: "failed_without_receipt", receiptState: "missing", cause: "fixture",
					settledAt: new Date(now - 2000).toISOString(), lateObservationUntil: new Date(until).toISOString(),
				},
			};
			db.query("UPDATE tasks SET data=json_set(data, '$.phase', 'failed', '$.result', json(?)) WHERE id=?")
				.run(JSON.stringify(result), taskId);
		};
		settle(late, now + 1000);
		settle(expired, now - 1000);
		const snapshot = () => ["tasks", "audit", "operations", "receipts"].map((table) =>
			db.query("SELECT * FROM " + table + " ORDER BY rowid").all());
		const before = snapshot();
		const fleet = new OfflineFleet(store, { clock: () => now });
		for (const id of [ordinary, approval, late, expired]) await fleet.observationReachable(id);
		const readTurn = "gjc_coordinator_read_turn";
		const listQuestions = "gjc_coordinator_list_questions";
		expect(fleet.calls).toEqual([
			{ nodeId: node.id, required: [readTurn, listQuestions] },
			{ nodeId: node.id, required: [readTurn] },
			{ nodeId: node.id, required: [readTurn] },
			{ nodeId: node.id, required: [readTurn, listQuestions] },
		]);
		expect(fleet.closes).toBe(4);
		expect(snapshot()).toEqual(before);
	} finally {
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
