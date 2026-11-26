import type { DashboardTask, NodeProbe, NodeResources } from "./dashboard";
import type { HealthObservation } from "./node-health";
import type { FleetStore } from "./store";

export type DashboardNodeStatus = {
	level: "healthy" | "degraded" | "down" | "unknown";
	reasons: Array<"coordinator_unreachable" | "sdk_probe_failed" | "broker_session_list_failed" | "resource_sample_failed" | "no_fresh_control_observation">;
};
export type DashboardTasksAtRisk = { count: number; taskIds: string[] };
export type DashboardOverall = {
	state: "normal" | "degraded" | "critical" | "unknown";
	reasons: Array<"node_paths_down" | "node_paths_degraded" | "node_status_unknown" | "hub_lease_expired">;
	/** Nonterminal Fleet task sessions freshly observed working on unimpaired nodes. Not a reservation count. */
	confirmedRunning: number;
};
export type DashboardHubLease = {
	state: "held" | "expiring" | "expired" | "absent";
	expiresAt: string | null;
	lastCycleAt: string | null;
};
export type DashboardHealthFreshness = {
	state: "fresh" | "stale" | "none";
	checkedAt: string | null;
};

function wallTime(value: unknown): number | undefined {
	const at = typeof value === "string" ? Date.parse(value) : value;
	return typeof at === "number" && Number.isFinite(at) && at > 0 && at <= 8.64e15 ? at : undefined;
}
function fresh(at: number | undefined, now: number, maxAge: number): boolean {
	return at !== undefined && at <= now && now - at <= maxAge;
}
const iso = (at: number | undefined) => at === undefined ? null : new Date(at).toISOString();

/** Presentation age only. Never feed wall clock freshness back into health or admission decisions. */
export function dashboardHealthFreshness(observations: readonly (number | undefined)[], now: number, maxAge: number): DashboardHealthFreshness {
	let oldest: number | undefined;
	let missing = observations.length === 0;
	for (const at of observations) {
		const stamp = wallTime(at);
		if (stamp === undefined || stamp > now) { missing = true; continue; }
		oldest = Math.min(oldest ?? stamp, stamp);
	}
	if (oldest !== undefined && !fresh(oldest, now, maxAge)) return { state: "stale", checkedAt: iso(oldest) };
	if (missing) return { state: "none", checkedAt: null };
	return { state: "fresh", checkedAt: iso(oldest) };
}

/** Only the observed lease row; an absent row is not an outage and held does not mean a live process. */
export function dashboardHubLease(daemon: ReturnType<FleetStore["daemonStatus"]>, now: number): DashboardHubLease {
	const expires = wallTime(daemon?.leaseExpiresAt);
	if (!daemon || expires === undefined) return { state: "absent", expiresAt: null, lastCycleAt: null };
	const data = daemon.status && typeof daemon.status === "object" && !Array.isArray(daemon.status) ? daemon.status : undefined;
	const ttl = data?.leaseMs;
	const expiring = typeof ttl === "number" && Number.isSafeInteger(ttl) && ttl >= 1_000 && ttl <= 600_000 && expires - now <= ttl / 4;
	const lastCycleAt = wallTime(data?.lastCycleAt);
	return {
		state: expires <= now ? "expired" : expiring ? "expiring" : "held",
		expiresAt: iso(expires),
		lastCycleAt: iso(lastCycleAt !== undefined && lastCycleAt <= now ? lastCycleAt : undefined),
	};
}

type Task = Pick<DashboardTask, "id" | "held" | "phase" | "nodeId" | "sessionId" | "turnId" | "executionTerminal">;
type Freshness = { now: number; controlMs: number; resourceMs: number; heartbeatMs: number };
type Condition = { status: DashboardNodeStatus; tasksAtRisk: DashboardTasksAtRisk; workingTaskIds: string[] };
const settled = new Set<Task["phase"]>(["queued", "succeeded", "failed", "cancelled", "archived"]);

