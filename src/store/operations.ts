import { randomUUID } from "node:crypto";
import { Json, OperationIntent, OperationLease, Phase, TaskRecord } from "../contracts";
import { canonicalJson, demand, digest, nonemptyEvidence, object, text } from "../core";
import { FailureDiagnostic } from "../diagnostic";
import { settledExecution } from "../execution";
import { DAEMON_LEASE_KEY, DAEMON_STATUS_LIMIT, DaemonLeaseHolder, DataRow, RELEASABLE_CLAIM_KINDS, SEND_CLAIM_KINDS, SchedulingRow, nodeFailureCode, operatorRunPayload, preparationReevaluationOutcomes, refusalCode, resultTestBinding } from "./shared";
import { StoreResults } from "./results";

export abstract class StoreOperations extends StoreResults {
	beginOperation(taskId: string, kind: string, payload: Json): OperationIntent {
		return this.operation(taskId, kind, payload, false)!;
	}

	/** `owner`: the claimer's identity lease, kept only on a verifier claim (verify-test, result-test) so a
	 * later caller can tell a live concurrent verifier from a claim whose owner is gone. Never in the digest. */
	claimOperation(
		taskId: string,
		kind: string,
		payload: Json,
		owner?: OperationLease,
	): OperationIntent | null {
		return this.operation(taskId, kind, payload, true, owner);
	}

	claimResultTest(taskId: string, argv: string[], owner?: OperationLease): OperationIntent | null {
		return this.claimOperation(taskId, "result-test", resultTestBinding(this.requireTask(taskId), argv), owner);
	}

	/** Pure read; an older read-only database without the table simply has no lease (null). */
	resourceReturnNode(nodeId: string): { token: string; expires: number } | null {
		if (!this.hasTable("resource_return_leases")) return null;
		return this.db.query("SELECT token, expires FROM resource_return_leases WHERE node_id=?").get(nodeId) as { token: string; expires: number } | null;
	}

	/** Pacing lease only. It is wall-clock based and is NOT the mutation fence: a
	 * settled-session close is excluded by its durable per-attempt claim
	 * (claimResourceReturnClose, UNIQUE(attempt_id,kind)) and by the broker's exact
	 * generation/incarnation check. An expired lease is taken over by token CAS without
	 * consulting unrelated tasks, so no legacy row can block a node forever. */
	claimResourceReturnNode(nodeId: string, token: string): boolean {
		return this.transaction("claimResourceReturnNode", undefined, () => {
			text(nodeId); text(token);
			const now = Date.now();
			const prior = this.resourceReturnNode(nodeId);
			if (prior) {
				if (prior.expires > now) return false;
				return this.db.query("UPDATE resource_return_leases SET token=?,expires=? WHERE node_id=? AND token=? AND expires<=?").run(token, now + 120000, nodeId, prior.token, now).changes === 1;
			}
			return this.db.query("INSERT OR IGNORE INTO resource_return_leases VALUES (?,?,?)").run(nodeId, token, now + 120000).changes === 1;
		});
	}

	renewResourceReturnNode(nodeId: string, token: string): boolean {
		return this.transaction("renewResourceReturnNode", undefined, () => this.db.query("UPDATE resource_return_leases SET expires=? WHERE node_id=? AND token=? AND expires>?").run(Date.now() + 120000, nodeId, token, Date.now()).changes === 1);
	}

	releaseResourceReturnNode(nodeId: string, token: string): void {
		this.transaction("releaseResourceReturnNode", undefined, () => {
			this.db.query("DELETE FROM resource_return_leases WHERE node_id=? AND token=?").run(nodeId, token);
		});
	}

	/** Raw daemon lease row; an older read-only database without the lease table has none. */
	protected daemonLeaseRow(): { token: string; expires: number } | null {
		if (!this.hasTable("resource_return_leases")) return null;
		return this.db
			.query<{ token: string; expires: number }, [string]>("SELECT token, expires FROM resource_return_leases WHERE node_id=?")
			.get(DAEMON_LEASE_KEY);
	}

	/** Pure read of the daemon owner lease. An unparsable token (never written by this build) is reported with owner = token. */
	daemonLease(): { holder: DaemonLeaseHolder; expires: number } | null {
		const row = this.daemonLeaseRow();
		if (!row) return null;
		let holder: any;
		try {
			holder = JSON.parse(row.token);
		} catch {
			holder = undefined;
		}
		const valid = holder && typeof holder === "object" && typeof holder.owner === "string" && Number.isSafeInteger(holder.pid) && typeof holder.host === "string" && typeof holder.startedAt === "string";
		return { holder: valid ? holder : { owner: row.token, pid: 0, host: "", startedAt: "" }, expires: row.expires };
	}

