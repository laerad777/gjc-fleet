import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ArchiveEvidence, DispositionRequest, NodeConfig, TaskDisposition, TaskInput, TaskRecord, TaskState, OperationIntent, OperationLease, Json } from "../contracts";
import type { ApprovalDiscovery, ApprovalSessionContext, FleetOptions, NativeWorkflowQuestion, TaskApprovalBackend, TaskApprovalChannel } from "../approval";
import { DISPOSITION_LIMITS, FleetStore, exportReviewDigest, heldResultTest, normaliseDisposition, resultTestBinding, type FailureContext } from "../store";
import { conditionDiagnostic, type DiagnosticCondition, type DiagnosticStep, type FailureDiagnostic, failureDiagnostic } from "../diagnostic";
import {
	canonicalJson,
	demand,
	digest,
	FleetError,
	observationDigest,
	nonemptyEvidence,
	receiptlessUnverifiable,
	validateTaskInput,
} from "../core";
import { classifyCreateRefusal, nodeRpc, type StdioRpc, TransportError } from "../rpc";
import { nodeOperation, oneShot, NodeReplyError, PREFLIGHT_PASSED } from "../node";
import { discoverOrdinary } from "../ordinary";
import {
	abortOwnedSession,
	closeOwnedSession,
	confirmReceiptlessEnd,
	EXECUTION_FAILURE_REPORTED,
	failedExecutionReceipt,
	failureReported,
	LATE_RECEIPT_WINDOW_MS,
	lateReceiptObservation,
	type LateReceiptBinding,
	readSessionAuthority,
	readExecution,
	receiptlessTurnEnd,
	settledExecution,
	type ReceiptlessCandidate,
} from "../execution";
import { validateInputPackage } from "../inputs";
import { inputOptions, isRoleTask, type OutputHeadProof, recordCached, workUnitState } from "../work-unit";
import {
	entryKind,
	PROGRESS_CLOCK_TOLERANCE_SECONDS,
	progressSessionLimit,
	type ProgressConfig,
	progressConfig,
	progressEligible,
	progressOrderToleranceMs,
	ProgressRouteError,
	type ProgressReading,
	readNodeProgress,
	type SessionReading,
} from "../progress";
import {
	sha256,
	safeRelative,
	excluded,
	validateSelectedOutputs,
	IGNORED_LIST_LIMIT,
	IGNORE_SOURCES,
	pathKey,
	ROOT_EXCLUSION,
	TRACKED_ENTRY_LIMIT,
	WORKSPACE_SCAN_LIMITS,
	type WorkspaceIdentity,
	type ResultManifest,
} from "../workspace";

/** Largest selected file a dispatched review receives inline (it cannot read the subject workspace). */
export const REVIEW_SUBJECT_MAX_BYTES = 192 * 1024; // leaves room for the template under the 256 KiB prompt limit
export { exportReviewDigest, heldResultTest };

export const VERIFIER_OWNER_BOUND_MS = 24 * 60 * 60_000;

export const liveVerifierOwners = new Set<string>();

export function validateTestEvidence(
	identity: WorkspaceIdentity,
	test: any,
): void {
	demand(
		test &&
			test.cwd === identity.path &&
			Array.isArray(test.argv) &&
			test.argv.length > 0 &&
			test.argv.every((s: any) => typeof s === "string") &&
			Number.isInteger(test.exit) &&
			test.exit >= 0 &&
			test.exit <= 255 &&
			typeof test.stdout === "string" &&
			typeof test.stderr === "string" &&
			sha256(test.stdout) === test.stdoutDigest &&
			sha256(test.stderr) === test.stderrDigest &&
			typeof test.startedAt === "string" &&
			typeof test.endedAt === "string" &&
			Number.isFinite(Date.parse(test.startedAt)) &&
			Number.isFinite(Date.parse(test.endedAt)),
		"TEST_EVIDENCE",
		"Invalid command evidence",
	);
}
type Exclusion = NonNullable<ResultManifest["exclusions"]>[number];
/**
 * Shape, bounded reason/source vocabulary, portable paths, order, uniqueness and
 * overlap. `ignored_out_of_tree` entries carry their deciding `source`; only they
 * may use the root marker `.` and only they may contain repository boundaries.
 */
