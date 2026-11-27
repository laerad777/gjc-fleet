/**
 * Work-unit Step 1 + 1b: a collected review/report is a DELIVERABLE FACT, never a verification.
 * Port of the DESIGN-v2 prototype `step1.test.ts` onto the production store, plus one test per review finding
 * R6-R15 and R20. Every state below is produced by production store methods except `cancelled` and `archived`
 * rows, which need broker evidence and are shaped by raw SQL exactly as store.ts writes them (stated, as in the
 * prototype). Every test executes code; none scans source.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { renderDashboardFixture } from "./dashboard-vm";
import { FleetStore } from "../src/store";
import { Fleet, validateResult } from "../src/fleet";
import { FleetError, observationDigest, validateTaskInput } from "../src/core";
import { getDashboardState, getDashboardTask } from "../src/dashboard";
import { preflightPlacement } from "../src/placement-preflight";
import { ClawhipControl, controlBinding, type ControlCommand } from "../src/clawhip-control";
import { checkPreparation, collectResult, outputHeadCreated, prepareWorkspace, sha256 as sha256hex } from "../src/workspace";
import { nodeOperation } from "../src/node";
import {
	classifyLegacyReport,
	classifyReport,
	DeliverableUnavailable,
	deliverableViews,
	disableWorkUnits,
	enableWorkUnits,
	LABEL,
	recordDeliverable,
	REVIEW_ORDERING,
	REVIEW_PROMPT_INSTRUCTION,
	ROLE_PROMPT_INSTRUCTION,
	ROLE_REPORT_PATH,
	switchState,
	workUnitState,
	workUnitStatus,
} from "../src/work-unit";
import { headroom } from "./admission-fixture";
import { watchTasks } from "../src/operator-commands";
import { repositoryFixture } from "./fixtures/coordinator";
import { reconsiderQueue } from "../src/index";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const dirs: string[] = [];
const temp = (p: string) => {
	const d = realpathSync.native(mkdtempSync(join(tmpdir(), p)));
	dirs.push(d);
	return d;
};
const stores: { close(): void }[] = [];
afterAll(() => {
	for (const s of stores.splice(0)) try { s.close(); } catch {}
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const base = "a".repeat(40);
/** The base of the author tasks; their agent's commit (outputHead) is `base`, the commit every review reviews. */
const authorBase = "b".repeat(40);
const BRANCH = "fleet/author-work";
const ROLE_PROMPT = "Review the change. " + ROLE_PROMPT_INSTRUCTION;
const REVIEW_PROMPT = ROLE_PROMPT + " " + REVIEW_PROMPT_INSTRUCTION;
const input = (key: string, role: "review" | "report" | null, prompt = role === "review" ? REVIEW_PROMPT : role ? ROLE_PROMPT : "p " + key, subject?: string) => ({
	schemaVersion: 1 as const, key, caller: "lead", repoId: "fleet", baseCommit: base, prompt, required: {},
	...(role === "review" ? { workUnit: { role, subject: { taskId: subject ?? "no-subject", branch: BRANCH } } } : role ? { workUnit: { role } } : {}),
});
/** The Fleet author task of a store (built once): role-less, its agent committed `base` on top of authorBase. */
const authors = new WeakMap<FleetStore, string>();
function authorFor(store: FleetStore): string {
	if (!authors.has(store)) authors.set(store, build(store, { key: "author", files: [{ path: "src/a.ts", text: "x" }], patch: "diff --git a/src/a.ts b/src/a.ts\n", role: null, author: true }));
	return authors.get(store)!;
}
const reviewInput = (store: FleetStore, key: string, prompt?: string) => input(key, "review", prompt, authorFor(store));
function nodeFor(dir: string) {
	return { id: "win", os: process.platform, arch: process.arch, roots: { fleet: dir }, workspaceRoot: join(dir, "w"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["m"], operations: ["write"], transport: { command: "must-not-execute", args: [] }, sdkTransport: { command: "must-not-execute", args: [] } } as any;
}
function open(path: string, options?: ConstructorParameters<typeof FleetStore>[2]) {
	const store = new FleetStore(path, 100, { deferTerminalRelease: true, ...options });
	stores.push(store);
	return store;
}
function fresh(prefix = "wu-") {
	const dir = temp(prefix);
	const path = join(dir, "fleet.sqlite");
	const store = open(path);
	store.putNode(nodeFor(dir));
	return { dir, path, store };
}

type FileSpec = { path: string; text?: string; bytes?: Buffer; deleted?: boolean };
type Spec = {
	key: string;
	files?: FileSpec[];
	patch?: string;
	turn?: "completed" | "failed" | "receiptless" | "receiptless_late_accepted" | "provisional" | "none";
	role?: "review" | "report" | null;
	save?: boolean;
	shape?: "cancelled" | "archived";
	claimTest?: boolean;
	tests?: boolean;
	/** A role-less author task: baseCommit authorBase, outputHead base. */
	author?: boolean;
	/** An author result saved without the node's separate creation proof (asked and not obtained: `not_created`). */
	unproven?: boolean;
	/** The session id to record (default: a fresh `s-N`). */
	session?: string;
	/** Pin the task to this node (required.nodeId). */
	nodeId?: string;
};
function fileEntry(f: FileSpec) {
	const bytes = f.deleted ? Buffer.alloc(0) : (f.bytes ?? Buffer.from(f.text ?? ""));
	return { path: f.path, bytes: bytes.length, sha256: sha(bytes), contentBase64: bytes.toString("base64"), deleted: !!f.deleted, mode: f.deleted ? 0 : 0o644, type: f.deleted ? "deleted" : "regular" };
}
let counter = 0;
/** The identity the task row records for its workspace; a task without one is a broken fixture, as `identity!.baseCommit` threw before. */
function identityBaseCommit(identity: unknown): unknown {
	if (identity === null || typeof identity !== "object" || Array.isArray(identity)) throw new Error("task has no workspace identity");
	return "baseCommit" in identity ? identity.baseCommit : undefined;
}
function manifestFor(store: FleetStore, id: string, s: Pick<Spec, "files" | "patch" | "tests" | "author" | "unproven">) {
	const identity = store.task(id)!.workspace;
	const patch = s.patch ?? "";
	const tests = s.tests ? [{ argv: ["bun", "test"], cwd: ".", exit: 0, stdout: "", stderr: "", stdoutDigest: sha(""), stderrDigest: sha(""), startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z" }] : [];
	return { schemaVersion: 1, identity, patch, patchDigest: sha(patch), outputHead: s.author ? base : identityBaseCommit(identity), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: (s.files ?? []).map(fileEntry), tests, status: s.tests ? "verified" : "not_run" } as any;
}
/** A production-store task in the requested state; the switch must be on for a role input. */
function build(store: FleetStore, s: Spec): string {
	const i = ++counter;
	const chosen = s.author ? { ...input(s.key, null), baseCommit: authorBase } : s.role === "review" ? reviewInput(store, s.key) : input(s.key, s.role ?? null);
	const submitted = s.nodeId ? { ...chosen, required: { nodeId: s.nodeId } } : chosen;
	const task = store.reserve(store.submit(submitted as any).id);
	if (s.turn === "none") return task.id;
	const node = store.nodes().find((n) => n.id === task.nodeId)!;
	const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: node.id, inputDigest: task.inputDigest, path: join(node.workspaceRoot, task.id), repo: node.roots.fleet, baseCommit: submitted.baseCommit };
	store.setWorkspace(task.id, identity);
	const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
	const session = s.session ?? `s-${i}`;
	store.recordSession(task.id, session, true, { operationId: create.id, ephemeral: true, cwd: identity.path } as any);
	store.recordTurn(task.id, "turn");
	const turn = s.turn ?? "completed";
	const evidence: any = { native: "settled", execution: { commandId: `cmd-${i}`, turnId: `rt-${i}` } };
	const settledAt = new Date().toISOString();
	const body: any =
		turn === "completed" ? { sessionId: session, turnId: "turn", status: "completed_unverified", terminal: true, evidence }
		: turn === "failed" ? { sessionId: session, turnId: "turn", status: "failed", terminal: true, evidence }
		: turn === "provisional" ? { sessionId: session, turnId: "turn", status: "completed_unverified", terminal: false, evidence }
		: { sessionId: session, turnId: "turn", status: "failed", terminal: true, evidence,
			settlement: { kind: "failed_without_receipt", receiptState: "missing", cause: "runtime receipt absent", settledAt, lateObservationUntil: new Date(Date.now() + 86400000).toISOString() } };
	store.observe(task.id, { eventId: `e-${i}`, digest: observationDigest(body), ...body });
	if (turn === "receiptless_late_accepted") {
		const lateDigest = "9".repeat(64);
		store.recordLateReceipt(task.id, { status: "terminal_ok", digest: lateDigest, observedAt: new Date().toISOString(), terminalAt: Date.now(), outcome: { ok: true }, sessionId: session, turnId: "turn", runtimeCommandId: `cmd-${i}`, runtimeTurnId: `rt-${i}` } as any);
		store.acceptLateReceipt(task.id, { actor: "operator", reason: "genuine late receipt", digest: lateDigest, evidence: { freshRead: true } } as any);
	}
	if (s.shape) shape(store, task.id, s.shape);
	if (s.claimTest) store.claimOperation(task.id, "verify-test", { argv: ["bun", "test"] });
	if (s.save !== false) store.saveResult(task.id, manifestFor(store, task.id, s), s.author ? (s.unproven ? { created: false, reason: "not_created" } : { created: true }) : undefined);
	return task.id;
}
/** store.ts cancel (phase cancelled, executionTerminal forced true) and archive (archivedFrom keeps phase/result). */
function shape(store: FleetStore, id: string, kind: "cancelled" | "archived") {
	const db: Database = (store as any).db;
	const data = JSON.parse(rowData(db, id));
	if (kind === "cancelled") {
		data.phase = "cancelled";
		data.result = { ...data.result, executionTerminal: true };
	} else {
		data.archivedFrom = { phase: data.phase, result: data.result };
		data.phase = "archived";
		data.archivedAt = new Date().toISOString();
	}
	data.held = false;
	db.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(data), id);
}
const rowData = (db: Database, id: string) => (db.query("SELECT data FROM tasks WHERE id=?").get(id) as any).data as string;
const rows = (db: Database, id: string) => db.query("SELECT * FROM task_deliverables WHERE task_id=?").all(id) as any[];
/** The heads the node proved created for a task: its `output_head_created` audit rows (outside the manifest). */
const proofs = (store: FleetStore, id: string) => ((store as any).db as Database).query("SELECT data FROM audit WHERE task_id=? AND kind='output_head_created' ORDER BY sequence").all(id).map((r: any) => JSON.parse(r.data).outputHead);
const dbOf = (store: FleetStore): Database => (store as any).db;
const enable = (store: FleetStore) => enableWorkUnits(store, { actor: "operator", reason: "step 1 trial" });
const record = (store: FleetStore, id: string, operator?: any) => recordDeliverable(store, id, { validate: validateResult, ...(operator ? { operator } : {}) });
const report = (text: string) => [{ path: ROLE_REPORT_PATH, text }];
/** A review report: its first line is the verdict line. */
const verdictReport = (text: string) => report("VERDICT: NOT CLEAN\n" + text);
/** Build, then saveResult with path (a) faulted (its SAVEPOINT cannot open): the save itself must commit. */
function buildSkippingRecord(store: FleetStore, s: Spec): string {
	const id = build(store, { ...s, save: false });
	const access = store.workUnitAccess();
	const db = new Proxy(access.db, { get: (target, key) => (key === "exec" ? () => { throw new Error("process died"); } : typeof Reflect.get(target, key) === "function" ? (Reflect.get(target, key) as any).bind(target) : Reflect.get(target, key)) });
	const spy = spyOn(store, "workUnitAccess").mockImplementation(() => ({ ...access, db }));
	try { store.saveResult(id, manifestFor(store, id, s)); } finally { spy.mockRestore(); }
	return id;
}

// ---- the main fixture: one production DB, switch on, every state -----------------------------------------
const SPECS: Spec[] = [
	{ key: "ok-review", files: report("VERDICT: CLEAN\n# Review\nfindings: none blocking\n"), role: "review" },
	{ key: "ok-report", files: report("# Investigation\nresult store notes\n"), role: "report" },
	{ key: "prose-clean", files: report("## Verdict: CLEAN"), role: "review" },
	{ key: "one-byte", files: report("\n"), role: "review" },
	{ key: "nul-only", files: [{ path: ROLE_REPORT_PATH, bytes: Buffer.from([0, 0, 0]) }], role: "review" },
	{ key: "zwsp-only", files: report("\u200b\u200d\ufeff \u2060"), role: "review" },
	{ key: "bom-only", files: [{ path: ROLE_REPORT_PATH, bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x0a]) }], role: "review" },
	{ key: "no-report", files: [], role: "review" },
	{ key: "root-report", files: [{ path: "report-1234.md", text: "## Verdict: CLEAN" }], role: "review" },
	{ key: "case-variant", files: [{ path: "fleet-review/Report.md", text: "x" }], role: "review" },
	{ key: "extra-file", files: [...report("ok\n"), { path: "fleet-review/notes.md", text: "n" }], role: "review" },
	{ key: "deleted-report", files: [{ path: ROLE_REPORT_PATH, deleted: true }], role: "review" },
	{ key: "changed-code", files: [...report("ok\n"), { path: "src/a.ts", text: "x" }], patch: "diff --git a/src/a.ts b/src/a.ts\n", role: "review" },
	{ key: "not-utf8", files: [{ path: ROLE_REPORT_PATH, bytes: Buffer.from([0xff, 0xfe, 0x41]) }], role: "report" },
	{ key: "failed-turn", files: report("half a review\n"), turn: "failed", role: "review" },
	{ key: "receiptless", files: report("review without receipt\n"), turn: "receiptless", role: "review" },
	{ key: "receiptless-late", files: report("review, late receipt accepted\n"), turn: "receiptless_late_accepted", role: "review" },
	{ key: "provisional", files: report("not settled\n"), turn: "provisional", role: "review" },
	{ key: "not-collected", turn: "completed", save: false, role: "review" },
	{ key: "cancelled", files: report("half-written review\n"), role: "review", shape: "cancelled" },
	{ key: "archived", files: report("archived review\n"), turn: "failed", role: "review", shape: "archived" },
	{ key: "claimed-test", files: report("claimed test\n"), role: "review", claimTest: true },
	{ key: "tested-manifest", files: report("with tests\n"), role: "review", tests: true },
	{ key: "role-less", files: report("legacy review\n"), role: null },
	{ key: "legacy-root", files: [{ path: "report-0f8fad5b-d9cb-469f-a165-70867728950e.md", text: "# legacy root report\n" }], role: null },
	{ key: "legacy-bad-name", files: [{ path: "report-1234.md", text: "# legacy\n" }], role: null },
	{ key: "legacy-nested", files: [{ path: "docs/report-0f8fad5b-d9cb-469f-a165-70867728950e.md", text: "# legacy\n" }], role: null },
	{ key: "queued-role", turn: "none", role: "review" },
];
let main: { dir: string; path: string; store: FleetStore };
const ids: Record<string, string> = {};
const before: Record<string, string> = {};
beforeAll(() => {
	main = fresh("wu-main-");
	enable(main.store);
	for (const s of SPECS) ids[s.key] = build(main.store, s);
});

