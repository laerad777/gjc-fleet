import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDashboardState, startDashboardServer, type DashboardState, type NodeProbe } from "../src/dashboard";
import { NodeHealthHistory } from "../src/node-health";
import { FleetStore } from "../src/store";
import { activeOn, node, reserveOn } from "./fixtures/daemon";
import { refuseHostGjc } from "./host-gjc-guard";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dash-status-"));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	return {
		path, store, node: (id: string) => node(id, dir),
		close() { store.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); },
	};
}

function observation(nodeId: string, at: number, patch: Partial<NodeProbe> = {}): NodeProbe {
	return { nodeId, checkedAt: new Date(at).toISOString(), probed: true, ok: true, ...patch };
}

test("degraded requires an observed path failure; still running requires another freshly observed associated working session", () => {
	const f = fixture();
	try {
		f.store.putNode(f.node("gone"));
		f.store.putNode(f.node("other"));
		const atRisk = activeOn(f.store, "gone", "at-risk");
		const onlyReserved = reserveOn(f.store, "gone", "only-reserved");
		const working = activeOn(f.store, "other", "working");
		const waiting = activeOn(f.store, "other", "waiting");
		const unrecordedTurn = reserveOn(f.store, "other", "no-turn");
		f.store.recordSession(unrecordedTurn.id, "unrecorded-turn", true);
		const oldHeartbeat = activeOn(f.store, "other", "old-heartbeat");
		// Registry claims are not observations, neither positively nor negatively.
		f.store.putNode({ ...f.node("other"), reachable: false, sdkReady: false, modelReady: false });
		const now = Date.now();
		const probes = new Map([
			["gone", observation("gone", now, { ok: false, error: "internal verbose error" })],
			["other", observation("other", now, {
				sessionsOk: true,
				sessions: [
					{ sessionId: `session-${working}`, live: true, state: "working", lastHeartbeatAt: now },
					{ sessionId: `session-${waiting}`, live: true, state: "waiting_answer", lastHeartbeatAt: now },
					{ sessionId: `session-${oldHeartbeat}`, live: true, state: "working", lastHeartbeatAt: now - 121_000 },
					{ sessionId: "unrecorded-turn", live: true, state: "working", lastHeartbeatAt: now },
					{ sessionId: "unrelated-live-session", live: true, state: "working", lastHeartbeatAt: now },
				],
			})],
		]);
		const state = getDashboardState(f.store, undefined, probes);
		expect(state.nodes.find((n) => n.id === "gone")).toMatchObject({
			status: { level: "down", reasons: ["sdk_probe_failed"] },
			tasksAtRisk: { count: 1, taskIds: [atRisk] },
		});
		expect(state.nodes.find((n) => n.id === "other")).toMatchObject({ status: { level: "healthy", reasons: [] }, tasksAtRisk: { count: 0, taskIds: [] } });
		expect(state.summary.overall).toEqual({ state: "degraded", reasons: ["node_paths_down"], confirmedRunning: 1 });
		expect(f.store.task(atRisk)?.held).toBe(true);
		expect(f.store.task(onlyReserved.id)?.sessionId).toBeUndefined();

		// A successful OS sample is evidence of a responding path, not proof the SDK is reachable.
		const partial = getDashboardState(f.store, undefined, probes, (id) => id === "gone" ? { ok: true, sampledAt: now } : undefined);
		expect(partial.nodes.find((n) => n.id === "gone")).toMatchObject({
			status: { level: "degraded", reasons: ["sdk_probe_failed"] },
			tasksAtRisk: { count: 1, taskIds: [atRisk] },
		});
		// Even a working session ID is not confirmation for a task on a different node.
		const freshOther = probes.get("other")!;
		probes.set("other", { ...freshOther, sessions: [
			{ sessionId: `session-${atRisk}`, live: true, state: "working", lastHeartbeatAt: now },
		] });
		expect(getDashboardState(f.store, undefined, probes).summary.overall?.confirmedRunning).toBe(0);
		// The winning session must be freshly listed, not only have a heartbeat in a stale listing.
		probes.set("other", { ...freshOther, checkedAt: new Date(now - 61_000).toISOString() });
		expect(getDashboardState(f.store, undefined, probes).summary.overall?.confirmedRunning).toBe(0);
		probes.set("other", observation("other", now, { ok: false }));
		expect(getDashboardState(f.store, undefined, probes).summary.overall).toEqual({ state: "critical", reasons: ["node_paths_down"], confirmedRunning: 0 });
	} finally { f.close(); }
});