const SHAPES: Record<string, string> = {
	nested_repository: "outerTrackedEntries,path,reason",
	gitlink: "outerTrackedEntries,path,reason",
	ignored_out_of_tree: "outerTrackedEntries,path,reason,source",
	unlisted: "count,outerTrackedEntries,path,reason",
};
/** `pathKey`, with the root marker kept. */
const exclusionKey = (path: string) => (path === ROOT_EXCLUSION ? ROOT_EXCLUSION : pathKey(path));
/** Whether `outer` is `inner` or one of its ancestors under `pathKey` (the root marker contains everything). */
const atOrAbove = (outer: string, inner: string) => outer === ROOT_EXCLUSION || inner === outer || (inner !== ROOT_EXCLUSION && inner.startsWith(outer + "/"));
/**
 * Shape, bounded reason/source vocabulary, portable paths, order, uniqueness and
 * overlap under `pathKey`. `ignored_out_of_tree` entries carry their deciding
 * `source`; `unlisted` entries carry a positive `count` of withheld names below
 * their path that cannot be listed and never withhold anything else. Only
 * `ignored_out_of_tree` (an aggregate) and `unlisted` may use the root marker
 * `.`. Permitted overlaps: a repository boundary inside an out-of-tree-ignored
 * entry, and any entry inside an `unlisted` one.
 */
function validateExclusions(exclusions: unknown): Exclusion[] {
	demand(Array.isArray(exclusions) && exclusions.length <= 1024, "RESULT_EXCLUSIONS", "Bounded exclusion list required");
	const accepted: { entry: Exclusion; key: string }[] = [];
	for (const entry of exclusions as any[]) {
		demand(
			entry && typeof entry === "object" &&
				typeof entry.reason === "string" && Object.hasOwn(SHAPES, entry.reason) &&
				Object.keys(entry).sort().join(",") === SHAPES[entry.reason] &&
				typeof entry.path === "string" &&
				(entry.reason !== "ignored_out_of_tree" || IGNORE_SOURCES.includes(entry.source)) &&
				(entry.reason !== "unlisted" || (Number.isSafeInteger(entry.count) && entry.count >= 1 && entry.count <= WORKSPACE_SCAN_LIMITS.maxEntries)) &&
				Number.isSafeInteger(entry.outerTrackedEntries) && entry.outerTrackedEntries >= 0 && entry.outerTrackedEntries <= TRACKED_ENTRY_LIMIT,
			"RESULT_EXCLUSIONS",
			"Invalid exclusion",
		);
		if (!(entry.path === ROOT_EXCLUSION && (entry.reason === "ignored_out_of_tree" || entry.reason === "unlisted"))) safeRelative(entry.path);
		demand(!accepted.length || accepted[accepted.length - 1]!.entry.path < entry.path, "RESULT_EXCLUSIONS", "Exclusions must be sorted and unique");
		const key = exclusionKey(entry.path);
		const permitted = (outer: Exclusion, inner: Exclusion) =>
			outer.reason === "unlisted" || (outer.reason === "ignored_out_of_tree" && (inner.reason === "nested_repository" || inner.reason === "gitlink"));
		demand(
			!accepted.some((other) =>
				other.key === key ||
				(atOrAbove(other.key, key) && !permitted(other.entry, entry)) ||
				(atOrAbove(key, other.key) && !permitted(entry, other.entry)),
			),
			"RESULT_EXCLUSIONS",
			"Overlapping exclusions",
		);
		accepted.push({ entry, key });
	}
	return accepted.map((item) => item.entry);
}
/** Ignored/junk summary: exact count, unlisted count, sorted unique portable paths, bounded list. */
function validateIgnored(ignored: unknown): string[] {
	const value = ignored as any;
	demand(
		value && typeof value === "object" && !Array.isArray(value) &&
			Object.keys(value).sort().join(",") === "count,paths,unlisted" &&
			Array.isArray(value.paths) && value.paths.length <= IGNORED_LIST_LIMIT &&
			Number.isSafeInteger(value.count) && Number.isSafeInteger(value.unlisted) && value.unlisted >= 0 &&
			(value.paths.length < IGNORED_LIST_LIMIT ? value.count === value.paths.length + value.unlisted : value.count >= value.paths.length + value.unlisted),
		"RESULT_IGNORED",
		"Bounded ignored-path summary required",
	);
	const paths: string[] = [];
	for (const path of value.paths) {
		demand(typeof path === "string" && (!paths.length || paths[paths.length - 1]! < path), "RESULT_IGNORED", "Ignored paths must be sorted and unique");
		safeRelative(path.endsWith("/") ? path.slice(0, -1) : path);
		paths.push(path);
	}
	return paths;
}
/**
 * Artifact schema a manifest was created under. `legacy-v1` manifests predate
 * exclusions/exportComplete/ignored/junk (all absent); `exclusions-v1` carries all four.
 */
