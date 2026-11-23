// Review 17580fae F1/F2: with the stored switch off, a writable `ui` creates no node_health table or
// index, writes no row, and makes no producer call to any node, for several producer ticks; a
// producer started with the switch on stops once the switch reads off. Every node transport is
// wrapped in a call log, so each node call the ui process makes is counted. With FLEET_BASE_ROOT
// pointing at a pristine main extract, main's ui runs on a byte copy of the same DB beside it.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHealthHistory } from "../src/node-health";
import { getDashboardState, startDashboardServer, HEALTH_OBSERVE_MS } from "../src/dashboard";
import type { NodeConfig } from "../src/contracts";
import { approval, bad, cleanup, clocked, fleetFixture, makeStable, runCli, track } from "./fixtures/node-health";

setDefaultTimeout(180_000);
afterEach(cleanup, 60_000);

const patched = fileURLToPath(new URL("..", import.meta.url));
const callLog = fileURLToPath(new URL("./fixtures/call-log.ts", import.meta.url));
const base = process.env.FLEET_BASE_ROOT;

/** Every transport of the node runs through the call log first. */
function logged(node: NodeConfig, log: string): NodeConfig {
	const wrap = (transport: { command: string; args: string[] }) => ({ command: process.execPath, args: [callLog, log, transport.command, ...transport.args] });
	return { ...node, transport: wrap(node.transport), ...(node.workspaceTransport ? { workspaceTransport: wrap(node.workspaceTransport) } : {}), ...(node.sdkTransport ? { sdkTransport: wrap(node.sdkTransport) } : {}) };
}
const calls = (log: string) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);

/** Schema (every sqlite_master entry with its SQL), per-table row counts, user_version and application_id. */
function snapshot(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		const schema = db.query("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() as { type: string; name: string }[];
		const counts = Object.fromEntries(schema.filter((row) => row.type === "table").map((row) => [row.name, (db.query(`SELECT count(*) AS n FROM "${row.name.replaceAll('"', '""')}"`).get() as { n: number }).n]));
		return JSON.stringify({ userVersion: db.query("PRAGMA user_version").get(), applicationId: db.query("PRAGMA application_id").get(), schema, counts });
	} finally {
		db.close();
	}
}

/** A real `ui` process of the tree at `root` (writable, probing), left running for `ms`, then stopped. */
async function ui(root: string, db: string, ms: number) {
	const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "--db", db, "ui", "--port", "0"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	let stderr = "";
	const stderrDone = (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk); })();
	try {
		const reader = child.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		reader.releaseLock();
		expect(JSON.parse(first.split("\n")[0]!)).toMatchObject({ ok: true });
		await Bun.sleep(ms);
	} finally {
		child.kill("SIGTERM");
		const exited = await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(5_000).then(() => false),
		]);
		if (!exited) {
			child.kill("SIGKILL");
			await child.exited;
		}
		await stderrDone;
	}
	return { stderr };
}

test("F1/F2: switch off, a writable ui running several producer ticks leaves schema and row counts identical and makes no node call", async () => {
	const f = await fleetFixture();
	const log = join(f.dir, "calls.log");
	f.store.putNode(logged(await f.node("A"), log));
	f.store.putNode(logged(await f.node("B"), log));
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	f.store.close();
	const before = snapshot(f.path);
	const baseDb = join(f.dir, "base.sqlite"), baseLog = join(f.dir, "base-calls.log");
	if (base) {
		copyFileSync(f.path, baseDb);
		const db = new Database(baseDb);
		try { db.query("UPDATE nodes SET data = replace(data, ?, ?)").run(JSON.stringify(log).slice(1, -1), JSON.stringify(baseLog).slice(1, -1)); } finally { db.close(); }
	}
	// Two producer periods after the first tick, which runs at once: three ticks of the round-2 producer.
	const ms = 2 * HEALTH_OBSERVE_MS + 5_000;
	const [run, baseRun] = await Promise.all([ui(patched, f.path, ms), base ? ui(base, baseDb, ms) : undefined]);
	expect(run.stderr).not.toContain("node_health_observe_failed");
	const after = snapshot(f.path);
	expect(after).toBe(before);
	expect(JSON.parse(after).schema.filter((row: { name: string }) => row.name.startsWith("node_health"))).toEqual([]);
	expect(calls(log)).toEqual([]);
	if (base) {
		expect(snapshot(baseDb)).toBe(after);
		expect(calls(baseLog)).toEqual(calls(log));
		expect(baseRun!.stderr).toBe(run.stderr);
	}
}, 120_000);

