import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { digest, executionOutcome, observationDigest } from "../src/core";
import { getDashboardState } from "../src/dashboard";
import { EXECUTION_FAILURE_REPORTED, LATE_RECEIPT_WINDOW_MS } from "../src/execution";
import { Fleet, VERIFIER_OWNER_BOUND_MS } from "../src/fleet";
import { compactTask } from "../src/operator-commands";
import { CREATE_REFUSAL_CLASSES, classifyCreateRefusal, TransportError } from "../src/rpc";
import { FleetStore, VERIFICATION_CONFLICT_REASON, VERIFICATION_OUTCOME_UNKNOWN_REASON, VERIFICATION_RECORDED_REQUESTS } from "../src/store";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { reconsiderQueue } from "../src/index";

// CONTROLLED stdio Coordinator + CONTROLLED public SDK query stand-in (not GJC). Settlement/bookkeeping
// consistency (audit sweep-store #2 #4 #5 #6). Behaviour only: no source text is read.
const coordinatorPath = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const executionPath = fileURLToPath(new URL("./fixtures/execution-query.ts", import.meta.url));
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INTERVAL = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Shape = { turn: Record<string, any>; execution: Record<string, any> };
function publicTurn(status: "failed" | "completed", session: Record<string, any>) {
	return {
		ok: true,
		turn: {
			session_id: SESSION, turn_id: TURN,
			prompt: { text: "CONTROLLED prompt", source: "mcp", created_at: "2026-11-12T09:00:00.000Z" },
			status, completed_at: "2026-11-12T09:41:07.512Z",
			...(status === "failed"
				? { error: { code: "unavailable", message: "Coordinator service is unavailable" } }
				: { final_response: { source: "agent_end" } }),
			delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false },
		},
		advisory_status: { authority: "sdk", is_streaming: false },
		session_state: { session_id: SESSION, current_turn_id: null, activity: { phase: "finished" }, active_tool_count: 0, ...session },
	};
}
const erroredSession = { state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false };
/** Production #2 shapes: a recorded execution error with no durable receipt. */
const agentErrorMissing: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: {
		status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512,
		outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "Provider failure after execution started." },
		error: { code: "agent_error", message: "Provider failure after execution started." },
	},
};
const deadlineInFlight: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: { status: "in_flight", receiptState: "absent", error: { code: "prompt_deadline_exceeded", message: "Prompt deadline exceeded." } },
};
const turnFailedOnly: Shape = { turn: publicTurn("failed", erroredSession), execution: { status: "in_flight", receiptState: "absent" } };
/** A durable failed receipt of the exact command (what settledExecution accepts). */
const failedReceipt: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: { status: "failed", receiptState: "present", terminalAt: 1_763_000_999_500, outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline", message: "Prompt deadline exceeded." } },
};
const input = (repo: { baseCommit: string }, key = "settlement"): TaskInput => ({
	schemaVersion: 1, key, caller: "controlled-operator", repoId: "repo",
	baseCommit: repo.baseCommit, prompt: "CONTROLLED prompt", required: {},
});

async function controlled(prefix: string, state: Partial<ControlledState> = {}) {
	const repo = await repositoryFixture(prefix);
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const statePath = join(repo.dir, "coordinator.json");
	const executionState = join(repo.dir, "execution.json");
	const executionLog = join(repo.dir, "execution.log");
	await writeFile(statePath, JSON.stringify({ calls: [], ...state } satisfies ControlledState));
	await writeFile(executionLog, "");
	const node: NodeConfig = {
		id: "alpha", os: process.platform, arch: process.arch, roots: { repo: repo.repo },
		workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true,
		sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [coordinatorPath, statePath] },
		sdkTransport: { command: process.execPath, args: [executionPath, executionState, executionLog] },
	};
	const dbPath = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(dbPath);
	cleanups.push(() => store.close());
	store.putNode(node);
	let now = T0;
	const fleet = new Fleet(store, { localNodeId: node.id, clock: () => now } as any);
	const coordinator = async (): Promise<ControlledState> => JSON.parse(await readFile(statePath, "utf8"));
	return { repo, store, fleet, statePath, executionState, dbPath, coordinator, setNow(ms: number) { now = T0 + ms; } };
}

