import type { NodeConfig, TaskInput, TaskRecord } from "./contracts";
import { DEFAULT_ADMISSION_POLICY, type AdmissionPolicy, type ResourceSample } from "./admission";
import { digest, FleetError, reconsiderCandidates, selectNode, subjectNodeId, validateNode } from "./core";
import { BOOTSTRAP_PROBE_ALLOWANCE_MS, bootstrapPlan, goodObservation, type HealthDecision, type HealthObservation, type NodeHealthHistory, type RecordResult } from "./node-health";
import { coordinatorProbe, preflightPlacement, type PlacementReport, type PlacementStore, type PreflightOptions, type ReservationResources } from "./placement-preflight";
import { brokerSessionListObservable, probeBrokerSessionList, sshSerialized } from "./dashboard";
import { diagnosticErrorClass, type DiagnosticErrorClass } from "./diagnostic";
import type { Fleet } from "./fleet";
import { inputOptions, isRoleTask, workUnitState } from "./work-unit";

/**
 * Node health in scheduling, behind the operator switch stored in the fleet DB (`node_health_gating`,
 * read by `FleetStore.nodeHealthGating()` once per decision, before anything else).
 *
 * Switch OFF (default, no row): `submitPlacement`, `reservePlacement`, `reconsiderQueue` and
 * `runTask` run their unchanged pre-feature bodies. Nothing in this module runs: no history is
 * opened, no probe is sent, nothing is recorded, no lock is taken. History is produced only by the
 * `ui` hub producer (`observeNodeHealth`) and by an explicit `node-health bootstrap`.
 *
 * Switch ON: the functions below. Each decision first probes every hard-eligible node (Coordinator
 * tools/list, then the guarded Broker session list), THEN takes fresh resource samples (stamped on
 * receipt), records one observation per probed node, runs the unchanged preflight on those fresh
 * samples, and excludes automatic candidates that are not stable. A health error never aborts the
 * decision: it fails closed (`node_health_unavailable`: automatic candidates excluded, pinned
 * dispatch onto a ready node still reserved with a warning).
 */

/** What a caller supplies so a decision can run when the stored switch is on. */
export interface NodeHealthAccess {
	/** The writable history on the fleet DB; called only when the switch is on. */
	history: () => NodeHealthHistory;
	/**
	 * Fresh hub samples measured after the decision probes; `stamp` must be called on receipt of each
	 * sample (resource success evidence). Without it the caller's samples are used for admission and
	 * are never health success evidence (a failed one still counts as a failure).
	 */
	sample?: (stamp: (nodeId: string, sample: ResourceSample) => void) => Promise<ReadonlyMap<string, ResourceSample>>;
}
export interface HealthGateDecision { nodeId: string; pinned: boolean; allowed: boolean; failingDimensions: string[] }
/** How node health took part in one decision made with the switch on (shown as `placement.nodeHealth`). */
export interface HealthOutcome {
	mode: "enforce";
	/** One decision per node that passed the pre-feature readiness checks. */
	decisions: HealthGateDecision[];
	/** Set when the history could not be used; the decision then failed closed. */
	error?: HealthFailure;
	/** Set when the bounded sidecar copy of a committed pinned warning failed. */
	healthWarningMirrorError?: HealthFailure;
}
/** Where a health failure happened; Fleet-defined identifiers only. */
export type HealthFailureStage = "access" | "history_open" | "history_retain" | "decision_probe" | "record" | "admit" | "mirror";
/**
 * A health failure as reported in `placement.nodeHealth` (never stored). Deny-by-default like main's
 * failure diagnostics: a fixed code, the Fleet-defined stage and the error class found by the same
 * trap-free prototype-chain walk (`diagnosticErrorClass`). No message or other text from the error.
 */
export interface HealthFailure {
	code: "node_health_access_required" | "node_health_unavailable" | "node_health_mirror_failed";
	stage: HealthFailureStage;
	errorClass: DiagnosticErrorClass;
}

