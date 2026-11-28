// Review caba7bbd fixes: H1 (switch off never perturbs scheduling, also with a slow Broker), M1 (the
// moment of switching on), L1 (health errors never abort a decision), L2 (evidence stamped on
// receipt), the operator `run` path and the read-only health view. Real child probes and SQLite.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeHealthHistory } from "../src/node-health";
import { gatingPreview } from "../src/node-health-gate";
import { reservePlacement } from "../src/placement-preflight";
import { reconsiderQueue, submitPlacement } from "../src/index";
import { runTask, operatorExit } from "../src/operator-commands";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { getDashboardState, sampleResourcesOnce, startDashboardServer } from "../src/dashboard";
import { DEFAULT_ADMISSION_POLICY, type ResourceSample } from "../src/admission";
import { headroom } from "./admission-fixture";
import { manualHealthTimer } from "./fixtures/manual-health-timer";
import { access, approval, bad, cleanup, cliPath, clocked, fleetFixture, forbiddenAccess, good, makeStable, runCli, selectionAudit, track } from "./fixtures/node-health";

afterEach(cleanup);

test("H1: a slow Broker never changes a switch-off decision (one and two nodes); nothing probes it", async () => {
	const f = await fleetFixture();
	const log = join(f.dir, "broker.log");
	f.store.putNode(await f.node("A", { broker: `ok,slow=6000,log=${log}` }));
	f.store.putNode(await f.node("B", { broker: `ok,log=${log}` }));
	// Any history, including a recorded failure of A: irrelevant while the switch is off.
	const { h } = clocked(f.path);
	h.record("A", bad);
	const fleet = new Fleet(f.store);
	for (const [key, nodes] of [["one", ["A"]], ["two", ["A", "B"]]] as const) {
		// The caller's samples are 10 s old (of 15 s): a 6 s probe on the admission path would expire them.
		const started = performance.now();
		const placed = await submitPlacement(fleet, { ...f.input, key }, headroom([...nodes], 10), { nodeHealth: forbiddenAccess() });
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(placed.task.attemptId).toBeTruthy();
		for (const id of nodes) expect(placed.report.nodes.find(row => row.nodeId === id)!.checks.resources.ok).toBe(true);
	}
	const task = f.store.submit({ ...f.input, key: "reserve" });
	expect((await reservePlacement(f.store, task.id, headroom(["A", "B"], 10), { nodeHealth: forbiddenAccess() })).task.nodeId).toBeTruthy();
	expect(await Bun.file(log).exists()).toBe(false);
	expect(h.observations("A")).toHaveLength(1);
}, 60_000);

test("H1, switch on: the decision probes run before the samples are measured, so a slow Broker does not expire them", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A", { broker: "ok,slow=6000" }));
	f.store.putNode(await f.node("B"));
	const start = Date.now();
	const clock = { now: start };
	// Monotonic = injected advance (exact) + real elapsed time (only ever adds): spacing is never short.
	const h = track(new NodeHealthHistory(f.path, {}, { clock: () => clock.now, monotonic: () => clock.now - start + performance.now() }));
	// Stable by spaced probes of this writer (its monotonic clock runs with the injected offset).
	for (let i = 0; i < 3; i++) { clock.now += 30_000; for (const id of ["A", "B"]) h.record(id, good); }
	clock.now += 30_000;
	h.setSelectionGating(true, approval);
	// Fresh samples are measured after the probes (as the CLI does): both nodes stay admissible.
	const measured = () => ({ samples: new Map([...headroom(["A", "B"], 10).samples].map(([id, s]) => [id, { ...s, at: Date.now() }])) });
	const fresh = await submitPlacement(new Fleet(f.store), { ...f.input, key: "fresh" }, headroom(["A", "B"], 10), {
		nodeHealth: { history: () => h, sample: async stamp => { const { samples } = measured(); for (const [id, s] of samples) stamp(id, s); return samples; } },
	});
	expect(fresh.task.attemptId).toBeTruthy();
	expect(fresh.report.nodes.every(row => row.checks.resources.ok)).toBe(true);
	expect((fresh as any).health).toEqual({ mode: "enforce", decisions: [{ nodeId: "A", pinned: false, allowed: true, failingDimensions: [] }, { nodeId: "B", pinned: false, allowed: true, failingDimensions: [] }] });
	// Without a fresh measurement the caller's 10 s old samples age by the probe time: the documented
	// fail-closed cost of deciding on stale input (resources_unknown), never an unsafe placement.
	clock.now += 30_000;
	const stale = await submitPlacement(new Fleet(f.store), { ...f.input, key: "stale" }, headroom(["A", "B"], 10), { nodeHealth: { history: () => h } });
	expect(stale.task.attemptId).toBeUndefined();
	expect(JSON.stringify(selectionAudit(f.store, stale.task.id))).toContain("resources");
}, 60_000);

