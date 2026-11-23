import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { ClawhipControl, controlBinding } from "../src/clawhip-control";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { observationDigest } from "../src/core";
import { getDashboardState, getDashboardTask, renderDashboardHtml, type DashboardState } from "../src/dashboard";
import { LATE_RECEIPT_WINDOW_MS } from "../src/execution";
import { Fleet, retainedResult } from "../src/fleet";
import { operatorReleaseResource, returnResources } from "../src/resource-return";
import { FleetStore } from "../src/store";
import { repositoryFixture } from "./fixtures/coordinator";
import type { StackSdkState } from "./fixtures/stack-sdk";

// Interactions between receipt-less settlement + bounded late-receipt observation (A)
// and settled-session resource return (B), through the real Fleet/store/resource-return
// code. CONTROLLED stand-ins only (fixtures/stack-coordinator.ts, fixtures/stack-sdk.ts):
// no live GJC. Both store modes: CLI (release at settlement) and deferTerminalRelease.
const coordinatorPath = fileURLToPath(new URL("./fixtures/stack-coordinator.ts", import.meta.url));
const sdkPath = fileURLToPath(new URL("./fixtures/stack-sdk.ts", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INTERVAL = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const INCARNATION = "b".repeat(64);
const OK_ARGV = [process.execPath, "--eval", "process.exit(0)"];
const RELEASED_UNCONFIRMED = "Released by operator · session end not confirmed (may still be running on the node)";
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
// The same two shapes A's own suite settles: failed/missing and completed in_flight/absent.
const failedMissing: Shape = {
	turn: publicTurn("failed", { state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false }),
	execution: {
		status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512,
		outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "model stream stalled" },
	},
};
const olderCompleted: Shape = { turn: publicTurn("completed", { state: "completed", ready_for_input: true }, { live: true }), execution: { status: "in_flight", receiptState: "absent" } };
const OK_RECEIPT = { status: "terminal_ok", receiptState: "present", terminalAt: 1_763_000_999_000, outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" } };
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
const KINDS = [["failed_without_receipt", failedMissing], ["ended_without_receipt", olderCompleted]] as const;
const MODES = [["cli", false], ["deferred", true]] as const;

async function world(shape: Shape, defer: boolean) {
	const repo = await repositoryFixture("fleet-stack-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const coordinatorState = join(repo.dir, "coordinator.json");
	const sdkState = join(repo.dir, "sdk.json");
	const sdkLog = join(repo.dir, "sdk.log");
	const dbPath = join(repo.dir, "fleet.sqlite");
	await writeFile(coordinatorState, JSON.stringify({ calls: [], readTurn: shape.turn }));
	await writeFile(sdkLog, "");
	const initial: StackSdkState = {
		dbPath, indexSeq: 1, execution: shape.execution,
		session: { present: true, live: true, terminal: false, activity: "idle", endpointGeneration: 1, endpointIncarnation: INCARNATION },
	};
	await writeFile(sdkState, JSON.stringify(initial));
	const node: NodeConfig = {
		id: "alpha", os: process.platform, arch: process.arch, roots: { repo: repo.repo },
		workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true,
		sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [coordinatorPath, coordinatorState] },
		sdkTransport: { command: process.execPath, args: [sdkPath, sdkState, sdkLog, coordinatorState] },
	};
	const store = new FleetStore(dbPath, 2, { deferTerminalRelease: defer });
	cleanups.push(() => store.close());
	store.putNode(node);
	let now = T0;
	const fleet = new Fleet(store, { localNodeId: node.id, clock: () => now } as any);
	const input: TaskInput = { schemaVersion: 1, key: "stack-interaction", caller: "controlled-operator", repoId: "repo", baseCommit: repo.baseCommit, prompt: "CONTROLLED prompt", required: {} };
	const started = await fleet.start(fleet.submit(input).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	// B's precondition: the exact original incarnation was captured before the prompt.
	expect(store.getOperation(started.id, "session-authority")!.payload).toMatchObject({ sessionId: SESSION, endpointGeneration: 1, endpointIncarnation: INCARNATION });
	const id = started.id;
	const sdk = async (): Promise<StackSdkState> => JSON.parse(await readFile(sdkState, "utf8"));
	const sdkCalls = async () => (await readFile(sdkLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const coordinator = async () => JSON.parse(await readFile(coordinatorState, "utf8"));
	const events = (kind: string, s: FleetStore = store) => s.events(id).filter((e) => e.kind === kind);
	return {
		store, fleet, node, dbPath, repo, id,
		setNow(ms: number) { now = T0 + ms; },
		async poll(ms: number) { now = T0 + ms; return fleet.inspect(id); },
		async setSdk(patch: (s: StackSdkState) => void) { const s = await sdk(); patch(s); await writeFile(sdkState, JSON.stringify(s)); },
		async setTurn(turn: Record<string, any> | undefined, gone = false) { await writeFile(coordinatorState, JSON.stringify({ ...(await coordinator()), readTurn: turn, readTurnGone: gone })); },
		sdk, sdkCalls,
		closes: async () => (await sdkCalls()).filter((c) => c.op === "close"),
		lists: async () => (await sdkCalls()).filter((c) => c.op === "list"),
		reads: async () => (await coordinator()).calls.filter((c: any) => c.name === "gjc_coordinator_read_turn").length,
		events,
		released: (s: FleetStore = store) => events("released", s).length,
		charges: () => [...store.heldCharges().values()].flat().length,
		task: (): TaskRecord => store.task(id)!,
		ret: (s: FleetStore = store) => returnResources(s, [id], { paceMs: 0 }),
		cli: async (...args: string[]) => {
			const p = Bun.spawn([process.execPath, cliPath, "--db", dbPath, ...args], { stdout: "pipe", stderr: "pipe" });
			const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
			let parsed: any;
			try { parsed = out ? JSON.parse(out) : undefined; } catch { parsed = out; }
			return { code, out: parsed, err };
		},
	};
}
type World = Awaited<ReturnType<typeof world>>;

/** A's two identical observations >= 60 s apart; mode decides whether the slot is released now. */
async function settleByA(w: World, kind: string, defer: boolean) {
	const first = (await w.poll(0)).task;
	expect(first).toMatchObject({ held: true });
	expect(first.result?.executionTerminal).not.toBe(true);
	const settled = (await w.poll(INTERVAL)).task;
	expect(settled).toMatchObject({ phase: "failed", held: defer, result: { executionTerminal: true, verified: false, settlement: { kind } } });
	expect(w.released()).toBe(defer ? 0 : 1);
	expect(w.charges()).toBe(defer ? 1 : 0);
	return settled;
}

describe("B returns an A-settled task like any other settled task", () => {
	for (const [mode, defer] of MODES)
		for (const [kind, shape] of KINDS)
			test(`${mode}: ${kind} — idle exact session closed once through the incarnation fence, claim durable before send, never re-sent; one release`, async () => {
				const w = await world(shape, defer);
				const settled = await settleByA(w, kind, defer);
				// The only listing so far is Fleet.start's original authority capture.
				expect(await w.lists()).toHaveLength(1);
				// Custody first, exactly as for any settled task: no read, no close before collection.
				expect(await w.ret()).toEqual([{ taskId: w.id, state: "refused", reason: "settlement_custody_or_ownership_missing", refusal: "custody_missing" }]);
				expect(await w.lists()).toHaveLength(1);
				expect(await w.closes()).toHaveLength(0);
				expect((await w.fleet.result(w.id)).status).toBe("not_run");
				const reports = await w.ret();
				expect(reports).toEqual([{ taskId: w.id, state: "returned" }]);
				const closes = await w.closes();
				expect(closes).toHaveLength(1);
				expect(closes[0]).toMatchObject({ durableBeforeSend: true, activity: "idle", input: { sessionId: SESSION, endpointGeneration: 1, endpointIncarnation: INCARNATION, ifIdle: true } });
				expect(closes[0].key).toBe(w.store.getOperation(w.id, "resource-return-close:1")!.key);
				expect((await w.sdk()).session).toMatchObject({ live: false, terminal: true });
				const after = w.task();
				expect(after).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true, verified: false, settlement: settled.result!.settlement } });
				expect(w.released()).toBe(1);
				expect(w.events("released").at(-1)!.data).toMatchObject(defer ? { reason: "resource_return_confirmed" } : { attemptId: after.attemptId });
				expect(w.charges()).toBe(0);
				expect(w.store.resourceReturnStatus(w.id)).toMatchObject({ state: "returned", observedGone: true, observed: "terminal", afterOperatorRelease: false });
				// Never re-sent: a second pass reads the durable confirmation only.
				const listsBefore = (await w.lists()).length;
				expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
				expect(await w.closes()).toHaveLength(1);
				expect(await w.lists()).toHaveLength(listsBefore);
				expect(w.released()).toBe(1);
			});
});

describe("A's bounded late observation after B closed the session", () => {
	for (const [mode, defer] of MODES)
		test(`${mode}: reads stay read-only, a coordinator that forgot the session changes nothing, the window ends cleanly; nothing re-reserved`, async () => {
			const w = await world(olderCompleted, defer);
			await settleByA(w, "ended_without_receipt", defer);
			await w.fleet.result(w.id);
			expect((await w.ret())[0]!.state).toBe("returned");
			const closed = w.task();
			const audit = () => w.store.events(w.id).length;
			// Still inside the window: the exact turn is read, no receipt, no change.
			let reads = await w.reads();
			const quiet = await w.poll(3 * INTERVAL);
			expect(quiet.lateReceipt).toEqual({ checked: true, found: false });
			expect(await w.reads()).toBe(reads + 1);
			expect(w.task()).toEqual(closed);
			// The coordinator no longer knows the closed session.
			await w.setTurn(undefined, true);
			const auditBefore = audit();
			const gone = await w.poll(4 * INTERVAL);
			expect((gone.lateReceipt as any)?.found).not.toBe(true);
			expect(w.task()).toEqual(closed);
			expect(audit()).toBe(auditBefore);
			// The runtime query is unreachable too: still nothing.
			await w.setSdk((s) => { s.executionFails = true; });
			expect(((await w.poll(5 * INTERVAL)).lateReceipt as any)?.found).not.toBe(true);
			expect(w.task()).toEqual(closed);
			// Past the window: no read at all, plain snapshot.
			reads = await w.reads();
			const settledAt = Date.parse(closed.result!.settlement!.settledAt);
			const late = await w.poll(settledAt - T0 + LATE_RECEIPT_WINDOW_MS + 1);
			expect(late).toEqual({ task: closed });
			expect(await w.reads()).toBe(reads);
			expect(w.released()).toBe(1);
			expect(w.task().held).toBe(false);
			expect(w.charges()).toBe(0);
			expect(await w.closes()).toHaveLength(1);
			expect(w.store.resourceReturnStatus(w.id)!.state).toBe("returned");
		});

	for (const [mode, defer] of MODES)
		test(`${mode}: a genuine receipt still readable after the close is recorded (finality kept); acceptance + normal verifier; B state and the single release untouched`, async () => {
			const w = await world(failedMissing, defer);
			await settleByA(w, "failed_without_receipt", defer);
			await w.fleet.result(w.id);
			expect((await w.ret())[0]!.state).toBe("returned");
			const late = lateOk(failedMissing);
			await w.setTurn(late.turn);
			await w.setSdk((s) => { s.execution = late.execution; });
			const seen = await w.poll(2 * INTERVAL);
			expect(seen.lateReceipt).toEqual({ checked: true, found: true });
			expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { lateReceipt: { status: "terminal_ok", settlementKind: "failed_without_receipt" } } });
			expect(w.events("late_receipt_contradiction")).toHaveLength(1);
			const accepted = await w.fleet.acceptLateReceipt(w.id, { reason: "checked after resource return" });
			expect(accepted).toMatchObject({ phase: "completed_unverified", held: false });
			expect((await w.fleet.result(w.id, OK_ARGV)).status).toBe("verified");
			expect(w.task()).toMatchObject({ phase: "succeeded", held: false, result: { verified: true } });
			// The returned task stays returned; no second close, no second release, no charge.
			expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
			expect(await w.closes()).toHaveLength(1);
			expect(w.released()).toBe(1);
			expect(w.charges()).toBe(0);
			const dash = getDashboardState(w.store);
			const row = dash.tasks.find((t) => t.id === w.id)!;
			expect(row).toMatchObject({ phase: "succeeded", held: false, resourceReturn: { state: "returned" }, settlement: { kind: "failed_without_receipt" }, lateReceipt: { status: "terminal_ok" } });
			expect(dash.pipeline.outcome).toMatchObject({ succeeded: 1, unverified: 0, troubled: 0 });
			const node = dash.nodes.find((n) => n.id === "alpha")!;
			expect(node.holding).toEqual([]);
			expect(node.possiblyRunning).toEqual([]);
		});
});

