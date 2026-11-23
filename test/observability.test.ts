import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { Fleet } from "../src/fleet";
import { TransportError } from "../src/rpc";
import { digest, FleetError, observationDigest } from "../src/core";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fleet-observability-"));
	roots.push(root);
	const path = join(root, "source.sqlite");
	const marker = join(root, "transport-called");
	const spy = join(root, "spy.ts");
	writeFileSync(
		spy,
		`await Bun.write(${JSON.stringify(marker)}, "called"); process.exit(90);`,
	);
	const transport = { command: process.execPath, args: [spy] };
	const node: NodeConfig = {
		id: "node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: root },
		workspaceRoot: join(root, "PRIVATE_WORKSPACE_ROOT"),
		maxConcurrency: 8,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport,
		workspaceTransport: transport,
	};
	const store = new FleetStore(path, 8);
	store.putNode(node);
	return { root, path, marker, store };
}
function input(key: string): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "test",
		repoId: "repo",
		baseCommit: "a".repeat(40),
		prompt: "PRIVATE_PROMPT",
		required: {},
	};
}
function reserved(store: FleetStore, key: string) {
	return store.reserve(store.submit(input(key)).id);
}
function execution(store: FleetStore, key: string) {
	const task = reserved(store, key);
	store.setWorkspace(task.id, {
		path: "PRIVATE_WORKSPACE_PATH",
		taskId: task.id,
		attemptId: task.attemptId!,
		nodeId: task.nodeId!,
		inputDigest: task.inputDigest,
	});
	store.recordSession(task.id, "session-" + key, true);
	return store.recordTurn(task.id, "turn-" + key);
}
function observe(
	store: FleetStore,
	task: TaskRecord,
	status: "active" | "approval_required" | "completed_unverified",
	terminal = false,
	sequence?: number,
) {
	const body = {
		sessionId: task.sessionId!,
		turnId: task.turnId!,
		status,
		terminal,
		evidence: { secret: "PRIVATE_RESPONSE_EVIDENCE" },
	};
	return store.observe(
		task.id,
		{
			...body,
			eventId: `${task.id}:${status}:${sequence ?? "event"}`,
			digest: observationDigest(body),
		},
		sequence,
	);
}
function counter(
	view: ReturnType<FleetStore["observability"]>,
	operation: string,
	outcome: string,
	reason: string,
) {
	return view.counters.values.find(
		(value) =>
			value.operation === operation &&
			value.outcome === outcome &&
			value.reason === reason,
	)!.count;
}
async function failure(action: () => Promise<unknown>) {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(Error);
	return caught as Error;
}

