// Switch-on placement tests of the node-health feature. These were added to
// test/placement-preflight.test.ts by the earlier port; that main test file is now unmodified (its
// tests run the switch-off path exactly as on main) and these run here, against the stored switch.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { NodeHealthHistory } from "../src/node-health";
import { bootstrapNodeHealth, observeNodeHealth } from "../src/node-health-gate";
import { reservePlacement } from "../src/placement-preflight";
import { headroom } from "./admission-fixture";
import { access, approval, brokerList, cleanup, fleetFixture, good, track } from "./fixtures/node-health";

afterEach(cleanup);

test("dispatch stability excludes a flapping host and audits an explicit pin", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("sandbox"));
	const history = track(new NodeHealthHistory(f.path));
	history.setSelectionGating(true, approval);
	for (const reachable of [true, false, true]) history.record("sandbox", { ...good, reachable });
	const automatic = f.store.submit(f.input);
	const excluded = await reservePlacement(f.store, automatic.id, headroom(["sandbox"], 10), { nodeHealth: access(history) });
	expect(excluded.task.attemptId).toBeUndefined();
	expect(excluded.report.selection.nodeId).toBeUndefined();
	expect(excluded.report.selection.exclusions.some(row => row.reasons.includes("node_unstable") && row.reasons.includes("reachable"))).toBe(true);
	const pinned = f.store.submit({ ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "sandbox" } });
	// A pinned attempt that ordinary resource admission rejects is not an audited dispatch.
	const refused = await reservePlacement(f.store, pinned.id, { samples: new Map() }, { nodeHealth: access(history) });
	expect(refused.task.attemptId).toBeUndefined();
	expect(history.warnings()).toHaveLength(0);
	const admitted = await reservePlacement(f.store, pinned.id, headroom(["sandbox"], 10), { nodeHealth: access(history) });
	expect(admitted.task.nodeId).toBe("sandbox");
	expect(history.warnings()).toEqual([expect.objectContaining({ task: pinned.id, node: "sandbox" })]);
	expect(JSON.parse((history.warnings()[0] as any).dimensions)).toContain("reachable");
}, 60_000);

test("fresh history reaches stable through the decision probes of normal reservations; observations are real", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("NODEG"));
	const clock = { now: Date.now() };
	const history = track(new NodeHealthHistory(f.path, {}, { clock: () => clock.now, monotonic: () => clock.now }));
	history.setSelectionGating(true, approval);
	expect(history.hasHistory("NODEG")).toBe(false);
	const task = f.store.submit(f.input);
	const outcomes: (string | undefined)[] = [];
	for (let i = 0; i < 3; i++) {
		if (i) clock.now += 30_000;
		const result = await reservePlacement(f.store, task.id, headroom(["NODEG"], 10), { nodeHealth: access(history, headroom(["NODEG"], 10)) });
		expect(history.observations("NODEG").at(-1)).toEqual({ at: clock.now, reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: expect.any(Number) });
		outcomes.push(result.task.nodeId);
		if (!result.task.nodeId) expect(result.report.selection.exclusions.some(row => row.reasons.includes("node_unstable") && row.reasons.includes("consecutive_observations"))).toBe(true);
	}
	expect(outcomes).toEqual([undefined, undefined, "NODEG"]);
	expect(history.observations("NODEG")).toHaveLength(3);
	expect(history.warnings()).toHaveLength(0);
}, 60_000);

test("explicit bootstrap is audited, time-bounded and uses the ordinary policy on real probes", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("NODEG"));
	const clock = { now: Date.now() };
	const history = track(new NodeHealthHistory(f.path, {}, { clock: () => clock.now, monotonic: () => clock.now }));
	const waits: number[] = [];
	const started = clock.now;
	const result = await bootstrapNodeHealth(f.store.nodes(), history, { reason: "new node NODEG enrolled by operator", sampleResources: async node => headroom([node.id], 10).samples.get(node.id), wait: async ms => { waits.push(ms); clock.now += ms; } });
	expect(result).toEqual([{ nodeId: "NODEG", outcome: "stable", observations: 3 }]);
	expect(waits).toEqual([30_000, 30_000]);
	expect(history.bootstraps("NODEG")).toEqual([expect.objectContaining({ reason: "new node NODEG enrolled by operator", started_at: started, deadline_at: started + 130_000, finished_at: started + 60_000, outcome: "stable", observations: 3 })]);
	expect(await bootstrapNodeHealth(f.store.nodes(), history, { reason: "again", wait: async () => {} })).toEqual([{ nodeId: "NODEG", outcome: "skipped_stable", observations: 0 }]);
	// Bootstrapped, then switched on: the next automatic decision selects the node.
	history.setSelectionGating(true, approval);
	const task = f.store.submit(f.input);
	const reserved = await reservePlacement(f.store, task.id, headroom(["NODEG"], 10), { nodeHealth: access(history) });
	expect(reserved.task.nodeId).toBe("NODEG");
	expect(history.warnings()).toHaveLength(0);
}, 60_000);