describe("work-unit switch (table AND row)", () => {
	test("off by default; on = table and row; table without row = inconsistent: role submits and recordings refused, reads work", async () => {
		const { store, path } = fresh();
		expect(workUnitState(store)).toBe("off");
		expect(dbOf(store).query("SELECT 1 FROM sqlite_master WHERE name IN ('task_deliverables','work_unit_switch')").get()).toBeNull();
		const roleLess = build(store, { key: "plain", files: report("x\n"), role: null });
		expect(record(store, roleLess)).toEqual({ outcome: "not_ready", reason: "switch_off" });
		expect(enable(store)).toEqual({ changed: true, state: "on" });
		expect(enable(store)).toEqual({ changed: false, state: "on" });
		const id = build(store, { key: "role", files: verdictReport("# r\n"), role: "review" });
		dbOf(store).exec("DELETE FROM work_unit_switch");
		expect(workUnitState(store)).toBe("inconsistent");
		expect(() => store.submit(input("role-2", "review") as any)).toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
		const fleet = new Fleet(store);
		expect(() => fleet.submit(input("role-3", "review") as any, headroom(["win"], 2))).toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
		expect(() => record(store, id)).toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
		expect(() => enable(store)).toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
		// Reads keep working and show nothing (today's view).
		expect(deliverableViews(store)).toBeUndefined();
		expect(workUnitStatus(store).state).toBe("inconsistent");
		expect(getDashboardState(store).pipeline.outcome).not.toHaveProperty("reportsCollected");
		// Role-less work is untouched.
		expect(store.submit(input("plain-2", null) as any).phase).toBe("queued");
		dbOf(store).exec("INSERT INTO work_unit_switch VALUES (1,'2026-11-13T00:00:00Z','operator','repair')");
		expect(workUnitState(store)).toBe("on");
		expect(rows(dbOf(store), id)).toHaveLength(1);
		// Enabling is refused during rollback (a fresh DB: rollback is permanent).
		const other = fresh();
		other.store.enterRollback();
		expect(() => enable(other.store)).toThrow(expect.objectContaining({ code: "DISPATCH_DISABLED" }));
		expect(workUnitState(other.store)).toBe("off");
		void path;
	});
	test("enable and disable are audited; disable drops only the switch table and records stay", () => {
		const { store } = fresh();
		enable(store);
		const id = build(store, { key: "r", files: report("# r\n"), role: "report" });
		expect(disableWorkUnits(store, { actor: "operator", reason: "trial over" })).toEqual({ changed: true, state: "off" });
		expect(workUnitState(store)).toBe("off");
		expect(rows(dbOf(store), id)).toHaveLength(1);
		expect(deliverableViews(store)).toBeUndefined();
		const audit = dbOf(store).query("SELECT kind FROM audit WHERE task_id IS NULL AND kind LIKE 'work_unit_switch_%' ORDER BY sequence").all();
		expect(audit).toEqual([{ kind: "work_unit_switch_enabled" }, { kind: "work_unit_switch_disabled" }]);
		expect(enable(store)).toEqual({ changed: true, state: "on" });
		expect(deliverableViews(store)!.get(id)!.kind).toBe("report_collected");
	});
});

describe("Step 1: a collected report is a deliverable fact (port of prototype step1.test.ts)", () => {
	test("recorded inside saveResult: row written, task row unchanged by recording, never succeeded/verified", () => {
		const db = dbOf(main.store);
		for (const key of ["ok-review", "ok-report"]) {
			const [row] = rows(db, ids[key]!);
			expect([key, row.kind, row.basis, row.reason]).toEqual([key, "report_collected", "role_tag", null]);
			const t = JSON.parse(rowData(db, ids[key]!));
			expect(t.phase).toBe("completed_unverified");
			expect(t.result.verified).toBe(false);
			expect(t.result.verificationEvidence).toBeUndefined();
			// Path (c) on an already recorded task is a no-op and leaves tasks.data byte-identical (P1).
			const data = rowData(db, ids[key]!);
			const again = record(main.store, ids[key]!) as any;
			expect([again.outcome, again.changed]).toEqual(["recorded", false]);
			expect(rowData(db, ids[key]!)).toBe(data);
		}
		const saved = (db.query("SELECT data FROM audit WHERE task_id=? AND kind='result_saved'").get(ids["ok-review"]!) as any).data;
		const [row] = rows(db, ids["ok-review"]!);
		expect(row.manifest_digest).toBe(JSON.parse(saved).digest);
		expect(row.report_sha256).toBe(sha("VERDICT: CLEAN\n# Review\nfindings: none blocking\n"));
		expect(row.report_path).toBe(ROLE_REPORT_PATH);
		const audit = db.query("SELECT data FROM audit WHERE task_id=? AND kind='deliverable_recorded'").all(ids["ok-review"]!) as any[];
		expect(audit).toHaveLength(1);
		expect(JSON.parse(audit[0].data)).toMatchObject({ kind: "report_collected", recordDigest: row.record_digest, basis: "role_tag" });
		expect(() => db.exec(`UPDATE task_deliverables SET kind='report_rejected', reason='x' WHERE task_id='${ids["ok-review"]}'`)).toThrow("append-only");
		expect(() => db.exec(`DELETE FROM task_deliverables WHERE task_id='${ids["ok-review"]}'`)).toThrow("append-only");
	});
	test("contract violations are report_rejected facts about the manifest; phase unchanged (R13 NUL/zero-width/BOM-only = empty)", () => {
		const db = dbOf(main.store);
		const cases: [string, string][] = [
			// A review whose first line is not the verdict line (prose '## Verdict: CLEAN' is not one).
			["prose-clean", "verdict_missing"],
			["one-byte", "report_empty"],
			["nul-only", "report_empty"],
			["zwsp-only", "report_empty"],
			["bom-only", "report_empty"],
			["no-report", "report_not_in_manifest"],
			["root-report", "report_outside_contract"],
			["case-variant", "report_outside_contract"],
			["extra-file", "report_outside_contract"],
			["deleted-report", "report_outside_contract"],
			["changed-code", "report_changed_code"],
			["not-utf8", "report_not_utf8"],
		];
		for (const [key, reason] of cases) {
			const [row] = rows(db, ids[key]!);
			expect([key, row?.kind, row?.reason]).toEqual([key, "report_rejected", reason]);
			expect(JSON.parse(rowData(db, ids[key]!)).phase).toBe("completed_unverified");
		}
	});
	test("cancelled, failed-turn, receipt-less (with and without accepted late receipt), archived, provisional, uncollected, role-less, not started ⇒ not_ready, no row", () => {
		const db = dbOf(main.store);
		const late = JSON.parse(rowData(db, ids["receiptless-late"]!));
		expect(late.phase).toBe("completed_unverified");
		expect(late.result.settlement).toBeDefined();
		const cases: [string, string][] = [
			["cancelled", "phase_cancelled"],
			["failed-turn", "phase_failed"],
			["receiptless", "phase_failed"],
			["receiptless-late", "receiptless_settlement"],
			["archived", "phase_archived"],
			["provisional", "execution_not_terminal"],
			["not-collected", "manifest_not_saved"],
			["role-less", "not_role_tagged"],
			["queued-role", "phase_preparing"],
		];
		for (const [key, reason] of cases) {
			const data = rowData(db, ids[key]!);
			expect([key, record(main.store, ids[key]!)]).toEqual([key, { outcome: "not_ready", reason }]);
			expect(rowData(db, ids[key]!)).toBe(data);
			expect(rows(db, ids[key]!)).toEqual([]);
		}
	});
	test("crash between saveResult COMMIT and recording: `deliverable ID` (path c) records exactly once", () => {
		const { store } = fresh();
		enable(store);
		// The production saveResult commits; recording is skipped as if the process died right after COMMIT.
		const id = buildSkippingRecord(store, { key: "crash", files: report("# crash case\n"), role: "report" });
		const db = dbOf(store);
		expect(store.task(id)!.resultManifest).toBeDefined();
		expect(rows(db, id)).toEqual([]);
		const data = rowData(db, id);
		const first = record(store, id) as any;
		const second = record(store, id) as any;
		expect([first.outcome, first.changed, second.changed]).toEqual(["recorded", true, false]);
		expect(rows(db, id)).toHaveLength(1);
		expect(rowData(db, id)).toBe(data);
	});
	test("a differing record for the same task is VERIFICATION_CONFLICT (audited refusal); nothing written", () => {
		const id = ids["ok-review"]!;
		const db = dbOf(main.store);
		const task = main.store.task(id)!;
		const tampered = structuredClone(task) as any;
		tampered.resultManifest.files[0].contentBase64 = Buffer.from("other\n").toString("base64");
		tampered.resultManifest.files[0].sha256 = sha("other\n");
		tampered.resultManifest.files[0].bytes = 6;
		// A differing manifest is not bound to the saved result: not_ready before the conflict check.
		expect(recordDeliverable(main.store, id, { validate: validateResult, task: tampered })).toEqual({ outcome: "not_ready", reason: "manifest_not_bound_to_saved_result" });
		const bytes = db.query("SELECT count(*) n FROM task_deliverables").get();
		// A different record body for the same bound manifest (another role) is the conflict.
		const otherRole = structuredClone(task) as any;
		otherRole.input.workUnit = { role: "report" };
		expect(() => recordDeliverable(main.store, id, { validate: validateResult, task: otherRole })).toThrow(expect.objectContaining({ code: "VERIFICATION_CONFLICT" }));
		expect(db.query("SELECT count(*) n FROM task_deliverables").get()).toEqual(bytes);
		const refused = db.query("SELECT data FROM audit WHERE task_id=? AND kind='refused' ORDER BY sequence DESC LIMIT 1").get(id) as any;
		expect(JSON.parse(refused.data)).toMatchObject({ action: "recordDeliverable", code: "VERIFICATION_CONFLICT", failureDiagnostic: { code: "fleet:verification_conflict" } });
	});
	test("two processes recording the same task concurrently ⇒ exactly one row (X4)", async () => {
		const { store, path } = fresh();
		enable(store);
		const id = buildSkippingRecord(store, { key: "race", files: verdictReport("# race\n"), role: "review" });
		expect(store.task(id)!.resultManifest).toBeDefined();
		expect(rows(dbOf(store), id)).toEqual([]);
		const script = `import { FleetStore } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
import { validateResult } from ${JSON.stringify(join(import.meta.dir, "../src/fleet.ts"))};
import { recordDeliverable } from ${JSON.stringify(join(import.meta.dir, "../src/work-unit.ts"))};
const store = new FleetStore(process.argv[2], 100, { deferTerminalRelease: true });
try { const o = recordDeliverable(store, process.argv[3], { validate: validateResult }); console.log(JSON.stringify(o.outcome === "recorded" ? { outcome: o.outcome, changed: o.changed } : o)); }
catch (e) { console.log(JSON.stringify({ error: e.code ?? e.message })); } finally { store.close(); }`;
		const file = join(temp("wu-race-"), "race.ts");
		writeFileSync(file, script);
		const outs = await Promise.all([0, 1, 2].map(async () => {
			const child = Bun.spawn([process.execPath, file, path, id], { stdout: "pipe", stderr: "pipe" });
			const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return JSON.parse(out.trim());
		}));
		expect(outs.filter((o) => o.changed === true)).toHaveLength(1);
		for (const o of outs) expect(o.outcome === "recorded" || o.error !== undefined).toBe(true);
		expect(rows(dbOf(store), id)).toHaveLength(1);
	});
});

