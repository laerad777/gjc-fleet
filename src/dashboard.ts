import { type HeldCharge, type ResourceSample, resourceReasons, unmeasuredTasks } from "./admission";
import { SELECTED_NODE_REASONS, type AuditEvent, type DispositionKind, type LateReceipt, type NodeConfig, type Phase, type ReceiptlessSettlement, type SelectedNodeReason, type TaskProgress, type TaskRecord, type TaskState } from "./contracts";
import { DASHBOARD_HTML } from "./dashboard-page";
import { EXECUTION_FAILURE_REPORTED } from "./execution";
import { executionOutcome, exportReviewPending, placementView, reasonClass, shownPlacement } from "./core";
import { diagnosticErrorClass } from "./diagnostic";
import { progressShown } from "./progress";
import type { FleetStore, ResourceReturnStatus } from "./store";
import type { NodeHealthHistory } from "./node-health";
import { type DeliverableView, withDeliverables } from "./work-unit";
import { spawnTrusted } from "./spawn";
import { dashboardTaskAttention, type DashboardTaskAttention, type DashboardSshEvidence, dashboardSshEvidence, dashboardSshLinks, dashboardSshRoute } from "./dashboard-map-view";
import { dashboardHealthFreshness, dashboardHubLease, dashboardNodeCondition, dashboardOverall, type DashboardHealthFreshness, type DashboardHubLease, type DashboardNodeStatus, type DashboardOverall, type DashboardTasksAtRisk } from "./dashboard-status";
import { publicCommandError, publicExitError, publicLateReceipt, publicSettlement } from "./dashboard-poll-view";

declare const Bun: any;

/** Ordered pipeline stages. A task reaches a stage when one of its audit kinds is recorded. */
export const PIPELINE_STAGES = [
	{ key: "submitted", label: "Received", kinds: ["submitted"] },
	{ key: "assigned", label: "Assigned", kinds: ["reserved"] },
	{ key: "workspace", label: "Prepared", kinds: ["workspace_recorded"] },
	{ key: "session", label: "Session", kinds: ["session_recorded"] },
	{ key: "turn", label: "Running", kinds: ["turn_recorded"] },
	{ key: "result", label: "Result", kinds: ["result_saved"] },
	{ key: "verified", label: "Verified", kinds: ["result_verified", "incomplete_export_accepted"] },
] as const;
/** Index of the result_saved pipeline stage — used to split “result not collected” from true verify-wait. */
export const RESULT_STAGE_INDEX = PIPELINE_STAGES.findIndex((stage) => stage.key === "result");

const RUNNING: Phase[] = ["preparing", "dispatching", "active"];
const TROUBLE: Phase[] = ["failed", "blocked_unknown", "cancel_unknown"];
/** Soft cap for settled/history rows. Held, running, queued, approval and unsettled tasks are never dropped for this budget. */
const TASK_LIMIT = 40;
/** Soft cap for a single task timeline after collapse; newest rows are kept. */
const TIMELINE_LIMIT = 80;
const DISPOSITION_TEXT_LIMIT = 200;
/** The dashboard's bounded view of a stored disposition. */
export function dispositionSummary(d: NonNullable<TaskRecord["disposition"]>): NonNullable<DashboardTask["disposition"]> {
	// Cut on code points, never inside a surrogate pair.
	const cut = (text: string) => {
		const points = Array.from(text);
		return points.length > DISPOSITION_TEXT_LIMIT ? points.slice(0, DISPOSITION_TEXT_LIMIT - 1).join("") + "…" : text;
	};
	return {
		kind: d.kind,
		...(d.commit ? { commit: d.commit } : {}),
		...(d.supersededBy ? { supersededBy: d.supersededBy } : {}),
		...(d.subject ? { subject: cut(d.subject) } : {}),
		...(d.verdict ? { verdict: d.verdict } : {}),
		reason: cut(d.reason),
		actor: cut(d.actor),
		at: d.at,
		verifiedByFleet: false,
	};
}
const SESSION_LIMIT = 15;

export interface GjcRuntimeStatus {
	installed: boolean;
	version?: string;
	brokerDiscovery?: string;
	mcpCoordinatorReady?: boolean;
	/** Live sessions known to the hub broker across every workspace (--scope all). */
	activeSessionsCount?: number;
	totalSessionsCount?: number;
	lastCheckedAt: string;
}

export type SessionState = "ended" | "waiting_answer" | "waiting_permission" | "waiting_workflow" | "working" | "idle" | "stale" | "unknown";

export interface NodeSessionSummary {
	sessionId: string;
	live: boolean;
	cwd?: string;
	activity?: string;
	/**
	 * GJC-derived state: ended (endpoint gone), waiting_answer (pending ordinary ask), waiting_permission
	 * (pending tool permission), working (heartbeat activity active), idle, or stale (live but heartbeat old).
	 */
	state?: SessionState;
	/** Pending ask/permission request count behind a waiting_* state. */
	pending?: number;
	/** Bounded read-only query diagnostics; absent counts remain unknown, not zero. */
	requestErrors?: Array<{ source: string; code: string }>;
	lastHeartbeatAt?: number;
	/** First user prompt of the session, read from its transcript on the node; says what the work is. */
	title?: string;
	/** Fleet task that recorded this session, when the hub DB knows it. */
	taskId?: string;
	/** That task's last recorded lane progress (see DashboardTask.progress). */
	progress?: DashboardProgress;
	taskKey?: string;
	taskTitle?: string;
}

/** System resources streamed from the node itself with read-only OS commands. */
export interface NodeResources {
	ok: boolean;
	error?: string;
	cores?: number;
	physicalCores?: number;
	threads?: number;
	/** 1-minute load average; absent on Windows. */
	load1?: number;
	/** CPU busy percent: Linux /proc/stat delta, Windows LoadPercentage, macOS iostat 1s busy. Absent until measured. */
	cpuPct?: number;
	/** Epoch ms the hub received this sample (set by the stream reader). */
	sampledAt?: number;
	memTotal?: number;
	/** Memory in real use. On a ballooned VM this excludes what the host has taken back. */
	memUsed?: number;
	/**
	 * Linux only: memory the host took back through a virtio balloon. The guest kernel counts it as
	 * in use, but no process holds it; it returns only if the host can deflate the balloon.
	 */
	memReclaimed?: number;
	/** One entry per real partition/volume on the node (boot, loop and virtual mounts are left out). */
	disks?: Array<{ path: string; total: number; used: number }>;
}

/** Result of actually calling GJC through the node's registered sdkTransport. */
export interface NodeProbe {
	nodeId: string;
	checkedAt: string;
	/** false when the node has no sdkTransport, so nothing could be measured. */
	probed: boolean;
	ok: boolean;
	version?: string;
	error?: string;
	elapsedMs?: number;
	sessionsOk?: boolean;
	sessionsError?: string;
	totalSessions?: number;
	liveSessions?: number;
	sessions?: NodeSessionSummary[];
}

export interface DashboardTask {
	/** Work-unit switch on only: the task's append-only deliverable record (never a verification). */
	deliverable?: DeliverableView;
	id: string;
	key: string;
	/** First line of the task prompt. */
	title: string;
	caller: string;
	phase: Phase;
	/** Operator-facing state, independent of running/reserved capacity counts. */
	attention?: DashboardTaskAttention;
	nodeId?: string;
	held: boolean;
	executionTerminal: boolean;
	reason?: string;
	archivedFrom?: TaskRecord["archivedFrom"];
	archivedAt?: string;
	/**
	 * Present only for a task archived by `task dispose`: an operator record, never Fleet verification.
	 * A bounded summary (the full record stays in `show`): texts cut to 200 characters; no statement, no request digest.
	 */
	disposition?: { kind: DispositionKind; commit?: string; supersededBy?: string; subject?: string; verdict?: string; reason: string; actor: string; at: string; verifiedByFleet: false };
	resultStatus?: string;
	/** Current execution outcome (core.executionOutcome); resultStatus is the last observation only. */
	outcome: string | null;
	verified?: boolean;
	/** Present when execution ended provably but WITHOUT a runtime receipt: a failure, never success. */
	settlement?: ReceiptlessSettlement;
	/** A receipt for the same turn that appeared after settlement: a recorded contradiction. */
	lateReceipt?: LateReceipt;
	/** Only on a task whose passing commands met an incomplete export (`result.exportIncomplete`). */
	exportReview?: "required" | "accepted";
	sessionId?: string;
	turnId?: string;
	/** Last recorded lane progress (node transcript read), with ages computed when this state was generated. */
	progress?: DashboardProgress;
	/** Settled-session resource return: returned only after a fresh listing showed the
	 * session gone; an operator release without that is shown as possibly still running. */
	resourceReturn?: ResourceReturnStatus;
	required: TaskRecord["input"]["required"];
	preferences: string[];
	/** ISO time each pipeline stage was first reached, null when not reached. */
	stages: Array<string | null>;
	/** Index of the furthest reached stage, -1 when no audit trail exists. */
	stageIndex: number;
	submittedAt?: string;
	lastEventAt?: string;
	selection?: {
		outcome?: string;
		nodeId?: string;
		globalFull?: boolean;
		/** Only on task detail: an allowlisted code recorded by the last selection. */
		reason?: SelectedNodeReason | "no_eligible_node" | "global_capacity";
		exclusions: Array<{ nodeId: string; reasons: string[] }>;
	};
	/**
	 * Never-admitted queued task only: waiting for capacity vs unplaceable (core.placementView). blocking[].structural
	 * lists the reasons only an operator change clears; summary is the CLI's operator words.
	 */
	placement?: {
		verdict: "waiting" | "unplaceable";
		since: string;
		checkedAt: string;
		rejections: number;
		nodes: number;
		summary: string;
		blocking: Array<{ nodeId: string; reasons: string[]; structural: string[] }>;
	};
	/** Present only for a queued task the operator withdrew before any attempt (`queue withdraw`). */
	withdrawal?: { actor: string; reason: string; at: string };
	timeline: Array<{ at: string; kind: string; detail?: string; count?: number }>;
	/**
	 * When the live payload deferred the audit timeline (`timeline` empty), this is the full collapsed
	 * count available from `/api/task/:id`. When a timeline is present it is older rows trimmed past TIMELINE_LIMIT.
	 */
	timelineOmitted?: number;
}

/** Live cards only need archivedFrom.phase/reason; the nested result blob is loaded with `/api/task/:id`. */
function slimArchivedFrom(from: NonNullable<DashboardTask["archivedFrom"]>): NonNullable<DashboardTask["archivedFrom"]> {
	return { phase: from.phase, ...(from.reason !== undefined ? { reason: from.reason } : {}) };
}

/** Collapsed live cards only need a short title; full headline comes from `/api/task/:id`. */
const LIVE_TITLE_MAX = 48;

