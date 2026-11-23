import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { ClawhipControl, controlBinding, type ControlCommand } from "../src/clawhip-control";
import { observationDigest } from "../src/core";
import { getDashboardState } from "../src/dashboard";
import { repositoryFixture } from "./fixtures/coordinator";
import type { NodeConfig } from "../src/contracts";
import { headroom } from "./admission-fixture";
import { reconsiderQueue } from "../src/index";

// Controlled Coordinator and real disposable Git/SQLite/subprocesses; not provider or remote-host proof.
const cleanups: (() => Promise<void>)[] = [];
test("queue excludes stale and missing samples and stops fan-out on unknown start", async () => {
 const f = await fixture();
 const tasks = ["first", "second"].map(key => f.fleet.submit({ ...f.task.input, key }, { samples: new Map() }));
 const samples = headroom([f.node.id], 10).samples;
 samples.get(f.node.id)!.disks![0]!.path = f.node.workspaceRoot;
 samples.get(f.node.id)!.at = 0;
 await reconsiderQueue(f.fleet, async () => samples, { localNodeId: f.node.id });
 expect(tasks.every(task => !f.store.task(task.id)!.attemptId)).toBe(true);
 await reconsiderQueue(f.fleet, async () => new Map(), { localNodeId: f.node.id });
 expect(tasks.every(task => !f.store.task(task.id)!.attemptId)).toBe(true);
 // Preflight is explicitly local, but this Fleet lacks local execution authority.
 const noExecutionRoute = new Fleet(f.store);
 samples.get(f.node.id)!.at = Date.now();
 const results = await reconsiderQueue(noExecutionRoute, async () => samples, { localNodeId: f.node.id });
 expect(results).toHaveLength(1);
 expect(results[0]!.phase).toBe("blocked_unknown");
 expect(tasks.filter(task => f.store.task(task.id)!.phase === "queued")).toHaveLength(1);
 await expect(reconsiderQueue(f.fleet, async () => samples, { limit: 101 })).rejects.toThrow("queue_limit");
});
test("queue recovers cpu_busy without replacing identity; concurrent passes reserve once", async () => {
 const f = await fixture();
 const fresh = () => {
  const samples = headroom([f.node.id], 10).samples;
  samples.get(f.node.id)!.disks![0]!.path = f.node.workspaceRoot;
  return samples;
 };
 const busy = fresh();
 busy.get(f.node.id)!.cpuPct = 100;
 const queued = f.fleet.submit({ ...f.task.input, key: "queued-recovery" }, { samples: busy });
 expect(queued.phase).toBe("queued");
 const before = f.store.task(f.task.id);
 await reconsiderQueue(f.fleet, async () => busy, { localNodeId: f.node.id });
 expect(f.store.task(queued.id)?.attemptId).toBeUndefined();
 const resourcesFile = join(f.dir, "queue-resources.json");
 await writeFile(resourcesFile, JSON.stringify(Object.fromEntries(busy)));
 const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"),
  "--db", f.db, "--local-node-id", f.node.id, "--resources", resourcesFile, "queue", "reconsider", "1"],
  { stdout: "pipe", stderr: "pipe" });
 const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
 expect(stderr).toBe("");
 expect(exit).toBe(0);
 expect(JSON.parse(stdout)[0].id).toBe(queued.id);
 expect(JSON.parse(stdout)[0].phase).toBe("queued");
 const other = new FleetStore(f.db);
 try {
  await Promise.all([f.fleet, new Fleet(other, { localNodeId: f.node.id })].map(fleet =>
   reconsiderQueue(fleet, async () => fresh(), { localNodeId: f.node.id })));
 } finally { other.close(); }
 const recovered = f.store.task(queued.id)!;
 expect(recovered.attemptId).toBeTruthy();
 expect(recovered.id).toBe(queued.id);
 expect(recovered.input.key).toBe(queued.input.key);
 expect(recovered.inputDigest).toBe(queued.inputDigest);
 expect(f.store.task(f.task.id)).toEqual(before);
 const db = new Database(f.db, { readonly: true });
 try {
  expect(db.query("SELECT count(*) AS n FROM audit WHERE task_id=? AND kind='reserved'").get(queued.id)).toEqual({ n: 1 });
  const rows = db.query("SELECT data FROM audit WHERE task_id=? AND kind='selection' ORDER BY rowid").all(queued.id).map((row: any) => JSON.parse(row.data));
  // The second cpu_busy rejection (identical exclusion set) is counted on the task, not appended; the
  // CLI pass's changed set (resources_unknown) and the winning reservation are audited.
  expect(rows.map((row: any) => [row.nodeId ?? null, row.exclusions])).toEqual([
   [null, [{ nodeId: f.node.id, reasons: ["cpu_busy"] }]],
   [null, [{ nodeId: f.node.id, reasons: ["resources_unknown"] }]],
   [f.node.id, []],
  ]);
 } finally { db.close(); }
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(sdk = false) {
 const repo = await repositoryFixture("fleet-recovery-regression-");
 cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
 const db = join(repo.dir, "fleet.sqlite");
 const store = new FleetStore(db);
 cleanups.push(async () => store.close());
 const state = join(repo.dir, "coordinator.json");
 await writeFile(state, JSON.stringify({ calls: [] }));
 const node: NodeConfig = { id: "explicit-node", os: process.platform, arch: process.arch,
 roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false,
 reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
 transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] },
 ...(sdk ? { sdkTransport: { command: process.execPath, args: ["--eval", `console.log(JSON.stringify({type:'query_response',ok:true,result:{kind:'prompt',commandId:'command',turnId:'runtime-turn',status:'terminal_ok',receiptState:'present',terminalAt:123,outcome:{kind:'stopped',reason:'end_turn',provenance:'agent'}}}))`, "--"] } } : {}) };
 store.putNode(node);
 const fleet = new Fleet(store, { localNodeId: node.id });
 const task = fleet.submit({ schemaVersion: 1, key: "recovery", caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled recovery", required: {} });
 function observe(terminal: boolean) {
  const current = store.task(task.id)!;
  const body = { sessionId: current.sessionId!, turnId: current.turnId!, status: "completed_unverified" as const, terminal, evidence: { controlled: true } };
  return store.observe(task.id, { ...body, eventId: "observation-" + terminal, digest: observationDigest(body) });
 }
 return { ...repo, db, state, store, node, fleet, task, observe };
}

test("R1 same-platform without explicit host identity creates no prepare intent or local workspace", async () => {
 const f = await fixture();
 const implicit = new Fleet(f.store);
 expect((await implicit.start(f.task.id)).phase).toBe("blocked_unknown");
 expect(f.store.getOperation(f.task.id, "prepare")).toBeUndefined();
 expect(f.store.task(f.task.id)?.workspace).toBeUndefined();
 expect(JSON.parse(await readFile(f.state, "utf8")).calls).toEqual([]);
 expect(await Bun.file(join(f.workspaceRoot, f.task.id + "-" + f.task.attemptId, ".fleet-identity.json")).exists()).toBe(false);
});

for (const missing of [undefined, null, 7, "", " "]) test(`R2 configured SDK incomplete command identity ${String(missing)} stays held and later exact proof reconciles`, async () => {
 const f = await fixture(true);
 f.store.recordSession(f.task.id, "session", true); f.store.recordTurn(f.task.id, "turn");
 let command: unknown = missing;
 let reads = 0;
 (f.fleet as any).connect = async () => ({ close: async () => {}, call: async (name: string) => {
  if (name.endsWith("list_questions")) return { ok: true, reconciliation: { complete: true }, questions: [] };
  reads++;
  return { ok: true, turn: { session_id: "session", turn_id: "turn", status: "completed", final_response: { source: "agent_end" }, delivery: { prompt_acknowledged: true, queued: false, runtime_turn_id: "runtime-turn", runtime_command_id: command } }, advisory_status: { authority: "sdk", live: true, is_streaming: false }, session_state: { session_id: "session", current_turn_id: "turn", state: "completed" } };
 } });
 for (let i = 0; i < 2; i++) {
  const observed = await f.fleet.inspect(f.task.id);
  expect(observed.task.held).toBe(true);
  expect(observed.task.result?.executionTerminal).not.toBe(true);
 }
 expect(reads).toBe(2);
 command = "command";
 const exact = await f.fleet.inspect(f.task.id);
 expect(exact.task.result?.executionTerminal).toBe(true);
 expect(exact.task.held).toBe(false);
}, 30_000);

test("R3 provisional completion is reported unsettled, not active or in flight, until exact settlement", async () => {
 const f = await fixture();
 f.store.recordSession(f.task.id, "session", true); f.store.recordTurn(f.task.id, "turn");
 f.observe(false);
 const provisional = getDashboardState(f.store);
 expect(provisional.tasks[0]?.executionTerminal).toBe(false);
 expect(provisional.nodes[0]?.holding[0]?.executionTerminal).toBe(false);
 expect(provisional.summary.activeTasks).toBe(0);
 expect(provisional.summary.unsettledTasks).toBe(1);
 expect(provisional.pipeline.outcome.unverified).toBe(0);
 expect(provisional.pipeline.outcome.unsettled).toBe(1);
 expect(provisional.pipeline.stages.reduce((n, stage) => n + stage.inFlight, 0)).toBe(0);
 f.observe(true);
 const settled = getDashboardState(f.store);
 expect(settled.tasks[0]?.executionTerminal).toBe(true);
 expect(settled.summary.activeTasks).toBe(0);
 expect(settled.summary.unsettledTasks).toBe(0);
 expect(settled.pipeline.outcome.unverified).toBe(0);
 expect(settled.pipeline.outcome.resultMissing).toBe(1);
 // Projection must preserve terminal proof even if a holding is retained separately.
 const tasks = f.store.taskStates.bind(f.store);
 f.store.taskStates = () => tasks().map(task => ({ ...task, held: true }));
 expect(getDashboardState(f.store).nodes[0]?.holding[0]?.executionTerminal).toBe(true);
 f.store.taskStates = tasks;
 const page = await readFile(join(import.meta.dir, "../src/dashboard-page.ts"), "utf8");
 // isDone delegates to needsImmediate; extract both so the judgment still runs outside the page VM.
 const block = page.match(/function needsImmediate\(t\)\{[^}]+\}[\s\n]*function isDone\(t\)\{[^}]+\}/)?.[0];
 expect(block).toBeTruthy();
 const { isDone, needsImmediate } = new Function(
  "RUN",
  "UNKNOWN",
  `${block}; return { isDone, needsImmediate };`,
 )({ preparing: 1, dispatching: 1, active: 1 }, {}) as {
  isDone: (task: { phase?: string; held?: boolean; executionTerminal?: boolean; timeline?: unknown[] }) => boolean;
  needsImmediate: (task: { phase?: string; held?: boolean; executionTerminal?: boolean; timeline?: unknown[] }) => boolean;
 };
 // Provisional completion stays immediate (not folded) until exact settlement — and after settlement
 // completed_unverified still needs supervisor check, so it remains immediate too.
 expect(isDone(provisional.tasks[0]!)).toBe(false);
 expect(needsImmediate(provisional.tasks[0]!)).toBe(true);
 expect(isDone(settled.tasks[0]!)).toBe(false);
 expect(needsImmediate(settled.tasks[0]!)).toBe(true);
 expect(isDone({ phase: "succeeded", held: false, timeline: [] })).toBe(true);
});