/** A down observation path is not proof the host died. No registered status flag or reservation is evidence. */
export function dashboardNodeCondition(
	nodeId: string,
	tasks: readonly Task[],
	probe: NodeProbe | null,
	resources: NodeResources | null,
	health: HealthObservation | undefined,
	{ now, controlMs, resourceMs, heartbeatMs }: Freshness,
): Condition {
	const probeAt = wallTime(probe?.checkedAt);
	const checked = probe?.nodeId === nodeId && probe.probed === true && fresh(probeAt, now, controlMs) ? probe : undefined;
	const healthAt = wallTime(health?.at);
	const observed = fresh(healthAt, now, controlMs) ? health : undefined;
	const sample = fresh(wallTime(resources?.sampledAt), now, resourceMs) ? resources : undefined;
	// Prefer newer observed results of the same Broker path. A skipped or unguarded list is not a result.
	const list = checked?.ok === true ? checked.sessionsOk : undefined;
	const broker = typeof list === "boolean" &&
		(!observed || typeof observed.brokerSessionListOk !== "boolean" || probeAt! >= healthAt!)
		? list : observed?.brokerSessionListOk;
	const coordinatorDown = observed?.reachable === false;
	const sdkDown = checked?.ok === false;
	const brokerDown = broker === false;
	const controlDown = coordinatorDown || sdkDown || brokerDown;
	// Cached GJC version metadata (no elapsed time on this probe) is not a response.
	const sdkOk = checked?.ok === true && typeof checked.elapsedMs === "number" && Number.isFinite(checked.elapsedMs) && checked.elapsedMs >= 0;
	const controlOk = observed?.reachable === true || broker === true || sdkOk;

	const reasons: DashboardNodeStatus["reasons"] = [];
	if (coordinatorDown) reasons.push("coordinator_unreachable");
	if (sdkDown) reasons.push("sdk_probe_failed");
	if (brokerDown) reasons.push("broker_session_list_failed");
	// "refused" may mean unsupported/unconfigured; a delay or an old re-recorded failure proves nothing.
	if (sample?.ok === false && sample.error === "resource_stream_disconnected") reasons.push("resource_sample_failed");
	const level: DashboardNodeStatus["level"] = reasons.length
		? controlDown && !controlOk && sample?.ok !== true ? "down" : "degraded"
		: controlOk ? "healthy" : "unknown";
	if (level === "unknown") reasons.push("no_fresh_control_observation");

	const started = tasks.filter((task) => task.nodeId === nodeId && task.held && !task.executionTerminal &&
		!settled.has(task.phase) && task.sessionId && task.turnId);
	const workingSessions = new Set(
		list === true && !brokerDown ? checked?.sessions?.filter((session) =>
			session.live === true && session.state === "working" && fresh(wallTime(session.lastHeartbeatAt), now, heartbeatMs),
		).map((session) => session.sessionId) : undefined,
	);
	const workingTaskIds = started.filter((task) => workingSessions.has(task.sessionId!)).map((task) => task.id);
	const atRisk = controlDown ? started.filter((task) => !workingSessions.has(task.sessionId!)).map((task) => task.id) : [];
	return { status: { level, reasons }, tasksAtRisk: { count: atRisk.length, taskIds: atRisk }, workingTaskIds };
}

export function dashboardOverall(conditions: readonly Condition[], lease: DashboardHubLease): DashboardOverall {
	const reasons: DashboardOverall["reasons"] = [];
	if (conditions.some((node) => node.status.level === "down")) reasons.push("node_paths_down");
	if (conditions.some((node) => node.status.level === "degraded")) reasons.push("node_paths_degraded");
	if (!conditions.length || conditions.some((node) => node.status.level === "unknown")) reasons.push("node_status_unknown");
	if (lease.state === "expired") reasons.push("hub_lease_expired");
	const state = conditions.length && conditions.every((node) => node.status.level === "down") ? "critical"
		: reasons.some((reason) => reason !== "node_status_unknown") ? "degraded"
			: reasons.length ? "unknown" : "normal";
	// A degraded headline can say "still running" only for verified activity on a different, healthy node.
	const confirmedRunning = new Set(conditions.flatMap((node) => node.status.level === "healthy" ? node.workingTaskIds : [])).size;
	return { state, reasons, confirmedRunning };
}
