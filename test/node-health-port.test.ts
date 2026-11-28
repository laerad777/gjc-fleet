import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATING_AUDIT_CAPACITY, NodeHealthHistory, type HealthProbe } from "../src/node-health";
import { reservePlacement } from "../src/placement-preflight";
import { reconsiderQueue, submitPlacement } from "../src/index";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { getDashboardState, getDashboardTask, HEALTH_OBSERVE_MS, startDashboardServer } from "../src/dashboard";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import type { ResourceSample } from "../src/admission";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";
import { access, forbiddenAccess, runCli } from "./fixtures/node-health";
import { manualHealthTimer } from "./fixtures/manual-health-timer";

// The node-health operator switch on main cb1b744 (stored in the fleet DB, default off) and the
// main-only features it meets (queue reconsider, operator run, resource-return node blocks, archive,
// dashboard, rollback). Real child probes (controlled fixtures), real SQLite and FleetStore.
const good: HealthProbe = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
const bad: HealthProbe = { ...good, reachable: false };
const approval = { operator: "ops", reason: "port test" };
const open: { close(): void }[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** Switch-on decision inputs: fresh samples measured after the decision probes, stamped on receipt. */
const hub = (h: NodeHealthHistory, resources: { samples: ReadonlyMap<string, ResourceSample> }) => [resources, { nodeHealth: access(h, resources) }] as const;
function clocked(path: string) {
	const clock = { now: 1_800_000_000_000 };
	const h = new NodeHealthHistory(path, {}, { clock: () => clock.now, monotonic: () => clock.now });
	open.push(h);
	return { h, clock };
}
const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const brokerList = fileURLToPath(new URL("./fixtures/broker-list.ts", import.meta.url));
async function fixture() {
	const repo = await repositoryFixture("fleet-health-port-");
	dirs.push(repo.dir);
	const input: TaskInput = { schemaVersion: 1, key: "automatic", caller: "health-port", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	async function node(id: string, changes: Partial<NodeConfig> = {}) {
		const state = join(repo.dir, id + "-coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const config = join(repo.dir, id + ".json");
		const value: NodeConfig = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces-" + id), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] }, sdkTransport: { command: process.execPath, args: [brokerList, "ok"] }, ...changes };
		await writeFile(config, JSON.stringify(value));
		return JSON.parse(JSON.stringify(value)) as NodeConfig;
	}
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	open.push(store);
	return { ...repo, input, node, store, path: join(repo.dir, "fleet.sqlite") };
}
const selectionAudit = (store: FleetStore, id: string) => store.events(id).filter(e => e.kind === "selection").at(-1)!.data as any;

test("switch off (default): reserve never opens a history, probes or records, and its selection audit equals a plain reservation", async () => {
	const f = await fixture();
	const { h, clock } = clocked(f.path);
	const log = join(f.dir, "broker-calls.log");
	f.store.putNode(await f.node("A", { sdkTransport: { command: process.execPath, args: [brokerList, "ok,log=" + log] } }));
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	// Any history: here A failed and gating was switched on and off again.
	h.record("A", bad);
	h.setSelectionGating(true, approval);
	clock.now += 1_000;
	h.setSelectionGating(false, approval);
	const observations = h.observations("A");
	const nodeHealth = forbiddenAccess();
	const observed = f.store.submit(f.input);
	const withHealth = await reservePlacement(f.store, observed.id, headroom(["A"], 10), { nodeHealth });
	expect(withHealth.task.nodeId).toBe("A");
	expect("health" in withHealth).toBe(false);
	// The pre-feature path (no access at all) writes the same selection audit.
	const plain = f.store.submit({ ...f.input, key: "plain" });
	const without = await reservePlacement(f.store, plain.id, headroom(["A"], 10));
	expect(without.task.nodeId).toBe("A");
	const identity = new Set(["taskId", "attemptId", "inputDigest"]);
	const strip = (audit: unknown) => JSON.parse(JSON.stringify(audit, (key, value) => identity.has(key) ? undefined : value));
	expect(strip(selectionAudit(f.store, observed.id))).toEqual(strip(selectionAudit(f.store, plain.id)));
	expect(JSON.stringify(selectionAudit(f.store, observed.id))).not.toContain("node_unstable");
	// A pinned dispatch onto the failed node carries no warning while the switch is off.
	const pinned = f.store.submit({ ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "A" } });
	const reserved = await reservePlacement(f.store, pinned.id, headroom(["A"], 10), { nodeHealth });
	expect(reserved.task.nodeId).toBe("A");
	expect(f.store.events(pinned.id).some(e => e.kind === "node_health_warning")).toBe(false);
	expect(nodeHealth.calls).toEqual([]);
	expect(h.observations("A")).toEqual(observations);
	expect(h.warnings()).toHaveLength(0);
	expect(await Bun.file(log).exists()).toBe(false);
}, 120_000);

test("the selection gating switch is an audited operator action, persisted in the shared DB and bounded", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-health-gating-"));
	dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	open.push(new FleetStore(path));
	const { h, clock } = clocked(path);
	for (const missing of [{ operator: "", reason: "x" }, { operator: "ops", reason: " " }, { operator: "ops" }, undefined])
		expect(() => h.setSelectionGating(true, missing as any)).toThrow("selection_gating_approval_required");
	expect(() => h.setSelectionGating("yes" as any, approval)).toThrow("invalid_selection_gating");
	expect(h.selectionGatingAudit()).toEqual([]);
	expect(h.setSelectionGating(true, approval)).toEqual({ enabled: true, operator: "ops", reason: "port test", at: clock.now });
	const other = new NodeHealthHistory(path);
	open.push(other);
	expect(other.selectionGating().enabled).toBe(true);
	other.setSelectionGating(false, { operator: "ops2", reason: "rollback" });
	expect(h.selectionGating()).toMatchObject({ enabled: false, operator: "ops2", reason: "rollback" });
	for (let i = 0; i < GATING_AUDIT_CAPACITY + 10; i++) h.setSelectionGating(i % 2 === 0, approval);
	const audit = h.selectionGatingAudit() as { enabled: number }[];
	expect(audit).toHaveLength(GATING_AUDIT_CAPACITY);
	expect(h.selectionGating().enabled).toBe(audit.at(-1)!.enabled === 1);
	// The store reads the same switch with a plain query, also read-only; no table means off.
	const store = open[0] as FleetStore;
	expect(store.nodeHealthGating()).toEqual(h.selectionGating());
	const readOnly = new FleetStore(path, 2, { readOnly: true });
	open.push(readOnly);
	expect(readOnly.nodeHealthGating()).toEqual(h.selectionGating());
	const fresh = join(dir, "fresh.sqlite");
	const freshStore = new FleetStore(fresh);
	open.push(freshStore);
	expect(freshStore.nodeHealthGating()).toEqual({ enabled: false });
	const freshDb = new Database(fresh, { readonly: true });
	try { expect(freshDb.query("SELECT name FROM sqlite_master WHERE name LIKE 'node_health%'").all()).toEqual([]); } finally { freshDb.close(); }
});

test("CLI: show is read-only (also under --read-only), gating on is refused while nodes are not stable unless --force, every change is audited", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-health-cli-"));
	dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	new FleetStore(path).close();
	const cli = (...args: string[]) => runCli(path, ...args);
	const tables = () => { const db = new Database(path, { readonly: true }); try { return db.query("SELECT name FROM sqlite_master WHERE name LIKE 'node_health%'").all().length; } finally { db.close(); } };
	for (const flags of [[], ["--read-only"]]) {
		const shown = await cli(...flags, "node-health", "show");
		expect(shown.exit).toBe(0);
		expect(JSON.parse(shown.stdout)).toEqual({ gating: { enabled: false }, gatingAudit: [], nodes: [], preview: { nodes: [], stable: 0, wouldBeExcluded: [], allExcluded: false } });
	}
	// Showing never creates the node-health tables or takes a write lock.
	expect(tables()).toBe(0);
	const approvalFile = join(dir, "approval.json");
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "enable after bootstrap" }));
	expect((await cli("--read-only", "node-health", "gating", "on", approvalFile)).stderr).toContain("READ_ONLY");
	// Two enabled nodes without history (one has no sdkTransport, so its Broker list is never observable).
	const store = new FleetStore(path);
	const f = await fixture();
	store.putNode(await f.node("A"));
	const { sdkTransport: _none, ...withoutBroker } = await f.node("C");
	store.putNode(withoutBroker);
	store.putNode({ ...(await f.node("D")), enabled: false });
	store.close();
	const refused = await cli("node-health", "gating", "on", approvalFile);
	expect(refused.exit).toBe(1);
	const preview = JSON.parse(refused.stdout);
	expect(preview).toMatchObject({ ok: false, error: "node_health_not_stable", gating: { enabled: false }, preview: { stable: 0, wouldBeExcluded: ["A", "C"], allExcluded: true } });
	expect(preview.preview.nodes).toEqual([
		{ nodeId: "A", stable: false, wouldBeExcluded: true, failingDimensions: ["no_history"], consecutiveGood: 0, required: 3, neverObservable: [] },
		{ nodeId: "C", stable: false, wouldBeExcluded: true, failingDimensions: ["no_history"], consecutiveGood: 0, required: 3, neverObservable: ["brokerSessionListOk"] },
	]);
	expect(JSON.parse((await cli("node-health", "show")).stdout).gating).toEqual({ enabled: false });
	const forced = await cli("node-health", "gating", "on", "--force", approvalFile);
	expect(forced.exit).toBe(0);
	expect(JSON.parse(forced.stdout)).toMatchObject({ ok: true, forced: true, gating: { enabled: true, operator: "ops", reason: "enable after bootstrap" }, preview: { allExcluded: true } });
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops" }));
	const unapproved = await cli("node-health", "gating", "off", approvalFile);
	expect(unapproved.exit).not.toBe(0);
	expect(unapproved.stdout + unapproved.stderr).toContain("selection_gating_approval_required");
	expect((await cli("node-health", "gating", "off", "--force", approvalFile)).stderr).toContain("usage_node_health");
	const after = JSON.parse((await cli("--read-only", "node-health", "show")).stdout);
	expect(after.gating.enabled).toBe(true);
	expect(after.gatingAudit).toHaveLength(1);
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "back to off" }));
	expect((await cli("node-health", "gating", "off", approvalFile)).exit).toBe(0);
	expect(JSON.parse((await cli("node-health", "show")).stdout).gatingAudit.map((row: any) => row.enabled)).toEqual([1, 0]);
}, 60_000);

