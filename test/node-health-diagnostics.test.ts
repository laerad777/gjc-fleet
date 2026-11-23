// Interaction of the node-health gate with main's failure-diagnostics rule (integration lane a13d72f5).
//
// Rule on main: every place where an error becomes unknown / blocked / refused records a deny-by-default
// failureDiagnostic, enforced at run time by test/diagnostic-guard.ts. This file runs the node-health code
// paths that can meet an error (switch-on decisions, the gate's own fail-closed path, the store-side
// exclusion validation, the ui producer and bootstrap) under that same guard, for the whole file:
// - a conversion reached through a node-health path (Store.transaction refusal, Fleet.start node refusal)
//   is recorded by main's existing site with the same converting event and diagnostic as with the switch off;
// - the node-health sites themselves never write a converting event (they are N rows of
//   docs/failure-diagnostics.md: placement exclusions, health observations, pre-transaction argument checks).
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FleetError } from "../src/core";
import { Fleet } from "../src/fleet";
import { reconsiderQueue, submitPlacement } from "../src/index";
import { bootstrapNodeHealth, observeNodeHealth } from "../src/node-health-gate";
import { runTask } from "../src/operator-commands";
import { reservePlacement } from "../src/placement-preflight";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { type DiagnosticGuard, installDiagnosticGuard } from "./diagnostic-guard";
import { access, approval, cleanup, clocked, fleetFixture, forbiddenAccess, makeStable, selectionAudit } from "./fixtures/node-health";

let guard: DiagnosticGuard;
beforeAll(() => {
	guard = installDiagnosticGuard(FleetStore);
});
afterAll(() => {
	guard.uninstall();
	expect(guard.allViolations).toEqual([]);
	// The file really drove converting events through the guard (not a vacuous pass).
	expect(guard.checked.events).toBeGreaterThan(0);
});
afterEach(cleanup);

const converting = () => guard.take();
/** Fresh fixtures differ only in generated ids and in digests of their own repository (base commit). */
const ids = (value: unknown) =>
	JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>").replace(/\b[0-9a-f]{64}\b/g, "<h64>").replace(/\b[0-9a-f]{40}\b/g, "<h40>"));

/** One fleet with nodes A and B, the switch on, and both nodes stable for the history's own writer. */
async function switchedOn(stable: boolean) {
	const f = await fleetFixture("fleet-nh-diag-");
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B"));
	const { h, clock } = clocked(f.path, Date.now());
	if (stable) makeStable(h, clock, ["A", "B"]);
	clock.now += 30_000;
	h.setSelectionGating(true, approval);
	return { f, h, clock };
}
async function switchedOff() {
	const f = await fleetFixture("fleet-nh-diag-");
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B"));
	return { f };
}

test("switch on, unusable history: the gate fails closed without a converting event; pinned dispatch keeps its warning", async () => {
	const { f } = await switchedOn(true);
	const broken = { history: () => { throw new Error("history_unusable"); } };
	const fleet = new Fleet(f.store);
	converting();
	const auto = await submitPlacement(fleet, f.input, headroom(["A", "B"], 10), { nodeHealth: broken });
	expect(auto.task.phase).toBe("queued");
	expect(auto.task.reason).toBe("no_eligible_node");
	expect(selectionAudit(f.store, auto.task.id).exclusions).toEqual([
		{ nodeId: "A", reasons: ["node_unstable", "node_health_unavailable"] },
		{ nodeId: "B", reasons: ["node_unstable", "node_health_unavailable"] },
	]);
	// A placement exclusion (as main's readiness codes), not an unknown/blocked/refused record.
	expect(converting()).toEqual({ events: [], violations: [] });
	expect(f.store.reasonDiagnostic(auto.task.id)).toBeUndefined();
	const pinned = await submitPlacement(fleet, { ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "A" } }, headroom(["A"], 10), { nodeHealth: broken });
	expect(pinned.task.nodeId).toBe("A");
	expect(f.store.events(pinned.task.id).find((e) => e.kind === "node_health_warning")!.data).toMatchObject({ nodeId: "A", failingDimensions: ["node_health_unavailable"] });
	expect(converting()).toEqual({ events: [], violations: [] });
	// No health access at all (a caller that never supplied one): the same fail-closed outcome.
	const none = await submitPlacement(fleet, { ...f.input, key: "no-access" }, headroom(["A", "B"], 10));
	expect(none.task.phase).toBe("queued");
	expect(converting()).toEqual({ events: [], violations: [] });
}, 120_000);

test("a Store.transaction refusal inside a gated reservation records the same refused event and diagnostic as with the switch off", async () => {
	const results: unknown[] = [];
	for (const on of [false, true]) {
		const ctx = on ? await switchedOn(true) : await switchedOff();
		const f = ctx.f;
		const task = f.store.submit({ ...f.input, key: "rollback" });
		f.store.enterRollback();
		converting();
		const nodeHealth = on ? access((ctx as any).h, headroom(["A", "B"], 10)) : forbiddenAccess();
		const rows = () => (on ? (ctx as any).h.observations("A").length + (ctx as any).h.observations("B").length : 0);
		const probed = rows();
		const caught = await reservePlacement(f.store, task.id, headroom(["A", "B"], 10), { nodeHealth }).catch((error) => error);
		// Switch on: the gate really ran (one decision probe recorded per node) before the store refused.
		if (on) expect(rows()).toBe(probed + 2);
		expect(caught).toBeInstanceOf(FleetError);
		expect((caught as FleetError).code).toBe("DISPATCH_DISABLED");
		const seen = converting();
		expect(seen.violations).toEqual([]);
		const refused = f.store.events(task.id).filter((e) => e.kind === "refused").map((e) => e.data);
		results.push({ code: (caught as FleetError).code, events: seen.events, refused });
		if (!on) expect((nodeHealth as any).calls).toEqual([]);
	}
	expect(ids(results[0])).toEqual(ids(results[1]));
	expect((results[1] as any).events).toEqual([expect.objectContaining({ event: "refused", source: "Store.transaction", phase: "record", errorClass: "FleetError" })]);
}, 120_000);

