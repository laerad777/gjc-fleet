import type { FleetStore } from "./fleet-store";
import { consumeArchiveObservation } from "../fleet";
import { DispositionRequest, Json, Observation, OperationIntent, SessionAuthority, TaskDisposition, TaskRecord, TaskState, TaskWithdrawal } from "../contracts";
import { canonicalJson, demand, digest, object, text } from "../core";
import { FailureDiagnostic } from "../diagnostic";
import { DISPOSITION_LIMITS, DISPOSITION_STATEMENT, DataRow, FailureContext, OPERATOR_RELEASE_STATEMENT, OperatorReleaseListing, ResourceReturnStatus, WITHDRAWAL_LIMITS, boundedText, normaliseDisposition } from "./shared";
import { StoreOperations } from "./operations";

export abstract class StoreLifecycle extends StoreOperations {
	/**
	 * Resource-return outcomes recorded for the task's given attempt (audit only; no task body is read). With
	 * `afterClose` (a close claim's operation id): only the outcomes recorded after that claim.
	 */
	resourceReturnOutcomes(taskId: string, attemptId: string, afterClose?: string): { kind: string; reason: string | null }[] {
		text(taskId); text(attemptId);
		if (afterClose !== undefined) text(afterClose);
		return this.db
			.query<{ kind: string; reason: unknown }, [string, string, string, string | null]>(
				"SELECT kind, json_extract(data,'$.reason') AS reason FROM audit WHERE task_id=? AND kind IN ('resource_return_unknown','resource_return_not_ours','resource_return_session_busy') AND json_extract(data,'$.attemptId')=? AND sequence > COALESCE((SELECT max(sequence) FROM audit WHERE task_id=? AND kind='resource_return_close_intent' AND json_extract(data,'$.operationId')=?),0) ORDER BY sequence",
			)
			.all(taskId, attemptId, taskId, afterClose ?? null)
			.map((row) => ({ kind: row.kind, reason: typeof row.reason === "string" ? row.reason : null }));
	}

	recordResourceReturnUnknown(taskId: string, reason: string, diagnostic?: FailureDiagnostic): void {
		this.recordResourceReturnOutcome(taskId, "resource_return_unknown", reason, null, diagnostic);
	}

	/** Audit-only record of the tasks refused by resource-return eligibility in one return call,
	 * before any read or close: per task the stable refusal code plus the classified diagnostic. Never
	 * releases anything. Row metadata only, so a task whose externalised result is damaged is still
	 * recorded. All refusals of the call are recorded in one write transaction, so a held write lock
	 * costs the call at most one busy wait. A refusal identical to ANY resource_return_refused row of
	 * the same task (same attempt, session, code and diagnostic) is never written again, however many
	 * audit rows came in between: the lookup reads every resource_return_refused row of these tasks
	 * (one scan of the audit table per call, no schema object). Returns the number of rows written. */
	recordResourceReturnRefused(refusals: readonly { taskId: string; refusal: string; diagnostic?: FailureDiagnostic }[]): number {
		if (refusals.length === 0) return 0;
		return this.transaction("recordResourceReturnRefused", refusals.length === 1 ? refusals[0]!.taskId : undefined, () => {
			const ids = [...new Set(refusals.map((r) => r.taskId))];
			const seen = new Set<string>();
			for (const row of this.db
				.query<{ task_id: string; data: string }, [string]>("SELECT task_id, data FROM audit WHERE kind='resource_return_refused' AND task_id IN (SELECT value FROM json_each(?))")
				.all(JSON.stringify(ids))) {
				const { observability: _attributes, ...previous } = JSON.parse(row.data);
				seen.add(row.task_id + "\n" + canonicalJson(previous));
			}
			let written = 0;
			for (const { taskId, refusal, diagnostic } of refusals) {
				text(refusal);
				const task = this.requireTaskState(taskId);
				const data: Record<string, Json> = { attemptId: task.attemptId ?? null, sessionId: task.sessionId ?? null, reason: refusal, replay: false, ...this.diagnosticData(diagnostic) };
				const key = taskId + "\n" + canonicalJson(data);
				if (seen.has(key)) continue;
				seen.add(key);
				this.audit("resource_return_refused", data, taskId, task);
				written++;
			}
			return written;
		});
	}

	/** Audit-only outcome of one return attempt; never releases or settles anything. */
	recordResourceReturnOutcome(taskId: string, kind: "resource_return_unknown" | "resource_return_not_ours" | "resource_return_session_busy", reason: string, detail: Json = null, diagnostic?: FailureDiagnostic): void {
		this.transaction("recordResourceReturnOutcome", taskId, () => {
			demand(["resource_return_unknown", "resource_return_not_ours", "resource_return_session_busy"].includes(kind), "INVALID_INPUT", "Unknown return outcome");
			text(reason);
			const task = this.requireTask(taskId);
			this.audit(kind, { attemptId: task.attemptId ?? null, sessionId: task.sessionId ?? null, reason, physicalState: kind === "resource_return_not_ours" ? "not_owned_incarnation" : "unknown", replay: false, detail, ...this.diagnosticData(diagnostic) }, taskId);
		});
	}

