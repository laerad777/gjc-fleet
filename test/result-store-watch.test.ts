// F-1 regression: `watch TASK_ID...`, `watch --all-active`, `run --wait` and the CLI `watch TASK_ID` decide from
// task metadata only (store.taskState). With the result store off (inline rows) and on (externalised rows) they
// load ZERO result bodies, print exactly what the full-record read printed, keep the exit-code table, and keep
// working when a result blob is missing after the one-way step, while an explicit result read (show) still fails
// with RESULT_INTEGRITY.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { exitCodes, operatorExit, runTask, watchTasks, worstExit } from "../src/operator-commands";
import { ResultStore } from "../src/result-store";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

const root = fileURLToPath(new URL("..", import.meta.url));
const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const MARK = "BODY-MARK-";
/** Large distinct bodies (each above EXTERNAL_MIN_BYTES, so externalised as one blob when the switch is on). */
const body = (name: string) => ({ status: "verified", patch: `${MARK}${name}\n`.repeat(40_000) });
type Mode = "off" | "on";
/**
 * U: completed_unverified (execution terminal) with a result; F: failed with a result; both settled by a
 * terminal observation, no inspection needed. Optionally A: a live run via the controlled Coordinator (active,
 * no result), and an sdkTransport that makes the next inspection collect a failed terminal outcome (run --wait).
 */
async function world(mode: Mode, options: { active?: boolean; collect?: boolean; reuse?: boolean } = {}) {
	const f = await repositoryFixture("fleet-watch-");
	dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const config = join(f.dir, "node.json");
	const node: NodeConfig = { id: "controlled", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot: f.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"],
		transport: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url)), state] },
		workspaceTransport: { command: process.execPath, args: [fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url)), config] } };
	await writeFile(config, JSON.stringify(node));
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db);
	stores.push(store);
	if (mode === "on") store.enableResultStore({ actor: "watch-test", reason: "F-1 regression" });
	store.putNode(node);
	const input: TaskInput = { schemaVersion: 1, key: "watch-run", caller: "watch-test", repoId: "fixture", baseCommit: f.baseCommit, prompt: "private prompt", required: {} };
	const settled = (key: string, status: "completed_unverified" | "failed") => {
		const task = store.reserve(store.submit({ ...input, key }).id, headroom([node.id], 10))!;
		store.recordSession(task.id, `session-${key}`);
		store.recordTurn(task.id, `turn-${key}`);
		const observation = { sessionId: `session-${key}`, turnId: `turn-${key}`, status, terminal: true, evidence: { source: `watch-${key}` } };
		store.observe(task.id, { ...observation, eventId: `event-${key}`, digest: observationDigest(observation) });
		store.saveResult(task.id, body(key));
		return task.id;
	};
	const U = settled("U", "completed_unverified");
	const F = settled("F", "failed");
	let A: string | undefined;
	if (options.active) A = (await runTask(new Fleet(store), { ...input, key: "A" }, { sample: async () => headroom([node.id], 10).samples })).task.id;
	let R: string | undefined;
	const file = join(f.dir, "task.json");
	// reuse: the run file names U's caller/key, so `run --wait` resolves the settled U (reported as-is, then watched).
	await writeFile(file, JSON.stringify(options.reuse ? { ...input, key: "U" } : input));
	if (options.collect) {
		const result = { kind: "prompt", commandId: "controlled-runtime-command", turnId: "controlled-runtime-turn", status: "failed", receiptState: "present", terminalAt: 123,
			outcome: { kind: "failed", code: "prompt_failed", provenance: "agent_failed", message: "controlled failure" } };
		store.putNode({ ...node, sdkTransport: { command: process.execPath, args: ["--eval",
			`await new Response(Bun.stdin.stream()).text(); console.log(JSON.stringify({type:'query_response',ok:true,result:${JSON.stringify(result)}}))`, "--"] } });
		R = store.reserve(store.submit(input).id, headroom([node.id], 10))!.id;
		store.recordSession(R, "controlled-session");
		store.recordTurn(R, "controlled-turn");
		await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, "utf8")), session: { session_id: "controlled-session" }, turnId: "controlled-turn", terminal: true }));
	}
	const row = (id: string) => {
		const raw = new Database(db, { readonly: true });
		try {
			return JSON.parse((raw.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string }).data);
		} finally {
			raw.close();
		}
	};
	for (const id of [U, F]) expect(row(id).resultExternal !== undefined).toBe(mode === "on");
	/** Removes exactly the one blob file of a task's externalised result. */
	const loseBlob = (id: string) => {
		const blobs = row(id).resultExternal.blobs as { sha256: string }[];
		expect(blobs).toHaveLength(1);
		rmSync(join(`${db}.results`, blobs[0]!.sha256, "data"));
	};
	return { ...f, db, store, fleet: new Fleet(store), U, F, A, R, file, loseBlob };
}

