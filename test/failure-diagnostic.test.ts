// Behaviour tests for the bounded failure diagnostic persisted with unknown/blocked/refused
// state changes. This file intentionally imports only modules that exist in the base tree so
// the "reasons and phases unchanged" half can be run against unmodified fleet-main.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { TransportError } from "../src/rpc";
import { FleetError, observationDigest } from "../src/core";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";

// Deny-by-default: a stored diagnostic carries an allowlisted code and the fixed text for that code,
// never the message itself or anything derived from it (no length, no hash).
function coded(code: string, text: string) {
	return { code, message: text };
}
const UNCLASSIFIED = "Unclassified failure; no code recorded";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const helper = fileURLToPath(new URL("../src/node.ts", import.meta.url));

type NodeVariant = "fake" | "no-route" | "real-helper-denied" | "sdk-authority";
function fixture(variant: NodeVariant = "fake") {
	const root = mkdtempSync(join(tmpdir(), "fleet-diagnostic-"));
	roots.push(root);
	const spy = join(root, "spy.ts");
	writeFileSync(spy, "process.exit(90);");
	const transport = { command: process.execPath, args: [spy] };
	const node: NodeConfig = {
		id: "node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: root },
		workspaceRoot: join(root, "work"),
		maxConcurrency: 8,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport,
		...(variant === "no-route" ? {} : { workspaceTransport: transport }),
	};
	if (variant === "real-helper-denied") {
		const config = join(root, "node.json");
		// The node's own helper config does not allowlist the repository: a real node-side refusal.
		writeFileSync(config, JSON.stringify({ ...node, roots: { other: root } }));
		node.workspaceTransport = { command: process.execPath, args: [helper, config] };
	}
	if (variant === "sdk-authority") {
		const sdk = join(root, "sdk.ts");
		writeFileSync(sdk, "console.log('not json from C:\\\\Users\\\\alice\\\\PRIVATE_SDK');");
		node.sdkTransport = { command: process.execPath, args: [sdk] };
	}
	const store = new FleetStore(join(root, "fleet.sqlite"), 8);
	store.putNode(node);
	return { root, store, workspacePath: join(root, "work", "ws") };
}
function input(key: string): TaskInput {
	return { schemaVersion: 1, key, caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "PRIVATE_PROMPT", required: {} };
}
function identity(task: TaskRecord, path: string, overrides: Record<string, unknown> = {}) {
	return { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: task.nodeId!, inputDigest: task.inputDigest, baseCommit: task.input.baseCommit, path, ...overrides };
}
type Rpc = { close(): void; call(name: string, args: any): Promise<any> };
function rpc(handlers: Record<string, (args: any) => any>): Rpc {
	return {
		close() {},
		async call(name, args) {
			const handler = handlers[name];
			if (!handler) throw new Error("unexpected_call");
			return handler(args);
		},
	};
}

