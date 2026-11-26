// Interactions of the stacked patches on production main 34d0622: operator commands (run, run --wait,
// watch --all-active, tasks filters; no steer verb) with main's receipt-less settlement + late-receipt
// observation, settled-session resource return / operator override, archive, and the structured node
// refusals (retained before_send refusal, preflight/clear). Real temporary SQLite, real git fixtures,
// the real src/node.ts helper behind a recording shim, the controlled stdio Coordinator/SDK stand-ins of
// main's suites, and the real CLI as a separate process. No live service.
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { normalizeDiagnostic } from "../src/diagnostic";
import { Fleet } from "../src/fleet";
import { exitCodes, runTask, watchTasks } from "../src/operator-commands";
import { operatorReleaseResource, returnResources, type ReturnReport } from "../src/resource-return";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";
import type { StackSdkState } from "./fixtures/stack-sdk";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
/** The real CLI in its own process: exit code, every stdout JSON line (or one pretty value), stderr. */
async function cli(db: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, cliPath, "--db", db, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	// Operator commands print one JSON value per line, other commands one pretty value; --compact prints TSV.
	let lines: any[];
	try { lines = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch {
		try { lines = [JSON.parse(stdout)]; } catch { lines = []; }
	}
	return { exit, lines, last: lines.at(-1), stdout, stderr };
}
const noSample = async (): Promise<never> => { throw new Error("run must not measure an existing reserved task"); };

// ---------------------------------------------------------------------------------------------
// Structured node refusals (stack-1) through `run` (stack-2).
// ---------------------------------------------------------------------------------------------
// The production transport helper: read-only placement probe plus prepare/preflight/test/collect.
const helperTs = resolve(root, "src/placement-preflight.ts");
const REFUSAL = "node_refused:root_denied:allowlist";

async function refusalWorld(key: string, reserve = true) {
	const f = await repositoryFixture("stack-op-refusal-");
	cleanups.push(() => rm(f.dir, { recursive: true, force: true }));
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const sessions = join(f.dir, "sessions.ts");
	await writeFile(sessions, `console.log(JSON.stringify({ok:true,result:{version:2,source:"broker",scope:"all",selection:{scope:"all"},sessions:[],warnings:[]}}))`);
	const base: any = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot, maxConcurrency: 1, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [resolve(root, "test/fixtures/coordinator.ts"), state] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(base));
	// Recording shim in front of the real helper: one line "<action> <attemptId>" per node request.
	const counter = join(f.dir, "dispatches");
	const shim = join(f.dir, "helper.ts");
	await writeFile(shim, `import {appendFileSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';let attempt='?';try{const r=JSON.parse(input);action=String(r.action);attempt=String(r.input?.attemptId??r.identity?.attemptId)}catch{}
appendFileSync(${JSON.stringify(counter)},action+' '+attempt+'\\n');
const child=Bun.spawn([process.execPath,${JSON.stringify(helperTs)},${JSON.stringify(config)}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`);
	const node = { ...base, workspaceTransport: { command: process.execPath, args: [shim] }, sdkTransport: { command: process.execPath, args: [sessions] } };
	// The helper's NODE_CONFIG is the exact registered node (the placement probe verifies it).
	await writeFile(config, JSON.stringify(node));
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db);
	cleanups.push(() => store.close());
	store.putNode(node);
	const input: TaskInput = { schemaVersion: 1, key, caller: "stack-op", repoId: "repo", baseCommit: f.baseCommit, prompt: "refusal", required: {} };
	const file = join(f.dir, "task.json");
	await writeFile(file, JSON.stringify(input));
	const resources = headroom(["node"], 1);
	resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
	let id: string | undefined;
	if (reserve) {
		id = store.submit(input).id;
		store.reserve(id, resources);
	}
	const dispatches = async () => (await Bun.file(counter).exists()) ? (await readFile(counter, "utf8")).trim().split("\n") : [];
	const coordinatorCalls = async () => JSON.parse(await readFile(state, "utf8")).calls.length as number;
	const taskId = () => id ?? store.tasks()[0]!.id;
	return {
		...f, db, store, input, file, resources,
		taskId,
		task: (): TaskRecord => store.task(taskId())!,
		dispatches,
		actions: async () => (await dispatches()).map((line) => line.split(" ")[0]),
		coordinatorCalls,
		events: (kind: string) => store.events(taskId()).filter((e) => e.kind === kind),
		charges: () => [...store.heldCharges().values()].flat().length,
		breakSource: () => f.git("config", "filter.fleet-refusal.clean", "cat"),
		fixSource: () => f.git("config", "--remove-section", "filter.fleet-refusal"),
	};
}
type RefusalWorld = Awaited<ReturnType<typeof refusalWorld>>;
async function caught(p: Promise<unknown>): Promise<any> {
	try { await p; } catch (error) { return error; }
	throw new Error("expected rejection");
}
/** The exit-1 contract of `run`: stderr JSON and the identical last stdout row. */
function expectErrorRow(r: Awaited<ReturnType<typeof cli>>, error: string) {
	expect(r.exit).toBe(1);
	expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, error });
	expect(r.last).toEqual({ ok: false, error, exit: 1, outcome: "error" });
}
/** The first run refuses before send: exit 1 with the error row, the attempt held with its receipt. */
async function refusedRun(w: RefusalWorld, ...extra: string[]) {
	await w.breakSource();
	const r = await cli(w.db, "run", w.file, ...extra);
	expectErrorRow(r, REFUSAL);
	expect(await w.actions()).toEqual(["prepare"]);
	expect(await w.coordinatorCalls()).toBe(0);
	const task = w.task();
	expect(task).toMatchObject({ phase: "dispatching", held: true });
	expect(task.workspace).toBeUndefined();
	const prepare = w.store.getOperation(task.id, "prepare")!;
	expect((prepare.receipt as any).nodeRefusal).toMatchObject({ ok: false, certainty: "before_send" });
	const operatorRun = w.store.getOperation(task.id, "operator-run")!;
	expect(operatorRun.receipt).toBeUndefined();
	expect((operatorRun as any).lease).toBeUndefined();
	expect(w.events("node_operation_failure").map((e) => e.data)).toMatchObject([{ code: REFUSAL, certainty: "before_send" }]);
	await w.fixSource();
	return task;
}

