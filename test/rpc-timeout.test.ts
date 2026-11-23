import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { canonicalJson, DEFAULT_NODE_RPC_TIMEOUT_MS, FleetError, nodeObservationTimeoutMs, nodeRpcTimeoutMs, validateNode } from "../src/core";
import { DIAGNOSTIC_TEXT, normalizeDiagnostic, type DiagnosticSource, type DiagnosticStep, type FailureDiagnostic } from "../src/diagnostic";
import { Fleet } from "../src/fleet";
import { nodeRpc, TransportError } from "../src/rpc";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { type ControlledState, repositoryFixture } from "./fixtures/coordinator";
import { installDiagnosticGuard } from "./diagnostic-guard";

// Per-node Coordinator RPC timeout, through the real path: real temporary SQLite store, real Fleet.start /
// Fleet.inspect, the real node helper as workspaceTransport, and the controlled stdio Coordinator
// (fixtures/coordinator.ts) that persists the effect and then answers after `hangMs`. No live service.
// The long cases run concurrently: they only wait on the controlled transport.
const root = fileURLToPath(new URL("..", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const guard = installDiagnosticGuard(FleetStore);
const dirs: string[] = [];
afterAll(async () => {
	guard.uninstall();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const SECOND = 1000;
/**
 * Upper bound slack for "timed out at the configured limit" wall-clock checks.
 * A loaded host can delay setTimeout past the nominal limit by a few hundred ms
 * (macOS verify under load hit +149ms / +223ms on the 30s/120s cases). Hang
 * answers must stay beyond this slack so a late timer still beats the fixture.
 */
const TIMER_SLACK = 5 * SECOND;

type Options = { os: "posix" | "win32"; timeoutMs?: number; legacyRow?: boolean; state?: Partial<ControlledState> };
async function fixture(options: Options) {
	const f = await repositoryFixture("fleet-rpc-timeout-");
	dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [], ...options.state }));
	// The node helper runs on this host: its own config declares this host's platform. A win32 Fleet node
	// therefore reaches a controlled stand-in for the Windows host's helper; only the Coordinator timing is under test.
	const local: NodeConfig = {
		id: "controlled", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot: f.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [],
		operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"],
		transport: { command: process.execPath, args: [coordinator, state] },
	};
	const config = join(f.dir, "node.json");
	await writeFile(config, JSON.stringify(local));
	const node: NodeConfig = {
		...local,
		os: options.os === "win32" ? "win32" : process.platform === "win32" ? "linux" : process.platform,
		transport: { ...local.transport, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) },
		workspaceTransport: { command: process.execPath, args: [helper, config] },
	};
	const db = join(f.dir, "fleet.sqlite");
	let store = new FleetStore(db);
	if (options.legacyRow) {
		// A node row as an earlier version wrote it: no transport.timeoutMs, written straight to the table.
		expect(node.transport.timeoutMs).toBeUndefined();
		store.close();
		const raw = new Database(db);
		raw.query("INSERT INTO nodes(id,data) VALUES (?,?)").run(node.id, canonicalJson(node));
		raw.close();
		store = new FleetStore(db);
	} else store.putNode(node);
	const fleet = new Fleet(store);
	const input: TaskInput = { schemaVersion: 1, key: "rpc-timeout", caller: "rpc-timeout-test", repoId: "fixture", baseCommit: f.baseCommit, prompt: "controlled prompt", required: {} };
	const id = store.reserve(store.submit(input).id, headroom([node.id], 10)).id;
	async function calls() {
		const all = (JSON.parse(await readFile(state, "utf8")) as ControlledState).calls;
		return { start: all.filter((c) => c.name.endsWith("start_session")).length, send: all.filter((c) => c.name.endsWith("send_prompt")).length, read: all.filter((c) => c.name.endsWith("read_turn")).length };
	}
	async function change(patch: Partial<ControlledState>) {
		await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), ...patch }));
	}
	const unknownEvents = () => store.events(id).filter((e) => e.kind === "unknown");
	return { ...f, db, node, store, fleet, id, calls, change, unknownEvents };
}
type Fx = Awaited<ReturnType<typeof fixture>>;

