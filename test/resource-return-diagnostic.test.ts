// Every resource-return / operator-release / unblock catch site that turns an error into a
// recorded unknown/blocked/refused outcome carries a deny-by-default diagnostic, and the
// reported outcome (state, reason, report objects, holds, claims) is exactly what base reports.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { FleetError, observationDigest } from "../src/core";
import { sha256 } from "../src/workspace";
import { TransportError } from "../src/rpc";
import { DIAGNOSTIC_TEXT } from "../src/diagnostic";
import { operatorReleaseResource, returnResources, type ReturnConnection } from "../src/resource-return";
import type { NodeConfig, SessionAuthority } from "../src/contracts";

const INC = "b".repeat(64);
const SECRET = "C:\\Users\\alice\\.ssh\\id_rsa token=ghp_ABCDEFGHIJKLMNOP build01.corp.example.com";
const LEAKS = ["alice", "id_rsa", "ghp_", "build01", "corp.example"];
const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) { try { s.close(); } catch {} }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "return-diagnostic-"))); dirs.push(dir);
	const store = new FleetStore(join(dir, "fleet.sqlite"), 100, { deferTerminalRelease: true }); stores.push(store);
	const node: NodeConfig = { id: "node", os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: process.execPath, args: [] } };
	store.putNode(node);
	const task = store.reserve(store.submit({ schemaVersion: 1, key: "task", caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
	const path = join(node.workspaceRoot, task.id + "-" + task.attemptId);
	const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: node.id, inputDigest: task.inputDigest, path, repo: dir, baseCommit: "a".repeat(40) };
	store.setWorkspace(task.id, identity);
	const create = store.claimOperation(task.id, "create", { cwd: path })!;
	store.recordSession(task.id, "session", true, { operationId: create.id, ephemeral: true, cwd: path });
	store.recordSessionAuthority(task.id, { sessionId: "session", cwd: path, endpointGeneration: 1, endpointIncarnation: INC });
	store.recordTurn(task.id, "turn");
	const body = { sessionId: "session", turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(task.id, { eventId: "terminal", digest: observationDigest(body), ...body });
	store.saveResult(task.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" });
	return { store, id: task.id, path, db: join(dir, "fleet.sqlite") };
}
/** A live exact session; each hook may replace one call. */
function port(f: { path: string }, hooks: Partial<ReturnConnection> = {}): ReturnConnection {
	let seq = 0;
	return {
		async list(sessionId) {
			return { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: [{ sessionId, locator: { cwd: f.path }, endpointGeneration: 1, endpointIncarnation: INC, live: true, terminal: false, ambiguous: false, terminalUncertain: false, activity: { state: "idle" } }] } };
		},
		async fencedClose(_authority: SessionAuthority, _key: string) { return { ok: true, operation: "session.close", result: { sessionId: "session" } }; },
		close() {},
		...hooks,
	};
}
function lastEvent(store: FleetStore, id: string, kind: string) {
	return store.events(id).findLast((e) => e.kind === kind)!;
}
const expected = (source: string, phase: string, errorClass: string, code: string, operation?: { kind: string; id: string }) => ({
	version: 1, use: "diagnostic_only_not_evidence", source, phase,
	...(operation ? { operationKind: operation.kind, operationId: operation.id } : {}),
	errorClass, code, message: DIAGNOSTIC_TEXT.get(code)!,
});
function noLeak(value: unknown) {
	for (const leak of LEAKS) expect(JSON.stringify(value)).not.toContain(leak);
}

test("fenced close throws without a public answer: return_unknown keeps its reason and records the close call step", async () => {
	for (const [error, errorClass, code] of [
		[new TransportError("execution_query_timeout", "unknown", SECRET), "TransportError", "transport:execution_query_timeout"],
		[new Error(SECRET), "Error", "unclassified"],
	] as const) {
		const f = fixture();
		const r = await returnResources(f.store, [f.id], { connect: async () => port(f, { async fencedClose() { throw error; } }), paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" }]);
		const claim = f.store.getOperation(f.id, "resource-return-close:1")!;
		expect(claim.receipt).toBeUndefined();
		expect(f.store.task(f.id)!.held).toBe(true);
		const event = lastEvent(f.store, f.id, "resource_return_unknown");
		expect(event.data).toMatchObject({ reason: "close_outcome_unknown_no_replay", physicalState: "unknown", replay: false, detail: null });
		expect((event.data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "call", errorClass, code, { kind: "resource-return-close", id: claim.id }));
		noLeak(event);
	}
});

test("listing, validation and connection failures in the pass record the failing step", async () => {
	const cases: [string, Partial<ReturnConnection> | "connect", string, string, string, string][] = [
		["list throws", { async list() { throw new TransportError("invalid_public_sdk_response", "unknown", SECRET); } }, "ResourceReturn.list", "call", "TransportError", "transport:invalid_public_sdk_response"],
		["list invalid", { async list() { return { type: "broker_response", ok: true, result: { indexSeq: 1, sessions: [{ sessionId: "other" }] }, secret: SECRET }; } }, "ResourceReturn.list", "validate", "FleetError", "fleet:return_list_invalid"],
		["connect throws", "connect", "ResourceReturn.connect", "call", "Error", "unclassified"],
	];
	for (const [name, hooks, source, phase, errorClass, code] of cases) {
		const f = fixture();
		const connect = hooks === "connect" ? async () => { throw new Error(SECRET); } : async () => port(f, hooks);
		const r = await returnResources(f.store, [f.id], { connect, paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "fresh_authoritative_observation_unavailable_no_replay" }]);
		expect(f.store.getOperation(f.id, "resource-return-close:1")).toBeUndefined();
		const event = lastEvent(f.store, f.id, "resource_return_unknown");
		expect((event.data as any).reason).toBe("fresh_authoritative_observation_unavailable_no_replay");
		expect([name, (event.data as any).failureDiagnostic]).toEqual([name, expected(source, phase, errorClass, code)]);
		noLeak(event);
	}
});

test("an expired lease before a new close records the close precondition step", async () => {
	const f = fixture();
	f.store.renewResourceReturnNode = () => false;
	const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
	expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "fresh_authoritative_observation_unavailable_no_replay" }]);
	expect((lastEvent(f.store, f.id, "resource_return_unknown").data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "precondition", "FleetError", "fleet:return_lease_lost"));
});

