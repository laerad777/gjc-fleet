import { createHash } from "node:crypto";
import { SDK_UI_APPROVAL_CONTRACT } from "./approval";
import { validateSelectedOutputs } from "./workspace";
import { posix, win32 } from "node:path";
import type {
	Json,
	NodeConfig,
	NodeExclusion,
	Observation,
	Phase,
	Selection,
	TaskInput,
	TaskPlacement,
	TaskResult,
	TaskState,
	TaskSubject,
} from "./contracts";
import { type AdmissionContext, resourceReasons, unmeasuredTasks } from "./admission";

export class FleetError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FleetError";
	}
}
export function demand(
	condition: unknown,
	code: string,
	message: string,
): asserts condition {
	if (!condition) throw new FleetError(code, message);
}
export function object(
	value: unknown,
): asserts value is Record<string, unknown> {
	demand(
		value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null),
		"INVALID_INPUT",
		"Expected a plain object",
	);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
	demand(
		Object.keys(value).every((key) => allowed.includes(key)),
		"INVALID_INPUT",
		"Unexpected field",
	);
}
export function text(value: unknown): asserts value is string {
	demand(
		typeof value === "string" && value.trim().length > 0,
		"INVALID_INPUT",
		"Expected a nonempty string",
	);
}
function strings(value: unknown): asserts value is string[] {
	demand(Array.isArray(value), "INVALID_INPUT", "Expected an array");
	for (const item of value) text(item);
}
export function positiveCap(value: unknown): asserts value is number {
	demand(
		Number.isSafeInteger(value) && (value as number) > 0,
		"INVALID_INPUT",
		"Concurrency must be a positive safe integer",
	);
}
export function canonicalJson(value: unknown): string {
	const seen = new Set<object>();
	function encode(item: unknown): string {
		if (item === null || typeof item === "boolean" || typeof item === "string")
			return JSON.stringify(item);
		if (typeof item === "number") {
			demand(
				Number.isFinite(item),
				"INVALID_INPUT",
				"JSON numbers must be finite",
			);
			return JSON.stringify(item);
		}
		demand(
			typeof item === "object" && item !== null,
			"INVALID_INPUT",
			"Value is not JSON",
		);
		demand(!seen.has(item), "INVALID_INPUT", "Cyclic JSON");
		seen.add(item);
		let encoded: string;
		if (Array.isArray(item)) {
			demand(
				Object.keys(item).length === item.length,
				"INVALID_INPUT",
				"Sparse or extended arrays are not JSON",
			);
			encoded = `[${item.map(encode).join(",")}]`;
		} else {
			object(item);
			demand(
				Object.getOwnPropertySymbols(item).length === 0,
				"INVALID_INPUT",
				"Symbol fields are not JSON",
			);
			encoded = `{${Object.keys(item)
				.sort()
				.map((key) => {
					const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
					demand(
						"value" in descriptor,
						"INVALID_INPUT",
						"Accessors are not JSON",
					);
					return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
				})
				.join(",")}}`;
		}
		seen.delete(item);
		return encoded;
	}
	return encode(value);
}
export function digest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
/** Work-unit switch state (src/work-unit.ts), read by the caller in its own snapshot. */
export type WorkUnitSwitchState = "off" | "on" | "inconsistent";
/** The fixed report contract path of a role task (work-unit Step 1). */
export const ROLE_REPORT_PATH = "fleet-review/report.md";
/** The first line a review report must start with; the prompt of a review task must name it. */
export const REVIEW_VERDICT_PREFIX = "VERDICT:";
/** A branch name as a plain `refs/heads/` component list (a subset of git check-ref-format). */
export const REVIEW_BRANCH = /^(?![-.])(?!.*\.\.)(?!.*\/\/)(?!.*\/[-.])(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![/.])$/;
/**
 * `options.workUnits` defaults to "off": exactly the validation of code without work units (the key
 * `workUnit` is an unexpected field). Only with "on" is `workUnit` accepted: `{role: "report"}`, or
 * `{role: "review", subject: {taskId, branch}}` whose prompt also names the verdict line; never with an
 * input package (its files would be collected as the role task's own output). "inconsistent" refuses any
 * role input. Whether the subject is a Fleet commit is checked against the store by FleetStore.submit.
 */
