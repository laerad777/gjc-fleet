import { Json, TaskRecord, TaskState } from "../contracts";
import { ApprovalDiscovery } from "../approval";
import { FailureContext, FleetStore } from "../store";
import { DiagnosticStep, FailureDiagnostic, conditionDiagnostic } from "../diagnostic";
import { FleetError, canonicalJson, demand, digest, observationDigest } from "../core";
import { StdioRpc, TransportError } from "../rpc";
import { EXECUTION_FAILURE_REPORTED, LATE_RECEIPT_WINDOW_MS, ReceiptlessCandidate, confirmReceiptlessEnd, failedExecutionReceipt, failureReported, lateReceiptObservation, readExecution, receiptlessTurnEnd, settledExecution } from "../execution";
import { ProgressReading, ProgressRouteError, SessionReading, progressConfig, progressEligible, progressOrderToleranceMs, progressSessionLimit, readNodeProgress } from "../progress";
import { classifyReading, failureEvidence, lateReceiptBinding, lateReceiptWatched } from "./shared";
import { FleetExecution } from "./execution";

export abstract class FleetInspection extends FleetExecution {
	/**
	 * The single public exact-turn observation path. With `tolerateReadFailure`, only a failed read step
	 * (connect, read_turn, question/approval discovery, execution receipt) or an incomplete question
	 * reconciliation throws OBSERVATION_UNAVAILABLE instead of marking the attempt unknown: the task stays as it
	 * was and held, and the read is abandoned so it never supersedes a concurrent strict poll's failure.
	 * Identity/binding mismatches and local errors (including the original approval channel, authority and
	 * discovery binding checks) take the strict path in both modes. Settlement rules are
	 * identical in both modes. With `recordUnchanged: false` (the daemon), a read whose observation digest
	 * equals the one already applied writes no receipt and no audit row (see FleetStore.observe).
	 */
	async inspect(
		id: string,
		options: { tolerateReadFailure?: boolean; recordUnchanged?: boolean } = {},
	): Promise<{ task: TaskRecord; publicTurn?: unknown; questions?: unknown; lateReceipt?: unknown }> {
		const start = this.store.beginReconcileTiming();
		let outcome: "applied" | "stale" | "unknown" | "failed" | undefined;
		try {
			return await this.inspectSnapshot(id, options.tolerateReadFailure === true, options.recordUnchanged !== false, (value) => {
				outcome = value;
			});
		} catch (error) {
			if (outcome !== undefined) outcome = "failed";
			throw error;
		} finally {
			if (outcome) this.store.finishReconcileTiming(start, outcome);
		}
	}