async function scenario(shape: Shape, options: { legacyRow?: boolean } = {}) {
	const c = await controlled("fleet-settlement-");
	const started = await c.fleet.start(c.fleet.submit(input(c.repo)).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	async function set(next: Shape) {
		await writeFile(c.statePath, JSON.stringify({ ...(await c.coordinator()), readTurn: next.turn }));
		await writeFile(c.executionState, JSON.stringify(next.execution));
	}
	await set(shape);
	if (options.legacyRow) {
		// The row an older tree (bc98149 shape) wrote for this evidence: completed_unverified, held,
		// executionTerminal false, empty reason.
		const sequence = c.store.beginObservation(started.id)!;
		const body = {
			sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false,
			evidence: {
				publicTurn: shape.turn,
				questions: { ok: true, reconciliation: { complete: true }, questions: [] },
				execution: { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", ...shape.execution },
			},
		};
		c.store.observe(started.id, { ...body, eventId: started.attemptId + ":poll:" + sequence, digest: observationDigest(body) }, sequence);
	}
	const events = (kind: string) => c.store.events(started.id).filter((e) => e.kind === kind);
	return {
		...c, id: started.id, set, events,
		async inspect(ms: number) { c.setNow(ms); return (await c.fleet.inspect(started.id)).task; },
	};
}

describe("#2 recorded execution errors settle by what they prove", () => {
	test("a durable failed receipt of the exact command settles failed at once and releases", async () => {
		const f = await scenario(failedReceipt);
		const t = await f.inspect(0);
		expect(t).toMatchObject({ phase: "failed", held: false, result: { status: "failed", executionTerminal: true, verified: false } });
		expect(t.reason).toBeUndefined();
		expect(f.events("released")).toHaveLength(1);
		expect([...f.store.heldCharges().values()].flat()).toHaveLength(0);
		const summary = getDashboardState(f.store).summary;
		expect(summary).toMatchObject({ activeTasks: 0, failedTasks: 1, heldTasks: 0, provisionalTasks: 0, failureReportedTasks: 0 });
		// Final: a later different observation never reopens it.
		await f.set(agentErrorMissing);
		expect((await f.inspect(INTERVAL)).phase).toBe("failed");
		expect(f.events("released")).toHaveLength(1);
	});

	for (const [name, shape] of [["agent_error, receipt missing", agentErrorMissing], ["prompt_deadline_exceeded, receipt absent", deadlineInFlight], ["public turn failed only", turnFailedOnly]] as const)
		test(`${name}: held, provisional, with a visible reason; never failed, never unverified output`, async () => {
			const f = await scenario(shape);
			const t = await f.inspect(0);
			expect(t).toMatchObject({ phase: "completed_unverified", held: true, reason: EXECUTION_FAILURE_REPORTED, result: { executionTerminal: false } });
			const dash = getDashboardState(f.store);
			expect(dash.summary).toMatchObject({ activeTasks: 0, unsettledTasks: 1, heldTasks: 1, provisionalTasks: 0, failureReportedTasks: 1, failedTasks: 0 });
			expect(dash.pipeline.outcome).toMatchObject({ unverified: 0, succeeded: 0 });
			expect(dash.tasks.find((row) => row.id === f.id)).toMatchObject({ phase: "completed_unverified", reason: EXECUTION_FAILURE_REPORTED, outcome: "unsettled" });
			expect(f.events("released")).toHaveLength(0);
		});

	test("agent_error with a missing receipt settles failed after confirmation and keeps the 24 h late-receipt check", async () => {
		const f = await scenario(agentErrorMissing);
		expect((await f.inspect(0)).reason).toBe(EXECUTION_FAILURE_REPORTED);
		const settled = await f.inspect(INTERVAL);
		expect(settled).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true, verified: false } });
		expect(settled.reason).not.toBe(EXECUTION_FAILURE_REPORTED);
		expect(settled.result!.settlement).toMatchObject({
			kind: "failed_without_receipt",
			lateObservationUntil: new Date(T0 + INTERVAL + LATE_RECEIPT_WINDOW_MS).toISOString(),
		});
		expect(f.events("released")).toHaveLength(1);
		expect(getDashboardState(f.store).summary).toMatchObject({ activeTasks: 0, failedTasks: 1, failureReportedTasks: 0 });
	});

	test("a row written by the older tree (completed_unverified, held, not terminal) is re-read, never silently re-classified", async () => {
		const f = await scenario(agentErrorMissing, { legacyRow: true });
		// Production rows of that tree carry an empty reason string.
		const raw = new Database(f.dbPath);
		try {
			raw.query("UPDATE tasks SET data=json_set(data,'$.reason','') WHERE id=?").run(f.id);
		} finally {
			raw.close();
		}
		const before = f.store.task(f.id)!;
		expect(before).toMatchObject({ phase: "completed_unverified", held: true, reason: "", result: { executionTerminal: false } });
		// Reading it changes nothing; it is counted as a plain provisional row until it is observed again.
		expect(getDashboardState(f.store).summary).toMatchObject({ activeTasks: 0, unsettledTasks: 1, provisionalTasks: 1, failureReportedTasks: 0 });
		expect(f.store.task(f.id)).toEqual(before);
		// The next real observation re-decides it from evidence; settlement still needs its confirmation.
		expect(await f.inspect(0)).toMatchObject({ phase: "completed_unverified", held: true, reason: EXECUTION_FAILURE_REPORTED });
		expect((await f.inspect(INTERVAL)).phase).toBe("failed");
		expect(f.events("released")).toHaveLength(1);
	});

	test("the reported-failure reason is cleared once an observation no longer reports a failure", async () => {
		const f = await scenario(turnFailedOnly);
		expect((await f.inspect(0)).reason).toBe(EXECUTION_FAILURE_REPORTED);
		await f.set({ turn: { ...publicTurn("completed", { state: "running" }), turn: { ...publicTurn("completed", {}).turn, status: "running" } }, execution: { status: "in_flight", receiptState: "absent" } });
		const t = await f.inspect(INTERVAL);
		expect(t.phase).toBe("active");
		expect(t.reason).toBeUndefined();
	});

	test("held reason is accepted only on a non-terminal active observation and never overwrites another reason", async () => {
		const f = await scenario(turnFailedOnly);
		const active = { sessionId: SESSION, turnId: TURN, status: "active" as const, terminal: false, evidence: { controlled: 1 } };
		expect(() => f.store.observe(f.id, { ...active, eventId: "x1", digest: observationDigest(active) }, undefined, true, EXECUTION_FAILURE_REPORTED)).toThrow();
		const terminal = { sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: true, evidence: { controlled: 2 } };
		expect(() => f.store.observe(f.id, { ...terminal, eventId: "x2", digest: observationDigest(terminal) }, undefined, true, EXECUTION_FAILURE_REPORTED)).toThrow();
		const provisional = { sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false, evidence: { controlled: 3 } };
		f.store.observe(f.id, { ...provisional, eventId: "x3", digest: observationDigest(provisional) }, undefined, true, EXECUTION_FAILURE_REPORTED);
		expect(f.store.task(f.id)!.reason).toBe(EXECUTION_FAILURE_REPORTED);
	});

	test("a reported-failure observation keeps a reason the task already has", async () => {
		const f = await scenario(turnFailedOnly);
		const raw = new Database(f.dbPath);
		try {
			raw.query("UPDATE tasks SET data=json_set(data,'$.reason','controlled_other_reason') WHERE id=?").run(f.id);
		} finally {
			raw.close();
		}
		const provisional = { sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false, evidence: { controlled: 4 } };
		const t = f.store.observe(f.id, { ...provisional, eventId: "x4", digest: observationDigest(provisional) }, undefined, true, EXECUTION_FAILURE_REPORTED);
		expect(t).toMatchObject({ phase: "completed_unverified", held: true, reason: "controlled_other_reason" });
		expect(f.store.task(f.id)!.reason).toBe("controlled_other_reason");
	});

	test("an unchanged daemon poll (recordUnchanged: false) still applies a held reason the task does not show", async () => {
		const f = await scenario(turnFailedOnly);
		const provisional = { sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false, evidence: { controlled: 5 } };
		const poll = (recordUnchanged: boolean) => {
			const sequence = f.store.beginObservation(f.id)!;
			return f.store.observe(f.id, { ...provisional, eventId: "unchanged:" + sequence, digest: observationDigest(provisional) }, sequence, recordUnchanged, EXECUTION_FAILURE_REPORTED);
		};
		expect(poll(true).reason).toBe(EXECUTION_FAILURE_REPORTED);
		// Precondition: the same observation again is an unchanged daemon poll (no new observation row).
		const observations = () => f.events("observation").length;
		const before = observations();
		expect(poll(false).reason).toBe(EXECUTION_FAILURE_REPORTED);
		expect(observations()).toBe(before);
		// The same applied observation without the reason (a row the older tree wrote: empty reason).
		const raw = new Database(f.dbPath);
		try {
			raw.query("UPDATE tasks SET data=json_set(data,'$.reason','') WHERE id=?").run(f.id);
		} finally {
			raw.close();
		}
		expect(poll(false)).toMatchObject({ phase: "completed_unverified", held: true, reason: EXECUTION_FAILURE_REPORTED });
		expect(f.store.task(f.id)!.reason).toBe(EXECUTION_FAILURE_REPORTED);
	});
});

