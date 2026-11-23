import type { InputPackage } from "./inputs";
import type { ApprovalContract } from "./approval";

export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };

export interface NodeConfig {
	id: string;
	os: string;
	arch: string;
	roots: Record<string, string>;
	/**
	 * Operator-owned collection rules of source roots (repoId → the object
	 * `gjc-fleet collection-rules REPO` prints): preparation takes the collection
	 * configuration, `info/exclude` and repository excludes text from here, never from
	 * the root's shared `.git`, which every worker on the root can write. A root without
	 * them takes those facts from its `.git` at each preparation.
	 */
	collectionRules?: Record<string, { config: Record<string, string>; info_exclude: string; excludes_file: string }>;
	workspaceRoot: string;
	/** Legacy field from slot-based scheduling; accepted but no longer enforced. */
	maxConcurrency?: number;
	enabled: boolean;
	draining: boolean;
	reachable: boolean;
	sdkReady: boolean;
	modelReady: boolean;
	models: string[];
	modelProfiles?: string[];
	/**
	 * Coordinator stdio transport. `timeoutMs` bounds each call over it (initialize, tools/list and every
	 * tool call); absent = the OS default (see `nodeRpcTimeoutMs`).
	 */
	transport: { command: string; args: string[]; timeoutMs?: number };
	workspaceTransport?: { command: string; args: string[] };
	sdkTransport?: { command: string; args: string[] };
	operations: string[];
}

export interface SessionAuthority {
	sessionId: string;
	cwd: string;
	endpointGeneration: number;
	endpointIncarnation: string;
}

export interface TaskInput {
	schemaVersion: 1;
	key: string;
	caller: string;
	repoId: string;
	baseCommit: string;
	prompt: string;
	required: {
		os?: string;
		arch?: string;
		model?: string;
		modelProfile?: string;
		nodeId?: string;
		operations?: string[];
	};
	preferences?: string[];
	/** Work-unit Step 1: accepted only while the work-unit switch is on (validateTaskInput). */
	workUnit?: { role: "report" } | { role: "review"; subject: { taskId: string; branch: string } };
	/** Subject linkage (step 2): the reviewed file of another task's stored result; never with workUnit. */
	subject?: TaskSubject;
	approvalContract?: ApprovalContract;
	inputPackage?: InputPackage;
	/** Opt-in authority to collect exactly these files after a successful runtime receipt; never a verifier. */
	autoCustody?: { paths: string[] };
	/** Explicit one-child selected-file review dispatch policy, bound into this immutable input. */
	reviewDispatch?: { path: string; required: TaskInput["required"]; promptTemplate: string; childCustody?: string[] };
}
/**
 * One file of another task's STORED result manifest, checked by FleetStore.submit. `otherNode: true` keeps
 * this task off the subject's node (selectNode reason `subject_node`). The input itself is the only state.
 */
export interface TaskSubject {
	taskId: string;
	path: string;
	sha256: string;
	otherNode?: boolean;
}

export type Phase =
	| "queued"
	| "preparing"
	| "dispatching"
	| "active"
	| "approval_required"
	| "blocked_unknown"
	| "cancel_unknown"
	| "completed_unverified"
	| "succeeded"
	| "failed"
	| "archived"
	| "cancelled";
export interface ArchiveEvidence {
	/** Caller-supplied annotations, never authorization or broker evidence. */
	notes?: Json;
	/** Required in addition to node_retired when no session/create outcome exists. */
	noSessionConfirmation?: { kind: "never_started" | "create_outcome_unknown_operator_confirmed"; reason: string };
	operatorOverride?: {
		kind: "never_started" | "create_outcome_unknown_operator_confirmed" | "node_retired";
		reason: string;
	};
}
export type DispositionKind = "deployed" | "superseded" | "review-recorded" | "discarded";
/**
 * Operator disposition of a completed_unverified task: an audited operator RECORD, never Fleet
 * verification. The task moves to the terminal archived phase; it never becomes succeeded.
 */