	/** Durable intent for one exact-incarnation idle-only close, claimed BEFORE dispatch.
	 * UNIQUE(attempt_id,kind) makes this the mutation fence: of any number of controllers
	 * (regardless of clocks or leases) exactly one can claim ordinal N. Ordinal N+1 may be
	 * claimed only after ordinal N retained a public pre-effect refusal receipt. */
	claimResourceReturnClose(taskId: string, ordinal: number, payload: { sessionId: string; cwd: string; endpointGeneration: number; endpointIncarnation: string; ifIdle: true }): OperationIntent | null {
		return this.transaction("claimResourceReturnClose", taskId, () => {
			this.assertDispatchEnabled();
			const task = this.requireTask(taskId);
			demand(Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= 5, "RETURN_BOUNDS", "Bounded close ordinal required");
			demand(task.result?.executionTerminal && task.resultManifest && task.sessionId === payload.sessionId, "RETURN_NOT_SETTLED", "Settled collected attempt required before close");
			demand(!this.getOperation(taskId, "cancel"), "CANCEL_PENDING", "Cancellation owns retirement");
			demand(!this.getOperation(taskId, "resource-return-confirmed") && !this.getOperation(taskId, "resource-return-override"), "RETURN_ALREADY_SETTLED", "Return already settled");
			const original = this.authority(task).payload as any;
			demand(payload.ifIdle === true && original.sessionId === payload.sessionId && original.cwd === payload.cwd && original.endpointGeneration === payload.endpointGeneration && original.endpointIncarnation === payload.endpointIncarnation && Object.keys(payload).length === 5, "AUTHORITY_CONFLICT", "Close must carry exactly the original recorded authority");
			if (ordinal > 1) demand(this.getOperation(taskId, `resource-return-close:${ordinal - 1}`)?.receipt !== undefined, "RETURN_REPLAY", "A new close requires the previous close's retained public refusal");
			// Checked in the same transaction as the claim, so a block written by another
			// process before this claim commits always prevents the close.
			demand(!task.nodeId || !this.resourceReturnNodeBlock(task.nodeId), "RETURN_NODE_BLOCKED", "Node is blocked for resource-return closes until an audited unblock");
			const kind = `resource-return-close:${ordinal}`;
			if (this.getOperation(taskId, kind)) return null;
			const intent = this.insertIntent(task, kind, payload);
			this.audit("resource_return_close_intent", { operationId: intent.id, kind, endpointGeneration: payload.endpointGeneration, endpointIncarnation: payload.endpointIncarnation, ifIdle: true }, taskId);
			return intent;
		});
	}

	resourceReturnNodeBlock(nodeId: string): { diagnostic: string; taskId: string; operationId: string; at: string } | undefined {
		if (!this.hasTable("resource_return_node_blocks")) return undefined;
		const row = this.db.query<{ data: string }, [string]>("SELECT data FROM resource_return_node_blocks WHERE node_id=?").get(nodeId);
		return row ? JSON.parse(row.data) : undefined;
	}

	/** A node whose broker deterministically refuses targeted closes before dispatch.
	 * Persisted so later passes do not hammer it; read-only reconciliation continues. */
	blockResourceReturnNode(nodeId: string, taskId: string, operationId: string, diagnostic: string, failure?: FailureDiagnostic): void {
		this.transaction("blockResourceReturnNode", taskId, () => {
			text(nodeId); text(diagnostic);
			if (this.resourceReturnNodeBlock(nodeId)) return;
			const block = { diagnostic, taskId, operationId, at: new Date().toISOString() };
			this.db.query("INSERT INTO resource_return_node_blocks VALUES (?,?)").run(nodeId, canonicalJson(block));
			// The operator diagnostic goes on the audit event only; the persisted block is unchanged.
			this.audit("resource_return_blocked_by_node", { nodeId, ...block, applied: false, ...this.diagnosticData(failure) }, taskId);
		});
	}

	/** Audited operator action after the node's lifecycle ledger is repaired. */
	clearResourceReturnNodeBlock(nodeId: string, approval: { operator: string; reason: string }): void {
		this.transaction("clearResourceReturnNodeBlock", undefined, () => {
			text(nodeId); text(approval?.operator); text(approval?.reason);
			const block = this.resourceReturnNodeBlock(nodeId);
			demand(block, "RETURN_NOT_BLOCKED", "Node has no resource-return block");
			this.db.query("DELETE FROM resource_return_node_blocks WHERE node_id=?").run(nodeId);
			this.audit("resource_return_node_unblocked", { nodeId, operator: approval.operator, reason: approval.reason, block });
		});
	}

	/** Explicit audited operator release of a held reservation whose return cannot be
	 * proven (missing authority, reused id, lost close outcome, blocked node, unreachable
	 * node). It is NOT a return: it sends nothing, records that the session was NOT
	 * observed gone, and releases at most once. The caller supplies the fresh listing it
	 * took immediately before (same trust model as confirmResourceReturn). Refused when
	 * that listing shows the session gone (use return), shows it live and not idle
	 * (possibly running a turn), or shows the exact incarnation live and idle while no
	 * fenced close was ever tried (use return first). The session stays reported as
	 * possibly running on the node until a later fresh listing shows it gone. */
	overrideResourceReturn(taskId: string, approval: { operator: string; reason: string }, listing: OperatorReleaseListing, diagnostic?: FailureDiagnostic): OperationIntent {
		return this.transaction("overrideResourceReturn", taskId, () => {
			text(approval?.operator); text(approval?.reason);
			demand(approval.operator.length <= 200 && approval.reason.length <= 2000, "INVALID_INPUT", "Bounded operator and reason required");
			const task = this.requireTask(taskId);
			demand(!this.getOperation(taskId, "resource-return-confirmed") && !this.getOperation(taskId, "resource-return-override"), "RETURN_ALREADY_SETTLED", "Return already settled");
			demand(task.attemptId && task.result?.executionTerminal, "RETURN_NOT_SETTLED", "Only a settled attempt's reservation can be overridden");
			demand(!this.getOperation(taskId, "cancel"), "CANCEL_PENDING", "Cancellation owns retirement");
			demand(task.held, "RETURN_NOT_HELD", "Reservation is not held");
			const hasAuthority = Boolean(this.getOperation(taskId, "session-authority"));
			const kinds: Record<OperatorReleaseListing["kind"], boolean> = { exact_live: hasAuthority, exact_unproven: hasAuthority, foreign_incarnation: hasAuthority, unverifiable_without_authority: !hasAuthority, unavailable: true };
			demand(listing && kinds[listing.kind] === true && (listing.kind === "unavailable" ? typeof listing.error === "string" : Number.isSafeInteger(listing.indexSeq) && listing.indexSeq >= 0), "OVERRIDE_LISTING_REQUIRED", "A fresh listing of the session (or its failure) taken for this override is required");
			const live = listing.kind === "exact_live" || ((listing.kind === "exact_unproven" || listing.kind === "unverifiable_without_authority") && listing.live === true);
			const activity = "activity" in listing ? listing.activity : null;
			demand(!live || activity === "idle", "OVERRIDE_SESSION_RUNNING", "Fresh listing shows the session live and not idle (possibly running a turn); override refused");
			const closes: Json[] = [];
			for (let n = 1; n <= 5; n++) {
				const close = this.getOperation(taskId, `resource-return-close:${n}`);
				if (!close) break;
				closes.push({ id: close.id, receipt: close.receipt ?? null });
			}
			demand(listing.kind !== "exact_live" || closes.length > 0, "OVERRIDE_RETURN_FIRST", "Fresh listing shows the exact session live and idle and no fenced close was tried; run return instead");
			const stop = this.getOperation(taskId, "stop");
			const payload = { operator: approval.operator, reason: approval.reason, attemptId: task.attemptId, nodeId: task.nodeId ?? null, sessionId: task.sessionId ?? null, stopOperationId: stop?.id ?? null, stopReceipt: stop?.receipt ?? null, closes, freshListing: listing as unknown as Json, observedGone: false, physicalState: "possibly_running_on_node", at: new Date().toISOString() };
			const intent = this.insertIntent(task, "resource-return-override", payload);
			this.audit("resource_return_operator_override", { ...payload, ...this.diagnosticData(diagnostic) }, taskId);
			task.held = false;
			this.audit("released", { attemptId: task.attemptId, reason: "resource_return_operator_override" }, taskId);
			this.save(task);
			return intent;
		});
	}