/**
 * Warning / proof rows that must stay on the collapsed live card (pre-expand) so operators still see
 * the same attention labels that used to come from the full audit timeline. Everything else loads
 * from `/api/task/:id` on expand. Keep this set small: it is not a substitute for the full history.
 */
const LIVE_ATTENTION_TIMELINE_KINDS = new Set([
	"late_receipt_contradiction",
	"late_receipt_conflict",
	"late_receipt_accepted",
	"output_head_created",
	"output_head_unproven",
	"node_health_warning",
	"blocked",
]);

/**
 * Live `/api/state` keeps archive/list cards but drops non-attention audit rows, heavy
 * archivedFrom.result, selection exclusions, and stage timestamps (ops measured multi-MB payloads /
 * ~1MB after the first slim). Attention warning/proof kinds and stageIndex stay on the card before
 * expand; full selection/stages/title/timeline load from `/api/task/:id`.
 */
function deferHeavyTimeline(task: DashboardTask): DashboardTask {
	let next = task;
	if (task.timeline.length > 0) {
		const kept = task.timeline.filter((row) => LIVE_ATTENTION_TIMELINE_KINDS.has(row.kind));
		const omitted = (task.timelineOmitted ?? 0) + (task.timeline.length - kept.length);
		const { timelineOmitted: _priorOmitted, ...base } = next;
		next = omitted > 0 ? { ...base, timeline: kept, timelineOmitted: omitted } : { ...base, timeline: kept };
	}
	if (next.archivedFrom && next.archivedFrom.result !== undefined) {
		next = { ...next, archivedFrom: slimArchivedFrom(next.archivedFrom) };
	}
	const title = next.title.length > LIVE_TITLE_MAX ? `${next.title.slice(0, LIVE_TITLE_MAX - 1)}…` : next.title;
	const stages = PIPELINE_STAGES.map(() => null);
	const selection = next.selection
		? {
				...(next.selection.outcome !== undefined ? { outcome: next.selection.outcome } : {}),
				...(next.selection.nodeId !== undefined ? { nodeId: next.selection.nodeId } : {}),
				...(next.selection.globalFull ? { globalFull: true } : {}),
				exclusions: [] as Array<{ nodeId: string; reasons: string[] }>,
			}
		: undefined;
	next = { ...next, title, stages, ...(selection ? { selection } : {}) };
	return next;
}

/**
 * Tasks that must stay visible even when a soft list budget is applied. Includes every
 * completed_unverified row (end unproven or awaiting supervisor verification) so "done-looking"
 * work that still needs a result check is never sliced away.
 */
export function dashboardPriorityTask(task: Pick<DashboardTask, "phase" | "held" | "executionTerminal" | "placement">): boolean {
	if (task.held) return true;
	if (RUNNING.includes(task.phase)) return true;
	if (task.phase === "queued" || task.phase === "approval_required") return true;
	if (TROUBLE.includes(task.phase)) return true;
	if (task.phase === "completed_unverified") return true;
	return false;
}

/**
 * Prefer attention-needed tasks over a blind "newest N" cut. Priority rows are never omitted;
 * remaining budget fills with the newest other rows when space remains under the soft limit.
 * Live `/api/state` currently lists every visible card (timelines deferred); this helper remains
 * for callers/tests that still apply a soft budget.
 */
export function selectDashboardTasks(visible: DashboardTask[], limit = TASK_LIMIT): { tasks: DashboardTask[]; omitted: number } {
	const priority = visible.filter(dashboardPriorityTask);
	const rest = visible.filter((task) => !dashboardPriorityTask(task));
	const room = Math.max(0, limit - priority.length);
	const chosen = [...priority, ...rest.slice(0, room)];
	chosen.sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
	return { tasks: chosen, omitted: visible.length - chosen.length };
}

export type DashboardProgress = TaskProgress & {
	/** generatedAt minus lastProgressAt (s): the per-session time since the last transcript write, current at every push. */
	secondsSinceProgress: number | null;
	/** generatedAt minus observedAt (s): how old the node read is. */
	secondsSinceObserved: number | null;
};
function dashboardProgress(progress: TaskProgress, now: number): DashboardProgress {
	const since = (iso: string | undefined) => {
		const at = Date.parse(iso ?? "");
		return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null;
	};
	return { ...progress, secondsSinceProgress: since(progress.lastProgressAt), secondsSinceObserved: since(progress.observedAt) };
}

export interface DashboardNode {
	id: string;
	os: string;
	arch: string;
	enabled: boolean;
	draining: boolean;
	reachable: boolean;
	sdkReady: boolean;
	modelReady: boolean;
	/** Held tasks whose phase is running (preparing, dispatching, active). */
	currentLoad: number;
	/** Held tasks in any other phase: the slot is still reserved but no work is running. */
	heldNotRunning: number;
	/** Whether a new task would be admitted by measured headroom now; null when not measuring live. */
	admission: { open: boolean; reasons: string[] } | null;
	modelProfiles: string[];
	operations: string[];
	/** Tasks currently holding a slot on this node. */
	holding: Array<{ id: string; key: string; phase: Phase; executionTerminal: boolean }>;
	/** Reservations released by an operator whose session no fresh listing has shown gone:
	 * no longer holding capacity, but possibly still running on this node. */
	possiblyRunning: Array<{ id: string; key: string; sessionId: string | null; operator: string; reason: string; at: string | null }>;
	assignedTotal: number;
	succeeded: number;
	troubled: number;
	/** How often this node was skipped during selection, by reason. */
	exclusions: Record<string, number>;
	probe: NodeProbe | null;
	/** Observed control path condition, not a statement that the host is powered off. */
	status?: DashboardNodeStatus;
	/** Held work whose outcome is unconfirmed behind an observed failed path. */
	tasksAtRisk?: DashboardTasksAtRisk;
	/** Latest streamed measurement; null when streaming is off or no sample has arrived yet. */
	resources: NodeResources | null;
	/** Node stability from the hub's health history (absent without one or with the switch off). Independent of
	 * resource-return blocks: a node blocked for returns is not thereby unstable. */
	health?: DashboardNodeHealth;
}

export interface DashboardNodeHealth {
	/** `observe`: shown and recorded only, selection unchanged; `enforce`: gates automatic selection. */
	gating: "observe" | "enforce";
	stable: boolean;
	failingDimensions: string[];
	consecutiveGood: number;
	required: number;
	/** Display only: store wall time of the latest recorded probe and of the last failure. */
	latestAt?: number;
	freshness?: DashboardHealthFreshness;
	lastFailure?: { at: number; dimensions: string[] };
	/** Dimensions this node's configuration can never observe (no guarded sdkTransport): such a
	 * node can never become stable, so switching gating on excludes it from automatic selection. */
	neverObservable: string[];
}

function nodeHealthView(health: ReturnType<NodeHealthHistory["dimensions"]>, node: NodeConfig, gating: "observe" | "enforce", now: number): DashboardNodeHealth {
	return {
		gating,
		neverObservable: brokerSessionListObservable(node) ? [] : ["brokerSessionListOk"],
		stable: health.stable,
		failingDimensions: health.failingDimensions,
		consecutiveGood: health.consecutiveGood,
		required: health.required,
		...(health.latest ? { latestAt: health.latest.at } : {}),
		freshness: dashboardHealthFreshness([health.latest?.at], now, HEALTH_OBSERVE_MS * 3),
		...(health.lastFailure ? { lastFailure: { at: health.lastFailure.at, dimensions: health.lastFailure.dimensions } } : {}),
	};
}
function gatingView(store: FleetStore): NonNullable<DashboardState["nodeHealth"]> {
	const gating = store.nodeHealthGating();
	return { gating: gating.enabled ? "enforce" : "observe", ...(gating.operator ? { operator: gating.operator, reason: gating.reason, at: gating.at } : {}) };
}

export interface DashboardState {
	generatedAt: string;
	/** true when the server measures nodes live (SSH resource streams and GJC probes). */
	live: boolean;
	summary: {
		overall?: DashboardOverall;
		totalNodes: number;
		healthyNodes: number;
		/** Tasks in a RUNNING phase (preparing, dispatching, active). Provisional completions are counted in unsettledTasks, not here. */
		activeTasks: number;
		/** completed_unverified tasks without executionTerminal proof: not running, not settled. */
		unsettledTasks: number;
		/** Part of unsettledTasks: phase completed_unverified WITHOUT terminal proof and no reported failure (public completion only; slot held). */
		provisionalTasks: number;
		/** Part of unsettledTasks: provisional with a reported but unproven failure (reason execution_failure_reported_end_unproven; slot held). */
		failureReportedTasks: number;
		queuedTasks: number;
		/** Part of queuedTasks: never-admitted queued tasks whose last selection found them unplaceable. */
		unplaceableTasks: number;
		succeededTasks: number;
		/** `completed_unverified` tasks whose commands passed over an incomplete export: waiting for operator acceptance. */
		exportIncompleteTasks: number;
		failedTasks: number;
		heldTasks: number;
		/** Nodes that would take a new task right now by measured headroom; null when not measuring live. */
		openNodes: number | null;
		totalTasks: number;
		/** Non-archived tasks included in `tasks` (may exceed TASK_LIMIT when many need attention). */
		listedTasks: number;
		/** Non-archived tasks omitted from `tasks` (never includes held/running/queued/approval/unsettled/trouble). */
		omittedTasks: number;
		/** Archived tasks included in `archivedTasks`. */
		listedArchived: number;
		/** Older archived tasks omitted from the payload. */
		omittedArchived: number;
	};
	pipeline: {
		stages: Array<{ key: string; label: string; inFlight: number; reached: number }>;
		outcome: {
			succeeded: number;
			/** completed_unverified with terminal proof AND result_saved — true supervisor verify-wait. */
			unverified: number;
			/**
			 * completed_unverified with terminal proof but no result_saved audit.
			 * These are stuck before collection, not waiting on a verify queue.
			 */
			resultMissing: number;
			unsettled: number; troubled: number; cancelled: number; approval: number;
			/** Only while one or more `completed_unverified` tasks await export acceptance (taken out of `unverified` and `resultMissing`). */
			exportIncomplete?: number;
			/** Work-unit switch on only: report_collected tasks (never verified) taken out of `unverified`. */
			reportsCollected?: number;
			/** Work-unit switch on only: Step 1b operator-classified reports (never verified). */
			reportsClassified?: number;
		};
	};
	gjcRuntime: GjcRuntimeStatus;
	nodes: DashboardNode[];
	/** Observations of existing hub-initiated SSH resource streams only. */
	sshLinks?: ReturnType<typeof dashboardSshLinks>;
	tasks: DashboardTask[];
	archivedTasks: DashboardTask[];
	/** The `fleet daemon` owner lease and its published status; absent when no daemon row exists. */
	daemon?: ReturnType<FleetStore["daemonStatus"]>;
	hub?: { lease: DashboardHubLease };
	/** Available only when the existing health history is enabled. No producer liveness is inferred. */
	health?: { gating: "observe" | "enforce"; freshness: DashboardHealthFreshness };
	/** Present only with a health history while the stored switch is on (`enforce`: the operator
	 * switch gates automatic selection). Switch off: absent, and so is every nodes[].health. */
	nodeHealth?: { gating: "observe" | "enforce"; operator?: string; reason?: string; at?: number };
}

