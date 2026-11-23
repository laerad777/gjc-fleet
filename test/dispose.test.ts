// `task dispose`: audited operator disposition of completed_unverified tasks through the archive machinery.
// Every database is seeded through a tree's real store operations (test/fixtures/dispose-seed.ts); every
// disposition goes through Fleet.dispose / Fleet.disposeBatch or the real CLI process. The node is the seed's
// SDK stand-in: it counts its calls and prints the session listing the test writes.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, digest } from "../src/core";
import { DISPOSE_BATCH_LIMIT, Fleet } from "../src/fleet";
import { FleetStore, DISPOSITION_STATEMENT } from "../src/store";
import { dispositionSummary, getDashboardState, renderDashboardHtml } from "../src/dashboard";
import { watchTasks } from "../src/operator-commands";
import type { Phase } from "../src/contracts";
import { installDiagnosticGuard } from "./diagnostic-guard";

const root = resolve(import.meta.dir, "..");
const legacyTree = process.env.FLEET_LEGACY_TREE ? resolve(process.env.FLEET_LEGACY_TREE) : undefined;
const seedScript = join(import.meta.dir, "fixtures", "dispose-seed.ts");
const dirs: string[] = [];
const open: FleetStore[] = [];
afterAll(() => {
	for (const store of open) try { store.close(); } catch {}
	for (const dir of dirs) {
		try { chmodSync(dir, 0o700); } catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});
type Seeded = { dir: string; db: string; ids: Record<string, string> };
function seed(tree = root, completed = 3): Seeded {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dispose-"));
	dirs.push(dir);
	const db = join(dir, "fleet.sqlite");
	const run = Bun.spawnSync([process.execPath, seedScript, tree, db, dir, String(completed)], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	if (run.exitCode !== 0) throw new Error(`seed failed: ${run.stderr.toString()}`);
	return { dir, db, ids: JSON.parse(run.stdout.toString()).ids };
}
function hub(f: Seeded, options: { deferTerminalRelease?: boolean } = {}) {
	const store = new FleetStore(f.db, 2, options);
	open.push(store);
	return { store, fleet: new Fleet(store) };
}
const calls = (f: Seeded) => readFileSync(join(f.dir, "calls.log"), "utf8").split("\n").filter(Boolean).length;
function listing(f: Seeded, sessions: unknown[], patch: Record<string, unknown> = {}) {
	writeFileSync(join(f.dir, "listing.json"), JSON.stringify({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" }, sessions, warnings: [], ...patch } }));
}
/** Raw row text, through a separate connection. */
function row(f: Seeded, id: string): string {
	const db = new Database(f.db, { readonly: true });
	try { return db.query<{ data: string }, [string]>("SELECT data FROM tasks WHERE id=?").get(id)!.data; } finally { db.close(); }
}
/** Every table's rows: the logical content of the database. */
function logical(f: Seeded): string {
	const db = new Database(f.db, { readonly: true });
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
		return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
	} finally { db.close(); }
}
function userVersion(f: Seeded): number {
	const db = new Database(f.db, { readonly: true });
	try { return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; } finally { db.close(); }
}
/** Name, size and mtime of every entry under the result directory (or "absent"). */
function blobs(f: Seeded): string {
	const base = `${f.db}.results`;
	if (!existsSync(base)) return "absent";
	const out: string[] = [];
	const walk = (path: string) => {
		for (const name of readdirSync(path).sort()) {
			const full = join(path, name), st = statSync(full);
			out.push(`${full.slice(base.length)}:${st.isDirectory() ? "d" : st.size}:${st.mtimeMs}`);
			if (st.isDirectory()) walk(full);
		}
	};
	walk(base);
	return out.join("\n");
}
/** The stored result exactly as the row carries it: its canonical text must be a byte substring of the row. */
function storedResult(f: Seeded, id: string): { text: string; form: "inline" | "external" } {
	const data = row(f, id), parsed = JSON.parse(data);
	const form = Object.hasOwn(parsed, "resultExternal") ? "external" : "inline";
	const text = `"${form === "external" ? "resultExternal" : "resultManifest"}":${canonicalJson(form === "external" ? parsed.resultExternal : parsed.resultManifest)}`;
	expect(data.includes(text)).toBe(true);
	return { text, form };
}
async function cli(f: Seeded, args: string[]) {
	const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "--db", f.db, ...args], { cwd: f.dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, exit };
}
const requests = (by: string) => ({
	deployed: { kind: "deployed", commit: "ABCDEF0123", reason: "landed in production main" },
	superseded: { kind: "superseded", supersededBy: by, reason: "later task of the same topic" },
	"review-recorded": { kind: "review-recorded", subject: "review of the dispose lane", verdict: "not-clean", reason: "review-only verdict" },
	discarded: { kind: "discarded", reason: "rehearsal" },
}) as const;

for (const kind of ["deployed", "superseded", "review-recorded", "discarded"] as const) test(`dispose --as ${kind}: archived through the archive machinery, recorded and audited, result untouched, never succeeded`, async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	const before = store.taskState(id)!;
	const fullBefore = store.task(id)!;
	const result = storedResult(f, id);
	const eventsBefore = store.events(id).length;
	const request = requests(f.ids["completed-1"]!)[kind];
	const done = await fleet.dispose(id, request as any, "alice");
	expect(calls(f)).toBe(1);
	expect(done).toMatchObject({ taskId: id, outcome: "disposed", phase: "archived", archivedFrom: "completed_unverified", verifiedByFleet: false, succeeded: false, resultUntouched: true, releasedReservation: false });
	const after = store.taskState(id)!;
	expect(after.phase).toBe("archived");
	expect(after.held).toBe(false);
	expect(after.archivedFrom).toEqual({ phase: "completed_unverified", result: before.result! });
	expect(after.result).toEqual(before.result!);
	expect(after.result!.verified).toBe(false);
	expect(after.archiveActor).toBe("alice");
	const { kind: _k, ...fields } = request as any;
	expect(after.disposition).toEqual({ kind, ...fields, ...(kind === "deployed" ? { commit: "abcdef0123" } : {}), actor: "alice", at: after.archivedAt!,
		requestDigest: digest({ kind, ...fields, ...(kind === "deployed" ? { commit: "abcdef0123" } : {}) } as any), statement: DISPOSITION_STATEMENT[kind], verifiedByFleet: false });
	expect(DISPOSITION_STATEMENT[kind]).toContain("Not succeeded.");
	expect(DISPOSITION_STATEMENT[kind]).toMatch(/^Operator record/);
	// Byte-identical stored result, same form, same full verified result.
	expect(storedResult(f, id)).toEqual(result);
	expect(store.task(id)!.resultManifest).toEqual(fullBefore.resultManifest!);
	// Audit trail: exactly one archived event with the disposition, its fields, actor and time.
	const added = store.events(id).slice(eventsBefore);
	expect(added.map((e) => e.kind)).toEqual(["archived"]);
	expect((added[0]!.data as any).disposition).toEqual(after.disposition);
	expect((added[0]!.data as any).actor).toBe("alice");
	expect((added[0]!.data as any).archivedFrom.phase).toBe("completed_unverified");
	// CLI show and tasks carry it; never "succeeded".
	const show = await cli(f, ["show", id]);
	expect(show.exit).toBe(0);
	expect(JSON.parse(show.stdout)).toMatchObject({ phase: "archived", disposition: { kind, statement: DISPOSITION_STATEMENT[kind], verifiedByFleet: false } });
	expect(show.stdout).not.toContain('"phase": "succeeded"');
});

test("a task still holding its reservation is never disposed: refused before the node is contacted whatever the listing would show; the reservation stays held", async () => {
	const f = seed();
	const { store, fleet } = hub(f, { deferTerminalRelease: true });
	const id = f.ids.held!;
	const before = row(f, id), heldBefore = (store.heldCharges().get("n1") ?? []).length;
	const base = { sessionId: "session-held", live: false, terminal: true, terminalUncertain: false, ambiguous: false, endpointGeneration: 1, endpointIncarnation: "b".repeat(64), locator: { cwd: "/work" } };
	// Rows resource return does not accept as gone (foreign incarnation, other cwd, uncertainty flags missing,
	// ambiguous, no recorded authority), the exact terminal row, and absence: a disposition judges none of them.
	const rows = [
		[{ ...base, endpointIncarnation: "c".repeat(64) }],
		[{ ...base, locator: { cwd: "/elsewhere" } }],
		[{ sessionId: "session-held", live: false, terminal: true }],
		[{ ...base, ambiguous: true }],
		[base],
		[],
	];
	for (const sessions of rows) {
		listing(f, sessions);
		for (const dryRun of [true, false])
			await expect(fleet.dispose(id, { kind: "discarded", reason: "x" }, "operator", { dryRun })).rejects.toMatchObject({ code: "DISPOSE_RESOURCE_UNPROVEN", message: expect.stringContaining(`return ${id}`) });
		expect(row(f, id)).toBe(before);
	}
	const batch = await fleet.disposeBatch([{ taskId: id, as: "superseded", by: f.ids["completed-0"], reason: "later" }]);
	expect(batch.map((r) => r.ok ? r.outcome : r.code)).toEqual(["DISPOSE_RESOURCE_UNPROVEN"]);
	const out = await cli(f, ["task", "dispose", id, "--as", "discarded", "--reason", "x"]);
	expect(out.exit).toBe(1);
	expect(JSON.parse(out.stderr)).toEqual({ ok: false, error: "DISPOSE_RESOURCE_UNPROVEN" });
	expect(calls(f)).toBe(0);
	expect(row(f, id)).toBe(before);
	expect(store.taskState(id)!.held).toBe(true);
	expect((store.heldCharges().get("n1") ?? []).length).toBe(heldBefore);
	expect(store.events(id).filter((e) => e.kind === "released")).toEqual([]);
	// Each non-dry refusal is recorded (deny-by-default diagnostic with its own code); dry runs write nothing.
	const refused = store.events(id).filter((e) => e.kind === "refused").map((e) => [(e.data as any).action, (e.data as any).failureDiagnostic?.code]);
	expect(refused).toEqual(Array(rows.length + 2).fill(["dispose", "fleet:dispose_resource_unproven"]));
});

test("--node-retired never releases a held reservation: refused with DISPOSE_RESOURCE_UNPROVEN, no node contact, the task stays held", async () => {
	const f = seed(root, 1);
	const { store, fleet } = hub(f, { deferTerminalRelease: true });
	const id = f.ids.held!;
	const raw = new Database(f.db);
	try { raw.query("DELETE FROM nodes").run(); } finally { raw.close(); }
	const before = row(f, id);
	for (const dryRun of [true, false])
		await expect(fleet.dispose(id, { kind: "discarded", reason: "x", nodeRetired: "decommissioned" }, "operator", { dryRun })).rejects.toMatchObject({ code: "DISPOSE_RESOURCE_UNPROVEN" });
	expect(row(f, id)).toBe(before);
	expect(store.taskState(id)!.held).toBe(true);
	expect(store.events(id).filter((e) => e.kind === "released" || e.kind === "archived")).toEqual([]);
	expect(calls(f)).toBe(0);
});

test("after the existing audited return-override releases the reservation, the task is disposed and the disposition itself releases nothing", async () => {
	const { operatorReleaseResource } = await import("../src/resource-return");
	const f = seed(root, 1);
	const { store, fleet } = hub(f, { deferTerminalRelease: true });
	const id = f.ids.held!;
	// The seed's held task has no recorded session authority, so only the operator override can release it.
	const connect = async () => ({ list: async () => ({ type: "broker_response", ok: true, result: { indexSeq: 1, sessions: [{ sessionId: "session-held", live: false, terminal: false }] } }), stop: async () => {}, fencedClose: async () => { throw new Error("no close"); }, close() {} });
	const release = await operatorReleaseResource(store, id, { operator: "op", reason: "node checked by hand" }, { connect: connect as any });
	expect(release.state).toBe("released_by_operator_unconfirmed");
	expect(store.taskState(id)!.held).toBe(false);
	const status = store.resourceReturnStatus(id);
	const events = store.events(id).length;
	const done = await fleet.dispose(id, { kind: "discarded", reason: "rehearsal" });
	expect({ outcome: done.outcome, releasedReservation: done.releasedReservation }).toEqual({ outcome: "disposed", releasedReservation: false });
	expect(store.events(id).slice(events).map((e) => e.kind)).toEqual(["archived"]);
	// The override's record is left exactly as resource return keeps it (still reported possibly running).
	expect(store.resourceReturnStatus(id)).toEqual(status);
});

test("a stored row that is not in canonical form is refused with DISPOSE_ROW_FORM and never rewritten", async () => {
	const f = seed(root, 1);
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	// The same task, its keys in reverse order: valid JSON, not canonical text.
	const parsed = JSON.parse(row(f, id));
	const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
	expect(reordered).not.toBe(row(f, id));
	const raw = new Database(f.db);
	try { raw.query("UPDATE tasks SET data=? WHERE id=?").run(reordered, id); } finally { raw.close(); }
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_ROW_FORM" });
	expect(row(f, id)).toBe(reordered);
	expect(store.taskState(id)!.phase).toBe("completed_unverified");
	expect(store.events(id).filter((e) => e.kind === "refused").map((e) => (e.data as any).failureDiagnostic?.code)).toEqual(["fleet:dispose_row_form"]);
});

test("a completed_unverified task still carrying its lane progress record is disposed, and the record is dropped as task archive drops it", async () => {
	const f = seed(root, 1);
	const id = f.ids["completed-0"]!;
	// The record a progress read left while the task was active: completed_unverified is not settled, so it is kept.
	const progress = {
		version: 1, verdict: "stalled_model", observedAt: "2027-01-15T08:00:00.010Z", readStartedAt: "2027-01-15T08:00:00.000Z",
		lastEntryKind: "awaiting_model", idleSeconds: 900, thresholds: { modelSeconds: 480, toolSeconds: 2400 },
		stall: { verdict: "stalled_model", since: "2027-01-15T08:00:00.010Z", nodeWrittenAt: "2027-01-15T07:45:00.000Z" }, hint: "stalled",
	};
	const raw = new Database(f.db);
	try { raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...JSON.parse(row(f, id)), progress }), id); } finally { raw.close(); }
	const { store, fleet } = hub(f);
	expect(store.taskState(id)!).toMatchObject({ phase: "completed_unverified", progress: { verdict: "stalled_model" } });
	const done = await fleet.dispose(id, { kind: "discarded", reason: "rehearsal" });
	expect(done).toMatchObject({ outcome: "disposed", phase: "archived", archivedFrom: "completed_unverified" });
	expect(calls(f)).toBe(1);
	expect("progress" in JSON.parse(row(f, id))).toBe(false);
	expect(store.taskState(id)!.progress).toBeUndefined();
});