/** The exact persisted diagnostic of a timed-out call. */
function timeoutDiagnostic(source: DiagnosticSource, operationKind: DiagnosticStep["operationKind"], timeoutMs: number): FailureDiagnostic {
	return {
		version: 1, use: "diagnostic_only_not_evidence", source, phase: "call",
		...(operationKind ? { operationKind, operationId: expect.stringMatching(/^[0-9a-f-]{36}$/) } : {}),
		errorClass: "TransportError", code: "transport:transport_timeout", message: DIAGNOSTIC_TEXT.get("transport:transport_timeout")!, timeoutMs,
	};
}
async function sendAnsweredWithin(f: Fx) {
	const started = performance.now();
	const task = await f.fleet.start(f.id);
	const elapsed = performance.now() - started;
	expect(task).toMatchObject({ phase: "active", sessionId: "controlled-session", turnId: "controlled-turn", held: true });
	expect(task.reason).toBeUndefined();
	expect(f.unknownEvents()).toEqual([]);
	expect(await f.calls()).toEqual({ start: 1, send: 1, read: 0 });
	f.store.close();
	return elapsed;
}
/** The send timed out after delivery: unknown, the limit in the diagnostic, and never re-sent. */
async function sendTimedOut(f: Fx, timeoutMs: number, hangMs: number) {
	const started = performance.now();
	const task = await f.fleet.start(f.id);
	const elapsed = performance.now() - started;
	expect(task).toMatchObject({ phase: "blocked_unknown", reason: "transport_timeout", sessionId: "controlled-session", held: true });
	expect(task.turnId).toBeUndefined();
	const events = f.unknownEvents();
	expect(events).toHaveLength(1);
	expect((events[0]!.data as any).failureDiagnostic).toEqual(timeoutDiagnostic("Fleet.start.prompt", "prompt", timeoutMs));
	expect(f.store.reasonDiagnostic(f.id)?.diagnostic).toEqual(timeoutDiagnostic("Fleet.start.prompt", "prompt", timeoutMs));
	// The prompt was delivered (the Coordinator persisted it before its late answer).
	expect(await f.calls()).toEqual({ start: 1, send: 1, read: 0 });
	// Outlive the controlled answer, then start again: the uncertain send is still never re-sent.
	await Bun.sleep(Math.max(0, hangMs - elapsed) + 300);
	const again = await f.fleet.start(f.id).catch((error) => error);
	expect(again instanceof FleetError || again?.phase === "blocked_unknown").toBe(true);
	expect(f.store.task(f.id)).toMatchObject({ phase: "blocked_unknown", held: true });
	expect(await f.calls()).toEqual({ start: 1, send: 1, read: 0 });
	f.store.close();
	return elapsed;
}

// ---- defaults: just under and just over, posix and win32 ------------------------------------------------
const posix = DEFAULT_NODE_RPC_TIMEOUT_MS.posix;
const win32 = DEFAULT_NODE_RPC_TIMEOUT_MS.win32;
test("the OS defaults are 30 s for posix and 120 s for win32", () => {
	expect(DEFAULT_NODE_RPC_TIMEOUT_MS).toEqual({ posix: 30_000, win32: 120_000 });
});
test.concurrent("posix node, default limit (legacy node row without the field): a send answered 1 s under 30 s is recorded active", async () => {
	const f = await fixture({ os: "posix", legacyRow: true, state: { hang: "send", hangMs: posix - SECOND } });
	expect(nodeRpcTimeoutMs(f.store.task(f.id)!.nodeSnapshot!)).toBe(posix);
	expect(await sendAnsweredWithin(f)).toBeGreaterThan(posix - SECOND);
}, 3 * 60 * SECOND);
test.concurrent("posix node, default limit: a send answered well over 30 s is unknown near the 30 s limit, never re-sent", async () => {
	const hangMs = posix + TIMER_SLACK + SECOND;
	const f = await fixture({ os: "posix", state: { hang: "send", hangMs } });
	const elapsed = await sendTimedOut(f, posix, hangMs);
	expect(elapsed).toBeGreaterThanOrEqual(posix);
	expect(elapsed).toBeLessThan(posix + TIMER_SLACK);
}, 3 * 60 * SECOND);
test.concurrent("win32 node, default limit: a send answered 1 s under 120 s (far over the old 30 s) is recorded active", async () => {
	const f = await fixture({ os: "win32", state: { hang: "send", hangMs: win32 - SECOND } });
	expect(await sendAnsweredWithin(f)).toBeGreaterThan(win32 - SECOND);
}, 4 * 60 * SECOND);
test.concurrent("win32 node, default limit: a send answered well over 120 s is unknown near the 120 s limit, never re-sent", async () => {
	const hangMs = win32 + TIMER_SLACK + SECOND;
	const f = await fixture({ os: "win32", state: { hang: "send", hangMs } });
	const elapsed = await sendTimedOut(f, win32, hangMs);
	expect(elapsed).toBeGreaterThanOrEqual(win32);
	expect(elapsed).toBeLessThan(win32 + TIMER_SLACK);
}, 4 * 60 * SECOND);
test.concurrent("win32 legacy node row without the field gets the win32 default and admits new work", async () => {
	const f = await fixture({ os: "win32", legacyRow: true });
	expect(nodeRpcTimeoutMs(f.store.task(f.id)!.nodeSnapshot!)).toBe(win32);
	await sendAnsweredWithin(f);
}, 60 * SECOND);

