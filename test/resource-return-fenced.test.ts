import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { observationDigest } from "../src/core";
import { sha256 } from "../src/workspace";
import { TransportError } from "../src/rpc";
import { connectResourceReturn, operatorReleaseResource, returnResources, type ReturnConnection } from "../src/resource-return";
import { ClawhipControl, controlBinding, type ControlCommand } from "../src/clawhip-control";
import { cli } from "../src/cli";
import type { NodeConfig, SessionAuthority } from "../src/contracts";
import { headroom } from "./admission-fixture";

// Behavior tests for the third-round findings F1..F8 of re-review 90f79989.
// Temporary SQLite only. The broker is an in-memory model whose refusal
// envelopes mirror the installed gjc CLI output; the last test uses the real
// installed CLI against a throwaway broker under the OS temp directory.
const INC = "b".repeat(64);
const FOREIGN = "c".repeat(64);
const dirs: string[] = [];
const stores: { close(): void }[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) { try { s.close(); } catch {} }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
type Opts = { defer?: boolean; custody?: boolean; authority?: boolean; cwd?: string; sessionId?: string; incarnation?: string; generation?: number };
function nodeConfig(dir: string, id = "node"): NodeConfig {
	return { id, os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: process.execPath, args: [] } };
}
function addTask(store: FleetStore, n: NodeConfig, dir: string, i: number, o: Opts = {}) {
	const task = store.reserve(store.submit({ schemaVersion: 1, key: `task-${n.id}-${i}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
	expect(task.nodeId).toBe(n.id);
	const path = o.cwd ?? join(n.workspaceRoot, task.id + "-" + task.attemptId);
	const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: n.id, inputDigest: task.inputDigest, path, repo: dir, baseCommit: "a".repeat(40) };
	store.setWorkspace(task.id, identity);
	const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
	const sessionId = o.sessionId ?? `session-${n.id}-${i}`;
	store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
	if (o.authority !== false) store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: o.generation ?? 1, endpointIncarnation: o.incarnation ?? INC });
	store.recordTurn(task.id, "turn");
	const body = { sessionId, turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(task.id, { eventId: `terminal-${n.id}-${i}`, digest: observationDigest(body), ...body });
	if (o.custody !== false) store.saveResult(task.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" });
	return store.task(task.id)!;
}
function fixture(count = 1, o: Opts = {}) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fenced-return-"))); dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 100, o.defer === false ? {} : { deferTerminalRelease: true }); stores.push(store);
	const n = nodeConfig(dir); store.putNode(n);
	const ids: string[] = [];
	for (let i = 0; i < count; i++) ids.push(addTask(store, n, dir, i, o).id);
	return { store, path, dir, ids, node: n };
}
function envelope(code: string, diagnostics?: string[]) {
	return { schema: "gjc.command-error", version: 1, ok: false, command: ["sdk", "session", "raw", "global"], error: { code, category: "unavailable", message: code, retryability: "unknown", outcomeCertainty: "unknown", references: [], nextSteps: [] }, ...(diagnostics ? { diagnostics: diagnostics.map(d => ({ code: d, message: d })) } : {}), omittedOptional: [], complete: true, evidence: { status: "inline" }, continuation: null };
}
type Session = { inc: string; gen: number; cwd: string; live: boolean; terminal: boolean; busy?: boolean };
/** Broker model: exact generation/incarnation fence before any effect, idle fence, legacy admission fence. */
function broker(store: FleetStore, options: { legacy?: () => boolean; hang?: () => boolean; lingering?: () => boolean } = {}) {
	const sessions = new Map<string, Session>();
	for (const t of store.tasks()) if (t.sessionId) sessions.set(t.sessionId, { inc: INC, gen: 1, cwd: (t.workspace as any).path, live: true, terminal: false });
	const closes: { sessionId: string; generation: number; incarnation: string; key: string; ifIdle: boolean }[] = [];
	const listed: string[] = [];
	let seq = 0;
	const port: ReturnConnection = {
		async list(sessionId) {
			listed.push(sessionId);
			const s = sessions.get(sessionId);
			return { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: s ? [{ sessionId, locator: { cwd: s.cwd }, endpointGeneration: s.gen, endpointIncarnation: s.inc, live: s.live, terminal: s.terminal, ambiguous: false, terminalUncertain: false, activity: { state: s.busy ? "busy" : "idle" } }] : [] } };
		},
		async fencedClose(authority: SessionAuthority, key: string) {
			closes.push({ sessionId: authority.sessionId, generation: authority.endpointGeneration, incarnation: authority.endpointIncarnation, key, ifIdle: true });
			if (options.hang?.()) throw new TransportError("execution_query_timeout", "unknown");
			if (options.legacy?.()) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("operation_failed", ["lifecycle_legacy_history_ambiguous"]));
			const s = sessions.get(authority.sessionId);
			if (!s) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("not_found"));
			if (s.inc !== authority.endpointIncarnation || s.gen !== authority.endpointGeneration) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("endpoint_stale"));
			if (s.busy) throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("busy"));
			if (!options.lingering?.()) { s.live = false; s.terminal = true; }
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
function expireLease(path: string, token = "dead-owner") {
	const db = new Database(path);
	try { db.query("INSERT OR REPLACE INTO resource_return_leases VALUES ('node', ?, 0)").run(token); } finally { db.close(); }
}

// ---------------- F1: fenced idle-only close of live settled sessions ----------------
test("F1 live exact settled session is closed once through the fenced idle close and confirmed by a fresh listing", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	const r = await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 });
	expect(r).toEqual([{ taskId: id, state: "returned" }]);
	expect(b.closes).toHaveLength(1);
	const claim = f.store.getOperation(id, "resource-return-close:1")!;
	expect(b.closes[0]).toEqual({ sessionId: "session-node-0", generation: 1, incarnation: INC, key: claim.key, ifIdle: true });
	expect(claim.payload).toEqual({ sessionId: "session-node-0", cwd: (f.store.task(id)!.workspace as any).path, endpointGeneration: 1, endpointIncarnation: INC, ifIdle: true });
	expect(claim.receipt).toEqual({ ok: true, operation: "session.close", result: { sessionId: "session-node-0" } });
	expect(b.listed.length).toBe(2); // pre-close + post-close fresh listing
	const confirmed = f.store.getOperation(id, "resource-return-confirmed")!.payload as any;
	expect(confirmed.closeOperationId).toBe(claim.id);
	expect(confirmed.observed).toBe("terminal");
	expect(f.store.task(id)!.held).toBe(false);
	expect(audits(f.path, "released", "resource_return_confirmed")).toBe(1);
	// Idempotent: a repeat pass neither lists, closes nor releases again.
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(1);
	expect(audits(f.path, "released")).toBe(1);
});

test("F1 endpoint_stale means not ours: reported not_ours, never returned, never re-closed", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	// The listing still shows the recorded incarnation, but the broker fence rejects it
	// (incarnation replaced between listing and close).
	const port = await b.connect();
	const swap: ReturnConnection = { ...port, async fencedClose(a, k) { b.sessions.get("session-node-0")!.inc = FOREIGN; return port.fencedClose(a, k); } };
	const r = await returnResources(f.store, [id], { connect: async () => swap, paceMs: 0 });
	expect(r).toEqual([{ taskId: id, state: "not_ours", reason: "endpoint_stale_incarnation_not_owned" }]);
	expect(b.sessions.get("session-node-0")!.live).toBe(true);
	expect(f.store.task(id)!.held).toBe(true);
	expect(f.store.getOperation(id, "resource-return-confirmed")).toBeUndefined();
	expect(audits(f.path, "resource_return_not_ours")).toBe(1);
	// Later passes see a foreign incarnation and never close it.
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("not_ours");
	expect(b.closes).toHaveLength(1);
	expect(audits(f.path, "released")).toBe(0);
});

test("F1 lifecycle_legacy_history_ambiguous blocks the whole node: pass stops, nothing retried, operator unblock re-enables", async () => {
	const f = fixture(3);
	let legacy = true;
	const b = broker(f.store, { legacy: () => legacy });
	const r = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(r.map(x => x.state)).toEqual(["return_blocked_by_node", "return_blocked_by_node", "return_blocked_by_node"]);
	expect(r[0]!.reason).toBe("lifecycle_legacy_history_ambiguous");
	expect(b.closes).toHaveLength(1); // first refusal stops the pass
	expect(b.listed).toEqual(["session-node-0"]); // later tasks not even listed
	expect(f.store.resourceReturnNodeBlock("node")?.diagnostic).toBe("lifecycle_legacy_history_ambiguous");
	expect(audits(f.path, "resource_return_blocked_by_node")).toBe(1);
	// Next pass: no close is dispatched to the blocked node; read-only reconciliation still works.
	b.sessions.get("session-node-1")!.live = false; b.sessions.get("session-node-1")!.terminal = true;
	const again = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(again.map(x => x.state)).toEqual(["return_blocked_by_node", "returned", "return_blocked_by_node"]);
	expect(b.closes).toHaveLength(1);
	// Audited operator unblock after the ledger defect is fixed; refused without operator identity.
	expect(() => f.store.clearResourceReturnNodeBlock("node", { operator: "", reason: "x" })).toThrow();
	f.store.clearResourceReturnNodeBlock("node", { operator: "ops", reason: "GJC ledger repaired" });
	expect(audits(f.path, "resource_return_node_unblocked")).toBe(1);
	legacy = false;
	const after = await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(after.map(x => x.state)).toEqual(["returned", "returned", "returned"]);
	expect(f.store.getOperation(f.ids[0]!, "resource-return-close:2")).toBeDefined(); // pre-dispatch refusal permits one new claim
	expect(b.closes).toHaveLength(3);
	expect(audits(f.path, "released", "resource_return_confirmed")).toBe(3);
});

test("F1 operation_failed (unknown outcome) without diagnostics is treated as a possible legacy refusal: node blocked, not retried", async () => {
	const f = fixture();
	const b = broker(f.store);
	const port = await b.connect();
	const failing: ReturnConnection = { ...port, async fencedClose(a, k) { b.closes.push({ sessionId: a.sessionId, generation: a.endpointGeneration, incarnation: a.endpointIncarnation, key: k, ifIdle: true }); throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", envelope("operation_failed")); } };
	for (let i = 0; i < 2; i++) expect((await returnResources(f.store, f.ids, { connect: async () => failing, paceMs: 0 }))[0]!.state).toBe("return_blocked_by_node");
	expect(b.closes).toHaveLength(1);
	expect(f.store.resourceReturnNodeBlock("node")?.diagnostic).toBe("unclassified_operation_failed_possible_legacy_history");
});

test("F1 legacy refusal on one node does not stop another node", async () => {
	const f = fixture(1);
	const other = nodeConfig(f.dir, "other"); f.store.putNode(other);
	f.store.setNodeState("node", { enabled: false });
	const t2 = addTask(f.store, other, f.dir, 0);
	f.store.setNodeState("node", { enabled: true, draining: false });
	const b = broker(f.store, { legacy: () => true });
	const port = await b.connect();
	const ok = broker(f.store);
	const r = await returnResources(f.store, [f.ids[0]!, t2.id], { connect: async n => (n.id === "node" ? port : ok.connect()), paceMs: 0 });
	expect(r.map(x => x.state)).toEqual(["return_blocked_by_node", "returned"]);
	expect(f.store.resourceReturnNodeBlock("other")).toBeUndefined();
});

test("F1 unknown close outcome is never replayed; later fresh absence still confirms", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store, { hang: () => true });
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" });
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" });
	expect(b.closes).toHaveLength(1);
	expect(f.store.task(id)!.held).toBe(true);
	b.sessions.delete("session-node-0");
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(1);
});

test("F1 busy (not idle) is a pre-effect refusal: reported, retried only on a later pass, bounded", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	b.sessions.get("session-node-0")!.busy = true;
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "session_busy", reason: "session_not_idle" });
	expect(b.closes).toHaveLength(1);
	b.sessions.get("session-node-0")!.busy = false;
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(2);
	// Bounded: a permanently busy session stops being retried after the attempt cap.
	const g = fixture();
	const c = broker(g.store); c.sessions.get("session-node-0")!.busy = true;
	for (let i = 0; i < 7; i++) await returnResources(g.store, g.ids, { connect: c.connect, paceMs: 0 });
	expect(c.closes).toHaveLength(5);
	expect((await returnResources(g.store, g.ids, { connect: c.connect, paceMs: 0 }))[0]).toEqual({ taskId: g.ids[0]!, state: "return_unknown", reason: "close_attempts_exhausted" });
});

test("F1 acknowledged close whose host still lists live is not returned until a fresh listing proves it; no re-close", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	let linger = true;
	const b = broker(f.store, { lingering: () => linger });
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "return_unknown", reason: "close_acknowledged_awaiting_terminal_listing" });
	expect(f.store.task(id)!.held).toBe(true);
	linger = false;
	b.sessions.get("session-node-0")!.live = false; b.sessions.get("session-node-0")!.terminal = true;
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(1);
});

test("F1 default mode closes the session but never releases a second time", async () => {
	const f = fixture(1, { defer: false });
	const b = broker(f.store);
	expect(audits(f.path, "released")).toBe(1);
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(1);
	expect(audits(f.path, "released")).toBe(1);
});

test("F1 a crash after the durable close claim is never replayed by the successor", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const worker = join(f.dir, "crash.ts");
	writeFileSync(worker, `import {FleetStore} from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};import {returnResources} from ${JSON.stringify(join(import.meta.dir, "../src/resource-return.ts"))};const s=new FleetStore(${JSON.stringify(f.path)},100,{deferTerminalRelease:true});const t=s.task(${JSON.stringify(id)});await returnResources(s,[t.id],{paceMs:0,connect:async()=>({list:async()=>({type:'broker_response',ok:true,result:{indexSeq:1,sessions:[{sessionId:t.sessionId,locator:{cwd:t.workspace.path},endpointGeneration:1,endpointIncarnation:${JSON.stringify(INC)},live:true,terminal:false,ambiguous:false,terminalUncertain:false}]}}),fencedClose:async()=>{process.exit(77)},close(){}})});`);
	const child = Bun.spawn([process.execPath, worker], { stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(77);
	expect(f.store.getOperation(id, "resource-return-close:1")?.receipt).toBeUndefined();
	const db = new Database(f.path); db.query("UPDATE resource_return_leases SET expires=0").run(); db.close();
	const b = broker(f.store);
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" });
	expect(b.closes).toHaveLength(0);
	b.sessions.get("session-node-0")!.live = false; b.sessions.get("session-node-0")!.terminal = true;
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(0);
});

// ---------------- F2: lease takeover independent of unrelated legacy tasks ----------------
test("F2 expired lease takeover never lists unrelated legacy stop tasks (no authority / reused id)", async () => {
	const f = fixture(1);
	const legacy = addTask(f.store, f.node, f.dir, 1, { authority: false });
	f.store.claimOperation(legacy.id, "stop", { session_id: legacy.sessionId!, allow_mutation: true, reason: "Fleet task execution settled" });
	const reused = addTask(f.store, f.node, f.dir, 2);
	f.store.claimOperation(reused.id, "stop", { session_id: reused.sessionId!, allow_mutation: true, reason: "Fleet task execution settled" });
	const b = broker(f.store);
	b.sessions.get(reused.sessionId!)!.inc = FOREIGN;
	b.sessions.get("session-node-0")!.live = false; b.sessions.get("session-node-0")!.terminal = true;
	expireLease(f.path);
	expect(await returnResources(f.store, [f.ids[0]!], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: f.ids[0]!, state: "returned" }]);
	expect(b.listed.every(s => s === "session-node-0")).toBe(true);
	expect(f.store.resourceReturnNode("node")).toBeNull();
	// The un-provable legacy tasks themselves are reported per task, without blocking the node.
	const r = await returnResources(f.store, [legacy.id, reused.id], { connect: b.connect, paceMs: 0 });
	expect(r).toEqual([{ taskId: legacy.id, state: "refused", reason: "original_session_authority_missing", refusal: "authority_missing" }, { taskId: reused.id, state: "not_ours", reason: "session_id_reused_by_foreign_incarnation" }]);
	expect(b.closes).toHaveLength(0);
	expect(f.store.resourceReturnNode("node")).toBeNull();
});

// ---------------- F3: pre-existing stop claims are reconcilable; operator override ----------------
test("F3 stop claim (as created by `fleet stop`) reconciles on fresh absence or exact terminal row, once", async () => {
	const f = fixture(2);
	const [a, c] = f.ids as [string, string];
	for (const id of f.ids) f.store.claimOperation(id, "stop", { session_id: f.store.task(id)!.sessionId!, allow_mutation: true, reason: "Fleet task execution settled" });
	const b = broker(f.store);
	b.sessions.delete("session-node-0");
	b.sessions.get("session-node-1")!.live = false; b.sessions.get("session-node-1")!.terminal = true;
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 })).map(x => x.state)).toEqual(["returned", "returned"]);
	expect((f.store.getOperation(a, "resource-return-confirmed")!.payload as any).stopOperationId).toBe(f.store.getOperation(a, "stop")!.id);
	expect((f.store.getOperation(a, "resource-return-confirmed")!.payload as any).observed).toBe("absent");
	expect((f.store.getOperation(c, "resource-return-confirmed")!.payload as any).observed).toBe("terminal");
	expect(b.closes).toHaveLength(0);
	expect(audits(f.path, "released", "resource_return_confirmed")).toBe(2);
	await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 });
	expect(audits(f.path, "released")).toBe(2);
});

test("F3 stop claim with the exact incarnation still live is closed through the fence, never by replaying the stop", async () => {
	const f = fixture();
	f.store.claimOperation(f.ids[0]!, "stop", { session_id: "session-node-0", allow_mutation: true, reason: "Fleet task execution settled" });
	const b = broker(f.store);
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("returned");
	expect(b.closes).toHaveLength(1);
	expect(b.closes[0]!.incarnation).toBe(INC);
});

test("F3 audited operator release of an unprovable reservation happens exactly once and is never reported returned", async () => {
	const f = fixture();
	const id = f.ids[0]!;
	const b = broker(f.store);
	b.sessions.get("session-node-0")!.inc = FOREIGN;
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("not_ours");
	await expect(operatorReleaseResource(f.store, id, { operator: "", reason: "x" }, { connect: b.connect })).rejects.toThrow();
	await expect(operatorReleaseResource(f.store, id, { operator: "ops", reason: "" }, { connect: b.connect })).rejects.toThrow();
	expect((await operatorReleaseResource(f.store, id, { operator: "ops", reason: "session id reused; original host retired by hand" }, { connect: b.connect })).state).toBe("released_by_operator_unconfirmed");
	expect(f.store.task(id)!.held).toBe(false);
	expect(audits(f.path, "released", "resource_return_operator_override")).toBe(1);
	const override = f.store.getOperation(id, "resource-return-override")!.payload as any;
	expect(override).toMatchObject({ operator: "ops", reason: "session id reused; original host retired by hand", sessionId: "session-node-0", observedGone: false, freshListing: { kind: "foreign_incarnation" } });
	await expect(operatorReleaseResource(f.store, id, { operator: "ops", reason: "again" }, { connect: b.connect })).rejects.toThrow("Return already settled");
	expect((await returnResources(f.store, [id], { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: id, state: "released_by_operator_unconfirmed", reason: "session_not_observed_gone" });
	expect(b.closes).toHaveLength(0);
	expect(audits(f.path, "released")).toBe(1);
	// Not for a released reservation or a non-terminal attempt.
	const g = fixture(1, { defer: false });
	expect(() => g.store.overrideResourceReturn(g.ids[0]!, { operator: "ops", reason: "r" }, { kind: "unavailable", error: "x" })).toThrow("Reservation is not held");
});

test("F3 operator CLI: return-override and return-unblock are audited; return runs the fenced pass", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fenced-cli-"))); dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	// A stand-in public SDK CLI: session.list answers "absent" for every session.
	const fakeSdk = join(dir, "fake-sdk.ts");
	writeFileSync(fakeSdk, `const input=await new Response(Bun.stdin.stream()).text();const op=process.argv[process.argv.indexOf("--op")+1];if(op!=="session.list"){console.log(JSON.stringify({schema:"gjc.command-error",ok:false,error:{code:"unexpected"}}));process.exit(1)}console.log(JSON.stringify({type:"broker_response",ok:true,result:{indexSeq:1,sessions:[]}}));`);
	const store = new FleetStore(path, 100, { deferTerminalRelease: true }); stores.push(store);
	const n = { ...nodeConfig(dir), sdkTransport: { command: process.execPath, args: [fakeSdk] } };
	store.putNode(n);
	const t0 = addTask(store, n, dir, 0), t1 = addTask(store, n, dir, 1);
	store.blockResourceReturnNode("node", t0.id, "op", "lifecycle_legacy_history_ambiguous");
	const file = join(dir, "override.json");
	writeFileSync(file, JSON.stringify({ operator: "ops", reason: "foreign reuse proven by hand" }));
	store.close();
	const out: string[] = [];
	const log = console.log; console.log = (v: unknown) => { out.push(String(v)); };
	try {
		// The override's own fresh listing shows the session gone: return records that, not an override.
		await expect(cli(["--db", path, "--cap", "100", "return-override", t0.id, file])).rejects.toThrow("run return");
		expect(await cli(["--db", path, "--cap", "100", "return-unblock", "node", file])).toBe(0);
		expect(await cli(["--db", path, "--cap", "100", "return", t0.id, t1.id])).toBe(0);
		await expect(cli(["--db", path, "--cap", "100", "--read-only", "return-override", t1.id, file])).rejects.toThrow("READ_ONLY");
	} finally { console.log = log; }
	expect(JSON.parse(out[0]!)).toEqual({ ok: true, nodeId: "node", unblocked: true });
	expect(JSON.parse(out[1]!)).toEqual([{ taskId: t0.id, state: "returned" }, { taskId: t1.id, state: "returned" }]);
	const reopened = new FleetStore(path, 100, { deferTerminalRelease: true }); stores.push(reopened);
	expect(reopened.task(t0.id)!.held).toBe(false);
	expect(reopened.task(t1.id)!.held).toBe(false);
	expect(reopened.resourceReturnNodeBlock("node")).toBeUndefined();
	expect(audits(path, "resource_return_operator_override")).toBe(0);
	expect(audits(path, "resource_return_node_unblocked")).toBe(1);
	expect(audits(path, "released")).toBe(2);
});

// ---------------- F4: live:false without terminal:true is not proof ----------------
test("F4 live:false with terminal:false is unproven: reservation retained, no close", async () => {
	const f = fixture();
	const b = broker(f.store);
	b.sessions.get("session-node-0")!.live = false;
	expect((await returnResources(f.store, f.ids, { connect: b.connect, paceMs: 0 }))[0]).toEqual({ taskId: f.ids[0]!, state: "return_unknown", reason: "host_liveness_unproven" });
	expect(f.store.task(f.ids[0]!)!.held).toBe(true);
	expect(b.closes).toHaveLength(0);
	expect(audits(f.path, "released")).toBe(0);
});

// ---------------- F5: Clawhip collect in deferred mode ----------------
test("F5 deferred mode permits fresh Clawhip collect of a settled task, same as default mode", async () => {
	const outcome: Record<string, string> = {};
	for (const defer of [false, true]) {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "fenced-clawhip-"))); dirs.push(root);
		const fleetDb = join(root, "fleet.sqlite");
		const store = new FleetStore(fleetDb, 2, { deferTerminalRelease: defer }); stores.push(store);
		store.putNode({ id: "node", os: process.platform, arch: process.arch, roots: { repo: root }, workspaceRoot: join(root, "workspaces"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["controlled"], transport: { command: "must-not-execute", args: [] }, operations: ["read", "write"] });
		const task = new Fleet(store).submit({ schemaVersion: 1, key: "t", caller: "rr", repoId: "repo", baseCommit: "a".repeat(40), prompt: "x", required: { model: "controlled", operations: ["write"] } }, headroom(["node"], 2));
		const THREAD = "1569213398762131521";
		const control = new ClawhipControl(join(root, "control.sqlite"), { thread: THREAD, fleetDb }, true); stores.push(control);
		const start: ControlCommand = { schema: 1, thread: THREAD, key: "start-1", action: "start", binding: controlBinding(task), testArgv: null };
		control.ingest({ command_ref: control.stage(start, store).command_ref });
		const executor = {
			async start(id: string) {
				store.recordSession(id, "s", true); store.recordTurn(id, "t");
				const body = { sessionId: "s", turnId: "t", status: "active" as const, terminal: false, evidence: { i: true } };
				return store.observe(id, { ...body, eventId: "a", digest: observationDigest(body) });
			},
			async inspect(id: string) { return { task: store.task(id)! }; },
			async result() { return { injected: true } as any; },
		};
		await control.run(start.key, store, executor as any, 500);
		// Unsettled in either mode: still observation only.
		const early: ControlCommand = { schema: 1, thread: THREAD, key: "collect-0", action: "collect", binding: control.binding(task.id, store), testArgv: [process.execPath, "verify.ts"] };
		expect(() => control.stage(early, store)).toThrow("Unsettled execution; observation only");
		const body = { sessionId: "s", turnId: "t", status: "completed_unverified" as const, terminal: true, evidence: { i: true, settled: true } };
		store.observe(task.id, { ...body, eventId: "z", digest: observationDigest(body) });
		expect(store.task(task.id)!.held).toBe(defer);
		const collect: ControlCommand = { schema: 1, thread: THREAD, key: "collect-1", action: "collect", binding: control.binding(task.id, store), testArgv: [process.execPath, "verify.ts"] };
		try { control.stage(collect, store); outcome[String(defer)] = "staged"; } catch (e) { outcome[String(defer)] = (e as Error).message; }
	}
	expect(outcome).toEqual({ false: "staged", true: "staged" });
});

// ---------------- F6: mutation exclusion is the per-task durable claim, not the wall clock ----------------
test("F6 a clock-skewed successor that takes over a live owner's lease cannot dispatch a second close", async () => {
	const f = fixture(1);
	const id = f.ids[0]!;
	const log = join(f.dir, "closes.log");
	const closed = join(f.dir, "closed.marker");
	const mk = (name: string, skew: number, listDelay: number) => {
		const p = join(f.dir, name + ".ts");
		writeFileSync(p, `const real=Date.now.bind(Date);Date.now=()=>real()+${skew};import {FleetStore} from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};import {returnResources} from ${JSON.stringify(join(import.meta.dir, "../src/resource-return.ts"))};import {appendFileSync,existsSync,writeFileSync} from 'node:fs';const s=new FleetStore(${JSON.stringify(f.path)},100,{deferTerminalRelease:true});const t=s.task(${JSON.stringify(id)});let seq=0;const out=await returnResources(s,[t.id],{paceMs:0,connect:async()=>({list:async()=>{await Bun.sleep(${listDelay});const gone=existsSync(${JSON.stringify(closed)});return {type:'broker_response',ok:true,result:{indexSeq:++seq,sessions:[{sessionId:t.sessionId,locator:{cwd:t.workspace.path},endpointGeneration:1,endpointIncarnation:${JSON.stringify(INC)},live:!gone,terminal:gone,ambiguous:false,terminalUncertain:false}]}}},fencedClose:async(a,k)=>{appendFileSync(${JSON.stringify(log)},'${name}:'+k+'\\n');await Bun.sleep(600);writeFileSync(${JSON.stringify(closed)},'1');return {ok:true,operation:'session.close',result:{sessionId:a.sessionId}}},close(){}})});console.log(JSON.stringify(out));s.close();`);
		return p;
	};
	const a = Bun.spawn([process.execPath, mk("ownerA", 0, 50)], { stdout: "pipe", stderr: "pipe" });
	for (let i = 0; i < 300 && !existsSync(log); i++) await Bun.sleep(10);
	expect(existsSync(log)).toBe(true); // A is inside its close
	const b = Bun.spawn([process.execPath, mk("skewB", 200000, 5)], { stdout: "pipe", stderr: "pipe" });
	const [ra, rb] = await Promise.all([a, b].map(async k => ({ exit: await k.exited, out: await new Response(k.stdout).text(), err: await new Response(k.stderr).text() })));
	expect([ra!.exit, rb!.exit]).toEqual([0, 0]);
	expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
	expect(JSON.parse(ra!.out)[0].state).toBe("returned");
	expect(["return_unknown", "returned"]).toContain(JSON.parse(rb!.out)[0].state);
	expect(audits(f.path, "released", "resource_return_confirmed")).toBe(1);
});

// ---------------- F7 / F8 ----------------
test("F7 connecting never spawns the coordinator transport; F8 read-only store reads the lease without writing", async () => {
	const f = fixture();
	const marker = join(f.dir, "coordinator-spawned");
	const coordinator = join(f.dir, "coordinator.sh");
	writeFileSync(coordinator, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`); chmodSync(coordinator, 0o755);
	const connection = await connectResourceReturn({ ...f.node, transport: { command: coordinator, args: [] } });
	connection.close();
	await Bun.sleep(100);
	expect(existsSync(marker)).toBe(false);
	f.store.close();
	const ro = new FleetStore(f.path, 100, { readOnly: true }); stores.push(ro);
	expect(ro.resourceReturnNode("node")).toBeNull();
	expect(ro.resourceReturnNodeBlock("node")).toBeUndefined();
});

