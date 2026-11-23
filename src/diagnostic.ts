import { types } from "node:util";
import type { Json } from "./contracts";
import { FleetError } from "./core";
import { TransportError } from "./rpc";

/**
 * Operator-facing failure diagnostics, deny-by-default.
 *
 * A diagnostic says *where* a state change to unknown/blocked/refused happened (Fleet-defined
 * step, phase and operation identifiers), the error class and an allowlisted code. Nothing else
 * is taken from the thrown value: the class is found by walking its prototype chain (no user code
 * runs, Proxies are never touched) and the code is read only from Fleet's own error classes, and
 * only when it is an own data property (no getter, toString or Proxy trap is ever invoked). For a
 * TransportError classified `transport:transport_timeout` only, the expired per-call limit is read
 * the same way (own data property `timeoutMs`) and kept only when it is a bounded integer. No
 * message, length, hash or other derivative of error text is stored. Codes outside the table are
 * stored as "unclassified". A diagnostic is never read back by any decision: it is not
 * settlement, replay or reclassification evidence.
 */
export const diagnosticSources = [
	"Fleet.start.prepare",
	"Fleet.start.preflight",
	"Fleet.start.connect",
	"Fleet.start.create",
	"Fleet.start.authority",
	"Fleet.start.approval_attach",
	"Fleet.start.prompt",
	"Fleet.start.close",
	"Fleet.inspect.connect",
	"Fleet.inspect.read_turn",
	"Fleet.inspect.list_questions",
	"Fleet.inspect.approval_discovery",
	"Fleet.inspect.read_execution",
	"Fleet.inspect.observe",
	"Fleet.inspect.receiptless",
	"Fleet.answer.discovery",
	"Fleet.answer.submit",
	"Fleet.cancel.abort",
	"Fleet.cancel.close",
	"Fleet.result",
	"ResourceReturn.precondition",
	"ResourceReturn.connect",
	"ResourceReturn.list",
	"ResourceReturn.close",
	"ResourceReturn.record",
	"ResourceReturn.release_listing",
	"Store.transaction",
	"Fleet.progress.read",
] as const;
export type DiagnosticSource = (typeof diagnosticSources)[number];
/** precondition: before any claim; claim: effect intent claim; call: awaiting the effect or read;
 * validate: checking the reply; record: persisting the reply. */
export const diagnosticPhases = ["precondition", "claim", "call", "validate", "record"] as const;
export type DiagnosticPhase = (typeof diagnosticPhases)[number];
export const diagnosticOperationKinds = ["prepare", "create", "prompt", "approval-attach", "answer", "cancel", "cancel-close", "resource-return-close"] as const;
/** Found on the prototype chain of Fleet's own classes and the built-in error classes; never taken from `name` or the constructor. */
export const diagnosticErrorClasses = ["FleetError", "TransportError", "SyntaxError", "TypeError", "RangeError", "Error", "non_error", "none", "unclassified"] as const;
export type DiagnosticErrorClass = (typeof diagnosticErrorClasses)[number];
/** Stored codes: short, lower-case, namespaced (`fleet:`, `transport:`, `condition:`). */
export const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9_:.-]{1,72}$/;
const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DiagnosticStep = {
	source: DiagnosticSource;
	phase: DiagnosticPhase;
	operationKind?: (typeof diagnosticOperationKinds)[number];
	operationId?: string;
};
export type FailureDiagnostic = DiagnosticStep & {
	version: 1;
	use: "diagnostic_only_not_evidence";
	errorClass: DiagnosticErrorClass;
	code: string;
	/** Fixed text for `code` from DIAGNOSTIC_TEXT; never text from the error. */
	message: string;
	/** `transport:transport_timeout` only: the per-call limit that expired, in ms. */
	timeoutMs?: number;
};
/** Largest per-call limit a diagnostic can carry (the node transport.timeoutMs maximum). */
const MAX_DIAGNOSTIC_TIMEOUT_MS = 600_000;
const TIMEOUT_CODE = "transport:transport_timeout";
function timeoutValue(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_DIAGNOSTIC_TIMEOUT_MS ? (value as number) : undefined;
}