	/**
	 * Single-instance guarantee of the daemon: the same wall-clock token-CAS lease as the resource-return
	 * pacing lease, on a key that is never a node id. Taken when absent, expired, or when `replaceable`
	 * (the caller's liveness check of the holder process) says the holder is gone. Like that lease it is
	 * NOT a mutation fence: effects stay fenced by their durable claims (UNIQUE(attempt_id,kind)).
	 */
	claimDaemonLease(holder: DaemonLeaseHolder, ttlMs: number, replaceable: (held: { holder: DaemonLeaseHolder; expires: number }) => boolean = () => false, clock: () => number = Date.now): boolean {
		return this.transaction("claimDaemonLease", undefined, () => {
			text(holder?.owner); text(holder?.host); text(holder?.startedAt);
			demand(holder.owner.length <= 128 && holder.host.length <= 256 && Number.isSafeInteger(holder.pid) && holder.pid > 0 && Number.isSafeInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= 600_000, "INVALID_INPUT", "Bounded daemon lease holder and lifetime required");
			const now = clock();
			const token = canonicalJson({ owner: holder.owner, pid: holder.pid, host: holder.host, startedAt: holder.startedAt });
			const prior = this.daemonLeaseRow();
			if (prior) {
				const held = this.daemonLease()!;
				if (prior.expires > now && !replaceable(held)) return false;
				return this.db.query("UPDATE resource_return_leases SET token=?,expires=? WHERE node_id=? AND token=?").run(token, now + ttlMs, DAEMON_LEASE_KEY, prior.token).changes === 1;
			}
			return this.db.query("INSERT OR IGNORE INTO resource_return_leases VALUES (?,?,?)").run(DAEMON_LEASE_KEY, token, now + ttlMs).changes === 1;
		});
	}

	/** Renews only while `owner` holds the unexpired lease, publishing its bounded status in the same row. */
	renewDaemonLease(owner: string, ttlMs: number, status: Json, clock: () => number = Date.now): boolean {
		return this.transaction("renewDaemonLease", undefined, () => {
			text(owner);
			demand(Number.isSafeInteger(ttlMs) && ttlMs >= 1000 && ttlMs <= 600_000, "INVALID_INPUT", "Bounded daemon lease lifetime required");
			const now = clock();
			const prior = this.daemonLeaseRow();
			const held = this.daemonLease();
			if (!prior || !held || held.holder.owner !== owner || prior.expires <= now) return false;
			const { status: _previous, ...holder } = held.holder;
			const token = canonicalJson({ ...holder, status });
			demand(Buffer.byteLength(token) <= DAEMON_STATUS_LIMIT, "INVALID_INPUT", "Daemon status exceeds its byte limit");
			return this.db.query("UPDATE resource_return_leases SET token=?,expires=? WHERE node_id=? AND token=?").run(token, now + ttlMs, DAEMON_LEASE_KEY, prior.token).changes === 1;
		});
	}

	/** Graceful stop: removes the row only for its own owner, so the store looks as if no daemon ever ran. */
	releaseDaemonLease(owner: string): boolean {
		return this.transaction("releaseDaemonLease", undefined, () => {
			text(owner);
			const prior = this.daemonLeaseRow();
			if (!prior || this.daemonLease()!.holder.owner !== owner) return false;
			return this.db.query("DELETE FROM resource_return_leases WHERE node_id=? AND token=?").run(DAEMON_LEASE_KEY, prior.token).changes === 1;
		});
	}

	/** Read-only view of the daemon for CLI, dashboard and observability; undefined when no daemon row exists. */
	daemonStatus(now = Date.now()): { alive: boolean; leaseExpiresAt: string; owner: string; pid: number; host: string; startedAt: string; status: Json } | undefined {
		const lease = this.daemonLease();
		if (!lease) return undefined;
		return {
			alive: lease.expires > now,
			leaseExpiresAt: new Date(lease.expires).toISOString(),
			owner: lease.holder.owner,
			pid: lease.holder.pid,
			host: lease.holder.host,
			startedAt: lease.holder.startedAt,
			status: lease.holder.status ?? null,
		};
	}

	/**
	 * Why the daemon did not act on a task, as an audit observation written at most once per task attempt
	 * and note (repeated cycles add nothing). Not a conversion: nothing about the task changes.
	 */
	recordDaemonNote(taskId: string, note: string): boolean {
		return this.transaction("recordDaemonNote", taskId, () => {
			// Uppercase is allowed so notes can embed Fleet error codes (e.g. RESULT_BINDING) without
			// failing the audit write after a custody claim; claim / no-replay fences stay separate.
			demand(typeof note === "string" && /^[a-zA-Z0-9_:.-]{1,160}$/.test(note), "INVALID_INPUT", "Bounded daemon note required");
			const task = this.taskState(taskId);
			demand(task, "TASK_NOT_FOUND", "Unknown task");
			const attemptId = task.attemptId ?? null;
			const seen = this.db
				.query("SELECT 1 FROM audit WHERE task_id=? AND kind='daemon_note' AND json_extract(data,'$.note')=? AND json_extract(data,'$.attemptId') IS ? LIMIT 1")
				.get(taskId, note, attemptId);
			if (seen) return false;
			this.audit("daemon_note", { note, attemptId }, taskId, task);
			return true;
		});
	}

