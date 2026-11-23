import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Fleet, FleetStore, submitPlacement, ClawhipControl, controlBinding, validateControlCommand, clawhipControlCli, reservePlacement } from "../src/index";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
async function fixture() {
	const repo = await repositoryFixture("fleet-integration-wiring-");
	dirs.push(repo.dir);
	const db = join(repo.dir, "fleet.sqlite");
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const node: NodeConfig = {
		id: "EXPLICIT-LOCAL", os: process.platform, arch: process.arch,
		roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces"),
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], modelProfiles: ["controlled"],
		operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"],
		transport: { command: process.execPath, args: [coordinator, state] },
	};
	const input: TaskInput = { schemaVersion: 1, key: "wiring", caller: "controlled-test", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Test admission only", required: { modelProfile: "controlled" } };
	const store = new FleetStore(db);
	try { store.putNode(node); } finally { store.close(); }
	const taskFile = join(repo.dir, "task.json");
	const resources = join(repo.dir, "resources.json");
	await writeFile(taskFile, JSON.stringify(input));
	await writeFile(resources, JSON.stringify(Object.fromEntries(headroom([node.id], 10).samples)));
	async function cli(...args: string[]) {
		const child = Bun.spawn([process.execPath, cliPath, "--db", db, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exit, stdout, stderr };
	}
	return { ...repo, db, node, input, state, taskFile, resources, cli };
}

test("public package exposes placement and existing Clawhip control entrypoints", () => {
	for (const api of [submitPlacement, reservePlacement, ClawhipControl, controlBinding, validateControlCommand, clawhipControlCli]) expect(typeof api).toBe("function");
});

test("real CLI/SQLite refuses implicit locality, admits explicit locality and deduplicates", async () => {
	const f = await fixture();
	const refused = await f.cli("--resources", f.resources, "submit", f.taskFile);
	expect(refused.exit).toBe(1);
	const refusal = JSON.parse(refused.stdout);
	expect(refusal.attemptId).toBeUndefined();
	expect(refusal.placement.nodes[0].checks.workspace.code).toBe("workspace_transport_required");
	const admitted = await f.cli("--resources", f.resources, "--local-node-id", f.node.id, "submit", f.taskFile);
	expect(admitted.stderr).toBe("");
	expect(admitted.exit).toBe(0);
	const task = JSON.parse(admitted.stdout);
	expect(task.nodeId).toBe(f.node.id);
	expect(task.phase).toBe("preparing");
	expect(task.placement.nodes[0].executionProven).toBe(false);
	const repeat = await f.cli("--resources", f.resources, "--local-node-id", f.node.id, "submit", f.taskFile);
	expect(repeat.exit).toBe(0);
	expect(JSON.parse(repeat.stdout).attemptId).toBe(task.attemptId);
	const store = new FleetStore(f.db);
	try {
		expect(store.tasks()).toHaveLength(1);
		expect(store.task(task.id)?.held).toBe(true);
		expect(store.nodes()).toEqual([f.node]);
	} finally { store.close(); }
	expect(JSON.parse(await readFile(f.state, "utf8")).calls).toEqual([]);
});

test("public submit keeps source and resource failures closed and input validation intact", async () => {
	const f = await fixture();
	const store = new FleetStore(f.db);
	try {
		const fleet = new Fleet(store);
		const options = { localNodeId: f.node.id };
		const missing = await submitPlacement(fleet, { ...f.input, baseCommit: "f".repeat(40) }, headroom([f.node.id], 10), options);
		expect(missing.task.attemptId).toBeUndefined();
		expect(missing.report.nodes[0].checks.source.ok).toBe(false);
		const stale = headroom([f.node.id], 10);
		stale.samples.get(f.node.id)!.at = Date.now() - 60_000;
		const result = await submitPlacement(fleet, { ...f.input, key: "stale" }, stale, options);
		expect(result.task.attemptId).toBeUndefined();
		expect(result.report.nodes[0].checks.resources.code).toBe("resources_stale");
		await expect(submitPlacement(fleet, { ...f.input, key: "invalid", baseCommit: "not-a-commit" }, headroom([f.node.id], 10), options)).rejects.toThrow();
		expect(store.tasks()).toHaveLength(2);
	} finally { store.close(); }
});

test("CLI rejects missing/unknown explicit identity and preserves unregister", async () => {
	const f = await fixture();
	expect((await f.cli("--local-node-id")).exit).toBe(1);
	const unknown = await f.cli("--resources", f.resources, "--local-node-id", "UNKNOWN", "submit", f.taskFile);
	expect(unknown.exit).toBe(1);
	expect(unknown.stderr).toContain("local_node_not_registered");
	expect((await f.cli("node", "unregister", f.node.id)).exit).toBe(1);
	expect((await f.cli("node", "disable", f.node.id)).exit).toBe(0);
	expect((await f.cli("node", "unregister", f.node.id)).exit).toBe(0);
	const store = new FleetStore(f.db);
	try { expect(store.nodes()).toEqual([]); expect(store.tasks()).toEqual([]); }
	finally { store.close(); }
});

test("CLI admits an explicitly transported target without claiming it is local", async () => {
	const f = await fixture();
	const config = join(f.dir, "node.json");
	const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
	const node = { ...f.node, workspaceTransport: { command: process.execPath, args: [helper, config] } };
	await writeFile(config, JSON.stringify(node));
	const store = new FleetStore(f.db);
	try { store.putNode(node); } finally { store.close(); }
	const result = await f.cli("--resources", f.resources, "submit", f.taskFile);
	expect(result.stderr).toBe("");
	expect(result.exit).toBe(0);
	const task = JSON.parse(result.stdout);
	expect(task.nodeId).toBe(node.id);
	expect(task.placement.nodes[0].checks.source.code).toBe("repo_and_exact_base_present");
	expect(task.placement.nodes[0].executionProven).toBe(false);
	// A real helper subprocess on this host models the transport, not a remote Mac or provider.
	expect(JSON.parse(await readFile(f.state, "utf8")).calls).toEqual([]);
});
