import { AuditEvent, Json, LateReceipt, Observation, TaskProgress, TaskRecord } from "../contracts";
import { canonicalJson, demand, digest, nonemptyEvidence, object, receiptlessUnverifiable, text, validateObservation } from "../core";
import { FailureDiagnostic, failureDiagnostic, normalizeDiagnostic } from "../diagnostic";
import { EXECUTION_FAILURE_REPORTED } from "../execution";
import { PROGRESS_EPISODE_COALESCE_SECONDS, PROGRESS_PHASES, ProgressRead, ProgressReading, progressHint, progressOrderToleranceMs, progressVerdict } from "../progress";
import { DataRow, FailureContext, VERIFICATION_CONFLICT_REASON, VERIFICATION_OUTCOME_UNKNOWN_REASON, VERIFICATION_RECORDED_REQUESTS, VERIFICATION_RETAINED_DIGESTS, exportReviewDigest, heldResultTest, subjectDescribesStored, storedExport } from "./shared";
import { StoreLifecycle } from "./lifecycle";

export abstract class StoreObservation extends StoreLifecycle {
	beginObservation(taskId: string): number | null {
		return this.transaction("beginObservation", taskId, () => {
			const task = this.requireTask(taskId);
			demand(
				task.sessionId && task.turnId,
				"NO_TURN",
				"Exact execution identity required for a poll",
			);
			if (task.result?.executionTerminal) return null;
			const sequence = (task.pollIssued ?? 0) + 1;
			demand(
				Number.isSafeInteger(sequence),
				"POLL_LIMIT",
				"Poll sequence exhausted",
			);
			task.pollIssued = sequence;
			this.save(task);
			return sequence;
		});
	}

	/**
	 * `recordUnchanged: false` (the daemon's periodic poll): a current poll whose digest equals the observation
	 * already applied to this non-terminal task only advances pollApplied (as applying it would); it writes no
	 * receipt and no audit row, so an unchanged task does not grow either table.
	 */
	observe(
		taskId: string,
		observation: Observation,
		pollSequence?: number,
		recordUnchanged = true,
		heldReason?: typeof EXECUTION_FAILURE_REPORTED,
	): TaskRecord {
		return this.transaction("observe", taskId, () => {
			validateObservation(observation);
			demand(
				heldReason === undefined ||
					(heldReason === EXECUTION_FAILURE_REPORTED && !observation.terminal && observation.status === "completed_unverified"),
				"INVALID_INPUT",
				"A held reason belongs only to a non-terminal active observation",
			);
			const task = this.requireTask(taskId);
			const encoded = canonicalJson(observation);
			const previous = this.db
				.query<{ task_id: string; data: string }, [string]>(
					"SELECT task_id,data FROM receipts WHERE event_id=?",
				)
				.get(observation.eventId);
			if (previous) {
				demand(
					previous.task_id === taskId && previous.data === encoded,
					"EVENT_CONFLICT",
					"Event identity already has different content or owner",
				);
				return task;
			}
			demand(
				task.attemptId && task.sessionId === observation.sessionId,
				"SESSION_CONFLICT",
				"Observation must own the exact recorded session",
			);
			demand(
				task.turnId === observation.turnId,
				"TURN_CONFLICT",
				"Observation must own the exact recorded turn",
			);
			if (pollSequence !== undefined) {
				demand(
					Number.isSafeInteger(pollSequence) &&
						pollSequence > 0 &&
						pollSequence <= (task.pollIssued ?? 0),
					"POLL_CONFLICT",
					"Poll must match a locally issued read",
				);
				if (pollSequence !== task.pollIssued && pollSequence !== this.latestLiveSequence(task)) {
					if (this.getOperation(taskId, "cancel"))
						this.db
							.query(
								"INSERT INTO receipts(event_id,task_id,data) VALUES (?,?,?)",
							)
							.run(observation.eventId, taskId, encoded);
					this.audit(
						"stale_poll",
						{
							sequence: pollSequence,
							eventId: observation.eventId,
							digest: observation.digest,
						},
						taskId,
					);
					return task;
				}
				task.pollApplied = pollSequence;
				// Unchanged also requires the held reason to stay as it is (it follows the latest applied observation).
				const reasonUnchanged = heldReason !== undefined ? Boolean(task.reason) : task.reason !== EXECUTION_FAILURE_REPORTED;
				if (!recordUnchanged && reasonUnchanged && this.appliedUnchanged(task, observation)) return this.save(task);
			}
			this.db
				.query("INSERT INTO receipts(event_id,task_id,data) VALUES (?,?,?)")
				.run(observation.eventId, taskId, encoded);
			this.audit(
				"observation",
				{
					eventId: observation.eventId,
					digest: observation.digest,
					status: observation.status,
					terminal: observation.terminal,
				},
				taskId,
			);
			if (task.phase === "archived") return task;
			if (this.getOperation(taskId, "cancel")) {
				// Retain native late evidence, but cancellation owns retirement and release.
				if (observation.terminal && !task.result?.executionTerminal)
					task.result = {
						status: observation.status,
						evidence: observation.evidence,
						executionTerminal: true,
						verified: false,
						...(observation.settlement
							? { settlement: observation.settlement }
							: {}),
					};
				return this.save(task);
			}
			if (task.result?.executionTerminal) {
				// Receipt retained, but neither a late update nor a contradictory terminal can rewrite finality.
				if (observation.terminal)
					demand(
						task.result.status === observation.status &&
							canonicalJson(task.result.evidence) ===
								canonicalJson(observation.evidence),
						"TERMINAL_CONFLICT",
						"Authoritative terminal result is immutable",
					);
				return task;
			}
			const recoveredRead =
				pollSequence !== undefined &&
				task.reason === "observation_unavailable_original_attempt_held";
			const sticky =
				!recoveredRead &&
				(task.phase === "blocked_unknown" || task.phase === "cancel_unknown");
			const rank = (phase: string) =>
				phase === "approval_required"
					? 2
					: ["preparing", "dispatching", "active"].indexOf(phase);
			const currentRank = rank(task.phase);
			const incomingRank = rank(observation.status);
			if (
				!observation.terminal &&
				((sticky && task.phase !== observation.status) ||
					(incomingRank >= 0 && currentRank > incomingRank))
			)
				return pollSequence === undefined ? task : this.save(task);
			const before = task.phase;
			task.phase = observation.status;
			if (
				["blocked_unknown", "cancel_unknown"].includes(before) &&
				!["blocked_unknown", "cancel_unknown"].includes(task.phase)
			)
				this.audit(
					"unknown_reconciled",
					{
						before,
						after: task.phase,
						receiptEventId: observation.eventId,
						receiptDigest: observation.digest,
					},
					taskId,
					task,
				);
			if (recoveredRead) delete task.reason;
			// The reported-failure reason follows the latest applied observation; it never replaces another reason.
			if (heldReason !== undefined) {
				// An empty reason (written by older trees) is no reason.
				if (!task.reason) task.reason = heldReason;
			} else if (task.reason === EXECUTION_FAILURE_REPORTED) delete task.reason;
			task.result = {
				status: observation.status,
				evidence: observation.evidence,
				executionTerminal: observation.terminal,
				verified: false,
				...(observation.settlement
					? { settlement: observation.settlement }
					: {}),
			};
			if (observation.terminal && !this.deferTerminalRelease) {
				task.held = false;
				delete task.reason;
				this.audit("released", { attemptId: task.attemptId }, taskId);
			}
			return this.save(task);
		});
	}