// ---- code table ---------------------------------------------------------------------------
// Every FleetError code Fleet itself throws. test/catch-site-behaviour.test.ts fails when a driven
// conversion records a Fleet code that is missing here (it would otherwise be stored as "unclassified").
const fleetErrorCodes = [
	"ALREADY_TERMINAL", "ANSWER_PENDING", "APPROVAL_AUTHORITY", "APPROVAL_BACKEND_UNAVAILABLE",
	"APPROVAL_BINDING", "APPROVAL_BLOCKED", "APPROVAL_CHANNEL_LOST", "APPROVAL_CONSUMPTION",
	"APPROVAL_CONTRACT", "APPROVAL_DISCOVERY", "APPROVAL_DISPATCH", "APPROVAL_TRANSPORT", "ARCHIVED_TASK",
	"ARCHIVE_AUTHORITY", "ARCHIVE_CONFLICT", "ARCHIVE_CREATE_UNKNOWN", "ARCHIVE_EVIDENCE", "ARCHIVE_IN_PROGRESS",
	"ARCHIVE_LIVE_SESSION", "ARCHIVE_NODE", "ARCHIVE_OUTPUT_LIMIT", "ARCHIVE_OVERRIDE", "ARCHIVE_PHASE",
	"ARCHIVE_QUERY", "ARCHIVE_TIMEOUT", "ARCHIVE_TRANSPORT", "ARTIFACT_CHANGED", "AUTHORITY_CONFLICT", "BACKUP_EXISTS",
	"BACKUP_FAILED", "BACKUP_LEFTOVER", "BACKUP_LIMIT", "CANCEL_BLOCKED", "CANCEL_PENDING", "CANCEL_UNCONFIRMED", "CANCEL_UNKNOWN",
	"CANCEL_UNSUPPORTED", "CREATE_UNCONFIRMED", "CWD_MISMATCH", "DIGEST_MISMATCH", "DISPATCH_DISABLED",
	"DISPOSE_CONFLICT", "DISPOSE_INPUT", "DISPOSE_NOT_TERMINAL", "DISPOSE_PHASE", "DISPOSE_RESOURCE_UNPROVEN", "DISPOSE_RETURN_IN_PROGRESS", "DISPOSE_ROW_FORM", "DISPOSE_SUPERSEDER",
	"EVENT_CONFLICT", "EXECUTION_BINDING", "EXPORT_REVIEW_CHANGED", "EXPORT_REVIEW_NOT_REQUIRED", "EXPORT_REVIEW_REQUIRED", "IDENTITY_MISMATCH", "INPUT_AUTHORIZATION", "INVALID_EVIDENCE",
	"INVALID_INPUT", "KEY_CONFLICT", "LATE_RECEIPT_ACCEPTED", "LATE_RECEIPT_BINDING", "LATE_RECEIPT_CHANGED",
	"LATE_RECEIPT_STATE", "MIGRATION_NOT_APPLIED", "NODE_ENABLED", "NODE_HAS_LIVE_TASKS", "NODE_NOT_ADMISSIBLE", "NODE_PLATFORM_MISMATCH", "NOT_FOUND",
	"NOT_TERMINAL", "NO_ATTEMPT", "NO_HELD_ATTEMPT", "NO_SESSION", "NO_TURN", "OBSERVATION_BINDING", "OBSERVATION_UNAVAILABLE",
	"OPERATION_BINDING", "OPERATION_CONFLICT", "OPERATION_UNAVAILABLE", "ORDINARY_BINDING",
	"ORDINARY_TRANSPORT", "OVERRIDE_LISTING_REQUIRED", "OVERRIDE_OBSERVED_GONE", "OVERRIDE_RETURN_FIRST",
	"OVERRIDE_SESSION_RUNNING", "POLL_CONFLICT", "POLL_LIMIT", "PREPARATION_NOT_RENEWABLE", "READ_ONLY", "RECEIPTLESS_UNVERIFIABLE",
	"REMOTE_WORKSPACE_TRANSPORT_REQUIRED", "RESERVED_OPERATION", "RESULT_BINDING", "RESULT_COMPLETENESS", "RESULT_CONFLICT",
	"RESULT_DIGEST", "RESULT_EXCLUSIONS", "RESULT_HEAD", "RESULT_IGNORED", "RESULT_INTEGRITY", "RESULT_NOT_READY", "RESULT_PATH", "RESULT_PRODUCER", "RESULT_SCHEMA",
	"RESULT_STATUS", "RESULT_STORE_OFF", "RETURN_ALREADY_SETTLED", "RETURN_AUTHORITY_CHANGED", "RETURN_AUTHORITY_MISSING",
	"RETURN_BINDING", "RETURN_BOUNDS", "RETURN_CANCEL_PENDING", "RETURN_CUSTODY_BINDING",
	"RETURN_CUSTODY_MISSING", "RETURN_LEASE_LOST", "RETURN_LIST_INVALID", "RETURN_NODE_BLOCKED",
	"RETURN_NODE_CHANGED", "RETURN_NOT_BLOCKED", "RETURN_NOT_HELD", "RETURN_NOT_SETTLED", "RETURN_REPLAY",
	"RETURN_STALE_LIST", "ROOT_DENIED", "SCHEMA_VERSION", "SDK_TRANSPORT_REQUIRED",
	"SESSION_AUTHORITY_REQUIRED", "SESSION_CONFLICT", "STOP_BLOCKED", "STOP_UNKNOWN", "STORE_ERROR", "TASK_NOT_FOUND",
	"TERMINAL_CONFLICT", "TEST_EVIDENCE", "TEST_UNKNOWN", "TURN_CONFLICT", "TURN_UNCONFIRMED",
	"UNKNOWN_EXECUTION", "UNSAFE_DB_PATH", "VERIFICATION_CONFLICT", "WITHDRAW_ATTEMPTED", "WITHDRAW_INPUT", "WITHDRAW_PHASE",
	"WORKSPACE_BINDING", "WORKSPACE_CONFLICT",
	// Work-unit Step 1/1b (src/work-unit.ts, core.ts validateTaskInput).
	"CLASSIFICATION_MISMATCH", "NON_FLEET_COMMIT", "ROLE_NO_TESTS", "ROLE_PROMPT_CONTRACT", "WORK_UNIT_ROLE_TASKS_PENDING", "WORK_UNIT_SWITCH_INCONSISTENT",
	// Subject linkage (src/subject.ts, FleetStore.submit).
	"SUBJECT_FILE_MISMATCH", "SUBJECT_NODE_PINNED", "SUBJECT_NOT_COLLECTED", "SUBJECT_NOT_FOUND", "SUBJECT_SELF",
] as const;
const transportText = {
	transport_exited: "Transport process exited",
	transport_closed: "Transport was closed",
	transport_timeout: "Transport request timed out",
	transport_write_failed: "Writing to the transport failed",
	too_many_requests: "Too many concurrent transport requests",
	stderr_limit: "Transport stderr exceeded its limit",
	stderr_failure: "Transport stderr could not be read",
	rpc_error: "Remote returned an RPC error",
	invalid_rpc_result: "Remote RPC reply had no result",
	invalid_transport_output: "Transport output was not valid RPC",
	invalid_tools: "Remote tool list was invalid",
	missing_tool_content: "Remote tool reply had no content",
	non_json_tool_content: "Remote tool reply was not JSON",
	tool_refused: "Remote tool refused the call",
	execution_query_timeout: "Execution query timed out",
	execution_query_output_limit: "Execution query output exceeded its limit",
	execution_query_failed: "Execution query failed",
	invalid_public_sdk_response: "Public SDK reply was invalid",
	// Node helper client (oneShot / NodeReplyError). Only the certainty prefix is kept: the typed
	// error/detail pair and correlation id of a NodeReplyError are not stored here.
	node_transport_failed: "Node helper transport failed",
	node_timeout: "Node helper timed out",
	node_output_limit: "Node helper output exceeded its limit",
	node_refused: "Node helper refused before sending; nothing ran",
	node_failed: "Node helper failed; effects unknown",
	// Node-side progress read (src/progress.ts): read-only, never runs gjc.
	progress_spawn_failed: "Progress read could not be started",
	progress_timeout: "Progress read timed out",
	progress_output_limit: "Progress read output exceeded its limit",
	progress_exit: "Progress read exited unsuccessfully",
	progress_reply_invalid: "Progress read reply was invalid",
} as const;
const conditionText = {
	operation_already_claimed: "Effect intent already claimed; not replayed",
	questions_incomplete: "Question reconciliation incomplete",
	preflight_reply_invalid: "Preflight reply was not a pass",
	close_answer_unclassified: "Close answer was not classified; not replayed",
	close_answer_legacy_refusal: "Close answer was a legacy lifecycle refusal; node blocked",
	close_answer_endpoint_stale: "Close answer was endpoint stale; session still listed",
	close_attempts_exhausted: "Bounded close attempts exhausted; not closed",
	resource_return_node_blocked: "Node blocked for resource-return closes; not closed",
	create_refused_before_effect: "Create refused before any session existed; attempt failed",
	verification_conflict: "Verifier request conflicts with retained evidence; final",
	verification_owner_gone: "Verifier claim owner gone without receipt; not rerun",
	progress_route_unavailable: "No registered route to read progress on the node",
	transcript_missing: "Session transcript not found on the node",
	transcript_ambiguous: "More than one session transcript matched on the node",
	transcript_unreadable: "Session transcript could not be read on the node",
	progress_reply_invalid: "Progress reply line for the session was invalid",
	progress_clock_inconsistent: "Transcript time is ahead of the node clock beyond tolerance",
} as const;
export type DiagnosticCondition = keyof typeof conditionText;

