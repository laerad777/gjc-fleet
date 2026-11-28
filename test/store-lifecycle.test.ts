import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";

test("resource-return history only counts this task and attempt's outcomes after the selected close", () => {
	const dir = mkdtempSync(join(tmpdir(), "return-history-test-"));
	const path = join(dir, "fleet.db");
	const store = new FleetStore(path);
	try {
		const db = new Database(path);
		try {
			const add = db.query("INSERT INTO audit(task_id, kind, at, data) VALUES (?, ?, ?, ?)");
			const at = "2026-01-01T00:00:00.000Z";
			const close = "current-close";
			const record = (task: string, kind: string, data: Record<string, string>) =>
				add.run(task, kind, at, JSON.stringify(data));
			record("task", "resource_return_unknown", { attemptId: "current", reason: "before-close" });
			record("task", "resource_return_close_intent", { operationId: close });
			record("task", "resource_return_session_busy", { attemptId: "previous", reason: "old-attempt" });
			record("another-task", "resource_return_unknown", { attemptId: "current", reason: "other-task" });
			record("task", "resource_return_session_busy", { attemptId: "current", reason: "after-close" });
			record("another-task", "resource_return_close_intent", { operationId: close });
			record("task", "unrelated_audit", { attemptId: "current", reason: "unrelated-kind" });
			record("task", "resource_return_close_intent", { operationId: "later-close" });
			record("task", "resource_return_not_ours", { attemptId: "current", reason: "after-later-close" });
		} finally {
			db.close();
		}
		const before = { kind: "resource_return_unknown", reason: "before-close" };
		const after = { kind: "resource_return_session_busy", reason: "after-close" };
		const later = { kind: "resource_return_not_ours", reason: "after-later-close" };
		expect(store.resourceReturnOutcomes("task", "current")).toEqual([before, after, later]);
		expect(store.resourceReturnOutcomes("task", "current", "current-close")).toEqual([after, later]);
		expect(store.resourceReturnOutcomes("task", "current", "later-close")).toEqual([later]);
		expect(store.resourceReturnOutcomes("task", "missing", "current-close")).toEqual([]);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
