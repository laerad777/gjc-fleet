import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { compactTask, filteredTasks, parseTaskFilters, runTask, watchTasks, taskExit } from "../src/operator-commands";
import { cli } from "../src/cli";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

// Real temporary SQLite, Git/workspaces and controlled public stdio Coordinator. No live service.
const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture() {
	const f = await repositoryFixture("fleet-operator-"); dirs.push(f.dir);
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
	const input: TaskInput = { schemaVersion: 1, key: "operator-one", caller: "controlled-test", repoId: "fixture", baseCommit: f.baseCommit, prompt: "private prompt", required: {} };
	const sample = async () => headroom([node.id], 10).samples;
	async function change(patch: Record<string, unknown>) { await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), ...patch })); }
	return { ...f, db, state, store, fleet, input, sample, node, change };
}

test("run freshly admits, starts once, audits its original operation and does not resubmit duplicates", async () => {
	const f = await fixture(); let sampled = 0;
	const first = await runTask(f.fleet, f.input, { sample: async () => { sampled++; return f.sample(); } });
	expect(first.code).toBe(0); expect(first.task.phase).toBe("active");
	expect(first.task.nodeId).toBe(f.node.id); expect(first.task.sessionId).toBeTruthy();
	const op = f.store.getOperation(first.task.id, "operator-run")!;
	expect(first.operationId).toBe(op.id); expect(op.receipt).toMatchObject({ phase: "active", sessionId: first.task.sessionId });
	const again = await runTask(f.fleet, f.input, { sample: async () => { sampled++; return f.sample(); } });
	expect(again.reused).toBe(true); expect(again.task.id).toBe(first.task.id); expect(sampled).toBe(1);
	expect(f.store.task(first.task.id)!.inputDigest).toBe(first.task.inputDigest);
	const calls = JSON.parse(await readFile(f.state, "utf8")).calls;
	expect(calls.filter((c: any) => c.name.endsWith("send_prompt"))).toHaveLength(1);
	expect(f.store.events(first.task.id).some(e => e.kind === "operation_receipt")).toBe(true);
	await expect(runTask(f.fleet, { ...f.input, prompt: "changed" }, { sample: f.sample })).rejects.toThrow("run_input_conflict");
});

test("queued and blocked have distinct exits; queued is freshly re-admitted, blocked is never retried", async () => {
	const f = await fixture();
	const queued = await runTask(f.fleet, f.input, { sample: async () => new Map() });
	expect(queued.code).toBe(2); expect(queued.task.phase).toBe("queued");
	expect(await runTask(f.fleet, f.input, { sample: async () => new Map() })).toMatchObject({ code: 2, reused: true });
	const admitted = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(admitted).toMatchObject({ code: 0, reused: true }); expect(admitted.task.id).toBe(queued.task.id);
	await f.change({ lose: "send" });
	const blocked = await runTask(f.fleet, { ...f.input, key: "lost-send" }, { sample: f.sample });
	expect(blocked.code).toBe(3); expect(blocked.task.phase).toBe("blocked_unknown");
	const before = await readFile(f.state, "utf8");
	expect(await runTask(f.fleet, { ...f.input, key: "lost-send" }, { sample: f.sample })).toMatchObject({ code: 3, reused: true });
	expect(await readFile(f.state, "utf8")).toBe(before);
	const output: any[] = [];
	expect(await watchTasks(f.fleet, { ids: [blocked.task.id], emit: v => output.push(v) })).toBe(3);
	expect(await readFile(f.state, "utf8")).toBe(before);
	expect(output[0].phase).toBe("blocked_unknown");
	expect(taskExit({ ...blocked.task, phase: "failed" })).toBe(4);
});

