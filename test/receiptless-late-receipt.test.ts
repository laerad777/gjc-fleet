import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClawhipControl, controlBinding } from "../src/clawhip-control";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { digest, observationDigest } from "../src/core";
import { getDashboardState, getDashboardTask } from "../src/dashboard";
import { CAUSE_TEXT_LIMIT, LATE_RECEIPT_WINDOW_MS } from "../src/execution";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

// CONTROLLED stdio Coordinator + CONTROLLED public SDK query stand-in (not GJC).
// Ports the independent review 8c7f0027 reproductions (converted to the fixed
// behaviour where they documented a finding) and adds the late-receipt contract.
const coordinatorPath = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const executionPath = fileURLToPath(new URL("./fixtures/execution-query.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INTERVAL = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const OK_ARGV = [process.execPath, "--eval", "process.exit(0)"];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Shape = { turn: Record<string, any>; execution: Record<string, any> };
const clone = <T>(v: T): T => structuredClone(v);
function publicTurn(status: "failed" | "completed", session: Record<string, any>, advisory: Record<string, any> = {}) {
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
		advisory_status: { authority: "sdk", is_streaming: false, ...advisory },
		session_state: { session_id: SESSION, current_turn_id: null, activity: { phase: "finished" }, active_tool_count: 0, ...session },
	};
}
const erroredSession = { state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false };
const completedSession = { state: "completed", ready_for_input: true };
const failedMissing: Shape = {
	turn: publicTurn("failed", erroredSession),
	execution: {
		status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512,
		outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "model stream stalled: no tokens for 180s; run aborted" },
	},
};
const olderFailed: Shape = { turn: publicTurn("failed", erroredSession), execution: { status: "in_flight", receiptState: "absent" } };
const olderCompleted: Shape = { turn: publicTurn("completed", completedSession, { live: true }), execution: { status: "in_flight", receiptState: "absent" } };
const OK_RECEIPT = { status: "terminal_ok", receiptState: "present", terminalAt: 1_763_000_999_000, outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" } };
const FAILED_RECEIPT = { status: "failed", receiptState: "present", terminalAt: 1_763_000_999_500, outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "late agent failure" } };
/** A real, valid late receipt for the same command (what settledExecution accepts). */
const lateOk = (base: Shape): Shape => {
	const s = clone(base);
	s.turn.turn.status = "completed";
	delete s.turn.turn.error;
	s.turn.turn.final_response = { source: "agent_end" };
	s.turn.advisory_status.live = true;
	s.turn.session_state.state = "completed";
	s.execution = clone(OK_RECEIPT);
	return s;
};
const withReceipt = (base: Shape, receipt: Record<string, any>): Shape => ({ turn: clone(base.turn), execution: clone(receipt) });
const input = (repo: { baseCommit: string }): TaskInput => ({
	schemaVersion: 1, key: "receiptless-late", caller: "controlled-operator", repoId: "repo",
	baseCommit: repo.baseCommit, prompt: "CONTROLLED prompt", required: {},
});

async function scenario(shape: Shape, options: { existing?: boolean } = {}) {
	const repo = await repositoryFixture("fleet-receiptless-late-");
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
	const dbPath = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(dbPath);
	cleanups.push(() => store.close());
	store.putNode(node);
	let now = T0;
	const fleet = new Fleet(store, { localNodeId: node.id, clock: () => now } as any);
	const started = await fleet.start(fleet.submit(input(repo)).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	const coordinator = async (): Promise<ControlledState> => JSON.parse(await readFile(statePath, "utf8"));
	async function set(next: Shape, extra: Partial<ControlledState> = {}) {
		await writeFile(statePath, JSON.stringify({ ...(await coordinator()), lose: undefined, readTurn: next.turn, ...extra }));
		await writeFile(executionState, JSON.stringify(next.execution));
	}
	await set(shape);
	if (options.existing) {
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
	}
	const reads = async () => (await coordinator()).calls.filter((c) => c.name === "gjc_coordinator_read_turn").length;
	const events = (kind: string) => store.events(started.id).filter((e) => e.kind === kind);
	return {
		store, fleet, node, dbPath, repo, id: started.id, attemptId: started.attemptId!, set, coordinator, reads, events, executionState,
		setNow(ms: number) { now = T0 + ms; },
		async inspect(ms: number) { now = T0 + ms; return (await fleet.inspect(started.id)).task; },
		async poll(ms: number) { now = T0 + ms; return fleet.inspect(started.id); },
		released: (s: FleetStore = store) => s.events(started.id).filter((e) => e.kind === "released").length,
		executionCalls: async () => (await readFile(executionLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
	};
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const held = (t: TaskRecord) => t.held === true && !t.result?.executionTerminal && !(t.result as any)?.settlement;
async function settle(f: Scenario, at = 0) {
	expect(held(await f.inspect(at))).toBe(true);
	const settled = await f.inspect(at + INTERVAL);
	expect(settled).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true, verified: false } });
	expect(f.released()).toBe(1);
	return settled;
}
function expectFinal(f: Scenario, settled: TaskRecord) {
	const now = f.store.task(f.id)!;
	expect(now.phase).toBe("failed");
	expect(now.held).toBe(false);
	expect(now.result).toMatchObject({ status: "failed", executionTerminal: true, verified: false, settlement: settled.result!.settlement });
	expect(f.released()).toBe(1);
	expect([...f.store.heldCharges().values()].flat().length).toBe(0);
	return now;
}
const archiveList = (repo: { workspaceRoot: string }, live: boolean) => JSON.stringify({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" },
	sessions: [{ sessionId: SESSION, live, cwd: repo.workspaceRoot, locator: { cwd: repo.workspaceRoot, worktreeRoot: repo.workspaceRoot } }], warnings: [] } });

