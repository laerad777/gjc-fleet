import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { headroom } from "./admission-fixture";
import type { Json, NodeConfig, SessionAuthority, TaskInput, TaskRecord } from "../src/contracts";
import { observationDigest } from "../src/core";
import { LATE_RECEIPT_WINDOW_MS } from "../src/execution";
import { Fleet } from "../src/fleet";
import { MAX_CLOSE_ATTEMPTS, REFUSAL_CODES, returnResources, type ReturnConnection, type ReturnReport } from "../src/resource-return";
import { TransportError } from "../src/rpc";
import { getDashboardState } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { sha256 } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";
import type { StackSdkState } from "./fixtures/stack-sdk";

// Held-return lane, round 3. No settled attempt is closed (and its slot returned) WITHOUT collected
// custody: every attempt `return` accepts ran a turn, so the node may hold its uncollected work. That
// includes an exact settled FAILED or deadline-exceeded runtime receipt and a COMPLETED public turn
// whose runtime receipt failed. Every refusal is reported with a stable code and recorded once per change.
// Part 1 drives the real Fleet.start / Fleet.inspect / returnResources / store code against CONTROLLED
// stand-ins (fixtures/stack-coordinator.ts, fixtures/stack-sdk.ts; not GJC). Part 2 enumerates the
// decision table and the limits on a temporary SQLite store with an in-memory broker model of the
// public session.list / fenced session.close contract. Wall time is set with setSystemTime so the
// Fleet clock and the store clock are ONE clock; it is reset after every test.
const HOUR = 3_600_000;
const INTERVAL = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	setSystemTime();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const REFUSED = (taskId: string, refusal: string, reason = "settlement_custody_or_ownership_missing"): ReturnReport => ({ taskId, state: "refused", reason, refusal: refusal as any });
const at = (ms: number) => setSystemTime(new Date(ms));
function codeOf(fn: () => unknown): string {
	try {
		fn();
		return "no-throw";
	} catch (error) {
		return String((error as { code?: unknown })?.code ?? error);
	}
}

// ---------------------------------------------------------------- shapes (same as stack-interactions)
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INCARNATION = "b".repeat(64);
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
const errored = { state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false };
const OK_RECEIPT = { status: "terminal_ok", receiptState: "present", terminalAt: 1_763_000_999_000, outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" } };
const FAILED_RECEIPT = { status: "failed", receiptState: "present", terminalAt: 1_763_000_999_500, outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "provider stream interrupted" } };
/** Receipt-less, the runtime command failed but wrote no receipt: settles failed_without_receipt. */
const failedMissing: Shape = {
	turn: publicTurn("failed", errored),
	execution: { status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512, outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "model stream stalled" } },
};
/** Receipt-less, the runtime turn reported COMPLETED: settles ended_without_receipt. */
const olderCompleted: Shape = { turn: publicTurn("completed", { state: "completed", ready_for_input: true }, { live: true }), execution: { status: "in_flight", receiptState: "absent" } };
/** A turn the runtime itself ended failed WITH its receipt: the exact failed receipt. */
function receiptTurn(execution: Record<string, any>): Shape {
	const turn = publicTurn("failed", errored, { live: true });
	(turn.turn as any).final_response = { source: "agent_end" };
	return { turn, execution: clone(execution) };
}
const exactFailed = receiptTurn(FAILED_RECEIPT);
const DEADLINE_RECEIPT = { status: "failed", receiptState: "present", terminalAt: 1_763_000_999_700, outcome: { kind: "failed", code: "prompt_deadline_exceeded", provenance: "deadline", message: "prompt deadline exceeded" } };
const exactDeadline = receiptTurn(DEADLINE_RECEIPT);
/** The public turn COMPLETED (agent_end) while the runtime command's own receipt is an exact failed
 * receipt: inspect settles phase "failed" (either side failed). */
const completedTurnFailedReceipt: Shape = { turn: publicTurn("completed", { state: "completed", ready_for_input: true }, { live: true }), execution: clone(FAILED_RECEIPT) };
/** Public turn failed but the runtime command's own receipt is terminal_ok: phase "failed", a possible success. */
const failedTurnOkReceipt = receiptTurn(OK_RECEIPT);