// ---- an explicit per-node value overrides the default ---------------------------------------------------
test.concurrent("win32 node with transport.timeoutMs 5000: answered 1 s under is active, 1 s over is unknown with 5000 in the diagnostic", async () => {
	const under = await fixture({ os: "win32", timeoutMs: 5000, state: { hang: "send", hangMs: 4000 } });
	await sendAnsweredWithin(under);
	const over = await fixture({ os: "win32", timeoutMs: 5000, state: { hang: "send", hangMs: 6000 } });
	const elapsed = await sendTimedOut(over, 5000, 6000);
	expect(elapsed).toBeLessThan(6000);
}, 60 * SECOND);
test.concurrent("posix node with transport.timeoutMs 45000: a send answered at 31 s (over the posix default) is active", async () => {
	const f = await fixture({ os: "posix", timeoutMs: 45_000, state: { hang: "send", hangMs: posix + SECOND } });
	expect(await sendAnsweredWithin(f)).toBeGreaterThan(posix);
}, 3 * 60 * SECOND);
test.concurrent("create is bounded by the same per-node limit: a create answered 1 s over 5000 is unknown at Fleet.start.create, never re-sent", async () => {
	const f = await fixture({ os: "posix", timeoutMs: 5000, state: { hang: "start", hangMs: 6000 } });
	const task = await f.fleet.start(f.id);
	expect(task).toMatchObject({ phase: "blocked_unknown", reason: "transport_timeout", held: true });
	expect((f.unknownEvents()[0]!.data as any).failureDiagnostic).toEqual(timeoutDiagnostic("Fleet.start.create", "create", 5000));
	await Bun.sleep(1500);
	await f.fleet.start(f.id).catch(() => undefined);
	expect(await f.calls()).toEqual({ start: 1, send: 0, read: 0 });
	f.store.close();
}, 60 * SECOND);
test.concurrent("exactly at the limit (answer delayed by exactly transport.timeoutMs): one consistent outcome, one send, never re-sent", async () => {
	const f = await fixture({ os: "posix", timeoutMs: 5000, state: { hang: "send", hangMs: 5000 } });
	const task = await f.fleet.start(f.id);
	// The timer fires no earlier than 5000 ms after the write; the delayed answer arrives just after 5000 ms of
	// fixture sleep plus its own I/O, so either may win. Both outcomes must be complete and consistent.
	if (task.phase === "active") expect(f.unknownEvents()).toEqual([]);
	else {
		expect(task).toMatchObject({ phase: "blocked_unknown", reason: "transport_timeout" });
		expect((f.unknownEvents()[0]!.data as any).failureDiagnostic).toEqual(timeoutDiagnostic("Fleet.start.prompt", "prompt", 5000));
	}
	await Bun.sleep(1000);
	await f.fleet.start(f.id).catch(() => undefined);
	expect(await f.calls()).toEqual({ start: 1, send: 1, read: 0 });
	f.store.close();
}, 60 * SECOND);