/** A resource sample stamped with the receiving process's monotonic clock (`NodeHealthHistory.stampSample`). */
export interface ResourceEvidence { sample: ResourceSample; mono: number }
/**
 * Hub sample as health evidence; reads no wall clock. Any failed sample (stamped or not, any age) is a
 * failure: it can only delay. Success needs monotonic-stamped evidence whose age by the history's own
 * monotonic clock is within `maxSampleAgeMs`; anything else is unobserved. Busy is success.
 */
export function resourceObservation(history: NodeHealthHistory, evidence: ResourceEvidence | undefined, sample: ResourceSample | undefined, policy: AdmissionPolicy = DEFAULT_ADMISSION_POLICY): boolean | null {
	if ((evidence?.sample && !evidence.sample.ok) || (sample && !sample.ok)) return false;
	if (!evidence?.sample) return null;
	const age = history.monotonicNow() - evidence.mono;
	return Number.isFinite(age) && age >= 0 && age <= policy.maxSampleAgeMs ? true : null;
}

/**
 * Coordinator tools/list, then the guarded Broker session list: one login per host at a time. The
 * Coordinator session waits in the same per-destination SSH queue as the Broker probe and every other
 * dashboard SSH call of this process, so it never overlaps another login to that host (review 5d0d5336
 * L1). The latency is that of the probe itself, not of the wait in the queue.
 */
async function probeReach(node: NodeConfig, timeoutMs: number) {
	const { check, latencyMs } = await sshSerialized([node.transport.command, ...node.transport.args], async () => {
		const started = performance.now();
		const check = await coordinatorProbe(node, timeoutMs);
		return { check, latencyMs: Math.round(performance.now() - started) };
	});
	const broker = await probeBrokerSessionList(node, timeoutMs);
	return { reachable: check.code !== "coordinator_unavailable", latencyMs, broker };
}
function validTimeout(timeoutMs: number) {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("invalid_preflight_timeout");
	return timeoutMs;
}
function record(history: NodeHealthHistory, nodeId: string, reach: { reachable: boolean; latencyMs: number; broker: boolean | null }, resource: boolean | null): { observation: HealthObservation; record: RecordResult } {
	const values = { reachable: reach.reachable, brokerSessionListOk: reach.broker, resourceSampleOk: resource, latencyMs: reach.latencyMs };
	// The store stamps the row with its own wall time (display only); report what was recorded.
	const result = history.record(nodeId, values);
	return { observation: { at: result.at, ...values }, record: result };
}
const failure = (code: HealthFailure["code"], stage: HealthFailureStage, error: unknown): HealthFailure => ({ code, stage, errorClass: diagnosticErrorClass(error) });

export interface HealthProbeOptions {
	/** Wall-stamped hub samples: a failed one is a failure; they are never success evidence. */
	samples?: ReadonlyMap<string, ResourceSample>;
	/** Success evidence: samples stamped by `history.stampSample` when this process received them (busy is success). */
	resourceEvidence?: (nodeId: string) => ResourceEvidence | undefined;
	resourcePolicy?: AdmissionPolicy;
	timeoutMs?: number;
}
/**
 * Periodic producer for the `ui` hub (never on a scheduling path): one real Coordinator tools/list
 * and one guarded Broker session-list probe per enabled registered node, recorded into the history.
 * No session, prompt, model call or autostart.
 */
export async function observeNodeHealth(nodes: NodeConfig[], history: NodeHealthHistory, options: HealthProbeOptions = {}) {
	for (const node of nodes) validateNode(node);
	const timeoutMs = validTimeout(options.timeoutMs ?? 10_000);
	return Promise.all(nodes.filter(node => node.enabled).map(async node => {
		const reach = await probeReach(node, timeoutMs);
		const resource = resourceObservation(history, options.resourceEvidence?.(node.id), options.samples?.get(node.id), options.resourcePolicy);
		return { nodeId: node.id, observation: record(history, node.id, reach, resource).observation };
	}));
}