export type ArtifactSchema = "legacy-v1" | "exclusions-v1";
export function artifactSchema(manifest: ResultManifest): ArtifactSchema {
	return manifest.exclusions === undefined && manifest.exportComplete === undefined ? "legacy-v1" : "exclusions-v1";
}
/**
 * The schema of a fresh collection: `exclusions-v1`, except for an identity prepared
 * without a collection snapshot (by a release before snapshots), whose rules were read
 * at collection from the worker-writable source root: the node reports it as
 * `legacy-v1`, completeness unknown, verified only after an operator accepts it.
 */
export function freshSchema(identity: WorkspaceIdentity): ArtifactSchema {
	return identity.collectionSnapshot === undefined ? "legacy-v1" : "exclusions-v1";
}
export function validateResult(
	identity: WorkspaceIdentity,
	value: any,
): asserts value is ResultManifest {
	demand(
		value?.schemaVersion === 1 &&
			canonicalJson(value.identity) === canonicalJson(identity),
		"RESULT_BINDING",
		"Result must own exact input, attempt and node",
	);
	demand(
		typeof value.patch === "string" &&
			sha256(value.patch) === value.patchDigest,
		"RESULT_DIGEST",
		"Patch digest mismatch",
	);
	demand(
		/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.outputHead),
		"RESULT_HEAD",
		"Exact output commit required",
	);
	demand(
		value.producer &&
			["platform", "arch", "bun"].every(
				(key) =>
					typeof value.producer[key] === "string" &&
					value.producer[key].length > 0,
			),
		"RESULT_PRODUCER",
		"Result reader runtime identity required",
	);
	demand(
		Array.isArray(value.files) &&
			value.files.length <= 1024 &&
			Array.isArray(value.tests),
		"RESULT_SCHEMA",
		"Bounded file and test lists required",
	);
	let total = 0;
	const exclusions = value.exclusions === undefined ? [] : value.exclusions;
	const exclusionEntries = validateExclusions(exclusions);
	demand(value.exclusions === undefined ? value.exportComplete === undefined : value.exportComplete === (exclusions.length === 0), "RESULT_COMPLETENESS", "Export completeness must match exclusions; legacy completeness is unknown");
	// exclusions-v1 always carries the ignored and junk summaries; legacy-v1 never does.
	demand(value.exclusions === undefined ? value.ignored === undefined && value.junk === undefined : value.ignored !== undefined && value.junk !== undefined, "RESULT_IGNORED", "Ignored-path summaries must match the artifact schema");
	const withheldPaths = value.ignored === undefined ? [] : [...validateIgnored(value.ignored), ...validateIgnored(value.junk)].map(pathKey);
	const exclusionKeys = exclusionEntries.map((entry) => ({ reason: entry.reason, key: pathKey(entry.path) }));
	const seen = new Set<string>();
	if (value.custody !== undefined) {
		const selection = value.custody;
		const paths = (() => {
			try { return validateSelectedOutputs(selection?.paths); }
			catch { return undefined; }
		})();
		demand(paths !== undefined && selection?.kind === "selected"
			&& canonicalJson(paths) === canonicalJson(selection.paths)
			&& selection.selectionDigest === sha256(canonicalJson(paths))
			&& canonicalJson(value.files.map((file: any) => file?.path)) === canonicalJson(paths)
			&& value.files.every((file: any) => !file?.deleted),
		"RESULT_BINDING", "Selected custody must contain exactly the requested regular files");
	}
	// A legacy-v1 manifest keeps the duplicate rule it was stored under (lower case only):
	// names distinct on disk that only `pathKey` equates stay valid (review fx-397df5a5 F5).
	const legacy = artifactSchema(value) === "legacy-v1";
	for (const file of value.files) {
		safeRelative(file.path);
		// Every comparison under `pathKey`: an alias spelling of a withheld path is that path.
		const key = pathKey(file.path);
		const unique = legacy ? file.path.toLowerCase() : key;
		demand(
			!excluded(file.path) && !seen.has(unique) &&
				// Nothing at or below a repository boundary; never the bytes of an out-of-tree-ignored path.
				!exclusionKeys.some((entry) =>
					entry.reason === "unlisted"
						? false
						: entry.reason === "ignored_out_of_tree"
							? file.deleted !== true && key === entry.key
							: key === entry.key || key.startsWith(entry.key + "/"),
				),
			"RESULT_PATH",
			"Excluded or duplicate result path",
		);
		// Ignored bytes are never exported; only a tracked deletion may be listed there.
		demand(file.deleted === true || !withheldPaths.some((path) => (path.endsWith("/") ? key.startsWith(path) : key === path)), "RESULT_PATH", "Ignored path exported");
		seen.add(unique);
		demand(
			typeof file.contentBase64 === "string" &&
				typeof file.deleted === "boolean" &&
				Number.isInteger(file.mode) &&
				file.mode >= 0 &&
				file.mode <= 0o777 &&
				file.type === (file.deleted ? "deleted" : "regular"),
			"RESULT_SCHEMA",
			"File bytes, mode and type required",
		);
		const bytes = Buffer.from(file.contentBase64, "base64");
		total += bytes.length;
		demand(
			bytes.toString("base64") === file.contentBase64 &&
				file.bytes === bytes.length &&
				sha256(bytes) === file.sha256 &&
				(!file.deleted || bytes.length === 0) &&
				bytes.length <= 4 * 1024 * 1024 &&
				total <= 16 * 1024 * 1024,
			"RESULT_DIGEST",
			"File bytes are incomplete or mismatched",
		);
	}
	for (const test of value.tests) validateTestEvidence(identity, test);
	demand(
		value.status ===
			(!value.tests.length
				? "not_run"
				: value.tests.every((t: any) => t.exit === 0)
					? "verified"
					: "tests_failed"),
		"RESULT_STATUS",
		"Result status must match real exits",
	);
}