	/** True when applying `observation` would change nothing but pollApplied: its digest is the applied one. */
	protected appliedUnchanged(task: TaskRecord, observation: Observation): boolean {
		const result = task.result;
		if (!result || result.executionTerminal || observation.terminal || task.phase === "archived") return false;
		if (task.phase !== observation.status || task.phase === "blocked_unknown" || task.phase === "cancel_unknown") return false;
		if (this.getOperation(task.id, "cancel")) return false;
		// Observation digests are digest() of the body without eventId/digest (validateObservation).
		const applied = digest({
			sessionId: task.sessionId!,
			...(task.turnId !== undefined ? { turnId: task.turnId } : {}),
			status: result.status,
			terminal: result.executionTerminal,
			evidence: result.evidence,
			...(result.settlement ? { settlement: result.settlement } : {}),
		});
		return applied === observation.digest;
	}

	/**
	 * Persist one node-side progress read of a task's session (see src/progress.ts). Display and operator hint
	 * only: touches nothing but the row's `progress` field and two audit kinds (progress_stalled when a stall
	 * episode starts, progress_recovered when it ends). Never changes phase, hold, poll sequences, receipts or
	 * claims, so it cannot fence, supersede or be superseded by an observation. The row is rewritten from its
	 * stored JSON (never re-encoded through encodeTask), so it can never externalise or move a result.
	 * An older read completing after a newer one, a repeated identical read, or a task that left its progress
	 * phase, attempt or session meanwhile is ignored; a stored read issued beyond progressOrderToleranceMs after
	 * this one is a hub clock step-back and is replaced. `settle` is true for exactly one recorder per
	 * finished-but-unobserved transcript state of an `active` task (again only after settleRetrySeconds); a
	 * blocked_unknown task is read and displayed only, and a caller that will not run the observation
	 * (`options.settle` false) records no settle request.
	 */
	recordProgress(
		taskId: string,
		read: ProgressRead,
		reading: ProgressReading,
		diagnostic?: FailureDiagnostic,
		options: { settle?: boolean } = {},
	): { recorded: boolean; settle: boolean; progress?: TaskProgress } {
		return this.transaction("recordProgress", taskId, () => {
			text(taskId);
			const row = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?").get(taskId);
			if (!row) return { recorded: false, settle: false };
			const stored = JSON.parse(row.data) as Record<string, any>;
			const previous = stored.progress?.version === 1 ? (stored.progress as TaskProgress) : undefined;
			if (
				!PROGRESS_PHASES.includes(stored.phase) ||
				stored.result?.executionTerminal ||
				stored.attemptId !== read.attemptId ||
				stored.sessionId !== read.sessionId
			)
				return { recorded: false, settle: false, ...(previous ? { progress: previous } : {}) };
			const ahead = previous ? Date.parse(previous.readStartedAt) - read.startedAt : Number.NaN;
			if (previous && ahead >= 0 && ahead <= progressOrderToleranceMs(read.config))
				return { recorded: false, settle: false, progress: previous };
			const iso = (ms: number) => new Date(ms).toISOString();
			const observedAt = iso(read.observedAt);
			const thresholds = { modelSeconds: read.config.modelStallSeconds, toolSeconds: read.config.toolStallSeconds };
			let next: TaskProgress;
			if (reading.ok) {
				const verdict = progressVerdict(reading.kind, reading.idleSeconds, stored.phase, read.config, reading.pendingToolsUnknown === true);
				next = {
					version: 1,
					verdict,
					observedAt,
					readStartedAt: iso(read.startedAt),
					lastEntryKind: reading.kind,
					...(reading.stopReason ? { lastStopReason: reading.stopReason } : {}),
					...(reading.pendingToolsUnknown ? { pendingToolsUnknown: true as const } : {}),
					lastProgressAt: iso(read.observedAt - reading.idleSeconds * 1000),
					idleSeconds: reading.idleSeconds,
					nodeWrittenAt: iso(reading.writtenAt * 1000),
					nodeClockOffsetSeconds: reading.nodeNow - Math.floor(read.observedAt / 1000),
					factObservedAt: observedAt,
					thresholds,
					hint: progressHint(verdict),
				};
			} else {
				next = {
					version: 1,
					verdict: "unknown",
					observedAt,
					readStartedAt: iso(read.startedAt),
					...(previous
						? Object.fromEntries(
								(["lastEntryKind", "lastStopReason", "pendingToolsUnknown", "lastProgressAt", "idleSeconds", "nodeWrittenAt", "nodeClockOffsetSeconds", "factObservedAt", "stall", "settle"] as const)
									.filter((key) => previous[key] !== undefined)
									.map((key) => [key, previous[key]]),
							)
						: {}),
					thresholds,
					hint: progressHint("unknown"),
					...this.progressDiagnostic(diagnostic),
				};
			}
			const event = (kind: "progress_stalled" | "progress_recovered", data: Record<string, Json>) =>
				this.audit(kind, { ...data, lastEntryKind: next.lastEntryKind ?? null, idleSeconds: next.idleSeconds ?? null, lastProgressAt: next.lastProgressAt ?? null, nodeWrittenAt: next.nodeWrittenAt ?? null }, taskId);
			// Stall/recover pairs are coalesced: a recovery is audited only once no new stall followed within
			// PROGRESS_EPISODE_COALESCE_SECONDS, and a stall within it (or a new write that is stalled again by the
			// next read) continues the open episode without an audit row.
			const stall = previous?.stall;
			const coalesceMs = PROGRESS_EPISODE_COALESCE_SECONDS * 1000;
			const closed = (s: NonNullable<TaskProgress["stall"]>) => !!s.recovered && read.observedAt - Date.parse(s.recovered.at) > coalesceMs;
			const recoveredEvent = (s: NonNullable<TaskProgress["stall"]>) =>
				event("progress_recovered", { verdict: s.recovered!.verdict, previousVerdict: s.verdict, stalledSince: s.since, recoveredAt: s.recovered!.at, coalesced: s.coalesced ?? 0, cause: "transcript_progressed" });
			if (next.verdict === "stalled_model" || next.verdict === "stalled_tool") {
				if (stall && !closed(stall)) {
					const again = !!stall.recovered || stall.nodeWrittenAt !== next.nodeWrittenAt;
					const coalesced = (stall.coalesced ?? 0) + (again ? 1 : 0);
					next.stall = { verdict: next.verdict, since: stall.since, nodeWrittenAt: next.nodeWrittenAt!, ...(coalesced ? { coalesced } : {}) };
				} else {
					if (stall) recoveredEvent(stall);
					next.stall = { verdict: next.verdict, since: observedAt, nodeWrittenAt: next.nodeWrittenAt! };
					event("progress_stalled", {
						verdict: next.verdict,
						thresholdSeconds: next.verdict === "stalled_tool" ? thresholds.toolSeconds : thresholds.modelSeconds,
						hint: next.hint,
					});
				}
			} else if (next.verdict !== "unknown" && stall) {
				if (!stall.recovered) next.stall = { ...stall, recovered: { at: observedAt, verdict: next.verdict } };
				else if (closed(stall)) recoveredEvent(stall);
				else next.stall = stall;
			}
			let settle = false;
			if (next.verdict === "finished_unobserved") {
				const requested = previous?.settle;
				if (requested && requested.nodeWrittenAt === next.nodeWrittenAt && read.observedAt - Date.parse(requested.requestedAt) < read.config.settleRetrySeconds * 1000)
					next.settle = requested;
				else if (options.settle !== false && stored.phase === "active") {
					next.settle = { requestedAt: observedAt, nodeWrittenAt: next.nodeWrittenAt! };
					settle = true;
				} else if (requested) next.settle = requested;
			}
			stored.progress = next;
			const changes = this.db
				.query("UPDATE tasks SET data=? WHERE id=? AND data=?")
				.run(canonicalJson(stored as Json), taskId, row.data).changes;
			demand(changes === 1, "STORE_ERROR", "Progress row update was not applied");
			return { recorded: true, settle, progress: next };
		});
	}

