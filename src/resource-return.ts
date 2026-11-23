import { randomUUID } from "node:crypto";
import type { NodeConfig, OperationIntent, SessionAuthority, TaskRecord } from "./contracts";
import { canonicalJson, demand, digest, FleetError } from "./core";
import { conditionDiagnostic, type DiagnosticCondition, type DiagnosticStep, type FailureDiagnostic, failureDiagnostic } from "./diagnostic";
import { closeOwnedSession, listSession } from "./execution";
import { validateResult } from "./fleet";
import { TransportError } from "./rpc";
import { FleetStore, OPERATOR_RELEASE_STATEMENT, type OperatorReleaseListing } from "./store";
import type { WorkspaceIdentity } from "./workspace";

export interface ReturnConnection {
	/** Fresh, exact, unpaginated public session.list response, never a cached inventory. */
	list(sessionId: string): Promise<unknown>;
	/** Public broker session.close carrying the exact recorded endpointGeneration and
	 * endpointIncarnation plus ifIdle:true. Resolves the public response or rejects; a
	 * public refusal rejects with TransportError.publicResponse set. */
	fencedClose(authority: SessionAuthority, key: string): Promise<unknown>;
	close(): void;
}
/** "returned" only after a fresh listing showed the session gone. An operator release
 * without that observation is "released_by_operator_unconfirmed", never "returned". */
export type ReturnState = "returned" | "return_unknown" | "refused" | "node_busy" | "not_ours" | "session_busy" | "return_blocked_by_node" | "released_by_operator_unconfirmed";
export interface ReturnReport {
	taskId: string;
	state: ReturnState;
	reason?: string;
	/** Only on state "refused": the stable code of the eligibility precondition that failed
	 * (REFUSAL_CODES). `reason` keeps its earlier values unchanged for existing callers. */
	refusal?: RefusalCode;
}
/** Bounded number of idle-fenced close claims per attempt (only pre-effect refusals advance it). */
export const MAX_CLOSE_ATTEMPTS = 5;
const LEGACY_DIAGNOSTIC = "lifecycle_legacy_history_ambiguous";
/** operation_failed with unknown outcome and no diagnostics is indistinguishable from a
 * legacy refusal whose diagnostics were omitted; it blocks the node the same way. */
const SUSPECT_LEGACY_DIAGNOSTIC = "unclassified_operation_failed_possible_legacy_history";
const UNCONFIRMED = "released_by_operator_unconfirmed";

/** Only the public SDK CLI is used; the coordinator transport is never spawned. */
export async function connectResourceReturn(node: NodeConfig): Promise<ReturnConnection> {
	demand(node.sdkTransport, "SDK_TRANSPORT_REQUIRED", "Explicit SDK transport required");
	return {
		list: sessionId => listSession(node, sessionId),
		fencedClose: (authority, key) => closeOwnedSession(node, authority, key, { ifIdle: true }),
		close() {},
	};
}

/** Which eligibility check was running when it threw: classification of the refusal only. */
type EligibilityStage = { at: "load" | "settlement" | "custody" | "ownership" };
/** Custody (a validated collected manifest bound to the exact attempt) is required before any
 * close, for every attempt this path accepts: it requires a recorded turn (`turnId`) and a
 * terminal settlement, so a turn ran and the node may hold its uncollected work (a failed or
 * deadline-exceeded turn included). The only releases without custody are the cases proven to
 * have run no turn, and they are not on this path: `archive` (`never_started`, or a retained
 * before-send preparation refusal). */
