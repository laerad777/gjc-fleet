import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { hostname } from "node:os";
import { exitCodeHelp, exitCodeMarkdown, exitCodes, runTask, watchTasks, worstExit } from "../src/operator-commands";
import { observationDigest } from "../src/core";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

// Real temporary SQLite, Git/workspaces, controlled public stdio Coordinator and the real CLI process. No live service.
const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
	const f = await repositoryFixture("fleet-exit-"); dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const config = join(f.dir, "node.json");
	const node: NodeConfig = { id: "controlled", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot: f.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"],
		transport: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url)), state] },
		workspaceTransport: { command: process.execPath, args: [fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url)), config] } };
	await writeFile(config, JSON.stringify(node));
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db); stores.push(store); store.putNode(node);
	const fleet = new Fleet(store);
	const input: TaskInput = { schemaVersion: 1, key: "exit-one", caller: "exit-test", repoId: "fixture", baseCommit: f.baseCommit, prompt: "private prompt", required: {} };
	const file = join(f.dir, "task.json");
	await writeFile(file, JSON.stringify(input));
	const sample = async () => headroom([node.id], 10).samples;
	async function change(patch: Record<string, unknown>) { await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), ...patch })); }
	async function calls() {
		const all = JSON.parse(await readFile(state, "utf8")).calls as { name: string }[];
		return { start: all.filter(c => c.name.endsWith("start_session")).length, send: all.filter(c => c.name.endsWith("send_prompt")).length };
	}
	/** Reserve exactly as submit/run admission does, without an operator-run claim (an interrupted or first run). */
	function reserve(key = input.key) { return store.reserve(store.submit({ ...input, key }).id, headroom([node.id], 10)); }
	function release() { const i = stores.indexOf(store); if (i >= 0) { stores.splice(i, 1); store.close(); } }
	function read() { const s = new FleetStore(db, 2, { readOnly: true }); try { return { task: s.tasks()[0]!, operatorRun: s.tasks()[0] ? s.getOperation(s.tasks()[0]!.id, "operator-run") : undefined }; } finally { s.close(); } }
	return { ...f, db, state, store, fleet, input, file, sample, node, change, calls, reserve, release, read };
}
/** The real CLI entry point in its own process: exit code, every stdout JSON line, stderr. */
async function cli(db: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", db, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	// Operator commands print one JSON value per line; other commands pretty-print a single value.
	let lines: any[];
	try { lines = stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)); }
	catch { lines = [JSON.parse(stdout)]; }
	return { exit, lines, last: lines.at(-1), stderr };
}

// ---- Reviewer reproductions (ee0dab0a), ported as regression tests ----

for (const hang of ["start", "send"] as const) {
	test(`N1 concurrent CLI run while the first run's ${hang} ack is delayed: the owner exits 0 with the acknowledged turn, the other exits 7 with no effect`, async () => {
		const f = await fixture();
		f.reserve(); f.release();
		await f.change({ hang, hangMs: 4000 });
		const first = cli(f.db, "run", f.file);
		for (let i = 0; i < 400; i++) { const c = await f.calls(); if ((hang === "start" ? c.start : c.send) === 1) break; await Bun.sleep(25); }
		expect(await f.calls()).toMatchObject(hang === "start" ? { start: 1, send: 0 } : { start: 1, send: 1 });
		const second = await cli(f.db, "run", f.file);
		const a = await first;
		const final = f.read();
		expect({ exit: second.exit, stderr: second.stderr }).toEqual({ exit: 7, stderr: "" });
		expect(second.last).toMatchObject({ taskId: final.task.id, reused: true, exit: 7, outcome: "in_progress" });
		expect({ exit: a.exit, stderr: a.stderr }).toEqual({ exit: 0, stderr: "" });
		expect(a.last).toMatchObject({ taskId: final.task.id, phase: "active", sessionId: "controlled-session", exit: 0, outcome: "ok" });
		expect(final.task).toMatchObject({ phase: "active", sessionId: "controlled-session", turnId: "controlled-turn", held: true });
		expect(final.task.reason).toBeUndefined();
		// The audit receipt is written by the run that owned the start and matches the recorded turn.
		expect(final.operatorRun?.receipt).toEqual({ phase: "active", sessionId: "controlled-session", turnId: "controlled-turn" });
		expect(await f.calls()).toEqual({ start: 1, send: 1 });
	}, 60000);
}