test("bootstrap stops at the first failed probe and cannot launder an unreachable node", async () => {
	const f = await fleetFixture();
	const down = await f.node("DOWN", { transport: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
	const clock = { now: Date.now() };
	const history = track(new NodeHealthHistory(":memory:", {}, { clock: () => clock.now, monotonic: () => clock.now }));
	let waited = 0;
	const result = await bootstrapNodeHealth([down], history, { reason: "operator bootstrap", timeoutMs: 1000, wait: async ms => { waited += ms; clock.now += ms; } });
	expect(result).toEqual([{ nodeId: "DOWN", outcome: "failed", observations: 1 }]);
	expect(waited).toBe(0);
	expect(history.dimensions("DOWN").failingDimensions).toContain("reachable");
	expect(history.bootstraps("DOWN")).toEqual([expect.objectContaining({ outcome: "failed", observations: 1 })]);
	// An unstable node may bootstrap again (audited); a still-down node just fails again.
	const again = await bootstrapNodeHealth([down], history, { reason: "retry", timeoutMs: 1000, wait: async ms => { waited += ms; clock.now += ms; } });
	expect(again).toEqual([{ nodeId: "DOWN", outcome: "failed", observations: 1 }]);
	expect(history.bootstraps("DOWN")).toHaveLength(2);
	const disabled = await bootstrapNodeHealth([{ ...down, id: "OFF", enabled: false }], history, { reason: "operator bootstrap" });
	expect(disabled).toEqual([{ nodeId: "OFF", outcome: "skipped_not_enabled", observations: 0 }]);
	expect(history.hasHistory("OFF")).toBe(false);
}, 60_000);

test("busy is not unstable; a failed Broker list is an exact failing dimension", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("BUSY"));
	f.store.putNode(await f.node("NOBROKER", { broker: "fail" }));
	const skew = { ms: 0 };
	const history = track(new NodeHealthHistory(f.path, {}, { clock: () => Date.now() + skew.ms, monotonic: () => performance.now() + skew.ms }));
	for (const offset of [-60_000, -30_000, -1_000]) { skew.ms = offset; for (const id of ["BUSY", "NOBROKER"]) history.record(id, good); }
	skew.ms = 0;
	history.setSelectionGating(true, approval);
	const admission = headroom(["BUSY", "NOBROKER"], 10);
	admission.samples.get("BUSY")!.cpuPct = 99;
	const task = f.store.submit(f.input);
	const placed = await reservePlacement(f.store, task.id, admission, { nodeHealth: access(history, admission) });
	expect(placed.report.nodes.find(row => row.nodeId === "BUSY")!.checks.resources.code).toBe("cpu_busy");
	expect(history.observations("BUSY").at(-1)).toMatchObject({ reachable: true, brokerSessionListOk: true, resourceSampleOk: true });
	expect(history.dimensions("BUSY").stable).toBe(true);
	expect(history.observations("NOBROKER").at(-1)).toMatchObject({ reachable: true, brokerSessionListOk: false });
	expect(history.dimensions("NOBROKER").failingDimensions).toEqual(["brokerSessionListOk", "consecutive_observations"]);
	expect(history.dimensions("NOBROKER").unobserved).toEqual(["reachable", "brokerSessionListOk", "resourceSampleOk"]);
	// The busy node is still not selected (resource admission), the failed-Broker node is excluded as unstable.
	expect(placed.task.attemptId).toBeUndefined();
	expect(placed.report.selection.exclusions).toContainEqual({ nodeId: "NOBROKER", reasons: ["node_unstable", "brokerSessionListOk", "consecutive_observations"] });
	const off = await f.node("OFF");
	const periodic = await observeNodeHealth([...f.store.nodes(), { ...off, enabled: false }], history, { samples: admission.samples });
	expect(periodic.map(row => [row.nodeId, row.observation.brokerSessionListOk])).toEqual([["BUSY", true], ["NOBROKER", false]]);
	expect(history.hasHistory("OFF")).toBe(false);
}, 60_000);

test("an unreachable Coordinator is recorded as a reachability failure of a probed node", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("NODEG", { transport: { command: process.execPath, args: ["-e", "process.exit(1)"] } }));
	const history = track(new NodeHealthHistory(f.path));
	history.setSelectionGating(true, approval);
	const task = f.store.submit(f.input);
	const placed = await reservePlacement(f.store, task.id, headroom(["NODEG"], 10), { timeoutMs: 1000, nodeHealth: access(history, headroom(["NODEG"], 10)) });
	expect(history.observations("NODEG").at(-1)).toMatchObject({ reachable: false, brokerSessionListOk: true, resourceSampleOk: true });
	expect(history.dimensions("NODEG").failingDimensions).toContain("reachable");
	// Not ready by the unchanged readiness checks already; the health failure is recorded as well.
	expect(placed.report.nodes[0]!.checks.coordinator.code).toBe("coordinator_unavailable");
	expect(placed.task.attemptId).toBeUndefined();
}, 60_000);

test("a sleeping Broker list times out as a failure of the decision probe, bounded by the preflight timeout", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("SLOW", { broker: "ok,slow=60000" }));
	const history = track(new NodeHealthHistory(f.path));
	history.setSelectionGating(true, approval);
	const started = performance.now();
	const task = f.store.submit(f.input);
	await reservePlacement(f.store, task.id, headroom(["SLOW"], 10), { timeoutMs: 1000, nodeHealth: access(history, headroom(["SLOW"], 10)) });
	expect(performance.now() - started).toBeLessThan(15_000);
	expect(history.observations("SLOW").at(-1)).toMatchObject({ reachable: true, brokerSessionListOk: false });
	expect(brokerList).toContain("broker-list");
}, 60_000);