test("a block written between the check and the claim: blocked outcome records the claim step; the store refusal records its own", async () => {
	const f = fixture();
	const claim = f.store.claimResourceReturnClose.bind(f.store);
	f.store.claimResourceReturnClose = (...args) => {
		f.store.blockResourceReturnNode("node", f.id, "11111111-2222-4333-8444-555555555555", "lifecycle_legacy_history_ambiguous");
		return claim(...args);
	};
	const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
	expect(r).toEqual([{ taskId: f.id, state: "return_blocked_by_node", reason: "lifecycle_legacy_history_ambiguous" }]);
	expect(f.store.getOperation(f.id, "resource-return-close:1")).toBeUndefined();
	const unknown = lastEvent(f.store, f.id, "resource_return_unknown");
	expect((unknown.data as any).reason).toBe("node_blocked_by_lifecycle_legacy_history_ambiguous");
	expect((unknown.data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "claim", "FleetError", "fleet:return_node_blocked"));
	const refused = lastEvent(f.store, f.id, "refused");
	expect(refused.data).toMatchObject({ action: "claimResourceReturnClose", code: "RETURN_NODE_BLOCKED" });
	expect((refused.data as any).failureDiagnostic).toEqual(expected("Store.transaction", "record", "FleetError", "fleet:return_node_blocked"));
	// main's own block record keeps its string `diagnostic` field (review I-3): a different field name.
	const blocked = lastEvent(f.store, f.id, "resource_return_blocked_by_node");
	expect((blocked.data as any).diagnostic).toBe("lifecycle_legacy_history_ambiguous");
	expect(blocked.data).not.toHaveProperty("failureDiagnostic");
});