	/**
	 * Change feed of the scheduling projection: every write of a task row commits an audit event for that
	 * task in the same transaction (except the poll counter, which the projection does not contain), and a
	 * new task gets a larger rowid. A cursor taken before the projection is read therefore never misses a
	 * change; one that arrives during the read is reported again next time.
	 */
	schedulingCursor(): { audit: number; rowid: number } {
		const row = this.db
			.query<{ audit: number | null; rowid: number | null }, []>("SELECT (SELECT max(sequence) FROM audit) AS audit, (SELECT max(rowid) FROM tasks) AS rowid")
			.get()!;
		return { audit: row.audit ?? 0, rowid: row.rowid ?? 0 };
	}

	/** Task ids changed after `since` (see schedulingCursor), or undefined when more than `limit` changed. */
	schedulingChanges(since: { audit: number; rowid: number }, limit = 1000): string[] | undefined {
		demand(Number.isSafeInteger(since.audit) && Number.isSafeInteger(since.rowid) && Number.isSafeInteger(limit) && limit > 0, "INVALID_INPUT", "Bounded scheduling cursor required");
		const ids = this.db
			.query<{ id: string }, [number, number, number]>(
				"SELECT id FROM (SELECT DISTINCT task_id AS id FROM audit WHERE sequence>? AND task_id IS NOT NULL UNION SELECT id FROM tasks WHERE rowid>?) LIMIT ?",
			)
			.all(since.audit, since.rowid, limit + 1)
			.map((row) => row.id);
		return ids.length > limit ? undefined : ids;
	}

	/**
	 * The scheduling projection of every task, or of the given ids (rowid order). SQLite extracts only scalars
	 * and type tests, so neither result form, the prompt nor observation evidence is materialised in this process.
	 */
	schedulingIndex(ids?: readonly string[]): SchedulingRow[] {
		type Row = { id: string; phase: Phase; node_id: string | null; attempt_id: string | null; session_id: string | null; turn_id: string | null; held: number | null; reason: unknown; approval: unknown; terminal: number | null; status: unknown; auto_custody: number; settled_at: unknown; late_until: unknown; late_receipt: number; result_stored: number; workspace: number; sdk: number; node_os: unknown };
		const str = (value: unknown) => (typeof value === "string" ? value : undefined);
		return this.db
			.query<Row, string[]>(
				`SELECT id, json_extract(data,'$.phase') AS phase, json_extract(data,'$.nodeId') AS node_id,
					json_extract(data,'$.attemptId') AS attempt_id, json_extract(data,'$.sessionId') AS session_id,
					json_extract(data,'$.turnId') AS turn_id, json_extract(data,'$.held') AS held, json_extract(data,'$.reason') AS reason,
					json_extract(data,'$.input.approvalContract') AS approval, json_extract(data,'$.result.executionTerminal') AS terminal,
					json_extract(data,'$.result.status') AS status, json_type(data,'$.input.autoCustody') IS NOT NULL AS auto_custody, json_extract(data,'$.result.settlement.settledAt') AS settled_at,
					json_extract(data,'$.result.settlement.lateObservationUntil') AS late_until,
					json_type(data,'$.result.lateReceipt') IS NOT NULL AS late_receipt,
					(json_type(data,'$.resultManifest') IS NOT NULL OR json_type(data,'$.resultExternal') IS NOT NULL) AS result_stored,
					json_type(data,'$.workspace') IS NOT NULL AS workspace, json_type(data,'$.nodeSnapshot.sdkTransport') IS NOT NULL AS sdk,
					json_extract(data,'$.nodeSnapshot.os') AS node_os
				FROM tasks ${ids ? "WHERE id IN (SELECT value FROM json_each(?))" : ""} ORDER BY rowid`,
			)
			.all(...(ids ? [JSON.stringify(ids)] : []))
			.map((row) => ({
				id: row.id,
				phase: row.phase,
				...(typeof row.node_id === "string" ? { nodeId: row.node_id } : {}),
				...(typeof row.attempt_id === "string" ? { attemptId: row.attempt_id } : {}),
				...(typeof row.session_id === "string" ? { sessionId: row.session_id } : {}),
				...(typeof row.turn_id === "string" ? { turnId: row.turn_id } : {}),
				held: row.held === 1,
				...(str(row.reason) !== undefined ? { reason: str(row.reason) } : {}),
				...(str(row.approval) !== undefined ? { approvalContract: str(row.approval) } : {}),
				executionTerminal: row.terminal === 1,
				...(str(row.status) !== undefined ? { resultStatus: str(row.status) } : {}),
				...(row.auto_custody === 1 ? { autoCustody: true } : {}),
				...(str(row.settled_at) !== undefined ? { settledAt: str(row.settled_at) } : {}),
				...(str(row.late_until) !== undefined ? { lateObservationUntil: str(row.late_until) } : {}),
				lateReceipt: row.late_receipt === 1,
				resultStored: row.result_stored === 1,
				workspace: row.workspace === 1,
				sdkTransport: row.sdk === 1,
				...(str(row.node_os) !== undefined ? { nodeOs: str(row.node_os) } : {}),
			}));
	}