describe("review findings R6-R15, R20", () => {
	test("R6: TEST_UNKNOWN / claimed verify-test, a tested manifest, and a test argv on a role task never yield a record", async () => {
		const db = dbOf(main.store);
		expect(rows(db, ids["claimed-test"]!)).toEqual([]);
		expect(record(main.store, ids["claimed-test"]!)).toEqual({ outcome: "not_ready", reason: "test_unknown_or_claimed" });
		expect(rows(db, ids["tested-manifest"]!)).toEqual([]);
		expect(record(main.store, ids["tested-manifest"]!)).toEqual({ outcome: "not_ready", reason: "test_evidence_present" });
		// `result ID ARGV` on a role task is refused before any claim.
		const fleet = new Fleet(main.store);
		const ops = () => db.query("SELECT count(*) n FROM operations WHERE task_id=?").get(ids["ok-review"]!);
		const n = ops();
		await expect(fleet.result(ids["ok-review"]!, ["bun", "test"])).rejects.toThrow(expect.objectContaining({ code: "ROLE_NO_TESTS" }));
		expect(ops()).toEqual(n);
		// Without ARGV the cached result is returned unchanged (and the cached branch records nothing new).
		const cached = await fleet.result(ids["ok-review"]!);
		expect(cached.status).toBe("not_run");
	});
	test("R7: a base tree tracking fleet-review/ is refused before any effect for role tasks only; Fleet.start asks for it", async () => {
		const f = await repositoryFixture("wu-r7-");
		dirs.push(f.dir);
		const req = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot };
		await expect(checkPreparation({ ...req, reviewDirAbsent: true })).resolves.toBeDefined();
		for (const tracked of ["fleet-review/report.md", "Fleet-Review/notes.md"]) {
			mkdirSync(join(f.repo, tracked.split("/")[0]!), { recursive: true });
			await writeFile(join(f.repo, tracked), "old report\n");
			await f.git("add", "--", tracked);
			await f.git("commit", "-m", "tracks a review dir");
			const head = await f.git("rev-parse", "HEAD");
			await expect(checkPreparation({ ...req, baseCommit: head, reviewDirAbsent: true })).rejects.toThrow("role_base_has_review_dir");
			await expect(checkPreparation({ ...req, baseCommit: head })).resolves.toBeDefined();
			await f.git("rm", "-q", "-r", "--", tracked.split("/")[0]!);
			await f.git("commit", "-m", "drop it");
		}
		// Through the node protocol: a proven before_send refusal (unsafe_path), nothing materialised.
		mkdirSync(join(f.repo, "fleet-review"), { recursive: true });
		await writeFile(join(f.repo, "fleet-review/report.md"), "old\n");
		await f.git("add", "--", "fleet-review/report.md");
		await f.git("commit", "-m", "again");
		const head = await f.git("rev-parse", "HEAD");
		const node = { id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [] } } as any;
		const prep = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256hex("input"), repoId: "repo", baseCommit: head };
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, reviewDirAbsent: true } })).rejects.toThrow("node_refused:unsafe_path");
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, reviewDirAbsent: false } })).rejects.toThrow("node_refused:invalid_request");
		expect(await nodeOperation(node, { action: "preflight", input: prep })).toEqual({ preflight: "passed" });
		expect(() => statSync(f.workspaceRoot)).toThrow();
		// A real role workspace from a clean base: the report is untracked, the patch empty, the record collected.
		const clean = await repositoryFixture("wu-r7b-");
		dirs.push(clean.dir);
		const identity = await prepareWorkspace({ ...req, repo: clean.repo, baseCommit: clean.baseCommit, workspaceRoot: clean.workspaceRoot, reviewDirAbsent: true });
		mkdirSync(join(identity.path, "fleet-review"));
		writeFileSync(join(identity.path, ROLE_REPORT_PATH), "# real report\n");
		const manifest = await collectResult(identity, []);
		expect(classifyReport(manifest as any)).toEqual({ kind: "report_collected", reportPath: ROLE_REPORT_PATH, reportSha256: sha("# real report\n"), reportBytes: 14 });
		// Fleet.start sends the key only for a role task (the claimed prepare payload).
		const { store } = fresh();
		enable(store);
		// The node is local (explicit identity), so start reaches the prepare claim; its transport then fails.
		const fleet = new Fleet(store, { localNodeId: "win" });
		for (const role of ["review", null] as const) {
			const t = store.reserve(store.submit((role ? reviewInput(store, "start-" + role) : input("start-" + role, role)) as any).id);
			await fleet.start(t.id).catch(() => {});
			const op = store.getOperation(t.id, "prepare") as any;
			expect([role, op?.payload?.reviewDirAbsent]).toEqual([role, role ? true : undefined]);
		}
	});
	test("R8: Step 1b accepts only root report-<uuid>.md or fleet-review/report.md, bound to task id + path + sha, --role required", () => {
		const db = dbOf(main.store);
		const op = (id: string, path: string, text: string, role: any = "review") => ({ actor: "operator", reason: "legacy review, report only", reportPath: path, reportSha256: sha(text), role });
		const legacyRoot = "report-0f8fad5b-d9cb-469f-a165-70867728950e.md";
		expect(() => record(main.store, ids["role-less"]!, { ...op(ids["role-less"]!, ROLE_REPORT_PATH, "legacy review\n"), reportSha256: "0".repeat(64) })).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		expect(() => record(main.store, ids["legacy-bad-name"]!, op("", "report-1234.md", "# legacy\n"))).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		expect(() => record(main.store, ids["legacy-nested"]!, op("", "docs/" + legacyRoot, "# legacy\n"))).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		// The path must be the manifest's only entry: naming the right sha for a different task's path is refused.
		expect(() => record(main.store, ids["role-less"]!, op("", legacyRoot, "# legacy root report\n"))).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		expect(rows(db, ids["role-less"]!)).toEqual([]);
		for (const [key, path, text] of [["role-less", ROLE_REPORT_PATH, "legacy review\n"], ["legacy-root", legacyRoot, "# legacy root report\n"]] as const) {
			const out = record(main.store, ids[key]!, op("", path, text, "report")) as any;
			expect([out.outcome, out.record.basis, out.record.kind, out.record.role, out.record.reportPath]).toEqual(["recorded", "operator_classified", "report_collected", "report", path]);
			const [row] = rows(db, ids[key]!);
			expect([row.actor, row.actor_reason, typeof row.os_user, typeof row.host, row.report_sha256]).toEqual(["operator", "legacy review, report only", "string", "string", sha(text)]);
			const audit = db.query("SELECT data FROM audit WHERE task_id=? AND kind='deliverable_recorded'").get(ids[key]!) as any;
			expect(JSON.parse(audit.data)).toMatchObject({ basis: "operator_classified", actor: "operator", osUser: row.os_user, host: row.host });
		}
		// Role-tagged tasks use the role rule; Step 1b keeps every Step 1 precondition.
		expect(record(main.store, ids["ok-review"]!, op("", ROLE_REPORT_PATH, "x"))).toEqual({ outcome: "not_ready", reason: "role_tagged_task_uses_role_rule" });
		expect(classifyLegacyReport.length).toBe(3);
	});
	test("R9: a work-unit fault inside saveResult never rolls back the evidence save (SAVEPOINT); path c records afterwards", () => {
		const { store } = fresh();
		enable(store);
		const access = store.workUnitAccess();
		// A forced CHECK failure inside the savepoint: an out-of-range report size reaching the INSERT.
		const spy = spyOn(store, "workUnitAccess").mockImplementation(() => ({
			...access,
			audit: () => { access.db.exec("INSERT INTO task_deliverables(task_id) VALUES ('x')"); },
		}));
		const id = build(store, { key: "r9", files: verdictReport("# r9\n"), role: "review" });
		spy.mockRestore();
		const db = dbOf(store);
		expect(store.task(id)!.resultManifest).toBeDefined();
		expect(db.query("SELECT count(*) n FROM audit WHERE task_id=? AND kind='result_saved'").get(id)).toEqual({ n: 1 });
		expect(rows(db, id)).toEqual([]);
		expect(db.query("SELECT count(*) n FROM audit WHERE task_id=? AND kind='refused'").get(id)).toEqual({ n: 0 });
		const out = record(store, id) as any;
		expect([out.outcome, out.changed, out.record.kind]).toEqual(["recorded", true, "report_collected"]);
	});
	test("R10: clawhip collect of a role task is refused at staging and at claim; never claimed or unknown", async () => {
		const { store, dir, path } = fresh();
		enable(store);
		const fleet = new Fleet(store);
		const THREAD = "1569213398762131521";
		const task = fleet.submit(reviewInput(store, "clawhip-role") as any, headroom(["win"], 2));
		const control = new ClawhipControl(join(dir, "control.sqlite"), { thread: THREAD, fleetDb: path }, true);
		stores.push(control);
		const start: ControlCommand = { schema: 1, thread: THREAD, key: "start-1", action: "start", binding: controlBinding(task), testArgv: null };
		const staged = control.stage(start, store);
		control.ingest({ command_ref: staged.command_ref });
		await control.run("start-1", store, {
			async start(id) {
				store.recordSession(id, "sess", true);
				store.recordTurn(id, "turn");
				const body = { sessionId: "sess", turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { injected: true } };
				return store.observe(id, { ...body, eventId: "e-1", digest: observationDigest(body) });
			},
			async inspect() { throw new Error("unused"); },
			async result() { throw new Error("must not run"); },
		}, 500);
		const collect: ControlCommand = { schema: 1, thread: THREAD, key: "collect-1", action: "collect", binding: control.binding(task.id, store), testArgv: [process.execPath, "verify.ts"] };
		expect(() => control.stage(collect, store)).toThrow("Role task");
		const states = new Database(join(dir, "control.sqlite"), { readonly: true });
		try {
			expect(states.query("SELECT key, state FROM commands ORDER BY key").all()).toEqual([{ key: "start-1", state: "done" }]);
		} finally { states.close(); }
	});
	test("R11/R20: an unreadable (v3 externalised) result is not_ready; a store/SQLite error is unavailable; never a rejection or success", () => {
		const { store, path } = fresh();
		enable(store);
		store.enableResultStore({ actor: "operator", reason: "coexistence" });
		const big = "# big report\n" + "x".repeat(4096) + "\n";
		const id = build(store, { key: "external", files: verdictReport(big), role: "review" });
		const db = dbOf(store);
		// Coexistence: recorded from the in-memory manifest; the row is externalised; path c agrees (no-op).
		expect(JSON.parse(rowData(db, id))).toHaveProperty("resultExternal");
		expect(rows(db, id)[0].kind).toBe("report_collected");
		expect((record(store, id) as any).changed).toBe(false);
		// A second task whose recording was skipped, then its blob disappears.
		const lost = buildSkippingRecord(store, { key: "lost", files: verdictReport(big + "lost\n"), role: "review" });
		const external = JSON.parse(rowData(db, lost)).resultExternal;
		expect(external).toBeDefined();
		for (const name of readdirSync(`${path}.results`, { recursive: true }) as string[]) {
			const file = join(`${path}.results`, name);
			if (statSync(file).isFile()) rmSync(file);
		}
		expect(() => store.task(lost)).toThrow(expect.objectContaining({ code: "RESULT_INTEGRITY" }));
		expect(record(store, lost)).toEqual({ outcome: "not_ready", reason: "result_unreadable" });
		expect(rows(db, lost)).toEqual([]);
		// SQLite / I-O fault on the write: unavailable, nothing written.
		const access = store.workUnitAccess();
		const fault = spyOn(store, "workUnitAccess").mockImplementation(() => ({ ...access, transaction: () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); } }));
		const other = build(store, { key: "io", files: verdictReport("# io\n"), role: "review" });
		expect(() => record(store, other)).toThrow(DeliverableUnavailable);
		fault.mockRestore();
		// Path (a) never uses the refusal-audited transaction (it runs inside saveResult's), so it recorded.
		expect(rows(db, other)).toHaveLength(1);
	});
	test("R11: CLI prints `unavailable` (exit 1) for a locked store and never a rejection; --read-only refused; 1b needs --role", async () => {
		const { store, path } = fresh();
		enable(store);
		const id = buildSkippingRecord(store, { key: "cli", files: verdictReport("# cli\n"), role: "review" });
		const plain = build(store, { key: "cli-plain", files: report("# plain\n"), role: null });
		const cli = async (...args: string[]) => {
			const preload = args[0] === "--fault" ? ["--preload", fault, ...(args.shift(), [])] : [];
			const child = Bun.spawn([process.execPath, ...preload, join(import.meta.dir, "../src/cli.ts"), "--db", path, "--cap", "100", ...args], { stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			return { stdout, stderr, exit };
		};
		const ro = await cli("--read-only", "deliverable", id);
		expect([ro.exit, ro.stderr.includes("READ_ONLY")]).toEqual([1, true]);
		// Fault injection in the CLI process (preload): the recording transaction fails with a SQLite I/O error.
		const fault = join(temp("wu-fault-"), "fault.ts");
		writeFileSync(fault, `import { FleetStore } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
const original = FleetStore.prototype.workUnitAccess;
FleetStore.prototype.workUnitAccess = function () {
	return { ...original.call(this), transaction: () => { throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" }); } };
};`);
		const busy = await cli("--fault", "deliverable", id);
		expect([busy.exit, JSON.parse(busy.stdout)]).toEqual([1, { ok: false, taskId: id, outcome: "unavailable", verified: false }]);
		expect(rows(dbOf(store), id)).toEqual([]);
		const ok = await cli("deliverable", id);
		expect([ok.exit, JSON.parse(ok.stdout).outcome, JSON.parse(ok.stdout).verified, JSON.parse(ok.stdout).record.kind]).toEqual([0, "recorded", false, "report_collected"]);
		const notReady = await cli("deliverable", plain);
		expect([notReady.exit, JSON.parse(notReady.stdout).outcome, JSON.parse(notReady.stdout).reason]).toEqual([1, "not_ready", "not_role_tagged"]);
		const noRole = await cli("deliverable", plain, "--legacy-report", ROLE_REPORT_PATH, "--sha256", sha("# plain\n"), "--actor", "operator", "--reason", "legacy");
		expect([noRole.exit, noRole.stderr.includes("usage_deliverable")]).toEqual([1, true]);
		const classified = await cli("deliverable", plain, "--legacy-report", ROLE_REPORT_PATH, "--sha256", sha("# plain\n"), "--role", "review", "--actor", "operator", "--reason", "legacy");
		expect([classified.exit, JSON.parse(classified.stdout).record.basis]).toEqual([0, "operator_classified"]);
	});
	test("R12: a weak task_deliverables (no triggers / other schema) makes the switch inconsistent and is never adopted", () => {
		const { store } = fresh();
		const db = dbOf(store);
		db.exec("CREATE TABLE task_deliverables (task_id TEXT PRIMARY KEY, kind TEXT)");
		expect(() => enable(store)).toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
		expect(workUnitState(store)).toBe("off");
		db.exec("CREATE TABLE work_unit_switch (id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL, enabled_by TEXT NOT NULL CHECK(length(enabled_by) BETWEEN 1 AND 200), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000))");
		db.exec("INSERT INTO work_unit_switch VALUES (1,'t','o','r')");
		expect(switchState(db)).toBe("inconsistent");
		// Records retained from an earlier enable with the exact schema are re-used.
		const ok = fresh();
		enable(ok.store);
		const id = build(ok.store, { key: "kept", files: verdictReport("# k\n"), role: "review" });
		disableWorkUnits(ok.store, { actor: "operator", reason: "pause" });
		expect(enable(ok.store)).toEqual({ changed: true, state: "on" });
		expect(rows(dbOf(ok.store), id)).toHaveLength(1);
		dbOf(ok.store).exec("DROP TRIGGER task_deliverables_no_delete");
		expect(workUnitState(ok.store)).toBe("inconsistent");
	});
	test("R13: classifier unit cases (NUL, ZWSP, BOM-only, BOM + text, CRLF)", () => {
		const m = (bytes: Buffer) => ({ patch: "", files: [fileEntry({ path: ROLE_REPORT_PATH, bytes })] } as any);
		expect(classifyReport(m(Buffer.from("\0\0"))).kind).toBe("report_rejected");
		expect(classifyReport(m(Buffer.from("\u200b\u200c\u200d\u2060\ufeff\t\r\n "))).kind).toBe("report_rejected");
		expect(classifyReport(m(Buffer.from([0xef, 0xbb, 0xbf]))).kind).toBe("report_rejected");
		expect(classifyReport(m(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# ok\r\n")]))).kind).toBe("report_collected");
		expect(classifyReport(m(Buffer.from("a"))).kind).toBe("report_collected");
		const big = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
		expect(classifyReport(m(big))).toEqual({ kind: "report_rejected", reason: "report_too_large" });
		const lying = { patch: "", files: [{ ...fileEntry({ path: ROLE_REPORT_PATH, text: "a" }), sha256: "0".repeat(64) }] } as any;
		expect(classifyReport(lying)).toEqual({ kind: "report_rejected", reason: "report_digest_mismatch" });
	});
	test("R14: disable is refused while a role task has not started; allowed once it is cancelled/started", () => {
		const { store } = fresh();
		enable(store);
		const queued = store.submit(reviewInput(store, "waiting") as any);
		expect(() => disableWorkUnits(store, { actor: "operator", reason: "off" })).toThrow(expect.objectContaining({ code: "WORK_UNIT_ROLE_TASKS_PENDING" }));
		expect(workUnitState(store)).toBe("on");
		const refused = dbOf(store).query("SELECT data FROM audit WHERE kind='refused' ORDER BY sequence DESC LIMIT 1").get() as any;
		expect(JSON.parse(refused.data)).toMatchObject({ action: "workunitsDisable", code: "WORK_UNIT_ROLE_TASKS_PENDING", failureDiagnostic: { code: "fleet:work_unit_role_tasks_pending" } });
		shape(store, queued.id, "cancelled");
		expect(disableWorkUnits(store, { actor: "operator", reason: "off" })).toEqual({ changed: true, state: "off" });
	});
	test("R15: views — show/tasks gain `deliverable` only while on; dashboard counts and `warn` label; never ok/succeeded", async () => {
		const state = getDashboardState(main.store);
		const all = main.store.taskStates().filter((t) => t.phase === "completed_unverified" && t.result?.executionTerminal === true);
		const outcome = state.pipeline.outcome as any;
		const collected = all.filter((t) => rows(dbOf(main.store), t.id)[0]?.kind === "report_collected");
		const byBasis = (b: string) => collected.filter((t) => rows(dbOf(main.store), t.id)[0].basis === b).length;
		expect(outcome.reportsCollected).toBe(byBasis("role_tag"));
		expect(outcome.reportsClassified).toBe(byBasis("operator_classified"));
		expect(outcome.unverified + outcome.resultMissing + outcome.reportsCollected + outcome.reportsClassified).toBe(all.length);
		expect(outcome.succeeded).toBe(0);
		const card = state.tasks.find((t) => t.id === ids["ok-review"])!;
		expect(card.deliverable).toMatchObject({ kind: "report_collected", basis: "role_tag", label: LABEL.role_tag, verified: false });
		expect(state.tasks.find((t) => t.id === ids["no-report"])!.deliverable!.label).toBe(`${LABEL.rejected} · ${LABEL.report_not_in_manifest}`);
		// Page: the real script renders the label with class warn, never ok.
		const html = await renderPage(state);
		expect(html).toContain(`<span class="chip warn"><b></b><span>${LABEL.role_tag}</span></span>`);
		expect(html).toContain(`<span class="chip warn"><b></b><span>${LABEL.operator_classified}</span></span>`);
		expect(html).not.toContain(`<span class="chip ok"><b></b><span>${LABEL.role_tag}`);
		expect(html).toContain(LABEL.report_not_in_manifest);
		// CLI show/tasks.
		const cli = async (path: string, ...args: string[]) => {
			const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--db", path, "--cap", "100", ...args], { stdout: "pipe", stderr: "pipe" });
			const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			return { stdout, exit };
		};
		const show = JSON.parse((await cli(main.path, "show", ids["ok-review"]!)).stdout);
		expect([show.phase, show.result.verified, show.deliverable.kind, show.deliverable.verified]).toEqual(["completed_unverified", false, "report_collected", false]);
		const listing = JSON.parse((await cli(main.path, "tasks")).stdout) as any[];
		expect(listing.find((t) => t.id === ids["ok-report"]).deliverable.kind).toBe("report_collected");
		// watch --all-active skips report_collected tasks (never inspected, not in the summary); others are watched.
		const lines: any[] = [];
		const inspected: string[] = [];
		const watcher = new Fleet(main.store);
		spyOn(watcher, "inspect").mockImplementation(async (id: string) => { inspected.push(id); throw new FleetError("OBSERVATION_UNAVAILABLE", "controlled"); });
		await watchTasks(watcher, { allActive: true, interval: 10, maxPolls: 1, emit: (v: unknown) => lines.push(v), sleep: async () => {} } as any);
		const summary = lines.at(-1).tasks as Record<string, number>;
		expect(summary).not.toHaveProperty(ids["ok-review"]!);
		expect(summary).not.toHaveProperty(ids["role-less"]!);
		expect(summary).toHaveProperty(ids["no-report"]!);
		expect(inspected).not.toContain(ids["ok-review"]!);
		// Switch off: absent everywhere (records stay).
		const off = fresh();
		enable(off.store);
		const id = build(off.store, { key: "v", files: verdictReport("# v\n"), role: "review" });
		disableWorkUnits(off.store, { actor: "operator", reason: "off" });
		expect(JSON.parse((await cli(off.path, "show", id)).stdout)).not.toHaveProperty("deliverable");
		// The review and its (role-less, completed_unverified) author task.
		expect(getDashboardState(off.store).pipeline.outcome).toEqual({ succeeded: 0, unverified: 2, resultMissing: 0, unsettled: 0, troubled: 0, cancelled: 0, approval: 0 });
	});
});

describe("input key `workUnit` at the four validateTaskInput call sites", () => {
	test("switch off: every call site refuses exactly as code without work units (byte-identical message and code)", async () => {
		const { store } = fresh();
		const role = input("off-role", "review") as any;
		const expected = (() => { try { validateTaskInput(role); } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; } })();
		expect(expected).toEqual({ name: "FleetError", code: "INVALID_INPUT", message: "Unexpected field" });
		const caught = async (f: () => unknown) => { try { await f(); } catch (e: any) { return { name: e.name, code: e.code, message: e.message }; } return undefined; };
		const fleet = new Fleet(store);
		expect(await caught(() => store.submit(role))).toEqual(expected);
		expect(await caught(() => fleet.submit(role, headroom(["win"], 2)))).toEqual(expected);
		expect(await caught(() => preflightPlacement(role, store.nodes(), [], { samples: new Map(), held: new Map(), now: Date.now() } as any, { workUnits: workUnitState(store) }))).toEqual(expected);
		// A role row written while on, started after the switch went off (R14 refuses the disable; raw drop here).
		enable(store);
		const queued = store.reserve(store.submit(reviewInput(store, "off-start") as any).id);
		expect(queued.attemptId).toBeDefined();
		dbOf(store).exec("DROP TABLE work_unit_switch");
		const ops = dbOf(store).query("SELECT count(*) n FROM operations WHERE task_id=?").get(queued.id);
		expect(await caught(() => fleet.start(queued.id))).toEqual(expected);
		expect(dbOf(store).query("SELECT count(*) n FROM operations WHERE task_id=?").get(queued.id)).toEqual(ops);
	});
	test("switch on: exact keys {role}, role ∈ review|report, prompt must name the report path; same at every site", async () => {
		const { store } = fresh();
		enable(store);
		const fleet = new Fleet(store);
		const opts = { workUnits: "on" as const };
		const sites = [
			(v: any) => validateTaskInput(v, opts),
			(v: any) => store.submit(v),
			(v: any) => fleet.submit(v, headroom(["win"], 2)),
			(v: any) => preflightPlacement(v, store.nodes(), [], { samples: new Map(), held: new Map(), now: Date.now() } as any, opts),
		];
		const bad: [any, string][] = [
			[{ ...input("b1", "review"), workUnit: { role: "verify" } }, "INVALID_INPUT"],
			[{ ...input("b2", "review"), workUnit: { role: "review", extra: 1 } }, "INVALID_INPUT"],
			[{ ...input("b3", "review"), workUnit: "review" }, "INVALID_INPUT"],
			[input("b4", "review", "no path here"), "ROLE_PROMPT_CONTRACT"],
			[{ ...input("b5", "review"), surprise: 1 }, "INVALID_INPUT"],
		];
		for (const [value, code] of bad)
			for (const site of sites) {
				let error: any;
				try { await site(value); } catch (e) { error = e; }
				expect([value.key, error instanceof FleetError, error?.code]).toEqual([value.key, true, code]);
			}
		expect(store.submit(input("good", "report") as any).input.workUnit).toEqual({ role: "report" });
	});
});

describe("review fx-2b12ff9e findings F1-F5", () => {
	test("F1: a review record binds repo, branch, reviewed head commit, subject task, evidence hash and verdict", () => {
		const db = dbOf(main.store);
		const [row] = rows(db, ids["ok-review"]!);
		const author = main.store.task(ids["ok-review"]!)!.input.workUnit as any;
		expect([row.kind, row.repo_id, row.head_commit, row.branch, row.subject_task_id, row.verdict, row.report_sha256]).toEqual([
			"report_collected", "fleet", base, BRANCH, author.subject.taskId, "clean", sha("VERDICT: CLEAN\n# Review\nfindings: none blocking\n"),
		]);
		// The subject is the author task whose Fleet workspace produced `base`.
		expect((main.store.task(author.subject.taskId)!.resultManifest as any).outputHead).toBe(base);
		const audit = JSON.parse((db.query("SELECT data FROM audit WHERE task_id=? AND kind='deliverable_recorded'").get(ids["ok-review"]!) as any).data);
		expect(audit).toMatchObject({ verdict: "clean", headCommit: base, branch: BRANCH, recordDigest: row.record_digest });
		const view = deliverableViews(main.store)!.get(ids["ok-review"]!)!;
		expect([view.verdict, view.headCommit, view.branch, view.repoId, view.verified]).toEqual(["clean", base, BRANCH, "fleet", false]);
		// NOT CLEAN is its own verdict; a report (not a review) has neither verdict nor subject.
		const { store } = fresh();
		enable(store);
		const notClean = build(store, { key: "nc", files: verdictReport("# found F1\n"), role: "review" });
		expect(rows(dbOf(store), notClean)[0].verdict).toBe("not_clean");
		const [plainReport] = rows(db, ids["ok-report"]!);
		expect([plainReport.verdict, plainReport.branch, plainReport.subject_task_id, plainReport.head_commit]).toEqual([null, null, null, base]);
		// CLEAN and NOT CLEAN are different records, never the same fact.
		expect(rows(dbOf(store), notClean)[0].record_digest).not.toBe(row.record_digest);
	});
	test("F1: a review of a commit no Fleet task made is refused (NON_FLEET_COMMIT, audited); a review needs its subject", () => {
		const { store } = fresh();
		enable(store);
		const db = dbOf(store);
		const author = authorFor(store);
		const noCommit = build(store, { key: "no-commit", files: [], role: null });
		const unsaved = build(store, { key: "unsaved", files: [], role: null, save: false });
		const roleSubject = build(store, { key: "role-subject", files: report("# r\n"), role: "report" });
		const count = () => (db.query("SELECT count(*) n FROM tasks").get() as any).n;
		const before = count();
		const cases: [any, string][] = [
			[{ ...input("foreign", "review", undefined, author), baseCommit: "f".repeat(40) }, "NON_FLEET_COMMIT"],
			[input("unknown-subject", "review", undefined, "0f8fad5b-d9cb-469f-a165-70867728950e"), "NON_FLEET_COMMIT"],
			[input("subject-no-commit", "review", undefined, noCommit), "NON_FLEET_COMMIT"],
			[input("subject-unsaved", "review", undefined, unsaved), "NON_FLEET_COMMIT"],
			[input("subject-role", "review", undefined, roleSubject), "NON_FLEET_COMMIT"],
			[{ ...input("other-repo", "review", undefined, author), repoId: "other" }, "NON_FLEET_COMMIT"],
			[{ ...input("no-subject", "review"), workUnit: { role: "review" } }, "INVALID_INPUT"],
			[{ ...input("bad-branch", "review"), workUnit: { role: "review", subject: { taskId: author, branch: "../main" } } }, "INVALID_INPUT"],
			[{ ...input("report-subject", "report"), workUnit: { role: "report", subject: { taskId: author, branch: BRANCH } } }, "INVALID_INPUT"],
			[input("no-verdict-line", "review", ROLE_PROMPT, author), "ROLE_PROMPT_CONTRACT"],
		];
		for (const [value, code] of cases) {
			let error: any;
			try { store.submit(value); } catch (e) { error = e; }
			expect([value.key, error?.code]).toEqual([value.key, code]);
		}
		expect(count()).toBe(before);
		const refused = db.query("SELECT data FROM audit WHERE kind='refused' AND json_extract(data,'$.code')='NON_FLEET_COMMIT'").all() as any[];
		expect(refused).toHaveLength(6);
		expect(JSON.parse(refused[0].data)).toMatchObject({ action: "submit", failureDiagnostic: { code: "fleet:non_fleet_commit" } });
		// The commit the author task made is accepted.
		expect(store.submit(reviewInput(store, "fleet-commit") as any).phase).toBe("queued");
	});
	test("F1: a review run in its author's session is never a review verdict; an unknown author session records nothing", () => {
		const { store, dir } = fresh();
		store.putNode({ ...nodeFor(dir), id: "mac" });
		enable(store);
		// Session ids are unique per node (SESSION_CONFLICT); the same id on another node is the same session id.
		authors.set(store, build(store, { key: "author-shared", files: [], role: null, author: true, session: "shared", nodeId: "win" }));
		const same = build(store, { key: "same-session", files: verdictReport("# self review\n"), role: "review", session: "shared", nodeId: "mac" });
		const [row] = rows(dbOf(store), same);
		expect([row.kind, row.reason, row.verdict, row.report_sha256, row.branch]).toEqual(["report_rejected", "reviewer_not_independent", null, null, BRANCH]);
		const other = build(store, { key: "other-session", files: verdictReport("# independent\n"), role: "review", nodeId: "mac" });
		expect([rows(dbOf(store), other)[0].kind, rows(dbOf(store), other)[0].verdict]).toEqual(["report_collected", "not_clean"]);
		// The author row without a session (raw SQL): unknown, so nothing is recorded, now or by path c.
		const unknown = buildSkippingRecord(store, { key: "unknown-author", files: verdictReport("# x\n"), role: "review", nodeId: "mac" });
		dbOf(store).query("UPDATE tasks SET data=json_remove(data,'$.sessionId') WHERE id=?").run(authors.get(store)!);
		expect(record(store, unknown)).toEqual({ outcome: "not_ready", reason: "subject_session_unknown" });
		expect(rows(dbOf(store), unknown)).toEqual([]);
	});
	test("F1: the node refuses before any effect unless refs/heads/<branch> is exactly the reviewed commit; Fleet.start sends the branch", async () => {
		const f = await repositoryFixture("wu-branch-");
		dirs.push(f.dir);
		await f.git("branch", BRANCH);
		await f.git("branch", "stale");
		await writeFile(join(f.repo, "tracked.txt"), "newer\n");
		await f.git("commit", "-a", "-m", "newer");
		const newer = await f.git("rev-parse", "HEAD");
		const node = { id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [] } } as any;
		const prep = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256hex("input"), repoId: "repo", baseCommit: f.baseCommit, reviewDirAbsent: true };
		expect(await nodeOperation(node, { action: "preflight", input: { ...prep, reviewBranch: BRANCH } })).toEqual({ preflight: "passed" });
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, baseCommit: newer, reviewBranch: "stale" } })).rejects.toThrow("node_refused:identity_mismatch");
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, reviewBranch: "missing" } })).rejects.toThrow("node_refused:identity_mismatch");
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, reviewBranch: "../x" } })).rejects.toThrow("node_refused:invalid_request");
		await expect(nodeOperation(node, { action: "preflight", input: { ...prep, reviewDirAbsent: undefined, reviewBranch: BRANCH } })).rejects.toThrow("node_refused:invalid_request");
		expect(() => statSync(f.workspaceRoot)).toThrow();
		const { store } = fresh();
		enable(store);
		const fleet = new Fleet(store, { localNodeId: "win" });
		const t = store.reserve(store.submit(reviewInput(store, "start-branch") as any).id);
		await fleet.start(t.id).catch(() => {});
		expect((store.getOperation(t.id, "prepare") as any)?.payload?.reviewBranch).toBe(BRANCH);
	});
	test("F2: a role input never carries an input package (all four validateTaskInput sites)", async () => {
		const { store } = fresh();
		enable(store);
		const fleet = new Fleet(store);
		const digest = "d".repeat(64);
		const bytes = Buffer.from("# planted\n");
		const inputPackage = { schemaVersion: 1, repoId: "fleet", baseCommit: base, digest, changes: [{ path: ROLE_REPORT_PATH, before: null, after: { sha256: sha(bytes), mode: 100644, bytes: bytes.length, contentBase64: bytes.toString("base64") } }], authorization: { digest, reference: "lead" } };
		const sites = [
			(v: any) => validateTaskInput(v, { workUnits: "on" }),
			(v: any) => store.submit(v),
			(v: any) => fleet.submit(v, headroom(["win"], 2)),
			(v: any) => preflightPlacement(v, store.nodes(), [], { samples: new Map(), held: new Map(), now: Date.now() } as any, { workUnits: "on" }),
		];
		for (const value of [{ ...reviewInput(store, "pkg-review"), inputPackage }, { ...input("pkg-report", "report"), inputPackage }])
			for (const site of sites) {
				let error: any;
				try { await site(value); } catch (e) { error = e; }
				expect([value.key, error?.code, String(error?.message).includes("input package")]).toEqual([value.key, "INVALID_INPUT", true]);
			}
		// The same package on role-less work is untouched.
		expect(() => validateTaskInput({ ...input("pkg-plain", null), inputPackage })).not.toThrow();
	});
	test("F3: a Step 1b classification mismatch is refused inside the transaction and audited", () => {
		const { store } = fresh();
		enable(store);
		const id = build(store, { key: "legacy", files: report("legacy review\n"), role: null });
		const op = { actor: "operator", reason: "legacy", reportPath: ROLE_REPORT_PATH, reportSha256: "0".repeat(64), role: "review" };
		expect(() => record(store, id, op)).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		expect(() => record(store, id, { ...op, reportPath: "docs/x.md" })).toThrow(expect.objectContaining({ code: "CLASSIFICATION_MISMATCH" }));
		const refused = dbOf(store).query("SELECT data FROM audit WHERE task_id=? AND kind='refused' ORDER BY sequence").all(id) as any[];
		expect(refused.map((r) => JSON.parse(r.data))).toEqual([
			expect.objectContaining({ action: "recordDeliverable", code: "CLASSIFICATION_MISMATCH", failureDiagnostic: expect.objectContaining({ code: "fleet:classification_mismatch" }) }),
			expect.objectContaining({ action: "recordDeliverable", code: "CLASSIFICATION_MISMATCH", failureDiagnostic: expect.objectContaining({ code: "fleet:classification_mismatch" }) }),
		]);
		expect(rows(dbOf(store), id)).toEqual([]);
	});
	test("F4: start of an ended role task returns it after the switch went off or inconsistent, as for role-less work", async () => {
		const { store } = fresh();
		enable(store);
		const fleet = new Fleet(store);
		const role = build(store, { key: "ended-role", files: verdictReport("# done\n"), role: "review" });
		const plain = build(store, { key: "ended-plain", files: [], role: null });
		expect(disableWorkUnits(store, { actor: "operator", reason: "off" })).toEqual({ changed: true, state: "off" });
		for (const id of [role, plain]) expect((await fleet.start(id)).phase).toBe("completed_unverified");
		enable(store);
		dbOf(store).exec("DELETE FROM work_unit_switch");
		expect(workUnitState(store)).toBe("inconsistent");
		expect((await fleet.start(role)).phase).toBe("completed_unverified");
		// A role task that has not ended is still validated against the switch (refused while inconsistent).
		dbOf(store).exec("INSERT INTO work_unit_switch VALUES (1,'2026-11-13T00:00:00Z','operator','repair')");
		const queued = store.reserve(store.submit(reviewInput(store, "not-ended") as any).id);
		dbOf(store).exec("DELETE FROM work_unit_switch");
		await expect(fleet.start(queued.id)).rejects.toThrow(expect.objectContaining({ code: "WORK_UNIT_SWITCH_INCONSISTENT" }));
	});
	test("F5: `result ID` of a collected role task never waits for the write lock; a missing record is still written", async () => {
		const { store, path } = fresh();
		enable(store);
		const fleet = new Fleet(store);
		const id = build(store, { key: "collected", files: verdictReport("# r\n"), role: "review" });
		expect(rows(dbOf(store), id)).toHaveLength(1);
		const missing = buildSkippingRecord(store, { key: "missing", files: verdictReport("# m\n"), role: "review" });
		const audits = () => (dbOf(store).query("SELECT count(*) n FROM audit").get() as any).n;
		const n = audits();
		const lock = new Database(path);
		try {
			lock.exec("BEGIN IMMEDIATE");
			const started = performance.now();
			expect((await fleet.result(id)).status).toBe("not_run");
			expect(performance.now() - started).toBeLessThan(2000);
		} finally {
			if (lock.inTransaction) lock.exec("ROLLBACK");
			lock.close();
		}
		expect(audits()).toBe(n);
		await fleet.result(missing);
		expect(rows(dbOf(store), missing)).toHaveLength(1);
	}, 30_000);
});

