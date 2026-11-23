// Diagnostics on the catch sites that exist only on production main: receipt-less settlement
// (Fleet.inspect.receiptless), the read-only late-receipt check (no state change, so no
// diagnostic), and a failing transport close in Fleet.start (review I-2, Fleet.start.close).
import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { DIAGNOSTIC_TEXT } from "../src/diagnostic";
import { Fleet } from "../src/fleet";
import { TransportError } from "../src/rpc";
import { FleetStore } from "../src/store";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

const coordinatorPath = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const executionPath = fileURLToPath(new URL("./fixtures/execution-query.ts", import.meta.url));
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INTERVAL = 60_000;
// Full-suite HUB load: default 5s per-test budget is too tight for fixture+start+inspect.
const TEST_SLACK_MS = 30_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const SECRET = "C:\\Users\\alice\\.ssh\\id_rsa token=ghp_ABCDEFGHIJKLMNOP build01.corp.example.com";
const LEAKS = ["alice", "id_rsa", "ghp_", "build01", "corp.example"];
const cleanups: (() => Promise<void> | void)[] = [];
/** Unexpected store.close failures during cleanup (expected already-closed is swallowed). */
const closeCleanupErrors: string[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	const unexpected = closeCleanupErrors.splice(0);
	if (unexpected.length > 0) {
		throw new Error(`store.close cleanup hid unexpected errors: ${unexpected.join(" | ")}`);
	}
});

/** The production shape: agent turn failed after start and GJC wrote no command receipt. */
const turn = {
	ok: true,
	turn: {
		session_id: SESSION, turn_id: TURN, prompt: { text: "CONTROLLED prompt", source: "mcp", created_at: "2026-11-12T09:00:00.000Z" },
		status: "failed", completed_at: "2026-11-12T09:41:07.512Z", error: { code: "unavailable", message: "Coordinator service is unavailable" },
		delivery: { runtime_command_id: "runtime-command-1", runtime_turn_id: "runtime-turn-1", prompt_acknowledged: true, queued: false },
	},
	advisory_status: { authority: "sdk", is_streaming: false },
	session_state: { session_id: SESSION, current_turn_id: null, activity: { phase: "finished" }, active_tool_count: 0, state: "errored", ended_at: "2026-11-12T09:41:07.600Z", ready_for_input: false },
};
const execution = {
	status: "failed", receiptState: "missing", terminalAt: 1_763_000_467_512,
	outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", phase: "post_start", category: "agent_runtime", message: "model stream stalled" },
};
const input = (baseCommit: string): TaskInput => ({ schemaVersion: 1, key: "receiptless", caller: "controlled-operator", repoId: "repo", baseCommit, prompt: "CONTROLLED prompt", required: {} });

