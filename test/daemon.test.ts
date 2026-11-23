import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { FleetDaemon, observationKind } from "../src/daemon";
import { reconsiderQueue } from "../src/index";
import { Fleet } from "../src/fleet";
import { DAEMON_LEASE_KEY, FleetStore } from "../src/store";
import { canonicalJson, digest, FleetError, observationDigest } from "../src/core";
import { preflightPlacement } from "../src/placement-preflight";
import { getDashboardState } from "../src/dashboard";
import type { NodeConfig } from "../src/contracts";
import { enableWorkUnits, ROLE_PROMPT_INSTRUCTION } from "../src/work-unit";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";
import { activeOn, fakeBroker, fakeCoordinator, input, node, reserveOn, settledOn } from "./fixtures/daemon";

// Controlled in-process node transports (test/fixtures/daemon.ts); the daemon, Fleet.inspect,
// reconsiderQueue, returnResources and the store are the production code paths.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const CLI = join(import.meta.dir, "../src/cli.ts");

function fixture(nodeIds: string[] = ["node"]) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-daemon-"));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => store.close());
	for (const id of nodeIds) store.putNode(node(id, dir));
	const fleet = new Fleet(store);
	return { dir, path, store, fleet };
}
/** Test timing: every interval scaled down; node budgets off unless a test sets them. */
const fast = { cycleMs: 20, leaseMs: 4000, observeEveryMs: 1, observeMaxEveryMs: 1, backoffMs: 50, backoffMaxMs: 200, nodeGapMs: () => 0, graceMs: 5000, returnPaceMs: 0, returnEveryMs: 50 };
function daemon(fleet: Fleet, options: ConstructorParameters<typeof FleetDaemon>[1] = {}) {
	const d = new FleetDaemon(fleet, { ...fast, sample: async () => ({ ok: false, at: Date.now(), error: "no_sample" }), ...options });
	return d;
}
async function runFor(d: FleetDaemon, ms: number) {
	const done = d.run();
	await Bun.sleep(ms);
	d.stop();
	return done;
}
const raw = (path: string) => new Database(path);
function sql<T>(path: string, query: string, ...args: any[]): T {
	const db = raw(path);
	try { return db.query(query).get(...args) as T; } finally { db.close(); }
}
async function until(check: () => boolean, ms = 10_000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out");
		await Bun.sleep(5);
	}
}
/** spawnSync without the blocked event loop: a live in-process daemon keeps cycling while the child runs. */
async function spawnCli(argv: string[]) {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, exitCode };
}

test("observation eligibility is the daemon's single rule over metadata-only rows", () => {
	const base = { id: "t", phase: "active" as const, nodeId: "n", attemptId: "a", sessionId: "s", turnId: "u", held: true, executionTerminal: false, lateReceipt: false, resultStored: false, workspace: true, sdkTransport: true };
	const now = Date.parse("2026-01-01T12:00:00Z");
	expect(observationKind(base, now)).toBe("poll");
	for (const phase of ["preparing", "dispatching", "approval_required", "completed_unverified"] as const) expect(observationKind({ ...base, phase }, now)).toBe("poll");
	expect(observationKind({ ...base, turnId: undefined }, now)).toBeUndefined();
	expect(observationKind({ ...base, approvalContract: "sdk-ui" }, now)).toBeUndefined();
	expect(observationKind({ ...base, executionTerminal: true, phase: "completed_unverified" }, now)).toBeUndefined();
	expect(observationKind({ ...base, phase: "blocked_unknown", reason: "observation_unavailable_original_attempt_held" }, now)).toBe("poll");
	expect(observationKind({ ...base, phase: "blocked_unknown", reason: "prompt_outcome_unknown" }, now)).toBeUndefined();
	for (const phase of ["queued", "succeeded", "cancelled", "cancel_unknown", "archived"] as const) expect(observationKind({ ...base, phase }, now)).toBeUndefined();
	const settled = { ...base, phase: "failed" as const, executionTerminal: true, settledAt: "2026-01-01T11:00:00Z", lateObservationUntil: "2026-01-02T11:00:00Z" };
	expect(observationKind(settled, now)).toBe("late_receipt");
	expect(observationKind({ ...settled, lateReceipt: true }, now)).toBeUndefined();
	expect(observationKind(settled, Date.parse("2026-01-02T11:00:01Z"))).toBeUndefined();
});

test("fairness: a node at 90 s per call (scaled 1:100 to 900 ms) never delays other nodes; one call per node, one observation per task", async () => {
	const f = fixture(["fast-a", "fast-b", "slow-win"]);
	const ids = { "fast-a": [] as string[], "fast-b": [] as string[], "slow-win": [] as string[] };
	for (const [nodeId, n] of [["fast-a", 5], ["fast-b", 5], ["slow-win", 3]] as const) for (let i = 0; i < n; i++) ids[nodeId].push(activeOn(f.store, nodeId, `${nodeId}-${i}`));
	const stats = fakeCoordinator(f.fleet, (nodeId) => (nodeId === "slow-win" ? 900 : 20));
	const d = daemon(f.fleet);
	const started = Date.now();
	await runFor(d, 3_300);
	const elapsed = Date.now() - started;
	const reads = (nodeId: keyof typeof ids) => ids[nodeId].map((id) => stats.reads.get(`session-${id}`) ?? 0);
	// One in-flight call per node and one observation per task at any time.
	for (const nodeId of Object.keys(ids)) expect(stats.maxNodeConcurrency.get(nodeId)).toBe(1);
	expect(stats.maxTaskConcurrency).toBe(1);
	// Round-robin: every slow-node task observed, never more than once ahead of another.
	const slow = reads("slow-win");
	expect(Math.min(...slow)).toBeGreaterThanOrEqual(1);
	expect(Math.max(...slow) - Math.min(...slow)).toBeLessThanOrEqual(1);
	expect(stats.nodeCalls.get("slow-win")!.length).toBeLessThanOrEqual(Math.ceil(elapsed / 900) + 1);
	// The fast nodes are not held back by the slow node: many observations each, evenly spread.
	for (const nodeId of ["fast-a", "fast-b"] as const) {
		const counts = reads(nodeId);
		expect(Math.min(...counts)).toBeGreaterThanOrEqual(10);
		expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
	}
	expect(stats.other).toEqual([]);
	// Graceful stop let the slow in-flight call finish; nothing left unknown or abandoned.
	for (const id of Object.values(ids).flat()) expect(f.store.task(id)!.phase).toBe("active");
	expect(f.store.daemonStatus()).toBeUndefined();
}, 20_000);

test("per-node budget and backoff: a failing node backs off, its own tasks are not marked unknown, others continue", async () => {
	const f = fixture(["good", "bad"]);
	const good = activeOn(f.store, "good", "g");
	const bad = activeOn(f.store, "bad", "b");
	const badBefore = f.store.task(bad)!;
	const stats = fakeCoordinator(f.fleet, () => 5);
	const connect = (f.fleet as any).connect;
	let badCalls = 0;
	(f.fleet as any).connect = async (n: NodeConfig, required: string[]) => {
		if (n.id === "bad") { badCalls++; throw Object.assign(new Error("ssh: connect timed out"), { code: "ETIMEDOUT" }); }
		return connect(n, required);
	};
	const d = daemon(f.fleet, { backoffMs: 200, backoffMaxMs: 400, nodeGapMs: (n) => (n.id === "good" ? 10 : 0) });
	await runFor(d, 1_000);
	expect(badCalls).toBeGreaterThanOrEqual(2);
	expect(badCalls).toBeLessThanOrEqual(5);
	expect(f.store.task(bad)!.phase).toBe(badBefore.phase);
	expect(f.store.task(bad)!.reason).toBe(badBefore.reason);
	expect(f.store.task(bad)!.held).toBe(true);
	expect(stats.reads.get(`session-${good}`)!).toBeGreaterThan(10);
	// The first read failure is the existing abandoned-poll record; while the node is backed off, every retry is a
	// reachability check that writes nothing (no new poll), so repeated failures flood neither the log nor the store.
	const events = f.store.events(bad).filter((e) => e.kind === "abandoned_poll");
	expect(events.length).toBe(1);
	expect(events.every((e) => (e.data as any).failureDiagnostic)).toBe(true);
}, 10_000);

