import { Database } from "bun:sqlite";
import { consumeArchiveObservation } from "../fleet";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
	AuditEvent,
	DispositionKind,
	DispositionRequest,
	Json,
	LateReceipt,
	NodeConfig,
	Observation,
	OperationIntent,
	OperationLease,
	Phase,
	SessionAuthority,
	TaskInput,
	TaskDisposition,
	TaskProgress,
	TaskRecord,
	TaskState,
	TaskWithdrawal,
} from "../contracts";
import {
	canonicalJson,
	demand,
	digest,
	FleetError,
	nonemptyEvidence,
	object,
	positiveCap,
	receiptlessUnverifiable,
	selectNode,
	sendRefusals,
	subjectNodeId,
	text,
	validateNode,
	validateObservation,
	validateTaskInput,
	placementRecord,
} from "../core";
import { type AdmissionPolicy, DEFAULT_ADMISSION_POLICY, type HeldCharge, type ResourceSample } from "../admission";
import { type FailureDiagnostic, failureDiagnostic, normalizeDiagnostic, prototypeChain } from "../diagnostic";
import { EXECUTION_FAILURE_REPORTED } from "../execution";
import { PROGRESS_EPISODE_COALESCE_SECONDS, PROGRESS_PHASES, type ProgressRead, type ProgressReading, progressHint, progressOrderToleranceMs, progressSettled, progressVerdict } from "../progress";
import { type ExternalManifest, type ResultInventory, ResultStore, SHA as BLOB_NAME, syncDirectory, TEMP as BLOB_TEMP } from "../result-store";
import { assertFleetCommit, fleetCommitSubject, inputOptions, isRoleTask, OUTPUT_HEAD_CREATED, OUTPUT_HEAD_UNPROVEN, type OutputHeadProof, recordInSave, type WorkUnitAccess } from "../work-unit";
import { NODE_HEALTH_TABLE } from "../node-health";
import { assertSubject, subjectLinks } from "../subject";

export interface ReserveResources {
	samples: ReadonlyMap<string, ResourceSample>;
	policy?: AdmissionPolicy;
	/** Nodes a caller-side gate (preflight, node health) excluded, with their exact reasons. */
	exclusions?: readonly { nodeId: string; reasons: readonly string[] }[];
	/** Pinned dispatch onto an unstable node: recorded atomically with the reservation it describes. */
	healthWarning?: { nodeId: string; failingDimensions: readonly string[] };
}

export type DataRow = { data: string };

export const VERIFICATION_CONFLICT_REASON = "verification_conflict";

export const VERIFICATION_OUTCOME_UNKNOWN_REASON = "verification_outcome_unknown";

export const VERIFICATION_RETAINED_DIGESTS = 8;

export const VERIFICATION_RECORDED_REQUESTS = 8;

export const STATE_COLUMN = "json_remove(data,'$.resultManifest','$.resultExternal')";

export const DAEMON_LEASE_KEY = "daemon:owner";

export const DAEMON_STATUS_LIMIT = 64 * 1024;

export interface DaemonLeaseHolder {
	owner: string;
	pid: number;
	host: string;
	startedAt: string;
	status?: Json;
}

export interface SchedulingRow {
	id: string;
	phase: Phase;
	nodeId?: string;
	attemptId?: string;
	sessionId?: string;
	turnId?: string;
	held: boolean;
	reason?: string;
	approvalContract?: string;
	executionTerminal: boolean;
	resultStatus?: string;
	autoCustody?: boolean;
	settledAt?: string;
	lateObservationUntil?: string;
	lateReceipt: boolean;
	/** A collected result is stored (inline or externalised); never read here. */
	resultStored: boolean;
	workspace: boolean;
	sdkTransport: boolean;
	nodeOs?: string;
}