describe("#4 create refusals are classified by what they prove", () => {
	const refusal = (code: string, extra: Record<string, any> = {}) => ({ ok: false, error: { code, message: code, outcomeCertainty: "unknown", ...extra } });
	test("every listed refusal code has a class; unlisted, bare, inexact or session-bearing refusals stay unknown", () => {
		expect(CREATE_REFUSAL_CLASSES).toEqual({ spawn_failed: "failed_before_effect", broker_compensation_unobserved: "unknown" });
		const e = (code: string, reply?: unknown) => new TransportError(code, "unknown", code, reply);
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed", refusal("spawn_failed")))).toEqual({ class: "failed_before_effect", reason: "spawn_failed" });
		expect(classifyCreateRefusal(e("tool_refused:broker_compensation_unobserved", refusal("broker_compensation_unobserved"))).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:never_heard_of", refusal("never_heard_of"))).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused", refusal("spawn_failed"))).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed")).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed", { ok: true, error: { code: "spawn_failed" } })).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed", { ...refusal("spawn_failed"), session_id: "s" })).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed", refusal("spawn_failed", { sessionId: "s" }))).class).toBe("unknown");
		expect(classifyCreateRefusal(e("tool_refused:spawn_failed", { reason: "spawn_failed" })).class).toBe("unknown");
		expect(classifyCreateRefusal(e("transport_timeout")).class).toBe("unknown");
		expect(classifyCreateRefusal(new Error("tool_refused:spawn_failed")).class).toBe("unknown");
		// An inherited name is not a listed code.
		expect(classifyCreateRefusal(e("tool_refused:constructor", refusal("constructor"))).class).toBe("unknown");
	});

	test("spawn_failed settles failed-before-effect, releases once, keeps the receipt, records a diagnostic, never re-sends", async () => {
		const c = await controlled("fleet-create-refused-", { refuseStart: refusal("spawn_failed") });
		const t = await c.fleet.start(c.fleet.submit(input(c.repo)).id);
		expect(t).toMatchObject({ phase: "failed", held: false, reason: "tool_refused:spawn_failed", result: { status: "failed", executionTerminal: true, verified: false } });
		expect(t.sessionId).toBeUndefined();
		const events = c.store.events(t.id);
		const refused = events.filter((e) => e.kind === "create_refused");
		expect(refused).toHaveLength(1);
		expect(refused[0]!.data).toMatchObject({ code: "tool_refused:spawn_failed", class: "failed_before_effect", failureDiagnostic: { code: "condition:create_refused_before_effect" } });
		expect(events.filter((e) => e.kind === "released")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "unknown")).toHaveLength(0);
		expect(c.store.getOperation(t.id, "create")?.receipt).toEqual({ createRefusal: { code: "tool_refused:spawn_failed", class: "failed_before_effect" } });
		expect([...c.store.heldCharges().values()].flat()).toHaveLength(0);
		const startCalls = async () => (await c.coordinator()).calls.filter((call) => call.name.endsWith("start_session")).length;
		expect(await startCalls()).toBe(1);
		// Starting the settled task again sends nothing and changes nothing.
		const again = await c.fleet.start(t.id).catch((error: unknown) => error);
		expect(await startCalls()).toBe(1);
		expect(c.store.task(t.id)).toMatchObject({ phase: "failed", held: false, reason: "tool_refused:spawn_failed" });
		expect(again instanceof Error || (again as TaskRecord).phase === "failed").toBe(true);
		expect(getDashboardState(c.store).summary).toMatchObject({ activeTasks: 0, failedTasks: 1, heldTasks: 0 });
		await expect(c.fleet.result(t.id)).rejects.toMatchObject({ code: "RESULT_NOT_READY" });
	});

	test("a queue pass stops at the first definite create refusal: the other candidates stay queued, nothing else is sent", async () => {
		const c = await controlled("fleet-create-refused-queue-", { refuseStart: refusal("spawn_failed") });
		const ids = ["q1", "q2", "q3"].map((key) => c.fleet.submit(input(c.repo, key), { samples: new Map() }).id);
		expect(ids.map((id) => c.store.task(id)!.phase)).toEqual(["queued", "queued", "queued"]);
		const samples = headroom(["alpha"], 10).samples;
		samples.get("alpha")!.disks![0]!.path = c.repo.workspaceRoot;
		const out = await reconsiderQueue(c.fleet, async () => samples, { localNodeId: "alpha", limit: 10 });
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ id: ids[0], phase: "failed", held: false, reason: "tool_refused:spawn_failed" });
		expect(ids.map((id) => c.store.task(id)!.phase)).toEqual(["failed", "queued", "queued"]);
		for (const id of ids.slice(1)) {
			expect(c.store.task(id)!.attemptId).toBeUndefined();
			expect(c.store.getOperation(id, "create")).toBeUndefined();
		}
		expect((await c.coordinator()).calls.filter((call) => call.name.endsWith("start_session"))).toHaveLength(1);
		expect([...c.store.heldCharges().values()].flat()).toHaveLength(0);
	});

	for (const code of ["broker_compensation_unobserved", "never_heard_of"])
		test(`${code} stays unknown and held (never settled, never re-sent)`, async () => {
			const c = await controlled("fleet-create-unknown-", { refuseStart: refusal(code) });
			const t = await c.fleet.start(c.fleet.submit(input(c.repo)).id);
			expect(t).toMatchObject({ phase: "blocked_unknown", held: true, reason: "tool_refused:" + code });
			expect(c.store.events(t.id).filter((e) => e.kind === "create_refused")).toHaveLength(0);
			expect(c.store.events(t.id).filter((e) => e.kind === "released")).toHaveLength(0);
			expect(c.store.getOperation(t.id, "create")?.receipt).toBeUndefined();
		});

	/** Starts the task with a create call that hangs, waits for its create claim, runs `meanwhile`, then awaits it. */
	async function hangingRefusedStart(prefix: string, meanwhile: (c: Awaited<ReturnType<typeof controlled>>, id: string) => Promise<unknown>) {
		const c = await controlled(prefix, { refuseStart: refusal("spawn_failed"), hang: "start", hangMs: 1500 });
		const id = c.fleet.submit(input(c.repo)).id;
		const first = c.fleet.start(id);
		const deadline = Date.now() + 10_000;
		while (!c.store.getOperation(id, "create") && Date.now() < deadline) await Bun.sleep(10);
		expect(c.store.getOperation(id, "create")).toBeDefined();
		const during = await meanwhile(c, id);
		return { c, id, during, settled: await first };
	}

	test("a definite refusal that resolves an overlapping start's blocked_unknown records unknown_reconciled in the same transaction", async () => {
		const { c, id, during, settled } = await hangingRefusedStart("fleet-create-refused-overlap-", (c, id) => c.fleet.start(id).catch((error: unknown) => error));
		expect(during).toMatchObject({ phase: "blocked_unknown", held: true });
		expect(settled).toMatchObject({ phase: "failed", held: false, reason: "tool_refused:spawn_failed" });
		const events = c.store.events(id).filter((e) => ["unknown", "create_refused", "unknown_reconciled", "released"].includes(e.kind));
		expect(events.map((e) => e.kind)).toEqual(["unknown", "create_refused", "unknown_reconciled", "released"]);
		expect(events[2]!.data).toMatchObject({ before: "blocked_unknown", after: "failed", cause: "create_refused_before_effect" });
		expect((await c.coordinator()).calls.filter((call) => call.name.endsWith("start_session"))).toHaveLength(1);
	}, 30_000);

	test("a definite refusal never settles an attempt whose cancellation is pending: cancellation owns it", async () => {
		const { c, id, settled } = await hangingRefusedStart("fleet-create-refused-cancel-", async (c, id) => {
			const task = c.store.task(id)!;
			const cancel = { id: "controlled-cancel", key: "controlled-cancel", digest: "controlled", taskId: id, attemptId: task.attemptId, kind: "cancel", payload: {} };
			// StoreCore.db is not public. Keep the original connection (same transaction/lock scope as the daemon's own writes); only the type-level access changes.
			(c.store as unknown as { db: Database }).db.query("INSERT INTO operations(id,task_id,attempt_id,kind,data) VALUES (?,?,?,?,?)").run(cancel.id, id, task.attemptId!, "cancel", JSON.stringify(cancel));
		});
		expect(settled).toMatchObject({ held: true });
		expect((settled as TaskRecord).phase).not.toBe("failed");
		expect(c.store.task(id)!.result?.executionTerminal).not.toBe(true);
		expect(c.store.getOperation(id, "create")?.receipt).toBeUndefined();
		const events = c.store.events(id);
		expect(events.filter((e) => e.kind === "create_refused")).toHaveLength(0);
		expect(events.filter((e) => e.kind === "released")).toHaveLength(0);
		expect([...c.store.heldCharges().values()].flat()).toHaveLength(1);
	}, 30_000);
});