test("M1: the moment of switching on with little history: who is excluded, what the operator sees, pinned dispatch still works", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B"));
	f.store.putNode(await f.node("C", { broker: null }));
	const { h, clock } = clocked(f.path);
	// Preview before switching: no node has history, so every enabled node would be excluded.
	const preview = gatingPreview(f.store.nodes(), h);
	expect(preview).toMatchObject({ stable: 0, wouldBeExcluded: ["A", "B", "C"], allExcluded: true });
	expect(preview.nodes.find(row => row.nodeId === "C")!.neverObservable).toEqual(["brokerSessionListOk"]);
	// The CLI refuses exactly this without --force.
	const approvalFile = join(f.dir, "approval.json");
	writeFileSync(approvalFile, JSON.stringify(approval));
	expect((await runCli(f.path, "node-health", "gating", "on", approvalFile)).exit).toBe(1);
	expect(f.store.nodeHealthGating().enabled).toBe(false);
	expect((await runCli(f.path, "node-health", "gating", "on", "--force", approvalFile)).exit).toBe(0);
	expect(f.store.nodeHealthGating()).toMatchObject({ enabled: true, operator: "ops" });
	// Forced on: every automatic candidate is excluded at once; the task is queued, not failed, and
	// its durable selection audit names each node's cause.
	const fleet = new Fleet(f.store);
	const auto = await submitPlacement(fleet, f.input, headroom(["A", "B", "C"], 10), { nodeHealth: access(h, headroom(["A", "B", "C"], 10)) });
	expect(auto.task.phase).toBe("queued");
	expect(selectionAudit(f.store, auto.task.id).exclusions).toEqual([
		{ nodeId: "A", reasons: ["node_unstable", "consecutive_observations"] },
		{ nodeId: "B", reasons: ["node_unstable", "consecutive_observations"] },
		{ nodeId: "C", reasons: ["node_unstable", "consecutive_observations", "unobserved:brokerSessionListOk"] },
	]);
	// Pinned dispatch onto a ready but unstable node is still reserved, with the warning in the same transaction.
	const pinned = await submitPlacement(fleet, { ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "C" } }, headroom(["C"], 10), { nodeHealth: access(h, headroom(["C"], 10)) });
	expect(pinned.task.nodeId).toBe("C");
	expect(f.store.events(pinned.task.id).find(e => e.kind === "node_health_warning")!.data).toMatchObject({ nodeId: "C", pinned: true, failingDimensions: ["consecutive_observations", "unobserved:brokerSessionListOk"] });
	// Spaced decisions of this writer make A and B stable; C (no guarded sdkTransport) never becomes stable.
	for (let i = 0; i < 2; i++) { clock.now += 30_000; await reconsiderQueue(fleet, async () => headroom(["A", "B", "C"], 10).samples, { nodeHealth: access(h, headroom(["A", "B", "C"], 10)) }); }
	expect(f.store.task(auto.task.id)!.nodeId).toBe("A");
	expect(h.dimensions("C")).toMatchObject({ stable: false, failingDimensions: ["unobserved:brokerSessionListOk"] });
	// The dashboard names the never-observable dimension on C only.
	const dash = getDashboardState(f.store, undefined, new Map(), undefined, h);
	expect(dash.nodes.map(node => [node.id, node.health!.neverObservable])).toEqual([["A", []], ["B", []], ["C", ["brokerSessionListOk"]]]);
	// Switching off restores the pre-feature decision at once.
	h.setSelectionGating(false, approval);
	const after = await submitPlacement(fleet, { ...f.input, key: "after-off", required: { ...f.input.required, nodeId: "C" } }, headroom(["C"], 10), { nodeHealth: forbiddenAccess() });
	expect(after.task.nodeId).toBe("C");
	expect(f.store.events(after.task.id).some(e => e.kind === "node_health_warning")).toBe(false);
}, 120_000);