test("F2: a producer started with the switch on stops probing and recording once the switch is turned off elsewhere", async () => {
	const f = await fleetFixture();
	const log = join(f.dir, "calls.log");
	f.store.putNode(logged(await f.node("A"), log));
	const h = track(new NodeHealthHistory(f.path));
	h.setSelectionGating(true, approval);
	const server = startDashboardServer(f.store, 0, "127.0.0.1", { healthHistory: h });
	try {
		const deadline = Date.now() + 30_000;
		while (h.observations("A").length === 0 && Date.now() < deadline) await Bun.sleep(100);
		expect(h.observations("A")).toHaveLength(1);
		expect(calls(log).length).toBeGreaterThan(0);
		const approvalFile = join(f.dir, "off.json");
		writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "switched off elsewhere" }));
		expect((await runCli(f.path, "node-health", "gating", "off", approvalFile)).exit).toBe(0);
		await Bun.sleep(1_000);
		const recorded = h.observations("A").length, called = calls(log).length;
		// Past the next producer tick: it reads the switch off, so nothing is probed, recorded or rescheduled.
		await Bun.sleep(HEALTH_OBSERVE_MS + 5_000);
		expect(h.observations("A")).toHaveLength(recorded);
		expect(calls(log)).toHaveLength(called);
	} finally { server.stop(true); }
}, 180_000);

/** A real `ui --no-probe` of the tree at `root`: its /api/state once, then stopped. */
async function uiState(root: string, db: string) {
	const child = Bun.spawn([process.execPath, join(root, "src/cli.ts"), "--db", db, "ui", "--port", "0", "--no-probe"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	try {
		const reader = child.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		reader.releaseLock();
		const { ok, url } = JSON.parse(first.split("\n")[0]!);
		expect(ok).toBe(true);
		return (await (await fetch(`${url}/api/state`)).json()) as Record<string, any>;
	} finally {
		child.kill("SIGTERM");
		const exited = await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(5_000).then(() => false),
		]);
		if (!exited) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}
/** The state without its clocks (generatedAt, nodes[].probe.checkedAt) and its asynchronously loaded local GJC runtime probe. */
const comparable = (state: Record<string, any>) => JSON.stringify({ ...state, generatedAt: undefined, gjcRuntime: undefined, nodes: state.nodes.map((node: any) => ({ ...node, probe: node.probe && { ...node.probe, checkedAt: undefined } })) });
const healthFree = (state: Record<string, any>) => {
	expect(state).not.toHaveProperty("nodeHealth");
	for (const node of state.nodes) expect(node).not.toHaveProperty("health");
	for (const label of ["no_history", "observe", "enforce", "stable"]) expect(JSON.stringify(state)).not.toContain(label);
};

test("r5 F1: switch off, the dashboard state with a health history equals the state without one (no table, and a history switched on then off)", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B", { broker: null }));
	f.store.submit(f.input);
	const without = getDashboardState(f.store, undefined, new Map(), undefined);
	healthFree(without);
	// No node_health table: the read-only view the ui opens with the switch off.
	const view = track(new NodeHealthHistory(f.path, {}, { readOnly: true }));
	const noTable = getDashboardState(f.store, undefined, new Map(), undefined, view);
	healthFree(noTable);
	expect(comparable(noTable)).toBe(comparable(without));
	// A recorded history, the switch turned on and off again by an operator: still nothing shown.
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	h.record("B", bad);
	h.setSelectionGating(true, approval);
	expect(getDashboardState(f.store, undefined, new Map(), undefined, h).nodeHealth).toMatchObject({ gating: "enforce" });
	h.setSelectionGating(false, approval);
	for (const history of [h, view]) {
		const off = getDashboardState(f.store, undefined, new Map(), undefined, history);
		healthFree(off);
		expect(comparable(off)).toBe(comparable(getDashboardState(f.store, undefined, new Map(), undefined)));
	}
}, 60_000);

test("r5 F1: switch off, a real ui's /api/state has no nodeHealth or health (equal to the base ui's /api/state with FLEET_BASE_ROOT)", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B", { broker: null }));
	f.store.submit(f.input);
	f.store.close();
	const baseDb = join(f.dir, "base.sqlite");
	if (base) copyFileSync(f.path, baseDb);
	const state = await uiState(patched, f.path);
	expect(state.nodes.map((node: any) => node.id)).toEqual(["A", "B"]);
	healthFree(state);
	if (base) expect(comparable(state)).toBe(comparable(await uiState(base, baseDb)));
}, 60_000);