	/** Called only with a fresh absence or exact-incarnation terminal observation from the
	 * controller. After an operator release the observation is still recorded (that is when
	 * the session stops being reported as possibly running) but nothing is released again. */
	confirmResourceReturn(taskId: string, attemptId: string, sessionId: string, evidence: Json): void {
		this.transaction("confirmResourceReturn", taskId, () => {
			const task = this.requireTask(taskId);
			const released = this.getOperation(taskId, "resource-return-override");
			demand(task.attemptId === attemptId && task.sessionId === sessionId && task.result?.executionTerminal && (task.resultManifest || released), "RETURN_BINDING", "Exact settled collected attempt required");
			const proof = evidence as any;
			demand(proof?.attemptId === attemptId && proof.sessionId === sessionId && proof.manifestDigest === (task.resultManifest ? digest(task.resultManifest) : null) && ["absent", "terminal"].includes(proof.observed) && Number.isSafeInteger(proof.indexSeq) && proof.indexSeq >= 0, "RETURN_BINDING", "Exact fresh absence and custody binding required");
			if (!released) this.cancellationOwnership(taskId);
			if (this.getOperation(taskId, "resource-return-confirmed")) return;
			if (released) {
				const floor = (released.payload as any)?.freshListing?.indexSeq;
				demand(!Number.isSafeInteger(floor) || proof.indexSeq > floor, "RETURN_STALE_LIST", "Observation not newer than the override's own listing");
				const observed = { ...proof, afterOperatorRelease: true, overrideOperationId: released.id };
				this.insertIntent(task, "resource-return-confirmed", observed);
				this.audit("resource_return_confirmed", { attemptId, sessionId, evidence: observed, afterOperatorRelease: true, released: false }, taskId);
				return;
			}
			this.insertIntent(task, "resource-return-confirmed", evidence);
			this.audit("resource_return_confirmed", { attemptId, sessionId, evidence }, taskId);
			if (task.held) {
				task.held = false;
				this.audit("released", { attemptId, reason: "resource_return_confirmed" }, taskId);
				this.save(task);
			}
		});
	}

	/** Pure read for CLI and dashboard: returned only after a fresh listing showed the
	 * session gone; an operator release without that observation is reported separately. */
	resourceReturnStatus(taskId: string): ResourceReturnStatus | undefined {
		const confirmed = this.getOperation(taskId, "resource-return-confirmed");
		const released = this.getOperation(taskId, "resource-return-override");
		return this.returnStatus(confirmed, released, () => this.taskState(taskId)?.nodeId ?? null);
	}

	/**
	 * `resourceReturnStatus` for many tasks from task states the caller already holds: one read of the two
	 * operation kinds instead of two task-row reads per task. Same value per task as `resourceReturnStatus(id)`.
	 */
	resourceReturnStatuses(states: readonly Pick<TaskState, "id" | "attemptId" | "nodeId">[]): Map<string, ResourceReturnStatus> {
		const byAttempt = new Map<string, { confirmed?: OperationIntent; released?: OperationIntent }>();
		const rows = this.db
			.query<{ attempt_id: string; kind: string; data: string }, []>("SELECT attempt_id, kind, data FROM operations WHERE kind IN ('resource-return-confirmed','resource-return-override')")
			.all();
		for (const row of rows) {
			const entry = byAttempt.get(row.attempt_id) ?? {};
			if (row.kind === "resource-return-confirmed") entry.confirmed = JSON.parse(row.data);
			else entry.released = JSON.parse(row.data);
			byAttempt.set(row.attempt_id, entry);
		}
		const out = new Map<string, ResourceReturnStatus>();
		for (const task of states) {
			const entry = task.attemptId ? byAttempt.get(task.attemptId) : undefined;
			const status = entry ? this.returnStatus(entry.confirmed, entry.released, () => task.nodeId ?? null) : undefined;
			if (status) out.set(task.id, status);
		}
		return out;
	}

	protected returnStatus(confirmed: OperationIntent | undefined, released: OperationIntent | undefined, nodeId: () => string | null): ResourceReturnStatus | undefined {
		if (confirmed) return { state: "returned", observedGone: true, observed: String((confirmed.payload as any)?.observed), afterOperatorRelease: Boolean(released) };
		if (!released) return undefined;
		const p = released.payload as any;
		return { state: "released_by_operator_unconfirmed", observedGone: false, possiblyRunningOnNode: true, statement: OPERATOR_RELEASE_STATEMENT, operator: String(p.operator), reason: String(p.reason), nodeId: p.nodeId ?? nodeId(), sessionId: p.sessionId ?? null, at: p.at ?? null };
	}