// ---------------- Real installed CLI against a throwaway broker ----------------
// Only when GJC_BIN points at an installed binary: never default to a personal path
// (that path leaks host identity and makes verify host-dependent).
const GJC = process.env.GJC_BIN ?? "";
test.skipIf(!GJC || !existsSync(GJC))("real gjc: exact-authority idle close returns the session; a wrong incarnation is endpoint_stale and stays live", async () => {
	const agent = realpathSync(mkdtempSync(join(tmpdir(), "fenced-agent-"))); dirs.push(agent);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "fenced-real-"))); dirs.push(root);
	const wrapper = join(root, "gjc-isolated.sh");
	writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(GJC)} "$@" --agent-dir ${JSON.stringify(agent)}\n`); chmodSync(wrapper, 0o755);
	async function gjc(input: unknown, ...args: string[]) {
		// Throwaway --agent-dir brokers must be allowed to autostart. An inherited
		// GJC_SDK_BROKER_AUTOSTART=0 from the verify host (list/archive guards) makes
		// session.create exit 1 for A+B and N1 alike — clear it for this real-CLI path.
		const env = { ...process.env };
		delete env.GJC_SDK_BROKER_AUTOSTART;
		const child = Bun.spawn([wrapper, ...args, "--json"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
		child.stdin.write(JSON.stringify(input)); child.stdin.end();
		const [out, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { exit, value: JSON.parse(out) };
	}
	const created: { sessionId: string; endpointGeneration: number; endpointIncarnation: string; cwd: string }[] = [];
	try {
		for (const name of ["own", "foreign"]) {
			const cwd = join(root, name);
			Bun.spawnSync(["mkdir", "-p", cwd]); Bun.spawnSync(["git", "init", "-q"], { cwd });
			const c = await gjc({ cwd }, "sdk", "session", "raw", "global", "--op", "session.create", "--idempotency-key", `fenced-create-${name}-${Date.now()}`, "--json-input-stdin");
			expect(c.exit).toBe(0);
			created.push({ ...c.value.result, cwd });
		}
		const dbDir = realpathSync(mkdtempSync(join(tmpdir(), "fenced-db-"))); dirs.push(dbDir);
		const store = new FleetStore(join(dbDir, "fleet.sqlite"), 100, { deferTerminalRelease: true }); stores.push(store);
		const n: NodeConfig = { ...nodeConfig(root), transport: { command: join(root, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: wrapper, args: [] } };
		store.putNode(n);
		const own = addTask(store, n, root, 0, { cwd: created[0]!.cwd, sessionId: created[0]!.sessionId, generation: created[0]!.endpointGeneration, incarnation: created[0]!.endpointIncarnation });
		// Recorded authority deliberately differs from the live host: the broker must refuse it.
		const foreign = addTask(store, n, root, 1, { cwd: created[1]!.cwd, sessionId: created[1]!.sessionId, generation: created[1]!.endpointGeneration, incarnation: FOREIGN });
		const before = await gjc({ resolveSessionId: created[1]!.sessionId }, "sdk", "session", "raw", "global", "--op", "session.list", "--json-input-stdin", "--attach-only", "--page", "--limit", "2");
		expect(before.value.result.sessions[0].endpointIncarnation).not.toBe(FOREIGN);
		// Force the close path for the mismatched task: present the listing as the recorded incarnation.
		const real = await connectResourceReturn(n);
		// Only the first listing is presented; the re-list after endpoint_stale is the real one.
		let presented = false;
		const presenting: ReturnConnection = { ...real, async list(id) { const v: any = await real.list(id); if (id === created[1]!.sessionId && !presented) { presented = true; for (const s of v.result.sessions) s.endpointIncarnation = FOREIGN; } return v; } };
		const report = await returnResources(store, [own.id, foreign.id], { paceMs: 0, connect: async () => presenting });
		expect(report).toEqual([{ taskId: own.id, state: "returned" }, { taskId: foreign.id, state: "not_ours", reason: "endpoint_stale_incarnation_not_owned" }]);
		const ownAfter = await gjc({ resolveSessionId: created[0]!.sessionId }, "sdk", "session", "raw", "global", "--op", "session.list", "--json-input-stdin", "--attach-only", "--page", "--limit", "2");
		expect(ownAfter.value.result.sessions[0]).toMatchObject({ live: false, terminal: true, endpointIncarnation: created[0]!.endpointIncarnation });
		const foreignAfter = await gjc({ resolveSessionId: created[1]!.sessionId }, "sdk", "session", "raw", "global", "--op", "session.list", "--json-input-stdin", "--attach-only", "--page", "--limit", "2");
		expect(foreignAfter.value.result.sessions[0]).toMatchObject({ live: true, terminal: false });
		expect(store.task(own.id)!.held).toBe(false);
		expect(store.task(foreign.id)!.held).toBe(true);
		expect(existsSync(join(root, "coordinator-must-not-spawn"))).toBe(false);
	} finally {
		// Cleanup of the throwaway broker's sessions through the same exact fence.
		for (const s of created) await gjc({ sessionId: s.sessionId, endpointGeneration: s.endpointGeneration, endpointIncarnation: s.endpointIncarnation }, "sdk", "session", "raw", "global", "--op", "session.close", "--idempotency-key", `fenced-cleanup-${s.sessionId}`, "--json-input-stdin", "--attach-only");
	}
}, 180000);
