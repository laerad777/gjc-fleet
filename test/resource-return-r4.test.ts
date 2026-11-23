import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { observationDigest } from "../src/core";
import { sha256 } from "../src/workspace";
import { TransportError } from "../src/rpc";
import { operatorReleaseResource, returnResources, type ReturnConnection } from "../src/resource-return";
import { getDashboardState } from "../src/dashboard";
import { cli } from "../src/cli";
import type { NodeConfig, SessionAuthority } from "../src/contracts";

// Fourth-round tests for re-review d28d7315 findings N1..N4, written from the
// reviewer's reproductions R9, R11, R12, R13. Temporary SQLite only; the broker is
// an in-memory model whose envelopes mirror the installed gjc CLI.
const INC = "b".repeat(64);
const FOREIGN = "c".repeat(64);
const dirs: string[] = [];
const stores: { close(): void }[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) { try { s.close(); } catch {} }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
type Opts = { authority?: boolean };
function nodeConfig(dir: string, id = "node", sdkArgs: string[] = []): NodeConfig {
	return { id, os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: process.execPath, args: sdkArgs } };
}
function addTask(store: FleetStore, n: NodeConfig, dir: string, i: number, o: Opts = {}) {
	const task = store.reserve(store.submit({ schemaVersion: 1, key: `task-${n.id}-${i}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
	const path = join(n.workspaceRoot, task.id + "-" + task.attemptId);
	const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: n.id, inputDigest: task.inputDigest, path, repo: dir, baseCommit: "a".repeat(40) };
	store.setWorkspace(task.id, identity);
	const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
	const sessionId = `session-${n.id}-${i}`;
	store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
	if (o.authority !== false) store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: INC });
	store.recordTurn(task.id, "turn");
	const body = { sessionId, turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(task.id, { eventId: `terminal-${n.id}-${i}`, digest: observationDigest(body), ...body });
	store.saveResult(task.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" });
	return store.task(task.id)!;
}
function fixture(count = 1, o: Opts = {}, sdkArgs: string[] = []) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "r4-return-"))); dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 100, { deferTerminalRelease: true }); stores.push(store);
	const n = nodeConfig(dir, "node", sdkArgs); store.putNode(n);
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push(addTask(store, n, dir, i, o).id);
	return { store, path, dir, ids, node: n };
}
function envelope(code: string, diagnostics?: string[], certainty = "unknown") {
	return { schema: "gjc.command-error", version: 1, ok: false, command: ["sdk", "session", "raw", "global"], error: { code, category: "unavailable", message: code, retryability: "unknown", outcomeCertainty: certainty, references: [], nextSteps: [] }, ...(diagnostics ? { diagnostics: diagnostics.map(d => ({ code: d, message: d })) } : {}), omittedOptional: [], complete: true, evidence: { status: "inline" }, continuation: null };
}
type Session = { inc: string; gen: number; cwd: string; live: boolean; terminal: boolean; activity?: string };
function broker(store: FleetStore, options: { refuse?: (sessionId: string) => unknown | undefined; hang?: () => boolean; afterList?: (sessionId: string) => void } = {}) {
	const sessions = new Map<string, Session>();
	for (const t of store.tasks()) if (t.sessionId) sessions.set(t.sessionId, { inc: INC, gen: 1, cwd: (t.workspace as any).path, live: true, terminal: false, activity: "idle" });
	const closes: { sessionId: string; key: string }[] = [];
	const listed: string[] = [];
	let seq = 0;
	const port: ReturnConnection = {
		async list(sessionId) {
			listed.push(sessionId);
			const s = sessions.get(sessionId);
			const answer = { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: s ? [{ sessionId, locator: { cwd: s.cwd }, endpointGeneration: s.gen, endpointIncarnation: s.inc, live: s.live, terminal: s.terminal, ambiguous: false, terminalUncertain: false, ...(s.activity ? { activity: { state: s.activity } } : {}) }] : [] } };
			options.afterList?.(sessionId);
			return answer;
		},
		async fencedClose(authority: SessionAuthority, key: string) {
			closes.push({ sessionId: authority.sessionId, key });
			if (options.hang?.()) throw new TransportError("execution_query_timeout", "unknown");
			const refused = options.refuse?.(authority.sessionId);
			if (refused) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", refused);
			const s = sessions.get(authority.sessionId);
			if (!s) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("not_found"));
			if (s.inc !== authority.endpointIncarnation || s.gen !== authority.endpointGeneration) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("endpoint_stale"));
			if (s.activity !== "idle") throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("busy"));
			s.live = false; s.terminal = true;
			return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
		},
		close() {},
	};
	return { connect: async () => port, sessions, closes, listed };
}
function audits(path: string, kind: string, reason?: string): number {
	const db = new Database(path, { readonly: true });
	try {
		return reason === undefined
			? (db.query("SELECT count(*) AS n FROM audit WHERE kind=?").get(kind) as any).n
			: (db.query("SELECT count(*) AS n FROM audit WHERE kind=? AND json_extract(data,'$.reason')=?").get(kind, reason) as any).n;
	} finally { db.close(); }
}
const ops = { operator: "ops-user", reason: "close outcome lost; host checked by hand" };
const UNCONFIRMED = "released_by_operator_unconfirmed";

// ---------------- N1: operator release is never "returned" ----------------
test("N1 (R11) override is refused while a fresh listing shows the exact session live and running a turn", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	b.sessions.get("session-node-0")!.activity = "active";
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_SESSION_RUNNING" });
	// Unknown activity is not idle either.
	b.sessions.get("session-node-0")!.activity = undefined;
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_SESSION_RUNNING" });
	// Even after an unprovable close history, a running turn refuses the override.
	const g = fixture();
	const c = broker(g.store, { hang: () => true });
	expect((await returnResources(g.store, g.ids, { connect: c.connect, paceMs: 0 }))[0]!.reason).toBe("close_outcome_unknown_no_replay");
	c.sessions.get("session-node-0")!.activity = "active";
	await expect(operatorReleaseResource(g.store, g.ids[0]!, ops, { connect: c.connect })).rejects.toMatchObject({ code: "OVERRIDE_SESSION_RUNNING" });
	for (const [s, t] of [[f.store, id], [g.store, g.ids[0]!]] as const) {
		expect(s.task(t)!.held).toBe(true);
		expect(s.getOperation(t, "resource-return-override")).toBeUndefined();
	}
	expect(audits(f.path, "released") + audits(g.path, "released")).toBe(0);
	expect(b.closes).toHaveLength(0);
});

test("N1 (R11) override of an exact live idle session never tried is refused: return closes it instead", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_RETURN_FIRST" });
	expect(f.store.task(id)!.held).toBe(true);
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "returned" }]);
	// A session a fresh listing shows gone is returned by `return`, not overridden.
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "RETURN_ALREADY_SETTLED" });
	const g = fixture();
	const c = broker(g.store);
	c.sessions.delete("session-node-0");
	await expect(operatorReleaseResource(g.store, g.ids[0]!, ops, { connect: c.connect })).rejects.toMatchObject({ code: "OVERRIDE_OBSERVED_GONE" });
	expect(g.store.task(g.ids[0]!)!.held).toBe(true);
});

test("N1 override requires operator identity and an explicit reason", async () => {
	const f = fixture();
	const b = broker(f.store, { hang: () => true });
	await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	for (const bad of [{ operator: "", reason: "x" }, { operator: "ops", reason: "" }, { operator: "ops", reason: "   " }, { operator: "ops" }, {}] as any[])
		await expect(operatorReleaseResource(f.store, f.ids[0]!, bad, { connect: b.connect })).rejects.toThrow();
	expect(f.store.task(f.ids[0]!)!.held).toBe(true);
	expect(b.listed).toHaveLength(1); // validation precedes any listing
});

test("N1 (R11/R12) released_by_operator_unconfirmed: distinct state, audited, stays visible until a fresh listing shows it gone", async () => {
	const f = fixture(2);
	const [id, other] = f.ids as [string, string];
	const b = broker(f.store, { hang: () => true });
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" });
	const released = await operatorReleaseResource(f.store, id, ops, { connect: b.connect });
	expect(released).toMatchObject({ taskId: id, state: UNCONFIRMED, observedGone: false });
	expect(released.statement).toContain("NOT observed gone");
	const payload = f.store.getOperation(id, "resource-return-override")!.payload as any;
	expect(payload).toMatchObject({ operator: "ops-user", reason: ops.reason, observedGone: false, physicalState: "possibly_running_on_node", nodeId: "node", sessionId: "session-node-0", freshListing: { kind: "exact_live", activity: "idle" } });
	expect(payload.closes).toEqual([{ id: f.store.getOperation(id, "resource-return-close:1")!.id, receipt: null }]);
	expect(audits(f.path, "resource_return_operator_override")).toBe(1);
	expect(audits(f.path, "released", "resource_return_operator_override")).toBe(1);
	expect(f.store.task(id)!.held).toBe(false);
	expect(f.store.resourceReturnStatus(id)).toMatchObject({ state: UNCONFIRMED, observedGone: false, possiblyRunningOnNode: true, operator: "ops-user", nodeId: "node", sessionId: "session-node-0" });
	expect(f.store.resourceReturnStatus(other)).toBeUndefined();
	// Dashboard: task and node both show the session as possibly still running.
	let dash = getDashboardState(f.store);
	expect(dash.tasks.find(t => t.id === id)!.resourceReturn).toMatchObject({ state: UNCONFIRMED, possiblyRunningOnNode: true });
	expect(dash.nodes[0]!.possiblyRunning).toEqual([expect.objectContaining({ id, sessionId: "session-node-0", operator: "ops-user" })]);
	// Later passes list (read-only), never close, never report returned while it is listed.
	const closes = b.closes.length;
	for (let i = 0; i < 2; i++) {
		const listedBefore = b.listed.length;
		expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: UNCONFIRMED, reason: "session_not_observed_gone" }]);
		expect(b.listed.length).toBe(listedBefore + 1);
	}
	b.sessions.get("session-node-0")!.activity = "active"; // the override never closes, even a running session
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe(UNCONFIRMED);
	expect(b.closes.length).toBe(closes);
	expect(() => f.store.claimResourceReturnClose(id, 2, { sessionId: "session-node-0", cwd: (f.store.task(id)!.workspace as any).path, endpointGeneration: 1, endpointIncarnation: INC, ifIdle: true })).toThrow("Return already settled");
	// A fresh listing showing it gone turns it into returned, with no second release.
	b.sessions.delete("session-node-0");
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "returned", reason: "observed_gone_after_operator_release" }]);
	const confirmed = f.store.getOperation(id, "resource-return-confirmed")!.payload as any;
	expect(confirmed).toMatchObject({ observed: "absent", afterOperatorRelease: true, overrideOperationId: f.store.getOperation(id, "resource-return-override")!.id });
	expect(audits(f.path, "released")).toBe(1);
	expect(f.store.resourceReturnStatus(id)).toMatchObject({ state: "returned", observedGone: true, afterOperatorRelease: true });
	dash = getDashboardState(f.store);
	expect(dash.nodes[0]!.possiblyRunning).toEqual([]);
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "returned", reason: "observed_gone_after_operator_release" }]);
	expect(audits(f.path, "released")).toBe(1);
});

test("N1 (R12) a pass confirming gone after a concurrent override records the observation without a second release", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store, { hang: () => true });
	await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 });
	await operatorReleaseResource(f.store, id, ops, { connect: b.connect });
	const task = f.store.task(id)!;
	f.store.confirmResourceReturn(id, task.attemptId!, task.sessionId!, { sessionId: task.sessionId!, attemptId: task.attemptId!, manifestDigest: (await import("../src/core")).digest(task.resultManifest!), indexSeq: 9, observed: "terminal", endpointGeneration: 1, endpointIncarnation: INC, closeOperationId: null, closeReceipt: null, stopOperationId: null, stopReceipt: null });
	expect(f.store.resourceReturnStatus(id)).toMatchObject({ state: "returned", afterOperatorRelease: true });
	expect(audits(f.path, "released")).toBe(1);
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "RETURN_ALREADY_SETTLED" });
});

test("N1 override of a task without recorded authority is allowed only as unconfirmed and observed by absence", async () => {
	const f = fixture(1, { authority: false });
	const id = f.ids[0]!;
	const b = broker(f.store);
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "refused", reason: "original_session_authority_missing", refusal: "authority_missing" });
	b.sessions.get("session-node-0")!.activity = "active";
	await expect(operatorReleaseResource(f.store, id, ops, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_SESSION_RUNNING" });
	b.sessions.get("session-node-0")!.activity = "idle";
	expect((await operatorReleaseResource(f.store, id, ops, { connect: b.connect })).state).toBe(UNCONFIRMED);
	expect((f.store.getOperation(id, "resource-return-override")!.payload as any).freshListing).toMatchObject({ kind: "unverifiable_without_authority" });
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: UNCONFIRMED, reason: "session_not_observed_gone" });
	b.sessions.get("session-node-0")!.live = false; b.sessions.get("session-node-0")!.terminal = true;
	// Without the recorded incarnation, only absence proves gone.
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe(UNCONFIRMED);
	b.sessions.delete("session-node-0");
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "returned", reason: "observed_gone_after_operator_release" });
	expect(b.closes).toHaveLength(0);
	expect(audits(f.path, "released")).toBe(1);
});

test("N1 an unreachable node permits an unconfirmed release that records the listing failure", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store, { hang: () => true });
	await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 });
	const down = async (): Promise<ReturnConnection> => ({ list: async () => { throw new TransportError("execution_query_timeout", "unknown"); }, fencedClose: async () => { throw new Error("must not close"); }, close() {} });
	expect((await operatorReleaseResource(f.store, id, ops, { connect: down })).state).toBe(UNCONFIRMED);
	expect((f.store.getOperation(id, "resource-return-override")!.payload as any).freshListing).toMatchObject({ kind: "unavailable" });
	expect((await returnResources(f.store, [id], { connect: down, paceMs: 0 }))[0]).toEqual({ taskId: id, state: UNCONFIRMED, reason: "fresh_listing_unavailable" });
	expect(f.store.resourceReturnStatus(id)!.state).toBe(UNCONFIRMED);
});

test("N1 store API refuses an override observation showing a running or gone exact session", () => {
	const f = fixture();
	const id = f.ids[0]!;
	expect(() => f.store.overrideResourceReturn(id, ops, { kind: "exact_live", indexSeq: 1, activity: "active" })).toThrow(expect.objectContaining({ code: "OVERRIDE_SESSION_RUNNING" }));
	expect(() => f.store.overrideResourceReturn(id, ops, { kind: "exact_live", indexSeq: 1, activity: "idle" })).toThrow(expect.objectContaining({ code: "OVERRIDE_RETURN_FIRST" }));
	expect(() => f.store.overrideResourceReturn(id, ops, { kind: "absent", indexSeq: 1 } as any)).toThrow();
	expect(() => f.store.overrideResourceReturn(id, ops, undefined as any)).toThrow();
	expect(f.store.task(id)!.held).toBe(true);
});

test("N1 CLI: return-override exits 3 and says NOT observed gone; tasks/show and return keep it unconfirmed", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "r4-cli-"))); dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	const state = join(dir, "listing.json");
	// Stand-in public SDK CLI: session.list answers from listing.json.
	const fakeSdk = join(dir, "fake-sdk.ts");
	writeFileSync(fakeSdk, `const op=process.argv[process.argv.indexOf("--op")+1];if(op!=="session.list"){console.log(JSON.stringify({schema:"gjc.command-error",ok:false,error:{code:"unexpected"}}));process.exit(1)}console.log(require("node:fs").readFileSync(${JSON.stringify(state)},"utf8"));`);
	const store = new FleetStore(path, 100, { deferTerminalRelease: true }); stores.push(store);
	const n = nodeConfig(dir, "node", [fakeSdk]);
	store.putNode(n);
	const t0 = addTask(store, n, dir, 0, { authority: false });
	const row = (activity: string) => JSON.stringify({ type: "broker_response", ok: true, result: { indexSeq: 3, sessions: [{ sessionId: t0.sessionId, locator: { cwd: (t0.workspace as any).path }, endpointGeneration: 1, endpointIncarnation: INC, live: true, terminal: false, ambiguous: false, terminalUncertain: false, activity: { state: activity } }] } });
	const file = join(dir, "override.json");
	writeFileSync(file, JSON.stringify(ops));
	store.close();
	const out: string[] = [];
	const log = console.log; console.log = (v: unknown) => { out.push(String(v)); };
	try {
		writeFileSync(state, row("active"));
		await expect(cli(["--db", path, "--cap", "100", "return-override", t0.id, file])).rejects.toThrow("running a turn");
		writeFileSync(state, row("idle"));
		expect(await cli(["--db", path, "--cap", "100", "return-override", t0.id, file])).toBe(3);
		expect(await cli(["--db", path, "--cap", "100", "return", t0.id])).toBe(1);
		expect(await cli(["--db", path, "--cap", "100", "--read-only", "show", t0.id])).toBe(0);
		writeFileSync(state, JSON.stringify({ type: "broker_response", ok: true, result: { indexSeq: 4, sessions: [] } }));
		expect(await cli(["--db", path, "--cap", "100", "return", t0.id])).toBe(0);
	} finally { console.log = log; }
	const override = JSON.parse(out[0]!);
	expect(override).toMatchObject({ ok: true, taskId: t0.id, state: UNCONFIRMED, observedGone: false, override: { operator: "ops-user", reason: ops.reason } });
	expect(override.statement).toContain("NOT observed gone");
	expect(JSON.parse(out[1]!)).toEqual([{ taskId: t0.id, state: UNCONFIRMED, reason: "session_not_observed_gone" }]);
	expect(JSON.parse(out[2]!).resourceReturn).toMatchObject({ state: UNCONFIRMED, possiblyRunningOnNode: true, operator: "ops-user" });
	expect(JSON.parse(out[3]!)).toEqual([{ taskId: t0.id, state: "returned", reason: "observed_gone_after_operator_release" }]);
	expect(audits(path, "released")).toBe(1);
});

test("N1 R11 ported: untried live and busy exact sessions cannot be released; nothing reports returned; return exits non-zero", async () => {
	const f = fixture(2);
	const [a, c] = f.ids as [string, string];
	const b = broker(f.store);
	b.sessions.get("session-node-1")!.activity = "busy"; // running a turn
	await expect(operatorReleaseResource(f.store, a, { operator: "anyone", reason: "x" }, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_RETURN_FIRST" });
	await expect(operatorReleaseResource(f.store, c, { operator: "anyone", reason: "x" }, { connect: b.connect })).rejects.toMatchObject({ code: "OVERRIDE_SESSION_RUNNING" });
	expect(f.store.task(a)!.held && f.store.task(c)!.held).toBe(true);
	expect(audits(f.path, "released")).toBe(0);
	const r = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(r).toEqual([{ taskId: a, state: "returned" }, { taskId: c, state: "session_busy", reason: "session_not_idle" }]);
	expect(b.sessions.get("session-node-1")!.live).toBe(true);
});

test("N1 R12 ported: released exactly once in every order; a forged confirmation after a release is refused", async () => {
	const f = fixture(2);
	const [a, c] = f.ids as [string, string];
	const b = broker(f.store);
	expect((await returnResources(f.store, [a], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	await expect(operatorReleaseResource(f.store, a, ops, { connect: b.connect })).rejects.toMatchObject({ code: "RETURN_ALREADY_SETTLED" });
	const port = await b.connect();
	const lost: ReturnConnection = { ...port, async fencedClose() { throw new TransportError("timeout", "unknown"); } };
	expect((await returnResources(f.store, [c], { connect: async () => lost, paceMs: 0 }))[0]!.reason).toBe("close_outcome_unknown_no_replay");
	expect((await operatorReleaseResource(f.store, c, ops, { connect: b.connect })).state).toBe(UNCONFIRMED);
	const task = f.store.task(c)!;
	expect(() => f.store.confirmResourceReturn(c, task.attemptId!, "session-node-1", { attemptId: task.attemptId!, sessionId: "session-node-1", manifestDigest: "x", observed: "absent", indexSeq: 1 })).toThrow();
	expect(() => f.store.confirmResourceReturn(c, task.attemptId!, "session-node-1", { attemptId: task.attemptId!, sessionId: "session-node-1", manifestDigest: null, observed: "live", indexSeq: 1 })).toThrow();
	b.sessions.delete("session-node-1");
	expect((await returnResources(f.store, [c], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: c, state: "returned", reason: "observed_gone_after_operator_release" });
	await expect(operatorReleaseResource(f.store, c, ops, { connect: b.connect })).rejects.toMatchObject({ code: "RETURN_ALREADY_SETTLED" });
	expect(audits(f.path, "released")).toBe(2);
	const payload = f.store.getOperation(c, "resource-return-override")!.payload as any;
	expect(payload).toMatchObject({ physicalState: "possibly_running_on_node", observedGone: false });
	expect(payload.closes).toHaveLength(1);
	expect(payload.closes[0].receipt).toBeNull();
});

// ---------------- N2: endpoint_stale is re-listed before not_ours ----------------
test("N2 (R13) transient endpoint_stale with the exact incarnation still listed is return_unknown, then a bounded new claim returns it", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	let stale = true;
	const b = broker(f.store, { refuse: () => (stale ? envelope("endpoint_stale") : undefined) });
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "return_unknown", reason: "endpoint_stale_exact_incarnation_still_listed" }]);
	expect(audits(f.path, "resource_return_not_ours")).toBe(0);
	stale = false;
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "returned" }]);
	expect(b.closes).toHaveLength(2);
	expect(f.store.getOperation(id, "resource-return-close:2")).toBeDefined();
	expect(audits(f.path, "released")).toBe(1);
	// Persistent stale on an exact listing stays bounded by the claim cap.
	const g = fixture();
	const c = broker(g.store, { refuse: () => envelope("endpoint_stale") });
	for (let i = 0; i < 7; i++) await returnResources(g.store, g.ids, { connect: c.connect, paceMs: 0 });
	expect(c.closes).toHaveLength(5);
	expect((await returnResources(g.store, g.ids, { connect: c.connect, paceMs: 0 }))[0]).toEqual({ taskId: g.ids[0]!, state: "return_unknown", reason: "close_attempts_exhausted" });
});

test("N2 endpoint_stale then a foreign incarnation is not_ours; then absence is a normal confirmed return", async () => {
	const f = fixture(2);
	const [a, c] = f.ids as [string, string];
	const b = broker(f.store, {
		refuse: sessionId => {
			if (sessionId === "session-node-0") b.sessions.get(sessionId)!.inc = FOREIGN;
			else b.sessions.delete(sessionId);
			return envelope("endpoint_stale");
		},
	});
	expect(await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: a, state: "not_ours", reason: "endpoint_stale_incarnation_not_owned" }, { taskId: c, state: "returned" }]);
	expect((await returnResources(f.store, [a], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("not_ours");
	expect(b.closes).toHaveLength(2);
	expect(audits(f.path, "released")).toBe(1);
});

// ---------------- N3: unclassified refusals stop the node ----------------
test("N3 (R9) operation_failed with unknown certainty and no diagnostics blocks the node persistently", async () => {
	const f = fixture(3);
	let failing = true;
	const b = broker(f.store, { refuse: () => (failing ? envelope("operation_failed") : undefined) });
	const r = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(r.map(x => x.state)).toEqual(["return_blocked_by_node", "return_blocked_by_node", "return_blocked_by_node"]);
	expect(r[0]!.reason).toBe("unclassified_operation_failed_possible_legacy_history");
	expect(b.closes).toHaveLength(1);
	expect(b.listed).toEqual(["session-node-0"]);
	expect(f.store.resourceReturnNodeBlock("node")?.diagnostic).toBe("unclassified_operation_failed_possible_legacy_history");
	failing = false;
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 })).map(x => x.state)).toEqual(["return_blocked_by_node", "return_blocked_by_node", "return_blocked_by_node"]);
	expect(b.closes).toHaveLength(1);
	f.store.clearResourceReturnNodeBlock("node", { operator: "ops", reason: "ledger checked" });
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 })).map(x => x.state)).toEqual(["returned", "returned", "returned"]);
});

test("N3 any other unclassified refusal stops the node's pass without a persistent block", async () => {
	const f = fixture(3);
	let failing = true;
	const b = broker(f.store, { refuse: () => (failing ? envelope("authorization_denied", undefined, "certain") : undefined) });
	const r = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(r).toEqual([
		{ taskId: f.ids[0]!, state: "return_unknown", reason: "close_outcome_unknown_no_replay" },
		{ taskId: f.ids[1]!, state: "return_unknown", reason: "node_pass_stopped_by_unclassified_close_refusal" },
		{ taskId: f.ids[2]!, state: "return_unknown", reason: "node_pass_stopped_by_unclassified_close_refusal" },
	]);
	expect(b.closes).toHaveLength(1);
	expect(b.listed).toEqual(["session-node-0"]);
	expect(f.store.resourceReturnNodeBlock("node")).toBeUndefined();
	failing = false;
	const next = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(next.map(x => x.state)).toEqual(["return_unknown", "returned", "returned"]);
	expect(b.closes).toHaveLength(3); // the unclassified one is never replayed
});

// ---------------- N4: block checked inside the claim transaction ----------------
test("N4 a block written after the pass's checks refuses the close claim inside its transaction", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store, { afterList: () => { if (!f.store.resourceReturnNodeBlock("node")) f.store.blockResourceReturnNode("node", id, "other-process", "lifecycle_legacy_history_ambiguous"); } });
	expect(await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: id, state: "return_blocked_by_node", reason: "lifecycle_legacy_history_ambiguous" }]);
	expect(b.closes).toHaveLength(0);
	expect(f.store.getOperation(id, "resource-return-close:1")).toBeUndefined();
	const task = f.store.task(id)!;
	expect(() => f.store.claimResourceReturnClose(id, 1, { sessionId: task.sessionId!, cwd: (task.workspace as any).path, endpointGeneration: 1, endpointIncarnation: INC, ifIdle: true })).toThrow(expect.objectContaining({ code: "RETURN_NODE_BLOCKED" }));
});

// ---------------- R4-1: post-override "gone" is anchored to the override's own listing ----------------
/** Listings scripted as (indexSeq, present?) for one session; never closes. */
function scriptedList(rows: { seq: number; present: boolean }[], sessionId: string, cwd: string) {
	const self = {
		lists: 0, closes: 0,
		async list() {
			const r = rows[Math.min(self.lists++, rows.length - 1)]!;
			return { type: "broker_response", ok: true, result: { indexSeq: r.seq, sessions: r.present ? [{ sessionId, locator: { cwd }, endpointGeneration: 1, endpointIncarnation: INC, live: true, terminal: false, ambiguous: false, terminalUncertain: false, activity: { state: "idle" } }] : [] } };
		},
		async fencedClose(): Promise<never> { self.closes++; throw new Error("must not close"); },
		close() {},
	};
	return self;
}
test("R4-1 after an override, a listing older than or equal to the override's own fresh listing never turns it into returned", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const cwd = (f.store.task(id)!.workspace as any).path;
	await returnResources(f.store, [id], { connect: broker(f.store, { hang: () => true }).connect, paceMs: 0 }); // close outcome lost
	const at = scriptedList([{ seq: 1000, present: true }], "session-node-0", cwd);
	expect((await operatorReleaseResource(f.store, id, ops, { connect: async () => at })).state).toBe(UNCONFIRMED);
	expect((f.store.getOperation(id, "resource-return-override")!.payload as any).freshListing).toEqual({ kind: "exact_live", indexSeq: 1000, activity: "idle" });
	// A regressed or rebuilt broker index answers absent at seq 5 and 6, then at the override's own seq.
	for (const rows of [[{ seq: 5, present: false }, { seq: 6, present: false }], [{ seq: 1000, present: false }, { seq: 1000, present: false }], [{ seq: 999, present: false }, { seq: 1001, present: false }]]) {
		const stale = scriptedList(rows, "session-node-0", cwd);
		expect(await returnResources(f.store, [id], { connect: async () => stale, paceMs: 0 })).toEqual([{ taskId: id, state: UNCONFIRMED, reason: "fresh_listing_unavailable" }]);
		expect(stale.closes).toBe(0);
		expect(f.store.getOperation(id, "resource-return-confirmed")).toBeUndefined();
		expect(f.store.resourceReturnStatus(id)).toMatchObject({ state: UNCONFIRMED, observedGone: false, possiblyRunningOnNode: true });
		expect(getDashboardState(f.store).nodes[0]!.possiblyRunning.map(x => x.id)).toEqual([id]);
	}
	// The store refuses a confirmation not newer than the override's listing, too.
	const task = f.store.task(id)!;
	const proof = (indexSeq: number) => ({ sessionId: task.sessionId!, attemptId: task.attemptId!, manifestDigest: (require("../src/core") as typeof import("../src/core")).digest(task.resultManifest!), indexSeq, observed: "absent", endpointGeneration: 1, endpointIncarnation: INC, closeOperationId: null, closeReceipt: null, stopOperationId: null, stopReceipt: null });
	expect(() => f.store.confirmResourceReturn(id, task.attemptId!, task.sessionId!, proof(1000))).toThrow(expect.objectContaining({ code: "RETURN_STALE_LIST" }));
	expect(f.store.getOperation(id, "resource-return-confirmed")).toBeUndefined();
	// Only a listing newer than the override's, seen gone twice, returns it, with no second release.
	const newer = scriptedList([{ seq: 1001, present: false }, { seq: 1002, present: false }], "session-node-0", cwd);
	expect(await returnResources(f.store, [id], { connect: async () => newer, paceMs: 0 })).toEqual([{ taskId: id, state: "returned", reason: "observed_gone_after_operator_release" }]);
	expect((f.store.getOperation(id, "resource-return-confirmed")!.payload as any)).toMatchObject({ indexSeq: 1002, observed: "absent", afterOperatorRelease: true });
	expect(newer.closes).toBe(0);
	expect(audits(f.path, "released")).toBe(1);
	expect(getDashboardState(f.store).nodes[0]!.possiblyRunning).toEqual([]);
});