	markUnknown(
		taskId: string,
		reason: string,
		context?: FailureContext,
		diagnostic?: FailureDiagnostic,
	): TaskRecord {
		return this.block(taskId, reason, "unknown", undefined, context, diagnostic);
	}

	markObservationUnknown(
		taskId: string,
		sequence: number,
		reason: string,
		context?: FailureContext,
		diagnostic?: FailureDiagnostic,
	): TaskRecord {
		return this.block(taskId, reason, "unknown", sequence, context, diagnostic);
	}

	/** A tolerant read failed: record it as abandoned so it never decides ordering. Nothing is marked or
	 * released for the abandoned read itself; a strict failure that was deferred only to this read is fenced. */
	abandonObservation(
		taskId: string,
		sequence: number,
		context?: FailureContext,
		diagnostic?: FailureDiagnostic,
	): TaskRecord {
		return this.transaction("abandonObservation", taskId, () => {
			const task = this.requireTask(taskId);
			if (task.phase === "archived") return task;
			demand(
				Number.isSafeInteger(sequence) &&
					sequence > 0 &&
					sequence <= (task.pollIssued ?? 0),
				"POLL_CONFLICT",
				"Abandoned read must match an issued read",
			);
			this.audit(
				"abandoned_poll",
				{ sequence, attemptId: task.attemptId ?? null, failure: this.failureAttributes(context), ...this.diagnosticData(diagnostic) },
				taskId,
			);
			const latest = this.latestLiveSequence(task);
			if (latest <= (task.pollApplied ?? 0)) return task;
			const deferred = this.pollEvents(task, "stale_poll_failure").find(
				(data) => data.sequence === latest,
			);
			if (!deferred || task.result?.executionTerminal || this.getOperation(taskId, "cancel"))
				return task;
			const reason =
				typeof deferred.reason === "string"
					? deferred.reason
					: "observation_unavailable_original_attempt_held";
			task.pollApplied = latest;
			task.phase = "blocked_unknown";
			task.reason = reason;
			this.audit(
				"unknown",
				// The deferred strict failure's own diagnostic (display only, re-normalized), not this read's.
				{ reason, deferredSequence: latest, failure: deferred.failure ?? {}, ...this.diagnosticData(normalizeDiagnostic(deferred.failureDiagnostic)) },
				taskId,
			);
			return this.save(task);
		});
	}