/** Rendered reviewDispatch template limit; with a 192 KiB inline subject the child stays under the prompt limit. */
export const REVIEW_TEMPLATE_MAX_BYTES = 32 * 1024;
export function validateTaskInput(value: unknown, options: { workUnits?: WorkUnitSwitchState } = {}): asserts value is TaskInput {
	if ((options.workUnits === "on" || options.workUnits === "inconsistent") && value !== null && typeof value === "object" && Object.hasOwn(value, "workUnit")) {
		demand(Buffer.byteLength(canonicalJson(value)) <= 32 * 1024 * 1024, "INVALID_INPUT", "Task input exceeds total byte limit");
		object(value);
		demand(options.workUnits === "on", "WORK_UNIT_SWITCH_INCONSISTENT", "Work-unit switch is inconsistent (table without its single row or with an unexpected schema); role tasks are refused");
		demand(!Object.hasOwn(value, "subject"), "INVALID_INPUT", "A role task (workUnit) never carries a subject: a work-unit review names its commit in workUnit.subject");
		const { workUnit, ...rest } = value;
		validateTaskInput(rest);
		object(workUnit);
		demand(workUnit.role === "review" || workUnit.role === "report", "INVALID_INPUT", "workUnit.role must be review or report");
		demand(rest.inputPackage === undefined, "INVALID_INPUT", "A role task never carries an input package: its files would be collected as the role task's own output");
		demand((rest.prompt as string).includes(ROLE_REPORT_PATH), "ROLE_PROMPT_CONTRACT", `A role task's prompt must tell the agent to write its report to ${ROLE_REPORT_PATH} and change nothing else`);
		if (workUnit.role === "report") {
			keys(workUnit, ["role"]);
			return;
		}
		keys(workUnit, ["role", "subject"]);
		const subject = workUnit.subject;
		object(subject);
		keys(subject, ["taskId", "branch"]);
		demand(typeof subject.taskId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(subject.taskId), "INVALID_INPUT", "workUnit.subject.taskId must name the Fleet task whose commit is reviewed");
		demand(typeof subject.branch === "string" && REVIEW_BRANCH.test(subject.branch), "INVALID_INPUT", "workUnit.subject.branch must be a plain branch name");
		demand((rest.prompt as string).includes(REVIEW_VERDICT_PREFIX), "ROLE_PROMPT_CONTRACT", `A review task's prompt must tell the agent to start its report with "${REVIEW_VERDICT_PREFIX} CLEAN" or "${REVIEW_VERDICT_PREFIX} NOT CLEAN"`);
		return;
	}
	demand(
		Buffer.byteLength(canonicalJson(value)) <= 32 * 1024 * 1024,
		"INVALID_INPUT",
		"Task input exceeds total byte limit",
	);
	object(value);
	keys(value, [
		"schemaVersion",
		"key",
		"caller",
		"repoId",
		"baseCommit",
		"prompt",
		"required",
		"preferences",
		"approvalContract",
		"inputPackage",
		"subject",
		"autoCustody",
		"reviewDispatch",
	]);
	demand(
		value.schemaVersion === 1,
		"SCHEMA_VERSION",
		"Task schemaVersion must be 1",
	);
	for (const field of ["key", "caller", "repoId", "baseCommit", "prompt"])
		text(value[field]);
	demand(
		Buffer.byteLength(value.prompt as string) <= 256 * 1024 &&
			[value.key, value.caller, value.repoId].every(
				(field) => Buffer.byteLength(field as string) <= 256,
			),
		"INVALID_INPUT",
		"Task identity or prompt exceeds its byte limit",
	);
	demand(
		/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseCommit as string),
		"INVALID_INPUT",
		"baseCommit must be a full lowercase immutable commit hash",
	);
	object(value.required);
	keys(value.required, [
		"os",
		"arch",
		"model",
		"modelProfile",
		"nodeId",
		"operations",
	]);
	for (const field of ["os", "arch", "model", "modelProfile", "nodeId"])
		if (field in value.required) text(value.required[field]);
	if ("operations" in value.required) strings(value.required.operations);
	if ("preferences" in value) strings(value.preferences);
	if ("subject" in value) validateSubject(value.subject);
	if ("reviewDispatch" in value) {
		object(value.reviewDispatch);
		keys(value.reviewDispatch, ["path", "required", "promptTemplate", "childCustody"]);
		if ("childCustody" in value.reviewDispatch) {
			let paths: string[];
			try { paths = validateSelectedOutputs(value.reviewDispatch.childCustody); }
			catch { throw new FleetError("INVALID_INPUT", "Invalid reviewDispatch.childCustody exact output paths"); }
			demand(paths.length > 0 && canonicalJson(paths) === canonicalJson(value.reviewDispatch.childCustody), "INVALID_INPUT", "reviewDispatch.childCustody must be sorted canonical exact paths");
		}
		let paths: string[];
		try { paths = validateSelectedOutputs([value.reviewDispatch.path]); }
		catch { throw new FleetError("INVALID_INPUT", "reviewDispatch.path must be one normalized selected output path"); }
		demand(paths.length === 1 && paths[0] === value.reviewDispatch.path, "INVALID_INPUT", "reviewDispatch.path must be one normalized selected output path");
		object(value.reviewDispatch.required);
		keys(value.reviewDispatch.required, ["os", "arch", "model", "modelProfile", "nodeId", "operations"]);
		for (const field of ["os", "arch", "model", "modelProfile", "nodeId"])
			if (field in value.reviewDispatch.required) text(value.reviewDispatch.required[field]);
		if ("operations" in value.reviewDispatch.required) strings(value.reviewDispatch.required.operations);
		text(value.reviewDispatch.promptTemplate);
		demand((value.reviewDispatch.promptTemplate as string).includes("{path}"), "INVALID_INPUT", "reviewDispatch.promptTemplate must include {path}");
		// The child prompt is this rendered template plus the inline subject (at most 192 KiB) under the 256 KiB
		// prompt limit, so the rendered template is bounded here, at submission, not discovered after custody.
		demand(Buffer.byteLength((value.reviewDispatch.promptTemplate as string).replaceAll("{path}", value.reviewDispatch.path as string)) <= REVIEW_TEMPLATE_MAX_BYTES, "INVALID_INPUT", `reviewDispatch.promptTemplate rendered with its path must be at most ${REVIEW_TEMPLATE_MAX_BYTES} bytes`);
		const custody = (value as any).autoCustody?.paths;
		demand(Array.isArray(custody) && custody.includes(value.reviewDispatch.path), "INVALID_INPUT", "reviewDispatch.path must be one of autoCustody.paths");
		demand(!("workUnit" in value) && !("subject" in value), "INVALID_INPUT", "reviewDispatch cannot be combined with workUnit or subject");
	}
	if ("autoCustody" in value) {
		object(value.autoCustody);
		keys(value.autoCustody, ["paths"]);
		let paths: string[];
		try { paths = validateSelectedOutputs(value.autoCustody.paths); }
		catch { throw new FleetError("INVALID_INPUT", "Invalid autoCustody exact output paths"); }
		demand(canonicalJson(paths) === canonicalJson(value.autoCustody.paths), "INVALID_INPUT", "autoCustody paths must be sorted canonical exact paths");
	}
	if ("approvalContract" in value)
		demand(
			value.approvalContract === SDK_UI_APPROVAL_CONTRACT,
			"INVALID_INPUT",
			"Unknown approval contract",
		);
	if (value.inputPackage !== undefined) {
		object(value.inputPackage);
		object(value.inputPackage.authorization);
		demand(
			Array.isArray(value.inputPackage.changes) &&
				value.inputPackage.changes.length <= 1024 &&
				value.inputPackage.changes.every(
					(change) =>
						change !== null &&
						typeof change === "object" &&
						!Array.isArray(change) &&
						typeof change.path === "string",
				),
			"INVALID_INPUT",
			"Bounded input changes require explicit paths",
		);
		demand(
			value.inputPackage.schemaVersion === 1 &&
				value.inputPackage.repoId === value.repoId &&
				value.inputPackage.baseCommit === value.baseCommit &&
				typeof value.inputPackage.digest === "string" &&
				/^[a-f0-9]{64}$/.test(value.inputPackage.digest) &&
				value.inputPackage.authorization.digest === value.inputPackage.digest &&
				typeof value.inputPackage.authorization.reference === "string" &&
				value.inputPackage.authorization.reference.trim().length > 0,
			"INPUT_AUTHORIZATION",
			"Input package must match exact repository/base and explicit digest-bound authorization",
		);
	}
}
/** Byte bound of `subject.path` (a collected manifest path; PATH_MAX of the common hub/node OSs). */
export const SUBJECT_PATH_MAX_BYTES = 4096;
/**
 * Shape of `subject` (step 2): exact keys; taskId a Fleet task id; path a normalized relative POSIX path
 * as collection records it (no absolute or drive path, no backslash, no control character, no empty, `.`
 * or `..` segment); sha256 64 lowercase hex; otherNode a boolean. The store checks the subject task.
 */