test("P2-1: `gating off` on a DB without the node_health_gating table prints the current state and leaves the schema snapshot identical", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	f.store.close();
	const before = snapshot(f.path);
	expect(JSON.parse(before).schema.filter((row: { name: string }) => row.name.startsWith("node_health"))).toEqual([]);
	const approvalFile = join(f.dir, "off.json");
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "already off" }));
	const off = await runCli(f.path, "node-health", "gating", "off", approvalFile);
	expect(off.exit).toBe(0);
	expect(JSON.parse(off.stdout)).toEqual({ ok: true, gating: { enabled: false }, unchanged: true });
	expect(snapshot(f.path)).toBe(before);
}, 60_000);

// Review b7eb69c8 F1: with the switch off, `node-health bootstrap` is refused with a fixed code before any
// node-health history is opened: no node_health table, index or row, and no call to the node.
test("r6 F1: switch off, `node-health bootstrap` is refused with node_health_gating_off, creates no node_health table and makes no node call", async () => {
	const f = await fleetFixture();
	const log = join(f.dir, "calls.log");
	f.store.putNode(logged(await f.node("A"), log));
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	f.store.close();
	const before = snapshot(f.path);
	const refused = await runCli(f.path, "node-health", "bootstrap", "A", "--reason", "switch off");
	expect(refused.exit).toBe(1);
	expect(refused.stdout).toBe("");
	expect(JSON.parse(refused.stderr.trim())).toEqual({ ok: false, error: "node_health_gating_off" });
	const after = snapshot(f.path);
	expect(after).toBe(before);
	expect(JSON.parse(after).schema.filter((row: { name: string }) => row.name.startsWith("node_health"))).toEqual([]);
	expect(calls(log)).toEqual([]);
}, 60_000);

test("r6 F1: switched on then off, `node-health bootstrap` is refused and the schema and every row count stay identical; switched on it is not refused", async () => {
	const f = await fleetFixture();
	const log = join(f.dir, "calls.log");
	f.store.putNode(logged(await f.node("A"), log));
	const h = new NodeHealthHistory(f.path);
	h.setSelectionGating(true, approval);
	h.setSelectionGating(false, approval);
	h.close();
	expect(f.store.nodeHealthGating()).toMatchObject({ enabled: false });
	const before = snapshot(f.path);
	const refused = await runCli(f.path, "node-health", "bootstrap", "A", "--reason", "switch off");
	expect(refused.exit).toBe(1);
	expect(JSON.parse(refused.stderr.trim())).toEqual({ ok: false, error: "node_health_gating_off" });
	expect(snapshot(f.path)).toBe(before);
	expect(calls(log)).toEqual([]);
	// The refusal follows the stored switch only: switched on, the command passes the gate (an unknown node
	// then fails on its own fixed code without probing anything).
	const on = track(new NodeHealthHistory(f.path));
	on.setSelectionGating(true, approval);
	const unknown = await runCli(f.path, "node-health", "bootstrap", "Z", "--reason", "switch on");
	expect(unknown.exit).toBe(1);
	expect(JSON.parse(unknown.stderr.trim())).toEqual({ ok: false, error: "node_not_found" });
	expect(calls(log)).toEqual([]);
}, 60_000);

// r6 sweep: `gating off` while the switch already reads off (table and an off row present) writes nothing:
// no audit row, no migration, no table or index.
test("r6 sweep: `gating off` while already off on a DB with an off row prints unchanged and leaves the schema and every row count identical", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const h = new NodeHealthHistory(f.path);
	h.setSelectionGating(true, approval);
	h.setSelectionGating(false, approval);
	h.close();
	const current = f.store.nodeHealthGating();
	expect(current.enabled).toBe(false);
	f.store.close();
	const before = snapshot(f.path);
	const approvalFile = join(f.dir, "off.json");
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "already off" }));
	const off = await runCli(f.path, "node-health", "gating", "off", approvalFile);
	expect(off.exit).toBe(0);
	expect(JSON.parse(off.stdout)).toEqual({ ok: true, gating: current, unchanged: true });
	expect(snapshot(f.path)).toBe(before);
}, 60_000);