test("watch tolerates one real transport failure without blocking, then applies authoritative settlement", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	await f.change({ lose: "read", terminal: true });
	const output: any[] = [];
	const exit = await watchTasks(f.fleet, { allActive: true, maxPolls: 3, interval: 10, emit: v => output.push(v), sleep: async () => {
		expect(f.store.task(run.task.id)!.phase).toBe("active");
		expect(f.store.task(run.task.id)!.held).toBe(true);
		await f.change({ lose: undefined });
	} });
	expect(exit).toBe(0); expect(output[0]).toMatchObject({ observation: "unavailable", consecutiveFailures: 1 });
	expect(f.store.task(run.task.id)!.result?.executionTerminal).toBe(true);
	expect(f.store.task(run.task.id)!.held).toBe(false);
	expect(JSON.stringify(output)).not.toContain("private prompt");
	expect(f.store.events(run.task.id).some(e => e.kind === "unknown")).toBe(false);
});

// Re-review N4: a remote session/turn identity mismatch is not a failed read; it is fenced exactly like poll.
test("watch all-active continues other tasks; a remote identity mismatch is fenced like poll, not relabelled unavailable", async () => {
	const f = await fixture();
	const one = await runTask(f.fleet, f.input, { sample: f.sample });
	const two = f.store.reserve(f.store.submit({ ...f.input, key: "second" }).id, headroom([f.node.id], 10));
	f.store.recordSession(two.id, "second-session"); f.store.recordTurn(two.id, "second-turn");
	await f.change({ terminal: true });
	const output: any[] = [];
	expect(await watchTasks(f.fleet, { allActive: true, interval: 10, maxPolls: 3, emit: v => output.push(v), sleep: async () => {} })).toBe(3);
	expect(f.store.task(one.task.id)!.result?.executionTerminal).toBe(true);
	expect(f.store.task(two.id)).toMatchObject({ phase: "blocked_unknown", held: true });
	expect(output.filter(v => v.taskId === two.id && v.observation === "unavailable")).toHaveLength(0);
	expect(output.at(-1)).toEqual({ observation: "summary", exit: 3, outcome: "blocked_unknown", tasks: { [one.task.id]: 0, [two.id]: 3 } });
});

for (const fault of ["queued", "unacknowledged", "no_runtime", "empty_runtime", "metadata", "not_live", "streaming", "wrong_session", "wrong_turn"]) {
	test(`watch does not accept metadata settlement with ${fault}`, async () => {
		const f = await fixture(); const run = await runTask(f.fleet, f.input, { sample: f.sample });
		await f.change({ terminal: true, terminalFault: fault });
		expect(await watchTasks(f.fleet, { ids: [run.task.id], maxPolls: 1, emit: () => {} })).toBe(5);
		expect(f.store.task(run.task.id)!.result?.executionTerminal).not.toBe(true);
		expect(f.store.task(run.task.id)!.held).toBe(true);
	});
}

test("incomplete questions are reported unavailable by tolerant inspection without marking or releasing", async () => {
	const f = await fixture(); const run = await runTask(f.fleet, f.input, { sample: f.sample });
	await f.change({ questionsComplete: false });
	const before = f.store.task(run.task.id)!;
	await expect(f.fleet.inspect(run.task.id, { tolerateReadFailure: true })).rejects.toMatchObject({ code: "OBSERVATION_UNAVAILABLE" });
	const after = f.store.task(run.task.id)!;
	expect({ ...after, pollIssued: undefined }).toEqual({ ...before, pollIssued: undefined });
	expect(after.pollIssued).toBe((before.pollIssued ?? 0) + 1);
	expect(f.store.events(run.task.id).some(e => e.kind === "unknown")).toBe(false);
	// The strict single-task poll path keeps its existing fencing semantics.
	expect((await f.fleet.inspect(run.task.id)).task.phase).toBe("blocked_unknown");
	expect(f.store.events(run.task.id).some(e => e.kind === "unknown")).toBe(true);
});