type Scenario = {
	name: string;
	variant?: NodeVariant;
	setup: (f: ReturnType<typeof fixture>, fleet: Fleet, task: TaskRecord) => void;
	reason: string;
	failure: "none" | { source: string; errorType: string; certainty?: string; operationKind?: string };
	diagnostic: Record<string, unknown>;
	mustNotContain?: string[];
};
const created = (path: string, ephemeral = false) => () => ({ ok: true, session: { session_id: "session-1", cwd: path, ephemeral } });
const scenarios: Scenario[] = [
	{
		name: "before prepare (no authenticated workspace route)",
		variant: "no-route",
		setup() {},
		reason: "node_operation_failed_original_attempt_held",
		failure: "none",
		diagnostic: { source: "Fleet.start.prepare", phase: "precondition", errorClass: "FleetError", ...coded("fleet:remote_workspace_transport_required", "Fleet check refused the step") },
	},
	{
		name: "prepare throw",
		setup(f, fleet) {
			(fleet as any).node = async () => {
				throw Object.assign(new Error("EACCES: permission denied, mkdir 'C:\\Users\\alice\\PRIVATE_WORK'\n    at secret stack"), { code: "EACCES" });
			};
		},
		reason: "node_operation_failed_original_attempt_held",
		failure: { source: "Fleet.start.prepare", errorType: "unclassified", operationKind: "prepare" },
		diagnostic: { source: "Fleet.start.prepare", phase: "call", operationKind: "prepare", errorClass: "Error", ...coded("unclassified", UNCLASSIFIED) },
		mustNotContain: ["alice", "PRIVATE_WORK", "\\n", "secret stack", "mkdir"],
	},
	{
		name: "prepare binding mismatch",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath, { taskId: "other-task" });
		},
		reason: "node_operation_failed_original_attempt_held",
		failure: "none",
		diagnostic: { source: "Fleet.start.prepare", phase: "validate", operationKind: "prepare", errorClass: "FleetError", ...coded("fleet:workspace_binding", "Fleet check refused the step") },
	},
	{
		name: "connect transport failure",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => {
				throw new TransportError("transport_exited", "unknown");
			};
		},
		reason: "transport_exited",
		failure: { source: "Fleet.start.connect", errorType: "transport_error", certainty: "unknown" },
		diagnostic: { source: "Fleet.start.connect", phase: "call", errorClass: "TransportError", ...coded("transport:transport_exited", "Transport process exited") },
	},
	{
		name: "session create throw",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_start_session() {
					throw new TransportError("rpc_error", "unknown", "PRIVATE_MESSAGE from alice@build01");
				},
			});
		},
		reason: "rpc_error",
		failure: { source: "Fleet.start.create", errorType: "transport_error", certainty: "unknown", operationKind: "create" },
		diagnostic: { source: "Fleet.start.create", phase: "call", operationKind: "create", errorClass: "TransportError", ...coded("transport:rpc_error", "Remote returned an RPC error") },
		mustNotContain: ["PRIVATE_", "alice", "build01", " from "],
	},
	{
		name: "authority read throw",
		variant: "sdk-authority",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => rpc({ gjc_coordinator_start_session: created(f.workspacePath, true) });
		},
		reason: "invalid_public_sdk_response",
		failure: { source: "Fleet.start.authority", errorType: "transport_error", certainty: "unknown" },
		diagnostic: { source: "Fleet.start.authority", phase: "call", errorClass: "TransportError", ...coded("transport:invalid_public_sdk_response", "Public SDK reply was invalid") },
		mustNotContain: ["PRIVATE_SDK", "alice"],
	},
	{
		name: "prompt claim already held",
		setup(f, fleet, task) {
			f.store.setWorkspace(task.id, identity(task, f.workspacePath) as any);
			f.store.recordSession(task.id, "session-1", true);
			f.store.beginOperation(task.id, "prompt", { session_id: "session-1", prompt: task.input.prompt, allow_mutation: true });
			(fleet as any).connect = async () => rpc({});
		},
		reason: "prompt_response_unavailable_no_readonly_key_lookup",
		failure: "none",
		diagnostic: { source: "Fleet.start.prompt", phase: "claim", operationKind: "prompt", errorClass: "none", ...coded("condition:operation_already_claimed", "Effect intent already claimed; not replayed") },
	},
	{
		name: "prompt transport error",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_start_session: created(f.workspacePath),
				gjc_coordinator_send_prompt() {
					throw new TransportError("transport_closed", "before_send");
				},
			});
		},
		reason: "transport_closed",
		failure: { source: "Fleet.start.prompt", errorType: "transport_error", certainty: "before_send", operationKind: "prompt" },
		diagnostic: { source: "Fleet.start.prompt", phase: "call", operationKind: "prompt", errorClass: "TransportError", ...coded("transport:transport_closed", "Transport was closed") },
	},
	{
		name: "prompt timeout",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_start_session: created(f.workspacePath),
				gjc_coordinator_send_prompt() {
					throw new TransportError("transport_timeout", "unknown");
				},
			});
		},
		reason: "transport_timeout",
		failure: { source: "Fleet.start.prompt", errorType: "transport_error", certainty: "unknown", operationKind: "prompt" },
		diagnostic: { source: "Fleet.start.prompt", phase: "call", operationKind: "prompt", errorClass: "TransportError", ...coded("transport:transport_timeout", "Transport request timed out") },
	},
	{
		name: "prompt acceptance not confirmed",
		setup(f, fleet, task) {
			(fleet as any).node = async () => identity(task, f.workspacePath);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_start_session: created(f.workspacePath),
				gjc_coordinator_send_prompt: () => ({ ok: false }),
			});
		},
		reason: "node_operation_failed_original_attempt_held",
		failure: "none",
		diagnostic: { source: "Fleet.start.prompt", phase: "validate", operationKind: "prompt", errorClass: "FleetError", ...coded("fleet:turn_unconfirmed", "Fleet check refused the step") },
	},
];