export interface BootstrapOptions {
	/** Operator-supplied justification persisted in the bootstrap audit row. */
	reason: string;
	resourcePolicy?: AdmissionPolicy;
	timeoutMs?: number;
	/** Takes a fresh hub sample during each probe; the bootstrapping process stamps it on return (its
	 * wall `at` is not read). Without it the resource dimension stays unobserved, so bootstrap alone cannot reach `stable`. */
	sampleResources?: (node: NodeConfig) => Promise<ResourceSample | undefined>;
	/** Receives the planned pause in ms; it is only called when the pause and the next probe fit before the deadline. */
	wait?: (ms: number) => Promise<void>;
}
export type BootstrapOutcome = "stable" | "failed" | "unstable" | "deadline_exceeded" | "skipped_stable" | "skipped_not_enabled";
/**
 * Explicit, audited, time-bounded bootstrap for any node that is not currently stable (a fresh or
 * upgraded database, a node recovering from a failure, a deployment without a long-lived producer).
 * It does not relax policy: it takes real probes from this one process, `spacingMs` apart, through
 * the ordinary `record()`, stops at the first failed probe and as soon as the node is `stable`.
 *
 * The plan and its hard deadline come from `bootstrapPlan` and are independent of `timeoutMs`:
 * defaults 4 probes / 130 s, or 6 probes / 210 s when recovering from a failure. Each probe timeout
 * is at most the allowance; a pause or probe that cannot finish before the deadline is not started.
 * Every completed probe is recorded (a late failure still resets). The run is bounded by this
 * process's monotonic clock only. A stable node is skipped (`skipped_stable`).
 */
export async function bootstrapNodeHealth(nodes: NodeConfig[], history: NodeHealthHistory, options: BootstrapOptions) {
	for (const node of nodes) validateNode(node);
	const timeoutMs = Math.min(validTimeout(options.timeoutMs ?? BOOTSTRAP_PROBE_ALLOWANCE_MS), BOOTSTRAP_PROBE_ALLOWANCE_MS);
	const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
	return Promise.all(nodes.map(async node => {
		if (!node.enabled || node.draining) return { nodeId: node.id, outcome: "skipped_not_enabled" as BootstrapOutcome, observations: 0 };
		const { interval, probes, budgetMs: budget } = bootstrapPlan(history.policy, history.dimensions(node.id).required > history.policy.consecutive);
		let audit: number;
		try { audit = history.beginBootstrap(node.id, options.reason, budget); }
		catch (error) {
			if (error instanceof Error && error.message === "node_health_stable") return { nodeId: node.id, outcome: "skipped_stable" as BootstrapOutcome, observations: 0 };
			throw error;
		}
		const start = history.monotonicNow();
		const remaining = () => budget - (history.monotonicNow() - start);
		let observations = 0;
		let outcome: BootstrapOutcome = "failed";
		try {
			for (let i = 0; i < probes; i++) {
				if (i > 0) {
					if (remaining() - timeoutMs < interval) { outcome = "deadline_exceeded"; break; }
					await wait(interval);
				}
				if (remaining() < timeoutMs) { outcome = "deadline_exceeded"; break; }
				const [reach, evidence] = await Promise.all([
					probeReach(node, timeoutMs),
					options.sampleResources ? options.sampleResources(node).then(sample => sample ? history.stampSample(sample) : undefined) : undefined,
				]);
				const { observation } = record(history, node.id, reach, resourceObservation(history, evidence, undefined, options.resourcePolicy));
				observations++;
				history.bootstrapProgress(audit, observations);
				if (!goodObservation(observation)) { outcome = "failed"; break; }
				outcome = history.dimensions(node.id).stable ? "stable" : "unstable";
				if (outcome === "stable") break;
			}
		} finally { history.finishBootstrap(audit, outcome, observations); }
		return { nodeId: node.id, outcome, observations };
	}));
}

/**
 * What switching gating on would do right now, per enabled non-draining node. `neverObservable`
 * names dimensions this node's configuration can never observe (no guarded sdkTransport: no Broker
 * session list), so such a node can never become stable and would stay excluded from automatic
 * selection while the switch is on.
 */
