import { resolve, join } from "node:path";
import { constants as fsConstants } from "node:fs";
import { mkdir, realpath, lstat, open as openFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { TransportError } from "./rpc";
import { applyInput, importRepository, validateInputPackage } from "./inputs";
import { validateNode, canonicalJson, demand, object, REVIEW_BRANCH } from "./core";
import type { NodeConfig } from "./contracts";
import { spawnTrusted } from "./spawn";
import {
	checkPreparation,
	materializeWorkspace,
	collectResult,
	validateSelectedOutputs,
	EXPORT_COMPLETENESS,
	gitProgram,
	legacyManifest,
	outputHeadCreated,
	testWorkspace,
	readOwnedFile,
	withheldFiles,
	type WorkspaceIdentity,
} from "./workspace";

const details = {
	unsafe_path: "unsafe_entry",
	nested_repository: "git_entry",
	identity_mismatch: "identity",
	root_denied: "allowlist",
	workspace_missing: "workspace",
	output_limit: "bytes",
	timeout: "deadline",
	git_failed: "git_exit",
	// Reserved for a future win32 path-budget refusal; must stay a typed pair so
	// it is never swallowed as internal/exception. Not thrown by prepare yet.
	workspace_path_too_long: "path_budget",
	invalid_request: "request",
	internal: "exception",
	// The operation ran (or may have run); building or encoding its reply failed afterwards.
	executed_reply_failed: "reply",
} as const;
/**
 * Synthesized by the caller for an older helper's bare `{"ok":false,"error":"node_operation_refused"}`
 * (or the forwarding helper's `placement_operation_refused`). It proves only that the helper
 * process was reached and answered with its generic failure envelope. It does NOT prove that
 * nothing ran: older helpers used one catch-all for failures before and after an operation
 * began. Its certainty is therefore always `unknown`; it is never retained as a re-evaluable
 * refusal and never permits redispatch. No helper ever emits this category itself.
 */
const legacyReply = {
	ok: false,
	error: "refused",
	detail: "legacy_unspecified",
	certainty: "unknown",
} as const;
type Refusal =
	| {
			ok: false;
			error: keyof typeof details;
			detail: string;
			certainty: "before_send" | "unknown";
			correlationId?: string;
	  }
	| typeof legacyReply;
/** Per-operation fact: set once any step that may have an effect has begun. Never cleared. */
export type OperationProgress = { executed: boolean };
export async function nodeFailure(
	error: unknown,
	certainty: "before_send" | "unknown",
): Promise<Refusal> {
	if (error instanceof NodeReplyError) return error.reply;
	// Only an explicit before_send is a refusal; anything else is conservatively unknown.
	const reply = classify(
		error,
		certainty === "before_send" ? "before_send" : "unknown",
	);
	return logged(reply);
}
/**
 * Local correlation log next to the helper.
 * Soft 1 MiB cap: in-process writers are serialized; cross-process writers may briefly
 * exceed by about one line because a process-shared lock would strand after SIGKILL.
 */
export const NODE_ERROR_LOG_MAX_BYTES = 1 * 1024 * 1024;

/** Serialize in-process appends only (no durable lockfile). */
let nodeErrorLogChain: Promise<unknown> = Promise.resolve();

function withNodeErrorLogLock<T>(fn: () => Promise<T>): Promise<T> {
	const run = nodeErrorLogChain.then(fn, fn);
	nodeErrorLogChain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** True when this platform can open without following symlinks. */
export const nodeErrorLogSupportsNoFollow = (fsConstants.O_NOFOLLOW ?? 0) !== 0;

/** Test hooks: afterLstat (symlink race), beforeWrite (delayed create overwrite). */
export const nodeErrorLogTestHooks: {
	afterLstat?: () => void | Promise<void>;
	beforeWrite?: () => void | Promise<void>;
} = {};

/** Exported for regression tests (size race + hardlink). Production callers use `logged` only. */
export async function appendNodeErrorLog(line: string): Promise<void> {
	await withNodeErrorLogLock(async () => {
		const path = join(import.meta.dir, ".node-errors.log");
		const noFollow = fsConstants.O_NOFOLLOW ?? 0;
		// Without O_NOFOLLOW an intervening symlink can be followed; refuse file logging (stderr fallback).
		if (noFollow === 0) throw new Error("unsafe_node_error_log");
		const bytes = Buffer.byteLength(line);
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error?.code === "ENOENT") return null;
			throw error;
		});
		if (existing) {
			if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)
				throw new Error("unsafe_node_error_log");
			if (existing.size + bytes > NODE_ERROR_LOG_MAX_BYTES) throw new Error("node_error_log_full");
		}
		await nodeErrorLogTestHooks.afterLstat?.();
		// Always O_APPEND (including O_EXCL create) so a delayed first write cannot clobber a peer.
		// Missing path: O_EXCL so a raced symlink cannot be followed into create.
		const flags = existing
			? fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow
			: fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_APPEND | noFollow;
		const handle = await openFile(path, flags, 0o600);
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.nlink !== 1) throw new Error("unsafe_node_error_log");
			if (existing && (opened.ino !== existing.ino || opened.dev !== existing.dev))
				throw new Error("unsafe_node_error_log");
			// Soft cap: re-check size after open; concurrent helpers may still overshoot by one line.
			if (opened.size + bytes > NODE_ERROR_LOG_MAX_BYTES) throw new Error("node_error_log_full");
			await nodeErrorLogTestHooks.beforeWrite?.();
			await handle.write(line);
		} finally {
			await handle.close();
		}
	});
}