test("N2 watch --all-active reports a watched task fenced blocked_unknown by another poller between polls (exit 3, line emitted)", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(run.code).toBe(0);
	const output: any[] = [];
	let fenced = false;
	const exit = await watchTasks(f.fleet, { allActive: true, interval: 10, maxPolls: 5, emit: v => output.push(v), sleep: async () => {
		if (fenced) return;
		fenced = true;
		// A concurrent strict observer (CLI poll, dashboard) hits a read failure and fences the task.
		await f.change({ lose: "read" });
		expect((await new Fleet(f.store).inspect(run.task.id)).task.phase).toBe("blocked_unknown");
		await f.change({ lose: undefined });
	} });
	expect(f.store.task(run.task.id)!.phase).toBe("blocked_unknown");
	expect(output.filter(v => v.taskId === run.task.id).map(v => v.phase)).toEqual(["active", "blocked_unknown"]);
	expect(exit).toBe(3);
	expect(output.at(-1)).toEqual({ observation: "summary", exit: 3, outcome: "blocked_unknown", tasks: { [run.task.id]: 3 } });
});

test("N2 watch --all-active reports a watched task that another actor settles failed between polls (exit 4)", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	const output: any[] = [];
	let settled = false;
	const exit = await watchTasks(f.fleet, { allActive: true, interval: 10, maxPolls: 5, emit: v => output.push(v), sleep: async () => {
		if (settled) return;
		settled = true;
		const task = f.store.task(run.task.id)!;
		const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "failed" as const, terminal: true, evidence: { source: "other-actor" } };
		f.store.observe(run.task.id, { ...body, eventId: "other-actor-failed", digest: observationDigest(body) });
	} });
	expect(f.store.task(run.task.id)!.phase).toBe("failed");
	expect(output.filter(v => v.taskId === run.task.id).map(v => v.phase)).toEqual(["active", "failed"]);
	expect(exit).toBe(4);
});

test("N3 aggregation: a blocked_unknown task is never masked by another task's unavailable observation (3, not 5)", async () => {
	const f = await fixture();
	const a = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(a.code).toBe(0);
	// A second acknowledged attempt; every read of either task now fails in transport (not a binding mismatch).
	const b = { task: f.reserve("exit-two") };
	f.store.recordSession(b.task.id, "second-session"); f.store.recordTurn(b.task.id, "second-turn");
	await f.change({ lose: "read" });
	let n = 0;
	const output: any[] = [];
	const exit = await watchTasks(f.fleet, { allActive: true, interval: 10, maxPolls: 4, emit: v => output.push(v), sleep: async () => {
		if (n++ === 0) f.store.markUnknown(a.task.id, "concurrent_fence");
	} });
	expect(f.store.task(a.task.id)!.phase).toBe("blocked_unknown");
	expect(f.store.task(b.task.id)).toMatchObject({ phase: "preparing", held: true });
	expect(output.filter(v => v.taskId === b.task.id && v.observation === "unavailable")).toHaveLength(2);
	expect(exit).toBe(3);
	expect(output.at(-1)).toMatchObject({ observation: "summary", exit: 3, tasks: { [a.task.id]: 3, [b.task.id]: 5 } });
});

test("N4 tolerant inspection does not relabel a local error after a good read as unavailable; it takes the strict path", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	const original = f.store.observe.bind(f.store);
	(f.store as any).observe = () => { throw new TypeError("local bug, not a read failure"); };
	let result: any;
	try { result = await f.fleet.inspect(run.task.id, { tolerateReadFailure: true }); }
	finally { (f.store as any).observe = original; }
	expect(result.task.phase).toBe("blocked_unknown");
	expect(f.store.task(run.task.id)!.phase).toBe("blocked_unknown");
	expect(f.store.events(run.task.id).filter(e => e.kind === "unknown")).toHaveLength(1);
});

test("N4 tolerant inspection fences a remote identity mismatch exactly like the strict poll", async () => {
	const f = await fixture();
	const task = f.reserve("mismatch");
	f.store.recordSession(task.id, "other-session"); f.store.recordTurn(task.id, "other-turn");
	await f.change({ session: { session_id: "controlled-session" }, turnId: "controlled-turn" });
	const result = await f.fleet.inspect(task.id, { tolerateReadFailure: true });
	expect(result.task.phase).toBe("blocked_unknown");
	expect(f.store.events(task.id).some(e => e.kind === "unknown")).toBe(true);
});