describe("review fx-5f110277 findings F1-F5", () => {
	/** git in a prepared workspace (the agent's view), hooks off. */
	const wsGit = (path: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "core.hooksPath=" + join(path, "..", "no-hooks"), "-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "-C", path, ...args]);
		if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
		return r.stdout.toString().trimEnd();
	};
	test("F1: moving HEAD to an existing commit (descendant or ancestor) carries no creation proof; a commit made in the workspace does", async () => {
		const f = await repositoryFixture("wu-f1-");
		dirs.push(f.dir);
		const older = f.baseCommit;
		await writeFile(join(f.repo, "tracked.txt"), "mid\n");
		await f.git("commit", "-a", "-m", "human mid");
		const mid = await f.git("rev-parse", "HEAD");
		await writeFile(join(f.repo, "tracked.txt"), "newer human\n");
		await f.git("commit", "-a", "-m", "human newer");
		const newer = await f.git("rev-parse", "HEAD");
		let n = 0;
		const workspace = () => prepareWorkspace({ taskId: `t${++n}`, attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: mid, workspaceRoot: f.workspaceRoot });
		// Descendant: the agent checks out a newer human commit; no commit is made.
		const descendant = await workspace();
		wsGit(descendant.path, "checkout", "--detach", newer);
		const d = await collectResult(descendant, []);
		expect([d.outputHead, await outputHeadCreated(descendant, d.outputHead)]).toEqual([newer, false]);
		// Ancestor: the agent resets to an older human commit.
		const ancestor = await workspace();
		wsGit(ancestor.path, "reset", "--hard", older);
		const a = await collectResult(ancestor, []);
		expect([a.outputHead, await outputHeadCreated(ancestor, a.outputHead)]).toEqual([older, false]);
		// No move at all.
		const still = await workspace();
		expect(await outputHeadCreated(still, (await collectResult(still, [])).outputHead)).toBe(false);
		// A commit the agent made in the workspace is proven; once a branch reaches it, a later collection is not.
		const made = await workspace();
		await writeFile(join(made.path, "tracked.txt"), "agent work\n");
		wsGit(made.path, "commit", "-a", "-m", "agent");
		const m = await collectResult(made, []);
		expect(await outputHeadCreated(made, m.outputHead)).toBe(true);
		expect(() => validateResult(made, m)).not.toThrow();
		await f.git("branch", "fleet/agent", m.outputHead);
		expect(await outputHeadCreated(made, m.outputHead)).toBe(false);
		// Store: a subject manifest without the proof (older manifests included) is NON_FLEET_COMMIT; with it, queued.
		const { store } = fresh();
		enable(store);
		const unproven = build(store, { key: "moved-head", files: [], role: null, author: true, unproven: true });
		let error: any;
		try { store.submit(input("review-moved", "review", undefined, unproven) as any); } catch (e) { error = e; }
		expect([error?.code, String(error?.message).includes("created in its workspace")]).toEqual(["NON_FLEET_COMMIT", true]);
		expect(store.submit(reviewInput(store, "review-proven") as any).phase).toBe("queued");
	}, 60_000);
	test("F1: verifying an author result after a branch was made to its commit is not ARTIFACT_CHANGED", async () => {
		const repo = await repositoryFixture("wu-f1v-");
		dirs.push(repo.dir);
		const db = join(repo.dir, "fleet.sqlite");
		const store = new FleetStore(db);
		stores.push(store);
		// The proof is asked only while the switch is on (review fx-8fae504e F4).
		enable(store);
		const state = join(repo.dir, "coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } } as any);
		const fleet = new Fleet(store, { localNodeId: "local" });
		const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "author-verify", caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled author", required: {} } as any).id);
		const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { injected: "not provider settlement proof" } };
		store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
		const path = (task.workspace as any).path;
		await writeFile(join(path, "tracked.txt"), "agent work\n");
		wsGit(path, "commit", "-a", "-m", "agent");
		const collected = await fleet.result(task.id);
		expect(proofs(store, task.id)).toEqual([collected.outputHead]);
		// The operator makes the branch a review needs; the collected bytes are unchanged.
		await repo.git("branch", BRANCH, collected.outputHead);
		const verified = await fleet.result(task.id, [process.execPath, "--eval", "console.log('ok')"]);
		expect(verified.status).toBe("verified");
		expect<unknown>(store.task(task.id)!.resultManifest).toEqual(collected);
	}, 60_000);
	test("F2: only an exact or decided verdict line is a verdict; undecided, prefixed, glued or later-line verdicts are verdict_missing", () => {
		const m = (text: string) => ({ patch: "", files: [fileEntry({ path: ROLE_REPORT_PATH, text })] } as any);
		const verdict = (text: string) => {
			const fact = classifyReport(m(text), "review") as any;
			return fact.kind === "report_collected" ? fact.verdict : fact.reason;
		};
		const cases: [string, string][] = [
			["VERDICT: CLEAN", "clean"],
			["VERDICT: CLEAN\n# body", "clean"],
			["VERDICT: CLEAN\r\n# body", "clean"],
			["VERDICT: NOT CLEAN\r\n", "not_clean"],
			["VERDICT: NOT CLEAN  two P1 findings below\n", "not_clean"],
			["VERDICT: CLEAN\tall tests pass\n", "clean"],
			// F2 reproductions: undecided first lines.
			["VERDICT: CLEAN / NOT CLEAN\n", "verdict_missing"],
			["VERDICT: CLEAN? I could not run the tests\n", "verdict_missing"],
			["VERDICT: CLEAN-ish, two P1 findings below\n", "verdict_missing"],
			["VERDICT: NOT CLEAN or CLEAN\n", "verdict_missing"],
			["VERDICT: CLEAN \n", "clean"],
			// M2: no boundary after the token.
			["VERDICT: CLEANER\n", "verdict_missing"],
			// M1: not anchored at the start of the line.
			["Summary VERDICT: CLEAN\n", "verdict_missing"],
			[" VERDICT: CLEAN\n", "verdict_missing"],
			// M3: the verdict must be the first line, not anywhere in the text.
			["# Review\nVERDICT: CLEAN\n", "verdict_missing"],
			["\nVERDICT: NOT CLEAN\n", "verdict_missing"],
		];
		expect(cases.map(([text]) => [text, verdict(text)])).toEqual(cases);
		// End to end through saveResult: an undecided line is recorded as a rejection, never verdict=clean.
		const { store } = fresh();
		enable(store);
		const id = build(store, { key: "undecided", files: report("VERDICT: CLEAN / NOT CLEAN\n# body\n"), role: "review" });
		expect([rows(dbOf(store), id)[0].kind, rows(dbOf(store), id)[0].reason, rows(dbOf(store), id)[0].verdict]).toEqual(["report_rejected", "verdict_missing", null]);
	});
	test("F3: with the switch inconsistent a queued role task stays queued and is reported; a role-less task behind it is considered", async () => {
		const { store } = fresh();
		enable(store);
		const role = store.submit(reviewInput(store, "queued-role") as any);
		const plain = store.submit(input("queued-plain", null) as any);
		dbOf(store).exec("DELETE FROM work_unit_switch");
		expect(workUnitState(store)).toBe("inconsistent");
		const considered: number[] = [];
		const out = await reconsiderQueue(new Fleet(store), async () => (considered.push(1), new Map()));
		// Only the role-less task was sampled (preflighted); the role task is reported, unchanged and queued.
		expect(considered).toHaveLength(1);
		expect(out.map((t) => [t.id, t.phase])).toEqual([[role.id, "queued"], [plain.id, "queued"]]);
		for (const id of [role.id, plain.id]) expect([store.task(id)!.phase, store.task(id)!.attemptId]).toEqual(["queued", undefined]);
	});
	test("merge review 033ebb50 F1: with node-health gating ON a role task goes through the same work-unit rules (no INVALID_INPUT; not-on switch keeps it queued, unsampled)", async () => {
		const { store } = fresh();
		enable(store);
		dbOf(store).exec("CREATE TABLE IF NOT EXISTS node_health_gating (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), operator TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)");
		dbOf(store).exec("INSERT INTO node_health_gating(enabled, operator, reason, at) VALUES (1, 'operator', 'both switches on', 1)");
		expect(store.nodeHealthGating().enabled).toBe(true);
		const role = store.submit(reviewInput(store, "gated-role") as any);
		// Both switches on: the gated pass validates the role input with the switch state instead of throwing 'Unexpected field'.
		await reconsiderQueue(new Fleet(store), async () => new Map());
		expect([store.task(role.id)!.phase, store.task(role.id)!.attemptId]).toEqual(["queued", undefined]);
		// Work-unit switch no longer on: the role task is reported and stays queued without being sampled or preflighted.
		dbOf(store).exec("DELETE FROM work_unit_switch");
		const considered: number[] = [];
		const out = await reconsiderQueue(new Fleet(store), async () => (considered.push(1), new Map()));
		expect(considered).toHaveLength(0);
		expect(out.map((t) => [t.id, t.phase])).toEqual([[role.id, "queued"]]);
	});
	test("F4: the branch check is an exact, case-sensitive refname match, loose and packed alike", async () => {
		const f = await repositoryFixture("wu-f4-");
		dirs.push(f.dir);
		await f.git("branch", BRANCH);
		const req = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot, reviewDirAbsent: true as const };
		const outcome = (branch: string) => checkPreparation({ ...req, reviewBranch: branch }).then(() => "passed", (e: Error) => e.message);
		const variants = [BRANCH, BRANCH.toUpperCase(), "Fleet/author-work", "fleet/Author-Work", "fleet", "fleet/author"];
		const expected = ["passed", "review_branch_mismatch", "review_branch_mismatch", "review_branch_mismatch", "review_branch_mismatch", "review_branch_mismatch"];
		const loose = [];
		for (const v of variants) loose.push(await outcome(v));
		expect(loose).toEqual(expected);
		await f.git("pack-refs", "--all");
		const packed = [];
		for (const v of variants) packed.push(await outcome(v));
		expect(packed).toEqual(expected);
		expect(() => statSync(f.workspaceRoot)).toThrow();
	});
	test("F5: a review submit reads only the subject row: a damaged externalised subject blob is not RESULT_INTEGRITY", () => {
		const { store, path } = fresh();
		enable(store);
		store.enableResultStore({ actor: "operator", reason: "coexistence" });
		const big = "diff --git a/src/a.ts b/src/a.ts\n" + "+x\n".repeat(1024);
		const author = build(store, { key: "external-author", files: [{ path: "src/a.ts", text: "x".repeat(2048) }], patch: big, role: null, author: true });
		authors.set(store, author);
		const unproven = build(store, { key: "external-unproven", files: [{ path: "src/a.ts", text: "y".repeat(2048) }], patch: big + "+y\n", role: null, author: true, unproven: true });
		const db = dbOf(store);
		for (const id of [author, unproven]) expect(JSON.parse(rowData(db, id))).toHaveProperty("resultExternal");
		for (const name of readdirSync(`${path}.results`, { recursive: true }) as string[]) {
			const file = join(`${path}.results`, name);
			if (statSync(file).isFile()) rmSync(file);
		}
		expect(() => store.task(author)).toThrow(expect.objectContaining({ code: "RESULT_INTEGRITY" }));
		expect(store.submit(reviewInput(store, "review-external") as any).phase).toBe("queued");
		let error: any;
		try { store.submit(input("review-external-unproven", "review", undefined, unproven) as any); } catch (e) { error = e; }
		expect(error?.code).toBe("NON_FLEET_COMMIT");
		const integrity = db.query("SELECT count(*) n FROM audit WHERE kind='refused' AND json_extract(data,'$.code')='RESULT_INTEGRITY'").get() as any;
		expect(integrity.n).toBe(0);
	});
});

