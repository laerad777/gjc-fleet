import { Json, OperationIntent, TaskRecord } from "../contracts";
import { FailureContext } from "../store";
import { DiagnosticStep, FailureDiagnostic, conditionDiagnostic } from "../diagnostic";
import { FleetError, canonicalJson, demand, digest, observationDigest, validateTaskInput } from "../core";
import { TransportError, classifyCreateRefusal } from "../rpc";
import { NodeReplyError, PREFLIGHT_PASSED } from "../node";
import { discoverOrdinary } from "../ordinary";
import { abortOwnedSession, closeOwnedSession, readSessionAuthority } from "../execution";
import { inputOptions, isRoleTask } from "../work-unit";
import { WorkspaceIdentity } from "../workspace";
import { failureEvidence, lateReceiptWatched, transportCode } from "./shared";
import { FleetBase } from "./base";

/**
 * Tasks whose cancellation this process admitted and has not returned from yet, per store. Only this is
 * proof that a cancellation is still in progress: a duplicate call then gets CANCEL_PENDING and changes
 * nothing. Without it (another process, a crash, a call after the first returned) the retained path below
 * keeps the reservation held exactly as before.
 */
const cancelsInFlight = new WeakMap<object, Set<string>>();
function inFlight(store: object): Set<string> {
	let set = cancelsInFlight.get(store);
	if (!set) cancelsInFlight.set(store, (set = new Set()));
	return set;
}