// ---------------------------------------------------------------- Part 1 world: real Fleet + store + resource return
const coordinatorPath = fileURLToPath(new URL("./fixtures/stack-coordinator.ts", import.meta.url));
const sdkPath = fileURLToPath(new URL("./fixtures/stack-sdk.ts", import.meta.url));
async function world(shape: Shape, defer: boolean) {
	at(T0);
	const repo = await repositoryFixture("fleet-held-return-");
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
	// No injected clock: Fleet and store both read Date.now (set by setSystemTime).
	const fleet = new Fleet(store, { localNodeId: node.id } as any);
	const input: TaskInput = { schemaVersion: 1, key: "held-return", caller: "controlled-operator", repoId: "repo", baseCommit: repo.baseCommit, prompt: "CONTROLLED prompt", required: {} };
	const started = await fleet.start(fleet.submit(input).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	expect(store.getOperation(started.id, "session-authority")!.payload).toMatchObject({ sessionId: SESSION, endpointGeneration: 1, endpointIncarnation: INCARNATION });
	const id = started.id;
	const sdk = async (): Promise<StackSdkState> => JSON.parse(await readFile(sdkState, "utf8"));
	const sdkCalls = async () => (await readFile(sdkLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const gate = sdkState + ".gate";
	return {
		store, fleet, id, dbPath,
		async poll(ms: number) { at(T0 + ms); return (await fleet.inspect(id)).task; },
		async setSdk(patch: (s: StackSdkState) => void) { const s = await sdk(); patch(s); await writeFile(sdkState, JSON.stringify(s)); },
		sdk,
		closes: async () => (await sdkCalls()).filter((c) => c.op === "close"),
		lists: async () => (await sdkCalls()).filter((c) => c.op === "list"),
		released: () => store.events(id).filter((e) => e.kind === "released").length,
		charges: () => [...store.heldCharges().values()].flat().length,
		task: (): TaskRecord => store.task(id)!,
		/** The agent's uncollected change in the Fleet worktree on the (local) node. */
		async edit(name: string, body: string) { await writeFile(join((store.task(id)!.workspace as any).path, name), body); },
		ret: (s: FleetStore = store) => returnResources(s, [id], { paceMs: 0 }),
		/** Holds the next turn.result query inside the stand-in until release(). */
		async hold() { await writeFile(gate, "held"); },
		async waitHeld() { for (let i = 0; i < 800 && !existsSync(gate + ".waiting"); i++) await Bun.sleep(10); expect(existsSync(gate + ".waiting")).toBe(true); },
		async release() { await rm(gate, { force: true }); },
		claimCode: () => codeOf(() => store.claimResourceReturnClose(id, 1, { ...(store.getOperation(id, "session-authority")!.payload as any), ifIdle: true })),
	};
}
type World = Awaited<ReturnType<typeof world>>;
async function settleReceiptless(w: World, kind: string, defer: boolean) {
	expect((await w.poll(0)).result?.executionTerminal).not.toBe(true);
	const settled = await w.poll(INTERVAL);
	expect(settled).toMatchObject({ phase: "failed", held: defer, result: { status: "failed", executionTerminal: true, verified: false, settlement: { kind } } });
	expect(Date.parse(settled.result!.settlement!.lateObservationUntil)).toBe(T0 + INTERVAL + LATE_RECEIPT_WINDOW_MS);
	return settled;
}
const MODES = [["cli", false], ["deferred", true]] as const;

describe("F1 (real inspect path): a receipt-less turn the runtime reported COMPLETED is never closed without custody", () => {
	for (const [mode, defer] of MODES)
		test(`${mode}: ended_without_receipt after its late-receipt window: refused custody_missing, no listing, no close; custody first still returns it`, async () => {
			const w = await world(olderCompleted, defer);
			const settled = await settleReceiptless(w, "ended_without_receipt", defer);
			const until = Date.parse(settled.result!.settlement!.lateObservationUntil);
			for (const now of [until + 1, until + 6 * HOUR]) {
				at(now);
				expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
			}
			// Only Fleet.start's original authority capture listed the session; nothing was closed.
			expect(await w.lists()).toHaveLength(1);
			expect(await w.closes()).toHaveLength(0);
			expect((await w.sdk()).session).toMatchObject({ live: true, terminal: false });
			expect(w.task().held).toBe(defer);
			// The store fence refuses the close claim on its own.
			expect(w.claimCode()).toBe("RETURN_NOT_SETTLED");
			expect(w.store.getOperation(w.id, "resource-return-close:1")).toBeUndefined();
			// Custody first (the documented path) still gives the slot and the session back.
			expect((await w.fleet.result(w.id)).status).toBe("not_run");
			expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
			expect(await w.closes()).toHaveLength(1);
			expect(w.task().held).toBe(false);
			expect(w.released()).toBe(1);
		});

	test("phase failed whose own runtime receipt is terminal_ok (public turn failed, command succeeded): refused custody_missing, no close", async () => {
		const w = await world(failedTurnOkReceipt, true);
		const t = await w.poll(0);
		expect(t).toMatchObject({ phase: "failed", held: true, result: { status: "failed", executionTerminal: true } });
		expect(t.result!.settlement).toBeUndefined();
		expect((t.result!.evidence as any).execution).toMatchObject({ status: "terminal_ok", receiptState: "present" });
		expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
		expect(await w.closes()).toHaveLength(0);
		expect(w.claimCode()).toBe("RETURN_NOT_SETTLED");
		expect(w.task().held).toBe(true);
	});
});

describe("F2 (real inspect path, one clock): the late-receipt window boundary never interleaves into a close", () => {
	test("inspector check begun 1 s before the window ends, held in its runtime read; return 1 s after the end; then a genuine late terminal_ok lands: no close at any point", async () => {
		const w = await world(failedMissing, true);
		const settled = await settleReceiptless(w, "failed_without_receipt", true);
		const until = Date.parse(settled.result!.settlement!.lateObservationUntil);
		at(until - 1000);
		await w.hold();
		const inspecting = w.fleet.inspect(w.id);
		await w.waitHeld();
		// The runtime now has the genuine receipt; the in-flight read will see it once released.
		await w.setSdk((s) => { s.execution = clone(OK_RECEIPT); });
		at(until + 1000);
		const during = await w.ret();
		const closesDuring = (await w.closes()).length;
		await w.release();
		const inspected = await inspecting;
		expect(inspected.lateReceipt).toEqual({ checked: true, found: true });
		expect(w.task().result!.lateReceipt).toMatchObject({ status: "terminal_ok", settlementKind: "failed_without_receipt" });
		expect(during).toEqual([REFUSED(w.id, "custody_missing")]);
		expect(closesDuring).toBe(0);
		// After the late receipt: still the custody path, still no close, slot held, session live.
		expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
		expect(await w.closes()).toHaveLength(0);
		expect(w.claimCode()).toBe("RETURN_NOT_SETTLED");
		expect(w.task().held).toBe(true);
		expect((await w.sdk()).session).toMatchObject({ live: true, terminal: false });
		// The late receipt in between changes no refusal field: the identical refusal is recorded once (F5).
		expect(w.store.events(w.id).filter((e) => e.kind === "resource_return_refused")).toHaveLength(1);
	});

	test("the window boundary itself (until - 1 ms, until, until + 1 ms) changes no return decision", async () => {
		const w = await world(failedMissing, true);
		const settled = await settleReceiptless(w, "failed_without_receipt", true);
		const until = Date.parse(settled.result!.settlement!.lateObservationUntil);
		for (const now of [until - 1, until, until + 1]) {
			at(now);
			expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
		}
		// Unchanged task, identical refusal: recorded once, not once per invocation.
		expect(w.store.events(w.id).filter((e) => e.kind === "resource_return_refused")).toHaveLength(1);
		for (const now of [until - 1, until, until + 1]) {
			at(now);
			expect(w.claimCode()).toBe("RETURN_NOT_SETTLED");
		}
		expect(await w.closes()).toHaveLength(0);
	});
});

/**
 * A turn ran, so the node may hold its uncollected work: refused custody_missing before any listing
 * or close and nothing released; the store's own claim fence refuses too. Custody first (`result`
 * collects failed attempts as well) then returns it with one idle-fenced close, never re-sent.
 */
async function expectCustodyFirst(w: World, defer: boolean, collected?: string) {
	expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
	// Only Fleet.start's original authority capture listed the session; nothing was closed.
	expect(await w.lists()).toHaveLength(1);
	expect(await w.closes()).toHaveLength(0);
	expect(w.claimCode()).toBe("RETURN_NOT_SETTLED");
	expect(w.store.getOperation(w.id, "resource-return-close:1")).toBeUndefined();
	expect((await w.sdk()).session).toMatchObject({ live: true, terminal: false });
	expect(w.task().held).toBe(defer);
	const manifest = await w.fleet.result(w.id);
	expect(manifest.files.map((file) => file.path)).toEqual(collected ? [collected] : []);
	expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
	const closes = await w.closes();
	expect(closes).toHaveLength(1);
	expect(closes[0]).toMatchObject({ durableBeforeSend: true, activity: "idle", input: { sessionId: SESSION, endpointGeneration: 1, endpointIncarnation: INCARNATION, ifIdle: true } });
	expect(w.task().held).toBe(false);
	expect(w.released()).toBe(1);
	expect((w.store.getOperation(w.id, "resource-return-confirmed")!.payload as any).manifestDigest).toMatch(/^[0-9a-f]{64}$/);
	expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
	expect(await w.closes()).toHaveLength(1);
	expect(w.released()).toBe(1);
}

describe("F1 r3 (real inspect path): a COMPLETED public turn whose runtime receipt failed is never closed without custody", () => {
	for (const [mode, defer] of MODES)
		test(`${mode}: settles phase failed with an exact failed receipt; refused custody_missing, no close; custody first returns it`, async () => {
			const w = await world(completedTurnFailedReceipt, defer);
			const t = await w.poll(0);
			expect(t).toMatchObject({ phase: "failed", held: defer, result: { status: "failed", executionTerminal: true } });
			expect(t.result!.settlement).toBeUndefined();
			expect((t.result!.evidence as any).publicTurn.turn.status).toBe("completed");
			expect((t.result!.evidence as any).execution).toMatchObject({ status: "failed", receiptState: "present" });
			await w.edit("agent-change.txt", "completed turn output\n");
			await expectCustodyFirst(w, defer, "agent-change.txt");
		});
});

describe("F2 r3 (real inspect path): an exact failed or deadline-exceeded receipt can leave uncollected work; never closed without custody", () => {
	for (const [code, shape] of [["prompt_failed", exactFailed], ["prompt_deadline_exceeded", exactDeadline]] as const)
		test(`${code} after the agent changed the worktree: refused, no close; the change is collected first, then returned`, async () => {
			const w = await world(shape, true);
			const t = await w.poll(0);
			expect(t).toMatchObject({ phase: "failed", held: true, result: { status: "failed", executionTerminal: true } });
			expect((t.result!.evidence as any).execution).toMatchObject({ status: "failed", receiptState: "present", outcome: { code } });
			await w.edit("agent-change.txt", "partial work before the turn stopped\n");
			await expectCustodyFirst(w, true, "agent-change.txt");
		});

	test("cli: exact failed receipt with a clean worktree is still custody first (nothing on the node is proof of nothing to collect)", async () => {
		const w = await world(exactFailed, false);
		expect(await w.poll(0)).toMatchObject({ phase: "failed", held: false, result: { status: "failed", executionTerminal: true } });
		await expectCustodyFirst(w, false);
	});
});

describe("custody-first close path after an exact failed receipt (real inspect path)", () => {
	test("busy session: session_busy and held; an inspector poll in between changes nothing; idle later: returned with the next bounded claim", async () => {
		const w = await world(exactFailed, true);
		await w.poll(0);
		await w.fleet.result(w.id);
		await w.setSdk((s) => { s.session.activity = "busy"; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "session_busy", reason: "session_not_idle" }]);
		expect(w.task().held).toBe(true);
		const before = w.task();
		expect((await w.poll(2 * INTERVAL))).toEqual(before);
		await w.setSdk((s) => { s.session.activity = "idle"; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect((await w.closes()).map((c) => c.key)).toEqual([1, 2].map((n) => w.store.getOperation(w.id, `resource-return-close:${n}`)!.key));
		expect(w.released()).toBe(1);
	});

	test("repeated identical requests: two concurrent passes on two store handles send one close and release once", async () => {
		const w = await world(exactFailed, true);
		await w.poll(0);
		await w.fleet.result(w.id);
		const other = new FleetStore(w.dbPath, 2, { deferTerminalRelease: true });
		cleanups.push(() => other.close());
		const [a, b] = await Promise.all([w.ret(), w.ret(other)]);
		const states = [a[0]!.state, b[0]!.state].sort();
		expect(states).toEqual(["node_busy", "returned"]);
		expect(await w.closes()).toHaveLength(1);
		expect(await w.ret(other)).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(await w.closes()).toHaveLength(1);
		expect(w.released()).toBe(1);
	});

	test("F4 r3: returned, then archived: the next return reports returned, sends nothing and records no refusal", async () => {
		const w = await world(exactFailed, true);
		await w.poll(0);
		expect(await w.ret()).toEqual([REFUSED(w.id, "custody_missing")]);
		await w.fleet.result(w.id);
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect((await w.fleet.archive(w.id)).phase).toBe("archived");
		const lists = (await w.lists()).length;
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
		expect(w.store.resourceReturnStatus(w.id)?.state).toBe("returned");
		expect(w.store.events(w.id).filter((e) => e.kind === "resource_return_refused")).toHaveLength(1);
		expect(await w.closes()).toHaveLength(1);
		expect(await w.lists()).toHaveLength(lists);
		expect(w.released()).toBe(1);
	});
});

// ---------------------------------------------------------------- Part 2: store-level decision table and limits
const INC = INCARNATION;
type Receipt = "failed" | "deadline" | "terminal_ok" | "legacy" | "foreign" | "receiptless_failed" | "receiptless_in_flight";
interface Spec {
	phase?: "failed" | "completed_unverified" | "active";
	receipt?: Receipt;
	settlement?: "failed_without_receipt" | "ended_without_receipt";
	/** Settled this long before "now" (receipt-less only); the window is 24 h. */
	settledAgoMs?: number;
	late?: "terminal_ok" | "failed" | "accepted";
	custody?: "valid" | "corrupt";
	authority?: boolean;
	cancel?: boolean;
	noSession?: boolean;
	/** Public turn status recorded by inspect (default: completed for completed/ended settlements, else failed). */
	turnStatus?: "completed" | "failed";
}
function nodeConfig(dir: string): NodeConfig {
	return { id: "node", os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: process.execPath, args: [] } };
}
function manifestFor(identity: unknown, patch = ""): Json {
	return { schemaVersion: 1, identity: identity as Json, patch, patchDigest: sha256(patch), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" };
}
/** The evidence Fleet.inspect records: the exact public turn and the runtime command record (if any). */
function evidenceOf(sessionId: string, receipt: Receipt, turnStatus: string): Json {
	const delivery = { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false };
	const command = { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1" };
	const execution: Record<string, Json> | undefined = {
		failed: { ...command, ...FAILED_RECEIPT },
		deadline: { ...command, ...DEADLINE_RECEIPT },
		terminal_ok: { ...command, ...OK_RECEIPT },
		foreign: { ...command, commandId: "runtime-command-2", ...FAILED_RECEIPT },
		receiptless_failed: { ...command, ...failedMissing.execution },
		receiptless_in_flight: { ...command, status: "in_flight", receiptState: "absent" },
		legacy: undefined,
	}[receipt] as any;
	return { publicTurn: { ok: true, turn: { session_id: sessionId, turn_id: "turn", status: turnStatus, delivery } }, ...(execution ? { execution } : {}) } as Json;
}
let serial = 0;
function storeFixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "held-return-store-")));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 100, { deferTerminalRelease: true });
	cleanups.push(() => store.close());
	const node = nodeConfig(dir);
	store.putNode(node);
	const add = (spec: Spec, resources?: Parameters<FleetStore["reserve"]>[1]) => {
		const n = ++serial;
		const task = store.reserve(store.submit({ schemaVersion: 1, key: `held-${n}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id, resources);
		expect(task.held).toBe(true);
		if (spec.noSession) return store.task(task.id)!;
		const cwd = join(node.workspaceRoot, task.id + "-" + task.attemptId);
		const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: node.id, inputDigest: task.inputDigest, path: cwd, repo: dir, baseCommit: "a".repeat(40) };
		store.setWorkspace(task.id, identity);
		const create = store.claimOperation(task.id, "create", { cwd })!;
		const sessionId = `session-${n}`;
		store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd });
		const authority = { sessionId, cwd, endpointGeneration: 1, endpointIncarnation: INC };
		if (spec.authority !== false) store.recordSessionAuthority(task.id, authority);
		store.recordTurn(task.id, "turn");
		if (spec.cancel) {
			const active = { sessionId, turnId: "turn", status: "active" as const, terminal: false, evidence: { native: "running" } };
			store.observe(task.id, { eventId: `active-${n}`, digest: observationDigest(active), ...active });
			store.admitCancellation(task.id, store.task(task.id)!, authority);
		}
		const phase = spec.phase ?? "failed";
		if (phase !== "active") {
			const receipt = spec.receipt ?? (spec.settlement ? (spec.settlement === "failed_without_receipt" ? "receiptless_failed" : "receiptless_in_flight") : phase === "failed" ? "failed" : "terminal_ok");
			const settledAt = Date.now() - (spec.settledAgoMs ?? 30 * HOUR);
			const turnStatus = spec.turnStatus ?? (spec.settlement === "ended_without_receipt" || phase === "completed_unverified" ? "completed" : "failed");
			const body = {
				sessionId, turnId: "turn", status: phase, terminal: true,
				evidence: evidenceOf(sessionId, receipt, turnStatus),
				...(spec.settlement ? { settlement: { kind: spec.settlement, receiptState: receipt === "receiptless_failed" ? "missing" : "absent", cause: "controlled", settledAt: new Date(settledAt).toISOString(), lateObservationUntil: new Date(settledAt + LATE_RECEIPT_WINDOW_MS).toISOString() } } : {}),
			};
			store.observe(task.id, { eventId: `terminal-${n}`, digest: observationDigest(body), ...body });
			if (spec.late) {
				const status = spec.late === "failed" ? "failed" : "terminal_ok";
				store.recordLateReceipt(task.id, { status, digest: (status === "failed" ? "d" : "e").repeat(64), terminalAt: Date.now(), outcome: { kind: status === "failed" ? "failed" : "stopped" }, sessionId, turnId: "turn", runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1", observedAt: new Date().toISOString() });
				if (spec.late === "accepted") store.acceptLateReceipt(task.id, { actor: "operator", reason: "re-proven", digest: "e".repeat(64), evidence: store.task(task.id)!.result!.evidence });
			}
		}
		if (spec.custody) store.saveResult(task.id, manifestFor(identity));
		if (spec.custody === "corrupt") raw(path, "UPDATE tasks SET data=json_set(data,'$.resultManifest.patch','corrupt') WHERE id=?", task.id);
		return store.task(task.id)!;
	};
	return { store, path, dir, node, add };
}
type StoreFixture = ReturnType<typeof storeFixture>;
function raw(path: string, sql: string, ...args: any[]) {
	const db = new Database(path);
	try { db.query(sql).run(...args); } finally { db.close(); }
}
function auditRows(path: string, taskId: string, kind: string): any[] {
	const db = new Database(path, { readonly: true });
	try {
		return db.query<{ data: string }, [string, string]>("SELECT data FROM audit WHERE task_id=? AND kind=? ORDER BY sequence").all(taskId, kind).map((row) => JSON.parse(row.data));
	} finally { db.close(); }
}
function count(path: string, sql: string, ...args: any[]): number {
	const db = new Database(path, { readonly: true });
	try { return (db.query(sql).get(...args) as { n: number }).n; } finally { db.close(); }
}
type Session = { live: boolean; terminal: boolean; busy?: boolean; inc?: string };
function broker(store: FleetStore, o: { hang?: () => boolean; onList?: (sessionId: string, call: number) => void | Promise<void> } = {}) {
	const sessions = new Map<string, Session>();
	for (const t of store.taskStates()) if (t.sessionId) sessions.set(t.sessionId, { live: true, terminal: false });
	const closes: { sessionId: string; key: string }[] = [];
	const listed: string[] = [];
	let seq = 0;
	const port: ReturnConnection = {
		async list(sessionId) {
			listed.push(sessionId);
			await o.onList?.(sessionId, listed.length);
			const s = sessions.get(sessionId);
			const cwd = (store.taskStates().find((t) => t.sessionId === sessionId)!.workspace as any).path;
			return { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: s ? [{ sessionId, locator: { cwd }, endpointGeneration: 1, endpointIncarnation: s.inc ?? INC, live: s.live, terminal: s.terminal, ambiguous: false, terminalUncertain: false, activity: { state: s.busy ? "busy" : "idle" } }] : [] } };
		},
		async fencedClose(authority: SessionAuthority, key: string) {
			closes.push({ sessionId: authority.sessionId, key });
			if (o.hang?.()) throw new TransportError("execution_query_timeout", "unknown");
			const s = sessions.get(authority.sessionId)!;
			if (s.busy) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", { schema: "gjc.command-error", version: 1, ok: false, error: { code: "busy", message: "busy", outcomeCertainty: "unknown" } });
			s.live = false;
			s.terminal = true;
			return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
		},
		close() {},
	};
	return { connect: async () => port, sessions, closes, listed };
}
const run = (f: StoreFixture, ids: string[], b: ReturnType<typeof broker>, store: FleetStore = f.store) => returnResources(store, ids, { connect: b.connect, paceMs: 0, maxTasks: 100 });
function fences(f: StoreFixture, t: TaskRecord) {
	const authority = f.store.getOperation(t.id, "session-authority")?.payload as any;
	const claim = authority ? codeOf(() => f.store.claimResourceReturnClose(t.id, 1, { sessionId: authority.sessionId, cwd: authority.cwd, endpointGeneration: 1, endpointIncarnation: INC, ifIdle: true })) : "no-authority";
	const confirm = codeOf(() => f.store.confirmResourceReturn(t.id, t.attemptId!, t.sessionId!, { sessionId: t.sessionId!, attemptId: t.attemptId!, manifestDigest: null, indexSeq: 1, observed: "absent", endpointGeneration: 1, endpointIncarnation: INC, closeOperationId: null, closeReceipt: null, stopOperationId: null, stopReceipt: null }));
	return { claim, confirm };
}

/**
 * The decision table of RESULT.md: settlement kind x receipt state x late-receipt window state x late
 * receipt x custody. No row is closed without custody. Every row is driven through returnResources
 * (eligibility, listing, claim, close, confirmation) and both store fences.
 */
const WINDOW_OPEN = 1 * HOUR;
const WINDOW_OVER = 30 * HOUR;
const TABLE: { row: string; spec: Spec; report: "returned" | string }[] = [
	{ row: "1 exact failed receipt, nothing collected (F2)", spec: { receipt: "failed" }, report: "custody_missing" },
	{ row: "1b exact deadline-exceeded receipt, nothing collected (F2)", spec: { receipt: "deadline" }, report: "custody_missing" },
	{ row: "1c COMPLETED public turn, exact failed receipt, nothing collected (F1)", spec: { receipt: "failed", turnStatus: "completed" }, report: "custody_missing" },
	{ row: "1d exact deadline-exceeded receipt, valid custody", spec: { receipt: "deadline", custody: "valid" }, report: "returned" },
	{ row: "2 exact failed receipt, valid custody", spec: { receipt: "failed", custody: "valid" }, report: "returned" },
	{ row: "3 exact failed receipt, corrupt custody", spec: { receipt: "failed", custody: "corrupt" }, report: "custody_invalid" },
	{ row: "4 phase failed, own receipt terminal_ok", spec: { receipt: "terminal_ok" }, report: "custody_missing" },
	{ row: "5 phase failed, legacy evidence without receipt", spec: { receipt: "legacy" }, report: "custody_missing" },
	{ row: "6 phase failed, receipt of another command", spec: { receipt: "foreign" }, report: "custody_missing" },
	{ row: "7 completed_unverified, uncollected", spec: { phase: "completed_unverified" }, report: "custody_missing" },
	{ row: "8 completed_unverified, valid custody", spec: { phase: "completed_unverified", custody: "valid" }, report: "returned" },
	{ row: "9 failed_without_receipt (failed/missing), window open", spec: { settlement: "failed_without_receipt", settledAgoMs: WINDOW_OPEN }, report: "custody_missing" },
	{ row: "10 failed_without_receipt (failed/missing), window over", spec: { settlement: "failed_without_receipt", settledAgoMs: WINDOW_OVER }, report: "custody_missing" },
	{ row: "11 failed_without_receipt (in_flight/absent), window over", spec: { settlement: "failed_without_receipt", receipt: "receiptless_in_flight", settledAgoMs: WINDOW_OVER }, report: "custody_missing" },
	{ row: "12 ended_without_receipt, window open", spec: { settlement: "ended_without_receipt", settledAgoMs: WINDOW_OPEN }, report: "custody_missing" },
	{ row: "13 ended_without_receipt, window over (F1)", spec: { settlement: "ended_without_receipt", settledAgoMs: WINDOW_OVER }, report: "custody_missing" },
	{ row: "14 receipt-less + late terminal_ok, window over", spec: { settlement: "failed_without_receipt", late: "terminal_ok" }, report: "custody_missing" },
	{ row: "15 receipt-less + late failed, window over", spec: { settlement: "failed_without_receipt", late: "failed" }, report: "custody_missing" },
	{ row: "16 receipt-less + accepted late terminal_ok (completed_unverified)", spec: { settlement: "ended_without_receipt", late: "accepted" }, report: "custody_missing" },
	{ row: "17 receipt-less, valid custody, window open", spec: { settlement: "ended_without_receipt", settledAgoMs: WINDOW_OPEN, custody: "valid" }, report: "returned" },
	{ row: "18 not terminal (active)", spec: { phase: "active" }, report: "not_settled" },
	{ row: "19 never started (reserved, no session)", spec: { noSession: true }, report: "not_settled" },
	{ row: "20 exact failed receipt, nothing collected, no recorded authority", spec: { receipt: "failed", authority: false }, report: "custody_missing" },
	{ row: "20b exact failed receipt, valid custody, no recorded authority", spec: { receipt: "failed", authority: false, custody: "valid" }, report: "authority_missing" },
	{ row: "21 exact failed receipt observed under an admitted cancel (phase stays cancel-owned)", spec: { receipt: "failed", cancel: true }, report: "custody_missing" },
	{ row: "22 collected attempt, cancel pending", spec: { phase: "completed_unverified", custody: "valid", cancel: true }, report: "cancel_pending" },
];

describe("decision table: no settled attempt is closed without custody", () => {
	for (const { row, spec, report } of TABLE)
		test(row, async () => {
			const f = storeFixture();
			const t = f.add(spec);
			const b = broker(f.store);
			const reports = await run(f, [t.id], b);
			if (report === "returned") {
				expect(reports).toEqual([{ taskId: t.id, state: "returned" }]);
				expect(b.closes).toHaveLength(1);
				expect(f.store.task(t.id)!.held).toBe(false);
			} else {
				const reason = report === "authority_missing" ? "original_session_authority_missing" : report === "cancel_pending" ? "cancellation_owns_retirement" : "settlement_custody_or_ownership_missing";
				expect(reports).toEqual([REFUSED(t.id, report, reason)]);
				expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
				expect(f.store.task(t.id)!.held).toBe(true);
				// Independently of the controller, neither store fence accepts an uncollected attempt.
				if (!spec.custody && !spec.noSession && spec.authority !== false) expect(fences(f, t)).toEqual({ claim: "RETURN_NOT_SETTLED", confirm: "RETURN_BINDING" });
			}
		});

	test("the late-receipt window is not an input: receipt-less rows at until - 1, until, until + 1 (store clock) are refused and fenced alike", async () => {
		for (const kind of ["failed_without_receipt", "ended_without_receipt"] as const) {
			const f = storeFixture();
			const t = f.add({ settlement: kind, settledAgoMs: WINDOW_OVER });
			const until = Date.parse(t.result!.settlement!.lateObservationUntil);
			for (const now of [until - 1, until, until + 1]) {
				at(now);
				const b = broker(f.store);
				expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
				expect(b.closes).toHaveLength(0);
				expect(fences(f, t)).toEqual({ claim: "RETURN_NOT_SETTLED", confirm: "RETURN_BINDING" });
			}
			setSystemTime();
		}
	});

});

describe("concurrency with an inspector or a second controller (second store handle on the same DB)", () => {
	test("custody saved by another handle after a refusal: nothing was listed or closed before it; the next pass binds the custody", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed" });
		const other = new FleetStore(f.path, 100, { deferTerminalRelease: true });
		cleanups.push(() => other.close());
		const b = broker(f.store);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
		other.saveResult(t.id, manifestFor(t.workspace));
		expect(await run(f, [t.id], b)).toEqual([{ taskId: t.id, state: "returned" }]);
		expect(b.closes).toHaveLength(1);
		expect((f.store.getOperation(t.id, "resource-return-confirmed")!.payload as any).manifestDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("the attempt stops being terminal (another handle) between listing and claim: no close", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed", custody: "valid" });
		const b = broker(f.store, { onList: (_s, call) => { if (call === 1) raw(f.path, "UPDATE tasks SET data=json_set(data,'$.result.executionTerminal',json('false')) WHERE id=?", t.id); } });
		expect((await run(f, [t.id], b))[0]!.state).toBe("return_unknown");
		expect(b.closes).toHaveLength(0);
		expect(f.store.getOperation(t.id, "resource-return-close:1")).toBeUndefined();
	});

	test("collected exact failed receipt whose session id is listed under another incarnation: not_ours, no close, still held", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed", custody: "valid" });
		const b = broker(f.store);
		b.sessions.get(t.sessionId!)!.inc = "c".repeat(64);
		const [report] = await run(f, [t.id], b);
		expect(report).toMatchObject({ taskId: t.id, state: "not_ours" });
		expect(b.closes).toHaveLength(0);
		expect(f.store.task(t.id)!.held).toBe(true);
		expect(auditRows(f.path, t.id, "released")).toHaveLength(0);
	});
	test("an unanswered close is never re-sent, by this or a second controller handle; only a later absence settles it", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed", custody: "valid" });
		const b = broker(f.store, { hang: () => true });
		expect(await run(f, [t.id], b)).toEqual([{ taskId: t.id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" }]);
		const other = new FleetStore(f.path, 100, { deferTerminalRelease: true });
		cleanups.push(() => other.close());
		expect(await run(f, [t.id], b, other)).toEqual([{ taskId: t.id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" }]);
		expect(b.closes).toHaveLength(1);
		expect(f.store.task(t.id)!.held).toBe(true);
		b.sessions.delete(t.sessionId!);
		expect(await run(f, [t.id], b)).toEqual([{ taskId: t.id, state: "returned" }]);
		expect(b.closes).toHaveLength(1);
	});
});

describe("refusal codes and their record (F3, F4, retention)", () => {
	test("every refusal code except unclassified is reachable, reported and stored with its own diagnostic", async () => {
		const f = storeFixture();
		const cases: [string, string, Spec][] = [
			["not_settled", "fleet:return_not_settled", { phase: "active" }],
			["custody_missing", "fleet:return_custody_missing", { phase: "completed_unverified" }],
			["custody_invalid", "fleet:result_digest", { phase: "completed_unverified", custody: "corrupt" }],
			["authority_missing", "fleet:return_authority_missing", { receipt: "failed", authority: false, custody: "valid" }],
			["cancel_pending", "fleet:return_cancel_pending", { phase: "completed_unverified", custody: "valid", cancel: true }],
		];
		const ids = cases.map(([, , spec]) => f.add(spec).id);
		const binding = f.add({ phase: "completed_unverified", custody: "valid" });
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.resultManifest.identity.inputDigest',?,'$.workspace.inputDigest',?) WHERE id=?", "f".repeat(64), "f".repeat(64), binding.id);
		const ownerless = f.add({ receipt: "failed", custody: "valid" });
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.sessionValidated',json('false')) WHERE id=?", ownerless.id);
		cases.push(["custody_binding_mismatch", "fleet:return_custody_binding", {}], ["ownership_missing", "fleet:cancel_unsupported", {}]);
		ids.push(binding.id, ownerless.id);
		const b = broker(f.store);
		const reports = await run(f, [...ids, "no-such-task"], b);
		expect(new Set(reports.map((r) => r.refusal))).toEqual(new Set(REFUSAL_CODES.filter((c) => c !== "unclassified")));
		cases.forEach(([refusal, code], i) => {
			expect(reports[i]!.refusal).toBe(refusal as any);
			const stored = auditRows(f.path, ids[i]!, "resource_return_refused");
			expect(stored.map((e) => [e.reason, e.replay, e.failureDiagnostic?.code, e.failureDiagnostic?.source, e.failureDiagnostic?.phase])).toEqual([[refusal, false, code, "ResourceReturn.precondition", "precondition"]]);
		});
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	for (const [name, path, value, code] of [
		["invalid test evidence (TEST_EVIDENCE)", "$.resultManifest.tests", JSON.stringify([{ bogus: true }]), "fleet:test_evidence"],
		["unsafe file path (plain Error)", "$.resultManifest.files", JSON.stringify([{ path: "../escape", mode: 33188, contentBase64: "" }]), "unclassified"],
		["manifest without identity (RESULT_BINDING)", "$.resultManifest.identity", "null", "fleet:result_binding"],
	] as const)
		test(`F3 corrupt custody, ${name}: custody_invalid, recorded, no read or close`, async () => {
			const f = storeFixture();
			const t = f.add({ receipt: "failed", custody: "valid" });
			raw(f.path, `UPDATE tasks SET data=json_set(data,'${path}',json(?)) WHERE id=?`, value, t.id);
			const b = broker(f.store);
			expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
			expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
			expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic?.code])).toEqual([["custody_invalid", code]]);
		});

	test("F3 damaged externalised custody (RESULT_INTEGRITY on load): custody_invalid and the refusal is stored", async () => {
		const f = storeFixture();
		f.store.enableResultStore({ actor: "test", reason: "externalise custody" });
		const t = f.add({ phase: "completed_unverified" });
		const patch = "+externalised line\n".repeat(4000);
		f.store.saveResult(t.id, manifestFor(t.workspace, patch));
		const results = `${f.path}.results`;
		let damaged = 0;
		for (const entry of readdirSync(results)) {
			const data = join(results, entry, "data");
			if (existsSync(data) && statSync(data).isFile()) { writeFileSync(data, "corrupt"); damaged++; }
		}
		expect(damaged).toBeGreaterThan(0);
		const b = broker(f.store);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
		expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic?.code])).toEqual([["custody_invalid", "fleet:result_integrity"]]);
	});

	test("a store error outside every precondition stays unclassified and is recorded", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed", custody: "valid" });
		const original = f.store.cancellationOwnership.bind(f.store);
		(f.store as any).cancellationOwnership = () => { throw new Error("controlled store fault"); };
		const r = await run(f, [t.id], broker(f.store));
		(f.store as any).cancellationOwnership = original;
		expect(r).toEqual([REFUSED(t.id, "unclassified")]);
		expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic.errorClass, e.failureDiagnostic.code])).toEqual([["unclassified", "Error", "unclassified"]]);
	});

	test("F4 the refusal record failing: report unchanged; a fault inside its transaction is the store's own refused row; read-only records nothing; both counted", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		raw(f.path, "CREATE TRIGGER held_return_fault BEFORE INSERT ON audit WHEN NEW.kind='resource_return_refused' BEGIN SELECT RAISE(ABORT,'controlled audit fault'); END;");
		const telemetry = (s: FleetStore) => (s as any).telemetryFailures as number;
		const before = telemetry(f.store);
		expect(await run(f, [t.id], broker(f.store))).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(telemetry(f.store)).toBe(before + 1);
		expect(auditRows(f.path, t.id, "refused").map((e) => [e.action, e.code, e.failureDiagnostic?.source, e.failureDiagnostic?.phase])).toEqual([["recordResourceReturnRefused", "STORE_ERROR", "Store.transaction", "record"]]);
		raw(f.path, "DROP TRIGGER held_return_fault");
		const ro = new FleetStore(f.path, 100, { readOnly: true, deferTerminalRelease: true });
		cleanups.push(() => ro.close());
		expect(await run(f, [t.id], broker(f.store), ro)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(telemetry(ro)).toBe(1);
		expect(auditRows(f.path, t.id, "resource_return_refused")).toHaveLength(0);
	});

	test("R6-F1 a blank id in the batch: repeated return [\"\", valid] records the valid refusal once and writes no refused row", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const b = broker(f.store);
		const telemetry = () => (f.store as any).telemetryFailures as number;
		const before = telemetry();
		for (let i = 0; i < 3; i++) expect(await run(f, ["", t.id], b)).toEqual([REFUSED("", "unclassified"), REFUSED(t.id, "custody_missing")]);
		expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => e.reason)).toEqual(["custody_missing"]);
		expect(count(f.path, "SELECT count(*) AS n FROM audit WHERE kind='refused'")).toBe(0);
		expect(telemetry()).toBe(before);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("retention: repeating return on an unchanged refused task adds no rows; a changed refusal records one new row", async () => {
		const f = storeFixture();
		const t = f.add({ settlement: "ended_without_receipt" });
		const b = broker(f.store);
		const rows = () => count(f.path, "SELECT count(*) AS n FROM audit WHERE task_id=?", t.id);
		await run(f, [t.id], b);
		const after1 = rows();
		for (let i = 0; i < 50; i++) expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(rows()).toBe(after1);
		expect(auditRows(f.path, t.id, "resource_return_refused")).toHaveLength(1);
		// A different refusal (corrupt custody) is recorded once.
		f.store.saveResult(t.id, manifestFor(t.workspace));
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.resultManifest.patchDigest',?) WHERE id=?", "0".repeat(64), t.id);
		for (let i = 0; i < 3; i++) expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
		expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => e.reason)).toEqual(["custody_missing", "custody_invalid"]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("F5 retention: other events of the task between identical refusals (inspector observations, a late receipt) add no refusal rows", async () => {
		const f = storeFixture();
		const active = f.add({ phase: "active" });
		const settled = f.add({ settlement: "failed_without_receipt" });
		const b = broker(f.store);
		for (let round = 0; round < 20; round++) {
			// An inspector poll between return calls: one observation audit row per round on the active task.
			const body = { sessionId: active.sessionId!, turnId: "turn", status: "active" as const, terminal: false, evidence: { native: `running-${round}` } };
			f.store.observe(active.id, { eventId: `poll-${active.id}-${round}`, digest: observationDigest(body), ...body });
			if (round === 10) f.store.recordLateReceipt(settled.id, { status: "failed", digest: "d".repeat(64), terminalAt: Date.now(), outcome: { kind: "failed" }, sessionId: settled.sessionId!, turnId: "turn", runtimeCommandId: "runtime-command-1", runtimeTurnId: "runtime-turn-1", observedAt: new Date().toISOString() });
			expect(await run(f, [active.id, settled.id], b)).toEqual([REFUSED(active.id, "not_settled"), REFUSED(settled.id, "custody_missing")]);
		}
		expect(auditRows(f.path, active.id, "observation").length).toBeGreaterThanOrEqual(20);
		expect(auditRows(f.path, active.id, "resource_return_refused").map((e) => e.reason)).toEqual(["not_settled"]);
		expect(auditRows(f.path, settled.id, "resource_return_refused").map((e) => e.reason)).toEqual(["custody_missing"]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("R4-F1 schema: writable opens and recorded refusals add no schema object; sqlite_master and the schema cookie are unchanged", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const schema = () => {
			const db = new Database(f.path, { readonly: true });
			try {
				return {
					objects: db.query<{ type: string; name: string; sql: string | null }, []>("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
					cookie: (db.query("PRAGMA schema_version").get() as { schema_version: number }).schema_version,
					version: (db.query("PRAGMA user_version").get() as { user_version: number }).user_version,
				};
			} finally { db.close(); }
		};
		const auditIndexes = () => schema().objects.filter((o) => o.type === "index" && o.sql !== null && /\bON audit\b/.test(o.sql)).map((o) => o.name);
		expect(auditIndexes()).toEqual(["audit_global_kind"]);
		const before = schema();
		const b = broker(f.store);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		f.store.close();
		const reopened = new FleetStore(f.path, 100, { deferTerminalRelease: true });
		cleanups.push(() => reopened.close());
		expect(await run(f, [t.id], broker(reopened), reopened)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(schema()).toEqual(before);
		expect(auditIndexes()).toEqual(["audit_global_kind"]);
		expect(auditRows(f.path, t.id, "resource_return_refused")).toHaveLength(1);
	});

	test("R5-F1 churn: an identical refusal is never written again, however many newer audit rows (999, 1000, 1001, 5000) came in between", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const b = broker(f.store);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		const filler = (n: number) => {
			const db = new Database(f.path);
			try {
				const insert = db.query("INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)");
				db.transaction(() => { for (let i = 0; i < n; i++) insert.run(`other-${i % 50}`, "observation", "2026-01-01T00:00:00.000Z", "{}"); })();
			} finally { db.close(); }
		};
		// Cumulative newer rows: 999, 1000, 1001 (r4's lookback boundary) and 5000.
		for (const n of [999, 1, 1, 3999]) {
			filler(n);
			expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
			expect(auditRows(f.path, t.id, "resource_return_refused")).toHaveLength(1);
		}
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("R5-F1 cycle: 1001 permanently refused tasks returned in batches of 100, twice: the second cycle writes zero rows", async () => {
		const f = storeFixture();
		const K = 1001;
		const ids: string[] = [];
		for (let i = 0; i < K; i++) ids.push(f.store.submit({ schemaVersion: 1, key: `cycle-${i}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
		const b = broker(f.store);
		const refusals = () => count(f.path, "SELECT count(*) AS n FROM audit WHERE kind='resource_return_refused'");
		const all = () => count(f.path, "SELECT count(*) AS n FROM audit");
		const cycle = async () => {
			for (let i = 0; i < K; i += 100) {
				const batch = ids.slice(i, i + 100);
				expect(await run(f, batch, b)).toEqual(batch.map((id) => REFUSED(id, "not_settled")));
			}
		};
		await cycle();
		expect(refusals()).toBe(K);
		const before = all();
		await cycle();
		expect(all()).toBe(before);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	}, 120_000);

	test("R5-F2 lock held by another writer: all refusals of one call wait for one busy timeout, not one per refused id; nothing recorded, counted once", async () => {
		const f = storeFixture();
		const ids = [f.add({ phase: "completed_unverified" }).id, f.add({ phase: "active" }).id, f.add({ settlement: "ended_without_receipt" }).id];
		const BUSY_MS = 1000;
		const db = (f.store as any).db;
		db.exec(`PRAGMA busy_timeout=${BUSY_MS}`);
		const holder = new Database(f.path);
		cleanups.push(() => holder.close());
		holder.exec("PRAGMA busy_timeout=0");
		holder.exec("BEGIN IMMEDIATE");
		// What ONE refused write-lock attempt costs on this host's SQLite while the lock is held. It is
		// not BUSY_MS everywhere: a SQLite built with SQLITE_ENABLE_SETLK_TIMEOUT (macOS system SQLite)
		// waits about 3 x busy_timeout for a single BEGIN IMMEDIATE.
		const single = performance.now();
		expect(() => db.exec("BEGIN IMMEDIATE")).toThrow();
		const oneWait = performance.now() - single;
		expect(db.inTransaction).toBe(false);
		const exec = db.exec;
		let begins = 0;
		db.exec = function (sql: string, ...rest: unknown[]) {
			if (/^\s*BEGIN/i.test(sql)) begins++;
			return exec.call(this, sql, ...rest);
		};
		const telemetry = () => (f.store as any).telemetryFailures as number;
		const before = telemetry();
		const b = broker(f.store);
		const started = performance.now();
		let reports: ReturnReport[];
		try {
			reports = await run(f, ids, b);
		} finally {
			db.exec = exec;
		}
		const elapsed = performance.now() - started;
		holder.exec("ROLLBACK");
		expect(reports.map((r) => r.refusal)).toEqual(["custody_missing", "not_settled", "custody_missing"]);
		// One lock attempt, so one busy wait (~oneWait); one per id would be ~3 x oneWait.
		expect(begins).toBe(1);
		expect(elapsed).toBeGreaterThanOrEqual(BUSY_MS * 0.9);
		expect(elapsed).toBeLessThan(oneWait * 2);
		expect(telemetry()).toBe(before + 1);
		expect(count(f.path, "SELECT count(*) AS n FROM audit WHERE kind IN ('resource_return_refused','refused')")).toBe(0);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	}, 30_000);

	test("R5-F2 one write transaction per return call records every refusal of the call", async () => {
		const f = storeFixture();
		const ids = [f.add({ phase: "completed_unverified" }).id, f.add({ phase: "active" }).id, f.add({ settlement: "ended_without_receipt" }).id, "no-such-task"];
		const db = (f.store as any).db;
		const exec = db.exec;
		let begins = 0;
		db.exec = function (sql: string, ...rest: unknown[]) {
			if (/^\s*BEGIN/i.test(sql)) begins++;
			return exec.call(this, sql, ...rest);
		};
		try {
			const b = broker(f.store);
			expect((await run(f, ids, b)).map((r) => r.refusal)).toEqual(["custody_missing", "not_settled", "custody_missing", "task_not_found"]);
			expect(begins).toBe(1);
			for (const id of ids.slice(0, 3)) expect(auditRows(f.path, id, "resource_return_refused")).toHaveLength(1);
		} finally {
			db.exec = exec;
		}
	});

	test("R5-F3 a recorded refusal does not move the task's dashboard lastEventAt", async () => {
		at(T0);
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const last = () => getDashboardState(f.store).tasks.find((task) => task.id === t.id)!.lastEventAt;
		const settled = last();
		expect(settled).toBe(new Date(T0).toISOString());
		at(T0 + HOUR);
		expect(await run(f, [t.id], broker(f.store))).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(auditRows(f.path, t.id, "resource_return_refused")).toHaveLength(1);
		expect(last()).toBe(settled);
	});

	test("R5-F4 two never-reserved tasks refused in one call have identical refusal data and get one row each", async () => {
		const f = storeFixture();
		const ids = [0, 1].map((i) => f.store.submit({ schemaVersion: 1, key: `never-${i}-${++serial}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
		const b = broker(f.store);
		for (let round = 0; round < 2; round++) expect(await run(f, ids, b)).toEqual(ids.map((id) => REFUSED(id, "not_settled")));
		const stored = ids.map((id) => auditRows(f.path, id, "resource_return_refused").map(({ observability: _o, ...data }) => data));
		expect(stored.map((rows) => rows.length)).toEqual([1, 1]);
		expect(stored[0]).toEqual(stored[1]!);
		expect(stored[0]![0]).toMatchObject({ attemptId: null, sessionId: null, reason: "not_settled" });
	});

	test("R4-F2 alternating refusals of one unchanged task (transient load fault vs custody_missing) write one row per distinct refusal, not per invocation", async () => {
		const f = storeFixture();
		const t = f.add({ settlement: "ended_without_receipt" });
		const b = broker(f.store);
		const original = f.store.resourceReturnStatus.bind(f.store);
		let fault = false;
		(f.store as any).resourceReturnStatus = (id: string) => {
			if (fault) throw new Error("controlled transient fault");
			return original(id);
		};
		for (let round = 0; round < 40; round++) {
			fault = round % 2 === 1;
			expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, fault ? "unclassified" : "custody_missing")]);
		}
		(f.store as any).resourceReturnStatus = original;
		expect(auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic?.code])).toEqual([["custody_missing", "fleet:return_custody_missing"], ["unclassified", "unclassified"]]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
		expect(f.store.task(t.id)!.held).toBe(true);
	});

	test("R4-F3 dedupe key, diagnostic: the same code with a different diagnostic is a new row; returning to an earlier identical one is not", async () => {
		const f = storeFixture();
		const t = f.add({ receipt: "failed", custody: "valid" });
		const b = broker(f.store);
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.resultManifest.patch','corrupt') WHERE id=?", t.id);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.resultManifest.patch','','$.resultManifest.identity',json('null')) WHERE id=?", t.id);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
		const codes = () => auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic?.code]);
		expect(codes()).toEqual([["custody_invalid", "fleet:result_digest"], ["custody_invalid", "fleet:result_binding"]]);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_invalid")]);
		expect(codes()).toHaveLength(2);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("R4-F3 dedupe key, attempt and session: the same code and diagnostic under another session or attempt is a new row", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const b = broker(f.store);
		const stored = () => auditRows(f.path, t.id, "resource_return_refused").map((e) => [e.reason, e.failureDiagnostic?.code, e.attemptId, e.sessionId]);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.sessionId','session-other') WHERE id=?", t.id);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		raw(f.path, "UPDATE tasks SET data=json_set(data,'$.attemptId','attempt-other') WHERE id=?", t.id);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		expect(stored()).toEqual([
			["custody_missing", "fleet:return_custody_missing", t.attemptId, t.sessionId],
			["custody_missing", "fleet:return_custody_missing", t.attemptId, "session-other"],
			["custody_missing", "fleet:return_custody_missing", "attempt-other", "session-other"],
		]);
		expect([b.listed.length, b.closes.length]).toEqual([0, 0]);
	});

	test("R4-F3 an unknown task id is reported task_not_found and leaves the audit table untouched", async () => {
		const f = storeFixture();
		const t = f.add({ phase: "completed_unverified" });
		const b = broker(f.store);
		expect(await run(f, [t.id], b)).toEqual([REFUSED(t.id, "custody_missing")]);
		const rows = () => count(f.path, "SELECT count(*) AS n FROM audit");
		const newest = () => count(f.path, "SELECT COALESCE(MAX(sequence),0) AS n FROM audit");
		const before = [rows(), newest()];
		for (let i = 0; i < 3; i++) expect(await run(f, ["no-such-task"], b)).toEqual([REFUSED("no-such-task", "task_not_found")]);
		expect([rows(), newest()]).toEqual(before);
		expect(count(f.path, "SELECT count(*) AS n FROM audit WHERE task_id='no-such-task'")).toBe(0);
	});
});

describe("limits, capacity and legacy state", () => {
	test(`close attempts at MAX_CLOSE_ATTEMPTS - 1, MAX_CLOSE_ATTEMPTS and + 1 on a store already holding older valid work`, async () => {
		expect(MAX_CLOSE_ATTEMPTS).toBe(5);
		const f = storeFixture();
		// Older valid data: returned custody tasks, refused completed tasks, collected exact failed tasks already returned.
		const older = [...Array(60)].map((_, i) => f.add(i % 3 === 0 ? { phase: "completed_unverified", custody: "valid" } : i % 3 === 1 ? { phase: "completed_unverified" } : { receipt: "failed", custody: "valid" }));
		const ob = broker(f.store);
		const olderIds = older.map((t) => t.id);
		for (let i = 0; i < olderIds.length; i += 100) await run(f, olderIds.slice(i, i + 100), ob);
		const busyUntil = (task: TaskRecord, busyPasses: number) => async () => {
			const b = broker(f.store);
			b.sessions.get(task.sessionId!)!.busy = true;
			const states: string[] = [];
			for (let pass = 1; pass <= busyPasses + 1; pass++) {
				if (pass > busyPasses) b.sessions.get(task.sessionId!)!.busy = false;
				states.push((await run(f, [task.id], b))[0]!.state);
			}
			return { states, closes: b.closes.length };
		};
		// limit - 1 busy refusals: the 5th claim is the last allowed one and returns it.
		const a = f.add({ receipt: "failed", custody: "valid" });
		expect(await busyUntil(a, MAX_CLOSE_ATTEMPTS - 1)()).toEqual({ states: [...Array(MAX_CLOSE_ATTEMPTS - 1).fill("session_busy"), "returned"], closes: MAX_CLOSE_ATTEMPTS });
		// limit busy refusals: no 6th close, held, exhausted.
		const c = f.add({ receipt: "failed", custody: "valid" });
		expect(await busyUntil(c, MAX_CLOSE_ATTEMPTS)()).toEqual({ states: [...Array(MAX_CLOSE_ATTEMPTS).fill("session_busy"), "return_unknown"], closes: MAX_CLOSE_ATTEMPTS });
		expect(f.store.task(c.id)!.held).toBe(true);
		// limit + 1: the store itself refuses the sixth ordinal.
		const authority = f.store.getOperation(c.id, "session-authority")!.payload as any;
		expect(codeOf(() => f.store.claimResourceReturnClose(c.id, MAX_CLOSE_ATTEMPTS + 1, { ...authority, ifIdle: true }))).toBe("RETURN_BOUNDS");
	}, 60_000);

	test("return batch bounds at 99, 100 and 101 ids with a store already holding many older tasks", async () => {
		const f = storeFixture();
		const ids = [...Array(101)].map(() => f.add({ receipt: "failed", custody: "valid" }).id);
		const b = broker(f.store);
		await expect(returnResources(f.store, ids, { connect: b.connect, paceMs: 0, maxTasks: 100 })).rejects.toMatchObject({ code: "RETURN_BOUNDS" });
		await expect(returnResources(f.store, ids, { connect: b.connect, paceMs: 0, maxTasks: 101 })).rejects.toMatchObject({ code: "RETURN_BOUNDS" });
		expect(b.closes).toHaveLength(0);
		const first = await run(f, ids.slice(0, 99), b);
		expect(first.every((r) => r.state === "returned")).toBe(true);
		const second = await run(f, ids.slice(0, 100), b);
		expect(second.every((r) => r.state === "returned")).toBe(true);
		expect(b.closes).toHaveLength(100);
		expect(f.store.task(ids[100]!)!.held).toBe(true);
	}, 60_000);

	test("admission at the headroom limit: limit - 1 admits, limit refuses, returning one collected exact failed task admits the next", async () => {
		const f = storeFixture();
		const LIMIT = 4;
		const resources = headroom(["node"], LIMIT);
		// Older valid data that does not hold: returned collected exact-failed and custody tasks.
		const older = [...Array(30)].map((_, i) => f.add(i % 2 ? { receipt: "failed", custody: "valid" } : { phase: "completed_unverified", custody: "valid" }));
		const b0 = broker(f.store);
		await run(f, older.map((t) => t.id), b0);
		expect(older.every((t) => f.store.task(t.id)!.held === false)).toBe(true);
		const held = [...Array(LIMIT - 1)].map(() => f.add({ receipt: "failed", custody: "valid" }, resources));
		const atLimit = f.add({ receipt: "failed", custody: "valid" }, resources);
		expect([...held, atLimit].every((t) => f.store.task(t.id)!.held)).toBe(true);
		const next = f.store.submit({ schemaVersion: 1, key: "over-limit", caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} });
		expect(f.store.reserve(next.id, resources)).toMatchObject({ reason: "no_eligible_node" });
		expect(f.store.task(next.id)!.attemptId).toBeUndefined();
		const b = broker(f.store);
		expect(await run(f, [atLimit.id], b)).toEqual([{ taskId: atLimit.id, state: "returned" }]);
		expect(f.store.reserve(next.id, resources)).toMatchObject({ held: true });
	});

	test("legacy state: a ladder-v1 database with production-shaped rows loads, returns, migrates results and admits new work", async () => {
		const f = storeFixture();
		const failed = f.add({ receipt: "failed" });
		const legacyFailed = f.add({ receipt: "legacy" });
		const collected = f.add({ phase: "completed_unverified", custody: "valid" });
		const receiptless = f.add({ settlement: "failed_without_receipt" });
		f.store.close();
		const db = new Database(f.path);
		db.exec(`DROP TRIGGER archived_phase_fence;
			ALTER TABLE fleet_meta RENAME TO fleet_meta_v2;
			CREATE TABLE fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), global_cap INTEGER NOT NULL CHECK(global_cap>0));
			INSERT INTO fleet_meta SELECT id,1,global_cap FROM fleet_meta_v2; DROP TABLE fleet_meta_v2; PRAGMA user_version=1;`);
		db.close();
		const store = new FleetStore(f.path, 100, { deferTerminalRelease: true });
		cleanups.push(() => store.close());
		const b = broker(store);
		const reports = await returnResources(store, [failed.id, legacyFailed.id, collected.id, receiptless.id], { connect: b.connect, paceMs: 0 });
		// Refusals are reported first (eligibility), then the node pass in input order.
		expect(reports).toEqual([REFUSED(failed.id, "custody_missing"), REFUSED(legacyFailed.id, "custody_missing"), REFUSED(receiptless.id, "custody_missing"), { taskId: collected.id, state: "returned" }]);
		store.saveResult(failed.id, manifestFor(failed.workspace));
		store.saveResult(legacyFailed.id, manifestFor(legacyFailed.workspace));
		store.enableResultStore({ actor: "test", reason: "legacy migration" });
		expect(store.migrateResults(true)).toMatchObject({ failed: [] });
		expect(await returnResources(store, [failed.id, legacyFailed.id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: failed.id, state: "returned" }, { taskId: legacyFailed.id, state: "returned" }]);
		const next = store.reserve(store.submit({ schemaVersion: 1, key: "after-legacy", caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
		expect(next.held).toBe(true);
		expect(b.closes).toHaveLength(3);
	});
});