export function gatingPreview(nodes: NodeConfig[], history: NodeHealthHistory) {
	const rows = nodes.filter(node => node.enabled && !node.draining).map(node => {
		const health = history.dimensions(node.id);
		const neverObservable = brokerSessionListObservable(node) ? [] : ["brokerSessionListOk"];
		return { nodeId: node.id, stable: health.stable, wouldBeExcluded: !health.stable, failingDimensions: health.failingDimensions, consecutiveGood: health.consecutiveGood, required: health.required, neverObservable };
	});
	return { nodes: rows, stable: rows.filter(row => row.stable).length, wouldBeExcluded: rows.filter(row => !row.stable).map(row => row.nodeId), allExcluded: rows.length > 0 && rows.every(row => !row.stable) };
}

interface Probed { records: Map<string, RecordResult>; samples: ReadonlyMap<string, ResourceSample>; error?: HealthFailure; history?: NodeHealthHistory }
/**
 * The decision probes, then fresh samples: the probe time never ages the samples admission judges.
 * Health failures are caught (fail closed by the gate); only sampling errors propagate, as on main.
 */
async function probeForDecision(store: Pick<PlacementStore, "nodes" | "taskStates">, input: TaskInput, access: NodeHealthAccess | undefined, fallback: () => Promise<ReadonlyMap<string, ResourceSample>> | ReadonlyMap<string, ResourceSample>, policy: AdmissionPolicy | undefined, timeoutMs: number): Promise<Probed> {
	const records = new Map<string, RecordResult>();
	if (!access) return { records, samples: await fallback(), error: { code: "node_health_access_required", stage: "access", errorClass: "none" } };
	let history: NodeHealthHistory | undefined;
	let error: HealthFailure | undefined;
	let stage: HealthFailureStage = "history_open";
	// Exactly the nodes the preflight probes: hard-eligible for this input (a pin probes only its node).
	const states = store.taskStates();
	const nodes = store.nodes().filter(node => !(selectNode(input, [node], states, undefined, subjectNodeId(input, states)).exclusions[0]?.reasons.length));
	let reach: Awaited<ReturnType<typeof probeReach>>[] = [];
	try {
		history = access.history();
		stage = "history_retain";
		history.retainNodes(store.nodes().map(node => node.id));
		stage = "decision_probe";
		reach = await Promise.all(nodes.map(node => probeReach(node, timeoutMs)));
	} catch (caught) { error = failure("node_health_unavailable", stage, caught); }
	const evidence = new Map<string, ResourceEvidence>();
	const samples = access.sample ? await access.sample((nodeId, sample) => { if (history && !error) evidence.set(nodeId, history.stampSample(sample)); }) : await fallback();
	if (history && !error) {
		try {
			nodes.forEach((node, i) => records.set(node.id, record(history!, node.id, reach[i]!, resourceObservation(history!, evidence.get(node.id), samples.get(node.id), policy)).record));
		} catch (caught) { error = failure("node_health_unavailable", "record", caught); }
	}
	return { records, samples, error, history };
}

/**
 * Enforcement over an unchanged preflight report: unstable ready nodes are excluded with durable
 * `node_unstable` reasons, the selection is recomputed over the admitted nodes, and the store receives
 * the preflight and health exclusions with their exact reasons. A pinned ready node is always admitted;
 * when it is not stable the store records a `node_health_warning` in the reservation transaction.
 */