test("migrate results: a disposed task's inline result stays eligible and is moved by an explicit --apply; a plainly archived one is still skipped", async () => {
	const f = seed(root, 2);
	const { store, fleet } = hub(f);
	store.enableResultStore({ actor: "test", reason: "shrink the database" });
	const disposed = f.ids["completed-0"]!, sibling = f.ids["completed-1"]!, plain = f.ids.failed!;
	const manifest = store.task(disposed)!.resultManifest;
	const before = store.migrateResults(false);
	await fleet.dispose(disposed, { kind: "deployed", commit: "abcdef0", reason: "landed" });
	await fleet.archive(plain, {});
	const plan = store.migrateResults(false);
	expect({ eligible: plan.eligible, archived: plan.archived }).toEqual({ eligible: before.eligible - 1, archived: before.archived + 1 });
	const disposedRow = JSON.parse(row(f, disposed));
	const applied = store.migrateResults(true);
	expect({ migrated: applied.migrated, archived: applied.archived, failed: applied.failed }).toEqual({ migrated: plan.eligible, archived: plan.archived, failed: [] });
	for (const id of [disposed, sibling]) expect(storedResult(f, id).form).toBe("external");
	expect(storedResult(f, plain).form).toBe("inline");
	// Only the result's storage form changed: the disposition, phase and every other key are carried as they were.
	const { resultManifest, ...rest } = disposedRow;
	const { resultExternal, ...after } = JSON.parse(row(f, disposed));
	expect(after).toEqual(rest);
	expect(resultExternal).toBeDefined();
	expect(store.task(disposed)!.resultManifest).toEqual(manifest);
	expect(store.taskState(disposed)!.disposition!.kind).toBe("deployed");
	expect(store.migrateResults(false)).toMatchObject({ eligible: 0, archived: plan.archived });
});