/** One SSH connection per destination at a time; parallel logins to one host get refused. */
const sshQueues = new Map<string, Promise<unknown>>();

/**
 * Runs `task` in the per-destination queue of the SSH command `cmd` (destination = every argument but
 * the remote command), after every earlier call queued for that destination by this process. A
 * command that is not `ssh` runs at once.
 */
export function sshSerialized<T>(cmd: string[], task: () => Promise<T>): Promise<T> {
	if (cmd[0] !== "ssh") return task();
	const destination = cmd.slice(0, -1).join("\u0000");
	const next = (sshQueues.get(destination) ?? Promise.resolve()).then(task, task);
	sshQueues.set(destination, next);
	return next;
}

function run(
	cmd: string[],
	timeoutMs: number,
	env?: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	if (cmd[0] !== "ssh") return spawnOnce(cmd, timeoutMs, env);
	// Exit 255 is SSH's own connection failure, seen intermittently on back-to-back logins.
	// Every command sent here is a read-only query, so one retry cannot duplicate an effect.
	const attempt = async () => {
		const first = await spawnOnce(cmd, timeoutMs, env);
		if (first.code !== 255) return first;
		await new Promise((resolve) => setTimeout(resolve, 700));
		return spawnOnce(cmd, timeoutMs, env);
	};
	return sshSerialized(cmd, attempt);
}

