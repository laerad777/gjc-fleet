export { FleetStore } from "./store";
import { Fleet } from "./fleet";
import type { TaskInput } from "./contracts";
import type { AdmissionPolicy, ResourceSample } from "./admission";
import { digest, FleetError, reconsiderCandidates } from "./core";
import { preflightPlacement, type PreflightOptions } from "./placement-preflight";
import { reconsiderEnforced, submitEnforced } from "./node-health-gate";
import { inputOptions, isRoleTask, workUnitState } from "./work-unit";

/** Public asynchronous admission: readiness never substitutes for resource reservation. */
export async function submitPlacement(
	fleet: Fleet,
	input: TaskInput,
	resources: { samples: ReadonlyMap<string, ResourceSample>; policy?: AdmissionPolicy },
	options: PreflightOptions = {},
) {
	// Switch on: node-health enforcement. Off (default): the unchanged pre-feature body below.
	if (fleet.store.nodeHealthGating?.().enabled) return submitEnforced(fleet, input, resources, options);
	const store = fleet.store;
	const report = await preflightPlacement(input, store.nodes(), store.taskStates(), {
		...resources, held: store.heldCharges(), now: Date.now(),
	}, { ...options, ...inputOptions(store, input) });
	if (digest(input) !== report.inputDigest ||
		digest(Object.fromEntries(store.nodes().map(node => [node.id, digest(node)]))) !== digest(report.nodeDigests))
		throw new Error("placement_changed_during_preflight");
	const ready = new Set(report.nodes.filter(node => node.ready).map(node => node.nodeId));
	const samples = new Map([...resources.samples].filter(([id]) => ready.has(id)));
	return { report, task: fleet.submit(input, { samples, policy: resources.policy }) };
}
export { preflightPlacement, probePlacementSource, reservePlacement } from "./placement-preflight";
/** A bounded snapshot pass. Fresh samples and readiness are checked again for each candidate. */
export async function reconsiderQueue(
	fleet: Fleet,
	sample: () => Promise<ReadonlyMap<string, ResourceSample>>,
	options: PreflightOptions & { limit?: number } = {},
) {
	// Lane progress of running tasks (one read-only command per node, durably rate-limited per task). Detection
	// only: it never observes a task (settle false), is never part of the admission decision, and runs after
	// the node-health gated pass as well. A failed progress pass never fails the reconsider pass.
	const refreshProgress = async () => {
		try {
			await fleet.refreshProgress(undefined, { settle: false });
		} catch {
			// Display only.
		}
	};
	if (fleet.store.nodeHealthGating?.().enabled) {
		const gated = await reconsiderEnforced(fleet, sample, options);
		await refreshProgress();
		return gated;
	}
	const limit = options.limit ?? 10;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("queue_limit_1_to_100");
	const store = fleet.store;
	// Metadata only (M2): a damaged or large result of another task never stops or slows admission.
	// Unplaceable tasks never take the slots of waiting ones but are still re-checked (core.reconsiderCandidates);
	// the ones this pass skips below are never re-checked, so they cannot hold the re-check slots.
	const candidates = reconsiderCandidates(store.taskStates(), limit, (task) => isRoleTask(task) && workUnitState(store) !== "on");
	const results = [];
	for (const candidate of candidates) {
		// A role task while the work-unit switch is not on stays queued and is reported; it never blocks the pass.
		if (isRoleTask(candidate) && workUnitState(store) !== "on") {
			results.push(store.task(candidate.id)!);
			continue;
		}
		const samples = await sample();
		const report = await preflightPlacement(candidate.input, store.nodes(), store.taskStates(), {
			samples, held: store.heldCharges(), now: Date.now(),
		}, { ...options, ...inputOptions(store, candidate.input) });
		if (digest(Object.fromEntries(store.nodes().map(node => [node.id, digest(node)]))) !== digest(report.nodeDigests))
			throw new Error("placement_changed_during_preflight");
		const ready = new Set(report.nodes.filter(node => node.ready).map(node => node.nodeId));
		const task = store.reserveQueued(candidate.id, { samples: new Map([...samples].filter(([id]) => ready.has(id))) });
		if (!task) continue;
		let result = task;
		if (task.attemptId) {
			try {
				result = await fleet.start(task.id);
			} catch (error) {
				// A proven before_send preparation refusal, or a node that stopped being admissible between
				// reservation and send, keeps this attempt held (nothing sent); report it with the tasks
				// already started in this pass and stop, as for blocked_unknown.
				if (!(error instanceof FleetError && (error.code.startsWith("node_refused:") || error.code === "NODE_NOT_ADMISSIBLE"))) throw error;
				results.push(store.task(task.id)!);
				break;
			}
		}
		results.push(result);
		if (result.phase === "blocked_unknown") break;
		// A definite create refusal (settled failed, released) likely repeats on that node: stop the pass so the
		// other candidates stay queued, as for blocked_unknown, instead of burning each one on the same refusal.
		if (result.phase === "failed" && (result.result?.evidence as Record<string, unknown> | undefined)?.createRefusal !== undefined) break;
	}
	await refreshProgress();
	return results;
}
export type { PreflightOptions, PlacementReport, NodeReadiness, ReadinessCheck, PlacementStore, ReservationResources } from "./placement-preflight";
export { bootstrapNodeHealth, gatingPreview, observeNodeHealth, reconsiderEnforced, reserveEnforced, resourceObservation, submitEnforced } from "./node-health-gate";
export type { BootstrapOptions, BootstrapOutcome, HealthGateDecision, HealthOutcome, HealthProbeOptions, NodeHealthAccess, ResourceEvidence } from "./node-health-gate";
export { NodeHealthHistory, defaultHealthPolicy, healthPolicy, healthPolicyBounds, goodObservation, stepHealth, evaluateHealth, bootstrapPlan, WARNING_CAPACITY, TOMBSTONE_CAPACITY, ANCHOR_CAPACITY, BOOTSTRAP_PROBE_ALLOWANCE_MS, REMOVED_NODES_ROLLUP, NODE_HEALTH_TABLE, GATING_AUDIT_CAPACITY } from "./node-health";
export type { HealthProbe, HealthObservation, HealthPolicy, NodeHealth, HealthDecision, HealthHistoryOptions, NodeHealthState, Anchor, ProbeInput, CountedBy, RecordResult, StepResult } from "./node-health";
export type { ReserveResources } from "./store";
export { ClawhipControl, controlBinding, validateControlCommand, clawhipControlCli } from "./clawhip-control";
export type { ControlBinding, ControlCommand, ControlPolicy, ControlExecutor, ControlReceipt } from "./clawhip-control";
export { Fleet, validateResult, exportReviewDigest, DISPOSE_BATCH_LIMIT } from "./fleet";
export type { DisposeResult, DisposeBatchItem } from "./fleet";
export { exportResult, EXPORT_RECORD } from "./result-export";
export type { ExportOptions, ExportRecord, ExportSummary, ExportedFile } from "./result-export";
export {
	classifyReport,
	DeliverableUnavailable,
	deliverableViews,
	disableWorkUnits,
	enableWorkUnits,
	recordDeliverable,
	ROLE_PROMPT_INSTRUCTION,
	ROLE_REPORT_PATH,
	workUnitState,
	workUnitStatus,
} from "./work-unit";
export type { DeliverableRecord, DeliverableView, WorkUnitSwitchState } from "./work-unit";
export { SDK_UI_APPROVAL_CONTRACT } from "./approval";
export { SdkUiApprovalBackend } from "./sdk-ui";
export type {
	SdkUiAttachment,
	SdkUiDispatchContext,
	SdkUiRouter,
	SdkUiRouterOptions,
	SdkUiApprovalOptions,
} from "./sdk-ui";
export { getDashboardState, renderDashboardHtml, startDashboardServer } from "./dashboard";
export type {
	ApprovalContract,
	ApprovalSessionContext,
	NativeUiQuestionAuthority,
	NativeWorkflowQuestion,
	ApprovalConsumption,
	ApprovalDiscovery,
	ApprovalAnswerDispatch,
	TaskApprovalChannel,
	TaskApprovalBackend,
	FleetOptions,
} from "./approval";
export {
	FleetError,
	canonicalJson,
	DEFAULT_NODE_RPC_TIMEOUT_MS,
	digest,
	NODE_RPC_TIMEOUT_MAX_MS,
	NODE_RPC_TIMEOUT_MIN_MS,
	nodeRpcTimeoutMs,
	observationDigest,
	selectNode,
	SUBJECT_PATH_MAX_BYTES,
	subjectNodeId,
	validateNode,
	validateTaskInput,
} from "./core";
export { assertSubject, SUBJECT_REVIEWS_SHOWN, subjectLinks } from "./subject";
export { nodeRpc, StdioRpc, TransportError } from "./rpc";
export {
	discoverOrdinary,
	answerOrdinary,
	ordinaryContractEvidence,
} from "./ordinary";
export type {
	OrdinaryBinding,
	OrdinaryCandidate,
	OrdinaryDiscovery,
	OrdinaryTransport,
} from "./ordinary";
export {
	previewInput,
	authorizeInput,
	validateInputPackage,
	importRepository,
	applyInput,
} from "./inputs";
export type { InputPackage } from "./inputs";
export {
	prepareWorkspace,
	collectResult,
	testWorkspace,
	safeRelative,
	excluded,
	readOwnedFile,
} from "./workspace";
export type * from "./contracts";
export type {
	WorkspaceIdentity,
	ResultManifest,
	TestEvidence,
} from "./workspace";
