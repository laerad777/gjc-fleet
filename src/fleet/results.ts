import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import { ArchiveEvidence, DispositionRequest, Json, OperationIntent, OperationLease, TaskInput, TaskRecord, TaskState } from "../contracts";
import { exportReviewDigest, normaliseDisposition } from "../store";
import { FleetError, canonicalJson, demand, digest, exportReviewPending, receiptlessUnverifiable } from "../core";
import { TransportError } from "../rpc";
import { NodeReplyError } from "../node";
import { OutputHeadProof, isRoleTask, recordCached, workUnitState } from "../work-unit";
import { spawnTrusted } from "../spawn";
import { EXPORT_COMPLETENESS, ResultManifest, WorkspaceIdentity, sha256, validateSelectedOutputs } from "../workspace";
import { ARCHIVE_TIMEOUT, DisposeBatchItem, DisposeResult, REVIEW_SUBJECT_MAX_BYTES, VERIFIER_OWNER_BOUND_MS, archiveDigest, archiveObservations, artifactDigest, artifactSchema, disposeBatchRequests, effectiveOperation, exportCompleteness, exportReviewSubject, freshSchema, legacyWithheld, liveVerifierOwners, reproducedArtifact, validateOperator, validateResult, validateTestEvidence, verificationEvidence, withResultTest } from "./shared";
import { FleetInspection } from "./inspection";