	/** Highest issued poll sequence of this attempt that was not abandoned by a failed tolerant read. */
	protected latestLiveSequence(task: TaskRecord): number {
		let latest = task.pollIssued ?? 0;
		if (latest === 0) return 0;
		const abandoned = new Set(
			this.pollEvents(task, "abandoned_poll").map((data) => data.sequence),
		);
		while (latest > 0 && abandoned.has(latest)) latest--;
		return latest;
	}

	protected pollEvents(task: TaskRecord, kind: "abandoned_poll" | "stale_poll_failure"): Record<string, Json>[] {
		return this.db
			.query<DataRow, [string, string]>("SELECT data FROM audit WHERE task_id=? AND kind=? ORDER BY sequence")
			.all(task.id, kind)
			.map((row) => JSON.parse(row.data) as Record<string, Json>)
			.filter((data) => data.attemptId === (task.attemptId ?? null));
	}

	/**
	 * Settle an attempt whose exact create claim was refused with a reason that proves no session exists
	 * (classified by the caller, see rpc.ts CREATE_REFUSAL_CLASSES): the claim keeps the refusal as its
	 * immutable receipt, the task becomes `failed` (executionTerminal, never verifiable) and its reservation is
	 * released once, also in a deferTerminalRelease store (there is no session to return). Nothing is re-sent.
	 * Returns undefined, changing nothing, unless the task is exactly that held, session-less, uncancelled
	 * attempt with that unreceipted create claim; the caller then records the outcome as unknown.
	 */
	settleCreateRefusal(taskId: string, operationId: string, code: string, diagnostic?: FailureDiagnostic): TaskRecord | undefined {
		return this.transaction("settleCreateRefusal", taskId, () => {
			text(operationId);
			demand(/^tool_refused:[a-zA-Z0-9_:.-]{1,128}$/.test(code), "INVALID_INPUT", "Bounded create refusal code required");
			const task = this.requireTask(taskId);
			const create = this.getOperation(taskId, "create");
			if (
				task.phase === "archived" || !task.attemptId || !task.held || task.sessionId || task.turnId ||
				task.result?.executionTerminal || this.getOperation(taskId, "cancel") ||
				!create || create.id !== operationId || create.receipt !== undefined
			)
				return undefined;
			const refusal = { code, class: "failed_before_effect" };
			create.receipt = { createRefusal: refusal };
			this.db.query("UPDATE operations SET data=? WHERE id=? AND task_id=? AND attempt_id=? AND kind='create'")
				.run(canonicalJson(create as unknown as Json), create.id, taskId, task.attemptId);
			const before = task.phase;
			task.phase = "failed";
			task.reason = code;
			task.result = { status: "failed", evidence: { createRefusal: { operationId, ...refusal } }, executionTerminal: true, verified: false };
			task.held = false;
			this.audit("create_refused", { operationId, code, class: "failed_before_effect", ...this.diagnosticData(diagnostic) }, taskId);
			// An overlapping start may have recorded this attempt as unknown meanwhile; the refusal resolves it.
			if (before === "blocked_unknown")
				this.audit("unknown_reconciled", { before, after: task.phase, cause: "create_refused_before_effect" }, taskId);
			this.audit("released", { attemptId: task.attemptId, cause: "create_refused_before_effect" }, taskId);
			return this.save(task);
		});
	}

	markBlocked(taskId: string, reason: string, diagnostic?: FailureDiagnostic): TaskRecord {
		return this.block(taskId, reason, "blocked", undefined, undefined, diagnostic);
	}

	protected block(
		taskId: string,
		reason: string,
		kind: "unknown" | "blocked",
		pollSequence?: number,
		context?: FailureContext,
		diagnostic?: FailureDiagnostic,
	): TaskRecord {
		return this.transaction(
			kind === "unknown" ? "markUnknown" : "markBlocked",
			taskId,
			() => {
				text(reason);
				const task = this.requireTask(taskId);
				if (task.phase === "archived") return task;
				if (pollSequence !== undefined) {
					demand(
						Number.isSafeInteger(pollSequence) &&
							pollSequence > 0 &&
							pollSequence <= (task.pollIssued ?? 0),
						"POLL_CONFLICT",
						"Poll failure must match an issued read",
					);
					if (pollSequence !== task.pollIssued && pollSequence !== this.latestLiveSequence(task)) {
						// A newer read decides. If it is later abandoned, abandonObservation applies this fence.
						this.audit(
							"stale_poll_failure",
							{
								sequence: pollSequence,
								attemptId: task.attemptId ?? null,
								reason,
								failure: this.failureAttributes(context),
								...this.diagnosticData(diagnostic),
							},
							taskId,
						);
						return task;
					}
					task.pollApplied = pollSequence;
				}
				demand(
					task.attemptId,
					"NO_ATTEMPT",
					"Only a reserved attempt can become unknown",
				);
				if (task.result?.executionTerminal) return task;
				if (this.getOperation(taskId, "cancel")) return task;
				task.phase = "blocked_unknown";
				task.reason = reason;
				this.audit(
					kind,
					{
						reason,
						...(context ? { failure: this.failureAttributes(context) } : {}),
						...this.diagnosticData(diagnostic),
					},
					taskId,
				);
				return this.save(task);
			},
		);
	}

	setWorkspace(taskId: string, identity: Json): TaskRecord {
		return this.transaction("setWorkspace", taskId, () => {
			nonemptyEvidence(identity);
			const task = this.requireTask(taskId);
			demand(
				task.attemptId,
				"NO_ATTEMPT",
				"Workspace identity belongs to a reserved attempt",
			);
			if (task.workspace !== undefined) {
				demand(
					canonicalJson(task.workspace) === canonicalJson(identity),
					"WORKSPACE_CONFLICT",
					"Workspace identity is immutable",
				);
				return task;
			}
			demand(
				!task.result?.executionTerminal,
				"ALREADY_TERMINAL",
				"Cannot attach a workspace after terminal execution",
			);
			task.workspace = identity;
			this.audit("workspace_recorded", { digest: digest(identity) }, taskId);
			return this.save(task);
		});
	}