export const transportCodes = new Set([
	"transport_exited",
	"stderr_limit",
	"stderr_failure",
	"rpc_error",
	"invalid_rpc_result",
	"invalid_transport_output",
	"invalid_public_sdk_response",
	"transport_closed",
	"too_many_requests",
	"transport_timeout",
	"transport_write_failed",
	"invalid_tools",
	"missing_tool_content",
	"non_json_tool_content",
	"tool_refused",
]);

export function transportCode(error: unknown, fallback: string): string {
	// A tool refusal carries its bounded reason as "tool_refused:<code>".
	// Collapsing that to the generic fallback hides the actual refusal.
	const code = error instanceof TransportError ? error.code : "";
	if (error instanceof NodeReplyError || ["node_timeout", "node_transport_failed", "node_output_limit"].includes(code)) return code;
	return transportCodes.has(code) || /^tool_refused:[a-zA-Z0-9_:.-]{1,128}$/.test(code)
		? code
		: fallback;
}

export function failureEvidence(
	error: unknown,
	context?: FailureContext,
): FailureContext | undefined {
	if (!context) return undefined;
	return {
		...context,
		errorType:
			error instanceof TransportError ? "transport_error" : "unclassified",
		...(error instanceof TransportError ? { certainty: error.certainty } : {}),
	};
}