function eligible(store: FleetStore, task: TaskRecord, stage: EligibilityStage = { at: "settlement" }): void {
	stage.at = "settlement";
	demand(task.result?.executionTerminal && task.attemptId && task.sessionId && task.turnId && task.workspace && task.nodeSnapshot, "RETURN_NOT_SETTLED", "Exact authoritative terminal attempt required");
	demand(task.resultManifest, "RETURN_CUSTODY_MISSING", "Collected result custody required before any close");
	stage.at = "custody";
	validateResult(task.workspace as unknown as WorkspaceIdentity, task.resultManifest);
	const identity = (task.resultManifest as any).identity;
	demand(identity.taskId === task.id && identity.attemptId === task.attemptId && identity.nodeId === task.nodeId && identity.inputDigest === task.inputDigest, "RETURN_CUSTODY_BINDING", "Collected bytes must belong to exact task attempt");
	stage.at = "ownership";
	demand(store.getOperation(task.id, "session-authority"), "RETURN_AUTHORITY_MISSING", "Original session authority required");
	store.cancellationOwnership(task.id);
	demand(!store.getOperation(task.id, "cancel"), "RETURN_CANCEL_PENDING", "Cancellation owns retirement");
}
/** Earlier report reasons, unchanged for existing callers. */
const refusalReasons: Record<string, string> = { RETURN_AUTHORITY_MISSING: "original_session_authority_missing", RETURN_CANCEL_PENDING: "cancellation_owns_retirement" };
/** Stable per-precondition refusal codes of the return report (`refusal`) and the stored refusal. */
export const REFUSAL_CODES = ["task_not_found", "not_settled", "custody_missing", "custody_invalid", "custody_binding_mismatch", "authority_missing", "ownership_missing", "cancel_pending", "unclassified"] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];
const PRECONDITION_CODES: Record<string, RefusalCode> = {
	TASK_NOT_FOUND: "task_not_found",
	RETURN_NOT_SETTLED: "not_settled",
	RETURN_CUSTODY_MISSING: "custody_missing",
	RETURN_CUSTODY_BINDING: "custody_binding_mismatch",
	RETURN_AUTHORITY_MISSING: "authority_missing",
	CANCEL_UNSUPPORTED: "ownership_missing",
	RETURN_CANCEL_PENDING: "cancel_pending",
};
/** Refusal code of an eligibility failure. Anything thrown while the collected manifest is being
 * validated (any RESULT_* or TEST_EVIDENCE code, an unsafe path, a malformed shape) is
 * `custody_invalid`, as is a damaged externalised manifest found while loading the task
 * (RESULT_INTEGRITY). Only a failure outside every precondition is `unclassified`. */
function refusalOf(error: unknown, stage: EligibilityStage): RefusalCode {
	const code = error instanceof FleetError ? error.code : "";
	const named = PRECONDITION_CODES[code];
	if (named) return named;
	if (stage.at === "custody") return "custody_invalid";
	if (stage.at === "load" && code === "RESULT_INTEGRITY") return "custody_invalid";
	return "unclassified";
}

function exactAuthority(store: FleetStore, task: TaskRecord): SessionAuthority {
	const value = store.getOperation(task.id, "session-authority")!.payload as any;
	return { sessionId: value.sessionId, cwd: value.cwd, endpointGeneration: value.endpointGeneration, endpointIncarnation: value.endpointIncarnation };
}

type Seen = { kind: "absent" | "terminal" | "live" | "unproven" | "foreign"; indexSeq: number };
/** A complete, unpaginated exact-session listing: its sequence and the session's row, if any. */
function fresh(value: any, sessionId: string): { indexSeq: number; row?: any } {
	const result = value?.result;
	demand(value?.type === "broker_response" && value.ok === true && Number.isSafeInteger(result?.indexSeq) && result.indexSeq >= 0 && Array.isArray(result.sessions) && result.sessions.length <= 1 && value.continuationCursor === undefined && result.continuationCursor === undefined, "RETURN_LIST_INVALID", "Complete exact-session listing required");
	if (result.sessions.length === 0) return { indexSeq: result.indexSeq };
	const row = result.sessions[0];
	demand(row?.sessionId === sessionId, "RETURN_LIST_INVALID", "Listing answered for another session");
	return { indexSeq: result.indexSeq, row };
}
/** absent, or the exact original incarnation with the authoritative terminal signal,
 * are the only proofs of return. live:false without terminal:true proves nothing. */
function observe(value: any, authority: SessionAuthority): Seen {
	const { indexSeq, row } = fresh(value, authority.sessionId);
	if (!row) return { kind: "absent", indexSeq };
	if (row.endpointGeneration !== authority.endpointGeneration || row.endpointIncarnation !== authority.endpointIncarnation) return { kind: "foreign", indexSeq };
	demand(row.locator?.cwd === authority.cwd && row.ambiguous === false && row.terminalUncertain === false && typeof row.live === "boolean" && typeof row.terminal === "boolean", "RETURN_AUTHORITY_CHANGED", "Exact unambiguous original session authority required");
	if (row.terminal === true && row.live === false) return { kind: "terminal", indexSeq };
	if (row.live === true && row.terminal === false) return { kind: "live", indexSeq };
	return { kind: "unproven", indexSeq };
}
const gone = (seen: Seen) => seen.kind === "absent" || seen.kind === "terminal";
const activityOf = (row: any): string | null => (typeof row?.activity?.state === "string" ? row.activity.state : null);
const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