// ---- reads use the observation limit max(transport.timeoutMs, OS floor); effects keep transport.timeoutMs ----
test.concurrent("strict inspect: read_turn answered under the observation limit observes (even past transport.timeoutMs); over it it is unknown with the observation limit in the diagnostic; a send on the same node stays bounded by transport.timeoutMs", async () => {
	const f = await fixture({ os: "posix", timeoutMs: 5000 });
	const observation = nodeObservationTimeoutMs(f.node);
	expect(observation).toBe(posix);
	// The same node configuration with a send that answers 1 s over 5000: unknown at 5000, never re-sent.
	const sendOver = fixture({ os: "posix", timeoutMs: 5000, state: { hang: "send", hangMs: 6000 } }).then((over) => sendTimedOut(over, 5000, 6000));
	await f.fleet.start(f.id);
	await f.change({ hang: "read", hangMs: 4000 });
	expect((await f.fleet.inspect(f.id)).task).toMatchObject({ phase: "active" });
	// Past the 5000 transport limit but under the observation limit: still observed, nothing unknown.
	await f.change({ hangMs: 6000 });
	expect((await f.fleet.inspect(f.id)).task).toMatchObject({ phase: "active" });
	expect(f.unknownEvents()).toEqual([]);
	await f.change({ hangMs: observation + TIMER_SLACK + SECOND });
	const started = performance.now();
	const inspected = await f.fleet.inspect(f.id);
	const elapsed = performance.now() - started;
	expect(elapsed).toBeGreaterThanOrEqual(observation);
	expect(elapsed).toBeLessThan(observation + TIMER_SLACK);
	expect(inspected.task).toMatchObject({ phase: "blocked_unknown", held: true });
	expect(f.unknownEvents()).toHaveLength(1);
	expect((f.unknownEvents()[0]!.data as any).failureDiagnostic).toEqual(timeoutDiagnostic("Fleet.inspect.read_turn", undefined, observation));
	expect(await f.calls()).toEqual({ start: 1, send: 1, read: 3 });
	expect(await sendOver).toBeLessThan(6000);
	await Bun.sleep(1500);
	f.store.close();
}, 90 * SECOND);

// ---- explicit caller deadlines keep their meaning ---------------------------------------------------------
test("an explicit caller deadline (onboarding 5 s, preflight timeoutMs) wins over the node value; the timeout carries it", async () => {
	const node = { os: "win32", transport: { command: process.execPath, args: ["--eval", "for await (const p of Bun.stdin.stream()) {}"], timeoutMs: 600_000 } };
	const rpc = nodeRpc(node, 50);
	const started = performance.now();
	const error = await rpc.request("initialize", {}).catch((e) => e);
	rpc.close();
	expect(performance.now() - started).toBeLessThan(5000);
	expect(error).toBeInstanceOf(TransportError);
	expect(error).toMatchObject({ code: "transport_timeout", certainty: "unknown", timeoutMs: 50 });
});

// ---- validation at node add --------------------------------------------------------------------------------
function sampleNode(transport: Record<string, unknown>): unknown {
	return {
		id: "n1", os: "win32", arch: "x64", roots: { r: "C:\\repo" }, workspaceRoot: "C:\\ws", enabled: false, draining: false, reachable: false,
		sdkReady: false, modelReady: false, models: [], operations: [], transport: { command: "ssh", args: ["host"], ...transport },
	};
}
test("transport.timeoutMs is validated at the bounds: 4999 and 600001 rejected, 5000/5001/599999/600000 accepted", () => {
	for (const ok of [5000, 5001, 599_999, 600_000]) {
		const node = sampleNode({ timeoutMs: ok });
		validateNode(node);
		expect(nodeRpcTimeoutMs(node as NodeConfig)).toBe(ok);
	}
	for (const bad of [4999, 600_001, 0, -5000, 30_000.5, "30000", null, true, [30000], { ms: 30000 }, Number.MAX_SAFE_INTEGER + 1])
		expect(() => validateNode(sampleNode({ timeoutMs: bad }))).toThrow(FleetError);
	// Only the Coordinator transport has a configurable per-call limit.
	expect(() => validateNode({ ...(sampleNode({}) as object), sdkTransport: { command: "ssh", args: [], timeoutMs: 30000 } })).toThrow(FleetError);
	expect(() => validateNode({ ...(sampleNode({}) as object), workspaceTransport: { command: "ssh", args: [], timeoutMs: 30000 } })).toThrow(FleetError);
	// A snapshot that somehow bypassed validation is refused before anything is spawned.
	expect(() => nodeRpcTimeoutMs({ os: "linux", transport: { command: "x", args: [], timeoutMs: 1 } })).toThrow(FleetError);
	expect(nodeRpcTimeoutMs({ os: "darwin", transport: { command: "x", args: [] } })).toBe(30_000);
	expect(nodeRpcTimeoutMs({ os: "linux", transport: { command: "x", args: [] } })).toBe(30_000);
	expect(nodeRpcTimeoutMs({ os: "win32", transport: { command: "x", args: [] } })).toBe(120_000);
});

