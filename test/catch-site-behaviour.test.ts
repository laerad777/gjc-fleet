// Review 9fbbbd8d F-1 (fix lane e5723b8a): behavioural catch-site check. Replaces the source-text audit.
//
// Every diagnostic-recording (D) row of the catch-site table (docs/failure-diagnostics.md) is driven here
// through the public Fleet / resource-return API with a controlled transport, node, UI, SDK or store fault
// (or a controlled reply) so that exactly that site converts the failure, and the persisted converting
// events written by that run are compared with the row's expected event, diagnostic source/phase and
// error class. Nothing here reads source text.
//
// Completeness is checked by execution: test/diagnostic-guard.ts wraps the store's state-converting
// methods and its audit writer (incl. the Store.transaction refusal writer) for this whole file, and any
// conversion that arrives without a valid diagnostic fails the case that caused it and the final check.
// The sweep at the end additionally faults every seam call of every scenario under the guard, so a
// converting site that is missing from the table but reachable from these scenarios is found by running it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Json, NodeConfig, Observation } from "../src/contracts";
import { FleetError, digest, observationDigest } from "../src/core";
import { diagnosticPhases, diagnosticSources } from "../src/diagnostic";
import { Fleet, VERIFIER_OWNER_BOUND_MS } from "../src/fleet";
import { NodeReplyError, PREFLIGHT_PASSED } from "../src/node";
import * as rr from "../src/resource-return";
import { TransportError } from "../src/rpc";
import { FleetStore } from "../src/store";
import { sha256 } from "../src/workspace";
import { CONVERTING_EVENTS, type DiagnosticGuard, installDiagnosticGuard } from "./diagnostic-guard";

const SDK = fileURLToPath(new URL("./fixtures/scripted-sdk.ts", import.meta.url));
const INC = "b".repeat(64);
const SESSION = "S1";
const TURN = "T1";
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const TIMEOUT = 60_000;

// ---- controlled faults ----------------------------------------------------------------------------
type ErrorKind = "transport" | "store" | "clock" | "node_refused" | "return_node_blocked" | "result_schema" | "create_spawn_failed";
const makeError: Record<ErrorKind, () => unknown> = {
	clock: () => new Error("controlled clock fault"),
	transport: () => new TransportError("transport_exited", "unknown"),
	store: () => new Error("controlled store fault"),
	node_refused: () => new NodeReplyError({ ok: false, error: "root_denied", detail: "allowlist", certainty: "before_send" } as any),
	return_node_blocked: () => new FleetError("RETURN_NODE_BLOCKED", "controlled"),
	result_schema: () => new FleetError("RESULT_SCHEMA", "controlled"),
	/** The exact public refusal envelope the rpc layer throws for an `isError` start_session reply. */
	create_spawn_failed: () => new TransportError("tool_refused:spawn_failed", "unknown", "tool_refused:spawn_failed", { ok: false, error: { code: "spawn_failed", message: "spawn_failed" } }),
};
let armed = false;
let plan: { seam: string; n: number; error: () => unknown } | null = null;
let counts = new Map<string, number>();
let hit = false;
function enter(seam: string): (() => unknown) | undefined {
	if (!armed) return;
	const n = (counts.get(seam) ?? 0) + 1;
	counts.set(seam, n);
	if (plan && plan.seam === seam && plan.n === n) {
		const make = plan.error;
		plan = null;
		hit = true;
		return make;
	}
}
function seamSync<T>(seam: string, fn: () => T): T {
	const make = enter(seam);
	if (make) throw make();
	return fn();
}
async function seamAsync<T>(seam: string, fn: () => T | Promise<T>): Promise<T> {
	const make = enter(seam);
	if (make) throw make();
	return fn();
}