describe("structured node refusal of a run's prepare", () => {
	test("CLI run on a reserved task: prepare refused before send -> exit 1, error row per table row 1; attempt held, nothing else sent", async () => {
		const w = await refusalWorld("run-refused");
		await refusedRun(w);
		expect(w.events("reserved")).toHaveLength(1);
		expect(w.charges()).toBe(1);
	}, 60000);

	test("run --wait with a refused prepare: same exit 1 and error row; --wait never watches an errored run", async () => {
		const w = await refusalWorld("run-wait-refused");
		const before = await refusedRun(w, "--wait");
		expect(w.task().attemptId).toBe(before.attemptId);
	}, 60000);

	test("runTask from absent (fresh measured admission) with a refused prepare: one reservation, the FleetError surfaces, held", async () => {
		const w = await refusalWorld("run-absent-refused", false);
		await w.breakSource();
		const error = await caught(runTask(new Fleet(w.store), w.input, { sample: async () => w.resources.samples }));
		expect(error.code).toBe(REFUSAL);
		expect(w.store.tasks()).toHaveLength(1);
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true });
		expect(w.events("reserved")).toHaveLength(1);
		// The read-only placement probe passes (it does not read checkout filters); prepare refuses before send.
		expect(await w.actions()).toEqual(["placement-preflight", "prepare"]);
		expect(w.store.getOperation(w.taskId(), "operator-run")!.receipt).toBeUndefined();
		// The CLI re-invocation reuses the reserved task (no new measurement or reservation) and, exactly like
		// start, re-checks the retained refusal by preflight only; the cause persists, so it stays retained.
		expect(w.store.retainedPreparationRefusal(w.taskId())).toBeDefined();
		const again = await cli(w.db, "run", w.file);
		expectErrorRow(again, REFUSAL);
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true, reason: "preparation_refusal_retained:still_refused" });
		expect(await w.actions()).toEqual(["placement-preflight", "prepare", "preflight"]);
		expect(w.store.tasks()).toHaveLength(1);
		expect(w.events("reserved")).toHaveLength(1);
	}, 60000);

	// Stack-3 (STACK.md S1 fixed): a run's own unreceipted `operator-run` claim is its start lease, not an
	// effect, so a run-started proven before_send refusal is retained exactly like a start-started one, and a
	// later run re-checks it by preflight, clears it to a fresh attempt and prepares, exactly as start does.
	test("run re-invocation after a run-started refusal, cause removed: preflight -> clear -> fresh attempt -> prepare, as start; no second reservation (exit 0)", async () => {
		const w = await refusalWorld("run-rerun");
		const refused = await refusedRun(w);
		const retained = w.store.retainedPreparationRefusal(refused.id)!;
		expect(retained).toMatchObject({ kind: "prepare", attemptId: refused.attemptId });
		const oldRun = w.store.getOperation(refused.id, "operator-run")!;
		const again = await cli(w.db, "run", w.file);
		expect(again.exit).toBe(0);
		expect(again.stderr).toBe("");
		expect(again.lines).toHaveLength(1);
		const task = w.task();
		expect(task.attemptId).not.toBe(refused.attemptId);
		expect(task).toMatchObject({ phase: "active", held: true, sessionId: "controlled-session", turnId: "controlled-turn", workspace: { attemptId: task.attemptId } });
		expect(task.reason).toBeUndefined();
		const run = w.store.getOperation(refused.id, "operator-run")!;
		expect(run).toMatchObject({ attemptId: task.attemptId, receipt: { phase: "active", sessionId: "controlled-session", turnId: "controlled-turn" } });
		expect((run as any).lease).toBeUndefined();
		expect(again.last).toMatchObject({ taskId: refused.id, phase: "active", sessionId: "controlled-session", reused: true, operationId: run.id, exit: 0, outcome: "ok" });
		expect(await w.dispatches()).toEqual([`prepare ${refused.attemptId}`, `preflight ${refused.attemptId}`, `prepare ${task.attemptId}`]);
		expect(w.events("preparation_refusal_cleared").map((e) => e.data)).toMatchObject([{
			previousAttemptId: refused.attemptId, attemptId: task.attemptId, operationId: retained.id, code: REFUSAL,
			certainty: "before_send", preflight: "passed", operatorRun: { previousOperationId: oldRun.id, operationId: run.id },
		}]);
		expect(w.events("unknown")).toHaveLength(0);
		expect(w.events("reserved")).toHaveLength(1);
		expect(w.charges()).toBe(1);
		expect(await w.coordinatorCalls()).toBe(2);
		// The refused attempt's claims stay as recorded: the refusal receipt is immutable, the old run claim unleased.
		const raw = (id: string) => JSON.parse(((w.store as any).db.query("SELECT data FROM operations WHERE id=?").get(id) as any).data);
		expect(raw(retained.id)).toEqual(retained);
		expect(raw(oldRun.id)).toEqual(oldRun);
		// Stable: a third run reports the acknowledged start and sends nothing.
		const third = await cli(w.db, "run", w.file);
		expect(third.exit).toBe(0);
		expect(third.last).toMatchObject({ phase: "active", reused: true, operationId: run.id, exit: 0, outcome: "ok" });
		expect(await w.dispatches()).toHaveLength(3);
		expect(await w.coordinatorCalls()).toBe(2);
		expect(w.charges()).toBe(1);
	}, 90000);

	test("a run-started refusal is a retained refusal: archivable while dispatching (stack-1 release route), released once; run then reports archived (4) and sends nothing", async () => {
		const w = await refusalWorld("run-archive-dispatching");
		const refused = await refusedRun(w);
		const archived = await new Fleet(w.store).archive(refused.id, { noSessionConfirmation: { kind: "never_started", reason: "refused before send" } });
		expect(archived).toMatchObject({ phase: "archived", held: false, archivedFrom: { phase: "dispatching" } });
		expect(w.charges()).toBe(0);
		expect(w.events("released")).toHaveLength(1);
		const r = await cli(w.db, "run", w.file);
		expect(r.exit).toBe(4);
		expect(r.last).toMatchObject({ taskId: refused.id, phase: "archived", exit: 4, outcome: "failed" });
		expect(await w.actions()).toEqual(["prepare"]);
		expect(await w.coordinatorCalls()).toBe(0);
		expect(w.events("released")).toHaveLength(1);
	}, 60000);

	test("a start-retained refusal followed by CLI run: run re-checks it exactly as start (preflight -> clear -> fresh attempt -> prepare); no second reservation (exit 0)", async () => {
		const w = await refusalWorld("start-then-run");
		await w.breakSource();
		expect((await caught(new Fleet(w.store).start(w.taskId()))).code).toBe(REFUSAL);
		await w.fixSource();
		const refusedAttempt = w.task().attemptId;
		expect(w.store.retainedPreparationRefusal(w.taskId())).toBeDefined();
		const r = await cli(w.db, "run", w.file);
		expect(r.exit).toBe(0);
		expect(r.last).toMatchObject({ phase: "active", exit: 0, outcome: "ok", reused: true });
		const task = w.task();
		expect(task.attemptId).not.toBe(refusedAttempt);
		expect(await w.dispatches()).toEqual([`prepare ${refusedAttempt}`, `preflight ${refusedAttempt}`, `prepare ${task.attemptId}`]);
		expect(w.events("preparation_refusal_cleared")).toHaveLength(1);
		expect(w.store.getOperation(task.id, "operator-run")).toMatchObject({ attemptId: task.attemptId, receipt: { phase: "active" } });
		expect(w.events("reserved")).toHaveLength(1);
		expect(w.charges()).toBe(1);
	}, 60000);

	test("preflight/clear path (stack-1) stays intact without run: start re-evaluates once, clears, then CLI run reports the acknowledged start (exit 0) with no second reservation", async () => {
		const w = await refusalWorld("start-clear-then-run");
		await w.breakSource();
		expect((await caught(new Fleet(w.store).start(w.taskId()))).code).toBe(REFUSAL);
		const refusedAttempt = w.task().attemptId;
		// Still refused: preflight only, retained, nothing claimed.
		expect((await caught(new Fleet(w.store).start(w.taskId()))).code).toBe(REFUSAL);
		expect(w.task().reason).toBe("preparation_refusal_retained:still_refused");
		await w.fixSource();
		const started = await new Fleet(w.store).start(w.taskId());
		expect(started).toMatchObject({ phase: "active", held: true, sessionId: "controlled-session", turnId: "controlled-turn" });
		expect(started.attemptId).not.toBe(refusedAttempt);
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "prepare"]);
		expect(w.events("preparation_refusal_cleared")).toHaveLength(1);
		const r = await cli(w.db, "run", w.file);
		expect(r.exit).toBe(0);
		expect(r.last).toMatchObject({ taskId: started.id, phase: "active", sessionId: "controlled-session", reused: true, exit: 0, outcome: "ok" });
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "prepare"]);
		expect(w.events("reserved")).toHaveLength(1);
		expect(w.charges()).toBe(1);
	}, 90000);

	test("retained refusal released by archive (stack-1 route): run reports archived (4) and sends no preflight; watch --all-active ignores it", async () => {
		const w = await refusalWorld("archived-refusal");
		await w.breakSource();
		expect((await caught(new Fleet(w.store).start(w.taskId()))).code).toBe(REFUSAL);
		const archived = await new Fleet(w.store).archive(w.taskId(), { noSessionConfirmation: { kind: "never_started", reason: "refused before send" } });
		expect(archived).toMatchObject({ phase: "archived", held: false });
		await w.fixSource();
		const r = await cli(w.db, "run", w.file);
		expect(r.exit).toBe(4);
		expect(r.last).toMatchObject({ phase: "archived", exit: 4, outcome: "failed", reused: true, operationId: null });
		const watch = await cli(w.db, "watch", "--all-active", "--interval", "10", "--max-polls", "2");
		expect(watch.exit).toBe(0);
		expect(watch.lines).toEqual([{ observation: "summary", exit: 0, outcome: "ok", tasks: {} }]);
		expect(await w.actions()).toEqual(["prepare"]);
		expect(w.store.getOperation(w.taskId(), "operator-run")).toBeUndefined();
	}, 60000);

	test("resource return of a retained refusal (never had a session): return and return-override refuse, nothing sent; archive releases once; return after archive still refuses", async () => {
		const w = await refusalWorld("return-refusal");
		await w.breakSource();
		expect((await caught(new Fleet(w.store).start(w.taskId()))).code).toBe(REFUSAL);
		const refused: ReturnReport[] = [{ taskId: w.taskId(), state: "refused", reason: "settlement_custody_or_ownership_missing", refusal: "not_settled" }];
		expect(await returnResources(w.store, [w.taskId()], { paceMs: 0 })).toEqual(refused);
		expect((await caught(operatorReleaseResource(w.store, w.taskId(), { operator: "op", reason: "r" }))).code).toBe("RETURN_NOT_SETTLED");
		expect(w.charges()).toBe(1);
		expect(w.events("released")).toHaveLength(0);
		await new Fleet(w.store).archive(w.taskId(), { noSessionConfirmation: { kind: "never_started", reason: "refused before send" } });
		expect(w.charges()).toBe(0);
		expect(w.events("released")).toHaveLength(1);
		expect(await returnResources(w.store, [w.taskId()], { paceMs: 0 })).toEqual(refused);
		const r = await cli(w.db, "return", w.taskId());
		expect(r.exit).toBe(1);
		expect(r.last).toEqual(refused);
		expect(w.store.resourceReturnStatus(w.taskId())).toBeUndefined();
		expect(w.events("released")).toHaveLength(1);
		expect(await w.actions()).toEqual(["prepare"]);
		expect(await w.coordinatorCalls()).toBe(0);
	}, 60000);
	test("watch of a held refused attempt: not acknowledged, so never inspected remotely; the poll limit reports unavailable (5), nothing marked", async () => {
		const w = await refusalWorld("watch-refused");
		const refused = await refusedRun(w);
		const output: any[] = [];
		const exit = await watchTasks(new Fleet(w.store), { ids: [refused.id], interval: 10, maxPolls: 2, emit: (v) => output.push(v), sleep: async () => {} });
		expect(exit).toBe(5);
		expect(output.at(-1)).toEqual({ observation: "summary", exit: 5, outcome: "unavailable", tasks: { [refused.id]: 5 } });
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true });
		expect(await w.actions()).toEqual(["prepare"]);
		expect(await w.coordinatorCalls()).toBe(0);
	}, 60000);
});