	protected async inspectSnapshot(
		id: string,
		tolerateReadFailure: boolean,
		recordUnchanged: boolean,
		setOutcome: (
			value: "applied" | "stale" | "unknown" | "failed" | undefined,
		) => void,
	): Promise<{ task: TaskRecord; publicTurn?: unknown; questions?: unknown; lateReceipt?: unknown }> {
		const task = this.task(id);
		if (task.sessionId && task.turnId && lateReceiptWatched(task, this.clock()))
			return this.inspectLateReceipt(task);
		if (!task.sessionId || !task.turnId || task.result?.executionTerminal)
			return { task };
		setOutcome("failed");
		const pollSequence = this.store.beginObservation(id);
		if (pollSequence === null) {
			setOutcome(undefined);
			return { task: this.task(id) };
		}
		// Read after this poll was issued: every earlier applied poll is visible here,
		// and any earlier poll applied later becomes stale.
		const issued = this.task(id);
		let rpc: StdioRpc | undefined;
		let source: FailureContext["source"] | undefined = "Fleet.inspect.connect";
		// A local identity/binding check inside approval discovery keeps the discovery's evidence source but is
		// never a tolerable read failure.
		let localCheck = false;
		// Diagnostic step only; unlike `source` it is never cleared before the failure is recorded.
		let step: DiagnosticStep = { source: "Fleet.inspect.connect", phase: "call" };
		try {
			rpc = await this.connect(task.nodeSnapshot!, [
				"gjc_coordinator_read_turn",
				...(task.input.approvalContract ? [] : ["gjc_coordinator_list_questions"]),
			]);
			source = "Fleet.inspect.read_turn";
			step = { source: "Fleet.inspect.read_turn", phase: "call" };
			const turn = await rpc.call("gjc_coordinator_read_turn", {
				session_id: task.sessionId,
				turn_id: task.turnId,
			});
			source = undefined;
			step = { ...step, phase: "validate" };
			demand(
				turn.ok === true &&
					turn.turn?.session_id === task.sessionId &&
					turn.turn?.turn_id === task.turnId,
				"OBSERVATION_BINDING",
				"Exact turn observation required",
			);
			source = task.input.approvalContract ? "Fleet.inspect.approval_discovery" : "Fleet.inspect.list_questions";
			step = { source: task.input.approvalContract ? "Fleet.inspect.approval_discovery" : "Fleet.inspect.list_questions", phase: "call" };
			let questions: any;
			if (task.input.approvalContract) {
				localCheck = true;
				const channel = this.originalChannel(task);
				localCheck = false;
				const discovery = await channel.discover();
				localCheck = true;
				questions = this.validApprovalDiscovery(task, channel, discovery, tolerateReadFailure);
				localCheck = false;
			} else questions = await rpc.call("gjc_coordinator_list_questions", {
				session_id: task.sessionId,
				turn_id: task.turnId,
				status: "pending",
			});
			source = undefined;
			step = { ...step, phase: "validate" };
			const status = turn.turn.status;
			const questionsComplete =
				task.input.approvalContract ? questions.complete === true :
				questions.ok === true && questions.reconciliation?.complete === true && Array.isArray(questions.questions);
			const pendingQuestion =
				questionsComplete && questions.questions.length > 0;
			if (!questionsComplete) {
				if (tolerateReadFailure) {
					// An incomplete reconciliation is a failed discovery read, not a binding fault.
					source = task.input.approvalContract ? "Fleet.inspect.approval_discovery" : "Fleet.inspect.list_questions";
					throw new FleetError("OBSERVATION_UNAVAILABLE", "Incomplete question reconciliation");
				}
				const unknown = this.store.markObservationUnknown(
					id,
					pollSequence,
					"observation_unavailable_original_attempt_held",
					undefined,
					conditionDiagnostic(step, "questions_incomplete"),
				);
				setOutcome(unknown.pollIssued !== pollSequence ? "stale" : "unknown");
				return {
					task: unknown,
					publicTurn: turn,
					questions,
				};
			}
			// A metadata terminal is not an execution receipt. Require an acknowledged
			// nonqueued runtime turn plus a separate live SDK idle observation and exact
			// terminal sidecar identity. Missing proof keeps both slots held.
			const state = turn.session_state;
			let execution: unknown;
			const delivery = turn.turn.delivery;
			if (
				!pendingQuestion &&
				["completed", "failed"].includes(status) &&
				task.nodeSnapshot!.sdkTransport &&
				typeof delivery?.runtime_command_id === "string" &&
				delivery.runtime_command_id.trim().length > 0 &&
				typeof delivery.runtime_turn_id === "string" &&
				delivery.runtime_turn_id.trim().length > 0
			) {
				source = "Fleet.inspect.read_execution";
				step = { source: "Fleet.inspect.read_execution", phase: "call" };
				execution = await readExecution(
					task.nodeSnapshot!,
					task.sessionId,
					delivery.runtime_command_id,
					delivery.runtime_turn_id,
				);
				source = undefined;
			}
			step = { source: "Fleet.inspect.observe", phase: "validate" };
			const exactSettlement =
				execution !== undefined && settledExecution(execution);
			const sidecarLabels = [state?.current_turn_id, state?.last_turn_id];
			const sidecarBinding = sidecarLabels.every(
				(label) => label === null || label === undefined,
			)
				? exactSettlement
				: sidecarLabels.every(
						(label) =>
							label === null || label === undefined || label === task.turnId,
					);
			const terminal = Boolean(
				!pendingQuestion &&
					["completed", "failed"].includes(status) &&
					turn.turn.final_response?.source === "agent_end" &&
					turn.turn.delivery?.prompt_acknowledged === true &&
					turn.turn.delivery?.queued === false &&
					typeof turn.turn.delivery?.runtime_turn_id === "string" &&
					turn.turn.delivery.runtime_turn_id.trim().length > 0 &&
					turn.advisory_status?.authority === "sdk" &&
					turn.advisory_status?.live === true &&
					turn.advisory_status?.is_streaming === false &&
					state?.session_id === task.sessionId &&
					sidecarBinding &&
					(!task.nodeSnapshot!.sdkTransport || exactSettlement) &&
					["completed", "errored"].includes(state.state),
			);
			// No receipt: settle only when receiptlessTurnEnd proves the exact turn over on
			// two distinct polls spaced by the minimum interval. Never success.
			step = { source: "Fleet.inspect.receiptless", phase: "validate" };
			const receiptlessEnd =
				!terminal && !pendingQuestion && execution !== undefined
					? receiptlessTurnEnd(
							{ sessionId: task.sessionId, turnId: task.turnId },
							turn,
							execution,
						)
					: null;
			const receiptless: ReceiptlessCandidate | undefined = receiptlessEnd
				? confirmReceiptlessEnd(
						(issued.result?.evidence as any)?.receiptless,
						receiptlessEnd,
						pollSequence,
						this.clock(),
						issued.pollApplied,
					)
				: undefined;
			const settledWithoutReceipt = receiptless?.confirmed === true;
			// Evidence -> phase (README "Settlement evidence table"): a durable failed receipt of the exact
			// command settles as failed even without the success-oriented terminal predicate; a REPORTED
			// failure that nothing proves over stays held (provisional) with a visible reason; it is never failed.
			const failedWithReceipt =
				!pendingQuestion && !terminal && !settledWithoutReceipt &&
				["completed", "failed"].includes(status) &&
				execution !== undefined && failedExecutionReceipt(turn, execution);
			const reportedFailure =
				!pendingQuestion && !terminal && !settledWithoutReceipt && !failedWithReceipt &&
				["completed", "failed"].includes(status) && failureReported(turn, execution);
			step = { source: settledWithoutReceipt ? "Fleet.inspect.receiptless" : "Fleet.inspect.observe", phase: "validate" };
			const phase = pendingQuestion
				? "approval_required"
				: settledWithoutReceipt || failedWithReceipt
					? "failed"
				: terminal
					? status === "failed" || (execution as any)?.status === "failed"
						? "failed"
						: "completed_unverified"
					: ["completed", "failed", "cancelled", "superseded"].includes(status)
						? "completed_unverified"
						: "active";
			const body = {
				sessionId: task.sessionId,
				turnId: task.turnId,
				status: phase as any,
				terminal: terminal || settledWithoutReceipt || failedWithReceipt,
				evidence: {
					publicTurn: turn,
					questions,
					...(execution !== undefined ? { execution: execution as any } : {}),
					...(receiptless ? { receiptless: receiptless as any } : {}),
				},
				...(settledWithoutReceipt
					? {
							settlement: {
								kind: receiptless!.kind,
								receiptState: receiptless!.receiptState,
								cause: receiptless!.causeText,
								settledAt: new Date(receiptless!.observedAt).toISOString(),
								lateObservationUntil: new Date(
									receiptless!.observedAt + LATE_RECEIPT_WINDOW_MS,
								).toISOString(),
							},
						}
					: {}),
			};
			step = { ...step, phase: "record" };
			const observed = this.store.observe(
				id,
				{
					...body,
					eventId: task.attemptId + ":poll:" + pollSequence,
					digest: observationDigest(body),
				},
				pollSequence,
				recordUnchanged,
				reportedFailure ? EXECUTION_FAILURE_REPORTED : undefined,
			);
			setOutcome(
				observed.pollApplied !== pollSequence
					? "stale"
					: ["blocked_unknown", "cancel_unknown"].includes(observed.phase)
						? "unknown"
						: "applied",
			);
			return { task: observed, publicTurn: turn, questions };
		} catch (error) {
			setOutcome("failed");
			if (tolerateReadFailure && source !== undefined && !localCheck) {
				const kept = this.store.abandonObservation(
					id,
					pollSequence,
					failureEvidence(error, { source, errorType: "unclassified" }),
					this.diagnose(error, step),
				);
				// The durable task changed meanwhile (e.g. a strict poll failure deferred to this read is now
				// applied by abandonObservation): report that state instead of "unavailable".
				if (kept.phase !== task.phase) {
					setOutcome("unknown");
					return { task: kept };
				}
				throw new FleetError("OBSERVATION_UNAVAILABLE", "Exact observation unavailable; attempt unchanged and held");
			}
			const unknown = this.store.markObservationUnknown(
				id,
				pollSequence,
				"observation_unavailable_original_attempt_held",
				failureEvidence(
					error,
					source ? { source, errorType: "unclassified" } : undefined,
				),
				this.diagnose(error, step),
			);
			setOutcome(unknown.pollIssued !== pollSequence ? "stale" : "unknown");
			return {
				task: unknown,
			};
		} finally {
			rpc?.close();
		}
	}

