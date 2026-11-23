// Rebase onto cb1b744 (reviewer eb7f0d3a): results of tasks with a retained typed before_send
// preparation refusal and with operator-run owner leases round-trip unchanged through save, migrate,
// gc, backup and restore in all three switch modes, and cb1b744's new listing paths (CLI `tasks` with
// filters/--compact, filteredTasks, retainedPreparationRefusal) never read a result body.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import type { TaskInput } from "../src/contracts";
import { canonicalJson } from "../src/core";
import { FleetStore, operatorRunPayload } from "../src/store";
import { cli } from "../src/cli";
import { compactTask, filteredTasks, parseTaskFilters } from "../src/operator-commands";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const node = {
	id: "node", os: "linux", arch: "arm64", roots: { repo: "/repos/repo" }, workspaceRoot: "/work", maxConcurrency: 100,
	enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"],
	transport: { command: "gjc", args: ["acp"] }, operations: ["read", "write"],
};
const input = (key: string): TaskInput => ({ schemaVersion: 1, key, caller: "refusal-lease", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} });
const manifest = (seed: string) => ({
	status: "verified",
	patch: `+${seed} ünï\n`.repeat(3000),
	files: [{ path: "f.bin", bytes: 4096, sha256: "x", contentBase64: Buffer.alloc(4096, seed.charCodeAt(0)).toString("base64") }],
	tests: [{ argv: ["bun", "test"], cwd: "/w", exit: 0, stdout: `ok ${seed}\n`.repeat(500), stderr: "w\n".repeat(600) }],
});
const refusal = { ok: false, error: "root_denied", detail: "allowlist", certainty: "before_send" };
const lease = (owner: string, expiresAt: number) => ({ owner, pid: process.pid, host: hostname(), expiresAt });