describe("late receipt after a receipt-less settlement (F1)", () => {
	test("review repro: late valid terminal_ok receipt AFTER settlement is recorded durably and visibly; finality kept", async () => {
		const f = await scenario(olderCompleted);
		const settled = await settle(f);
		expect(settled.result!.settlement).toMatchObject({ kind: "ended_without_receipt", settledAt: new Date(T0 + INTERVAL).toISOString(),
			lateObservationUntil: new Date(T0 + INTERVAL + LATE_RECEIPT_WINDOW_MS).toISOString() });
		// Within the window inspection still observes the exact session/turn: no receipt yet.
		const readsBefore = await f.reads();
		const quiet = await f.poll(2 * INTERVAL);
		expect(quiet.lateReceipt).toEqual({ checked: true, found: false });
		expect((quiet.publicTurn as any).turn).toMatchObject({ session_id: SESSION, turn_id: TURN });
		expect(await f.reads()).toBe(readsBefore + 1);
		expect(quiet.task).toEqual(settled);
		await f.set(lateOk(olderCompleted));
		const seen = await f.poll(5 * INTERVAL);
		expect(seen.lateReceipt).toEqual({ checked: true, found: true });
		const after = expectFinal(f, settled);
		const execution = { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", ...OK_RECEIPT };
		expect(after.result!.lateReceipt).toEqual({
			status: "terminal_ok", digest: digest(execution), terminalAt: OK_RECEIPT.terminalAt,
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			sessionId: SESSION, turnId: TURN, runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1",
			observedAt: new Date(T0 + 5 * INTERVAL).toISOString(), settlementKind: "ended_without_receipt",
		});
		const contradiction = f.events("late_receipt_contradiction");
		expect(contradiction).toHaveLength(1);
		expect(contradiction[0]!.data).toMatchObject({ status: "terminal_ok", digest: digest(execution), settlementKind: "ended_without_receipt", phase: "failed", finality: "unchanged" });
		// Evidence of the settlement itself is untouched; nothing re-reserved.
		expect(after.result!.evidence).toEqual(settled.result!.evidence);
		// Recording ends the late observation: no further reads, no duplicate event.
		const readsAfter = await f.reads();
		expect((await f.poll(6 * INTERVAL)).lateReceipt).toBeUndefined();
		expect(await f.reads()).toBe(readsAfter);
		expect(f.events("late_receipt_contradiction")).toHaveLength(1);
		// Dashboard surfaces the contradiction; it is not counted as success or unverified.
		const dash = getDashboardState(f.store);
		const row = dash.tasks.find((t) => t.id === f.id)!;
		expect(row).toMatchObject({ phase: "failed", held: false, verified: false, lateReceipt: { status: "terminal_ok", digest: digest(execution) } });
		expect(row.timeline.map((e) => e.kind)).toContain("late_receipt_contradiction");
		expect(getDashboardTask(f.store, f.id)!.timeline.map((e) => e.kind)).toContain("late_receipt_contradiction");
		expect(dash.pipeline.outcome).toMatchObject({ succeeded: 0, unverified: 0, troubled: 1 });
		// Never verified automatically.
		await expect(f.fleet.result(f.id, OK_ARGV)).rejects.toThrow("without a runtime receipt");
		expect(() => f.store.verifyResult(f.id, { forged: true })).toThrow("without a runtime receipt");
	});

	for (const [name, base] of [["failed_without_receipt", failedMissing], ["ended_without_receipt", olderCompleted]] as const) {
		test(`late failed receipt for the same turn (${name}) is recorded; it can never be accepted`, async () => {
			const f = await scenario(base);
			const settled = await settle(f);
			await f.set(withReceipt(base, FAILED_RECEIPT));
			await f.inspect(3 * INTERVAL);
			const after = expectFinal(f, settled);
			expect(after.result!.lateReceipt).toMatchObject({ status: "failed", settlementKind: name, outcome: { kind: "failed", code: "prompt_failed", message: "late agent failure" } });
			expect(f.events("late_receipt_contradiction")).toHaveLength(1);
			await expect(f.fleet.acceptLateReceipt(f.id, { reason: "operator checked" })).rejects.toThrow("Only a recorded late terminal_ok");
			expect(f.events("late_receipt_accepted")).toHaveLength(0);
			expect(f.store.task(f.id)!.phase).toBe("failed");
		});
	}

	test("late terminal_ok for the same turn of a failed_without_receipt settlement is recorded as terminal_ok", async () => {
		const f = await scenario(failedMissing);
		const settled = await settle(f);
		await f.set(lateOk(failedMissing));
		await f.inspect(2 * INTERVAL);
		expect(expectFinal(f, settled).result!.lateReceipt).toMatchObject({ status: "terminal_ok", settlementKind: "failed_without_receipt" });
	});

	const notThisTurn: Array<[string, (s: Shape) => void]> = [
		["different turn id on read", (s) => { s.turn.turn.turn_id = "other-turn"; }],
		["a different runtime turn now delivered for this turn", (s) => { s.turn.turn.delivery.runtime_turn_id = "runtime-turn-2"; }],
		["a different runtime command now delivered", (s) => { s.turn.turn.delivery.runtime_command_id = "runtime-command-2"; }],
		["receipt record bound to another command", (s) => { s.execution.commandId = "runtime-command-OTHER"; }],
		["receipt record bound to another runtime turn", (s) => { s.execution.turnId = "runtime-turn-OTHER"; }],
		["different session id on read", (s) => { s.turn.turn.session_id = "other-session"; }],
		["different session in session_state", (s) => { s.turn.session_state.session_id = "other-session"; }],
		["receipt present but not a genuine receipt (bad outcome)", (s) => { s.execution.outcome = { kind: "stopped", reason: "made_up", provenance: "agent" }; }],
		["receipt still pending", (s) => { s.execution.receiptState = "pending"; }],
	];
	for (const [name, mutate] of notThisTurn) {
		test(`late terminal_ok that is not this turn's receipt is never recorded: ${name}`, async () => {
			const f = await scenario(olderCompleted);
			const settled = await settle(f);
			const s = lateOk(olderCompleted);
			mutate(s);
			await f.set(s);
			for (const ms of [2 * INTERVAL, 3 * INTERVAL]) expect(await f.inspect(ms)).toEqual(settled);
			expect(f.store.task(f.id)!.result!.lateReceipt).toBeUndefined();
			expect(f.events("late_receipt_contradiction")).toHaveLength(0);
			expectFinal(f, settled);
			// Only read-only routes were used.
			for (const call of await f.executionCalls()) expect(call.argv.slice(0, 4)).toEqual(["sdk", "session", "raw", "query"]);
			const calls = (await f.coordinator()).calls;
			expect(calls.filter((c) => c.name === "gjc_coordinator_send_prompt")).toHaveLength(1);
			expect(calls.filter((c) => c.name === "gjc_coordinator_stop_session")).toHaveLength(0);
		});
	}

	test("a failed late read changes nothing and a later read inside the window still records", async () => {
		const f = await scenario(failedMissing);
		const settled = await settle(f);
		await f.set(lateOk(failedMissing), { lose: "read" } as any);
		const failed = await f.poll(2 * INTERVAL);
		expect(failed.lateReceipt).toEqual({ checked: false });
		expect(failed.task).toEqual(settled);
		expect(f.store.task(f.id)!.reason).toBeUndefined();
		await f.set(lateOk(failedMissing));
		await f.inspect(3 * INTERVAL);
		expect(expectFinal(f, settled).result!.lateReceipt?.status).toBe("terminal_ok");
	});

	test("late observation is bounded: exactly the window end still reads, after it and before settlement nothing is read", async () => {
		const f = await scenario(failedMissing);
		const settled = await settle(f);
		const until = INTERVAL + LATE_RECEIPT_WINDOW_MS;
		let reads = await f.reads();
		await f.inspect(until);
		expect(await f.reads()).toBe(reads + 1);
		await f.set(lateOk(failedMissing));
		reads = await f.reads();
		for (const ms of [until + 1, until + 10 * INTERVAL, 0, INTERVAL - 1]) expect(await f.inspect(ms)).toEqual(settled);
		expect(await f.reads()).toBe(reads);
		expect(f.store.task(f.id)!.result!.lateReceipt).toBeUndefined();
		expect(f.events("late_receipt_contradiction")).toHaveLength(0);
	});

	test("the store records one contradiction per receipt; a different second receipt is audited as a conflict, the first is kept", async () => {
		const f = await scenario(failedMissing);
		await settle(f);
		const base = { sessionId: SESSION, turnId: TURN, runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1", observedAt: new Date(T0).toISOString(), terminalAt: 5, outcome: { kind: "stopped" } };
		const first = f.store.recordLateReceipt(f.id, { ...base, status: "terminal_ok", digest: "a".repeat(64) });
		expect(f.store.recordLateReceipt(f.id, { ...base, status: "terminal_ok", digest: "a".repeat(64) })).toEqual(first);
		f.store.recordLateReceipt(f.id, { ...base, status: "failed", digest: "b".repeat(64) });
		expect(f.store.task(f.id)!.result!.lateReceipt).toMatchObject({ status: "terminal_ok", digest: "a".repeat(64) });
		expect(f.events("late_receipt_contradiction")).toHaveLength(1);
		expect(f.events("late_receipt_conflict")[0]!.data).toMatchObject({ recordedDigest: "a".repeat(64), digest: "b".repeat(64) });
		expect(() => f.store.recordLateReceipt(f.id, { ...base, runtimeCommandId: "other", status: "terminal_ok", digest: "c".repeat(64) })).toThrow("exact settled session");
		expect(f.store.task(f.id)!.phase).toBe("failed");
	});

	test("late receipts are refused for tasks that were not settled without a receipt", async () => {
		const normal = clone(failedMissing);
		normal.turn.turn.final_response = { source: "agent_end" };
		normal.turn.advisory_status.live = true;
		normal.execution.receiptState = "present";
		const f = await scenario(normal);
		expect(await f.inspect(0)).toMatchObject({ phase: "failed", held: false });
		expect(() => f.store.recordLateReceipt(f.id, { sessionId: SESSION, turnId: TURN, runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1",
			observedAt: new Date(T0).toISOString(), terminalAt: 5, outcome: {}, status: "terminal_ok", digest: "a".repeat(64) })).toThrow("receipt-less failed settlements");
		const reads = await f.reads();
		await f.inspect(INTERVAL);
		expect(await f.reads()).toBe(reads);
	});
});

describe("operator acceptance of a late terminal_ok receipt", () => {
	test("audited acceptance sends the task through the NORMAL verifier; never automatic success, slot never re-taken", async () => {
		const f = await scenario(olderCompleted);
		const settled = await settle(f);
		await expect(f.fleet.acceptLateReceipt(f.id, { reason: "checked" })).rejects.toThrow("Only a recorded late terminal_ok");
		await f.set(lateOk(olderCompleted));
		await f.inspect(2 * INTERVAL);
		await expect(f.fleet.acceptLateReceipt(f.id, { reason: " " })).rejects.toThrow("Audited operator reason required");
		const accepted = await f.fleet.acceptLateReceipt(f.id, { reason: "late receipt matches workspace" }, "alice");
		expect(accepted).toMatchObject({ phase: "completed_unverified", held: false, result: { status: "completed_unverified", executionTerminal: true, verified: false } });
		expect(accepted.result!.settlement).toEqual(settled.result!.settlement);
		expect(accepted.result!.lateReceipt!.acceptance).toMatchObject({ actor: "alice", reason: "late receipt matches workspace" });
		expect((accepted.result!.evidence as any).execution).toMatchObject({ receiptState: "present", status: "terminal_ok" });
		const audit = f.events("late_receipt_accepted");
		expect(audit).toHaveLength(1);
		expect(audit[0]!.data).toMatchObject({ actor: "alice", before: "failed", after: "completed_unverified", verifier: "required", priorEvidenceDigest: digest(settled.result!.evidence) });
		expect(f.released()).toBe(1);
		expect([...f.store.heldCharges().values()].flat().length).toBe(0);
		// Repeating the same acceptance is idempotent; a different one is refused.
		expect(await f.fleet.acceptLateReceipt(f.id, { reason: "late receipt matches workspace" }, "alice")).toEqual(accepted);
		await expect(f.fleet.acceptLateReceipt(f.id, { reason: "other" }, "bob")).rejects.toThrow("already accepted");
		// Not archivable now (normal rule: only failed/unknown), not re-observed by inspect.
		const reads = await f.reads();
		expect(await f.inspect(3 * INTERVAL)).toEqual(accepted);
		expect(await f.reads()).toBe(reads);
		// The normal verifier decides.
		const manifest = await f.fleet.result(f.id, OK_ARGV);
		expect(manifest.status).toBe("verified");
		expect(f.store.task(f.id)).toMatchObject({ phase: "succeeded", held: false, result: { verified: true } });
		expect(f.released()).toBe(1);
	});

	test("a failing verifier after acceptance leaves the task unverified", async () => {
		const f = await scenario(failedMissing);
		await settle(f);
		await f.set(lateOk(failedMissing));
		await f.inspect(2 * INTERVAL);
		await f.fleet.acceptLateReceipt(f.id, { reason: "checked" });
		const manifest = await f.fleet.result(f.id, [process.execPath, "--eval", "process.exit(3)"]);
		expect(manifest.status).not.toBe("verified");
		expect(f.store.task(f.id)).toMatchObject({ phase: "completed_unverified", result: { verified: false } });
	});

	test("acceptance re-proves the receipt on a fresh exact read", async () => {
		const f = await scenario(olderCompleted);
		await settle(f);
		await f.set(lateOk(olderCompleted));
		await f.inspect(2 * INTERVAL);
		const changed = lateOk(olderCompleted);
		changed.execution.terminalAt += 1;
		await f.set(changed);
		await expect(f.fleet.acceptLateReceipt(f.id, { reason: "checked" })).rejects.toThrow("differs from the recorded late receipt");
		const gone = lateOk(olderCompleted);
		gone.turn.turn.delivery.runtime_turn_id = "runtime-turn-2";
		await f.set(gone);
		await expect(f.fleet.acceptLateReceipt(f.id, { reason: "checked" })).rejects.toThrow("no longer shows a genuine terminal_ok");
		expect(f.store.task(f.id)).toMatchObject({ phase: "failed", result: { verified: false } });
		expect(f.events("late_receipt_accepted")).toHaveLength(0);
	});

	test("CLI shows settlement and late receipt, and accept-late-receipt is the audited operator path", async () => {
		const f = await scenario(olderCompleted);
		await settle(f);
		await f.set(lateOk(olderCompleted));
		await f.inspect(2 * INTERVAL);
		const run = async (...args: string[]) => {
			const p = Bun.spawn([process.execPath, cliPath, "--db", f.dbPath, ...args], { stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			return { code, out: out ? JSON.parse(out) : undefined, err };
		};
		const shown = await run("show", f.id);
		expect(shown.code).toBe(0);
		expect(shown.out).toMatchObject({ phase: "failed", held: false, result: { settlement: { kind: "ended_without_receipt" }, lateReceipt: { status: "terminal_ok", digest: f.store.task(f.id)!.result!.lateReceipt!.digest } } });
		expect((await run("task", "accept-late-receipt", f.id)).code).toBe(1);
		const accepted = await run("task", "accept-late-receipt", f.id, "--reason", "cli operator check");
		expect(accepted.code).toBe(0);
		expect(accepted.out).toMatchObject({ phase: "completed_unverified", result: { lateReceipt: { acceptance: { actor: "operator", reason: "cli operator check" } } } });
		const events = await run("events", f.id);
		expect(events.out.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["late_receipt_contradiction", "late_receipt_accepted"]));
	});
});

describe("archive interaction", () => {
	for (const [label, base, kind] of [
		["failed/missing", failedMissing, "failed_without_receipt"],
		["completed in_flight/absent", olderCompleted, "ended_without_receipt"],
	] as const) {
		test(`review repro: receipt-less settled task (${label}) is archivable once its session is not live; archive keeps settlement`, async () => {
			const f = await scenario(base);
			await expect(f.fleet.archive(f.id)).rejects.toThrow();
			await settle(f);
			await writeFile(f.executionState + ".list.json", archiveList(f.repo, true));
			await expect(f.fleet.archive(f.id)).rejects.toThrow("still live");
			await writeFile(f.executionState + ".list.json", archiveList(f.repo, false));
			const archived = await f.fleet.archive(f.id);
			expect(archived.phase).toBe("archived");
			expect(archived.archivedFrom as any).toMatchObject({ phase: "failed", result: { settlement: { kind } } });
			expect(f.released()).toBe(1);
			// Existing archive rules: archived failed results stay collectable as evidence only.
			expect((await f.fleet.result(f.id)).status).toBe("not_run");
			await expect(f.fleet.result(f.id, OK_ARGV)).rejects.toThrow("without a runtime receipt");
			expect(() => f.store.verifyResult(f.id, { x: 1 })).toThrow("without a runtime receipt");
			expect(f.store.task(f.id)).toMatchObject({ phase: "archived", result: { verified: false } });
			const dash = getDashboardState(f.store);
			expect(dash.tasks.find((t) => t.id === f.id)).toBeUndefined();
			const row = dash.archivedTasks.find((t) => t.id === f.id)!;
			expect(row.phase).toBe("archived");
			expect(row.settlement?.kind).toBe(kind);
			expect(dash.pipeline.outcome).toMatchObject({ succeeded: 0 });
			// An archived task is never re-observed, even inside the window with a receipt present.
			await f.set(lateOk(base));
			const reads = await f.reads();
			const snapshot = f.store.task(f.id)!;
			expect(await f.inspect(3 * INTERVAL)).toEqual(snapshot);
			expect(await f.reads()).toBe(reads);
			expect(f.store.recordLateReceipt(f.id, { sessionId: SESSION, turnId: TURN, runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1",
				observedAt: new Date(T0).toISOString(), terminalAt: 5, outcome: {}, status: "terminal_ok", digest: "a".repeat(64) })).toEqual(snapshot);
			expect(f.events("late_receipt_contradiction")).toHaveLength(0);
			await expect(f.fleet.acceptLateReceipt(f.id, { reason: "checked" })).rejects.toThrow("Archived tasks");
			expect(() => f.store.acceptLateReceipt(f.id, { actor: "operator", reason: "x", digest: "a".repeat(64), evidence: { x: 1 } })).toThrow("Archived tasks");
		});
	}

	test("a settled task with a recorded late receipt is still archivable; the contradiction survives in archivedFrom", async () => {
		const f = await scenario(olderCompleted);
		await settle(f);
		await f.set(lateOk(olderCompleted));
		await f.inspect(2 * INTERVAL);
		await writeFile(f.executionState + ".list.json", archiveList(f.repo, false));
		const archived = await f.fleet.archive(f.id);
		expect(archived.archivedFrom).toMatchObject({ phase: "failed", result: { lateReceipt: { status: "terminal_ok" }, settlement: { kind: "ended_without_receipt" } } });
		expect(f.released()).toBe(1);
		const row = getDashboardState(f.store).archivedTasks.find((t) => t.id === f.id)!;
		expect(row.lateReceipt?.status).toBe("terminal_ok");
		expect(f.store.task(f.id)!.archivedFrom!.result!.lateReceipt).toEqual(f.store.task(f.id)!.result!.lateReceipt!);
	});
});

describe("review repro: (1) running / receipt-capable turns", () => {
	test("receipt goes pending -> present after first poll: normal receipt path, never settlement", async () => {
		const f = await scenario(olderCompleted);
		expect(held(await f.inspect(0))).toBe(true);
		const pending = clone(olderCompleted); pending.execution.receiptState = "pending";
		await f.set(pending);
		expect(held(await f.inspect(30_000))).toBe(true);
		await f.set(lateOk(olderCompleted));
		const t = await f.inspect(INTERVAL);
		expect(t.phase).toBe("completed_unverified");
		expect(t.result).toMatchObject({ executionTerminal: true });
		expect((t.result as any).settlement).toBeUndefined();
		expect(f.released()).toBe(1);
	});

	test("first poll qualifies, then receipt becomes present at the 2nd poll: normal path wins", async () => {
		const f = await scenario(olderCompleted);
		expect(held(await f.inspect(0))).toBe(true);
		await f.set(lateOk(olderCompleted));
		const t = await f.inspect(INTERVAL);
		expect((t.result as any).settlement).toBeUndefined();
		expect(t.phase).toBe("completed_unverified");
	});

	test("streaming resumes between polls -> held; new turn on same session (last_turn_id) -> held", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		const streaming = clone(failedMissing); streaming.turn.advisory_status.is_streaming = true; streaming.turn.session_state.current_turn_id = "turn-2";
		await f.set(streaming);
		expect(held(await f.inspect(INTERVAL))).toBe(true);
		const after = clone(failedMissing); after.turn.session_state.last_turn_id = "turn-2";
		await f.set(after);
		for (const ms of [2 * INTERVAL, 4 * INTERVAL]) expect(held(await f.inspect(ms))).toBe(true);
		expect(f.released()).toBe(0);
	});

	test("tools become active between polls -> held and candidate resets", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		const tools = clone(failedMissing); tools.turn.session_state.active_tool_count = 2;
		await f.set(tools);
		expect(held(await f.inspect(INTERVAL))).toBe(true);
		await f.set(failedMissing);
		expect(held(await f.inspect(INTERVAL + 1000))).toBe(true);
		expect(held(await f.inspect(2 * INTERVAL))).toBe(true);
		expect((await f.inspect(2 * INTERVAL + 1000)).phase).toBe("failed");
	});

	test("delivery bound to another command id: the turn.result read is for that id and the fingerprint covers it", async () => {
		const f = await scenario(failedMissing);
		const other = clone(failedMissing); other.turn.turn.delivery.runtime_command_id = "runtime-command-OTHER";
		await f.set(other);
		for (const ms of [0, INTERVAL, 2 * INTERVAL]) await f.inspect(ms);
		const t = f.store.task(f.id)!;
		expect(["failed", "completed_unverified"]).toContain(t.phase);
		if (t.phase === "failed") expect((t.result!.evidence as any).execution.commandId).toBe("runtime-command-OTHER");
	});

	test("F7a fixed: an intermediate transport failure (blocked_unknown) RESETS the candidate", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		await f.set(failedMissing, { lose: "read" } as any);
		const blocked = await f.inspect(30_000);
		expect(blocked.phase).toBe("blocked_unknown");
		await f.set(failedMissing);
		const restarted = await f.inspect(INTERVAL);
		expect(held(restarted)).toBe(true);
		expect((restarted.result!.evidence as any).receiptless).toMatchObject({ firstObservedAt: T0 + INTERVAL, confirmed: false });
		expect(held(await f.inspect(2 * INTERVAL - 1))).toBe(true);
		const t = await f.inspect(2 * INTERVAL);
		expect(t.phase).toBe("failed");
		expect((t.result!.evidence as any).receiptless).toMatchObject({ firstObservedAt: T0 + INTERVAL, observedAt: T0 + 2 * INTERVAL });
		expect(f.released()).toBe(1);
	});

	test("F7a fixed: an incomplete questions read in between also resets the candidate", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		await f.set(failedMissing, { questionsComplete: false });
		const unknown = await f.inspect(30_000);
		expect(unknown).toMatchObject({ held: true, phase: "blocked_unknown" });
		await f.set(failedMissing, { questionsComplete: true });
		expect(held(await f.inspect(INTERVAL))).toBe(true);
		expect((await f.inspect(2 * INTERVAL)).phase).toBe("failed");
	});
});