async function runStart(scenario: Scenario) {
	const f = fixture(scenario.variant);
	try {
		const task = f.store.reserve(f.store.submit(input("diag")).id);
		const fleet = new Fleet(f.store);
		scenario.setup(f, fleet, task);
		const result = await fleet.start(task.id);
		const events = f.store.events(task.id);
		const unknown = events.filter((event) => event.kind === "unknown");
		return { f, task, result, events, unknown };
	} catch (error) {
		f.store.close();
		throw error;
	}
}

describe("Fleet.start failure keeps the original outcome (identical to base)", () => {
	for (const scenario of scenarios)
		test(`${scenario.name}: reason, phase, hold and failure context unchanged`, async () => {
			const { f, task, result, unknown } = await runStart(scenario);
			try {
				expect(result.phase).toBe("blocked_unknown");
				expect(result.held).toBe(true);
				expect(result.reason).toBe(scenario.reason);
				expect(result.attemptId).toBe(task.attemptId);
				expect(result).not.toHaveProperty("failureDiagnostic");
				expect(f.store.task(task.id)).toEqual(result);
				expect(unknown).toHaveLength(1);
				const data = unknown[0]!.data as any;
				expect(data.reason).toBe(scenario.reason);
				if (scenario.failure === "none") expect(data).not.toHaveProperty("failure");
				else {
					const expected: Record<string, unknown> = { ...scenario.failure };
					if (scenario.failure.operationKind) {
						const op = f.store.getOperation(task.id, scenario.failure.operationKind)!;
						Object.assign(expected, { operationId: op.id, operationKey: op.key, payloadDigest: op.digest });
					}
					expect(data.failure).toEqual(expected);
				}
				expect(Object.keys(data).filter((key) => key !== "failureDiagnostic").sort()).toEqual(
					["observability", "reason", ...(scenario.failure === "none" ? [] : ["failure"])].sort(),
				);
			} finally {
				f.store.close();
			}
		});
});

describe("Fleet.start failure persists a bounded structured diagnostic", () => {
	for (const scenario of scenarios)
		test(`${scenario.name}: diagnostic names step and code`, async () => {
			const { f, task, unknown } = await runStart(scenario);
			try {
				const diagnostic = (unknown[0]!.data as any).failureDiagnostic;
				const expected: Record<string, unknown> = { version: 1, use: "diagnostic_only_not_evidence", ...scenario.diagnostic };
				if (scenario.diagnostic.operationKind)
					expected.operationId = f.store.getOperation(task.id, scenario.diagnostic.operationKind as string)!.id;
				expect(diagnostic).toEqual(expected);
				const serialized = JSON.stringify(unknown[0]);
				for (const leak of [...(scenario.mustNotContain ?? []), "PRIVATE_PROMPT", f.root, f.root.replaceAll("\\", "\\\\")])
					expect(serialized).not.toContain(leak);
			} finally {
				f.store.close();
			}
		});
});