// ---------------------------------------------------------------------------------------------
// Stack-3: `run` and `start` compose with a retained before_send refusal (STACK.md S1 fixed).
// Deaths are real SIGKILLs: of the CLI while the recording shim holds a node request, or of a child
// running the real runTask that kills itself right after (or inside) a named store step.
// ---------------------------------------------------------------------------------------------
const srcDir = resolve(root, "src");
/** The refusal world with a shim that can hold (`block-<action>`) or fail (`fail-<action>`) a node request. */
async function holdingWorld(key: string) {
	const w = await refusalWorld(key);
	const file = (name: string) => join(w.dir, name);
	await writeFile(file("helper.ts"), `import {appendFileSync,existsSync,rmSync,writeFileSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';let attempt='?';try{const r=JSON.parse(input);action=String(r.action);attempt=String(r.input?.attemptId??r.identity?.attemptId)}catch{}
const block=${JSON.stringify(file("block-"))}+action;const held=existsSync(block);const pidFile=block+'.'+process.pid+'.pid';
if(held)writeFileSync(pidFile,'');
appendFileSync(${JSON.stringify(file("dispatches"))},action+' '+attempt+'\\n');
if(held){while(existsSync(block))await Bun.sleep(20);rmSync(pidFile);}
if(existsSync(${JSON.stringify(file("fail-"))}+action))process.exit(70);
const child=Bun.spawn([process.execPath,${JSON.stringify(helperTs)},${JSON.stringify(file("config.json"))}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`);
	// A held shim is SIGKILLed, never released: the held request is never delivered to the real helper.
	const killHeld = async () => {
		for (const name of await Array.fromAsync(new Bun.Glob("block-*.pid").scan({ cwd: w.dir }))) {
			try { process.kill(Number(name.split(".").at(-2)), "SIGKILL"); } catch { /* already gone */ }
		}
	};
	cleanups.push(killHeld);
	// Windows has no signals: a self-sent SIGKILL is TerminateProcess(self, 1), indistinguishable from
	// exit(1). There the child stops synchronously at the point (nothing after it runs, a transaction
	// stays open) and the parent terminates it with the real kill Bun reports as SIGKILL.
	const dying = (pid: number) => file("dying-" + pid);
	const die = process.platform === "win32"
		? `const die = () => { require("node:fs").writeFileSync(${JSON.stringify(file("dying-"))} + process.pid, ""); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); process.exit(99); };`
		: `const die = () => process.kill(process.pid, "SIGKILL");`;
	const script = file("run-death.ts");
	await writeFile(script, `import { Fleet } from ${JSON.stringify(join(srcDir, "fleet.ts"))};
import { FleetStore } from ${JSON.stringify(join(srcDir, "store.ts"))};
import { runTask } from ${JSON.stringify(join(srcDir, "operator-commands.ts"))};
const [db, inputFile, point] = process.argv.slice(2);
${die}
const P = FleetStore.prototype as any;
const after = (name: string, when: (...a: any[]) => boolean = () => true) => {
	const original = P[name];
	P[name] = function (...a: any[]) { const r = original.apply(this, a); if (when(...a, r)) die(); return r; };
};
if (point === "lease") after("leaseOperatorRun", (...a) => a.at(-1) === true);
else if (point === "renew-uncommitted") {
	const audit = P.audit;
	P.audit = function (kind: string, ...a: any[]) { if (kind === "preparation_refusal_cleared") die(); return audit.call(this, kind, ...a); };
} else if (point === "renew-committed") after("renewRefusedPreparation");
else if (point === "prepare-claimed") after("claimOperation", (_id, kind) => kind === "prepare");
else if (point === "workspace") after("setWorkspace");
else throw new Error("unknown_death_point");
const store = new FleetStore(db);
await runTask(new Fleet(store), await Bun.file(inputFile).json(), { sample: async () => { throw new Error("no_measurement"); } });
console.log("SURVIVED");`);
	return {
		...w,
		block: (action: string) => writeFile(file("block-" + action), ""),
		fail: (action: string) => writeFile(file("fail-" + action), ""),
		unfail: (action: string) => rm(file("fail-" + action), { force: true }),
		killHeld,
		/** Wait until the shim recorded `count` node requests. */
		async dispatched(count: number) {
			for (let i = 0; i < 1500; i++) {
				if ((await w.dispatches()).length >= count) return;
				await Bun.sleep(20);
			}
			throw new Error("dispatch_not_observed");
		},
		/** The real runTask in its own process, SIGKILLed by itself at `point`. */
		async dieAt(point: string) {
			const child = Bun.spawn([process.execPath, script, w.db, w.file, point], { cwd: root, stdout: "pipe", stderr: "pipe" });
			if (process.platform === "win32") {
				while (child.exitCode === null && child.signalCode === null && !(await Bun.file(dying(child.pid)).exists())) await Bun.sleep(10);
				child.kill("SIGKILL");
			}
			const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			expect({ signal: child.signalCode, stdout, stderr }).toEqual({ signal: "SIGKILL", stdout: "", stderr: "" });
		},
		/** The real CLI run, SIGKILLed once the shim holds its `count`-th node request. */
		async killCliAt(action: string, count: number) {
			await this.block(action);
			const child = Bun.spawn([process.execPath, cliPath, "--db", w.db, "run", w.file], { cwd: root, stdout: "pipe", stderr: "pipe" });
			await this.dispatched(count);
			child.kill("SIGKILL");
			await child.exited;
			expect(child.signalCode).toBe("SIGKILL");
			await killHeld();
			await rm(file("block-" + action), { force: true });
		},
	};
}
/** Invariants of every re-run: one task, one reservation, one held charge, the refused claim immutable. */
function expectOneReservation(w: RefusalWorld) {
	expect(w.store.tasks()).toHaveLength(1);
	expect(w.events("reserved")).toHaveLength(1);
	expect(w.charges()).toBe(1);
}
function expectStarted(w: RefusalWorld, r: Awaited<ReturnType<typeof cli>>, refusedAttempt: string) {
	expect(r.exit).toBe(0);
	expect(r.last).toMatchObject({ phase: "active", sessionId: "controlled-session", reused: true, exit: 0, outcome: "ok" });
	const task = w.task();
	expect(task.attemptId).not.toBe(refusedAttempt);
	expect(task).toMatchObject({ phase: "active", held: true, workspace: { attemptId: task.attemptId } });
	expect(w.events("preparation_refusal_cleared")).toMatchObject([{ data: { previousAttemptId: refusedAttempt, attemptId: task.attemptId } }]);
	expect(w.events("unknown")).toHaveLength(0);
	expectOneReservation(w);
	return task;
}