/** The listing an operator release is decided on. A session the listing shows gone is
 * never released by an operator: return records it as returned instead. */
function releaseListing(value: unknown, sessionId: string, authority: SessionAuthority | undefined): OperatorReleaseListing {
	const { indexSeq, row } = fresh(value, sessionId);
	demand(row, "OVERRIDE_OBSERVED_GONE", "Fresh listing shows the session gone; run return to record it as returned");
	if (!authority) return { kind: "unverifiable_without_authority", indexSeq, live: flag(row.live), activity: activityOf(row) };
	if (row.endpointGeneration !== authority.endpointGeneration || row.endpointIncarnation !== authority.endpointIncarnation) return { kind: "foreign_incarnation", indexSeq };
	const exact = row.locator?.cwd === authority.cwd && row.ambiguous === false && row.terminalUncertain === false;
	demand(!(exact && row.terminal === true && row.live === false), "OVERRIDE_OBSERVED_GONE", "Fresh listing shows the exact session terminal; run return to record it as returned");
	if (exact && row.live === true && row.terminal === false) return { kind: "exact_live", indexSeq, activity: activityOf(row) };
	return { kind: "exact_unproven", indexSeq, live: flag(row.live), terminal: flag(row.terminal), activity: activityOf(row) };
}
/** Gone for an operator-released reservation: absence, or with the recorded authority the
 * exact incarnation terminal. Without authority only absence proves anything. */
function releasedGone(value: unknown, sessionId: string, authority: SessionAuthority | undefined): { observed?: "absent" | "terminal"; indexSeq: number } {
	if (!authority) {
		const { indexSeq, row } = fresh(value, sessionId);
		return row ? { indexSeq } : { observed: "absent", indexSeq };
	}
	try {
		const seen = observe(value, authority);
		return seen.kind === "absent" || seen.kind === "terminal" ? { observed: seen.kind, indexSeq: seen.indexSeq } : { indexSeq: seen.indexSeq };
	} catch (error) {
		if (error instanceof FleetError && error.code === "RETURN_AUTHORITY_CHANGED") return { indexSeq: fresh(value, sessionId).indexSeq };
		throw error;
	}
}

export interface OperatorRelease {
	taskId: string;
	state: "released_by_operator_unconfirmed";
	observedGone: false;
	statement: string;
	override: unknown;
}
/** Audited operator release of a held reservation whose return cannot be proven. It takes
 * one fresh read-only listing (never a close), is refused when that listing shows the
 * session gone, live and not idle (possibly running a turn), or exact, live and idle with
 * no fenced close ever tried. It is never reported as returned. */
export async function operatorReleaseResource(store: FleetStore, taskId: string, approval: { operator: string; reason: string }, options: {
	connect?: (node: NodeConfig) => Promise<ReturnConnection>;
} = {}): Promise<OperatorRelease> {
	demand(typeof approval?.operator === "string" && approval.operator.trim().length > 0 && approval.operator.length <= 200 && typeof approval.reason === "string" && approval.reason.trim().length > 0 && approval.reason.length <= 2000, "INVALID_INPUT", "Operator identity and an explicit reason are required");
	const task = store.task(taskId);
	demand(task, "TASK_NOT_FOUND", "Task not found");
	demand(!store.resourceReturnStatus(task.id), "RETURN_ALREADY_SETTLED", "Return already settled");
	const authority = store.getOperation(task.id, "session-authority") ? exactAuthority(store, task) : undefined;
	let listing: OperatorReleaseListing;
	let diagnostic: FailureDiagnostic | undefined;
	if (!task.sessionId || !task.nodeSnapshot) listing = { kind: "unavailable", error: "no_recorded_session_or_node" };
	else {
		let connection: ReturnConnection | undefined;
		let value: unknown;
		let failure: string | undefined;
		// Diagnostic step only; never read by any decision.
		let step: DiagnosticStep = { source: "ResourceReturn.connect", phase: "call" };
		try {
			connection = await (options.connect ?? connectResourceReturn)(task.nodeSnapshot);
			step = { source: "ResourceReturn.release_listing", phase: "call" };
			value = await connection.list(task.sessionId);
		} catch (error) {
			const code = (error as { code?: unknown })?.code;
			failure = typeof code === "string" && code ? code : "listing_failed";
			diagnostic = diagnose(error, step);
		} finally {
			connection?.close();
		}
		listing = failure !== undefined ? { kind: "unavailable", error: failure } : releaseListing(value, task.sessionId, authority);
	}
	const intent = store.overrideResourceReturn(task.id, approval, listing, diagnostic);
	return { taskId: task.id, state: UNCONFIRMED, observedGone: false, statement: OPERATOR_RELEASE_STATEMENT, override: intent.payload };
}