async function logged(reply: Refusal): Promise<Refusal> {
	if ("correlationId" in reply && reply.correlationId) {
		const line =
			JSON.stringify({
				correlationId: reply.correlationId,
				error: reply.error,
			}) + "\n";
		try {
			await appendNodeErrorLog(line);
		} catch {
			console.error(line.trimEnd());
		}
	}
	return reply;
}
/**
 * Run one helper request and produce its complete reply line, classifying by what actually
 * happened: once `progress.executed` is set, no failure (including building or encoding the
 * success reply) can be reported as a `before_send` refusal.
 */
export async function answer(
	progress: OperationProgress,
	body: () => Promise<string>,
): Promise<{ line: string; exitCode: 0 | 1 }> {
	try {
		return { line: await body(), exitCode: 0 };
	} catch (error) {
		let reply: Refusal;
		if (error instanceof NodeReplyError) reply = error.reply;
		else if (progress.executed)
			reply = await logged({
				ok: false,
				error: "executed_reply_failed",
				detail: details.executed_reply_failed,
				certainty: "unknown",
				correlationId: randomUUID(),
			});
		else reply = await nodeFailure(error, "before_send");
		if (progress.executed && reply.certainty === "before_send")
			reply = { ...reply, certainty: "unknown" } as Refusal;
		return { line: JSON.stringify(reply), exitCode: 1 };
	}
}
export class NodeReplyError extends TransportError {
	constructor(public readonly reply: Refusal) {
		// Code prefix states certainty: node_refused = proven before_send, node_failed = unknown.
		super(
			`node_${reply.certainty === "before_send" ? "refused" : "failed"}:${reply.error}:${reply.detail}${"correlationId" in reply && reply.correlationId ? ":" + reply.correlationId : ""}`,
			reply.certainty,
			undefined,
			reply,
		);
	}
}
function classify(
	error: any,
	certainty: "before_send" | "unknown",
): Refusal {
	const message = error instanceof Error ? error.message : "";
	const code = error?.code;
	let category: keyof typeof details = "internal";
	if (message === "nested_repository") category = "nested_repository";
	else if (
		code === "ROOT_DENIED" ||
		["repository_root_required", "checkout_filters_not_authorized"].includes(
			message,
		)
	)
		category = "root_denied";
	else if (
		code === "IDENTITY_MISMATCH" ||
		code === "NODE_PLATFORM_MISMATCH" ||
		[
			"workspace_identity_mismatch",
			"collection_snapshot_mismatch",
			"source_repository_missing",
			"base_commit_mismatch",
			"review_branch_mismatch",
			"prepared_head_mismatch",
		].includes(message)
	)
		category = "identity_mismatch";
	else if (message === "workspace_missing") category = "workspace_missing";
	else if (
		[
			"command_output_limit",
			"node_request_limit",
			"artifact_count_limit",
			"artifact_total_limit",
			"workspace_scan_limit",
			"exclusion_count_limit",
			"tracked_entry_limit",
			"command_line_limit",
		].includes(message)
	)
		category = "output_limit";
	else if (message === "git_failed" || message.startsWith("git_failed:"))
		category = "git_failed";
	else if (
		message === "workspace_path_too_long" ||
		message.startsWith("workspace_path_too_long:")
	)
		category = "workspace_path_too_long";
	else if (
		code === "INVALID_INPUT" ||
		error instanceof SyntaxError ||
		[
			"invalid_argv",
			"invalid_identity",
			"exact_commit_required",
			"input_digest_required",
			"input_package_digest_required",
			"unsupported_node_operation",
			// Operator configuration the node cannot collect under (fix the node, then retry).
			"ignore_rules_unresolved",
			"ignore_rules_inside_workspace",
			"collection_config_unsupported",
			"git_common_dir_missing",
			"invalid_worktree_basename",
			"unsupported_node_os",
		].includes(message) ||
		message.startsWith("unresolved_path_root:")
	)
		category = "invalid_request";
	else if (
		/^(unsafe_relative_path|unsafe_artifact|unsafe_artifact_path|unsafe_artifact_root|unsafe_artifact_parent|artifact_unavailable_or_unsafe|unsafe_windows_root|unsafe_windows_artifact|root_symlink|repository_symlink_forbidden|workspace_root_symlink_forbidden|reserved_identity_path|role_base_has_review_dir|case_collision)$/.test(
			message,
		) ||
		message === "workspace_scan_unreadable" ||
		/^(excluded_input|excluded_result|unsupported_tree_entry|unsafe_result_entry):/.test(message)
	)
		category = "unsafe_path";
	return {
		ok: false,
		error: category,
		detail: details[category],
		certainty,
		...(category === "internal" ? { correlationId: randomUUID() } : {}),
	};
}
/**
 * The only pre-effect check of test/collect on the workspace itself: it must still be the real
 * directory preparation created. Its contents are the task's own business; collect applies its
 * own exclusions to what it actually reads, exactly as before this check existed.
 */