	recordSession(
		taskId: string,
		sessionId: string,
		validated = false,
		creation?: { operationId: string; ephemeral: boolean; cwd: string },
	): TaskRecord {
		return this.transaction("recordSession", taskId, () =>
			this.attachSession(taskId, sessionId, validated, creation),
		);
	}

	protected attachSession(
		taskId: string,
		sessionId: string,
		validated = false,
		creation?: { operationId: string; ephemeral: boolean; cwd: string },
	): TaskRecord {
		{
			const task = this.requireTask(taskId);
			text(sessionId);
			demand(
				task.attemptId,
				"NO_ATTEMPT",
				"Reserve before recording session identity",
			);
			demand(
				!task.sessionId || task.sessionId === sessionId,
				"SESSION_CONFLICT",
				"Session identity is immutable",
			);
			const owner = this.taskStates().find(
				(other) =>
					other.id !== taskId &&
					other.sessionId === sessionId &&
					other.nodeId === task.nodeId,
			);
			demand(
				!owner,
				"SESSION_CONFLICT",
				"Session already belongs to another attempt on this node",
			);
			if (!task.sessionId) {
				task.sessionId = sessionId;
				task.sessionValidated = validated === true;
				this.audit("session_recorded", { sessionId }, taskId, task);
				this.save(task);
				const create = this.getOperation(taskId, "create");
				if (
					task.nodeSnapshot?.sdkTransport &&
					validated &&
					creation?.ephemeral === true &&
					create?.id === creation.operationId &&
					(create.payload as any).cwd === creation.cwd &&
					(task.workspace as any)?.path === creation.cwd
				) {
					this.insertIntent(task, "session-ownership", {
						taskId,
						attemptId: task.attemptId!,
						nodeId: task.nodeId!,
						sessionId,
						workspace: task.workspace!,
						createOperationId: create.id,
						ephemeral: true,
						retirementRoute: "sdk-session-close-v1",
					});
				}
			}
			return task;
		}
	}

	recordTurn(taskId: string, turnId: string): TaskRecord {
		return this.transaction("recordTurn", taskId, () => {
			const task = this.requireTask(taskId);
			demand(
				!this.getOperation(taskId, "cancel"),
				"CANCEL_PENDING",
				"Cancellation fences late turn effects",
			);
			text(turnId);
			demand(task.sessionId, "NO_SESSION", "Record a session before its turn");
			demand(
				!task.turnId || task.turnId === turnId,
				"TURN_CONFLICT",
				"Turn identity is immutable",
			);
			if (!task.turnId) {
				demand(
					!task.result?.executionTerminal,
					"ALREADY_TERMINAL",
					"Cannot add a turn to a terminal attempt",
				);
				task.turnId = turnId;
				this.audit("turn_recorded", { turnId }, taskId, task);
				this.save(task);
			}
			return task;
		});
	}

	protected ownership(task: TaskRecord): OperationIntent {
		const owner = this.getOperation(task.id, "session-ownership");
		const create = this.getOperation(task.id, "create");
		const value = owner?.payload as any;
		demand(
			task.nodeSnapshot?.sdkTransport &&
				task.sessionValidated &&
				owner &&
				create &&
				value.retirementRoute === "sdk-session-close-v1" &&
				value.ephemeral === true &&
				value.taskId === task.id &&
				value.attemptId === task.attemptId &&
				value.nodeId === task.nodeId &&
				value.sessionId === task.sessionId &&
				value.createOperationId === create.id &&
				canonicalJson(value.workspace) === canonicalJson(task.workspace) &&
				(create.payload as any).cwd === (task.workspace as any)?.path &&
				!this.taskStates().some(
					(other) =>
						other.id !== task.id &&
						other.nodeId === task.nodeId &&
						other.sessionId === task.sessionId,
				),
			"CANCEL_UNSUPPORTED",
			"Fresh exclusive ephemeral ownership and SDK transport required",
		);
		return owner;
	}

	cancellationOwnership(taskId: string): OperationIntent {
		const task = this.requireTask(taskId);
		this.authority(task);
		return this.ownership(task);
	}

	protected authority(task: TaskRecord): OperationIntent {
		const owner = this.ownership(task);
		const receipt = this.getOperation(task.id, "session-authority");
		const value = receipt?.payload as any;
		demand(
			receipt &&
				value.ownershipOperationId === owner.id &&
				canonicalJson(value.ownership) === canonicalJson(owner.payload) &&
				value.sessionId === task.sessionId &&
				value.cwd === (task.workspace as any)?.path &&
				Number.isSafeInteger(value.endpointGeneration) &&
				value.endpointGeneration > 0 &&
				typeof value.endpointIncarnation === "string" &&
				/^[a-f0-9]{64}$/.test(value.endpointIncarnation),
			"CANCEL_UNSUPPORTED",
			"Original session authority receipt required",
		);
		return receipt;
	}

	recordSessionAuthority(
		taskId: string,
		authority: SessionAuthority,
	): OperationIntent {
		return this.transaction("recordSessionAuthority", taskId, () => {
			const task = this.requireTask(taskId);
			this.mutableAttempt(task);
			const owner = this.ownership(task);
			demand(
				!task.turnId &&
					!this.getOperation(taskId, "prompt") &&
					authority.sessionId === task.sessionId &&
					authority.cwd === (task.workspace as any)?.path &&
					Number.isSafeInteger(authority.endpointGeneration) &&
					authority.endpointGeneration > 0 &&
					typeof authority.endpointIncarnation === "string" &&
					/^[a-f0-9]{64}$/.test(authority.endpointIncarnation),
				"AUTHORITY_CONFLICT",
				"Original authority requires fresh ownership before any prompt intent or turn",
			);
			const payload = {
				sessionId: authority.sessionId,
				cwd: authority.cwd,
				endpointGeneration: authority.endpointGeneration,
				endpointIncarnation: authority.endpointIncarnation,
				ownershipOperationId: owner.id,
				ownership: owner.payload,
			};
			const previous = this.getOperation(taskId, "session-authority");
			if (previous) {
				demand(
					canonicalJson(previous.payload) === canonicalJson(payload),
					"AUTHORITY_CONFLICT",
					"Original authority is immutable",
				);
				return previous;
			}
			return this.insertIntent(task, "session-authority", payload);
		});
	}