test("N4 a failed tolerant read never suppresses a concurrent strict poll's fence (concurrent Fleet calls)", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	await f.change({ lose: "read" });
	const [strict, tolerant] = await Promise.allSettled([f.fleet.inspect(run.task.id), f.fleet.inspect(run.task.id, { tolerateReadFailure: true })]);
	expect(strict.status).toBe("fulfilled");
	// Whichever read fails last, the strict failure fences: either directly (the tolerant read was already
	// abandoned) or when the later tolerant read is abandoned, which then reports the fenced task.
	if (tolerant.status === "rejected") expect(tolerant.reason).toMatchObject({ code: "OBSERVATION_UNAVAILABLE" });
	else expect(tolerant.value.task.phase).toBe("blocked_unknown");
	expect(f.store.task(run.task.id)!.phase).toBe("blocked_unknown");
	expect(f.store.events(run.task.id).filter(e => e.kind === "unknown")).toHaveLength(1);
});

for (const order of ["strict failure first", "tolerant failure first"] as const) {
	test(`N4 store ordering: strict read n then tolerant read n+1, both fail, ${order}: the strict fence applies`, async () => {
		const f = await fixture();
		const run = await runTask(f.fleet, f.input, { sample: f.sample });
		const strict = f.store.beginObservation(run.task.id)!;
		const tolerant = f.store.beginObservation(run.task.id)!;
		expect(tolerant).toBe(strict + 1);
		if (order === "strict failure first") {
			expect(f.store.markObservationUnknown(run.task.id, strict, "observation_unavailable_original_attempt_held").phase).toBe("active");
			expect(f.store.abandonObservation(run.task.id, tolerant).phase).toBe("blocked_unknown");
		} else {
			expect(f.store.abandonObservation(run.task.id, tolerant).phase).toBe("active");
			expect(f.store.markObservationUnknown(run.task.id, strict, "observation_unavailable_original_attempt_held").phase).toBe("blocked_unknown");
		}
		expect(f.store.task(run.task.id)).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
		expect(f.store.events(run.task.id).filter(e => e.kind === "unknown")).toHaveLength(1);
	});
}

test("N4 a later successful read still supersedes an earlier strict failure; an abandoned read alone marks nothing", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	const lone = f.store.beginObservation(run.task.id)!;
	expect(f.store.abandonObservation(run.task.id, lone)).toMatchObject({ phase: "active", held: true });
	const strict = f.store.beginObservation(run.task.id)!;
	await f.change({ terminal: true });
	const good = await f.fleet.inspect(run.task.id, { tolerateReadFailure: true });
	expect(good.task.result?.executionTerminal).toBe(true);
	expect(f.store.markObservationUnknown(run.task.id, strict, "observation_unavailable_original_attempt_held").phase).toBe("completed_unverified");
	expect(f.store.events(run.task.id).some(e => e.kind === "unknown")).toBe(false);
});

// ---- The exit-code table: one real-CLI test per row, asserting the process exit and the stdout JSON ----