describe("deferred release: A-settled reservation is held until B returns it", () => {
	test("a late receipt observed while the settled slot awaits return is recorded (not refused); acceptance never releases or re-reserves; B releases exactly once", async () => {
		const w = await world(olderCompleted, true);
		await settleByA(w, "ended_without_receipt", true);
		const late = lateOk(olderCompleted);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; });
		const seen = await w.poll(2 * INTERVAL);
		expect(seen.lateReceipt).toEqual({ checked: true, found: true });
		expect(w.task()).toMatchObject({ phase: "failed", held: true, result: { lateReceipt: { status: "terminal_ok" } } });
		expect(w.events("refused")).toHaveLength(0);
		expect(w.events("late_receipt_contradiction")).toHaveLength(1);
		expect(w.released()).toBe(0);
		// Observation ends with the first recorded receipt.
		const reads = await w.reads();
		expect((await w.poll(3 * INTERVAL)).lateReceipt).toBeUndefined();
		expect(await w.reads()).toBe(reads);
		const accepted = await w.fleet.acceptLateReceipt(w.id, { reason: "checked while held" });
		expect(accepted).toMatchObject({ phase: "completed_unverified", held: true, result: { executionTerminal: true } });
		expect(w.released()).toBe(0);
		expect(w.charges()).toBe(1);
		// Dashboard: still holding the node slot, awaiting the verifier; never success.
		let dash = getDashboardState(w.store);
		expect(dash.nodes[0]!.holding.map((t) => t.id)).toEqual([w.id]);
		expect(dash.pipeline.outcome).toMatchObject({ succeeded: 0, unverified: 0, resultMissing: 1 });
		await w.fleet.result(w.id);
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(w.released()).toBe(1);
		expect(w.events("released")[0]!.data).toMatchObject({ reason: "resource_return_confirmed" });
		expect((await w.fleet.result(w.id, OK_ARGV)).status).toBe("verified");
		expect(w.task()).toMatchObject({ phase: "succeeded", held: false });
		expect(w.released()).toBe(1);
		dash = getDashboardState(w.store);
		expect(dash.nodes[0]!.holding).toEqual([]);
		expect(dash.pipeline.outcome).toMatchObject({ succeeded: 1, unverified: 0, troubled: 0 });
	});

	test("mode boundary: only a deferTerminalRelease connection treats a held settled task as settled; a CLI-mode connection still refuses", async () => {
		const w = await world(olderCompleted, true);
		await settleByA(w, "ended_without_receipt", true);
		const late = lateOk(olderCompleted);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; });
		const cli = new FleetStore(w.dbPath);
		cleanups.push(() => cli.close());
		const fleet = new Fleet(cli, { clock: () => T0 + 2 * INTERVAL } as any);
		expect((await fleet.inspect(w.id)).lateReceipt).toEqual({ checked: false });
		expect(w.events("refused").map((e) => e.data)).toEqual([expect.objectContaining({ action: "recordLateReceipt", code: "LATE_RECEIPT_STATE" })]);
		expect(w.task().result!.lateReceipt).toBeUndefined();
		expect((await w.poll(2 * INTERVAL)).lateReceipt).toEqual({ checked: true, found: true });
		await expect(fleet.acceptLateReceipt(w.id, { reason: "cli" })).rejects.toThrow("Only a recorded late terminal_ok receipt");
		expect(w.task()).toMatchObject({ phase: "failed", held: true });
		expect(await w.fleet.acceptLateReceipt(w.id, { reason: "deferred" })).toMatchObject({ phase: "completed_unverified", held: true });
		expect(w.released()).toBe(0);
	});

	test("late observation and a return pass racing on two connections: receipt recorded, session returned, released exactly once", async () => {
		const w = await world(failedMissing, true);
		await settleByA(w, "failed_without_receipt", true);
		await w.fleet.result(w.id);
		const late = lateOk(failedMissing);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; });
		const other = new FleetStore(w.dbPath, 2, { deferTerminalRelease: true });
		cleanups.push(() => other.close());
		w.setNow(2 * INTERVAL);
		const [observed, returned] = await Promise.all([w.fleet.inspect(w.id), w.ret(other)]);
		expect(observed.lateReceipt).toEqual({ checked: true, found: true });
		expect(returned).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { lateReceipt: { status: "terminal_ok" } } });
		expect(w.released()).toBe(1);
		expect(await w.closes()).toHaveLength(1);
		expect(w.events("refused")).toHaveLength(0);
	});
});