	recordVerification(taskId: string, receipt: Json): TaskRecord {
		return this.transaction("recordVerification", taskId, () => {
			const task = this.requireTask(taskId);
			demand(!task.disposition, "ARCHIVED_TASK", "A disposed task is an operator record; a late verifier receipt is never recorded onto it");
			demand(
				task.result?.executionTerminal,
				"NOT_TERMINAL",
				"Verification receipt requires a settled execution",
			);
			demand(
				!receiptlessUnverifiable(task.result),
				"RECEIPTLESS_UNVERIFIABLE",
				"Execution ended without a runtime receipt; it is never verified unless an operator accepts a genuine late receipt",
			);
			object(receipt);
			const intent = this.getOperation(taskId, "verify-test");
			demand(
				intent &&
					canonicalJson((intent.payload as Record<string, Json>).argv) ===
						canonicalJson(receipt.argv),
				"VERIFICATION_CONFLICT",
				"Receipt must match the original verification command",
			);
			nonemptyEvidence(receipt);
			if (task.testReceipt !== undefined) {
				demand(
					canonicalJson(task.testReceipt) === canonicalJson(receipt),
					"VERIFICATION_CONFLICT",
					"Verification receipt is immutable",
				);
				return task;
			}
			task.testReceipt = receipt;
			this.audit("verification_receipt", { digest: digest(receipt) }, taskId);
			this.clearOwnerGone(task, "verify-test", intent!.id);
			return this.save(task);
		});
	}

	/**
	 * Record, once per attempt and on the task itself, that a requested verifier argv conflicts with the
	 * attempt's immutable retained verifier evidence. Retained evidence never changes, so the same request can
	 * never succeed: the conflict is final at its first occurrence. Each distinct requested argv is audited once
	 * as `verification_conflict` (at most VERIFICATION_RECORDED_REQUESTS per attempt, kept in
	 * `recordedArgvDigests`); a repeat of a recorded request only advances count/lastAt (one bounded object per
	 * task). Returns `first` (audited now), `repeat` (already audited; the caller audits nothing) or
	 * `not_recorded` (nothing changed: archived task, no attempt, a request that IS retained evidence so this is
	 * not a request-versus-retained conflict, or the bound is reached; the caller audits the rejection). A task
	 * still waiting for its verifier gets the visible reason `verification_conflict` unless another reason is set.
	 */
	recordVerificationConflict(taskId: string, requestedArgv: string[], diagnostic?: FailureDiagnostic): "first" | "repeat" | "not_recorded" {
		return this.transaction("verificationConflict", taskId, () => {
			const task = this.requireTask(taskId);
			if (task.phase === "archived" || !task.attemptId) return "not_recorded";
			const argvs: unknown[] = [];
			if (task.testReceipt !== undefined) argvs.push((task.testReceipt as any)?.argv);
			for (const test of ((task.resultManifest as any)?.tests ?? []) as any[]) argvs.push(test?.argv);
			const resultTest = this.getOperation(taskId, "result-test");
			if (resultTest) argvs.push((resultTest.payload as any)?.argv);
			const verifyTest = this.getOperation(taskId, "verify-test");
			if (verifyTest) argvs.push((verifyTest.payload as any)?.argv);
			const retained = [...new Set(argvs.filter((argv) => argv !== undefined).map((argv) => digest(argv as Json)))].sort();
			const requestedArgvDigest = digest(requestedArgv as unknown as Json);
			// Only a request that differs from every retained verifier argv conflicts with retained evidence; any other
			// VERIFICATION_CONFLICT (a node reply for another argv, a receipt binding mismatch) is not recorded here.
			if (retained.length === 0 || retained.includes(requestedArgvDigest)) return "not_recorded";
			const retainedArgvDigests = retained.slice(0, VERIFICATION_RETAINED_DIGESTS);
			const current = task.verification?.state === "conflict" && task.verification.attemptId === task.attemptId ? task.verification : undefined;
			const recorded = current?.recordedArgvDigests ?? [];
			const repeat = recorded.includes(requestedArgvDigest);
			if (!repeat && recorded.length >= VERIFICATION_RECORDED_REQUESTS) return "not_recorded";
			const at = new Date().toISOString();
			// count and firstAt belong to the record (every recorded conflicting request of this attempt), so a
			// repeat of any recorded request advances count and never resets firstAt.
			task.verification = {
				state: "conflict",
				attemptId: task.attemptId,
				requestedArgvDigest,
				recordedArgvDigests: repeat ? recorded : [...recorded, requestedArgvDigest],
				retainedArgvDigests,
				count: Math.min((current?.count ?? 0) + 1, Number.MAX_SAFE_INTEGER),
				firstAt: current?.firstAt ?? at,
				lastAt: at,
			};
			if (!repeat)
				this.audit("verification_conflict", {
					attemptId: task.attemptId,
					requestedArgvDigest: task.verification.requestedArgvDigest,
					retainedArgvDigests,
					final: true,
					...this.diagnosticData(diagnostic),
				}, taskId);
			if (task.phase === "completed_unverified" && !task.reason) task.reason = VERIFICATION_CONFLICT_REASON;
			this.save(task);
			return repeat ? "repeat" : "first";
		});
	}

	/**
	 * Record that an unreceipted verifier claim of the current attempt has no live owner any more (the caller
	 * proved it, see Fleet). Its test effect may or may not have run, and may still be running, so it is never
	 * rerun and collection stays refused (TEST_UNKNOWN); recording it makes the outcome visible
	 * (`verification_outcome_unknown`). Idempotent: audited once per claim.
	 */
	recordVerifierOwnerGone(taskId: string, kind: "verify-test" | "result-test", operationId: string, diagnostic?: FailureDiagnostic): TaskRecord {
		return this.transaction("verifierOwnerGone", taskId, () => {
			text(operationId);
			const task = this.requireTask(taskId);
			const intent = this.getOperation(taskId, kind);
			demand(task.attemptId && intent?.id === operationId && intent.receipt === undefined && (kind !== "verify-test" || task.testReceipt === undefined),
				"OPERATION_BINDING", "Exact unreceipted verifier claim of the current attempt required");
			if (task.verification?.state === "owner_gone" && task.verification.operationId === operationId) return task;
			if (task.phase === "archived") return task;
			task.verification = { state: "owner_gone", attemptId: task.attemptId!, kind, operationId, at: new Date().toISOString() };
			if (!task.reason || task.reason === VERIFICATION_CONFLICT_REASON) task.reason = VERIFICATION_OUTCOME_UNKNOWN_REASON;
			this.audit("verification_owner_gone", { attemptId: task.attemptId!, kind, operationId, ...this.diagnosticData(diagnostic) }, taskId);
			return this.save(task);
		});
	}