function execution(store: FleetStore, path: string) {
	const task = store.reserve(store.submit(input("inspect")).id);
	store.setWorkspace(task.id, identity(task, path) as any);
	store.recordSession(task.id, "session-1", true);
	return store.recordTurn(task.id, "turn-1");
}
describe("other Fleet catch sites", () => {
	test("inspect binding mismatch after read_turn keeps reason and records validate step", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const fleet = new Fleet(f.store);
			(fleet as any).connect = async () => rpc({ gjc_coordinator_read_turn: () => ({ ok: true, turn: { session_id: "other", turn_id: "x" } }) });
			const { task: after } = await fleet.inspect(task.id);
			expect(after).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
			const data = f.store.events(task.id).findLast((event) => event.kind === "unknown")!.data as any;
			expect(data).not.toHaveProperty("failure");
			expect(data.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.inspect.read_turn", phase: "validate", errorClass: "FleetError", ...coded("fleet:observation_binding", "Fleet check refused the step") });
		} finally {
			f.store.close();
		}
	});

	test("inspect incomplete questions records a no-error diagnostic", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const fleet = new Fleet(f.store);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_read_turn: () => ({ ok: true, turn: { session_id: "session-1", turn_id: "turn-1", status: "active" } }),
				gjc_coordinator_list_questions: () => ({ ok: true, reconciliation: { complete: false } }),
			});
			const { task: after } = await fleet.inspect(task.id);
			expect(after).toMatchObject({ phase: "blocked_unknown", reason: "observation_unavailable_original_attempt_held" });
			const data = f.store.events(task.id).findLast((event) => event.kind === "unknown")!.data as any;
			expect(data.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.inspect.list_questions", phase: "validate", errorClass: "none", ...coded("condition:questions_incomplete", "Question reconciliation incomplete") });
		} finally {
			f.store.close();
		}
	});

	test("inspect transport failure on read_turn keeps base certainty and records call step", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const fleet = new Fleet(f.store);
			(fleet as any).connect = async () => rpc({ gjc_coordinator_read_turn() { throw new TransportError("transport_closed", "unknown"); } });
			await fleet.inspect(task.id);
			const data = f.store.events(task.id).findLast((event) => event.kind === "unknown")!.data as any;
			expect(data.failure).toEqual({ source: "Fleet.inspect.read_turn", errorType: "transport_error", certainty: "unknown" });
			expect(data.failureDiagnostic).toMatchObject({ source: "Fleet.inspect.read_turn", phase: "call", errorClass: "TransportError", code: "transport:transport_closed" });
		} finally {
			f.store.close();
		}
	});

	test("answer submit transport failure keeps its exception and records the answer operation", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "approval_required" as const, terminal: false, evidence: { questions: true } };
			f.store.observe(task.id, { ...body, eventId: task.id + ":approval", digest: observationDigest(body) });
			const fleet = new Fleet(f.store);
			const request = { questionId: "q1", answerBinding: "binding", answer: "yes" };
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_list_questions: () => ({ ok: true, reconciliation: { complete: true }, questions: [{ question_id: "q1", answer_binding: "binding", session_id: task.sessionId, turn_id: task.turnId, answer_schema: {} }] }),
				gjc_coordinator_submit_question_answer() { throw new TransportError("transport_closed", "before_send"); },
			});
			await expect(fleet.answer(task.id, request)).rejects.toThrow("answer_consumption_unknown_no_replay");
			expect(f.store.task(task.id)).toMatchObject({ phase: "blocked_unknown", reason: "answer_consumption_unknown_no_replay" });
			const data = f.store.events(task.id).findLast((event) => event.kind === "unknown")!.data as any;
			const op = f.store.getOperation(task.id, "answer:q1")!;
			expect(data.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.answer.submit", phase: "call", operationKind: "answer", operationId: op.id, errorClass: "TransportError", ...coded("transport:transport_closed", "Transport was closed") });
		} finally {
			f.store.close();
		}
	});

	test("result validation rejection records diagnostic without changing task or exception", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { done: true } };
			f.store.observe(task.id, { ...body, eventId: task.id + ":done", digest: observationDigest(body) });
			f.store.saveResult(task.id, { identity: "PRIVATE_BAD_BINDING", patch: "PRIVATE_PATCH" } as any);
			const before = f.store.task(task.id);
			const error = await new Fleet(f.store).result(task.id).catch((e) => e);
			expect(error).toBeInstanceOf(FleetError);
			expect(error.code).toBe("RESULT_BINDING");
			expect(f.store.task(task.id)).toEqual(before);
			const event = f.store.events(task.id).findLast((row) => row.kind === "result_validation_rejected")!;
			expect((event.data as any).code).toBe("RESULT_BINDING");
			expect((event.data as any).certainty).toBe("local_validation");
			expect((event.data as any).failureDiagnostic).toMatchObject({ source: "Fleet.result", phase: "validate", errorClass: "FleetError", code: "fleet:result_binding", message: "Fleet check refused the step" });
			expect(JSON.stringify(event)).not.toContain("PRIVATE_");
		} finally {
			f.store.close();
		}
	});
});