describe("busy session of an A-settled task", () => {
	test("never closed while busy (idle fence); A's observation unaffected; closed once when idle; one release", async () => {
		const w = await world(failedMissing, false);
		await settleByA(w, "failed_without_receipt", false);
		await w.fleet.result(w.id);
		await w.setSdk((s) => { s.session.activity = "running"; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "session_busy", reason: "session_not_idle" }]);
		let closes = await w.closes();
		expect(closes).toHaveLength(1);
		expect(closes[0]).toMatchObject({ durableBeforeSend: true, activity: "running", input: { ifIdle: true } });
		expect((await w.sdk()).session).toMatchObject({ present: true, live: true, terminal: false });
		expect((await w.poll(2 * INTERVAL)).lateReceipt).toEqual({ checked: true, found: false });
		expect(w.task()).toMatchObject({ phase: "failed", held: false });
		await w.setSdk((s) => { s.session.activity = "idle"; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		closes = await w.closes();
		expect(closes).toHaveLength(2);
		expect(closes[1]).toMatchObject({ durableBeforeSend: true, activity: "idle" });
		expect(closes[1].key).toBe(w.store.getOperation(w.id, "resource-return-close:2")!.key);
		expect(closes[0].key).not.toBe(closes[1].key);
		expect(w.released()).toBe(1);
	});
});

describe("B operator override on an A-settled task", () => {
	test("cli: settled reservation already released by A — override refused RETURN_NOT_HELD (exit 1), return via CLI closes once (exit 0)", async () => {
		const w = await world(olderCompleted, false);
		await settleByA(w, "ended_without_receipt", false);
		await w.fleet.result(w.id);
		const approval = join(w.repo.dir, "approval.json");
		await writeFile(approval, JSON.stringify({ operator: "op", reason: "unprovable" }));
		const override = await w.cli("return-override", w.id, approval);
		expect(override.code).toBe(1);
		expect(JSON.parse(override.err)).toEqual({ ok: false, error: "RETURN_NOT_HELD" });
		await expect(operatorReleaseResource(w.store, w.id, { operator: "op", reason: "x" })).rejects.toThrow("Reservation is not held");
		expect(w.store.getOperation(w.id, "resource-return-override")).toBeUndefined();
		const ret = await w.cli("return", w.id);
		expect(ret.code).toBe(0);
		expect(ret.out).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(await w.closes()).toHaveLength(1);
		const shown = await w.cli("--read-only", "show", w.id);
		expect(shown.code).toBe(0);
		expect(shown.out).toMatchObject({ phase: "failed", held: false, result: { settlement: { kind: "ended_without_receipt" } }, resourceReturn: { state: "returned" } });
		expect(w.released()).toBe(1);
	});

	test("deferred: listing rules apply unchanged; accepted override releases once; A observation keeps working; return later confirms without a second release", async () => {
		const w = await world(failedMissing, true);
		await settleByA(w, "failed_without_receipt", true);
		const approval = { operator: "op", reason: "node unreachable" };
		// Live and idle with no fenced close tried: run return first.
		await expect(operatorReleaseResource(w.store, w.id, approval)).rejects.toThrow("no fenced close was tried");
		// Live and running a turn: refused.
		await w.setSdk((s) => { s.session.activity = "running"; });
		await expect(operatorReleaseResource(w.store, w.id, approval)).rejects.toThrow("not idle");
		expect(w.task().held).toBe(true);
		expect(w.released()).toBe(0);
		// Listing unavailable: audited release, never "returned".
		await w.setSdk((s) => { s.listFails = true; });
		const released = await operatorReleaseResource(w.store, w.id, approval);
		expect(released).toMatchObject({ state: "released_by_operator_unconfirmed", observedGone: false });
		expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { settlement: { kind: "failed_without_receipt" } } });
		expect(w.released()).toBe(1);
		expect(w.events("released")[0]!.data).toMatchObject({ reason: "resource_return_operator_override" });
		expect(await w.closes()).toHaveLength(0);
		let dash = getDashboardState(w.store);
		let node = dash.nodes[0]!;
		expect(node.holding).toEqual([]);
		expect(node.possiblyRunning.map((t) => t.id)).toEqual([w.id]);
		expect(dash.tasks.find((t) => t.id === w.id)).toMatchObject({ phase: "failed", settlement: { kind: "failed_without_receipt" }, resourceReturn: { state: "released_by_operator_unconfirmed", operator: "op" } });
		expect(dash.pipeline.outcome).toMatchObject({ troubled: 1, succeeded: 0 });
		// A's late observation after the override: recorded, held stays false, no new release.
		const late = lateOk(failedMissing);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; s.listFails = false; });
		expect((await w.poll(2 * INTERVAL)).lateReceipt).toEqual({ checked: true, found: true });
		expect(w.task()).toMatchObject({ held: false, result: { lateReceipt: { status: "terminal_ok" } } });
		expect(w.released()).toBe(1);
		// Session still listed: never closed after an override, stays unconfirmed.
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "released_by_operator_unconfirmed", reason: "session_not_observed_gone" }]);
		expect(await w.closes()).toHaveLength(0);
		// The node ends it (newer index, gone): confirmed after the operator release, no second release.
		await w.setSdk((s) => { s.session.present = false; s.indexSeq += 3; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned", reason: "observed_gone_after_operator_release" }]);
		expect(w.released()).toBe(1);
		expect(w.store.resourceReturnStatus(w.id)).toMatchObject({ state: "returned", afterOperatorRelease: true });
		dash = getDashboardState(w.store);
		node = dash.nodes[0]!;
		expect(node.possiblyRunning).toEqual([]);
		// Acceptance after the override/return path: never re-reserves.
		expect(await w.fleet.acceptLateReceipt(w.id, { reason: "checked" })).toMatchObject({ phase: "completed_unverified", held: false });
		expect(w.released()).toBe(1);
		expect(w.charges()).toBe(0);
	});
});

