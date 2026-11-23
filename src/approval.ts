import type { ProgressConfig } from "./progress";
import type { Json, SessionAuthority } from "./contracts";

/** Explicitly selected before admission; never inferred from a missing gate page. */
export const SDK_UI_APPROVAL_CONTRACT = "sdk-ui-waiter-v1" as const;
export type ApprovalContract = typeof SDK_UI_APPROVAL_CONTRACT;

export interface ApprovalSessionContext {
	contract: ApprovalContract;
	taskId: string;
	attemptId: string;
	nodeId: string;
	inputDigest: string;
	sessionId: string;
	workspacePath: string;
	createOperationId: string;
	/** Saved before any prompt; not refreshed or replaced by the UI adapter. */
	sessionAuthority: SessionAuthority;
}

export interface NativeUiQuestionAuthority {
	kind: "sdk_ui_waiter";
	requestId: string;
	connectionId: string;
	leaseId: string;
	/** Firsthand public Router capability identity, not a recomputed SDK tuple. */
	attachmentAuthorityId: string;
	endpointGeneration: number;
}

export interface NativeWorkflowQuestion {
	questionId: string;
	/** Local compare-and-swap digest; NOT a native workflow-gate binding field. */
	answerBinding: string;
	authority: NativeUiQuestionAuthority;
	form: Json;
	workflow: {
		stage: "ralplan";
		kind: "approval";
		toolCallId: string;
		questionId: string;
		/** Native Ask arguments/event, not workflow classification from form text. */
		evidence: Json;
	};
	status: "pending" | "sent_unconfirmed";
}

export interface ApprovalConsumption {
	questionId: string;
	authority: NativeUiQuestionAuthority;
	toolCallId: string;
	/** Native tool completion; sending a response is not this receipt. */
	evidence: Json;
}

export interface ApprovalDiscovery {
	contract: ApprovalContract;
	sessionId: string;
	complete: boolean;
	questions: NativeWorkflowQuestion[];
	consumed: ApprovalConsumption[];
	/** Coverage/fail-closed explanation; never contains endpoint tokens. */
	evidence: Json;
}

export interface ApprovalAnswerDispatch {
	contract: ApprovalContract;
	questionId: string;
	authority: NativeUiQuestionAuthority;
	delivery: "sent_unconfirmed";
	consumption: "unproven";
}

export interface TaskApprovalChannel {
	readonly context: Readonly<ApprovalSessionContext>;
	/** Safe, serializable receipt for the original pre-prompt UI registration. */
	readonly receipt: Json;
	/** Associates the already accepted original Coordinator turn, not a native UI field. */
	bindTurn(turnId: string): void;
	discover(): Promise<ApprovalDiscovery>;
	/** Pure validation before the durable answer claim. */
	validateAnswer(question: NativeWorkflowQuestion, answer: Json): void;
	/** One send using the original native request/connection/lease capability. No retry. */
	answer(question: NativeWorkflowQuestion, answer: Json, operationKey: string): Promise<ApprovalAnswerDispatch>;
	/** Release only this channel's retained UI lease/connection; not session retirement. */
	close(): Promise<void>;
}

export interface TaskApprovalBackend {
	readonly contract: ApprovalContract;
	/** Called once after the attach intent is committed and before the prompt intent. */
	attach(context: Readonly<ApprovalSessionContext>, operationKey: string): Promise<TaskApprovalChannel>;
}

export interface FleetOptions {
	approvalBackends?: readonly TaskApprovalBackend[];
	/** Operator-asserted host identity; matching platform alone never grants locality. */
	localNodeId?: string;
	/** Fleet-local wall clock (ms) for observation spacing; defaults to Date.now. */
	clock?: () => number;
	/** Lane progress thresholds and read bounds (src/progress.ts PROGRESS_DEFAULTS). */
	progress?: Partial<ProgressConfig>;
}