/**
 * Versioned artifact digest. A manifest's own digest always uses the schema it
 * was created under; a fresh collection compared against a stored manifest is
 * projected to the stored manifest's schema, so a schema-only difference is
 * never reported as changed bytes. Legacy-v1 is exactly the pre-exclusion
 * artifact object; exclusions-v1 additionally covers exclusions/completeness.
 */
export function artifactDigest(manifest: ResultManifest, schema: ArtifactSchema = artifactSchema(manifest)): string {
	const { tests, status, producer, exclusions, exportComplete, ignored, junk, ...artifact } = manifest;
	return digest(schema === "legacy-v1" ? artifact : { ...artifact, exclusions, exportComplete, ignored, junk });
}
/**
 * What a fresh collection must reproduce of a stored manifest. A legacy-v1 manifest may come
 * from an earlier release whose collector derived `outputHead` (the workspace HEAD) and
 * `patch` (`git diff` against the base, worker commits included) differently from this one
 * (review fx-093cc54b F3): only what both collectors derive the same way is compared, the
 * identity and the exported files (bytes, modes, deletions).
 */
export function reproducedArtifact(manifest: ResultManifest, schema: ArtifactSchema): string {
	if (schema !== "legacy-v1") return artifactDigest(manifest, schema);
	return digest({ schemaVersion: manifest.schemaVersion, identity: manifest.identity, files: manifest.files } as unknown as Json);
}
/**
 * Review fx-6f923f88 F2: an earlier release's collector exported an untracked bare repository,
 * or a directory holding a `.git` entry that is not a repository, as ordinary files; this one
 * withholds it as a repository boundary. When every file of the fresh collection is exactly the
 * stored one and every stored file it lacks lies at or below one of its repository boundaries
 * (`nested_repository`/`gitlink`, never the root marker) and is exactly what the node read there
 * (`files`, the stored entry without its content; review fx-1091e277 F2), the boundaries holding
 * them (sorted, as observed). Anything else, including malformed boundaries or file evidence, is
 * an artifact change (`undefined`).
 */
export function legacyWithheld(cached: ResultManifest, fresh: ResultManifest, boundaries: unknown, files: unknown): Exclusion[] | undefined {
	if (boundaries === undefined || !Array.isArray(files)) return undefined;
	const read = new Map<string, string>();
	for (const entry of files) {
		if (!entry || typeof entry !== "object" || typeof (entry as { path?: unknown }).path !== "string" || read.has((entry as { path: string }).path)) return undefined;
		try {
			read.set((entry as { path: string }).path, canonicalJson(entry as Json));
		} catch {
			return undefined;
		}
	}
	let repositories: Exclusion[];
	try {
		repositories = validateExclusions(boundaries).filter((entry) => (entry.reason === "nested_repository" || entry.reason === "gitlink") && entry.path !== ROOT_EXCLUSION);
	} catch {
		return undefined;
	}
	const stored = new Map(cached.files.map((file) => [file.path, canonicalJson(file as unknown as Json)]));
	if (fresh.files.some((file) => stored.get(file.path) !== canonicalJson(file as unknown as Json))) return undefined;
	const present = new Set(fresh.files.map((file) => file.path));
	const used = new Set<Exclusion>();
	for (const file of cached.files) {
		if (present.has(file.path)) continue;
		const boundary = repositories.find((entry) => atOrAbove(pathKey(entry.path), pathKey(file.path)));
		if (!boundary) return undefined;
		const { contentBase64: _content, ...entry } = file;
		if (read.get(file.path) !== canonicalJson(entry as unknown as Json)) return undefined;
		used.add(boundary);
	}
	return used.size ? repositories.filter((entry) => used.has(entry)) : undefined;
}
export type ExportCompleteness =
	| { completeness: "complete"; exclusions: [] }
	| { completeness: "incomplete"; exclusions: Exclusion[] }
	| { completeness: "unknown"; exclusions: null };