export const MIGRATION_FAILURE_TEXT: ReadonlyMap<string, string> = new Map([
	// Fleet's own codes.
	["MIGRATION_NOT_APPLIED", "Row update was not applied"],
	["RESULT_INTEGRITY", "Result integrity check failed; row left inline (run results check)"],
	["RESULT_STORE_OFF", "Result store switch is off; row left inline"],
	["SCHEMA_VERSION", "Unsupported database format version; row left inline"],
	// SQLite errors, by primary result code.
	["DB_BUSY", "Database is locked by another connection; row left inline (retry when the other writer is done)"],
	["DB_FULL", "Database or disk is full; row left inline"],
	["DB_CONSTRAINT", "Database constraint refused the migration write; row left inline"],
	["DB_ERROR", "Database error; row left inline"],
	// OS errors: inside a migration transaction only result-directory file operations raise them.
	["RESULT_DIR_DENIED", "Result directory not writable (permission denied or read-only file system); row left inline"],
	["RESULT_DIR_FULL", "No space left for the result directory (disk full or quota); row left inline"],
	["RESULT_DIR_ERROR", "Result directory file operation failed; row left inline"],
	// Anything else (a programming error, a non-Error value, an error without a known code).
	["STORE_ERROR", "Error not classified further; row left inline"],
]);

export const MIGRATION_FAILURE_OTHER = "Row not migrated; row left inline";

export const FLEET_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export const OS_CODE = /^E[A-Z0-9]{1,31}$/;

export function ownString(value: object, key: string): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor !== undefined && Object.hasOwn(descriptor, "value") && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

export function migrationFailureCode(error: unknown): string {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return "STORE_ERROR";
	const chain = prototypeChain(error);
	if (!chain) return "STORE_ERROR";
	const code = ownString(error, "code");
	if (chain.includes(FleetError.prototype)) return code !== undefined && FLEET_CODE.test(code) ? code : "STORE_ERROR";
	if (!chain.includes(Error.prototype) || code === undefined) return "STORE_ERROR";
	if (ownString(error, "name") === "SQLiteError" && /^SQLITE_[A-Z_]{1,40}$/.test(code)) {
		if (/^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) return "DB_BUSY";
		if (code === "SQLITE_FULL") return "DB_FULL";
		if (/^SQLITE_CONSTRAINT(_|$)/.test(code)) return "DB_CONSTRAINT";
		return "DB_ERROR";
	}
	if (OS_CODE.test(code)) {
		if (["EACCES", "EPERM", "EROFS"].includes(code)) return "RESULT_DIR_DENIED";
		if (["ENOSPC", "EDQUOT"].includes(code)) return "RESULT_DIR_FULL";
		return "RESULT_DIR_ERROR";
	}
	return "STORE_ERROR";
}

export function isResultIntegrity(error: unknown): boolean {
	if ((typeof error !== "object" && typeof error !== "function") || error === null) return false;
	const chain = prototypeChain(error);
	return chain !== undefined && chain.includes(FleetError.prototype) && ownString(error, "code") === "RESULT_INTEGRITY";
}

export const REHYDRATE_INTEGRITY_TEXT =
	"Externalised result does not verify (invalid manifest or blob reference, unreadable blob, or skeleton/digest mismatch)";

export const REHYDRATE_OTHER_TEXT = "Externalised result could not be read";

export const BACKUP_TOOL = "gjc-fleet-backup";

export const BACKUP_OWNER = "owner.json";

export const BACKUP_RESULTS_INTENT = "results.intent";

export const BACKUP_RESULTS_OWNER = "results.owner";

export const BACKUP_PUBLISH_INTENT = "publish.intent";

export const SNAPSHOT_FILES = ["snapshot.sqlite", "snapshot.sqlite-journal", "snapshot.sqlite-wal", "snapshot.sqlite-shm"];

export const BACKUP_STAGING_FILES = [...SNAPSHOT_FILES, BACKUP_RESULTS_INTENT, BACKUP_RESULTS_OWNER, BACKUP_PUBLISH_INTENT, BACKUP_OWNER];