// ---- fixtures (public API only; the node, coordinator, UI and SDK are controlled stand-ins) ----------
let root = "";
let seq = 0;
let taskSeq = 0;
type Fx = ReturnType<typeof fixture>;
function fixture(o: { defer?: boolean } = {}) {
	const dir = join(root, String(++seq));
	mkdirSync(join(dir, "work"), { recursive: true });
	const planPath = join(dir, "sdk-plan.json");
	const logPath = join(dir, "sdk-log.jsonl");
	writeFileSync(logPath, "");
	const wsPath = join(dir, "work", "ws");
	const node: NodeConfig = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"),
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"],
		transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] },
		sdkTransport: { command: process.execPath, args: [SDK, planPath, logPath] },
	} as NodeConfig;
	const store: any = new FleetStore(join(dir, "fleet.sqlite"), 8, o.defer ? { deferTerminalRelease: true } : {});
	store.putNode(node);
	const f = {
		dir, store, wsPath, planPath, logPath, now: T0,
		ephemeral: false,
		turn: running() as any,
		questions: { ok: true, reconciliation: { complete: true }, questions: [] } as any,
		execution: undefined as unknown,
		preflight: undefined as unknown,
		prepare: undefined as ((task: any) => unknown) | undefined,
		createCwd: undefined as string | undefined,
		promptReply: undefined as unknown,
		dispatch: undefined as ((q: any) => unknown) | undefined,
		uiPending: false,
		question: undefined as any,
		sdkFaults: {} as Record<string, number>,
	};
	writePlan(f);
	return f;
}
function writePlan(f: Fx) {
	const replies: Record<string, unknown> = {
		"session.list": { type: "broker_response", ok: true, result: { indexSeq: 1, sessions: [{ sessionId: SESSION, locator: { cwd: f.wsPath }, endpointGeneration: 1, endpointIncarnation: INC, live: true, ambiguous: false, terminalUncertain: false, terminal: false }] } },
		"turn.abort": { ok: true, result: { ok: true, selection: "owned", turn: "stopped", ownedWork: "stopped", automaticDelivery: "none", resumeOnOwnedCompletion: false } },
		"session.close": { ok: true, operation: "session.close", result: { sessionId: SESSION } },
		...(f.execution !== undefined ? { "turn.result": f.execution } : {}),
	};
	writeFileSync(f.planPath, JSON.stringify({ replies, faults: f.sdkFaults }));
}
/** Faults the n-th call of an SDK op counted from now (earlier setup calls are not counted). */
function sdkFault(f: Fx, op: string, n: number) {
	const before = readFileSync(f.logPath, "utf8").split("\n").filter(Boolean).filter((line) => JSON.parse(line).op === op).length;
	f.sdkFaults = { [op]: before + n };
}
function running() {
	return { ok: true, turn: { session_id: SESSION, turn_id: TURN, status: "running", delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false } }, advisory_status: { authority: "sdk", live: true, is_streaming: true }, session_state: { session_id: SESSION, current_turn_id: TURN, state: "active" } };
}
function failedTurn() {
	return {
		ok: true,
		turn: { session_id: SESSION, turn_id: TURN, status: "failed", completed_at: "2026-11-12T09:41:07.512Z", error: { code: "unavailable", message: "Coordinator service is unavailable" }, delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false } },
		advisory_status: { authority: "sdk", is_streaming: false },
		session_state: { session_id: SESSION, current_turn_id: null, activity: { phase: "finished" }, active_tool_count: 0, state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false },
	};
}
const execFailedMissing = () => ({ kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512, outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "model stream stalled" } });
function identity(task: any, f: Fx) {
	return { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId, nodeId: task.nodeId, inputDigest: task.inputDigest, path: f.wsPath, repo: f.dir, baseCommit: task.input.baseCommit };
}
function manifest(task: any, f: Fx) {
	return { schemaVersion: 1, identity: task.workspace ?? identity(task, f), patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" };
}
const STORE_SEAMS = [
	"assertDispatchEnabled", "claimOperation", "getOperation", "setWorkspace", "recordSession", "recordSessionAuthority", "recordOperationReceipt", "recordTurn", "observe",
	"beginObservation", "cancellationOwnership", "admitCancellation", "retainCancellationReply", "claimCancellationClose", "finishCancellation", "saveResult",
	"claimResourceReturnNode", "renewResourceReturnNode", "claimResourceReturnClose", "confirmResourceReturn", "resourceReturnNodeBlock", "save", "retainedPreparationRefusal",
];
/** Instance-level store faults; the guard stays below them on the prototype. */
function wrapStore(f: Fx) {
	const s = f.store;
	for (const m of STORE_SEAMS) {
		const original = s[m];
		if (typeof original === "function") s[m] = (...a: any[]) => seamSync("store." + m, () => original.apply(s, a));
	}
}
function wireFleet(f: Fx, opts: { approval?: boolean } = {}) {
	const fleet: any = new Fleet(f.store, { localNodeId: "node", clock: () => seamSync("clock", () => f.now), ...(opts.approval ? { approvalBackends: [approvalBackend(f)] } : {}) } as any);
	fleet.node = (task: any, request: any) =>
		seamAsync("node." + request.action, () => {
			if (request.action === "prepare") return f.prepare ? f.prepare(task) : identity(task, f);
			if (request.action === "collect") return manifest(f.store.task(task.id), f);
			if (request.action === "preflight") return structuredClone(f.preflight ?? PREFLIGHT_PASSED);
			throw new Error("unexpected_node_action");
		});
	fleet.connect = () => seamAsync("connect", () => rpcStub(f));
	return fleet;
}
function rpcStub(f: Fx) {
	const handlers: Record<string, (a: any) => any> = {
		gjc_coordinator_start_session: () => ({ ok: true, session: { session_id: SESSION, cwd: f.createCwd ?? f.wsPath, ephemeral: f.ephemeral } }),
		gjc_coordinator_send_prompt: (a) => f.promptReply ?? { ok: true, session_id: a.session_id, turn_id: TURN, delivered: true },
		gjc_coordinator_read_turn: () => structuredClone(f.turn),
		gjc_coordinator_list_questions: () => structuredClone(f.questions),
		gjc_coordinator_submit_question_answer: (a) => ({ ok: true, session_id: a.session_id, turn_id: a.turn_id, question_id: a.question_id, answer_binding: a.answer_binding, accepted: true }),
	};
	return {
		call: (name: string, args: any) => seamAsync("rpc." + name, () => handlers[name]!(args)),
		close: () => seamSync("rpc.close", () => undefined),
	};
}
function approvalBackend(f: Fx) {
	return {
		contract: "sdk-ui-waiter-v1",
		attach: (context: any, key: string) =>
			seamAsync("ui.attach", () => {
				const authority = { kind: "sdk_ui_waiter", requestId: "r1", connectionId: "c1", leaseId: "l1", attachmentAuthorityId: "a1", endpointGeneration: context.sessionAuthority.endpointGeneration };
				const workflow = { stage: "ralplan", kind: "approval", questionId: "q1", toolCallId: "tc1", evidence: { seen: "tool_start" } };
				const form = { type: "select", options: ["Approve", "Reject"] };
				const question = { questionId: "q1", status: "pending", authority, form, workflow, answerBinding: digest({ context, authority, form, workflow, questionId: "q1" }) };
				f.question = question;
				return {
					context,
					receipt: { attached: true, contract: "sdk-ui-waiter-v1", key },
					bindTurn: () => seamSync("ui.bindTurn", () => undefined),
					discover: () => seamAsync("ui.discover", () => ({ contract: "sdk-ui-waiter-v1", sessionId: context.sessionId, complete: true, questions: f.uiPending ? [question] : [], consumed: [], evidence: { coverage: "controlled" } })),
					validateAnswer: () => seamSync("ui.validateAnswer", () => undefined),
					answer: (q: any) => seamAsync("ui.answer", () => f.dispatch?.(q) ?? { contract: "sdk-ui-waiter-v1", questionId: q.questionId, authority: q.authority, delivery: "sent_unconfirmed", consumption: "unproven" }),
					close: () => seamAsync("ui.close", () => undefined),
				};
			}),
	};
}
function taskInput(approval = false) {
	return { schemaVersion: 1, key: "k" + taskSeq++, caller: "catch-site-behaviour", repoId: "repo", baseCommit: "a".repeat(40), prompt: "controlled prompt", required: {}, ...(approval ? { approvalContract: "sdk-ui-waiter-v1" } : {}) };
}
/** Store-level settled task with custody and authority (resource-return fixtures); no converting call. */
function settledTask(f: Fx, sessionId = SESSION, collect = true) {
	const s = f.store;
	const task = s.reserve(s.submit(taskInput()).id);
	const id = identity(task, f);
	s.setWorkspace(task.id, id);
	const create = s.claimOperation(task.id, "create", { cwd: id.path })!;
	s.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: id.path });
	s.recordSessionAuthority(task.id, { sessionId, cwd: id.path, endpointGeneration: 1, endpointIncarnation: INC });
	s.recordTurn(task.id, TURN);
	const body: Omit<Observation, "digest" | "eventId"> = { sessionId, turnId: TURN, status: "completed_unverified", terminal: true, evidence: { native: "settled" } };
	s.observe(task.id, { eventId: "terminal-" + task.id, digest: observationDigest(body), ...body });
	if (collect) s.saveResult(task.id, manifest(s.task(task.id), f));
	return s.task(task.id)!;
}
/** Valid retained verifier evidence for `argv` in the task's workspace. */
function testEvidence(task: any, f: Fx, argv: string[]) {
	const at = new Date(T0).toISOString();
	return { cwd: (task.workspace ?? identity(task, f)).path, argv, exit: 0, stdout: "", stderr: "", stdoutDigest: sha256(""), stderrDigest: sha256(""), startedAt: at, endedAt: at };
}

/** Store-level settled attempt without custody, with authority. The evidence is the shape Fleet.inspect records: the
 * exact public turn and the exact runtime receipt, failed (exact failed receipt) by default, else terminal_ok. Both
 * are refused by eligibility before any read: custody first for every attempt. */