	/** Operation kinds recorded for exactly this attempt of the task (no task row is read). */
	attemptOperationKinds(taskId: string, attemptId: string): Set<string> {
		text(taskId); text(attemptId);
		return new Set(
			this.db
				.query<{ kind: string }, [string, string]>("SELECT kind FROM operations WHERE task_id=? AND attempt_id=?")
				.all(taskId, attemptId)
				.map((row) => row.kind),
		);
	}

	getOperation(taskId: string, kind: string): OperationIntent | undefined {
		text(kind);
		// Only the attempt id is needed: never read (or fail on) the task's result here.
		const task = this.requireTaskState(taskId);
		if (!task.attemptId) return undefined;
		const row = this.db
			.query<DataRow, [string, string]>(
				"SELECT data FROM operations WHERE attempt_id=? AND kind=?",
			)
			.get(task.attemptId, kind);
		return row ? JSON.parse(row.data) : undefined;
	}

	/** Retain an already claimed effect's evidence, including late replies after rollback.
	 * This does not authorize dispatch, settle an execution or release its held attempt. */
	recordOperationReceipt(
		taskId: string,
		kind: string,
		operationId: string,
		receipt: Json,
	): OperationIntent {
		return this.transaction("recordOperationReceipt", taskId, () => {
			text(kind);
			text(operationId);
			nonemptyEvidence(receipt);
			const task = this.requireTask(taskId);
			const row = this.db.query<DataRow, [string, string, string, string]>(
				"SELECT data FROM operations WHERE task_id=? AND attempt_id=? AND kind=? AND id=?",
			).get(taskId, task.attemptId ?? "", kind, operationId);
			demand(row && task.attemptId, "OPERATION_BINDING", "Exact original task, attempt and claim required");
			const intent: OperationIntent = JSON.parse(row.data);
			demand(!(kind === "result-test" && task.disposition), "ARCHIVED_TASK", "A disposed task is an operator record; a late result-test receipt is never recorded onto it");
			demand(
				intent.taskId === taskId && intent.attemptId === task.attemptId &&
				intent.kind === kind && intent.id === operationId && intent.key === intent.id &&
				intent.digest === digest(intent.payload),
				"OPERATION_BINDING", "Stored operation does not match original claim",
			);
			const encodedReceipt = canonicalJson(receipt);
			if (intent.receipt !== undefined) {
				demand(canonicalJson(intent.receipt) === encodedReceipt, "OPERATION_CONFLICT", "Operation receipt is immutable");
				return intent;
			}
			intent.receipt = JSON.parse(encodedReceipt);
			this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind=? AND id=?")
				.run(canonicalJson(intent), taskId, task.attemptId, kind, operationId);
			this.audit("operation_receipt", { operationId, kind, digest: digest(receipt) }, taskId);
			if (this.clearOwnerGone(task, kind, operationId)) this.save(task);
			return intent;
		});
	}