test("submit and queue reconsider apply the same stability decision; reconsider follows the operator switch", async () => {
	const f = await fixture();
	const { h, clock } = clocked(f.path);
	f.store.putNode(await f.node("A"));
	h.setSelectionGating(true, approval);
	const fleet = new Fleet(f.store);
	// Unstable (fresh) A: submitPlacement queues with the durable node_unstable reason.
	const submitted = await submitPlacement(fleet, f.input, ...hub(h, headroom(["A"], 10)));
	expect(submitted.task.attemptId).toBeUndefined();
	expect(submitted.task.phase).toBe("queued");
	expect((submitted as any).health.mode).toBe("enforce");
	expect(selectionAudit(f.store, submitted.task.id).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "consecutive_observations"] }]);
	// Queue reconsider of the same task decides identically: still excluded for the same cause.
	clock.now += 10_000;
	const samples = headroom(["A"], 10).samples;
	const [, options] = hub(h, { samples });
	expect(h.observations("A")).toHaveLength(1);
	const queuedOnly = (results: TaskRecord[]) => results.map(task => [task.id, task.phase, task.attemptId]);
	expect(queuedOnly(await reconsiderQueue(fleet, async () => samples, options))).toEqual([[submitted.task.id, "queued", undefined]]);
	expect(f.store.task(submitted.task.id)!.attemptId).toBeUndefined();
	expect(selectionAudit(f.store, submitted.task.id).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "consecutive_observations"] }]);
	// A failure observed between passes is named as the cause by reconsider as well.
	h.record("A", bad);
	clock.now += 30_000;
	expect(queuedOnly(await reconsiderQueue(fleet, async () => samples, options))).toEqual([[submitted.task.id, "queued", undefined]]);
	expect(selectionAudit(f.store, submitted.task.id).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "reachable", "consecutive_observations"] }]);
	expect(h.observations("A")).toHaveLength(4);
	// Operator switches gating off: the next pass selects exactly as without node health and
	// records nothing (it never even opens the history).
	h.setSelectionGating(false, approval);
	clock.now += 30_000;
	// A fresh sample: the switch-on passes above spawn real child probes and may outlast the old one.
	const offSamples = headroom(["A"], 10).samples;
	const results = await reconsiderQueue(fleet, async () => offSamples, { nodeHealth: forbiddenAccess() });
	expect(results.map(task => task.id)).toEqual([submitted.task.id]);
	expect(f.store.task(submitted.task.id)!.nodeId).toBe("A");
	expect(f.store.task(submitted.task.id)!.attemptId).toBeTruthy();
	expect(JSON.stringify(selectionAudit(f.store, submitted.task.id))).not.toContain("node_unstable");
	expect(h.observations("A")).toHaveLength(4);
}, 180_000);