describe("review repro: (1b) liveness of the SDK view (F4, F9)", () => {
	test("F4 fixed: completed turn + 'completed' session + advisory live:false (stale SDK view) never settles", async () => {
		const s = clone(olderCompleted); s.turn.advisory_status.live = false;
		const f = await scenario(s);
		for (const ms of [0, INTERVAL, 3 * INTERVAL]) expect(held(await f.inspect(ms))).toBe(true);
		expect(f.released()).toBe(0);
	});

	test("F4: completed turn on an ended session with ended_at settles without a live view", async () => {
		const s = clone(olderCompleted);
		delete s.turn.advisory_status.live;
		Object.assign(s.turn.session_state, { state: "ended", ended_at: "2026-11-12T09:41:08.000Z" });
		const f = await scenario(s);
		const settled = await settle(f);
		expect(settled.result!.settlement!.kind).toBe("ended_without_receipt");
	});

	test("F9 fixed: a per-read volatile field inside advisory_status/activity no longer prevents settlement", async () => {
		const f = await scenario(failedMissing);
		for (let i = 0; i < 2; i++) {
			const s = clone(failedMissing);
			s.turn.advisory_status.observed_at = new Date(T0 + i * INTERVAL).toISOString();
			s.turn.session_state.activity.age_ms = 1000 + i;
			await f.set(s);
			const t = await f.inspect(i * INTERVAL);
			expect(t.phase).toBe(i === 0 ? "completed_unverified" : "failed");
		}
		expect(f.released()).toBe(1);
	});
});