test("M1: the CLI submit output shows the gate; a node never seen by the history reads no_history", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const h = track(new NodeHealthHistory(f.path));
	h.setSelectionGating(true, approval);
	expect(h.dimensions("A").failingDimensions).toEqual(["no_history"]);
	const taskFile = join(f.dir, "task.json");
	writeFileSync(taskFile, JSON.stringify(f.input));
	const resources = join(f.dir, "resources.json");
	writeFileSync(resources, JSON.stringify(Object.fromEntries([...headroom(["A"], 10).samples].map(([id, s]) => [id, { ...s, at: Date.now() }]))));
	const submitted = await runCli(f.path, "--resources", resources, "submit", taskFile);
	expect(submitted.exit).toBe(1);
	const output = JSON.parse(submitted.stdout);
	expect(output.phase).toBe("queued");
	// --resources samples are admission input, never health success evidence.
	expect(output.placement.nodeHealth).toEqual({ mode: "enforce", decisions: [{ nodeId: "A", pinned: false, allowed: false, failingDimensions: ["consecutive_observations", "unobserved:resourceSampleOk"] }] });
	expect(output.placement.selection.exclusions).toContainEqual({ nodeId: "A", reasons: ["node_unstable", "consecutive_observations", "unobserved:resourceSampleOk"] });
	const shown = JSON.parse((await runCli(f.path, "--read-only", "node-health", "show", "A")).stdout);
	expect(shown.nodes[0]).toMatchObject({ nodeId: "A", stable: false, consecutiveGood: 1, required: 3 });
}, 60_000);