function enforce(input: TaskInput, report: PlacementReport, store: Pick<PlacementStore, "nodes" | "taskStates" | "heldCharges">, resources: { samples: ReadonlyMap<string, ResourceSample>; policy?: AdmissionPolicy }, probed: Probed) {
	const readyIds = new Set(report.nodes.filter(node => node.ready).map(node => node.nodeId));
	const decisions: HealthGateDecision[] = [];
	const admitted = new Map<string, Pick<HealthDecision, "allowed" | "warning"> & { failingDimensions: string[] }>();
	let error = probed.error;
	for (const row of report.nodes) {
		if (!row.ready) continue;
		const pinned = input.required.nodeId === row.nodeId;
		let decision: Pick<HealthDecision, "allowed" | "warning"> & { failingDimensions: string[] };
		const unavailable = { allowed: pinned, warning: pinned, failingDimensions: ["node_health_unavailable"] };
		if (error || !probed.history) {
			error ??= { code: "node_health_unavailable", stage: "history_open", errorClass: "none" };
			decision = unavailable;
		} else {
			try {
				const admit = probed.history.admit(row.nodeId, pinned, probed.records.get(row.nodeId));
				decision = { allowed: admit.allowed, warning: admit.warning, failingDimensions: admit.health.failingDimensions };
			} catch (caught) {
				error = failure("node_health_unavailable", "admit", caught);
				decision = unavailable;
			}
		}
		admitted.set(row.nodeId, decision);
		decisions.push({ nodeId: row.nodeId, pinned, allowed: decision.allowed, failingDimensions: decision.failingDimensions });
	}
	let healthWarning: { nodeId: string; failingDimensions: string[] } | undefined;
	// Durable reasons for every node the preflight or the health gate excluded.
	const excluded = new Map<string, string[]>();
	for (const row of report.nodes) {
		if (!row.ready) { excluded.set(row.nodeId, Object.entries(row.checks).filter(([, check]) => !check.ok).map(([stage, check]) => stage + ":" + check.code)); continue; }
		const decision = admitted.get(row.nodeId)!;
		if (decision.warning) healthWarning = { nodeId: row.nodeId, failingDimensions: decision.failingDimensions };
		if (!decision.allowed) {
			readyIds.delete(row.nodeId);
			row.ready = false;
			const reasons = ["node_unstable", ...decision.failingDimensions];
			excluded.set(row.nodeId, reasons);
			report.selection.exclusions.push({ nodeId: row.nodeId, reasons });
			if (report.selection.nodeId === row.nodeId) report.selection.nodeId = undefined;
		}
	}
	const exclusions = report.selection.exclusions;
	const states = store.taskStates();
	report.selection = selectNode(input, store.nodes().filter(node => readyIds.has(node.id)), states, { ...resources, held: store.heldCharges(), now: Date.now() }, subjectNodeId(input, states));
	report.selection.exclusions.push(...exclusions);
	const reservation: ReservationResources = {
		samples: new Map([...resources.samples].filter(([nodeId]) => readyIds.has(nodeId))),
		policy: resources.policy,
		exclusions: [...excluded].map(([nodeId, reasons]) => ({ nodeId, reasons })),
		...(healthWarning ? { healthWarning } : {}),
	};
	return { reservation, healthWarning, outcome: { mode: "enforce" as const, decisions, ...(error ? { error } : {}) } };
}

/**
 * The store recorded the warning atomically with the reservation; the history keeps a bounded
 * sidecar copy for the dashboard. A failed copy does not undo or hide the committed reservation.
 */
function mirror(history: NodeHealthHistory | undefined, warning: { nodeId: string; failingDimensions: string[] } | undefined, reserved: TaskRecord | undefined): HealthFailure | undefined {
	if (!history || !warning || !reserved || reserved.nodeId !== warning.nodeId || !reserved.attemptId) return undefined;
	try { history.auditPinnedAdmission(reserved.id, warning.nodeId, warning.failingDimensions); }
	catch (error) { return failure("node_health_mirror_failed", "mirror", error); }
	return undefined;
}
const withMirror = (outcome: HealthOutcome, error: HealthFailure | undefined): HealthOutcome => error ? { ...outcome, healthWarningMirrorError: error } : outcome;
const nodeDigests = (store: Pick<PlacementStore, "nodes">) => digest(Object.fromEntries(store.nodes().map(node => [node.id, digest(node)])));