test("missing, stale, unsupported and cached-only telemetry do not prove an outage or a healthy control path", () => {
	const f = fixture();
	try {
		for (const id of ["stale", "future", "cache", "unsupported", "missing"]) f.store.putNode(f.node(id));
		const now = Date.now();
		const probes = new Map([
			["stale", observation("stale", now - 61_000, { ok: false })],
			["future", observation("future", now + 60_000, { ok: false })],
			["cache", observation("cache", now, { version: "cached", sessionsOk: undefined })],
			["unsupported", observation("unsupported", now, { ok: false, probed: false })],
		]);
		const state = getDashboardState(f.store, undefined, probes, (id) => {
			if (id === "stale") return { ok: false, sampledAt: now - 13_000, error: "resource_stream_disconnected" };
			if (id === "unsupported") return { ok: false, sampledAt: now, error: "resource_stream_refused" };
			if (id === "cache") return { ok: true, sampledAt: now };
			return undefined;
		});
		expect(state.summary.overall).toEqual({ state: "unknown", reasons: ["node_status_unknown"], confirmedRunning: 0 });
		expect(state.nodes.every((n) => n.status?.level === "unknown" && n.tasksAtRisk?.count === 0)).toBe(true);
		const resourceOnly = getDashboardState(f.store, undefined, probes, (id) =>
			id === "missing" ? { ok: false, sampledAt: now, error: "resource_stream_disconnected" } : undefined);
		expect(resourceOnly.nodes.find((n) => n.id === "missing")?.status).toEqual({ level: "degraded", reasons: ["resource_sample_failed"] });
		expect(resourceOnly.nodes.find((n) => n.id === "missing")?.tasksAtRisk?.count).toBe(0);
	} finally { f.close(); }
});

test("a fresher failed Broker list invalidates a cached working session; stale history is display-only", () => {
	const f = fixture();
	const now = Date.now();
	let at = now - 62_000;
	const history = new NodeHealthHistory(f.path, {}, { clock: () => at });
	try {
		for (const id of ["a", "b"]) f.store.putNode(f.node(id));
		const id = activeOn(f.store, "a", "work");
		const failed = { reachable: false, brokerSessionListOk: false, resourceSampleOk: false, latencyMs: 1 };
		const good = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
		history.setSelectionGating(true, { operator: "test", reason: "projection fixture" });
		history.record("a", failed);
		at = now - 10;
		history.record("b", good);
		const probes = new Map([["a", observation("a", now - 100, { sessionsOk: true, sessions: [
			{ sessionId: `session-${id}`, live: true, state: "working", lastHeartbeatAt: now },
		] })]]);
		const stale = getDashboardState(f.store, undefined, probes, undefined, history);
		expect(stale.health?.freshness).toEqual({ state: "stale", checkedAt: new Date(now - 62_000).toISOString() });
		expect(stale.summary.overall).toEqual({ state: "normal", reasons: [], confirmedRunning: 1 });
		at = now;
		history.record("a", failed);
		const fresh = getDashboardState(f.store, undefined, probes, undefined, history);
		expect(fresh.health?.freshness).toEqual({ state: "fresh", checkedAt: new Date(now - 10).toISOString() });
		expect(fresh.nodes.find((n) => n.id === "a")).toMatchObject({
			status: { level: "down", reasons: ["coordinator_unreachable", "broker_session_list_failed"] },
			tasksAtRisk: { count: 1, taskIds: [id] },
		});
		expect(fresh.summary.overall?.confirmedRunning).toBe(0);
		// A second, responding path on the same node distinguishes partial impairment from a host outage.
		history.record("a", { ...failed, brokerSessionListOk: null });
		const partial = getDashboardState(f.store, undefined, probes, undefined, history);
		expect(partial.nodes.find((n) => n.id === "a")).toMatchObject({
			status: { level: "degraded", reasons: ["coordinator_unreachable"] },
			tasksAtRisk: { count: 0, taskIds: [] },
		});
		expect(partial.summary.overall?.confirmedRunning).toBe(0); // No working session on a different healthy node.
		history.setSelectionGating(false, { operator: "test", reason: "off" });
		expect(getDashboardState(f.store, undefined, probes, undefined, history).health).toBeUndefined();
	} finally { history.close(); f.close(); }
});

test("HTTP status shows only the recorded owner lease; absent does not mean failed", async () => {
	const f = fixture();
	const restoreGjc = refuseHostGjc();
	const server = startDashboardServer(f.store, 0, "127.0.0.1", { probeNodes: false });
	try {
		const snapshot = async () => {
			const response = await fetch(`http://127.0.0.1:${server.port}/api/state`);
			expect(response.status).toBe(200);
			return await response.json() as DashboardState;
		};
		expect((await snapshot()).hub?.lease).toEqual({ state: "absent", expiresAt: null, lastCycleAt: null });
		const now = Date.now();
		const holder = { owner: "fixture", host: "fixture", pid: 1, startedAt: new Date(now - 29_000).toISOString() };
		expect(f.store.claimDaemonLease(holder, 30_000, undefined, () => now - 26_000)).toBe(true);
		expect(f.store.renewDaemonLease("fixture", 30_000, { leaseMs: 30_000, lastCycleAt: new Date(now - 26_000).toISOString() }, () => now - 26_000)).toBe(true);
		expect((await snapshot()).hub?.lease).toEqual({ state: "expiring", expiresAt: new Date(now + 4_000).toISOString(), lastCycleAt: new Date(now - 26_000).toISOString() });
		expect(f.store.releaseDaemonLease("fixture")).toBe(true);
		expect(f.store.claimDaemonLease(holder, 30_000, undefined, () => now - 35_000)).toBe(true);
		const expired = await snapshot();
		expect(expired.hub?.lease).toEqual({ state: "expired", expiresAt: new Date(now - 5_000).toISOString(), lastCycleAt: null });
		expect(expired.summary.overall).toEqual({ state: "degraded", reasons: ["node_status_unknown", "hub_lease_expired"], confirmedRunning: 0 });
	} finally { server.stop(true); restoreGjc(); f.close(); }
});