for (const status of ["terminal_ok", "failed", "acceptance_unknown"]) {
	test(`watch requires exact public SDK receipt: ${status}`, async () => {
		const f = await fixture();
		const sdkLog = join(f.dir, "sdk-query.json");
		const result = { kind: "prompt", commandId: "controlled-runtime-command", turnId: "controlled-runtime-turn", status,
			receiptState: "present", terminalAt: 123, outcome: status === "failed" ? { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "controlled failure" } : { kind: "stopped", reason: "end_turn", provenance: "agent" } };
		f.store.putNode({ ...f.node, sdkTransport: { command: process.execPath, args: ["--eval",
			`const input=JSON.parse(await new Response(Bun.stdin.stream()).text()); await Bun.write(${JSON.stringify(sdkLog)},JSON.stringify({argv:process.argv,input})); console.log(JSON.stringify({type:'query_response',ok:true,result:${JSON.stringify(result)}}))`, "--"] } });
		const task = f.store.reserve(f.store.submit(f.input).id, headroom([f.node.id], 10));
		f.store.recordSession(task.id, "controlled-session"); f.store.recordTurn(task.id, "controlled-turn");
		await f.change({ session: { session_id: "controlled-session" }, turnId: "controlled-turn", terminal: true });
		const code = await watchTasks(f.fleet, { ids: [task.id], maxPolls: 1, emit: () => {} });
		expect(code).toBe(status === "failed" ? 4 : status === "terminal_ok" ? 0 : 5);
		expect(f.store.task(task.id)!.held).toBe(status === "acceptance_unknown");
		const query = JSON.parse(await readFile(sdkLog, "utf8"));
		expect(query.argv).toContain("--attach-only");
		expect(query.input).toEqual({ kind: "prompt", commandId: "controlled-runtime-command", turnId: "controlled-runtime-turn" });
	});
}

test("tasks filters compose, since uses submission audit time, compact lines do not expose prompt", async () => {
	const f = await fixture();
	const first = f.store.submit(f.input);
	const second = f.store.reserve(f.store.submit({ ...f.input, key: "other" }).id, headroom([f.node.id], 10));
	expect(filteredTasks(f.store, parseTaskFilters(["--phase", "queued,active", "--key-prefix", "operator", "--since", "2000-01-01T00:00:00Z"])).map(t => t.id)).toEqual([first.id]);
	expect(filteredTasks(f.store, parseTaskFilters(["--node", f.node.id])).map(t => t.id)).toEqual([second.id]);
	expect(filteredTasks(f.store, parseTaskFilters(["--since", "2100-01-01T00:00:00Z"]))).toHaveLength(0);
	expect(compactTask(f.store, first)).toContain("operator-one");
	expect(compactTask(f.store, first)).not.toContain("private prompt");
	for (const args of [["--phase", "bogus"], ["--since", "yesterday"], ["--node"], ["--wat"], ["--json"], ["--compact", "--compact"]]) expect(() => parseTaskFilters(args)).toThrow();
	const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", f.db, "--read-only", "tasks", "--key-prefix", "operator"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
	const output = JSON.parse(await new Response(child.stdout).text());
	expect(await child.exited).toBe(0); expect(output).toHaveLength(1); expect(output[0].id).toBe(first.id);
	expect(output[0].input.prompt).toContain("omitted");
});

test("CLI rejects run recorded samples, invalid bounds, and unsupported steering without mutation", async () => {
	const f = await fixture();
	const file = join(f.dir, "task.json"); await writeFile(file, JSON.stringify(f.input));
	await expect(cli(["--db", f.db, "--resources", file, "run", file])).rejects.toThrow("run_requires_fresh_measurement");
	await expect(cli(["--db", f.db, "watch", "--all-active", "--interval", "NaN"])).rejects.toThrow("invalid_watch_bounds");
	await expect(cli(["--db", f.db, "steer", "missing", file])).rejects.toThrow("unknown_command");
	expect(f.store.tasks()).toHaveLength(0);
});