async function verifierFixture(options: { clock?: () => number } = {}) {
	const repo = await repositoryFixture("fleet-verification-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const db = join(repo.dir, "fleet.sqlite");
	let store = new FleetStore(db);
	cleanups.push(async () => store.close());
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	store.putNode({ id: "local", os: process.platform, arch: process.arch,
		roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], operations: [], transport: { command: process.execPath,
			args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } });
	const make = () => new Fleet(store, { localNodeId: "local", ...(options.clock ? { clock: options.clock } : {}) } as any);
	let fleet = make();
	const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "verify", caller: "controlled",
		repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled artifact verification", required: {} }).id);
	const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const,
		terminal: true, evidence: { injected: "controlled settlement" } };
	store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
	const counter = join(repo.dir, "verifier-count");
	const argv = (label: string, exit = 0) => [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},${JSON.stringify(label + "\n")});process.exit(${exit})`];
	const runs = async () => (await readFile(counter, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
	return { repo, db, task, argv, runs, get store() { return store; }, get fleet() { return fleet; },
		reopen(clock?: () => number) { store.close(); store = new FleetStore(db); options.clock = clock ?? options.clock; fleet = make(); } };
}

describe("#5 verification conflicts are final, bounded and visible; owner-gone claims are recorded, never collected", () => {
	test("a conflicting verifier request on a failed verification is recorded once with a visible reason; repeats only count", async () => {
		const f = await verifierFixture();
		const failed = await f.fleet.result(f.task.id, f.argv("A", 1));
		expect(failed.status).not.toBe("verified");
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified" });
		expect(f.store.task(f.task.id)!.reason).toBeUndefined();
		for (let n = 0; n < 3; n++) await expect(f.fleet.result(f.task.id, f.argv("B"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const after = f.store.task(f.task.id)!;
		expect(after.reason).toBe(VERIFICATION_CONFLICT_REASON);
		expect(after.verification).toMatchObject({ state: "conflict", attemptId: f.task.attemptId, count: 3 });
		expect((after.verification as any).retainedArgvDigests.length).toBeGreaterThan(0);
		const events = f.store.events(f.task.id);
		expect(events.filter((e) => e.kind === "verification_conflict")).toHaveLength(1);
		expect(events.filter((e) => e.kind === "verification_conflict")[0]!.data).toMatchObject({ final: true, failureDiagnostic: { code: "condition:verification_conflict" } });
		expect(events.filter((e) => e.kind === "result_validation_rejected" && (e.data as any).code === "VERIFICATION_CONFLICT")).toHaveLength(1);
		expect(await f.runs()).toEqual(["A"]);
		// The unchanged retained request still answers; the dashboard shows the reason.
		expect((await f.fleet.result(f.task.id, f.argv("A", 1))).status).toBe(failed.status);
		expect(getDashboardState(f.store).tasks.find((t) => t.id === f.task.id)).toMatchObject({ reason: VERIFICATION_CONFLICT_REASON });
		// A different conflicting request is audited once more and joins the same bounded record.
		await expect(f.fleet.result(f.task.id, f.argv("C"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		expect(f.store.task(f.task.id)!.verification).toMatchObject({ state: "conflict", count: 4, firstAt: (after.verification as any).firstAt });
		expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_conflict")).toHaveLength(2);
		expect(await f.runs()).toEqual(["A"]);
	});

	test("alternating conflicting requests are audited once per requested argv, never more rows than requests", async () => {
		const f = await verifierFixture();
		await f.fleet.result(f.task.id, f.argv("A", 1));
		const rows = () => f.store.events(f.task.id).filter((e) => e.kind === "verification_conflict" || e.kind === "result_validation_rejected");
		const before = rows().length;
		for (let n = 0; n < 10; n++) await expect(f.fleet.result(f.task.id, f.argv(n % 2 ? "C" : "B"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const added = rows().slice(before);
		expect(added.map((e) => e.kind).sort()).toEqual(["result_validation_rejected", "result_validation_rejected", "verification_conflict", "verification_conflict"]);
		expect(f.store.task(f.task.id)!.verification).toMatchObject({ state: "conflict", count: 10 });
		expect((f.store.task(f.task.id)!.verification as any).recordedArgvDigests).toHaveLength(2);
		expect(await f.runs()).toEqual(["A"]);
	});

	test("past the bound of recorded requests a new conflicting request writes exactly one rejection row and the record stays bounded", async () => {
		const f = await verifierFixture();
		await f.fleet.result(f.task.id, f.argv("A", 1));
		for (let n = 0; n < VERIFICATION_RECORDED_REQUESTS; n++) await expect(f.fleet.result(f.task.id, f.argv("R" + n))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const bounded = f.store.task(f.task.id)!.verification as any;
		expect(bounded.recordedArgvDigests).toHaveLength(VERIFICATION_RECORDED_REQUESTS);
		const before = f.store.events(f.task.id).length;
		await expect(f.fleet.result(f.task.id, f.argv("overflow"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const added = f.store.events(f.task.id).slice(before);
		expect(added.map((e) => [e.kind, (e.data as any).code])).toEqual([["result_validation_rejected", "VERIFICATION_CONFLICT"]]);
		expect(f.store.task(f.task.id)!.verification).toEqual(bounded);
	});

	test("a node verifier reply for another argv is not recorded as a conflict with retained evidence", async () => {
		const f = await verifierFixture();
		expect((await f.fleet.result(f.task.id)).status).toBe("not_run");
		const original = (f.fleet as any).node.bind(f.fleet);
		(f.fleet as any).node = async (task: unknown, request: any) => {
			const value = await original(task, request);
			return request.action === "test" ? { ...value, argv: f.argv("substituted") } : value;
		};
		await expect(f.fleet.result(f.task.id, f.argv("asked"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const t = f.store.task(f.task.id)!;
		expect(t.verification).toBeUndefined();
		expect(t.reason).toBeUndefined();
		const events = f.store.events(f.task.id);
		expect(events.filter((e) => e.kind === "verification_conflict")).toHaveLength(0);
		expect(events.filter((e) => e.kind === "result_validation_rejected" && (e.data as any).code === "VERIFICATION_CONFLICT")).toHaveLength(1);
		expect(await f.runs()).toEqual(["asked"]);
	});

	test("a conflict on a verified task never changes its phase or reason", async () => {
		const f = await verifierFixture();
		expect((await f.fleet.result(f.task.id, f.argv("A"))).status).toBe("verified");
		await expect(f.fleet.result(f.task.id, f.argv("B"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ phase: "succeeded", result: { verified: true }, verification: { state: "conflict", count: 1 } });
		expect(t.reason).toBeUndefined();
	});

	test("an unleased (older-tree) verify-test claim whose owner is gone becomes visible once; collection stays TEST_UNKNOWN; never rerun", async () => {
		let now = 0;
		const f = await verifierFixture({ clock: () => now });
		// Anchor the injected clock to the claim's recorded time, regardless of fixture setup latency.
		const claim = f.store.claimOperation(f.task.id, "verify-test", { argv: f.argv("lost") })!;
		now = Date.parse(f.store.operationClaimedAt(f.task.id, claim.id)!);
		expect(Number.isFinite(now)).toBe(true);
		// Within the bound its owner is unknown: the historical refusal, nothing recorded.
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		now += VERIFIER_OWNER_BOUND_MS - 1000;
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.task(f.task.id)!.verification).toBeUndefined();
		now += 2000;
		f.reopen(() => now);
		for (let n = 0; n < 2; n++) await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		const t = f.store.task(f.task.id)!;
		expect(t.resultManifest).toBeUndefined();
		expect(t).toMatchObject({ phase: "completed_unverified", reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, result: { verified: false },
			verification: { state: "owner_gone", kind: "verify-test", attemptId: f.task.attemptId } });
		await expect(f.fleet.result(f.task.id, f.argv("lost"))).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_owner_gone")).toHaveLength(1);
		expect(await f.runs()).toEqual([]);
	});

	test("a result-test claim whose in-process owner ended without a receipt is recorded once and never rerun", async () => {
		const f = await verifierFixture();
		await f.fleet.result(f.task.id);
		const original = (f.fleet as any).node.bind(f.fleet);
		(f.fleet as any).node = async (task: unknown, request: any) => {
			const value = await original(task, request);
			if (request.action === "test") throw Error("lost verifier response");
			return value;
		};
		await expect(f.fleet.result(f.task.id, f.argv("once"))).rejects.toThrow("lost verifier response");
		const claim = f.store.getOperation(f.task.id, "result-test")!;
		expect(claim.lease).toMatchObject({ pid: process.pid });
		expect(claim.receipt).toBeUndefined();
		f.reopen();
		for (let n = 0; n < 2; n++) await expect(f.fleet.result(f.task.id, f.argv("once"))).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
		expect(f.store.task(f.task.id)).toMatchObject({ reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, verification: { state: "owner_gone", kind: "result-test", operationId: claim.id } });
		expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_owner_gone")).toHaveLength(1);
		expect(await f.runs()).toEqual(["once"]);
	});

	test("a live owner on another host is trusted until its lease expires", async () => {
		let now = Date.now();
		const f = await verifierFixture({ clock: () => now });
		await f.fleet.result(f.task.id);
		f.store.claimResultTest(f.task.id, f.argv("other"), { owner: "other-owner", pid: 1, host: "another-host.invalid", expiresAt: now + 60_000 });
		await expect(f.fleet.result(f.task.id, f.argv("other"))).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
		expect(f.store.task(f.task.id)!.verification).toBeUndefined();
		now += 60_000;
		await expect(f.fleet.result(f.task.id, f.argv("other"))).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
		expect(f.store.task(f.task.id)!.verification).toMatchObject({ state: "owner_gone", kind: "result-test" });
		expect(await f.runs()).toEqual([]);
	});

	test("an owner lease is accepted only on a verifier claim", async () => {
		const f = await verifierFixture();
		expect(() => f.store.claimOperation(f.task.id, "stop", {}, { owner: "o", pid: 1, host: "h", expiresAt: Date.now() + 1000 })).toThrow("Only a verifier claim");
	});

	test("a verify-test claimer that dies while its admitted test still runs never unlocks collection; the late write is never frozen out", async () => {
		const f = await verifierFixture();
		const started = join(f.repo.dir, "verifier-started");
		const late = "late-by-verifier.txt";
		// The admitted test's effect outlives its claimer: it starts a detached writer (Windows ends the test
		// process itself with its claimer's job object; POSIX does not), signals start, then keeps running.
		const writer = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'late'),1500)`;
		const argv = [process.execPath, "--eval", `const fs=require('node:fs');require('node:child_process').spawn(process.execPath,['--eval',${JSON.stringify(writer)}],{detached:true,stdio:'ignore'}).unref();fs.writeFileSync(${JSON.stringify(started)},'');setTimeout(()=>{},3000)`];
		const claimer = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/verifier-claimer-child.ts"), f.db, f.task.id, started, JSON.stringify(argv)], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
		expect(await claimer.exited).toBe(137);
		const claim = f.store.getOperation(f.task.id, "verify-test")!;
		expect(claim.lease).toMatchObject({ pid: claimer.pid, host: hostname() });
		expect(claim.receipt).toBeUndefined();
		// The claimer is provably gone: that is recorded, but the original refusal stands.
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.task(f.task.id)).toMatchObject({ reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, verification: { state: "owner_gone", kind: "verify-test", operationId: claim.id } });
		expect(f.store.task(f.task.id)!.resultManifest).toBeUndefined();
		// The test was still running and writes after its claimer died.
		const workspace = join((f.store.task(f.task.id)!.workspace as any).path, late);
		const deadline = Date.now() + 10_000;
		while (!existsSync(workspace) && Date.now() < deadline) await Bun.sleep(25);
		expect(existsSync(workspace)).toBe(true);
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.task(f.task.id)!.resultManifest).toBeUndefined();
		expect(f.store.events(f.task.id).filter((e) => e.kind === "result_saved")).toHaveLength(0);
		expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_owner_gone")).toHaveLength(1);
	}, 30_000);

	test("a verify-test claim held by another live process on this host is TEST_UNKNOWN and not owner-gone until that process exits", async () => {
		const f = await verifierFixture();
		const holder = Bun.spawn([process.execPath, "--eval", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
		f.store.claimOperation(f.task.id, "verify-test", { argv: f.argv("held") }, { owner: "other-process", pid: holder.pid, host: hostname(), expiresAt: Date.now() + 60_000 });
		try {
			await expect(f.fleet.result(f.task.id)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
			expect(f.store.task(f.task.id)!.verification).toBeUndefined();
			expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_owner_gone")).toHaveLength(0);
		} finally {
			holder.stdin.end();
			await holder.exited;
		}
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.task(f.task.id)!.verification).toMatchObject({ state: "owner_gone", kind: "verify-test" });
		expect(await f.runs()).toEqual([]);
	}, 30_000);

	test("a same-host owner pid that answers EPERM is alive: never recorded as owner-gone", async () => {
		const f = await verifierFixture();
		const pid = 2_000_000_001;
		f.store.claimOperation(f.task.id, "verify-test", { argv: f.argv("held") }, { owner: "other-user-process", pid, host: hostname(), expiresAt: Date.now() + 60_000 });
		const kill = process.kill;
		let answer = "EPERM";
		(process as any).kill = (target: number, signal?: string | number) => {
			if (target === pid && signal === 0) throw Object.assign(new Error(answer), { code: answer });
			return kill.call(process, target, signal as any);
		};
		try {
			await expect(f.fleet.result(f.task.id)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
			expect(f.store.task(f.task.id)!.verification).toBeUndefined();
			answer = "ESRCH";
			await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
			expect(f.store.task(f.task.id)!.verification).toMatchObject({ state: "owner_gone", kind: "verify-test" });
		} finally {
			(process as any).kill = kill;
		}
	});

	test("a successful verification clears an earlier verification_conflict reason", async () => {
		const f = await verifierFixture();
		const original = (f.fleet as any).node.bind(f.fleet);
		let failCollect = true;
		(f.fleet as any).node = async (task: unknown, request: any) => {
			if (request.action === "collect" && failCollect) {
				failCollect = false;
				throw Error("lost collect response");
			}
			return original(task, request);
		};
		// The test receipt for A is retained, the collection is lost.
		await expect(f.fleet.result(f.task.id, f.argv("A"))).rejects.toThrow("lost collect response");
		await expect(f.fleet.result(f.task.id, f.argv("B"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "completed_unverified", reason: VERIFICATION_CONFLICT_REASON });
		expect((await f.fleet.result(f.task.id, f.argv("A"))).status).toBe("verified");
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect(t.reason).toBeUndefined();
		expect(await f.runs()).toEqual(["A"]);
	});

	test("a repeat of an earlier recorded request (B, C, B) advances count and keeps firstAt", async () => {
		const f = await verifierFixture();
		await f.fleet.result(f.task.id, f.argv("A", 1));
		await expect(f.fleet.result(f.task.id, f.argv("B"))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const first = f.store.task(f.task.id)!.verification as any;
		await Bun.sleep(5);
		for (const label of ["C", "B"]) await expect(f.fleet.result(f.task.id, f.argv(label))).rejects.toMatchObject({ code: "VERIFICATION_CONFLICT" });
		const record = f.store.task(f.task.id)!.verification as any;
		expect(record).toMatchObject({ state: "conflict", count: 3, firstAt: first.firstAt, requestedArgvDigest: first.requestedArgvDigest });
		expect(record.lastAt > first.firstAt).toBe(true);
		expect(f.store.events(f.task.id).filter((e) => e.kind === "verification_conflict")).toHaveLength(2);
	});

	test("an owner-gone verify-test claim whose live owner later records its genuine receipt is cleared; the verified task carries no stale reason", async () => {
		let now = Date.now();
		const f = await verifierFixture({ clock: () => now });
		const argv = f.argv("late");
		// The owner is alive (a suspended host), but its lease expired: judged gone.
		const claim = f.store.claimOperation(f.task.id, "verify-test", { argv }, { owner: "suspended-owner", pid: 1, host: "another-host.invalid", expiresAt: now + 60_000 })!;
		now += 60_000;
		await expect(f.fleet.result(f.task.id)).rejects.toThrow("TEST_UNKNOWN");
		expect(f.store.task(f.task.id)).toMatchObject({ reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, verification: { state: "owner_gone", kind: "verify-test", operationId: claim.id } });
		// The owner resumes: its admitted test ran once and it records that genuine receipt.
		const task = f.store.task(f.task.id)!;
		const receipt = await (f.fleet as any).node(task, { action: "test", identity: task.workspace, argv });
		f.store.recordVerification(f.task.id, receipt);
		const received = f.store.task(f.task.id)!;
		expect(received.verification).toBeUndefined();
		expect(received.reason).toBeUndefined();
		expect((await f.fleet.result(f.task.id)).status).toBe("verified");
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect(t.reason).toBeUndefined();
		expect(t.verification).toBeUndefined();
		expect(getDashboardState(f.store).tasks.find((d) => d.id === f.task.id)!.reason).toBeUndefined();
		expect(await f.runs()).toEqual(["late"]);
	});

	test("an owner-gone result-test claim whose live owner later records its genuine receipt is cleared; the verified task carries no stale reason", async () => {
		let now = Date.now();
		const f = await verifierFixture({ clock: () => now });
		const argv = f.argv("late-upgrade");
		await f.fleet.result(f.task.id);
		const claim = f.store.claimResultTest(f.task.id, argv, { owner: "suspended-owner", pid: 1, host: "another-host.invalid", expiresAt: now + 60_000 })!;
		now += 60_000;
		await expect(f.fleet.result(f.task.id, argv)).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
		expect(f.store.task(f.task.id)).toMatchObject({ reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, verification: { state: "owner_gone", kind: "result-test", operationId: claim.id } });
		// The owner resumes: its verifier ran once on the unchanged artifact and it records that receipt.
		const task = f.store.task(f.task.id)!;
		const cached = task.resultManifest as any;
		const test = await (f.fleet as any).node(task, { action: "test", identity: cached.identity, argv });
		const { tests: _tests, status: _status, producer: _producer, ...artifact } = cached;
		f.store.recordOperationReceipt(f.task.id, "result-test", claim.id, { manifestDigest: digest(cached), beforeDigest: digest(artifact), afterDigest: digest(artifact), test });
		const received = f.store.task(f.task.id)!;
		expect(received.verification).toBeUndefined();
		expect(received.reason).toBeUndefined();
		expect((await f.fleet.result(f.task.id, argv)).status).toBe("verified");
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect(t.reason).toBeUndefined();
		expect(t.verification).toBeUndefined();
		expect(await f.runs()).toEqual(["late-upgrade"]);
	});

	test("an owner-gone result-test claim that its live owner releases as never sent is cleared; a later verification leaves no stale reason", async () => {
		let now = Date.now();
		const f = await verifierFixture({ clock: () => now });
		await f.fleet.result(f.task.id);
		const claim = f.store.claimResultTest(f.task.id, f.argv("unsent"), { owner: "suspended-owner", pid: 1, host: "another-host.invalid", expiresAt: now + 60_000 })!;
		now += 60_000;
		await expect(f.fleet.result(f.task.id, f.argv("unsent"))).rejects.toMatchObject({ code: "TEST_UNKNOWN" });
		expect(f.store.task(f.task.id)).toMatchObject({ reason: VERIFICATION_OUTCOME_UNKNOWN_REASON, verification: { state: "owner_gone", kind: "result-test", operationId: claim.id } });
		// The owner resumes and proves its verifier request never reached the node.
		expect(f.store.releaseUnsentClaim(f.task.id, "result-test", claim.id)).toBe(true);
		const released = f.store.task(f.task.id)!;
		expect(released.verification).toBeUndefined();
		expect(released.reason).toBeUndefined();
		expect((await f.fleet.result(f.task.id, f.argv("unsent"))).status).toBe("verified");
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect(t.reason).toBeUndefined();
		expect(t.verification).toBeUndefined();
		expect(await f.runs()).toEqual(["unsent"]);
	});
});

describe("#6 receipts are point-in-time records; readers use derived state", () => {
	test("tasks, watch-style and dashboard readers report the derived outcome, never the last receipt row", async () => {
		const f = await verifierFixture();
		const id = f.task.id;
		expect((await f.fleet.result(id, f.argv("A"))).status).toBe("verified");
		const task = f.store.task(id)!;
		expect(task).toMatchObject({ phase: "succeeded", result: { verified: true } });
		const raw = new Database(f.db);
		try {
			const last = () => JSON.parse((raw.query("SELECT data FROM receipts WHERE task_id=? ORDER BY rowid DESC LIMIT 1").get(id) as any).data);
			// The last receipt is the observation that settled it; verification never appends one.
			expect(last()).toMatchObject({ status: "completed_unverified", terminal: true });
			// Even a contradicting row appended after the fact is not read as state.
			raw.query("INSERT INTO receipts(event_id,task_id,data) VALUES (?,?,?)").run("injected-contradiction", id, JSON.stringify({ status: "active", terminal: false }));
			expect(last()).toMatchObject({ status: "active", terminal: false });
		} finally {
			raw.close();
		}
		const now = f.store.task(id)!;
		expect(now).toEqual(task);
		expect(executionOutcome(now)).toBe("verified");
		expect(compactTask(f.store, now).split("\t").at(-1)).toBe("verified");
		const row = getDashboardState(f.store).tasks.find((t) => t.id === id)!;
		expect(row).toMatchObject({ phase: "succeeded", outcome: "verified", verified: true });
		expect(getDashboardState(f.store).pipeline.outcome).toMatchObject({ succeeded: 1 });
	});

	test("an unsettled task's last observation is never reported as its outcome", async () => {
		const f = await scenario(turnFailedOnly);
		const t = await f.inspect(0);
		expect(t.result?.status).toBe("completed_unverified");
		expect(executionOutcome(t)).toBe("unsettled");
		expect(compactTask(f.store, t).split("\t").at(-1)).toBe("unsettled");
		expect(getDashboardState(f.store).tasks.find((row) => row.id === f.id)).toMatchObject({ outcome: "unsettled" });
	});

	test("executionOutcome derivation table", () => {
		const r = (result?: Partial<NonNullable<TaskRecord["result"]>>) => ({ result: result as any });
		expect(executionOutcome(r())).toBeNull();
		expect(executionOutcome(r({ status: "failed", executionTerminal: false, verified: false }))).toBe("unsettled");
		expect(executionOutcome(r({ status: "completed_unverified", executionTerminal: true, verified: false }))).toBe("completed_unverified");
		expect(executionOutcome(r({ status: "completed_unverified", executionTerminal: true, verified: true }))).toBe("verified");
		expect(executionOutcome(r({ status: "failed", executionTerminal: true, verified: false }))).toBe("failed");
	});
});
