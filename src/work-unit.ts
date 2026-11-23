/**
 * Work-unit Step 1 and Step 1b: a collected review/report becomes a DELIVERABLE FACT, never a verification.
 *
 * Principle P1: nothing in this module writes `tasks.data`. A task's phase, `result.verified` and
 * `verificationEvidence` stay exactly what the existing lifecycle made them. The only writes are rows of the
 * append-only `task_deliverables` table, the operator switch `work_unit_switch` and audit rows.
 *
 * Switch = table AND its row: on = `work_unit_switch` holds exactly row id=1 and both work-unit tables and
 * their triggers have exactly the expected schema; off = no `work_unit_switch` table; anything else is
 * inconsistent (role submits, starts and recordings are refused; reads keep working, shown as off).
 *
 * Unknown stays unknown: a precondition that is not provably met, a store or report that cannot be read, or
 * any SQLite / I-O error yields `not_ready` / `unavailable` with nothing written, never a rejection and never
 * a success. No git is spawned here and no node is contacted.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { canonicalJson, demand, digest, FleetError, REVIEW_VERDICT_PREFIX, ROLE_REPORT_PATH, type WorkUnitSwitchState } from "./core";
import type { Json, Phase, TaskInput, TaskRecord, TaskState } from "./contracts";
import type { FailureDiagnostic } from "./diagnostic";

export { ROLE_REPORT_PATH };
export type { WorkUnitSwitchState };
/** The fixed instruction a role task's prompt must carry (submit templates, README, `workunits status`). */
export const ROLE_PROMPT_INSTRUCTION = `Write your complete report as UTF-8 Markdown to ${ROLE_REPORT_PATH} and change nothing else: no other file, no commit.`;
/** Added to ROLE_PROMPT_INSTRUCTION for a review task (validateTaskInput requires the prompt to name the verdict line). */
export const REVIEW_PROMPT_INSTRUCTION = `Start the report with exactly one line "${REVIEW_VERDICT_PREFIX} CLEAN" or "${REVIEW_VERDICT_PREFIX} NOT CLEAN".`;
export const REPORT_LIMIT = 4 * 1024 * 1024;
/** Step 1b: the only paths an operator may classify as a report (root `report-<uuid>.md` or the role path). */
export const LEGACY_REPORT_PATH = /^report-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/;
export const LABEL = {
	role_tag: "Report collected · not verification",
	operator_classified: "Operator-classified · report · not verification",
	rejected: "Execution ended · awaiting supervisor verification",
	report_not_in_manifest: "No report in the collected manifest",
} as const;