test("a resource-return node block is a separate concept: it neither marks a node unstable nor is set by instability", async () => {
	const f = await fixture();
	const { h, clock } = clocked(f.path);
	for (const id of ["A", "B"]) f.store.putNode(await f.node(id));
	h.setSelectionGating(true, approval);
	// A: stable by spaced probes of this writer; B: a recorded failure.
	for (let i = 0; i < 3; i++) { if (i) clock.now += 30_000; h.record("A", good); }
	h.record("B", bad);
	const owner = f.store.submit({ ...f.input, key: "owner" });
	f.store.blockResourceReturnNode("A", owner.id, "op-1", "broker refused targeted close");
	expect(f.store.resourceReturnNodeBlock("A")).toMatchObject({ diagnostic: "broker refused targeted close", taskId: owner.id });
	expect(f.store.resourceReturnNodeBlock("B")).toBeUndefined();
	expect(h.dimensions("A")).toMatchObject({ stable: true, failingDimensions: [] });
	expect(h.dimensions("B")).toMatchObject({ stable: false, failingDimensions: ["reachable", "consecutive_observations"] });
	// Gated selection: the return-blocked but stable node A is selected, the unstable B is excluded
	// for instability only; no return block is created for B.
	clock.now += 30_000;
	const task = f.store.submit(f.input);
	const placed = await reservePlacement(f.store, task.id, ...hub(h, headroom(["A", "B"], 10)));
	expect(placed.task.nodeId).toBe("A");
	expect(selectionAudit(f.store, task.id).exclusions).toEqual([{ nodeId: "B", reasons: ["node_unstable", "reachable", "consecutive_observations"] }]);
	expect(f.store.resourceReturnNodeBlock("B")).toBeUndefined();
	// The dashboard shows both facts side by side without merging them.
	const state = getDashboardState(f.store, undefined, new Map(), undefined, h);
	const nodeA = state.nodes.find(node => node.id === "A")!;
	expect(nodeA.health).toMatchObject({ gating: "enforce", stable: true });
	expect(state.nodes.find(node => node.id === "B")!.health).toMatchObject({ gating: "enforce", stable: false, failingDimensions: ["reachable", "consecutive_observations"] });
	expect(state.nodeHealth).toEqual({ gating: "enforce", operator: "ops", reason: "port test", at: expect.any(Number) });
	// Clearing the return block is its own audited action and leaves node health untouched.
	const before = h.dimensions("A");
	f.store.clearResourceReturnNodeBlock("A", { operator: "ops", reason: "ledger repaired" });
	expect(f.store.resourceReturnNodeBlock("A")).toBeUndefined();
	expect(h.dimensions("A")).toEqual(before);
}, 120_000);