/** R: retained before_send refusal + unreceipted leased operator-run claim; L: finished run (receipt, lease released); H: live lease. */
function populate(store: FleetStore) {
	store.putNode(node as any);
	const ids: Record<string, string> = {};
	for (const key of ["R", "L", "H"]) ids[key] = store.reserve(store.submit(input(key)).id)!.id;
	const prepare = store.claimOperation(ids.R!, "prepare", { prepare: "R" })!;
	store.recordOperationReceipt(ids.R!, "prepare", prepare.id, { nodeRefusal: refusal } as any);
	store.recordResultValidationRejected(ids.R!, "node_refused:root_denied:allowlist");
	for (const key of ["R", "L", "H"]) {
		const run = store.claimOperation(ids[key]!, "operator-run", operatorRunPayload(store.task(ids[key]!)!))!;
		expect(store.leaseOperatorRun(ids[key]!, run.id, lease(`owner-${key}`, Date.now() + 3_600_000), () => false)).toBe(true);
	}
	store.recordSession(ids.L!, "session-L");
	store.recordTurn(ids.L!, "turn-L");
	const runL = store.getOperation(ids.L!, "operator-run")!;
	store.recordOperationReceipt(ids.L!, "operator-run", runL.id, { phase: "active", sessionId: "session-L", turnId: "turn-L" });
	store.releaseOperatorRun(ids.L!, runL.id, "owner-L");
	return ids;
}
function saveAll(store: FleetStore, ids: Record<string, string>) {
	for (const key of ["R", "L", "H"]) store.saveResult(ids[key]!, manifest(key));
}
async function listing(db: string, ...extra: string[]) {
	const lines: string[] = [];
	const log = console.log;
	console.log = (...a: unknown[]) => void lines.push(a.join(" "));
	try {
		expect(await cli(["--read-only", "--db", db, "--cap", "2", "tasks", ...extra])).toBe(0);
	} finally {
		console.log = log;
	}
	return lines.join("\n");
}
async function snapshot(db: string, ids: Record<string, string>) {
	const store = new FleetStore(db, 2, { readOnly: true });
	try {
		const raw = new Database(db, { readonly: true });
		const operations = (raw.query("SELECT task_id, attempt_id, kind, id, data FROM operations ORDER BY rowid").all() as any[]).map((r) => canonicalJson(r));
		const audit = (raw.query("SELECT kind, COUNT(*) n FROM audit WHERE task_id IS NOT NULL GROUP BY kind ORDER BY kind").all() as any[]).map((r) => `${r.kind}:${r.n}`);
		raw.close();
		return {
			tasks: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, canonicalJson(store.task(id) as any)])),
			refusals: Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, canonicalJson((store.retainedPreparationRefusal(id) ?? null) as any)])),
			operations,
			audit,
			cliTasks: await listing(db),
			cliFiltered: await listing(db, "--phase", "dispatching,preparing,active", "--key-prefix", "R"),
			cliCompact: (await listing(db, "--compact")).split("\n").map((l) => l.split("\t").filter((_, i) => i !== 4).join("\t")).join("\n"),
		};
	} finally {
		store.close();
	}
}
for (const mode of ["off", "on before results", "on after results + migrate"] as const)
	test(`cb1b744 rebase: typed refusal and operator-run lease tasks round-trip (${mode})`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "rs-refusal-lease-"));
		dirs.push(dir);
		const db = join(dir, "fleet.sqlite");
		const store = new FleetStore(db);
		const ids = populate(store);
		if (mode === "on before results") store.enableResultStore({ actor: "test", reason: "on before" });
		saveAll(store, ids);
		const saved = await snapshot(db, ids);
		expect(JSON.parse(saved.refusals.R!)?.receipt?.nodeRefusal).toEqual(refusal);
		expect(saved.refusals.L).toBe("null");
		expect(JSON.parse(saved.cliTasks).find((t: any) => t.id === ids.R).preparationRefusal).toMatchObject({ code: "node_refused:root_denied:allowlist", certainty: "before_send" });
		expect(saved.operations.filter((o) => JSON.parse(JSON.parse(o).data).lease !== undefined)).toHaveLength(2);
		if (mode === "on after results + migrate") {
			store.enableResultStore({ actor: "test", reason: "on after" });
			expect(store.migrateResults(true)).toMatchObject({ migrated: 3, failed: [] });
		}
		const external = mode !== "off";
		expect(store.resultStoreStatus()).toMatchObject({ externalResults: external ? 3 : 0, userVersion: external ? 3 : 2 });
		expect(await snapshot(db, ids)).toEqual(saved);
		store.collectResults(true);
		expect(await snapshot(db, ids)).toEqual(saved);
		const backup = join(dir, "backup.sqlite");
		const report = store.backup(backup);
		expect(report.results.path !== null).toBe(external);
		store.close();
		const restored = join(dir, "restored.sqlite");
		cpSync(backup, restored);
		if (external) cpSync(`${backup}.results`, `${restored}.results`, { recursive: true });
		expect(await snapshot(restored, ids)).toEqual(saved);
		const writable = new FleetStore(restored);
		expect(writable.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
		writable.close();
		expect(await snapshot(restored, ids)).toEqual(saved);
		if (external) {
			// The listing paths added by cb1b744 read no result body: they work with every blob gone.
			rmSync(`${restored}.results`, { recursive: true });
			const blind = new FleetStore(restored, 2, { readOnly: true });
			try {
				expect(blind.retainedPreparationRefusal(ids.R!)?.id).toBe(JSON.parse(saved.refusals.R!).id);
				expect(filteredTasks(blind, parseTaskFilters(["--key-prefix", "R"])).map((t) => t.id)).toEqual([ids.R]);
				expect(compactTask(blind, blind.taskState(ids.L!)!)).toContain('"L"');
				expect(() => blind.task(ids.R!)).toThrow();
			} finally {
				blind.close();
			}
			expect(await listing(restored)).toBe(saved.cliTasks);
			expect(existsSync(`${restored}.results`)).toBe(false);
		}
	});