async function spawnOnce(
	cmd: string[],
	timeoutMs: number,
	env?: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const proc = spawnTrusted(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, env: env ?? process.env });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	await proc.exited;
	return { code: proc.exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function failure(result: { code: number | null; stderr: string }): string {
	return publicExitError(result.code);
}

interface RawSession {
	sessionId: string;
	live?: boolean;
	deleted?: boolean;
	locator?: { cwd?: string };
	activity?: { state?: string };
	lastHeartbeatAt?: number;
}

/** GJC reports command failures as JSON on stdout; fixed public codes only. */
function commandError(stdout: string): string {
	try {
		return publicCommandError(JSON.parse(stdout)?.error?.code);
	} catch {
		return publicCommandError(undefined);
	}
}

function parseSessions(stdout: string): RawSession[] | undefined {
	try {
		const json = JSON.parse(stdout);
		const sessions = json?.ok ? json.result?.sessions : undefined;
		return Array.isArray(sessions) ? sessions : undefined;
	} catch {
		return undefined;
	}
}

export async function probeGjcRuntime(): Promise<GjcRuntimeStatus> {
	const result: GjcRuntimeStatus = { installed: false, lastCheckedAt: new Date().toISOString() };
	try {
		const ver = await run(["gjc", "--version"], 5000);
		if (ver.code !== 0 || !ver.stdout) return result;
		result.installed = true;
		result.version = ver.stdout;
	} catch {
		return result;
	}
	try {
		const mcp = await run(["gjc", "mcp-serve", "coordinator", "--check", "--json", "--attach-only"], 8000);
		if (mcp.code === 0 && mcp.stdout) {
			const json = JSON.parse(mcp.stdout);
			result.mcpCoordinatorReady = json.catalog?.ready === true;
			result.brokerDiscovery = json.broker?.discovery_status ?? "unknown";
		}
	} catch {}
	try {
		const list = await run(["gjc", "sdk", "session", "list", "--scope", "all", "--json"], 15000, {
			...process.env,
			GJC_SDK_BROKER_AUTOSTART: "0",
		});
		const sessions = list.code === 0 ? parseSessions(list.stdout) : undefined;
		if (sessions) {
			result.totalSessionsCount = sessions.length;
			result.activeSessionsCount = sessions.filter((s) => s.live).length;
		}
	} catch {}
	return result;
}

/**
 * Build a GJC invocation through the node's registered sdkTransport.
 * `guarded` is true only when broker autostart could be disabled for the call;
 * session listing is skipped otherwise so a read-only dashboard never starts a broker.
 */
function gjcInvocation(
	node: NodeConfig,
	args: string[],
): { cmd: string[]; env: Record<string, string | undefined>; guarded: boolean } | undefined {
	const transport = node.sdkTransport;
	if (!transport) return undefined;
	const env = { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" };
	if (transport.command !== "ssh") return { cmd: [transport.command, ...transport.args, ...args], env, guarded: true };
	const head = transport.args.slice(0, -1);
	const remote = transport.args.at(-1) ?? "";
	const suffix = ` ${args.join(" ")}`;
	if (node.os === "win32") {
		const cmdPrefix = /^cmd\.exe \/c /i;
		const guarded = cmdPrefix.test(remote);
		const guardedRemote = guarded
			? `cmd.exe /c "set GJC_SDK_BROKER_AUTOSTART=0&& ${remote.replace(cmdPrefix, "")}${suffix}"`
			: remote + suffix;
		return { cmd: ["ssh", ...head, guardedRemote], env, guarded };
	}
	return { cmd: ["ssh", ...head, `env GJC_SDK_BROKER_AUTOSTART=0 ${remote}${suffix}`], env, guarded: true };
}

/**
 * Several read-only GJC calls in one connection, outputs split by a marker line.
 * Undefined when broker autostart cannot be disabled for the node's transport.
 */
const BATCH_SEP = "==FLEET-BATCH-SEP==";
function gjcBatch(node: NodeConfig, calls: string[][]): { cmd: string[]; env: Record<string, string | undefined> } | undefined {
	const transport = node.sdkTransport;
	if (!transport || !calls.length) return undefined;
	const env = { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" };
	const safe = calls.every((call) => call.every((arg) => /^[\w.:/=-]+$/.test(arg)));
	if (!safe) return undefined;
	if (transport.command !== "ssh") {
		const base = [transport.command, ...transport.args].join(" ");
		if (!/^[\w.:/= -]+$/.test(base)) return undefined;
		return { cmd: ["sh", "-c", calls.map((call) => `${base} ${call.join(" ")}`).join(`; echo ${BATCH_SEP}; `)], env };
	}
	const head = transport.args.slice(0, -1);
	const remote = transport.args.at(-1) ?? "";
	if (node.os === "win32") {
		const prefix = /^cmd\.exe \/c /i;
		if (!prefix.test(remote)) return undefined;
		const exe = remote.replace(prefix, "");
		const body = calls.map((call) => `${exe} ${call.join(" ")}`).join(` & echo ${BATCH_SEP} & `);
		return { cmd: ["ssh", ...head, `cmd.exe /c "set GJC_SDK_BROKER_AUTOSTART=0&& ${body}"`], env };
	}
	const body = calls.map((call) => `env GJC_SDK_BROKER_AUTOSTART=0 ${remote} ${call.join(" ")}`).join(`; echo ${BATCH_SEP}; `);
	return { cmd: ["ssh", ...head, body], env };
}

/** How long a live session may go without a broker heartbeat before it is shown as not responding. */
const HEARTBEAT_STALE_MS = 120_000;
const STATE_QUERY_LIMIT = 12;

/** Pending ask and permission requests per live session, via the session's own read-only queries. */
async function sessionRequests(node: NodeConfig, ids: string[]): Promise<Map<string, { counts?: { asks: number; permissions: number; gates: number }; errors: Array<{ source: string; code: string }> }>> {
	const out = new Map<string, { counts?: { asks: number; permissions: number; gates: number }; errors: Array<{ source: string; code: string }> }>();
	const targets = ids.filter((id) => SESSION_ID.test(id) || /^[0-9a-f-]{36}$/.test(id)).slice(0, STATE_QUERY_LIMIT);
	if (!targets.length) return out;
	const calls = targets.flatMap((id) => [
		["sdk", "session", "raw", "query", id, "--query", "ask.requests.list", "--json"],
		["sdk", "session", "raw", "query", id, "--query", "permission.requests.list", "--json"],
		["sdk", "session", "raw", "query", id, "--query", "workflow.gates.list", "--json"],
	]);
	const batch = gjcBatch(node, calls);
	let parts: string[] = [];
	let batchError: string | undefined;
	if (!batch) batchError = "query_unavailable";
	else try {
		const result = await run(batch.cmd, 25_000, batch.env);
		parts = result.stdout.split(BATCH_SEP).map((part) => part.trim());
		if (result.code !== 0) batchError = result.code === null ? "query_timeout" : "query_exit";
	} catch {
		batchError = "query_threw";
	}
	const count = (text: string | undefined, pick: (json: any) => unknown): { count?: number; code?: string } => {
		try {
			const json = JSON.parse(text ?? "");
			if (json?.ok !== true) {
				return { code: batchError ?? publicCommandError(json?.error?.code) };
			}
			if (batchError) return { code: batchError };
			const items = pick(json);
			return Array.isArray(items) ? { count: items.length } : { code: "query_malformed" };
		} catch {
			return { code: batchError ?? "query_malformed" };
		}
	};
	targets.forEach((id, index) => {
		const values = [count(parts[index * 3], (json) => json.page?.items), count(parts[index * 3 + 1], (json) => json.result?.requests), count(parts[index * 3 + 2], (json) => json.page?.items)];
		const sources = ["ask.requests.list", "permission.requests.list", "workflow.gates.list"];
		const errors = values.flatMap((value, i) => value.code ? [{ source: sources[i]!, code: value.code }] : []);
		const [asks, permissions, gates] = values.map((value) => value.count);
		// All three must parse; otherwise the session's state is unknown rather than guessed.
		out.set(id, { counts: asks !== undefined && permissions !== undefined && gates !== undefined ? { asks, permissions, gates } : undefined, errors });
	});
	return out;
}

export function sessionState(
	session: { live: boolean; activity?: string; lastHeartbeatAt?: number },
	requests: { asks: number; permissions: number; gates?: number } | undefined,
	now = Date.now(),
): { state: SessionState; pending?: number } {
	if (!session.live) return { state: "ended" };
	if (requests?.gates) return { state: "waiting_workflow", pending: requests.gates };
	if (requests?.asks) return { state: "waiting_answer", pending: requests.asks };
	if (requests?.permissions) return { state: "waiting_permission", pending: requests.permissions };
	if (session.lastHeartbeatAt && now - session.lastHeartbeatAt > HEARTBEAT_STALE_MS) return { state: "stale" };
	// Without a complete read of pending requests, neither "working" nor "idle" can be claimed.
	if (!requests) return { state: "unknown" };
	if (session.activity === "active") return { state: "working" };
	if (session.activity === "idle") return { state: "idle" };
	return { state: "unknown" };
}

/** How to run a fixed read-only shell command on the node's host (not through GJC). */
function hostShell(node: NodeConfig): { remote: boolean; argv: (command: string) => string[] } {
	const transport = node.sdkTransport ?? node.transport;
	if (transport.command !== "ssh") return { remote: false, argv: (command) => ["sh", "-c", command] };
	const head = ["ssh", ...transport.args.slice(0, -1)];
	const wsl = /^(wsl\.exe .*? -- )/i.exec(transport.args.at(-1) ?? "")?.[1] ?? "";
	return { remote: true, argv: (command) => [...head, wsl + command] };
}

function powershell(script: string): string {
	return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

/** First non-empty line, whitespace collapsed, capped. */
function headline(text: string | undefined, max = 110): string {
	const line = (text ?? "").split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Pull the first user text out of a (possibly truncated) transcript line. */
function promptFromTranscriptLine(line: string): string | undefined {
	const from = line.indexOf('"role":"user"');
	if (from < 0) return undefined;
	const match = /"(?:text|content)":"((?:[^"\\]|\\.)*)/.exec(line.slice(from));
	if (!match?.[1]) return undefined;
	let raw = match[1].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, "");
	try {
		raw = JSON.parse(`"${raw}"`);
	} catch {
		raw = raw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
	}
	return headline(raw) || undefined;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Read each session's first user prompt from the node's own transcript files.
 * GJC exposes no session title, so this is the only way to say what a session is doing.
 */
async function sessionTitles(node: NodeConfig, sessionIds: string[]): Promise<Map<string, string>> {
	const titles = new Map<string, string>();
	const ids = sessionIds.filter((id) => SESSION_ID.test(id));
	if (!ids.length) return titles;
	const shell = hostShell(node);
	let stdout = "";
	if (node.os === "win32") {
		if (!shell.remote) return titles;
		const script =
			`$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;` +
			`foreach($i in @(${ids.map((id) => `'${id}'`).join(",")})){` +
			`$f=Get-ChildItem "$env:USERPROFILE\\.gjc\\agent\\sessions\\*\\*_$i.jsonl" -ErrorAction SilentlyContinue|Select-Object -First 1;` +
			`if($f){$m=Select-String -LiteralPath $f.FullName -Pattern '"role":"user"' -SimpleMatch -List;` +
			`if($m){$l=$m.Line;if($l.Length -gt 900){$l=$l.Substring(0,900)};"_$i.jsonl:$l"}}}`;
		stdout = (await run(shell.argv(powershell(script)), 25000)).stdout;
	} else {
		const agentDir = node.sdkTransport?.args.find((arg) => arg.startsWith("GJC_CODING_AGENT_DIR="))?.slice("GJC_CODING_AGENT_DIR=".length);
		const root = agentDir && /^[\w./-]+$/.test(agentDir) ? agentDir : "$HOME/.gjc/agent";
		const globs = ids.map((id) => `${root}/sessions/*/*_${id}.jsonl`).join(" ");
		stdout = (await run(shell.argv(`grep -m1 -H '"role":"user"' ${globs} 2>/dev/null | cut -c1-1100; true`), 20000)).stdout;
	}
	for (const line of stdout.split("\n")) {
		const id = /_([0-9a-f-]{36})\.jsonl:/.exec(line)?.[1];
		const title = id ? promptFromTranscriptLine(line) : undefined;
		if (id && title) titles.set(id, title);
	}
	return titles;
}

/** Carried between probes of one node: the GJC version is re-read rarely, titles once per session. */
export interface ProbeCache {
	version?: string;
	versionAt?: number;
	titles: Map<string, string | null>;
}
const VERSION_TTL_MS = 60_000;

/**
 * Health observation of the Broker session list through the node's sdkTransport. `null` when it
 * cannot be observed without risking a Broker autostart (no or unguarded sdkTransport): not a failure.
 */
/** Whether the Broker session list of this node can ever be observed (a guarded sdkTransport). */
export function brokerSessionListObservable(node: NodeConfig): boolean {
	return gjcInvocation(node, ["sdk", "session", "list", "--scope", "all", "--attach-only", "--json"])?.guarded === true;
}
export async function probeBrokerSessionList(node: NodeConfig, timeoutMs = 20_000): Promise<boolean | null> {
	const list = gjcInvocation(node, ["sdk", "session", "list", "--scope", "all", "--attach-only", "--json"]);
	if (!list?.guarded) return null;
	try {
		const result = await run(list.cmd, timeoutMs, list.env);
		return result.code === 0 && parseSessions(result.stdout) !== undefined;
	} catch {
		return false;
	}
}

export async function probeNode(node: NodeConfig, cache: ProbeCache = { titles: new Map() }): Promise<NodeProbe> {
	const probe: NodeProbe = { nodeId: node.id, checkedAt: new Date().toISOString(), probed: false, ok: false };
	const version = gjcInvocation(node, ["--version"]);
	if (!version) {
		probe.error = "sdkTransport not configured";
		return probe;
	}
	probe.probed = true;
	const started = Date.now();
	if (cache.version && Date.now() - (cache.versionAt ?? 0) < VERSION_TTL_MS) {
		probe.ok = true;
		probe.version = cache.version;
	} else try {
		const result = await run(version.cmd, 12000, version.env);
		probe.elapsedMs = Date.now() - started;
		if (result.code !== 0 || !result.stdout) {
			probe.error = failure(result);
			return probe;
		}
		probe.ok = true;
		probe.version = result.stdout.split("\n").at(-1)?.trim();
		cache.version = probe.version;
		cache.versionAt = Date.now();
	} catch {
		probe.error = "spawn_failed";
		return probe;
	}
	const list = gjcInvocation(node, ["sdk", "session", "list", "--scope", "all", "--json"]);
	if (!list?.guarded) {
		probe.sessionsError = "cannot block broker auto-start — query skipped";
		return probe;
	}
	try {
		const result = await run(list.cmd, 20000, list.env);
		const sessions = result.code === 0 ? parseSessions(result.stdout) : undefined;
		if (!sessions) {
			probe.sessionsOk = false;
			probe.sessionsError =
				result.code === 0 ? "failed to parse response" : result.code === null ? failure(result) : (commandError(result.stdout) ?? failure(result));
			return probe;
		}
		const visible = sessions.filter((s) => !s.deleted);
		probe.sessionsOk = true;
		probe.totalSessions = visible.length;
		probe.liveSessions = visible.filter((s) => s.live).length;
		probe.sessions = visible
			.sort((a, b) => Number(b.live ?? false) - Number(a.live ?? false) || (b.lastHeartbeatAt ?? 0) - (a.lastHeartbeatAt ?? 0))
			.slice(0, SESSION_LIMIT)
			.map((s) => ({
				sessionId: s.sessionId,
				live: s.live === true,
				cwd: s.locator?.cwd,
				activity: s.activity?.state,
				lastHeartbeatAt: s.lastHeartbeatAt,
			}));
		const live = probe.sessions.filter((s) => s.live).map((s) => s.sessionId);
		const requests = await sessionRequests(node, live);
		const now = Date.now();
		for (const session of probe.sessions) {
			const { state, pending } = sessionState(
				session,
				requests.get(session.sessionId)?.counts ?? (session.live ? undefined : { asks: 0, permissions: 0, gates: 0 }),
				now,
			);
			session.state = state;
			const errors = requests.get(session.sessionId)?.errors;
			if (errors?.length) session.requestErrors = errors;
			if (pending) session.pending = pending;
		}
		try {
			const missing = probe.sessions.map((s) => s.sessionId).filter((id) => !cache.titles.has(id));
			if (missing.length) {
				const titles = await sessionTitles(node, missing);
				for (const id of missing) cache.titles.set(id, titles.get(id) ?? null);
			}
			for (const session of probe.sessions) session.title = cache.titles.get(session.sessionId) ?? undefined;
		} catch {}
	} catch {
		probe.sessionsOk = false;
		probe.sessionsError = "spawn_failed";
	}
	return probe;
}

function eventDetail(event: AuditEvent): string | undefined {
	const data = (event.data ?? {}) as Record<string, any>;
	switch (event.kind) {
		case "selection": {
			const skipped = Array.isArray(data.exclusions) ? data.exclusions.length : 0;
			return `${data.outcome ?? "?"}${data.nodeId ? ` → ${data.nodeId}` : ""}${skipped ? ` · excluded ${skipped}` : ""}${data.globalFull ? " · global limit reached" : ""}`;
		}
		case "reserved":
			return data.nodeId;
		case "operation_intent":
			return data.kind;
		case "session_recorded":
			return typeof data.sessionId === "string" ? data.sessionId.slice(0, 8) : undefined;
		case "turn_recorded":
			return typeof data.turnId === "string" ? data.turnId.slice(0, 13) : undefined;
		case "unknown":
			return [data.failure?.errorType, data.failure?.source].filter(Boolean).join(" · ") || undefined;
		case "progress_stalled":
		case "progress_recovered":
			return [data.verdict, typeof data.idleSeconds === "number" ? `${data.idleSeconds}s` : undefined].filter(Boolean).join(" · ") || undefined;
		case "abandoned_poll":
		case "stale_poll_failure": {
			const failure = (data.failure ?? {}) as Record<string, unknown>;
			const source = typeof failure.source === "string" ? failure.source : undefined;
			const code = typeof failure.errorType === "string" ? failure.errorType : typeof failure.code === "string" ? failure.code : undefined;
			return [source, code].filter(Boolean).join(" · ") || undefined;
		}
		case "daemon_note":
			return typeof data.note === "string" ? data.note : undefined;
		case "unknown_reconciled":
			return `${data.before} → ${data.after}`;
		case "blocked":
			return typeof data.reason === "string" ? data.reason : undefined;
		case "late_receipt_contradiction":
		case "late_receipt_accepted":
			return typeof data.status === "string" ? data.status : undefined;
		default:
			return undefined;
	}
}

/** Consecutive noise rows of these kinds collapse to one timeline entry with a count. */
const COLLAPSE_TIMELINE = new Set(["observation", "abandoned_poll", "stale_poll_failure"]);

/** Never forward arbitrary audit text or explain a legacy choice from its input or today's registry. */
function publicSelectionReason(data: Record<string, unknown>, assignedNode: string | undefined) {
	if (data.outcome === "selected" && assignedNode !== undefined && data.nodeId === assignedNode)
		return SELECTED_NODE_REASONS.find((code) => code === data.reason);
	if (data.outcome === "rejected" && assignedNode === undefined && data.nodeId === undefined &&
		(data.reason === "no_eligible_node" || data.reason === "global_capacity"))
		return data.reason;
	return undefined;
}

function projectTask(
	task: TaskState,
	events: AuditEvent[],
	resourceReturn: ResourceReturnStatus | undefined,
	options?: { timelineLimit?: number | null; includeSelectionReason?: boolean },
): DashboardTask {
	const placement = placementView(task);
	const stages: Array<string | null> = PIPELINE_STAGES.map(() => null);
	let stageIndex = -1;
	let selection: DashboardTask["selection"];
	const timeline: DashboardTask["timeline"] = [];
	const timelineLimit = options && "timelineLimit" in options ? options.timelineLimit : TIMELINE_LIMIT;
	for (const event of events) {
		const index = PIPELINE_STAGES.findIndex((stage) => (stage.kinds as readonly string[]).includes(event.kind));
		if (index >= 0) {
			stages[index] ??= event.at;
			stageIndex = Math.max(stageIndex, index);
		}
		if (event.kind === "selection") {
			const data = (event.data ?? {}) as Record<string, any>;
			const reason = options?.includeSelectionReason ? publicSelectionReason(data, task.nodeId) : undefined;
			selection = {
				outcome: data.outcome,
				nodeId: data.nodeId,
				globalFull: data.globalFull === true,
				...(reason !== undefined ? { reason } : {}),
				exclusions: Array.isArray(data.exclusions)
					? data.exclusions.map((x: any) => ({ nodeId: String(x.nodeId), reasons: Array.isArray(x.reasons) ? x.reasons.map(String) : [] }))
					: [],
			};
		}
		const last = timeline.at(-1);
		if (last && last.kind === event.kind && COLLAPSE_TIMELINE.has(event.kind)) {
			last.count = (last.count ?? 1) + 1;
			last.at = event.at;
			// Keep the newest readable detail so a collapsed poll burst still shows the latest failure code.
			const detail = eventDetail(event);
			if (detail) last.detail = detail;
		} else {
			timeline.push({ at: event.at, kind: event.kind, detail: eventDetail(event) });
		}
	}
	let timelineOmitted = 0;
	if (timelineLimit != null && timeline.length > timelineLimit) {
		timelineOmitted = timeline.length - timelineLimit;
		timeline.splice(0, timelineOmitted);
	}
	return {
		id: task.id,
		key: task.input.key,
		title: headline(task.input.prompt),
		caller: task.input.caller,
		phase: task.phase,
		attention: dashboardTaskAttention(task.phase, {
			executionTerminal: task.result?.executionTerminal === true,
			exportReview: exportReviewPending(task.result),
			receiptConflict: !!task.result?.lateReceipt && !task.result.lateReceipt.acceptance,
			resultSaved: stageIndex >= RESULT_STAGE_INDEX,
			unplaceable: placement?.verdict === "unplaceable",
		}),
		nodeId: task.nodeId,
		held: task.held,
		executionTerminal: task.result?.executionTerminal === true,
		reason: task.reason,
		archivedFrom: task.archivedFrom,
		archivedAt: task.archivedAt,
		...(task.disposition ? { disposition: dispositionSummary(task.disposition) } : {}),
		resultStatus: task.result?.status,
		outcome: executionOutcome(task),
		verified: task.result?.verified,
		...(task.result?.settlement ? { settlement: publicSettlement(task.result.settlement) } : {}),
		...(task.result?.lateReceipt ? { lateReceipt: publicLateReceipt(task.result.lateReceipt) } : {}),
		...(task.result?.exportIncomplete ? { exportReview: task.result.exportIncomplete.acceptance ? "accepted" as const : "required" as const } : {}),
		sessionId: task.sessionId,
		turnId: task.turnId,
		// Only while the task is in a progress phase: a settled task's record is a frozen last read.
		...(task.progress && progressShown(task) ? { progress: dashboardProgress(task.progress, Date.now()) } : {}),
		...(resourceReturn ? { resourceReturn } : {}),
		required: task.input.required ?? {},
		preferences: task.input.preferences ?? [],
		stages,
		stageIndex,
		submittedAt: events[0]?.at,
		// An audit-only return refusal is not task progress: it never moves the task's last event.
		lastEventAt: events.filter((event) => event.kind !== "resource_return_refused").at(-1)?.at,
		selection,
		...(placement
			? {
					placement: {
						verdict: placement.verdict,
						since: placement.since,
						checkedAt: placement.checkedAt,
						rejections: placement.rejections,
						nodes: placement.nodes,
						summary: placement.summary,
						blocking: placement.blocking.map((row) => ({ nodeId: row.nodeId, reasons: row.reasons, structural: row.reasons.filter((reason) => reasonClass(reason) === "structural") })),
					},
				}
			: {}),
		...(task.withdrawal ? { withdrawal: { actor: task.withdrawal.actor, reason: task.withdrawal.reason, at: task.withdrawal.at } } : {}),
		timeline,
		...(timelineOmitted > 0 ? { timelineOmitted } : {}),
	};
}

/** One fully projected task (collapsed timeline, unbound) for on-demand card detail. */
export function getDashboardTask(store: FleetStore, taskId: string): DashboardTask | null {
	const task = store.taskState(taskId);
	if (!task) return null;
	const returns = store.resourceReturnStatuses([task]);
	return projectTask(task, store.events(taskId), returns.get(taskId), { timelineLimit: null, includeSelectionReason: true });
}

export function getDashboardState(
	store: FleetStore,
	gjcStatus?: GjcRuntimeStatus,
	probes: ReadonlyMap<string, NodeProbe> = new Map(),
	resources?: (nodeId: string) => NodeResources | undefined,
	health?: NodeHealthHistory,
	sshEvidence?: (node: NodeConfig) => DashboardSshEvidence | undefined,
): DashboardState {
	// Switch off: nothing is observed or recorded, so nothing is shown; the state equals the state
	// without node health (no nodeHealth, no nodes[].health; review 09e80a06 F1).
	const gating = health && store.nodeHealthGating().enabled ? gatingView(store) : undefined;
	const allTasks = store.taskStates();
	const allNodes = store.nodes();
	// One grouped audit read for all tasks (audit has no task_id index: a per-task read is a full scan each).
	const events = store.eventsByTask();
	const returns = store.resourceReturnStatuses(allTasks);
	const projected = allTasks.map((task) => projectTask(task, events.get(task.id) ?? [], returns.get(task.id)));
	projected.sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? ""));
	const visible = projected.filter((task) => task.phase !== "archived");
	const archived = projected.filter((task) => task.phase === "archived");

	const sessionOwner = new Map<string, DashboardTask>();
	for (const task of projected) if (task.sessionId) sessionOwner.set(task.sessionId, task);

	// Same rule the CLI applies at submit time, evaluated on the live stream sample.
	const now = Date.now();
	const held = resources ? store.heldCharges(allTasks) : new Map<string, HeldCharge[]>();
	const admissionView = (n: (typeof allNodes)[number], latest: NodeResources | null) => {
		if (!resources) return null;
		const reasons = [
			...(!n.enabled ? ["disabled"] : []),
			...(n.draining ? ["draining"] : []),
			...(!n.reachable ? ["unreachable"] : []),
			...(!n.sdkReady ? ["sdk_not_ready"] : []),
			...(!n.modelReady ? ["model_not_ready"] : []),
			...resourceReasons(
				n.workspaceRoot,
				latest ? { ...latest, at: latest.sampledAt ?? Number.NaN } : undefined,
				unmeasuredTasks(held.get(n.id), latest?.sampledAt),
				now,
			),
		];
		return { open: reasons.length === 0, reasons };
	};

	const conditions: ReturnType<typeof dashboardNodeCondition>[] = [];
	const healthObservations: (number | undefined)[] = [];
	const nodes: DashboardNode[] = allNodes.map((n) => {
		const mine = projected.filter((t) => t.nodeId === n.id);
		const exclusions: Record<string, number> = {};
		for (const task of projected)
			for (const skipped of task.selection?.exclusions ?? [])
				if (skipped.nodeId === n.id) for (const reason of skipped.reasons) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
		const raw = probes.get(n.id);
		const probe: NodeProbe | null = raw
			? {
					...raw,
					sessions: raw.sessions?.map((s) => {
						const owner = sessionOwner.get(s.sessionId);
						return owner ? { ...s, taskId: owner.id, taskKey: owner.key, taskTitle: owner.title, ...(owner.progress ? { progress: owner.progress } : {}) } : s;
					}),
				}
			: null;
		const latest = resources?.(n.id) ?? null;
		const observation = health && gating ? health.dimensions(n.id) : undefined;
		if (gating && n.enabled) healthObservations.push(observation?.latest?.at);
		const condition = dashboardNodeCondition(n.id, mine, probe, latest, observation?.latest, {
			now, controlMs: HEALTH_OBSERVE_MS * 3, resourceMs: SAMPLE_STALE_MS, heartbeatMs: HEARTBEAT_STALE_MS,
		});
		conditions.push(condition);
		return {
			id: n.id,
			os: n.os,
			arch: n.arch,
			enabled: n.enabled,
			draining: n.draining,
			reachable: n.reachable,
			sdkReady: n.sdkReady,
			modelReady: n.modelReady,
			currentLoad: mine.filter((t) => t.held && RUNNING.includes(t.phase)).length,
			heldNotRunning: mine.filter((t) => t.held && !RUNNING.includes(t.phase)).length,
			admission: admissionView(n, latest),
			modelProfiles: n.modelProfiles ?? [],
			operations: n.operations ?? [],
			holding: mine.filter((t) => t.held).map((t) => ({ id: t.id, key: t.key, phase: t.phase, executionTerminal: t.executionTerminal })),
			possiblyRunning: mine.flatMap((t) =>
				t.resourceReturn?.state === "released_by_operator_unconfirmed"
					? [{ id: t.id, key: t.key, sessionId: t.resourceReturn.sessionId, operator: t.resourceReturn.operator, reason: t.resourceReturn.reason, at: t.resourceReturn.at }]
					: [],
			),
			assignedTotal: mine.length,
			succeeded: mine.filter((t) => t.phase === "succeeded").length,
			troubled: mine.filter((t) => TROUBLE.includes(t.phase)).length,
			exclusions,
			probe,
			resources: latest,
			status: condition.status,
			tasksAtRisk: condition.tasksAtRisk,
			...(observation && gating ? { health: nodeHealthView(observation, n, gating.gating, now) } : {}),
		};
	});

	const provisional = (t: { phase: Phase; result?: TaskRecord["result"] }) => t.phase === "completed_unverified" && t.result?.executionTerminal !== true;
	const inFlight = (t: DashboardTask) => RUNNING.includes(t.phase) || t.phase === "queued" || t.phase === "approval_required";
	const unsettled = allTasks.filter(provisional).length;
	const count = (phases: Phase[]) => allTasks.filter((t) => phases.includes(t.phase)).length;
	const daemon = store.daemonStatus(now);
	const lease = dashboardHubLease(daemon, now);
	// An incomplete export awaiting operator acceptance is its own outcome, not plain "unverified".
	const awaitingReview = (t: TaskRecord) => t.phase === "completed_unverified" && exportReviewPending(t.result);
	const exportIncomplete = allTasks.filter(awaitingReview).length;
	// Timelines are deferred for every live card (expand loads `/api/task/:id`), so listing every
	// visible + archived card stays cheap and nothing important is sliced out of the UI.
	const listed = { tasks: visible, omitted: 0 };
	const listedTasks = listed.tasks.map(deferHeavyTimeline);
	const archivedListed = archived.map(deferHeavyTimeline);
	// Work-unit Step 1: switch not on ⇒ the very same object; on ⇒ `deliverable` fields and report counts.
	return withDeliverables(store, allTasks, {
		generatedAt: new Date().toISOString(),
		live: resources !== undefined,
		summary: {
			overall: dashboardOverall(conditions, lease),
			totalNodes: allNodes.length,
			healthyNodes: allNodes.filter((n) => n.enabled && n.reachable && n.sdkReady && n.modelReady && !n.draining).length,
			activeTasks: count(RUNNING),
			unsettledTasks: unsettled,
			provisionalTasks: allTasks.filter((t) => provisional(t) && t.reason !== EXECUTION_FAILURE_REPORTED).length,
			failureReportedTasks: allTasks.filter((t) => provisional(t) && t.reason === EXECUTION_FAILURE_REPORTED).length,
			queuedTasks: count(["queued"]),
			unplaceableTasks: allTasks.filter((t) => shownPlacement(t)?.verdict === "unplaceable").length,
			succeededTasks: count(["succeeded"]),
			exportIncompleteTasks: exportIncomplete,
			failedTasks: count(TROUBLE),
			heldTasks: allTasks.filter((t) => t.held).length,
			openNodes: resources ? nodes.filter((n) => n.admission?.open).length : null,
			totalTasks: allTasks.length,
			listedTasks: listedTasks.length,
			omittedTasks: listed.omitted,
			listedArchived: archivedListed.length,
			omittedArchived: Math.max(0, archived.length - archivedListed.length),
		},
		pipeline: {
			stages: PIPELINE_STAGES.map((stage, index) => ({
				key: stage.key,
				label: stage.label,
				inFlight: visible.filter((t) => inFlight(t) && t.stageIndex === index).length,
				reached: visible.filter((t) => t.stages[index] !== null).length,
			})),
			outcome: (() => {
				const terminalUnverified = projected.filter(
					// An incomplete export awaiting operator acceptance is its own outcome (exportIncomplete), not verify-wait or result-missing.
					(t) => t.phase === "completed_unverified" && t.executionTerminal && t.exportReview !== "required",
				);
				return {
					succeeded: count(["succeeded"]),
					unverified: terminalUnverified.filter((t) => t.stageIndex >= RESULT_STAGE_INDEX).length,
					resultMissing: terminalUnverified.filter((t) => t.stageIndex < RESULT_STAGE_INDEX).length,
					unsettled,
					...(exportIncomplete ? { exportIncomplete } : {}),
					troubled: count(TROUBLE),
					cancelled: count(["cancelled"]),
					approval: count(["approval_required"]),
				};
			})(),
		},
		gjcRuntime: gjcStatus ?? { installed: false, lastCheckedAt: new Date().toISOString() },
		nodes,
		sshLinks: dashboardSshLinks(allNodes, sshEvidence),
		tasks: listedTasks,
		archivedTasks: archivedListed,
		...(daemon ? { daemon } : {}),
		hub: { lease },
		...(gating ? { nodeHealth: gating, health: { gating: gating.gating, freshness: dashboardHealthFreshness(healthObservations, now, HEALTH_OBSERVE_MS * 3) } } : {}),
	});
}