export abstract class FleetExecution extends FleetBase {
	async start(id: string): Promise<TaskRecord> {
		let task = this.task(id);
		const ended =
			task.phase === "blocked_unknown" ||
			task.phase === "cancel_unknown" ||
			task.result?.executionTerminal;
		// An admitted role task that already ended is returned as is, whatever the work-unit switch is now.
		if (!(ended && isRoleTask(task)))
			validateTaskInput(task.input, inputOptions(this.store, task.input));
		this.requireApprovalBackend(task.input);
		if (ended) return task;
		let failureContext: FailureContext | undefined;
		let retainedRefusal: FleetError | undefined;
		// Diagnostic step only: advanced before each action and never cleared, so the step that
		// failed is recorded even after failureContext is cleared for a completed call.
		let step: DiagnosticStep = { source: "Fleet.start.prepare", phase: "precondition" };
		try {
			this.store.assertDispatchEnabled();
			if (!task.workspace) {
				this.requireWorkspaceRoute(task);
				// Only a held, still-retained proven before_send refusal of the current attempt is
				// re-evaluated. Archived, released, unknown or otherwise changed tasks take the base
				// path, which never dispatches for them; no preflight reaches their node.
				const refused = this.store.retainedPreparationRefusal(id);
				if (refused) {
					// Send-time admission: the preflight carries the input package. Nothing awaits between
					// this check and the spawn of the preflight request. (A new prepare claim checks the same
					// atomically; an existing uncertain claim is never sent again, whatever the node state.)
					this.store.assertNodeAdmissible(id);
					// The helper proved this preparation ran nothing. Re-run only its side-effect-free
					// preflight; the refused claim itself is never replayed.
					const outcome = await this.reevaluatePreparation(task, refused);
					if (outcome) throw (retainedRefusal = outcome);
					task = this.store.renewRefusedPreparation(id, refused.id);
				}
				const input = {
					taskId: id,
					attemptId: task.attemptId!,
					nodeId: task.nodeId!,
					inputDigest: task.inputDigest,
					repoId: task.input.repoId,
					baseCommit: task.input.baseCommit,
					...(task.input.inputPackage
						? { inputPackage: task.input.inputPackage as any }
						: {}),
					// Work-unit R7: the node refuses before any effect a base tree that tracks fleet-review/.
					...(isRoleTask(task) ? { reviewDirAbsent: true as const } : {}),
					// Work-unit review: the node refuses before any effect unless this branch's head is baseCommit.
					...(task.input.workUnit?.role === "review" ? { reviewBranch: task.input.workUnit.subject.branch } : {}),
				};
				step = { source: "Fleet.start.prepare", phase: "claim" };
				const op = this.store.claimOperation(id, "prepare", input);
				if (!op)
					return this.store.markUnknown(
						id,
						"preparation_inflight_or_unknown_no_replay",
						undefined,
						this.claimed(id, step, "prepare"),
					);
				step = { source: "Fleet.start.prepare", phase: "call", operationKind: "prepare", operationId: op.id };
				failureContext = {
					source: "Fleet.start.prepare",
					errorType: "unclassified",
					operationKind: "prepare",
					operationId: op.id,
					operationKey: op.key,
					payloadDigest: op.digest,
				};
				const workspace = (await this.node(task, {
					action: "prepare",
					input,
				})) as WorkspaceIdentity;
				failureContext = undefined;
				step = { ...step, phase: "validate" };
				demand(
					workspace.taskId === id &&
						workspace.attemptId === task.attemptId &&
						workspace.nodeId === task.nodeId &&
						workspace.inputDigest === task.inputDigest &&
						workspace.baseCommit === task.input.baseCommit &&
						workspace.inputPackageDigest === task.input.inputPackage?.digest,
					"WORKSPACE_BINDING",
					"Prepared input identity mismatch",
				);
				step = { ...step, phase: "record" };
				task = this.store.setWorkspace(id, workspace as any);
			}
			const workspace = task.workspace as unknown as WorkspaceIdentity;
			step = { source: "Fleet.start.connect", phase: "precondition" };
			this.store.assertDispatchEnabled();
			step = { source: "Fleet.start.connect", phase: "call" };
			failureContext = {
				source: "Fleet.start.connect",
				errorType: "unclassified",
			};
			const rpc = await this.connect(task.nodeSnapshot!, [
				...(!task.sessionId ? ["gjc_coordinator_start_session"] : []),
				...(!task.turnId ? ["gjc_coordinator_send_prompt"] : []),
			]);
			failureContext = undefined;
			try {
				if (!task.sessionId) {
					const args = {
						cwd: workspace.path,
						allow_mutation: true,
						...(task.input.required.modelProfile
							? { mpreset: task.input.required.modelProfile }
							: {}),
						...(task.input.required.model
							? { model: task.input.required.model }
							: {}),
					};
					step = { source: "Fleet.start.create", phase: "claim" };
					const op = this.store.claimOperation(id, "create", args);
					if (!op)
						return this.store.markUnknown(
							id,
							"create_response_unavailable_no_readonly_key_lookup",
							undefined,
							this.claimed(id, step, "create"),
						);
					step = { source: "Fleet.start.create", phase: "call", operationKind: "create", operationId: op.id };
					failureContext = {
						source: "Fleet.start.create",
						errorType: "unclassified",
						operationKind: "create",
						operationId: op.id,
						operationKey: op.key,
						payloadDigest: op.digest,
					};
					const response = await rpc.call("gjc_coordinator_start_session", {
						...args,
						idempotency_key: op.key,
					});
					failureContext = undefined;
					step = { ...step, phase: "validate" };
					demand(
						response.ok === true &&
							typeof response.session?.session_id === "string",
						"CREATE_UNCONFIRMED",
						"Creation not confirmed",
					);
					step = { ...step, phase: "record" };
					task = this.store.recordSession(
						id,
						response.session.session_id,
						response.session.cwd === workspace.path,
						{
							operationId: op.id,
							ephemeral: response.session.ephemeral === true,
							cwd: response.session.cwd,
						},
					);
				}
				step = { source: "Fleet.start.create", phase: "validate" };
				demand(
					task.sessionValidated === true,
					"CWD_MISMATCH",
					"Node creation cwd was not validated; prompt blocked",
				);
				if (!task.turnId) {
					step = { source: "Fleet.start.authority", phase: "precondition" };
					const owner = this.store.getOperation(id, "session-ownership");
					if (
						((owner?.payload as any)?.retirementRoute ===
							"sdk-session-close-v1" || task.input.approvalContract !== undefined) &&
						!this.store.getOperation(id, "session-authority")
					) {
						demand(
							!this.store.getOperation(id, "prompt"),
							"AUTHORITY_CONFLICT",
							"Cannot capture original authority after prompt intent",
						);
						step = { source: "Fleet.start.authority", phase: "call" };
						failureContext = {
							source: "Fleet.start.authority",
							errorType: "unclassified",
						};
						const authority = await readSessionAuthority(
							task.nodeSnapshot!,
							task.sessionId!,
							workspace.path,
						);
						failureContext = undefined;
						step = { source: "Fleet.start.authority", phase: "record" };
						this.store.recordSessionAuthority(id, authority);
					}
					if (task.input.approvalContract) {
						step = { source: "Fleet.start.approval_attach", phase: "precondition" };
						const context = this.approvalContext(task);
						if (!this.approvalChannels.has(id)) {
							demand(!this.store.getOperation(id, "prompt"), "APPROVAL_CHANNEL_LOST", "Cannot attach after original prompt intent");
							this.store.assertDispatchEnabled();
							step = { source: "Fleet.start.approval_attach", phase: "claim" };
							const attach = this.store.claimOperation(id, "approval-attach", context as unknown as Json);
							if (!attach) return this.store.markUnknown(id, "approval_channel_lost_no_reattach", undefined, this.claimed(id, step, "approval-attach"));
							step = { source: "Fleet.start.approval_attach", phase: "call", operationKind: "approval-attach", operationId: attach.id };
							failureContext = { source: "Fleet.start.approval_attach", errorType: "unclassified", operationKind: "approval-attach", operationId: attach.id, operationKey: attach.key, payloadDigest: attach.digest };
							const channel = await this.approvalBackends.get(task.input.approvalContract)!.attach(context, attach.key);
							step = { ...step, phase: "record" };
							this.approvalChannels.set(id, channel);
							this.originalChannel(task);
							this.store.recordOperationReceipt(id, "approval-attach", attach.id, channel.receipt);
							failureContext = undefined;
						} else {
							step = { source: "Fleet.start.approval_attach", phase: "validate" };
							this.originalChannel(task);
						}
					}
					const args = {
						session_id: task.sessionId!,
						prompt: task.input.prompt,
						allow_mutation: true,
					};
					step = { source: "Fleet.start.prompt", phase: "claim" };
					const op = this.store.claimOperation(id, "prompt", args);
					if (!op)
						return this.store.markUnknown(
							id,
							"prompt_response_unavailable_no_readonly_key_lookup",
							undefined,
							this.claimed(id, step, "prompt"),
						);
					step = { source: "Fleet.start.prompt", phase: "call", operationKind: "prompt", operationId: op.id };
					failureContext = {
						source: "Fleet.start.prompt",
						errorType: "unclassified",
						operationKind: "prompt",
						operationId: op.id,
						operationKey: op.key,
						payloadDigest: op.digest,
					};
					const response = await rpc.call("gjc_coordinator_send_prompt", {
						...args,
						idempotency_key: op.key,
					});
					failureContext = undefined;
					step = { ...step, phase: "validate" };
					demand(
						response.ok === true &&
							response.session_id === task.sessionId &&
							typeof response.turn_id === "string",
						"TURN_UNCONFIRMED",
						"Prompt acceptance not confirmed",
					);
					step = { ...step, phase: "record" };
					task = this.store.recordTurn(id, response.turn_id);
					if (task.input.approvalContract) this.originalChannel(task).bindTurn(task.turnId!);
					const body = {
						sessionId: task.sessionId!,
						turnId: task.turnId!,
						status: "active" as const,
						terminal: false,
						evidence: {
							delivered: response.delivered === true,
							accepted: true,
							consumed: "unproven",
						},
					};
					task = this.store.observe(id, {
						...body,
						eventId: op.id + ":accepted",
						digest: observationDigest(body),
					});
				}
				if (task.input.approvalContract) {
					step = { source: "Fleet.start.approval_attach", phase: "validate" };
					this.originalChannel(task);
				}
				return task;
			} finally {
				try {
					rpc.close();
				} catch (closeError) {
					// Diagnostic step only: a failing close is not a failure of the last step.
					step = { source: "Fleet.start.close", phase: "call" };
					throw closeError;
				}
			}
		} catch (error) {
			if (error instanceof FleetError && (error.code === "DISPATCH_DISABLED" || error.code === "NODE_NOT_ADMISSIBLE"))
				throw error;
			// Nothing effectful was dispatched while re-evaluating; the original attempt stays held.
			if (error === retainedRefusal) throw error;
			if (error instanceof NodeReplyError && error.certainty === "before_send") {
				if (failureContext?.operationKind === "prepare" && failureContext.operationId)
					this.store.recordOperationReceipt(id, "prepare", failureContext.operationId, { nodeRefusal: error.reply } as any);
				this.store.recordResultValidationRejected(id, error.code, this.diagnose(error, step));
				throw new FleetError(error.code, error.code);
			}
			// A create refusal that proves no session exists settles the attempt as failed before any effect.
			if (
				failureContext?.source === "Fleet.start.create" &&
				failureContext.operationKind === "create" &&
				failureContext.operationId &&
				error instanceof TransportError &&
				classifyCreateRefusal(error).class === "failed_before_effect"
			) {
				const settled = this.store.settleCreateRefusal(
					id,
					failureContext.operationId,
					error.code,
					this.condition(step, "create_refused_before_effect"),
				);
				if (settled) return settled;
			}
			return this.store.markUnknown(
				id,
				error instanceof TransportError
					? transportCode(error, "transport_error")
					: "node_operation_failed_original_attempt_held",
				failureEvidence(error, failureContext),
				this.diagnose(error, step),
			);
		}
	}

