import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { NodeConfig, TaskInput, TaskRecord, TaskState, Selection } from "./contracts";
import type { AdmissionContext, ResourceSample, AdmissionPolicy } from "./admission";
import { digest, FleetError, selectNode, subjectNodeId, validateNode, validateTaskInput, type WorkUnitSwitchState } from "./core";
import { inputOptions, type WorkUnitAccess } from "./work-unit";
import { nodeOperation, answer, oneShot, type OperationProgress } from "./node";
import { validateInputPackage } from "./inputs";
import { nodeRpc, type StdioRpc } from "./rpc";
import {
	projectPreparationPaths,
	runGit,
	type PreparationPathProjection,
} from "./workspace";
import type { NodeHealthAccess } from "./node-health-gate";

export interface ReadinessCheck {
	ok: boolean;
	code: string;
	action: string;
}
/**
 * Placement-side projection of preparation admin/checkout paths from a probed
 * Git common dir. Pure observation for readiness design: does not refuse on
 * path length (budget cliff unproven). Call after `rev-parse --git-common-dir`.
 *
 * - `repoRoot` / `workspaceRoot` must be syntactically resolved absolute roots
 *   (`path === resolve(path)`). This is not `realpath`; symlink policy stays
 *   with the placement probe / preparation checks.
 * - Relative `commonDir` is interpreted against `repoRoot`, not cwd.
 * - `os` must be `win32` | `linux` | `darwin`; anything else throws
 *   `unsupported_node_os` (no silent fallback to linux).
 */
export function projectNodePreparationPaths(input: {
	repoRoot: string;
	commonDir: string;
	workspaceRoot: string;
	taskId: string;
	attemptId: string;
	os: NodeConfig["os"];
}): PreparationPathProjection {
	return projectPreparationPaths({
		repoRoot: input.repoRoot,
		commonDir: input.commonDir,
		workspaceRoot: input.workspaceRoot,
		taskId: input.taskId,
		attemptId: input.attemptId,
		platform: input.os,
	});
}
export interface NodeReadiness {
	nodeId: string;
	/** Prerequisites only: neither checkout, provider authentication nor execution success. */
	ready: boolean;
	executionProven: false;
	checks: {
		eligibility: ReadinessCheck;
		source: ReadinessCheck;
		workspace: ReadinessCheck;
		coordinator: ReadinessCheck;
		model: ReadinessCheck;
		resources: ReadinessCheck;
	};
}
export interface PlacementReport {
	inputDigest: string;
	nodeDigests: Record<string, string>;
	checkedAt: number;
	nodes: NodeReadiness[];
	selection: Selection;
}
export interface PreflightOptions {
	/** Used only when the node-health switch stored in the fleet DB is on (see node-health-gate.ts). */
	nodeHealth?: NodeHealthAccess;
	/** Explicit identity, NOT inferred from matching OS/arch (another Mac is not local). */
	localNodeId?: string;
	timeoutMs?: number;
	/**
	 * Runs one node's remote readiness probes (Coordinator catalog, then workspace probe: one at a time) as ONE
	 * call slot, e.g. the daemon's per-node gate. Rejecting with FleetError NODE_BUSY means "not probed now":
	 * that node is not ready in this report (probe_deferred_node_busy). Any other rejection propagates.
	 * Default: probe directly (both probes overlap).
	 */
	nodeCall?: <T>(nodeId: string, probe: () => Promise<T>) => Promise<T>;
	/** Work-unit switch state read by the caller (src/work-unit.ts inputOptions); default off. */
	workUnits?: WorkUnitSwitchState;
}
const pass = (code: string): ReadinessCheck => ({ ok: true, code, action: "none" });
const fail = (code: string, action: string): ReadinessCheck => ({ ok: false, code, action });
const tools = [
	"gjc_coordinator_start_session",
	"gjc_coordinator_send_prompt",
	"gjc_coordinator_read_turn",
	"gjc_coordinator_list_questions",
];

interface ReadinessInput {
	repoId: string;
	baseCommit: string;
	packageDigest?: string;
	packageSummary?: { changedFiles: number; objectCount: number; authorizedObjectsAvailable: boolean };
}