async function controlled() {
 const f = await fixture();
 const path = join(f.dir, "control.sqlite");
 const policy = { thread: "1234", fleetDb: f.db };
 let control = new ClawhipControl(path, policy, true);
 cleanups.push(async () => control.close());
 function enqueue(action: "start" | "inspect" | "collect", key: string, argv: string[] | null = null) {
  const command: ControlCommand = { schema: 1, thread: policy.thread, action, key, binding: action === "start" ? controlBinding(f.task) : control.binding(f.task.id, f.store), testArgv: argv };
  const staged = control.stage(command, f.store); control.ingest({ command_ref: staged.command_ref });
 }
 enqueue("start", "start");
 expect((await control.run("start", f.store, f.fleet)).state).toBe("done");
 f.observe(true);
 function reopen() { control.close(); control = new ClawhipControl(path, policy); return control; }
 return { ...f, path, enqueue, reopen, get control() { return control; } };
}

test("R4 interrupted inspect after reopen cannot fence collect, mutations still cannot replay", async () => {
 const f = await controlled();
 f.enqueue("inspect", "interrupted");
 const db = new Database(f.path); db.exec("UPDATE commands SET state='claimed' WHERE key='interrupted'"); db.close();
 f.reopen();
 const argv = [process.execPath, "--eval", "console.log('verified')"];
 f.enqueue("collect", "collect", argv);
 expect((await f.control.run("collect", f.store, f.fleet)).state).toBe("done");
 expect(f.control.snapshot("interrupted")?.state).toBe("claimed");
 expect((await f.control.run("start", f.store, f.fleet)).state).toBe("done");
});