describe("review fx-ed3a26ef findings F1-F4", () => {
	const PRISTINE = process.env.FLEET_PRISTINE;
	/** git in a prepared workspace (the agent's view), hooks off. */
	const wsGit = (path: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "core.hooksPath=" + join(path, "..", "no-hooks"), "-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "-C", path, ...args]);
		if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
		return r.stdout.toString().trimEnd();
	};
	const repoNode = (f: { repo: string; workspaceRoot: string }) => ({ id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [] } }) as any;
	/** The node's separate, read-only provenance query (never part of a result manifest). */
	const created = async (node: any, identity: any, head: string) => ((await nodeOperation(node, { action: "provenance", identity, head })) as any).created;
	async function fixture(prefix: string) {
		const f = await repositoryFixture(prefix);
		dirs.push(f.dir);
		let n = 0;
		const workspace = () => prepareWorkspace({ taskId: `t${++n}`, attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		/** A fresh workspace whose agent commits once on top of `onto` (default: its baseCommit). */
		const agentCommit = async (onto?: string) => {
			const ws = await workspace();
			if (onto) wsGit(ws.path, "checkout", "-q", "--detach", onto);
			await writeFile(join(ws.path, "tracked.txt"), `agent work ${n}\n`);
			wsGit(ws.path, "commit", "-q", "-a", "-m", "agent");
			return { ws, head: wsGit(ws.path, "rev-parse", "HEAD") };
		};
		return { f, node: repoNode(f), workspace, agentCommit };
	}
	test.skipIf(!PRISTINE)("F1: results the real node collected on this tree, unverified and verified, still verify on 6b95dde after rollback", async () => {
		const P = { ...(await import(join(PRISTINE!, "src/store.ts"))), ...(await import(join(PRISTINE!, "src/fleet.ts"))) };
		const argv = [process.execPath, "--eval", "console.log('ok')"];
		const outcome = (p: Promise<any>) => p.then((m) => m.status, (e) => e.code ?? e.message);
		/** One controlled author task in its own store: the agent commits, then this tree collects (and verifies). */
		const authored = async (key: string, verify: boolean) => {
			const repo = await repositoryFixture("wu-r4f1-");
			dirs.push(repo.dir);
			const db = join(repo.dir, "fleet.sqlite");
			const store = new FleetStore(db);
			// The proof is asked only while the switch is on (review fx-8fae504e F4).
			enable(store);
			const state = join(repo.dir, "coordinator.json");
			await writeFile(state, JSON.stringify({ calls: [] }));
			store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } } as any);
			const fleet = new Fleet(store, { localNodeId: "local" });
			try {
				const task = await fleet.start(fleet.submit({ schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled author", required: {} } as any).id);
				const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { injected: "not provider settlement proof" } };
				store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
				const path = (task.workspace as any).path;
				await writeFile(join(path, "tracked.txt"), "agent work\n");
				wsGit(path, "commit", "-q", "-a", "-m", "agent");
				const collected = await fleet.result(task.id);
				const status = verify ? (await fleet.result(task.id, argv)).status : collected.status;
				// The creation proof is recorded, outside the manifest.
				return { db, id: task.id, status, proofs: proofs(store, task.id), head: collected.outputHead };
			} finally {
				store.close();
			}
		};
		const onOld = async (db: string, run: (fleet: any) => Promise<string[]>) => {
			const old = new P.FleetStore(db);
			try {
				return await run(new P.Fleet(old, { localNodeId: "local" }));
			} finally {
				old.close();
			}
		};
		const unverified = await authored("rollback-unverified", false);
		const verified = await authored("rollback-verified", true);
		expect([unverified.status, unverified.proofs, verified.status, verified.proofs]).toEqual(["not_run", [unverified.head], "verified", [verified.head]]);
		const afterRollback = [
			...(await onOld(unverified.db, async (fleet) => [await outcome(fleet.result(unverified.id, argv))])),
			...(await onOld(verified.db, async (fleet) => [await outcome(fleet.result(verified.id)), await outcome(fleet.result(verified.id, argv))])),
		];
		expect(afterRollback).toEqual(["verified", "verified", "verified"]);
	}, 60_000);
	test("F2: (a) refs/pull, (b) stash, (c) deleted-branch, (d) another Fleet worktree's HEAD and (e) a human commit inside base..head are never created here", async () => {
		const { f, node, workspace, agentCommit } = await fixture("wu-r4f2-");
		const main = await f.git("symbolic-ref", "--short", "HEAD");
		// (a) a contributor PR head, written by update-ref only (refs/pull/* has no reflog).
		const pr = await f.git("commit-tree", await f.git("rev-parse", "HEAD^{tree}"), "-p", f.baseCommit, "-m", "contributor PR");
		await f.git("update-ref", "refs/pull/7/head", pr);
		// (b) a human's stash.
		await writeFile(join(f.repo, "tracked.txt"), "stashed human work\n");
		await f.git("stash");
		const stash = await f.git("rev-parse", "refs/stash");
		// (c) a human commit whose branch was deleted.
		await f.git("checkout", "-q", "-b", "tmp");
		await writeFile(join(f.repo, "tracked.txt"), "deleted branch work\n");
		await f.git("commit", "-q", "-a", "-m", "human tmp");
		const deleted = await f.git("rev-parse", "HEAD");
		await f.git("checkout", "-q", main);
		await f.git("branch", "-q", "-D", "tmp");
		// (d) another Fleet task's commit, still that workspace's detached HEAD: created there, not here.
		const other = await agentCommit();
		expect(await created(node, other.ws, other.head)).toBe(true);
		const moved: Record<string, boolean> = {};
		for (const [name, commit] of [["a", pr], ["b", stash], ["c", deleted], ["d", other.head]] as const) {
			const ws = await workspace();
			wsGit(ws.path, "checkout", "-q", "--detach", commit);
			moved[name] = await created(node, ws, commit);
		}
		// (e) the agent commits on top of a newer human commit of the main branch: the range holds a human commit.
		await writeFile(join(f.repo, "tracked.txt"), "newer human\n");
		await f.git("commit", "-q", "-a", "-m", "human newer");
		const onTop = await agentCommit(await f.git("rev-parse", "HEAD"));
		moved.e = await created(node, onTop.ws, onTop.head);
		expect(moved).toEqual({ a: false, b: false, c: false, d: false, e: false });
	}, 60_000);
	test("F3: the review-branch check lists only the named ref: a refs/heads/ listing over the 4 MiB output cap still passes", async () => {
		const f = await repositoryFixture("wu-r4f3-");
		dirs.push(f.dir);
		await f.git("branch", BRANCH);
		// 70,000 packed branches; each listing line is 85 bytes, about 5.9 MB in all.
		const lines: string[] = [];
		for (let i = 0; i < 70_000; i++) lines.push(`${f.baseCommit} refs/heads/bulk/${String(i).padStart(8, "0")}-${"x".repeat(18)}`);
		writeFileSync(join(f.repo, ".git", "packed-refs"), "# pack-refs with: peeled fully-peeled sorted \n" + lines.join("\n") + "\n");
		const all = await f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/").catch((e: Error) => e.message);
		expect(all).toContain("command_output_limit");
		const req = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot, reviewDirAbsent: true as const };
		const outcome = (branch: string) => checkPreparation({ ...req, reviewBranch: branch }).then(() => "passed", (e: Error) => e.message);
		expect([await outcome(BRANCH), await outcome("bulk/00000001-" + "x".repeat(18)), await outcome("fleet/other")]).toEqual(["passed", "passed", "review_branch_mismatch"]);
	}, 60_000);
	test("F4: a tag- or remote-reached head and an orphan agent commit are not created; a role task is never a review subject", async () => {
		const { f, node, workspace, agentCommit } = await fixture("wu-r4f4-");
		const tagged = await agentCommit();
		const beforeTag = await created(node, tagged.ws, tagged.head);
		await f.git("tag", "human-tag", tagged.head);
		const remote = await agentCommit();
		const beforeRemote = await created(node, remote.ws, remote.head);
		await f.git("update-ref", "refs/remotes/origin/work", remote.head);
		// An orphan commit the agent made (no parent, so not a descendant of baseCommit), reached by no ref.
		const ws = await workspace();
		const orphan = wsGit(ws.path, "commit-tree", wsGit(ws.path, "rev-parse", "HEAD^{tree}"), "-m", "orphan agent commit");
		wsGit(ws.path, "checkout", "-q", "--detach", orphan);
		expect([beforeTag, await created(node, tagged.ws, tagged.head), beforeRemote, await created(node, remote.ws, remote.head), await created(node, ws, orphan)]).toEqual([true, false, true, false, false]);
		// A role task with a different head and the proof row is still refused as a subject.
		const { store } = fresh();
		enable(store);
		const role = build(store, { key: "role-subject", files: report("# r\n"), role: "report", save: false });
		const head = "c".repeat(40);
		store.saveResult(role, { ...manifestFor(store, role, { files: report("# r\n") }), outputHead: head }, { created: true });
		expect(proofs(store, role)).toEqual([head]);
		let error: any;
		try { store.submit({ ...input("review-of-role", "review", undefined, role), baseCommit: head } as any); } catch (e) { error = e; }
		expect([error?.code, String(error?.message).includes("itself a role task")]).toEqual(["NON_FLEET_COMMIT", true]);
	}, 60_000);
});