test("operator release with a failing listing keeps main's listing error and records a deny-by-default diagnostic", async () => {
	const cases: [string, () => Promise<ReturnConnection>, string, string, string, string, string][] = [
		["connect throws Error", async () => { throw new Error(SECRET); }, "listing_failed", "ResourceReturn.connect", "call", "Error", "unclassified"],
		["list throws TransportError", async () => ({ ...port({ path: "" }), async list() { throw new TransportError("execution_query_timeout", "unknown", SECRET); } }), "execution_query_timeout", "ResourceReturn.release_listing", "call", "TransportError", "transport:execution_query_timeout"],
	];
	for (const [name, connect, listingError, source, phase, errorClass, code] of cases) {
		const f = fixture();
		const release = await operatorReleaseResource(f.store, f.id, { operator: "ops", reason: "node unreachable" }, { connect });
		expect(release).toMatchObject({ taskId: f.id, state: "released_by_operator_unconfirmed", observedGone: false });
		expect((release.override as any).freshListing).toEqual({ kind: "unavailable", error: listingError });
		expect(release.override).not.toHaveProperty("failureDiagnostic");
		const event = lastEvent(f.store, f.id, "resource_return_operator_override");
		expect((event.data as any).freshListing).toEqual({ kind: "unavailable", error: listingError });
		expect([name, (event.data as any).failureDiagnostic]).toEqual([name, expected(source, phase, errorClass, code)]);
		noLeak(event);
	}
	// A successful listing adds nothing.
	const f = fixture();
	// The fixture session is exact, live and idle: a tried (busy-refused) close must exist before an override.
	const r = await returnResources(f.store, [f.id], { connect: async () => port(f, { async fencedClose() { throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", "refused", { ok: false, error: { code: "busy" } }); } }), paceMs: 0 });
	expect(r[0]!.state).toBe("session_busy");
	await operatorReleaseResource(f.store, f.id, { operator: "ops", reason: "operator decision" }, { connect: async () => port(f) });
	expect(lastEvent(f.store, f.id, "resource_return_operator_override").data).not.toHaveProperty("failureDiagnostic");
});

test("refused unblock and override record the store refusal diagnostic", async () => {
	const f = fixture();
	expect(() => f.store.clearResourceReturnNodeBlock("node", { operator: "ops", reason: "x" })).toThrow(FleetError);
	const db = new Database(f.db, { readonly: true });
	const row = db.query<{ data: string }, []>("SELECT data FROM audit WHERE kind='refused' AND task_id IS NULL ORDER BY sequence DESC LIMIT 1").get()!;
	db.close();
	const refused = { data: JSON.parse(row.data) };
	expect(refused.data).toMatchObject({ action: "clearResourceReturnNodeBlock", code: "RETURN_NOT_BLOCKED" });
	expect((refused.data as any).failureDiagnostic).toEqual(expected("Store.transaction", "record", "FleetError", "fleet:return_not_blocked"));
	expect(() => f.store.overrideResourceReturn(f.id, { operator: "ops", reason: "x" }, { kind: "exact_live", indexSeq: 1, activity: "busy" })).toThrow("possibly running");
	const override = lastEvent(f.store, f.id, "refused");
	expect(override.data).toMatchObject({ action: "overrideResourceReturn", code: "OVERRIDE_SESSION_RUNNING" });
	expect((override.data as any).failureDiagnostic).toEqual(expected("Store.transaction", "record", "FleetError", "fleet:override_session_running"));
});

// Review L-2: the fenced-close catch's second branch (a TransportError carrying a public answer)
// and the answer classes that follow it. Two settled tasks on one node, so the stopped pass runs too.
function pair() {
	const f = fixture();
	const dir = join(f.db, "..");
	const node = { id: "node", workspaceRoot: join(dir, "work"), roots: { repo: dir } };
	const second = f.store.reserve(f.store.submit({ schemaVersion: 1, key: "task-2", caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
	const path = join(node.workspaceRoot, second.id + "-" + second.attemptId);
	const identity = { schemaVersion: 1, taskId: second.id, attemptId: second.attemptId!, nodeId: node.id, inputDigest: second.inputDigest, path, repo: node.roots.repo!, baseCommit: "a".repeat(40) };
	f.store.setWorkspace(second.id, identity);
	const create = f.store.claimOperation(second.id, "create", { cwd: path })!;
	f.store.recordSession(second.id, "session-2", true, { operationId: create.id, ephemeral: true, cwd: path });
	f.store.recordSessionAuthority(second.id, { sessionId: "session-2", cwd: path, endpointGeneration: 1, endpointIncarnation: INC });
	f.store.recordTurn(second.id, "turn-2");
	const body = { sessionId: "session-2", turnId: "turn-2", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	f.store.observe(second.id, { eventId: "terminal-2", digest: observationDigest(body), ...body });
	f.store.saveResult(second.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" });
	const paths = new Map([["session", f.path], ["session-2", path]]);
	let seq = 0;
	const live = (fencedClose: ReturnConnection["fencedClose"]): ReturnConnection => ({
		async list(sessionId) {
			return { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: [{ sessionId, locator: { cwd: paths.get(sessionId) }, endpointGeneration: 1, endpointIncarnation: INC, live: true, terminal: false, ambiguous: false, terminalUncertain: false, activity: { state: "idle" } }] } };
		},
		fencedClose,
		close() {},
	});
	return { ...f, second: second.id, live };
}
const refusedWith = (answer: unknown) => async () => { throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", SECRET, answer); };
const answeredWith = (answer: unknown) => async () => answer;

test("review L-2: a thrown public answer that ends unknown or node-blocked records the close call step, also for the stopped rest of the pass", async () => {
	const cases: [string, unknown, string, string, string][] = [
		["unclassified refusal", { ok: false, error: { code: "weird_refusal", message: SECRET } }, "return_unknown", "close_outcome_unknown_no_replay", "unclassified_close_refusal"],
		["legacy refusal", { ok: false, error: { code: "legacy_lifecycle_ambiguous", message: SECRET } }, "return_blocked_by_node", "lifecycle_legacy_history_ambiguous", "lifecycle_legacy_history_ambiguous"],
		["suspect legacy refusal", { ok: false, error: { code: "operation_failed", outcomeCertainty: "unknown", message: SECRET } }, "return_blocked_by_node", "unclassified_operation_failed_possible_legacy_history", "unclassified_operation_failed_possible_legacy_history"],
	];
	for (const [name, answer, state, reason, stoppedBy] of cases) {
		const f = pair();
		const r = await returnResources(f.store, [f.id, f.second], { connect: async () => f.live(refusedWith(answer)), paceMs: 0 });
		expect<unknown>([name, r]).toEqual([name, [
			{ taskId: f.id, state, reason },
			{ taskId: f.second, state, reason: state === "return_unknown" ? "node_pass_stopped_by_unclassified_close_refusal" : stoppedBy },
		]]);
		const claim = f.store.getOperation(f.id, "resource-return-close:1")!;
		expect(claim.receipt).toEqual(answer as any);
		expect(f.store.getOperation(f.second, "resource-return-close:1")).toBeUndefined();
		const want = expected("ResourceReturn.close", "call", "TransportError", "transport:execution_query_failed", { kind: "resource-return-close", id: claim.id });
		const first = lastEvent(f.store, f.id, state === "return_unknown" ? "resource_return_unknown" : "resource_return_blocked_by_node");
		if (state === "return_unknown") expect((first.data as any).reason).toBe(reason);
		else expect(first.data).toMatchObject({ nodeId: "node", diagnostic: reason, taskId: f.id, operationId: claim.id, applied: false });
		expect([name, (first.data as any).failureDiagnostic]).toEqual([name, want]);
		const rest = lastEvent(f.store, f.second, "resource_return_unknown");
		expect((rest.data as any).reason).toBe(`node_pass_stopped_by_${stoppedBy}`);
		expect([name, (rest.data as any).failureDiagnostic]).toEqual([name, want]);
		// The persisted node block itself is unchanged: string diagnostic only.
		if (state !== "return_unknown") expect(Object.keys(f.store.resourceReturnNodeBlock("node")!).sort()).toEqual(["at", "diagnostic", "operationId", "taskId"]);
		noLeak(first); noLeak(rest);
	}
});

test("review L-2 audit: a returned (not thrown) answer that ends unknown or node-blocked records a condition at the close validate step", async () => {
	const cases: [string, unknown, string, string, string, string][] = [
		["unclassified answer", { ok: false, error: { code: "weird_refusal", message: SECRET } }, "return_unknown", "close_outcome_unknown_no_replay", "node_pass_stopped_by_unclassified_close_refusal", "condition:close_answer_unclassified"],
		["wrong session acknowledged", { ok: true, operation: "session.close", result: { sessionId: "other" } }, "return_unknown", "close_outcome_unknown_no_replay", "node_pass_stopped_by_unclassified_close_refusal", "condition:close_answer_unclassified"],
		["legacy answer", { ok: false, error: { code: "legacy_lifecycle_ambiguous" } }, "return_blocked_by_node", "lifecycle_legacy_history_ambiguous", "lifecycle_legacy_history_ambiguous", "condition:close_answer_legacy_refusal"],
	];
	for (const [name, answer, state, reason, secondReason, code] of cases) {
		const f = pair();
		const r = await returnResources(f.store, [f.id, f.second], { connect: async () => f.live(answeredWith(answer)), paceMs: 0 });
		expect<unknown>([name, r]).toEqual([name, [{ taskId: f.id, state, reason }, { taskId: f.second, state, reason: secondReason }]]);
		const claim = f.store.getOperation(f.id, "resource-return-close:1")!;
		const want = expected("ResourceReturn.close", "validate", "none", code, { kind: "resource-return-close", id: claim.id });
		const first = lastEvent(f.store, f.id, state === "return_unknown" ? "resource_return_unknown" : "resource_return_blocked_by_node");
		expect([name, (first.data as any).failureDiagnostic]).toEqual([name, want]);
		expect([name, (lastEvent(f.store, f.second, "resource_return_unknown").data as any).failureDiagnostic]).toEqual([name, want]);
		noLeak(first);
	}
});

test("review L-2 audit: answers that settle, refuse busy or re-list carry no diagnostic (no error or refusal became unknown)", async () => {
	const f = pair();
	const r = await returnResources(f.store, [f.id], { connect: async () => f.live(refusedWith({ ok: false, error: { code: "busy" } })), paceMs: 0 });
	expect(r).toEqual([{ taskId: f.id, state: "session_busy", reason: "session_not_idle" }]);
	expect(lastEvent(f.store, f.id, "resource_return_session_busy").data).not.toHaveProperty("failureDiagnostic");
});

test("review L-2 audit: an endpoint_stale answer whose exact incarnation stays listed ends unknown with the answer's diagnostic", async () => {
	for (const [name, close, phase, errorClass, code] of [
		["thrown", refusedWith({ ok: false, error: { code: "endpoint_stale", message: SECRET } }), "call", "TransportError", "transport:execution_query_failed"],
		["returned", answeredWith({ ok: false, error: { code: "endpoint_stale" } }), "validate", "none", "condition:close_answer_endpoint_stale"],
	] as const) {
		const f = pair();
		const r = await returnResources(f.store, [f.id], { connect: async () => f.live(close), paceMs: 0 });
		expect([name, r]).toEqual([name, [{ taskId: f.id, state: "return_unknown", reason: "endpoint_stale_exact_incarnation_still_listed" }]]);
		const claim = f.store.getOperation(f.id, "resource-return-close:1")!;
		const event = lastEvent(f.store, f.id, "resource_return_unknown");
		expect((event.data as any).reason).toBe("endpoint_stale_exact_incarnation_still_listed");
		expect([name, (event.data as any).failureDiagnostic]).toEqual([name, expected("ResourceReturn.close", phase, errorClass, code, { kind: "resource-return-close", id: claim.id })]);
		noLeak(event);
	}
});

test("audit: Fleet's own no-replay refusals before a close record a condition naming the retained close", async () => {
	// A prior close whose outcome is unknown is never replayed.
	{
		const f = fixture();
		await returnResources(f.store, [f.id], { connect: async () => port(f, { async fencedClose() { throw new Error(SECRET); } }), paceMs: 0 });
		const prior = f.store.getOperation(f.id, "resource-return-close:1")!;
		const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" }]);
		expect(f.store.getOperation(f.id, "resource-return-close:2")).toBeUndefined();
		expect((lastEvent(f.store, f.id, "resource_return_unknown").data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "precondition", "none", "condition:operation_already_claimed", { kind: "resource-return-close", id: prior.id }));
	}
	// A close claimed by another controller between the check and this claim.
	{
		const f = fixture();
		const claim = f.store.claimResourceReturnClose.bind(f.store);
		f.store.claimResourceReturnClose = (...args) => { claim(...args); return claim(...args); };
		const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_outcome_unknown_no_replay" }]);
		const other = f.store.getOperation(f.id, "resource-return-close:1")!;
		expect(other.receipt).toBeUndefined();
		expect((lastEvent(f.store, f.id, "resource_return_unknown").data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "claim", "none", "condition:operation_already_claimed", { kind: "resource-return-close", id: other.id }));
	}
	// The bounded close attempts are used up by retained busy refusals.
	{
		const f = fixture();
		const busy = async () => port(f, { async fencedClose() { throw new TransportError("EXECUTION_QUERY_FAILED", "unknown", SECRET, { ok: false, error: { code: "busy" } }); } });
		for (let n = 0; n < 5; n++) expect((await returnResources(f.store, [f.id], { connect: busy, paceMs: 0 }))[0]!.state).toBe("session_busy");
		const last = f.store.getOperation(f.id, "resource-return-close:5")!;
		const r = await returnResources(f.store, [f.id], { connect: busy, paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_attempts_exhausted" }]);
		expect((lastEvent(f.store, f.id, "resource_return_unknown").data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "precondition", "none", "condition:close_attempts_exhausted", { kind: "resource-return-close", id: last.id }));
	}
	// A node already blocked by an earlier refusal.
	{
		const f = fixture();
		f.store.blockResourceReturnNode("node", f.id, "11111111-2222-4333-8444-555555555555", "lifecycle_legacy_history_ambiguous");
		const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
		expect(r).toEqual([{ taskId: f.id, state: "return_blocked_by_node", reason: "lifecycle_legacy_history_ambiguous" }]);
		expect(f.store.getOperation(f.id, "resource-return-close:1")).toBeUndefined();
		const event = lastEvent(f.store, f.id, "resource_return_unknown");
		expect((event.data as any).reason).toBe("node_blocked_by_lifecycle_legacy_history_ambiguous");
		expect((event.data as any).failureDiagnostic).toEqual(expected("ResourceReturn.close", "precondition", "none", "condition:resource_return_node_blocked"));
	}
});

test("audit: observation outcomes that are not an error or refusal record no diagnostic", async () => {
	const f = fixture();
	// The exact incarnation is listed, the close is acknowledged, and the next listing still shows it.
	const r = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
	expect(r).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_acknowledged_awaiting_terminal_listing" }]);
	expect(lastEvent(f.store, f.id, "resource_return_unknown").data).not.toHaveProperty("failureDiagnostic");
	const again = await returnResources(f.store, [f.id], { connect: async () => port(f), paceMs: 0 });
	expect(again).toEqual([{ taskId: f.id, state: "return_unknown", reason: "close_acknowledged_awaiting_terminal_listing" }]);
	expect(lastEvent(f.store, f.id, "resource_return_unknown").data).not.toHaveProperty("failureDiagnostic");
});