	admitCancellation(
		taskId: string,
		snapshot: TaskRecord,
		freshAuthority: SessionAuthority,
	): OperationIntent {
		return this.transaction("admitCancellation", taskId, () => {
			this.assertDispatchEnabled();
			const task = this.requireTask(taskId);
			this.mutableAttempt(task);
			demand(
				["active", "approval_required"].includes(task.phase) &&
					task.turnId &&
					task.attemptId === snapshot.attemptId &&
					task.sessionId === snapshot.sessionId &&
					task.turnId === snapshot.turnId &&
					task.nodeId === snapshot.nodeId &&
					canonicalJson(task.workspace) === canonicalJson(snapshot.workspace),
				"CANCEL_BLOCKED",
				"Cancellation requires the current active exact attempt",
			);
			const owner = this.ownership(task);
			const authority = this.authority(task);
			const original = authority.payload as any;
			demand(
				freshAuthority &&
					freshAuthority.sessionId === original.sessionId &&
					freshAuthority.cwd === original.cwd &&
					freshAuthority.endpointGeneration === original.endpointGeneration &&
					freshAuthority.endpointIncarnation === original.endpointIncarnation &&
					canonicalJson(task.nodeSnapshot) ===
						canonicalJson(snapshot.nodeSnapshot),
				"AUTHORITY_CONFLICT",
				"Fresh authority must match the original session authority",
			);
			demand(
				!this.db
					.query<{ id: string }, [string]>(
						"SELECT id FROM operations WHERE attempt_id=? AND kind LIKE 'answer:%'",
					)
					.get(task.attemptId!),
				"ANSWER_PENDING",
				"Existing answer consumption must be reconciled before cancellation",
			);
			const op = this.insertIntent(task, "cancel", {
				ownership: owner.payload,
				authorityOperationId: authority.id,
				authority: authority.payload,
				turnId: task.turnId,
			});
			task.reason = "cancel_requested";
			this.save(task);
			return op;
		});
	}

	claimCancellationClose(taskId: string, abortReceipt: Json): OperationIntent {
		return this.transaction("claimCancellationClose", taskId, () => {
			this.assertDispatchEnabled();
			const task = this.requireTask(taskId);
			this.ownership(task);
			const authority = this.authority(task);
			const cancel = this.getOperation(taskId, "cancel");
			demand(
				(cancel?.payload as any)?.authorityOperationId === authority.id &&
					canonicalJson((cancel?.payload as any)?.authority) ===
						canonicalJson(authority.payload) &&
					canonicalJson(
						this.getOperation(taskId, "cancel-abort-reply")?.payload,
					) === canonicalJson(abortReceipt),
				"CANCEL_UNKNOWN",
				"Close must retain the original authority and actual abort reply",
			);
			const proof = (abortReceipt as any)?.result;
			// Installed GJC SDK (0.21.0, abortTerminal) answers an owned abort in one of two settled shapes:
			// it stopped the turn and the exact owned work, or the turn had already ended on its own
			// ({turn:"no_active_turn", terminal:"terminal_no_effect"}, no owned-work fields). The second is
			// accepted only with the native terminal receipt of this exact session and turn already retained.
			const stoppedOwned =
				proof?.selection === "owned" &&
				proof.turn === "stopped" &&
				proof.ownedWork === "stopped" &&
				proof.automaticDelivery === "none" &&
				proof.resumeOnOwnedCompletion === false;
			const endedNatively =
				proof?.selection === "owned" &&
				proof.turn === "no_active_turn" &&
				proof.terminal === "terminal_no_effect" &&
				this.retainedNativeTerminal(task);
			demand(
				(abortReceipt as any)?.ok === true &&
					proof?.ok === true &&
					(stoppedOwned || endedNatively),
				"CANCEL_UNCONFIRMED",
				"Owned-work settlement required before close",
			);
			demand(
				task.held &&
					this.getOperation(taskId, "cancel") &&
					!this.getOperation(taskId, "cancel-close"),
				"CANCEL_UNKNOWN",
				"Cancellation close cannot be replayed",
			);
			this.insertIntent(task, "cancel-abort-receipt", abortReceipt);
			const original = authority.payload as any;
			return this.insertIntent(task, "cancel-close", {
				sessionId: original.sessionId,
				endpointGeneration: original.endpointGeneration,
				endpointIncarnation: original.endpointIncarnation,
			});
		});
	}

	/** True when task.result is the native terminal of this exact session and turn, backed by its receipt. */
	private retainedNativeTerminal(task: TaskRecord): boolean {
		const result = task.result;
		if (!result?.executionTerminal || !task.sessionId || !task.turnId) return false;
		return this.db
			.query<{ data: string }, [string]>("SELECT data FROM receipts WHERE task_id=?")
			.all(task.id)
			.some(({ data }) => {
				const o = JSON.parse(data);
				return (
					o?.terminal === true &&
					o.sessionId === task.sessionId &&
					o.turnId === task.turnId &&
					o.status === result.status &&
					canonicalJson(o.evidence) === canonicalJson(result.evidence)
				);
			});
	}

	retainCancellationReply(
		taskId: string,
		stage: "abort" | "close",
		reply: Json,
	): void {
		this.transaction("retainCancellationReply", taskId, () => {
			const task = this.requireTask(taskId);
			demand(
				this.getOperation(taskId, "cancel") &&
					!this.getOperation(taskId, `cancel-${stage}-reply`),
				"CANCEL_UNKNOWN",
				"Original cancellation reply cannot be replaced",
			);
			demand(
				stage === "abort" || this.getOperation(taskId, "cancel-close"),
				"CANCEL_UNKNOWN",
				"Close reply requires its original intent",
			);
			this.insertIntent(task, `cancel-${stage}-reply`, reply);
		});
	}