describe("stack-3: run and start compose with a retained before_send refusal", () => {
	test("cause persists: run re-checks by preflight only and stays refused and retained (exit 1, typed error row, reason still_refused, lease released), identical to start; cleared once fixed", async () => {
		const w = await refusalWorld("run-still-refused");
		const refused = await refusedRun(w);
		await w.breakSource();
		const again = await cli(w.db, "run", w.file);
		expectErrorRow(again, REFUSAL);
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true, attemptId: refused.attemptId, reason: "preparation_refusal_retained:still_refused" });
		expect(w.store.retainedPreparationRefusal(refused.id)).toBeDefined();
		expect((w.store.getOperation(refused.id, "operator-run") as any).lease).toBeUndefined();
		expect(w.events("preparation_reevaluation").map((e) => e.data)).toMatchObject([{ outcome: "still_refused", code: REFUSAL }]);
		// Plain start on the same run-started refusal: the identical re-check and outcome.
		expect((await caught(new Fleet(w.store).start(refused.id))).code).toBe(REFUSAL);
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true, attemptId: refused.attemptId, reason: "preparation_refusal_retained:still_refused" });
		expect(await w.dispatches()).toEqual([`prepare ${refused.attemptId}`, `preflight ${refused.attemptId}`, `preflight ${refused.attemptId}`]);
		expect(w.events("preparation_refusal_cleared")).toHaveLength(0);
		expectOneReservation(w);
		await w.fixSource();
		const task = expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "preflight", "prepare"]);
		expect(task.reason).toBeUndefined();
	}, 90000);

	test("plain start clears a run-started refusal exactly as run does; the following run reports the acknowledged start (exit 0)", async () => {
		const w = await refusalWorld("run-then-start");
		const refused = await refusedRun(w);
		const started = await new Fleet(w.store).start(refused.id);
		expect(started).toMatchObject({ phase: "active", held: true });
		expect(started.attemptId).not.toBe(refused.attemptId);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
		// start carries the (unleased, unreceipted) run claim to the fresh attempt; the next run reuses it.
		const r = await cli(w.db, "run", w.file);
		expectStarted(w, r, refused.attemptId!);
		expect(r.last.operationId).toBe(w.store.getOperation(refused.id, "operator-run")!.id);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
	}, 90000);

	test("preflight cannot run: exit 1 with the typed transport code, retained with reason preparation_refusal_retained:unavailable; nothing claimed; cleared once it can", async () => {
		const w = await holdingWorld("run-preflight-unavailable");
		const refused = await refusedRun(w);
		await w.fail("preflight");
		const again = await cli(w.db, "run", w.file);
		expect(again.exit).toBe(1);
		const code = again.last.error;
		expect(code).toMatch(/^node_/);
		expectErrorRow(again, code);
		expect(w.task()).toMatchObject({ phase: "dispatching", held: true, attemptId: refused.attemptId, reason: "preparation_refusal_retained:unavailable" });
		expect(w.events("preparation_reevaluation").map((e) => e.data)).toMatchObject([{ outcome: "unavailable", code }]);
		expect(w.store.retainedPreparationRefusal(refused.id)).toBeDefined();
		expect(await w.actions()).toEqual(["prepare", "preflight"]);
		await w.unfail("preflight");
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "prepare"]);
	}, 90000);

	test("visible: show and tasks carry the retained refusal (typed code, attempt, certainty) for run- and start-started refusals; gone once cleared", async () => {
		const w = await refusalWorld("run-visible");
		const refused = await refusedRun(w);
		const prepare = w.store.getOperation(refused.id, "prepare")!;
		const indicator = { operationId: prepare.id, attemptId: refused.attemptId, code: REFUSAL, certainty: "before_send" };
		const show = await cli(w.db, "show", refused.id);
		expect(show.exit).toBe(0);
		expect(show.last).toMatchObject({ id: refused.id, phase: "dispatching", held: true, preparationRefusal: indicator });
		const listed = await cli(w.db, "--read-only", "tasks", "--phase", "dispatching");
		expect(listed.last).toMatchObject([{ id: refused.id, preparationRefusal: indicator }]);
		expect(await w.actions()).toEqual(["prepare"]);
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect((await cli(w.db, "show", refused.id)).last.preparationRefusal).toBeUndefined();
		// A start-started refusal is shown the same way.
		const s = await refusalWorld("start-visible");
		await s.breakSource();
		expect((await caught(new Fleet(s.store).start(s.taskId()))).code).toBe(REFUSAL);
		const shown = await cli(s.db, "show", s.taskId());
		expect(shown.last.preparationRefusal).toEqual({ operationId: s.store.getOperation(s.taskId(), "prepare")!.id, attemptId: s.task().attemptId, code: REFUSAL, certainty: "before_send" });
	}, 90000);

	test("not a retained refusal: an operator-run claim with a receipt, or a second effect claim, on the refused attempt; such a task takes main's no-replay path", async () => {
		const w = await refusalWorld("run-not-retained");
		const refused = await refusedRun(w);
		const run = w.store.getOperation(refused.id, "operator-run")!;
		w.store.recordOperationReceipt(refused.id, "operator-run", run.id, { phase: "dispatching", sessionId: null, turnId: null });
		expect(w.store.retainedPreparationRefusal(refused.id)).toBeUndefined();
		const r = await cli(w.db, "run", w.file);
		// A receipted run claim is reported from the durable, never acknowledged task (taskExit: not_started).
		expect(r.exit).toBe(9);
		expect(r.last).toMatchObject({ phase: "dispatching", reused: true, exit: 9, outcome: "not_started" });
		expect(w.task().attemptId).toBe(refused.attemptId);
		expect(await w.actions()).toEqual(["prepare"]);
		const s = await refusalWorld("start-not-retained");
		await s.breakSource();
		expect((await caught(new Fleet(s.store).start(s.taskId()))).code).toBe(REFUSAL);
		await s.fixSource();
		s.store.claimOperation(s.taskId(), "approval-attach", { forged: true });
		expect(s.store.retainedPreparationRefusal(s.taskId())).toBeUndefined();
		const t = await cli(s.db, "run", s.file);
		expect(t.exit).toBe(3);
		expect(t.last).toMatchObject({ phase: "blocked_unknown", exit: 3, outcome: "blocked_unknown" });
		expect(s.task().reason).toBe("preparation_inflight_or_unknown_no_replay");
		expect(await s.actions()).toEqual(["prepare"]);
	}, 90000);

	// Kill at each step of the re-run (cause already removed), then one more CLI run.
	test("kill after the run's lease is taken, before preflight: the next run takes over the dead lease and clears (exit 0)", async () => {
		const w = await holdingWorld("kill-lease");
		const refused = await refusedRun(w);
		await w.dieAt("lease");
		expect(await w.actions()).toEqual(["prepare"]);
		expect(w.task()).toMatchObject({ phase: "dispatching", attemptId: refused.attemptId });
		expect((w.store.getOperation(refused.id, "operator-run") as any).lease.pid).toBeGreaterThan(0);
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
		expect(w.events("operator_run_lease").at(-1)!.data).toHaveProperty("replacedOwner");
	}, 90000);

	test("kill during preflight: nothing changed; the next run re-checks and clears (exit 0)", async () => {
		const w = await holdingWorld("kill-preflight");
		const refused = await refusedRun(w);
		await w.killCliAt("preflight", 2);
		expect(w.task()).toMatchObject({ phase: "dispatching", attemptId: refused.attemptId });
		expect(w.store.retainedPreparationRefusal(refused.id)).toBeDefined();
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "prepare"]);
	}, 90000);

	test("kill inside the clearing transaction: rolled back, still retained on the old attempt; the next run re-checks and clears once (exit 0)", async () => {
		const w = await holdingWorld("kill-renew-inside");
		const refused = await refusedRun(w);
		await w.dieAt("renew-uncommitted");
		expect(w.task()).toMatchObject({ phase: "dispatching", attemptId: refused.attemptId });
		expect(w.store.retainedPreparationRefusal(refused.id)).toBeDefined();
		expect(w.events("preparation_refusal_cleared")).toHaveLength(0);
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "preflight", "prepare"]);
	}, 90000);

	test("kill right after the clear committed: fresh attempt with the carried (dead) lease; the next run takes it over and prepares, no second preflight (exit 0)", async () => {
		const w = await holdingWorld("kill-renew-committed");
		const refused = await refusedRun(w);
		await w.dieAt("renew-committed");
		const renewed = w.task();
		expect(renewed).toMatchObject({ phase: "preparing", held: true });
		expect(renewed.attemptId).not.toBe(refused.attemptId);
		expect(w.store.getOperation(refused.id, "operator-run")).toMatchObject({ attemptId: renewed.attemptId });
		expect(w.store.getOperation(refused.id, "prepare")).toBeUndefined();
		const task = expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(task.attemptId).toBe(renewed.attemptId);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
	}, 90000);

	test("kill right after the fresh prepare claim, before send: unknown, never replayed (exit 3, preparation_inflight_or_unknown_no_replay)", async () => {
		const w = await holdingWorld("kill-prepare-claimed");
		const refused = await refusedRun(w);
		await w.dieAt("prepare-claimed");
		const renewed = w.task();
		expect(renewed.attemptId).not.toBe(refused.attemptId);
		for (const _ of [1, 2]) {
			const r = await cli(w.db, "run", w.file);
			expect(r.exit).toBe(3);
			expect(r.last).toMatchObject({ phase: "blocked_unknown", exit: 3, outcome: "blocked_unknown" });
		}
		expect(w.task()).toMatchObject({ phase: "blocked_unknown", held: true, attemptId: renewed.attemptId, reason: "preparation_inflight_or_unknown_no_replay" });
		expect(await w.actions()).toEqual(["prepare", "preflight"]);
		expect(await w.coordinatorCalls()).toBe(0);
		expectOneReservation(w);
	}, 90000);

	test("kill while the fresh prepare is in flight: unknown, never replayed (exit 3); no preflight or prepare after it", async () => {
		const w = await holdingWorld("kill-prepare-sent");
		const refused = await refusedRun(w);
		await w.killCliAt("prepare", 3);
		const renewed = w.task();
		expect(renewed.attemptId).not.toBe(refused.attemptId);
		for (const _ of [1, 2]) expect((await cli(w.db, "run", w.file)).exit).toBe(3);
		expect(w.task()).toMatchObject({ phase: "blocked_unknown", held: true, attemptId: renewed.attemptId, reason: "preparation_inflight_or_unknown_no_replay" });
		expect(await w.dispatches()).toEqual([`prepare ${refused.attemptId}`, `preflight ${refused.attemptId}`, `prepare ${renewed.attemptId}`]);
		expect(await w.coordinatorCalls()).toBe(0);
		expectOneReservation(w);
	}, 90000);

	test("kill after the fresh workspace is recorded: the next run continues on that workspace (no second prepare or workspace) and starts (exit 0)", async () => {
		const w = await holdingWorld("kill-workspace");
		const refused = await refusedRun(w);
		await w.dieAt("workspace");
		const prepared = w.task();
		expect(prepared.workspace).toMatchObject({ attemptId: prepared.attemptId });
		const task = expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(task.workspace).toEqual(prepared.workspace);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
		expect(await w.coordinatorCalls()).toBe(2);
	}, 90000);

	// Two concurrent `run` processes on one run-started refusal (cause removed).
	test("two concurrent CLI runs, one held in preflight: the other sees the live lease (exit 7, nothing sent); the holder clears and starts (exit 0)", async () => {
		const w = await holdingWorld("concurrent-held");
		const refused = await refusedRun(w);
		await w.block("preflight");
		const first = Bun.spawn([process.execPath, cliPath, "--db", w.db, "run", w.file], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const firstOut = Promise.all([new Response(first.stdout).text(), first.exited]);
		await w.dispatched(2);
		const second = await cli(w.db, "run", w.file);
		expect(second.exit).toBe(7);
		expect(second.last).toMatchObject({ phase: "dispatching", reused: true, exit: 7, outcome: "in_progress" });
		expect(await w.actions()).toEqual(["prepare", "preflight"]);
		await rm(join(w.dir, "block-preflight"));
		const [stdout, exit] = await firstOut;
		expect(exit).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ phase: "active", exit: 0, outcome: "ok" });
		expectStarted(w, await cli(w.db, "run", w.file), refused.attemptId!);
		expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
		expect(await w.coordinatorCalls()).toBe(2);
	}, 90000);

	test("two concurrent CLI runs started together (3 rounds): exits only 0/7, exactly one preflight, one clear, one fresh prepare, one session, one reservation", async () => {
		for (const round of [1, 2, 3]) {
			const w = await refusalWorld(`concurrent-race-${round}`);
			const refused = await refusedRun(w);
			const [a, b] = await Promise.all([cli(w.db, "run", w.file), cli(w.db, "run", w.file)]);
			const exits = [a.exit, b.exit].sort();
			expect([[0, 0], [0, 7]]).toContainEqual(exits);
			expect(a.stderr + b.stderr).toBe("");
			expectStarted(w, a.exit === 0 ? a : b, refused.attemptId!);
			expect(await w.actions()).toEqual(["prepare", "preflight", "prepare"]);
			expect(await w.coordinatorCalls()).toBe(2);
		}
	}, 180000);

	test("a run whose attempt was cleared by another live run between its read and its claim or lease re-binds to the fresh attempt and reports in_progress (7); nothing sent", async () => {
		for (const step of ["claimOperation", "leaseOperatorRun"] as const) {
			const w = await refusalWorld(`rebind-${step}`);
			const refused = await refusedRun(w);
			const retained = w.store.retainedPreparationRefusal(refused.id)!;
			const oldRun = w.store.getOperation(refused.id, "operator-run")!;
			// Another live run (this pid, another owner) holds the lease and clears the attempt at exactly this step.
			const other = new FleetStore(w.db);
			cleanups.push(() => other.close());
			const mine = new FleetStore(w.db);
			cleanups.push(() => mine.close());
			const original = (mine as any)[step].bind(mine);
			let raced = false;
			(mine as any)[step] = (...args: any[]) => {
				if (!raced && args[1] === (step === "claimOperation" ? "operator-run" : oldRun.id)) {
					raced = true;
					expect(other.leaseOperatorRun(refused.id, oldRun.id, { owner: "other-run", pid: process.pid, host: hostname(), expiresAt: Date.now() + 60000 }, () => false)).toBe(true);
					other.renewRefusedPreparation(refused.id, retained.id);
				}
				return original(...args);
			};
			const result = await runTask(new Fleet(mine), w.input, { sample: noSample });
			expect(raced).toBe(true);
			expect(result.code).toBe(7);
			const task = w.task();
			expect(task.attemptId).not.toBe(refused.attemptId);
			expect(result.operationId).toBe(w.store.getOperation(refused.id, "operator-run")!.id);
			expect((w.store.getOperation(refused.id, "operator-run") as any).lease.owner).toBe("other-run");
			expect(await w.actions()).toEqual(["prepare"]);
			expectOneReservation(w);
		}
	}, 90000);

	test("exit table: row 1 is the single source for a proven before_send refusal of a run (no new row; codes 0..9 unchanged)", () => {
		expect(exitCodes.map((r) => r.code)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(exitCodes[1].meaning).toContain("proven before_send node refusal of prepare");
		expect(exitCodes[1].meaning).toContain("preparation_refusal_retained");
	});
});

