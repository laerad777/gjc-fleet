/**
 * `export TASK_ID DEST`: the named-file deliverables of a finished task, copied from its ONE collected result to a new
 * hub directory with their SHA-256s.
 *
 * The bytes come only from the task's collected result manifest: the stored one when it exists (no node contact),
 * otherwise the normal `result TASK_ID` collection runs first (authoritative settlement required, read-only on the
 * node, saved once and immutable). A copy therefore can never be taken while the lane is still writing, and every
 * export of a task has the same bytes and the same `manifestDigest` that `tasks`/`show` report.
 *
 * Never a verification and never success: phase, verification state and the stored result are untouched.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, demand, digest, FleetError } from "./core";
import { boundedText } from "./execution";
import type { Fleet } from "./fleet";
import { effectiveOperation, exportCompleteness, validateResult, withResultTest } from "./fleet/shared";
import type { OperationIntent } from "./contracts";
import type { ResultManifest, WorkspaceIdentity } from "./workspace";

/** The export's own record, written beside the files; a collected file with this path is refused. */
export const EXPORT_RECORD = "fleet-export.json";
const PATTERN_LIMIT = 64;

export interface ExportOptions {
	/** Bun.Glob patterns over the collected paths (`*` does not cross `/`); none = every collected file. */
	include?: string[];
	/** Each pattern must match at least one collected file; matches are exported even when not included. */
	require?: string[];
}
export interface ExportedFile {
	path: string;
	bytes: number;
	sha256: string;
}
/** Completeness of the exported bytes themselves; independent of test status and operator review. */
export type ExportRecordCompleteness = "complete" | "incomplete" | "unknown";
/**
 * Operator export-review state recorded beside the files.
 * `null` = no incomplete-export review is open or accepted for this task.
 */
export type ExportRecordReview = "required" | "accepted" | null;

export interface ExportRecord {
	schemaVersion: 1;
	taskId: string;
	attemptId: string;
	nodeId: string;
	repoId: string;
	baseCommit: string;
	outputHead: string;
	/** The status inside the collected manifest, never the task's later verification (`result ID` reports that). */
	manifestStatus: ResultManifest["status"];
	/**
	 * Same completeness judgment as `export review`: exclusions-v1 uses the manifest;
	 * legacy-v1 uses observed exclusions on the retained result-test receipt when present,
	 * otherwise `unknown`. Operator acceptance never changes this: an accepted incomplete
	 * export stays `incomplete`.
	 */
	exportCompleteness: ExportRecordCompleteness;
	/**
	 * Whether an incomplete export is awaiting review or was accepted.
	 * Absent review subject ⇒ `null` (complete or never reviewed).
	 */
	exportReview: ExportRecordReview;
	manifestDigest: string;
	patchDigest: string;
	custody?: ResultManifest["custody"];
	source: "stored" | "collected";
	required: string[];
	files: ExportedFile[];
}
export interface ExportSummary {
	ok: true;
	taskId: string;
	dest: string;
	source: ExportRecord["source"];
	manifestDigest: string;
	manifestStatus: ResultManifest["status"];
	exportCompleteness: ExportRecordCompleteness;
	exportReview: ExportRecordReview;
	recordSha256: string;
	custody?: ResultManifest["custody"];
	files: ExportedFile[];
}

/**
 * Export-record completeness: reuse the fleet `exportCompleteness` judgment so
 * legacy manifests with observation evidence are complete/incomplete, not unknown.
 */
export function exportRecordCompleteness(manifest: ResultManifest, operation?: OperationIntent): ExportRecordCompleteness {
	return exportCompleteness(manifest, operation).completeness;
}

/** Map task.result.exportIncomplete into the export-record review vocabulary. */
export function exportRecordReview(result: { exportIncomplete?: { acceptance?: unknown } } | undefined): ExportRecordReview {
	const review = result?.exportIncomplete;
	if (!review) return null;
	return review.acceptance ? "accepted" : "required";
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function patterns(values: string[] | undefined, flag: string): string[] {
	const list = values ?? [];
	demand(list.length <= PATTERN_LIMIT, "INVALID_INPUT", `At most ${PATTERN_LIMIT} ${flag} patterns`);
	for (const value of list)
		demand(typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value), "INVALID_INPUT", `${flag} patterns are 1-256 printable characters`);
	// Bun.Glob negates a leading `!`: a negated --require would be satisfied by any other file.
	for (const value of list) demand(!value.startsWith("!"), "INVALID_INPUT", `${flag} patterns never start with ! (no negation)`);
	return [...new Set(list)];
}