export interface DispositionRequest {
	kind: DispositionKind;
	reason: string;
	/** deployed only: the commit the operator states the work landed in (7-40 hex). Recorded, not verified. */
	commit?: string;
	/** superseded only: an existing different task. */
	supersededBy?: string;
	/** review-recorded only. */
	subject?: string;
	verdict?: "clean" | "not-clean";
	/** Audited reason when the task's node was unregistered (the archive node_retired override). */
	nodeRetired?: string;
}
export interface TaskDisposition extends DispositionRequest {
	actor: string;
	at: string;
	/** digest of the normalised request; with actor, the idempotency identity. */
	requestDigest: string;
	/** Fixed wording of what the record means (and does not mean). */
	statement: string;
	verifiedByFleet: false;
}
/**
 * Terminal settlement of a turn that is provably over but has NO runtime command
 * receipt. Always paired with status "failed"; never success, never verifiable.
 */
export interface ReceiptlessSettlement {
	kind: "failed_without_receipt" | "ended_without_receipt";
	/** Runtime receiptState that was observed (missing/absent); never "present". */
	receiptState: string;
	/** Operator-facing original failure cause (bounded, control-stripped, redacted). */
	cause: string;
	/** Fleet-clock instant of the confirming poll. */
	settledAt: string;
	/** Inspect keeps a read-only late-receipt check for the exact turn until this instant. */
	lateObservationUntil: string;
}
/**
 * A runtime receipt for the SAME session/turn/runtime command that appeared AFTER a
 * receipt-less settlement. Recorded as a durable contradiction; never rewrites finality.
 */
export interface LateReceipt {
	/** Runtime outcome kind of the late receipt (terminal_ok, failed, ...). */
	status: string;
	/** SHA256 of the canonical exact runtime execution record. */
	digest: string;
	/** Runtime terminal instant (ms) carried by the receipt. */
	terminalAt: number;
	/** Bounded structured outcome codes of the receipt (no free text beyond the cap). */
	outcome: { [key: string]: Json };
	sessionId: string;
	turnId: string;
	runtimeCommandId: string;
	runtimeTurnId: string;
	observedAt: string;
	settlementKind: ReceiptlessSettlement["kind"];
	/** Present only after an audited operator acceptance of a terminal_ok late receipt. */
	acceptance?: { at: string; actor: string; reason: string; evidenceDigest: string };
}
export interface TaskResult {
	status: Phase;
	evidence: Json;
	executionTerminal: boolean;
	verified: boolean;
	/**
	 * Exactly `{manifestDigest, testCount, trust}`, byte-compatible with every earlier
	 * release (which re-derives and compares it on each `result` read).
	 */
	verificationEvidence?: Json;
	/** Export completeness evidence of the verification (`exportComplete`, schema; acceptance), which earlier releases ignore. */
	exportEvidence?: Json;
	settlement?: ReceiptlessSettlement;
	lateReceipt?: LateReceipt;
	/**
	 * Passing commands over an incomplete (or legacy-unknown) export. The task stays
	 * `completed_unverified` and can never be verified until an operator accepts this
	 * exact review (the immutable subject: task, attempt, effective result digest,
	 * artifact schema, completeness and exclusion set, bound by `reviewDigest`).
	 * The store's `verifyResult` refuses to verify the task, and `requireExportReview`
	 * to change the review, without that acceptance (no schema trigger: review fx-9abb2530 F3).
	 */
	exportIncomplete?: ExportIncomplete;
}
export interface ExportIncomplete {
	subject: Json;
	reviewDigest: string;
	requiredAt: string;
	acceptance?: { operator: string; reviewDigest: string; acceptedAt: string };
	/** Digest of the passing result-test receipt of an explicit verification. The receipt itself is held
	 * once, outside the task row, as its receipt-less claim's `held` (see `OperationIntent.held`), so no
	 * earlier release verifies the task on a read (review fx-6f923f88 F3). */
	resultTestDigest?: string;
}
export type TaskProgressVerdict = "progressing" | "stalled_model" | "stalled_tool" | "finished_unobserved" | "unknown";
/** Kind of the last transcript entry: tool_running = assistant toolUse; awaiting_model = toolResult/user;
 * assistant_final = assistant with any other stopReason; none = empty transcript; other = any other entry. */
