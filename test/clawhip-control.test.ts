import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClawhipControl, controlBinding, validateControlCommand, type ControlCommand, type ControlExecutor } from "../src/clawhip-control";
import { digest, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";

// Real on-disk Fleet/control SQLite. Execution below is explicitly INJECTED,
// not live GJC, Discord, or an actual Clawhip daemon.
const THREAD = "1569213398762131521";
const roots: string[] = [];
const handles: { close(): void }[] = [];
afterEach(() => {
	for (const handle of handles.splice(0).reverse()) { try { handle.close(); } catch {} }
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-clawhip-control-")));
	roots.push(root);
	const fleetDb = join(root, "fleet.sqlite");
	const dbPath = join(root, "control.sqlite");
	const store = new FleetStore(fleetDb); handles.push(store);
	store.putNode({ id: "node", os: process.platform, arch: process.arch, roots: { repo: root }, workspaceRoot: join(root, "workspaces"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["controlled"], transport: { command: "must-not-execute", args: [] }, operations: ["read", "write"] });
	const fleet = new Fleet(store);
	const task = fleet.submit({ schemaVersion: 1, key: "original-task", caller: "clawhip-test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "Injected execution only", required: { model: "controlled", operations: ["write"] } }, headroom(["node"], 2));
	const policy = { thread: THREAD, fleetDb };
	let control = new ClawhipControl(dbPath, policy, true); handles.push(control);
	const start: ControlCommand = { schema: 1, thread: THREAD, key: "start-1", action: "start", binding: controlBinding(task), testArgv: null };
	let starts = 0, inspections = 0, collections = 0;
	const executor: ControlExecutor = {
		async start(id) {
			starts++;
			store.recordSession(id, "original-session", true);
			store.recordTurn(id, "original-turn");
			const body = { sessionId: "original-session", turnId: "original-turn", status: "active" as const, terminal: false, evidence: { injected: true } };
			return store.observe(id, { ...body, eventId: "injected-start", digest: observationDigest(body) });
		},
		async inspect(id) { inspections++; return { task: store.task(id)! }; },
		async result() { collections++; return { injected: true } as any; },
	};
	function reopen() { control.close(); control = new ClawhipControl(dbPath, policy); handles.push(control); return control; }
	function next(action: "inspect" | "collect", key = action + "-1"): ControlCommand {
		return { schema: 1, thread: THREAD, key, action, binding: control.binding(task.id, store), testArgv: action === "collect" ? [process.execPath, "verify.ts"] : null };
	}
	function enqueue(command = start) { const staged = control.stage(command, store); control.ingest({ command_ref: staged.command_ref }); return staged; }
	function settle() {
		const body = { sessionId: "original-session", turnId: "original-turn", status: "completed_unverified" as const, terminal: true, evidence: { injected: true, settled: true } };
		store.observe(task.id, { ...body, eventId: "injected-terminal", digest: observationDigest(body) });
	}
	return { root, fleetDb, dbPath, policy, store, fleet, task, start, executor, reopen, next, enqueue, settle, get control() { return control; }, counts: () => ({ starts, inspections, collections }) };
}
function sql(path: string, query: string) {
	const db = new Database(path, { readonly: true });
	try { return db.query(query).all(); } finally { db.close(); }
}
async function subprocess(args: string[], input: string) {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/clawhip-control.ts"), ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { LANG: "C", LC_ALL: "C", TZ: "UTC" } });
	child.stdin.write(input);
	child.stdin.end();
	const timer = setTimeout(() => child.kill(), 5000);
	try {
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { stdout, stderr, exit };
	} finally { clearTimeout(timer); }
}

describe("thread-scoped Clawhip control — SQLite and injected executor, NOT live E2E", () => {
	test("ingest is durable and accepts scalar projection without starting execution", () => {
		const f = fixture();
		const staged = f.control.stage(f.start, f.store);
		expect(staged.command_ref).toBe(digest(f.start));
		expect(staged.state).toBe("staged");
		const event = f.control.ingest({ command_ref: staged.command_ref });
		expect(event).toEqual({ type: "fleet.control.accepted", payload: { command_ref: staged.command_ref, message: staged.command_ref } });
		expect(f.counts().starts).toBe(0);
		expect(sql(f.dbPath, "SELECT state FROM commands")).toEqual([{ state: "pending" }]);
		expect(f.reopen().snapshot(f.start.key)?.state).toBe("pending");
		expect(f.store.task(f.task.id)?.sessionId).toBeUndefined();
	});
	test("wrong thread, extra keys, malformed refs and unknown references cannot enqueue", () => {
		const f = fixture();
		expect(() => f.control.stage({ ...f.start, thread: "999" }, f.store)).toThrow("thread");
		for (const value of [{ command_ref: "0".repeat(64), session_id: "bad" }, { command_ref: "0".repeat(64) + "\n" }, { command_ref: "0".repeat(64) }, { command_ref: ["ref"] }]) expect(() => f.control.ingest(value)).toThrow();
		expect(sql(f.dbPath, "SELECT * FROM commands")).toEqual([]);
		expect(sql(f.dbPath, "SELECT * FROM owners")).toEqual([]);
	});
	test("command key digest conflict and alternative-key start are rejected before effects", () => {
		const f = fixture(); f.enqueue();
		expect(() => f.control.stage({ ...f.start, action: "inspect" }, f.store)).toThrow("conflict");
		expect(() => f.control.stage({ ...f.start, key: "start-2" }, f.store)).toThrow("already");
		expect(sql(f.dbPath, "SELECT count(*) AS n FROM commands")).toEqual([{ n: 1 }]);
		expect(f.counts().starts).toBe(0);
	});
	test("duplicate start, concurrent runners and restart never resend", async () => {
		const f = fixture(); f.enqueue();
		const second = new ClawhipControl(f.dbPath, f.policy); handles.push(second);
		const results = await Promise.all([f.control.run(f.start.key, f.store, f.executor, 500), second.run(f.start.key, f.store, f.executor, 500)]);
		expect(results.map(result => result.status).sort()).toEqual(["done", "unknown_no_replay"]);
		expect(f.counts().starts).toBe(1);
		const original = f.control.snapshot(f.start.key);
		f.reopen(); f.enqueue();
		expect<unknown>(await f.control.run(f.start.key, f.store, f.executor, 500)).toEqual(original);
		expect(f.counts().starts).toBe(1);
		expect(f.control.binding(f.task.id, f.store)).toMatchObject({ sessionId: "original-session", turnId: "original-turn" });
	});
	test("staged-but-not-ingested command cannot run", async () => {
		const f = fixture(); f.control.stage(f.start, f.store);
		expect((await f.control.run(f.start.key, f.store, f.executor, 50)).state).toBe("staged");
		expect(f.counts().starts).toBe(0);
	});
	test("inspect binds original task, input digest, attempt, session and turn", async () => {
		const f = fixture(); f.enqueue(); await f.control.run(f.start.key, f.store, f.executor, 500);
		const inspect = f.next("inspect");
		for (const field of ["taskId", "taskKey", "inputDigest", "attemptId", "sessionId", "turnId"] as const) {
			const binding = { ...inspect.binding, [field]: field === "inputDigest" ? "b".repeat(64) : "wrong" };
			expect(() => f.control.stage({ ...inspect, binding }, f.store)).toThrow();
		}
		f.enqueue(inspect);
		const result = await f.control.run(inspect.key, f.store, f.executor, 500);
		expect(result.state).toBe("done");
		expect(f.counts()).toEqual({ starts: 1, inspections: 1, collections: 0 });
	});
	test("exception after delivery retains original identity and allows observation only", async () => {
		const f = fixture(); f.enqueue();
		const executor = { ...f.executor, async start(id: string) { await f.executor.start(id); throw Error("secret=must-not-persist"); } };
		const result = await f.control.run(f.start.key, f.store, executor, 500);
		expect(result.status).toBe("unknown_no_replay");
		expect(JSON.stringify(result)).not.toContain("must-not-persist");
		f.reopen();
		await f.control.run(f.start.key, f.store, f.executor, 500);
		f.settle();
		expect(() => f.control.stage(f.next("collect"), f.store)).toThrow("observation only");
		const inspect = f.next("inspect"); f.enqueue(inspect);
		expect((await f.control.run(inspect.key, f.store, f.executor, 500)).state).toBe("done");
		expect(f.control.snapshot(f.start.key)?.state).toBe("unknown");
		expect(f.counts()).toEqual({ starts: 1, inspections: 1, collections: 0 });
	});
	test("review L-1: a clawhip control command that ends unknown stores only fixed text in the control DB; the Fleet failure behind it carries the diagnostic", async () => {
		const f = fixture(); f.enqueue();
		const columns = sql(f.dbPath, "SELECT name FROM pragma_table_info('commands') ORDER BY cid");
		// The real Fleet: this node has no workspace route, so Fleet.start records blocked_unknown itself.
		const result = await f.control.run(f.start.key, f.store, f.fleet, 500);
		expect(result).toMatchObject({ state: "unknown", status: "unknown_no_replay" });
		const rows = sql(f.dbPath, "SELECT state, receipt, error FROM commands WHERE key='start-1'");
		expect(rows).toEqual([{ state: "unknown", receipt: null, error: "Outcome unknown; replay prohibited, observation only" }]);
		expect(sql(f.dbPath, "SELECT name FROM pragma_table_info('commands') ORDER BY cid")).toEqual(columns);
		expect(JSON.stringify(sql(f.dbPath, "SELECT * FROM commands"))).not.toContain("failureDiagnostic");
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "blocked_unknown", held: true });
		const unknown = f.store.events(f.task.id).findLast((e) => e.kind === "unknown")!;
		expect((unknown.data as any).failureDiagnostic).toEqual({ version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.start.prepare", phase: "precondition", errorClass: "FleetError", code: "fleet:remote_workspace_transport_required", message: "Fleet check refused the step" });
		expect(f.counts().starts).toBe(0);
	});
	test("Fleet returned blocked_unknown is not mistaken for success", async () => {
		const f = fixture(); f.enqueue();
		const result = await f.control.run(f.start.key, f.store, { ...f.executor, async start(id) { return f.store.markUnknown(id, "injected ambiguity"); } }, 500);
		expect(result.state).toBe("unknown");
		expect(f.store.task(f.task.id)).toMatchObject({ held: true, phase: "blocked_unknown" });
		// This uses the REAL Fleet.inspect API: absent execution IDs cause no transport or replay.
		const inspect = f.next("inspect"); f.enqueue(inspect);
		expect((await f.control.run(inspect.key, f.store, f.fleet, 500)).state).toBe("done");
		expect(f.store.task(f.task.id)?.phase).toBe("blocked_unknown");
		expect(f.counts().starts).toBe(0);
	});
	test("bounded timeout ignores late completion and cannot become a retry", async () => {
		const f = fixture(); f.enqueue();
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		let finished!: () => void;
		const done = new Promise<void>(resolve => { finished = resolve; });
		const executor = { ...f.executor, async start(id: string) { await gate; const result = await f.executor.start(id); finished(); return result; } };
		const result = await f.control.run(f.start.key, f.store, executor, 5);
		expect(result.state).toBe("unknown");
		expect(f.counts().starts).toBe(0);
		release(); await done; await Promise.resolve();
		expect(f.control.snapshot(f.start.key)?.state).toBe("unknown");
		await f.control.run(f.start.key, f.store, executor, 100);
		expect(f.counts().starts).toBe(1);
		f.settle(); expect(() => f.control.stage(f.next("collect"), f.store)).toThrow("observation only");
	});
	test("interrupted claimed command survives restart without replay; observation remains possible", async () => {
		const f = fixture(); f.enqueue();
		const db = new Database(f.dbPath);
		db.query("UPDATE commands SET state='claimed' WHERE key=?").run(f.start.key); db.close();
		f.reopen();
		expect((await f.control.run(f.start.key, f.store, f.executor, 100)).status).toBe("unknown_no_replay");
		const inspect = f.next("inspect"); f.enqueue(inspect);
		expect((await f.control.run(inspect.key, f.store, f.fleet, 500)).state).toBe("done");
		expect(f.counts().starts).toBe(0);
		expect(f.control.snapshot(f.start.key)?.state).toBe("claimed");
	});
	test("collect requires authoritative settlement and explicit digest-bound verifier", async () => {
		const f = fixture(); f.enqueue(); await f.control.run(f.start.key, f.store, f.executor, 500);
		expect(() => f.control.stage(f.next("collect"), f.store)).toThrow("observation only");
		f.settle();
		const collect = f.next("collect");
		expect(() => f.control.stage({ ...collect, testArgv: null }, f.store)).toThrow("verifier");
		f.enqueue(collect);
		const receipt = await f.control.run(collect.key, f.store, f.executor, 500);
		expect(receipt.state).toBe("done");
		f.reopen(); expect(await f.control.run(collect.key, f.store, f.executor, 500)).toEqual(receipt);
		expect(() => f.control.stage({ ...collect, testArgv: ["different"] }, f.store)).toThrow("conflict");
		expect(f.counts().collections).toBe(1);
	});
	test("unknown collection blocks other collection keys but not observation", async () => {
		const f = fixture(); f.enqueue(); await f.control.run(f.start.key, f.store, f.executor, 500); f.settle();
		const collect = f.next("collect"); f.enqueue(collect);
		await f.control.run(collect.key, f.store, { ...f.executor, async result() { throw Error("lost"); } }, 500);
		expect(() => f.control.stage(f.next("collect", "collect-2"), f.store)).toThrow("observation only");
		const inspect = f.next("inspect"); f.enqueue(inspect);
		expect((await f.control.run(inspect.key, f.store, f.executor, 500)).state).toBe("done");
	});
	test("wrong policy, symlink database, and accidental reinitialization fail closed", () => {
		const f = fixture();
		expect(() => new ClawhipControl(f.dbPath, { ...f.policy, thread: "999" })).toThrow("policy");
		expect(() => new ClawhipControl(f.dbPath, f.policy, true)).toThrow();
		const alias = join(f.root, "alias.sqlite"); symlinkSync(f.dbPath, alias);
		expect(() => new ClawhipControl(alias, f.policy)).toThrow("Unsafe");
		expect(sql(f.dbPath, "SELECT * FROM commands")).toEqual([]);
	});
	test("validation rejects accessor authority and non-JSON selector tricks", () => {
		const f = fixture();
		const command = { ...f.start };
		Object.defineProperty(command, "key", { get() { throw Error("getter ran"); }, enumerable: true });
		expect(() => validateControlCommand(command, THREAD)).toThrow("Accessors");
		for (const bad of [{ ...f.start, key: "key\n" }, { ...f.start, thread: THREAD, session_id: "unprojected" }, { ...f.start, binding: { ...f.start.binding, sessionId: null, turnId: "turn" } }]) expect(() => validateControlCommand(bad, THREAD)).toThrow();
	});
	test("changed original session at execution is rejected without retargeting", async () => {
		const f = fixture(); f.enqueue(); await f.control.run(f.start.key, f.store, f.executor, 500);
		const inspect = f.next("inspect"); f.enqueue(inspect);
		const task = f.store.task(f.task.id)!;
		const db = new Database(f.fleetDb);
		db.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify({ ...task, sessionId: "replacement-session" }), task.id); db.close();
		await expect(f.control.run(inspect.key, f.store, f.executor, 500)).rejects.toThrow("execution mismatch");
		expect(f.counts().inspections).toBe(0);
		expect(sql(f.dbPath, "SELECT binding FROM owners")).toEqual([{ binding: JSON.stringify(inspect.binding, Object.keys(inspect.binding).sort()) }]);
	});
	test("CLI init and stage persist private authority without dispatch", async () => {
		const f = fixture(); const path = join(f.root, "cli-control.sqlite");
		const args = [path, f.fleetDb, THREAD];
		const initialized = await subprocess(["init", ...args], "");
		expect(initialized.exit).toBe(0);
		const staged = await subprocess(["stage", ...args], JSON.stringify(f.start));
		expect(staged.exit).toBe(0); expect(JSON.parse(staged.stdout).state).toBe("staged");
		const shown = await subprocess(["show", ...args, f.start.key], "");
		expect(shown.exit).toBe(0); expect(JSON.parse(shown.stdout).command_ref).toBe(digest(f.start));
		expect(f.store.task(f.task.id)?.sessionId).toBeUndefined();
	});
	test("CLI binding, stage, ingest, run and show use real Fleet observation without session creation", async () => {
		const f = fixture(); f.enqueue();
		await f.control.run(f.start.key, f.store, { ...f.executor, async start(id) { return f.store.markUnknown(id, "injected pre-session uncertainty"); } }, 500);
		const args = [f.dbPath, f.fleetDb, THREAD];
		const bound = await subprocess(["binding", ...args, f.task.id], "");
		expect(bound.exit).toBe(0);
		const inspect = { ...f.next("inspect"), binding: JSON.parse(bound.stdout) };
		const staged = await subprocess(["stage", ...args], JSON.stringify(inspect));
		expect(staged.exit).toBe(0);
		const ingested = await subprocess(["ingest", ...args], JSON.stringify({ command_ref: JSON.parse(staged.stdout).command_ref }));
		expect(ingested.exit).toBe(0);
		const ran = await subprocess(["run", ...args, inspect.key, "500"], "");
		expect(ran.exit).toBe(0); expect(JSON.parse(ran.stdout)).toMatchObject({ state: "done", receipt: { task: { id: f.task.id, phase: "blocked_unknown" } } });
		const shown = await subprocess(["show", ...args, f.start.key], "");
		expect(shown.exit).toBe(0); expect(JSON.parse(shown.stdout).status).toBe("unknown_no_replay");
		expect(f.store.task(f.task.id)?.sessionId).toBeUndefined();
	});
	test("stored digest tampering cannot cross the subscription ingest gate", () => {
		const f = fixture(); const receipt = f.control.stage(f.start, f.store);
		const db = new Database(f.dbPath);
		db.query("UPDATE commands SET command=?").run(JSON.stringify({ ...f.start, action: "inspect" })); db.close();
		expect(() => f.control.ingest({ command_ref: receipt.command_ref })).toThrow("digest");
		expect(f.control.snapshot(f.start.key)?.state).toBe("staged");
	});
	test("real Bun subprocess obeys Clawhip env-cleared stdin/EOF and single-event stdout contract", async () => {
		const f = fixture(); const staged = f.control.stage(f.start, f.store);
		const result = await subprocess(["ingest", f.dbPath, f.fleetDb, THREAD], JSON.stringify({ command_ref: staged.command_ref }));
		expect(result.exit).toBe(0); expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({ type: "fleet.control.accepted", payload: { command_ref: staged.command_ref, message: staged.command_ref } });
		// subscription.rs RestrictedAdapterEvent denies extra top-level fields and reserved payload keys.
		expect(Object.keys(JSON.parse(result.stdout))).toEqual(["type", "payload"]);
		expect(Object.keys(JSON.parse(result.stdout).payload)).toEqual(["command_ref", "message"]);
		expect(f.reopen().snapshot(f.start.key)?.state).toBe("pending");
		expect(f.store.task(f.task.id)?.sessionId).toBeUndefined();
	});
	test("subprocess rejects oversized/trailing/extra-field input without stdout or reflected secrets", async () => {
		const f = fixture(); const staged = f.control.stage(f.start, f.store);
		for (const input of [JSON.stringify({ command_ref: staged.command_ref, secret: "do-not-echo" }), JSON.stringify({ command_ref: staged.command_ref }) + "{}", "x".repeat(4097)]) {
			const result = await subprocess(["ingest", f.dbPath, f.fleetDb, THREAD], input);
			expect(result.exit).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toBe("Fleet control rejected\n");
		}
		expect(f.control.snapshot(f.start.key)?.state).toBe("staged");
	});
});