	/**
	 * Lane progress for tasks in a progress phase (active, blocked_unknown) with a GJC session: ONE bounded,
	 * read-only command per node for all of its due sessions (src/progress.ts), each result persisted by
	 * store.recordProgress. Called by the existing observation paths (poll, watch, queue reconsider); it is not a
	 * loop of its own. A task read less than minIntervalSeconds ago is skipped, so overlapping callers share one
	 * durable rate limit; overlapping reads are ordered by their issue time and never touch poll sequences.
	 * A failed read records verdict unknown with a deny-by-default diagnostic and changes nothing else.
	 * With `settle` (default true) a finished_unobserved `active` task gets the normal tolerant observation
	 * (inspect) once per finished transcript state; a blocked_unknown task is never observed here. `settle` as
	 * an id list limits that observation to those tasks (every other task is read and displayed only). Nothing is
	 * ever killed, closed, resent or reassigned.
	 */
	async refreshProgress(
		ids?: readonly string[],
		options: { settle?: boolean | readonly string[] } = {},
	): Promise<Array<{ taskId: string; progress: NonNullable<TaskRecord["progress"]>; settled?: boolean }>> {
		if (!this.store.writable) return [];
		const config = this.progressConfig;
		const settleIds = typeof options.settle === "object" ? new Set(options.settle) : undefined;
		const settles = (id: string) => (settleIds ? settleIds.has(id) : options.settle !== false);
		const now = this.clock();
		// Only the named rows when ids are given (poll, single watch): never a scan of the whole tasks table.
		const candidates = ids ? [...new Set(ids)].map((id) => this.store.taskState(id)).filter((task): task is TaskState => task !== undefined) : this.store.taskStates();
		const due = candidates.filter((task) => {
			if (!progressEligible(task)) return false;
			const last = Date.parse(task.progress?.observedAt ?? "");
			// |elapsed|: a record from the hub's own future (clock stepped back) is rate-limited too, not read every poll.
			if (Number.isFinite(last) && Math.abs(now - last) < config.minIntervalSeconds * 1000) return false;
			// A stored read issued up to the order tolerance in the hub's future would win over this read
			// (store.recordProgress): not read until the clock passes it, so a step-back never reads every poll.
			const ahead = Date.parse(task.progress?.readStartedAt ?? "") - now;
			return !(ahead >= 0 && ahead <= progressOrderToleranceMs(config));
		});
		const groups = new Map<string, typeof due>();
		for (const task of due) {
			const node = task.nodeSnapshot!;
			const key = digest({ id: node.id, os: node.os, route: node.sdkTransport ?? node.transport });
			groups.set(key, [...(groups.get(key) ?? []), task]);
		}
		const recorded: Array<{ taskId: string; progress: NonNullable<TaskRecord["progress"]>; settle: boolean }> = [];
		await Promise.all(
			[...groups.values()].map(async (group) => {
				// Least recently read first, so sessions beyond the per-command limit are read next time.
				const batch = group
					.sort((a, b) => (a.progress?.observedAt ?? "").localeCompare(b.progress?.observedAt ?? ""))
					.slice(0, progressSessionLimit(group[0]!.nodeSnapshot!, config));
				const node = batch[0]!.nodeSnapshot!;
				const startedAt = this.clock();
				let reply: Map<string, SessionReading> | undefined;
				let failure: FailureDiagnostic | undefined;
				try {
					reply = await readNodeProgress(node, batch.map((task) => task.sessionId!), config);
				} catch (error) {
					failure =
						error instanceof ProgressRouteError
							? conditionDiagnostic({ source: "Fleet.progress.read", phase: "precondition" }, "progress_route_unavailable")
							: (this.diagnose(error, { source: "Fleet.progress.read", phase: error instanceof TransportError && error.code === "progress_reply_invalid" ? "validate" : "call" }) ??
								conditionDiagnostic({ source: "Fleet.progress.read", phase: "call" }, "progress_reply_invalid"));
				}
				const observedAt = this.clock();
				for (const task of batch) {
					const { reading, diagnostic } = reply
						? classifyReading(reply.get(task.sessionId!)!)
						: { reading: { ok: false } as ProgressReading, diagnostic: failure };
					try {
						const result = this.store.recordProgress(
							task.id,
							{ attemptId: task.attemptId!, sessionId: task.sessionId!, startedAt, observedAt, config },
							reading,
							diagnostic,
							{ settle: settles(task.id) },
						);
						if (result.recorded && result.progress) recorded.push({ taskId: task.id, progress: result.progress, settle: result.settle });
					} catch {
						// The store already audited its refusal; progress is display only.
						this.store.noteTelemetryFailure();
					}
				}
			}),
		);
		const out: Array<{ taskId: string; progress: NonNullable<TaskRecord["progress"]>; settled?: boolean }> = [];
		for (const entry of recorded) {
			if (!entry.settle || !settles(entry.taskId)) {
				out.push({ taskId: entry.taskId, progress: entry.progress });
				continue;
			}
			// The normal observation path, tolerant: a failed read leaves the task exactly as it was.
			let settled = false;
			try {
				const observed = await this.inspect(entry.taskId, { tolerateReadFailure: true });
				settled = observed.task.result?.executionTerminal === true;
			} catch {
				// OBSERVATION_UNAVAILABLE or a strict-path failure already recorded by inspect itself.
			}
			out.push({ taskId: entry.taskId, progress: entry.progress, settled });
		}
		return out;
	}