export type TaskProgressEntryKind = "tool_running" | "awaiting_model" | "assistant_final" | "other" | "none";
/**
 * Durable per-task lane progress, written only by Fleet's observation paths from one node-side read of the
 * session transcript (file time and the last entry's role/stopReason, never its content). Display and
 * operator hints only: it never changes phase, hold, claims or settlement, and never causes a kill, close,
 * resend or reassignment. Rows written before this field existed simply lack it.
 */
export interface TaskProgress {
	version: 1;
	verdict: TaskProgressVerdict;
	/** Hub clock: when the read that produced this record completed. */
	observedAt: string;
	/** Hub clock: when that read was issued; an older read never replaces a newer one. */
	readStartedAt: string;
	/** Facts of the last successful read (kept, with factObservedAt, when a later read fails). */
	lastEntryKind?: TaskProgressEntryKind;
	lastStopReason?: string;
	/** The read window held no line fixing the open tool-call count (a long batch): the tool threshold applied. */
	pendingToolsUnknown?: true;
	/** Hub clock: observedAt minus the node-measured seconds since the last transcript write. */
	lastProgressAt?: string;
	/** Node clock minus transcript file time at the read, in seconds (never negative). */
	idleSeconds?: number;
	/** Node clock: transcript file time; identifies one transcript state across reads. */
	nodeWrittenAt?: string;
	/** Node clock minus hub clock at the read (display only). */
	nodeClockOffsetSeconds?: number;
	factObservedAt?: string;
	thresholds: { modelSeconds: number; toolSeconds: number };
	/**
	 * Current stall episode: set when a task first becomes stalled. `recovered` marks a recovery not yet audited;
	 * the episode is closed (and audited) once no new stall followed within PROGRESS_EPISODE_COALESCE_SECONDS,
	 * and a stall within it continues the episode (`coalesced` counts those re-stalls).
	 */
	stall?: {
		verdict: "stalled_model" | "stalled_tool";
		since: string;
		nodeWrittenAt: string;
		recovered?: { at: string; verdict: TaskProgressVerdict };
		coalesced?: number;
	};
	/** finished_unobserved observation already requested for this transcript state. */
	settle?: { requestedAt: string; nodeWrittenAt: string };
	hint: string;
	/** Deny-by-default diagnostic of a failed read (verdict unknown). */
	diagnostic?: Json;
}
export interface TaskRecord {
	id: string;
	/** Immutable collection request for this exact attempt, persisted before node contact. */
	resultCustodyRequest?: { attemptId: string; paths: string[] | null };
	input: TaskInput;
	inputDigest: string;
	nodeId?: string;
	nodeSnapshot?: NodeConfig;
	attemptId?: string;
	phase: Phase;
	archivedFrom?: { phase: Phase; reason?: string; result?: TaskResult };
	archivedAt?: string;
	archiveActor?: string;
	archiveEvidenceDigest?: string;
	/** Present only on a task archived by `task dispose`. */
	disposition?: TaskDisposition;
	sessionId?: string;
	sessionValidated?: boolean;
	turnId?: string;
	held: boolean;
	reason?: string;
	result?: TaskResult;
	workspace?: Json;
	resultManifest?: Json;
	testReceipt?: Json;
	/**
	 * Last recorded verifier outcome that is NOT a receipt, for the current attempt: a final conflict between a
	 * requested verifier argv and the attempt's immutable retained verifier evidence, or a verifier claim whose
	 * owner is gone without a receipt (never rerun). Bounded: one object per task, digests only.
	 */
	verification?: VerificationRecord;
	pollIssued?: number;
	pollApplied?: number;
	progress?: TaskProgress;
	/**
	 * Why the last selection of this never-admitted queued task found no node (core.placementRecord). Bounded;
	 * removed when the task is admitted. Display and queue ordering only: never an input to node selection.
	 */
	placement?: TaskPlacement;
	/** Present only on a queued task withdrawn by the operator (`queue withdraw`) before any attempt. */
	withdrawal?: TaskWithdrawal;
}
export interface TaskPlacement {
	/** waiting: some node is excluded only for reasons that can clear by themselves; unplaceable: only an operator change can clear it. */
	verdict: "waiting" | "unplaceable";
	/** First selection (ISO) that rejected the task with these verdict-deciding reasons. */
	since: string;
	/** Latest selection (ISO) that rejected the task with these verdict-deciding reasons. */
	checkedAt: string;
	/** Selections that rejected the task with these verdict-deciding reasons, the audited first one included. */
	rejections: number;
	/**
	 * Digest of the verdict, the pin and each excluded node's verdict-deciding reasons (only the structural ones
	 * of a structurally excluded node, all of any other node): a rejection with the same digest appends no
	 * selection audit row.
	 */
	exclusionsDigest: string;
	/** Nodes excluded by that selection (blocking keeps at most PLACEMENT_BLOCKING_LIMIT of them). */
	nodes: number;
	/** The pinned node first, then the closest nodes (fewest structural, then fewest reasons); bounded. */
	blocking: NodeExclusion[];
}
export interface TaskWithdrawal {
	actor: string;
	reason: string;
	at: string;
}
export type VerificationRecord =
	| {
			state: "conflict";
			attemptId: string;
			requestedArgvDigest: string;
			/** Distinct requested argv digests already audited for this attempt (bounded, see store.ts). */
			recordedArgvDigests: string[];
			/** Digests of every verifier argv retained for the attempt (receipt, cached manifest tests, result-test). */
			retainedArgvDigests: string[];
			/** Conflicting requests recorded for this attempt, repeats included; firstAt is the first of them. */
			count: number;
			firstAt: string;
			lastAt: string;
	  }
	| {
			state: "owner_gone";
			attemptId: string;
			kind: "verify-test" | "result-test";
			operationId: string;
			at: string;
	  };