/**
 * Move the finished staging directory to DEST. A rename refused because something appeared at DEST after the last
 * check (a concurrent export of the same DEST, or any other writer) is the EXPORT_DEST_EXISTS refusal, never a raw
 * OS error carrying the staging path. Known limits, both only for something created at DEST after the caller's last
 * absent() check (rename has no no-replace form here): on POSIX an EMPTY directory is replaced by the export (a file
 * or a non-empty directory is not); on Windows a FILE is replaced by the export (a directory, empty or not, is not).
 */
export function publishStaging(staging: string, dest: string): void {
	try {
		renameSync(staging, dest);
	} catch (error) {
		if (!absent(dest)) throw new FleetError("EXPORT_DEST_EXISTS", "DEST appeared during the export; nothing was written there");
		throw error;
	}
}
function absent(path: string): boolean {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
		throw error;
	}
}

/**
 * Validate the request and the destination before anything is read or collected: DEST must not exist and its
 * parent must be an existing directory. Then take the task's one collected manifest, select, check requirements
 * and write everything into a private sibling directory that is renamed to DEST only when complete and re-read.
 */
export async function exportResult(fleet: Fleet, taskId: string, destination: string, options: ExportOptions = {}): Promise<ExportSummary> {
	const include = patterns(options.include, "--include");
	const required = patterns(options.require, "--require");
	const dest = resolve(destination);
	const parent = dirname(dest);
	demand(dest !== parent, "EXPORT_DEST_PARENT", "DEST must be a new directory inside an existing directory");
	demand(absent(dest), "EXPORT_DEST_EXISTS", "DEST already exists; an export never writes into or over an existing path");
	// A link to a directory is followed, as links in every other ancestor are; only a missing parent is a refusal.
	let parentIsDirectory = false;
	try {
		parentIsDirectory = statSync(parent).isDirectory();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	demand(parentIsDirectory, "EXPORT_DEST_PARENT", "The parent of DEST must be an existing directory");

	let task = fleet.store.task(taskId);
	demand(task, "TASK_NOT_FOUND", "Task does not exist");
	// Same policy as `result`: a disposed task's result path is closed, stored or not.
	demand(!task.disposition, "ARCHIVED_TASK", "A disposed task is an operator record; its result is never re-collected, tested or verified");
	let source: ExportRecord["source"] = "stored";
	if (task.resultManifest === undefined) {
		// The normal collection with all of its refusals (settlement, receipt, disposition, verifier claims).
		await fleet.result(taskId);
		source = "collected";
		task = fleet.store.task(taskId);
		demand(task?.resultManifest !== undefined, "RESULT_NOT_READY", "No collected result is stored for this task");
	}
	const storedManifest = task!.resultManifest as unknown as ResultManifest;
	// Same effective result + result-test receipt that `export review` uses for completeness.
	const operation = effectiveOperation(task!, fleet.store.getOperation(taskId, "result-test"));
	const manifest = withResultTest(task!, storedManifest, operation);
	// The stored bytes are re-checked against their node-computed SHA-256s and the task's exact workspace identity.
	validateResult(task!.workspace as unknown as WorkspaceIdentity, storedManifest);

	const present = storedManifest.files.filter((file) => !file.deleted);
	const matches = (pattern: string) => {
		const glob = new Bun.Glob(pattern);
		return present.filter((file) => glob.match(file.path));
	};
	const missing = required.filter((pattern) => matches(pattern).length === 0);
	demand(missing.length === 0, "EXPORT_REQUIRED_MISSING", `Required deliverable not in the collected result: ${missing.join(", ")}`);
	const selected = new Set<string>();
	for (const file of include.length ? include.flatMap(matches) : present) selected.add(file.path);
	for (const pattern of required) for (const file of matches(pattern)) selected.add(file.path);
	const files = present.filter((file) => selected.has(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const conflict = files.find((file) => file.path.split("/")[0]!.toLowerCase() === EXPORT_RECORD);
	demand(!conflict, "EXPORT_PATH_CONFLICT", `A collected file uses the reserved export record path ${EXPORT_RECORD}`);

	// Completeness follows export-review judgment on the effective result; identity/status/digest stay the stored collected manifest.
	const completeness = exportRecordCompleteness(manifest, operation);
	const review = exportRecordReview(task!.result);
	const record: ExportRecord = {
		schemaVersion: 1,
		taskId: task!.id,
		attemptId: storedManifest.identity.attemptId,
		nodeId: storedManifest.identity.nodeId,
		repoId: task!.input.repoId,
		baseCommit: storedManifest.identity.baseCommit,
		outputHead: storedManifest.outputHead,
		manifestStatus: storedManifest.status,
		exportCompleteness: completeness,
		exportReview: review,
		manifestDigest: digest(storedManifest),
		patchDigest: storedManifest.patchDigest,
		source,
		required,
		files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
	};
	const recordText = JSON.stringify(JSON.parse(canonicalJson(record)), null, 2) + "\n";

	// Fixed-length name: any DEST name the filesystem accepts also leaves room for the staging directory.
	const staging = mkdtempSync(join(parent, ".fleet-export.partial-"));
	try {
		for (const file of files) {
			const target = join(staging, ...file.path.split("/"));
			mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
			writeFileSync(target, Buffer.from(file.contentBase64, "base64"), { flag: "wx", mode: 0o600 });
		}
		writeFileSync(join(staging, EXPORT_RECORD), recordText, { flag: "wx", mode: 0o600 });
		for (const file of files)
			demand(sha256(readFileSync(join(staging, ...file.path.split("/")))) === file.sha256, "EXPORT_WRITE_MISMATCH", `Written bytes differ from the collected SHA-256: ${file.path}`);
		demand(readFileSync(join(staging, EXPORT_RECORD), "utf8") === recordText, "EXPORT_WRITE_MISMATCH", `Written ${EXPORT_RECORD} differs`);
		demand(absent(dest), "EXPORT_DEST_EXISTS", "DEST appeared during the export; nothing was written there");
		publishStaging(staging, dest);
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		throw error;
	}
	return {
		ok: true,
		taskId: task!.id,
		dest,
		source,
		manifestDigest: record.manifestDigest,
		manifestStatus: record.manifestStatus,
		exportCompleteness: record.exportCompleteness,
		exportReview: record.exportReview,
		recordSha256: sha256(recordText),
		...(manifest.custody ? { custody: manifest.custody } : {}),
		files: record.files,
	};
}

const USAGE = "usage_export_TASK_ID_DEST_[--include_GLOB]..._[--require_GLOB]...";

/** Public export refusal line: structured code plus length-capped, redacted free text. */
export function publicExportFailure(taskId: string, error: FleetError): string {
	return JSON.stringify({ ok: false, taskId, code: error.code, error: boundedText(error.message) });
}

/** CLI: a Fleet refusal is one JSON line on stdout with its code and exit 1; transport and other errors propagate. */
export async function exportCommand(fleet: Fleet, args: string[]): Promise<number> {
	const [, taskId, dest, ...rest] = args;
	if (!taskId || taskId.startsWith("--") || !dest || dest.startsWith("--")) throw new Error(USAGE);
	const include: string[] = [];
	const require: string[] = [];
	for (let i = 0; i < rest.length; i += 2) {
		const value = rest[i + 1];
		if (value === undefined) throw new Error(USAGE);
		if (rest[i] === "--include") include.push(value);
		else if (rest[i] === "--require") require.push(value);
		else throw new Error(USAGE);
	}
	try {
		console.log(JSON.stringify(await exportResult(fleet, taskId, dest, { include, require }), null, 2));
		return 0;
	} catch (error) {
		if (!(error instanceof FleetError)) throw error;
		console.log(publicExportFailure(taskId, error));
		return 1;
	}
}