async function scenario() {
	const repo = await repositoryFixture("fleet-receiptless-diag-");
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
	cleanups.push(() => {
		try {
			store.close();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Expected under timed-out sibling teardown; anything else must surface.
			if (/database has closed|database is not open|already closed/i.test(message)) return;
			closeCleanupErrors.push(message);
		}
	});
	store.putNode(node);
	let now = T0;
	let clockCalls = 0;
	let throwOnClockCall: number | undefined;
	const fleet = new Fleet(store, {
		localNodeId: node.id,
		clock: () => {
			clockCalls++;
			if (clockCalls === throwOnClockCall) throw new Error(SECRET);
			return now;
		},
	} as any);
	const started = await fleet.start(fleet.submit(input(repo.baseCommit)).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	const state: ControlledState = JSON.parse(await readFile(statePath, "utf8"));
	await writeFile(statePath, JSON.stringify({ ...state, readTurn: turn }));
	await writeFile(executionState, JSON.stringify(execution));
	return {
		store, fleet, id: started.id,
		async inspect(ms: number, options: { throwOnClockCall?: number } = {}) {
			now = T0 + ms;
			clockCalls = 0;
			throwOnClockCall = options.throwOnClockCall;
			try { return await fleet.inspect(started.id); } finally { throwOnClockCall = undefined; }
		},
	};
}
const diagnosticOf = (store: FleetStore, id: string) => (store.events(id).findLast((e) => e.kind === "unknown")!.data as any);
const expected = (source: string, phase: string, errorClass: string, code: string) => ({ version: 1, use: "diagnostic_only_not_evidence", source, phase, errorClass, code, message: DIAGNOSTIC_TEXT.get(code)! });

test("receipt-less evaluation failure: the unknown observation keeps base reason and records Fleet.inspect.receiptless/validate", async () => {
	const f = await scenario();
	// Clock call 1 is the late-receipt window check, call 2 the receipt-less confirmation.
	const { task } = await f.inspect(0, { throwOnClockCall: 2 });
	expect(task).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
	const data = diagnosticOf(f.store, f.id);
	expect(data).not.toHaveProperty("failure");
	expect(data.failureDiagnostic).toEqual(expected("Fleet.inspect.receiptless", "validate", "Error", "unclassified"));
	for (const leak of LEAKS) expect(JSON.stringify(f.store.events(f.id))).not.toContain(leak);
}, TEST_SLACK_MS);

test("receipt-less settlement record failure: the unknown observation records Fleet.inspect.receiptless/record", async () => {
	const f = await scenario();
	expect((await f.inspect(0)).task.held).toBe(true);
	const observe = f.store.observe.bind(f.store);
	f.store.observe = ((...args: Parameters<FleetStore["observe"]>) => {
		if ((args[1] as any).settlement) throw new Error(SECRET);
		return observe(...args);
	}) as FleetStore["observe"];
	const { task } = await f.inspect(INTERVAL);
	expect(task).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
	expect(diagnosticOf(f.store, f.id).failureDiagnostic).toEqual(expected("Fleet.inspect.receiptless", "record", "Error", "unclassified"));
	for (const leak of LEAKS) expect(JSON.stringify(f.store.events(f.id))).not.toContain(leak);
	expect(f.store.events(f.id).filter((e) => e.kind === "released")).toHaveLength(0);
}, TEST_SLACK_MS);

test("late-receipt check failure changes no state and records nothing (no conversion, so no diagnostic)", async () => {
	const f = await scenario();
	await f.inspect(0);
	const settled = (await f.inspect(INTERVAL)).task;
	expect(settled).toMatchObject({ phase: "failed", held: false });
	const before = f.store.events(f.id);
	(f.fleet as any).connect = async () => { throw new TransportError("transport_exited", "unknown", SECRET); };
	const late = await f.inspect(2 * INTERVAL);
	expect(late).toEqual({ task: settled, lateReceipt: { checked: false } });
	expect(f.store.events(f.id)).toEqual(before);
	expect(f.store.task(f.id)).toEqual(settled);
}, TEST_SLACK_MS);

test("review I-2: a throwing transport close in Fleet.start is labelled Fleet.start.close, not as the last step", async () => {
	const f = await scenario();
	const task = f.store.reserve(f.store.submit({ ...input("a".repeat(40)), key: "close" }).id);
	(f.fleet as any).node = async () => ({ schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: task.nodeId!, inputDigest: task.inputDigest, baseCommit: task.input.baseCommit, path: "/nonexistent-close-test" });
	(f.fleet as any).connect = async () => ({
		close() { throw new TransportError("transport_closed", "unknown", SECRET); },
		async call(name: string) {
			if (name === "gjc_coordinator_start_session") throw new TransportError("rpc_error", "unknown");
			throw new Error("unexpected_call");
		},
	});
	const result = await f.fleet.start(task.id);
	// Base outcome: the close error replaces the create error (finally), exactly as before.
	expect(result).toMatchObject({ phase: "blocked_unknown", held: true, reason: "transport_closed" });
	const data = diagnosticOf(f.store, task.id);
	expect(data.failure).toMatchObject({ source: "Fleet.start.create", errorType: "transport_error" });
	expect(data.failureDiagnostic).toEqual(expected("Fleet.start.close", "call", "TransportError", "transport:transport_closed"));
}, TEST_SLACK_MS);