async function requireWorkspaceDirectory(root: string): Promise<void> {
	try {
		if (
			!(await lstat(root)).isDirectory() ||
			(await realpath(root)) !== resolve(root)
		)
			throw new Error("root_symlink");
	} catch (error: any) {
		if (error?.code === "ENOENT") throw new Error("workspace_missing");
		throw error;
	}
}

/** One request, one response, then exit. This is a filesystem adapter, not an agent or service. */
export async function nodeOperation(
	node: NodeConfig,
	request: any,
	progress: OperationProgress = { executed: false },
): Promise<unknown> {
	try {
		return await operate(node, request, () => {
			progress.executed = true;
		});
	} catch (error) {
		throw new NodeReplyError(
			await nodeFailure(error, progress.executed ? "unknown" : "before_send"),
		);
	}
}
/** The only successful reply of the side-effect-free `preflight` action. */
export const PREFLIGHT_PASSED = { preflight: "passed" } as const;
async function operate(
	node: NodeConfig,
	request: any,
	started: () => void,
): Promise<unknown> {
	validateNode(node);
	demand(
		node.os === process.platform && node.arch === process.arch,
		"NODE_PLATFORM_MISMATCH",
		"Configured node platform does not match this helper process",
	);
	(object as (v: unknown) => void)(request);
	if (!["prepare", "preflight", "test", "collect", "provenance"].includes(request.action))
		throw new Error("unsupported_node_operation");
	// `preflight` runs exactly the checks `prepare` runs before its first effect, then stops.
	// It never calls started(): every outcome it reports is a proven before_send fact.
	const preflight = request.action === "preflight";
	if (request.action === "prepare" || preflight) {
		const p = request.input;
		(object as (v: unknown) => void)(p);
		demand(
			Object.keys(p).every((k) =>
				[
					"taskId",
					"attemptId",
					"nodeId",
					"inputDigest",
					"repoId",
					"baseCommit",
					"inputPackage",
					"reviewDirAbsent",
					"reviewBranch",
				].includes(k),
			),
			"INVALID_INPUT",
			"Unexpected preparation field",
		);
		demand(p.reviewDirAbsent === undefined || p.reviewDirAbsent === true, "INVALID_INPUT", "Unexpected preparation field");
		demand(p.reviewBranch === undefined || (p.reviewDirAbsent === true && typeof p.reviewBranch === "string" && REVIEW_BRANCH.test(p.reviewBranch)), "INVALID_INPUT", "Unexpected preparation field");
		demand(
			p.nodeId === node.id &&
				typeof p.repoId === "string" &&
				Object.hasOwn(node.roots, p.repoId),
			"ROOT_DENIED",
			"Repository not allowlisted",
		);
		for (const id of [p.taskId, p.attemptId])
			demand(
				typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
				"INVALID_INPUT",
				"Safe task and attempt identifiers required",
			);
		let repo = node.roots[p.repoId]!;
		const pkg = p.inputPackage;
		if (pkg !== undefined) {
			validateInputPackage(pkg);
			demand(
				pkg.repoId === p.repoId &&
					pkg.baseCommit === p.baseCommit &&
					pkg.authorization?.digest === pkg.digest,
				"INPUT_AUTHORIZATION",
				"Exact authorized input package required",
			);
			if (pkg.objects) {
				// A Git program inside the workspace root is refused before any effect, never run.
				gitProgram([node.workspaceRoot]);
				if (preflight) return PREFLIGHT_PASSED;
				started();
				await mkdir(node.workspaceRoot, { recursive: true, mode: 0o700 });
				demand(
					(await realpath(node.workspaceRoot)) === resolve(node.workspaceRoot),
					"ROOT_DENIED",
					"Canonical workspace root required",
				);
				const inputRoot = join(node.workspaceRoot, ".inputs");
				await mkdir(inputRoot, { recursive: true, mode: 0o700 });
				demand(
					(await realpath(inputRoot)) === resolve(inputRoot),
					"ROOT_DENIED",
					"Canonical input repository root required",
				);
				repo = await importRepository(
					join(inputRoot, String(p.taskId) + "-" + String(p.attemptId)),
					pkg,
					[node.workspaceRoot],
				);
			}
		}
		// The operator's collection rules of the root (node configuration), never the hub's or a
		// worker's. An imported input repository is the node's own and takes its own.
		const rules = repo === node.roots[p.repoId] ? node.collectionRules?.[p.repoId] : undefined;
		const preparation = {
			...p,
			repo,
			...(pkg ? { inputPackageDigest: pkg.digest } : {}),
			workspaceRoot: node.workspaceRoot,
			...(rules !== undefined ? { collectionRules: rules } : {}),
		} as any;
		// Exactly the checks prepare makes before its first effect: request, repository
		// configuration and the committed tree. The working tree of the source root is never read.
		const checked = await checkPreparation(preparation);
		if (preflight) return PREFLIGHT_PASSED;
		started();
		const identity = await materializeWorkspace(checked);
		if (pkg) await applyInput(identity, pkg);
		return identity;
	}
	const identity = request.identity as WorkspaceIdentity;
	demand(
		identity && identity.schemaVersion === 1 && identity.nodeId === node.id,
		"IDENTITY_MISMATCH",
		"Exact node identity required",
	);
	for (const id of [identity.taskId, identity.attemptId])
		demand(
			typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id),
			"INVALID_INPUT",
			"Invalid task identity",
		);
	demand(
		identity.path ===
			join(node.workspaceRoot, identity.taskId + "-" + identity.attemptId) &&
			(Object.values(node.roots).some(
				(root) => resolve(root) === identity.repo,
			) ||
				(/^[a-f0-9]{64}$/.test(identity.inputPackageDigest ?? "") &&
					identity.repo ===
						join(
							node.workspaceRoot,
							".inputs",
							identity.taskId + "-" + identity.attemptId,
						))),
		"ROOT_DENIED",
		"Workspace not bound to allowlisted root",
	);
	await requireWorkspaceDirectory(identity.path);
	const marker = JSON.parse(
		(await readOwnedFile(identity.path, ".fleet-identity.json")).toString(),
	);
	if (canonicalJson(marker) !== canonicalJson(identity))
		throw new Error("workspace_identity_mismatch");
	if (request.action === "test")
		demand(
			Array.isArray(request.argv) &&
				request.argv.length > 0 &&
				request.argv.every(
					(arg: unknown) => typeof arg === "string" && !arg.includes("\0"),
				),
			"INVALID_INPUT",
			"Invalid argv",
		);
	if (request.action === "collect")
		demand(
			request.tests === undefined || Array.isArray(request.tests),
			"INVALID_INPUT",
			"Invalid tests",
		);
	if (request.action === "collect")
		demand(
			request.exportCompleteness === undefined || request.exportCompleteness === EXPORT_COMPLETENESS,
			"INVALID_INPUT",
			"Unsupported export completeness schema",
		);
	if (request.action === "collect")
		demand(
			request.observeBoundaries === undefined ||
				(Array.isArray(request.observeBoundaries) && request.observeBoundaries.length <= 1024 && request.observeBoundaries.every((path: unknown) => typeof path === "string")),
			"INVALID_INPUT",
			"Invalid observeBoundaries",
		);
	if (request.action === "collect") {
		const selectedOutputs = request.selectedOutputs === undefined ? undefined : (() => {
			try { return validateSelectedOutputs(request.selectedOutputs); }
			catch { return undefined; }
		})();
		demand(request.selectedOutputs === undefined || selectedOutputs !== undefined, "INVALID_INPUT", "Invalid selectedOutputs");
		started();
		// A hub that does not declare it reads export completeness is a release before it.
		const result = await collectResult(
			identity,
			request.tests ?? [],
			selectedOutputs ?? (request.exportCompleteness === EXPORT_COMPLETENESS),
		);
		// A hub verifying a stored legacy-v1 manifest names its stored paths and asks which boundaries
		// withheld content (review fx-6f923f88 F2) and what the workspace holds at the stored paths they
		// withhold (review fx-1091e277 F2); both stay outside the manifest and every digest.
		const observed = request.observeBoundaries === undefined ? undefined : await withheldFiles(identity.path, result, request.observeBoundaries);
		if (identity.collectionSnapshot !== undefined) return observed ? { ...result, withheldFiles: observed } : result;
		return observed ? { ...legacyManifest(result), withheldBoundaries: result.exclusions, withheldFiles: observed } : legacyManifest(result);
	}
	if (request.action === "test") {
		started();
		return await testWorkspace(identity, request.argv);
	}
	// Work-unit review evidence, read only and outside every result manifest: deny by default.
	if (request.action === "provenance")
		return { created: await outputHeadCreated(identity, request.head) };
	throw new Error("unsupported_node_operation");
}
const correlated = new Set<string>(["internal", "executed_reply_failed"]);
function typedReply(result: any): boolean {
	return (
		result !== null &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		result.ok === false &&
		typeof result.error === "string" &&
		Object.hasOwn(details, result.error) &&
		result.detail === details[result.error as keyof typeof details] &&
		["before_send", "unknown"].includes(result.certainty) &&
		// A reply-encoding failure happens after execution by definition.
		(result.error !== "executed_reply_failed" || result.certainty === "unknown") &&
		Object.keys(result).every((k) =>
			["ok", "error", "detail", "certainty", "correlationId"].includes(k),
		) &&
		(correlated.has(result.error)
			? typeof result.correlationId === "string" &&
				/^[a-f0-9-]{36}$/.test(result.correlationId)
			: result.correlationId === undefined)
	);
}
function legacyAnswer(result: any): boolean {
	return (
		result !== null &&
		typeof result === "object" &&
		!Array.isArray(result) &&
		Object.keys(result).length === 2 &&
		result.ok === false &&
		(result.error === "node_operation_refused" ||
			result.error === "placement_operation_refused")
	);
}
/**
 * Best-effort termination of the helper and every descendant. POSIX helpers run in their own
 * process group (see oneShot); Windows uses taskkill's tree walk before the root is killed.
 * Never awaited: a deadline must not depend on how long cleanup takes.
 */