function uncollectedTask(f: Fx, status: "failed" | "completed_unverified" = "failed") {
	const s = f.store;
	const task = s.reserve(s.submit(taskInput()).id);
	const id = identity(task, f);
	s.setWorkspace(task.id, id);
	const create = s.claimOperation(task.id, "create", { cwd: id.path })!;
	s.recordSession(task.id, SESSION, true, { operationId: create.id, ephemeral: true, cwd: id.path });
	s.recordSessionAuthority(task.id, { sessionId: SESSION, cwd: id.path, endpointGeneration: 1, endpointIncarnation: INC });
	s.recordTurn(task.id, TURN);
	const delivery = { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false };
	const receipt: Record<string, Json> = status === "failed"
		? { status: "failed", receiptState: "present", terminalAt: 1_763_000_000_000, outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "controlled failure" } }
		: { status: "terminal_ok", receiptState: "present", terminalAt: 1_763_000_000_000, outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" } };
	const evidence = { publicTurn: { ok: true, turn: { session_id: SESSION, turn_id: TURN, status: status === "failed" ? "failed" : "completed", delivery } }, execution: { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", ...receipt } };
	const body = { sessionId: SESSION, turnId: TURN, status, terminal: true, evidence };
	s.observe(task.id, { eventId: "terminal-" + task.id, digest: observationDigest(body), ...body });
	return s.task(task.id)!;
}
type Session = { live: boolean; terminal: boolean; busy?: boolean; gone?: boolean; inc?: string };
type CloseMode = "ok" | "legacy" | "suspect" | "unknown" | "listed_stale" | "busy" | "hang";
/** Controlled resource-return port. Thrown answers carry the public refusal envelope; `answered` returns it. */
function port(f: Fx, mode: { close?: CloseMode; session?: Session; answered?: boolean; listing?: unknown } = {}) {
	const sess: Session = mode.session ?? { live: true, terminal: false };
	let n = 0;
	const env = (code: string, diagnostics?: string[]) => ({ schema: "gjc.command-error", version: 1, ok: false, error: { code, message: code, outcomeCertainty: "unknown" }, ...(diagnostics ? { diagnostics: diagnostics.map((d) => ({ code: d, message: d })) } : {}) });
	const answer = (c: CloseMode) => (c === "legacy" ? env("operation_failed", ["lifecycle_legacy_history_ambiguous"]) : c === "suspect" ? env("operation_failed") : c === "listed_stale" ? env("endpoint_stale") : c === "busy" ? env("busy") : env("weird_refusal"));
	const p = {
		list: (sessionId: string) => seamAsync("rr.list", () => mode.listing ?? { type: "broker_response", ok: true, result: { indexSeq: 10 + ++n, sessions: sess.gone ? [] : [{ sessionId, locator: { cwd: f.wsPath }, endpointGeneration: 1, endpointIncarnation: sess.inc ?? INC, live: sess.live, terminal: sess.terminal, ambiguous: false, terminalUncertain: false, activity: { state: sess.busy ? "busy" : "idle" } }] } }),
		fencedClose: (authority: any) =>
			seamAsync("rr.fencedClose", () => {
				const c = mode.close ?? "ok";
				if (c === "hang") throw new TransportError("execution_query_timeout", "unknown");
				if (c !== "ok") {
					if (mode.answered) return answer(c);
					throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", answer(c));
				}
				sess.live = false;
				sess.terminal = true;
				return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
			}),
		close: () => seamSync("rr.close", () => undefined),
	};
	return { connect: () => seamAsync("rr.connect", () => p) };
}
const returnPass = (f: Fx, ids: string[], mode: Parameters<typeof port>[1] = {}) => rr.returnResources(f.store, ids, { connect: port(f, mode).connect, paceMs: 0 });

// ---- scenarios ------------------------------------------------------------------------------------------
type Target = () => Promise<unknown>;
type Built = { f: Fx; ids: string[]; target: Target; repeat?: Target };
async function started(fleet: any, approval = false) {
	const t = await fleet.start(fleet.submit(taskInput(approval)).id);
	if (t.phase !== "active") throw new Error("setup start: " + t.phase + " " + t.reason);
	return t;
}
async function receiptlessSettled(f: Fx, fleet: any) {
	const t = await started(fleet);
	f.turn = failedTurn();
	f.execution = execFailedMissing();
	writePlan(f);
	f.now = T0;
	const first = await fleet.inspect(t.id);
	if (!first.task.held) throw new Error("setup: first receipt-less poll settled early");
	return t;
}
const scenarios: Record<string, () => Promise<Built>> = {
	"start/plain": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = fleet.submit(taskInput());
		return { f, ids: [t.id], target: () => fleet.start(t.id) };
	},
	"start/ephemeral": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f); const t = fleet.submit(taskInput());
		return { f, ids: [t.id], target: () => fleet.start(t.id) };
	},
	"start/approval": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f, { approval: true }); const t = fleet.submit(taskInput(true));
		return { f, ids: [t.id], target: () => fleet.start(t.id) };
	},
	/** A task whose prompt intent is already claimed (an earlier controller died after claiming). */
	"start/prompt_claimed": async () => {
		const f = fixture(); const fleet = wireFleet(f); const task = f.store.reserve(f.store.submit(taskInput()).id);
		f.store.setWorkspace(task.id, identity(task, f));
		f.store.recordSession(task.id, SESSION, true);
		f.store.beginOperation(task.id, "prompt", { session_id: SESSION, prompt: task.input.prompt, allow_mutation: true });
		return { f, ids: [task.id], target: () => fleet.start(task.id) };
	},
	/** The current attempt holds a retained before_send prepare refusal (set up by a real refused start). */
	"start/retained_refusal": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = fleet.submit(taskInput());
		f.prepare = () => { throw makeError.node_refused(); };
		await fleet.start(t.id).catch(() => undefined);
		f.prepare = undefined;
		if (!f.store.retainedPreparationRefusal(t.id)) throw new Error("setup: no retained refusal");
		return { f, ids: [t.id], target: () => fleet.start(t.id) };
	},
	"inspect/running": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await started(fleet);
		return { f, ids: [t.id], target: () => fleet.inspect(t.id) };
	},
	"inspect/tolerant": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await started(fleet);
		return { f, ids: [t.id], target: () => fleet.inspect(t.id, { tolerateReadFailure: true }).catch((e: unknown) => e) };
	},
	/** A strict inspect fails while a later tolerant inspect is the latest read; the tolerant read then fails too. */
	"inspect/strict_deferred_to_tolerant": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await started(fleet);
		const real = fleet.connect;
		return {
			f, ids: [t.id],
			target: async () => {
				let failStrict!: () => void;
				const strictGate = new Promise<void>((resolve) => { failStrict = resolve; });
				let strictDone!: () => void;
				const strictSettled = new Promise<void>((resolve) => { strictDone = resolve; });
				let call = 0;
				fleet.connect = async (...a: any[]) => {
					if (++call === 1) { await strictGate; throw new TransportError("transport_exited", "unknown"); }
					await strictSettled;
					const rpc = await real(...a);
					return { ...rpc, call: (name: string, args: any) => (name === "gjc_coordinator_read_turn" ? Promise.reject(new TransportError("transport_closed", "unknown")) : rpc.call(name, args)) };
				};
				try {
					const strict = fleet.inspect(t.id).catch((e: unknown) => e);
					const tolerant = fleet.inspect(t.id, { tolerateReadFailure: true }).catch((e: unknown) => e);
					failStrict();
					await strict;
					strictDone();
					return await tolerant;
				} finally {
					fleet.connect = real;
				}
			},
		};
	},
	"inspect/receiptless_settle": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await receiptlessSettled(f, fleet);
		f.now = T0 + 60_000;
		return { f, ids: [t.id], target: () => fleet.inspect(t.id) };
	},
	"inspect/approval_pending": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f, { approval: true }); const t = await started(fleet, true);
		f.uiPending = true;
		return { f, ids: [t.id], target: () => fleet.inspect(t.id) };
	},
	"answer/ordinary": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await started(fleet);
		f.questions = { ok: true, reconciliation: { complete: true }, questions: [{ question_id: "q1", answer_binding: "b1", session_id: SESSION, turn_id: TURN, answer_schema: { type: "object" } }] };
		const i = await fleet.inspect(t.id);
		if (i.task.phase !== "approval_required") throw new Error("setup answer: " + i.task.phase);
		return { f, ids: [t.id], target: () => fleet.answer(t.id, { questionId: "q1", answerBinding: "b1", answer: { choice: "Approve" } }).catch((e: unknown) => e) };
	},
	"answer/approval": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f, { approval: true }); const t = await started(fleet, true);
		f.uiPending = true;
		const i = await fleet.inspect(t.id);
		if (i.task.phase !== "approval_required") throw new Error("setup answer approval: " + i.task.phase);
		const q = f.question;
		return { f, ids: [t.id], target: () => fleet.answer(t.id, { contract: "sdk-ui-waiter-v1", sessionId: SESSION, expectedTurnId: TURN, questionId: q.questionId, answerBinding: q.answerBinding, answer: { decision: "Approve" } }).catch((e: unknown) => e) };
	},
	"cancel/active": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f); const t = await started(fleet);
		return { f, ids: [t.id], target: () => fleet.cancel(t.id), repeat: () => fleet.cancel(t.id) };
	},
	/** A cancel whose abort reply was lost (set up by a real cancel); the target is the repeated cancel. */
	"cancel/abort_lost": async () => {
		const f = fixture(); f.ephemeral = true; const fleet = wireFleet(f); const t = await started(fleet);
		sdkFault(f, "turn.abort", 1);
		writePlan(f);
		const first = await fleet.cancel(t.id);
		if (first.task.phase !== "cancel_unknown") throw new Error("setup cancel: " + first.task.phase);
		f.sdkFaults = {};
		return { f, ids: [t.id], target: () => fleet.cancel(t.id) };
	},
	"result/receiptless": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = await receiptlessSettled(f, fleet);
		f.now = T0 + 60_000;
		const settled = await fleet.inspect(t.id);
		if (settled.task.phase !== "failed") throw new Error("setup receipt-less settle: " + settled.task.phase);
		f.now = T0 + 25 * 3600_000; // after the late-receipt window
		return { f, ids: [t.id], target: () => fleet.result(t.id).catch((e: unknown) => e) };
	},
	/** A settled, uncollected task whose verify-test receipt retains another argv. */
	"result/conflict": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = settledTask(f, SESSION, false);
		f.store.claimOperation(t.id, "verify-test", { argv: ["retained"] });
		f.store.recordVerification(t.id, testEvidence(f.store.task(t.id), f, ["retained"]));
		return { f, ids: [t.id], target: () => fleet.result(t.id, ["requested"]).catch((e: unknown) => e) };
	},
	/** An unleased (older-tree) verify-test claim of a settled task, past the owner bound. */
	"result/owner_gone": async () => {
		const f = fixture(); const fleet = wireFleet(f); const t = settledTask(f, SESSION, false);
		f.store.claimOperation(t.id, "verify-test", { argv: ["lost"] });
		f.now = Date.now() + VERIFIER_OWNER_BOUND_MS + 60_000;
		return { f, ids: [t.id], target: () => fleet.result(t.id).catch((e: unknown) => e) };
	},
	"return/one": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		return { f, ids: [t.id], target: () => returnPass(f, [t.id]) };
	},
	/** An exact failed receipt without custody: refused by eligibility before any read. */
	"return/failed_turn": async () => {
		const f = fixture({ defer: true }); const t = uncollectedTask(f);
		return { f, ids: [t.id], target: () => returnPass(f, [t.id]) };
	},
	/** A completed (not failed) attempt without custody: refused by eligibility before any read. */
	"return/refused_custody": async () => {
		const f = fixture({ defer: true }); const t = uncollectedTask(f, "completed_unverified");
		return { f, ids: [t.id], target: () => returnPass(f, [t.id]) };
	},
	"return/invalid_listing": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		return { f, ids: [t.id], target: () => returnPass(f, [t.id], { listing: { type: "broker_response", ok: false } }) };
	},
	"return/hang_then_again": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		return { f, ids: [t.id], target: () => returnPass(f, [t.id], { close: "hang" }), repeat: () => returnPass(f, [t.id]) };
	},
	"return/exhausted": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		for (let n = 0; n < 5; n++) await returnPass(f, [t.id], { close: "busy" });
		if (!f.store.getOperation(t.id, "resource-return-close:5")) throw new Error("setup exhausted");
		return { f, ids: [t.id], target: () => returnPass(f, [t.id], { close: "busy" }) };
	},
	/** Another controller claims the same close between this pass's check and its claim. */
	"return/claim_race": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		const claim = f.store.claimResourceReturnClose.bind(f.store);
		f.store.claimResourceReturnClose = (...a: any[]) => { claim(...a); return claim(...a); };
		return { f, ids: [t.id], target: () => returnPass(f, [t.id]) };
	},
	"return/while_blocked": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f); const t2 = settledTask(f, "S2");
		await returnPass(f, [t.id], { close: "legacy" });
		if (!f.store.resourceReturnNodeBlock("node")) throw new Error("setup block");
		return { f, ids: [t2.id], target: () => returnPass(f, [t2.id]) };
	},
	"release/live": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		return { f, ids: [t.id], target: () => rr.operatorReleaseResource(f.store, t.id, { operator: "op", reason: "manual" }, { connect: port(f, { session: { live: true, terminal: false, busy: true } }).connect }) };
	},
	"unblock/not_blocked": async () => {
		const f = fixture({ defer: true }); const t = settledTask(f);
		return { f, ids: [t.id], target: async () => { try { f.store.clearResourceReturnNodeBlock("node", { operator: "op", reason: "checked" }); } catch (e) { return e; } } };
	},
};
/** Another controller claims the same effect intent between this start's checks and its claim. */
for (const kind of ["prepare", "create", "approval-attach", "prompt"] as const)
	scenarios[`start/claim_race/${kind}`] = async () => {
		const f = fixture(); f.ephemeral = true; const approval = kind === "approval-attach";
		const fleet = wireFleet(f, { approval }); const t = fleet.submit(taskInput(approval));
		const claim = f.store.claimOperation.bind(f.store);
		f.store.claimOperation = (id: string, k: string, payload: unknown) => { if (k === kind) claim(id, k, payload); return claim(id, k, payload); };
		return { f, ids: [t.id], target: () => fleet.start(t.id) };
	};