/** Validate content and authorization on the hub; only this non-content summary leaves it. */
function readinessInput(input: TaskInput): ReadinessInput {
	const pkg = input.inputPackage;
	if (!pkg) return { repoId: input.repoId, baseCommit: input.baseCommit };
	validateInputPackage(pkg);
	if (pkg.repoId !== input.repoId || pkg.baseCommit !== input.baseCommit || pkg.authorization?.digest !== pkg.digest) throw new Error("source_authorization_required");
	return { repoId: input.repoId, baseCommit: input.baseCommit, packageDigest: pkg.digest, packageSummary: { changedFiles: pkg.changes.length, objectCount: pkg.objects?.length ?? 0, authorizedObjectsAvailable: pkg.objects !== undefined } };
}

/** Read-only filesystem probe, executed ON the target host, never against hub paths for a remote node. */
export async function probePlacementSource(node: NodeConfig, input: ReadinessInput) {
	validateNode(node);
	let source = fail("repo_unavailable", "Provision the allowlisted repository with the exact base commit on this host.");
	let workspace = fail("workspace_unavailable", "Provide a canonical writable workspace directory or writable canonical ancestor on this host.");
	if (node.os !== process.platform || node.arch !== process.arch) {
		const mismatch = fail("probe_platform_mismatch", "Run the workspace helper on the configured target host, not on the hub.");
		return { source: mismatch, workspace: mismatch };
	}
	const repo = Object.hasOwn(node.roots, input.repoId) ? node.roots[input.repoId] : undefined;
	if (repo && input.packageSummary?.authorizedObjectsAvailable) {
		// A hub assertion of locally validated availability, not target import or verification.
		source = pass("authorized_source_objects_available_import_unverified");
	} else if (repo && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseCommit)) {
		try {
			if (await realpath(repo) !== resolve(repo)) throw new Error("repository_symlink");
			const git = (args: string[]) => runGit(repo, args, 1024 * 1024, [node.workspaceRoot]);
			const top = await git(["rev-parse", "--show-toplevel"]);
			if (top.exit !== 0 || await realpath(top.stdout.trimEnd()) !== repo) throw new Error("repository_root");
			const base = await git(["rev-parse", "--verify", input.baseCommit + "^{commit}"]);
			if (base.exit !== 0 || base.stdout.trim() !== input.baseCommit) throw new Error("base_missing");
			source = pass("repo_and_exact_base_present");
		} catch {
			source = fail("repo_or_base_unavailable", "Provision a canonical repository root containing the exact base commit; no fetch or clone was attempted.");
		}
	}
	try {
		let ancestor = resolve(node.workspaceRoot);
		for (;;) {
			try {
				if (!(await lstat(ancestor)).isDirectory() || await realpath(ancestor) !== ancestor) throw new Error("workspace_not_canonical_directory");
				await access(ancestor, constants.W_OK | constants.X_OK);
				workspace = pass(ancestor === resolve(node.workspaceRoot) ? "workspace_accessible" : "workspace_ancestor_accessible");
				break;
			} catch (error: any) {
				if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
				ancestor = dirname(ancestor);
			}
		}
	} catch { /* Preserve an actionable refusal; do not create directories in preflight. */ }
	return { source, workspace };
}

/** Bounded one-shot protocol; only explicitly configured authenticated transports are executed. */
async function workspaceProbe(node: NodeConfig, input: ReadinessInput, timeoutMs: number) {
	const transport = node.workspaceTransport!;
	const nonce = randomUUID();
	const request = { action: "placement-preflight", nonce, nodeDigest: digest(node), input };
	// Shared one-shot transport: its deadline fires on time even if descendants hold the pipes.
	const value = await oneShot(transport.command, transport.args, request, timeoutMs);
	if (value?.nonce !== nonce || value?.nodeDigest !== request.nodeDigest || value?.inputDigest !== digest(request.input) || value?.repoId !== input.repoId || value?.baseCommit !== input.baseCommit) throw new Error("workspace_probe_identity_mismatch");
	for (const key of ["source", "workspace"]) {
		const check = value[key];
		if (!check || typeof check.ok !== "boolean" || typeof check.code !== "string" || !/^[a-z_]{1,128}$/.test(check.code) || typeof check.action !== "string" || check.action.length > 1024) throw new Error("invalid_workspace_probe");
	}
	return { source: value.source as ReadinessCheck, workspace: value.workspace as ReadinessCheck };
}

