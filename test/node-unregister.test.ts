import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, Observation, TaskInput } from "../src/contracts";
import { observationDigest } from "../src/core";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";

// Real, temporary SQLite databases only. No configured transport is executed.
const roots: string[] = [];
const stores = new Set<FleetStore>();
const databases = new Set<Database>();
function open(path: string, readOnly = false) {
	const store = new FleetStore(path, 2, { readOnly });
	stores.add(store);
	return store;
}
function close(store: FleetStore) {
	store.close();
	stores.delete(store);
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-node-unregister-"));
	roots.push(root);
	const path = join(root, "fleet.sqlite");
	const store = open(path);
	const node: NodeConfig = {
		id: "owned-node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: root },
		workspaceRoot: root,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: ["owned-model"],
		transport: { command: "must-not-execute", args: ["owned-endpoint"] },
		operations: ["read", "write"],
	};
	store.putNode(node);
	const sql = new Database(path, { strict: true });
	databases.add(sql);
	return { root, path, store, node, sql };
}
afterEach(() => {
	for (const store of stores) store.close();
	stores.clear();
	for (const db of databases) db.close();
	databases.clear();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function input(key: string): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "unregister-test",
		repoId: "repo",
		baseCommit: "a".repeat(40),
		prompt: "Owned local unregister fixture",
		required: { nodeId: "owned-node" },
	};
}
function reserved(store: FleetStore, key: string, withOperation = true) {
	const task = store.reserve(
		store.submit(input(key)).id,
		headroom(["owned-node"], 10),
	);
	expect(task.phase).toBe("preparing");
	if (withOperation)
		store.beginOperation(task.id, "prepare", { repo: "repo", key });
	store.recordSession(task.id, `session-${key}`);
	store.recordTurn(task.id, `turn-${key}`);
	return task.id;
}
function observe(
	store: FleetStore,
	id: string,
	status: Observation["status"],
	terminal = false,
) {
	const task = store.task(id)!;
	const body = {
		sessionId: task.sessionId!,
		turnId: task.turnId!,
		status,
		terminal,
		evidence: { source: "owned-local-fixture" },
	};
	return store.observe(id, {
		...body,
		eventId: `${id}-${status}`,
		digest: observationDigest(body),
	});
}
function history(sql: Database) {
	return {
		tasks: sql.query("SELECT * FROM tasks ORDER BY id").all(),
		operations: sql.query("SELECT * FROM operations ORDER BY id").all(),
		receipts: sql.query("SELECT * FROM receipts ORDER BY event_id").all(),
		audit: sql.query("SELECT * FROM audit ORDER BY sequence").all(),
	};
}
function archives(sql: Database) {
	return sql
		.query<{ data: string }, []>(
			"SELECT data FROM audit WHERE kind='node_unregistered' ORDER BY sequence",
		)
		.all()
		.map((row) => JSON.parse(row.data));
}