const SWITCH_TABLE = "work_unit_switch";
const DELIVERABLES_TABLE = "task_deliverables";
const SCHEMA = [
	`CREATE TABLE ${SWITCH_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL, enabled_by TEXT NOT NULL CHECK(length(enabled_by) BETWEEN 1 AND 200), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000))`,
	`CREATE TABLE ${DELIVERABLES_TABLE} (
  task_id TEXT PRIMARY KEY CHECK(length(task_id) BETWEEN 1 AND 64),
  attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 64),
  input_digest TEXT NOT NULL CHECK(length(input_digest)=64),
  basis TEXT NOT NULL CHECK(basis IN ('role_tag','operator_classified')),
  role TEXT NOT NULL CHECK(role IN ('review','report')),
  kind TEXT NOT NULL CHECK(kind IN ('report_collected','report_rejected')),
  reason TEXT CHECK((kind='report_collected' AND reason IS NULL) OR (kind='report_rejected' AND length(reason) BETWEEN 1 AND 64)),
  manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64),
  report_path TEXT CHECK(report_path IS NULL OR length(report_path) BETWEEN 1 AND 128),
  report_sha256 TEXT CHECK(report_sha256 IS NULL OR length(report_sha256)=64),
  report_bytes INTEGER CHECK(report_bytes IS NULL OR report_bytes BETWEEN 1 AND ${REPORT_LIMIT}),
  record_digest TEXT NOT NULL UNIQUE CHECK(length(record_digest)=64),
  repo_id TEXT NOT NULL CHECK(length(repo_id) BETWEEN 1 AND 256),
  head_commit TEXT NOT NULL CHECK(length(head_commit) IN (40,64)),
  branch TEXT CHECK(branch IS NULL OR length(branch) BETWEEN 1 AND 200),
  subject_task_id TEXT CHECK(subject_task_id IS NULL OR length(subject_task_id) BETWEEN 1 AND 128),
  verdict TEXT CHECK(verdict IS NULL OR verdict IN ('clean','not_clean')),
  actor TEXT CHECK(actor IS NULL OR length(actor) BETWEEN 1 AND 200),
  actor_reason TEXT CHECK(actor_reason IS NULL OR length(actor_reason) BETWEEN 1 AND 1000),
  os_user TEXT CHECK(os_user IS NULL OR length(os_user) BETWEEN 1 AND 200),
  host TEXT CHECK(host IS NULL OR length(host) BETWEEN 1 AND 255),
  recorded_at TEXT NOT NULL,
  CHECK((kind='report_collected') = (report_sha256 IS NOT NULL AND report_bytes IS NOT NULL AND report_path IS NOT NULL)),
  CHECK((basis='operator_classified') = (actor IS NOT NULL AND actor_reason IS NOT NULL AND os_user IS NOT NULL AND host IS NOT NULL)),
  CHECK(basis='role_tag' OR kind='report_collected'),
  CHECK((basis='role_tag' AND role='review') = (branch IS NOT NULL AND subject_task_id IS NOT NULL)),
  CHECK((verdict IS NOT NULL) = (basis='role_tag' AND role='review' AND kind='report_collected')))`,
	`CREATE TRIGGER task_deliverables_no_update BEFORE UPDATE ON ${DELIVERABLES_TABLE} BEGIN SELECT RAISE(ABORT,'Deliverable records are append-only'); END`,
	`CREATE TRIGGER task_deliverables_no_delete BEFORE DELETE ON ${DELIVERABLES_TABLE} BEGIN SELECT RAISE(ABORT,'Deliverable records are append-only'); END`,
] as const;
type SchemaObject = { type: string; name: string; tbl_name: string; sql: string | null };
const OBJECTS_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name IN ('${SWITCH_TABLE}','${DELIVERABLES_TABLE}') OR name IN ('${SWITCH_TABLE}','${DELIVERABLES_TABLE}','task_deliverables_no_update','task_deliverables_no_delete') ORDER BY type, name`;
/** sqlite_master exactly as SQLite stores this schema (computed, not hand-copied), per table. */
const EXPECTED: { all: string; deliverables: string } = (() => {
	const db = new Database(":memory:");
	try {
		for (const sql of SCHEMA) db.exec(sql);
		const all = db.query<SchemaObject, []>(OBJECTS_SQL).all();
		return { all: JSON.stringify(all), deliverables: JSON.stringify(all.filter((o) => o.tbl_name === DELIVERABLES_TABLE)) };
	} finally {
		db.close();
	}
})();

/** What FleetStore exposes to this module (FleetStore.workUnitAccess): its connection and its own writers. */
export interface WorkUnitAccess {
	db: Database;
	readOnly: boolean;
	/** FleetStore.transaction: BEGIN IMMEDIATE; a throw rolls back and is audited as `refused` with a diagnostic. */
	transaction<T>(action: string, taskId: string | undefined, body: () => T): T;
	audit(kind: string, value: Record<string, Json>, taskId?: string): void;
	dispatchDisabled(): boolean;
}
/** The store surface used here (structural: no runtime import of store.ts). */
export interface WorkUnitStore {
	workUnitAccess(): WorkUnitAccess;
	task(id: string): TaskRecord | undefined;
}
type Validate = (identity: any, manifest: any) => void;

function objects(db: Database): SchemaObject[] {
	return db.query<SchemaObject, []>(OBJECTS_SQL).all();
}
/** The switch in the caller's snapshot (call inside the caller's transaction when it has one). */
export function switchState(db: Database): WorkUnitSwitchState {
	const all = objects(db);
	if (!all.some((o) => o.type === "table" && o.name === SWITCH_TABLE)) return "off";
	if (JSON.stringify(all) !== EXPECTED.all) return "inconsistent";
	const rows = db.query<{ id: unknown }, []>(`SELECT id FROM ${SWITCH_TABLE}`).all();
	return rows.length === 1 && rows[0]!.id === 1 ? "on" : "inconsistent";
}
/** One short read snapshot when the caller is not inside a transaction. */
export function workUnitState(store: Pick<WorkUnitStore, "workUnitAccess">): WorkUnitSwitchState {
	const { db } = store.workUnitAccess();
	return db.inTransaction ? switchState(db) : db.transaction(() => switchState(db)).deferred();
}
/**
 * validateTaskInput options for one of its four call sites: an input without the `workUnit` key does not
 * even read the switch (code without work units, byte for byte); with it, the switch is read in a snapshot.
 */
export function inputOptions(store: Pick<WorkUnitStore, "workUnitAccess">, input: unknown): { workUnits?: WorkUnitSwitchState } {
	return input !== null && typeof input === "object" && Object.hasOwn(input, "workUnit") ? { workUnits: workUnitState(store) } : {};
}
export function isRoleTask(task: { input?: unknown }): boolean {
	return task.input !== null && typeof task.input === "object" && Object.hasOwn(task.input, "workUnit");
}

function bounded(value: unknown, max: number, field: string): string {
	demand(typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), "INVALID_INPUT", `${field} must be 1..${max} printable characters`);
	return value;
}
/** Operator switch ON: creates both tables and triggers (exact schema) and row id=1, audited, one transaction. */
export function enableWorkUnits(store: Pick<WorkUnitStore, "workUnitAccess">, request: { actor: string; reason: string }) {
	const access = store.workUnitAccess();
	return access.transaction("workunitsEnable", undefined, () => {
		const actor = bounded(request?.actor, 200, "actor");
		const reason = bounded(request?.reason, 1000, "reason");
		demand(!access.dispatchDisabled(), "DISPATCH_DISABLED", "Local rollback is entered; the work-unit switch is not enabled during rollback");
		const db = access.db;
		const state = switchState(db);
		if (state === "on") return { changed: false, state };
		demand(state === "off", "WORK_UNIT_SWITCH_INCONSISTENT", "Work-unit switch table present without its single row or with an unexpected schema; repair it first");
		const present = objects(db);
		if (present.length) {
			// Records retained from an earlier enable: re-used only with exactly the expected schema (R12).
			demand(JSON.stringify(present) === EXPECTED.deliverables, "WORK_UNIT_SWITCH_INCONSISTENT", "A task_deliverables table or trigger with an unexpected schema exists; it is never adopted");
		} else for (const sql of SCHEMA.slice(1)) db.exec(sql);
		db.exec(SCHEMA[0]);
		db.query(`INSERT INTO ${SWITCH_TABLE}(id,enabled_at,enabled_by,reason) VALUES (1,?,?,?)`).run(new Date().toISOString(), actor, reason);
		demand(switchState(db) === "on", "WORK_UNIT_SWITCH_INCONSISTENT", "Work-unit switch did not read back as on");
		access.audit("work_unit_switch_enabled", { actor, reason, retainedRecords: present.length > 0 });
		return { changed: true, state: "on" as const };
	});
}
/** Non-started role tasks: they hold a reservation and cannot start once the switch is off (R14). */
export function pendingRoleTasks(db: Database): string[] {
	return db
		.query<{ id: string }, []>(
			"SELECT id FROM tasks WHERE json_type(data,'$.input.workUnit') IS NOT NULL AND json_extract(data,'$.phase') IN ('queued','preparing','dispatching') AND json_type(data,'$.turnId') IS NULL ORDER BY rowid",
		)
		.all()
		.map((row) => row.id);
}
/** Operator switch OFF: drops only `work_unit_switch`; records stay (readable, ignored by views). */
export function disableWorkUnits(store: Pick<WorkUnitStore, "workUnitAccess">, request: { actor: string; reason: string }) {
	const access = store.workUnitAccess();
	return access.transaction("workunitsDisable", undefined, () => {
		const actor = bounded(request?.actor, 200, "actor");
		const reason = bounded(request?.reason, 1000, "reason");
		const db = access.db;
		if (!objects(db).some((o) => o.type === "table" && o.name === SWITCH_TABLE)) return { changed: false, state: "off" as const };
		const pending = pendingRoleTasks(db);
		demand(pending.length === 0, "WORK_UNIT_ROLE_TASKS_PENDING", `Role tasks not yet started would stay reserved and could never start; cancel them first: ${pending.slice(0, 20).join(",")}`);
		const from = switchState(db);
		db.exec(`DROP TABLE ${SWITCH_TABLE}`);
		access.audit("work_unit_switch_disabled", { actor, reason, from });
		return { changed: true, state: "off" as const };
	});
}
export function workUnitStatus(store: Pick<WorkUnitStore, "workUnitAccess">) {
	const { db } = store.workUnitAccess();
	return db.transaction(() => {
		const state = switchState(db);
		const hasRecords = objects(db).some((o) => o.type === "table" && o.name === DELIVERABLES_TABLE);
		const counts = hasRecords
			? db.query<{ basis: string; kind: string; n: number }, []>(`SELECT basis, kind, count(*) AS n FROM ${DELIVERABLES_TABLE} GROUP BY basis, kind ORDER BY basis, kind`).all()
			: [];
		const row = state === "on" ? db.query<{ enabled_at: string; enabled_by: string; reason: string }, []>(`SELECT enabled_at, enabled_by, reason FROM ${SWITCH_TABLE} WHERE id=1`).get() : null;
		return {
			state,
			...(row ? { enabledAt: row.enabled_at, enabledBy: row.enabled_by, reason: row.reason } : {}),
			records: counts,
			reportPath: ROLE_REPORT_PATH,
			promptInstruction: ROLE_PROMPT_INSTRUCTION,
			reviewPromptInstruction: REVIEW_PROMPT_INSTRUCTION,
			statement: "A deliverable record means the report bytes were collected; it is never a verification.",
			reviewOrdering: REVIEW_ORDERING,
		};
	}).deferred();
}

// ---- classification (pure) ------------------------------------------------------------------
type ManifestFile = { path: string; bytes: number; sha256: string; contentBase64: string; deleted: boolean; type: string };
type Manifest = { identity: unknown; outputHead?: unknown; patch: string; patchDigest: string; files: ManifestFile[]; tests: unknown[]; status: string };
export type RejectReason =
	| "report_changed_code"
	| "report_outside_contract"
	| "report_not_in_manifest"
	| "report_digest_mismatch"
	| "report_too_large"
	| "report_not_utf8"
	| "report_empty"
	| "verdict_missing"
	| "reviewer_not_independent";
export type Verdict = "clean" | "not_clean";
export type ReportFact =
	| { kind: "report_collected"; reportPath: string; reportSha256: string; reportBytes: number; verdict?: Verdict }
	| { kind: "report_rejected"; reason: RejectReason };
/**
 * A review report's first line (one trailing CR removed): exactly `VERDICT: CLEAN` or `VERDICT: NOT CLEAN`, or
 * that token followed by whitespace and a remainder that does not contain `CLEAN`. Anything else is undecided.
 */
function verdictLine(text: string): Verdict | undefined {
	let line = text.split("\n", 1)[0]!;
	if (line.endsWith("\r")) line = line.slice(0, -1);
	for (const [token, verdict] of [[`${REVIEW_VERDICT_PREFIX} NOT CLEAN`, "not_clean"], [`${REVIEW_VERDICT_PREFIX} CLEAN`, "clean"]] as const) {
		if (line === token) return verdict;
		const rest = line.startsWith(token) ? line.slice(token.length) : undefined;
		if (rest !== undefined && /^\s/u.test(rest) && !rest.includes("CLEAN")) return verdict;
	}
	return undefined;
}
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
/** At least one code point outside White_Space, Cc and Cf (R13: NUL-only or zero-width-only is empty). */
const VISIBLE = /[^\p{White_Space}\p{Cc}\p{Cf}]/u;
function fileFact(file: ManifestFile, path: string, review = false): ReportFact {
	if (file.deleted || file.type !== "regular") return { kind: "report_rejected", reason: "report_outside_contract" };
	const bytes = Buffer.from(file.contentBase64, "base64");
	if (bytes.length > REPORT_LIMIT) return { kind: "report_rejected", reason: "report_too_large" };
	if (sha256(bytes) !== file.sha256 || bytes.length !== file.bytes) return { kind: "report_rejected", reason: "report_digest_mismatch" };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return { kind: "report_rejected", reason: "report_not_utf8" };
	}
	if (!VISIBLE.test(text)) return { kind: "report_rejected", reason: "report_empty" };
	const fact = { kind: "report_collected" as const, reportPath: path, reportSha256: file.sha256, reportBytes: bytes.length };
	if (!review) return fact;
	const verdict = verdictLine(text);
	if (!verdict) return { kind: "report_rejected", reason: "verdict_missing" };
	return { ...fact, verdict };
}
/**
 * The fixed report contract of a role task: exactly one regular file fleet-review/report.md, patch empty;
 * a review's report must also open with its verdict line.
 */
export function classifyReport(manifest: Manifest, role: "review" | "report" = "report"): ReportFact {
	if (manifest.patch !== "") return { kind: "report_rejected", reason: "report_changed_code" };
	const report = manifest.files.filter((f) => f.path === ROLE_REPORT_PATH);
	if (manifest.files.length !== report.length) return { kind: "report_rejected", reason: "report_outside_contract" };
	// Absent from the COLLECTED manifest: never written, or excluded by ignore rules / unreadable on the node.
	// The record states only that manifest fact, never "the agent wrote nothing".
	if (!report.length) return { kind: "report_rejected", reason: "report_not_in_manifest" };
	return fileFact(report[0]!, ROLE_REPORT_PATH, role === "review");
}
/** Step 1b: the operator names the one file and its sha256; anything else is CLASSIFICATION_MISMATCH. */
export function classifyLegacyReport(manifest: Manifest, path: string, sha: string): ReportFact & { kind: "report_collected" } {
	const refuse = (why: string): never => {
		throw new FleetError("CLASSIFICATION_MISMATCH", `Operator classification refused (${why}); nothing written`);
	};
	if (path !== ROLE_REPORT_PATH && !LEGACY_REPORT_PATH.test(path)) refuse("report_path_not_allowed");
	if (manifest.patch !== "") refuse("report_changed_code");
	if (manifest.files.length !== 1 || manifest.files[0]!.path !== path) refuse("report_outside_contract");
	const fact = fileFact(manifest.files[0]!, path);
	if (fact.kind !== "report_collected") return refuse(fact.reason);
	if (fact.reportSha256 !== sha) refuse("report_sha256_mismatch");
	return fact;
}

// ---- preconditions ----------------------------------------------------------------------------
export type Basis = "role_tag" | "operator_classified";
/** Every precondition on the task row without its result (P3); undefined = met. */
function stateBlock(task: TaskState, basis: Basis): string | undefined {
	if (basis === "role_tag" && !isRoleTask(task)) return "not_role_tagged";
	if (basis === "operator_classified" && isRoleTask(task)) return "role_tagged_task_uses_role_rule";
	const phase: Phase = task.phase;
	if (phase !== "completed_unverified") return "phase_" + phase;
	if (task.result?.executionTerminal !== true) return "execution_not_terminal";
	// Receipt-less, with or without an accepted late receipt (which is completed_unverified again).
	if (task.result.settlement !== undefined) return "receiptless_settlement";
	if (task.result.verified === true || task.result.verificationEvidence !== undefined) return "already_verified";
	if (!task.workspace || !task.attemptId || !task.sessionId || !task.turnId) return "no_executed_identity";
	if (task.testReceipt !== undefined) return "test_evidence_present";
	return undefined;
}
/** R6: a claimed verify-test/result-test, with or without its receipt, never yields a deliverable. */
function testOperations(db: Database, taskId: string): number {
	return db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM operations WHERE task_id=? AND kind IN ('verify-test','result-test')").get(taskId)!.n;
}
function manifestBlock(task: TaskRecord, manifest: unknown): string | undefined {
	if (manifest === undefined) return "manifest_not_saved";
	const m = manifest as Manifest;
	if (!m || typeof m !== "object" || typeof m.patch !== "string" || !Array.isArray(m.files) || !Array.isArray(m.tests)) return "manifest_invalid";
	if (canonicalJson(m.identity) !== canonicalJson(task.workspace)) return "manifest_invalid";
	if (sha256(m.patch) !== m.patchDigest) return "manifest_invalid";
	if (m.tests.length !== 0 || m.status !== "not_run") return "test_evidence_present";
	return undefined;
}

export type Operator = { actor: string; reason: string; reportPath: string; reportSha256: string; role: "review" | "report" };
export type Outcome =
	| { outcome: "not_ready"; reason: string }
	| { outcome: "recorded"; changed: boolean; record: DeliverableRecord };
export interface DeliverableRecord {
	taskId: string;
	attemptId: string;
	inputDigest: string;
	basis: Basis;
	role: "review" | "report";
	kind: "report_collected" | "report_rejected";
	reason: string | null;
	manifestDigest: string;
	reportPath: string | null;
	reportSha256: string | null;
	reportBytes: number | null;
	actor: string | null;
	actorReason: string | null;
	osUser: string | null;
	host: string | null;
	/** What was reviewed or reported on: the task's repository and the exact commit its workspace was made from. */
	repoId: string;
	headCommit: string;
	/** Review (role tag) only: the declared branch (its head was this commit at preparation) and the author task. */
	branch: string | null;
	subjectTaskId: string | null;
	/** Review (role tag) with a collected report only: its first line. */
	verdict: Verdict | null;
	recordDigest: string;
}
/** The subject of a role-tagged review task (validateTaskInput admitted it while the switch was on). */
function reviewSubject(task: { input: TaskInput }): { taskId: string; branch: string } | undefined {
	const unit = task.input.workUnit;
	return unit?.role === "review" ? unit.subject : undefined;
}
/** The session of a review's author task, in the caller's snapshot; undefined when it is not known. */
function authorSession(db: Database, task: { input: TaskInput }): string | undefined {
	const subject = reviewSubject(task);
	if (!subject) return undefined;
	const row = db.query<{ session: unknown }, [string]>("SELECT json_extract(data,'$.sessionId') AS session FROM tasks WHERE id=?").get(subject.taskId);
	return typeof row?.session === "string" ? row.session : undefined;
}
/** Role-tag review only: the author's session must be known (session ids are immutable once recorded). */
function independenceBlock(db: Database, task: TaskRecord, basis: Basis): string | undefined {
	return basis === "role_tag" && reviewSubject(task) && authorSession(db, task) === undefined ? "subject_session_unknown" : undefined;
}
/** The operator contract for a reviewable author commit (README, `workunits status`). */
export const REVIEW_ORDERING =
	"A review subject's commit is proven once, at its first `fleet result` while the switch is on: the author commits on its detached HEAD (no `git switch -c`/`checkout -b`), and nobody creates a branch or other ref at that commit before that `fleet result`; create the review branch afterwards. 'Proven created' means not reachable from this repository's recorded history (refs, other worktrees' HEADs and per-worktree refs, the reflogs of refs and of the main-worktree HEAD), not authored by Fleet: a commit found only in another linked worktree's HEAD reflog, or imported without a ref (e.g. `git fetch URL` and a checkout of FETCH_HEAD), is proven created.";
/** The audit kind FleetStore.saveResult writes, outside the manifest, when the node proved its outputHead created. */
export const OUTPUT_HEAD_CREATED = "output_head_created";
/** The audit kind FleetStore.saveResult writes instead when the proof was asked and not obtained, with its reason. */
export const OUTPUT_HEAD_UNPROVEN = "output_head_unproven";
/**
 * Why a proof asked at the first collection was not obtained: the node answered `{created: false}`, answered
 * anything else, refused before any effect (e.g. an older node without `provenance`), or failed otherwise.
 */
export const UNPROVEN_REASONS = ["not_created", "reply_invalid", "node_refused", "node_failed"] as const;
export type UnprovenReason = (typeof UNPROVEN_REASONS)[number];
/** Fleet.result's provenance outcome, asked once (switch on, role-less task, first collection) and saved with the result. */
export type OutputHeadProof = { created: true } | { created: false; reason: UnprovenReason; diagnostic?: FailureDiagnostic };
/**
 * The subject facts assertFleetCommit needs, read by SQL: outputHead from the task row (the inline manifest or
 * the externalised skeleton, never a result blob) and the node's proof from its own `output_head_created` audit row.
 */
export interface FleetCommitSubject {
	roleTask: boolean;
	repoId: unknown;
	baseCommit: unknown;
	outputHead: unknown;
	outputHeadCreated: boolean;
	/** The recorded reason when the proof was asked and not obtained; undefined when no proof was ever asked. */
	unproven: unknown;
}
export function fleetCommitSubject(db: Database, taskId: string): FleetCommitSubject | undefined {
	const row = db
		.query<{ role: number; repo_id: unknown; base: unknown; head: unknown; created: number; unproven: unknown }, [string, string]>(
			`SELECT json_type(data,'$.input.workUnit') IS NOT NULL AS role, json_extract(data,'$.input.repoId') AS repo_id,
				json_extract(data,'$.input.baseCommit') AS base,
				CASE WHEN json_type(data,'$.resultExternal') IS NOT NULL THEN json_extract(data,'$.resultExternal.skeleton.outputHead') ELSE json_extract(data,'$.resultManifest.outputHead') END AS head,
				EXISTS(SELECT 1 FROM audit WHERE task_id=?1 AND kind='${OUTPUT_HEAD_CREATED}' AND json_extract(audit.data,'$.outputHead') =
					CASE WHEN json_type(tasks.data,'$.resultExternal') IS NOT NULL THEN json_extract(tasks.data,'$.resultExternal.skeleton.outputHead') ELSE json_extract(tasks.data,'$.resultManifest.outputHead') END) AS created,
				(SELECT json_extract(audit.data,'$.reason') FROM audit WHERE task_id=?1 AND kind='${OUTPUT_HEAD_UNPROVEN}' AND json_extract(audit.data,'$.outputHead') =
					CASE WHEN json_type(tasks.data,'$.resultExternal') IS NOT NULL THEN json_extract(tasks.data,'$.resultExternal.skeleton.outputHead') ELSE json_extract(tasks.data,'$.resultManifest.outputHead') END
					ORDER BY sequence LIMIT 1) AS unproven
			FROM tasks WHERE id=?2`,
		)
		.get(taskId, taskId);
	return row
		? { roleTask: row.role === 1, repoId: row.repo_id, baseCommit: row.base, outputHead: row.head, outputHeadCreated: row.created === 1, unproven: row.unproven ?? undefined }
		: undefined;
}
/**
 * FleetStore.submit, inside its transaction, for a new review input: the reviewed head commit (the review's
 * baseCommit) must be a commit a Fleet task made. That is the `outputHead` of the subject task's saved result:
 * a role-less task of the same repository whose node proved at collection that its agent created that commit
 * in its Fleet workspace (its `output_head_created` audit row: every commit from its baseCommit to that head was
 * reachable from no ref, no other worktree HEAD and no shared reflog). Anything else, including an unknown subject
 * or a result saved without that proof, is NON_FLEET_COMMIT.
 */
export function assertFleetCommit(input: TaskInput, subject: FleetCommitSubject | undefined): void {
	if (input.workUnit?.role !== "review") return;
	const refuse = (why: string) => new FleetError("NON_FLEET_COMMIT", `Review refused: ${why}; only a commit made by a Fleet task is reviewed`);
	if (!subject) throw refuse("the subject task is unknown to this store");
	if (subject.roleTask) throw refuse("the subject task is itself a role task");
	if (subject.repoId !== input.repoId) throw refuse("the subject task belongs to another repository");
	const head = subject.outputHead;
	if (typeof head !== "string") throw refuse("the subject task has no saved result");
	if (head === subject.baseCommit) throw refuse("the subject task made no commit");
	if (head !== input.baseCommit) throw refuse("baseCommit is not the commit the subject task made");
	if (subject.outputHeadCreated) return;
	if (subject.unproven === undefined)
		throw refuse("no creation proof was asked for the subject's result (collected while the work-unit switch was off, or by an earlier Fleet version); the proof is asked only once, at the first collection");
	const reason = (UNPROVEN_REASONS as readonly unknown[]).includes(subject.unproven) ? subject.unproven : "unrecognised";
	throw refuse(`the subject's node did not prove the commit was created in its workspace (proof outcome at its first collection: ${reason}; never asked again)`);
}
function principal(): { osUser: string; host: string } {
	let osUser = "unknown";
	try {
		osUser = userInfo().username || "unknown";
	} catch {}
	return { osUser: osUser.slice(0, 200), host: (hostname() || "unknown").slice(0, 255) };
}
/**
 * Pure: the record for a task whose preconditions hold (no I/O beyond the caller's in-memory task and the
 * author session the caller read). A review run in its author's session is never a review verdict.
 */