const rows: Record<number, () => Promise<void>> = {
	0: async () => {
		const f = await fixture();
		const task = f.reserve(); f.release();
		const r = await cli(f.db, "run", f.file);
		expect(r.exit).toBe(0);
		expect(r.lines).toHaveLength(1);
		expect(r.last).toMatchObject({ taskId: task.id, phase: "active", sessionId: "controlled-session", reused: true, exit: 0, outcome: "ok" });
		expect(f.read().task).toMatchObject({ phase: "active", turnId: "controlled-turn" });
		expect(await f.calls()).toEqual({ start: 1, send: 1 });
	},
	1: async () => {
		const f = await fixture(); f.release();
		const r = await cli(f.db, "run");
		expect(r.exit).toBe(1);
		expect(r.lines).toEqual([{ ok: false, error: "usage_run_TASK_JSON_wait", exit: 1, outcome: "error" }]);
		expect(JSON.parse(r.stderr)).toEqual({ ok: false, error: "usage_run_TASK_JSON_wait" });
		const w = await cli(f.db, "watch", "--all-active", "--interval", "5");
		expect(w.exit).toBe(1);
		expect(w.lines).toEqual([{ ok: false, error: "invalid_watch_bounds", exit: 1, outcome: "error" }]);
		expect(await f.calls()).toEqual({ start: 0, send: 0 });
	},
	2: async () => {
		const f = await fixture(); f.release();
		const r = await cli(join(f.dir, "no-nodes.sqlite"), "run", f.file);
		expect(r.exit).toBe(2);
		expect(r.lines).toHaveLength(1);
		expect(r.last).toMatchObject({ phase: "queued", nodeId: null, sessionId: null, reused: false, exit: 2, outcome: "queued" });
		expect(await f.calls()).toEqual({ start: 0, send: 0 });
	},
	3: async () => {
		const f = await fixture();
		const task = f.reserve(); f.release();
		await f.change({ lose: "send" });
		const r = await cli(f.db, "run", f.file);
		expect(r.exit).toBe(3);
		expect(r.last).toMatchObject({ taskId: task.id, phase: "blocked_unknown", exit: 3, outcome: "blocked_unknown" });
		expect(await f.calls()).toEqual({ start: 1, send: 1 });
		const again = await cli(f.db, "run", f.file, "--wait");
		expect(again.exit).toBe(3);
		expect(again.lines).toHaveLength(1);
		expect(again.last).toMatchObject({ taskId: task.id, phase: "blocked_unknown", exit: 3, outcome: "blocked_unknown" });
		expect(await f.calls()).toEqual({ start: 1, send: 1 });
	},
	4: async () => {
		const f = await fixture();
		const result = { kind: "prompt", commandId: "controlled-runtime-command", turnId: "controlled-runtime-turn", status: "failed", receiptState: "present", terminalAt: 123,
			outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "controlled failure" } };
		f.store.putNode({ ...f.node, sdkTransport: { command: process.execPath, args: ["--eval",
			`await new Response(Bun.stdin.stream()).text(); console.log(JSON.stringify({type:'query_response',ok:true,result:${JSON.stringify(result)}}))`, "--"] } });
		const task = f.reserve();
		f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
		await f.change({ session: { session_id: "controlled-session" }, turnId: "controlled-turn", terminal: true });
		f.release();
		const r = await cli(f.db, "run", f.file, "--wait");
		expect(r.exit).toBe(4);
		expect(r.lines[0]).toMatchObject({ taskId: task.id, exit: 0, outcome: "ok" });
		expect(r.lines.some(l => l.taskId === task.id && l.phase === "failed" && l.executionTerminal === true)).toBe(true);
		expect(r.last).toEqual({ observation: "summary", exit: 4, outcome: "failed", tasks: { [task.id]: 4 } });
		expect(f.read().task).toMatchObject({ phase: "failed", held: false });
	},
	5: async () => {
		const f = await fixture();
		const run = await runTask(f.fleet, f.input, { sample: f.sample });
		await f.change({ lose: "read" }); f.release();
		const r = await cli(f.db, "watch", "--all-active", "--interval", "10", "--max-polls", "3");
		expect(r.exit).toBe(5);
		expect(r.lines.filter(l => l.observation === "unavailable").map(l => l.consecutiveFailures)).toEqual([1, 2]);
		expect(r.last).toEqual({ observation: "summary", exit: 5, outcome: "unavailable", tasks: { [run.task.id]: 5 } });
		expect(f.read().task).toMatchObject({ phase: "active", held: true });
	},
	6: async () => {
		const f = await fixture();
		const run = await runTask(f.fleet, f.input, { sample: f.sample });
		await f.change({ questions: "bound" }); f.release();
		const r = await cli(f.db, "watch", "--all-active", "--interval", "10", "--max-polls", "2");
		expect(r.exit).toBe(6);
		expect(r.lines[0]).toMatchObject({ taskId: run.task.id, phase: "approval_required" });
		expect(r.last).toEqual({ observation: "summary", exit: 6, outcome: "approval_required", tasks: { [run.task.id]: 6 } });
	},
	7: async () => {
		const f = await fixture();
		const task = f.reserve();
		const op = f.store.claimOperation(task.id, "operator-run", { inputDigest: task.inputDigest, nodeId: task.nodeId!, attemptId: task.attemptId! })!;
		// A live holder: this test process, on this host, unexpired.
		expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "live-holder", pid: process.pid, host: hostname(), expiresAt: Date.now() + 600_000 }, () => false)).toBe(true);
		f.release();
		const r = await cli(f.db, "run", f.file);
		expect(r.exit).toBe(7);
		expect(r.last).toMatchObject({ taskId: task.id, phase: "dispatching", sessionId: null, operationId: op.id, reused: true, exit: 7, outcome: "in_progress" });
		expect(await f.calls()).toEqual({ start: 0, send: 0 });
		expect(f.read().operatorRun?.lease?.owner).toBe("live-holder");
	},
	8: async () => {
		const f = await fixture();
		const task = f.reserve();
		f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
		const body = { sessionId: "controlled-session", turnId: "controlled-turn", status: "cancel_unknown" as const, terminal: false, evidence: { source: "owned-local-fixture" } };
		f.store.observe(task.id, { ...body, eventId: "fixture-cancel-unknown", digest: observationDigest(body) });
		f.release();
		const r = await cli(f.db, "run", f.file);
		expect(r.exit).toBe(8);
		expect(r.last).toMatchObject({ taskId: task.id, phase: "cancel_unknown", exit: 8, outcome: "cancel_unknown" });
		expect(await f.calls()).toEqual({ start: 0, send: 0 });
	},
	9: async () => {
		const f = await fixture();
		const task = f.reserve(); f.release();
		expect((await cli(f.db, "rollback")).exit).toBe(0);
		const r = await cli(f.db, "run", f.file);
		expect(r.exit).toBe(9);
		expect(r.last).toMatchObject({ taskId: task.id, phase: "preparing", sessionId: null, exit: 9, outcome: "not_started" });
		expect(await f.calls()).toEqual({ start: 0, send: 0 });
	},
};
for (const row of exitCodes) test(`exit table row ${row.code} (${row.outcome}) through the real CLI`, rows[row.code]!, 60000);