test("unregister preserves exact SQLite history, unknown held attempts and snapshots across reopen", () => {
	const f = fixture();
	const unknown = reserved(f.store, "unknown");
	observe(f.store, unknown, "active");
	f.store.markUnknown(unknown, "effect_may_have_run");
	const cancelUnknown = reserved(f.store, "cancel-unknown");
	observe(f.store, cancelUnknown, "cancel_unknown");
	for (const phase of [
		"completed_unverified",
		"succeeded",
		"failed",
		"cancelled",
	] as const) {
		const id = reserved(f.store, phase);
		observe(f.store, id, phase, true);
	}
	const queued = f.store.submit(input("queued"));
	f.store.setNodeState(f.node.id, { enabled: false });
	const archivedNode = f.store.nodes()[0]!;
	const tasks = f.store.tasks();
	const before = history(f.sql);
	expect(before.operations.length).toBe(6);
	expect(before.receipts.length).toBe(6);
	f.store.unregisterNode(f.node.id);
	expect(f.store.nodes()).toEqual([]);
	const after = history(f.sql);
	expect(after.tasks).toEqual(before.tasks);
	expect(after.operations).toEqual(before.operations);
	expect(after.receipts).toEqual(before.receipts);
	expect(after.audit.slice(0, -1)).toEqual(before.audit);
	expect(archives(f.sql)).toEqual([
		expect.objectContaining({ nodeId: f.node.id, archivedNode }),
	]);
	close(f.store);
	const reopened = open(f.path);
	expect(reopened.tasks()).toEqual(tasks);
	expect(reopened.nodes()).toEqual([]);
	expect(history(f.sql)).toEqual(after);
	reopened.unregisterNode(f.node.id);
	reopened.unregisterNode(f.node.id);
	expect(history(f.sql)).toEqual(after);
	for (const id of [unknown, cancelUnknown]) {
		const original = tasks.find((task) => task.id === id)!;
		expect(reopened.reserve(id)).toEqual(original);
		expect(() =>
			reopened.beginOperation(id, "prepare", { repo: "repo", key: id }),
		).toThrow("Unknown execution");
		expect(() =>
			reopened.claimOperation(id, "prompt", { prompt: "never replay" }),
		).toThrow("Unknown execution");
		expect(reopened.task(id)).toEqual(original);
		expect(reopened.task(id)?.held).toBe(true);
		expect(reopened.task(id)?.nodeSnapshot).toEqual(f.node);
	}
	const admitted = reopened.reserve(queued.id, headroom([f.node.id], 10));
	expect(admitted.attemptId).toBeUndefined();
	expect(admitted.reason).toBe("no_eligible_node");
	expect(history(f.sql).operations).toEqual(before.operations);
	expect(history(f.sql).receipts).toEqual(before.receipts);
});

for (const phase of [
	"preparing",
	"dispatching",
	"active",
	"approval_required",
] as const) {
	test(`unregister refuses disabled node with ${phase} task without changing history`, () => {
		const f = fixture();
		const id = reserved(f.store, phase, phase !== "preparing");
		if (phase !== "preparing") observe(f.store, id, phase);
		expect(f.store.task(id)?.phase).toBe(phase);
		f.store.setNodeState(f.node.id, { enabled: false });
		const before = history(f.sql);
		expect(() => f.store.unregisterNode(f.node.id)).toThrow(
			"Node has preparing",
		);
		expect(f.store.nodes()).toHaveLength(1);
		const after = history(f.sql);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.operations).toEqual(before.operations);
		expect(after.receipts).toEqual(before.receipts);
		expect(after.audit.slice(0, -1)).toEqual(before.audit);
		expect(archives(f.sql)).toEqual([]);
		close(f.store);
		expect(open(f.path).task(id)?.phase).toBe(phase);
	});
}

test("enabled/draining nodes are refused, unknown IDs are not silently accepted, and re-enrollment is checked anew", () => {
	const f = fixture();
	f.store.setNodeState(f.node.id, { draining: true });
	expect(() => f.store.unregisterNode(f.node.id)).toThrow("Disable the node");
	expect(() => f.store.unregisterNode("never-registered")).toThrow(
		"Node does not exist",
	);
	expect(archives(f.sql)).toEqual([]);
	f.store.setNodeState(f.node.id, { enabled: false });
	f.store.unregisterNode(f.node.id);
	f.store.putNode(f.node);
	expect(() => f.store.unregisterNode(f.node.id)).toThrow("Disable the node");
	f.store.setNodeState(f.node.id, { enabled: false });
	f.store.unregisterNode(f.node.id);
	expect(archives(f.sql)).toHaveLength(2);
});

test("original removeNode still refuses historical and unknown tasks, but removes unreferenced inventory", () => {
	const f = fixture();
	const id = reserved(f.store, "historical");
	observe(f.store, id, "failed", true);
	f.store.setNodeState(f.node.id, { enabled: false });
	expect(() => f.store.removeNode(f.node.id)).toThrow("node_has_tasks");
	expect(f.store.nodes()).toHaveLength(1);
	f.store.putNode({ ...f.node, id: "unused" });
	f.store.removeNode("unused");
	expect(() => f.store.removeNode("unused")).toThrow("node_not_found");
	f.store.unregisterNode(f.node.id);
	expect(() => f.store.removeNode(f.node.id)).toThrow("node_not_found");
	const other = fixture();
	const unknown = reserved(other.store, "unknown-remove");
	other.store.markUnknown(unknown, "uncertain");
	other.store.setNodeState(other.node.id, { enabled: false });
	expect(() => other.store.removeNode(other.node.id)).toThrow("node_has_tasks");
});