for (const answered of [false, true])
	for (const close of ["legacy", "suspect", "unknown", "listed_stale"] as const)
		scenarios[`return/pair/${answered ? "answered" : "thrown"}/${close}`] = async () => {
			const f = fixture({ defer: true }); const t = settledTask(f); const t2 = settledTask(f, "S2");
			return { f, ids: [t.id, t2.id], target: () => returnPass(f, [t.id, t2.id], { close, answered }) };
		};

// ---- running one case ----------------------------------------------------------------------------------
type Outcome = { events: string[]; violations: string[]; unclassified: string[]; hit: boolean; seams: Record<string, number> };
const convertingKinds = new Set<string>(CONVERTING_EVENTS);
function describeEvent(e: { kind: string; data: any }): string {
	const d = e.data?.failureDiagnostic;
	return d ? `${e.kind} ${d.source}/${d.phase} ${d.errorClass}` : `${e.kind} - ${e.data?.reason ?? e.data?.freshListing?.kind ?? ""}`;
}
/** Audit rows persisted after `after` (task-bound or not), read from the database file as written. */
function persisted(f: Fx, after: number): { sequence: number; kind: string; data: any }[] {
	const db = new Database(join(f.dir, "fleet.sqlite"), { readonly: true });
	try {
		return db.query<{ sequence: number; kind: string; data: string }, [number]>("SELECT sequence, kind, data FROM audit WHERE sequence > ? ORDER BY sequence").all(after).map((row) => ({ ...row, data: JSON.parse(row.data) }));
	} finally {
		db.close();
	}
}
let guard: DiagnosticGuard;
async function runCase(scenario: string, options: { fault?: string; error?: ErrorKind; before?: (f: Fx) => void; repeat?: boolean } = {}): Promise<Outcome> {
	armed = false; plan = null; counts = new Map(); hit = false;
	const built = await scenarios[scenario]!();
	const { f } = built;
	try {
		wrapStore(f);
		options.before?.(f);
		const [seam, nth] = options.fault ? options.fault.split("#") : [];
		if (seam?.startsWith("sdk.")) sdkFault(f, seam.slice(4), Number(nth));
		writePlan(f);
		const baseline = persisted(f, 0).at(-1)?.sequence ?? 0;
		const sdkBefore = readFileSync(f.logPath, "utf8").split("\n").filter(Boolean).length;
		guard.take();
		if (seam && !seam.startsWith("sdk.")) plan = { seam, n: Number(nth), error: makeError[options.error ?? (seam.startsWith("store.") ? "store" : "transport")] };
		armed = true;
		// Outcomes and exceptions are pinned by the existing behaviour tests; here only the persisted conversions count.
		await built.target().catch(() => undefined);
		if (options.repeat && built.repeat) await built.repeat().catch(() => undefined);
		armed = false;
		const sdkLog = readFileSync(f.logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { op: string; call: number });
		const sdkHit = seam?.startsWith("sdk.") ? sdkLog.some((entry) => entry.op === seam.slice(4) && entry.call === f.sdkFaults[seam.slice(4)]) : false;
		for (const entry of sdkLog.slice(sdkBefore)) counts.set("sdk." + entry.op, (counts.get("sdk." + entry.op) ?? 0) + 1);
		const converted = persisted(f, baseline).filter((e) => convertingKinds.has(e.kind));
		const events = converted.map(describeEvent);
		// Every injected error carries an allowlisted code, so an unclassified code of Fleet's own error classes
		// here is a code Fleet itself threw that is missing from the diagnostic code table.
		const unclassified = converted.filter((e) => ["FleetError", "TransportError"].includes(e.data?.failureDiagnostic?.errorClass) && e.data.failureDiagnostic.code === "unclassified").map(describeEvent);
		return { events, unclassified, violations: guard.take().violations, hit: hit || sdkHit, seams: Object.fromEntries(counts) };
	} finally {
		armed = false; plan = null;
		try { f.store.close(); } catch {}
		rmSync(f.dir, { recursive: true, force: true });
	}
}