	finishCancellation(taskId: string, closeReceipt: Json): TaskRecord {
		return this.transaction("finishCancellation", taskId, () => {
			const task = this.requireTask(taskId);
			if (task.phase === "archived") return task;
			const receipt = closeReceipt as any;
			const close = this.getOperation(taskId, "cancel-close");
			const original = this.authority(task).payload as any;
			const cancel = this.getOperation(taskId, "cancel");
			demand(
				task.held &&
					close &&
					close.digest === digest(close.payload) &&
					canonicalJson((cancel?.payload as any)?.authority) ===
						canonicalJson(original) &&
					this.getOperation(taskId, "cancel-abort-receipt") &&
					canonicalJson(close.payload) ===
						canonicalJson({
							sessionId: original.sessionId,
							endpointGeneration: original.endpointGeneration,
							endpointIncarnation: original.endpointIncarnation,
						}) &&
					canonicalJson(
						this.getOperation(taskId, "cancel-close-reply")?.payload,
					) === canonicalJson(closeReceipt) &&
					receipt?.ok === true &&
					receipt.operation === "session.close" &&
					receipt.result?.sessionId === task.sessionId,
				"CANCEL_UNKNOWN",
				"Exact authoritative session retirement required",
			);
			this.insertIntent(task, "cancel-close-receipt", closeReceipt);
			task.phase = "cancelled";
			if (!task.result?.executionTerminal)
				task.result = {
					status: "cancelled",
					evidence: {
						abort: this.getOperation(taskId, "cancel-abort-receipt")!.payload,
						close: closeReceipt,
					},
					executionTerminal: false,
					verified: false,
				};
			task.result.executionTerminal = true;
			task.held = false;
			delete task.reason;
			this.audit("released", { attemptId: task.attemptId! }, taskId);
			return this.save(task);
		});
	}

	cancellationUnknown(
		taskId: string,
		reason: string,
		context?: FailureContext,
		diagnostic?: FailureDiagnostic,
	): TaskRecord {
		return this.transaction("cancellationUnknown", taskId, () => {
			const task = this.requireTask(taskId);
			demand(
				this.getOperation(taskId, "cancel"),
				"CANCEL_BLOCKED",
				"Cancellation was not admitted",
			);
			if (!task.held) return task;
			task.phase = "cancel_unknown";
			task.reason = reason;
			this.audit(
				"cancel_unknown",
				{ reason, failure: this.failureAttributes(context), ...this.diagnosticData(diagnostic) },
				taskId,
			);
			return this.save(task);
		});
	}

	archive(taskId: string, token: object, actor = "operator"): TaskRecord {
		return this.transaction("archive", taskId, () => {
			const task = this.requireTask(taskId);
			text(actor);
			const evidence = consumeArchiveObservation(token, this as unknown as FleetStore, task);
			const evidenceDigest = digest({nodeId: evidence.nodeId, request: evidence.request});
			if (task.phase === "archived") {
				demand(task.archiveEvidenceDigest === evidenceDigest && task.archiveActor === actor,
					"ARCHIVE_CONFLICT", "Archive identity differs from retained evidence or actor");
				return task;
			}
			// A retained before_send preparation refusal proved nothing ran on the node; archiving is
			// its operator release route (the refused claim is never replayed).
			demand(["blocked_unknown", "cancel_unknown", "failed"].includes(task.phase) || this.retainedPreparationRefusal(taskId),
				"ARCHIVE_PHASE", "Only unknown or failed tasks may be archived");
			this.archiveObservationChecks(task, evidence);
			task.archivedFrom = { phase: task.phase, ...(task.reason !== undefined ? { reason: task.reason } : {}),
				...(task.result !== undefined ? { result: task.result } : {}) };
			task.archivedAt = new Date().toISOString();
			task.archiveActor = actor;
			task.archiveEvidenceDigest = evidenceDigest;
			task.phase = "archived";
			// Lane progress is display only and never shown for an archived task: not retained.
			delete task.progress;
			if (task.held) this.audit("released", { attemptId: task.attemptId ?? null, cause: "archived" }, taskId);
			task.held = false;
			this.audit("archived", { archivedFrom: task.archivedFrom as unknown as Json,
				archivedAt: task.archivedAt, actor, evidenceDigest, observation: {nodeId: evidence.nodeId, capturedAt: evidence.capturedAt, command: evidence.command, rawResponseDigest: evidence.rawResponseDigest}, request: evidence.request }, taskId);
			return this.save(task);
		});
	}