for (const point of ["delete", "archive"] as const) {
	test(`SQLite ${point} failure rolls back inventory and archive together, survives reopen and permits retry`, () => {
		const f = fixture();
		const id = reserved(f.store, "rollback");
		observe(f.store, id, "active");
		f.store.markUnknown(id, "effect_unknown");
		f.store.setNodeState(f.node.id, { enabled: false });
		const before = history(f.sql);
		const nodes = f.store.nodes();
		f.sql.exec(
			point === "delete"
				? "CREATE TRIGGER reject_unregister BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT,'owned_unregister_failure'); END"
				: "CREATE TRIGGER reject_unregister BEFORE INSERT ON audit WHEN NEW.kind='node_unregistered' BEGIN SELECT RAISE(ABORT,'owned_unregister_failure'); END",
		);
		expect(() => f.store.unregisterNode(f.node.id)).toThrow(
			"owned_unregister_failure",
		);
		expect(f.store.nodes()).toEqual(nodes);
		const failed = history(f.sql);
		expect(failed.tasks).toEqual(before.tasks);
		expect(failed.operations).toEqual(before.operations);
		expect(failed.receipts).toEqual(before.receipts);
		expect(failed.audit.slice(0, -1)).toEqual(before.audit);
		expect(archives(f.sql)).toEqual([]);
		close(f.store);
		const reopened = open(f.path);
		expect(reopened.nodes()).toEqual(nodes);
		expect(history(f.sql)).toEqual(failed);
		f.sql.exec("DROP TRIGGER reject_unregister");
		reopened.unregisterNode(f.node.id);
		expect(reopened.nodes()).toEqual([]);
		expect(reopened.task(id)?.phase).toBe("blocked_unknown");
		expect(reopened.task(id)?.held).toBe(true);
		expect(archives(f.sql)).toHaveLength(1);
	});
}

test("read-only store cannot unregister inventory", () => {
	const f = fixture();
	f.store.setNodeState(f.node.id, { enabled: false });
	const before = history(f.sql);
	expect(() => open(f.path, true).unregisterNode(f.node.id)).toThrow(
		"read-only",
	);
	expect(f.store.nodes()).toHaveLength(1);
	expect(history(f.sql)).toEqual(before);
});

async function cli(path: string, ...args: string[]) {
	const child = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"--db",
			path,
			...args,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test("CLI exposes explicit unregister, preserves history, rejects unsafe usage and repeats idempotently", async () => {
	const f = fixture();
	const id = reserved(f.store, "cli-unknown");
	f.store.markUnknown(id, "uncertain");
	const help = await cli(f.path, "--help");
	expect(help.code).toBe(0);
	expect(help.stdout).toContain("node unregister ID");
	expect(help.stdout).toContain("no replay, release or remote fence");
	expect((await cli(f.path, "node", "unregister", f.node.id)).code).not.toBe(0);
	f.store.setNodeState(f.node.id, { enabled: false });
	const before = history(f.sql);
	for (const args of [
		["node", "unregister"],
		["node", "unregister", f.node.id, "extra"],
		["--read-only", "node", "unregister", f.node.id],
	]) {
		expect((await cli(f.path, ...args)).code).not.toBe(0);
	}
	expect(history(f.sql)).toEqual(before);
	expect((await cli(f.path, "node", "remove", f.node.id)).stderr).toContain(
		"node_has_tasks",
	);
	const result = await cli(f.path, "node", "unregister", f.node.id);
	expect(result.code).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ ok: true });
	const after = history(f.sql);
	expect(after.tasks).toEqual(before.tasks);
	expect(after.operations).toEqual(before.operations);
	expect(after.receipts).toEqual(before.receipts);
	expect((await cli(f.path, "node", "unregister", f.node.id)).code).toBe(0);
	expect(history(f.sql)).toEqual(after);
	expect(JSON.parse((await cli(f.path, "node", "list")).stdout)).toEqual([]);
	close(f.store);
	expect(open(f.path).task(id)).toMatchObject({
		phase: "blocked_unknown",
		held: true,
		nodeSnapshot: f.node,
	});
});