	/**
	 * The owner-gone record of exactly this claim is history once the claim resolves (its receipt is recorded, or
	 * it is released as never sent): its owner was in fact alive. Clears that record and its visible reason
	 * `verification_outcome_unknown` (never another reason). Mutates `task` only; true when it changed.
	 */
	protected clearOwnerGone(task: TaskRecord, kind: string, operationId: string): boolean {
		const record = task.verification;
		if (task.phase === "archived" || record?.state !== "owner_gone" || record.kind !== kind || record.operationId !== operationId || record.attemptId !== task.attemptId) return false;
		delete task.verification;
		if (task.reason === VERIFICATION_OUTCOME_UNKNOWN_REASON) delete task.reason;
		return true;
	}

	verifyResult(taskId: string, evidence: Json, exportEvidence?: Json): TaskRecord {
		return this.transaction("verifyResult", taskId, () => {
			canonicalJson(evidence);
			const task = this.requireTask(taskId);
			demand(!task.disposition, "ARCHIVED_TASK", "A disposed task is an operator record; it is never verified");
			demand(
				task.result?.executionTerminal,
				"NOT_TERMINAL",
				"Result verification requires an authoritative terminal receipt",
			);
			demand(
				!receiptlessUnverifiable(task.result),
				"RECEIPTLESS_UNVERIFIABLE",
				"Execution ended without a runtime receipt; it is never verified unless an operator accepts a genuine late receipt",
			);
			nonemptyEvidence(evidence);
			if (task.result.verified) {
				demand(
					canonicalJson(task.result.verificationEvidence) ===
						canonicalJson(evidence),
					"VERIFICATION_CONFLICT",
					"Verification evidence is immutable",
				);
				return task;
			}
			// A stored legacy-v1 result (completeness unknown) is verified here as production did; Fleet
			// itself sends one to export review before it verifies (port of r4 onto 3eb6ec2).
			demand(
				task.result.exportIncomplete === undefined &&
					(task.resultManifest === undefined || storedExport(task, this.getOperation(taskId, "result-test")).completeness !== "incomplete"),
				"EXPORT_REVIEW_REQUIRED",
				"EXPORT_REVIEW_REQUIRED: incomplete export requires explicit operator acceptance",
			);
			task.result.verified = true;
			task.result.verificationEvidence = evidence;
			if (exportEvidence !== undefined) task.result.exportEvidence = exportEvidence;
			if (task.phase === "completed_unverified") task.phase = "succeeded";
			// A conflict recorded earlier on this attempt is history now: the retained evidence verified it.
			if (task.reason === VERIFICATION_CONFLICT_REASON) delete task.reason;
			this.audit("result_verified", {}, taskId);
			return this.save(task);
		});
	}
	/**
	 * Passing commands with an incomplete (or legacy-unknown) export: record the
	 * immutable review subject as `result.exportIncomplete`. The task stays
	 * `completed_unverified` (a phase every release understands) and is never
	 * verified until `acceptIncompleteExport`. Idempotent for the identical subject.
	 */
	requireExportReview(taskId: string, subject: Json, reviewDigest: string, resultTest?: Json): TaskRecord {
		return this.transaction("requireExportReview", taskId, () => {
			const task = this.requireTask(taskId);
			object(subject);
			demand(reviewDigest === exportReviewDigest(subject), "VERIFICATION_CONFLICT", "Export review digest must match its subject");
			const recorded = task.result?.exportIncomplete;
			if (recorded !== undefined) {
				demand(
					recorded.reviewDigest === reviewDigest &&
						canonicalJson(recorded.subject) === canonicalJson(subject) &&
						(resultTest === undefined || recorded.resultTestDigest === digest(resultTest)),
					"VERIFICATION_CONFLICT",
					"Export review is immutable",
				);
				return task;
			}
			// A held result-test receipt belongs to this attempt's receipt-less result-test claim on the stored result.
			const claim = this.getOperation(taskId, "result-test");
			if (resultTest !== undefined) {
				object(resultTest);
				demand(claim !== undefined && claim.receipt === undefined && claim.held === undefined && (resultTest as Record<string, Json>).manifestDigest === digest(task.resultManifest), "OPERATION_BINDING", "A held result-test receipt requires the stored result's receipt-less claim");
			}
			const value = subject as Record<string, Json>;
			demand(
				task.result?.executionTerminal &&
					!task.result.verified &&
					task.phase === "completed_unverified" &&
					task.resultManifest !== undefined &&
					value.taskId === task.id &&
					value.attemptId === task.attemptId &&
					["incomplete", "unknown"].includes(value.completeness as string),
				"NOT_TERMINAL",
				"Export review requires a settled unverified result of this attempt",
			);
			demand(subjectDescribesStored(value, task, resultTest === undefined ? claim : { ...claim!, receipt: resultTest }), "VERIFICATION_CONFLICT", "Export review subject must describe the stored passing result");
			if (resultTest !== undefined) {
				// Held once, on its claim; the task row keeps only its digest (review fx-6f923f88 F3).
				claim!.held = resultTest;
				this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind=? AND id=?")
					.run(canonicalJson(claim as unknown as Json), taskId, task.attemptId!, "result-test", claim!.id);
			}
			task.result!.exportIncomplete = { subject, reviewDigest, requiredAt: new Date().toISOString(), ...(resultTest === undefined ? {} : { resultTestDigest: digest(resultTest) }) };
			this.audit(
				"export_review_required",
				{
					reviewDigest,
					manifestDigest: value.manifestDigest!,
					completeness: value.completeness!,
					exclusions: Array.isArray(value.exclusions) ? value.exclusions.length : null,
				},
				taskId,
				task,
			);
			return this.save(task);
		});
	}
	/**
	 * Explicit operator acceptance of a reviewed incomplete export: records who,
	 * when and which review digest, then verifies the `completed_unverified` task
	 * (`succeeded`). Refused unless the digest equals the recorded review.
	 */
	acceptIncompleteExport(taskId: string, operator: string, reviewDigest: string, evidence: Json): TaskRecord {
		return this.transaction("acceptIncompleteExport", taskId, () => {
			demand(typeof operator === "string" && /^[A-Za-z0-9._@+-]{1,128}$/.test(operator), "INVALID_INPUT", "INVALID_INPUT: operator identity required");
			demand(typeof reviewDigest === "string" && /^[a-f0-9]{64}$/.test(reviewDigest), "INVALID_INPUT", "INVALID_INPUT: reviewDigest must be a SHA256 hex digest");
			const task = this.requireTask(taskId);
			const review = task.result?.exportIncomplete;
			demand(review, "EXPORT_REVIEW_NOT_REQUIRED", "EXPORT_REVIEW_NOT_REQUIRED: task has no incomplete export awaiting review");
			if (task.result?.verified) {
				demand(
					review.acceptance?.operator === operator && review.acceptance.reviewDigest === reviewDigest,
					"VERIFICATION_CONFLICT",
					"VERIFICATION_CONFLICT: export acceptance is immutable",
				);
				return task;
			}
			const subject = review.subject as Record<string, Json>;
			demand(
				reviewDigest === review.reviewDigest &&
					review.reviewDigest === exportReviewDigest(review.subject) &&
					subject.taskId === task.id &&
					subject.attemptId === task.attemptId,
				"EXPORT_REVIEW_CHANGED",
				"EXPORT_REVIEW_CHANGED: exclusion set differs from the reviewed digest",
			);
			demand(subjectDescribesStored(subject, task, this.getOperation(taskId, "result-test")), "VERIFICATION_CONFLICT", "Export review subject must describe the stored passing result");
			demand(
				task.phase === "completed_unverified" && task.result?.executionTerminal,
				"NOT_TERMINAL",
				"Only a settled completed_unverified task awaiting export review can be accepted",
			);
			demand(
				!receiptlessUnverifiable(task.result),
				"RECEIPTLESS_UNVERIFIABLE",
				"Execution ended without a runtime receipt; it is never verified unless an operator accepts a genuine late receipt",
			);
			const acceptance = { operator, reviewDigest, acceptedAt: new Date().toISOString() };
			// Accepted: a held result-test receipt becomes the claim's receipt. The stored result is
			// never rewritten (review fx-397df5a5 F1: it is immutable and its stored form, inline or
			// externalised, never changes as a side effect); a retained verifier receipt beside a
			// held `not_run` result stays there and is joined on every read (see Fleet withResultTest).
			const claim = this.getOperation(taskId, "result-test");
			if (review.resultTestDigest !== undefined) {
				const held = heldResultTest(task, claim);
				demand(claim !== undefined && held !== undefined, "OPERATION_BINDING", "A held result-test receipt requires its receipt-less claim");
				claim.receipt = held;
				delete claim.held;
				this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind=? AND id=?")
					.run(canonicalJson(claim as unknown as Json), taskId, task.attemptId!, "result-test", claim.id);
				this.audit("operation_receipt", { operationId: claim.id, kind: "result-test", digest: digest(held) }, taskId);
			}
			review.acceptance = acceptance;
			task.result.verified = true;
			demand(
				evidence && typeof evidence === "object" && !Array.isArray(evidence) && (evidence as Record<string, Json>).manifestDigest === subject.manifestDigest,
				"VERIFICATION_CONFLICT",
				"Verification evidence must describe the reviewed result",
			);
			nonemptyEvidence(evidence);
			// The verification evidence keeps the shape every release re-derives; the
			// acceptance and the reviewed exclusions are export evidence beside it.
			task.result.verificationEvidence = evidence;
			task.result.exportEvidence = {
				manifestDigest: subject.manifestDigest!,
				exportComplete: false,
				artifactSchema: subject.artifactSchema!,
				completeness: subject.completeness!,
				exclusions: subject.exclusions!,
				reviewDigest,
				acceptance,
				trust: "operator-accepted incomplete export; trusted node command evidence, not remote attestation",
			};
			task.phase = "succeeded";
			this.audit(
				"incomplete_export_accepted",
				{
					operator,
					reviewDigest,
					acceptedAt: acceptance.acceptedAt,
					manifestDigest: subject.manifestDigest!,
					completeness: subject.completeness!,
					exclusions: Array.isArray(subject.exclusions) ? subject.exclusions.length : null,
				},
				taskId,
				task,
			);
			return this.save(task);
		});
	}