test("refused for every other phase and for a provisional completed_unverified, before the node is contacted; the row is unchanged", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const expected: Record<string, string> = { provisional: "DISPOSE_NOT_TERMINAL", archived: "DISPOSE_CONFLICT" };
	const phases: Phase[] = ["queued", "preparing", "dispatching", "active", "approval_required", "blocked_unknown", "cancel_unknown", "succeeded", "failed", "archived", "cancelled"];
	for (const key of [...phases, "provisional"]) {
		const id = f.ids[key]!;
		const data = row(f, id);
		const refusal = await fleet.dispose(id, { kind: "discarded", reason: "x" }).then(() => undefined, (e) => e);
		expect({ key, code: refusal?.code }).toEqual({ key, code: expected[key] ?? "DISPOSE_PHASE" });
		expect(row(f, id)).toBe(data);
	}
	expect(calls(f)).toBe(0);
	await expect(fleet.dispose("00000000-0000-4000-8000-000000000000", { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
	// The CLI reports the same refusal with exit 1.
	const out = await cli(f, ["task", "dispose", f.ids.succeeded!, "--as", "discarded", "--reason", "x"]);
	expect({ exit: out.exit, stderr: out.stderr }).toEqual({ exit: 1, stderr: '{"ok":false,"error":"DISPOSE_PHASE"}\n' });
});

test("live original session refuses exactly as task archive does (live idle included); a dead session is not live", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	const task = store.taskState(id)!;
	for (const activity of [{ state: "active" }, { state: "idle" }]) {
		listing(f, [{ sessionId: task.sessionId, live: true, locator: { cwd: "/other" }, activity }]);
		const data = row(f, id);
		await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "ARCHIVE_LIVE_SESSION" });
		expect(row(f, id)).toBe(data);
	}
	// Same evidence rules as archive: an incomplete listing is refused.
	listing(f, [], { warnings: ["partial"] });
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "ARCHIVE_EVIDENCE" });
	listing(f, [{ sessionId: "unrelated", live: true }]);
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "ARCHIVE_EVIDENCE" });
	const refused = store.events(id).filter((e) => e.kind === "refused").map((e) => (e.data as any).code);
	expect(refused).toEqual(["ARCHIVE_LIVE_SESSION", "ARCHIVE_LIVE_SESSION", "ARCHIVE_EVIDENCE", "ARCHIVE_EVIDENCE"]);
	listing(f, [{ sessionId: task.sessionId, live: false, locator: { cwd: "/other" }, activity: { state: "active" } }]);
	expect((await fleet.dispose(id, { kind: "discarded", reason: "x" })).outcome).toBe("disposed");
});