type CloseClass = "closed" | "stale" | "busy" | "legacy" | "suspect_legacy" | "unknown";
/** Classifies the public close response (gjc.command-error envelope or broker form). */
function classify(response: any, authority: SessionAuthority): CloseClass {
	if (response?.ok === true) return response.operation === "session.close" && response.result?.sessionId === authority.sessionId ? "closed" : "unknown";
	const code = response?.error?.code;
	// gjc.command-error carries diagnostics as top-level [{code,message}]; tolerate error.diagnostics too.
	const diagnostics: unknown[] = [...(Array.isArray(response?.diagnostics) ? response.diagnostics : []), ...(Array.isArray(response?.error?.diagnostics) ? response.error.diagnostics : [])];
	if (code === "endpoint_stale") return "stale";
	if (code === "busy") return "busy";
	if (code === "legacy_lifecycle_ambiguous" || (code === "operation_failed" && diagnostics.some((d: any) => d === LEGACY_DIAGNOSTIC || d?.code === LEGACY_DIAGNOSTIC))) return "legacy";
	// A legacy refusal whose diagnostics the CLI omitted looks exactly like this.
	if (code === "operation_failed" && response?.error?.outcomeCertainty === "unknown" && diagnostics.length === 0) return "suspect_legacy";
	return "unknown";
}
function latestClose(store: FleetStore, taskId: string): { ordinal: number; intent?: OperationIntent } {
	let ordinal = 0, intent: OperationIntent | undefined;
	for (let n = 1; n <= MAX_CLOSE_ATTEMPTS; n++) {
		const next = store.getOperation(taskId, `resource-return-close:${n}`);
		if (!next) break;
		ordinal = n; intent = next;
	}
	return { ordinal, intent };
}
/**
 * Durable return history of a task's current attempt for an automatic caller (the daemon), read without
 * the task body: how many idle-only closes were claimed, how the latest one was answered (unanswered =
 * outcome unknown, never replayed), the recorded per-attempt return outcomes and those recorded after the
 * latest close claim.
 */
export function returnHistory(store: FleetStore, taskId: string, attemptId: string): { closes: number; lastClose?: CloseClass | "unanswered"; outcomes: { kind: string; reason: string | null }[]; afterClose: { kind: string; reason: string | null }[] } {
	const { ordinal, intent } = latestClose(store, taskId);
	let lastClose: CloseClass | "unanswered" | undefined;
	if (intent) {
		const authority = store.getOperation(taskId, "session-authority")?.payload as any;
		lastClose = intent.receipt === undefined ? "unanswered" : authority ? classify(intent.receipt, { sessionId: authority.sessionId, cwd: authority.cwd, endpointGeneration: authority.endpointGeneration, endpointIncarnation: authority.endpointIncarnation }) : "unknown";
	}
	return { closes: ordinal, ...(lastClose ? { lastClose } : {}), outcomes: store.resourceReturnOutcomes(taskId, attemptId), afterClose: intent ? store.resourceReturnOutcomes(taskId, attemptId, intent.id) : [] };
}
const RELEASED_GONE = "observed_gone_after_operator_release";
/** Operator diagnostic for an error recorded as an unknown/blocked outcome. Never throws and never feeds a decision. */
function diagnose(error: unknown, step: DiagnosticStep): FailureDiagnostic | undefined {
	try {
		return failureDiagnostic(error, step);
	} catch {
		return undefined;
	}
}
/** Operator diagnostic for a close answer (not a thrown error) recorded as an unknown/blocked outcome. Same guarantees as diagnose(). */
function noted(step: DiagnosticStep, condition: DiagnosticCondition): FailureDiagnostic | undefined {
	try {
		return conditionDiagnostic(step, condition);
	} catch {
		return undefined;
	}
}

