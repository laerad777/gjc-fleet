import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digest, observationDigest } from "../src/core";
import type { NodeConfig, SessionAuthority } from "../src/contracts";
import { getDashboardState } from "../src/dashboard";
import { operatorReleaseResource, returnResources, type ReturnConnection } from "../src/resource-return";
import { TransportError } from "../src/rpc";
import { FleetStore } from "../src/store";
import { sha256 } from "../src/workspace";

// The result store together with 34d0622's resource return: results of tasks that were
// returned or released by operator override round-trip (switch off and on, migration,
// backup/restore); the resource-return leases and node blocks are carried by backup and
// restore and untouched by result gc.
const INC = "b".repeat(64);
const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) {
		try {
			s.close();
		} catch {}
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function nodeConfig(dir: string): NodeConfig {
	return { id: "node", os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: join(dir, "coordinator-must-not-spawn"), args: [] }, sdkTransport: { command: process.execPath, args: [] } } as NodeConfig;
}
/** A settled, collected attempt holding its reservation (deferTerminalRelease) with a multi-KiB result. */
function settled(store: FleetStore, n: NodeConfig, dir: string, i: number) {
	const task = store.reserve(store.submit({ schemaVersion: 1, key: `task-${i}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
	const path = join(n.workspaceRoot, `${task.id}-${task.attemptId}`);
	const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: n.id, inputDigest: task.inputDigest, path, repo: dir, baseCommit: "a".repeat(40) };
	store.setWorkspace(task.id, identity);
	const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
	const sessionId = `session-${i}`;
	store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
	store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: INC });
	store.recordTurn(task.id, "turn");
	const body = { sessionId, turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(task.id, { eventId: `terminal-${i}`, digest: observationDigest(body), ...body });
	const patch = `+line ${i} ✓\n`.repeat(800);
	const manifest = {
		schemaVersion: 1,
		identity,
		patch,
		patchDigest: sha256(patch),
		outputHead: "a".repeat(40),
		producer: { platform: process.platform, arch: process.arch, bun: Bun.version },
		files: [],
		tests: [],
		status: "not_run",
	};
	store.saveResult(task.id, manifest as any);
	return { id: task.id, manifest };
}
function broker(store: FleetStore, hang: Set<string>) {
	const sessions = new Map<string, { cwd: string; live: boolean }>();
	for (const t of store.taskStates()) if (t.sessionId) sessions.set(t.sessionId, { cwd: (t.workspace as any).path, live: true });
	let seq = 0;
	const port: ReturnConnection = {
		async list(sessionId) {
			const s = sessions.get(sessionId);
			return { type: "broker_response", ok: true, result: { indexSeq: ++seq, sessions: s?.live ? [{ sessionId, locator: { cwd: s.cwd }, endpointGeneration: 1, endpointIncarnation: INC, live: true, terminal: false, ambiguous: false, terminalUncertain: false, activity: { state: "idle" } }] : [] } };
		},
		async fencedClose(authority: SessionAuthority) {
			if (hang.has(authority.sessionId)) throw new TransportError("execution_query_timeout", "unknown");
			sessions.get(authority.sessionId)!.live = false;
			return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
		},
		close() {},
	};
	return { connect: async () => port };
}
function sideTables(path: string) {
	const db = new Database(path, { readonly: true });
	try {
		return {
			leases: db.query("SELECT * FROM resource_return_leases ORDER BY node_id").all(),
			blocks: db.query("SELECT * FROM resource_return_node_blocks ORDER BY node_id").all(),
			operations: (db.query("SELECT COUNT(*) AS n FROM operations").get() as { n: number }).n,
		};
	} finally {
		db.close();
	}
}
function forms(path: string): string[] {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT CASE WHEN json_type(data,'$.resultExternal') IS NOT NULL THEN 'external' WHEN json_type(data,'$.resultManifest') IS NOT NULL THEN 'inline' ELSE 'none' END AS form FROM tasks ORDER BY rowid").all() as { form: string }[]).map((row) => row.form);
	} finally {
		db.close();
	}
}

for (const mode of ["off", "on before results", "on after results + migrate"] as const) {
	test(`resource return + result store (${mode}): returned and operator-released results round-trip through save, migration, backup/restore; leases and node blocks survive backup and gc`, async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "rs-return-")));
		dirs.push(dir);
		const path = join(dir, "fleet.sqlite");
		const store = new FleetStore(path, 100, { deferTerminalRelease: true });
		stores.push(store);
		const n = nodeConfig(dir);
		store.putNode(n);
		if (mode === "on before results") store.enableResultStore({ actor: "tester", reason: "resource return round trip" });
		const tasks = [0, 1, 2].map((i) => settled(store, n, dir, i));
		const [returned, released, kept] = tasks as [(typeof tasks)[0], (typeof tasks)[0], (typeof tasks)[0]];
		expect(forms(path)).toEqual(mode === "on before results" ? ["external", "external", "external"] : ["inline", "inline", "inline"]);
		if (mode === "on after results + migrate") store.enableResultStore({ actor: "tester", reason: "resource return round trip" });
		// returned: fresh listing, one idle-fenced close, then a fresh listing shows it gone.
		const hang = new Set([`session-1`]);
		const b = broker(store, hang);
		expect(await returnResources(store, [returned.id], { connect: b.connect, paceMs: 0 })).toEqual([{ taskId: returned.id, state: "returned" }]);
		// released: the close outcome is lost, then the operator releases the reservation.
		expect((await returnResources(store, [released.id], { connect: b.connect, paceMs: 0 }))[0]!.state).toBe("return_unknown");
		const override = await operatorReleaseResource(store, released.id, { operator: "ops-user", reason: "close outcome lost; host checked" }, { connect: b.connect });
		expect(override).toMatchObject({ state: "released_by_operator_unconfirmed" });
		// kept: still held; plus a node block and a pacing lease on another node.
		store.blockResourceReturnNode("node", kept.id, "operation-x", "lifecycle_legacy_history_ambiguous");
		expect(store.claimResourceReturnNode("node-2", "token-2")).toBe(true);
		if (mode === "on after results + migrate") {
			expect(store.migrateResults(true)).toMatchObject({ migrated: 3, failed: [] });
			expect(forms(path)).toEqual(["external", "external", "external"]);
		}
		const expectedForms = forms(path);
		expect(expectedForms).toEqual(mode === "off" ? ["inline", "inline", "inline"] : ["external", "external", "external"]);
		const check = (s: FleetStore) => {
			for (const t of tasks) expect(canonicalJson(s.task(t.id)!.resultManifest)).toBe(canonicalJson(t.manifest));
			expect(s.resourceReturnStatus(returned.id)).toMatchObject({ state: "returned", observedGone: true });
			expect(s.resourceReturnStatus(released.id)).toMatchObject({ state: "released_by_operator_unconfirmed", operator: "ops-user" });
			expect(s.resourceReturnStatus(kept.id)).toBeUndefined();
			expect(s.taskState(returned.id)!.held).toBe(false);
			expect(s.taskState(released.id)!.held).toBe(false);
			expect(s.taskState(kept.id)!.held).toBe(true);
			expect(s.resourceReturnNodeBlock("node")).toMatchObject({ taskId: kept.id, diagnostic: "lifecycle_legacy_history_ambiguous" });
			expect(s.resourceReturnNode("node-2")).toMatchObject({ token: "token-2" });
			const dashboard = getDashboardState(s);
			expect(dashboard.nodes.find((node) => node.id === "node")!.possiblyRunning.map((t) => t.id)).toEqual([released.id]);
			const listing = s.taskListing();
			expect(listing.map((entry) => entry.result && "digest" in entry.result ? entry.result.digest : null)).toEqual(tasks.map((t) => digest(t.manifest)));
		};
		check(store);
		// Result gc never touches the resource-return tables (or any referenced blob).
		const before = sideTables(path);
		expect(store.collectResults(true)).toMatchObject({ dryRun: false, removed: [] });
		expect(sideTables(path)).toEqual(before);
		check(store);
		// Backup carries every table and exactly the referenced blobs; the restored pair reads the same.
		const receipt = store.backup(join(dir, "backup.sqlite"));
		expect(receipt.results.blobs).toBe(mode === "off" ? 0 : 3);
		expect(existsSync(join(dir, "backup.sqlite.results"))).toBe(mode !== "off");
		expect(sideTables(receipt.path)).toEqual(before);
		expect(forms(receipt.path)).toEqual(expectedForms);
		const restoredDir = join(dir, "restored");
		const { cpSync, mkdirSync } = await import("node:fs");
		mkdirSync(restoredDir);
		cpSync(receipt.path, join(restoredDir, "fleet.sqlite"));
		if (mode !== "off") cpSync(`${receipt.path}.results`, join(restoredDir, "fleet.sqlite.results"), { recursive: true });
		for (const readOnly of [true, false]) {
			const restored = new FleetStore(join(restoredDir, "fleet.sqlite"), 100, { readOnly, deferTerminalRelease: true });
			stores.push(restored);
			check(restored);
			expect(restored.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
			restored.close();
		}
		// A later fresh listing confirms the released session gone: still no second release, result intact.
		const gone = async (): Promise<ReturnConnection> => ({ ...(await b.connect()), list: async () => ({ type: "broker_response", ok: true, result: { indexSeq: 10_000, sessions: [] } }) });
		expect(await returnResources(store, [released.id], { connect: gone, paceMs: 0 })).toEqual([{ taskId: released.id, state: "returned", reason: "observed_gone_after_operator_release" }]);
		expect(store.resourceReturnStatus(released.id)).toMatchObject({ state: "returned", afterOperatorRelease: true });
		expect(canonicalJson(store.task(released.id)!.resultManifest)).toBe(canonicalJson(released.manifest));
		expect(forms(path)).toEqual(expectedForms);
		if (mode === "off") expect(readdirSync(dir).some((name) => name.endsWith(".results"))).toBe(false);
	});
}