	/**
	 * Read-only late-receipt check of a receipt-less settled task (bounded window, see
	 * LATE_RECEIPT_WINDOW_MS). Reads only the exact turn and the exact original runtime
	 * command; records a genuine receipt as a contradiction and never changes finality.
	 */
	protected async inspectLateReceipt(
		task: TaskRecord,
	): Promise<{ task: TaskRecord; publicTurn?: unknown; lateReceipt?: unknown }> {
		const binding = lateReceiptBinding(task);
		let rpc: StdioRpc | undefined;
		let turn: any;
		try {
			rpc = await this.connect(task.nodeSnapshot!, ["gjc_coordinator_read_turn"]);
			turn = await rpc.call("gjc_coordinator_read_turn", {
				session_id: task.sessionId,
				turn_id: task.turnId,
			});
			const execution = await readExecution(
				task.nodeSnapshot!,
				binding.sessionId,
				binding.runtimeCommandId,
				binding.runtimeTurnId,
			);
			const late = lateReceiptObservation(binding, turn, execution);
			if (!late)
				return { task: this.task(task.id), publicTurn: turn, lateReceipt: { checked: true, found: false } };
			const recorded = this.store.recordLateReceipt(task.id, {
				...late,
				sessionId: binding.sessionId,
				turnId: binding.turnId,
				runtimeCommandId: binding.runtimeCommandId,
				runtimeTurnId: binding.runtimeTurnId,
				observedAt: new Date(this.clock()).toISOString(),
			});
			return { task: recorded, publicTurn: turn, lateReceipt: { checked: true, found: true } };
		} catch {
			// A failed read-only check (transport, binding, or a task that moved on, e.g.
			// archived concurrently) changes nothing; store refusals are already audited.
			return { task: this.task(task.id), ...(turn ? { publicTurn: turn } : {}), lateReceipt: { checked: false } };
		} finally {
			rpc?.close();
		}
	}