function validateSubject(subject: unknown): asserts subject is TaskSubject {
	object(subject);
	keys(subject, ["taskId", "path", "sha256", "otherNode"]);
	demand(typeof subject.taskId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(subject.taskId), "INVALID_INPUT", "subject.taskId must name the Fleet task whose stored result is reviewed");
	const path = subject.path;
	demand(
		typeof path === "string" &&
			path.length > 0 &&
			Buffer.byteLength(path) <= SUBJECT_PATH_MAX_BYTES &&
			path.isWellFormed() &&
			!path.startsWith("/") &&
			!/^[A-Za-z]:/.test(path) &&
			!path.includes("\\") &&
			!/[\x00-\x1f\x7f]/.test(path) &&
			path.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
		"INVALID_INPUT",
		`subject.path must be a normalized relative path of at most ${SUBJECT_PATH_MAX_BYTES} bytes without traversal`,
	);
	demand(typeof subject.sha256 === "string" && /^[a-f0-9]{64}$/.test(subject.sha256), "INVALID_INPUT", "subject.sha256 must be 64 lowercase hex characters");
	if ("otherNode" in subject) demand(typeof subject.otherNode === "boolean", "INVALID_INPUT", "subject.otherNode must be a boolean");
}
/**
 * The node a task with `subject.otherNode: true` must not be placed on: the subject task's node, read from
 * `tasks` (a task's node never changes once reserved, and a collected subject always has one).
 */
export function subjectNodeId(input: TaskInput, tasks: readonly Pick<TaskState, "id" | "nodeId">[]): string | undefined {
	if (input.subject?.otherNode !== true) return undefined;
	const id = input.subject.taskId;
	return tasks.find((task) => task.id === id)?.nodeId;
}
/** Bounds of a node's configured per-call Coordinator transport timeout (`transport.timeoutMs`). */
export const NODE_RPC_TIMEOUT_MIN_MS = 5_000;
export const NODE_RPC_TIMEOUT_MAX_MS = 600_000;
/**
 * Per-call default when `transport.timeoutMs` is absent. POSIX nodes keep the historical 30 s (measured
 * max 6.3 s). Windows nodes answer a prompt in 17.7-20.1 s on average, up to 29.5 s, and 6 of 47 sends hit
 * 30 s while delivered; 120 s is 4x the old limit and the longest observed answer, and the same ceiling
 * the node helper (`oneShot`) already uses.
 */