	/**
	 * Durable record of a genuine runtime receipt for the SAME session/turn/command that
	 * appeared after a receipt-less settlement. A contradiction only: phase, held,
	 * executionTerminal and verified never change. Archived tasks are never re-observed.
	 */
	recordLateReceipt(
		taskId: string,
		late: Omit<LateReceipt, "settlementKind" | "acceptance">,
	): TaskRecord {
		return this.transaction("recordLateReceipt", taskId, () => {
			const task = this.requireTask(taskId);
			if (task.phase === "archived") return task;
			const result = task.result;
			const execution = (result?.evidence as any)?.execution;
			demand(
				task.phase === "failed" &&
					result?.executionTerminal === true &&
					result.settlement &&
					(!task.held || this.deferTerminalRelease),
				"LATE_RECEIPT_STATE",
				"Late receipts are recorded only for receipt-less failed settlements",
			);
			for (const field of [late.status, late.digest, late.observedAt]) text(field);
			demand(
				["terminal_ok", "failed"].includes(late.status) &&
					/^[0-9a-f]{64}$/.test(late.digest) &&
					Number.isFinite(Date.parse(late.observedAt)) &&
					Number.isFinite(late.terminalAt) &&
					late.terminalAt > 0 &&
					late.outcome !== null &&
					typeof late.outcome === "object" &&
					late.sessionId === task.sessionId &&
					late.turnId === task.turnId &&
					late.runtimeCommandId === execution?.commandId &&
					late.runtimeTurnId === execution?.turnId,
				"LATE_RECEIPT_BINDING",
				"Late receipt must belong to the exact settled session, turn and runtime command",
			);
			const recorded = result!.lateReceipt;
			if (recorded) {
				if (recorded.digest !== late.digest)
					this.audit(
						"late_receipt_conflict",
						{ recordedDigest: recorded.digest, digest: late.digest, status: late.status },
						taskId,
					);
				return task;
			}
			const lateReceipt: LateReceipt = {
				status: late.status,
				digest: late.digest,
				terminalAt: late.terminalAt,
				outcome: late.outcome,
				sessionId: late.sessionId,
				turnId: late.turnId,
				runtimeCommandId: late.runtimeCommandId,
				runtimeTurnId: late.runtimeTurnId,
				observedAt: late.observedAt,
				settlementKind: result!.settlement!.kind,
			};
			result!.lateReceipt = lateReceipt;
			this.audit(
				"late_receipt_contradiction",
				{
					status: late.status,
					digest: late.digest,
					settlementKind: lateReceipt.settlementKind,
					sessionId: late.sessionId,
					turnId: late.turnId,
					runtimeCommandId: late.runtimeCommandId,
					runtimeTurnId: late.runtimeTurnId,
					observedAt: late.observedAt,
					phase: task.phase,
					finality: "unchanged",
				},
				taskId,
			);
			return this.save(task);
		});
	}