/**
 * Instrumented read counter over every SQLite connection and the result store: values handed to JS that carry a
 * result body (the body marker in any returned value), result-blob reads and rehydrations. A positive control
 * (show = store.task) proves it sees body reads.
 */
function bodyCounter() {
	const counts = { sqliteBodyValues: 0, sqliteBodyBytes: 0, blobReads: 0, rehydrations: 0 };
	const scan = (value: unknown) => {
		if (value === null || value === undefined) return;
		const text = typeof value === "string" ? value : JSON.stringify(value);
		if (text.includes(MARK)) {
			counts.sqliteBodyValues++;
			counts.sqliteBodyBytes += text.length;
		}
	};
	const wrapped = new WeakSet<object>();
	const wrap = (statement: any) => {
		if (wrapped.has(statement)) return statement;
		wrapped.add(statement);
		for (const method of ["get", "all", "values"]) {
			const original = statement[method];
			statement[method] = (...args: unknown[]) => {
				const value = original.apply(statement, args);
				if (active) scan(value);
				return value;
			};
		}
		const iterate = statement.iterate;
		statement.iterate = function* (...args: unknown[]) {
			for (const row of iterate.apply(statement, args)) {
				if (active) scan(row);
				yield row;
			}
		};
		return statement;
	};
	let active = true;
	const query = Database.prototype.query;
	const prepare = Database.prototype.prepare;
	Database.prototype.query = function (this: Database, ...args: any[]) { return wrap((query as any).apply(this, args)); } as any;
	Database.prototype.prepare = function (this: Database, ...args: any[]) { return wrap((prepare as any).apply(this, args)); } as any;
	const blob = spyOn(ResultStore.prototype as any, "readBlob");
	const rehydrate = spyOn(ResultStore.prototype, "rehydrate");
	return {
		read() {
			return { ...counts, blobReads: blob.mock.calls.length, rehydrations: rehydrate.mock.calls.length };
		},
		/** Uninstalls and returns the final counts (read before mockRestore, which clears the recorded calls). */
		stop() {
			const final = this.read();
			active = false;
			Database.prototype.query = query;
			Database.prototype.prepare = prepare;
			blob.mockRestore();
			rehydrate.mockRestore();
			return final;
		},
	};
}
const zero = { sqliteBodyValues: 0, sqliteBodyBytes: 0, blobReads: 0, rehydrations: 0 };
/** The pre-fix read (store.task: full record, result verified) in place of taskState: the "before" oracle. */
async function asBefore<T>(fn: () => Promise<T>): Promise<T> {
	const proto = FleetStore.prototype as any;
	const original = proto.taskState;
	proto.taskState = proto.task;
	try {
		return await fn();
	} finally {
		proto.taskState = original;
	}
}
async function watch(fleet: Fleet, options: { ids?: string[]; allActive?: boolean; maxPolls?: number }) {
	const lines: string[] = [];
	let exit: number;
	try {
		exit = await watchTasks(fleet, { ...options, interval: 10, maxPolls: options.maxPolls ?? 2, emit: (v) => lines.push(JSON.stringify(v)), sleep: async () => {} });
	} catch (error) {
		return { exit: 1, error: (error as { code?: string }).code ?? String(error), lines };
	}
	return { exit, lines };
}
/**
 * The in-process CLI with stdout captured; errors are returned as exit 1 with their code, as the entry point does.
 * `atFirstLine` snapshots a counter when the first stdout line is printed: for `run --wait` that is the run's own
 * report, printed before the watch starts, so later reads belong to the watch phase.
 */