/** `submitPlacement` with the switch on. */
export async function submitEnforced(fleet: Fleet, input: TaskInput, resources: { samples: ReadonlyMap<string, ResourceSample>; policy?: AdmissionPolicy }, options: PreflightOptions = {}) {
	const store = fleet.store;
	const probed = await probeForDecision(store, input, options.nodeHealth, () => resources.samples, resources.policy, validTimeout(options.timeoutMs ?? 10_000));
	const fresh = { samples: probed.samples, policy: resources.policy };
	const report = await preflightPlacement(input, store.nodes(), store.taskStates(), { ...fresh, held: store.heldCharges(), now: Date.now() }, { ...options, ...inputOptions(store, input) });
	if (digest(input) !== report.inputDigest || nodeDigests(store) !== digest(report.nodeDigests)) throw new Error("placement_changed_during_preflight");
	const gate = enforce(input, report, store, fresh, probed);
	const task = fleet.submit(input, gate.reservation);
	return { report, task, health: withMirror(gate.outcome, mirror(probed.history, gate.healthWarning, task)) };
}

/** `reservePlacement` with the switch on. */
export async function reserveEnforced(store: PlacementStore, id: string, resources: { samples: ReadonlyMap<string, ResourceSample>; policy?: AdmissionPolicy }, options: PreflightOptions = {}) {
	const task = store.task(id);
	if (!task) throw new Error("task_not_found");
	if (task.attemptId) throw new Error("placement_already_reserved");
	const probed = await probeForDecision(store, task.input, options.nodeHealth, () => resources.samples, resources.policy, validTimeout(options.timeoutMs ?? 10_000));
	const fresh = { samples: probed.samples, policy: resources.policy };
	const report = await preflightPlacement(task.input, store.nodes(), store.taskStates(), { ...fresh, held: store.heldCharges(), now: Date.now() }, { ...options, ...inputOptions(store, task.input) });
	if (digest(store.task(id)?.input) !== report.inputDigest || nodeDigests(store) !== digest(report.nodeDigests)) throw new Error("placement_changed_during_preflight");
	const gate = enforce(task.input, report, store, fresh, probed);
	const reserved = store.reserve(id, gate.reservation);
	return { report, task: reserved, health: withMirror(gate.outcome, mirror(probed.history, gate.healthWarning, reserved)) };
}

/** `reconsiderQueue` with the switch on: the same pass, each candidate through the same gate. */
export async function reconsiderEnforced(fleet: Fleet, sample: () => Promise<ReadonlyMap<string, ResourceSample>>, options: PreflightOptions & { limit?: number } = {}) {
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("queue_limit_1_to_100");
	const timeoutMs = validTimeout(options.timeoutMs ?? 10_000);
	const store = fleet.store;
	const candidates = reconsiderCandidates(store.taskStates(), limit, (task) => isRoleTask(task) && workUnitState(store) !== "on");
	const results = [];
	for (const candidate of candidates) {
		// Same rule as the ungated pass: a role task while the work-unit switch is not on stays queued and is reported.
		if (isRoleTask(candidate) && workUnitState(store) !== "on") {
			results.push(store.task(candidate.id)!);
			continue;
		}
		const probed = await probeForDecision(store, candidate.input, options.nodeHealth, sample, undefined, timeoutMs);
		const report = await preflightPlacement(candidate.input, store.nodes(), store.taskStates(), {
			samples: probed.samples, held: store.heldCharges(), now: Date.now(),
		}, { ...options, ...inputOptions(store, candidate.input) });
		if (nodeDigests(store) !== digest(report.nodeDigests)) throw new Error("placement_changed_during_preflight");
		const gate = enforce(candidate.input, report, store, { samples: probed.samples }, probed);
		const { policy: _policy, ...queued } = gate.reservation;
		const task = store.reserveQueued(candidate.id, queued);
		if (!task) continue;
		mirror(probed.history, gate.healthWarning, task);
		let result = task;
		if (task.attemptId) {
			try {
				result = await fleet.start(task.id);
			} catch (error) {
				// As on main: a proven before_send preparation refusal keeps this attempt held and retained.
				if (!(error instanceof FleetError && error.code.startsWith("node_refused:"))) throw error;
				results.push(store.task(task.id)!);
				break;
			}
		}
		results.push(result);
		if (result.phase === "blocked_unknown") break;
	}
	return results;
}