describe("archive of A-settled tasks with resource return", () => {
	test("cli: returned A-settled task archives; archive releases nothing more; archived task is never re-observed or re-closed", async () => {
		const w = await world(olderCompleted, false);
		await settleByA(w, "ended_without_receipt", false);
		await w.fleet.result(w.id);
		expect((await w.ret())[0]!.state).toBe("returned");
		const archived = await w.fleet.archive(w.id);
		expect(archived).toMatchObject({ phase: "archived", held: false, archivedFrom: { phase: "failed", result: { settlement: { kind: "ended_without_receipt" } } } });
		expect(w.released()).toBe(1);
		const reads = await w.reads();
		expect((await w.poll(2 * INTERVAL)).task.phase).toBe("archived");
		expect(await w.reads()).toBe(reads);
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(await w.closes()).toHaveLength(1);
		const dash = getDashboardState(w.store);
		expect(dash.archivedTasks.find((t) => t.id === w.id)).toMatchObject({ phase: "archived", settlement: { kind: "ended_without_receipt" }, resourceReturn: { state: "returned" } });
		expect(dash.nodes[0]!.possiblyRunning).toEqual([]);
	});

	test("deferred: archive refused while live; archive of a dead-host session releases once; return of the archived task never releases again", async () => {
		const w = await world(failedMissing, true);
		await settleByA(w, "failed_without_receipt", true);
		await w.fleet.result(w.id);
		await expect(w.fleet.archive(w.id)).rejects.toThrow("still live");
		expect(w.task().held).toBe(true);
		// Host gone without a terminal record: archive evidence says not live.
		await w.setSdk((s) => { s.session.live = false; });
		const archived = await w.fleet.archive(w.id);
		expect(archived).toMatchObject({ phase: "archived", held: false });
		expect(w.released()).toBe(1);
		expect(w.events("released")[0]!.data).toMatchObject({ cause: "archived" });
		// live:false without terminal proves nothing for B: unknown, no close, no release.
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "return_unknown", reason: "host_liveness_unproven" }]);
		expect(await w.closes()).toHaveLength(0);
		await w.setSdk((s) => { s.session.present = false; s.indexSeq += 1; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(w.task().phase).toBe("archived");
		expect(w.released()).toBe(1);
		await expect(w.fleet.acceptLateReceipt(w.id, { reason: "x" })).rejects.toThrow("Archived tasks");
	});
});