// ---------------------------------------------------------------------------------------------
// Receipt-less settlement, late receipts, resource return / override, archive (main) x operator commands.
// World fixture as in main's test/stack-interactions.test.ts.
// ---------------------------------------------------------------------------------------------
const coordinatorPath = fileURLToPath(new URL("./fixtures/stack-coordinator.ts", import.meta.url));
const sdkPath = fileURLToPath(new URL("./fixtures/stack-sdk.ts", import.meta.url));
const SESSION = "controlled-session";
const TURN = "controlled-turn";
const INTERVAL = 60_000;
const T0 = Date.parse("2026-11-12T10:00:00.000Z");
const INCARNATION = "b".repeat(64);
const OK_ARGV = [process.execPath, "--eval", "process.exit(0)"];
type Shape = { turn: Record<string, any>; execution: Record<string, any> };
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
	const s = structuredClone(base);
	s.turn.turn.status = "completed";
	delete s.turn.turn.error;
	s.turn.turn.final_response = { source: "agent_end" };
	s.turn.advisory_status.live = true;
	s.turn.session_state.state = "completed";
	s.execution = structuredClone(OK_RECEIPT);
	return s;
};
const KINDS = [["failed_without_receipt", failedMissing], ["ended_without_receipt", olderCompleted]] as const;