describe("review fx-8fae504e findings F1-F5", () => {
	const relay = join(import.meta.dir, "fixtures/provenance-transport.ts");
	const helper = join(import.meta.dir, "../src/node.ts");
	const wsGit = (path: string, ...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "core.hooksPath=" + join(path, "..", "no-hooks"), "-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "-C", path, ...args]);
		if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`);
		return r.stdout.toString().trimEnd();
	};
	const headRows = (store: FleetStore, id: string) =>
		(dbOf(store).query("SELECT kind, data FROM audit WHERE task_id=? AND kind LIKE 'output_head_%' ORDER BY sequence").all(id) as any[]).map((r) => {
			const { observability, ...data } = JSON.parse(r.data);
			return { kind: r.kind, ...data };
		});
	/**
	 * One author task through the real Fleet.start / Fleet.result path: controlled coordinator, the real node helper
	 * behind a relay that logs every node action and controls only `provenance`. The agent commits once (on a branch
	 * it creates when `branch`), then `result` runs twice (the second is the cached branch).
	 */
	async function authored(key: string, mode: string, options: { enable?: boolean; branch?: boolean } = {}) {
		const repo = await repositoryFixture("wu-r5-");
		dirs.push(repo.dir);
		const store = open(join(repo.dir, "fleet.sqlite"));
		const state = join(repo.dir, "coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const node = { id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
		const config = join(repo.dir, "node.json");
		await writeFile(config, JSON.stringify(node));
		const control = join(repo.dir, "relay.json");
		await writeFile(control, JSON.stringify({ mode, actions: [] }));
		store.putNode({ ...node, workspaceTransport: { command: process.execPath, args: [relay, helper, config, control] } } as any);
		if (options.enable !== false) enable(store);
		const fleet = new Fleet(store, { localNodeId: "local" });
		const task = await fleet.start(fleet.submit({ schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled author", required: {} } as any).id);
		const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { injected: "not provider settlement proof" } };
		store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
		const path = (task.workspace as any).path;
		if (options.branch) wsGit(path, "switch", "-q", "-c", "agent-branch");
		await writeFile(join(path, "tracked.txt"), "agent work\n");
		wsGit(path, "commit", "-q", "-a", "-m", "agent");
		const head = wsGit(path, "rev-parse", "HEAD");
		const collected = await fleet.result(task.id);
		await fleet.result(task.id);
		const actions: string[] = JSON.parse(await Bun.file(control).text()).actions;
		const review = { schemaVersion: 1, key: "review-" + key, caller: "lead", repoId: "repo", baseCommit: collected.outputHead, prompt: REVIEW_PROMPT, required: {}, workUnit: { role: "review", subject: { taskId: task.id, branch: BRANCH } } };
		const submit = () => {
			try {
				return store.submit(review as any).phase as string;
			} catch (e: any) {
				return `${e.code}: ${e.message}`;
			}
		};
		return { store, id: task.id, head, outputHead: collected.outputHead, actions, rows: headRows(store, task.id), submit };
	}
	const unproven = (reason: string) => `NON_FLEET_COMMIT: Review refused: the subject's node did not prove the commit was created in its workspace (proof outcome at its first collection: ${reason}; never asked again); only a commit made by a Fleet task is reviewed`;

	test("F1/F5: {created:false}, any other reply, an older node's refusal and a transport failure are saved as the reason; asked once; the review names it", async () => {
		const out: Record<string, unknown> = {};
		for (const mode of ["real", "false", "invalid", "old", "transport"]) {
			const a = await authored("author-" + mode, mode);
			expect([mode, a.outputHead]).toEqual([mode, a.head]);
			const rows = a.rows.map(({ failureDiagnostic, ...row }) => ({ ...row, ...(failureDiagnostic ? { diagnostic: `${failureDiagnostic.source}/${failureDiagnostic.phase}` } : {}) }));
			out[mode] = { provenance: a.actions.filter((x) => x === "provenance").length, last: a.actions.at(-1), rows, review: a.submit() };
		}
		const head = (mode: string) => (out[mode] as any).rows[0]?.outputHead;
		expect(out).toEqual({
			real: { provenance: 1, last: "provenance", rows: [{ kind: "output_head_created", outputHead: head("real") }], review: "queued" },
			false: { provenance: 1, last: "provenance", rows: [{ kind: "output_head_unproven", outputHead: head("false"), reason: "not_created" }], review: unproven("not_created") },
			invalid: { provenance: 1, last: "provenance", rows: [{ kind: "output_head_unproven", outputHead: head("invalid"), reason: "reply_invalid" }], review: unproven("reply_invalid") },
			old: { provenance: 1, last: "provenance", rows: [{ kind: "output_head_unproven", outputHead: head("old"), reason: "node_refused", diagnostic: "Fleet.result/call" }], review: unproven("node_refused") },
			transport: { provenance: 1, last: "provenance", rows: [{ kind: "output_head_unproven", outputHead: head("transport"), reason: "node_failed", diagnostic: "Fleet.result/call" }], review: unproven("node_failed") },
		});
	}, 180_000);
	test("F5: HEAD moved between collect and provenance is not_created and the review is refused", async () => {
		const a = await authored("author-move", "move");
		expect([a.rows, a.submit()]).toEqual([[{ kind: "output_head_unproven", outputHead: a.head, reason: "not_created" }], unproven("not_created")]);
	}, 60_000);
	test("F2: an agent commit on a branch the agent created is recorded not_created; `workunits status` states the ordering", async () => {
		const a = await authored("author-branch", "real", { branch: true });
		expect([a.rows, a.submit()]).toEqual([[{ kind: "output_head_unproven", outputHead: a.head, reason: "not_created" }], unproven("not_created")]);
		expect(workUnitStatus(a.store).reviewOrdering).toBe(REVIEW_ORDERING);
		expect(REVIEW_ORDERING).toContain("before that `fleet result`");
	}, 60_000);
	test("F4: switch off: a collection sends only prepare and collect and writes no output_head row; switch on: the dashboard labels both kinds", async () => {
		const off = await authored("author-off", "real", { enable: false });
		expect([off.actions, off.rows]).toEqual([["prepare", "collect"], []]);
		expect(off.submit()).toBe("INVALID_INPUT: Unexpected field");
		const on = await authored("author-on", "false");
		const created = await authored("author-on-real", "real");
		const onState = getDashboardState(on.store);
		const createdState = getDashboardState(created.store);
		const page = (await renderPage(onState)) + (await renderPage(createdState));
		// Live cards keep output_head attention labels before expand; raw kind ids stay out of HTML.
		expect([page.includes("Commit creation unproven"), page.includes("Commit creation proven ("), page.includes("output_head_")]).toEqual([true, true, false]);
		expect(getDashboardTask(on.store, onState.tasks[0]!.id)!.timeline.some((e) => e.kind === "output_head_unproven")).toBe(true);
		expect(getDashboardTask(created.store, createdState.tasks[0]!.id)!.timeline.some((e) => e.kind === "output_head_created")).toBe(true);
	}, 120_000);
	test("F3: other worktrees beyond the 32,767-character command line and the 4 MiB listing cap still prove a new commit", async () => {
		const f = await repositoryFixture("wu-r5f3-");
		// Removed here (16,000 entries), not by afterAll and its 5 s hook timeout.
		try {
			const ws = await prepareWorkspace({ taskId: "t", attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
			await writeFile(join(ws.path, "tracked.txt"), "agent work\n");
			wsGit(ws.path, "commit", "-q", "-a", "-m", "agent");
			const head = wsGit(ws.path, "rev-parse", "HEAD");
			// 4,000 older Fleet worktrees (admin entries detached at baseCommit, as an older task leaves them).
			const admin = join(f.repo, ".git", "worktrees");
			const far = join(f.dir, "gone", "x".repeat(1100));
			for (let i = 0; i < 4000; i++) {
				const entry = join(admin, `bulk${i}`);
				mkdirSync(entry);
				writeFileSync(join(entry, "HEAD"), f.baseCommit + "\n");
				writeFileSync(join(entry, "commondir"), "../..\n");
				writeFileSync(join(entry, "gitdir"), `${far}${i}/.git\n`.replaceAll("\\", "/"));
			}
			const listing = await f.git("worktree", "list", "--porcelain").catch((e: Error) => e.message);
			expect(listing).toContain("command_output_limit");
			expect(await outputHeadCreated(ws, head)).toBe(true);
			// Still exact: one of them at the agent's commit makes it not created.
			writeFileSync(join(admin, "bulk3999", "HEAD"), head + "\n");
			expect(await outputHeadCreated(ws, head)).toBe(false);
		} finally {
			rmSync(f.dir, { recursive: true, force: true });
		}
	}, 120_000);
	for (const ref of ["refs/worktree/keep", "refs/bisect/bad"]) test(`review fx-72bd9133 F2: an existing commit named only by another linked worktree's ${ref} is not proven created`, async () => {
		const f = await repositoryFixture("wu-r6f2-");
		dirs.push(f.dir);
		// Another linked worktree: a commit X made there, kept only by its per-worktree ref, its HEAD moved back.
		const other = join(f.dir, "other");
		await f.git("worktree", "add", "--detach", other, f.baseCommit);
		await writeFile(join(other, "tracked.txt"), "human work\n");
		wsGit(other, "commit", "-q", "-a", "-m", "human");
		const x = wsGit(other, "rev-parse", "HEAD");
		wsGit(other, "update-ref", ref, x);
		wsGit(other, "checkout", "-q", "--detach", f.baseCommit);
		// The agent only moves its Fleet workspace's HEAD to X.
		const ws = await prepareWorkspace({ taskId: "t", attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		wsGit(ws.path, "checkout", "-q", "--detach", x);
		expect(await outputHeadCreated(ws, x)).toBe(false);
		// Exactly that ref: once it is deleted, X is named only by the other worktree's HEAD reflog (a documented limit).
		wsGit(other, "update-ref", "-d", ref);
		expect(await outputHeadCreated(ws, x)).toBe(true);
	}, 60_000);
	test("review fx-9292b210 F2: with a linked worktree as the node repository root, a human commit on the main worktree's detached HEAD is not proven created", async () => {
		const f = await repositoryFixture("wu-r7f2-");
		dirs.push(f.dir);
		// The node repository root is a linked worktree of f.repo; f.repo stays the main worktree.
		const root = join(f.dir, "linked-root");
		await f.git("worktree", "add", "--detach", root, f.baseCommit);
		// A human commit X on the main worktree's detached HEAD; no ref names it.
		wsGit(f.repo, "checkout", "-q", "--detach", f.baseCommit);
		await writeFile(join(f.repo, "tracked.txt"), "human work\n");
		wsGit(f.repo, "commit", "-q", "-a", "-m", "human");
		const x = wsGit(f.repo, "rev-parse", "HEAD");
		// The agent only moves its Fleet workspace (worktree-added from the linked root) to X.
		const ws = await prepareWorkspace({ taskId: "t", attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: root, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		wsGit(ws.path, "checkout", "-q", "--detach", x);
		expect(await outputHeadCreated(ws, x)).toBe(false);
		// Even a commit the agent really made there is not proven: the root must be the main worktree.
		await writeFile(join(ws.path, "tracked.txt"), "agent work\n");
		wsGit(ws.path, "commit", "-q", "-a", "-m", "agent");
		expect(await outputHeadCreated(ws, wsGit(ws.path, "rev-parse", "HEAD"))).toBe(false);
	}, 60_000);
	test("review fx-72bd9133 F3: a human commit fetched by URL into FETCH_HEAD is proven created, and `workunits status` says so", async () => {
		const f = await repositoryFixture("wu-r6f3-");
		dirs.push(f.dir);
		// A human commit on baseCommit in another repository, never referenced in this one.
		const elsewhere = join(f.dir, "elsewhere");
		await f.git("clone", "-q", "--no-local", f.repo, elsewhere);
		await writeFile(join(elsewhere, "tracked.txt"), "human work\n");
		wsGit(elsewhere, "commit", "-q", "-a", "-m", "human");
		const x = wsGit(elsewhere, "rev-parse", "HEAD");
		const ws = await prepareWorkspace({ taskId: "t", attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		wsGit(ws.path, "fetch", "-q", elsewhere, "HEAD");
		wsGit(ws.path, "checkout", "-q", "--detach", "FETCH_HEAD");
		expect(await outputHeadCreated(ws, x)).toBe(true);
		const { store } = fresh();
		enable(store);
		const ordering = workUnitStatus(store).reviewOrdering;
		expect([ordering.includes("not authored by Fleet"), ordering.includes("another linked worktree's HEAD reflog"), ordering.includes("FETCH_HEAD")]).toEqual([true, true, true]);
	}, 60_000);
	test("review fx-72bd9133 F4: through the real collect a report of 4 MiB − 1 and of exactly 4 MiB is report_collected; 1 byte more is refused by collect", async () => {
		const f = await repositoryFixture("wu-r6f4-");
		dirs.push(f.dir);
		const ws = await prepareWorkspace({ taskId: "t", attemptId: "a", nodeId: "node", inputDigest: sha256hex("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		mkdirSync(join(ws.path, "fleet-review"));
		const out: Record<string, unknown> = {};
		for (const delta of [-1, 0, 1]) {
			await writeFile(join(ws.path, ROLE_REPORT_PATH), Buffer.alloc(4 * 1024 * 1024 + delta, 0x61));
			out[delta] = await collectResult(ws, []).then((m) => classifyReport(m as any, "report").kind, (e: Error) => `collect threw ${e.message}`);
		}
		// The platform's reader refuses it (both messages are the node's unsafe_path category).
		const refused = process.platform === "win32" ? "unsafe_windows_artifact" : "unsafe_artifact";
		expect(out).toEqual({ "-1": "report_collected", "0": "report_collected", "1": `collect threw ${refused}` });
	}, 60_000);
});

describe("rollback to 6b95dde (FLEET_PRISTINE)", () => {
	const PRISTINE = process.env.FLEET_PRISTINE;
	test.skipIf(!PRISTINE)("the old binary opens the store, sees completed_unverified, and refuses to start a role task before any operation row", async () => {
		const P = { ...(await import(join(PRISTINE!, "src/store.ts"))), ...(await import(join(PRISTINE!, "src/fleet.ts"))) };
		const copyDir = temp("wu-rollback-");
		const copy = join(copyDir, "fleet.sqlite");
		main.store.backup(copy);
		for (const readOnly of [false, true]) {
			const old = new P.FleetStore(copy, 100, readOnly ? { readOnly: true } : { deferTerminalRelease: true });
			try {
				const t = old.task(ids["prose-clean"]!);
				expect([t.phase, t.result.verified, t.result.verificationEvidence]).toEqual(["completed_unverified", false, undefined]);
				// Every spec plus the store's author task.
				expect(old.taskStates().length).toBe(SPECS.length + 1);
			} finally { old.close(); }
		}
		const old = new P.FleetStore(copy, 100, { deferTerminalRelease: true });
		try {
			const fleet = new P.Fleet(old);
			const db: Database = (old as any).db;
			const opsBefore = db.query("SELECT count(*) n FROM operations WHERE task_id=?").get(ids["queued-role"]!);
			await expect(fleet.start(ids["queued-role"]!)).rejects.toThrow("Unexpected field");
			expect(db.query("SELECT count(*) n FROM operations WHERE task_id=?").get(ids["queued-role"]!)).toEqual(opsBefore);
			expect(db.query("SELECT count(*) n FROM task_deliverables").get()).toEqual(dbOf(main.store).query("SELECT count(*) n FROM task_deliverables").get());
		} finally { old.close(); }
	});
});

async function renderPage(state: any): Promise<string> {
	const elements = await renderDashboardFixture(state);
	return [...elements.values()].map((e) => e.innerHTML + e.textContent).join("\n");
}