	/**
	 * Release a post-execution verifier claim (verify-test, result-test) whose verifier request
	 * provably never reached the node: the caller saw a proven before_send failure of that request, or
	 * failed before sending it. Only the exact, unreceipted claim of the current attempt is deleted
	 * (never a claim with a receipt, never one whose test receipt is retained), so the same task can be
	 * verified once its environment is repaired; an uncertain outcome is never released. The release is
	 * audited (`operation_claim_released`) with the deny-by-default diagnostic of the failure. Returns
	 * false when that exact claim no longer exists (already released or superseded).
	 */
	releaseUnsentClaim(taskId: string, kind: string, operationId: string, diagnostic?: FailureDiagnostic): boolean {
		return this.transaction("releaseUnsentClaim", taskId, () => {
			text(kind);
			text(operationId);
			demand(RELEASABLE_CLAIM_KINDS.has(kind), "RESERVED_OPERATION", "Only an unsent verifier claim can be released");
			const task = this.requireTask(taskId);
			const row = this.db.query<DataRow, [string, string, string, string]>(
				"SELECT data FROM operations WHERE task_id=? AND attempt_id=? AND kind=? AND id=?",
			).get(taskId, task.attemptId ?? "", kind, operationId);
			if (!row) return false;
			const intent: OperationIntent = JSON.parse(row.data);
			demand(
				intent.taskId === taskId && intent.attemptId === task.attemptId && intent.kind === kind &&
					intent.id === operationId && intent.digest === digest(intent.payload) && intent.receipt === undefined && intent.held === undefined &&
					(kind !== "verify-test" || task.testReceipt === undefined),
				"OPERATION_BINDING",
				"Only the exact unreceipted verifier claim can be released",
			);
			this.db.query("DELETE FROM operations WHERE task_id=? AND attempt_id=? AND kind=? AND id=?")
				.run(taskId, task.attemptId!, kind, operationId);
			if (this.clearOwnerGone(task, kind, operationId)) this.save(task);
			this.audit(
				"operation_claim_released",
				{ operationId, kind, digest: intent.digest, cause: "verifier_not_sent", ...this.diagnosticData(diagnostic) },
				taskId,
			);
			return true;
		});
	}

	/**
	 * The current attempt's prepare claim when it is a retained, proven before_send refusal: the
	 * task is held in `dispatching` with no workspace, session, turn, cancel or terminal result,
	 * and the attempt has exactly one effect operation, an unaltered prepare claim whose only receipt
	 * is a bounded `before_send` node refusal. The only other row admitted is the exact, unreceipted
	 * `operator-run` claim of this attempt: a run's start lease, never sent to a node. Anything else
	 * (including unknown, legacy or effectful outcomes, archived or released tasks) is not a retained
	 * refusal.
	 */
	retainedPreparationRefusal(taskId: string): OperationIntent | undefined {
		// Metadata only (M2): listings call this per task; the result is never read here.
		const task = this.requireTaskState(taskId);
		if (
			!task.attemptId ||
			!task.held ||
			task.phase !== "dispatching" ||
			task.workspace ||
			task.sessionId ||
			task.turnId ||
			task.result?.executionTerminal
		)
			return undefined;
		const rows = this.db
			.query<DataRow, [string, string]>(
				"SELECT data FROM operations WHERE task_id=? AND attempt_id=?",
			)
			.all(taskId, task.attemptId);
		const effects = rows
			.map((row) => JSON.parse(row.data) as OperationIntent)
			.filter((intent) => !this.pendingOperatorRun(task, intent));
		if (effects.length !== 1 || rows.length > 2 || this.getOperation(taskId, "cancel")) return undefined;
		const intent = effects[0]!;
		const refusal = (intent.receipt as any)?.nodeRefusal;
		return intent.kind === "prepare" &&
			intent.taskId === taskId &&
			intent.attemptId === task.attemptId &&
			intent.key === intent.id &&
			intent.digest === digest(intent.payload) &&
			Object.keys((intent.receipt ?? {}) as object).length === 1 &&
			refusal?.ok === false &&
			refusal.certainty === "before_send" &&
			nodeFailureCode.test(refusalCode(refusal))
			? intent
			: undefined;
	}

	/** The attempt's own unreceipted operator-run claim, exactly as `run` makes it. */
	protected pendingOperatorRun(task: TaskRecord, intent: OperationIntent): boolean {
		return intent.kind === "operator-run" &&
			intent.taskId === task.id &&
			intent.attemptId === task.attemptId &&
			intent.key === intent.id &&
			intent.digest === digest(intent.payload) &&
			canonicalJson(intent.payload) === canonicalJson(operatorRunPayload(task)) &&
			intent.receipt === undefined;
	}