test("R5 lost adapter ACK recovers durable manifest with original unknown retained and zero replay", async () => {
 const f = await controlled();
 const argv = [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync('counter.txt','once\\n');console.log('verified')`];
 f.enqueue("collect", "lost", argv);
 const executor = { start: f.fleet.start.bind(f.fleet), inspect: f.fleet.inspect.bind(f.fleet), async result(id: string, args?: string[]) { await f.fleet.result(id, args); throw Error("lost ACK"); } };
 expect((await f.control.run("lost", f.store, executor)).state).toBe("unknown");
 f.reopen();
 const never = { async start(): Promise<any> { throw Error("replayed start"); }, async inspect(): Promise<any> { throw Error("replayed inspect"); }, async result(): Promise<any> { throw Error("replayed result"); } };
 const recovered = await f.control.run("lost", f.store, never);
 expect(recovered.state).toBe("unknown");
 expect(recovered.status).toBe("unknown_no_replay");
 expect((recovered.receipt as any).status).toBe("verified");
 expect(await readFile(join((f.store.task(f.task.id)!.workspace as any).path, "counter.txt"), "utf8")).toBe("once\n");
 expect(() => f.enqueue("collect", "different", argv)).toThrow("observation only");
 // An unknown claim without retained proof stays unknown, not a cache miss that runs tests.
 const db = new Database(f.path);
 const command = JSON.parse((db.query("SELECT command FROM commands WHERE key='lost'").get() as any).command);
 command.testArgv = [process.execPath, "--eval", "throw Error('must not run')"];
 // Keep the staged digest valid while simulating a different original unknown verifier.
 const { digest } = await import("../src/core");
 db.query("UPDATE commands SET command=?,ref=?,receipt=NULL WHERE key='lost'").run(JSON.stringify(command), digest(command)); db.close();
 expect((await f.control.run("lost", f.store, never)).receipt).toBeNull();
});

test("R5 also recovers a persisted verification upgrade without replaying result-test", async () => {
	const f = await controlled();
	const original = await f.fleet.result(f.task.id);
	expect(original.status).toBe("not_run");
	const counter = join(f.dir, "upgrade-counter");
	const argv = [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},'once\\n')`];
	f.enqueue("collect", "upgrade", argv);
	const executor = { start: f.fleet.start.bind(f.fleet), inspect: f.fleet.inspect.bind(f.fleet),
		async result(id: string, args?: string[]) { await f.fleet.result(id, args); throw Error("lost upgrade ACK"); } };
	expect((await f.control.run("upgrade", f.store, executor)).state).toBe("unknown");
	f.reopen();
	const never = { async start(): Promise<any> { throw Error("replayed start"); },
		async inspect(): Promise<any> { throw Error("replayed inspect"); }, async result(): Promise<any> { throw Error("replayed result"); } };
	const recovered = await f.control.run("upgrade", f.store, never);
	expect(recovered.state).toBe("unknown");
	expect((recovered.receipt as any).status).toBe("verified");
	expect(await readFile(counter, "utf8")).toBe("once\n");
	expect<unknown>(f.store.task(f.task.id)?.resultManifest).toEqual(original);
});