/**
 * Completeness of an (already validated) result. Exclusions-v1 manifests state it
 * themselves. A legacy-v1 manifest is unknown unless a validated explicit
 * verification receipt recorded what a fresh collection observed.
 */
export function exportCompleteness(manifest: ResultManifest, operation?: OperationIntent): ExportCompleteness {
	if (artifactSchema(manifest) === "exclusions-v1")
		return manifest.exportComplete ? { completeness: "complete", exclusions: [] } : { completeness: "incomplete", exclusions: manifest.exclusions! };
	const observed = (operation?.receipt as any)?.observedExclusions;
	if (!Array.isArray(observed)) return { completeness: "unknown", exclusions: null };
	return observed.length ? { completeness: "incomplete", exclusions: observed } : { completeness: "complete", exclusions: [] };
}
/** What an operator reviews: the exact task attempt, effective result and exclusions. */
/**
 * Verification evidence in the exact shape every earlier release derives from the same
 * effective result and compares on each `result` read (rollback keeps `result ID`).
 */
export function verificationEvidence(result: ResultManifest): Json {
	return { manifestDigest: digest(result), testCount: result.tests.length, trust: "trusted node command evidence, not remote attestation" };
}
export function exportReviewSubject(task: TaskRecord, result: ResultManifest, state: ExportCompleteness) {
	return {
		taskId: task.id,
		attemptId: task.attemptId!,
		manifestDigest: digest(result),
		artifactSchema: artifactSchema(result),
		completeness: state.completeness,
		exclusions: state.exclusions,
	};
}
export function validateOperator(operator: unknown): asserts operator is string {
	demand(typeof operator === "string" && /^[A-Za-z0-9._@+-]{1,128}$/.test(operator), "INVALID_INPUT", "INVALID_INPUT: operator identity (1-128 of A-Z a-z 0-9 . _ @ + -) required");
}
/**
 * The result-test claim with its receipt. Passing commands over an export that is not complete
 * are never persisted in a shape an earlier release verifies on a read (review fx-093cc54b F1):
 * the explicit verification's receipt waits as the claim's `held`, bound by
 * `result.exportIncomplete.resultTestDigest` (the claim stays receipt-less, which every release
 * treats as "outcome unavailable, never rerun") until an operator accepts the export.
 */
export function effectiveOperation(task: TaskRecord, operation: OperationIntent | undefined): OperationIntent | undefined {
	const held = heldResultTest(task, operation);
	return held !== undefined ? { ...operation!, receipt: held } : operation;
}
/**
 * The stored result with its retained verifier evidence. Like the receipt above, a fresh
 * collection whose passing commands met an export that is not complete is stored `not_run`
 * without tests, its verifier receipt retained as `task.testReceipt` (an earlier release never
 * verifies that shape on a read); both are joined again here.
 */
export function withResultTest(task: TaskRecord, cached: ResultManifest, operation?: OperationIntent): ResultManifest {
	if (!operation?.receipt && cached.status === "not_run" && cached.tests.length === 0 && task.testReceipt !== undefined) {
		const test = task.testReceipt as any;
		validateTestEvidence(cached.identity, test);
		const result: ResultManifest = { ...cached, tests: [test], status: test.exit === 0 ? "verified" : "tests_failed" };
		validateResult(cached.identity, result);
		return result;
	}
	if (!operation?.receipt) return cached;
	const proof = operation.receipt as any;
	const test = proof.test;
	validateTestEvidence(cached.identity, test);
	demand(operation.taskId === task.id && operation.attemptId === task.attemptId && operation.kind === "result-test" && operation.id === operation.key && operation.digest === digest(operation.payload) && canonicalJson(operation.payload) === canonicalJson(resultTestBinding(task, test.argv)) && proof.manifestDigest === digest(cached) && proof.beforeDigest === artifactDigest(cached) && proof.afterDigest === proof.beforeDigest && cached.status === "not_run" && cached.tests.length === 0, "VERIFICATION_CONFLICT", "Retained artifact verification receipt binding mismatch");
	// Receipts recorded before observation fields existed carry neither field;
	// completeness then comes from the manifest alone (unknown for legacy-v1). `null`: the fresh
	// collection of a workspace without a collection snapshot observes no exclusions (unknown).
	if (proof.artifactSchema !== undefined || proof.observedExclusions !== undefined) {
		demand(proof.artifactSchema === artifactSchema(cached), "VERIFICATION_CONFLICT", "Receipt artifact schema must match the stored manifest");
		if (proof.observedExclusions === null)
			demand(proof.artifactSchema === "legacy-v1" && cached.identity.collectionSnapshot === undefined, "VERIFICATION_CONFLICT", "Only a workspace without a collection snapshot observes no exclusions");
		else try {
			validateExclusions(proof.observedExclusions);
		} catch {
			throw new FleetError("VERIFICATION_CONFLICT", "Receipt observed exclusions are malformed");
		}
		if (proof.observedExclusions !== null) demand(artifactSchema(cached) === "legacy-v1" || canonicalJson(proof.observedExclusions) === canonicalJson(cached.exclusions), "VERIFICATION_CONFLICT", "Receipt observed exclusions must match the manifest");
	}
	const result: ResultManifest = { ...cached, tests: [test], status: test.exit === 0 ? "verified" : "tests_failed" };
	validateResult(cached.identity, result);
	return result;
}