test("L1: a corrupt health state never affects a switch-off decision; with the switch on it fails closed and pins still dispatch", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	const db = track(new Database(f.path));
	db.query("UPDATE node_health_state SET data='{' WHERE node='A'").run();
	const fleet = new Fleet(f.store);
	const off = await submitPlacement(fleet, { ...f.input, key: "off" }, headroom(["A"], 10), { nodeHealth: access(h, headroom(["A"], 10)) });
	expect(off.task.nodeId).toBe("A");
	expect("health" in off).toBe(false);
	h.setSelectionGating(true, approval);
	const auto = await submitPlacement(fleet, { ...f.input, key: "auto" }, headroom(["A"], 10), { nodeHealth: access(h, headroom(["A"], 10)) });
	expect(auto.task.phase).toBe("queued");
	// The corrupt state JSON surfaces when the decision probe is recorded: a fixed code, stage and class, no text.
	expect((auto as any).health.error).toEqual({ code: "node_health_unavailable", stage: "record", errorClass: "SyntaxError" });
	expect(selectionAudit(f.store, auto.task.id).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "node_health_unavailable"] }]);
	const pinned = await submitPlacement(fleet, { ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "A" } }, headroom(["A"], 10), { nodeHealth: access(h, headroom(["A"], 10)) });
	expect(pinned.task.nodeId).toBe("A");
	expect(f.store.events(pinned.task.id).find(e => e.kind === "node_health_warning")!.data).toMatchObject({ nodeId: "A", pinned: true, failingDimensions: ["node_health_unavailable"] });
	// A caller that supplies no access at all fails closed the same way; reconsider does not throw either.
	const none = await submitPlacement(fleet, { ...f.input, key: "none" }, headroom(["A"], 10));
	expect((none as any).health.error).toEqual({ code: "node_health_access_required", stage: "access", errorClass: "none" });
	expect(none.task.phase).toBe("queued");
	expect(await reconsiderQueue(fleet, async () => headroom(["A"], 10).samples, { nodeHealth: access(h, headroom(["A"], 10)) })).toEqual([expect.objectContaining({ phase: "queued" }), expect.objectContaining({ phase: "queued" })]);
	// The health write lock busy past its timeout (SQLITE_BUSY on record) fails closed the same way.
	db.query("DELETE FROM node_health_state WHERE node='A'").run();
	class Busy extends NodeHealthHistory { override record(): never { throw new Error("SQLITE_BUSY: database is locked"); } }
	const busy = track(new Busy(f.path));
	const locked = await submitPlacement(fleet, { ...f.input, key: "busy" }, headroom(["A"], 10), { nodeHealth: access(busy, headroom(["A"], 10)) });
	expect(locked.task.phase).toBe("queued");
	expect((locked as any).health.error).toEqual({ code: "node_health_unavailable", stage: "record", errorClass: "Error" });
	expect(selectionAudit(f.store, locked.task.id).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "node_health_unavailable"] }]);
}, 120_000);

test("L2: resource evidence is stamped on receipt, so a sample received early is aged from its receipt", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	h.setSelectionGating(true, approval);
	const samples = headroom(["A"], 10).samples;
	// Received, then the measurement keeps waiting for slower nodes past maxSampleAgeMs before returning.
	await reservePlacement(f.store, f.store.submit(f.input).id, { samples }, { nodeHealth: { history: () => h, sample: async stamp => {
		for (const [id, s] of samples) stamp(id, s);
		clock.now += DEFAULT_ADMISSION_POLICY.maxSampleAgeMs + 1;
		return samples;
	} } });
	expect(h.observations("A").at(-1)!.resourceSampleOk).toBeNull();
	// sampleResourcesOnce reports every received sample through onSample before it returns.
	const received: [string, ResourceSample, number][] = [];
	const result = await sampleResourcesOnce(f.store.nodes(), 5_000, (id, sample) => received.push([id, sample, performance.now()]));
	const returned = performance.now();
	expect(received.length).toBeGreaterThan(0);
	expect(received.every(([id, , at]) => id === "A" && at <= returned)).toBe(true);
	expect(result.get("A")).toEqual(received.at(-1)![1]);
}, 60_000);

test("operator run: switch off never opens a history; switch on queues unstable automatic runs and dispatches pins with a warning", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const fleet = new Fleet(f.store);
	const sample = async () => headroom(["A"], 10).samples;
	const nodeHealth = forbiddenAccess();
	const off = await runTask(fleet, { ...f.input, key: "run-off" }, { sample, nodeHealth });
	expect(off.task.nodeId).toBe("A");
	expect(off.placement).not.toHaveProperty("nodeHealth");
	expect(nodeHealth.calls).toEqual([]);
	const { h } = clocked(f.path);
	h.setSelectionGating(true, approval);
	const queued = await runTask(fleet, { ...f.input, key: "run-on" }, { sample, nodeHealth: access(h, headroom(["A"], 10)) });
	expect(queued.code).toBe(operatorExit.queued);
	expect(queued.placement!.nodeHealth).toMatchObject({ mode: "enforce", decisions: [{ nodeId: "A", allowed: false }] });
	const pinned = await runTask(fleet, { ...f.input, key: "run-pin", required: { ...f.input.required, nodeId: "A" } }, { sample, nodeHealth: access(h, headroom(["A"], 10)) });
	expect(pinned.task.nodeId).toBe("A");
	expect(f.store.events(pinned.task.id).some(e => e.kind === "node_health_warning")).toBe(true);
}, 120_000);