	/**
	 * Fresh-attempt transition for a proven before_send preparation refusal, used only after a new
	 * side-effect-free preflight passed. The helper proved nothing ran, so the reservation is kept
	 * and a fresh attempt id is admitted; the refused attempt's claim and receipt stay immutable.
	 * A pending operator-run claim moves with it in the same transaction: the fresh attempt gets the
	 * same claim for itself, carrying the owner lease, so the run that cleared it keeps fencing
	 * other runs and no other run can claim the fresh attempt in between.
	 * Any other claim, workspace, session, unknown or cancelled state is never renewed.
	 */
	renewRefusedPreparation(taskId: string, operationId: string): TaskRecord {
		return this.transaction("renewRefusedPreparation", taskId, () => {
			text(operationId);
			const task = this.requireTask(taskId);
			this.mutableAttempt(task);
			const rows = this.db
				.query<DataRow, [string, string]>(
					"SELECT data FROM operations WHERE task_id=? AND attempt_id=?",
				)
				.all(taskId, task.attemptId!);
			// A concurrent start already renewed this attempt; the caller re-reads and claims normally.
			if (!rows.some((row) => JSON.parse(row.data).id === operationId)) return task;
			const intent = this.retainedPreparationRefusal(taskId);
			demand(
				intent?.id === operationId,
				"PREPARATION_NOT_RENEWABLE",
				"Only a lone, proven before_send preparation refusal can be renewed",
			);
			const code = refusalCode((intent!.receipt as any).nodeRefusal);
			this.assertDispatchEnabled();
			const previousAttemptId = task.attemptId!;
			const previousRun = rows
				.map((row) => JSON.parse(row.data) as OperationIntent)
				.find((row) => this.pendingOperatorRun(task, row));
			task.attemptId = randomUUID();
			task.phase = "preparing";
			delete task.reason;
			let operatorRun: { previousOperationId: string; operationId: string } | undefined;
			if (previousRun) {
				const carried = this.insertIntent(task, "operator-run", operatorRunPayload(task));
				if (previousRun.lease) {
					carried.lease = previousRun.lease;
					this.db.query("UPDATE operations SET data=? WHERE id=?").run(canonicalJson(carried as unknown as Json), carried.id);
					delete previousRun.lease;
					this.db.query("UPDATE operations SET data=? WHERE id=?").run(canonicalJson(previousRun as unknown as Json), previousRun.id);
				}
				operatorRun = { previousOperationId: previousRun.id, operationId: carried.id };
			}
			this.audit(
				"preparation_refusal_cleared",
				{
					previousAttemptId,
					attemptId: task.attemptId,
					operationId,
					code,
					certainty: "before_send",
					preflight: "passed",
					...(operatorRun ? { operatorRun } : {}),
				},
				taskId,
				task,
			);
			return this.save(task);
		});
	}

	/**
	 * Audit a re-evaluation that did not clear a retained refusal and record on the task why its held
	 * attempt waits (`preparation_refusal_retained:<outcome>`); nothing is claimed or released.
	 */
	recordPreparationReevaluation(
		taskId: string,
		operationId: string,
		outcome: "still_refused" | "unavailable",
		code: string,
		diagnostic?: FailureDiagnostic,
	): void {
		text(operationId);
		demand(
			preparationReevaluationOutcomes.has(outcome) &&
				(nodeFailureCode.test(code) ||
					["node_timeout", "node_transport_failed", "node_output_limit", "preflight_reply_invalid"].includes(code)),
			"INVALID_INPUT",
			"Bounded re-evaluation outcome required",
		);
		this.transaction("preparationReevaluation", taskId, () => {
			this.audit(
				"preparation_reevaluation",
				{ operationId, outcome, code, ...this.diagnosticData(diagnostic) },
				taskId,
			);
			const task = this.requireTask(taskId);
			// Never overwrite another reason (for example cancel_requested) or touch a released task.
			// Only the refused claim that was re-evaluated, still retained on the current attempt:
			// a re-evaluation that lands after a concurrent renewal must not stamp the fresh attempt.
			if (
				this.retainedPreparationRefusal(taskId)?.id === operationId &&
				(task.reason === undefined || task.reason.startsWith("preparation_refusal_retained:"))
			) {
				task.reason = `preparation_refusal_retained:${outcome}`;
				this.save(task);
			}
		});
	}

	/** Atomically take or renew the owner lease of an unreceipted operator-run claim. A lease held by another
	 * owner is replaced only when `replaceable` says it is no longer live. This never claims or dispatches. */
	leaseOperatorRun(
		taskId: string,
		operationId: string,
		lease: OperationLease,
		replaceable: (held: OperationLease) => boolean,
	): boolean {
		return this.transaction("leaseOperatorRun", taskId, () => {
			text(lease.owner);
			text(lease.host);
			demand(Number.isSafeInteger(lease.pid) && lease.pid > 0 && Number.isSafeInteger(lease.expiresAt), "INVALID_INPUT", "Lease requires pid and expiry");
			const { task, intent } = this.operatorRun(taskId, operationId);
			if (intent.receipt !== undefined || task.phase === "archived") return false;
			const held = intent.lease;
			if (held && held.owner !== lease.owner && !replaceable(held)) return false;
			intent.lease = { owner: lease.owner, pid: lease.pid, host: lease.host, expiresAt: lease.expiresAt };
			this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind='operator-run' AND id=?")
				.run(canonicalJson(intent as unknown as Json), taskId, task.attemptId!, operationId);
			if (held?.owner !== lease.owner)
				this.audit("operator_run_lease", { operationId, owner: lease.owner, pid: lease.pid, ...(held ? { replacedOwner: held.owner } : {}) }, taskId);
			return true;
		});
	}

