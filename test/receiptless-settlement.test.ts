import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { observationDigest } from "../src/core";
import { getDashboardState } from "../src/dashboard";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

// CONTROLLED stdio Coordinator + CONTROLLED public SDK query stand-in (not GJC).
// The read_turn / turn.result replies replay the evidence shapes recorded on the
// 15 production tasks stuck in completed_unverified with executionTerminal=false.
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
const clone = <T>(value: T): T => structuredClone(value);

function publicTurn(status: "failed" | "completed", session: Record<string, any>) {
	return {
		ok: true,
		turn: {
			session_id: SESSION,
			turn_id: TURN,
			prompt: { text: "CONTROLLED prompt", source: "mcp", created_at: "2026-11-12T09:00:00.000Z" },
			status,
			completed_at: "2026-11-12T09:41:07.512Z",
			...(status === "failed"
				? { error: { code: "unavailable", message: "Coordinator service is unavailable" } }
				: { final_response: { source: "agent_end" } }),
			delivery: {
				runtime_command_id: "runtime-command-1",
				runtime_turn_id: "runtime-turn-1",
				prompt_acknowledged: true,
				queued: false,
			},
		},
		advisory_status: { authority: "sdk", is_streaming: false },
		session_state: {
			session_id: SESSION,
			current_turn_id: null,
			activity: { phase: "finished" },
			active_tool_count: 0,
			...session,
		},
	};
}
const erroredSession = { state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false };
const completedSession = { state: "completed", ready_for_input: true };

/** 12 of 15: agent turn failed after start, GJC wrote no command receipt. */
const failedMissing: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: {
		status: "failed",
		receiptState: "missing",
		terminalAt: 1_763_000_467_512,
		outcome: {
			kind: "failed",
			code: "prompt_failed",
			provenance: "agent_failed",
			phase: "post_start",
			category: "agent_runtime",
			message: "model stream stalled: no tokens for 180s; run aborted",
		},
	},
};
/** Older rows: runtime still reports in_flight/absent while the public turn ended. */
const olderFailed: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: { status: "in_flight", receiptState: "absent" },
};
/** A completed (idle, not ended) session settles only on a LIVE SDK view (F4). */
const olderCompleted: Shape = {
	turn: { ...publicTurn("completed", completedSession), advisory_status: { authority: "sdk", is_streaming: false, live: true } },
	execution: { status: "in_flight", receiptState: "absent" },
};

const input: (repo: { baseCommit: string }) => TaskInput = (repo) => ({
	schemaVersion: 1,
	key: "receiptless",
	caller: "controlled-operator",
	repoId: "repo",
	baseCommit: repo.baseCommit,
	prompt: "CONTROLLED prompt",
	required: {},
});