test("off by default and only the DB switch counts: no table, history rows without a switch row, and off rows all read off", async () => {
	const f = await fleetFixture();
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	const { h } = clocked(f.path);
	h.record("A", good);
	expect(f.store.nodeHealthGating()).toEqual({ enabled: false });
	h.setSelectionGating(false, approval);
	expect(f.store.nodeHealthGating()).toMatchObject({ enabled: false, operator: "ops" });
	// No environment variable turns it on (behaviour, in process and through the CLI): with candidate
	// variables set, the switch still reads off, no history is opened, and an automatic submit onto a
	// node that is not stable (excluded when the switch is on) is decided exactly as without them.
	f.store.putNode(await f.node("A"));
	const candidates = { NODE_HEALTH_GATING: "1", NODE_HEALTH: "on", FLEET_NODE_HEALTH: "on", FLEET_NODE_HEALTH_GATING: "1", GJC_FLEET_NODE_HEALTH: "1", GJC_NODE_HEALTH_GATING: "true", NODE_HEALTH_SELECTION_GATING: "enforce" };
	const saved = { ...process.env };
	Object.assign(process.env, candidates);
	try {
		expect(f.store.nodeHealthGating()).toMatchObject({ enabled: false });
		expect(track(new FleetStore(f.path)).nodeHealthGating()).toMatchObject({ enabled: false });
		expect(track(new NodeHealthHistory(f.path, {}, { readOnly: true })).selectionGating()).toMatchObject({ enabled: false });
		const nodeHealth = forbiddenAccess();
		const placed = await submitPlacement(new Fleet(f.store), { ...f.input, key: "in-process" }, headroom(["A"], 10), { nodeHealth });
		expect(placed.task.nodeId).toBe("A");
		expect("health" in placed).toBe(false);
		expect(nodeHealth.calls).toEqual([]);
	} finally {
		for (const key of Object.keys(candidates)) if (!(key in saved)) delete process.env[key];
	}
	const resources = join(f.dir, "resources.json");
	writeFileSync(resources, JSON.stringify(Object.fromEntries([...headroom(["A"], 10).samples].map(([id, s]) => [id, { ...s, at: Date.now() }]))));
	const submit = async (key: string, env: Record<string, string>) => {
		const taskFile = join(f.dir, key + ".json");
		writeFileSync(taskFile, JSON.stringify({ ...f.input, key }));
		const child = Bun.spawn([process.execPath, cliPath, "--db", f.path, "--resources", resources, "submit", taskFile], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
		const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return { exit, output: JSON.parse(stdout) };
	};
	const plain = await submit("plain", {});
	const withEnv = await submit("with-env", candidates);
	for (const run of [plain, withEnv]) {
		expect(run.exit).toBe(0);
		expect(run.output.nodeId).toBe("A");
		expect(run.output.placement).not.toHaveProperty("nodeHealth");
	}
	expect(withEnv.output.phase).toBe(plain.output.phase);
	expect(withEnv.output.placement.selection).toEqual(plain.output.placement.selection);
	expect(withEnv.output.placement.nodes).toEqual(plain.output.placement.nodes);
	expect(selectionAudit(f.store, withEnv.output.id).exclusions).toEqual(selectionAudit(f.store, plain.output.id).exclusions);
	expect(f.store.events(withEnv.output.id).some(e => e.kind === "node_health_warning")).toBe(false);
	expect(f.store.nodeHealthGating()).toMatchObject({ enabled: false });
}, 60_000);

test("ui --read-only shows node health from a read-only view and never probes or records", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	// Re-specified in r5 (review 09e80a06 F1): health is shown only while the switch is on, so it is on here.
	h.setSelectionGating(true, approval);
	const before = h.observations("A");
	const readOnlyStore = track(new FleetStore(f.path, 2, { readOnly: true }));
	const view = track(new NodeHealthHistory(f.path, {}, { readOnly: true }));
	expect(() => view.record("A", good)).toThrow("READ_ONLY");
	expect(() => view.setSelectionGating(true, approval)).toThrow("READ_ONLY");
	const timer = manualHealthTimer();
	let server: ReturnType<typeof startDashboardServer> | undefined;
	try {
		server = startDashboardServer(readOnlyStore, 0, "127.0.0.1", { healthHistory: view });
		const state: any = await (await fetch(`http://127.0.0.1:${server.port}/api/state`)).json();
		expect(state.nodes.find((node: any) => node.id === "A").health).toMatchObject({ gating: "enforce", stable: true });
		// Read-only startup and the live API request must not arm a health producer.
		expect(timer.delays()).toEqual([]);
		expect(await timer.tick()).toEqual({ ran: 0, pending: [] });
	} finally {
		try { server?.stop(true); } finally { timer.restore(); }
	}
	expect(h.observations("A")).toEqual(before);
	// A database without node-health tables reads as empty and stays untouched.
	const g = await fleetFixture();
	const empty = track(new NodeHealthHistory(g.path, {}, { readOnly: true }));
	expect(empty.dimensions("A").failingDimensions).toEqual(["no_history"]);
	expect(empty.selectionGating()).toEqual({ enabled: false });
	const raw = new Database(g.path, { readonly: true });
	try { expect(raw.query("SELECT name FROM sqlite_master WHERE name LIKE 'node_health%'").all()).toEqual([]); } finally { raw.close(); }
}, 60_000);