export function retainedResult(task: TaskRecord, testArgv: string[], resultTest?: OperationIntent, deferTerminalRelease = false): ResultManifest {
	demand(task.workspace && task.sessionId && task.turnId && task.result?.executionTerminal && (!task.held || deferTerminalRelease) && task.resultManifest, "RESULT_NOT_READY", "Durable settled result required");
	demand(!receiptlessUnverifiable(task.result), "RECEIPTLESS_UNVERIFIABLE", "Execution ended without a runtime receipt; never verified");
	const identity = task.workspace as unknown as WorkspaceIdentity;
	demand(identity.taskId === task.id && identity.attemptId === task.attemptId && identity.nodeId === task.nodeId && identity.inputDigest === task.inputDigest && identity.baseCommit === task.input.baseCommit, "WORKSPACE_BINDING", "Original workspace required");
	validateResult(identity, task.resultManifest);
	const manifest = withResultTest(task, task.resultManifest as unknown as ResultManifest, effectiveOperation(task, resultTest));
	demand(manifest.tests.some(test => canonicalJson(test.argv) === canonicalJson(testArgv)), "VERIFICATION_CONFLICT", "Cached result does not verify the newly requested command");
	return manifest;
}

export interface LateReceiptFacts {
	phase: TaskRecord["phase"];
	result?: { executionTerminal?: boolean; settlement?: { settledAt: string; lateObservationUntil: string }; lateReceipt?: unknown };
}

export function lateReceiptWatched(task: LateReceiptFacts, now: number): boolean {
	const settlement = task.result?.settlement;
	if (!(task.phase === "failed" && task.result?.executionTerminal && settlement && !task.result.lateReceipt))
		return false;
	const from = Date.parse(settlement.settledAt), until = Date.parse(settlement.lateObservationUntil);
	return Number.isFinite(from) && Number.isFinite(until) && from <= now && now <= until;
}

export function lateReceiptBinding(task: TaskRecord): LateReceiptBinding {
	const execution = (task.result?.evidence as any)?.execution;
	demand(
		task.sessionId && task.turnId && typeof execution?.commandId === "string" && typeof execution?.turnId === "string",
		"LATE_RECEIPT_BINDING",
		"Settled runtime command identity required",
	);
	return { sessionId: task.sessionId!, turnId: task.turnId!, runtimeCommandId: execution.commandId, runtimeTurnId: execution.turnId };
}

export function archiveDigest(task: TaskState): string {
	const { progress, ...rest } = task;
	return digest(rest);
}

/** Wall-clock bound for the read-only original-node session listing archive and dispose share. */
export const ARCHIVE_TIMEOUT = 15_000;

export const archiveObservations = new WeakMap<object, { store: FleetStore; taskDigest: string; evidence: any }>();