describe("review repro: (2) two-observation rule", () => {
	test("polls 59.9 s apart never settle; 60.0 s does", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		expect(held(await f.inspect(59_900))).toBe(true);
		expect(held(await f.inspect(59_999))).toBe(true);
		expect((await f.inspect(60_000)).phase).toBe("failed");
	});

	test("two different processes (separate OS processes, same DB) with restart between polls", async () => {
		const f = await scenario(failedMissing);
		f.store.close();
		const script = join(f.repo.dir, "poll.ts");
		const src = fileURLToPath(new URL("../src/", import.meta.url));
		await writeFile(script, `import { Fleet } from ${JSON.stringify(src + "fleet.ts")};
import { FleetStore } from ${JSON.stringify(src + "store.ts")};
const store = new FleetStore(process.argv[2]);
const fleet = new Fleet(store, { clock: () => Number(process.argv[4]) } as any);
const t = (await fleet.inspect(process.argv[3])).task;
console.log(JSON.stringify({ phase: t.phase, held: t.held, pid: process.pid, released: store.events(t.id).filter(e => e.kind === "released").length }));
store.close();`);
		const run = async (now: number) => {
			const p = Bun.spawn([process.execPath, script, f.dbPath, f.id, String(now)], { stdout: "pipe", stderr: "pipe" });
			const out = await new Response(p.stdout).text();
			expect(await p.exited).toBe(0);
			return JSON.parse(out.trim().split("\n").pop()!);
		};
		const a = await run(T0);
		expect(a).toMatchObject({ phase: "completed_unverified", held: true, released: 0 });
		const b = await run(T0 + INTERVAL);
		expect(b).toMatchObject({ phase: "failed", held: false, released: 1 });
		expect(b.pid).not.toBe(a.pid);
		const c = await run(T0 + 2 * INTERVAL);
		expect(c).toMatchObject({ phase: "failed", released: 1 });
	});

	test("F7b residual (documented): a second process 60 s ahead confirms early; a later contradiction is still recorded", async () => {
		const f = await scenario(failedMissing);
		expect(held(await f.inspect(0))).toBe(true);
		const store2 = new FleetStore(f.dbPath);
		cleanups.push(() => store2.close());
		const fleet2 = new Fleet(store2, { clock: () => T0 + INTERVAL + 1 } as any);
		const t = (await fleet2.inspect(f.id)).task;
		expect(t.phase).toBe("failed");
		await f.set(lateOk(failedMissing));
		await fleet2.inspect(f.id);
		expect(f.store.task(f.id)!.result!.lateReceipt?.status).toBe("terminal_ok");
		expect(f.store.task(f.id)!.phase).toBe("failed");
	});

	test("F7c residual (documented): an identical cached read replayed twice >=60 s apart settles", async () => {
		const f = await scenario(failedMissing);
		await f.inspect(0);
		expect((await f.inspect(INTERVAL)).phase).toBe("failed");
	});

	test("F8 trust boundary: a planted candidate must match the last APPLIED poll; one that does still settles (trusted store caller)", async () => {
		const f = await scenario(failedMissing);
		await f.inspect(0);
		const fp = (f.store.task(f.id)!.result!.evidence as any).receiptless.fingerprint;
		const plant = (pollOffset: number) => {
			const seq = f.store.beginObservation(f.id)!;
			const prior = f.store.task(f.id)!.result!.evidence as any;
			const body = {
				sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: false,
				evidence: { ...prior, receiptless: { ...prior.receiptless, fingerprint: fp, firstObservedAt: T0 - 10 * INTERVAL, firstPoll: 0, observedAt: T0 + 1, poll: seq + pollOffset, confirmed: false } },
			};
			f.store.observe(f.id, { ...body, eventId: f.attemptId + ":forge:" + seq, digest: observationDigest(body) }, seq);
		};
		plant(-1); // the reviewer's plant: candidate claims an earlier poll than the applied one
		expect(held(await f.inspect(2_000))).toBe(true);
		plant(0);
		expect((await f.inspect(3_000)).phase).toBe("failed");
	});

	test("F8 trust boundary: observe() with a settlement directly, no read at all (pre-existing trust in store callers)", async () => {
		const f = await scenario(failedMissing);
		const seq = f.store.beginObservation(f.id)!;
		const body = {
			sessionId: SESSION, turnId: TURN, status: "failed" as const, terminal: true,
			evidence: { forged: true },
			settlement: { kind: "failed_without_receipt" as const, receiptState: "missing", cause: "forged", settledAt: new Date(T0).toISOString(), lateObservationUntil: new Date(T0).toISOString() },
		};
		const t = f.store.observe(f.id, { ...body, eventId: f.attemptId + ":forge:" + seq, digest: observationDigest(body) }, seq);
		expect(t).toMatchObject({ phase: "failed", held: false });
		const bad = { ...body, settlement: { ...body.settlement, lateObservationUntil: new Date(T0 - 1).toISOString() } };
		expect(() => f.store.observe(f.id, { ...bad, eventId: f.attemptId + ":forge-bad", digest: observationDigest(bad) })).toThrow("Receipt-less settlement must be");
	});

	test("concurrent inspectors in one process: one settlement, one release, no throw", async () => {
		const f = await scenario(failedMissing);
		await f.inspect(0);
		f.setNow(INTERVAL);
		const results = await Promise.allSettled([f.fleet.inspect(f.id), f.fleet.inspect(f.id), f.fleet.inspect(f.id)]);
		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
		const t = f.store.task(f.id)!;
		const stale = f.store.events(f.id).filter((e) => e.kind === "stale_poll").length;
		if (t.phase === "failed") expect(f.released()).toBe(1);
		expect(f.released()).toBeLessThanOrEqual(1);
		const t2 = await f.inspect(INTERVAL + 1000);
		expect(t2.phase).toBe("failed");
		expect(f.released()).toBe(1);
		expect(stale).toBeGreaterThanOrEqual(1);
	});

	test("concurrent inspectors in two stores (two connections) at settlement: exactly one release", async () => {
		const f = await scenario(failedMissing);
		await f.inspect(0);
		const store2 = new FleetStore(f.dbPath);
		cleanups.push(() => store2.close());
		const fleet2 = new Fleet(store2, { clock: () => T0 + INTERVAL } as any);
		f.setNow(INTERVAL);
		const results = await Promise.allSettled([f.fleet.inspect(f.id), fleet2.inspect(f.id)]);
		expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
		await f.inspect(2 * INTERVAL + 2000);
		expect(f.store.task(f.id)!.phase).toBe("failed");
		expect(f.released()).toBe(1);
		expect([...f.store.heldCharges().values()].flat().length).toBe(0);
	});

	test("explicit interleaving: an older poll's confirmation is fenced by a newer concurrent poll whose read fails; the candidate restarts", async () => {
		const f = await scenario(failedMissing);
		await f.inspect(0);
		f.setNow(INTERVAL);
		const older = f.fleet.inspect(f.id); // issues poll 2 before its first await, then reads a confirming turn
		const newer = f.store.beginObservation(f.id)!; // a second inspector issues poll 3 before poll 2 applies
		expect((await older).task).toMatchObject({ phase: "completed_unverified", held: true, pollIssued: 3, pollApplied: 1 });
		expect(f.events("stale_poll").map((e) => (e.data !== null && typeof e.data === "object" && !Array.isArray(e.data) ? e.data.sequence : undefined))).toEqual([2]);
		// Poll 3's read fails (on the Windows fixture: the coordinator process exited): it decides, as unknown.
		const unknown = f.store.markObservationUnknown(f.id, newer, "observation_unavailable_original_attempt_held", { source: "Fleet.inspect.read_turn", errorType: "transport_error", certainty: "unknown" });
		expect(unknown).toMatchObject({ phase: "blocked_unknown", held: true, pollApplied: 3 });
		expect(f.released()).toBe(0);
		// The next good poll pairs with nothing: one observation, not settled, never success.
		const restarted = await f.inspect(INTERVAL + 1000);
		expect(restarted).toMatchObject({ phase: "completed_unverified", held: true, pollApplied: 4 });
		expect((restarted.result!.evidence as any).receiptless).toMatchObject({ firstPoll: 4, firstObservedAt: T0 + INTERVAL + 1000, confirmed: false });
		expect(held(await f.inspect(2 * INTERVAL + 999))).toBe(true);
		const settled = await f.inspect(2 * INTERVAL + 1000);
		expect(settled).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true, verified: false } });
		expect((settled.result!.evidence as any).receiptless).toMatchObject({ firstPoll: 4, poll: 6, confirmed: true });
		expect(f.released()).toBe(1);
	});
});