const SAMPLE_MS = 2_000;
/**
 * POSIX nodes: the remote loop takes one sample per line the hub writes and quits after this many
 * silent seconds, so it always ends itself after a disconnect.
 */
const TICK_TIMEOUT_SECONDS = 15;
/** Re-send a tick when a sample has not come back, well inside the remote timeout. */
const TICK_RETRY_MS = 8_000;
/** Backstop for a Windows loop whose session watch somehow fails; the hub simply reconnects. */
const WINDOWS_LIFETIME_SECONDS = 600;
/** A sample older than this means the stream stalled even though the process is still there. */
const SAMPLE_STALE_MS = 12_000;
/**
 * A stream with no sample for this long is killed so the normal reconnect path replaces it. A
 * paused/hibernated host can leave the SSH session open while the remote loop is frozen; without
 * this the hub kept that silent process forever and the node stayed resources_unknown.
 */
const STREAM_STALL_MS = 45_000;
/** How long a stopped stream process gets after SIGTERM before it is sent SIGKILL. */
const STOP_KILL_GRACE_MS = 1_000;
/** Drain final stdout after the direct transport exits, but do not wait for inherited pipe EOF. */
const STREAM_EXIT_DRAIN_MS = 250;

const LINUX_STREAM = `n=$(grep -c '^cpu[0-9]' /proc/stat)
p=$(LC_ALL=C lscpu -p=SOCKET,CORE 2>/dev/null | awk '!/^#/ && !seen[$0]++ {n++} END{print n+0}')
while read -r -t ${TICK_TIMEOUT_SECONDS} _; do
set -- $(head -1 /proc/stat)
idle=$(( $5 + $6 )); total=$(( $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9 ))
mem=$(awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}END{print t, a}' /proc/meminfo)
mi=$(awk 'BEGIN{b=-1}/^Balloon:/{b=$2}END{print b}' /proc/meminfo)
disk=$(df -kP | awk 'NR>1 && index($1,"/dev/")==1 && index($1,"loop")==0 && $2>=1048576 {m=$6; for(i=7;i<=NF;i++) m=m" "$i; if(index(m,"/boot")==1 || index(m,"/usr/src")==1) next; printf "|%s %s %s", $2, $4, m}')
load=$(cut -d' ' -f1 /proc/loadavg)
echo "L $n $load $idle $total $mem $p $mi$disk" || exit 0
done
`;