test("every exit table row has exactly one real-CLI test and the codes are 0..9", () => {
	expect(Object.keys(rows).map(Number)).toEqual(exitCodes.map(r => r.code));
	expect(exitCodes.map(r => r.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	expect(new Set(exitCodes.map(r => r.outcome)).size).toBe(exitCodes.length);
});

test("help and README render the single exit table verbatim", async () => {
	const help = Bun.spawn([process.execPath, "src/cli.ts", "--help"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, exit] = await Promise.all([new Response(help.stdout).text(), help.exited]);
	expect(exit).toBe(0);
	expect(stdout).toContain(exitCodeHelp());
	// Checkout may use CRLF on Windows; compare on normalized newlines.
	const readme = (await readFile(join(root, "README.md"), "utf8")).replaceAll("\r\n", "\n");
	expect(readme).toContain(exitCodeMarkdown());
});

test("aggregation follows the table's rank for every pair; an unknown is never masked", () => {
	const ranked = exitCodes.filter(r => r.rank !== null);
	for (const a of ranked) for (const b of ranked) {
		const expected = a.rank! <= b.rank! ? a.code : b.code;
		expect(worstExit([a.code, b.code])).toBe(expected);
	}
	expect(worstExit([5, 6, 9, 7, 2, 0, 3])).toBe(3);
	expect(worstExit([5, 9, 4])).toBe(4);
	expect(worstExit([])).toBe(0);
	expect(() => worstExit([1])).toThrow("error_exit_is_not_aggregated");
	expect(() => worstExit([10])).toThrow("undocumented_exit_code");
});

// ---- Reviewer 5357de00 R1..R3: the contract text is exactly true through the real CLI ----

test("R1 watch --all-active fences an approval-contract task whose original approval channel/authority is absent (3, not 5): a binding fault is never tolerated", async () => {
	const f = await fixture();
	const task = f.store.reserve(f.store.submit({ ...f.input, approvalContract: "sdk-ui-waiter-v1" }).id, headroom([f.node.id], 10));
	f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
	await f.change({ session: { session_id: "controlled-session" }, turnId: "controlled-turn" });
	f.release();
	// The CLI registers no approval backend, so the original channel can never be present in its process.
	const r = await cli(f.db, "watch", "--all-active", "--interval", "10", "--max-polls", "3");
	expect(r.exit).toBe(3);
	expect(r.lines.some(l => l.observation === "unavailable")).toBe(false);
	expect(r.lines[0]).toMatchObject({ taskId: task.id, phase: "blocked_unknown", held: true });
	expect(r.last).toEqual({ observation: "summary", exit: 3, outcome: "blocked_unknown", tasks: { [task.id]: 3 } });
	const s = new FleetStore(f.db, 2, { readOnly: true });
	try {
		expect(s.task(task.id)).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
		expect(s.events(task.id).filter(e => e.kind === "abandoned_poll")).toHaveLength(0);
	} finally { s.close(); }
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
}, 60000);

test("R2 once the global options parse, every run / watch --all-active error ends stdout with the table's error row", async () => {
	const f = await fixture(); f.release();
	const row = (error: string) => ({ ok: false, error, exit: 1, outcome: "error" });
	const cases: [string[], string][] = [
		[["--read-only", "run", f.file], "READ_ONLY"],
		[["--read-only", "run", f.file, "--wait"], "READ_ONLY"],
		[["--read-only", "watch", "--all-active"], "READ_ONLY"],
		[["--resources", f.file, "run", f.file], "run_requires_fresh_measurement"],
		[["run", f.file, "--now"], "usage_run_TASK_JSON_wait"],
		[["--local-node-id", "ghost", "run", f.file], "local_node_not_registered"],
		[["watch", "--all-active", "--all-active"], "usage_watch_all_active"],
	];
	for (const [args, error] of cases) {
		const r = await cli(f.db, ...args);
		expect({ args, exit: r.exit, lines: r.lines, stderr: JSON.parse(r.stderr) }).toEqual({ args, exit: 1, lines: [row(error)], stderr: { ok: false, error } });
	}
	// A store that cannot be opened (the --db path is a directory) is reported the same way.
	const open = await cli(f.dir, "run", f.file);
	expect(open.exit).toBe(1);
	expect(open.lines).toHaveLength(1);
	expect(open.last).toMatchObject({ ok: false, exit: 1, outcome: "error" });
	expect(open.last.error).toBe(JSON.parse(open.stderr).error);
	// The documented boundary: an error of the global options themselves has no command yet (stderr only).
	const child = Bun.spawn([process.execPath, "src/cli.ts", "run", f.file, "--db"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect({ exit, stdout, stderr: JSON.parse(stderr) }).toEqual({ exit: 1, stdout: "", stderr: { ok: false, error: "db_path_required" } });
	expect(exitCodes[1].meaning).toContain("once the global options parse");
	expect(exitCodeHelp()).toContain("once the global options parse, the last stdout JSON line carries");
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
}, 60000);

test("R3 watch --all-active with nothing active exits 0 with an empty summary, exactly as row 0 states; --all-active is accepted anywhere", async () => {
	const f = await fixture();
	const task = f.reserve();
	f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
	expect(f.store.markUnknown(task.id, "fixture_unknown").phase).toBe("blocked_unknown");
	f.release();
	for (const args of [["watch", "--all-active"], ["watch", "--interval", "10", "--all-active", "--max-polls", "2"]]) {
		const r = await cli(f.db, ...args);
		expect({ args, exit: r.exit, lines: r.lines, stderr: r.stderr }).toEqual({ args, exit: 0, lines: [{ observation: "summary", exit: 0, outcome: "ok", tasks: {} }], stderr: "" });
	}
	expect(exitCodes[0].meaning).toContain("watch --all-active also exits 0 with an empty summary when no task was active");
	expect(f.read().task).toMatchObject({ phase: "blocked_unknown", held: true });
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
}, 60000);

// ---- Production main: the archived phase is terminal for run, watch and filters; nothing is steered ----

/** A node whose recorded SDK transport answers the archive session-list query with no live session. */
async function archivable(f: Awaited<ReturnType<typeof fixture>>) {
	const sdk = join(f.dir, "sdk-list.ts");
	await writeFile(sdk, `console.log(JSON.stringify({ok:true,result:{version:2,source:"broker",scope:"all",selection:{scope:"all"},sessions:[],warnings:[]}}))`);
	f.store.putNode({ ...f.node, sdkTransport: { command: process.execPath, args: [sdk] } });
}
function blocked(f: Awaited<ReturnType<typeof fixture>>, key?: string) {
	const task = f.reserve(key);
	f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
	return f.store.markUnknown(task.id, "fixture_unknown");
}

test("archived through the real CLI: run and run --wait report 4 with no admission or effect, tasks --phase archived selects it, watch --all-active ignores it, steer does not exist", async () => {
	const f = await fixture();
	await archivable(f);
	const task = blocked(f);
	expect((await f.fleet.archive(task.id)).phase).toBe("archived");
	f.release();
	for (const args of [["run", f.file], ["run", f.file, "--wait"]]) {
		const r = await cli(f.db, ...args);
		expect({ args, exit: r.exit, stderr: r.stderr, lines: r.lines.length }).toEqual({ args, exit: 4, stderr: "", lines: 1 });
		expect(r.last).toMatchObject({ taskId: task.id, phase: "archived", reused: true, exit: 4, outcome: "failed" });
		expect(r.last.placement).toBeUndefined();
	}
	const listed = await cli(f.db, "tasks", "--phase", "archived");
	expect(listed.exit).toBe(0);
	expect(listed.last.map((t: any) => [t.id, t.phase])).toEqual([[task.id, "archived"]]);
	expect((await cli(f.db, "--read-only", "tasks", "--phase", "active,blocked_unknown")).last).toEqual([]);
	const compact = Bun.spawn([process.execPath, "src/cli.ts", "--db", f.db, "tasks", "--phase", "archived", "--compact"], { cwd: root, stdout: "pipe" });
	const [line, code] = await Promise.all([new Response(compact.stdout).text(), compact.exited]);
	expect(code).toBe(0);
	expect(line.trim().split("\t").slice(0, 4)).toEqual([task.id.slice(0, 12), "archived", "controlled", JSON.stringify(f.input.key)]);
	const w = await cli(f.db, "watch", "--all-active", "--interval", "10", "--max-polls", "2");
	expect({ exit: w.exit, lines: w.lines }).toEqual({ exit: 0, lines: [{ observation: "summary", exit: 0, outcome: "ok", tasks: {} }] });
	const steer = await cli(f.db, "steer", task.id, f.file);
	expect({ exit: steer.exit, stderr: JSON.parse(steer.stderr) }).toEqual({ exit: 1, stderr: { ok: false, error: "unknown_command_use_help" } });
	const final = f.read();
	expect(final.task).toMatchObject({ id: task.id, phase: "archived", held: false });
	expect(final.operatorRun).toBeUndefined();
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
}, 60000);

test("archived: a watched task archived by another actor between polls is reported with its archived line and code 4", async () => {
	const f = await fixture();
	await archivable(f);
	const task = f.reserve();
	f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
	await f.change({ session: { session_id: "controlled-session" }, turnId: "controlled-turn" });
	const output: any[] = [];
	let archived = false;
	const exit = await watchTasks(f.fleet, { allActive: true, interval: 10, maxPolls: 5, emit: v => output.push(v), sleep: async () => {
		if (archived) return;
		archived = true;
		// Another actor fences the task and then archives it.
		f.store.markUnknown(task.id, "other_actor_unknown");
		expect((await new Fleet(f.store).archive(task.id)).phase).toBe("archived");
	} });
	expect(output.filter(v => v.taskId === task.id).map(v => v.phase)).toEqual(["active", "archived"]);
	expect(exit).toBe(4);
	expect(output.at(-1)).toEqual({ observation: "summary", exit: 4, outcome: "failed", tasks: { [task.id]: 4 } });
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
});

test("archived: archive refuses a live operator-run start lease; an archived task's lease is never taken and a late tolerant read changes nothing", async () => {
	const f = await fixture();
	await archivable(f);
	// A run holds the start lease while its own start is fenced blocked_unknown (before its release).
	const reserved = f.reserve();
	const op = f.store.claimOperation(reserved.id, "operator-run", { inputDigest: reserved.inputDigest, nodeId: reserved.nodeId!, attemptId: reserved.attemptId! })!;
	expect(f.store.leaseOperatorRun(reserved.id, op.id, { owner: "live", pid: process.pid, host: hostname(), expiresAt: Date.now() + 600_000 }, () => false)).toBe(true);
	f.store.recordSession(reserved.id, "controlled-session"); f.store.recordTurn(reserved.id, "controlled-turn");
	const task = f.store.markUnknown(reserved.id, "fixture_unknown");
	await expect(f.fleet.archive(task.id)).rejects.toMatchObject({ code: "ARCHIVE_IN_PROGRESS" });
	expect(f.store.task(task.id)!.phase).toBe("blocked_unknown");
	f.store.releaseOperatorRun(task.id, op.id, "live");
	const done = await f.fleet.archive(task.id);
	expect(done.phase).toBe("archived");
	expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "late", pid: process.pid, host: hostname(), expiresAt: Date.now() + 600_000 }, () => true)).toBe(false);
	expect(f.store.getOperation(task.id, "operator-run")?.lease).toBeUndefined();
	// A tolerant read of the archived task that fails late is abandoned without fencing or audit.
	const sequence = f.store.beginObservation(task.id)!;
	expect(sequence).toBeGreaterThan(0);
	const before = f.store.events(task.id).length;
	expect(f.store.abandonObservation(task.id, sequence)).toMatchObject({ phase: "archived", held: false });
	expect(f.store.events(task.id).length).toBe(before);
	expect(await runTask(f.fleet, f.input, { sample: f.sample })).toMatchObject({ code: 4, reused: true, operationId: op.id });
	expect(f.store.task(task.id)).toMatchObject({ phase: "archived", held: false });
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
}, 60000);

// ---- N5: the owner lease distinguishes a crashed run from a live one ----

test("N5 a lease left by a crashed run (dead pid on this host) is taken over at once: recovery starts once (0)", async () => {
	const f = await fixture();
	const task = f.reserve();
	const op = f.store.claimOperation(task.id, "operator-run", { inputDigest: task.inputDigest, nodeId: task.nodeId!, attemptId: task.attemptId! })!;
	const dead = Bun.spawn([process.execPath, "-e", "0"]); await dead.exited;
	expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "crashed", pid: dead.pid, host: hostname(), expiresAt: Date.now() + 600_000 }, () => false)).toBe(true);
	f.release();
	const r = await cli(f.db, "run", f.file);
	expect(r.exit).toBe(0);
	expect(r.last).toMatchObject({ taskId: task.id, operationId: op.id, phase: "active", exit: 0 });
	expect(await f.calls()).toEqual({ start: 1, send: 1 });
	const final = f.read();
	expect(final.operatorRun?.receipt).toEqual({ phase: "active", sessionId: "controlled-session", turnId: "controlled-turn" });
	expect(final.operatorRun?.lease).toBeUndefined();
	const s = new FleetStore(f.db, 2, { readOnly: true });
	try { expect(s.events(task.id).filter(e => e.kind === "operator_run_lease").map(e => (e.data as any).replacedOwner)).toEqual([undefined, "crashed"]); }
	finally { s.close(); }
}, 60000);