describe("review repro: (3)(5) never verified, but output retrievable (F3)", () => {
	test("Fleet.result without tests collects unverified evidence; tests, store.verifyResult, recordVerification and terminal rewrites are refused", async () => {
		const f = await scenario(failedMissing);
		await settle(f);
		const manifest = await f.fleet.result(f.id);
		expect(manifest.status).toBe("not_run");
		expect(f.store.task(f.id)).toMatchObject({ phase: "failed", result: { verified: false } });
		await expect(f.fleet.result(f.id, OK_ARGV)).rejects.toThrow("without a runtime receipt");
		expect(() => f.store.verifyResult(f.id, { forged: true })).toThrow("without a runtime receipt");
		expect(() => f.store.recordVerification(f.id, { forged: true } as any)).toThrow();
		const body = { sessionId: SESSION, turnId: TURN, status: "succeeded" as any, terminal: true, evidence: { forged: true } };
		expect(() => f.store.observe(f.id, { ...body, eventId: f.attemptId + ":forge-ok", digest: observationDigest(body) })).toThrow();
		const okBody = { sessionId: SESSION, turnId: TURN, status: "completed_unverified" as const, terminal: true, evidence: { forged: true } };
		expect(() => f.store.observe(f.id, { ...okBody, eventId: f.attemptId + ":forge-ok2", digest: observationDigest(okBody) })).toThrow("immutable");
		expect(f.store.task(f.id)).toMatchObject({ phase: "failed", result: { verified: false, executionTerminal: true } });
		expect(f.store.events(f.id).filter((e) => e.kind === "result_verified")).toHaveLength(0);
	});

	test("ended_without_receipt output is retrievable like a normal failed task; verification only via accepted late receipt", async () => {
		const normal = clone(failedMissing);
		normal.turn.turn.final_response = { source: "agent_end" };
		normal.turn.advisory_status.live = true;
		normal.execution.receiptState = "present";
		const a = await scenario(normal);
		expect(await a.inspect(0)).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true } });
		expect(await a.fleet.result(a.id)).toBeDefined();
		const b = await scenario(olderCompleted);
		expect((await settle(b)).result).toMatchObject({ settlement: { kind: "ended_without_receipt" } });
		const collected = await b.fleet.result(b.id);
		expect(collected.status).toBe("not_run");
		expect(await b.fleet.result(b.id)).toEqual(collected);
		expect(b.store.task(b.id)).toMatchObject({ phase: "failed", result: { verified: false }, resultManifest: collected });
		await expect(b.fleet.result(b.id, OK_ARGV)).rejects.toThrow("without a runtime receipt");
		const names = allMethodNames(b.fleet).filter((n) => /verify|override|accept/i.test(n));
		expect(names.sort()).toEqual(["acceptIncompleteExport", "acceptLateReceipt", "acceptResult"]);
		// The export-review acceptance is no verifier path for a receipt-less settlement either.
		expect(() => b.fleet.acceptIncompleteExport(b.id, { operator: "ops", reviewDigest: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "EXPORT_REVIEW_NOT_REQUIRED" }));
		expect(b.store.task(b.id)).toMatchObject({ phase: "failed", result: { verified: false } });
	});

	test("node slot accounting after settlement: no held charge, dashboard node not holding", async () => {
		const f = await scenario(olderFailed, { existing: true });
		expect([...f.store.heldCharges().values()].flat().length).toBe(1);
		await f.inspect(0); await f.inspect(INTERVAL);
		expect([...f.store.heldCharges().values()].flat().length).toBe(0);
		const d = getDashboardState(f.store);
		expect(d.nodes[0]!.holding).toEqual([]);
		expect(d.nodes[0]!.currentLoad).toBe(0);
	});
});