/** Match node.ts killTree: win32 taskkill /T /F, POSIX process-group SIGKILL. */
function killArchiveQuery(child: ReturnType<typeof Bun.spawn>): void {
	if (process.platform === "win32") {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			const killer = spawnTrusted(
				[
					join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					"/PID",
					String(child.pid),
					"/T",
					"/F",
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			killer.exited.finally(() => {
				try { child.kill("SIGKILL"); } catch { /* already gone */ }
			}).catch(() => {});
		} catch {
			try { child.kill("SIGKILL"); } catch { /* already gone */ }
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch { /* The child may already have exited. */ }
	try { child.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
}

export abstract class FleetResults extends FleetInspection {
	async archive(id: string, request: ArchiveEvidence = {}, actor = "operator"): Promise<TaskRecord> {
		request = JSON.parse(canonicalJson(request));
		const task = this.store.task(id);
		demand(task, "TASK_NOT_FOUND", "Unknown task");
		demand(typeof task.nodeId === "string" && task.nodeId.trim().length > 0, "ARCHIVE_NODE", "Present original nodeId required");
		const override = request.operatorOverride;
		if (request.noSessionConfirmation) demand(["never_started", "create_outcome_unknown_operator_confirmed"].includes(request.noSessionConfirmation.kind) && typeof request.noSessionConfirmation.reason === "string" && request.noSessionConfirmation.reason.trim().length > 0, "ARCHIVE_OVERRIDE", "Explicit no-session classification and audited reason required");
		if (override) demand(["never_started", "create_outcome_unknown_operator_confirmed", "node_retired"].includes(override.kind) && typeof override.reason === "string" && override.reason.trim().length > 0, "ARCHIVE_OVERRIDE", "Explicit operator classification and audited reason required");
		return this.store.archive(id, await this.archiveObservation(task, request), actor);
	}

	/**
	 * The fresh read-only original-node session listing `task archive` decides on (broker autostart off,
	 * bounded output and time), sealed into a single-use token bound to this store and exactly `task`.
	 * The one copy: archive and dispose both observe through it. It lists sessions; it never collects.
	 */
	protected async archiveObservation(task: TaskState, request: ArchiveEvidence): Promise<object> {
		const node = this.store.nodes().find(node => node.id === task.nodeId);
		const override = request.operatorOverride;
		const capturedAt = new Date().toISOString();
		let command: string[] = [], raw = "", sessionList: any;
		if (!node) {
			demand(override?.kind === "node_retired", "ARCHIVE_NODE", "Missing registry node requires explicit audited node_retired override");
		} else {
			demand(override?.kind !== "node_retired", "ARCHIVE_NODE", "node_retired requires a missing registry node");
			const transport = task.nodeSnapshot?.sdkTransport;
			demand(transport && task.nodeSnapshot?.id === task.nodeId, "ARCHIVE_NODE", "Recorded original node SDK transport required");
			const args = ["sdk", "session", "list", "--scope", "all", "--json"];
			command = [transport.command, ...transport.args, ...args];
			if (transport.command === "ssh") {
				const remote = transport.args.at(-1) ?? "";
				let guarded: string;
				if (task.nodeSnapshot!.os === "win32") {
					demand(/^cmd\.exe \/c /i.test(remote), "ARCHIVE_TRANSPORT", "Cannot disable remote broker autostart");
					guarded = `cmd.exe /c "set GJC_SDK_BROKER_AUTOSTART=0&& ${remote.replace(/^cmd\.exe \/c /i, "") } ${args.join(" ")}"`;
				} else guarded = `env GJC_SDK_BROKER_AUTOSTART=0 ${remote} ${args.join(" ")}`;
				command = ["ssh", ...transport.args.slice(0, -1), guarded];
			}
			const child = spawnTrusted(command, {
				env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
				stdout: "pipe",
				stderr: "pipe",
				detached: process.platform !== "win32",
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new FleetError("ARCHIVE_TIMEOUT", "Original node session query timed out")),
					ARCHIVE_TIMEOUT,
				);
			});
			const readers = [
				(child.stdout as ReadableStream<Uint8Array>).getReader(),
				(child.stderr as ReadableStream<Uint8Array>).getReader(),
			];
			async function bounded(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number): Promise<string> {
				const parts: Uint8Array[] = [];
				let size = 0;
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return Buffer.concat(parts).toString();
					size += value.byteLength;
					demand(size <= limit, "ARCHIVE_OUTPUT_LIMIT", "Original node session query exceeded output limit");
					parts.push(value);
				}
			}
			let completed = false;
			try {
				const outputs = await Promise.race([
					Promise.all([
						bounded(readers[0]! as unknown as ReadableStreamDefaultReader<Uint8Array>, 8 * 1024 * 1024),
						bounded(readers[1]! as unknown as ReadableStreamDefaultReader<Uint8Array>, 1024 * 1024),
						child.exited,
					]),
					deadline,
				]);
				demand(outputs[2] === 0, "ARCHIVE_QUERY", "Original node session query failed");
				raw = outputs[0];
				sessionList = JSON.parse(raw);
				completed = true;
			} finally {
				clearTimeout(timer);
				if (!completed) killArchiveQuery(child);
				for (const reader of readers) {
					reader.cancel().catch(() => {});
					reader.releaseLock();
				}
			}
		}
		const token = {};
		archiveObservations.set(token, { store: this.store, taskDigest: archiveDigest(task), evidence: { capturedAt, nodeId: task.nodeId, command, rawResponseDigest: sha256(raw), sessionList, request } });
		return token;
	}

	/**
	 * Audited operator disposition of a completed_unverified task (`task dispose`). An operator record
	 * through the archive machinery, never verification: the task becomes archived (never succeeded),
	 * its result is never read, re-collected, rewritten, externalised or deleted, and the node is only
	 * asked for the same read-only session listing `task archive` decides on. Refusals that need no
	 * observation (input, phase, conflict, superseder, a still held reservation) are made before the node
	 * is contacted; an exact
	 * repeat of the recorded disposition by the same actor is answered without contacting the node.
	 */
	async dispose(id: string, request: DispositionRequest, actor = "operator", options: { dryRun?: boolean } = {}): Promise<DisposeResult> {
		request = normaliseDisposition(JSON.parse(canonicalJson(request as unknown as Json)));
		const dryRun = options.dryRun === true;
		const task = this.store.taskState(id);
		demand(task, "TASK_NOT_FOUND", "Unknown task");
		let token: object | undefined;
		if (!this.store.checkDisposition(id, request, actor, dryRun)) {
			demand(typeof task.nodeId === "string" && task.nodeId.trim().length > 0, "ARCHIVE_NODE", "Present original nodeId required");
			const observed = this.store.nodes().some(node => node.id === task.nodeId);
			demand(observed || request.nodeRetired !== undefined, "ARCHIVE_NODE", "Missing registry node requires --node-retired REASON");
			demand(!observed || request.nodeRetired === undefined, "ARCHIVE_NODE", "--node-retired requires a missing registry node");
			token = await this.archiveObservation(task, request.nodeRetired !== undefined ? { operatorOverride: { kind: "node_retired", reason: request.nodeRetired } } : {});
		}
		const done = this.store.dispose(id, request, token, actor, dryRun);
		return {
			taskId: id,
			outcome: done.outcome,
			dryRun,
			phase: done.outcome === "would_dispose" ? done.task.phase : "archived",
			archivedFrom: done.outcome === "would_dispose" ? done.task.phase : done.task.archivedFrom!.phase,
			releasedReservation: done.releasedReservation,
			verifiedByFleet: false,
			succeeded: false,
			resultUntouched: true,
			disposition: done.disposition,
		};
	}

	/**
	 * Batch form of dispose: every item is validated first (any malformed item is a usage error and
	 * nothing is applied), then each item is applied independently, in order; a refusal or failure of
	 * one item is reported and never stops the others.
	 */
	async disposeBatch(items: unknown, actor = "operator", options: { dryRun?: boolean } = {}): Promise<DisposeBatchItem[]> {
		const requests = disposeBatchRequests(items);
		const results: DisposeBatchItem[] = [];
		for (const { taskId, request } of requests) {
			try {
				results.push({ ok: true, ...(await this.dispose(taskId, request, actor, options)) });
			} catch (error) {
				// A non-Fleet error (for example an unparsable node listing) is reported by class only, never its text.
				results.push({ ok: false, taskId, outcome: "refused", code: error instanceof FleetError ? error.code : "UNCLASSIFIED",
					message: error instanceof FleetError ? error.message : `Unexpected ${error instanceof Error ? error.name : "non-error"}; this item was not disposed` });
			}
		}
		return results;
	}

	async result(id: string, testArgv?: string[], selectedOutputs?: string[]): Promise<ResultManifest> {
		let argv: string[] | undefined;
		try {
			demand(testArgv === undefined || (Array.isArray(testArgv) && testArgv.length > 0 && typeof testArgv[0] === "string" && testArgv[0].length > 0 && testArgv.every(arg => typeof arg === "string" && !arg.includes("\0"))), "INVALID_INPUT", "Explicit verifier argv required");
			argv = testArgv === undefined ? undefined : [...testArgv];
			return await this.resultValue(id, argv, selectedOutputs === undefined ? this.task(id).input.autoCustody?.paths : validateSelectedOutputs(selectedOutputs));
		} catch (error) {
			// Retained verifier evidence is immutable, so a conflicting request can never succeed: it is recorded
			// on the task as final once; a repeat of an already recorded request only advances the record's count.
			// Anything not recorded (archived task, not a request-versus-retained conflict, bound reached) is audited.
			let repeatedConflict = false;
			if (error instanceof FleetError && error.code === "VERIFICATION_CONFLICT" && argv) {
				try {
					repeatedConflict = this.store.recordVerificationConflict(id, argv, this.condition({ source: "Fleet.result", phase: "validate" }, "verification_conflict")) === "repeat";
				} catch {
					this.store.noteTelemetryFailure();
				}
			}
			if ((error instanceof FleetError || error instanceof NodeReplyError) && !repeatedConflict) {
				try {
					this.store.recordResultValidationRejected(id, error.code, this.diagnose(error, { source: "Fleet.result", phase: "validate" }));
				} catch {
					this.store.noteTelemetryFailure();
				}
			}
			throw error;
		}
	}

	/** A verifier claimer's owner lease: this process, this host, bounded by VERIFIER_OWNER_BOUND_MS. */
	protected verifierLease(): OperationLease {
		return { owner: randomUUID(), pid: process.pid, host: hostname(), expiresAt: this.clock() + VERIFIER_OWNER_BOUND_MS };
	}

	/**
	 * Whether the owner of an unreceipted verifier claim is provably gone: its lease expired, or it was taken on
	 * this host by a process that no longer exists, or by this process for a call that already ended. A claim
	 * written before owner leases existed (no lease) is gone once VERIFIER_OWNER_BOUND_MS passed since its
	 * recorded claim; until then its owner is unknown. Another host's live lease is trusted until it expires.
	 */
	protected verifierOwnerGone(id: string, intent: OperationIntent): boolean {
		const now = this.clock();
		const lease = intent.lease;
		if (!lease) {
			const claimed = this.store.operationClaimedAt(id, intent.id);
			const at = claimed === undefined ? Number.NaN : Date.parse(claimed);
			return Number.isFinite(at) && now - at >= VERIFIER_OWNER_BOUND_MS;
		}
		if (!Number.isSafeInteger(lease.expiresAt) || now >= lease.expiresAt) return true;
		if (lease.host !== hostname()) return false;
		if (lease.pid === process.pid) return !liveVerifierOwners.has(lease.owner);
		try {
			process.kill(lease.pid, 0);
			return false;
		} catch (error) {
			return (error as NodeJS.ErrnoException)?.code === "ESRCH";
		}
	}

	/**
	 * An unreceipted verifier claim of the current attempt: a live owner is reported as TEST_UNKNOWN (a
	 * concurrent verifier, never run twice); a gone owner is recorded once on the task (never rerun). A gone
	 * claimer does not prove its admitted test process is gone, so the caller still refuses with TEST_UNKNOWN.
	 */
	protected unreceiptedVerifier(id: string, kind: "verify-test" | "result-test", intent: OperationIntent): void {
		const gone = this.verifierOwnerGone(id, intent);
		if (!gone && intent.lease) throw new FleetError("TEST_UNKNOWN", "Verifier claim is held by a live owner; never run twice");
		if (gone) this.store.recordVerifierOwnerGone(id, kind, intent.id, this.condition({ source: "Fleet.result", phase: "validate" }, "verification_owner_gone"));
	}
	/** Post-save: a dispatch failure never turns saved custody into a failed call; a later result() retries idempotently. */
	private dispatchReviewAfterCustody(id: string): void {
		try { this.ensureReviewDispatch(id); }
		catch (error) { this.store.recordReviewDispatchFailed(id, (error as any)?.code ?? "UNKNOWN"); }
	}
	/**
	 * Opt-in `reviewDispatch`: submit exactly one file-review child for the selected file of the SAVED custody
	 * manifest (path and sha256 never come from prompts or reports). Idempotent: the child key is a digest of
	 * parent task, attempt, policy and subject, and `FleetStore.submit` returns the existing task for that key, so
	 * a restart or repeated call never creates a second child. The child is only queued; placement stays with the
	 * existing resource-aware queue. It carries no workUnit, autoCustody or reviewDispatch, so it cannot recurse.
	 * Returns the child id, or undefined when the task has no policy or no saved custody yet.
	 */
	ensureReviewDispatch(id: string): string | undefined {
		const task = this.task(id);
		const policy = task.input.reviewDispatch;
		const manifest = task.resultManifest as any;
		if (!policy || !manifest || !this.store.getOperation(id, "auto-custody")?.receipt) return undefined;
		const selected = (manifest.files ?? []).filter((entry: any) => entry.path === policy.path && entry.deleted !== true && typeof entry.sha256 === "string");
		demand(selected.length === 1, "REVIEW_SUBJECT_MISSING", "Selected review subject is not uniquely present in saved custody manifest");
		const subject = { taskId: task.id, path: selected[0].path as string, sha256: selected[0].sha256 as string, otherNode: true };
		// The child runs in its own workspace on another node and cannot read the subject's workspace, so the
		// reviewed bytes travel in its prompt: only from the saved manifest, only small UTF-8 text, hash-checked.
		const bytes = typeof selected[0].contentBase64 === "string" ? Buffer.from(selected[0].contentBase64, "base64") : undefined;
		demand(bytes !== undefined && bytes.length <= REVIEW_SUBJECT_MAX_BYTES, "REVIEW_SUBJECT_UNDELIVERABLE", `Review subject content must be stored in the manifest and at most ${REVIEW_SUBJECT_MAX_BYTES} bytes`);
		demand(createHash("sha256").update(bytes).digest("hex") === subject.sha256, "REVIEW_SUBJECT_MISSING", "Saved review subject content does not match its sha256");
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch { throw new FleetError("REVIEW_SUBJECT_UNDELIVERABLE", "Review subject is not UTF-8 text"); }
		// Longer than every backtick run in the subject AND the rendered template, so neither can contain the fence.
		const rendered = policy.promptTemplate.replaceAll("{path}", subject.path);
		const fence = "`".repeat(Math.max(3, ...[...(content + "\n" + rendered).matchAll(/`+/g)].map(m => m[0].length + 1)));
		const key = `review-${digest({ parent: task.id, attempt: task.attemptId ?? null, policy, subject }).slice(0, 48)}`;
		const child: TaskInput = {
			schemaVersion: 1, key, caller: task.input.caller, repoId: task.input.repoId, baseCommit: task.input.baseCommit,
			prompt: `${rendered}\n\nReviewed file ${subject.path} (sha256 ${subject.sha256}, from Fleet task ${task.id}; it is not in your workspace; exactly ${bytes.length} bytes, ${content.endsWith("\n") ? "ending with a newline" : "no final newline"}; the block holds those bytes${content.endsWith("\n") ? "" : " followed by one framing newline"}):\n${fence}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}\n`,
			required: structuredClone(policy.required), subject,
			// Opt-in: the child's own report is collected like any auto-custody task. It gets no reviewDispatch,
			// so collection of the review never dispatches another review.
			...(policy.childCustody ? { autoCustody: { paths: [...policy.childCustody] } } : {}),
		};
		// Only a pathological subject (a very long backtick run widens the fence) can still exceed the limit:
		// refuse deterministically with a named code instead of a generic validation failure.
		demand(Buffer.byteLength(child.prompt) <= 256 * 1024, "REVIEW_SUBJECT_UNDELIVERABLE", "Review prompt with the inline subject exceeds the 256 KiB prompt limit");
		return this.store.submit(child).id;
	}
	/** Submission is the authority; this entry point never supplies a verifier or invents paths. */
	async automaticCustody(id: string): Promise<ResultManifest> {
		const refusal = this.store.autoCustodyRefusal(id);
		demand(!refusal, "AUTO_CUSTODY_REFUSED", refusal ?? "Custody refused");
		return this.result(id, undefined, this.task(id).input.autoCustody!.paths);
	}

	protected async resultValue(
		id: string,
		testArgv?: string[],
		selectedOutputs?: string[],
	): Promise<ResultManifest> {
		const task = this.task(id);
		if (task.input.autoCustody) demand(canonicalJson(selectedOutputs ?? null) === canonicalJson(task.input.autoCustody.paths), "RESULT_CONFLICT", "Submission already binds the exact custody selector");
		// Work-unit Step 1: a role task delivers a report, never a test receipt (before any claim).
		demand(testArgv === undefined || !isRoleTask(task), "ROLE_NO_TESTS", "Role tasks are collected by `result TASK_ID` without ARGV; their report is never tested or verified");
		// A disposition is final: the result is never collected, tested or verified afterwards.
		demand(!task.disposition, "ARCHIVED_TASK", "A disposed task is an operator record; its result is never re-collected, tested or verified");
		demand(
			task.workspace && task.sessionId && task.turnId,
			"RESULT_NOT_READY",
			"Executed identity required",
		);
		demand(
			task.result?.executionTerminal,
			"RESULT_NOT_READY",
			"Authoritative runtime settlement required before result collection or tests",
		);
		// A receipt-less settlement may be collected as evidence (never tested or
		// verified) unless an operator accepted a genuine late terminal_ok receipt.
		demand(
			!receiptlessUnverifiable(task.result) ||
				(testArgv === undefined &&
					task.testReceipt === undefined &&
					!this.store.getOperation(id, "verify-test") &&
					!this.store.getOperation(id, "result-test")),
			"RECEIPTLESS_UNVERIFIABLE",
			"Execution ended without a runtime receipt; results are collected only as unverified evidence, never tested or verified as success",
		);
		const identity = task.workspace as unknown as WorkspaceIdentity;
		// Bind selected export before touching the node, preserving legacy full export with no request.
		if (selectedOutputs || task.resultCustodyRequest) this.store.bindResultCustody(id, selectedOutputs ?? null);
		if (task.resultManifest) {
			validateResult(identity, task.resultManifest);
			demand(canonicalJson((task.resultManifest as unknown as ResultManifest).custody?.paths ?? null) === canonicalJson(selectedOutputs ?? null), "RESULT_CONFLICT", "Cached selector differs from request");
			// Work-unit Step 1 (b): best effort for a role task collected earlier; never changes this reply.
			if (isRoleTask(task)) recordCached(this.store, task, validateResult);
			let cached = withResultTest(task, task.resultManifest as unknown as ResultManifest, effectiveOperation(task, this.store.getOperation(id, "result-test")));
			if (testArgv && cached.status === "not_run")
				cached = await this.upgradeResult(task, cached, testArgv);
			demand(
				!testArgv ||
					cached.tests.some(
						(test) => canonicalJson(test.argv) === canonicalJson(testArgv),
					),
				"VERIFICATION_CONFLICT",
				"Cached result does not verify the newly requested command",
			);
			this.acceptResult(id, cached, effectiveOperation(this.task(id), this.store.getOperation(id, "result-test")));
			this.dispatchReviewAfterCustody(id);
			return cached;
		}
		const tests: any[] = task.testReceipt ? [task.testReceipt] : [];
		if (task.testReceipt) validateTestEvidence(identity, task.testReceipt);
		if (testArgv && task.testReceipt)
			demand(
				canonicalJson((task.testReceipt as any).argv) ===
					canonicalJson(testArgv),
				"VERIFICATION_CONFLICT",
				"Requested command differs from the retained test receipt",
			);
		const verifier = task.testReceipt ? undefined : this.store.getOperation(id, "verify-test");
		// The original test outcome is unknown and never rerun. Once its claimer is provably gone that is recorded
		// on the task, but collection stays refused: the admitted test process may outlive its claimer and still
		// write to the workspace, and the collected manifest is immutable.
		if (verifier) {
			this.unreceiptedVerifier(id, "verify-test", verifier);
			throw new Error(
				"TEST_UNKNOWN: original test outcome unavailable; never rerun",
			);
		}
		if (testArgv && !task.testReceipt) {
			this.requireWorkspaceRoute(task);
			const lease = this.verifierLease();
			liveVerifierOwners.add(lease.owner);
			try {
				const op = this.store.claimOperation(id, "verify-test", {
					argv: testArgv,
				}, lease);
				demand(
					op,
					"TEST_UNKNOWN",
					"Test command already admitted; never rerun unknown effects",
				);
				let receipt: any;
				try {
					receipt = await this.node(task, {
						action: "test",
						identity,
						argv: testArgv,
					});
				} catch (error) {
					// The node checks the workspace path and identity before it runs anything.
					this.releaseUnsentVerifier(id, "verify-test", op.id, error, false);
					throw error;
				}
				validateTestEvidence(identity, receipt);
				this.store.recordVerification(id, receipt as Json);
				tests.push(receipt);
			} finally {
				liveVerifierOwners.delete(lease.owner);
			}
		}
		// The durable claim is shared by foreground and daemon collection of an opted-in task.
		// A missing receipt never grants replay, including after restart or loss of the daemon lease.
		let custodyClaim;
		if (task.input.autoCustody) {
			this.requireWorkspaceRoute(task);
			custodyClaim = this.store.claimOperation(id, "auto-custody", { inputDigest: task.inputDigest, paths: task.input.autoCustody.paths });
			demand(custodyClaim, "CUSTODY_UNKNOWN", "Original custody collection already claimed; inspect cached custody or recover explicitly, never replay");
		}
		const result = await this.node(task, {
			action: "collect",
			identity,
			tests,
			exportCompleteness: EXPORT_COMPLETENESS,
			...(selectedOutputs ? { selectedOutputs } : {}),
		});
		validateResult(identity, result);
		demand(canonicalJson(result.custody?.paths ?? null) === canonicalJson(selectedOutputs ?? null), "RESULT_BINDING", "Node returned different custody selection");
		demand(artifactSchema(result) === freshSchema(identity), "RESULT_SCHEMA", "Collection requires a collector that reports export completeness");
		// Passing commands over an export that is not complete: stored without its tests, the
		// retained verifier receipt beside it (see withResultTest), until an operator accepts it.
		const held = result.status === "verified" && exportCompleteness(result).completeness !== "complete";
		if (held) demand(result.tests.length === 1 && canonicalJson(result.tests[0] as unknown as Json) === canonicalJson(this.task(id).testReceipt!), "VERIFICATION_CONFLICT", "Passing commands must be the retained verifier receipt");
		// Work-unit review evidence: a separate read-only node query, kept outside the manifest and every digest.
		// Asked only while the switch is on; switch off: no query and no row, exactly as without work units.
		const proof = !isRoleTask(task) && workUnitState(this.store) === "on" ? await this.outputHeadProof(task, identity, result.outputHead) : undefined;
		this.store.saveResult(id, (held ? { ...result, tests: [], status: "not_run" } : result) as any, proof, custodyClaim?.id);
		this.acceptResult(id, result, undefined);
		this.dispatchReviewAfterCustody(id);
		return result;
	}

	/**
	 * Deny by default: any refusal, failure or reply other than exactly `{created: true}` is not proven, and the
	 * reason (with a diagnostic for a failure) is saved with the result as its `output_head_unproven` row.
	 */
	protected async outputHeadProof(task: TaskRecord, identity: WorkspaceIdentity, head: string): Promise<OutputHeadProof> {
		let reply: unknown;
		try {
			reply = await this.node(task, { action: "provenance", identity, head });
		} catch (error) {
			// N (docs/failure-diagnostics.md): not a conversion; the reason and diagnostic are recorded by saveResult.
			const refused = error instanceof NodeReplyError && error.certainty === "before_send";
			return { created: false, reason: refused ? "node_refused" : "node_failed", diagnostic: this.diagnose(error, { source: "Fleet.result", phase: "call" }) };
		}
		const is = (value: Json) => {
			try {
				return canonicalJson(reply as Json) === canonicalJson(value);
			} catch {
				return false;
			}
		};
		if (is({ created: true })) return { created: true };
		return { created: false, reason: is({ created: false }) ? "not_created" : "reply_invalid" };
	}

	protected async upgradeResult(task: TaskRecord, cached: ResultManifest, argv: string[]): Promise<ResultManifest> {
		const id = task.id;
		const verifier = task.testReceipt === undefined ? this.store.getOperation(id, "verify-test") : undefined;
		if (verifier && verifier.receipt === undefined) this.unreceiptedVerifier(id, "verify-test", verifier);
		demand(!this.store.getOperation(id, "verify-test") && task.testReceipt === undefined, "TEST_UNKNOWN", "Original verifier already exists; never bypass its outcome");
		const existing = this.store.getOperation(id, "result-test");
		if (existing && existing.receipt === undefined) this.unreceiptedVerifier(id, "result-test", existing);
		demand(!existing, "TEST_UNKNOWN", "Original result-test outcome unavailable; never rerun");
		this.requireWorkspaceRoute(task);
		const lease = this.verifierLease();
		liveVerifierOwners.add(lease.owner);
		try {
			return await this.leasedUpgrade(task, cached, argv, lease);
		} finally {
			liveVerifierOwners.delete(lease.owner);
		}
	}

	protected async leasedUpgrade(task: TaskRecord, cached: ResultManifest, argv: string[], lease: OperationLease): Promise<ResultManifest> {
		const id = task.id;
		const identity = cached.identity;
		// Compare fresh collections under the stored manifest's own schema.
		const schema = artifactSchema(cached);
		const fresh = async (when: string) => {
			// A legacy-v1 stored manifest also asks the node for the boundaries a legacy fresh collection withholds.
			const reply: any = await this.node(task, { action: "collect", identity, tests: [], exportCompleteness: EXPORT_COMPLETENESS, ...(cached.custody ? { selectedOutputs: cached.custody.paths } : {}), ...(schema === "legacy-v1" ? { observeBoundaries: cached.files.map((file) => file.path) } : {}) });
			const { withheldBoundaries, withheldFiles, ...value } = reply ?? {};
			validateResult(identity, value);
			demand(artifactSchema(value) === freshSchema(identity), "RESULT_SCHEMA", "Verification requires a collector that reports export completeness");
			demand(canonicalJson(value.custody?.paths ?? null) === canonicalJson(cached.custody?.paths ?? null), "RESULT_BINDING", "Node returned different custody selection");
			if (reproducedArtifact(value, schema) === reproducedArtifact(cached, schema)) return { value, withheld: null };
			const withheld = schema === "legacy-v1" ? legacyWithheld(cached, value, value.exclusions ?? withheldBoundaries, withheldFiles) : undefined;
			demand(withheld, "ARTIFACT_CHANGED", when === "before" ? "ARTIFACT_CHANGED: workspace no longer matches collected bytes" : "ARTIFACT_CHANGED: verifier changed collected artifact bytes");
			return { value, withheld };
		};
		const operation = this.store.claimResultTest(id, argv, lease);
		demand(operation, "TEST_UNKNOWN", "Result-test already claimed; never rerun unknown effects");
		let before: Awaited<ReturnType<typeof fresh>>;
		try {
			before = await fresh("before");
		} catch (error) {
			// Read-only collection failed or refused: the verifier was never sent.
			this.releaseUnsentVerifier(id, "result-test", operation.id, error, true);
			throw error;
		}
		let test: any;
		try {
			test = await this.node(task, { action: "test", identity, argv });
		} catch (error) {
			this.releaseUnsentVerifier(id, "result-test", operation.id, error, false);
			throw error;
		}
		validateTestEvidence(identity, test);
		demand(canonicalJson((test as any).argv) === canonicalJson(argv), "VERIFICATION_CONFLICT", "Verifier receipt must match explicit argv");
		const after = await fresh("after");
		demand(canonicalJson(after.value.exclusions ?? null) === canonicalJson(before.value.exclusions ?? null) && canonicalJson(after.withheld as unknown as Json) === canonicalJson(before.withheld as unknown as Json), "ARTIFACT_CHANGED", "ARTIFACT_CHANGED: verifier changed repository boundaries");
		// A workspace without a collection snapshot observes no exclusions: completeness stays unknown,
		// unless stored files are withheld at boundaries (`legacyWithheld`): those boundaries are observed.
		// Both collections reproduced the stored artifact (`reproducedArtifact`) outside them: the receipt binds its digest.
		const receipt = { manifestDigest: digest(cached), beforeDigest: artifactDigest(cached), afterDigest: artifactDigest(cached), artifactSchema: schema, observedExclusions: (before.value.exclusions ?? before.withheld ?? null) as unknown as Json, test: test as Json };
		const claimed = { ...this.store.getOperation(id, "result-test")!, receipt };
		const effective = withResultTest(task, cached, claimed);
		const state = exportCompleteness(effective, claimed);
		if (effective.status === "verified" && state.completeness !== "complete" && this.task(id).phase === "completed_unverified") {
			// Held with the export review, never as the claim's receipt (see effectiveOperation).
			const subject = exportReviewSubject(task, effective, state);
			this.store.requireExportReview(id, subject as unknown as Json, exportReviewDigest(subject as unknown as Json), receipt);
			return effective;
		}
		this.store.recordOperationReceipt(id, "result-test", operation.id, receipt);
		return withResultTest(task, cached, this.store.getOperation(id, "result-test"));
	}

	/**
	 * Release a verifier claim when its verifier request provably never reached the node: it failed
	 * before that request (`beforeVerifier`), or the request failed with proven before_send certainty
	 * (a typed node refusal: the helper checks workspace path and identity before running anything; or
	 * a spawn failure). Any other outcome is unknown and keeps the claim (TEST_UNKNOWN, never rerun).
	 * A failed release also keeps the claim; the original error is what the caller sees.
	 */
	protected releaseUnsentVerifier(id: string, kind: "verify-test" | "result-test", operationId: string, error: unknown, beforeVerifier: boolean): void {
		if (!beforeVerifier && !(error instanceof TransportError && error.certainty === "before_send")) return;
		try {
			this.store.releaseUnsentClaim(id, kind, operationId, this.diagnose(error, { source: "Fleet.result", phase: "call" }));
		} catch {
			this.store.noteTelemetryFailure();
		}
	}

	/**
	 * Passing commands plus a complete export verify the task. Passing commands with
	 * an incomplete or unknown export record `result.exportIncomplete` on the
	 * `completed_unverified` task, which only an explicit operator acceptance verifies.
	 */
	protected acceptResult(id: string, result: ResultManifest, operation: OperationIntent | undefined): void {
		if (result.status !== "verified") return;
		const task = this.task(id);
		// Verification evidence is immutable; earlier verification stands as recorded.
		if (task.result?.verified) return;
		const state = exportCompleteness(result, operation);
		if (state.completeness === "complete") {
			this.store.verifyResult(id, verificationEvidence(result), { exportComplete: true, artifactSchema: artifactSchema(result) });
			return;
		}
		// Like verification, review only applies to a settled completed_unverified
		// task; failed or cancelled executions keep their own terminal phase.
		if (task.phase !== "completed_unverified" && task.result?.exportIncomplete === undefined) return;
		const subject = exportReviewSubject(task, result, state);
		this.store.requireExportReview(id, subject as unknown as Json, exportReviewDigest(subject as unknown as Json));
	}
	/** Read-only: what an operator must review before accepting an incomplete export. */
	exportReview(id: string) {
		const task = this.task(id);
		demand(task.workspace && task.result?.executionTerminal && task.resultManifest, "RESULT_NOT_READY", "RESULT_NOT_READY: collected settled result required");
		const identity = task.workspace as unknown as WorkspaceIdentity;
		validateResult(identity, task.resultManifest);
		const operation = effectiveOperation(task, this.store.getOperation(id, "result-test"));
		const result = withResultTest(task, task.resultManifest as unknown as ResultManifest, operation);
		const state = exportCompleteness(result, operation);
		const subject = state.completeness === "complete" ? null : exportReviewSubject(task, result, state);
		const stored = task.result?.exportIncomplete;
		return {
			taskId: task.id,
			attemptId: task.attemptId!,
			phase: task.phase,
			status: result.status,
			artifactSchema: artifactSchema(result),
			completeness: state.completeness,
			exclusions: state.exclusions,
			manifestDigest: digest(result),
			subject,
			reviewDigest: subject ? exportReviewDigest(subject as unknown as Json) : null,
			required: exportReviewPending(task.result),
			accepted: stored?.acceptance ?? null,
		};
	}
	/**
	 * Explicit, audited operator acceptance of an incomplete export. The digest must
	 * equal the review recomputed from retained evidence and the stored review;
	 * otherwise the exclusion set changed since it was reviewed and acceptance is
	 * refused. Never dispatches anything or reads the workspace.
	 */
	acceptIncompleteExport(id: string, acceptance: { operator: string; reviewDigest: string }): TaskRecord {
		demand(acceptance && typeof acceptance === "object", "INVALID_INPUT", "INVALID_INPUT: acceptance {operator, reviewDigest} required");
		const { operator, reviewDigest } = acceptance;
		validateOperator(operator);
		demand(typeof reviewDigest === "string" && /^[a-f0-9]{64}$/.test(reviewDigest), "INVALID_INPUT", "INVALID_INPUT: reviewDigest must be a SHA256 hex digest");
		const task = this.task(id);
		demand(task.result?.exportIncomplete, "EXPORT_REVIEW_NOT_REQUIRED", "EXPORT_REVIEW_NOT_REQUIRED: task has no incomplete export awaiting review");
		if (!task.result?.verified) {
			const current = this.exportReview(id);
			demand(current.reviewDigest === reviewDigest, "EXPORT_REVIEW_CHANGED", "EXPORT_REVIEW_CHANGED: exclusion set differs from the reviewed digest");
		}
		const result = withResultTest(task, task.resultManifest as unknown as ResultManifest, effectiveOperation(task, this.store.getOperation(id, "result-test")));
		return this.store.acceptIncompleteExport(id, operator, reviewDigest, verificationEvidence(result));
	}
}