async function world(shape: Shape, defer: boolean) {
	const repo = await repositoryFixture("stack-op-world-");
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
	const input: TaskInput = { schemaVersion: 1, key: "stack-operator", caller: "controlled-operator", repoId: "repo", baseCommit: repo.baseCommit, prompt: "CONTROLLED prompt", required: {} };
	const file = join(repo.dir, "task.json");
	await writeFile(file, JSON.stringify(input));
	const started = await fleet.start(fleet.submit(input).id);
	expect(started).toMatchObject({ phase: "active", held: true, sessionId: SESSION, turnId: TURN });
	const id = started.id;
	const sdk = async (): Promise<StackSdkState> => JSON.parse(await readFile(sdkState, "utf8"));
	const sdkCalls = async () => (await readFile(sdkLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const coordinator = async () => JSON.parse(await readFile(coordinatorState, "utf8"));
	const events = (kind: string) => store.events(id).filter((e) => e.kind === kind);
	return {
		store, fleet, node, dbPath, repo, id, input, file,
		setNow(ms: number) { now = T0 + ms; },
		async poll(ms: number, tolerateReadFailure = false) { now = T0 + ms; return fleet.inspect(id, { tolerateReadFailure }); },
		/** Transport-level read failure: the stand-in cannot load its state and dies on the next tools/call. */
		breakCoordinator: () => rename(coordinatorState, coordinatorState + ".away"),
		fixCoordinator: () => rename(coordinatorState + ".away", coordinatorState),
		async setSdk(patch: (s: StackSdkState) => void) { const s = await sdk(); patch(s); await writeFile(sdkState, JSON.stringify(s)); },
		async setTurn(turn: Record<string, any> | undefined, gone = false) { await writeFile(coordinatorState, JSON.stringify({ ...(await coordinator()), readTurn: turn, readTurnGone: gone })); },
		sdkCalls,
		closes: async () => (await sdkCalls()).filter((c) => c.op === "close"),
		lists: async () => (await sdkCalls()).filter((c) => c.op === "list"),
		/** Every coordinator call (start/send/read) by name. */
		calls: async () => (await coordinator()).calls.map((c: any) => c.name as string),
		reads: async () => (await coordinator()).calls.filter((c: any) => c.name === "gjc_coordinator_read_turn").length,
		events,
		released: () => events("released").length,
		charges: () => [...store.heldCharges().values()].flat().length,
		auditCount: () => store.events(id).length,
		task: (): TaskRecord => store.task(id)!,
		ret: () => returnResources(store, [id], { paceMs: 0 }),
	};
}
type World = Awaited<ReturnType<typeof world>>;
async function settleByA(w: World, kind: string, defer: boolean) {
	expect((await w.poll(0)).task.result?.executionTerminal).not.toBe(true);
	const settled = (await w.poll(INTERVAL)).task;
	if (settled.phase === "blocked_unknown") {
		const diagnostic = normalizeDiagnostic(w.events("unknown").at(-1)?.data?.failureDiagnostic);
		if (diagnostic) {
			// Fixed Fleet diagnostic fields only: never dump audit events or transport output.
			console.error("settleByA: second poll failed", diagnostic.source, diagnostic.phase, diagnostic.code);
		}
	}
	expect(settled).toMatchObject({ phase: "failed", held: defer, result: { executionTerminal: true, verified: false, settlement: { kind } } });
	return settled;
}
/** run of an existing settled/archived task: reported from durable state only; nothing measured, claimed, sent or read. */
async function expectReportedOnly(w: World, code: number, phase: string) {
	const calls = await w.calls();
	const sdk = (await w.sdkCalls()).length;
	const released = w.released();
	const charges = w.charges();
	const result = await runTask(w.fleet, w.input, { sample: noSample });
	expect(result).toMatchObject({ code, reused: true, task: { id: w.id, phase } });
	expect(w.store.getOperation(w.id, "operator-run")).toBeUndefined();
	const r = await cli(w.dbPath, "run", w.file);
	expect(r.exit).toBe(code);
	expect(r.stderr).toBe("");
	expect(r.lines).toHaveLength(1);
	expect(r.last).toMatchObject({ taskId: w.id, phase, reused: true, exit: code, operationId: null, sessionId: SESSION });
	const wait = await cli(w.dbPath, "run", w.file, "--wait");
	expect(wait.exit).toBe(code);
	// --wait watches only an ok run: the run row, the task line, then the summary.
	expect(wait.lines).toHaveLength(code === 0 ? 3 : 1);
	if (code === 0) expect(wait.last).toEqual({ observation: "summary", exit: 0, outcome: "ok", tasks: { [w.id]: 0 } });
	expect(await w.calls()).toEqual(calls);
	expect((await w.sdkCalls()).length).toBe(sdk);
	expect(w.released()).toBe(released);
	expect(w.charges()).toBe(charges);
	expect(w.store.getOperation(w.id, "operator-run")).toBeUndefined();
}
async function expectWatchIgnores(w: World) {
	const reads = await w.reads();
	const watch = await cli(w.dbPath, "watch", "--all-active", "--interval", "10", "--max-polls", "2");
	expect(watch.exit).toBe(0);
	expect(watch.lines).toEqual([{ observation: "summary", exit: 0, outcome: "ok", tasks: {} }]);
	expect(await w.reads()).toBe(reads);
}

describe("receipt-less settled tasks under run / watch", () => {
	for (const [kind, shape] of KINDS)
		test(`${kind}: run and run --wait report failed (4) without measuring, claiming, sending or reading; watch --all-active ignores it; watch by id reports 4 without a read`, async () => {
			const w = await world(shape, false);
			await settleByA(w, kind, false);
			expect(w.released()).toBe(1);
			await expectReportedOnly(w, 4, "failed");
			await expectWatchIgnores(w);
			const reads = await w.reads();
			const output: any[] = [];
			expect(await watchTasks(w.fleet, { ids: [w.id], interval: 10, maxPolls: 3, emit: (v) => output.push(v), sleep: async () => {} })).toBe(4);
			expect(output.at(-1)).toEqual({ observation: "summary", exit: 4, outcome: "failed", tasks: { [w.id]: 4 } });
			expect(await w.reads()).toBe(reads);
			const filtered = await cli(w.dbPath, "tasks", "--phase", "failed", "--compact");
			expect(filtered.exit).toBe(0);
			expect(filtered.stdout.trim().split("\t").slice(0, 3)).toEqual([w.id.slice(0, 12), "failed", "alpha"]);
		}, 60000);

	for (const [kind, shape] of KINDS)
		test(`${kind}: watch by id is the observer that settles it (two identical reads 60 s apart, tolerant mode, same rules): exit 4, one release, no unknown`, async () => {
			const w = await world(shape, false);
			const output: any[] = [];
			let tick = 0;
			const exit = await watchTasks(w.fleet, { ids: [w.id], interval: 10, maxPolls: 5, emit: (v) => output.push(v), sleep: async () => { w.setNow(++tick * INTERVAL); } });
			expect(exit).toBe(4);
			expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { executionTerminal: true, verified: false, settlement: { kind } } });
			// The first read records main's non-terminal receipt-less candidate (completed_unverified, still watched).
			expect(output.filter((v) => v.taskId === w.id && v.phase).map((v) => [v.phase, v.executionTerminal])).toEqual([["completed_unverified", false], ["failed", true]]);
			expect(output.at(-1)).toEqual({ observation: "summary", exit: 4, outcome: "failed", tasks: { [w.id]: 4 } });
			expect(w.released()).toBe(1);
			expect(w.events("unknown")).toHaveLength(0);
			expect(w.events("abandoned_poll")).toHaveLength(0);
			// Only read-only calls after the original start: no second session or prompt.
			expect((await w.calls()).filter((n: string) => !["gjc_coordinator_read_turn", "gjc_coordinator_list_questions"].includes(n))).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
		}, 60000);

	test("a failed read between the two receipt-less observations: watch reports it unavailable (never unknown, nothing released), then the next good read settles (4)", async () => {
		const w = await world(failedMissing, false);
		const output: any[] = [];
		let tick = 0;
		const exit = await watchTasks(w.fleet, { ids: [w.id], interval: 10, maxPolls: 6, emit: (v) => output.push(v), sleep: async () => {
			tick++;
			if (tick === 1) { w.setNow(INTERVAL / 2); await w.breakCoordinator(); }
			if (tick === 2) { w.setNow(INTERVAL); await w.fixCoordinator(); }
			if (tick > 2) w.setNow(tick * INTERVAL);
		} });
		expect(output.filter((v) => v.observation === "unavailable")).toEqual([{ taskId: w.id, observation: "unavailable", consecutiveFailures: 1 }]);
		expect(w.events("abandoned_poll")).toHaveLength(1);
		expect(w.events("unknown")).toHaveLength(0);
		expect(exit).toBe(4);
		expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { settlement: { kind: "failed_without_receipt" } } });
		expect(w.released()).toBe(1);
	}, 60000);

	test("two failed reads in a row after the receipt-less candidate: watch exits 5 (unavailable), the candidate stays held and unsettled, nothing marked or released", async () => {
		const w = await world(failedMissing, false);
		await w.poll(0);
		await w.breakCoordinator();
		const output: any[] = [];
		let tick = 0;
		const exit = await watchTasks(w.fleet, { ids: [w.id], interval: 10, maxPolls: 6, emit: (v) => output.push(v), sleep: async () => { w.setNow(++tick * INTERVAL); } });
		await w.fixCoordinator();
		expect(exit).toBe(5);
		expect(output.at(-1)).toEqual({ observation: "summary", exit: 5, outcome: "unavailable", tasks: { [w.id]: 5 } });
		expect(w.task()).toMatchObject({ phase: "completed_unverified", held: true });
		expect(w.task().result?.executionTerminal).not.toBe(true);
		expect(w.events("abandoned_poll")).toHaveLength(2);
		expect(w.events("unknown")).toHaveLength(0);
		expect(w.released()).toBe(0);
	}, 60000);

	test("tolerant inspection vs late-receipt observation: inside the window both modes take the same read-only late path; a failed read is never OBSERVATION_UNAVAILABLE and changes nothing", async () => {
		const w = await world(failedMissing, false);
		const settled = await settleByA(w, "failed_without_receipt", false);
		// Coordinator forgot the session and the runtime query fails: the tolerant read does not throw.
		await w.setTurn(undefined, true);
		await w.setSdk((s) => { s.executionFails = true; });
		const audit = w.auditCount();
		const tolerant = await w.poll(2 * INTERVAL, true);
		expect((tolerant.lateReceipt as any)?.found).not.toBe(true);
		expect(w.task()).toEqual(settled);
		expect(w.auditCount()).toBe(audit);
		expect(w.events("abandoned_poll")).toHaveLength(0);
		const strict = await w.poll(2 * INTERVAL, false);
		expect(strict.lateReceipt).toEqual(tolerant.lateReceipt);
		expect(w.task()).toEqual(settled);
		// A genuine late receipt: the tolerant read records it exactly like a strict poll; finality kept.
		const late = lateOk(failedMissing);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; s.executionFails = false; });
		expect((await w.poll(3 * INTERVAL, true)).lateReceipt).toEqual({ checked: true, found: true });
		expect(w.task()).toMatchObject({ phase: "failed", held: false, result: { lateReceipt: { status: "terminal_ok", settlementKind: "failed_without_receipt" } } });
		expect(w.events("late_receipt_contradiction")).toHaveLength(1);
		// Recorded contradiction never changes the operator outcome: still failed (4), nothing sent or released.
		await expectReportedOnly(w, 4, "failed");
		// A second tolerant read is idempotent.
		await w.poll(4 * INTERVAL, true);
		expect(w.events("late_receipt_contradiction")).toHaveLength(1);
		// Past the window: no read in either mode.
		const reads = await w.reads();
		const settledAt = Date.parse(settled.result!.settlement!.settledAt);
		await w.poll(settledAt - T0 + 24 * 3600_000 + 1, true);
		expect(await w.reads()).toBe(reads);
	}, 180000);

	test("accepted late receipt: completed_unverified is reported like any completed_unverified task (row 0, --wait settles 0), nothing re-sent; still 0 after the normal verifier", async () => {
		const w = await world(failedMissing, false);
		await settleByA(w, "failed_without_receipt", false);
		const late = lateOk(failedMissing);
		await w.setTurn(late.turn);
		await w.setSdk((s) => { s.execution = late.execution; });
		expect((await w.poll(2 * INTERVAL, true)).lateReceipt).toEqual({ checked: true, found: true });
		const accepted = await w.fleet.acceptLateReceipt(w.id, { reason: "operator checked" });
		expect(accepted).toMatchObject({ phase: "completed_unverified", held: false, result: { executionTerminal: true } });
		const code = (await runTask(w.fleet, w.input, { sample: noSample })).code;
		// Acceptance yields completed_unverified with status completed_unverified (terminal, acknowledged turn):
		// table row 0, exactly as an ordinary completed_unverified task; never artifact verification.
		expect(accepted.result?.status).toBe("completed_unverified");
		expect(code).toBe(0);
		await expectReportedOnly(w, code, "completed_unverified");
		expect((await w.fleet.result(w.id, OK_ARGV)).status).toBe("verified");
		expect(w.task()).toMatchObject({ phase: "succeeded", held: false });
		await expectReportedOnly(w, 0, "succeeded");
		expect(w.released()).toBe(1);
	}, 180000);
});

