import { NodeConfig, OperationIntent, TaskInput, TaskRecord } from "../contracts";
import { ApprovalDiscovery, ApprovalSessionContext, FleetOptions, NativeWorkflowQuestion, TaskApprovalBackend, TaskApprovalChannel } from "../approval";
import { FleetStore } from "../store";
import { DiagnosticCondition, DiagnosticStep, FailureDiagnostic, conditionDiagnostic, failureDiagnostic } from "../diagnostic";
import { canonicalJson, demand, digest, nonemptyEvidence, validateTaskInput } from "../core";
import { nodeRpc } from "../rpc";
import { nodeOperation, oneShot } from "../node";
import { validateInputPackage } from "../inputs";
import { inputOptions } from "../work-unit";
import { ProgressConfig, progressConfig } from "../progress";

export abstract class FleetBase {
	protected readonly approvalBackends = new Map<string, TaskApprovalBackend>();

	protected readonly approvalChannels = new Map<string, TaskApprovalChannel>();

	protected readonly localNodeId?: string;

	protected readonly clock: () => number;

	readonly progressConfig: ProgressConfig;

	constructor(readonly store: FleetStore, options: FleetOptions = {}) {
		this.localNodeId = options.localNodeId;
		this.clock = options.clock ?? Date.now;
		this.progressConfig = progressConfig(options.progress);
		for (const backend of options.approvalBackends ?? []) {
			demand(backend.contract === "sdk-ui-waiter-v1" && !this.approvalBackends.has(backend.contract), "APPROVAL_CONTRACT", "Unsupported or duplicate approval backend");
			this.approvalBackends.set(backend.contract, backend);
		}
	}

	protected requireApprovalBackend(input: TaskInput) {
		if (input.approvalContract !== undefined)
			demand(this.approvalBackends.has(input.approvalContract), "APPROVAL_BACKEND_UNAVAILABLE", "Explicit approval backend is unavailable");
	}

	protected approvalContext(task: TaskRecord): ApprovalSessionContext {
		const authority = this.store.getOperation(task.id, "session-authority")?.payload as any;
		const create = this.store.getOperation(task.id, "create");
		demand(task.input.approvalContract === "sdk-ui-waiter-v1" && authority && create && authority.sessionId === task.sessionId && authority.cwd === (task.workspace as any)?.path, "APPROVAL_AUTHORITY", "Original session authority required");
		return Object.freeze({
			contract: task.input.approvalContract,
			taskId: task.id, attemptId: task.attemptId!, nodeId: task.nodeId!, inputDigest: task.inputDigest,
			sessionId: task.sessionId!, workspacePath: (task.workspace as any).path, createOperationId: create.id,
			sessionAuthority: Object.freeze({ sessionId: authority.sessionId, cwd: authority.cwd, endpointGeneration: authority.endpointGeneration, endpointIncarnation: authority.endpointIncarnation }),
		});
	}

	protected originalChannel(task: TaskRecord): TaskApprovalChannel {
		const channel = this.approvalChannels.get(task.id);
		const context = this.approvalContext(task);
		const claim = this.store.getOperation(task.id, "approval-attach");
		demand(channel && claim && canonicalJson(claim.payload) === canonicalJson(context) && canonicalJson(channel.context) === canonicalJson(context), "APPROVAL_CHANNEL_LOST", "Original live approval channel required; no reattachment");
		return channel;
	}

	protected async discoverApproval(task: TaskRecord): Promise<ApprovalDiscovery> {
		const channel = this.originalChannel(task);
		return this.validApprovalDiscovery(task, channel, await channel.discover(), false);
	}