test("ui hub producer: one history records real probes of every enabled node, the API shows them, stop ends probing", async () => {
	const f = await fixture();
	const h = new NodeHealthHistory(f.path);
	open.push(h);
	// linux/darwin/win32 start a real local resource stream. On Linux /proc answers in a few
	// milliseconds, so it often lands before the first probe and is recorded as success. This node
	// has no sampler: the hub publishes a failure before the producer runs.
	f.store.putNode(await f.node("A", { os: "none" }));
	f.store.putNode({ ...(await f.node("OFF")), enabled: false });
	// The producer runs only while the stored switch is on (review 17580fae F1/F2).
	h.setSelectionGating(true, approval);
	const timer = manualHealthTimer();
	let server: ReturnType<typeof startDashboardServer> | undefined;
	try {
		server = startDashboardServer(f.store, 0, "127.0.0.1", { healthHistory: h });
		expect(timer.delays()).toEqual([0]);
		expect(await timer.tick()).toEqual({ ran: 1, pending: [HEALTH_OBSERVE_MS] });
		const [first] = h.observations("A");
		expect(first).toMatchObject({ reachable: true, brokerSessionListOk: true });
		expect(h.observations("OFF")).toHaveLength(0);
		const state: any = await (await fetch(`http://127.0.0.1:${server.port}/api/state`)).json();
		expect(state.nodeHealth).toEqual({ gating: "enforce", operator: "ops", reason: "port test", at: expect.any(Number) });
		// The fixture node has no resource sampler: its stream sample fails and is recorded as the
		// failed resource dimension, never as success (the reviewed rule).
		expect(first!.resourceSampleOk).not.toBe(true);
		const dims = h.dimensions("A");
		expect(state.nodes.find((node: any) => node.id === "A").health).toMatchObject({ gating: "enforce", stable: dims.stable, failingDimensions: dims.failingDimensions, consecutiveGood: dims.consecutiveGood, required: dims.required });
		expect(state.nodes.find((node: any) => node.id === "OFF").health).toMatchObject({ failingDimensions: ["no_history"] });
		server.stop(true);
		server = undefined;
		const recorded = h.observations("A").length;
		// This previously armed callback must be cancelled, not merely delayed until later.
		expect(await timer.tick()).toEqual({ ran: 0, pending: [] });
		expect(h.observations("A")).toHaveLength(recorded);
	} finally {
		try { server?.stop(true); } finally { timer.restore(); }
	}
}, 60_000);