test("same request and actor is idempotent without contacting the node; a different disposition or actor is refused, never overwritten", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	const request = { kind: "deployed", commit: "abcdef1", reason: "landed" } as const;
	await fleet.dispose(id, request, "alice");
	const data = row(f, id), events = store.events(id).length;
	expect(calls(f)).toBe(1);
	const again = await fleet.dispose(id, { ...request, commit: "ABCDEF1" }, "alice");
	expect(again.outcome).toBe("already_disposed");
	expect(calls(f)).toBe(1);
	for (const [other, actor] of [[{ ...request, reason: "different" }, "alice"], [{ kind: "discarded", reason: "landed" }, "alice"], [request, "bob"]] as const) {
		await expect(fleet.dispose(id, other as any, actor)).rejects.toMatchObject({ code: "DISPOSE_CONFLICT" });
		await expect(fleet.dispose(id, other as any, actor, { dryRun: true })).rejects.toMatchObject({ code: "DISPOSE_CONFLICT" });
	}
	expect(calls(f)).toBe(1);
	expect(row(f, id)).toBe(data);
	expect(store.events(id).slice(events).map((e) => [e.kind, (e.data as any).code])).toEqual([["refused", "DISPOSE_CONFLICT"], ["refused", "DISPOSE_CONFLICT"], ["refused", "DISPOSE_CONFLICT"]]);
	// task archive keeps its own identity check on a disposed task; a plainly archived task takes no disposition.
	await expect(fleet.archive(id, {}, "alice")).rejects.toMatchObject({ code: "ARCHIVE_CONFLICT" });
	await expect(fleet.dispose(f.ids.archived!, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_CONFLICT" });
	expect(row(f, id)).toBe(data);
});

test("overlapping callers: identical requests both succeed with one record; conflicting requests leave exactly one", async () => {
	const f = seed();
	const a = hub(f), b = hub(f);
	const id = f.ids["completed-0"]!, other = f.ids["completed-1"]!;
	const same = await Promise.all([a.fleet.dispose(id, { kind: "discarded", reason: "x" }), b.fleet.dispose(id, { kind: "discarded", reason: "x" })]);
	expect(same.map((r) => r.outcome).sort()).toEqual(["already_disposed", "disposed"]);
	expect(a.store.events(id).filter((e) => e.kind === "archived")).toHaveLength(1);
	const mixed = await Promise.allSettled([a.fleet.dispose(other, { kind: "discarded", reason: "x" }), b.fleet.dispose(other, { kind: "discarded", reason: "y" })]);
	expect(mixed.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
	expect((mixed.find((r) => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("DISPOSE_CONFLICT");
	expect(a.store.events(other).filter((e) => e.kind === "archived")).toHaveLength(1);
});

test("--by names an existing different task and never closes a cycle; --commit is 7-40 hex and recorded, not verified", async () => {
	const f = seed();
	const { fleet } = hub(f);
	const [a, b, c] = [f.ids["completed-0"]!, f.ids["completed-1"]!, f.ids["completed-2"]!];
	await expect(fleet.dispose(a, { kind: "superseded", supersededBy: a, reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_SUPERSEDER" });
	await expect(fleet.dispose(a, { kind: "superseded", supersededBy: "no-such-task", reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_SUPERSEDER" });
	await fleet.dispose(a, { kind: "superseded", supersededBy: b, reason: "x" });
	await fleet.dispose(b, { kind: "superseded", supersededBy: c, reason: "x" });
	await expect(fleet.dispose(c, { kind: "superseded", supersededBy: a, reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_SUPERSEDER" });
	// The superseding task may be in any phase (here: succeeded).
	await fleet.dispose(c, { kind: "superseded", supersededBy: f.ids.succeeded!, reason: "x" });
	expect(calls(f)).toBe(3);
	for (const [commit, ok] of [["abcdef", false], ["abcdef0", true], ["abcdef01", true], ["a".repeat(39), true], ["a".repeat(40), true], ["a".repeat(41), false], ["abcdefg", false], [" abcdef0", false]] as const) {
		const g = seed(root, 1);
		const h = hub(g);
		const outcome = await h.fleet.dispose(g.ids["completed-0"]!, { kind: "deployed", commit, reason: "x" }, "operator", { dryRun: true }).then((r) => r.outcome, (e) => e.code);
		expect({ commit, outcome }).toEqual({ commit, outcome: ok ? "would_dispose" : "DISPOSE_INPUT" });
		if (!ok) expect(calls(g)).toBe(0);
	}
}, 120_000);

test("input limits: reason/subject/actor at, below and above the limit; exactly the fields of the kind", async () => {
	const f = seed(root, 1);
	const { fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	const dry = (request: any, actor = "operator") => fleet.dispose(id, request, actor, { dryRun: true }).then((r) => r.outcome, (e) => e.code);
	for (const [n, ok] of [[1999, true], [2000, true], [2001, false]] as const) expect([n, await dry({ kind: "discarded", reason: "r".repeat(n) })]).toEqual([n, ok ? "would_dispose" : "DISPOSE_INPUT"]);
	for (const [n, ok] of [[499, true], [500, true], [501, false]] as const) expect([n, await dry({ kind: "review-recorded", subject: "s".repeat(n), verdict: "clean", reason: "r" })]).toEqual([n, ok ? "would_dispose" : "DISPOSE_INPUT"]);
	for (const [n, ok] of [[199, true], [200, true], [201, false]] as const) expect([n, await dry({ kind: "discarded", reason: "r" }, "a".repeat(n))]).toEqual([n, ok ? "would_dispose" : "DISPOSE_INPUT"]);
	for (const bad of [{ kind: "discarded", reason: " " }, { kind: "discarded" }, { kind: "succeeded", reason: "r" }, { kind: "discarded", reason: "r", commit: "abcdef0" },
		{ kind: "deployed", reason: "r" }, { kind: "review-recorded", subject: "s", verdict: "maybe", reason: "r" }, { kind: "review-recorded", verdict: "clean", reason: "r" },
		{ kind: "discarded", reason: "r", nodeRetired: "" }, { kind: "discarded", reason: "r\0" }, null, []])
		expect([bad, await dry(bad)]).toEqual([bad, "DISPOSE_INPUT"]);
	// Only the six valid requests reached the node (one read-only listing each).
	expect(calls(f)).toBe(6);
});

test("--dry-run prints what would happen and writes nothing (no refusal record either)", async () => {
	const f = seed();
	const { fleet } = hub(f, { deferTerminalRelease: true });
	const before = logical(f);
	const out = await cli(f, ["task", "dispose", f.ids["completed-0"]!, "--as", "deployed", "--commit", "0123abc", "--reason", "landed", "--dry-run"]);
	expect(out.exit).toBe(0);
	expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, outcome: "would_dispose", dryRun: true, phase: "completed_unverified", releasedReservation: false, verifiedByFleet: false, succeeded: false,
		disposition: { kind: "deployed", commit: "0123abc", statement: DISPOSITION_STATEMENT.deployed } });
	expect(JSON.parse(out.stdout).disposition.at).toBeUndefined();
	listing(f, [{ sessionId: "session-completed-0", live: true, locator: {} }]);
	await expect(fleet.dispose(f.ids["completed-0"]!, { kind: "discarded", reason: "x" }, "operator", { dryRun: true })).rejects.toMatchObject({ code: "ARCHIVE_LIVE_SESSION" });
	await expect(fleet.dispose(f.ids.succeeded!, { kind: "discarded", reason: "x" }, "operator", { dryRun: true })).rejects.toMatchObject({ code: "DISPOSE_PHASE" });
	expect(logical(f)).toBe(before);
	expect(calls(f)).toBe(2);
});

test("batch: each item applied independently with per-item results; only usage errors stop it (nothing applied)", async () => {
	const f = seed();
	const { store } = hub(f);
	listing(f, []);
	const items = [
		{ taskId: f.ids["completed-0"], as: "deployed", commit: "abcdef0", reason: "landed" },
		{ taskId: f.ids.succeeded, as: "discarded", reason: "wrong phase" },
		{ taskId: "00000000-0000-4000-8000-000000000000", as: "discarded", reason: "missing" },
		{ taskId: f.ids["completed-1"], as: "superseded", by: "no-such-task", reason: "missing superseder" },
		{ taskId: f.ids["completed-2"], as: "superseded", by: f.ids["completed-0"], reason: "later task" },
		{ taskId: f.ids.provisional, as: "review-recorded", subject: "s", verdict: "clean", reason: "provisional" },
	];
	writeFileSync(join(f.dir, "batch.json"), JSON.stringify(items));
	const out = await cli(f, ["task", "dispose", "--batch", join(f.dir, "batch.json"), "--actor", "carol"]);
	expect(out.exit).toBe(1);
	const report = JSON.parse(out.stdout);
	expect({ ok: report.ok, total: report.total, refused: report.refused }).toEqual({ ok: false, total: 6, refused: 4 });
	expect(report.items.map((i: any) => [i.taskId, i.ok, i.outcome, i.code ?? null])).toEqual([
		[f.ids["completed-0"], true, "disposed", null],
		[f.ids.succeeded, false, "refused", "DISPOSE_PHASE"],
		["00000000-0000-4000-8000-000000000000", false, "refused", "TASK_NOT_FOUND"],
		[f.ids["completed-1"], false, "refused", "DISPOSE_SUPERSEDER"],
		[f.ids["completed-2"], true, "disposed", null],
		[f.ids.provisional, false, "refused", "DISPOSE_NOT_TERMINAL"],
	]);
	expect(store.taskState(f.ids["completed-0"]!)!.disposition!.actor).toBe("carol");
	expect(calls(f)).toBe(2);
	// Re-running the same batch: the disposed items are idempotent, nothing is contacted for them.
	const again = JSON.parse((await cli(f, ["task", "dispose", "--batch", join(f.dir, "batch.json"), "--actor", "carol"])).stdout);
	expect(again.items.map((i: any) => i.outcome)).toEqual(["already_disposed", "refused", "refused", "refused", "already_disposed", "refused"]);
	expect(calls(f)).toBe(2);
	// Usage errors stop the whole batch before anything is applied or contacted.
	const before = logical(f);
	const usage = [
		[{ taskId: f.ids["completed-1"], as: "discarded", reason: "ok" }, { taskId: f.ids.failed, as: "discarded" }],
		[{ taskId: f.ids["completed-1"], as: "discarded", reason: "ok" }, { taskId: f.ids["completed-1"], as: "discarded", reason: "ok" }],
		[{ taskId: f.ids["completed-1"], as: "discarded", reason: "ok", extra: 1 }],
		[{ taskId: f.ids["completed-1"], as: "deployed", commit: "xyz", reason: "ok" }],
		[], {}, "x",
	];
	for (const body of usage) {
		writeFileSync(join(f.dir, "usage.json"), JSON.stringify(body));
		const bad = await cli(f, ["task", "dispose", "--batch", join(f.dir, "usage.json")]);
		expect({ body, exit: bad.exit, stdout: bad.stdout }).toEqual({ body, exit: 1, stdout: "" });
		expect(bad.stderr).toStartWith('{"ok":false,"error":"');
	}
	expect(logical(f)).toBe(before);
	expect(calls(f)).toBe(2);
});

test("batch size at the limit, limit minus one and limit plus one", async () => {
	const f = seed(root, 1);
	const { fleet } = hub(f);
	const many = (n: number) => Array.from({ length: n }, (_, i) => ({ taskId: `missing-${i}`, as: "discarded", reason: "r" }));
	for (const n of [DISPOSE_BATCH_LIMIT - 1, DISPOSE_BATCH_LIMIT]) {
		const results = await fleet.disposeBatch(many(n));
		expect(results).toHaveLength(n);
		expect(new Set(results.map((r: any) => r.code))).toEqual(new Set(["TASK_NOT_FOUND"]));
	}
	await expect(fleet.disposeBatch(many(DISPOSE_BATCH_LIMIT + 1))).rejects.toMatchObject({ code: "DISPOSE_INPUT" });
	expect(DISPOSE_BATCH_LIMIT).toBe(500);
	expect(calls(f)).toBe(0);
});

test("listings: tasks --disposition filter, compact marker, show and the dashboard archived list", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	await fleet.dispose(f.ids["completed-0"]!, { kind: "deployed", commit: "abcdef0", reason: "landed" });
	await fleet.dispose(f.ids["completed-1"]!, { kind: "review-recorded", subject: "s", verdict: "clean", reason: "review" });
	const json = async (args: string[]) => { const r = await cli(f, args); expect(r.exit).toBe(0); return JSON.parse(r.stdout); };
	expect((await json(["tasks", "--disposition", "deployed"])).map((t: any) => t.id)).toEqual([f.ids["completed-0"]]);
	expect((await json(["tasks", "--disposition", "deployed,review-recorded", "--phase", "archived"])).map((t: any) => t.id).sort()).toEqual([f.ids["completed-0"], f.ids["completed-1"]].sort());
	expect(await json(["tasks", "--disposition", "discarded"])).toEqual([]);
	// The plainly archived task is archived but carries no disposition.
	expect((await json(["tasks", "--phase", "archived"])).map((t: any) => [t.id, t.disposition?.kind ?? null]).sort()).toEqual(
		[[f.ids.archived, null], [f.ids["completed-0"], "deployed"], [f.ids["completed-1"], "review-recorded"]].sort());
	const bad = await cli(f, ["tasks", "--disposition", "succeeded"]);
	expect({ exit: bad.exit, stderr: bad.stderr }).toEqual({ exit: 1, stderr: '{"ok":false,"error":"invalid_task_disposition"}\n' });
	const compact = (await cli(f, ["tasks", "--compact", "--phase", "archived"])).stdout.trim().split("\n").map((l) => l.split("\t"));
	const byId = new Map(compact.map((c) => [c[0], c]));
	expect(byId.get(f.ids["completed-0"]!.slice(0, 12))!.slice(6)).toEqual(["disposed=deployed:abcdef0(operator-record,not-verified)"]);
	expect(byId.get(f.ids["completed-1"]!.slice(0, 12))!.slice(6)).toEqual(["disposed=review-recorded:clean(operator-record,not-verified)"]);
	expect(byId.get(f.ids.archived!.slice(0, 12))!).toHaveLength(6);
	const ro = await cli(f, ["--read-only", "tasks", "--disposition", "deployed", "--compact"]);
	expect(ro.exit === 0 || ro.stderr.includes("unable to open")).toBe(true);
	const state = getDashboardState(store);
	const archived = new Map(state.archivedTasks.map((t) => [t.id, t]));
	expect(archived.get(f.ids["completed-0"]!)!.disposition).toMatchObject({ kind: "deployed", commit: "abcdef0", verifiedByFleet: false });
	expect(archived.get(f.ids.archived!)!).not.toHaveProperty("disposition");
	// Review 366d3a82 F2: the dashboard carries a bounded summary, never the full record (no fixed statement, no request digest; texts cut to 200).
	const published = archived.get(f.ids["completed-0"]!)!.disposition as Record<string, unknown>;
	expect(published).not.toHaveProperty("statement");
	expect(published).not.toHaveProperty("requestDigest");
	expect(published).not.toHaveProperty("nodeRetired");
	for (const text of [published.reason, published.actor]) expect((text as string).length).toBeLessThanOrEqual(200);
	expect(store.task(f.ids["completed-0"]!)!.disposition).toHaveProperty("statement");
	expect(state.tasks.some((t) => t.id === f.ids["completed-0"])).toBe(false);
	const html = renderDashboardHtml();
	expect(html).toContain("Recorded as deployed · operator record, not verified by Fleet");
});

test("result store switch OFF and ON (database at ladder v2): no externalised write, user_version, counters and blob directory unchanged", async () => {
	for (const on of [false, true]) {
		const f = seed();
		const { store, fleet } = hub(f);
		if (on) store.enableResultStore({ actor: "test", reason: "production has it on" });
		const status = store.resultStoreStatus(), version = userVersion(f), files = blobs(f);
		expect({ on, userVersion: version, externalResults: status.externalResults, oneWayStepTaken: status.oneWayStepTaken }).toEqual({ on, userVersion: 2, externalResults: 0, oneWayStepTaken: false });
		const results = Object.fromEntries(["completed-0", "completed-1", "completed-2"].map((k) => [k, storedResult(f, f.ids[k]!)]));
		await fleet.dispose(f.ids["completed-0"]!, { kind: "deployed", commit: "abcdef0", reason: "x" });
		await fleet.disposeBatch([{ taskId: f.ids["completed-1"], as: "discarded", reason: "x" }, { taskId: f.ids["completed-2"], as: "superseded", by: f.ids["completed-0"], reason: "x" }]);
		for (const k of Object.keys(results)) {
			expect(store.taskState(f.ids[k]!)!.phase).toBe("archived");
			expect(storedResult(f, f.ids[k]!)).toEqual(results[k]!);
		}
		expect({ on, status: store.resultStoreStatus(), userVersion: userVersion(f), blobs: blobs(f) }).toEqual({ on, status, userVersion: version, blobs: files });
		expect(store.events(f.ids["completed-0"]!).some((e) => e.kind === "result_store_format_step")).toBe(false);
		// A disposed task's inline result stays eligible for an explicit migrate results, exactly as before.
		if (on) expect(store.migrateResults(false)).toMatchObject({ archived: 0 });
	}
});

test("externalised result (ladder v3): the reference is carried over and the blobs are never opened", async () => {
	const f = seed(root, 0);
	const { store } = hub(f);
	store.enableResultStore({ actor: "test", reason: "externalised fixture" });
	// One externalised settled result made through the real save path.
	const task = store.reserve(store.submit({ schemaVersion: 1, key: "ext", caller: "dispose", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any).id);
	store.recordSession(task.id, "session-ext");
	store.recordTurn(task.id, "turn-ext");
	const { observationDigest } = await import("../src/core");
	const o = { sessionId: "session-ext", turnId: "turn-ext", status: "completed_unverified" as const, terminal: true, evidence: { x: 1 } };
	store.observe(task.id, { ...o, eventId: "e-ext", digest: observationDigest(o) });
	store.saveResult(task.id, { status: "verified", patch: "+x\n".repeat(4096), files: [{ path: "x" }], tests: [{ argv: ["true"] }] });
	expect(storedResult(f, task.id).form).toBe("external");
	const result = storedResult(f, task.id), status = store.resultStoreStatus(), version = userVersion(f), files = blobs(f);
	expect(version).toBe(3);
	// Unreadable result directory: any read of the body would fail; dispose never opens it.
	chmodSync(`${f.db}.results`, 0o000);
	try {
		const fleet = new Fleet(store);
		expect((await fleet.dispose(task.id, { kind: "discarded", reason: "x" })).outcome).toBe("disposed");
	} finally { chmodSync(`${f.db}.results`, 0o700); }
	expect(storedResult(f, task.id)).toEqual(result);
	expect({ status: store.resultStoreStatus(), version: userVersion(f), files: blobs(f) }).toEqual({ status, version, files });
	expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
});

test("run, run --wait and watch --all-active treat a disposed task exactly as an archived one", async () => {
	const f = seed();
	const { fleet } = hub(f);
	await fleet.dispose(f.ids["completed-0"]!, { kind: "discarded", reason: "x" });
	const input = (key: string) => ({ schemaVersion: 1, key, caller: "dispose", repoId: "repo", baseCommit: "a".repeat(40), prompt: `private ${key}`, required: {} });
	const shape = (s: string, id: string, other: string) => JSON.parse(s.trim().split("\n")[0]!.replaceAll(id, "<ID>").replaceAll(other, "<ID>"));
	for (const wait of [[], ["--wait"]]) {
		const results = [];
		for (const key of ["completed-0", "archived"]) {
			writeFileSync(join(f.dir, `${key}.json`), JSON.stringify(input(key)));
			const r = await cli(f, ["run", join(f.dir, `${key}.json`), ...wait]);
			results.push({ exit: r.exit, line: shape(r.stdout, f.ids[key]!, `session-${key}`), lines: r.stdout.trim().split("\n").length });
		}
		expect(results[0]).toEqual(results[1]);
		expect(results[0]).toMatchObject({ exit: 4, line: { phase: "archived", outcome: "failed", reused: true }, lines: 1 });
	}
	const emitted: any[] = [];
	await watchTasks(fleet, { allActive: true, maxPolls: 1, interval: 10, emit: (v) => emitted.push(v) });
	const watched = Object.keys(emitted.at(-1).tasks);
	expect(watched).not.toContain(f.ids["completed-0"]);
	expect(watched).not.toContain(f.ids.archived);
	expect(watched).toContain(f.ids["completed-1"]);
	const single = await cli(f, ["watch", f.ids["completed-0"]!, "--interval", "10"]);
	expect(single.exit).toBe(0);
	expect(JSON.parse(single.stdout.trim()).phase).toBe("archived");
});

test("after a disposition every later event leaves the row byte-identical: no result collection, test, verification, start, cancel or acceptance", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	await fleet.dispose(id, { kind: "deployed", commit: "abcdef0", reason: "landed" });
	const data = row(f, id), contacted = calls(f);
	await expect(fleet.result(id)).rejects.toMatchObject({ code: "ARCHIVED_TASK" });
	await expect(fleet.result(id, ["true"])).rejects.toMatchObject({ code: "ARCHIVED_TASK" });
	expect(() => store.verifyResult(id, { manual: true })).toThrow("never verified");
	await expect(fleet.acceptLateReceipt(id, { reason: "x" })).rejects.toThrow();
	// start and cancel of an archived task are refusals or no-ops; either way nothing changes (checked below).
	for (const call of [() => fleet.start(id), () => fleet.cancel(id)]) {
		const outcome = await call().then((value: any) => value?.phase ?? value?.task?.phase, (error) => error.code ?? "error");
		expect(["archived", "error", "ARCHIVED_TASK", "NO_HELD_ATTEMPT", "ALREADY_TERMINAL", "CANCEL_UNSUPPORTED"]).toContain(outcome);
	}
	const cliResult = await cli(f, ["result", id]);
	expect({ exit: cliResult.exit, stdout: cliResult.stdout }).toEqual({ exit: 1, stdout: "" });
	expect(row(f, id)).toBe(data);
	expect(calls(f)).toBe(contacted);
	expect(store.taskState(id)!.result!.verified).toBe(false);
	// Without the disposition the same calls reach their own checks (the guard is the disposition, not the phase).
	await expect(fleet.result(f.ids["completed-1"]!)).rejects.toMatchObject({ code: "RESULT_NOT_READY" });
	expect(store.verifyResult(f.ids["completed-1"]!, { manual: true }).phase).toBe("succeeded");
});

test("refusals record a deny-by-default Store.transaction diagnostic with their own code (guard: no violation)", async () => {
	const f = seed();
	const { store, fleet } = hub(f);
	const guard = installDiagnosticGuard(FleetStore);
	try {
		listing(f, [{ sessionId: "session-completed-0", live: true, locator: {} }]);
		await expect(fleet.dispose(f.ids["completed-0"]!, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "ARCHIVE_LIVE_SESSION" });
		listing(f, []);
		await fleet.dispose(f.ids["completed-0"]!, { kind: "discarded", reason: "x" });
		await expect(fleet.dispose(f.ids["completed-0"]!, { kind: "discarded", reason: "y" })).rejects.toMatchObject({ code: "DISPOSE_CONFLICT" });
		const taken = guard.take();
		expect(taken.violations).toEqual([]);
		const diagnostics = store.events(f.ids["completed-0"]!).filter((e) => e.kind === "refused").map((e) => [(e.data as any).action, (e.data as any).failureDiagnostic]);
		expect(diagnostics).toEqual(["fleet:archive_live_session", "fleet:dispose_conflict"].map((code) => ["dispose",
			{ version: 1, use: "diagnostic_only_not_evidence", source: "Store.transaction", phase: "record", errorClass: "FleetError", code, message: "Fleet check refused the step" }]));
		expect(guard.allViolations).toEqual([]);
	} finally { guard.uninstall(); }
});

test("refused while a resource-return pass holds the task's node; admitted once the pass ends", async () => {
	const f = seed(root, 1);
	const { store, fleet } = hub(f, { deferTerminalRelease: true });
	expect(store.claimResourceReturnNode("n1", "probe-pass")).toBe(true);
	const id = f.ids["completed-0"]!;
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "DISPOSE_RETURN_IN_PROGRESS" });
	expect(store.taskState(id)!.phase).toBe("completed_unverified");
	expect(calls(f)).toBe(0);
	store.releaseResourceReturnNode("n1", "probe-pass");
	expect((await fleet.dispose(id, { kind: "discarded", reason: "x" })).outcome).toBe("disposed");
});

test("a result or result --test already in flight when a disposition commits is refused at its write (recorded), never lands on the disposed row, and exits non-zero", async () => {
	const { observationDigest } = await import("../src/core");
	const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
	for (const mode of ["collect", "verify-test", "result-test"] as const) {
		const f = seed(root, 0);
		const { store, fleet } = hub(f);
		const other = hub(f); // the operator's dispose, from another process on the same database
		const task = store.reserve(store.submit({ schemaVersion: 1, key: `race-${mode}`, caller: "dispose", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any).id);
		const identity = { path: `/work/${task.id}-${task.attemptId}`, taskId: task.id, attemptId: task.attemptId!, nodeId: "n1" };
		store.setWorkspace(task.id, identity as any);
		store.recordSession(task.id, "session-race");
		store.recordTurn(task.id, "turn-race");
		const o = { sessionId: "session-race", turnId: "turn-race", status: "completed_unverified" as const, terminal: true, evidence: { source: "race" } };
		store.observe(task.id, { ...o, eventId: "e-race", digest: observationDigest(o) });
		const now = new Date().toISOString();
		const receipt = { cwd: identity.path, argv: ["true"], exit: 0, stdout: "", stderr: "", stdoutDigest: sha(""), stderrDigest: sha(""), startedAt: now, endedAt: now };
		const manifest = (tests: unknown[]) => ({ schemaVersion: 1, identity, patch: "", patchDigest: sha(""), outputHead: "b".repeat(40),
			producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests, status: tests.length ? "verified" : "not_run" });
		// result-test upgrades an already collected not_run artifact.
		if (mode === "result-test") store.saveResult(task.id, manifest([]) as any);
		let disposed: string | undefined;
		const disposeNow = async () => {
			expect((await other.fleet.dispose(task.id, { kind: "discarded", reason: "rehearsal" })).outcome).toBe("disposed");
			disposed = row(f, task.id);
		};
		// The node's reply arrives after the disposition committed: during collect, or while the verifier runs.
		(fleet as any).requireWorkspaceRoute = () => {};
		(fleet as any).node = async (_task: unknown, request: any) => {
			if (request.action === "test") { await disposeNow(); return receipt; }
			if (mode === "collect") await disposeNow();
			return manifest(request.tests);
		};
		await expect(fleet.result(task.id, mode === "collect" ? undefined : ["true"])).rejects.toMatchObject({ code: "ARCHIVED_TASK" });
		expect(disposed).toBeDefined();
		expect(row(f, task.id)).toBe(disposed!);
		const after = store.task(task.id)!;
		expect({ phase: after.phase, kind: after.disposition?.kind, verified: after.result?.verified, testReceipt: after.testReceipt }).toEqual({ phase: "archived", kind: "discarded", verified: false, testReceipt: undefined });
		expect(after.resultManifest === undefined).toBe(mode !== "result-test");
		const events = store.events(task.id), from = events.findIndex((e) => e.kind === "archived");
		const late = events.slice(from + 1);
		expect(late.map((e) => e.kind).filter((k) => ["result_saved", "verification_receipt", "operation_receipt", "result_verified"].includes(k))).toEqual([]);
		const action = { collect: "saveResult", "verify-test": "recordVerification", "result-test": "recordOperationReceipt" }[mode];
		expect(late.filter((e) => e.kind === "refused").map((e) => [(e.data as any).action, (e.data as any).failureDiagnostic?.code])).toContainEqual([action, "fleet:archived_task"]);
		// A new verifier claim on the disposed task is refused too.
		expect(() => store.claimOperation(task.id, "verify-test", { argv: ["other"] })).toThrow("never tested");
	}
});

test("a node removed from the inventory needs --node-retired REASON, recorded with the disposition", async () => {
	const f = seed(root, 1);
	const { store, fleet } = hub(f);
	const id = f.ids["completed-0"]!;
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x", nodeRetired: "decommissioned" })).rejects.toMatchObject({ code: "ARCHIVE_NODE" });
	const raw = new Database(f.db);
	try { raw.query("DELETE FROM nodes").run(); } finally { raw.close(); }
	await expect(fleet.dispose(id, { kind: "discarded", reason: "x" })).rejects.toMatchObject({ code: "ARCHIVE_NODE" });
	const done = await fleet.dispose(id, { kind: "discarded", reason: "x", nodeRetired: "decommissioned" });
	expect(done.disposition.nodeRetired).toBe("decommissioned");
	expect((store.events(id).at(-1)!.data as any).request).toEqual({ operatorOverride: { kind: "node_retired", reason: "decommissioned" } });
	expect(calls(f)).toBe(0);
});

test.skipIf(!legacyTree)("rows written by the bc98149 tree (FLEET_LEGACY_TREE) dispose correctly and the hub still admits new work", async () => {
	const f = seed(legacyTree!, 3);
	const { store, fleet } = hub(f, { deferTerminalRelease: true });
	expect(userVersion(f)).toBe(2);
	const results = Object.fromEntries(["completed-0", "completed-1", "held"].map((k) => [k, storedResult(f, f.ids[k]!)]));
	const report = await fleet.disposeBatch([
		{ taskId: f.ids["completed-0"], as: "deployed", commit: "bc98149", reason: "landed" },
		{ taskId: f.ids["completed-1"], as: "review-recorded", subject: "legacy review", verdict: "clean", reason: "review" },
		{ taskId: f.ids.held, as: "superseded", by: f.ids["completed-2"], reason: "later" },
		{ taskId: f.ids.archived, as: "discarded", reason: "legacy plain archive" },
	]);
	expect(report.map((r) => r.ok ? r.outcome : r.code)).toEqual(["disposed", "disposed", "DISPOSE_RESOURCE_UNPROVEN", "DISPOSE_CONFLICT"]);
	for (const k of Object.keys(results)) expect(storedResult(f, f.ids[k]!)).toEqual(results[k]!);
	expect(store.taskState(f.ids.held!)!.held).toBe(true);
	expect(userVersion(f)).toBe(2);
	// The legacy plainly archived task is still listed, and new work is admitted on the same database.
	expect(store.taskState(f.ids.archived!)!.disposition).toBeUndefined();
	const fresh = store.reserve(store.submit({ schemaVersion: 1, key: "after-legacy", caller: "dispose", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any).id);
	expect(fresh.held).toBe(true);
	// The legacy tree itself still opens the database and reads the disposed rows as archived.
	const check = Bun.spawnSync([process.execPath, "-e", `const { FleetStore } = await import(${JSON.stringify(join(legacyTree!, "src", "store.ts"))}); const s = new FleetStore(${JSON.stringify(f.db)}); console.log(JSON.stringify(s.tasks().filter(t => t.disposition).map(t => t.phase))); s.close();`], { stdout: "pipe", stderr: "pipe" });
	expect(check.exitCode).toBe(0);
	expect(JSON.parse(check.stdout.toString())).toEqual(["archived", "archived"]);
});

test("review 3123b12a P3: the dashboard summary of a disposition cuts long texts to 200 code points with an ellipsis and never splits a surrogate pair", () => {
	const base = { kind: "review-recorded", verdict: "clean", actor: "operator", at: "2026-11-14T00:00:00.000Z", requestDigest: "d".repeat(64), statement: "Operator record", verifiedByFleet: false } as const;
	const long = dispositionSummary({ ...base, reason: "r".repeat(2000), subject: "s".repeat(500) } as any);
	expect([Array.from(long.reason).length, long.reason.endsWith("…"), Array.from(long.subject!).length, long.subject!.endsWith("…")]).toEqual([200, true, 200, true]);
	const exact = dispositionSummary({ ...base, reason: "r".repeat(200) } as any);
	expect(exact.reason).toBe("r".repeat(200));
	const astral = dispositionSummary({ ...base, reason: "😀".repeat(300) } as any);
	expect(Array.from(astral.reason).length).toBe(200);
	expect(astral.reason).toBe("😀".repeat(199) + "…");
	expect(astral).not.toHaveProperty("statement");
	expect(renderDashboardHtml()).not.toContain("d.statement");
});