export const DEFAULT_NODE_RPC_TIMEOUT_MS = { posix: 30_000, win32: 120_000 } as const;
function rpcTimeout(value: unknown): asserts value is number {
	demand(
		Number.isSafeInteger(value) &&
			(value as number) >= NODE_RPC_TIMEOUT_MIN_MS &&
			(value as number) <= NODE_RPC_TIMEOUT_MAX_MS,
		"INVALID_INPUT",
		`transport.timeoutMs must be an integer from ${NODE_RPC_TIMEOUT_MIN_MS} to ${NODE_RPC_TIMEOUT_MAX_MS} ms`,
	);
}
/** Effective per-call limit of a node's Coordinator transport: the configured value, else the OS default. */
export function nodeRpcTimeoutMs(node: Pick<NodeConfig, "os" | "transport">): number {
	const configured = node.transport.timeoutMs;
	if (configured !== undefined) {
		rpcTimeout(configured);
		return configured;
	}
	return node.os === "win32" ? DEFAULT_NODE_RPC_TIMEOUT_MS.win32 : DEFAULT_NODE_RPC_TIMEOUT_MS.posix;
}
/**
 * Floor of the per-call limit of the read-only observation calls (Coordinator read_turn, list_questions).
 * A read of a RUNNING turn on a Windows node takes 37-53 s (earlier samples 28-62 s) because the
 * Coordinator reconciles its whole session roster; 180 s is about 3x the longest sample. POSIX keeps 30 s.
 */
export const NODE_OBSERVATION_TIMEOUT_FLOOR_MS = { posix: 30_000, win32: 180_000 } as const;
/**
 * Per-call limit of a node's observation reads: never shorter than the node's effective transport limit
 * (nodeRpcTimeoutMs, so `transport.timeoutMs` raises it too) and never below the OS floor. No own setting.
 */
export function nodeObservationTimeoutMs(node: Pick<NodeConfig, "os" | "transport">): number {
	return Math.max(nodeRpcTimeoutMs(node), node.os === "win32" ? NODE_OBSERVATION_TIMEOUT_FLOOR_MS.win32 : NODE_OBSERVATION_TIMEOUT_FLOOR_MS.posix);
}
export function validateNode(value: unknown): asserts value is NodeConfig {
	canonicalJson(value);
	object(value);
	keys(value, [
		"id",
		"os",
		"arch",
		"roots",
		"collectionRules",
		"workspaceRoot",
		"maxConcurrency",
		"enabled",
		"draining",
		"reachable",
		"sdkReady",
		"modelReady",
		"models",
		"modelProfiles",
		"transport",
		"workspaceTransport",
		"sdkTransport",
		"operations",
	]);
	for (const field of ["id", "os", "arch", "workspaceRoot"]) text(value[field]);
	demand(
		/^[a-zA-Z0-9_-]{1,128}$/.test(value.id as string),
		"INVALID_INPUT",
		"Node id must be a stable safe identifier",
	);
	const absolute = (path: unknown) => {
		text(path);
		demand(
			posix.isAbsolute(path) || win32.isAbsolute(path),
			"INVALID_INPUT",
			"Repository and workspace paths must be absolute",
		);
	};
	absolute(value.workspaceRoot);
	object(value.roots);
	for (const [repo, path] of Object.entries(value.roots)) {
		text(repo);
		absolute(path);
	}
	if (value.collectionRules !== undefined) {
		object(value.collectionRules);
		for (const [repo, rules] of Object.entries(value.collectionRules as Record<string, any>))
			demand(
				Object.hasOwn(value.roots, repo) &&
					rules !== null && typeof rules === "object" && !Array.isArray(rules) &&
					Object.keys(rules).sort().join(",") === "config,excludes_file,info_exclude" &&
					rules.config !== null && typeof rules.config === "object" && !Array.isArray(rules.config) &&
					Object.values(rules.config).every((entry) => typeof entry === "string") &&
					typeof rules.info_exclude === "string" && typeof rules.excludes_file === "string",
				"INVALID_INPUT",
				"Collection rules of an allowlisted root are {config, info_exclude, excludes_file}",
			);
	}
	if (value.maxConcurrency !== undefined) positiveCap(value.maxConcurrency);
	for (const field of [
		"enabled",
		"draining",
		"reachable",
		"sdkReady",
		"modelReady",
	])
		demand(
			typeof value[field] === "boolean",
			"INVALID_INPUT",
			`Expected boolean ${field}`,
		);
	strings(value.models);
	if (value.modelProfiles !== undefined) strings(value.modelProfiles);
	strings(value.operations);
	object(value.transport);
	keys(value.transport, ["command", "args", "timeoutMs"]);
	text(value.transport.command);
	demand(
		Array.isArray(value.transport.args) &&
			value.transport.args.every((arg) => typeof arg === "string"),
		"INVALID_INPUT",
		"Transport args must be strings",
	);
	if (value.transport.timeoutMs !== undefined) rpcTimeout(value.transport.timeoutMs);
	for (const key of ["workspaceTransport", "sdkTransport"])
		if (value[key] !== undefined) {
			const transport = value[key];
			object(transport);
			keys(transport, ["command", "args"]);
			text(transport.command);
			demand(
				Array.isArray(transport.args) &&
					transport.args.every((arg) => typeof arg === "string"),
				"INVALID_INPUT",
				"Optional transport args must be strings",
			);
		}
}
export const observationPhases: readonly Phase[] = [
	"preparing",
	"dispatching",
	"active",
	"approval_required",
	"blocked_unknown",
	"cancel_unknown",
	"completed_unverified",
	"succeeded",
	"failed",
	"cancelled",
];
export function observationDigest(
	value: Omit<Observation, "eventId" | "digest">,
): string {
	return digest(value);
}
export function nonemptyEvidence(value: unknown): void {
	canonicalJson(value);
	demand(
		(typeof value === "string" && value.trim().length > 0) ||
			(typeof value === "object" &&
				value !== null &&
				Object.keys(value).length > 0),
		"INVALID_EVIDENCE",
		"Evidence must be nonempty structured data or text",
	);
}
export function validateObservation(
	value: unknown,
): asserts value is Observation {
	canonicalJson(value);
	object(value);
	keys(value, [
		"eventId",
		"digest",
		"sessionId",
		"turnId",
		"status",
		"terminal",
		"evidence",
		"settlement",
	]);
	text(value.eventId);
	text(value.sessionId);
	text(value.digest);
	if ("turnId" in value) text(value.turnId);
	demand(
		observationPhases.includes(value.status as Phase),
		"INVALID_INPUT",
		"Unknown observation status",
	);
	demand(
		typeof value.terminal === "boolean" && "evidence" in value,
		"INVALID_INPUT",
		"Observation requires terminal and evidence",
	);
	const { eventId: _id, digest: supplied, ...body } = value;
	demand(
		supplied === digest(body),
		"DIGEST_MISMATCH",
		"Observation digest does not match its canonical content",
	);
	demand(
		!["succeeded", "failed", "cancelled"].includes(value.status as string) ||
			value.terminal,
		"INVALID_INPUT",
		"Terminal status requires an authoritative terminal receipt",
	);
	demand(
		!value.terminal ||
			["succeeded", "failed", "cancelled", "completed_unverified"].includes(
				value.status as string,
			),
		"INVALID_INPUT",
		"Terminal receipt requires a terminal execution status",
	);
	if (value.terminal) nonemptyEvidence(value.evidence);
	if ("settlement" in value) {
		// A receipt-less settlement is only ever a terminal failure, never success.
		const settlement = value.settlement as Record<string, unknown>;
		object(settlement);
		keys(settlement, ["kind", "receiptState", "cause", "settledAt", "lateObservationUntil"]);
		const at = (field: unknown) =>
			typeof field === "string" && Number.isFinite(Date.parse(field));
		demand(
			value.terminal === true &&
				value.status === "failed" &&
				["failed_without_receipt", "ended_without_receipt"].includes(
					settlement.kind as string,
				) &&
				["missing", "absent"].includes(settlement.receiptState as string) &&
				typeof settlement.cause === "string" &&
				settlement.cause.trim().length > 0 &&
				at(settlement.settledAt) &&
				at(settlement.lateObservationUntil) &&
				Date.parse(settlement.lateObservationUntil as string) >=
					Date.parse(settlement.settledAt as string),
			"INVALID_INPUT",
			"Receipt-less settlement must be a terminal failure with its cause",
		);
	}
}
/**
 * The CURRENT execution outcome of a task, derived from its state. Receipts rows and `result.status` are
 * point-in-time records of the observation that produced them (frozen once terminal; verification and
 * archiving never append or rewrite one), so no reader may present them as current state on their own.
 * null: never observed; unsettled: no terminal proof (any last observation is history only).
 */