describe("hand-resolved hunks keep both guards (STACK.md C1, C4)", () => {
	for (const [mode, defer] of MODES)
		test(`${mode}: retainedResult on an A-settled collected task refuses as receipt-less (A), never as merely held (B)`, async () => {
			const w = await world(failedMissing, defer);
			await settleByA(w, "failed_without_receipt", defer);
			await w.fleet.result(w.id);
			// B's relaxation applies only in deferred mode; A's receipt-less refusal applies in both.
			expect(() => retainedResult(w.task(), OK_ARGV, undefined, defer)).toThrow("never verified");
			if (defer) expect(() => retainedResult(w.task(), OK_ARGV, undefined, false)).toThrow("Durable settled result required");
			await expect(w.fleet.result(w.id, OK_ARGV)).rejects.toThrow("without a runtime receipt");
			expect(w.task()).toMatchObject({ phase: "failed", held: defer, result: { verified: false } });
		});

	for (const [mode, defer] of MODES)
		test(`${mode}: Clawhip collect of an A-settled task is refused as receipt-less up front, also while the deferred slot is held`, async () => {
			const THREAD = "1569213398762131521";
			const repo = await repositoryFixture("fleet-stack-claw-");
			cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
			const fleetDb = join(repo.dir, "fleet.sqlite");
			const store = new FleetStore(fleetDb, 2, { deferTerminalRelease: defer }); cleanups.push(() => store.close());
			store.putNode({ id: "node", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["controlled"], transport: { command: "must-not-execute", args: [] }, operations: ["read", "write"] } as any);
			const fleet = new Fleet(store);
			const task = fleet.submit({ schemaVersion: 1, key: "claw", caller: "t", repoId: "repo", baseCommit: repo.baseCommit, prompt: "p", required: {} });
			const control = new ClawhipControl(join(repo.dir, "control.sqlite"), { thread: THREAD, fleetDb }, true); cleanups.push(() => control.close());
			const start = { schema: 1, thread: THREAD, key: "start-1", action: "start", binding: controlBinding(task), testArgv: null } as any;
			const executor = {
				async start(id: string) {
					store.setWorkspace(id, { injected: true });
					store.recordSession(id, SESSION, true); store.recordTurn(id, TURN);
					const body = { sessionId: SESSION, turnId: TURN, status: "active" as const, terminal: false, evidence: { injected: true } };
					return store.observe(id, { ...body, eventId: "inj-start", digest: observationDigest(body) });
				},
				async inspect(id: string) { return { task: store.task(id)! }; },
				result: () => { throw new Error("must not run"); },
			};
			const staged = control.stage(start, store); control.ingest({ command_ref: staged.command_ref });
			expect((await control.run("start-1", store, executor as any)).state).toBe("done");
			const body = { sessionId: SESSION, turnId: TURN, status: "failed" as const, terminal: true, evidence: { injected: true },
				settlement: { kind: "failed_without_receipt" as const, receiptState: "missing", cause: "c", settledAt: new Date(T0).toISOString(), lateObservationUntil: new Date(T0 + LATE_RECEIPT_WINDOW_MS).toISOString() } };
			store.observe(task.id, { ...body, eventId: "inj-settle", digest: observationDigest(body) });
			expect(store.task(task.id)!.held).toBe(defer);
			const collect = { schema: 1, thread: THREAD, key: "collect-1", action: "collect", binding: control.binding(task.id, store), testArgv: [process.execPath, "v.ts"] } as any;
			expect(() => control.stage(collect, store)).toThrow("Execution ended without a runtime receipt; never verified");
			expect(control.snapshot("collect-1")).toBeNull();
		});
});