	async answer(
		id: string,
		request: { questionId: string; answerBinding: string; answer: Json; contract?: "sdk-ui-waiter-v1"; sessionId?: string; expectedTurnId?: string },
	): Promise<unknown> {
		const task = this.task(id);
		demand(
			task.phase === "approval_required" && task.sessionId && task.turnId,
			"APPROVAL_BLOCKED",
			"Discover current bound workflow question before answering",
		);
		this.store.assertDispatchEnabled();
		if (task.input.approvalContract) {
			// expectedTurnId is the caller's Fleet CAS, never a field of the native UI form.
			demand(request.contract === task.input.approvalContract && request.sessionId === task.sessionId && request.expectedTurnId === task.turnId, "APPROVAL_BINDING", "Selected contract, session and original caller expectedTurnId required");
			let discovery: ApprovalDiscovery;
			try { discovery = await this.discoverApproval(task); }
			catch (error) {
				this.store.markUnknown(id, "approval_discovery_unknown_original_attempt_held", undefined, this.diagnose(error, { source: "Fleet.answer.discovery", phase: "call" }));
				throw error;
			}
			const question = discovery.questions.find(row => row.questionId === request.questionId && row.answerBinding === request.answerBinding && row.status === "pending");
			demand(question, "APPROVAL_BINDING", "Missing or stale local UI binding");
			const channel = this.originalChannel(task);
			channel.validateAnswer(question, request.answer);
			const payload = { contract: request.contract, sessionId: task.sessionId, expectedTurnId: task.turnId, questionId: question.questionId, answerBinding: question.answerBinding, authority: question.authority, context: channel.context, form: question.form, workflow: question.workflow, answer: request.answer };
			const op = this.store.claimOperation(id, "answer:" + question.questionId, payload as unknown as Json);
			if (!op) throw new Error("answer_already_sent_reconcile_consumption");
			let step: DiagnosticStep = { source: "Fleet.answer.submit", phase: "call", operationKind: "answer", operationId: op.id };
			try {
				const dispatch = await channel.answer(question, request.answer, op.key);
				step = { ...step, phase: "validate" };
				demand(dispatch.contract === request.contract && dispatch.questionId === question.questionId && canonicalJson(dispatch.authority) === canonicalJson(question.authority) && dispatch.delivery === "sent_unconfirmed" && dispatch.consumption === "unproven", "APPROVAL_DISPATCH", "UI send is not proof of consumption");
				return dispatch;
			} catch (error) {
				this.store.markUnknown(id, "answer_consumption_unknown_no_replay", { source: "Fleet.answer.submit", errorType: "unclassified", operationKind: "answer", operationId: op.id, operationKey: op.key, payloadDigest: op.digest }, this.diagnose(error, step));
				throw error;
			}
		}
		const rpc = await this.connect(task.nodeSnapshot!, [
			"gjc_coordinator_list_questions",
			"gjc_coordinator_submit_question_answer",
		]);
		try {
			const current = await rpc.call("gjc_coordinator_list_questions", {
				session_id: task.sessionId,
				turn_id: task.turnId,
				status: "pending",
			});
			demand(
				current.ok === true && current.reconciliation?.complete === true,
				"APPROVAL_TRANSPORT",
				"Incomplete question discovery is not approval",
			);
			const row = current.questions?.find(
				(q: any) =>
					q.question_id === request.questionId &&
					q.answer_binding === request.answerBinding &&
					q.session_id === task.sessionId &&
					q.turn_id === task.turnId,
			);
			demand(
				row && row.answer_schema,
				"APPROVAL_BINDING",
				"Missing or stale workflow binding; generic ask.answer is never substituted",
			);
			const args = {
				session_id: task.sessionId,
				turn_id: task.turnId,
				question_id: request.questionId,
				answer_binding: request.answerBinding,
				answer: request.answer,
				allow_mutation: true,
			};
			const op = this.store.claimOperation(
				id,
				"answer:" + request.questionId,
				args,
			);
			if (!op) throw new Error("answer_already_sent_reconcile_consumption");
			try {
				return await rpc.call("gjc_coordinator_submit_question_answer", {
					...args,
					idempotency_key: op.key,
				});
			} catch (error) {
				this.store.markUnknown(id, "answer_consumption_unknown_no_replay", {
					source: "Fleet.answer.submit",
					errorType:
						error instanceof TransportError
							? "transport_error"
							: "unclassified",
					...(error instanceof TransportError
						? { certainty: error.certainty }
						: {}),
					operationKind: "answer",
					operationId: op.id,
					operationKey: op.key,
					payloadDigest: op.digest,
				}, this.diagnose(error, { source: "Fleet.answer.submit", phase: "call", operationKind: "answer", operationId: op.id }));
				throw new Error("answer_consumption_unknown_no_replay");
			}
		} finally {
			rpc.close();
		}
	}