// APFS volumes share one container, so the user data volume stands for "/"; external volumes follow.
// Volumes under 1GB (mounted installers) and ones sharing a listed container's space (Recovery) are skipped.
// Absolute /usr/sbin for sysctl/iostat only: macOS agent PATH may omit /usr/sbin, which yields
// empty D-line fields that parseResourceLine rejects → resources_unknown timeouts.
const DARWIN_STREAM = `n=$(/usr/sbin/sysctl -n hw.logicalcpu); p=$(/usr/sbin/sysctl -n hw.physicalcpu); m=$(/usr/sbin/sysctl -n hw.memsize)
while read -r -t ${TICK_TIMEOUT_SECONDS} _; do
load=$(/usr/sbin/sysctl -n vm.loadavg | awk '{print $2}')
idle=$(/usr/sbin/iostat -n 0 -c 2 -w 1 | awk 'END{print $3}')
avail=$(vm_stat | awk '/page size of/{p=$8}/^Pages (free|inactive|speculative)/{gsub(/[.]/,"",$NF); s+=$NF}END{printf "%.0f", s*p}')
disk=$(df -kP | awk 'NR>1 && index($1,"/dev/")==1 {m=$6; for(i=7;i<=NF;i++) m=m" "$i; if(m=="/System/Volumes/Data") m="/"; else if(index(m,"/Volumes/")!=1) next; if($2<1048576 || seen[$2" "$4]++) next; printf "|%s %s %s", $2, $4, m}')
echo "D $n $load $m $avail $p $idle$disk" || exit 0
done
`;

/**
 * Windows cannot be tick-driven: powershell.exe swallows redirected stdin, and Windows sshd neither
 * closes pipes nor kills children on disconnect. The loop instead watches the sshd session process
 * that launched it (parent of its cmd.exe) and quits when that is gone, with a lifetime cap as backstop.
 */
const WINDOWS_STREAM =
	`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';` +
	`$me=Get-CimInstance Win32_Process -Filter "ProcessId=$PID";` +
	`$par=Get-CimInstance Win32_Process -Filter "ProcessId=$($me.ParentProcessId)";` +
	`$g=Get-CimInstance Win32_Process -Filter "ProcessId=$($par.ParentProcessId)";` +
	`if(-not $g -or $g.Name -ne 'sshd.exe'){[Console]::Out.WriteLine('E no-sshd-session');exit};` +
	`$gid=$g.ProcessId;$gc=$g.CreationDate;$end=(Get-Date).AddSeconds(${WINDOWS_LIFETIME_SECONDS});` +
	`$procs=Get-CimInstance Win32_Processor;$n=($procs|Measure-Object NumberOfLogicalProcessors -Sum).Sum;$p=($procs|Measure-Object NumberOfCores -Sum).Sum;` +
	`while((Get-Date) -lt $end){$q=Get-CimInstance Win32_Process -Filter "ProcessId=$gid";if(-not $q -or $q.CreationDate -ne $gc){exit};` +
	`$o=Get-CimInstance Win32_OperatingSystem;` +
	`$c=(Get-CimInstance Win32_Processor|Measure-Object LoadPercentage -Average).Average;` +
	`$d=(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"|ForEach-Object{"|$($_.Size) $($_.FreeSpace) $($_.DeviceID)"}) -join '';` +
	`[Console]::Out.WriteLine("W $n $c $($o.TotalVisibleMemorySize) $($o.FreePhysicalMemory) $p$d");` +
	`[Console]::Out.Flush();Start-Sleep -Milliseconds ${SAMPLE_MS}}`;

/**
 * Linux memory from /proc/meminfo (KiB): MemTotal, MemAvailable and the kernel's own `Balloon:` line
 * (-1/NaN when the kernel does not report it). Only the reported balloon is split out; memory merely
 * unaccounted for by other categories is not guessed to be a balloon.
 */
export function linuxMemory(totalKiB: number, availableKiB: number, balloonKiB: number) {
	const reclaimedKiB = Number.isFinite(balloonKiB) && balloonKiB > 0 && balloonKiB < totalKiB ? balloonKiB : 0;
	return {
		memTotal: totalKiB * 1024,
		memUsed: Math.max(0, totalKiB - availableKiB - reclaimedKiB) * 1024,
		...(reclaimedKiB ? { memReclaimed: reclaimedKiB * 1024 } : {}),
	};
}

/**
 * Parse one stream line: space-separated counters, then one `|total free path` entry per partition.
 * `previous` carries Linux CPU counters so busy percent is a real delta.
 */