// ---- the catch-site table, as behaviour --------------------------------------------------------------------
// Each row names the site (as in docs/failure-diagnostics.md) and drives it; `expect` lists every converting
// event the run persists, in order: "<event> <diagnostic source>/<phase> <error class>".
type Case = { name: string; scenario: string; fault?: string; error?: ErrorKind; before?: (f: Fx) => void; repeat?: boolean; expect: string[] };
type Row = { site: string; cases: Case[] };
const U = (sp: string, cls = "Error") => `unknown ${sp} ${cls}`;
const RU = (sp: string, cls = "Error") => `resource_return_unknown ${sp} ${cls}`;
const rows: Row[] = [
	{ site: "fleet.ts Fleet.start catch -> markUnknown (every step label)", cases: [
		{ name: "dispatch check before prepare", scenario: "start/plain", fault: "store.assertDispatchEnabled#1", expect: [U("Fleet.start.prepare/precondition")] },
		{ name: "prepare claim", scenario: "start/plain", fault: "store.claimOperation#1", expect: [U("Fleet.start.prepare/claim")] },
		{ name: "prepare call", scenario: "start/plain", fault: "node.prepare#1", expect: [U("Fleet.start.prepare/call", "TransportError")] },
		{ name: "prepare reply for another task", scenario: "start/plain", before: (f) => { f.prepare = (task) => ({ ...identity(task, f), taskId: "other" }); }, expect: [U("Fleet.start.prepare/validate", "FleetError")] },
		{ name: "prepare record", scenario: "start/plain", fault: "store.setWorkspace#1", expect: [U("Fleet.start.prepare/record")] },
		{ name: "dispatch check before connect", scenario: "start/plain", fault: "store.assertDispatchEnabled#3", expect: [U("Fleet.start.connect/precondition")] },
		{ name: "connect", scenario: "start/plain", fault: "connect#1", expect: [U("Fleet.start.connect/call", "TransportError")] },
		{ name: "create claim", scenario: "start/plain", fault: "store.claimOperation#2", expect: [U("Fleet.start.create/claim")] },
		{ name: "create call", scenario: "start/plain", fault: "rpc.gjc_coordinator_start_session#1", expect: [U("Fleet.start.create/call", "TransportError")] },
		{ name: "create refused, nothing created (spawn_failed) settles failed before effect", scenario: "start/plain", fault: "rpc.gjc_coordinator_start_session#1", error: "create_spawn_failed", expect: ["create_refused Fleet.start.create/call none"] },
		{ name: "create record", scenario: "start/plain", fault: "store.recordSession#1", expect: [U("Fleet.start.create/record")] },
		{ name: "create reply in another cwd", scenario: "start/plain", before: (f) => { f.createCwd = join(f.dir, "elsewhere"); }, expect: [U("Fleet.start.create/validate", "FleetError")] },
		{ name: "authority precondition (retained intents read)", scenario: "start/ephemeral", fault: "store.getOperation#6", expect: [U("Fleet.start.authority/precondition")] },
		{ name: "authority read", scenario: "start/ephemeral", fault: "sdk.session.list#1", expect: [U("Fleet.start.authority/call", "TransportError")] },
		{ name: "authority record", scenario: "start/ephemeral", fault: "store.recordSessionAuthority#1", expect: [U("Fleet.start.authority/record")] },
		{ name: "dispatch check before approval attach", scenario: "start/approval", fault: "store.assertDispatchEnabled#5", expect: [U("Fleet.start.approval_attach/precondition")] },
		{ name: "approval attach claim", scenario: "start/approval", fault: "store.claimOperation#3", expect: [U("Fleet.start.approval_attach/claim")] },
		{ name: "approval attach call", scenario: "start/approval", fault: "ui.attach#1", expect: [U("Fleet.start.approval_attach/call", "TransportError")] },
		{ name: "approval attach record", scenario: "start/approval", fault: "store.recordOperationReceipt#1", expect: [U("Fleet.start.approval_attach/record")] },
		{ name: "original approval channel check after the prompt", scenario: "start/approval", fault: "store.getOperation#33", expect: [U("Fleet.start.approval_attach/validate")] },
		{ name: "prompt claim", scenario: "start/plain", fault: "store.claimOperation#3", expect: [U("Fleet.start.prompt/claim")] },
		{ name: "prompt call", scenario: "start/plain", fault: "rpc.gjc_coordinator_send_prompt#1", expect: [U("Fleet.start.prompt/call", "TransportError")] },
		{ name: "prompt not accepted", scenario: "start/plain", before: (f) => { f.promptReply = { ok: false }; }, expect: [U("Fleet.start.prompt/validate", "FleetError")] },
		{ name: "prompt record", scenario: "start/plain", fault: "store.recordTurn#1", expect: [U("Fleet.start.prompt/record")] },
		{ name: "approval turn binding", scenario: "start/approval", fault: "ui.bindTurn#1", expect: [U("Fleet.start.prompt/record", "TransportError")] },
		{ name: "transport close", scenario: "start/plain", fault: "rpc.close#1", expect: [U("Fleet.start.close/call", "TransportError")] },
	] },
	{ site: "fleet.ts Fleet.start catch -> typed before_send node refusal (node_operation_failure)", cases: [
		{ name: "prepare refused by the node helper", scenario: "start/plain", fault: "node.prepare#1", error: "node_refused", expect: ["node_operation_failure Fleet.start.prepare/call TransportError"] },
	] },
	{ site: "fleet.ts preflight re-evaluation of a retained refusal (still_refused / unavailable)", cases: [
		{ name: "still refused", scenario: "start/retained_refusal", fault: "node.preflight#1", error: "node_refused", expect: ["node_operation_failure Fleet.start.preflight/call TransportError", "preparation_reevaluation Fleet.start.preflight/call TransportError"] },
		{ name: "preflight unavailable", scenario: "start/retained_refusal", fault: "node.preflight#1", expect: ["preparation_reevaluation Fleet.start.preflight/call TransportError"] },
	] },
	{ site: "fleet.ts condition: preflight reply is not a pass", cases: [
		{ name: "preflight reply invalid", scenario: "start/retained_refusal", before: (f) => { f.preflight = { preflight: "not_passed" }; }, expect: ["preparation_reevaluation Fleet.start.preflight/call none"] },
	] },
	{ site: "fleet.ts conditions: effect intent already claimed (prepare, create, approval-attach, prompt)", cases: [
		{ name: "prepare claimed by another controller", scenario: "start/claim_race/prepare", expect: [U("Fleet.start.prepare/claim", "none")] },
		{ name: "create claimed by another controller", scenario: "start/claim_race/create", expect: [U("Fleet.start.create/claim", "none")] },
		{ name: "approval attach claimed by another controller", scenario: "start/claim_race/approval-attach", expect: [U("Fleet.start.approval_attach/claim", "none")] },
		{ name: "prompt claimed by another controller", scenario: "start/claim_race/prompt", expect: [U("Fleet.start.prompt/claim", "none")] },
		{ name: "prompt intent retained from an earlier controller", scenario: "start/prompt_claimed", expect: [U("Fleet.start.prompt/claim", "none")] },
		{ name: "retained prompt intent whose diagnostic-only read fails (condition still recorded, claim not named)", scenario: "start/prompt_claimed", fault: "store.getOperation#5", expect: [U("Fleet.start.prompt/claim", "none")] },
	] },
	{ site: "fleet.ts Fleet.inspect catch, strict -> markObservationUnknown", cases: [
		{ name: "connect", scenario: "inspect/running", fault: "connect#1", expect: [U("Fleet.inspect.connect/call", "TransportError")] },
		{ name: "read_turn", scenario: "inspect/running", fault: "rpc.gjc_coordinator_read_turn#1", expect: [U("Fleet.inspect.read_turn/call", "TransportError")] },
		{ name: "read_turn reply for another turn", scenario: "inspect/running", before: (f) => { f.turn = { ...running(), turn: { ...running().turn, turn_id: "other" } }; }, expect: [U("Fleet.inspect.read_turn/validate", "FleetError")] },
		{ name: "list_questions", scenario: "inspect/running", fault: "rpc.gjc_coordinator_list_questions#1", expect: [U("Fleet.inspect.list_questions/call", "TransportError")] },
		{ name: "approval discovery", scenario: "inspect/approval_pending", fault: "ui.discover#1", expect: [U("Fleet.inspect.approval_discovery/call", "TransportError")] },
		{ name: "execution record read", scenario: "inspect/receiptless_settle", fault: "sdk.turn.result#1", expect: [U("Fleet.inspect.read_execution/call", "TransportError")] },
		{ name: "observation record", scenario: "inspect/running", fault: "store.observe#1", expect: [U("Fleet.inspect.observe/record")] },
		{ name: "receipt-less evaluation (clock)", scenario: "inspect/receiptless_settle", fault: "clock#2", error: "clock", expect: [U("Fleet.inspect.receiptless/validate")] },
		{ name: "receipt-less settlement record", scenario: "inspect/receiptless_settle", fault: "store.observe#1", expect: [U("Fleet.inspect.receiptless/record")] },
	] },
	{ site: "fleet.ts condition: strict inspect with incomplete question reconciliation", cases: [
		{ name: "questions incomplete", scenario: "inspect/running", before: (f) => { f.questions = { ok: true, reconciliation: { complete: false }, questions: [] }; }, expect: [U("Fleet.inspect.list_questions/validate", "none")] },
	] },
	{ site: "fleet.ts Fleet.inspect catch, tolerant -> abandonObservation (and the deferred strict failure it applies)", cases: [
		{ name: "connect", scenario: "inspect/tolerant", fault: "connect#1", expect: ["abandoned_poll Fleet.inspect.connect/call TransportError"] },
		{ name: "read_turn", scenario: "inspect/tolerant", fault: "rpc.gjc_coordinator_read_turn#1", expect: ["abandoned_poll Fleet.inspect.read_turn/call TransportError"] },
		{ name: "list_questions", scenario: "inspect/tolerant", fault: "rpc.gjc_coordinator_list_questions#1", expect: ["abandoned_poll Fleet.inspect.list_questions/call TransportError"] },
		{ name: "strict failure deferred to an abandoned tolerant read", scenario: "inspect/strict_deferred_to_tolerant", expect: ["stale_poll_failure Fleet.inspect.connect/call TransportError", "abandoned_poll Fleet.inspect.read_turn/call TransportError", "unknown Fleet.inspect.connect/call TransportError"] },
	] },
	{ site: "fleet.ts UI answer discovery -> markUnknown", cases: [
		{ name: "discovery", scenario: "answer/approval", fault: "ui.discover#1", expect: [U("Fleet.answer.discovery/call", "TransportError")] },
	] },
	{ site: "fleet.ts UI answer send -> markUnknown", cases: [
		{ name: "send", scenario: "answer/approval", fault: "ui.answer#1", expect: [U("Fleet.answer.submit/call", "TransportError")] },
		{ name: "send reply is not sent_unconfirmed", scenario: "answer/approval", before: (f) => { f.dispatch = (q) => ({ contract: "sdk-ui-waiter-v1", questionId: q.questionId, authority: q.authority, delivery: "consumed", consumption: "proven" }); }, expect: [U("Fleet.answer.submit/validate", "FleetError")] },
	] },
	{ site: "fleet.ts ordinary answer submit -> markUnknown", cases: [
		{ name: "submit", scenario: "answer/ordinary", fault: "rpc.gjc_coordinator_submit_question_answer#1", expect: [U("Fleet.answer.submit/call", "TransportError")] },
	] },
	{ site: "fleet.ts Fleet.cancel catch -> cancellationUnknown", cases: [
		{ name: "abort call", scenario: "cancel/active", fault: "sdk.turn.abort#1", expect: ["cancel_unknown Fleet.cancel.abort/call TransportError"] },
		{ name: "abort reply record", scenario: "cancel/active", fault: "store.retainCancellationReply#1", expect: ["cancel_unknown Fleet.cancel.abort/record Error"] },
		{ name: "close claim", scenario: "cancel/active", fault: "store.claimCancellationClose#1", expect: ["cancel_unknown Fleet.cancel.close/claim Error"] },
		{ name: "close call", scenario: "cancel/active", fault: "sdk.session.close#1", expect: ["cancel_unknown Fleet.cancel.close/call TransportError"] },
		{ name: "close reply record", scenario: "cancel/active", fault: "store.retainCancellationReply#2", expect: ["cancel_unknown Fleet.cancel.close/record Error"] },
	] },
	{ site: "fleet.ts condition: repeated cancel re-records cancel_unknown", cases: [
		{ name: "repeat after a lost abort reply", scenario: "cancel/active", fault: "sdk.turn.abort#1", repeat: true, expect: ["cancel_unknown Fleet.cancel.abort/call TransportError", "cancel_unknown Fleet.cancel.abort/claim none"] },
		{ name: "repeat whose diagnostic-only read of the cancel claim fails (condition still recorded, claim not named)", scenario: "cancel/abort_lost", fault: "store.getOperation#2", expect: ["cancel_unknown Fleet.cancel.abort/claim none"] },
		{ name: "repeat after a lost close reply", scenario: "cancel/active", fault: "sdk.session.close#1", repeat: true, expect: ["cancel_unknown Fleet.cancel.close/call TransportError", "cancel_unknown Fleet.cancel.abort/claim none"] },
	] },
	{ site: "fleet.ts Fleet.result catch -> result_validation_rejected / node_operation_failure", cases: [
		{ name: "collect refused by the node helper", scenario: "result/receiptless", fault: "node.collect#1", error: "node_refused", expect: ["node_operation_failure Fleet.result/validate TransportError"] },
		{ name: "verifier request conflicting with the retained receipt (final, recorded once)", scenario: "result/conflict", expect: ["verification_conflict Fleet.result/validate none", "result_validation_rejected Fleet.result/validate FleetError"] },
		{ name: "conflicting verifier request on an archived task (nothing recorded, the rejection is still audited)", scenario: "result/conflict", before: (f) => { f.store.db.query("UPDATE tasks SET data=json_set(data,'$.phase','archived')").run(); }, expect: ["result_validation_rejected Fleet.result/validate FleetError"] },
		{ name: "unreceipted verifier claim whose owner is gone", scenario: "result/owner_gone", expect: ["verification_owner_gone Fleet.result/validate none"] },
		{ name: "collect rejected by a Fleet check", scenario: "result/receiptless", fault: "node.collect#1", error: "result_schema", expect: ["result_validation_rejected Fleet.result/validate FleetError"] },
	] },
	{ site: "resource-return.ts operator release with a failing listing -> override", cases: [
		{ name: "connect", scenario: "release/live", fault: "rr.connect#1", expect: ["resource_return_operator_override ResourceReturn.connect/call TransportError"] },
		{ name: "listing", scenario: "release/live", fault: "rr.list#1", expect: ["resource_return_operator_override ResourceReturn.release_listing/call TransportError"] },
	] },
	{ site: "resource-return.ts per-id eligibility refusal -> resource_return_refused", cases: [
		{ name: "completed attempt without custody", scenario: "return/refused_custody", expect: ["resource_return_refused ResourceReturn.precondition/precondition FleetError"] },
		{ name: "store error during eligibility (ownership read)", scenario: "return/one", fault: "store.cancellationOwnership#1", expect: ["resource_return_refused ResourceReturn.precondition/precondition Error"] },
		{ name: "exact failed receipt without custody (custody first for every attempt)", scenario: "return/failed_turn", expect: ["resource_return_refused ResourceReturn.precondition/precondition FleetError"] },
	] },
	{ site: "resource-return.ts per-task pass catch -> resource_return_unknown", cases: [
		{ name: "precondition (cancellation ownership)", scenario: "return/one", fault: "store.cancellationOwnership#2", expect: [RU("ResourceReturn.precondition/precondition")] },
		{ name: "connect", scenario: "return/one", fault: "rr.connect#1", expect: [RU("ResourceReturn.connect/call", "TransportError")] },
		{ name: "listing", scenario: "return/one", fault: "rr.list#1", expect: [RU("ResourceReturn.list/call", "TransportError")] },
		{ name: "listing reply invalid", scenario: "return/invalid_listing", expect: [RU("ResourceReturn.list/validate", "FleetError")] },
		{ name: "lease renewal before a new close", scenario: "return/one", fault: "store.renewResourceReturnNode#1", expect: [RU("ResourceReturn.close/precondition")] },
		{ name: "close claim (other store error)", scenario: "return/one", fault: "store.claimResourceReturnClose#1", expect: [RU("ResourceReturn.close/claim")] },
		{ name: "close receipt record", scenario: "return/one", fault: "store.recordOperationReceipt#1", expect: [RU("ResourceReturn.close/record")] },
		{ name: "post-close listing", scenario: "return/one", fault: "rr.list#2", expect: [RU("ResourceReturn.list/call", "TransportError")] },
		{ name: "return confirmation record", scenario: "return/one", fault: "store.confirmResourceReturn#1", expect: [RU("ResourceReturn.record/record")] },
	] },
	{ site: "resource-return.ts close claim refused by a block written meanwhile (RETURN_NODE_BLOCKED)", cases: [
		{ name: "claim refused", scenario: "return/one", fault: "store.claimResourceReturnClose#1", error: "return_node_blocked", expect: [RU("ResourceReturn.close/claim", "FleetError")] },
	] },
	{ site: "resource-return.ts fenced close catch (thrown; L-2 thrown public answers)", cases: [
		{ name: "no public answer", scenario: "return/one", fault: "rr.fencedClose#1", expect: [RU("ResourceReturn.close/call", "TransportError")] },
		{ name: "thrown legacy answer blocks the node, rest of pass stopped", scenario: "return/pair/thrown/legacy", expect: ["resource_return_blocked_by_node ResourceReturn.close/call TransportError", RU("ResourceReturn.close/call", "TransportError")] },
		{ name: "thrown suspect-legacy answer", scenario: "return/pair/thrown/suspect", expect: ["resource_return_blocked_by_node ResourceReturn.close/call TransportError", RU("ResourceReturn.close/call", "TransportError")] },
		{ name: "thrown unclassified answer", scenario: "return/pair/thrown/unknown", expect: [RU("ResourceReturn.close/call", "TransportError"), RU("ResourceReturn.close/call", "TransportError")] },
		{ name: "thrown endpoint_stale, exact incarnation still listed", scenario: "return/pair/thrown/listed_stale", expect: [RU("ResourceReturn.close/call", "TransportError"), RU("ResourceReturn.close/call", "TransportError")] },
	] },
	{ site: "resource-return.ts conditions: returned (not thrown) close answers (L-2)", cases: [
		{ name: "returned legacy answer", scenario: "return/pair/answered/legacy", expect: ["resource_return_blocked_by_node ResourceReturn.close/validate none", RU("ResourceReturn.close/validate", "none")] },
		{ name: "returned suspect-legacy answer", scenario: "return/pair/answered/suspect", expect: ["resource_return_blocked_by_node ResourceReturn.close/validate none", RU("ResourceReturn.close/validate", "none")] },
		{ name: "returned unclassified answer", scenario: "return/pair/answered/unknown", expect: [RU("ResourceReturn.close/validate", "none"), RU("ResourceReturn.close/validate", "none")] },
		{ name: "returned endpoint_stale, exact incarnation still listed", scenario: "return/pair/answered/listed_stale", expect: [RU("ResourceReturn.close/validate", "none"), RU("ResourceReturn.close/validate", "none")] },
	] },
	{ site: "resource-return.ts conditions: Fleet's own no-replay refusals before a close", cases: [
		{ name: "prior close unanswered", scenario: "return/hang_then_again", repeat: true, expect: [RU("ResourceReturn.close/call", "TransportError"), RU("ResourceReturn.close/precondition", "none")] },
		{ name: "node already blocked", scenario: "return/while_blocked", expect: [RU("ResourceReturn.close/precondition", "none")] },
		{ name: "close attempts exhausted", scenario: "return/exhausted", expect: [RU("ResourceReturn.close/precondition", "none")] },
		{ name: "close claimed by another controller meanwhile", scenario: "return/claim_race", expect: [RU("ResourceReturn.close/claim", "none")] },
	] },
	{ site: "store.ts Store.transaction refusal writer", cases: [
		{ name: "unblock of a node that is not blocked", scenario: "unblock/not_blocked", expect: ["refused Store.transaction/record FleetError"] },
		{ name: "store error inside a transaction (dispatch check inside the prepare claim)", scenario: "start/plain", fault: "store.assertDispatchEnabled#2", expect: ["refused Store.transaction/record Error", U("Fleet.start.prepare/claim")] },
	] },
];

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-catch-sites-")));
	guard = installDiagnosticGuard(FleetStore);
});
afterAll(() => {
	guard.uninstall();
	rmSync(root, { recursive: true, force: true });
});