function buildRecord(task: TaskRecord, manifest: Manifest, operator?: Operator, author?: string): DeliverableRecord {
	const subject = operator ? undefined : reviewSubject(task);
	const fact: ReportFact = operator
		? classifyLegacyReport(manifest, operator.reportPath, operator.reportSha256)
		: subject && task.sessionId === author
			? { kind: "report_rejected", reason: "reviewer_not_independent" }
			: classifyReport(manifest, task.input.workUnit!.role);
	const who = operator ? principal() : undefined;
	const body = {
		taskId: task.id,
		attemptId: task.attemptId!,
		inputDigest: task.inputDigest,
		basis: (operator ? "operator_classified" : "role_tag") as Basis,
		role: operator ? operator.role : task.input.workUnit!.role,
		kind: fact.kind,
		reason: fact.kind === "report_rejected" ? fact.reason : null,
		manifestDigest: digest(manifest),
		reportPath: fact.kind === "report_collected" ? fact.reportPath : null,
		reportSha256: fact.kind === "report_collected" ? fact.reportSha256 : null,
		reportBytes: fact.kind === "report_collected" ? fact.reportBytes : null,
		actor: operator ? operator.actor : null,
		actorReason: operator ? operator.reason : null,
		osUser: who?.osUser ?? null,
		host: who?.host ?? null,
		repoId: task.input.repoId,
		headCommit: task.input.baseCommit,
		branch: subject?.branch ?? null,
		subjectTaskId: subject?.taskId ?? null,
		verdict: fact.kind === "report_collected" ? (fact.verdict ?? null) : null,
	};
	// recorded_at stays outside the digest: the same fact recorded twice is the same record.
	return { ...body, recordDigest: digest(body as unknown as Json) };
}
type RowRecord = { record_digest: string };
/**
 * Under the caller's write lock: re-check everything that a concurrent writer could have changed since the
 * read (switch, task state without its result, test claims, the saved manifest's audit digest), then insert.
 * Never reads a result body or blob (R11).
 */