/** Live tools/list verifies Coordinator reachability/capabilities ONLY. No create, prompt or model call. */
export async function coordinatorProbe(node: NodeConfig, timeoutMs: number): Promise<ReadinessCheck> {
	let rpc: StdioRpc | undefined;
	try {
		rpc = nodeRpc(node, timeoutMs);
		await rpc.initialize();
		const catalog = await rpc.tools();
		const missing = tools.filter(name => !catalog.some(tool => tool.name === name));
		return missing.length ? fail("coordinator_tools_missing", "Expose required Coordinator tools: " + missing.join(", ")) : pass("coordinator_catalog_verified");
	} catch {
		return fail("coordinator_unavailable", "Verify the configured authenticated Coordinator command with attach-only; do not auto-start services.");
	} finally { rpc?.close(); }
}

const SUBJECT_NODE_ACTION = "The subject's node is excluded by subject.otherNode; register or enable another node.";
/** No node configuration resolves `subject_node`, so it carries its own action (alone, or after the generic one). */
function eligibilityAction(reasons: string[]): string {
	const generic = "Resolve node enablement, platform, repository allowlist and required operations.";
	if (!reasons.includes("subject_node")) return generic;
	return reasons.length === 1 ? SUBJECT_NODE_ACTION : `${generic} ${SUBJECT_NODE_ACTION}`;
}

/**
 * Fail-closed automatic candidate preparation. Resource admission remains the existing selectNode
 * algorithm, including held-task charges; input.required and preferences are never rewritten.
 * A green report means prerequisites, NOT remote execution or provider readiness proven.
 */