test("a node refusal reached through a gated operator run and queue reconsider is recorded by Fleet.start exactly as with the switch off", async () => {
	const runs: unknown[] = [];
	for (const on of [false, true]) {
		const ctx = on ? await switchedOn(true) : await switchedOff();
		const f = ctx.f;
		const fleet = new Fleet(f.store);
		const nodeHealth = () => (on ? access((ctx as any).h, headroom(["A", "B"], 10)) : forbiddenAccess());
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		const rows = () => (on ? (ctx as any).h.observations("A").length + (ctx as any).h.observations("B").length : 0);
		const probed = rows();
		converting();
		const run = await runTask(fleet, { ...f.input, key: "run" }, { sample: async () => headroom(["A", "B"], 10).samples, leaseMs: 5_000, nodeHealth: nodeHealth() }).catch((error) => error);
		const runSeen = converting();
		// A queued task taken by reconsider meets the same refusal inside Fleet.start.
		const queued = f.store.submit({ ...f.input, key: "queued" });
		if (on) (ctx as any).clock.now += 30_000;
		const reconsidered = await reconsiderQueue(fleet, async () => headroom(["A", "B"], 10).samples, { nodeHealth: nodeHealth(), limit: 4 });
		const reconsiderSeen = converting();
		// Switch on: both decisions went through the gate (decision probes recorded for A and B each time).
		if (on) expect(rows()).toBe(probed + 4);
		expect(runSeen.violations).toEqual([]);
		expect(reconsiderSeen.violations).toEqual([]);
		runs.push({
			run: run instanceof Error ? (run as FleetError).code : (run as any).code,
			runEvents: runSeen.events,
			reconsidered: reconsidered.map((t) => [t.input.key, t.phase, !!t.held]),
			queuedPhase: f.store.task(queued.id)!.phase,
			reconsiderEvents: reconsiderSeen.events,
		});
	}
	expect(ids(runs[0])).toEqual(ids(runs[1]));
	const off = runs[0] as any;
	expect(off.run).toBe("node_refused:root_denied:allowlist");
	expect(off.runEvents).toEqual([expect.objectContaining({ event: "node_operation_failure", source: "Fleet.start.prepare", phase: "call" })]);
	expect(off.reconsiderEvents).toEqual([expect.objectContaining({ event: "node_operation_failure", source: "Fleet.start.prepare", phase: "call" })]);
}, 180_000);

test("the store-side exclusion/warning checks reject malformed gate input before any transaction: nothing persisted, no conversion (N row)", async () => {
	const { f } = await switchedOff();
	const task = f.store.submit({ ...f.input, key: "invalid" });
	const before = f.store.events(task.id).length;
	converting();
	for (const resources of [
		{ ...headroom(["A"], 10), exclusions: [{ nodeId: "A", reasons: [] }] },
		{ ...headroom(["A"], 10), exclusions: [{ nodeId: "A", reasons: ["x"] }, { nodeId: "A", reasons: ["y"] }] },
		{ ...headroom(["A"], 10), healthWarning: { nodeId: "A", failingDimensions: "x" as any } },
	]) {
		let caught: unknown;
		try {
			f.store.reserve(task.id, resources);
		} catch (error) {
			caught = error;
		}
		expect((caught as FleetError).code).toBe("INVALID_INPUT");
	}
	expect(f.store.events(task.id)).toHaveLength(before);
	expect(f.store.task(task.id)!.phase).toBe("queued");
	expect(converting()).toEqual({ events: [], violations: [] });
}, 60_000);

test("producer and bootstrap probe failures are health observations only: no audit row, no conversion", async () => {
	const f = await fleetFixture("fleet-nh-diag-");
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B", { transport: { command: "/usr/bin/false", args: [] }, broker: "fail" }));
	const { h } = clocked(f.path, Date.now());
	const audit = () => {
		const db = new Database(f.path, { readonly: true });
		try {
			return (db.query("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n;
		} finally {
			db.close();
		}
	};
	const before = audit();
	converting();
	const observed = await observeNodeHealth(f.store.nodes(), h, { timeoutMs: 5_000 });
	expect(observed.find((row) => row.nodeId === "B")!.observation).toMatchObject({ reachable: false, brokerSessionListOk: false });
	const [boot] = await bootstrapNodeHealth([f.store.nodes().find((node) => node.id === "B")!], h, { reason: "diag test", wait: async () => undefined });
	expect(boot!.outcome).toBe("failed");
	expect(h.dimensions("B").stable).toBe(false);
	expect(audit()).toBe(before);
	expect(converting()).toEqual({ events: [], violations: [] });
}, 60_000);