export function parseResourceLine(
	line: string,
	previous: { idle: number; total: number } | undefined,
): { resources: NodeResources; counters?: { idle: number; total: number } } | undefined {
	const [head = "", ...diskParts] = line.trim().split("|");
	const parts = head.trim().split(/\s+/);
	const num = (index: number) => Number(parts[index]);
	const disks = (unit: number) =>
		diskParts.flatMap((part) => {
			const match = /^(\d+) (\d+) (.+)$/.exec(part.trim());
			if (!match) return [];
			const total = Number(match[1]) * unit;
			return total > 0 ? [{ path: match[3]!, total, used: total - Number(match[2]) * unit }] : [];
		});
	if (parts[0] === "L" && parts.length >= 7) {
		const cores = num(1);
		const load1 = num(2);
		const counters = { idle: num(3), total: num(4) };
		const span = previous ? counters.total - previous.total : 0;
		// Only a real /proc/stat delta counts; the first sample has none, so CPU stays unmeasured.
		const cpuPct = span > 0 ? (1 - (counters.idle - previous!.idle) / span) * 100 : undefined;
		return {
			counters,
			resources: { ok: true, cores, threads: cores, physicalCores: num(7) > 0 ? num(7) : undefined, load1, cpuPct, ...linuxMemory(num(5), num(6), parts.length >= 9 ? num(8) : Number.NaN), disks: disks(1024) },
		};
	}
	if (parts[0] === "D" && parts.length >= 5) {
		const cores = num(1);
		const load1 = num(2);
		return {
			resources: {
				ok: true,
				cores,
				threads: cores,
				physicalCores: num(5) > 0 ? num(5) : undefined,
				load1,
				cpuPct: parts.length >= 7 && Number.isFinite(num(6)) && num(6) >= 0 && num(6) <= 100 ? 100 - num(6) : undefined,
				memTotal: num(3),
				memUsed: num(3) - num(4),
				disks: disks(1024),
			},
		};
	}
	if (parts[0] === "W" && parts.length >= 5) {
		return {
			resources: { ok: true, cores: num(1), threads: num(1), physicalCores: num(5) > 0 ? num(5) : undefined, cpuPct: num(2), memTotal: num(3) * 1024, memUsed: (num(3) - num(4)) * 1024, disks: disks(1) },
		};
	}
	return undefined;
}

/** Exported for contract tests: the hub must ship PATH-independent Darwin tooling. */
export function streamCommand(node: NodeConfig): { argv: string[]; script?: string } | undefined {
	const shell = hostShell(node);
	const keepalive = (argv: string[]) =>
		argv[0] === "ssh" ? ["ssh", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", ...argv.slice(1)] : argv;
	if (node.os === "win32") return shell.remote ? { argv: keepalive(shell.argv(powershell(WINDOWS_STREAM))) } : undefined;
	// bash, not sh: the loop needs `read -t` to end itself when ticks stop.
	if (node.os === "linux") return { argv: keepalive(shell.argv("bash -s")), script: LINUX_STREAM };
	if (node.os === "darwin") return { argv: keepalive(shell.argv("bash -s")), script: DARWIN_STREAM };
	return undefined;
}

export interface ResourceStreams {
	/** No new traffic: evidence from the existing SSH-backed resource stream. */
	sshEvidence(node: NodeConfig): DashboardSshEvidence | undefined;
	/** Latest measurement per node; a stalled or dead stream reports ok:false instead of an old value. */
	latest(nodeId: string): NodeResources | undefined;
	stop(): void;
}

/**
 * Keep one long-lived process per node that prints a resource sample per hub tick.
 * Remote nodes use the SSH destination they are registered with; nothing is installed on the node
 * and the remote loop ends on EOF or when ticks stop.
 */
export function startResourceStreams(
	nodes: () => NodeConfig[],
	onSample: (nodeId: string, resources: NodeResources) => void,
	options: { stallMs?: number; command?: (node: NodeConfig) => { argv: string[]; script?: string } | undefined } = {},
): ResourceStreams {
	const stallMs = options.stallMs ?? STREAM_STALL_MS;
	const commandFor = options.command ?? streamCommand;
	interface Entry {
		proc?: any;
		resources?: NodeResources;
		at: number;
		ssh?: { checkedAt: string; receivedAt: number; route: string };
		failures: number;
		timer?: ReturnType<typeof setTimeout>;
		/** Ends everything the current launch started: ticker, pipes, readers and the process. */
		release?: () => void;
	}
	const entries = new Map<string, Entry>();
	let stopped = false;

	const publish = (nodeId: string, entry: Entry, resources: NodeResources) => {
		entry.resources = resources;
		entry.at = Date.now();
		onSample(nodeId, resources);
	};

	const launch = (nodeId: string) => {
		const entry = entries.get(nodeId);
		const node = nodes().find((candidate) => candidate.id === nodeId);
		if (stopped || !entry || !node) return;
		const command = commandFor(node);
		const sshRoute = options.command === undefined && command?.argv[0] === "ssh" ? dashboardSshRoute(node) : undefined;
		if (!command) {
			publish(nodeId, entry, { ok: false, error: "resource_stream_refused" });
			return;
		}
		let proc: any;
		try {
			proc = spawnTrusted(command.argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
		} catch {
			publish(nodeId, entry, { ok: false, error: "resource_stream_disconnected" });
			return;
		}
		entry.proc = proc;
		// One tick per answered sample, so a slow node is never sent a backlog it would keep working through.
		let lastTick = 0;
		let awaiting = false;
		let lastOutput = Date.now();
		let stalled = false;
		let ioClosed = false;
		let exitDrain: ReturnType<typeof setTimeout> | undefined;
		const stdoutReader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
		const stderrReader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
		const closeIO = () => {
			if (ioClosed) return;
			ioClosed = true;
			clearInterval(ticker);
			if (exitDrain) clearTimeout(exitDrain);
			try {
				proc.stdin.end();
			} catch {}
			// An SSH ControlPersist process may own inherited pipe writers. Close our ends
			// instead of signalling the process group or waiting for those writers to leave.
			void stdoutReader.cancel().catch(() => {});
			void stderrReader.cancel().catch(() => {});
		};
		const tick = () => {
			if (ioClosed) return;
			const now = Date.now();
			if (now - lastOutput > stallMs) {
				// A frozen transport must not block reconnect on stdout EOF or ignore SIGTERM.
				stalled = true;
				closeIO();
				try {
					proc.kill("SIGKILL");
				} catch {}
				return;
			}
			if (!command.script) return; // Windows loops sample on their own; only the watchdog applies.
			if (now - lastTick < SAMPLE_MS || (awaiting && now - lastTick < TICK_RETRY_MS)) return;
			lastTick = now;
			awaiting = true;
			try {
				proc.stdin.write("\n");
				proc.stdin.flush();
			} catch {}
		};
		const ticker = setInterval(tick, 250);
		if (command.script) {
			try {
				proc.stdin.write(command.script);
			} catch {}
		}
		tick();
		void proc.exited.then(() => {
			clearInterval(ticker);
			if (!ioClosed) exitDrain = setTimeout(closeIO, STREAM_EXIT_DRAIN_MS);
		});
		// Drain stderr without retaining its unused contents.
		void (async () => {
			try {
				while (!(await stderrReader.read()).done) {}
			} catch {}
		})();
		entry.release = () => {
			closeIO();
			// Hub stop / process exit: SIGKILL immediately. setTimeout grace cannot run on `exit`, and a
			// child that traps SIGTERM would otherwise outlive the hub. Per-node reconcile drops keep the grace.
			if (stopped) {
				try {
					proc.kill("SIGKILL");
				} catch {}
			} else {
				try {
					proc.kill();
				} catch {}
				const escalate = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}, STOP_KILL_GRACE_MS);
				proc.exited.then(() => clearTimeout(escalate));
			}
		};
		void (async () => {
			let counters: { idle: number; total: number } | undefined;
			let sampled = false;
			let buffer = "";
			const decoder = new TextDecoder();
			try {
				for (let read = await stdoutReader.read(); !read.done && !ioClosed; read = await stdoutReader.read()) {
					if (stopped || entries.get(nodeId) !== entry || entry.proc !== proc) return;
					lastOutput = Date.now();
					buffer += decoder.decode(read.value, { stream: true });
					let newline = buffer.indexOf("\n");
					while (newline >= 0 && !ioClosed) {
						const line = buffer.slice(0, newline).trim();
						const parsed = parseResourceLine(line, counters);
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
						if (line.startsWith("E ")) publish(nodeId, entry, { ok: false, error: "resource_stream_refused" });
						if (!parsed) continue;
						counters = parsed.counters;
						awaiting = false;
						sampled = true;
						entry.failures = 0;
						if (sshRoute !== undefined && parsed.resources.ok) entry.ssh = { checkedAt: new Date().toISOString(), receivedAt: performance.now(), route: sshRoute };
						publish(nodeId, entry, parsed.resources);
					}
				}
			} catch {}
			await proc.exited;
			closeIO();
			if (stopped || entries.get(nodeId) !== entry || entry.proc !== proc) return;
			if (!stalled && proc.exitCode === 0 && sampled) {
				// Planned end (lifetime cap): reconnect at once; the stale check covers the gap.
				launch(nodeId);
				return;
			}
			publish(nodeId, entry, { ok: false, error: "resource_stream_disconnected" });
			entry.failures += 1;
			entry.timer = setTimeout(() => launch(nodeId), Math.min(30_000, 2_000 * 2 ** Math.min(entry.failures - 1, 4)));
		})();
	};

	const drop = (entry: Entry) => {
		if (entry.timer) clearTimeout(entry.timer);
		const release = entry.release;
		entry.proc = undefined;
		entry.release = undefined;
		release?.();
	};

	const reconcile = () => {
		if (stopped) return;
		const ids = new Set(nodes().map((node) => node.id));
		for (const [id, entry] of entries)
			if (!ids.has(id)) {
				drop(entry);
				entries.delete(id);
			}
		for (const id of ids)
			if (!entries.has(id)) {
				entries.set(id, { at: 0, failures: 0 });
				launch(id);
			}
	};
	reconcile();
	const reconcileTimer = setInterval(reconcile, 15_000);
	const onSignal = () => {
		stop();
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		clearInterval(reconcileTimer);
		process.off("exit", stop);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		for (const entry of entries.values()) drop(entry);
		entries.clear();
	};
	// `exit` alone is not enough for a trapped-SIGTERM child (grace timers never run). Eager stop on
	// hub signals matches #53 option 2; release then SIGKILLs immediately because `stopped` is set.
	process.once("exit", stop);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	return {
		sshEvidence(node) {
			const entry = entries.get(node.id);
			return dashboardSshEvidence(node, entry?.ssh, entry?.resources?.ok === true, performance.now(), SAMPLE_STALE_MS);
		},
		latest(nodeId) {
			const entry = entries.get(nodeId);
			if (!entry?.resources) return undefined;
			const age = Date.now() - entry.at;
			if (entry.resources.ok && age > SAMPLE_STALE_MS)
				return { ok: false, error: `Stream delayed · last value ${Math.round(age / 1000)}s ago` };
			return { ...entry.resources, sampledAt: entry.at };
		},
		stop,
	};
}