export async function preflightPlacement(input: TaskInput, nodes: NodeConfig[], tasks: readonly TaskState[], admission: AdmissionContext, options: PreflightOptions = {}): Promise<PlacementReport> {
	validateTaskInput(input, options.workUnits === undefined ? {} : { workUnits: options.workUnits });
	if (input.inputPackage) validateInputPackage(input.inputPackage);
	for (const node of nodes) validateNode(node);
	if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error("duplicate_node_id");
	const timeoutMs = options.timeoutMs ?? 10_000;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("invalid_preflight_timeout");
	// Freeze caller-owned input/config across asynchronous probes.
	input = structuredClone(input);
	const metadata = readinessInput(input);
	nodes = structuredClone(nodes);
	tasks = structuredClone(tasks);
	admission = structuredClone(admission);
	// subject.otherNode: the subject's node is hard-ineligible (`subject_node`) and never probed.
	const subjectNode = subjectNodeId(input, tasks);
	const checkedAt = Date.now();
	const readiness: NodeReadiness[] = [];
	// Bound active transports regardless of registry size; each host's independent checks overlap.
	for (const node of nodes) {
		const hard = selectNode(input, [node], tasks, undefined, subjectNode).exclusions[0]?.reasons ?? [];
		const modelReasons = hard.filter(reason => reason.startsWith("model"));
		const otherReasons = hard.filter(reason => !reason.startsWith("model"));
		const resource = selectNode(input, [node], tasks, admission, subjectNode).exclusions[0]?.reasons.filter(reason => !hard.includes(reason)) ?? [];
		const model = modelReasons.length ? fail(modelReasons.join("+"), "Configure an eligible model/profile on this node and verify provider access separately.") : pass("model_declared_only_execution_unverified");
		const skipped = fail("hard_ineligible_probe_skipped", "Resolve hard eligibility before probing this node.");
		const probe = async () => {
			let filesystem: { source: ReadinessCheck; workspace: ReadinessCheck };
			// In one call slot the node gets one call at a time: the catalog probe finishes before the workspace probe.
			const coordinator = hard.length ? Promise.resolve(skipped) : options.nodeCall ? Promise.resolve(await coordinatorProbe(node, timeoutMs)) : coordinatorProbe(node, timeoutMs);
			if (hard.length) {
				filesystem = { source: skipped, workspace: skipped };
			} else if (node.workspaceTransport) {
				try { filesystem = await workspaceProbe(node, metadata, timeoutMs); }
				catch {
					const unavailable = fail("workspace_transport_unverified", "Configure workspaceTransport to run placement-preflight.ts NODE_CONFIG on the target host; verify its exact config and source/base. Legacy node.ts does not support the read-only probe.");
					filesystem = { source: unavailable, workspace: unavailable };
				}
			} else if (options.localNodeId === node.id) {
				filesystem = await probePlacementSource(node, metadata);
			} else {
				const missing = fail("workspace_transport_required", "Configure authenticated workspaceTransport on this host, or explicitly identify this node as local. Matching OS/arch is insufficient.");
				filesystem = { source: missing, workspace: missing };
			}
			return { ...filesystem, coordinator: await coordinator };
		};
		let probed: { source: ReadinessCheck; workspace: ReadinessCheck; coordinator: ReadinessCheck };
		if (hard.length || !options.nodeCall) probed = await probe();
		else {
			try { probed = await options.nodeCall(node.id, probe); }
			catch (error) {
				if (!(error instanceof FleetError && error.code === "NODE_BUSY")) throw error;
				const deferred = fail("probe_deferred_node_busy", "Another call to this node was in flight; a later pass probes it again.");
				probed = { source: deferred, workspace: deferred, coordinator: deferred };
			}
		}
		const checks = {
			eligibility: otherReasons.length ? fail(otherReasons.join("+"), eligibilityAction(otherReasons)) : pass("eligible"),
			source: probed.source,
			workspace: probed.workspace,
			coordinator: probed.coordinator,
			model,
			resources: resource.length ? fail(resource.join("+"), "Refresh node resource measurements or wait for measured headroom.") : pass("resources_admissible"),
		};
		readiness.push({ nodeId: node.id, ready: Object.values(checks).every(check => check.ok), executionProven: false, checks });
	}
	// A slow host must not make an earlier host's now-expired sample admissible.
	admission = { ...admission, now: Math.max(admission.now, Date.now()) };
	for (const node of nodes) {
		const hard = selectNode(input, [node], tasks, undefined, subjectNode).exclusions[0]?.reasons ?? [];
		const reasons = selectNode(input, [node], tasks, admission, subjectNode).exclusions[0]?.reasons.filter(reason => !hard.includes(reason)) ?? [];
		const row = readiness.find(row => row.nodeId === node.id)!;
		row.checks.resources = reasons.length ? fail(reasons.join("+"), "Refresh node resource measurements or wait for measured headroom.") : pass("resources_admissible");
		row.ready = Object.values(row.checks).every(check => check.ok);
	}
	const readyIds = new Set(readiness.filter(node => node.ready).map(node => node.nodeId));
	const selection = selectNode(input, nodes.filter(node => readyIds.has(node.id)), tasks, admission, subjectNode);
	for (const node of readiness.filter(node => !node.ready)) selection.exclusions.push({ nodeId: node.nodeId, reasons: Object.entries(node.checks).filter(([, check]) => !check.ok).map(([stage, check]) => stage + ":" + check.code) });
	return { inputDigest: digest(input), nodeDigests: Object.fromEntries(nodes.map(node => [node.id, digest(node)])), checkedAt, nodes: readiness, selection };
}

/** Structural store API: keeps this lane independent of FleetStore's implementation. */
export interface PlacementStore {
	task(id: string): TaskRecord | undefined;
	nodes(): NodeConfig[];
	taskStates(): TaskState[];
	heldCharges(): AdmissionContext["held"];
	reserve(id: string, resources: ReservationResources): TaskRecord;
	/** The stored node-health switch (FleetStore); a store without it never gates. */
	nodeHealthGating?(): { enabled: boolean };
	workUnitAccess(): WorkUnitAccess;
}
/**
 * What the store receives for one reservation: hub samples plus, with the node-health switch on, the
 * preflight/health exclusions (persisted verbatim in the selection audit) and the pinned health
 * warning (persisted in the same transaction as the reservation it describes).
 */