test("archive keeps the node_health_warning audit and the history; archiving records no probe", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-health-archive-"));
	dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 2);
	open.push(store);
	const { h } = clocked(path);
	const db = new Database(path);
	open.push(db);
	const response = join(dir, "response.json"), script = join(dir, "sdk.ts");
	writeFileSync(script, `if(process.env.GJC_SDK_BROKER_AUTOSTART!=="0"||JSON.stringify(process.argv.slice(2))!==JSON.stringify(["sdk","session","list","--scope","all","--json"]))process.exit(9);console.log(await Bun.file(${JSON.stringify(response)}).text());`);
	writeFileSync(response, JSON.stringify({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" }, warnings: [], sessions: [] } }));
	const node: any = { id: "node", sdkTransport: { command: process.execPath, args: [script] } };
	const task: TaskRecord = { id: "task-original", input: { schemaVersion: 1, key: "key", caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "archive test", required: { nodeId: "node" } }, inputDigest: "digest", nodeId: "node", nodeSnapshot: node, attemptId: "attempt-original", sessionId: "session-original", phase: "blocked_unknown", held: true, reason: "original unknown", workspace: { path: "/owned/task-original-attempt-original" }, result: { status: "failed", evidence: { original: true }, executionTerminal: false, verified: false } } as TaskRecord;
	db.query("INSERT INTO nodes VALUES (?,?)").run(node.id, JSON.stringify(node));
	db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(task.id, "test", "key", "digest", JSON.stringify(task));
	db.query("INSERT INTO operations VALUES (?,?,?,?,?)").run("op", task.id, task.attemptId!, "create", JSON.stringify({ id: "op", kind: "create", payload: { original: true } }));
	// The pinned reservation's warning as the store writes it, plus the history's sidecar copy.
	db.query("INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)").run(task.id, "node_health_warning", new Date().toISOString(), JSON.stringify({ nodeId: "node", pinned: true, failingDimensions: ["reachable"] }));
	h.record("node", bad);
	h.auditPinnedAdmission(task.id, "node", ["reachable"]);
	const health = h.dimensions("node"), observations = h.observations("node"), warnings = h.warnings();
	const archived = await new Fleet(store).archive(task.id, {}, "tester");
	expect(archived.phase).toBe("archived");
	expect(store.events(task.id).filter(e => e.kind === "node_health_warning")).toEqual([expect.objectContaining({ kind: "node_health_warning", data: { nodeId: "node", pinned: true, failingDimensions: ["reachable"] } })]);
	expect(h.dimensions("node")).toEqual(health);
	expect(h.observations("node")).toEqual(observations);
	expect(h.warnings()).toEqual(warnings);
	const state = getDashboardState(store, undefined, new Map(), undefined, h);
	expect(state.archivedTasks.map(t => t.id)).toEqual([task.id]);
	expect(state.archivedTasks[0]!.timeline.map(e => e.kind)).toContain("node_health_warning");
	expect(getDashboardTask(store, task.id)!.timeline.map(e => e.kind)).toContain("node_health_warning");
	// Re-specified in r5 (review 09e80a06 F1): switch off shows no node health; switched on, the
	// dashboard shows the history kept through the archive.
	expect(state.nodes[0]!).not.toHaveProperty("health");
	h.setSelectionGating(true, approval);
	expect(getDashboardState(store, undefined, new Map(), undefined, h).nodes[0]!.health).toMatchObject({ gating: "enforce", stable: false, failingDimensions: ["reachable", "consecutive_observations"] });
});

test("rollback: node health only adds node_health_* tables; user_version, application_id, fleet_meta and every fleet table are unchanged", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-health-rollback-"));
	dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	new FleetStore(path).close();
	const snapshot = () => {
		const db = new Database(path, { readonly: true });
		try {
			return {
				userVersion: db.query("PRAGMA user_version").get(),
				applicationId: db.query("PRAGMA application_id").get(),
				meta: db.query("SELECT * FROM fleet_meta ORDER BY 1").all(),
				schema: db.query("SELECT type, name, sql FROM sqlite_master WHERE tbl_name NOT LIKE 'node_health%' ORDER BY name").all(),
				health: (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'node_health%' ORDER BY name").all() as { name: string }[]).map(r => r.name),
			};
		} finally { db.close(); }
	};
	const before = snapshot();
	expect(before.health).toEqual([]);
	const { h } = clocked(path);
	h.record("A", good);
	h.setSelectionGating(true, approval);
	h.auditPinnedAdmission("t", "A", ["consecutive_observations"]);
	h.close();
	open.splice(open.indexOf(h), 1);
	const after = snapshot();
	expect<unknown>({ ...after, health: [] }).toEqual(before);
	expect(after.health).toEqual(["node_health_bootstrap", "node_health_gating", "node_health_meta", "node_health_rows", "node_health_state", "node_health_warning_rollup", "node_health_warnings"]);
	// Every node_health table is created with IF NOT EXISTS, so reopening is a no-op on the schema.
	const reopened = new NodeHealthHistory(path);
	reopened.close();
	expect(snapshot()).toEqual(after);
	// The fleet store still opens, writes and backs up the DB; the backup carries the history.
	const store = new FleetStore(path);
	open.push(store);
	store.submit({ schemaVersion: 1, key: "after-rollback", caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "write", required: {} });
	const backup = store.backup(join(dir, "backup.sqlite"));
	const copy = new Database(backup.path, { readonly: true });
	open.push(copy);
	expect((copy.query("SELECT count(*) AS n FROM node_health_rows").get() as { n: number }).n).toBe(1);
	expect((copy.query("SELECT enabled FROM node_health_gating").get() as { enabled: number }).enabled).toBe(1);
});