test("CLI run --wait reports queued with exit 2 and reuses identity without retry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fleet-run-cli-")); dirs.push(dir);
	const db = join(dir, "fleet.sqlite");
	const file = join(dir, "task.json");
	await writeFile(file, JSON.stringify({ schemaVersion: 1, key: "no-node", caller: "operator-cli", repoId: "fixture", baseCommit: "a".repeat(40), prompt: "private prompt", required: {} }));
	async function command(...args: string[]) {
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", db, ...args], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { stdout, stderr, exit };
	}
	const first = await command("run", file, "--wait");
	expect(first.exit).toBe(2);
	const value = JSON.parse(first.stdout);
	expect(value).toMatchObject({ phase: "queued", nodeId: null, sessionId: null, reused: false });
	const again = await command("run", file, "--wait");
	expect(again.exit).toBe(2); expect(JSON.parse(again.stdout).taskId).toBe(value.taskId);
	expect(JSON.parse(again.stdout).reused).toBe(true);
	const tasks = await command("tasks", "--compact");
	expect(tasks.exit).toBe(0); expect(tasks.stdout).toContain("no-node"); expect(tasks.stdout).not.toContain("private prompt");
	expect((await command("watch", "--all-active")).exit).toBe(0);
});

// Independent review 0176ef5f reproductions (R1..R6, F3..F8), asserting the corrected behavior.
const sendPrompts = async (state: string) => (JSON.parse(await readFile(state, "utf8")).calls as any[]).filter(c => c.name.endsWith("send_prompt"));
const coordinatorCalls = async (state: string) => (JSON.parse(await readFile(state, "utf8")).calls as any[]).length;

test("R1 a second run continues a task reserved before a crash: same attempt, started once, receipt recorded", async () => {
	const f = await fixture(); let sampled = 0;
	const reserved = f.store.reserve(f.store.submit(f.input).id, headroom([f.node.id], 10));
	expect(reserved.phase).toBe("preparing");
	const again = await runTask(f.fleet, f.input, { sample: async () => { sampled++; return f.sample(); } });
	expect(again).toMatchObject({ reused: true, code: 0 });
	expect(again.task).toMatchObject({ id: reserved.id, attemptId: reserved.attemptId, phase: "active" });
	expect(again.task.turnId).toBeTruthy(); expect(sampled).toBe(0);
	const op = f.store.getOperation(reserved.id, "operator-run")!;
	expect(again.operationId).toBe(op.id); expect(op.receipt).toMatchObject({ phase: "active", turnId: again.task.turnId });
	expect(await sendPrompts(f.state)).toHaveLength(1);
	const third = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(third).toMatchObject({ reused: true, code: 0 }); expect(await sendPrompts(f.state)).toHaveLength(1);
});

test("R1 a second run admits a task submitted but never reserved before a crash, then starts it", async () => {
	const f = await fixture(); let sampled = 0;
	const queued = f.store.submit(f.input);
	expect(f.store.events(queued.id).some(e => e.kind === "selection")).toBe(false);
	const again = await runTask(f.fleet, f.input, { sample: async () => { sampled++; return f.sample(); } });
	expect(again).toMatchObject({ reused: true, code: 0 });
	expect(again.task).toMatchObject({ id: queued.id, phase: "active" }); expect(sampled).toBe(1);
	expect(f.store.events(queued.id).some(e => e.kind === "selection")).toBe(true);
	expect(await sendPrompts(f.state)).toHaveLength(1);
});