function insertChecked(access: WorkUnitAccess, record: DeliverableRecord): Outcome {
	const db = access.db;
	const state = switchState(db);
	if (state !== "on") return { outcome: "not_ready", reason: "switch_" + state };
	const row = db.query<{ data: string }, [string]>("SELECT json_remove(data,'$.resultManifest','$.resultExternal') AS data FROM tasks WHERE id=?").get(record.taskId);
	if (!row) return { outcome: "not_ready", reason: "task_not_found" };
	const current = JSON.parse(row.data) as TaskState;
	const blocked = stateBlock(current, record.basis) ?? (testOperations(db, record.taskId) ? "test_unknown_or_claimed" : undefined);
	if (blocked) return { outcome: "not_ready", reason: blocked };
	if (current.attemptId !== record.attemptId || current.inputDigest !== record.inputDigest) return { outcome: "not_ready", reason: "attempt_changed" };
	const saved = db
		.query<{ digest: unknown }, [string]>("SELECT json_extract(data,'$.digest') AS digest FROM audit WHERE task_id=? AND kind='result_saved' ORDER BY sequence DESC LIMIT 1")
		.get(record.taskId);
	if (saved?.digest !== record.manifestDigest) return { outcome: "not_ready", reason: "manifest_not_bound_to_saved_result" };
	const existing = db.query<RowRecord, [string]>(`SELECT record_digest FROM ${DELIVERABLES_TABLE} WHERE task_id=?`).get(record.taskId);
	if (existing) {
		demand(existing.record_digest === record.recordDigest, "VERIFICATION_CONFLICT", "A different deliverable record exists for this task; records are append-only");
		return { outcome: "recorded", changed: false, record };
	}
	db.query(
		`INSERT INTO ${DELIVERABLES_TABLE}(task_id,attempt_id,input_digest,basis,role,kind,reason,manifest_digest,report_path,report_sha256,report_bytes,record_digest,repo_id,head_commit,branch,subject_task_id,verdict,actor,actor_reason,os_user,host,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		record.taskId, record.attemptId, record.inputDigest, record.basis, record.role, record.kind, record.reason, record.manifestDigest,
		record.reportPath, record.reportSha256, record.reportBytes, record.recordDigest, record.repoId, record.headCommit, record.branch,
		record.subjectTaskId, record.verdict, record.actor, record.actorReason, record.osUser, record.host,
		new Date().toISOString(),
	);
	access.audit(
		"deliverable_recorded",
		{ kind: record.kind, reason: record.reason, recordDigest: record.recordDigest, basis: record.basis, verdict: record.verdict, headCommit: record.headCommit, branch: record.branch, actor: record.actor, osUser: record.osUser, host: record.host },
		record.taskId,
	);
	return { outcome: "recorded", changed: true, record };
}

/**
 * Path (a): inside FleetStore.saveResult, after the manifest write, on the in-memory manifest the only
 * production caller (Fleet.resultValue) validated with validateResult immediately before. Runs under
 * SAVEPOINT; ANY error rolls back to it and is swallowed, so the evidence save commits exactly as without
 * work units (R9). Role-less tasks never reach this function.
 */
export function recordInSave(access: WorkUnitAccess, task: TaskRecord, manifest: unknown): void {
	const db = access.db;
	let open = false;
	try {
		db.exec("SAVEPOINT deliverable");
		open = true;
		if (switchState(db) === "on") {
			const blocked = stateBlock(task, "role_tag") ?? manifestBlock(task, manifest) ?? (testOperations(db, task.id) ? "test_unknown_or_claimed" : undefined) ?? independenceBlock(db, task, "role_tag");
			if (!blocked) insertChecked(access, buildRecord(task, manifest as Manifest, undefined, authorSession(db, task)));
		}
		db.exec("RELEASE deliverable");
		open = false;
	} catch {
		if (open)
			try {
				db.exec("ROLLBACK TO deliverable");
				db.exec("RELEASE deliverable");
			} catch {
				/* The outer saveResult transaction decides; nothing of this savepoint is kept. */
			}
	}
}

/** A failure of the store itself (SQLite, I/O, anything not a Fleet refusal): unknown, never a fact. */
export class DeliverableUnavailable extends Error {
	constructor(readonly cause: unknown) {
		super("deliverable_unavailable");
	}
}
const REFUSALS = new Set(["VERIFICATION_CONFLICT", "CLASSIFICATION_MISMATCH", "WORK_UNIT_SWITCH_INCONSISTENT", "READ_ONLY", "INVALID_INPUT", "TASK_NOT_FOUND"]);
/**
 * Paths (b) and (c): read the task OUTSIDE any write transaction (a v3 blob read may block on a stalled
 * disk; it then blocks only this caller), then BEGIN IMMEDIATE, classify in memory (so an operator
 * classification refusal is audited by the transaction), re-check with SQL and insert. Returns not_ready
 * (nothing written) or the record; throws a FleetError refusal or DeliverableUnavailable (nothing written).
 */
export function recordDeliverable(store: WorkUnitStore, taskId: string, options: { validate: Validate; operator?: Operator; task?: TaskRecord }): Outcome {
	const access = store.workUnitAccess();
	try {
		const state = workUnitState(store);
		if (state === "off") return { outcome: "not_ready", reason: "switch_off" };
		demand(state === "on", "WORK_UNIT_SWITCH_INCONSISTENT", "Work-unit switch is inconsistent; recording is refused");
		let task: TaskRecord | undefined;
		try {
			task = options.task ?? store.task(taskId);
		} catch (error) {
			// v3 wraps every blob read failure (missing, corrupt, I/O) as RESULT_INTEGRITY: never a report fact.
			if (error instanceof FleetError && error.code === "RESULT_INTEGRITY") return { outcome: "not_ready", reason: "result_unreadable" };
			throw error;
		}
		demand(task, "TASK_NOT_FOUND", "Unknown task");
		const basis: Basis = options.operator ? "operator_classified" : "role_tag";
		const blocked = stateBlock(task, basis) ?? manifestBlock(task, task.resultManifest);
		if (blocked) return { outcome: "not_ready", reason: blocked };
		try {
			options.validate(task.workspace, task.resultManifest);
		} catch {
			return { outcome: "not_ready", reason: "manifest_invalid" };
		}
		const found = task;
		return access.transaction("recordDeliverable", taskId, (): Outcome => {
			const unknown = independenceBlock(access.db, found, basis);
			if (unknown) return { outcome: "not_ready", reason: unknown };
			return insertChecked(access, buildRecord(found, found.resultManifest as unknown as Manifest, options.operator, authorSession(access.db, found)));
		});
	} catch (error) {
		if (error instanceof FleetError && REFUSALS.has(error.code)) throw error;
		throw new DeliverableUnavailable(error);
	}
}
/** Path (b), the cached branch of `result ID`: best effort, never changes what `result` returns or throws. */
export function recordCached(store: WorkUnitStore, task: TaskRecord, validate: Validate): void {
	if (!isRoleTask(task)) return;
	try {
		// Read-only when the record exists: a deferred snapshot, never the write lock (a reader is not blocked by a writer).
		const { db } = store.workUnitAccess();
		const exists = () => switchState(db) === "on" && db.query(`SELECT 1 FROM ${DELIVERABLES_TABLE} WHERE task_id=?`).get(task.id) !== null;
		if (db.inTransaction ? exists() : db.transaction(exists).deferred()) return;
		recordDeliverable(store, task.id, { validate, task });
	} catch {
		/* Left for `fleet deliverable ID` (path c); nothing was written. */
	}
}

// ---- views (switch on only; off = exactly the view without work units) -----------------------
export interface DeliverableView {
	kind: "report_collected" | "report_rejected";
	reason: string | null;
	basis: Basis;
	role: "review" | "report";
	label: string;
	verified: false;
	reportPath: string | null;
	reportSha256: string | null;
	reportBytes: number | null;
	repoId: string;
	headCommit: string;
	branch: string | null;
	subjectTaskId: string | null;
	verdict: Verdict | null;
	recordDigest: string;
	recordedAt: string;
	actor?: string;
	osUser?: string;
	host?: string;
}
type DbRow = { task_id: string; kind: DeliverableView["kind"]; reason: string | null; basis: Basis; role: DeliverableView["role"]; report_path: string | null; report_sha256: string | null; report_bytes: number | null; repo_id: string; head_commit: string; branch: string | null; subject_task_id: string | null; verdict: Verdict | null; record_digest: string; recorded_at: string; actor: string | null; os_user: string | null; host: string | null };
function view(row: DbRow): DeliverableView {
	const label = row.kind === "report_collected" ? LABEL[row.basis] : `${LABEL.rejected} · ${row.reason === "report_not_in_manifest" ? LABEL.report_not_in_manifest : row.reason}`;
	return {
		kind: row.kind,
		reason: row.reason,
		basis: row.basis,
		role: row.role,
		label,
		verified: false,
		reportPath: row.report_path,
		reportSha256: row.report_sha256,
		reportBytes: row.report_bytes,
		repoId: row.repo_id,
		headCommit: row.head_commit,
		branch: row.branch,
		subjectTaskId: row.subject_task_id,
		verdict: row.verdict,
		recordDigest: row.record_digest,
		recordedAt: row.recorded_at,
		...(row.basis === "operator_classified" ? { actor: row.actor!, osUser: row.os_user!, host: row.host! } : {}),
	};
}
/** Every record by task id, or undefined while the switch is not on (views then stay exactly as without work units). */
export function deliverableViews(store: Pick<WorkUnitStore, "workUnitAccess">): Map<string, DeliverableView> | undefined {
	const { db } = store.workUnitAccess();
	const read = () => {
		if (switchState(db) !== "on") return undefined;
		return new Map(db.query<DbRow, []>(`SELECT * FROM ${DELIVERABLES_TABLE} ORDER BY rowid`).all().map((row) => [row.task_id, view(row)]));
	};
	return db.inTransaction ? read() : db.transaction(read).deferred();
}
/** `show` / `tasks`: an additive `deliverable` field while the switch is on. */
export function deliverableField(views: Map<string, DeliverableView> | undefined, taskId: string): { deliverable?: DeliverableView } {
	const found = views?.get(taskId);
	return found ? { deliverable: found } : {};
}
/** A report_collected task is no longer "waiting for verification"; it is never counted as succeeded. */
export function collectedTaskIds(store: Pick<WorkUnitStore, "workUnitAccess">): Set<string> {
	const views = deliverableViews(store);
	return new Set(views ? [...views].filter(([, v]) => v.kind === "report_collected").map(([id]) => id) : []);
}
type DashboardLike = {
	pipeline: { outcome: { unverified: number } & Record<string, number> };
	tasks: { id: string }[];
	archivedTasks: { id: string }[];
};
/**
 * Dashboard state: switch not on ⇒ the very same object. On ⇒ terminal completed_unverified tasks with a
 * report_collected record leave `outcome.unverified` and are counted in `reportsCollected` (role tag) or
 * `reportsClassified` (operator, Step 1b); every task with a record gains `deliverable`. Layout untouched.
 */
export function withDeliverables<T extends DashboardLike>(store: Pick<WorkUnitStore, "workUnitAccess">, allTasks: readonly TaskState[], state: T): T {
	const views = deliverableViews(store);
	if (!views) return state;
	const waiting = allTasks.filter((t) => t.phase === "completed_unverified" && t.result?.executionTerminal === true);
	const collected = (basis: Basis) => waiting.filter((t) => views.get(t.id)?.kind === "report_collected" && views.get(t.id)!.basis === basis).length;
	const reportsCollected = collected("role_tag");
	const reportsClassified = collected("operator_classified");
	const decorate = <U extends { id: string }>(task: U): U => (views.has(task.id) ? { ...task, deliverable: views.get(task.id)! } : task);
	return {
		...state,
		pipeline: { ...state.pipeline, outcome: { ...state.pipeline.outcome, unverified: state.pipeline.outcome.unverified - reportsCollected - reportsClassified, reportsCollected, reportsClassified } },
		tasks: state.tasks.map(decorate),
		archivedTasks: state.archivedTasks.map(decorate),
	};
}