test("F1: a read-only view opened before any node-health table exists follows the tables another connection creates later", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const view = track(new NodeHealthHistory(f.path, {}, { readOnly: true }));
	expect(view.selectionGating()).toEqual({ enabled: false });
	expect(view.dimensions("A").failingDimensions).toEqual(["no_history"]);
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	h.setSelectionGating(true, approval);
	expect(view.selectionGating()).toMatchObject({ enabled: true, operator: approval.operator, reason: approval.reason });
	expect(view.dimensions("A")).toMatchObject({ stable: true });
	expect(view.dimensions("A").failingDimensions).not.toContain("no_history");
	expect(view.observations("A")).toEqual(h.observations("A"));
	expect(() => view.record("A", good)).toThrow("READ_ONLY");
	// Gating switched off again elsewhere is seen too.
	h.setSelectionGating(false, approval);
	expect(view.selectionGating()).toMatchObject({ enabled: false });
});

test("F1: the ui --read-only dashboard started before any node-health table exists shows gating and history changed by another process", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const readOnlyStore = track(new FleetStore(f.path, 2, { readOnly: true }));
	const view = track(new NodeHealthHistory(f.path, {}, { readOnly: true }));
	const before: any = getDashboardState(readOnlyStore, undefined, new Map(), undefined, view);
	// Re-specified in r5 (review 09e80a06 F1): switch off (no table yet) shows no node health at all.
	expect(before).not.toHaveProperty("nodeHealth");
	expect(before.nodes.find((node: any) => node.id === "A")).not.toHaveProperty("health");
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	const approvalFile = join(f.dir, "approval.json");
	writeFileSync(approvalFile, JSON.stringify({ operator: "ops", reason: "enabled elsewhere" }));
	const enabled = await runCli(f.path, "node-health", "gating", "on", approvalFile);
	expect(enabled.exit).toBe(0);
	const after: any = getDashboardState(readOnlyStore, undefined, new Map(), undefined, view);
	expect(after.nodeHealth).toMatchObject({ gating: "enforce", operator: "ops", reason: "enabled elsewhere" });
	expect(after.nodes.find((node: any) => node.id === "A").health).toMatchObject({ gating: "enforce", stable: true, failingDimensions: [] });
}, 60_000);