export interface ReservationResources {
	samples: ReadonlyMap<string, ResourceSample>;
	policy?: AdmissionPolicy;
	exclusions?: readonly { nodeId: string; reasons: readonly string[] }[];
	healthWarning?: { nodeId: string; failingDimensions: readonly string[] };
}
/**
 * Integration: store.submit(input), then await reservePlacement(store, id, resources).
 * No registry edits, no NODEM pin. Only ready nodes retain samples for the synchronous SQLite
 * reservation; other nodes are rejected by existing fail-closed resource admission.
 * Fleet.start(task.id) then performs actual workspace preparation and execution as usual.
 */
export async function reservePlacement(store: PlacementStore, id: string, resources: { samples: ReadonlyMap<string, ResourceSample>; policy?: AdmissionPolicy }, options: PreflightOptions = {}) {
	// Switch on: node-health enforcement. Off (default): the unchanged pre-feature body below.
	if (store.nodeHealthGating?.().enabled) return (await import("./node-health-gate")).reserveEnforced(store, id, resources, options);
	const task = store.task(id);
	if (!task) throw new Error("task_not_found");
	if (task.attemptId) throw new Error("placement_already_reserved");
	const report = await preflightPlacement(task.input, store.nodes(), store.taskStates(), { ...resources, held: store.heldCharges(), now: Date.now() }, { ...options, ...inputOptions(store, task.input) });
	if (digest(store.task(id)?.input) !== report.inputDigest || digest(Object.fromEntries(store.nodes().map(node => [node.id, digest(node)]))) !== digest(report.nodeDigests)) throw new Error("placement_changed_during_preflight");
	const readyIds = new Set(report.nodes.filter(node => node.ready).map(node => node.nodeId));
	const samples = new Map([...resources.samples].filter(([nodeId]) => readyIds.has(nodeId)));
	return { report, task: store.reserve(id, { samples, policy: resources.policy }) };
}

// Drop-in one-shot workspace helper: existing prepare/test/collect retain their real implementation.
if (import.meta.main) {
	const progress: OperationProgress = { executed: false };
	const { line, exitCode } = await answer(progress, async () => {
		const config = process.argv[2];
		if (!config) throw new Error("node_config_required");
		const node: NodeConfig = await Bun.file(resolve(config)).json();
		validateNode(node);
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const part of Bun.stdin.stream()) {
			size += part.length;
			if (size > 32 * 1024 * 1024) throw new Error("node_request_limit");
			chunks.push(part);
		}
		const request = JSON.parse(Buffer.concat(chunks).toString());
		let value: unknown;
		if (request.action === "placement-preflight") {
			if (request.nodeDigest !== digest(node) || typeof request.nonce !== "string" || request.nonce.length > 128 || typeof request.input?.repoId !== "string" || typeof request.input?.baseCommit !== "string") throw new Error("probe_identity_required");
			const metadata = request.input;
			if (Object.keys(metadata).some(key => !["repoId", "baseCommit", "packageDigest", "packageSummary"].includes(key))) throw new Error("probe_metadata_required");
			if (metadata.packageDigest !== undefined || metadata.packageSummary !== undefined) {
				const summary = metadata.packageSummary;
				if (typeof metadata.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(metadata.packageDigest) || !summary || Object.keys(summary).some(key => !["changedFiles", "objectCount", "authorizedObjectsAvailable"].includes(key)) || !Number.isSafeInteger(summary.changedFiles) || summary.changedFiles < 0 || summary.changedFiles > 1024 || !Number.isSafeInteger(summary.objectCount) || summary.objectCount < 0 || typeof summary.authorizedObjectsAvailable !== "boolean" || (summary.authorizedObjectsAvailable ? summary.objectCount < 1 : summary.objectCount !== 0)) throw new Error("probe_metadata_required");
			}
			value = { ...await probePlacementSource(node, request.input), nonce: request.nonce, nodeDigest: digest(node), inputDigest: digest(request.input), repoId: request.input.repoId, baseCommit: request.input.baseCommit };
		} else value = await nodeOperation(node, request, progress);
		// The placement probe is read-only; forwarded operations mark progress when they begin.
		return JSON.stringify({ ok: true, value });
	});
	console.log(line);
	process.exitCode = exitCode;
}