test("N5 an expired lease of a live process is taken over; a live lease on another host is honoured until expiry", async () => {
	const f = await fixture();
	const task = f.reserve();
	const op = f.store.claimOperation(task.id, "operator-run", { inputDigest: task.inputDigest, nodeId: task.nodeId!, attemptId: task.attemptId! })!;
	expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "remote", pid: 1, host: "another-host.invalid", expiresAt: Date.now() + 600_000 }, () => false)).toBe(true);
	expect(await runTask(f.fleet, f.input, { sample: f.sample })).toMatchObject({ code: 7, operationId: op.id });
	expect(await f.calls()).toEqual({ start: 0, send: 0 });
	expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "remote", pid: 1, host: "another-host.invalid", expiresAt: Date.now() - 1 }, () => false)).toBe(true);
	const recovered = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(recovered).toMatchObject({ code: 0, operationId: op.id });
	expect(await f.calls()).toEqual({ start: 1, send: 1 });
	expect(f.store.getOperation(task.id, "operator-run")?.lease).toBeUndefined();
	// A finished start is never leased or started again.
	expect(f.store.leaseOperatorRun(task.id, op.id, { owner: "late", pid: process.pid, host: hostname(), expiresAt: Date.now() + 1000 }, () => true)).toBe(false);
	expect(await runTask(f.fleet, f.input, { sample: f.sample })).toMatchObject({ code: 0, operationId: op.id });
	expect(await f.calls()).toEqual({ start: 1, send: 1 });
}, 60000);