	/**
	 * Audited operator acceptance of a recorded late terminal_ok receipt, re-proven by
	 * the caller on a fresh exact read. Moves the task to completed_unverified so the
	 * NORMAL verifier decides; never success, never re-reserves the released slot.
	 */
	acceptLateReceipt(
		taskId: string,
		acceptance: { actor: string; reason: string; digest: string; evidence: Json },
	): TaskRecord {
		return this.transaction("acceptLateReceipt", taskId, () => {
			const task = this.requireTask(taskId);
			text(acceptance.actor);
			text(acceptance.reason);
			nonemptyEvidence(acceptance.evidence);
			demand(task.phase !== "archived", "ARCHIVED_TASK", "Archived tasks are never re-observed or accepted");
			const late = task.result?.lateReceipt;
			if (late?.acceptance) {
				demand(
					late.acceptance.actor === acceptance.actor &&
						late.acceptance.reason === acceptance.reason &&
						late.acceptance.evidenceDigest === digest(acceptance.evidence),
					"LATE_RECEIPT_ACCEPTED",
					"Late receipt was already accepted",
				);
				return task;
			}
			demand(
				task.phase === "failed" &&
					task.result?.executionTerminal === true &&
					task.result.settlement &&
					(!task.held || this.deferTerminalRelease) &&
					late?.status === "terminal_ok",
				"LATE_RECEIPT_STATE",
				"Only a recorded late terminal_ok receipt of a receipt-less failed settlement can be accepted",
			);
			demand(
				late!.digest === acceptance.digest,
				"LATE_RECEIPT_CHANGED",
				"Fresh runtime receipt differs from the recorded late receipt",
			);
			const priorEvidenceDigest = digest(task.result!.evidence);
			const at = new Date().toISOString();
			const evidenceDigest = digest(acceptance.evidence);
			task.phase = "completed_unverified";
			task.result = {
				...task.result!,
				status: "completed_unverified",
				evidence: acceptance.evidence,
				executionTerminal: true,
				verified: false,
				lateReceipt: {
					...late!,
					acceptance: { at, actor: acceptance.actor, reason: acceptance.reason, evidenceDigest },
				},
			};
			this.audit(
				"late_receipt_accepted",
				{
					status: late!.status,
					digest: late!.digest,
					actor: acceptance.actor,
					reason: acceptance.reason,
					priorEvidenceDigest,
					evidenceDigest,
					before: "failed",
					after: "completed_unverified",
					verifier: "required",
				},
				taskId,
			);
			return this.save(task);
		});
	}

	events(taskId: string): AuditEvent[] {
		text(taskId);
		return this.db
			.query<
				{
					sequence: number;
					task_id: string | null;
					kind: string;
					at: string;
					data: string;
				},
				[string]
			>("SELECT * FROM audit WHERE task_id=? ORDER BY sequence")
			.all(taskId)
			.map((row) => ({
				sequence: row.sequence,
				...(row.task_id ? { taskId: row.task_id } : {}),
				kind: row.kind,
				at: row.at,
				data: JSON.parse(row.data),
			}));
	}

	/**
	 * Every task's events in one read, grouped by task and ordered by sequence: the same rows and shape as
	 * `events(taskId)` for each task. For callers that need the events of ALL tasks (the dashboard snapshot):
	 * `audit` has no task_id index, so one `events()` call per task is one full table scan per task.
	 */
	eventsByTask(): Map<string, AuditEvent[]> {
		const grouped = new Map<string, AuditEvent[]>();
		const rows = this.db
			.query<{ sequence: number; task_id: string; kind: string; at: string; data: string }, []>(
				"SELECT sequence, task_id, kind, at, data FROM audit WHERE task_id IS NOT NULL ORDER BY sequence",
			)
			.all();
		for (const row of rows) {
			const event: AuditEvent = { sequence: row.sequence, taskId: row.task_id, kind: row.kind, at: row.at, data: JSON.parse(row.data) };
			const list = grouped.get(row.task_id);
			if (list) list.push(event);
			else grouped.set(row.task_id, [event]);
		}
		return grouped;
	}
}