	/** Drop this owner's operator-run lease; a lease taken over by another owner is left untouched. */
	releaseOperatorRun(taskId: string, operationId: string, owner: string): void {
		this.transaction("releaseOperatorRun", taskId, () => {
			const { task, intent } = this.operatorRun(taskId, operationId);
			if (intent.lease?.owner !== owner) return;
			delete intent.lease;
			this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind='operator-run' AND id=?")
				.run(canonicalJson(intent as unknown as Json), taskId, task.attemptId!, operationId);
		});
	}

	protected operatorRun(taskId: string, operationId: string): { task: TaskRecord; intent: OperationIntent } {
		text(operationId);
		const task = this.requireTask(taskId);
		const row = this.db.query<DataRow, [string, string, string]>(
			"SELECT data FROM operations WHERE task_id=? AND attempt_id=? AND kind='operator-run' AND id=?",
		).get(taskId, task.attemptId ?? "", operationId);
		demand(row && task.attemptId, "OPERATION_BINDING", "Exact original task, attempt and operator-run claim required");
		const intent: OperationIntent = JSON.parse(row.data);
		demand(intent.taskId === taskId && intent.attemptId === task.attemptId && intent.id === operationId && intent.digest === digest(intent.payload),
			"OPERATION_BINDING", "Stored operation does not match original claim");
		return { task, intent };
	}
	/** Rechecked transactionally by the collection claim, not just by the scheduler projection. */
	autoCustodyRefusal(taskId: string): string | undefined {
		const task = this.requireTask(taskId);
		if (!task.input.autoCustody) return "not_authorized";
		if (!["completed_unverified", "succeeded"].includes(task.phase) || task.disposition) return "phase_not_successful";
		if (!task.attemptId || !task.nodeId || !task.sessionId || !task.turnId || !task.workspace) return "executed_identity_missing";
		if (!task.result?.executionTerminal || task.result.settlement || !["completed_unverified", "succeeded"].includes(task.result.status)) return "successful_settlement_required";
		if (task.input.approvalContract) return "approval_contract_requires_operator";
		if (this.getOperation(taskId, "cancel") || this.getOperation(taskId, "resource-return-override")) return "retirement_owned_elsewhere";
		const evidence = task.result.evidence as any;
		const receipt = evidence?.execution;
		const turn = evidence?.publicTurn?.turn;
		const delivery = turn?.delivery;
		if (!settledExecution(receipt) || receipt.kind !== "prompt" || receipt.status !== "terminal_ok" || receipt.outcome.provenance !== "agent" || receipt.outcome.reason === "cancelled" || turn?.session_id !== task.sessionId || turn?.turn_id !== task.turnId || typeof delivery?.runtime_command_id !== "string" || !delivery.runtime_command_id.trim() || typeof delivery?.runtime_turn_id !== "string" || !delivery.runtime_turn_id.trim() || receipt.commandId !== delivery.runtime_command_id || receipt.turnId !== delivery.runtime_turn_id) return "exact_success_receipt_required";
		try { this.authority(task); } catch { return "original_session_authority_missing"; }
		return undefined;
	}