// Executes the public page's own script with local DOM adapters (as dashboard-completion-labels.test.ts).
class Element {
	innerHTML = "";
	textContent = "";
	className = "";
	lastElementChild = { textContent: "" };
	classList = { add() {}, remove() {}, toggle() {} };
	addEventListener() {}
}
async function select(html: string, selector: string) {
	const matches: Array<{ text: string; className: string }> = [];
	await new HTMLRewriter().on(selector, {
		element(element) { matches.push({ text: "", className: element.getAttribute("class") ?? "" }); },
		text(chunk) { matches[matches.length - 1]!.text += chunk.text; },
	}).transform(new Response(html)).text();
	return matches;
}
async function render(state: DashboardState) {
	const elements = new Map<string, Element>();
	let script = "";
	await new HTMLRewriter()
		.on("[id]", { element(element) { elements.set(element.getAttribute("id")!, new Element()); } })
		.on("script", { text(chunk) { script += chunk.text; } })
		.transform(new Response(renderDashboardHtml())).text();
	runInNewContext(script, {
		document: { getElementById: (id: string) => elements.get(id)!, body: new Element(), querySelector: () => new Element(), querySelectorAll: () => [] },
		fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(state)) }),
		WebSocket: class {},
		location: { protocol: "http:", host: "dashboard.invalid" },
		setTimeout: () => 0,
		setInterval: () => 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	return { tasks: elements.get("tasks")!.innerHTML, nodes: elements.get("nodes")!.innerHTML, outcome: elements.get("outcome")!.innerHTML };
}