	/**
	 * Side-effect-free re-check of a retained before_send preparation refusal. Returns the error to
	 * surface while the cause persists or cannot be re-checked (audited; the attempt stays held and
	 * nothing is claimed), or undefined once the preflight passed.
	 */
	protected async reevaluatePreparation(
		task: TaskRecord,
		refused: OperationIntent,
	): Promise<FleetError | undefined> {
		let code = "preflight_reply_invalid";
		let outcome: "still_refused" | "unavailable" = "unavailable";
		const step: DiagnosticStep = { source: "Fleet.start.preflight", phase: "call", operationKind: "prepare", operationId: refused.id };
		let diagnostic = conditionDiagnostic(step, "preflight_reply_invalid") as FailureDiagnostic | undefined;
		try {
			const value = await this.node(task, {
				action: "preflight",
				input: refused.payload,
			});
			if (canonicalJson(value) === canonicalJson(PREFLIGHT_PASSED))
				return undefined;
		} catch (error) {
			const observed = transportCode(error, "node_transport_failed");
			code = /^node_/.test(observed) ? observed : "node_transport_failed";
			diagnostic = this.diagnose(error, step);
			// A helper without `preflight` refuses the unknown action as invalid_request. Unless the retained
			// refusal was itself invalid_request, that is a protocol mismatch (unavailable), not the old cause.
			const protocolMismatch =
				error instanceof NodeReplyError &&
				error.reply.error === "invalid_request" &&
				(refused.receipt as any)?.nodeRefusal?.error !== "invalid_request";
			if (error instanceof NodeReplyError && error.certainty === "before_send" && !protocolMismatch) {
				outcome = "still_refused";
				this.store.recordResultValidationRejected(task.id, code, diagnostic);
			}
		}
		this.store.recordPreparationReevaluation(task.id, refused.id, outcome, code, diagnostic);
		return new FleetError(code, code);
	}