export function renderDashboardHtml(): string {
	return DASHBOARD_HTML;
}

const RUNTIME_TTL_MS = 10_000;
/** Session list and per-session state refresh; version and titles are cached separately. */
const NODE_PROBE_TTL_MS = 3_000;
/**
 * Windows brokers have twice left their session-index lock wedged ("uncertain_after_send") under
 * frequent listing, so Windows nodes are probed less often.
 */
const WINDOWS_PROBE_TTL_MS = 15_000;
/**
 * Node-health producer cadence. Below the 30 s spacing, so tick jitter never costs a count:
 * every second probe proves spacing (default policy: stable 80 s after the first good probe,
 * 160 s after a failure). Less often than the Windows session-list probe above.
 */
export const HEALTH_OBSERVE_MS = 20_000;

/** Serve a stale value immediately and refresh in the background, so a request never waits on SSH. */
function background<T>(ttlMs: number, load: () => Promise<T>): () => T | undefined {
	let value: T | undefined;
	let loadedAt = 0;
	let inflight = false;
	return () => {
		if (!inflight && Date.now() - loadedAt >= ttlMs) {
			inflight = true;
			load()
				.then((next) => {
					value = next;
				})
				.catch(() => {})
				.finally(() => {
					loadedAt = Date.now();
					inflight = false;
				});
		}
		return value;
	};
}

/**
 * Timer source for the 2 s push loop. Tests inject a manually driven tick so push assertions never
 * wait on real time; production uses the global setInterval/clearInterval.
 */
export interface DashboardPushTimer {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

/**
 * WebSocket upgrades must be same-origin with the page Host, or (Origin omitted) only when the
 * server itself is bound to loopback. A missing Origin check would let a remote page open `/ws`
 * against a non-loopback bind and receive live fleet state.
 */
export function dashboardWsOriginAllowed(req: Request, bindHostname: string): boolean {
	const origin = req.headers.get("origin");
	if (!origin) {
		return bindHostname === "127.0.0.1" || bindHostname === "::1" || bindHostname === "localhost";
	}
	let parsed: URL;
	try {
		parsed = new URL(origin);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	const host = req.headers.get("host");
	if (!host || parsed.host !== host) return false;
	// Scheme must match the request URL (http vs https); host-only match is not same-origin.
	return parsed.protocol === new URL(req.url).protocol;
}

export function startDashboardServer(
	store: FleetStore,
	port = 8080,
	hostname = "127.0.0.1",
	options: { probeNodes?: boolean; healthHistory?: NodeHealthHistory; pushTimer?: DashboardPushTimer } = {},
) {
	const runtime = background(RUNTIME_TTL_MS, probeGjcRuntime);
	// One loader per node, so a slow host never delays the others' results.
	const loaders = new Map<string, () => NodeProbe | undefined>();
	const probes = (): Map<string, NodeProbe> => {
		const current = new Map<string, NodeProbe>();
		for (const node of store.nodes()) {
			if (options.probeNodes === false) {
				current.set(node.id, { nodeId: node.id, checkedAt: new Date().toISOString(), probed: false, ok: false, error: "Sampling off (--no-probe)" });
				continue;
			}
			let loader = loaders.get(node.id);
			if (!loader) {
				const cache: ProbeCache = { titles: new Map() };
				loader = background(node.os === "win32" ? WINDOWS_PROBE_TTL_MS : NODE_PROBE_TTL_MS, () => probeNode(store.nodes().find((n) => n.id === node.id) ?? node, cache));
				loaders.set(node.id, loader);
			}
			const probe = loader();
			if (probe) current.set(node.id, probe);
		}
		return current;
	};
	const live = options.probeNodes !== false;
	const TOPIC = "fleet";
	let server: any;
	const health = options.healthHistory;
	// Stream samples stamped on receipt with the history's monotonic clock: the producer's only
	// resource success evidence (their age is judged by that clock, never by wall time).
	const evidence = new Map<string, { sample: ResourceSample; mono: number }>();
	const streams = live
		? startResourceStreams(
				() => store.nodes(),
				(nodeId, resources) => {
					if (health) evidence.set(nodeId, health.stampSample({ ...resources, at: Date.now() } as ResourceSample));
					server?.publish(TOPIC, JSON.stringify({ type: "resources", nodeId, resources }));
				},
			)
		: undefined;
	// The long-lived hub producer: one real probe per enabled node every HEALTH_OBSERVE_MS, never
	// overlapping. It runs only while the stored selection gating switch is on: each tick re-reads it,
	// and once it reads off (or cannot be read) the producer stops without probing, recording or
	// scheduling again.
	let healthTimer: ReturnType<typeof setTimeout> | undefined;
	let healthStopped = false;
	const observeHealth = async () => {
		let on = false;
		try {
			on = store.nodeHealthGating().enabled;
			if (!on) return;
			const { observeNodeHealth } = await import("./node-health-gate");
			health!.retainNodes(store.nodes().map((node) => node.id));
			await observeNodeHealth(store.nodes(), health!, { resourceEvidence: (nodeId) => evidence.get(nodeId) });
		} catch (error) {
			// Fixed code and error class only (deny-by-default, docs/failure-diagnostics.md): no error text.
			console.error(JSON.stringify({ ok: false, error: "node_health_observe_failed", errorClass: diagnosticErrorClass(error) }));
		}
		if (on && !healthStopped) healthTimer = setTimeout(observeHealth, HEALTH_OBSERVE_MS);
	};
	// A read-only view (ui --read-only) only displays; it never probes or records.
	if (live && health && !health.readOnly) healthTimer = setTimeout(observeHealth, 0);
	const snapshot = () => getDashboardState(store, runtime(), probes(), streams ? (nodeId) => streams.latest(nodeId) : undefined, health, streams?.sshEvidence);
	const pushKey = (state: DashboardState) => {
		// generatedAt alone must not force a republish. Per-node resource samples are left out too: they already
		// reach browsers on their own channel (the {type:"resources"} message), and their sampledAt changes every
		// 2 s, which republished the whole state on every tick.
		const { generatedAt: _generatedAt, ...rest } = state;
		return JSON.stringify({ ...rest, nodes: rest.nodes.map(({ resources: _resources, ...node }) => node) });
	};
	// Push the full state to connected browsers when it changes; nothing runs while nobody is watching.
	// Unchanged snapshots are not republished every SAMPLE_MS (avoids busy idle hubs).
	let lastPushKey: string | undefined;
	const pushTick = () => {
		if (!server || server.subscriberCount(TOPIC) <= 0) return;
		const state = snapshot();
		const key = pushKey(state);
		if (key === lastPushKey) return;
		lastPushKey = key;
		server.publish(TOPIC, JSON.stringify({ type: "state", state }));
	};
	const pushClock: DashboardPushTimer = options.pushTimer ?? { setInterval, clearInterval };
	const pushTimer = pushClock.setInterval(pushTick, 2_000);
	server = Bun.serve({
		port,
		hostname,
		fetch(req: Request, srv: any) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				if (!dashboardWsOriginAllowed(req, hostname)) return new Response("Forbidden", { status: 403 });
				if (srv.upgrade(req)) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(renderDashboardHtml(), {
					headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
				});
			}
			if (url.pathname === "/api/state") {
				return new Response(JSON.stringify(snapshot()), {
					headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
				});
			}
			const taskMatch = url.pathname.match(/^\/api\/task\/([^/]+)$/);
			if (taskMatch) {
				let taskId: string;
				try {
					taskId = decodeURIComponent(taskMatch[1]!);
				} catch {
					return new Response(JSON.stringify({ error: "invalid_task_id" }), {
						status: 400,
						headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
					});
				}
				if (!taskId || taskId.includes("/") || taskId.includes("\0")) {
					return new Response(JSON.stringify({ error: "invalid_task_id" }), {
						status: 400,
						headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
					});
				}
				const task = getDashboardTask(store, taskId);
				if (!task) return new Response("Not Found", { status: 404 });
				return new Response(JSON.stringify(task), {
					headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
				});
			}
			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			open(ws: any) {
				// Only the first subscriber seeds the broadcast dedupe key. A later joiner gets its own
				// initial state, but that must not mark the state as already broadcast to existing clients.
				const firstSubscriber = server.subscriberCount(TOPIC) === 0;
				ws.subscribe(TOPIC);
				const state = snapshot();
				if (firstSubscriber) lastPushKey = pushKey(state);
				ws.send(JSON.stringify({ type: "state", state }));
			},
			// View-only channel: inbound messages are ignored.
			message() {},
			close(ws: any) {
				ws.unsubscribe(TOPIC);
			},
		},
	});
	const stopServer = server.stop.bind(server);
	server.stop = (...args: unknown[]) => {
		pushClock.clearInterval(pushTimer);
		healthStopped = true;
		if (healthTimer) clearTimeout(healthTimer);
		streams?.stop();
		return stopServer(...args);
	};
	return server;
}

/**
 * One fresh measurement per node for an admission decision, using the same read-only stream as the
 * dashboard. Linux needs a second sample for a real CPU delta. Nodes without a result by the deadline
 * are reported ok:false, so they are excluded (fail-closed).
 */
export async function sampleResourcesOnce(
	nodes: NodeConfig[],
	timeoutMs = 15_000,
	/** Called on receipt of each sample (node-health evidence is stamped here, not when this returns). */
	onSample?: (nodeId: string, sample: ResourceSample) => void,
): Promise<Map<string, ResourceSample>> {
	const samples = new Map<string, ResourceSample>();
	const counts = new Map<string, number>();
	const need = (node: NodeConfig) => (node.os === "linux" ? 2 : 1);
	const pending = () => nodes.filter((node) => (counts.get(node.id) ?? 0) < need(node) && !samples.get(node.id)?.error);
	let finish!: () => void;
	const done = new Promise<void>((resolve) => (finish = resolve));
	const streams = startResourceStreams(
		() => nodes,
		(nodeId, resources) => {
			if (resources.ok) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
			const sample = { ...resources, at: Date.now() } as ResourceSample;
			samples.set(nodeId, sample);
			onSample?.(nodeId, sample);
			if (!pending().length) finish();
		},
	);
	const timer = setTimeout(finish, timeoutMs);
	await done;
	clearTimeout(timer);
	streams.stop();
	for (const node of nodes) {
		const sample = samples.get(node.id);
		const enough = (counts.get(node.id) ?? 0) >= need(node);
		if (!sample || !enough)
			samples.set(node.id, { ok: false, at: sample?.at ?? Date.now(), error: sample?.error ?? "Measurement timed out" });
	}
	return samples;
}