/** Sequential bounded pass over explicit settled tasks.
 * - Proof of return is a fresh exact listing: absent, or the original incarnation terminal.
 * - A live original incarnation is closed once per claim through the public broker close with
 *   the recorded generation/incarnation and ifIdle:true; the claim is durable BEFORE dispatch
 *   and an unanswered claim is never replayed.
 * - endpoint_stale is re-listed: not_ours only when the listing shows another incarnation;
 *   the exact incarnation still listed is return_unknown and may get a new bounded claim.
 * - lifecycle_legacy_history_ambiguous (or operation_failed with unknown outcome and no
 *   diagnostics) blocks closes on the whole node: the node's pass stops and the block persists
 *   until an audited operator unblock. Any other unclassified refusal stops the node's pass.
 * - An operator-released reservation is only listed, never closed, and is reported
 *   released_by_operator_unconfirmed until a fresh listing shows the session gone.
 * - A legacy Fleet.stop claim is never re-sent; fresh exact evidence reconciles it.
 * - Custody here is the validated immutable local Fleet result, not central attestation.
 */
export async function returnResources(store: FleetStore, ids: string[], options: {
	maxTasks?: number;
	paceMs?: number;
	connect?: (node: NodeConfig) => Promise<ReturnConnection>;
} = {}): Promise<ReturnReport[]> {
	const max = options.maxTasks ?? 20;
	const pace = options.paceMs ?? 250;
	demand(Number.isInteger(max) && max >= 1 && max <= 100 && Number.isInteger(pace) && pace >= 0 && pace <= 5000, "RETURN_BOUNDS", "Bounded task count and pacing required");
	demand(ids.length <= max && new Set(ids).size === ids.length, "RETURN_BOUNDS", "Explicit unique bounded task IDs required");
	const reports: ReturnReport[] = [];
	const groups = new Map<string, TaskRecord[]>();
	const refused: { taskId: string; refusal: RefusalCode; error: unknown }[] = [];
	for (const id of ids) {
		const stage: EligibilityStage = { at: "load" };
		let loaded = false;
		try {
			const task = store.task(id);
			demand(task, "TASK_NOT_FOUND", "Task not found");
			loaded = true;
			const status = store.resourceReturnStatus(task.id);
			if (status?.state === "returned" && status.afterOperatorRelease) { reports.push({ taskId: id, state: "returned", reason: RELEASED_GONE }); continue; }
			if (status?.state !== UNCONFIRMED) eligible(store, task, stage);
			const group = groups.get(task.nodeId!) ?? [];
			group.push(task); groups.set(task.nodeId!, group);
		} catch (error) {
			const code = error instanceof FleetError ? error.code : "";
			const refusal = refusalOf(error, stage);
			// Stored with its classified diagnostic, only for an id whose task row was loaded: a returned
			// task, or a row whose externalised manifest is damaged (load-stage `custody_invalid`). A blank,
			// invalid or unknown id, or any other load failure, has no row to record on: report only.
			if (loaded || refusal === "custody_invalid") refused.push({ taskId: id, refusal, error });
			reports.push({ taskId: id, state: "refused", reason: refusalReasons[code] ?? "settlement_custody_or_ownership_missing", refusal });
		}
	}
	// All refusals of this call in one write transaction, before any node pass.
	if (refused.length > 0) {
		try {
			store.recordResourceReturnRefused(refused.map(({ taskId, refusal, error }) => ({ taskId, refusal, diagnostic: diagnose(error, { source: "ResourceReturn.precondition", phase: "precondition" }) })));
		} catch {
			// N (docs/failure-diagnostics.md): the reports still carry the refusals and nothing is
			// released either way. A failure inside the write's transaction is already recorded by the store
			// as its own `refused` Store.transaction/record row with a diagnostic; READ_ONLY or a failed
			// BEGIN records nothing. Every failure of this write is counted as telemetry, once per call.
			store.noteTelemetryFailure();
		}
	}
	for (const [nodeId, tasks] of groups) {
		const token = `${process.pid}:${randomUUID()}`;
		if (!store.claimResourceReturnNode(nodeId, token)) {
			reports.push(...tasks.map(task => ({ taskId: task.id, state: "node_busy" as const, reason: "node_return_pass_active" })));
			continue;
		}
		let connection: ReturnConnection | undefined;
		const connect = async (node: NodeConfig) => (connection ??= await (options.connect ?? connectResourceReturn)(node));
		/** Set once this node's pass must not send another close. */
		let stopped: { state: ReturnState; reason: string; audit: string; failure?: FailureDiagnostic } | undefined;
		try {
			for (const snapshot of tasks) {
				let touched = false;
				// Diagnostic step only: advanced before each action, never read by any decision.
				let step: DiagnosticStep = { source: "ResourceReturn.precondition", phase: "precondition" };
				try {
					const task = store.task(snapshot.id)!;
					const override = store.getOperation(task.id, "resource-return-override");
					if (override) {
						// Listing only. Never closed, never "returned" until a fresh listing shows it gone.
						let report: ReturnReport = { taskId: task.id, state: UNCONFIRMED, reason: "session_not_observed_gone" };
						try {
							demand(task.sessionId && task.nodeSnapshot && canonicalJson(task.nodeSnapshot) === canonicalJson(tasks[0]!.nodeSnapshot), "RETURN_NODE_CHANGED", "Recorded session on this node required");
							const port = await connect(task.nodeSnapshot);
							touched = true;
							const authority = store.getOperation(task.id, "session-authority") ? exactAuthority(store, task) : undefined;
							const before = releasedGone(await port.list(task.sessionId), task.sessionId, authority);
							if (before.observed) {
								// The override's own listing showed the session present; only a newer index can show it gone.
								const floor = (override.payload as any)?.freshListing?.indexSeq;
								demand(!Number.isSafeInteger(floor) || before.indexSeq > floor, "RETURN_STALE_LIST", "Listing not newer than the override's own listing");
								const after = releasedGone(await port.list(task.sessionId), task.sessionId, authority);
								demand(after.indexSeq >= before.indexSeq, "RETURN_STALE_LIST", "Listing sequence regressed");
								if (after.observed) {
									const close = latestClose(store, task.id).intent;
									const stop = store.getOperation(task.id, "stop");
									store.confirmResourceReturn(task.id, task.attemptId!, task.sessionId, { sessionId: task.sessionId, attemptId: task.attemptId!, manifestDigest: task.resultManifest ? digest(task.resultManifest) : null, indexSeq: after.indexSeq, observed: after.observed, endpointGeneration: authority?.endpointGeneration ?? null, endpointIncarnation: authority?.endpointIncarnation ?? null, closeOperationId: close?.id ?? null, closeReceipt: (close?.receipt ?? null) as any, stopOperationId: stop?.id ?? null, stopReceipt: (stop?.receipt ?? null) as any });
									report = { taskId: task.id, state: "returned", reason: RELEASED_GONE };
								}
							}
						} catch {
							report = { taskId: task.id, state: UNCONFIRMED, reason: "fresh_listing_unavailable" };
						}
						reports.push(report);
						continue;
					}
					if (stopped) {
						store.recordResourceReturnUnknown(task.id, stopped.audit, stopped.failure);
						reports.push({ taskId: task.id, state: stopped.state, reason: stopped.reason });
						continue;
					}
					eligible(store, task);
					demand(canonicalJson(task.nodeSnapshot) === canonicalJson(tasks[0]!.nodeSnapshot), "RETURN_NODE_CHANGED", "One exact node transport per connection required");
					if (store.getOperation(task.id, "resource-return-confirmed")) { reports.push({ taskId: task.id, state: "returned" }); continue; }
					const authority = exactAuthority(store, task);
					const stop = store.getOperation(task.id, "stop");
					const confirm = (seen: Seen, close?: OperationIntent) => {
						store.confirmResourceReturn(task.id, task.attemptId!, task.sessionId!, { sessionId: task.sessionId!, attemptId: task.attemptId!, manifestDigest: digest(task.resultManifest!), indexSeq: seen.indexSeq, observed: seen.kind, endpointGeneration: authority.endpointGeneration, endpointIncarnation: authority.endpointIncarnation, closeOperationId: close?.id ?? null, closeReceipt: (close?.receipt ?? null) as any, stopOperationId: stop?.id ?? null, stopReceipt: (stop?.receipt ?? null) as any });
						reports.push({ taskId: task.id, state: "returned" });
					};
					const notOurs = (reason: string) => {
						store.recordResourceReturnOutcome(task.id, "resource_return_not_ours", reason);
						reports.push({ taskId: task.id, state: "not_ours", reason });
					};
					const unknown = (reason: string, failure?: FailureDiagnostic) => {
						store.recordResourceReturnUnknown(task.id, reason, failure);
						reports.push({ taskId: task.id, state: "return_unknown", reason });
					};
					const blocked = (diagnostic: string, failure?: FailureDiagnostic) => {
						store.recordResourceReturnUnknown(task.id, `node_blocked_by_${diagnostic}`, failure);
						reports.push({ taskId: task.id, state: "return_blocked_by_node", reason: diagnostic });
					};
					step = { source: "ResourceReturn.connect", phase: "call" };
					const port = await connect(task.nodeSnapshot!);
					touched = true;
					step = { source: "ResourceReturn.list", phase: "call" };
					const listed = await port.list(task.sessionId!);
					step = { source: "ResourceReturn.list", phase: "validate" };
					const before = observe(listed, authority);
					step = { source: "ResourceReturn.precondition", phase: "precondition" };
					const prior = latestClose(store, task.id);
					if (gone(before)) {
						step = { source: "ResourceReturn.list", phase: "call" };
						const relisted = await port.list(task.sessionId!);
						step = { source: "ResourceReturn.list", phase: "validate" };
						const after = observe(relisted, authority);
						demand(after.indexSeq >= before.indexSeq, "RETURN_STALE_LIST", "Listing sequence regressed");
						step = { source: "ResourceReturn.record", phase: "record" };
						if (gone(after)) confirm(after, prior.intent); else unknown("listing_changed_between_observations");
						continue;
					}
					step = { source: "ResourceReturn.record", phase: "record" };
					if (before.kind === "foreign") { notOurs("session_id_reused_by_foreign_incarnation"); continue; }
					if (before.kind === "unproven") { unknown("host_liveness_unproven"); continue; }
					// The exact original incarnation is live. A prior endpoint_stale was a pre-effect
					// refusal while this exact incarnation stayed listed, so it may take a new bounded claim.
					const priorClass = prior.intent ? (prior.intent.receipt === undefined ? "unanswered" : classify(prior.intent.receipt, authority)) : "none";
					// Fleet's own no-replay refusals below carry a condition diagnostic naming the retained close (display only).
					const retained = (close: OperationIntent | null | undefined): DiagnosticStep => ({ source: "ResourceReturn.close", phase: "precondition", ...(close ? { operationKind: "resource-return-close" as const, operationId: close.id } : {}) });
					if (priorClass === "unanswered" || priorClass === "unknown") { unknown("close_outcome_unknown_no_replay", noted(retained(prior.intent), "operation_already_claimed")); continue; }
					if (priorClass === "closed") { unknown("close_acknowledged_awaiting_terminal_listing"); continue; }
					step = { source: "ResourceReturn.close", phase: "precondition" };
					const block = store.resourceReturnNodeBlock(nodeId);
					if (block) { blocked(block.diagnostic, noted(retained(undefined), "resource_return_node_blocked")); continue; }
					if (prior.ordinal >= MAX_CLOSE_ATTEMPTS) { unknown("close_attempts_exhausted", noted(retained(prior.intent), "close_attempts_exhausted")); continue; }
					demand(store.renewResourceReturnNode(nodeId, token), "RETURN_LEASE_LOST", "Expired pass may not start a new close");
					step = { source: "ResourceReturn.close", phase: "claim" };
					let claim: OperationIntent | null;
					try {
						claim = store.claimResourceReturnClose(task.id, prior.ordinal + 1, { ...authority, ifIdle: true });
					} catch (error) {
						if (!(error instanceof FleetError) || error.code !== "RETURN_NODE_BLOCKED") throw error;
						blocked(store.resourceReturnNodeBlock(nodeId)?.diagnostic ?? LEGACY_DIAGNOSTIC, diagnose(error, step));
						continue;
					}
					if (!claim) {
						let other: OperationIntent | undefined;
						try { other = store.getOperation(task.id, `resource-return-close:${prior.ordinal + 1}`); } catch { /* diagnostic only: the claim is then not named */ }
						unknown("close_outcome_unknown_no_replay", noted({ ...retained(other), phase: "claim" }, "operation_already_claimed"));
						continue;
					}
					step = { source: "ResourceReturn.close", phase: "call", operationKind: "resource-return-close", operationId: claim.id };
					let response: unknown;
					/** Diagnostic of a public refusal thrown by the close; undefined when the close returned. */
					let refusal: FailureDiagnostic | undefined;
					try {
						response = await port.fencedClose(authority, claim.key);
					} catch (error) {
						if (!(error instanceof TransportError) || error.publicResponse === undefined) { unknown("close_outcome_unknown_no_replay", diagnose(error, step)); continue; }
						response = error.publicResponse;
						refusal = diagnose(error, step);
					}
					step = { ...step, phase: "record" };
					const answered = store.recordOperationReceipt(task.id, claim.kind, claim.id, response as any);
					step = { ...step, phase: "validate" };
					const outcome = classify(response, authority);
					// Diagnostic only, for an answer that ends unknown/blocked: the thrown refusal's own, else the answer class at this step.
					const validated = step;
					const answerFailure = (condition: DiagnosticCondition) => refusal ?? noted(validated, condition);
					if (outcome === "closed") {
						await Bun.sleep(pace);
						step = { source: "ResourceReturn.list", phase: "call" };
						const listedAfterClose = await port.list(task.sessionId!);
						step = { source: "ResourceReturn.list", phase: "validate" };
						const post = observe(listedAfterClose, authority);
						step = { source: "ResourceReturn.record", phase: "record" };
						if (gone(post)) confirm(post, answered);
						else if (post.kind === "foreign") notOurs("session_id_reused_by_foreign_incarnation");
						else unknown("close_acknowledged_awaiting_terminal_listing");
					} else if (outcome === "stale") {
						// endpoint_stale is also emitted for transient pre-send failures: re-list first.
						step = { source: "ResourceReturn.list", phase: "call" };
						const listedAfterStale = await port.list(task.sessionId!);
						step = { source: "ResourceReturn.list", phase: "validate" };
						const post = observe(listedAfterStale, authority);
						step = { source: "ResourceReturn.record", phase: "record" };
						if (post.kind === "foreign") notOurs("endpoint_stale_incarnation_not_owned");
						else if (gone(post)) confirm(post, answered);
						else unknown("endpoint_stale_exact_incarnation_still_listed", answerFailure("close_answer_endpoint_stale"));
					} else if (outcome === "busy") {
						step = { source: "ResourceReturn.record", phase: "record" };
						store.recordResourceReturnOutcome(task.id, "resource_return_session_busy", "session_not_idle");
						reports.push({ taskId: task.id, state: "session_busy", reason: "session_not_idle" });
					} else if (outcome === "legacy" || outcome === "suspect_legacy") {
						// Deterministic pre-dispatch refusal: nothing applied. Block the node and stop its pass.
						const diagnostic = outcome === "legacy" ? LEGACY_DIAGNOSTIC : SUSPECT_LEGACY_DIAGNOSTIC;
						const failure = answerFailure("close_answer_legacy_refusal");
						step = { source: "ResourceReturn.record", phase: "record" };
						store.blockResourceReturnNode(nodeId, task.id, claim.id, diagnostic, failure);
						reports.push({ taskId: task.id, state: "return_blocked_by_node", reason: diagnostic });
						stopped = { state: "return_blocked_by_node", reason: diagnostic, audit: `node_pass_stopped_by_${diagnostic}`, failure };
					} else {
						// An unclassified public answer: never replayed, and no further close on this node in this pass.
						const failure = answerFailure("close_answer_unclassified");
						step = { source: "ResourceReturn.record", phase: "record" };
						unknown("close_outcome_unknown_no_replay", failure);
						stopped = { state: "return_unknown", reason: "node_pass_stopped_by_unclassified_close_refusal", audit: "node_pass_stopped_by_unclassified_close_refusal", failure };
					}
				} catch (error) {
					store.recordResourceReturnUnknown(snapshot.id, "fresh_authoritative_observation_unavailable_no_replay", diagnose(error, step));
					reports.push({ taskId: snapshot.id, state: "return_unknown", reason: "fresh_authoritative_observation_unavailable_no_replay" });
				} finally {
					if (touched) await Bun.sleep(pace);
				}
			}
		} finally {
			try { connection?.close(); } finally { store.releaseResourceReturnNode(nodeId, token); }
		}
	}
	return reports;
}