	/**
	 * Operator-driven, audited acceptance of a recorded late terminal_ok receipt. The
	 * receipt is re-proven on a fresh exact read, then the task goes to
	 * completed_unverified for the NORMAL verifier (`result(id, argv)`). Never success.
	 */
	async acceptLateReceipt(id: string, request: { reason: string }, actor = "operator"): Promise<TaskRecord> {
		const task = this.task(id);
		demand(task.phase !== "archived", "ARCHIVED_TASK", "Archived tasks are never re-observed or accepted");
		demand(typeof request?.reason === "string" && request.reason.trim().length > 0, "INVALID_INPUT", "Audited operator reason required");
		if (task.result?.lateReceipt?.acceptance) return this.store.acceptLateReceipt(id, { actor, reason: request.reason, digest: task.result.lateReceipt.digest, evidence: task.result.evidence });
		demand(
			task.phase === "failed" && task.result?.settlement && task.result.lateReceipt?.status === "terminal_ok" && task.sessionId && task.turnId,
			"LATE_RECEIPT_STATE",
			"Only a recorded late terminal_ok receipt of a receipt-less failed settlement can be accepted",
		);
		const binding = lateReceiptBinding(task);
		const rpc = await this.connect(task.nodeSnapshot!, ["gjc_coordinator_read_turn"]);
		let turn: any;
		try {
			turn = await rpc.call("gjc_coordinator_read_turn", { session_id: task.sessionId, turn_id: task.turnId });
		} finally {
			rpc.close();
		}
		const execution = await readExecution(task.nodeSnapshot!, binding.sessionId, binding.runtimeCommandId, binding.runtimeTurnId);
		const late = lateReceiptObservation(binding, turn, execution);
		demand(late?.status === "terminal_ok", "LATE_RECEIPT_CHANGED", "Fresh exact read no longer shows a genuine terminal_ok receipt");
		return this.store.acceptLateReceipt(id, {
			actor,
			reason: request.reason,
			digest: late!.digest,
			evidence: { publicTurn: turn, execution: execution as Json, acceptedLateReceipt: true },
		});
	}
}