test("repeated OBSERVATION_UNAVAILABLE stretches the task interval, notes operator recovery once, and never settles or replays", async () => {
	const f = fixture(["node"]);
	const id = activeOn(f.store, "node", "stuck");
	const before = f.store.task(id)!;
	const stats = fakeCoordinator(f.fleet, () => 5);
	const connect = (f.fleet as any).connect;
	(f.fleet as any).connect = async (n: NodeConfig, required: string[]) => {
		const rpc = await connect(n, required);
		const call = rpc.call.bind(rpc);
		rpc.call = async (tool: string, args: unknown) => {
			if (tool === "gjc_coordinator_read_turn") throw Object.assign(new Error("execution lookup refused"), { code: "EXECUTION_QUERY_FAILED" });
			return call(tool, args);
		};
		return rpc;
	};
	const events: { event: string; note?: string }[] = [];
	const d = daemon(f.fleet, {
		observeEveryMs: 20,
		observeMaxEveryMs: 40,
		observeFailureMaxEveryMs: 200,
		backoffMs: 20,
		backoffMaxMs: 40,
		log: (row) => {
			if (row.event === "noted" || row.event === "observation_failed") events.push({ event: String(row.event), note: row.note !== undefined ? String(row.note) : undefined });
		},
	});
	await runFor(d, 900);
	const after = f.store.task(id)!;
	expect(after.phase).toBe(before.phase);
	expect(after.held).toBe(true);
	expect(after.result?.executionTerminal).toBeFalsy();
	expect(after.reason).toBe(before.reason);
	const abandoned = f.store.events(id).filter((e) => e.kind === "abandoned_poll");
	// Without failure stretching, ~900/20 ≈ 45 polls would each abandon; the failure max keeps this far lower.
	expect(abandoned.length).toBeGreaterThanOrEqual(2);
	expect(abandoned.length).toBeLessThan(20);
	expect(f.store.events(id).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual([
		"observation_repeated_failure_operator_recovery_required",
	]);
	expect(events.some((e) => e.event === "noted" && e.note === "observation_repeated_failure_operator_recovery_required")).toBe(true);
	// Observation continues (not permanently stopped): more than the two failures that triggered the note.
	expect(abandoned.length).toBeGreaterThan(2);
	// No prompt/create/send effect from the daemon.
	expect(stats.other).toEqual([]);
}, 10_000);

test("deny-by-default diagnostics: every conversion a daemon run causes carries a valid diagnostic (completeness guard)", async () => {
	const { installDiagnosticGuard } = await import("./diagnostic-guard");
	const guard = installDiagnosticGuard(FleetStore);
	cleanups.push(() => guard.uninstall());
	const f = fixture(["good", "bad"]);
	const [ok, failing] = guard.exempt(() => [activeOn(f.store, "good", "g"), activeOn(f.store, "bad", "b")]);
	const settled = guard.exempt(() => settledOn(f.store, f.dir, "good", "settled"));
	const stats = fakeCoordinator(f.fleet, () => 2);
	const connect = (f.fleet as any).connect;
	(f.fleet as any).connect = async (n: NodeConfig, required: string[]) => {
		if (n.id === "bad") throw Object.assign(new Error("PRIVATE host bad.example: connection refused"), { code: "ECONNREFUSED" });
		return connect(n, required);
	};
	const broker = fakeBroker(f.dir, f.store);
	const port = await broker.connect();
	const d = daemon(f.fleet, { connectReturn: (async () => ({ ...port, list: async () => { throw new Error("PRIVATE listing failure"); } })) as any, returnRetries: 1 });
	await runFor(d, 700);
	const { events } = guard.take();
	expect(guard.allViolations).toEqual([]);
	expect(events.map((e) => e.event)).toContain("abandoned_poll");
	expect(events.map((e) => e.event)).toContain("resource_return_unknown");
	expect(stats.reads.get(`session-${ok}`)!).toBeGreaterThan(1);
	expect(f.store.task(failing)!.held).toBe(true);
	// Bounded automatic return retries (listing only), then the reason is noted once for the operator.
	const unknowns = f.store.events(settled).filter((e) => e.kind === "resource_return_unknown");
	expect(unknowns.length).toBe(2);
	expect(f.store.events(settled).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual(["return_needs_operator_retries_exhausted"]);
	expect(JSON.stringify(f.store.events(settled))).not.toContain("PRIVATE");
}, 10_000);

test("F1: a queue pass reserves nothing (capacity-1 node): the operator's next admission is admitted and queue reconsider still sees the task", async () => {
	const repo = await repositoryFixture("fleet-daemon-queue-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const db = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(db);
	cleanups.push(() => store.close());
	const state = join(repo.dir, "coordinator.json");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	const n: NodeConfig = { id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
	store.putNode(n);
	const fleet = new Fleet(store, { localNodeId: n.id });
	const task = (key: string) => ({ schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: key, required: {} });
	// Headroom for exactly one task.
	const one = () => {
		const s = headroom([n.id], 1).samples.get(n.id)!;
		s.disks![0]!.path = repo.workspaceRoot;
		return s;
	};
	const queued = fleet.submit(task("queued") as any, { samples: new Map() });
	expect(queued.phase).toBe("queued");
	let samples = 0;
	const d = new FleetDaemon(fleet, { ...fast, localNodeId: n.id, sample: async () => { samples++; return one(); } });
	d.acquire();
	// run() after stop() drains in-flight calls; the store must close only after they finish.
	cleanups.push(async () => { d.stop(); await d.run().catch(() => {}); try { store.releaseDaemonLease(d.owner); } catch {} });
	await d.cycle();
	await until(() => (d.status() as any).queue.lastPassAt !== null, 20_000);
	expect(samples).toBeGreaterThanOrEqual(1);
	// Re-checked and published, never reserved: no attempt, no held charge, nothing sent or prepared.
	expect(store.task(queued.id)).toMatchObject({ phase: "queued", held: false });
	expect(store.task(queued.id)!.attemptId).toBeUndefined();
	expect((d.status() as any).queue.admissible).toEqual([{ taskId: queued.id, nodeId: "local", checkedAt: expect.any(String) }]);
	const names = JSON.parse(readFileSync(state, "utf8")).calls.map((c: any) => c.name);
	expect(names).not.toContain("gjc_coordinator_start_session");
	expect(names).not.toContain("gjc_coordinator_send_prompt");
	expect(store.getOperation(queued.id, "prepare")).toBeUndefined();
	await d.cycle();
	expect((d.status() as any).backlog).toMatchObject({ queued: 1, awaitingStart: 0 });
	// The capacity is still free: an operator admission on the same measurement is admitted (as without a daemon).
	const second = fleet.submit(task("second") as any, { samples: new Map([[n.id, one()]]) });
	expect(second.attemptId).toBeTruthy();
	expect(second.held).toBe(true);
	// And the daemon-checked task is still a `queue reconsider` candidate (now refused only for capacity).
	const reconsidered = await reconsiderQueue(fleet, async () => new Map([[n.id, one()]]), { localNodeId: n.id });
	expect(reconsidered.map((t) => t.id)).toEqual([queued.id]);
	expect(store.task(queued.id)).toMatchObject({ phase: "queued", held: false });
}, 30_000);

test("review F1 (work units on): a queue pass checks a queued role task ahead of a role-less one; neither fails the pass", async () => {
	const repo = await repositoryFixture("fleet-daemon-role-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	const state = join(repo.dir, "coordinator.json");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	const n: NodeConfig = { id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
	store.putNode(n);
	const fleet = new Fleet(store, { localNodeId: n.id });
	enableWorkUnits(store, { actor: "operator", reason: "daemon role task" });
	const task = (key: string, extra: object = {}) => ({ schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: key, required: {}, ...extra });
	const role = fleet.submit(task("role", { prompt: "Report on the change. " + ROLE_PROMPT_INSTRUCTION, workUnit: { role: "report" } }) as any, { samples: new Map() });
	const plain = fleet.submit(task("plain") as any, { samples: new Map() });
	expect([role.phase, plain.phase]).toEqual(["queued", "queued"]);
	const d = new FleetDaemon(fleet, { ...fast, localNodeId: n.id, sample: async () => {
		const s = headroom([n.id], 2).samples.get(n.id)!;
		s.disks![0]!.path = repo.workspaceRoot;
		return s;
	} });
	d.acquire();
	cleanups.push(() => { try { store.releaseDaemonLease(d.owner); } catch {} });
	await d.cycle();
	await until(() => (d.status() as any).queue.lastPassAt !== null, 20_000);
	const queue = (d.status() as any).queue;
	expect(queue.lastError).toBeNull();
	expect(queue.admissible.map((a: any) => a.taskId).sort()).toEqual([role.id, plain.id].sort());
	// Read-only: neither task is reserved.
	for (const id of [role.id, plain.id]) expect([store.task(id)!.phase, store.task(id)!.attemptId]).toEqual(["queued", undefined]);
}, 30_000);

test("a queued task no node can admit is deferred without any node call, with bounded backoff", async () => {
	const f = fixture(["n1"]);
	const q = f.fleet.submit(input("q") as any, { samples: new Map() });
	let sampled = 0;
	const eventsBefore = f.store.events(q.id).length;
	const d = daemon(f.fleet, { queueMaxBackoffMs: 100, sample: async () => { sampled++; return { ok: false, at: Date.now(), error: "unreachable" }; } });
	await runFor(d, 600);
	expect(f.store.task(q.id)!.phase).toBe("queued");
	expect(f.store.task(q.id)!.attemptId).toBeUndefined();
	// cycle 20 ms over 600 ms would be ~30 passes without the deferral; backoff 20,40,80,100,100,...
	expect(sampled).toBeGreaterThanOrEqual(2);
	expect(sampled).toBeLessThanOrEqual(10);
	// No selection record per pass: the store does not grow while the task waits.
	expect(f.store.events(q.id)).toHaveLength(eventsBefore);
});

test("second daemon is refused (in-process and CLI); status shows the owner; a dead holder on this host is taken over at once", async () => {
	const f = fixture(["n1"]);
	activeOn(f.store, "n1", "a");
	fakeCoordinator(f.fleet, () => 1);
	const first = daemon(f.fleet);
	const running = first.run();
	await until(() => (f.store.daemonStatus()?.status as any)?.nodes?.[0]?.lastSuccessAt != null);
	const other = new FleetStore(f.path);
	cleanups.push(() => other.close());
	expect(() => daemon(new Fleet(other)).acquire()).toThrow("Another daemon holds the owner lease");
	const cli = await spawnCli([process.execPath, CLI, "--db", f.path, "daemon", "run", "--cycle-ms", "20", "--lease-ms", "4000"]);
	expect(cli.exitCode).toBe(1);
	expect(JSON.parse(cli.stderr)).toEqual({ ok: false, error: "DAEMON_RUNNING" });
	const status = await spawnCli([process.execPath, CLI, "--db", f.path, "--read-only", "daemon", "status"]);
	expect(status.exitCode).toBe(0);
	const shown = JSON.parse(status.stdout);
	expect(shown).toMatchObject({ ok: true, running: true, daemon: { alive: true, owner: first.owner, pid: process.pid, host: hostname() } });
	expect(shown.daemon.status.lastCycleAt).toEqual(expect.any(String));
	expect(shown.daemon.status.nodes[0]).toMatchObject({ id: "n1", lastSuccessAt: expect.any(String), backlog: { observable: 1 } });
	// observability and the dashboard state carry the same daemon view.
	expect(f.store.observability()).toMatchObject({ daemon: { alive: true, owner: first.owner } });
	expect(getDashboardState(f.store).daemon).toMatchObject({ alive: true, owner: first.owner });
	first.stop();
	await running;
	// Graceful stop removed the row: no daemon, CLI status exit 3, observability without the key.
	expect(f.store.daemonStatus()).toBeUndefined();
	expect(f.store.observability()).not.toHaveProperty("daemon");
	expect(getDashboardState(f.store)).not.toHaveProperty("daemon");
	expect((await spawnCli([process.execPath, CLI, "--db", f.path, "--read-only", "daemon", "status"])).exitCode).toBe(10);
	// A crashed holder on this host (dead pid, unexpired lease) is replaced at once.
	const dead = await spawnCli([process.execPath, "--eval", "console.log(process.pid)"]);
	const deadPid = Number(dead.stdout.trim());
	expect(f.store.claimDaemonLease({ owner: "crashed", pid: deadPid, host: hostname(), startedAt: new Date().toISOString() }, 600_000)).toBe(true);
	const successor = daemon(f.fleet);
	successor.acquire();
	expect(f.store.daemonStatus()).toMatchObject({ owner: successor.owner, alive: true });
	expect(f.store.releaseDaemonLease(successor.owner)).toBe(true);
	// A live holder on another host is never replaced before its lease expires.
	expect(f.store.claimDaemonLease({ owner: "remote", pid: 1, host: "other-host.invalid", startedAt: new Date().toISOString() }, 600_000)).toBe(true);
	expect(() => daemon(f.fleet).acquire()).toThrow("Another daemon holds the owner lease");
}, 30_000);

test("lease expiry and takeover with an in-flight close: the successor never resends; the old owner stops calling", async () => {
	const f = fixture(["n1"]);
	const id = settledOn(f.store, f.dir, "n1", "settled");
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const broker = fakeBroker(f.dir, f.store, { hold });
	const old = daemon(f.fleet, { connectReturn: broker.connect as any, takeoverQuietMs: 0 });
	// Settled as soon as it happens (the old owner may notice the lost lease at any point below).
	const oldRun = old.run().then(() => "stopped", (e) => e.code);
	await until(() => broker.stats.closes === 1);
	// The old owner is frozen inside the close (e.g. a 90 s Windows call) and its leases expire.
	const db = raw(f.path);
	db.query("UPDATE resource_return_leases SET expires=0").run();
	db.close();
	const store2 = new FleetStore(f.path);
	cleanups.push(() => store2.close());
	const successor = daemon(new Fleet(store2), { connectReturn: fakeBroker(f.dir, store2).connect as any, takeoverQuietMs: 50 });
	const logs: any[] = [];
	(successor as any).options.log = (e: any) => logs.push(e);
	const newRun = successor.run();
	await until(() => store2.events(id).some((e) => e.kind === "daemon_note"));
	expect(logs.find((e) => e.event === "lease_taken_over")).toMatchObject({ holderProvablyDead: false });
	// The unanswered close is never sent again: the successor only notes that the operator must decide.
	expect(store2.events(id).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual(["return_needs_operator_after_close_unanswered"]);
	expect(readFileSync(broker.log, "utf8").trim().split("\n")).toHaveLength(1);
	// The old owner learns it lost the lease and stops; its in-flight close completes once.
	expect(await oldRun).toBe("DAEMON_LEASE_LOST");
	release();
	await until(() => f.store.getOperation(id, "resource-return-close:1")?.receipt !== undefined);
	await Bun.sleep(200);
	successor.stop();
	await newRun;
	expect(readFileSync(broker.log, "utf8").trim().split("\n")).toHaveLength(1);
	expect(f.store.getOperation(id, "resource-return-close:2")).toBeUndefined();
	// The old pass recorded its close; the session was observed gone afterwards: returned exactly once.
	expect(f.store.getOperation(id, "resource-return-confirmed")).toBeDefined();
}, 30_000);

test("after settle, return runs where the rules allow; otherwise the reason is recorded once", async () => {
	const f = fixture(["n1"]);
	const ok = settledOn(f.store, f.dir, "n1", "returnable");
	const noCustody = activeOn(f.store, "n1", "x");
	// Settled but result never collected: the daemon waits (collection is the operator's).
	const body = { sessionId: `session-${noCustody}`, turnId: `turn-${noCustody}`, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	f.store.observe(noCustody, { eventId: "t", digest: observationDigest(body), ...body });
	const broker = fakeBroker(f.dir, f.store);
	const d = daemon(f.fleet, { connectReturn: broker.connect as any });
	await runFor(d, 800);
	expect(f.store.getOperation(ok, "resource-return-confirmed")).toBeDefined();
	expect(f.store.task(ok)!.held).toBe(false);
	expect(broker.stats.closes).toBe(1);
	const notes = f.store.events(noCustody).filter((e) => e.kind === "daemon_note");
	expect(notes.map((e) => (e.data as any).note)).toEqual(["return_awaits_result_collection"]);
	// A second daemon process does not repeat the note either.
	await runFor(daemon(f.fleet, { connectReturn: broker.connect as any }), 300);
	expect(f.store.events(noCustody).filter((e) => e.kind === "daemon_note")).toHaveLength(1);
	expect(broker.stats.closes).toBe(1);
}, 10_000);

test("kill between every pair of writes leaves a consistent store; a restarted daemon finishes without any resend", async () => {
	const repo = await repositoryFixture("fleet-daemon-kill-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const template = join(repo.dir, "template.sqlite");
	{
		const store = new FleetStore(template);
		const n: NodeConfig = { ...node("n1", repo.dir), roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), join(repo.dir, "coordinator.json")] } };
		writeFileSync(join(repo.dir, "coordinator.json"), JSON.stringify({ calls: [] }));
		store.putNode(n);
		const fleet = new Fleet(store, { localNodeId: "n1" });
		fleet.submit({ schemaVersion: 1, key: "queued", caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Queued", required: {} }, { samples: new Map() });
		activeOn(store, "n1", "active");
		settledOn(store, repo.dir, "n1", "settled");
		store.close();
	}
	const child = join(import.meta.dir, "fixtures/daemon-child.ts");
	let kills = 0;
	let total = -1;
	for (let killAt = 1; total < 0; killAt++) {
		const run = join(repo.dir, `run-${killAt}`);
		rmSync(run, { recursive: true, force: true });
		mkdirSync(run, { recursive: true });
		const db = join(run, "fleet.sqlite");
		copyFileSync(template, db);
		const first = Bun.spawnSync([process.execPath, child, db, run, String(killAt), repo.workspaceRoot], { stdout: "pipe", stderr: "pipe" });
		if (first.exitCode === 0) { total = JSON.parse(first.stdout.toString().trim().split("\n").at(-1)!).commits; break; }
		// Ended at the kill point (marker printed right before the kill), whatever the platform reports.
		expect(first.exitCode).not.toBe(0);
		expect(JSON.parse(first.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ killedAt: killAt });
		kills++;
		// Consistency at the kill point: SQLite integrity, every row decodes, format unchanged.
		const check = raw(db);
		try {
			expect(check.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
			expect((check.query("PRAGMA user_version").get() as any).user_version).toBe(2);
			expect((check.query("SELECT count(*) n FROM operations WHERE kind LIKE 'resource-return-close:%' GROUP BY attempt_id ORDER BY n DESC LIMIT 1").get() as any)?.n ?? 0).toBeLessThanOrEqual(1);
		} finally { check.close(); }
		const reopened = new FleetStore(db);
		try {
			for (const t of reopened.tasks()) expect(t.phase).not.toBe("blocked_unknown");
			expect(reopened.daemonStatus()?.pid ?? 0).not.toBe(process.pid);
		} finally { reopened.close(); }
		// A crash inside a return pass leaves its 120 s node pacing lease (existing behaviour: the successor
		// reports node_busy until it expires). Let that time pass; the daemon lease itself is left as it was.
		const pacing = raw(db);
		try { pacing.query("UPDATE resource_return_leases SET expires=0 WHERE node_id<>?").run(DAEMON_LEASE_KEY); } finally { pacing.close(); }
		// Restart (the crashed holder's pid is dead on this host: immediate takeover) and finish.
		const second = Bun.spawnSync([process.execPath, child, db, run, "0", repo.workspaceRoot], { stdout: "pipe", stderr: "pipe" });
		expect(second.stderr.toString()).not.toContain("error:");
		expect(second.exitCode).toBe(0);
		const closes = existsSync(join(run, "closes.log")) ? readFileSync(join(run, "closes.log"), "utf8").trim().split("\n").filter(Boolean) : [];
		const final = new FleetStore(db);
		try {
			const tasks = final.tasks();
			const settled = tasks.find((t) => t.input.key === "settled")!;
			const close = final.getOperation(settled.id, "resource-return-close:1");
			// Never a resend: at most one close was sent, and only for a durable claim.
			expect(closes.length).toBeLessThanOrEqual(1);
			if (closes.length) expect(close).toBeDefined();
			// A close sent but unanswered at the kill stays unknown (operator), never re-sent.
			if (close && close.receipt === undefined) expect(final.events(settled.id).some((e) => e.kind === "daemon_note")).toBe(true);
			else expect(final.getOperation(settled.id, "resource-return-confirmed")).toBeDefined();
			// Never reserved by the daemon: still queued, unattempted, holding nothing.
			expect(tasks.find((t) => t.input.key === "queued")).toMatchObject({ phase: "queued", held: false });
			expect(tasks.find((t) => t.input.key === "queued")!.attemptId).toBeUndefined();
			expect(final.daemonStatus()).toBeUndefined();
		} finally { final.close(); }
	}
	// Every write point of a full run was a kill point once (renewal timing may add a few writes).
	expect(total).toBeGreaterThan(5);
	expect(kills).toBeGreaterThanOrEqual(total - 3);
	console.log("DAEMON_KILL_POINTS " + JSON.stringify({ kills, commitsOfFullRun: total }));
}, 600_000);

test("300 tasks with 8 MB rows: metadata-only scheduling, bounded memory and time", async () => {
	// Process RSS is the whole bun process. In the suite this file has already run other tests, and
	// the peak then sits on the 400 MiB line (ubuntu CI: 407.36 and, before the openat commits, 408.03)
	// even though a fresh process stays under it. Measure this scheduler alone; the bound is unchanged.
	if (process.env.FLEET_RSS_ISOLATED !== "1") {
		const child = Bun.spawnSync([
			process.execPath, "test", "test/daemon.test.ts", "-t", "300 tasks with 8 MB rows",
		], {
			cwd: process.cwd(),
			env: { ...process.env, FLEET_RSS_ISOLATED: "1" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 240_000,
		});
		const out = child.stdout.toString() + child.stderr.toString();
		if (child.exitCode !== 0) throw new Error(out);
		const measured = out.split("\n").find(line => line.includes("DAEMON_MEASUREMENT"));
		if (!measured) throw new Error(out);
		console.log(measured);
		return;
	}
	const f = fixture(["n1", "n2", "n3"]);
	const big = "x".repeat(8 * 1024 * 1024);
	const ids: string[] = [];
	// Small rows first: every reservation scans all task states (existing behaviour), which is slow once
	// 8 MB rows exist; the large rows are then written as their final shape directly.
	const small: string[] = [];
	const padded: string[] = [];
	for (let i = 0; i < 10; i++) padded.push(activeOn(f.store, `n${(i % 3) + 1}`, `big-evidence-${i}`));
	for (let i = 0; i < 150; i++) small.push(activeOn(f.store, `n${(i % 3) + 1}`, `small-${i}`));
	const queued: string[] = [];
	for (let i = 0; i < 40; i++) queued.push(f.fleet.submit(input(`queued-${i}`) as any, { samples: new Map() }).id);
	// 100 settled rows each carrying an 8 MB inline result, 10 active rows each carrying 8 MB of earlier
	// observation evidence (~0.9 GB of rows; the DB stays under ~1 GB) and 190 small active/queued rows.
	const db = raw(f.path);
	for (let i = 0; i < 100; i++) {
		const t = f.store.submit(input(`big-result-${i}`) as any);
		db.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...t, phase: "succeeded", result: { status: "succeeded", executionTerminal: true, evidence: {} }, resultManifest: { patch: big } } as any), t.id);
		ids.push(t.id);
	}
	for (const id of padded) {
		db.query("UPDATE tasks SET data=json_set(data,'$.result',json_object('status','active','executionTerminal',json('false'),'evidence',json_object('pad',?))) WHERE id=?").run(big, id);
		ids.push(id);
	}
	db.close();
	ids.push(...small, ...queued);
	expect(ids).toHaveLength(300);
	const dbBytes = statSync(f.path).size;
	expect(dbBytes).toBeLessThan(1.05 * 1024 ** 3);
	const stats = fakeCoordinator(f.fleet, () => 2);
	// Record only the ids passed to store.task. A spy would also keep every returned task, and the
	// observed 8 MB rows would stay reachable until the test ends, inflating the RSS peak.
	const readIds = new Set<string>();
	const taskOwn = Object.prototype.hasOwnProperty.call(f.store, "task");
	const taskOriginal = f.store.task;
	f.store.task = function (this: unknown, ...args: Parameters<FleetStore["task"]>): ReturnType<FleetStore["task"]> {
		readIds.add(args[0]);
		return taskOriginal.apply(this, args);
	} as FleetStore["task"];
	let sampler: ReturnType<typeof setInterval> | undefined;
	let running: Promise<unknown> | undefined;
	let rssBefore = 0;
	let rssPeak = 0;
	const cycleTimes: number[] = [];
	let allObservedMs = 0;
	const d = daemon(f.fleet);
	try {
		Bun.gc(true);
		rssBefore = process.memoryUsage().rss;
		rssPeak = rssBefore;
		sampler = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 5);
		d.acquire();
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			await d.cycle();
			cycleTimes.push(performance.now() - t0);
		}
		const t0 = performance.now();
		running = d.run();
		await until(() => ids.slice(100).every((id, i) => i >= 160 || (stats.reads.get(`session-${id}`) ?? 0) >= 1), 60_000);
		allObservedMs = performance.now() - t0;
		d.stop();
		await running; // a lost lease rejects here and fails the test, as before
	} finally {
		d.stop();
		if (running) await running.catch(() => undefined);
		if (sampler) clearInterval(sampler);
		if (taskOwn) f.store.task = taskOriginal;
		else delete (f.store as { task?: unknown }).task;
	}
	// The scheduler never materialised a row: Fleet.inspect's own reads are only of observed tasks.
	for (const id of ids.slice(0, 100)) expect(readIds.has(id)).toBe(false);
	for (const id of ids.slice(260)) expect(readIds.has(id)).toBe(false);
	// Keep the metadata-only intent: typical cycles stay under the old 2s bound. A single
	// hosted-runner spike among the five samples is tolerated; a hard ceiling still applies.
	const sortedCycles = [...cycleTimes].sort((a, b) => a - b);
	const measured = { dbBytes, cycleMsMax: sortedCycles[sortedCycles.length - 1]!, cycleMsMedian: sortedCycles[2]!, allObservedMs, rssBeforeMiB: rssBefore / 2 ** 20, rssPeakDeltaMiB: (rssPeak - rssBefore) / 2 ** 20, observations: [...stats.reads.values()].reduce((a, b) => a + b, 0) };
	console.log("DAEMON_MEASUREMENT " + JSON.stringify(measured));
	expect(stats.maxTaskConcurrency).toBe(1);
	expect(measured.cycleMsMedian).toBeLessThan(2_000);
	expect(cycleTimes.filter((t) => t >= 2_000).length).toBeLessThanOrEqual(1);
	expect(measured.cycleMsMax).toBeLessThan(10_000);
	expect(measured.rssPeakDeltaMiB).toBeLessThan(400);
}, 300_000);

test("old-version rows and an old database: read-only status changes nothing; the daemon observes legacy rows", async () => {
	const f = fixture(["n1"]);
	const id = activeOn(f.store, "n1", "legacy");
	// A row as an older build wrote it: no poll counters, no node os/sdkTransport snapshot fields.
	const row = JSON.parse(sql<{ data: string }>(f.path, "SELECT data FROM tasks WHERE id=?", id).data);
	delete row.pollIssued; delete row.pollApplied; delete row.nodeSnapshot.os; delete row.nodeSnapshot.sdkTransport;
	const db = raw(f.path);
	db.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(row), id);
	db.close();
	f.store.close();
	// A ladder-v1 copy without the lease table.
	const old = join(f.dir, "v1.sqlite");
	copyFileSync(f.path, old);
	const legacy = raw(old);
	legacy.exec(`DROP TABLE resource_return_leases; DROP TRIGGER IF EXISTS archived_phase_fence;ALTER TABLE fleet_meta RENAME TO meta_new;CREATE TABLE fleet_meta(id INTEGER PRIMARY KEY CHECK(id=1),schema_version INTEGER NOT NULL CHECK(schema_version=1),global_cap INTEGER NOT NULL CHECK(global_cap>0));INSERT INTO fleet_meta SELECT id,1,global_cap FROM meta_new;DROP TABLE meta_new;PRAGMA user_version=1;`);
	legacy.close();
	const before = readFileSync(old);
	const status = Bun.spawnSync([process.execPath, CLI, "--db", old, "--read-only", "daemon", "status"], { stdout: "pipe", stderr: "pipe" });
	expect(JSON.parse(status.stdout.toString())).toEqual({ ok: true, running: false, daemon: null });
	expect(status.exitCode).toBe(10);
	expect(readFileSync(old).equals(before)).toBe(true);
	// The writable open is the existing v1 -> v2 upgrade (never v3); the daemon then observes the legacy row.
	const store = new FleetStore(old);
	cleanups.push(() => store.close());
	const fleet = new Fleet(store);
	const stats = fakeCoordinator(fleet, () => 1);
	await runFor(daemon(fleet), 300);
	expect(stats.reads.get(`session-${id}`)!).toBeGreaterThanOrEqual(1);
	expect(store.task(id)!.phase).toBe("active");
	expect(sql<any>(old, "PRAGMA user_version").user_version).toBe(2);
});

test("externalisation ON at user_version 2: daemon observation, notes and return never externalise a row", async () => {
	const f = fixture(["n1"]);
	f.store.enableResultStore({ actor: "test", reason: "daemon side-effect check" });
	expect(f.store.resultStoreStatus()).toMatchObject({ externalisation: "on", userVersion: 2, oneWayStepTaken: false });
	// Results saved before the switch stay inline (a settled task to return, and an active one to observe).
	f.store.disableResultStore({ actor: "test", reason: "seed inline rows" });
	const settled = settledOn(f.store, f.dir, "n1", "inline");
	f.store.enableResultStore({ actor: "test", reason: "daemon side-effect check" });
	const active = activeOn(f.store, "n1", "active");
	const stats = fakeCoordinator(f.fleet, () => 1);
	const broker = fakeBroker(f.dir, f.store);
	await runFor(daemon(f.fleet, { connectReturn: broker.connect as any }), 600);
	expect(stats.reads.get(`session-${active}`)!).toBeGreaterThanOrEqual(1);
	expect(f.store.getOperation(settled, "resource-return-confirmed")).toBeDefined();
	expect(f.store.resultStoreStatus()).toMatchObject({ userVersion: 2, oneWayStepTaken: false, externalResults: 0 });
	expect(sql<any>(f.path, "SELECT count(*) n FROM audit WHERE kind='result_store_format_step'").n).toBe(0);
});

// A signal from another process terminates a Windows process at once (no handler runs): the graceful stop by
// signal is POSIX-only there (docs/daemon.md, Windows). The Windows stop path is covered by the crash/kill test.
const posixSignals = test.skipIf(process.platform === "win32");
for (const signal of ["SIGTERM", "SIGINT"] as const) posixSignals(`fleet daemon run: ${signal} stops gracefully, releases the lease and exits 0`, async () => {
	const f = fixture([]);
	f.store.close();
	const child = Bun.spawn([process.execPath, CLI, "--db", f.path, "daemon", "run", "--cycle-ms", "20", "--lease-ms", "4000"], { stdout: "pipe", stderr: "pipe" });
	const status = () => Bun.spawnSync([process.execPath, CLI, "--db", f.path, "--read-only", "daemon", "status"], { stdout: "pipe" });
	// Loaded hosts: each status poll spawns a full CLI process, so the daemon's first write can outlast 10 s.
	await until(() => status().exitCode === 0, 30_000);
	child.kill(signal);
	expect(await child.exited).toBe(0);
	const lines = (await new Response(child.stdout).text()).trim().split("\n").map((l) => JSON.parse(l));
	expect(lines[0]).toMatchObject({ event: "started", pid: child.pid });
	expect(lines.at(-1)).toMatchObject({ event: "stopped", abandoned: 0, lostLease: false });
	expect(await new Response(child.stderr).text()).toBe("");
	expect(status().exitCode).toBe(10);
	// Flags are validated; a bad value never starts a daemon.
	const bad = Bun.spawnSync([process.execPath, CLI, "--db", f.path, "daemon", "run", "--cycle-ms", "5"], { stdout: "pipe", stderr: "pipe" });
	expect(bad.exitCode).toBe(1);
	expect(status().exitCode).toBe(10);
}, 60_000);

posixSignals("graceful stop: SIGTERM lets the in-flight call finish, releases the lease, exits 0; status is bounded", async () => {
	const f = fixture(["n1"]);
	activeOn(f.store, "n1", "a");
	f.store.close();
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/daemon-child.ts"), f.path, f.dir, "sigterm", ""], { stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	let out = "";
	while (!out.includes("\"observing\"")) {
		const { value, done } = await reader.read();
		if (done) break;
		out += new TextDecoder().decode(value);
	}
	child.kill("SIGTERM");
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		out += new TextDecoder().decode(value);
	}
	expect(await child.exited).toBe(0);
	const events = out.trim().split("\n").map((l) => JSON.parse(l));
	expect(events.map((e) => e.event)).toContain("stopping");
	expect(events.at(-1)).toMatchObject({ event: "stopped", abandoned: 0, lostLease: false });
	expect(events.find((e) => e.event === "observed")).toMatchObject({ finished: true });
	expect(sql<any>(f.path, "SELECT count(*) n FROM resource_return_leases WHERE node_id=?", DAEMON_LEASE_KEY).n).toBe(0);
	const store = new FleetStore(f.path);
	try { expect(store.tasks()[0]!.phase).toBe("active"); } finally { store.close(); }
}, 30_000);

/**
 * A return connection whose session is the exact recorded incarnation, live, until the first (acknowledged)
 * close; every listing after that close is `after`: unavailable (offline), a foreign incarnation, or unproven.
 */
function postCloseBroker(store: FleetStore, after: "offline" | "foreign" | "unproven") {
	const stats = { lists: 0, closes: 0 };
	let closed = false;
	const row = (sessionId: string) => ({ sessionId, locator: { cwd: (store.getOperation(sessionId.slice("session-".length), "session-authority")?.payload as any)?.cwd }, endpointGeneration: 1, endpointIncarnation: "b".repeat(64), live: true, terminal: false, ambiguous: false, terminalUncertain: false });
	const connect = async () => ({
		list: async (sessionId: string) => {
			stats.lists++;
			if (closed && after === "offline") throw Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
			const session = !closed ? row(sessionId) : after === "foreign" ? { ...row(sessionId), endpointIncarnation: "c".repeat(64) } : { ...row(sessionId), live: false };
			return { type: "broker_response", ok: true, result: { indexSeq: stats.lists, sessions: [session] } };
		},
		stop: async () => { throw new Error("ID-only stop must never be used"); },
		fencedClose: async (authority: any) => {
			stats.closes++;
			closed = true;
			return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
		},
		close() {},
	});
	return { connect, stats };
}
for (const after of ["offline", "foreign", "unproven"] as const) test(`F2: after an acknowledged close, a ${after} listing counts toward the re-list bound; then noted once, never another close`, async () => {
	const f = fixture(["n1"]);
	const id = settledOn(f.store, f.dir, "n1", "settled");
	const broker = postCloseBroker(f.store, after);
	await runFor(daemon(f.fleet, { connectReturn: broker.connect as any, returnRetries: 1, returnEveryMs: 20 }), 1_200);
	// Close pass: listing + close + post-close listing (outcome 1); one re-list (outcome 2 > 1 retry): done.
	expect(broker.stats.closes).toBe(1);
	expect(broker.stats.lists).toBe(3);
	expect(f.store.getOperation(id, "resource-return-close:2")).toBeUndefined();
	expect(f.store.events(id).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual(["return_needs_operator_relists_exhausted_after_close"]);
	expect(f.store.getOperation(id, "resource-return-confirmed")).toBeUndefined();
}, 10_000);

test("F3: unchanged daemon observations write no receipt and no audit row; a change is recorded; poll fencing advances", async () => {
	const f = fixture(["n1"]);
	const id = activeOn(f.store, "n1", "long-lived");
	let status = "active";
	const stats = fakeCoordinator(f.fleet, () => 1, () => status);
	const rows = () => ({
		receipts: sql<any>(f.path, "SELECT count(*) n FROM receipts WHERE task_id=?", id).n as number,
		audit: sql<any>(f.path, "SELECT count(*) n FROM audit WHERE task_id=?", id).n as number,
	});
	const d = daemon(f.fleet);
	const running = d.run();
	cleanups.push(async () => { d.stop(); await running.catch(() => {}); });
	await until(() => (stats.reads.get(`session-${id}`) ?? 0) >= 1);
	await Bun.sleep(20);
	const first = rows();
	await until(() => (stats.reads.get(`session-${id}`) ?? 0) >= 30);
	// 29 more identical observations: neither table grew.
	expect(rows()).toEqual(first);
	const task = f.store.task(id)!;
	expect(task.phase).toBe("active");
	expect(task.pollApplied).toBeGreaterThanOrEqual(29);
	// A changed observation is recorded once (receipt + observation audit), then unchanged again.
	status = "approval_wait";
	const reads = stats.reads.get(`session-${id}`)!;
	await until(() => stats.reads.get(`session-${id}`)! >= reads + 10);
	d.stop();
	await running;
	expect(rows().receipts).toBe(first.receipts + 1);
	expect(sql<any>(f.path, "SELECT count(*) n FROM audit WHERE task_id=? AND kind='observation'", id).n).toBe(first.receipts + 1);
	// The operator's poll path is unchanged: it records every observation.
	const before = rows().receipts;
	await f.fleet.inspect(id);
	await f.fleet.inspect(id);
	expect(rows().receipts).toBe(before + 2);
}, 20_000);

/** A transport that only records its own lifetime in `log` (the probes then fail closed, as unavailable). */
function spanTransport(dir: string, log: string, name: string) {
	const script = join(dir, "span.ts");
	writeFileSync(script, 'import { appendFileSync } from "node:fs";\nconst [log, name] = process.argv.slice(2);\nappendFileSync(log, name + " start " + Date.now() + "\\n");\nawait Bun.sleep(300);\nappendFileSync(log, name + " end " + Date.now() + "\\n");\n');
	return { command: process.execPath, args: [script, log, name] };
}
function preflightNode(dir: string, log: string): NodeConfig {
	return { ...node("n1", dir), transport: spanTransport(dir, log, "coordinator"), workspaceTransport: spanTransport(dir, log, "workspace") } as NodeConfig;
}
test("F4: inside one nodeCall slot the coordinator and workspace probes never overlap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-daemon-probe-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "spans.log");
	let slots = 0;
	const report = await preflightPlacement(input("probe") as any, [preflightNode(dir, log)], [], { samples: new Map(), held: new Map(), now: Date.now() } as any, {
		timeoutMs: 10_000,
		nodeCall: async (_id, probe) => { slots++; return probe(); },
	});
	expect(slots).toBe(1);
	expect(report.nodes[0]!.ready).toBe(false);
	const at = Object.fromEntries(readFileSync(log, "utf8").trim().split("\n").map((l) => { const [name, edge, ms] = l.split(" "); return [`${name}:${edge}`, Number(ms)]; }));
	expect(Object.keys(at).sort()).toEqual(["coordinator:end", "coordinator:start", "workspace:end", "workspace:start"]);
	expect(at["workspace:start"]!).toBeGreaterThanOrEqual(at["coordinator:end"]!);
}, 30_000);

test("F6: only a typed NODE_BUSY gate refusal becomes probe_deferred_node_busy; any other probe failure propagates", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-daemon-probe-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const n = preflightNode(dir, join(dir, "spans.log"));
	const admission = { samples: new Map(), held: new Map(), now: Date.now() } as any;
	const busy = await preflightPlacement(input("probe") as any, [n], [], admission, { nodeCall: async () => { throw new FleetError("NODE_BUSY", "gate held"); } });
	expect(busy.nodes[0]!.checks.coordinator.code).toBe("probe_deferred_node_busy");
	await expect(preflightPlacement(input("probe") as any, [n], [], admission, { nodeCall: async () => { throw new Error("probe internals failed"); } })).rejects.toThrow("probe internals failed");
	await expect(preflightPlacement(input("probe") as any, [n], [], admission, { nodeCall: async () => { throw new FleetError("OPERATION_UNAVAILABLE", "other refusal"); } })).rejects.toThrow("other refusal");
}, 30_000);

test("F7/M03: a queue pass never measures a node while an observation call on it is in flight", async () => {
	const f = fixture(["n1"]);
	activeOn(f.store, "n1", "slow");
	f.fleet.submit(input("q") as any, { samples: new Map() });
	const stats = fakeCoordinator(f.fleet, () => 150);
	const sampled: { start: number; end: number }[] = [];
	const d = daemon(f.fleet, { queueMaxBackoffMs: 20, sample: async () => {
		const start = Date.now();
		await Bun.sleep(30);
		sampled.push({ start, end: Date.now() });
		return { ok: false, at: Date.now(), error: "unreachable" };
	} });
	await runFor(d, 1_500);
	const observed = stats.nodeCalls.get("n1")!;
	expect(observed.length).toBeGreaterThanOrEqual(3);
	expect(sampled.length).toBeGreaterThanOrEqual(3);
	for (const s of sampled) for (const o of observed) expect(s.end <= o.start || s.start >= o.end).toBe(true);
}, 10_000);

test("daemon injected clock: owner-lease persistence and renewal use the scheduler clock; expiry still fails closed", async () => {
	const f = fixture([]);
	// A deliberately old epoch catches accidentally using Date.now() in persistence.
	let now = Date.parse("2026-01-01T00:00:00Z");
	const d = daemon(f.fleet, { now: () => now });
	d.acquire();
	expect(f.store.daemonLease()!.expires).toBe(now + fast.leaseMs);
	now += 100;
	d.stop();
	await d.run();
	expect(f.store.daemonLease()).toBeNull();
	const expired = daemon(f.fleet, { now: () => now });
	expired.acquire();
	now += fast.leaseMs;
	expired.stop();
	await expect(expired.run()).rejects.toMatchObject({ code: "DAEMON_LEASE_LOST" });
	// An expired row is not silently reacquired or renewed by its old owner.
	expect(f.store.daemonLease()!.expires).toBe(now);
}, 10_000);

test("F7/M05: after taking over an expired lease of a possibly live holder, no node call starts during the quiet period", async () => {
	const f = fixture(["n1"]);
	activeOn(f.store, "n1", "a");
	let now = Date.now();
	const clock = () => now;
	expect(f.store.claimDaemonLease({ owner: "remote", pid: 1, host: "other-host.invalid", startedAt: new Date(now).toISOString() }, 1_000, undefined, clock)).toBe(true);
	now += 1_100;
	const starts: number[] = [];
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	// Hold the first observation so no background lane pump can affect the boundary assertions.
	f.fleet.inspect = async () => {
		starts.push(now);
		await held;
		throw new FleetError("OBSERVATION_UNAVAILABLE", "test observation released");
	};
	const d = daemon(f.fleet, { takeoverQuietMs: 500, now: clock });
	d.acquire();
	const tookOver = now;
	try {
		await d.cycle();
		expect(starts).toEqual([]);
		now = tookOver + 499;
		await d.cycle();
		expect(starts).toEqual([]);
		now = tookOver + 500;
		await d.cycle();
		expect(starts).toEqual([tookOver + 500]);
	} finally {
		d.stop();
		release();
		// run() also drains calls and releases the lease when already stopped.
		await d.run();
	}
}, 10_000);

test("F7/M10: a settled task with a cancellation is never listed or closed by the daemon; noted once", async () => {
	const f = fixture(["n1"]);
	const id = settledOn(f.store, f.dir, "n1", "cancelled");
	// A retained cancellation intent of this attempt (as Fleet.cancel's transactional admission leaves it).
	const attemptId = f.store.task(id)!.attemptId!;
	const opId = crypto.randomUUID();
	const db = raw(f.path);
	try { db.query("INSERT INTO operations(id,task_id,attempt_id,kind,data) VALUES (?,?,?,?,?)").run(opId, id, attemptId, "cancel", canonicalJson({ id: opId, key: opId, digest: digest({}), taskId: id, attemptId, kind: "cancel", payload: {} })); } finally { db.close(); }
	expect(f.store.getOperation(id, "cancel")).toBeDefined();
	const broker = fakeBroker(f.dir, f.store);
	const now = Date.now();
	const d = daemon(f.fleet, { connectReturn: broker.connect as any, now: () => now });
	d.acquire();
	try {
		// Repeat the decision without a wall-clock sleep or an expiring test lease.
		await d.cycle();
		await d.cycle();
	} finally {
		d.stop();
		await d.run();
	}
	expect(broker.stats).toEqual({ lists: 0, closes: 0 });
	expect(f.store.events(id).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual(["return_cancellation_owns_retirement"]);
}, 10_000);

test("F7/M12: under rollback the daemon runs no queue pass and no return, and still observes", async () => {
	const f = fixture(["n1"]);
	const settled = settledOn(f.store, f.dir, "n1", "settled");
	const active = activeOn(f.store, "n1", "active");
	f.fleet.submit(input("q") as any, { samples: new Map() });
	f.store.enterRollback();
	const stats = fakeCoordinator(f.fleet, () => 1);
	const broker = fakeBroker(f.dir, f.store);
	let sampled = 0;
	const d = daemon(f.fleet, { connectReturn: broker.connect as any, sample: async () => { sampled++; return { ok: false, at: Date.now(), error: "x" }; } });
	await runFor(d, 500);
	expect(sampled).toBe(0);
	expect(broker.stats).toEqual({ lists: 0, closes: 0 });
	expect(f.store.getOperation(settled, "resource-return-confirmed")).toBeUndefined();
	expect(stats.reads.get(`session-${active}`)!).toBeGreaterThanOrEqual(1);
}, 10_000);

/** A Coordinator transport for the preflight probe: logs its name, answers nothing for `ms`, exits (fails closed). */
function sleepyTransport(dir: string, log: string, name: string, ms: number) {
	const script = join(dir, "sleepy.ts");
	writeFileSync(script, 'import { appendFileSync } from "node:fs";\nconst [log, name, ms] = process.argv.slice(2);\nappendFileSync(log, name + "\\n");\nawait Bun.sleep(Number(ms));\n');
	return { command: process.execPath, args: [script, log, name, String(ms)] };
}
/** Nodes "fast" (one active task) and "slow" (preflight probe `slowProbeMs`), plus three queued tasks admissible by resources. */
function placementFixture(slowProbeMs: number) {
	const f = fixture(["fast", "slow"]);
	const log = join(f.dir, "probes.log");
	writeFileSync(log, "");
	f.store.putNode({ ...node("fast", f.dir), transport: sleepyTransport(f.dir, log, "fast", 1) } as NodeConfig);
	f.store.putNode({ ...node("slow", f.dir), transport: sleepyTransport(f.dir, log, "slow", slowProbeMs) } as NodeConfig);
	const active = activeOn(f.store, "fast", "active");
	for (const key of ["q1", "q2", "q3"]) expect(f.fleet.submit(input(key) as any, { samples: new Map() }).phase).toBe("queued");
	const probes = (name: string) => readFileSync(log, "utf8").split("\n").filter((l) => l === name).length;
	return { ...f, active, probes };
}

for (const scenario of ["slow probe", "unmeasurable"] as const) test(`R1 (${scenario}): while a queue pass places on a slow or unreachable node, the other node keeps its observation cadence`, async () => {
	const f = placementFixture(scenario === "slow probe" ? 1_500 : 1);
	const stats = fakeCoordinator(f.fleet, () => 2);
	const sample = async (n: NodeConfig) => {
		if (n.id === "slow" && scenario === "unmeasurable") {
			await Bun.sleep(1_000);
			return { ok: false as const, at: Date.now(), error: "unreachable" };
		}
		return { ...headroom([n.id], 3).samples.get(n.id)!, at: Date.now() };
	};
	const d = daemon(f.fleet, { sample, queueMaxBackoffMs: 200 });
	const startedAt = Date.now();
	const running = d.run();
	cleanups.push(async () => { d.stop(); await running.catch(() => {}); });
	await Bun.sleep(4_000);
	const stoppedAt = Date.now();
	d.stop();
	await running;
	// Longest time the fast node went without an observation call (from start, between calls, until stop).
	const calls = stats.nodeCalls.get("fast") ?? [];
	let gap = 0;
	let last = startedAt;
	for (const call of calls) {
		gap = Math.max(gap, call.start - last);
		last = call.end;
	}
	gap = Math.max(gap, stoppedAt - last);
	// Without per-call gates the fast node waits for whole passes (seconds); here only its own sample/probe.
	// Load-tolerant bounds: 1.5 s still sits far below an ungated whole-pass wait, and 10 calls in 4 s is
	// one per 400 ms where an ungated node sees one per pass (seconds); the count carries the signal.
	expect(gap).toBeLessThan(1_500);
	expect(calls.length).toBeGreaterThanOrEqual(10);
	expect(stats.other).toEqual([]);
	// Queue passes ran and probed: the slow node only when its sample succeeded, never when it failed.
	expect(f.probes("fast")).toBeGreaterThanOrEqual(1);
	if (scenario === "slow probe") expect(f.probes("slow")).toBeGreaterThanOrEqual(1);
	else expect(f.probes("slow")).toBe(0);
}, 20_000);

test("R1: a queue pass measures each node at most once, keeps a failed sample for the pass and never probes that node", async () => {
	const f = placementFixture(1);
	const sampled = new Map<string, number>();
	const sample = async (n: NodeConfig) => {
		sampled.set(n.id, (sampled.get(n.id) ?? 0) + 1);
		if (n.id === "slow") return { ok: false as const, at: Date.now(), error: "unreachable" };
		return { ...headroom([n.id], 3).samples.get(n.id)!, at: Date.now() };
	};
	const d = daemon(f.fleet, { sample });
	d.acquire();
	// run() after stop() drains in-flight calls; the store must close only after they finish.
	cleanups.push(async () => { d.stop(); await d.run().catch(() => {}); try { f.store.releaseDaemonLease(d.owner); } catch {} });
	await d.cycle();
	await until(() => (d.status() as any).queue.lastPassAt !== null, 60_000);
	// Three candidates were admissible by resources on "fast" and each was preflighted there.
	expect(f.probes("fast")).toBe(3);
	expect(Object.fromEntries(sampled)).toEqual({ fast: 1, slow: 1 });
	expect(f.probes("slow")).toBe(0);
}, 120_000);

test("R2: an unreachable node adds no abandoned_poll row and issues no poll per retry; once reachable it is polled again", async () => {
	const f = fixture(["off"]);
	const id = activeOn(f.store, "off", "t");
	const before = f.store.task(id)!;
	const stats = fakeCoordinator(f.fleet, () => 1);
	const connect = (f.fleet as any).connect;
	let offline = true;
	let attempts = 0;
	(f.fleet as any).connect = async (n: NodeConfig, required: string[]) => {
		if (offline) { attempts++; throw Object.assign(new Error("ssh: connect timed out"), { code: "ETIMEDOUT" }); }
		return connect(n, required);
	};
	const abandoned = () => sql<any>(f.path, "SELECT count(*) n FROM audit WHERE task_id=? AND kind='abandoned_poll'", id).n as number;
	const audit = () => sql<any>(f.path, "SELECT count(*) n FROM audit WHERE task_id=?", id).n as number;
	const d = daemon(f.fleet, { backoffMs: 10, backoffMaxMs: 20 });
	const running = d.run();
	cleanups.push(async () => { d.stop(); await running.catch(() => {}); });
	await until(() => attempts >= 10);
	const rows = audit();
	const issued = f.store.task(id)!.pollIssued;
	// The first failed read is the one abandoned poll; the retries since then wrote nothing.
	expect(abandoned()).toBe(1);
	expect(issued).toBe(1);
	await until(() => attempts >= 40);
	expect(abandoned()).toBe(1);
	expect(audit()).toBe(rows);
	expect(f.store.task(id)!.pollIssued).toBe(issued);
	expect(f.store.task(id)).toMatchObject({ phase: before.phase, held: true });
	expect(f.store.task(id)!.reason).toBe(before.reason);
	// Reachable again: the reachability check passes and the task is polled as before.
	offline = false;
	await until(() => (stats.reads.get(`session-${id}`) ?? 0) >= 3);
	d.stop();
	await running;
	expect(abandoned()).toBe(1);
	expect(f.store.task(id)!.pollApplied).toBeGreaterThanOrEqual(3);
}, 20_000);