describe("review repro: (6)(7) clawhip and cause", () => {
	test("F5 fixed: clawhip collect on a receipt-less settled task is refused up front and never fenced as unknown", async () => {
		const THREAD = "1569213398762131521";
		const repo = await repositoryFixture("fleet-receiptless-claw-");
		cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
		const fleetDb = join(repo.dir, "fleet.sqlite");
		const store = new FleetStore(fleetDb); cleanups.push(() => store.close());
		store.putNode({ id: "node", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["controlled"], transport: { command: "must-not-execute", args: [] }, operations: ["read", "write"] } as any);
		const fleet = new Fleet(store);
		const task = fleet.submit({ schemaVersion: 1, key: "claw", caller: "t", repoId: "repo", baseCommit: repo.baseCommit, prompt: "p", required: {} });
		const control = new ClawhipControl(join(repo.dir, "control.sqlite"), { thread: THREAD, fleetDb }, true); cleanups.push(() => control.close());
		const start = { schema: 1, thread: THREAD, key: "start-1", action: "start", binding: controlBinding(task), testArgv: null } as any;
		let results = 0;
		const executor = {
			async start(id: string) {
				store.setWorkspace(id, { injected: true });
				store.recordSession(id, SESSION, true); store.recordTurn(id, TURN);
				const body = { sessionId: SESSION, turnId: TURN, status: "active" as const, terminal: false, evidence: { injected: true } };
				return store.observe(id, { ...body, eventId: "inj-start", digest: observationDigest(body) });
			},
			async inspect(id: string) { return { task: store.task(id)! }; },
			result: (id: string, argv: string[]) => { results++; return fleet.result(id, argv); },
		};
		const staged = control.stage(start, store); control.ingest({ command_ref: staged.command_ref });
		expect((await control.run("start-1", store, executor as any)).state).toBe("done");
		const body = { sessionId: SESSION, turnId: TURN, status: "failed" as const, terminal: true, evidence: { injected: true },
			settlement: { kind: "failed_without_receipt" as const, receiptState: "missing", cause: "c", settledAt: new Date(T0).toISOString(), lateObservationUntil: new Date(T0 + LATE_RECEIPT_WINDOW_MS).toISOString() } };
		store.observe(task.id, { ...body, eventId: "inj-settle", digest: observationDigest(body) });
		const collect = { schema: 1, thread: THREAD, key: "collect-1", action: "collect", binding: control.binding(task.id, store), testArgv: [process.execPath, "v.ts"] } as any;
		expect(() => control.stage(collect, store)).toThrow("without a runtime receipt");
		expect(control.snapshot("collect-1")).toBeNull();
		expect(() => control.stage({ ...collect, key: "collect-2" }, store)).toThrow("without a runtime receipt");
		expect(results).toBe(0);
	});

	test("F6 fixed: node-controlled cause text is control-stripped, redacted and bounded; codes stay structured", async () => {
		const shape = clone(failedMissing);
		shape.execution.outcome.message = "token=ghp_SECRETSECRETSECRET \u001b[31mred\u001b[0m Authorization: Bearer abc.def.ghi \u0007" + "x".repeat(200_000);
		shape.turn.session_state.error = { code: "agent_error", message: "api_key=sk-LIVEKEY123456 \u001b]0;title\u0007 crashed" };
		const f = await scenario(shape);
		await f.inspect(0); const t = await f.inspect(INTERVAL);
		const cause = (t.result as any).settlement.cause as string;
		const structured = JSON.stringify((t.result!.evidence as any).receiptless);
		for (const text of [cause, structured]) {
			expect(text).not.toContain("ghp_SECRETSECRETSECRET");
			expect(text).not.toContain("sk-LIVEKEY123456");
			expect(text).not.toContain("abc.def.ghi");
			expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
		}
		expect(cause).toContain("token=[redacted]");
		expect(cause).toContain("red");
		expect(cause.length).toBeLessThanOrEqual(CAUSE_TEXT_LIMIT + 40);
		expect(cause).toContain("chars truncated]");
		expect(structured.length).toBeLessThan(5 * CAUSE_TEXT_LIMIT);
		expect((t.result!.evidence as any).receiptless.cause.outcome).toMatchObject({ code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime" });
		expect((t.result!.evidence as any).receiptless.cause.sessionError).toMatchObject({ code: "agent_error" });
		expect(f.events("observation").every((e) => !JSON.stringify(e.data).includes("SECRET"))).toBe(true);
	});
});

// Fleet is composed as an inheritance chain, so collect names across the whole prototype chain.
function allMethodNames(obj: object): string[] {
	const names = new Set<string>();
	for (let p = Object.getPrototypeOf(obj); p && p !== Object.prototype; p = Object.getPrototypeOf(p))
		for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") names.add(n);
	return [...names];
}