test("R2 a second run after an unacknowledged prompt claim fences blocked_unknown (exit 3) and never resends", async () => {
	const f = await fixture();
	const reserved = f.store.reserve(f.store.submit(f.input).id, headroom([f.node.id], 10));
	f.store.claimOperation(reserved.id, "operator-run", { inputDigest: reserved.inputDigest, nodeId: reserved.nodeId!, attemptId: reserved.attemptId! });
	f.store.recordSession(reserved.id, "crash-session", true);
	f.store.claimOperation(reserved.id, "prompt", { session_id: "crash-session", prompt: "private prompt", allow_mutation: true });
	const again = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(again).toMatchObject({ reused: true, code: 3 });
	expect(again.task).toMatchObject({ id: reserved.id, phase: "blocked_unknown", reason: "prompt_response_unavailable_no_readonly_key_lookup", held: true });
	expect(await sendPrompts(f.state)).toHaveLength(0);
	expect(f.store.getOperation(reserved.id, "operator-run")!.receipt).toMatchObject({ phase: "blocked_unknown" });
	const third = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(third.code).toBe(3); expect(await coordinatorCalls(f.state)).toBe(0);
});

test("R2 a second run after an unrecorded prepare claim fences instead of preparing again", async () => {
	const f = await fixture();
	const reserved = f.store.reserve(f.store.submit(f.input).id, headroom([f.node.id], 10));
	f.store.claimOperation(reserved.id, "prepare", { taskId: reserved.id, attemptId: reserved.attemptId!, nodeId: reserved.nodeId!, inputDigest: reserved.inputDigest, repoId: f.input.repoId, baseCommit: f.input.baseCommit });
	const again = await runTask(f.fleet, f.input, { sample: f.sample });
	expect(again.code).toBe(3);
	expect(again.task).toMatchObject({ phase: "blocked_unknown", reason: "preparation_inflight_or_unknown_no_replay" });
	expect(again.task.workspace).toBeUndefined(); expect(await coordinatorCalls(f.state)).toBe(0);
});

test("R3 watch --all-active uses Fleet inspection and never regresses completed_unverified to active", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	await f.change({ terminal: true, terminalFault: "metadata" });
	expect((await f.fleet.inspect(run.task.id)).task.phase).toBe("completed_unverified");
	expect(await watchTasks(f.fleet, { allActive: true, maxPolls: 2, interval: 10, emit: () => {}, sleep: async () => {} })).toBe(5);
	expect(f.store.task(run.task.id)!.phase).toBe("completed_unverified");
	expect(f.store.task(run.task.id)!.held).toBe(true);
});

test("R5 concurrent identical runs start once; the loser reports in-progress (7), not unknown", async () => {
	const f = await fixture();
	const [a, b] = await Promise.all([runTask(f.fleet, f.input, { sample: f.sample }), runTask(new Fleet(f.store), f.input, { sample: f.sample })]);
	expect(a.task.id).toBe(b.task.id);
	expect([a.code, b.code].sort()).toEqual([0, 7]);
	expect([a, b].find(r => r.code === 7)!.task.phase).not.toBe("blocked_unknown");
	expect(f.store.task(a.task.id)!.phase).toBe("active");
	expect(await sendPrompts(f.state)).toHaveLength(1);
});

test("R6 stale fresh-sampler output is refused by shared admission (queued, exit 2)", async () => {
	const f = await fixture();
	const stale = async () => new Map([...headroom([f.node.id], 10).samples].map(([id, s]) => [id, { ...s, at: Date.now() - 60_000 }]));
	const r = await runTask(f.fleet, f.input, { sample: stale });
	expect(r.code).toBe(2); expect(r.task.attemptId).toBeUndefined();
});

test("F3 run applies submit's local_node_not_registered guard before sampling or submitting", async () => {
	const f = await fixture(); let sampled = 0;
	await expect(runTask(f.fleet, f.input, { localNodeId: "ghost", sample: async () => { sampled++; return f.sample(); } })).rejects.toThrow("local_node_not_registered");
	expect(sampled).toBe(0); expect(f.store.tasks()).toHaveLength(0);
	const dir = await mkdtemp(join(tmpdir(), "fleet-run-ghost-")); dirs.push(dir);
	const file = join(dir, "task.json"); await writeFile(file, JSON.stringify(f.input));
	await expect(cli(["--db", join(dir, "fleet.sqlite"), "--local-node-id", "ghost", "run", file])).rejects.toThrow("local_node_not_registered");
});