	protected operation(
		taskId: string,
		kind: string,
		payload: Json,
		claimOnly: boolean,
		owner?: OperationLease,
	): OperationIntent | null {
		if (owner !== undefined) {
			demand(["verify-test", "result-test"].includes(kind), "INVALID_INPUT", "Only a verifier claim carries an owner lease");
			text(owner.owner);
			text(owner.host);
			demand(Number.isSafeInteger(owner.pid) && owner.pid > 0 && Number.isSafeInteger(owner.expiresAt), "INVALID_INPUT", "Lease requires pid and expiry");
		}
		let reused = false;
		const failureAttributes: Record<string, Json> = {};
		const result = this.transaction(
			claimOnly ? "claimOperation" : "beginOperation",
			taskId,
			() => {
				const task = this.requireTask(taskId);
				text(kind);
				demand(
					!["session-ownership", "session-authority"].includes(kind) &&
						!kind.startsWith("cancel"),
					"RESERVED_OPERATION",
					"Ownership and cancellation require transactional admission",
				);
				if (
					kind === "prompt" &&
					(this.getOperation(taskId, "session-ownership")?.payload as any)
						?.retirementRoute === "sdk-session-close-v1"
				)
					this.authority(task);
				demand(
					!this.getOperation(taskId, "cancel"),
					"CANCEL_PENDING",
					"Cancellation fences other effect claims",
				);
				demand(!((kind === "result-test" || kind === "verify-test") && task.disposition), "ARCHIVED_TASK", "A disposed task is an operator record; it is never tested");
				if (kind === "auto-custody") {
					demand(claimOnly, "INVALID_INPUT", "Custody is claim-only");
					const refusal = this.autoCustodyRefusal(taskId);
					demand(!refusal, "AUTO_CUSTODY_REFUSED", refusal ?? "Custody refused");
					demand(canonicalJson(payload) === canonicalJson({ inputDigest: task.inputDigest, paths: task.input.autoCustody!.paths }), "RESULT_CONFLICT", "Exact submission custody binding required");
				} else if (kind === "result-test") {
					const manifest = task.resultManifest as any;
					demand(claimOnly && task.result?.executionTerminal && (!task.held || this.deferTerminalRelease) && manifest?.status === "not_run" && Array.isArray(manifest.tests) && manifest.tests.length === 0, "NOT_TERMINAL", "Verification upgrade requires settled immutable unverified artifact");
					demand(!this.getOperation(taskId, "verify-test") && task.testReceipt === undefined, "TEST_UNKNOWN", "Original verifier already exists; never bypass its outcome");
					object(payload);
					demand(canonicalJson(payload) === canonicalJson(resultTestBinding(task, (payload as any).argv)), "VERIFICATION_CONFLICT", "Exact artifact and original execution binding required");
				} else if (kind === "verify-test" || kind === "stop") {
					if (kind === "verify-test" && task.input.autoCustody) demand(task.resultManifest, "CUSTODY_FIRST", "Submission-authorized custody must be saved before any explicit verifier");
					demand(
						claimOnly &&
							task.result?.executionTerminal &&
							(kind === "stop" || !task.resultManifest),
						"NOT_TERMINAL",
						"Post-execution command requires an authoritative settled execution",
					);
				} else this.mutableAttempt(task);
				const payloadDigest = digest(payload);
				failureAttributes.payloadDigest = payloadDigest;
				const row = this.db
					.query<DataRow, [string, string]>(
						"SELECT data FROM operations WHERE attempt_id=? AND kind=?",
					)
					.get(task.attemptId!, kind);
				if (row) {
					const intent: OperationIntent = JSON.parse(row.data);
					failureAttributes.operationId = intent.id;
					failureAttributes.operationKey = intent.key;
					demand(
						intent.digest === payloadDigest,
						"OPERATION_CONFLICT",
						"Operation kind already has different payload",
					);
					reused = true;
					return claimOnly ? null : intent;
				}
				this.assertDispatchEnabled();
				// Atomic with the claim: the send that follows it is linearized here.
				if (SEND_CLAIM_KINDS.has(kind)) this.requireAdmissibleNode(task);
				const id = randomUUID();
				const intent: OperationIntent = {
					id,
					key: id,
					digest: payloadDigest,
					taskId,
					attemptId: task.attemptId!,
					kind,
					payload: JSON.parse(canonicalJson(payload)),
					...(owner ? { lease: { owner: owner.owner, pid: owner.pid, host: owner.host, expiresAt: owner.expiresAt } } : {}),
				};
				this.db
					.query(
						"INSERT INTO operations(id,task_id,attempt_id,kind,data) VALUES (?,?,?,?,?)",
					)
					.run(id, taskId, task.attemptId!, kind, canonicalJson(intent));
				if (task.phase === "preparing") task.phase = "dispatching";
				this.save(task);
				this.audit(
					"operation_intent",
					{ id, key: id, digest: payloadDigest, kind },
					taskId,
				);
				return intent;
			},
			() => failureAttributes,
		);
		if (reused) {
			if (claimOnly) this.operationClaimsSuppressed++;
			else this.idempotentReuses++;
		}
		return result;
	}

	protected insertIntent(
		task: TaskRecord,
		kind: string,
		payload: Json,
	): OperationIntent {
		const id = randomUUID();
		const intent: OperationIntent = {
			id,
			key: id,
			digest: digest(payload),
			taskId: task.id,
			attemptId: task.attemptId!,
			kind,
			payload: JSON.parse(canonicalJson(payload)),
		};
		this.db
			.query(
				"INSERT INTO operations(id,task_id,attempt_id,kind,data) VALUES (?,?,?,?,?)",
			)
			.run(id, task.id, task.attemptId!, kind, canonicalJson(intent));
		this.audit(
			"operation_intent",
			{ id, key: id, kind, digest: intent.digest },
			task.id,
			task,
		);
		return intent;
	}

	/** When an operation intent was claimed (its `operation_intent` audit row), or undefined. */
	operationClaimedAt(taskId: string, operationId: string): string | undefined {
		const row = this.db
			.query<{ at: string }, [string, string]>("SELECT at FROM audit WHERE task_id=? AND kind='operation_intent' AND json_extract(data,'$.id')=? ORDER BY sequence LIMIT 1")
			.get(taskId, operationId);
		return row?.at;
	}

	// Implemented by later classes in the chain
	protected abstract authority(task?: TaskRecord): OperationIntent;
	protected abstract clearOwnerGone(task?: TaskRecord, kind?: string, operationId?: string): boolean;
}