describe("resource return / operator override (possibly-running) under run / watch / tasks", () => {
	test("override-released task: run 4 and no re-reservation; tasks (also filtered) and show carry the possibly-running resourceReturn; compact line has no indicator", async () => {
		const w = await world(failedMissing, true);
		await settleByA(w, "failed_without_receipt", true);
		expect(w.charges()).toBe(1);
		await w.setSdk((s) => { s.listFails = true; });
		const released = await operatorReleaseResource(w.store, w.id, { operator: "op", reason: "node unreachable" });
		expect(released).toMatchObject({ state: "released_by_operator_unconfirmed", observedGone: false });
		expect(w.released()).toBe(1);
		expect(w.charges()).toBe(0);
		await expectReportedOnly(w, 4, "failed");
		await expectWatchIgnores(w);
		const indicator = { state: "released_by_operator_unconfirmed", operator: "op", observedGone: false };
		const all = await cli(w.dbPath, "tasks");
		expect(all.exit).toBe(0);
		expect(all.last.find((t: any) => t.id === w.id).resourceReturn).toMatchObject(indicator);
		// Resolved overlap (STACK.md C3): the reviewed filters keep main's per-task view.
		for (const args of [["--phase", "failed"], ["--node", "alpha"], ["--key-prefix", "stack-"], ["--phase", "failed,archived", "--node", "alpha"]]) {
			const filtered = await cli(w.dbPath, "tasks", ...args);
			expect(filtered.exit).toBe(0);
			expect(filtered.last).toHaveLength(1);
			expect(filtered.last[0]).toMatchObject({ id: w.id, phase: "failed", resourceReturn: indicator });
		}
		const show = await cli(w.dbPath, "show", w.id);
		expect(show.last.resourceReturn).toMatchObject(indicator);
		const ro = await cli(w.dbPath, "--read-only", "tasks", "--phase", "failed");
		expect(ro.last[0].resourceReturn).toMatchObject(indicator);
		// Compact is the reviewed 6-field line (no resourceReturn column): see STACK.md S2.
		const compact = await cli(w.dbPath, "tasks", "--phase", "failed", "--compact");
		expect(compact.stdout.trim().split("\t")).toHaveLength(6);
		// The node ends the session: confirmation recorded without a second release; run still 4.
		await w.setSdk((s) => { s.listFails = false; s.session.present = false; s.indexSeq += 3; });
		expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned", reason: "observed_gone_after_operator_release" }]);
		const after = await cli(w.dbPath, "tasks", "--phase", "failed");
		expect(after.last[0].resourceReturn).toMatchObject({ state: "returned", afterOperatorRelease: true });
		await expectReportedOnly(w, 4, "failed");
		expect(w.released()).toBe(1);
		expect(await w.closes()).toHaveLength(0);
	}, 60000);

	for (const [kind, shape] of KINDS)
		test(`${kind}: returned task: run 4 with no list/close; tasks --phase failed carries resourceReturn returned`, async () => {
			const w = await world(shape, false);
			await settleByA(w, kind, false);
			await w.fleet.result(w.id);
			expect(await w.ret()).toEqual([{ taskId: w.id, state: "returned" }]);
			const closes = (await w.closes()).length;
			await expectReportedOnly(w, 4, "failed");
			expect(await w.closes()).toHaveLength(closes);
			const filtered = await cli(w.dbPath, "tasks", "--phase", "failed");
			expect(filtered.last[0]).toMatchObject({ id: w.id, resourceReturn: { state: "returned" } });
		}, 60000);
});