export function executionOutcome(task: { result?: TaskResult }): string | null {
	const result = task.result;
	if (!result) return null;
	if (!result.executionTerminal) return "unsettled";
	if (result.verified) return "verified";
	return result.status;
}
/**
 * A receipt-less settlement is never verified or collected for verification, unless
 * an operator explicitly accepted a genuine late terminal_ok receipt for the same turn.
 */
export function receiptlessUnverifiable(result: TaskResult | undefined): boolean {
	return Boolean(result?.settlement && !result.lateReceipt?.acceptance);
}
/**
 * Passing commands over an incomplete export that no operator has accepted yet: the task
 * is `completed_unverified` and is never verified or succeeded until that acceptance.
 */
export function exportReviewPending(result: TaskResult | undefined): boolean {
	return Boolean(result?.exportIncomplete && !result.exportIncomplete.acceptance);
}
export function selectNode(
	input: TaskInput,
	nodes: NodeConfig[],
	tasks: readonly TaskState[],
	admission?: AdmissionContext,
	/** subjectNodeId(input, ...): excluded with reason `subject_node`. */
	subjectNode?: string,
): Selection {
	// No slot limits: a node's new work is bounded only by measured resource headroom.
	// Without an admission context (in-process callers and tests) only the hard filters apply.
	const held = tasks.filter((task) => task.held);
	const exclusions: Selection["exclusions"] = [];
	const eligible: { node: NodeConfig; load: number; preference: number }[] = [];
	for (const node of nodes) {
		const reasons: string[] = [];
		if (!node.enabled) reasons.push("disabled");
		if (node.draining) reasons.push("draining");
		if (!node.reachable) reasons.push("unreachable");
		if (!node.sdkReady) reasons.push("sdk_not_ready");
		if (!node.modelReady) reasons.push("model_not_ready");
		if (!Object.hasOwn(node.roots, input.repoId))
			reasons.push("repo_unavailable");
		if (input.required.os && input.required.os !== node.os)
			reasons.push("os_mismatch");
		if (input.required.arch && input.required.arch !== node.arch)
			reasons.push("arch_mismatch");
		if (input.required.model && !node.models.includes(input.required.model))
			reasons.push("model_unavailable");
		if (
			input.required.modelProfile &&
			!node.modelProfiles?.includes(input.required.modelProfile)
		)
			reasons.push("model_profile_unavailable");
		if (input.required.nodeId && input.required.nodeId !== node.id)
			reasons.push("manual_node_mismatch");
		if (subjectNode !== undefined && node.id === subjectNode) reasons.push("subject_node");
		for (const operation of input.required.operations ?? [])
			if (!node.operations.includes(operation))
				reasons.push(`operation_unavailable:${operation}`);
		const load = held.filter((task) => task.nodeId === node.id).length;
		if (admission)
			reasons.push(
				...resourceReasons(
					node.workspaceRoot,
					admission.samples.get(node.id),
					unmeasuredTasks(admission.held.get(node.id), admission.samples.get(node.id)?.at),
					admission.now,
					admission.policy,
				),
			);
		if (reasons.length) exclusions.push({ nodeId: node.id, reasons });
		else {
			const index = input.preferences?.indexOf(node.id) ?? -1;
			eligible.push({
				node,
				load,
				preference: index === -1 ? Number.MAX_SAFE_INTEGER : index,
			});
		}
	}
	eligible.sort(
		(a, b) =>
			a.preference - b.preference ||
			a.load - b.load ||
			(a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
	);
	return {
		...(eligible[0] ? { nodeId: eligible[0].node.id } : {}),
		exclusions,
	};
}
/**
 * THE classification of every node exclusion reason (selectNode, admission.ts resourceReasons, the
 * node-health gate and the legacy capacity reasons of older audit rows). structural: only an operator
 * configuration change (node registry, task pin/requirements) clears it; transient: it can clear by
 * itself (measurement, load, health, readiness, invocation). Not listed: transient, so a new or unknown
 * reason never declares a task unplaceable. test/queue-unplaceable.test.ts drives every producer and fails
 * when a reason it emits is missing here.
 */
export const PLACEMENT_REASON_CLASSES: Readonly<Record<string, "transient" | "structural">> = {
	// selectNode hard filters (registry and task requirements).
	disabled: "structural",
	repo_unavailable: "structural",
	os_mismatch: "structural",
	arch_mismatch: "structural",
	model_unavailable: "structural",
	model_profile_unavailable: "structural",
	manual_node_mismatch: "structural",
	draining: "transient",
	unreachable: "transient",
	sdk_not_ready: "transient",
	model_not_ready: "transient",
	// admission.ts measured headroom.
	resources_unknown: "transient",
	resources_stale: "transient",
	cpu_busy: "transient",
	memory_low: "transient",
	workspace_disk_unknown: "transient",
	disk_low: "transient",
	// Legacy slot reasons (older audit rows only).
	node_capacity: "transient",
	global_capacity: "transient",
	// Node-health gate (node_unstable plus the failing dimensions of node-health.ts).
	node_unstable: "transient",
	no_history: "transient",
	consecutive_observations: "transient",
	decision_probe_required: "transient",
	node_health_unavailable: "transient",
	reachable: "transient",
	brokerSessionListOk: "transient",
	resourceSampleOk: "transient",
	// Placement preflight check codes (as "<stage>:<code>[+<code>]" with the node-health switch on).
	probe_platform_mismatch: "structural",
	repo_or_base_unavailable: "transient",
	workspace_unavailable: "transient",
	workspace_transport_unverified: "transient",
	// Depends on the invocation's --local-node-id, not only on configuration.
	workspace_transport_required: "transient",
	coordinator_unavailable: "transient",
	coordinator_tools_missing: "transient",
	hard_ineligible_probe_skipped: "transient",
	probe_deferred_node_busy: "transient",
};
/** Parameterised reasons: `<prefix><name>`. */
export const PLACEMENT_REASON_PREFIXES: Readonly<Record<string, "transient" | "structural">> = {
	"operation_unavailable:": "structural",
	"unobserved:": "transient",
};
/** Preflight check stages: an excluded node's reason is `<stage>:<code>` with codes joined by `+`. */
export const PREFLIGHT_STAGES = ["eligibility", "source", "workspace", "coordinator", "model", "resources"] as const;
export function reasonClass(reason: string): "transient" | "structural" {
	if (Object.hasOwn(PLACEMENT_REASON_CLASSES, reason)) return PLACEMENT_REASON_CLASSES[reason]!;
	for (const [prefix, kind] of Object.entries(PLACEMENT_REASON_PREFIXES))
		if (reason.startsWith(prefix) && reason.length > prefix.length) return kind;
	const colon = reason.indexOf(":");
	if (colon > 0 && (PREFLIGHT_STAGES as readonly string[]).includes(reason.slice(0, colon)))
		return reason.slice(colon + 1).split("+").some((code) => code !== "" && reasonClass(code) === "structural") ? "structural" : "transient";
	return "transient";
}
/** Bounds of a TaskPlacement record. */
export const PLACEMENT_BLOCKING_LIMIT = 8;
export const PLACEMENT_REASONS_LIMIT = 8;
const PLACEMENT_TEXT_LIMIT = 160;
function byText(a: string, b: string) {
	return a < b ? -1 : a > b ? 1 : 0;
}
/** The structural part of one reason: the reason itself, a preflight composite reduced to its structural codes, or undefined. */
function structuralPart(reason: string): string | undefined {
	if (reasonClass(reason) !== "structural") return undefined;
	const colon = reason.indexOf(":");
	if (colon <= 0 || !(PREFLIGHT_STAGES as readonly string[]).includes(reason.slice(0, colon))) return reason;
	return `${reason.slice(0, colon + 1)}${reason.slice(colon + 1).split("+").filter((code) => code !== "" && reasonClass(code) === "structural").sort(byText).join("+")}`;
}
/**
 * The reasons of one node that decide the verdict: a structurally excluded node only by its structural
 * reasons (its load, measurement or health cannot change the verdict), any other node by all of them.
 */
function decidingReasons(reasons: readonly string[]): string[] {
	const structural = [...new Set(reasons.map(structuralPart).filter((reason): reason is string => reason !== undefined))].sort(byText);
	return structural.length ? structural : [...reasons];
}
/**
 * The verdict of a selection that found no node. A pinned task is unplaceable when its pinned node is
 * structurally excluded, whatever the other nodes say; otherwise the task is unplaceable only when at
 * least one node was excluded and every excluded node has a structural reason. No exclusion at all (an
 * empty registry) is waiting.
 */
export function placementVerdict(input: TaskInput, exclusions: readonly NodeExclusion[]): Omit<TaskPlacement, "since" | "checkedAt" | "rejections"> {
	const merged = new Map<string, Set<string>>();
	for (const row of exclusions) {
		const reasons = merged.get(row.nodeId) ?? new Set<string>();
		for (const reason of row.reasons) reasons.add(reason);
		merged.set(row.nodeId, reasons);
	}
	const rows = [...merged].map(([nodeId, reasons]) => {
		const sorted = [...reasons].sort(byText);
		return { nodeId, reasons: sorted, structural: sorted.filter((reason) => reasonClass(reason) === "structural").length };
	});
	const pinned = input.required.nodeId;
	const pin = pinned === undefined ? undefined : rows.find((row) => row.nodeId === pinned);
	const unplaceable = pin ? pin.structural > 0 : rows.length > 0 && rows.every((row) => row.structural > 0);
	rows.sort((a, b) =>
		Number(b.nodeId === pinned) - Number(a.nodeId === pinned) || a.structural - b.structural || a.reasons.length - b.reasons.length || byText(a.nodeId, b.nodeId));
	return {
		verdict: unplaceable ? "unplaceable" : "waiting",
		// Keyed on what decides the verdict only, so a transient flip on a structurally excluded node is a repeat.
		exclusionsDigest: digest([unplaceable ? "unplaceable" : "waiting", pinned ?? null, [...rows].sort((a, b) => byText(a.nodeId, b.nodeId)).map((row) => [row.nodeId, decidingReasons(row.reasons)])]),
		nodes: rows.length,
		blocking: rows.slice(0, PLACEMENT_BLOCKING_LIMIT).map((row) => ({
			nodeId: row.nodeId.slice(0, PLACEMENT_TEXT_LIMIT),
			reasons: row.reasons.slice(0, PLACEMENT_REASONS_LIMIT).map((reason) => reason.slice(0, PLACEMENT_TEXT_LIMIT)),
		})),
	};
}
/**
 * The placement record after one more rejection. The same verdict-deciding reasons (exclusionsDigest) keep
 * `since` and count the rejection (`repeat`: the caller appends no selection audit row) while `blocking`
 * shows the latest full reasons; changed deciding reasons start a new record.
 */
export function placementRecord(previous: TaskPlacement | undefined, input: TaskInput, exclusions: readonly NodeExclusion[], at: string): { placement: TaskPlacement; repeat: boolean } {
	const next = placementVerdict(input, exclusions);
	if (
		previous &&
		previous.exclusionsDigest === next.exclusionsDigest &&
		Number.isSafeInteger(previous.rejections) &&
		previous.rejections >= 1 &&
		typeof previous.since === "string"
	)
		return { placement: { ...next, since: previous.since, checkedAt: at, rejections: Math.min(previous.rejections + 1, Number.MAX_SAFE_INTEGER) }, repeat: true };
	return { placement: { ...next, since: at, checkedAt: at, rejections: 1 }, repeat: false };
}
/** The record is shown only while the task is a never-admitted queued task (an older tree may leave a stale one). */
export function shownPlacement(task: Pick<TaskState, "phase" | "attemptId" | "placement">): TaskPlacement | undefined {
	return task.phase === "queued" && !task.attemptId && task.placement && Array.isArray(task.placement.blocking) ? task.placement : undefined;
}
/** One exclusion reason of one node in operator words (never the prompt). */
export function reasonWords(nodeId: string, reason: string, input: TaskInput): string {
	const required = input.required;
	const words: Record<string, string> = {
		repo_unavailable: `${nodeId} does not serve repository ${input.repoId}`,
		manual_node_mismatch: `task is pinned to ${required.nodeId ?? "another node"}, not ${nodeId}`,
		disabled: `${nodeId} is disabled`,
		draining: `${nodeId} is draining`,
		unreachable: `${nodeId} is registered unreachable`,
		sdk_not_ready: `${nodeId} SDK is registered not ready`,
		model_not_ready: `${nodeId} model is registered not ready`,
		os_mismatch: `${nodeId} does not run the required OS ${required.os ?? ""}`.trimEnd(),
		arch_mismatch: `${nodeId} does not have the required architecture ${required.arch ?? ""}`.trimEnd(),
		model_unavailable: `${nodeId} does not offer model ${required.model ?? ""}`.trimEnd(),
		model_profile_unavailable: `${nodeId} does not offer model profile ${required.modelProfile ?? ""}`.trimEnd(),
		resources_unknown: `${nodeId} has no resource measurement`,
		resources_stale: `${nodeId} resource measurement is stale`,
		cpu_busy: `${nodeId} CPU is busy`,
		memory_low: `${nodeId} has too little free memory`,
		disk_low: `${nodeId} has too little free workspace disk`,
		workspace_disk_unknown: `${nodeId} workspace disk is not measured`,
		node_unstable: `${nodeId} is not stable (node health)`,
	};
	if (Object.hasOwn(words, reason)) return words[reason]!;
	if (reason.startsWith("operation_unavailable:")) return `${nodeId} does not offer operation ${reason.slice("operation_unavailable:".length)}`;
	return `${nodeId}: ${reason}`;
}
/**
 * The record in operator words: the verdict and the blocking reasons of the pinned/closest node (only
 * its structural reasons when unplaceable).
 */
export function placementSummary(input: TaskInput, placement: TaskPlacement): string {
	const closest = placement.blocking[0];
	if (!closest) return placement.verdict === "unplaceable" ? "unplaceable" : "waiting for capacity";
	const reasons = placement.verdict === "unplaceable" ? closest.reasons.filter((reason) => reasonClass(reason) === "structural") : closest.reasons;
	const more = placement.nodes > 1 && input.required.nodeId === undefined ? ` (and ${placement.nodes - 1} other node${placement.nodes > 2 ? "s" : ""})` : "";
	const detail = reasons.map((reason) => reasonWords(closest.nodeId, reason, input)).join("; ") + more;
	return placement.verdict === "unplaceable"
		? `unplaceable: ${detail}; only an operator change clears this (fix the node or task, or queue withdraw)`
		: `waiting for capacity: ${detail}`;
}
/** The shown record with its operator-words summary (tasks, show, queue reconsider, dashboard); undefined when not shown. */
export function placementView(task: Pick<TaskState, "phase" | "attemptId" | "placement" | "input">): (TaskPlacement & { summary: string }) | undefined {
	const placement = shownPlacement(task);
	return placement ? { ...placement, summary: placementSummary(task.input, placement) } : undefined;
}
/**
 * Queue reconsider candidates: never-admitted queued tasks in queue order, at most `limit`. Unplaceable
 * tasks never take the slots of waiting ones: waiting tasks fill up to limit-1 slots (all `limit` when no
 * task is unplaceable), and the rest re-checks unplaceable tasks least recently checked first, so each of
 * them still recovers on its own once the operator fixes its cause. `skipped` names the tasks the pass would
 * skip without a reservation attempt (their checkedAt never advances): they are never re-checked, so they
 * cannot hold the re-check slots. Limit 1 with both kinds: the waiting task, so LIMIT 1 never re-checks an
 * unplaceable task while any waiting task exists.
 */
export function reconsiderCandidates<T extends TaskState>(states: readonly T[], limit: number, skipped: (task: T) => boolean = () => false): T[] {
	const queued = states.filter((task) => task.phase === "queued" && !task.attemptId && !task.sessionId && !task.held);
	const unplaceable = queued.filter((task) => shownPlacement(task)?.verdict === "unplaceable");
	if (!unplaceable.length) return queued.slice(0, limit);
	const waiting = queued.filter((task) => shownPlacement(task)?.verdict !== "unplaceable");
	const recheckable = unplaceable.filter((task) => !skipped(task));
	const waitingSlots = Math.min(waiting.length, limit > 1 && recheckable.length ? limit - 1 : limit);
	const checkedAt = (task: T) => {
		const at = Date.parse(task.placement!.checkedAt);
		return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
	};
	const recheck = recheckable
		.map((task, index) => ({ task, index }))
		.sort((a, b) => checkedAt(a.task) - checkedAt(b.task) || a.index - b.index)
		.slice(0, limit - waitingSlots)
		.map(({ task }) => task);
	const chosen = new Set([...waiting.slice(0, waitingSlots), ...recheck]);
	return queued.filter((task) => chosen.has(task));
}
/**
 * The node fields a send of THIS task to its admission snapshot actually uses: its own repository
 * root only, and the SDK transport only when the snapshot has one (start never uses another).
 */
function sendRoute(node: NodeConfig, repoId: string, withSdkTransport: boolean) {
	return {
		id: node.id,
		os: node.os,
		arch: node.arch,
		root: Object.hasOwn(node.roots, repoId) ? node.roots[repoId] : null,
		workspaceRoot: node.workspaceRoot,
		transport: node.transport,
		workspaceTransport: node.workspaceTransport ?? null,
		sdkTransport: withSdkTransport ? (node.sdkTransport ?? null) : null,
	};
}
/**
 * Why the admitted node may not receive new work of this task NOW ([] = admissible). Fleet sends to
 * the task's admission snapshot, so the CURRENT registry entry must still be hard-eligible for this
 * task (enabled, not draining, reachable, ready, repository, platform, model, operations, manual pin)
 * and must still describe the same route. Resource headroom is not re-measured: the reservation
 * already charges it.
 */
export function sendRefusals(
	input: TaskInput,
	snapshot: NodeConfig | undefined,
	current: NodeConfig | undefined,
): string[] {
	if (!snapshot) return ["not_admitted"];
	if (!current) return ["not_registered"];
	const reasons = [
		...(selectNode(input, [current], []).exclusions[0]?.reasons ?? []),
	];
	const withSdk = snapshot.sdkTransport !== undefined;
	if (
		canonicalJson(sendRoute(current, input.repoId, withSdk)) !==
		canonicalJson(sendRoute(snapshot, input.repoId, withSdk))
	)
		reasons.push("route_changed");
	return reasons;
}