	/**
	 * What `task archive` checks on its fresh Fleet session observation (operator-run lease, evidence
	 * freshness and completeness, create outcome, live original session). The one copy: archive and
	 * dispose both run it. Reads row metadata only.
	 */
	protected archiveObservationChecks(task: TaskState, evidence: any): void {
			const taskId = task.id;
			const run = this.getOperation(taskId, "operator-run");
			demand(!(run && run.receipt === undefined && run.lease && run.lease.expiresAt > Date.now()),
				"ARCHIVE_IN_PROGRESS", "An operator run still holds this task's start lease");
			const age = Date.now() - Date.parse(evidence.capturedAt);
			const list = evidence.sessionList as any;
			demand(typeof task.nodeId === "string" && task.nodeId.trim().length > 0 && evidence.nodeId === task.nodeId, "ARCHIVE_NODE", "Present equal nodeId required");
			const retired = evidence.request.operatorOverride?.kind === "node_retired";
			demand(Number.isFinite(age) && age >= 0 && age <= 300000 && (retired || (
				list?.ok === true && list.result?.version === 2 && list.result.source === "broker" &&
				list.result.scope === "all" && list.result.selection?.scope === "all" &&
				Array.isArray(list.result.sessions) && Array.isArray(list.result.warnings) &&
				list.result.warnings.length === 0 && list.result.truncated !== true && list.result.hasMore !== true &&
				list.result.partial !== true && list.result.complete !== false && !list.result.nextCursor)),
				"ARCHIVE_EVIDENCE", "Fresh complete all-scope broker session-list evidence for the task node required");
			const workspace = task.workspace as any;
			if (!task.sessionId && this.getOperation(taskId, "create")?.receipt === undefined) {
				const confirmation = evidence.request.noSessionConfirmation ?? evidence.request.operatorOverride;
				demand(["never_started", "create_outcome_unknown_operator_confirmed"].includes(confirmation?.kind), "ARCHIVE_CREATE_UNKNOWN", "No session or create outcome requires explicit operator classification and reason");
			}
			for (const session of list?.result?.sessions ?? []) {
				// Sessions started outside a git worktree legitimately report null/absent path fields;
				// null/absent means "not provided", any other non-string (or empty) value is malformed.
				const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
				const optionalPath = (value: unknown) => value === undefined || value === null || (typeof value === "string" && value.length > 0);
				const locator = session?.locator;
				demand(record(session) && typeof session.sessionId === "string" && session.sessionId.length > 0 &&
					typeof session.live === "boolean" && (locator === undefined || locator === null || record(locator)) &&
					optionalPath(session.cwd) && optionalPath(locator?.cwd) && optionalPath(locator?.worktreeRoot) && optionalPath(locator?.stateRoot),
					"ARCHIVE_EVIDENCE", "Incomplete session identity or liveness");
				const paths = [session.cwd, ...Object.values(locator ?? {})].filter((path): path is string => typeof path === "string" && path.length > 0);
				const matches = session.sessionId === task.sessionId || session.taskId === task.id ||
					(task.attemptId && session.attemptId === task.attemptId) || paths.some((path: string) =>
						path === workspace?.path || path.includes(task.id) || (!!task.attemptId && path.includes(task.attemptId)));
				demand(!(matches && session.live), "ARCHIVE_LIVE_SESSION", "Original task or attempt session is still live");
				// A live session with no locating path could be running inside the task workspace under an
				// unrecorded id; a differing sessionId does not prove it unrelated.
				demand(!(session.live && paths.length === 0), "ARCHIVE_EVIDENCE", "Live session without any locating path cannot be proven unrelated");
			}
	}

	/**
	 * Refusals of a disposition that need no node observation. Returns true when the task already
	 * carries exactly this disposition by this actor (an idempotent repeat). Row metadata only.
	 */
	protected dispositionPrecheck(task: TaskState, request: DispositionRequest, actor: string): boolean {
		if (task.phase === "archived") {
			demand(task.disposition, "DISPOSE_CONFLICT", "Task was archived without a disposition; a disposition is never added to an archived task");
			demand(task.disposition.requestDigest === digest(request as unknown as Json) && task.disposition.actor === actor,
				"DISPOSE_CONFLICT", "Task already carries a different disposition or actor; a disposition is never overwritten");
			return true;
		}
		demand(task.phase === "completed_unverified", "DISPOSE_PHASE", "Only completed_unverified tasks may be disposed");
		demand(task.result?.executionTerminal === true, "DISPOSE_NOT_TERMINAL",
			"Execution end is not confirmed; the attempt keeps its slot until a terminal observation releases it");
		if (task.nodeId) {
			const pass = this.resourceReturnNode(task.nodeId);
			demand(!(pass && pass.expires > Date.now()), "DISPOSE_RETURN_IN_PROGRESS", "A resource-return pass holds this task's node; retry after it ends");
		}
		// A disposition never releases a reservation and never judges a session listing for one: a held
		// task leaves its reservation only through resource return (or its audited operator override).
		demand(task.held !== true, "DISPOSE_RESOURCE_UNPROVEN",
			`Task ${task.id} still holds its node reservation and a disposition never releases one; run 'return ${task.id}' first (or the audited 'return-override ${task.id} JSON'), then dispose`);
		if (request.kind === "superseded") {
			const seen = new Set<string>([task.id]);
			let next = this.taskState(request.supersededBy!);
			demand(next && next.id !== task.id, "DISPOSE_SUPERSEDER", "--by must name an existing different task");
			// Never a cycle: a chain of superseded-by records always ends at a task that is not superseded.
			while (next?.disposition?.kind === "superseded") {
				const by = next.disposition.supersededBy!;
				demand(!seen.has(by), "DISPOSE_SUPERSEDER", "Superseding task is itself superseded by this task (cycle)");
				seen.add(next.id);
				next = this.taskState(by);
			}
		}
		return false;
	}

	/**
	 * Pre-observation check of a disposition, before the node is contacted. True: already disposed exactly
	 * so. Writes nothing on success; a refusal is recorded like every Store.transaction refusal, except
	 * for a dry run, which writes nothing at all.
	 */
	checkDisposition(taskId: string, request: DispositionRequest, actor: string, dryRun = false): boolean {
		request = normaliseDisposition(request);
		demand(boundedText(actor, DISPOSITION_LIMITS.actor), "DISPOSE_INPUT", "A nonempty actor of at most 200 characters is required");
		const body = () => this.dispositionPrecheck(this.requireTaskState(taskId), request, actor);
		return dryRun ? this.db.transaction(body).deferred() : this.transaction("dispose", taskId, body);
	}