describe("local persisted observability, not public remote telemetry", () => {
	test.each([
		["prepare", "before_send"],
		["connect", "unknown"],
		["create", "before_send"],
		["prompt", "unknown"],
		["prompt", "generic"],
	] as const)("production start %s failure retains only actual %s evidence", async (stage, certainty) => {
		const f = fixture();
		try {
			const task = reserved(f.store, "start-failure");
			if (stage !== "prepare")
				f.store.setWorkspace(task.id, {
					path: "PRIVATE_PATH",
					taskId: task.id,
					attemptId: task.attemptId!,
					nodeId: task.nodeId!,
					inputDigest: task.inputDigest,
				});
			const fleet = new Fleet(f.store);
			const error =
				certainty === "generic"
					? Object.assign(new Error("UPPER_CASE_SECRET"), {
							certainty: "before_send",
							code: "transport_closed",
						})
					: new TransportError(
							"UPPER_CASE_SECRET",
							certainty,
							"PRIVATE_MESSAGE",
							{
								answer: "PRIVATE_ANSWER",
								binding: "PRIVATE_BINDING",
								path: "PRIVATE_PATH",
							},
						);
			error.stack = "PRIVATE_STACK";
			(fleet as any).node = async () => {
				throw error;
			};
			(fleet as any).connect = async () => {
				if (stage === "connect") throw error;
				return {
					close() {},
					async call(name: string) {
						if (stage === "prompt" && name === "gjc_coordinator_start_session")
							return {
								ok: true,
								session: { session_id: "session", cwd: "PRIVATE_PATH" },
							};
						throw error;
					},
				};
			};
			const result = await fleet.start(task.id);
			expect(result).toMatchObject({
				phase: "blocked_unknown",
				held: true,
				attemptId: task.attemptId,
			});
			const event = f.store
				.events(task.id)
				.findLast((row) => row.kind === "unknown")!;
			const attributes = (event.data as any).observability.attributes;
			expect(attributes).toMatchObject({
				source: `Fleet.start.${stage}`,
				errorType: certainty === "generic" ? "unclassified" : "transport_error",
			});
			if (certainty === "generic")
				expect(attributes).not.toHaveProperty("certainty");
			else expect(attributes.certainty).toBe(certainty);
			if (stage === "connect")
				expect(attributes).not.toHaveProperty("operationId");
			else {
				const op = f.store.getOperation(task.id, stage)!;
				expect(attributes).toMatchObject({
					operationKind: stage,
					operationId: op.id,
					operationKey: op.key,
					payloadDigest: op.digest,
				});
			}
			const view = f.store.observability();
			expect(
				view.logs.findLast((row) => row.kind === "unknown")!.attributes,
			).toEqual(attributes);
			expect(view.coverage.transportErrorCertainty).toBe(
				"new_typed_transport_failure_events_only_historical_and_unclassified_unavailable",
			);
			for (const serialized of [JSON.stringify(event), JSON.stringify(view)]) {
				expect(serialized).not.toContain("PRIVATE_");
				expect(serialized).not.toContain("UPPER_CASE_SECRET");
			}
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			f.store.close();
		}
	});

	test.each([
		"connect",
		"read_turn",
		"list_questions",
	] as const)("production inspect %s keeps certainty without later operation attribution", async (stage) => {
		const f = fixture();
		try {
			const task = execution(f.store, "inspect-failure");
			const fleet = new Fleet(f.store);
			const error = new TransportError(
				"UPPER_CASE_SECRET",
				"unknown",
				"PRIVATE_MESSAGE",
				{ response: "PRIVATE_RESPONSE" },
			);
			error.stack = "PRIVATE_STACK";
			(fleet as any).connect = async () => {
				if (stage === "connect") throw error;
				return {
					close() {},
					async call(name: string) {
						if (
							stage === "list_questions" &&
							name === "gjc_coordinator_read_turn"
						)
							return {
								ok: true,
								turn: {
									session_id: task.sessionId,
									turn_id: task.turnId,
									status: "active",
								},
							};
						// A concurrent, later intent must never supply this read's operation attribution.
						f.store.beginOperation(task.id, "answer:PRIVATE_BINDING", {
							answer: "PRIVATE_ANSWER",
						});
						throw error;
					},
				};
			};
			const result = await fleet.inspect(task.id);
			expect(result.task).toMatchObject({
				held: true,
				phase: "blocked_unknown",
			});
			const event = f.store
				.events(task.id)
				.findLast((row) => row.kind === "unknown")!;
			const attributes = (event.data as any).observability.attributes;
			expect(attributes).toMatchObject({
				source: `Fleet.inspect.${stage}`,
				errorType: "transport_error",
				certainty: "unknown",
			});
			expect(attributes).not.toHaveProperty("operationKind");
			expect(attributes).not.toHaveProperty("operationId");
			const log = f.store
				.observability()
				.logs.findLast((row) => row.kind === "unknown")!;
			expect(log.attributes).toEqual(attributes);
			expect(JSON.stringify(event)).not.toContain("PRIVATE_");
			expect(JSON.stringify(log)).not.toContain("UPPER_CASE_SECRET");
			const reusable = reserved(f.store, "reuse-no-extra-writes");
			const reusableOp = f.store.beginOperation(reusable.id, "create", {
				purpose: "reuse",
			});
			const reuseHistory = JSON.stringify(f.store.events(reusable.id));
			const persisted = JSON.stringify(f.store.events(task.id));
			f.store.finishReconcileTiming(f.store.beginReconcileTiming(), "unknown");
			f.store.observability();
			expect(
				f.store.beginOperation(reusable.id, "create", reusableOp.payload),
			).toEqual(reusableOp);
			expect(
				f.store.claimOperation(reusable.id, "create", reusableOp.payload),
			).toBeNull();
			expect(JSON.stringify(f.store.events(task.id))).toBe(persisted);
			expect(JSON.stringify(f.store.events(reusable.id))).toBe(reuseHistory);
		} finally {
			f.store.close();
		}
	});

	test("metadata-only context failure cannot replace start's primary held outcome", async () => {
		const f = fixture();
		try {
			const task = reserved(f.store, "metadata-failure");
			const fleet = new Fleet(f.store);
			(fleet as any).node = async () => {
				throw new TransportError("transport_closed", "before_send");
			};
			const original = f.store.markUnknown.bind(f.store);
			const mark = spyOn(f.store, "markUnknown").mockImplementation(
				(id, reason, context) =>
					original(id, reason, {
						...context!,
						get source(): never {
							throw new Error("PRIVATE_METADATA_FAILURE");
						},
					}),
			);
			try {
				expect(await fleet.start(task.id)).toMatchObject({
					held: true,
					phase: "blocked_unknown",
					reason: "transport_closed",
				});
			} finally {
				mark.mockRestore();
			}
			expect(
				f.store.observability().durations.telemetryFailures,
			).toBeGreaterThan(0);
			const event = f.store
				.events(task.id)
				.findLast((row) => row.kind === "unknown")!;
			expect((event.data as any).failure).toEqual({});
			expect(JSON.stringify(event)).not.toContain("PRIVATE_METADATA_FAILURE");
		} finally {
			f.store.close();
		}
	});

	test.each([
		false,
		true,
	])("answer typed failure preserves its original exception with metadata failure=%s", async (metadataFailure) => {
		const f = fixture();
		try {
			const task = execution(f.store, "answer-failure");
			observe(f.store, task, "approval_required");
			const fleet = new Fleet(f.store);
			const request = {
				questionId: "question",
				answerBinding: "PRIVATE_BINDING",
				answer: "PRIVATE_ANSWER",
			};
			(fleet as any).connect = async () => ({
				close() {},
				async call(name: string) {
					if (name === "gjc_coordinator_list_questions")
						return {
							ok: true,
							reconciliation: { complete: true },
							questions: [
								{
									question_id: request.questionId,
									answer_binding: request.answerBinding,
									session_id: task.sessionId,
									turn_id: task.turnId,
									answer_schema: {},
								},
							],
						};
					throw new TransportError(
						"UPPER_CASE_SECRET",
						"before_send",
						"PRIVATE_MESSAGE",
						request,
					);
				},
			});
			const original = f.store.markUnknown.bind(f.store);
			const mark = metadataFailure
				? spyOn(f.store, "markUnknown").mockImplementation(
						(id, reason, context) =>
							original(id, reason, {
								...context!,
								get source(): never {
									throw new Error("PRIVATE_METADATA_FAILURE");
								},
							}),
					)
				: undefined;
			try {
				expect(
					(await failure(() => fleet.answer(task.id, request))).message,
				).toBe("answer_consumption_unknown_no_replay");
			} finally {
				mark?.mockRestore();
			}
			expect(f.store.task(task.id)).toMatchObject({
				held: true,
				phase: "blocked_unknown",
			});
			const event = f.store
				.events(task.id)
				.findLast((row) => row.kind === "unknown")!;
			if (!metadataFailure) {
				const op = f.store.getOperation(task.id, "answer:question")!;
				expect((event.data as any).failure).toEqual({
					source: "Fleet.answer.submit",
					errorType: "transport_error",
					certainty: "before_send",
					operationKind: "answer",
					operationId: op.id,
					operationKey: op.key,
					payloadDigest: op.digest,
				});
			} else expect((event.data as any).failure).toEqual({});
			expect(JSON.stringify(event)).not.toContain("PRIVATE_");
			expect(JSON.stringify(event)).not.toContain("UPPER_CASE_SECRET");
		} finally {
			f.store.close();
		}
	});

	test("untyped prior events remain sparse and unsupported certainty is never projected", () => {
		const f = fixture();
		try {
			const task = execution(f.store, "sparse-certainty");
			f.store.markUnknown(task.id, "unclassified");
			const prior = f.store
				.events(task.id)
				.findLast((row) => row.kind === "unknown")!;
			const bytes = JSON.stringify(prior);
			f.store.markUnknown(task.id, "transport_error", {
				source: "Fleet.start.connect",
				errorType: "transport_error",
				certainty: "UPPER_CASE_SECRET" as any,
			});
			const events = f.store
				.events(task.id)
				.filter((row) => row.kind === "unknown");
			expect(JSON.stringify(events[0])).toBe(bytes);
			expect((events[1]!.data as any).failure).toEqual({
				source: "Fleet.start.connect",
				errorType: "transport_error",
			});
			const logs = f.store
				.observability()
				.logs.filter((row) => row.kind === "unknown");
			expect(logs[0]!.attributes).not.toHaveProperty("certainty");
			expect(logs[0]!.attributes).not.toHaveProperty("source");
			expect(logs[1]!.attributes).not.toHaveProperty("certainty");
			expect(JSON.stringify(logs)).not.toContain("UPPER_CASE_SECRET");
		} finally {
			f.store.close();
		}
	});

	test("overlapping gauges, safe event-time context and explicit unavailable remote sources", () => {
		const f = fixture();
		try {
			const active = execution(f.store, "active");
			observe(f.store, active, "active");
			const approval = execution(f.store, "approval");
			observe(f.store, approval, "approval_required");
			const unknown = execution(f.store, "unknown");
			f.store.markUnknown(unknown.id, "PRIVATE_ERROR_MESSAGE");
			const cancel = execution(f.store, "cancel");
			// A retained cancel_unknown row is a synthetic snapshot fixture, not cancellation proof.
			const db = new Database(f.path);
			try {
				db.query("UPDATE tasks SET data=? WHERE id=?").run(
					JSON.stringify({ ...cancel, phase: "cancel_unknown" }),
					cancel.id,
				);
			} finally {
				db.close();
			}
			const operation = f.store.beginOperation(
				active.id,
				"answer:PRIVATE_BINDING",
				{
					answer: "PRIVATE_ANSWER",
					answerBinding: "PRIVATE_BINDING",
					argv: ["PRIVATE_ARGV"],
					path: "PRIVATE_PATH",
				},
			);
			const view = f.store.observability();
			expect(view.scope).toBe("persisted_local_snapshot");
			expect(Number.isFinite(Date.parse(view.collectedAt))).toBe(true);
			expect(view.gauges).toEqual({
				reserved_slots: 4,
				active_tasks: 1,
				unknown_tasks: 2,
				approval_tasks: 1,
			});
			expect(view.coverage).toMatchObject({
				pendingQuestions:
					"unavailable_no_current_public_complete_question_observation",
				remoteLive: "unavailable_no_remote_queries",
				remoteFenceRejected: "unavailable_no_typed_public_remote_boundary",
				remoteCursorGaps: "unavailable_no_typed_public_remote_boundary",
				hubEpoch: "unavailable_not_established",
				codeRevision: "unavailable_not_established",
			});
			expect(
				view.counters.values.some((row) => row.operation.startsWith("remote")),
			).toBe(false);
			expect(view.warnings).toContainEqual({
				reason: "held_unknown_requires_original_observation",
				count: 2,
			});
			expect(view.warnings).toContainEqual({
				reason: "approval_requires_explicit_operator_review",
				count: 1,
			});
			expect(view.warningScope).toContain("not_external_alert_delivery");
			expect(view.logs).toContainEqual(
				expect.objectContaining({
					kind: "operation_intent",
					attributes: {
						taskId: active.id,
						attemptId: active.attemptId,
						nodeId: "node",
						sessionId: active.sessionId,
						turnId: active.turnId,
						inputDigest: active.inputDigest,
						operationId: operation.id,
						operationKey: operation.key,
						payloadDigest: operation.digest,
					},
				}),
			);
			const sessionEvent = f.store
				.events(active.id)
				.find((event) => event.kind === "session_recorded")!;
			expect((sessionEvent.data as any).observability.attributes).toMatchObject(
				{ sessionId: active.sessionId },
			);
			expect(
				(sessionEvent.data as any).observability.attributes,
			).not.toHaveProperty("turnId");
			expect(JSON.stringify(view)).not.toContain("PRIVATE_");
			for (const row of view.counters.values) {
				expect(Object.keys(row).sort()).toEqual([
					"count",
					"operation",
					"outcome",
					"reason",
				]);
				expect(JSON.stringify(row)).not.toContain(active.id);
			}
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			f.store.close();
		}
	});

	test("all recorded conflicts include null-task history beyond log limit; reuse and suppressed claims are not rejections", () => {
		const f = fixture();
		try {
			const task = reserved(f.store, "repeat");
			expect(f.store.submit(input("repeat")).id).toBe(task.id);
			const op = f.store.beginOperation(task.id, "create", {
				secret: "PRIVATE_PAYLOAD",
			});
			expect(
				f.store.beginOperation(task.id, "create", {
					secret: "PRIVATE_PAYLOAD",
				}),
			).toEqual(op);
			expect(
				f.store.claimOperation(task.id, "create", {
					secret: "PRIVATE_PAYLOAD",
				}),
			).toBeNull();
			const history = new Database(f.path);
			try {
				// Seed recorded sparse history in one real SQLite transaction. One
				// current public-API conflict below proves the new event boundary.
				history.transaction(() => {
					const insert = history.query(
						"INSERT INTO audit(task_id,kind,at,data) VALUES(NULL,'refused',?,?)",
					);
					for (let i = 0; i < 104; i++)
						insert.run(
							"2000-01-01T00:00:00Z",
							JSON.stringify({ action: "submit", code: "KEY_CONFLICT" }),
						);
				})();
			} finally {
				history.close();
			}
			expect(() =>
				f.store.submit({ ...input("repeat"), prompt: "PRIVATE_CONFLICT" }),
			).toThrow();
			const view = f.store.observability();
			expect(counter(view, "submit", "rejected", "key_conflict")).toBe(105);
			expect(view.logs).toHaveLength(100);
			expect(view.coverage.audits.total).toBeGreaterThan(100);
			expect(view.counters.instance).toMatchObject({
				scope: "store_instance",
				idempotent_reuse: 2,
				operation_claim_suppressed: 1,
			});
			const db = new Database(f.path);
			try {
				expect(
					(
						db
							.query(
								"SELECT COUNT(*) AS n FROM audit WHERE kind='refused' AND task_id IS NULL",
							)
							.get() as any
					).n,
				).toBe(105);
			} finally {
				db.close();
			}
			expect(view.logs.at(-1)!.attributes).toMatchObject({
				inputDigest: digest({ ...input("repeat"), prompt: "PRIVATE_CONFLICT" }),
				code: "KEY_CONFLICT",
				certainty: "local_transaction_rolled_back",
			});
			expect(view.logs.at(-1)!.attributes).not.toHaveProperty("taskId");
			expect(JSON.stringify(view)).not.toContain("PRIVATE_");
		} finally {
			f.store.close();
		}
	});

	test("admission rejection reflects actual headroom/unavailable-node selection only", () => {
		const f = fixture();
		try {
			const unavailable = f.store.submit({
				...input("no-node"),
				required: { nodeId: "absent" },
			});
			f.store.reserve(unavailable.id);
			// Without measurements there is no slot limit: all eight are admitted.
			for (let i = 0; i < 8; i++) expect(reserved(f.store, "slot-" + i).held).toBe(true);
			// Measured headroom for eight recent tasks rejects the ninth.
			f.store.reserve(f.store.submit(input("capacity")).id, headroom(["node"], 8));
			const view = f.store.observability();
			expect(
				counter(view, "admission", "admission_rejected", "no_eligible_node"),
			).toBe(2);
			expect(
				counter(view, "admission", "admission_rejected", "global_capacity"),
			).toBe(0);
			expect(counter(view, "submit", "rejected", "key_conflict")).toBe(0);
		} finally {
			f.store.close();
		}
	});

	test("sparse historical audits are not retrofitted, rewritten, or exposed as raw logs", () => {
		const f = fixture();
		try {
			const task = execution(f.store, "history");
			const sparse = JSON.stringify({
				reason: "PRIVATE_OLD_REASON",
				response: "PRIVATE_RESPONSE",
				input: "PRIVATE_INPUT",
			});
			const sparseRefusal = JSON.stringify({
				action: "submit",
				code: "PRIVATE_SECRET_BINDING",
				reason: "PRIVATE_REFUSAL_REASON",
				response: "PRIVATE_REFUSAL_RESPONSE",
			});
			const db = new Database(f.path);
			let sequence: number;
			let refusalSequence: number;
			try {
				sequence = Number(
					db
						.query("INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)")
						.run(task.id, "unknown", "2000-01-01T00:00:00Z", sparse)
						.lastInsertRowid,
				);
				refusalSequence = Number(
					db
						.query(
							"INSERT INTO audit(task_id,kind,at,data) VALUES (NULL,?,?,?)",
						)
						.run("refused", "2000-01-01T00:00:01Z", sparseRefusal)
						.lastInsertRowid,
				);
			} finally {
				db.close();
			}
			const view = f.store.observability();
			expect(view.coverage.audits.historicalSparse).toBe(2);
			expect(view.logs.find((row) => row.sequence === sequence)).toEqual({
				sequence,
				kind: "unknown",
				at: "2000-01-01T00:00:00Z",
				coverage: "historical_sparse_unenriched",
				attributes: {},
			});
			expect(view.logs.find((row) => row.sequence === refusalSequence)).toEqual(
				{
					sequence: refusalSequence,
					kind: "refused",
					at: "2000-01-01T00:00:01Z",
					coverage: "historical_sparse_unenriched",
					attributes: {},
				},
			);
			expect(JSON.stringify(view)).not.toContain("PRIVATE_");
			expect(JSON.stringify(view.logs)).not.toContain("PRIVATE_SECRET_BINDING");
			expect(JSON.stringify(view.counters)).not.toContain(
				"PRIVATE_SECRET_BINDING",
			);
			expect(counter(view, "submit", "rejected", "key_conflict")).toBe(0);
			const check = new Database(f.path);
			try {
				expect(
					(
						check
							.query("SELECT data FROM audit WHERE sequence=?")
							.get(sequence) as any
					).data,
				).toBe(sparse);
				expect(
					(
						check
							.query("SELECT data FROM audit WHERE sequence=?")
							.get(refusalSequence) as any
					).data,
				).toBe(sparseRefusal);
			} finally {
				check.close();
			}
		} finally {
			f.store.close();
		}
	});

	test("local stale poll is distinct from remote fences; unknown recovery links exact before/after/receipt", () => {
		const f = fixture();
		try {
			const task = execution(f.store, "reconcile");
			const old = f.store.beginObservation(task.id)!;
			const current = f.store.beginObservation(task.id)!;
			f.store.markObservationUnknown(
				task.id,
				current,
				"observation_unavailable_original_attempt_held",
			);
			observe(f.store, task, "active", false, old);
			expect(f.store.task(task.id)!.phase).toBe("blocked_unknown");
			const before = f.store.observability();
			expect(counter(before, "reconcile", "stale", "local_poll_sequence")).toBe(
				1,
			);
			expect(
				counter(before, "reconcile", "reconciled", "authoritative_observation"),
			).toBe(0);
			observe(f.store, task, "active", false, current);
			const view = f.store.observability();
			expect(
				counter(view, "reconcile", "reconciled", "authoritative_observation"),
			).toBe(1);
			expect(view.logs).toContainEqual(
				expect.objectContaining({
					kind: "unknown_reconciled",
					attributes: expect.objectContaining({
						before: "blocked_unknown",
						after: "active",
						receiptEventId: `${task.id}:active:${current}`,
					}),
				}),
			);
			// Idempotent reapplication is not a second transition.
			observe(f.store, task, "active", false, current);
			expect(
				counter(
					f.store.observability(),
					"reconcile",
					"reconciled",
					"authoritative_observation",
				),
			).toBe(1);
			expect(view.coverage.remoteFenceRejected).toBe(
				"unavailable_no_typed_public_remote_boundary",
			);
		} finally {
			f.store.close();
		}
	});

	test("real Fleet.result cached validation boundary records sanitized category without changing task or exception", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, "result");
			observe(f.store, task, "completed_unverified", true);
			f.store.saveResult(task.id, {
				identity: "PRIVATE_BAD_BINDING",
				patch: "PRIVATE_PATCH",
			});
			const before = f.store.task(task.id);
			const error = await failure(() => new Fleet(f.store).result(task.id));
			expect(error).toBeInstanceOf(FleetError);
			expect((error as FleetError).code).toBe("RESULT_BINDING");
			expect(f.store.task(task.id)).toEqual(before);
			const view = f.store.observability();
			expect(
				counter(view, "result", "validation_rejected", "RESULT_BINDING"),
			).toBe(1);
			expect(view.logs.at(-1)).toMatchObject({
				kind: "result_validation_rejected",
				attributes: {
					code: "RESULT_BINDING",
					certainty: "local_validation",
					taskId: task.id,
				},
			});
			expect(JSON.stringify(view)).not.toContain("PRIVATE_");
			expect(existsSync(f.marker)).toBe(false);
			const auditFailure = spyOn(
				f.store,
				"recordResultValidationRejected",
			).mockImplementation(() => {
				throw new Error("PRIVATE_AUDIT_FAILURE");
			});
			try {
				const second = await failure(() => new Fleet(f.store).result(task.id));
				expect((second as FleetError).code).toBe("RESULT_BINDING");
				expect(second.message).toBe(error.message);
				expect(f.store.task(task.id)).toEqual(before);
				expect(f.store.observability().durations.telemetryFailures).toBe(1);
			} finally {
				auditFailure.mockRestore();
			}
		} finally {
			f.store.close();
		}
	});

	test("monotonic admission spans include completion, omit reserve noops and cannot reconstruct restart origins", () => {
		const f = fixture();
		let second: FleetStore | undefined;
		try {
			const task = reserved(f.store, "timing");
			const values = f.store.observability().durations.values;
			expect(
				values.find((v) => v.operation === "enqueue_to_admission")!.count,
			).toBe(1);
			expect(
				values.find(
					(v) => v.operation === "admission" && v.outcome === "reserved",
				)!.count,
			).toBe(1);
			f.store.reserve(task.id);
			expect(f.store.observability().durations.values).toEqual(values);
			expect(f.store.observability().durations.noopsWithoutSample).toBe(1);
			const mutableView = f.store.observability();
			mutableView.durations.boundsMs.push(999999);
			mutableView.durations.values[0]!.buckets.fill(0);
			expect(f.store.observability().durations.values).toEqual(values);
			expect(f.store.observability().durations.boundsMs).toEqual([
				1, 10, 100, 1000, 10000,
			]);
			const queued = f.store.submit(input("restart-origin"));
			second = new FleetStore(f.path, 8);
			const initial = second.observability();
			expect(initial.durations).toMatchObject({
				scope: "store_instance",
				status: "unavailable",
				values: [],
				unavailableReason: "no_completed_spans_in_this_store_instance",
			});
			expect(initial.counters.instance.idempotent_reuse).toBe(0);
			second.reserve(queued.id);
			const after = second.observability();
			expect(after.durations.missingEnqueueOrigins).toBe(1);
			expect(
				after.durations.values.some(
					(v) => v.operation === "enqueue_to_admission",
				),
			).toBe(false);
			for (const value of [...values, ...after.durations.values]) {
				expect(Number.isFinite(value.sumMs) && value.sumMs >= 0).toBe(true);
				expect(value.buckets.at(-1)).toBe(value.count);
				expect(Object.keys(value).sort()).toEqual([
					"buckets",
					"count",
					"operation",
					"outcome",
					"sumMs",
				]);
			}
		} finally {
			second?.close();
			f.store.close();
		}
	});

	test("clock failures and backwards readings expose diagnostics without synthetic zero samples or primary failure", () => {
		const f = fixture();
		try {
			const clock = spyOn(performance, "now")
				.mockReturnValueOnce(50)
				.mockReturnValueOnce(40);
			try {
				f.store.finishReconcileTiming(
					f.store.beginReconcileTiming(),
					"applied",
				);
			} finally {
				clock.mockRestore();
			}
			expect(f.store.observability().durations).toMatchObject({
				status: "unavailable",
				telemetryFailures: 1,
				values: [],
			});
			const failedClock = spyOn(performance, "now").mockImplementation(() => {
				throw new Error("PRIVATE_CLOCK_FAILURE");
			});
			try {
				expect(reserved(f.store, "clock-failed")).toMatchObject({
					held: true,
					phase: "preparing",
				});
			} finally {
				failedClock.mockRestore();
			}
			expect(
				f.store.observability().durations.telemetryFailures,
			).toBeGreaterThan(1);
			expect(JSON.stringify(f.store.observability())).not.toContain("PRIVATE_");
		} finally {
			f.store.close();
		}
	});

	test("actual inspect spans cover applied/stale/unknown without sampling identity and terminal noops", async () => {
		const f = fixture();
		try {
			const fleet = new Fleet(f.store);
			const noop = reserved(f.store, "no-execution");
			await fleet.inspect(noop.id);
			expect(
				f.store
					.observability()
					.durations.values.some((v) => v.operation === "reconcile"),
			).toBe(false);
			const task = execution(f.store, "inspect");
			let complete = true;
			let supersede = false;
			// Local deterministic RPC fixture, not a public SDK or remote evidence claim.
			(fleet as any).connect = async () => ({
				close() {},
				async call(name: string) {
					if (name === "gjc_coordinator_read_turn") {
						if (supersede) f.store.beginObservation(task.id);
						return {
							ok: true,
							turn: {
								session_id: task.sessionId,
								turn_id: task.turnId,
								status: "active",
							},
						};
					}
					return { ok: true, reconciliation: { complete }, questions: [] };
				},
			});
			await fleet.inspect(task.id);
			supersede = true;
			await fleet.inspect(task.id);
			supersede = false;
			complete = false;
			await fleet.inspect(task.id);
			const spans = f.store
				.observability()
				.durations.values.filter((v) => v.operation === "reconcile");
			expect(spans.map((v) => v.outcome).sort()).toEqual([
				"applied",
				"stale",
				"unknown",
			]);
			for (const span of spans) expect(span.count).toBe(1);
			const primaryFailure = new Error("PRIVATE_LOCAL_RECONCILE_FAILURE");
			const failApply = spyOn(
				f.store,
				"markObservationUnknown",
			).mockImplementation(() => {
				throw primaryFailure;
			});
			try {
				expect(await failure(() => fleet.inspect(task.id))).toBe(
					primaryFailure,
				);
			} finally {
				failApply.mockRestore();
			}
			const failed = f.store
				.observability()
				.durations.values.find(
					(v) => v.operation === "reconcile" && v.outcome === "failed",
				)!;
			expect(failed.count).toBe(1);
			expect(Number.isFinite(failed.sumMs) && failed.sumMs >= 0).toBe(true);
			const completedSpans = f.store
				.observability()
				.durations.values.filter((v) => v.operation === "reconcile");
			observe(f.store, f.store.task(task.id)!, "completed_unverified", true);
			await fleet.inspect(task.id);
			expect(
				f.store
					.observability()
					.durations.values.filter((v) => v.operation === "reconcile"),
			).toEqual(completedSpans);
			expect(existsSync(f.marker)).toBe(false);
		} finally {
			f.store.close();
		}
	});

	test.each([
		false,
		true,
	])("actual observability CLI readonly=%s preserves DELETE bytes/mode/sidecars and has no input or transport effects", async (readOnly) => {
		const f = fixture();
		const snapshot = join(f.root, "snapshot.sqlite");
		try {
			const task = execution(f.store, "cli");
			f.store.markUnknown(task.id, "PRIVATE_UNKNOWN_REASON");
			f.store.backup(snapshot);
		} finally {
			f.store.close();
		}
		const before = readFileSync(snapshot);
		const mode = statSync(snapshot).mode;
		const inputMarker = join(f.root, "input-read");
		const preload = join(f.root, "preload.ts");
		writeFileSync(
			preload,
			`import { writeFileSync } from "node:fs"; Bun.file = () => { writeFileSync(${JSON.stringify(inputMarker)}, "read"); throw new Error("PRIVATE_FILE_READ"); };`,
		);
		const names = readdirSync(f.root).sort();
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				preload,
				resolve(import.meta.dir, "../src/cli.ts"),
				"--db",
				snapshot,
				"--cap",
				"8",
				...(readOnly ? ["--read-only"] : []),
				"observability",
			],
			{ cwd: f.root, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		expect(JSON.parse(stdout)).toMatchObject({
			scope: "persisted_local_snapshot",
			gauges: { reserved_slots: 1, unknown_tasks: 1 },
			durations: { scope: "store_instance", status: "unavailable", values: [] },
		});
		expect(stdout).not.toContain("PRIVATE_");
		expect(readFileSync(snapshot).equals(before)).toBe(true);
		expect(statSync(snapshot).mode).toBe(mode);
		expect(readdirSync(f.root).sort()).toEqual(names);
		expect(existsSync(inputMarker)).toBe(false);
		expect(existsSync(f.marker)).toBe(false);
		expect(existsSync(join(f.root, ".local"))).toBe(false);
	});
});