const table = new Map<string, string>([["unclassified", "Unclassified failure; no code recorded"]]);
for (const code of fleetErrorCodes) table.set("fleet:" + code.toLowerCase(), "Fleet check refused the step");
for (const [code, text] of Object.entries(transportText)) table.set("transport:" + code, text);
for (const [code, text] of Object.entries(conditionText)) table.set("condition:" + code, text);
/** Allowlisted code -> fixed message text. The only codes and messages a diagnostic can carry. */
export const DIAGNOSTIC_TEXT: ReadonlyMap<string, string> = table;

/** The allowlisted code itself, or "unclassified". */
function known(code: unknown): string {
	return typeof code === "string" && DIAGNOSTIC_CODE_PATTERN.test(code) && table.has(code) ? code : "unclassified";
}
function fleetCode(raw: string | undefined): string {
	return raw !== undefined && /^[A-Z][A-Z0-9_]{1,63}$/.test(raw) ? known("fleet:" + raw.toLowerCase()) : "unclassified";
}
function transportCode(raw: string | undefined): string {
	if (raw === "EXECUTION_QUERY_FAILED") return "transport:execution_query_failed";
	// "tool_refused:<remote reason>" keeps only the Fleet-defined prefix.
	const match = raw !== undefined ? /^([a-z][a-z0-9_]{1,63})(?::|$)/.exec(raw) : null;
	return match ? known("transport:" + match[1]) : "unclassified";
}
// ---- the only reads of a thrown value -----------------------------------------------------------
const MAX_PROTOTYPE_DEPTH = 64;
/**
 * The prototype chain of an object, or undefined when it cannot be walked without running user
 * code: the value or any prototype is a Proxy (whose getPrototypeOf trap `instanceof` would call),
 * or the chain is implausibly deep. Object.getPrototypeOf of a non-Proxy object runs no user code.
 */