export function consumeArchiveObservation(token: object, store: FleetStore, task: TaskRecord): any {
	const observation = archiveObservations.get(token);
	archiveObservations.delete(token);
	demand(observation?.store === store && observation.taskDigest === archiveDigest(task), "ARCHIVE_AUTHORITY", "Trusted Fleet archive observation required");
	return observation.evidence;
}

export interface DisposeResult {
	taskId: string;
	outcome: "disposed" | "already_disposed" | "would_dispose";
	dryRun: boolean;
	/** archived once disposed; the current phase for a dry run. Never succeeded. */
	phase: TaskState["phase"];
	archivedFrom: TaskState["phase"];
	/** A disposition never releases a reservation; a held task is refused (DISPOSE_RESOURCE_UNPROVEN). */
	releasedReservation: false;
	verifiedByFleet: false;
	succeeded: false;
	/** The stored result is carried over byte-identical: never read, re-collected, rewritten, externalised or deleted. */
	resultUntouched: true;
	disposition: Omit<TaskDisposition, "at"> & { at?: string };
}

export type DisposeBatchItem = ({ ok: true } & DisposeResult) | { ok: false; taskId: string; outcome: "refused"; code: string; message: string };

export const DISPOSE_BATCH_LIMIT = 500;

export const batchKeys = new Set(["taskId", "as", "reason", "commit", "by", "subject", "verdict", "nodeRetired"]);

export function disposeBatchRequests(items: unknown): { taskId: string; request: DispositionRequest }[] {
	demand(Array.isArray(items) && items.length >= 1 && items.length <= DISPOSE_BATCH_LIMIT, "DISPOSE_INPUT", `Batch must be a JSON list of 1-${DISPOSE_BATCH_LIMIT} items`);
	const seen = new Set<string>();
	return items.map((item, index) => {
		try {
			demand(item !== null && typeof item === "object" && !Array.isArray(item) && Object.keys(item).every(key => batchKeys.has(key)), "DISPOSE_INPUT", "Item must be an object with only taskId, as, reason, commit, by, subject, verdict, nodeRetired");
			const { taskId, as, by, ...rest } = item as Record<string, unknown>;
			demand(typeof taskId === "string" && taskId.trim().length > 0 && taskId.length <= DISPOSITION_LIMITS.taskId, "DISPOSE_INPUT", "Item taskId required");
			demand(!seen.has(taskId), "DISPOSE_INPUT", "Task appears twice in the batch");
			seen.add(taskId);
			return { taskId, request: normaliseDisposition({ kind: as, ...rest, ...(by !== undefined ? { supersededBy: by } : {}) }) };
		} catch (error) {
			if (error instanceof FleetError) throw new FleetError(error.code, `batch item ${index}: ${error.message}`);
			throw error;
		}
	});
}

export function classifyReading(line: SessionReading): { reading: ProgressReading; diagnostic?: FailureDiagnostic } {
	const step: DiagnosticStep = { source: "Fleet.progress.read", phase: "validate" };
	if (line.status === "missing") return { reading: { ok: false }, diagnostic: conditionDiagnostic(step, "transcript_missing") };
	if (line.status === "ambiguous") return { reading: { ok: false }, diagnostic: conditionDiagnostic(step, "transcript_ambiguous") };
	if (line.status === "unreadable") return { reading: { ok: false }, diagnostic: conditionDiagnostic(step, "transcript_unreadable") };
	if (line.status !== "ok") return { reading: { ok: false }, diagnostic: conditionDiagnostic(step, "progress_reply_invalid") };
	const age = line.nodeNow - line.mtime;
	if (age < -PROGRESS_CLOCK_TOLERANCE_SECONDS)
		return { reading: { ok: false }, diagnostic: conditionDiagnostic(step, "progress_clock_inconsistent") };
	const { kind, stopReason, pendingToolsUnknown } = entryKind(line);
	return { reading: { ok: true, kind, ...(stopReason ? { stopReason } : {}), ...(pendingToolsUnknown ? { pendingToolsUnknown } : {}), idleSeconds: Math.max(0, age), writtenAt: line.mtime, nodeNow: line.nodeNow } };
}