	/**
	 * Read-only reachability check of the Coordinator an observation of this task would read: the same
	 * connection and tool catalog as inspect, then closed. It issues no poll sequence and writes nothing (the
	 * daemon's gate before a new poll of a node in failure backoff).
	 */
	async observationReachable(id: string): Promise<void> {
		const task = this.task(id);
		const late = lateReceiptWatched(task, this.clock());
		const rpc = await this.connect(task.nodeSnapshot!, [
			"gjc_coordinator_read_turn",
			...(late || task.input.approvalContract ? [] : ["gjc_coordinator_list_questions"]),
		]);
		rpc.close();
	}

	async cancel(id: string): Promise<unknown> {
		const task = this.task(id);
		demand(
			!(inFlight(this.store).has(id) && this.store.getOperation(id, "cancel")),
			"CANCEL_PENDING",
			"This process is still settling the admitted cancellation of this task",
		);
		if (this.store.getOperation(id, "cancel")) {
			const retained = task.held
				? this.store.cancellationUnknown(
						id,
						task.reason?.startsWith("cancel_transport_failure:")
							? task.reason
							: "cancel_outcome_unknown_no_replay",
						undefined,
						this.claimed(id, { source: "Fleet.cancel.abort", phase: "claim" }, "cancel"),
					)
				: task;
			return {
				ok: retained.phase === "cancelled" && !retained.held,
				task: retained,
				abort: this.store.getOperation(id, "cancel-abort-reply")?.payload,
				close: this.store.getOperation(id, "cancel-close-reply")?.payload,
			};
		}
		this.store.assertDispatchEnabled();
		this.store.cancellationOwnership(id);
		demand(
			task.held &&
				["active", "approval_required"].includes(task.phase) &&
				!task.result?.executionTerminal,
			"CANCEL_BLOCKED",
			"Only a current active exclusively owned session can be cancelled",
		);
		const snapshot = await this.inspect(id);
		const current = snapshot.task;
		const publicTurn = snapshot.publicTurn as any;
		demand(
			current.held &&
				["active", "approval_required"].includes(current.phase) &&
				publicTurn?.turn?.session_id === task.sessionId &&
				publicTurn.turn.turn_id === task.turnId &&
				publicTurn.advisory_status?.authority === "sdk" &&
				publicTurn.advisory_status.live === true &&
				!["completed", "failed", "cancelled", "superseded"].includes(
					publicTurn.turn.status,
				) &&
				publicTurn.session_state?.session_id === task.sessionId &&
				[
					publicTurn.session_state.current_turn_id,
					publicTurn.session_state.last_turn_id,
				].every(
					(label) =>
						label === null || label === undefined || label === task.turnId,
				),
			"CANCEL_BLOCKED",
			"Fresh public execution must still match the active owned session",
		);
		const authority = await readSessionAuthority(
			task.nodeSnapshot!,
			task.sessionId!,
			(task.workspace as any).path,
		);
		const op = this.store.admitCancellation(id, task, authority);
		inFlight(this.store).add(id);
		try {
			return await this.settleCancellation(id, task, op, authority);
		} finally {
			inFlight(this.store).delete(id);
		}
	}