export function prototypeChain(value: object): object[] | undefined {
	const chain: object[] = [];
	let current: object | null = value;
	while (current !== null) {
		if (types.isProxy(current) || chain.length > MAX_PROTOTYPE_DEPTH) return undefined;
		current = Object.getPrototypeOf(current);
		if (current !== null) chain.push(current);
	}
	return chain;
}
/** `code` when it is an own data property holding a string; accessors and everything else yield undefined. */
function ownCode(value: object): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, "code");
	return descriptor !== undefined && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" ? descriptor.value : undefined;
}
/** `timeoutMs` when it is an own data property holding a bounded integer; read only for a classified transport timeout. */
function ownTimeout(value: object): number | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, "timeoutMs");
	return descriptor !== undefined && Object.hasOwn(descriptor, "value") ? timeoutValue(descriptor.value) : undefined;
}

type Classified = { errorClass: DiagnosticErrorClass; code: string; timeoutMs?: number };
/** Equivalent of the instanceof checks, in subclass-first order, without invoking any trap. */
function classify(error: unknown): Classified {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return { errorClass: "non_error", code: "unclassified" };
	const chain = prototypeChain(error);
	if (!chain) return { errorClass: "unclassified", code: "unclassified" };
	const has = (constructor: { prototype: object }) => chain.includes(constructor.prototype);
	if (has(FleetError)) return { errorClass: "FleetError", code: fleetCode(ownCode(error)) };
	if (has(TransportError)) {
		const code = transportCode(ownCode(error));
		const timeoutMs = code === TIMEOUT_CODE ? ownTimeout(error) : undefined;
		return { errorClass: "TransportError", code, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
	}
	if (has(SyntaxError)) return { errorClass: "SyntaxError", code: "unclassified" };
	if (has(TypeError)) return { errorClass: "TypeError", code: "unclassified" };
	if (has(RangeError)) return { errorClass: "RangeError", code: "unclassified" };
	if (has(Error)) return { errorClass: "Error", code: "unclassified" };
	return { errorClass: "non_error", code: "unclassified" };
}
function stepFields(step: DiagnosticStep): DiagnosticStep {
	return {
		source: step.source,
		phase: step.phase,
		...((diagnosticOperationKinds as readonly unknown[]).includes(step.operationKind) && typeof step.operationId === "string" && operationIdPattern.test(step.operationId)
			? { operationKind: step.operationKind, operationId: step.operationId }
			: {}),
	};
}

/** Build a diagnostic for a thrown error at `step`. Never throws; never copies text from `error`. */
export function failureDiagnostic(error: unknown, step: DiagnosticStep): FailureDiagnostic {
	let classified: Classified;
	try {
		classified = classify(error);
	} catch {
		classified = { errorClass: "unclassified", code: "unclassified" };
	}
	return {
		version: 1,
		use: "diagnostic_only_not_evidence",
		...stepFields(step),
		errorClass: classified.errorClass,
		code: classified.code,
		message: table.get(classified.code)!,
		...(classified.timeoutMs !== undefined ? { timeoutMs: classified.timeoutMs } : {}),
	};
}

/**
 * Only the error class of a thrown value, by the same trap-free prototype-chain walk as
 * `failureDiagnostic`. Never throws; reads no text from the value. Used by non-converting (N) sites
 * that report a failure without persisting it (node-health gate).
 */
export function diagnosticErrorClass(error: unknown): DiagnosticErrorClass {
	try {
		return classify(error).errorClass;
	} catch {
		return "unclassified";
	}
}

/** Diagnostic for a state change that was not caused by a thrown error (e.g. an existing claim). */
export function conditionDiagnostic(step: DiagnosticStep, condition: DiagnosticCondition): FailureDiagnostic {
	const code = known("condition:" + condition);
	return { version: 1, use: "diagnostic_only_not_evidence", ...stepFields(step), errorClass: "none", code, message: table.get(code)! };
}

/** Rebuild a diagnostic from allowlisted fields only; the message is recomputed from the code. */
export function normalizeDiagnostic(value: unknown): FailureDiagnostic | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const d = value as Record<string, unknown>;
	if (d.version !== 1 || d.use !== "diagnostic_only_not_evidence") return undefined;
	if (!(diagnosticSources as readonly unknown[]).includes(d.source)) return undefined;
	if (!(diagnosticPhases as readonly unknown[]).includes(d.phase)) return undefined;
	if (!(diagnosticErrorClasses as readonly unknown[]).includes(d.errorClass)) return undefined;
	const code = known(d.code);
	const timeoutMs = d.errorClass === "TransportError" && code === TIMEOUT_CODE ? timeoutValue(d.timeoutMs) : undefined;
	const out: Record<string, Json> = {
		version: 1,
		use: "diagnostic_only_not_evidence",
		...(stepFields({ source: d.source, phase: d.phase, operationKind: d.operationKind, operationId: d.operationId } as DiagnosticStep) as Record<string, Json>),
		errorClass: d.errorClass as string,
		code,
		message: table.get(code)!,
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
	return out as unknown as FailureDiagnostic;
}