export const BACKUP_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function fileIdentity(path: string): string | undefined {
	try {
		const stat = lstatSync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function regularFile(path: string): boolean {
	const stat = lstatSync(path, { throwIfNoEntry: false });
	return stat !== undefined && stat.isFile();
}

export function deadBackupStaging(staging: string, token: string, destination: string): boolean {
	const stat = lstatSync(staging, { throwIfNoEntry: false });
	if (!stat?.isDirectory() || (process.getuid && stat.uid !== process.getuid())) return false;
	const entries = readdirSync(staging);
	if (!entries.includes(BACKUP_OWNER) || !entries.every((name) => BACKUP_STAGING_FILES.includes(name) && regularFile(join(staging, name)))) return false;
	let owner: { tool?: unknown; token?: unknown; destination?: unknown; host?: unknown; pid?: unknown };
	try {
		owner = JSON.parse(readFileSync(join(staging, BACKUP_OWNER), "utf8"));
	} catch {
		return false;
	}
	if (owner?.tool !== BACKUP_TOOL || owner.token !== token || owner.destination !== destination || owner.host !== hostname()) return false;
	if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || owner.pid === process.pid) return false;
	try {
		process.kill(owner.pid as number, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export function fileSha256(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const hash = createHash("sha256");
		const chunk = Buffer.allocUnsafe(1024 * 1024);
		for (let n: number, position = 0; (n = readSync(fd, chunk, 0, chunk.length, position)) > 0; position += n)
			hash.update(chunk.subarray(0, n));
		return hash.digest("hex");
	} finally {
		closeSync(fd);
	}
}

export function backupResultsRemoval(resultsPath: string): { files: string[]; directories: string[] } | undefined {
	const files: string[] = [];
	const directories: string[] = [];
	try {
		for (const name of readdirSync(resultsPath)) {
			const published = BLOB_NAME.test(name);
			if (!published && !BLOB_TEMP.test(name)) return undefined;
			const directory = join(resultsPath, name);
			if (!lstatSync(directory).isDirectory()) return undefined;
			const entries = readdirSync(directory);
			if (entries.some((entry) => entry !== "data")) return undefined;
			if (entries.length === 1) {
				const data = join(directory, "data");
				if (!regularFile(data) || (published && fileSha256(data) !== name)) return undefined;
				files.push(data);
			}
			directories.push(directory);
		}
	} catch {
		return undefined;
	}
	return { files, directories };
}

export function removeBackupResults(resultsPath: string): boolean {
	const removal = backupResultsRemoval(resultsPath);
	if (!removal) return false;
	try {
		for (const file of removal.files) unlinkSync(file);
		for (const directory of removal.directories) rmdirSync(directory);
		rmdirSync(resultsPath);
		return true;
	} catch {
		return false;
	}
}

export function removeBackupStaging(staging: string): void {
	for (const name of BACKUP_STAGING_FILES) rmSync(join(staging, name), { force: true });
	// Fails on anything this tool did not write: that is left in place and named by the next retry.
	rmdirSync(staging);
}

export function recoverBackupLeftovers(destination: string, resultsPath: string): void {
	const parent = dirname(destination);
	const prefix = `${basename(destination)}.backup-`;
	let names: string[];
	try {
		names = readdirSync(parent);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const named: string[] = [];
	let moved = false;
	for (const name of names.sort()) {
		if (!name.startsWith(prefix) || !BACKUP_TOKEN.test(name.slice(prefix.length))) continue;
		const staging = join(parent, name);
		const results = fileIdentity(resultsPath);
		const unpublished = results !== undefined && fileIdentity(destination) === undefined;
		if (!deadBackupStaging(staging, name.slice(prefix.length), destination)) {
			if (unpublished && regularFile(join(staging, BACKUP_RESULTS_INTENT)) && !named.includes(resultsPath)) named.push(resultsPath);
			named.push(staging);
			continue;
		}
		if (unpublished) {
			let recorded: string | undefined;
			try {
				recorded = readFileSync(join(staging, BACKUP_RESULTS_OWNER), "utf8");
			} catch {}
			if (recorded === results) {
				const published = existsSync(join(staging, BACKUP_PUBLISH_INTENT));
				moved ||= published;
				if (published || !removeBackupResults(resultsPath)) {
					if (!named.includes(resultsPath)) named.push(resultsPath);
					named.push(staging);
					continue;
				}
			} else if (existsSync(join(staging, BACKUP_RESULTS_INTENT))) {
				if (!named.includes(resultsPath)) named.push(resultsPath);
				named.push(staging);
				continue;
			}
		}
		removeBackupStaging(staging);
	}
	if (named.length > 0)
		throw new FleetError(
			"BACKUP_LEFTOVER",
			`backup_leftover: an interrupted or running backup to this destination left paths this tool cannot prove it may remove${moved ? `; ${resultsPath} may hold the results of a published backup whose database was moved away: keep it with that database (move it, do not delete it)` : ""}; make sure no backup is running, then remove exactly ${JSON.stringify(named)}`,
		);
}

export const LEGACY_VERSION = 1;

export const ARCHIVE_VERSION = 2;

export const FEATURES_VERSION = 3;

export const RESULT_STORE_FEATURE = "result-store-v1";

export const KNOWN_FEATURES: ReadonlySet<string> = new Set([RESULT_STORE_FEATURE]);

export const RESULT_STORE_OFF_MESSAGE =
	"Result externalisation is off; an operator turns it on with `results enable --confirm-one-way --reason TEXT` (the first externalised row then moves the database to ladder v3, one-way)";

export const RESULT_SWITCH_TABLE = "result_externalisation";

export const RESULT_FORM_TRIGGERS = ["INSERT", "UPDATE OF data"]
	.map(
		(event) => `CREATE TRIGGER IF NOT EXISTS result_form_fence_${event === "INSERT" ? "insert" : "update"} BEFORE ${event} ON tasks
		WHEN json_type(NEW.data,'$.resultExternal') IS NOT NULL AND json_type(NEW.data,'$.resultManifest') IS NOT NULL
		BEGIN SELECT RAISE(ABORT,'Result stored both inline and externalised'); END;`,
	)
	.join("\n");

export const failureSources = [
	"Fleet.start.prepare",
	"Fleet.start.connect",
	"Fleet.start.create",
	"Fleet.start.authority",
	"Fleet.start.prompt",
	"Fleet.inspect.connect",
	"Fleet.inspect.read_turn",
	"Fleet.inspect.list_questions",
	"Fleet.inspect.read_execution",
	"Fleet.answer.submit",
	"Fleet.cancel.abort",
	"Fleet.cancel.close",
] as const;

export type FailureContext = {
	// approval_attach / approval_discovery are accepted here but dropped by safeFailureContext (not in failureSources).
	source: (typeof failureSources)[number] | "Fleet.start.approval_attach" | "Fleet.inspect.approval_discovery";
	errorType: "transport_error" | "unclassified";
	certainty?: "before_send" | "unknown";
	operationKind?:
		| "prepare"
		| "create"
		| "prompt"
		| "answer"
		| "cancel"
		| "cancel-close"
		| "approval-attach";
	operationId?: string;
	operationKey?: string;
	payloadDigest?: string;
};

export function safeFailureContext(context?: FailureContext): Record<string, Json> {
	const safe: Record<string, Json> = {};
	if (!context || !(failureSources as readonly string[]).includes(context.source)) return safe;
	if (!["transport_error", "unclassified"].includes(context.errorType))
		return safe;
	safe.source = context.source;
	safe.errorType = context.errorType;
	if (
		context.errorType === "transport_error" &&
		(context.certainty === "before_send" || context.certainty === "unknown")
	)
		safe.certainty = context.certainty;
	if (
		context.operationKind &&
		[
			"prepare",
			"create",
			"prompt",
			"answer",
			"cancel",
			"cancel-close",
		].includes(context.operationKind)
	) {
		safe.operationKind = context.operationKind;
		for (const key of ["operationId", "operationKey", "payloadDigest"] as const)
			if (typeof context[key] === "string") safe[key] = context[key]!;
	}
	return safe;
}

export const durationBounds = [1, 10, 100, 1000, 10000];

export type DurationOperation = "enqueue_to_admission" | "admission" | "reconcile";

export type DurationOutcome =
	| "admission_start"
	| "reserved"
	| "rejected"
	| "failed"
	| "applied"
	| "stale"
	| "unknown";

export const SEND_CLAIM_KINDS: ReadonlySet<string> = new Set(["prepare", "create", "approval-attach", "prompt"]);

export const RELEASABLE_CLAIM_KINDS: ReadonlySet<string> = new Set(["verify-test", "result-test"]);

export const nodePairs =
	"unsafe_path:unsafe_entry|nested_repository:git_entry|identity_mismatch:identity|root_denied:allowlist|workspace_missing:workspace|output_limit:bytes|timeout:deadline|git_failed:git_exit|workspace_path_too_long:path_budget|invalid_request:request|internal:exception:[a-f0-9-]{36}";

export const nodeFailureCode = new RegExp(
	`^(?:node_refused:(?:${nodePairs})|node_failed:(?:${nodePairs}|executed_reply_failed:reply:[a-f0-9-]{36}|refused:legacy_unspecified))$`,
);

export function refusalCode(refusal: any): string {
	return `node_refused:${refusal?.error}:${refusal?.detail}${refusal?.correlationId ? ":" + refusal.correlationId : ""}`;
}

export const preparationReevaluationOutcomes = new Set(["still_refused", "unavailable"]);

export const resultValidationCodes = new Set([
	"RESULT_BINDING",
	"RESULT_DIGEST",
	"RESULT_HEAD",
	"RESULT_PRODUCER",
	"RESULT_SCHEMA",
	"RESULT_PATH",
	"RESULT_STATUS",
	"RESULT_EXCLUSIONS",
	"RESULT_COMPLETENESS",
	"RESULT_IGNORED",
	"TEST_EVIDENCE",
	"VERIFICATION_CONFLICT",
]);

export const observableRefusalCodes = new Set([
	...resultValidationCodes,
	"KEY_CONFLICT",
	"CANCEL_PENDING",
	"UNKNOWN_EXECUTION",
	"AUTHORITY_CONFLICT",
	"READ_ONLY",
	"INVALID_INPUT",
	"NOT_FOUND",
	"STORE_ERROR",
	"NO_HELD_ATTEMPT",
	"NO_ATTEMPT",
	"NO_SESSION",
	"NO_TURN",
	"NOT_TERMINAL",
	"ALREADY_TERMINAL",
	"OPERATION_CONFLICT",
	"RESERVED_OPERATION",
	"SESSION_CONFLICT",
	"TURN_CONFLICT",
	"EVENT_CONFLICT",
	"POLL_CONFLICT",
	"POLL_LIMIT",
	"WORKSPACE_CONFLICT",
	"CANCEL_UNSUPPORTED",
	"CANCEL_BLOCKED",
	"CANCEL_UNKNOWN",
	"CANCEL_UNCONFIRMED",
	"ANSWER_PENDING",
	"DISPATCH_DISABLED",
]);

export function operatorRunPayload(task: TaskRecord): Json {
	return { inputDigest: task.inputDigest, nodeId: task.nodeId!, attemptId: task.attemptId! };
}
/** Digest an operator quotes to accept an incomplete export (task, attempt, result, exclusions). */
export function exportReviewDigest(subject: Json): string {
	return digest({ kind: "fleet-export-review-v1", subject });
}
/**
 * The passing result-test receipt held with a pending export review: the receipt-less claim's
 * `held`, bound by the review's `resultTestDigest`. It is held once, outside the task row
 * (review fx-6f923f88 F3); anything that does not match is no receipt.
 */
export function heldResultTest(task: TaskRecord, operation: OperationIntent | undefined): Json | undefined {
	const bound = task.result?.exportIncomplete?.resultTestDigest;
	return operation !== undefined && operation.receipt === undefined && operation.held !== undefined && bound !== undefined && digest(operation.held) === bound ? operation.held : undefined;
}
/**
 * Export completeness of the stored result, recomputed from the stored manifest
 * and its retained result-test receipt. Store-level defense in depth: a review
 * subject or verification must describe exactly this, never a caller value.
 */
export function storedExport(task: TaskRecord, resultTest: OperationIntent | undefined) {
	const stored = task.resultManifest as any;
	// A passing verification held with the export review (review fx-093cc54b F1, see Fleet).
	const proof = (resultTest?.receipt ?? heldResultTest(task, resultTest)) as any;
	const retained = !proof && stored.status === "not_run" && stored.tests.length === 0 ? (task.testReceipt as any) : undefined;
	const test = proof?.test ?? retained;
	const effective = test ? { ...stored, tests: [test], status: test.exit === 0 ? "verified" : "tests_failed" } : stored;
	const legacy = stored.exclusions === undefined && stored.exportComplete === undefined;
	const observed = proof?.observedExclusions;
	const state: { completeness: string; exclusions: Json } = !legacy
		? stored.exportComplete === true ? { completeness: "complete", exclusions: [] } : { completeness: "incomplete", exclusions: stored.exclusions }
		: Array.isArray(observed) ? (observed.length ? { completeness: "incomplete", exclusions: observed } : { completeness: "complete", exclusions: [] }) : { completeness: "unknown", exclusions: null };
	return { ...state, artifactSchema: legacy ? "legacy-v1" : "exclusions-v1", manifestDigest: digest(effective), status: effective.status as string };
}
export function subjectDescribesStored(subject: Record<string, Json>, task: TaskRecord, resultTest: OperationIntent | undefined): boolean {
	if (task.resultManifest === undefined) return false;
	const expected = storedExport(task, resultTest);
	return (
		Object.keys(subject).sort().join(",") === "artifactSchema,attemptId,completeness,exclusions,manifestDigest,taskId" &&
		expected.status === "verified" &&
		expected.completeness !== "complete" &&
		subject.manifestDigest === expected.manifestDigest &&
		subject.artifactSchema === expected.artifactSchema &&
		subject.completeness === expected.completeness &&
		canonicalJson(subject.exclusions) === canonicalJson(expected.exclusions)
	);
}
export function resultTestBinding(task: TaskRecord, argv: string[]): Json {
	demand(task.resultManifest && task.workspace && task.sessionId && task.turnId, "RESULT_NOT_READY", "Original collected execution required");
	demand(Array.isArray(argv) && argv.length > 0 && typeof argv[0] === "string" && argv[0].length > 0 && argv.every(arg => typeof arg === "string" && !arg.includes("\0")), "INVALID_INPUT", "Explicit verifier argv required");
	return { argv, manifestDigest: digest(task.resultManifest), workspaceDigest: digest(task.workspace), sessionId: task.sessionId, turnId: task.turnId };
}

export type OperatorReleaseListing =
	| { kind: "exact_live"; indexSeq: number; activity: string | null }
	| { kind: "exact_unproven"; indexSeq: number; live: boolean | null; terminal: boolean | null; activity: string | null }
	| { kind: "foreign_incarnation"; indexSeq: number }
	| { kind: "unverifiable_without_authority"; indexSeq: number; live: boolean | null; activity: string | null }
	| { kind: "unavailable"; error: string };

export const DISPOSITION_STATEMENT: Readonly<Record<DispositionKind, string>> = {
	deployed: "Operator record: the operator states this work landed in the recorded commit. Fleet cannot see the code repository and verified neither the commit, the result nor any deployment. Not succeeded.",
	superseded: "Operator record: a later task supersedes this one; its result is discarded unverified. Not succeeded.",
	"review-recorded": "Operator record of a review verdict; nothing to deploy. Fleet verified nothing. Not succeeded.",
	discarded: "Operator record: discarded unverified (for example a rehearsal). Not succeeded.",
};

export const DISPOSITION_KINDS = Object.keys(DISPOSITION_STATEMENT) as DispositionKind[];

export const DISPOSITION_LIMITS = { reason: 2000, subject: 500, actor: 200, taskId: 200 } as const;

export const WITHDRAWAL_LIMITS = { reason: 200, actor: 200 } as const;

export const dispositionFields: Readonly<Record<DispositionKind, readonly string[]>> = {
	deployed: ["commit"],
	superseded: ["supersededBy"],
	"review-recorded": ["subject", "verdict"],
	discarded: [],
};

export function boundedText(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= limit && !value.includes("\0");
}

export function normaliseDisposition(value: unknown): DispositionRequest {
	demand(value !== null && typeof value === "object" && !Array.isArray(value), "DISPOSE_INPUT", "Disposition request object required");
	const request = value as Record<string, unknown>;
	const kind = request.kind as DispositionKind;
	demand(typeof kind === "string" && Object.hasOwn(dispositionFields, kind), "DISPOSE_INPUT", "Disposition kind must be deployed, superseded, review-recorded or discarded");
	const allowed = new Set(["kind", "reason", "nodeRetired", ...dispositionFields[kind]]);
	demand(Object.keys(request).every((key) => allowed.has(key) && request[key] !== undefined), "DISPOSE_INPUT", "Only the fields of this disposition kind are accepted");
	demand(dispositionFields[kind].every((key) => Object.hasOwn(request, key)), "DISPOSE_INPUT", "Every field of this disposition kind is required");
	demand(boundedText(request.reason, DISPOSITION_LIMITS.reason), "DISPOSE_INPUT", "A nonempty reason of at most 2000 characters is required");
	if (Object.hasOwn(request, "nodeRetired"))
		demand(boundedText(request.nodeRetired, DISPOSITION_LIMITS.reason), "DISPOSE_INPUT", "A nonempty node-retired reason of at most 2000 characters is required");
	if (kind === "deployed")
		demand(typeof request.commit === "string" && /^[0-9a-fA-F]{7,40}$/.test(request.commit), "DISPOSE_INPUT", "--commit must be 7-40 hexadecimal characters");
	if (kind === "superseded") demand(boundedText(request.supersededBy, DISPOSITION_LIMITS.taskId), "DISPOSE_INPUT", "--by must name a task");
	if (kind === "review-recorded") {
		demand(boundedText(request.subject, DISPOSITION_LIMITS.subject), "DISPOSE_INPUT", "A nonempty subject of at most 500 characters is required");
		demand(request.verdict === "clean" || request.verdict === "not-clean", "DISPOSE_INPUT", "--verdict must be clean or not-clean");
	}
	return {
		kind,
		reason: request.reason as string,
		...(kind === "deployed" ? { commit: (request.commit as string).toLowerCase() } : {}),
		...(kind === "superseded" ? { supersededBy: request.supersededBy as string } : {}),
		...(kind === "review-recorded" ? { subject: request.subject as string, verdict: request.verdict as "clean" | "not-clean" } : {}),
		...(Object.hasOwn(request, "nodeRetired") ? { nodeRetired: request.nodeRetired as string } : {}),
	};
}

export const OPERATOR_RELEASE_STATEMENT = "Released by operator: the session was NOT observed gone and may still be running on the node. It stays reported as possibly running until a later fresh listing shows it gone.";

export type ResourceReturnStatus =
	| { state: "returned"; observedGone: true; observed: string; afterOperatorRelease: boolean }
	| { state: "released_by_operator_unconfirmed"; observedGone: false; possiblyRunningOnNode: true; statement: string; operator: string; reason: string; nodeId: string | null; sessionId: string | null; at: string | null };

export type ResultListing =
	| { stored: "inline" | "external"; digest: string; status?: Json; files?: number; tests?: number }
	/** A falsy manifest value (null, false, 0, ""): listed as the value itself, as for a full task. */
	| { stored: "inline" | "external"; value: Json };