describe("catch-site table: every diagnostic-recording site, driven", () => {
	for (const row of rows)
		for (const c of row.cases)
			test(`${row.site}: ${c.name}`, async () => {
				const out = await runCase(c.scenario, c);
				if (c.fault) expect([c.fault, out.hit]).toEqual([c.fault, true]);
				expect(out.events).toEqual(c.expect);
				expect(out.violations).toEqual([]);
				expect(out.unclassified).toEqual([]);
			}, TIMEOUT);
});

// Discovery by execution: every seam call a scenario makes (store, node, connect, rpc, UI, clock, SDK op,
// resource-return port) is faulted in turn. A conversion without a diagnostic is a guard violation; a
// diagnostic at a (event, source/phase) that no table row lists is an unlisted catch site.
const listed = (line: string) => line.split(" ").slice(0, 2).join(" ");
const tablePairs = new Set(rows.flatMap((row) => row.cases.flatMap((c) => c.expect.map(listed))));
const sweptPairs = new Set<string>();
function faultKinds(seam: string): (ErrorKind | undefined)[] {
	if (seam.startsWith("sdk.")) return [undefined];
	if (seam === "clock") return ["clock"];
	if (seam === "store.claimResourceReturnClose") return ["store", "return_node_blocked"];
	if (seam.startsWith("store.")) return ["store"];
	if (seam.startsWith("node.")) return ["transport", "node_refused", "result_schema"];
	return ["transport"];
}
describe("sweep: every seam call of every scenario faulted under the completeness guard", () => {
	for (const scenario of Object.keys(scenarios))
		test(scenario, async () => {
			const probe = await runCase(scenario, { repeat: true });
			const violations = probe.violations.map((v) => "probe: " + v);
			const unlisted: string[] = [];
			const unclassified = [...probe.unclassified];
			let runs = 0;
			for (const [seam, total] of Object.entries(probe.seams))
				for (let n = 1; n <= total; n++)
					for (const error of faultKinds(seam)) {
						const out = await runCase(scenario, { fault: `${seam}#${n}`, error, repeat: true });
						runs++;
						violations.push(...out.violations.map((v) => `${seam}#${n} ${error ?? ""}: ${v}`));
						unclassified.push(...out.unclassified.map((v) => `${seam}#${n} ${error ?? ""}: ${v}`));
						for (const event of out.events) {
							if (event.split(" ")[1] === "-") continue; // no diagnostic: allowed only where the guard allows it
							sweptPairs.add(listed(event));
							if (!tablePairs.has(listed(event))) unlisted.push(`${seam}#${n} ${error ?? ""}: ${event}`);
						}
					}
			expect(runs).toBeGreaterThan(0);
			expect(violations).toEqual([]);
			expect(unlisted).toEqual([]);
			expect(unclassified).toEqual([]);
		}, 300_000);
});

test("completeness guard: no conversion without a valid diagnostic during this whole file", () => {
	expect(guard.allViolations).toEqual([]);
	expect(guard.checked.events).toBeGreaterThan(500);
	expect(guard.checked.calls).toBeGreaterThan(500);
	// Every (event, source/phase) the sweep produced is a table row, and the sources/phases are allowlisted.
	for (const pair of sweptPairs) {
		const [source, phase] = pair.split(" ")[1]!.split("/");
		expect([pair, (diagnosticSources as readonly string[]).includes(source!), (diagnosticPhases as readonly string[]).includes(phase!)]).toEqual([pair, true, true]);
	}
});