describe("dashboard labels and counts with both features' fields", () => {
	test("returned A-settled task: failure label + cause + returned row; override: possibly-running sub-line and node chip; counts", async () => {
		const returned = await world(olderCompleted, false);
		await settleByA(returned, "ended_without_receipt", false);
		await returned.fleet.result(returned.id);
		await returned.ret();
		let view = await render(getDashboardState(returned.store));
		const label = "Ended · no execution receipt · not a success";
		expect((await select(view.tasks, ".tk-head .chip"))[0]).toEqual({ text: label, className: "chip bad" });
		// Collapsed cards keep the failure chip; returned/settlement kv rows mount after expand.
		expect(view.tasks).not.toContain("Released by operator");
		expect((await select(view.outcome, ".chip")).map((c) => c.text)).toContain("Failed / state unknown 1");

		const overridden = await world(failedMissing, true);
		await settleByA(overridden, "failed_without_receipt", true);
		view = await render(getDashboardState(overridden.store));
		// Held while awaiting return: the node's holding chip shows the failed phase (holding
		// entries carry no settlement field, so A's phaseLabel falls back to the phase label).
		expect((await select(view.nodes, ".hold .chip")).map((c) => c.text)).toEqual(["stack-interaction · Failed"]);
		expect((await select(view.tasks, ".tk-sub"))[0]!.text).toContain("slot held");
		await overridden.setSdk((s) => { s.listFails = true; });
		await operatorReleaseResource(overridden.store, overridden.id, { operator: "op<b>", reason: "unreachable" });
		const late = lateOk(failedMissing);
		await overridden.setTurn(late.turn);
		await overridden.setSdk((s) => { s.execution = late.execution; });
		await overridden.poll(2 * INTERVAL);
		view = await render(getDashboardState(overridden.store));
		expect((await select(view.tasks, ".tk-head .chip"))[0]).toEqual({ text: "Failed · no execution receipt · late receipt terminal_ok", className: "chip bad" });
		expect((await select(view.tasks, ".tk-sub"))[0]!.text).toContain(RELEASED_UNCONFIRMED);
		expect((await select(view.tasks, ".tk-sub"))[0]!.text).not.toContain("slot held");
		expect((await select(view.nodes, ".hold .chip")).map((c) => c.text)).toEqual([`stack-interaction · ${RELEASED_UNCONFIRMED}`]);
		// Live cards keep attention kinds pre-expand; full audit / kv still loads via /api/task.
		expect(view.tasks).toContain("Late execution receipt · contradicts final result");
		expect(getDashboardTask(overridden.store, overridden.id)!.timeline.some((e) => e.kind === "late_receipt_contradiction")).toBe(true);
		expect((await select(view.outcome, ".chip")).map((c) => c.text)).toContain("Failed / state unknown 1");
	});
});