function killTree(child: ReturnType<typeof Bun.spawn>): void {
	if (process.platform === "win32") {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			const killer = spawnTrusted(
				[
					join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					"/PID",
					String(child.pid),
					"/T",
					"/F",
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			// taskkill /F already force-ends the tree; still SIGKILL the Bun handle so a
			// trapped/stale root cannot outlive the deadline (matches POSIX killTree).
			killer.exited.finally(() => child.kill("SIGKILL")).catch(() => {});
		} catch {
			child.kill("SIGKILL");
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
	child.kill("SIGKILL");
}
export async function oneShot(
	command: string,
	args: string[],
	request: unknown,
	timeoutMs = 120000,
): Promise<any> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = spawnTrusted([command, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			// Own process group on POSIX so a deadline can kill descendants holding our pipes.
			detached: process.platform !== "win32",
		});
	} catch {
		throw new TransportError("node_transport_failed", "before_send");
	}
	const readers = [
		(child.stdout as ReadableStream<Uint8Array>).getReader(),
		(child.stderr as ReadableStream<Uint8Array>).getReader(),
	];
	let timer: ReturnType<typeof setTimeout> | undefined;
	// The deadline rejects independently of stream EOF or process exit.
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new TransportError("node_timeout", "unknown")),
			timeoutMs,
		);
	});
	let completed = false;
	async function bounded(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		limit: number,
	) {
		let total = 0;
		const parts: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit)
				throw new TransportError("node_output_limit", "unknown");
			parts.push(value);
		}
		return Buffer.concat(parts).toString();
	}
	try {
		const [stdout, , exit] = await Promise.race([
			(async () => {
				(child.stdin as any).write(JSON.stringify(request));
				(child.stdin as any).end();
				return Promise.all([
					bounded(readers[0]! as unknown as ReadableStreamDefaultReader<Uint8Array>, 32 * 1024 * 1024),
					bounded(readers[1]! as unknown as ReadableStreamDefaultReader<Uint8Array>, 1024 * 1024),
					child.exited,
				]);
			})(),
			deadline,
		]);
		let result: any;
		try {
			result = JSON.parse(stdout);
		} catch {
			throw new TransportError("node_transport_failed", "unknown");
		}
		if (exit === 1 && typedReply(result)) throw new NodeReplyError(result);
		// An older helper answered with its only failure envelope: answered, cause and
		// effects unproven. Distinct from a transport failure; never a before_send refusal.
		if (exit === 1 && legacyAnswer(result))
			throw new NodeReplyError({ ...legacyReply });
		if (
			exit !== 0 ||
			result?.ok !== true ||
			!Object.hasOwn(result, "value") ||
			Object.keys(result).length !== 2
		)
			throw new TransportError("node_transport_failed", "unknown");
		completed = true;
		return result.value;
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw new TransportError("node_transport_failed", "unknown");
	} finally {
		clearTimeout(timer);
		if (!completed) killTree(child);
		// Destroy our pipe ends; never wait for a descendant to close them.
		for (const reader of readers) reader.cancel().catch(() => {});
	}
}
// Bun bundles use the output file’s import.meta.main even for an inlined module.
// The build disables this launcher only when bundling the other entrypoints.
declare const __GJC_FLEET_SKIP_EMBEDDED_NODE_ENTRY__: boolean | undefined;
if (import.meta.main && (typeof __GJC_FLEET_SKIP_EMBEDDED_NODE_ENTRY__ === "undefined" || !__GJC_FLEET_SKIP_EMBEDDED_NODE_ENTRY__)) {
	const progress: OperationProgress = { executed: false };
	const { line, exitCode } = await answer(progress, async () => {
		const config = process.argv[2];
		if (!config) throw new Error("node_config_required");
		const node = await Bun.file(resolve(config)).json();
		let size = 0;
		const chunks: Uint8Array[] = [];
		for await (const part of Bun.stdin.stream()) {
			size += part.length;
			if (size > 32 * 1024 * 1024) throw new Error("node_request_limit");
			chunks.push(part);
		}
		const request = JSON.parse(Buffer.concat(chunks).toString());
		const value = await nodeOperation(node, request, progress);
		// Encoding stays inside the certainty boundary: after execution it can only be unknown.
		return canonicalJson({ ok: true, value });
	});
	console.log(line);
	process.exitCode = exitCode;
}