// Catch sites that exist only on production main (cb1b744): typed node refusals with preflight
// re-evaluation and the tolerant read used by operator watch.
describe("production-main catch sites", () => {
	const nodeRefused = coded("transport:node_refused", "Node helper refused before sending; nothing ran");
	test("a real node-side before_send refusal and its preflight re-evaluation carry diagnostics; outcome unchanged", async () => {
		const f = fixture("real-helper-denied");
		try {
			const task = f.store.reserve(f.store.submit(input("refused")).id);
			const first = await new Fleet(f.store).start(task.id).catch((e) => e);
			expect(first).toBeInstanceOf(FleetError);
			expect(first.code).toBe("node_refused:root_denied:allowlist");
			expect(f.store.task(task.id)).toMatchObject({ phase: "dispatching", held: true, attemptId: task.attemptId });
			const op = f.store.getOperation(task.id, "prepare")!;
			const refusal = f.store.events(task.id).findLast((row) => row.kind === "node_operation_failure")!.data as any;
			expect(refusal).toMatchObject({ code: "node_refused:root_denied:allowlist", certainty: "before_send" });
			expect(refusal.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prepare", phase: "call", operationKind: "prepare", operationId: op.id, errorClass: "TransportError", ...nodeRefused });
			const second = await new Fleet(f.store).start(task.id).catch((e) => e);
			expect(second.code).toBe("node_refused:root_denied:allowlist");
			expect(f.store.task(task.id)).toMatchObject({ phase: "dispatching", held: true, attemptId: task.attemptId, reason: "preparation_refusal_retained:still_refused" });
			const reevaluation = f.store.events(task.id).findLast((row) => row.kind === "preparation_reevaluation")!.data as any;
			expect(reevaluation).toMatchObject({ operationId: op.id, outcome: "still_refused", code: "node_refused:root_denied:allowlist" });
			expect(reevaluation.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.preflight", phase: "call", operationKind: "prepare", operationId: op.id, errorClass: "TransportError", ...nodeRefused });
			const rejected = f.store.events(task.id).filter((row) => row.kind === "node_operation_failure");
			expect(rejected).toHaveLength(2);
			expect((rejected[1]!.data as any).failureDiagnostic).toEqual(reevaluation.failureDiagnostic);
			expect(JSON.stringify(f.store.events(task.id))).not.toContain(f.root);
		} finally {
			f.store.close();
		}
	});

	test("a preflight reply that is not a pass records a no-error diagnostic; attempt kept", async () => {
		const f = fixture("real-helper-denied");
		try {
			const task = f.store.reserve(f.store.submit(input("preflight")).id);
			await new Fleet(f.store).start(task.id).catch(() => undefined);
			const op = f.store.getOperation(task.id, "prepare")!;
			const fleet = new Fleet(f.store);
			(fleet as any).node = async () => ({ preflight: "PRIVATE_NOT_PASSED" });
			const error = await fleet.start(task.id).catch((e) => e);
			expect(error.code).toBe("preflight_reply_invalid");
			expect(f.store.task(task.id)).toMatchObject({ phase: "dispatching", attemptId: task.attemptId, reason: "preparation_refusal_retained:unavailable" });
			const data = f.store.events(task.id).findLast((row) => row.kind === "preparation_reevaluation")!.data as any;
			expect(data).toMatchObject({ outcome: "unavailable", code: "preflight_reply_invalid" });
			expect(data.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.preflight", phase: "call", operationKind: "prepare", operationId: op.id, errorClass: "none", ...coded("condition:preflight_reply_invalid", "Preflight reply was not a pass") });
			expect(JSON.stringify(f.store.events(task.id))).not.toContain("PRIVATE_");
		} finally {
			f.store.close();
		}
	});

	test("a failed tolerant read is abandoned with a diagnostic; the task is unchanged", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const fleet = new Fleet(f.store);
			(fleet as any).connect = async () => rpc({ gjc_coordinator_read_turn() { throw new TransportError("transport_closed", "unknown", "PRIVATE_STDERR"); } });
			const error = await fleet.inspect(task.id, { tolerateReadFailure: true }).catch((e) => e);
			expect(error.code).toBe("OBSERVATION_UNAVAILABLE");
			const after = f.store.task(task.id)!;
			expect([after.phase, after.held, after.reason, after.attemptId]).toEqual([task.phase, true, task.reason, task.attemptId]);
			const data = f.store.events(task.id).findLast((row) => row.kind === "abandoned_poll")!.data as any;
			expect(data.failure).toEqual({ source: "Fleet.inspect.read_turn", errorType: "transport_error", certainty: "unknown" });
			expect(data.failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.inspect.read_turn", phase: "call", errorClass: "TransportError", ...coded("transport:transport_closed", "Transport was closed") });
			expect(f.store.events(task.id).some((row) => row.kind === "unknown")).toBe(false);
			expect(JSON.stringify(f.store.events(task.id))).not.toContain("PRIVATE_");
		} finally {
			f.store.close();
		}
	});

	test("a strict failure deferred to an abandoned read is applied with its own diagnostic", async () => {
		const f = fixture();
		try {
			const task = execution(f.store, f.workspacePath);
			const strict = f.store.beginObservation(task.id)!;
			const fleet = new Fleet(f.store);
			(fleet as any).connect = async () => rpc({
				gjc_coordinator_read_turn() {
					// The concurrent strict read fails while this tolerant read is the latest issued one.
					f.store.markObservationUnknown(task.id, strict, "observation_unavailable_original_attempt_held", { source: "Fleet.inspect.connect", errorType: "unclassified" },
						{ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.inspect.connect", phase: "call", errorClass: "Error", code: "unclassified", message: UNCLASSIFIED });
					throw new TransportError("transport_exited", "unknown");
				},
			});
			const { task: after } = await fleet.inspect(task.id, { tolerateReadFailure: true });
			expect(after).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
			const stale = f.store.events(task.id).findLast((row) => row.kind === "stale_poll_failure")!.data as any;
			const abandoned = f.store.events(task.id).findLast((row) => row.kind === "abandoned_poll")!.data as any;
			const unknown = f.store.events(task.id).findLast((row) => row.kind === "unknown")!.data as any;
			expect(abandoned.failureDiagnostic).toMatchObject({ source: "Fleet.inspect.read_turn", errorClass: "TransportError", code: "transport:transport_exited" });
			expect(unknown).toMatchObject({ reason: "observation_unavailable_original_attempt_held", deferredSequence: strict });
			expect(unknown.failureDiagnostic).toEqual(stale.failureDiagnostic);
			expect(unknown.failureDiagnostic).toMatchObject({ source: "Fleet.inspect.connect", code: "unclassified" });
			expect(f.store.reasonDiagnostic(task.id)?.diagnostic).toEqual(unknown.failureDiagnostic);
		} finally {
			f.store.close();
		}
	});
});

describe("diagnostic is not evidence", () => {
	test("diagnostic content never changes later reconciliation, replay fences or settlement", async () => {
		const outcomes: unknown[] = [];
		for (const message of ["first C:\\Users\\alice\\a", "completely different second message"]) {
			const f = fixture();
			try {
				const task = f.store.reserve(f.store.submit(input("evidence")).id);
				const fleet = new Fleet(f.store);
				(fleet as any).node = async () => identity(task, f.workspacePath);
				(fleet as any).connect = async () => rpc({
					gjc_coordinator_start_session: created(f.workspacePath),
					gjc_coordinator_send_prompt() { throw new TransportError("transport_timeout", "unknown", message); },
				});
				const blocked = await fleet.start(task.id);
				// A second start is fenced by the held unknown state regardless of diagnostic text.
				const again = await fleet.start(task.id);
				expect(again).toEqual(blocked);
				// Any further effect claim is still fenced by the unknown execution.
				expect(() => f.store.claimOperation(task.id, "prompt", { session_id: "session-1", prompt: task.input.prompt, allow_mutation: true })).toThrow("Unknown execution requires authoritative observation, not another effect");
				const kinds = f.store.events(task.id).map((event) => event.kind);
				const { phase, held, reason, sessionId, sessionValidated, turnId, result, pollIssued, pollApplied } = f.store.task(task.id)!;
				outcomes.push({ task: { phase, held, reason, sessionId, sessionValidated, turnId, result, pollIssued, pollApplied, keys: Object.keys(f.store.task(task.id)!).sort() }, kinds, operations: ["prepare", "create", "prompt"].map((kind) => !!f.store.getOperation(task.id, kind)) });
			} finally {
				f.store.close();
			}
		}
		expect(outcomes[1]).toEqual(outcomes[0]);
	});
});

describe("CLI exposure is read-only", () => {
	test("show prints the diagnostic of the event behind the reason, events print it as stored; the database bytes are unchanged by reading", async () => {
		const f = fixture();
		const scenario = scenarios.find((s) => s.name === "prompt timeout")!;
		const task = f.store.reserve(f.store.submit(input("cli")).id);
		const fleet = new Fleet(f.store);
		scenario.setup(f, fleet, task);
		await fleet.start(task.id);
		f.store.close();
		const db = join(f.root, "fleet.sqlite");
		const before = await Bun.file(db).bytes();
		const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const run = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, cli, "--db", db, "--cap", "8", "--read-only", ...args], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			return { stdout, stderr, exit };
		};
		const shown = await run("show", task.id);
		expect(shown.stderr).toBe("");
		expect(shown.exit).toBe(0);
		const value = JSON.parse(shown.stdout);
		expect(value.reason).toBe("transport_timeout");
		const unknownEvent = JSON.parse((await run("events", task.id)).stdout).findLast((e: any) => e.kind === "unknown");
		expect(value.failureDiagnostic).toEqual({ event: "unknown", sequence: unknownEvent.sequence, ...unknownEvent.data.failureDiagnostic });
		expect(value.failureDiagnostic).toMatchObject({ source: "Fleet.start.prompt", phase: "call", code: "transport:transport_timeout" });
		const events = await run("events", task.id);
		expect(events.exit).toBe(0);
		expect(JSON.parse(events.stdout).findLast((e: any) => e.kind === "unknown").data.failureDiagnostic).toMatchObject({ source: "Fleet.start.prompt", code: "transport:transport_timeout" });
		expect(Buffer.from(await Bun.file(db).bytes()).equals(Buffer.from(before))).toBe(true);
	});
});