async function cli(db: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", db, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exit, stdout, stderr };
}
test("CLI node add rejects an out-of-range timeout and stores nothing; node list (also --read-only) shows the effective value", async () => {
	const f = await repositoryFixture("fleet-rpc-timeout-cli-");
	dirs.push(f.dir);
	const db = join(f.dir, "fleet.sqlite");
	new FleetStore(db).close();
	const write = async (name: string, value: unknown) => {
		const path = join(f.dir, name);
		await writeFile(path, JSON.stringify(value));
		return path;
	};
	const node = (id: string, os: string, transport: Record<string, unknown>) => ({ ...(sampleNode(transport) as object), id, os });
	const bad = await cli(db, "node", "add", await write("bad.json", node("bad", "win32", { timeoutMs: 4999 })));
	expect(bad.exit).not.toBe(0);
	expect(JSON.parse(bad.stderr)).toEqual({ ok: false, error: "INVALID_INPUT" });
	expect((await cli(db, "node", "add", await write("big.json", node("big", "win32", { timeoutMs: 600_001 })))).exit).not.toBe(0);
	for (const [file, value] of [
		["p.json", node("p", "linux", {})],
		["w.json", node("w", "win32", {})],
		["c.json", node("c", "win32", { timeoutMs: 5000 })],
	] as const)
		expect(await cli(db, "node", "add", await write(file, value))).toMatchObject({ exit: 0, stderr: "" });
	// The rejected nodes were not stored: only c, p and w are listed.
	for (const prefix of [[], ["--read-only"]]) {
		const listed = await cli(db, ...prefix, "node", "list");
		expect(listed.exit).toBe(0);
		const nodes = JSON.parse(listed.stdout) as any[];
		expect(nodes.map((n) => [n.id, n.transport.timeoutMs ?? null, n.effectiveRpcTimeoutMs])).toEqual([
			["c", 5000, 5000],
			["p", null, 30_000],
			["w", null, 120_000],
		]);
	}
});

// ---- diagnostic rule ---------------------------------------------------------------------------------------
test("the diagnostic keeps timeoutMs only for a classified transport timeout with a bounded integer", () => {
	const base: FailureDiagnostic = { version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prompt", phase: "call", errorClass: "TransportError", code: "transport:transport_timeout", message: DIAGNOSTIC_TEXT.get("transport:transport_timeout")! };
	expect(normalizeDiagnostic({ ...base, timeoutMs: 120_000 })).toEqual({ ...base, timeoutMs: 120_000 });
	// A stored diagnostic written before this field existed still loads unchanged.
	expect(normalizeDiagnostic(base)).toEqual(base);
	for (const forged of [0, 600_001, 1.5, "120000", null, { v: 1 }]) expect(normalizeDiagnostic({ ...base, timeoutMs: forged })).toEqual(base);
	expect(normalizeDiagnostic({ ...base, code: "transport:transport_closed", message: "x", timeoutMs: 30_000 })).not.toHaveProperty("timeoutMs");
	expect(normalizeDiagnostic({ ...base, errorClass: "Error", timeoutMs: 30_000 })).not.toHaveProperty("timeoutMs");
});

test("every conversion in this file carried a valid diagnostic (completeness guard)", () => {
	expect(guard.allViolations).toEqual([]);
	expect(guard.checked.calls).toBeGreaterThan(0);
});