	private async settleCancellation(
		id: string,
		task: TaskRecord,
		op: OperationIntent,
		authority: Awaited<ReturnType<typeof readSessionAuthority>>,
	): Promise<unknown> {
		let failureContext: FailureContext | undefined = {
			source: "Fleet.cancel.abort",
			errorType: "unclassified",
			operationKind: "cancel",
			operationId: op.id,
			operationKey: op.key,
			payloadDigest: op.digest,
		};
		let stage: "abort" | "close" = "abort";
		// Diagnostic step only; never cleared before the failure is recorded.
		let step: DiagnosticStep = { source: "Fleet.cancel.abort", phase: "call", operationKind: "cancel", operationId: op.id };
		try {
			const abort = await abortOwnedSession(
				task.nodeSnapshot!,
				task.sessionId!,
				op.key,
			);
			failureContext = undefined;
			step = { ...step, phase: "record" };
			this.store.retainCancellationReply(id, "abort", abort as Json);
			step = { source: "Fleet.cancel.close", phase: "claim" };
			const close = this.store.claimCancellationClose(id, abort as Json);
			stage = "close";
			step = { source: "Fleet.cancel.close", phase: "call", operationKind: "cancel-close", operationId: close.id };
			failureContext = {
				source: "Fleet.cancel.close",
				errorType: "unclassified",
				operationKind: "cancel-close",
				operationId: close.id,
				operationKey: close.key,
				payloadDigest: close.digest,
			};
			const receipt = await closeOwnedSession(
				task.nodeSnapshot!,
				{ ...(close.payload as any), cwd: authority.cwd },
				close.key,
			);
			failureContext = undefined;
			step = { ...step, phase: "record" };
			this.store.retainCancellationReply(id, "close", receipt as Json);
			const settled = this.store.finishCancellation(id, receipt as Json);
			return { ok: true, abort, close: receipt, task: settled };
		} catch (error) {
			if (error instanceof FleetError && error.code === "DISPATCH_DISABLED") {
				// Rollback began after the abort reply was retained but before close was claimed: the turn
				// may already be stopped, so the task must not stay active. Record cancel_unknown (held, no
				// release) and send no close; the operator reconciles it.
				if (
					stage === "abort" &&
					this.store.getOperation(id, "cancel-abort-reply") &&
					!this.store.getOperation(id, "cancel-close")
				)
					this.store.cancellationUnknown(
						id,
						"cancel_transport_failure:close:before_send:dispatch_disabled",
						undefined,
						this.diagnose(error, step),
					);
				throw error;
			}
			const refusal =
				error instanceof TransportError && error.publicResponse !== undefined;
			if (refusal && !this.store.getOperation(id, `cancel-${stage}-reply`))
				this.store.retainCancellationReply(
					id,
					stage,
					error.publicResponse as Json,
				);
			const noReply = !this.store.getOperation(
				id,
				stage === "abort" ? "cancel-abort-reply" : "cancel-close-reply",
			);
			const code =
				error instanceof TransportError &&
				/^[a-zA-Z0-9_:.-]{1,160}$/.test(error.code)
					? error.code
					: "cancellation_operation_failed";
			const certainty =
				error instanceof TransportError ? error.certainty : "unknown";
			const reason = noReply
				? `cancel_transport_failure:${stage}:${certainty === "before_send" ? "before_send" : "unknown"}:${transportCode(error, "cancellation_operation_failed")}`
				: "cancel_outcome_unknown_no_replay";
			return {
				ok: false,
				task: this.store.cancellationUnknown(
					id,
					reason,
					failureEvidence(error, failureContext),
					this.diagnose(error, step),
				),
				...(noReply ? { transportFailure: { stage, code, certainty } } : {}),
				abort: this.store.getOperation(id, "cancel-abort-reply")?.payload,
				close: this.store.getOperation(id, "cancel-close-reply")?.payload,
			};
		}
	}