	/**
	 * Local identity/binding validation of one original UI discovery. With `allowIncomplete`, an incomplete
	 * discovery of the exact original session is returned unvalidated so the caller reports it as a failed read;
	 * it is never applied.
	 */
	protected validApprovalDiscovery(task: TaskRecord, channel: TaskApprovalChannel, discovery: ApprovalDiscovery, allowIncomplete: boolean): ApprovalDiscovery {
		demand(discovery.contract === task.input.approvalContract && discovery.sessionId === task.sessionId, "APPROVAL_DISCOVERY", "Complete original UI discovery required");
		if (allowIncomplete && discovery.complete !== true) return discovery;
		demand(discovery.complete === true && Array.isArray(discovery.questions) && Array.isArray(discovery.consumed), "APPROVAL_DISCOVERY", "Complete original UI discovery required");
		const seen = new Set<string>();
		nonemptyEvidence(discovery.evidence);
		const validAuthority = (authority: NativeWorkflowQuestion["authority"]) => {
			demand(authority?.kind === "sdk_ui_waiter" && [authority.requestId, authority.connectionId, authority.leaseId, authority.attachmentAuthorityId].every(value => typeof value === "string" && value.trim().length > 0) && authority.endpointGeneration === channel.context.sessionAuthority.endpointGeneration, "APPROVAL_AUTHORITY", "Original native request authority required");
		};
		for (const question of discovery.questions) {
			validAuthority(question.authority);
			nonemptyEvidence(question.workflow?.evidence);
			demand(typeof question.questionId === "string" && question.questionId.length > 0 && !seen.has(question.questionId) && question.workflow?.stage === "ralplan" && question.workflow.kind === "approval" && question.workflow.questionId === question.questionId && typeof question.workflow.toolCallId === "string" && question.workflow.toolCallId.length > 0 && ["pending", "sent_unconfirmed"].includes(question.status) && question.answerBinding === digest({ context: channel.context, authority: question.authority, form: question.form, workflow: question.workflow, questionId: question.questionId }), "APPROVAL_BINDING", "Exact local UI CAS binding required");
			seen.add(question.questionId);
		}
		for (const consumed of discovery.consumed) {
			validAuthority(consumed.authority);
			nonemptyEvidence(consumed.evidence);
			demand(typeof consumed.questionId === "string" && consumed.questionId.length > 0 && typeof consumed.toolCallId === "string" && consumed.toolCallId.length > 0, "APPROVAL_CONSUMPTION", "Native tool completion evidence required");
		}
		return discovery;
	}

	async close(): Promise<void> {
		// Only retained UI capabilities are released; held attempts and SDK sessions remain owned.
		const channels = [...this.approvalChannels.values()];
		this.approvalChannels.clear();
		const results = await Promise.allSettled(channels.map(channel => channel.close()));
		const failed = results.find(result => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}

	/** Submit and admit. Pass measured `resources` to bound admission by node headroom (the CLI always does). */
	submit(input: TaskInput, resources?: Parameters<FleetStore["reserve"]>[1]) {
		validateTaskInput(input, inputOptions(this.store, input));
		this.requireApprovalBackend(input);
		if (input.inputPackage !== undefined)
			validateInputPackage(input.inputPackage);
		return this.store.reserve(this.store.submit(input).id, resources);
	}

	/** Operator diagnostic for a recorded failure. Never throws and never feeds a decision. */
	protected diagnose(error: unknown, step: DiagnosticStep): FailureDiagnostic | undefined {
		try {
			return failureDiagnostic(error, step);
		} catch {
			return undefined;
		}
	}

	/** Condition diagnostic (not caused by reading a thrown value). Never throws and never feeds a decision. */
	protected condition(step: DiagnosticStep, condition: DiagnosticCondition): FailureDiagnostic | undefined {
		try {
			return conditionDiagnostic(step, condition);
		} catch {
			return undefined;
		}
	}

	/** Diagnostic for an unknown state caused by an already retained claim, naming that claim when it can be read. */
	protected claimed(id: string, step: DiagnosticStep, kind: NonNullable<DiagnosticStep["operationKind"]>): FailureDiagnostic | undefined {
		let existing: OperationIntent | undefined;
		try {
			existing = this.store.getOperation(id, kind);
		} catch {
			// Diagnostic only: the claim is then not named, but the condition is still recorded.
		}
		try {
			return conditionDiagnostic(existing ? { ...step, operationKind: kind, operationId: existing.id } : step, "operation_already_claimed");
		} catch {
			return undefined;
		}
	}

	protected task(id: string) {
		const task = this.store.task(id);
		demand(
			task?.attemptId && task.nodeSnapshot,
			"NO_ATTEMPT",
			"Task must have an admitted attempt",
		);
		return task;
	}

	protected requireWorkspaceRoute(task: TaskRecord): void {
		const node = task.nodeSnapshot!;
		demand(node.workspaceTransport || (node.id === this.localNodeId && node.os === process.platform && node.arch === process.arch), "REMOTE_WORKSPACE_TRANSPORT_REQUIRED", "Explicit authenticated workspace route required before effect intent");
	}

	protected async node(task: TaskRecord, request: unknown) {
		this.requireWorkspaceRoute(task);
		const node = task.nodeSnapshot!;
		if (node.workspaceTransport)
			return oneShot(
				node.workspaceTransport.command,
				node.workspaceTransport.args,
				request,
			);
		return nodeOperation(node, request);
	}

	protected async connect(node: NodeConfig, required: string[]) {
		const rpc = nodeRpc(node);
		try {
			await rpc.initialize();
			const tools = await rpc.tools();
			for (const name of required)
				demand(
					tools.some((t) => t.name === name),
					"OPERATION_UNAVAILABLE",
					"Required Coordinator tool unavailable",
				);
			return rpc;
		} catch (error) {
			rpc.close();
			throw error;
		}
	}
}