test("F4 exit codes distinguish unknown, cancel-unknown, approval, failure and settled success", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	const base = f.store.task(run.task.id)!;
	expect(taskExit({ ...base, phase: "blocked_unknown" })).toBe(3);
	expect(taskExit({ ...base, phase: "cancel_unknown" })).toBe(8);
	expect(taskExit({ ...base, phase: "approval_required" })).toBe(6);
	expect(taskExit({ ...base, phase: "failed" })).toBe(4);
	expect(taskExit({ ...base, phase: "cancelled" })).toBe(4);
	expect(taskExit({ ...base, phase: "queued" })).toBe(2);
	expect(taskExit(base)).toBe(0);
	const { turnId, ...unstarted } = base;
	expect(taskExit({ ...unstarted, phase: "preparing" })).not.toBe(0);
	expect(taskExit({ ...unstarted, phase: "dispatching" })).not.toBe(0);
});

test("F5 tasks keeps the previous JSON default; compact lines are opt-in; help documents the verbs", async () => {
	const f = await fixture();
	f.store.submit(f.input); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
	async function command(...args: string[]) {
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", f.db, ...args], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
		const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return { stdout, exit };
	}
	const plain = await command("tasks");
	expect(plain.exit).toBe(0);
	const parsed = JSON.parse(plain.stdout);
	expect(parsed).toHaveLength(1); expect(parsed[0].input.key).toBe("operator-one"); expect(parsed[0].input.prompt).toContain("omitted");
	expect((await command("tasks", "--key-prefix", "operator")).stdout).toBe(plain.stdout);
	const compact = await command("tasks", "--compact");
	expect(compact.exit).toBe(0); expect(compact.stdout.trim().split("\n")).toHaveLength(1);
	expect(compact.stdout).toContain("\"operator-one\""); expect(compact.stdout).not.toContain("private prompt");
	const help = await command("--help");
	expect(help.stdout).toContain("run TASK.json [--wait]"); expect(help.stdout).toContain("--compact");
	expect(help.stdout).not.toContain("tasks | show");
});

test("F6 filter values may start with dashes; impossible calendar instants are refused", async () => {
	const f = await fixture();
	f.store.submit({ ...f.input, key: "--dash" }); f.store.submit(f.input);
	expect(filteredTasks(f.store, parseTaskFilters(["--key-prefix", "--d"])).map(t => t.input.key)).toEqual(["--dash"]);
	for (const since of ["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:00+24:00", "2025-02-29T00:00:00Z"])
		expect(() => parseTaskFilters(["--since", since])).toThrow("invalid_since_iso");
	expect(parseTaskFilters(["--since", "2024-02-29T23:59:59.5+09:00"]).since).toBe(Date.parse("2024-02-29T14:59:59.5Z"));
	expect(() => parseTaskFilters(["--key-prefix"])).toThrow("tasks_filter_value_required");
	expect(() => parseTaskFilters(["--node", ""])).toThrow("tasks_filter_value_required");
});

test("F8 watch emits a task state line only when it changes", async () => {
	const f = await fixture();
	const run = await runTask(f.fleet, f.input, { sample: f.sample });
	const output: any[] = [];
	expect(await watchTasks(f.fleet, { ids: [run.task.id], maxPolls: 4, interval: 10, emit: v => output.push(v), sleep: async () => {} })).toBe(5);
	expect(output.filter(v => v.taskId === run.task.id && v.phase === "active")).toHaveLength(1);
	expect(output.at(-2)).toEqual({ observation: "wait_limit", maxPolls: 4 });
	expect(output.at(-1)).toEqual({ observation: "summary", exit: 5, outcome: "unavailable", tasks: { [run.task.id]: 5 } });
});
