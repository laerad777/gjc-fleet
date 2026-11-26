import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskInput } from "../src/contracts";
import { selectNode } from "../src/core";
import { startDashboardServer, type DashboardState, type DashboardTask } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { input, node } from "./fixtures/daemon";
import { refuseHostGjc } from "./host-gjc-guard";

test("task detail reports only a recorded placement reason and keeps it off live state and WebSocket", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fleet-dash-selection-"));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const restoreGjc = refuseHostGjc();
	const server = startDashboardServer(store, 0, "127.0.0.1", { probeNodes: false });
	try {
		store.putNode(node("beta", dir));
		store.putNode(node("alpha", dir));
		const reserve = (key: string, choice: Partial<Pick<TaskInput, "required" | "preferences">> = {}) =>
			store.reserve(store.submit({ ...input(key), schemaVersion: 1, ...choice }).id);
		const chosen = [
			[reserve("tie"), "alpha", "node_id_tiebreak"],
			// Alpha already holds work; preference, not its load, is decisive.
			[reserve("prefer", { preferences: ["alpha", "beta"] }), "alpha", "higher_preference"],
			[reserve("load"), "beta", "fewer_held_tasks"],
			[reserve("only-eligible", { required: { nodeId: "beta" }, preferences: ["alpha"] }), "beta", "only_eligible_node"],
		] as const;
		const rejected = reserve("no-eligible", { required: { nodeId: "missing" } });
		const legacy = reserve("legacy", { preferences: ["alpha"] });
		const unknown = reserve("unknown");
		const mismatched = reserve("mismatched");
		const rawReason = "private_malformed_reason_should_not_be_public";
		const db = new Database(path);
		try {
			db.query("UPDATE audit SET data=json_remove(data,'$.reason') WHERE task_id=? AND kind='selection'").run(legacy.id);
			db.query("UPDATE audit SET data=json_set(data,'$.reason',?) WHERE task_id=? AND kind='selection'").run(rawReason, unknown.id);
			const wrongNode = mismatched.nodeId === "alpha" ? "beta" : "alpha";
			db.query("UPDATE audit SET data=json_set(data,'$.nodeId',?) WHERE task_id=? AND kind='selection'").run(wrongNode, mismatched.id);
		} finally {
			db.close();
		}

		const detail = async (id: string) => {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/task/${id}`);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			const json = await response.text();
			expect(json).not.toContain(rawReason);
			return JSON.parse(json) as DashboardTask;
		};

		for (const [task, nodeId, reason] of chosen) {
			expect(task.nodeId).toBe(nodeId);
			expect(store.events(task.id).find((row) => row.kind === "selection")?.data).toMatchObject({ nodeId, reason });
			expect((await detail(task.id)).selection).toMatchObject({ outcome: "selected", nodeId, reason });
		}
		expect((await detail(rejected.id)).selection).toMatchObject({ outcome: "rejected", reason: "no_eligible_node" });
		for (const task of [legacy, unknown, mismatched])
			expect((await detail(task.id)).selection).not.toHaveProperty("reason");

		// Pure preflight/other callers retain the established selection shape.
		expect(selectNode(chosen[0][0].input, store.nodes(), [])).toEqual({ nodeId: "alpha", exclusions: [] });
		const live = await fetch(`http://127.0.0.1:${server.port}/api/state`);
		expect(live.status).toBe(200);
		const assertSlim = (state: DashboardState) => {
			for (const [task, nodeId] of chosen) {
				expect(state.tasks.find((row) => row.id === task.id)?.selection).toEqual({ outcome: "selected", nodeId, exclusions: [] });
			}
			expect(state.tasks.find((row) => row.id === rejected.id)?.selection).toEqual({ outcome: "rejected", exclusions: [] });
		};
		assertSlim(await live.json() as DashboardState);
		const pushed = await new Promise<{ type: string; state: DashboardState }>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
			ws.onmessage = (message) => {
				ws.close();
				resolve(JSON.parse(String(message.data)));
			};
			ws.onerror = () => reject(new Error("WebSocket failed"));
		});
		expect(pushed.type).toBe("state");
		assertSlim(pushed.state);
	} finally {
		server.stop(true);
		restoreGjc();
		store.close();
		await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});