async function scenario(shape: Shape, options: { existing?: boolean } = {}) {
	const repo = await repositoryFixture("fleet-receiptless-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const statePath = join(repo.dir, "coordinator.json");
	const executionState = join(repo.dir, "execution.json");
	const executionLog = join(repo.dir, "execution.log");
	await writeFile(statePath, JSON.stringify({ calls: [] } satisfies ControlledState));
	await writeFile(executionLog, "");
	const node: NodeConfig = {
		id: "alpha", os: process.platform, arch: process.arch, roots: { repo: repo.repo },
		workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true,
		sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [coordinatorPath, statePath] },
		sdkTransport: { command: process.execPath, args: [executionPath, executionState, executionLog] },
	};
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	store.putNode(node);
	let now = T0;
	const fleet = new Fleet(store, { localNodeId: node.id, clock: () => now } as any);
	const started = await fleet.start(fleet.submit(input(repo)).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	const coordinator = async (): Promise<ControlledState> => JSON.parse(await readFile(statePath, "utf8"));
	async function set(next: Shape) {
		await writeFile(statePath, JSON.stringify({ ...(await coordinator()), readTurn: next.turn }));
		await writeFile(executionState, JSON.stringify(next.execution));
	}
	await set(shape);
	if (options.existing) {
		// Exactly the row the pre-fix inspect persisted: completed_unverified, terminal=false, held.
		const sequence = store.beginObservation(started.id)!;
		const body = {
			sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false,
			evidence: {
				publicTurn: shape.turn,
				questions: { ok: true, reconciliation: { complete: true }, questions: [] },
				execution: { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", ...shape.execution },
			},
		};
		store.observe(started.id, { ...body, eventId: started.attemptId + ":poll:" + sequence, digest: observationDigest(body) }, sequence);
		expect(store.task(started.id)).toMatchObject({
			phase: "completed_unverified", held: true, result: { executionTerminal: false },
		});
	}
	return {
		store, fleet, id: started.id, set, coordinator,
		at(ms: number) { now = T0 + ms; },
		async inspect(ms: number) { now = T0 + ms; return (await fleet.inspect(started.id)).task; },
		released: () => store.events(started.id).filter((event) => event.kind === "released").length,
		executionCalls: async () => (await readFile(executionLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}

function expectHeld(task: TaskRecord) {
	expect(task.held).toBe(true);
	expect(task.result?.executionTerminal ?? false).toBe(false);
	expect(["completed_unverified", "blocked_unknown", "active"]).toContain(task.phase);
	expect((task.result as any)?.settlement).toBeUndefined();
}

async function expectSettledOnce(
	f: Awaited<ReturnType<typeof scenario>>,
	kind: "failed_without_receipt" | "ended_without_receipt",
	receiptState: string,
) {
	expectHeld(await f.inspect(0));
	expect(f.released()).toBe(0);
	// Same conclusion again, but before the minimum interval: still held.
	expectHeld(await f.inspect(INTERVAL - 1));
	expect(f.released()).toBe(0);
	await expect(f.fleet.stop(f.id)).rejects.toThrow("Only a proven settled");
	const settled = await f.inspect(INTERVAL);
	expect(settled.phase).toBe("failed");
	expect(settled.held).toBe(false);
	expect(settled.result).toMatchObject({ status: "failed", executionTerminal: true, verified: false });
	expect((settled.result as any).settlement).toMatchObject({ kind, receiptState });
	expect(settled.reason).toBeUndefined();
	const evidence = settled.result!.evidence as any;
	// The missing receipt stays visible in the retained evidence.
	expect(evidence.execution.receiptState).toBe(receiptState);
	expect(evidence.receiptless).toMatchObject({ kind, confirmed: true, firstObservedAt: T0, observedAt: T0 + INTERVAL });
	expect(f.released()).toBe(1);
	// Terminal is final: later reads do not re-observe, re-release or rewrite.
	const observations = f.store.events(f.id).filter((event) => event.kind === "observation").length;
	expect(await f.inspect(10 * INTERVAL)).toEqual(settled);
	expect(f.store.events(f.id).filter((event) => event.kind === "observation").length).toBe(observations);
	expect(f.released()).toBe(1);
	// Never verified / succeeded: no verifier path accepts a receipt-less settlement.
	await expect(f.fleet.result(f.id, [process.execPath, "--eval", "console.log('ok')"])).rejects.toThrow("without a runtime receipt");
	expect(() => f.store.verifyResult(f.id, { forged: true })).toThrow("without a runtime receipt");
	expect(f.store.task(f.id)).toMatchObject({ phase: "failed", result: { verified: false } });
	// Existing stop/session-return path now closes exactly this task's session, once.
	await f.fleet.stop(f.id);
	await expect(f.fleet.stop(f.id)).rejects.toThrow("Stop was already requested");
	const calls = (await f.coordinator()).calls;
	expect(calls.filter((call) => call.name === "gjc_coordinator_stop_session").map((call) => call.args)).toEqual([
		{ session_id: SESSION, allow_mutation: true, reason: "Fleet task execution settled" },
	]);
	// Never re-sent a prompt, never aborted or closed through the SDK route.
	expect(calls.filter((call) => call.name === "gjc_coordinator_send_prompt")).toHaveLength(1);
	for (const call of await f.executionCalls()) expect(call.argv.slice(0, 4)).toEqual(["sdk", "session", "raw", "query"]);
	return settled;
}

describe("receipt-less terminal turns", () => {
	test("failed after start with missing receipt settles as failed_without_receipt, keeps the agent cause, releases once", async () => {
		const f = await scenario(failedMissing);
		const settled = await expectSettledOnce(f, "failed_without_receipt", "missing");
		const settlement = (settled.result as any).settlement;
		expect(settlement.cause).toContain("model stream stalled: no tokens for 180s; run aborted");
		expect(settlement.cause).toContain("prompt_failed");
		expect(settlement.cause).toContain("unavailable");
		const cause = (settled.result!.evidence as any).receiptless.cause;
		expect(cause.turnError).toEqual({ code: "unavailable", message: "Coordinator service is unavailable" });
		expect(cause.outcome).toMatchObject({ code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime" });
		expect(cause.sessionState).toBe("errored");
		const dashboard = getDashboardState(f.store);
		const row = dashboard.tasks.find((task) => task.id === f.id)!;
		expect(row).toMatchObject({ phase: "failed", executionTerminal: true, held: false, verified: false });
		expect((row as any).settlement).toMatchObject({ kind: "failed_without_receipt", receiptState: "missing" });
		expect(dashboard.pipeline.outcome).toMatchObject({ succeeded: 0, unverified: 0, troubled: 1 });
		expect(dashboard.summary).toMatchObject({ succeededTasks: 0, heldTasks: 0 });
		expect(dashboard.nodes[0]!.holding).toEqual([]);
	});

	test("failed agent outcome without message still preserves the runtime and turn error codes", async () => {
		const shape = clone(failedMissing);
		delete shape.execution.outcome.message;
		const f = await scenario(shape);
		const settled = await expectSettledOnce(f, "failed_without_receipt", "missing");
		expect((settled.result as any).settlement.cause).toContain("prompt_failed");
		expect((settled.result as any).settlement.cause).toContain("unavailable");
	});

	for (const [name, shape, kind, receiptState] of [
		["12 production rows: failed/missing", failedMissing, "failed_without_receipt", "missing"],
		["older row: in_flight/absent with failed turn", olderFailed, "failed_without_receipt", "absent"],
		["older rows: in_flight/absent with completed turn", olderCompleted, "ended_without_receipt", "absent"],
	] as const) {
		test(`existing stuck row settles through normal inspect: ${name}`, async () => {
			const f = await scenario(shape, { existing: true });
			const settled = await expectSettledOnce(f, kind, receiptState);
			if (kind === "ended_without_receipt") {
				// Completed metadata without a receipt is never inferred as success.
				expect(settled.phase).not.toBe("succeeded");
				expect(settled.phase).not.toBe("completed_unverified");
				expect((settled.result as any).settlement.cause).toContain("receipt");
			}
			const dashboard = getDashboardState(f.store);
			expect(dashboard.pipeline.outcome).toMatchObject({ succeeded: 0, unverified: 0 });
		});
	}

	const nearMisses: Array<[string, (shape: Shape) => void, Shape?]> = [
		["session still streaming", (s) => { s.turn.advisory_status.is_streaming = true; }],
		["streaming flag missing", (s) => { delete s.turn.advisory_status.is_streaming; }],
		["active tool count > 0", (s) => { s.turn.session_state.active_tool_count = 1; }],
		["active tool count missing", (s) => { delete s.turn.session_state.active_tool_count; }],
		["activity still running", (s) => { s.turn.session_state.activity.phase = "tool_running"; }],
		["current_turn_id set", (s) => { s.turn.session_state.current_turn_id = TURN; }],
		["different turn id on read", (s) => { s.turn.turn.turn_id = "other-turn"; }],
		["sidecar last_turn_id of another turn", (s) => { s.turn.session_state.last_turn_id = "other-turn"; }],
		["different session id in session state", (s) => { s.turn.session_state.session_id = "other-session"; }],
		["different session id on read", (s) => { s.turn.turn.session_id = "other-session"; }],
		["turn status running", (s) => { s.turn.turn.status = "running"; delete s.turn.turn.completed_at; }],
		["turn status running with completed_at", (s) => { s.turn.turn.status = "running"; }],
		["completed_at missing", (s) => { delete s.turn.turn.completed_at; }],
		["failed turn but session still active", (s) => { s.turn.session_state.state = "active"; }],
		["failed turn but session has no ended_at", (s) => { delete s.turn.session_state.ended_at; }],
		["prompt still queued", (s) => { s.turn.turn.delivery.queued = true; }],
		["receipt pending", (s) => { s.execution.receiptState = "pending"; }],
		["runtime claims terminal_ok yet has no receipt", (s) => { s.execution.status = "terminal_ok"; }],
		["execution record of a different status", (s) => { s.execution.status = "queued"; }],
		["completed turn but session still active", (s) => { s.turn.session_state.state = "active"; }, olderCompleted],
		["completed turn with current turn", (s) => { s.turn.session_state.current_turn_id = TURN; }, olderCompleted],
		["completed turn, completed session, stale SDK view live:false", (s) => { s.turn.advisory_status.live = false; }, olderCompleted],
		["completed turn, completed session, live flag missing", (s) => { delete s.turn.advisory_status.live; }, olderCompleted],
		["completed turn, ended session without ended_at", (s) => { s.turn.session_state.state = "ended"; delete s.turn.advisory_status.live; }, olderCompleted],
	];
	for (const [name, mutate, base] of nearMisses) {
		test(`near miss stays held exactly as today: ${name}`, async () => {
			const shape = clone(base ?? failedMissing);
			mutate(shape);
			const f = await scenario(shape, { existing: true });
			for (const ms of [0, INTERVAL, 3 * INTERVAL]) expectHeld(await f.inspect(ms));
			expect(f.released()).toBe(0);
			await expect(f.fleet.stop(f.id)).rejects.toThrow("Only a proven settled");
			const calls = (await f.coordinator()).calls;
			expect(calls.filter((call) => call.name === "gjc_coordinator_stop_session")).toHaveLength(0);
			expect(calls.filter((call) => call.name === "gjc_coordinator_send_prompt")).toHaveLength(1);
		});
	}

	test("only one observation never settles, however old the turn is", async () => {
		const f = await scenario(failedMissing, { existing: true });
		expectHeld(await f.inspect(100 * INTERVAL));
		expect(f.released()).toBe(0);
	});

	test("a changed observation restarts the interval instead of pairing two different conclusions", async () => {
		const f = await scenario(failedMissing);
		expectHeld(await f.inspect(0));
		const changed = clone(failedMissing);
		changed.turn.session_state.ended_at = "2026-11-12T09:59:59.000Z";
		await f.set(changed);
		expectHeld(await f.inspect(INTERVAL));
		expectHeld(await f.inspect(2 * INTERVAL - 1));
		expect(f.released()).toBe(0);
		expect((await f.inspect(2 * INTERVAL)).held).toBe(false);
		expect(f.released()).toBe(1);
	});

	test("a non-proving observation in between resets the candidate", async () => {
		const f = await scenario(failedMissing);
		expectHeld(await f.inspect(0));
		const streaming = clone(failedMissing);
		streaming.turn.advisory_status.is_streaming = true;
		await f.set(streaming);
		expectHeld(await f.inspect(INTERVAL / 2));
		await f.set(failedMissing);
		expectHeld(await f.inspect(INTERVAL));
		expectHeld(await f.inspect(INTERVAL + INTERVAL / 2));
		expect(f.released()).toBe(0);
		expect((await f.inspect(2 * INTERVAL)).held).toBe(false);
	});

	test("a clock that moves backwards never confirms", async () => {
		const f = await scenario(failedMissing);
		expectHeld(await f.inspect(INTERVAL));
		expectHeld(await f.inspect(0));
		expectHeld(await f.inspect(INTERVAL - 1));
		expect(f.released()).toBe(0);
	});
});