	async ordinary(id: string) {
		const task = this.task(id);
		demand(
			task.nodeSnapshot?.sdkTransport && task.sessionId && task.turnId,
			"ORDINARY_TRANSPORT",
			"Explicit existing SDK CLI transport and exact execution identity required",
		);
		const snapshot = await this.inspect(id);
		const turn = (snapshot.publicTurn as any)?.turn;
		demand(
			turn?.session_id === task.sessionId &&
				turn?.turn_id === task.turnId &&
				typeof turn.delivery?.runtime_turn_id === "string" &&
				turn.delivery.runtime_turn_id.length > 0,
			"ORDINARY_BINDING",
			"Exact public runtime-turn identity unavailable; ordinary answer authority is not inferred",
		);
		return discoverOrdinary(task.nodeSnapshot.sdkTransport, {
			sessionId: task.sessionId,
			coordinatorTurnId: task.turnId,
			runtimeTurnId: turn.delivery.runtime_turn_id,
		});
	}

	async stop(id: string): Promise<unknown> {
		const task = this.task(id);
		demand(
			task.result?.executionTerminal && task.sessionId,
			"STOP_BLOCKED",
			"Only a proven settled task-owned ephemeral session can be stopped",
		);
		const args = {
			session_id: task.sessionId,
			allow_mutation: true,
			reason: "Fleet task execution settled",
		};
		const stopped = "Stop was already requested; inspect original session, never force-close";
		demand(!this.store.getOperation(id, "stop"), "STOP_UNKNOWN", stopped);
		this.store.assertDispatchEnabled();
		// The once-only claim depends on a connected Coordinator exposing the stop tool: verify that
		// first, so an unreachable Coordinator leaves no claim behind. Nothing awaits between the
		// claim and the write of the stop request.
		const rpc = await this.connect(task.nodeSnapshot!, [
			"gjc_coordinator_stop_session",
		]);
		try {
			if (!rpc.open) throw new TransportError("transport_closed", "before_send");
			const op = this.store.claimOperation(id, "stop", args);
			demand(op, "STOP_UNKNOWN", stopped);
			return await rpc.call("gjc_coordinator_stop_session", args);
		} finally {
			rpc.close();
		}
	}

	// Implemented by later classes in the chain
	protected abstract inspect(id?: string, options?: { tolerateReadFailure?: boolean; recordUnchanged?: boolean }): Promise<{ task: TaskRecord; publicTurn?: unknown; questions?: unknown; lateReceipt?: unknown }>;
}