/** A task row without its result: what scheduling, placement and listings need. */
export type TaskState = Omit<TaskRecord, "resultManifest">;
export interface OperationIntent {
	id: string;
	key: string;
	digest: string;
	taskId: string;
	attemptId: string;
	kind: string;
	payload: Json;
	/** Immutable evidence returned for this exact persisted operation claim. */
	receipt?: Json;
	/** Mutable owner lease of an operator-run claim; never part of the payload digest or the receipt. */
	lease?: OperationLease;
	/** A result-test receipt held with a pending export review (bound by `ExportIncomplete.resultTestDigest`);
	 * acceptance moves it to `receipt`. Never part of the payload digest. */
	held?: Json;
}
/** A live process that currently owns an operator-run start. Expiry or a dead same-host pid frees it. */
export interface OperationLease {
	owner: string;
	pid: number;
	host: string;
	expiresAt: number;
}
export interface Observation {
	eventId: string;
	/** SHA256 of canonical JSON of the observation excluding eventId and digest. */
	digest: string;
	sessionId: string;
	turnId?: string;
	status: Exclude<Phase, "queued" | "archived">;
	terminal: boolean;
	evidence: Json;
	settlement?: ReceiptlessSettlement;
}
export interface AuditEvent {
	sequence: number;
	taskId?: string;
	kind: string;
	at: string;
	data: Json;
}
export interface NodeExclusion {
	nodeId: string;
	reasons: string[];
}
export interface Selection {
	nodeId?: string;
	exclusions: NodeExclusion[];
}