describe("archived tasks under run / watch / steer", () => {
	test("archived A-settled, returned task: run/run --wait 4 (archived), never claimed or read; watch by id 4 without a read; --all-active ignores it; tasks --phase archived lists it", async () => {
		const w = await world(olderCompleted, false);
		await settleByA(w, "ended_without_receipt", false);
		await w.fleet.result(w.id);
		expect((await w.ret())[0]!.state).toBe("returned");
		expect(await w.fleet.archive(w.id)).toMatchObject({ phase: "archived", held: false });
		await expectReportedOnly(w, 4, "archived");
		await expectWatchIgnores(w);
		const reads = await w.reads();
		const output: any[] = [];
		expect(await watchTasks(w.fleet, { ids: [w.id], interval: 10, maxPolls: 2, emit: (v) => output.push(v), sleep: async () => {} })).toBe(4);
		expect(await w.reads()).toBe(reads);
		expect(w.events("abandoned_poll")).toHaveLength(0);
		const listed = await cli(w.dbPath, "tasks", "--phase", "archived");
		expect(listed.last).toHaveLength(1);
		expect(listed.last[0]).toMatchObject({ id: w.id, phase: "archived", resourceReturn: { state: "returned" } });
		expect(w.released()).toBe(1);
	}, 60000);

	test("steer is not a command (not delivered by the reviewed patch): exit 1, nothing sent to any task", async () => {
		const w = await world(failedMissing, false);
		await settleByA(w, "failed_without_receipt", false);
		const calls = await w.calls();
		const r = await cli(w.dbPath, "steer", w.id, "text");
		expect(r.exit).toBe(1);
		expect(JSON.parse(r.stderr.trim())).toEqual({ ok: false, error: "unknown_command_use_help" });
		expect(await w.calls()).toEqual(calls);
	}, 60000);
});

describe("exit-code table rows are the reviewed rows", () => {
	test("codes, outcomes and aggregation ranks are exactly the reviewed table (0..9)", () => {
		expect(exitCodes.map((r) => [r.code, r.outcome, r.rank])).toEqual([
			[0, "ok", 9], [1, "error", null], [2, "queued", 8], [3, "blocked_unknown", 1], [4, "failed", 3],
			[5, "unavailable", 5], [6, "approval_required", 4], [7, "in_progress", 7], [8, "cancel_unknown", 2], [9, "not_started", 6],
		]);
	});
});