	/**
	 * Audited operator disposition of a completed_unverified task, through the archive machinery:
	 * the same observation checks, archivedFrom and actor/evidence digest as archive. It never releases a
	 * reservation: a held task is refused (DISPOSE_RESOURCE_UNPROVEN) until resource return releases it. The row's stored result (inline manifest or externalised reference) is carried over
	 * byte-identical: the result is never decoded, verified, rehydrated, re-encoded, externalised or
	 * deleted, and a row whose stored text is not canonical is refused rather than rewritten. With
	 * dryRun nothing is written (no refusal record either) and the planned record is returned.
	 */
	dispose(taskId: string, request: DispositionRequest, token: object | undefined, actor: string, dryRun = false): {
		task: TaskState; outcome: "disposed" | "already_disposed" | "would_dispose"; releasedReservation: false; disposition: Omit<TaskDisposition, "at"> & { at?: string };
	} {
		request = normaliseDisposition(request);
		demand(boundedText(actor, DISPOSITION_LIMITS.actor), "DISPOSE_INPUT", "A nonempty actor of at most 200 characters is required");
		const body = () => {
			const task = this.requireTaskState(taskId);
			if (this.dispositionPrecheck(task, request, actor))
				return { task, outcome: "already_disposed" as const, releasedReservation: false as const, disposition: task.disposition! };
			demand(token, "ARCHIVE_AUTHORITY", "Trusted Fleet archive observation required");
			const evidence = consumeArchiveObservation(token, this as unknown as FleetStore, task);
			this.archiveObservationChecks(task, evidence);
			const raw = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?").get(taskId)!;
			const row = JSON.parse(raw.data);
			demand(canonicalJson(row) === raw.data, "DISPOSE_ROW_FORM", "Stored task row is not in canonical form; it is never rewritten here");
			const planned = { ...request, actor, requestDigest: digest(request as unknown as Json), statement: DISPOSITION_STATEMENT[request.kind], verifiedByFleet: false as const };
			const releasedReservation = false as const;
			if (dryRun) return { task, outcome: "would_dispose" as const, releasedReservation: releasedReservation as false, disposition: planned };
			// Bound to the disposition too: `task archive` never takes a disposed task as its own archive.
			const evidenceDigest = digest({nodeId: evidence.nodeId, request: evidence.request, disposition: planned.requestDigest});
			const disposition: TaskDisposition = { ...planned, at: new Date().toISOString() };
			// Only these row keys change; every other key, the stored result included, is carried as parsed.
			const changed = {
				archivedFrom: { phase: task.phase, ...(task.reason !== undefined ? { reason: task.reason } : {}),
					...(task.result !== undefined ? { result: task.result } : {}) },
				archivedAt: disposition.at,
				archiveActor: actor,
				archiveEvidenceDigest: evidenceDigest,
				phase: "archived" as const,
				held: false,
				disposition,
			};
			this.audit("archived", { archivedFrom: changed.archivedFrom as unknown as Json,
				archivedAt: changed.archivedAt, actor, evidenceDigest, observation: {nodeId: evidence.nodeId, capturedAt: evidence.capturedAt, command: evidence.command, rawResponseDigest: evidence.rawResponseDigest}, request: evidence.request,
				disposition: disposition as unknown as Json }, taskId);
			// Lane progress is display only and never shown for an archived task: not retained (as archive).
			const { progress: _rowProgress, ...kept } = row;
			const updated = canonicalJson({ ...kept, ...changed } as unknown as Json);
			const changes = this.db.query("UPDATE tasks SET data=? WHERE id=? AND data=?").run(updated, taskId, raw.data).changes;
			demand(changes === 1, "DISPOSE_ROW_FORM", "Task row changed during disposition");
			const { progress: _taskProgress, ...rest } = task;
			return { task: { ...rest, ...changed }, outcome: "disposed" as const, releasedReservation: releasedReservation as false, disposition };
		};
		if (dryRun) return this.db.transaction(body).deferred();
		return this.transaction("dispose", taskId, body);
	}

	/**
	 * Audited operator withdrawal (`queue withdraw`) of a queued task that never had an admitted attempt: no
	 * attempt id, node snapshot, session, workspace, reservation or operation row, so nothing was ever sent to a
	 * node. It ends in the existing terminal phase `archived` (archivedFrom keeps phase and reason) with a
	 * `withdrawal` record and one `withdrawn` audit row; it contacts no node. One write transaction, so it is
	 * atomic against a concurrent reserve: a withdrawn task is never reserved (archived), and a task reserved
	 * first is refused here (WITHDRAW_ATTEMPTED; cancel/return/task archive keep owning it). Any repeat on a
	 * withdrawn task returns `already_withdrawn` and writes nothing.
	 */
	withdrawQueued(taskId: string, reason: string, actor: string): { task: TaskState; outcome: "withdrawn" | "already_withdrawn"; withdrawal: TaskWithdrawal; nodeContacted: false } {
		return this.transaction("withdraw", taskId, () => {
			demand(boundedText(reason, WITHDRAWAL_LIMITS.reason), "WITHDRAW_INPUT", `A nonempty reason of at most ${WITHDRAWAL_LIMITS.reason} characters is required`);
			demand(boundedText(actor, WITHDRAWAL_LIMITS.actor), "WITHDRAW_INPUT", `A nonempty actor of at most ${WITHDRAWAL_LIMITS.actor} characters is required`);
			const task = this.requireTask(taskId);
			if (task.withdrawal) return { task, outcome: "already_withdrawn" as const, withdrawal: task.withdrawal, nodeContacted: false as const };
			const operation = this.db.query("SELECT 1 FROM operations WHERE task_id=? LIMIT 1").get(taskId);
			demand(
				!task.attemptId && !task.nodeSnapshot && !task.sessionId && !task.held && task.workspace === undefined && !operation,
				"WITHDRAW_ATTEMPTED",
				`Task ${task.id} has an admitted attempt; withdraw only takes never-admitted queued tasks (use cancel, return or task archive)`,
			);
			demand(task.phase === "queued", "WITHDRAW_PHASE", `Only a queued task can be withdrawn; task ${task.id} is ${task.phase}`);
			const at = new Date().toISOString();
			const withdrawal: TaskWithdrawal = { actor, reason, at };
			const archivedFrom = { phase: task.phase, ...(task.reason !== undefined ? { reason: task.reason } : {}) };
			const placement = task.placement;
			delete task.placement;
			Object.assign(task, { archivedFrom, archivedAt: at, archiveActor: actor, phase: "archived", held: false, withdrawal });
			this.audit("withdrawn", { actor, reason, archivedFrom, ...(placement ? { placement: placement as unknown as Json } : {}), nodeContacted: false }, taskId, task);
			return { task: this.save(task), outcome: "withdrawn" as const, withdrawal, nodeContacted: false as const };
		});
	}
}