async function cliRun(argv: string[], counter?: ReturnType<typeof bodyCounter>) {
	const { cli } = await import("../src/cli");
	const lines: string[] = [];
	let atFirstLine: ReturnType<ReturnType<typeof bodyCounter>["read"]> | undefined;
	const log = console.log;
	console.log = (...args: unknown[]) => {
		if (lines.length === 0 && counter) atFirstLine = counter.read();
		lines.push(args.join(" "));
	};
	try {
		return { exit: await cli(argv), lines, atFirstLine };
	} catch (error) {
		return { exit: 1, error: (error as { code?: string }).code ?? (error as Error).message, lines, atFirstLine };
	} finally {
		console.log = log;
	}
}
const minus = (a: typeof zero, b: typeof zero) => Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - (b as any)[k]]));
/** Replaces each distinct UUID (task ids differ between two otherwise identical worlds) by its order of appearance. */
function normalized(lines: string[]): string[] {
	const ids = new Map<string, string>();
	return lines.map((line) => line.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
		if (!ids.has(id)) ids.set(id, `ID${ids.size + 1}`);
		return ids.get(id)!;
	}));
}

for (const mode of ["off", "on"] as const) {
	test(`F-1 (${mode}): watch by id loads zero result bodies, prints exactly the full-read output and keeps the table's codes`, async () => {
		const w = await world(mode);
		const before = await asBefore(() => watch(w.fleet, { ids: [w.U, w.F] }));
		const counter = bodyCounter();
		const after = await watch(w.fleet, { ids: [w.U, w.F] });
		expect(counter.stop()).toEqual(zero);
		expect(after).toEqual(before);
		expect(after.exit).toBe(operatorExit.failed);
		expect(after.exit).toBe(worstExit([operatorExit.ok, operatorExit.failed]));
		expect(after.lines.map((line) => JSON.parse(line))).toEqual([
			{ taskId: w.U, phase: "completed_unverified", nodeId: "controlled", sessionId: "session-U", turnId: "turn-U", executionTerminal: true, held: expect.any(Boolean) },
			{ taskId: w.F, phase: "failed", nodeId: "controlled", sessionId: "session-F", turnId: "turn-F", executionTerminal: true, held: expect.any(Boolean) },
			{ observation: "summary", exit: 4, outcome: "failed", tasks: { [w.U]: 0, [w.F]: 4 } },
		]);
		// Positive control: the same counter sees the body read of an explicit result read (show = task()).
		const control = bodyCounter();
		expect(w.store.task(w.U)!.resultManifest).toEqual(body("U"));
		const seen = control.stop();
		if (mode === "off") expect(seen.sqliteBodyValues).toBeGreaterThan(0);
		else expect(seen.blobReads).toBeGreaterThan(0);
		// And it sees the pre-fix watch read every watched body.
		const old = bodyCounter();
		await asBefore(() => watch(w.fleet, { ids: [w.U, w.F] }));
		const oldCounts = old.stop();
		expect(mode === "off" ? oldCounts.sqliteBodyValues : oldCounts.blobReads).toBeGreaterThanOrEqual(2);
	}, 60_000);

	test(`F-1 (${mode}): watch --all-active loads zero result bodies (inspection of a live run included) and prints exactly the full-read output`, async () => {
		const w = await world(mode, { active: true });
		const before = await asBefore(() => watch(w.fleet, { allActive: true }));
		const counter = bodyCounter();
		const after = await watch(w.fleet, { allActive: true });
		expect(counter.stop()).toEqual(zero);
		expect(after).toEqual(before);
		// U is settled (0); the live run A stays active until the poll limit (5); F is not active, never watched.
		expect(JSON.parse(after.lines.at(-1)!)).toEqual({ observation: "summary", exit: 5, outcome: "unavailable", tasks: { [w.U]: 0, [w.A!]: 5 } });
		expect(after.exit).toBe(worstExit([operatorExit.ok, operatorExit.unavailable]));
		expect(after.lines.map((line) => JSON.parse(line)).filter((v) => v.taskId).map((v) => [v.taskId, v.phase])).toEqual([[w.U, "completed_unverified"], [w.A!, "active"]]);
	}, 60_000);

	test(`F-1 (${mode}): run --wait (real CLI entry, collected terminal outcome) loads zero result bodies and prints exactly the full-read output`, async () => {
		const runWait = async (asOld: boolean) => {
			const w = await world(mode, { collect: true });
			w.store.close();
			stores.splice(stores.indexOf(w.store), 1);
			const counter = bodyCounter();
			const out = asOld ? await asBefore(() => cliRun(["--db", w.db, "run", w.file, "--wait"])) : await cliRun(["--db", w.db, "run", w.file, "--wait"]);
			return { w, out, counts: counter.stop() };
		};
		const before = await runWait(true);
		const after = await runWait(false);
		expect(after.counts).toEqual(zero);
		expect(normalized(after.out.lines)).toEqual(normalized(before.out.lines));
		expect(after.out.exit).toBe(before.out.exit);
		expect(after.out.exit).toBe(operatorExit.failed);
		const lines = after.out.lines.map((line) => JSON.parse(line));
		expect(lines[0]).toMatchObject({ taskId: after.w.R, exit: 0, outcome: "ok", reused: true });
		expect(lines.some((l) => l.taskId === after.w.R && l.phase === "failed" && l.executionTerminal === true)).toBe(true);
		expect(lines.at(-1)).toEqual({ observation: "summary", exit: 4, outcome: "failed", tasks: { [after.w.R!]: 4 } });
	}, 60_000);

	test(`F-1 (${mode}): run --wait of a settled caller/key with a result: its watch phase loads zero result bodies (the pre-fix watch loaded it)`, async () => {
		const runWait = async (asOld: boolean) => {
			const w = await world(mode, { reuse: true });
			w.store.close();
			stores.splice(stores.indexOf(w.store), 1);
			const counter = bodyCounter();
			const argv = ["--db", w.db, "run", w.file, "--wait"];
			const out = asOld ? await asBefore(() => cliRun(argv, counter)) : await cliRun(argv, counter);
			const total = counter.stop();
			return { w, out, total, watchPhase: minus(total, out.atFirstLine!) };
		};
		const before = await runWait(true);
		const after = await runWait(false);
		expect(after.watchPhase).toEqual(zero);
		// The pre-fix watch phase read U's body; the counter sees it.
		expect(mode === "off" ? before.watchPhase.sqliteBodyValues : before.watchPhase.blobReads).toBeGreaterThan(0);
		// The run phase before the first line still reads the reused task's own record (runTask, review I-3, out of
		// this fix's scope); it is reported in the summary line below.
		expect(normalized(after.out.lines)).toEqual(normalized(before.out.lines));
		expect(after.out.exit).toBe(operatorExit.ok);
		expect(after.out.lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ taskId: after.w.U, phase: "completed_unverified", reused: true, exit: 0, outcome: "ok" }),
			{ taskId: after.w.U, phase: "completed_unverified", nodeId: "controlled", sessionId: "session-U", turnId: "turn-U", executionTerminal: true, held: expect.any(Boolean) },
			{ observation: "summary", exit: 0, outcome: "ok", tasks: { [after.w.U]: 0 } },
		]);
		console.log(`RUN-WAIT-REUSE ${mode} ${JSON.stringify({ runPhaseAfter: after.out.atFirstLine, watchPhaseBefore: before.watchPhase, watchPhaseAfter: after.watchPhase })}`);
	}, 60_000);

	test(`F-1 (${mode}): CLI watch TASK_ID reads metadata only and prints the same state line`, async () => {
		const w = await world(mode);
		const strip = (lines: string[]) => lines.map((line) => { const { at, ...rest } = JSON.parse(line); expect(typeof at).toBe("string"); return rest; });
		const before = await asBefore(() => cliRun(["--db", w.db, "watch", w.F]));
		const counter = bodyCounter();
		const after = await cliRun(["--db", w.db, "watch", w.F]);
		expect(counter.stop()).toEqual(zero);
		expect(after.exit).toBe(0);
		expect(strip(after.lines)).toEqual(strip(before.lines));
		expect(strip(after.lines)).toEqual([{ phase: "failed", held: expect.any(Boolean), nodeId: "controlled", turnStatus: null, questions: 0, resultStatus: "failed" }]);
	}, 60_000);
}