test("explicit CLI locality survives separate submit/start/result processes and retains private dedup binding", async () => {
	const f = await fixture();
	const taskFile = join(f.dir, "task.json");
	const resources = join(f.dir, "resources.json");
	await writeFile(taskFile, JSON.stringify(f.task.input));
	await writeFile(resources, JSON.stringify(Object.fromEntries(headroom([f.node.id], 10).samples)));
	async function cli(...args: string[]) {
		const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"),
			"--db", f.db, "--local-node-id", f.node.id, "--resources", resources, ...args],
			{ stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(stderr).toBe("");
		return { stdout, exit, value: JSON.parse(stdout) };
	}
	const submitted = await cli("submit", taskFile);
	expect(submitted.exit).toBe(0);
	expect(submitted.value.attemptId).toBe(f.task.attemptId);
	expect(submitted.value.placement.nodes[0].ready).toBe(true);
	expect(submitted.stdout).not.toContain(f.task.input.prompt);
	const duplicate = await cli("submit", taskFile);
	expect(duplicate.exit).toBe(0);
	expect(duplicate.value.attemptId).toBe(submitted.value.attemptId);
	const started = await cli("start", f.task.id);
	expect(started.exit).toBe(0);
	expect(started.value.phase).toBe("active");
	f.observe(true); // Controlled settlement, not real model proof.
	const argvFile = join(f.dir, "argv.json");
	await writeFile(argvFile, JSON.stringify([process.execPath, "--eval", "console.log('CLI verifier')"]));
	const result = await cli("result", f.task.id, argvFile);
	expect(result.exit).toBe(0);
	expect(result.value.status).toBe("verified");
	expect(result.value.tests[0].stdout).toBe("CLI verifier\n");
	expect(f.store.task(f.task.id)?.input.prompt).toBe(f.task.input.prompt);
	expect(f.store.events(f.task.id).filter(event => event.kind === "reserved")).toHaveLength(1);
});