test("F-1 (after the one-way step): a missing result blob no longer stops watch; it reports the task state and codes, while show still fails RESULT_INTEGRITY", async () => {
	// Intact reference outputs first.
	const intact = await world("on", { active: true });
	const byId = await watch(intact.fleet, { ids: [intact.U, intact.F] });
	const all = await watch(intact.fleet, { allActive: true });
	const cliWatch = await cliRun(["--db", intact.db, "watch", intact.F]);
	const strip = (lines: string[]) => lines.map((line) => { const { at: _at, ...rest } = JSON.parse(line); return rest; });
	// Exactly one blob file of U removed (and, for the CLI watch of a terminal task, one of F).
	intact.loseBlob(intact.U);
	const fresh = () => {
		const store = new FleetStore(intact.db);
		stores.push(store);
		return new Fleet(store);
	};
	const fleet = fresh();
	expect(() => fleet.store.task(intact.U)).toThrow(expect.objectContaining({ code: "RESULT_INTEGRITY" }));
	// Before the fix every watch of U aborted with exit 1 (RESULT_INTEGRITY).
	expect(await asBefore(() => watch(fleet, { ids: [intact.U, intact.F] }))).toMatchObject({ exit: 1, error: "RESULT_INTEGRITY" });
	expect(await asBefore(() => watch(fleet, { allActive: true }))).toMatchObject({ exit: 1, error: "RESULT_INTEGRITY" });
	const counter = bodyCounter();
	const lostById = await watch(fleet, { ids: [intact.U, intact.F] });
	const lostAll = await watch(fleet, { allActive: true });
	expect(counter.stop()).toEqual(zero);
	expect(lostById).toEqual(byId);
	expect(lostById.exit).toBe(operatorExit.failed);
	expect(JSON.parse(lostById.lines[0]!)).toMatchObject({ taskId: intact.U, phase: "completed_unverified", executionTerminal: true });
	expect(lostAll).toEqual(all);
	expect(lostAll.exit).toBe(operatorExit.unavailable);
	intact.loseBlob(intact.F);
	const lostCli = await cliRun(["--db", intact.db, "watch", intact.F]);
	expect(lostCli.exit).toBe(0);
	expect(strip(lostCli.lines)).toEqual(strip(cliWatch.lines));
	// The explicit result read still fails closed, in-process and through the real CLI process (exit 1).
	expect((await cliRun(["--db", intact.db, "show", intact.U])).error).toBe("RESULT_INTEGRITY");
	for (const id of [intact.U, intact.F]) {
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", intact.db, "show", id], { cwd: root, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ exit, stdout }).toEqual({ exit: 1, stdout: "" });
		expect(JSON.parse(stderr)).toMatchObject({ ok: false, error: "RESULT_INTEGRITY" });
	}
	// The listing and the real CLI watch process keep working too.
	const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", intact.db, "watch", "--all-active", "--interval", "10", "--max-polls", "2"], { cwd: root, stdout: "pipe", stderr: "pipe" });
	const [stdout, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	expect(exit).toBe(operatorExit.unavailable);
	expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toMatchObject({ observation: "summary", exit: 5, tasks: { [intact.U]: 0, [intact.A!]: 5 } });
	expect((await cliRun(["--db", intact.db, "tasks", "--compact"])).exit).toBe(0);
}, 120_000);

test("I-2: show prints an externalised result byte-identically to the same result inline (stable key order)", async () => {
	const w = await world("off");
	const inline = await Promise.all([w.U, w.F].map((id) => cliRun(["--db", w.db, "show", id])));
	w.store.enableResultStore({ actor: "watch-test", reason: "I-2" });
	expect(w.store.migrateResults(true)).toMatchObject({ failed: [] });
	const external = await Promise.all([w.U, w.F].map((id) => cliRun(["--db", w.db, "show", id])));
	expect(w.store.taskListing().filter((e) => [w.U, w.F].includes(e.state.id)).map((e) => e.result?.stored)).toEqual(["external", "external"]);
	expect(external.map((r) => r.exit)).toEqual([0, 0]);
	expect(external.map((r) => r.lines.join("\n"))).toEqual(inline.map((r) => r.lines.join("\n")));
	expect(Object.keys(w.store.task(w.U)!)).toEqual(Object.keys(w.store.task(w.U)!).sort());
});

test("F-1: the exit-code table is unchanged (codes, ranks, outcomes)", () => {
	expect(exitCodes.map((row) => [row.code, row.outcome, row.rank])).toEqual([
		[0, "ok", 9], [1, "error", null], [2, "queued", 8], [3, "blocked_unknown", 1], [4, "failed", 3],
		[5, "unavailable", 5], [6, "approval_required", 4], [7, "in_progress", 7], [8, "cancel_unknown", 2], [9, "not_started", 6],
	]);
});
