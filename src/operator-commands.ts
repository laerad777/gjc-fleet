import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { DispositionKind, Json, TaskDisposition, TaskInput, TaskProgress, TaskRecord, TaskState, Phase, OperationIntent, OperationLease } from "./contracts";
import { progressFlagged, progressMarker } from "./progress";
import type { Fleet } from "./fleet";
import { DISPOSITION_KINDS, operatorRunPayload, type FleetStore } from "./store";
import type { ResourceSample } from "./admission";
import { submitPlacement } from "./index";
import type { HealthOutcome, NodeHealthAccess } from "./node-health-gate";
import { digest, executionOutcome, FleetError, placementView } from "./core";
import { collectedTaskIds } from "./work-unit";

/**
 * THE operator exit-code contract of `run`, `run --wait` and `watch --all-active`: the only definition.
 * CLI help and the README table are rendered from it (`exitCodeHelp`, `exitCodeMarkdown`) and tests drive
 * every row through the real CLI. `rank` orders aggregation over several tasks: the lowest rank wins, so an
 * unknown outcome is never masked by a milder one. Code 1 aborts the command and is never aggregated.
 */
export const exitCodes = [
	{ code: 0, outcome: "ok", rank: 9, meaning: "started and acknowledged (turn recorded); with --wait or watch: authoritatively settled successful execution (not artifact verification: a completed_unverified task reports 0 whatever its result, including one whose passing commands met an incomplete export awaiting operator acceptance, result.exportIncomplete, see export review); watch --all-active also exits 0 with an empty summary when no task was active, because only tasks seen active are watched (an already blocked_unknown task is not in the summary and is never observed; while other tasks are watched it can get a display-only progress line)" },
	{ code: 1, outcome: "error", rank: null, meaning: "usage, validation or unhandled error (JSON on stderr); once the global options parse, every error of run or watch --all-active (including --read-only refusal) also prints {ok:false,error,exit:1,outcome:\"error\"} as the last stdout line; a proven before_send node refusal of prepare is such an error with its typed node_refused code: the attempt stays held as a retained refusal (tasks/show preparationRefusal), and the next run, like start, re-checks it by side-effect-free preflight only (still refused or unavailable: error again, reason preparation_refusal_retained:*) or, once passed, prepares a fresh attempt" },
	{ code: 2, outcome: "queued", rank: 8, meaning: "queued: no eligible node with measured headroom" },
	{ code: 3, outcome: "blocked_unknown", rank: 1, meaning: "blocked_unknown: a dispatch or observation outcome is unknown; held, never replayed" },
	{ code: 4, outcome: "failed", rank: 3, meaning: "failed, cancelled or archived (terminal without success; an archived task is reported, never run or started again)" },
	{ code: 5, outcome: "unavailable", rank: 5, meaning: "observation failed twice in a row, or the watch poll limit was reached; nothing marked or released" },
	{ code: 6, outcome: "approval_required", rank: 4, meaning: "approval_required: operator action needed" },
	{ code: 7, outcome: "in_progress", rank: 7, meaning: "another live run holds this task's start lease; this run sent nothing" },
	{ code: 8, outcome: "cancel_unknown", rank: 2, meaning: "cancel_unknown: a cancellation outcome is unknown; held" },
	{ code: 9, outcome: "not_started", rank: 6, meaning: "reserved but not started: local dispatch is disabled (rollback), or the admitted node is not admissible now (disabled, draining, not ready or route changed); nothing was sent and the reservation stays held" },
] as const;
type ExitRow = (typeof exitCodes)[number];
export type ExitOutcome = ExitRow["outcome"];
export const operatorExit = Object.fromEntries(exitCodes.map(row => [row.outcome, row.code])) as { readonly [K in ExitOutcome]: Extract<ExitRow, { outcome: K }>["code"] };
function row(code: number): ExitRow {
	const found = exitCodes.find(r => r.code === code);
	if (!found) throw new Error("undocumented_exit_code");
	return found;
}
export function exitOutcome(code: number): ExitOutcome { return row(code).outcome; }
/** The most severe of several task outcomes by the table's rank. */
export function worstExit(codes: Iterable<number>): number {
	let worst: ExitRow | undefined;
	for (const code of codes) {
		const next = row(code);
		if (next.rank === null) throw new Error("error_exit_is_not_aggregated");
		if (!worst || next.rank < worst.rank!) worst = next;
	}
	return worst?.code ?? operatorExit.ok;
}
const precedence = () => [...exitCodes].filter(r => r.rank !== null).sort((a, b) => a.rank! - b.rank!).map(r => r.code).join(" > ");
/** CLI help rendering of the table. */
export function exitCodeHelp(): string {
	return [`Exit codes of run, run --wait and watch --all-active (once the global options parse, the last stdout JSON line carries "exit" and "outcome";`,
		`several tasks: most severe wins, ${precedence()}):`,
		...exitCodes.map(r => `  ${r.code} ${r.outcome.padEnd(19)}${r.meaning}`)].join("\n");
}
/** README rendering of the table. */
export function exitCodeMarkdown(): string {
	return ["| exit | outcome | aggregation rank | meaning |", "|---:|---|---:|---|",
		...exitCodes.map(r => `| ${r.code} | \`${r.outcome}\` | ${r.rank ?? "-"} | ${r.meaning} |`),
		"", `Aggregation over several tasks (most severe first): ${precedence()}.`].join("\n");
}

// Every phase, checked by the type: a new phase cannot be silently missing from the --phase filter.
const phaseSet: Record<Phase, true> = { queued: true, preparing: true, dispatching: true, active: true, approval_required: true, blocked_unknown: true,
	cancel_unknown: true, completed_unverified: true, succeeded: true, failed: true, archived: true, cancelled: true };
const phases = Object.keys(phaseSet) as Phase[];
// Archived is terminal: never watched, run, started or steered again.
const active = new Set<Phase>(["preparing", "dispatching", "active", "approval_required", "completed_unverified"]);
export function taskExit(task: TaskState): number {
	switch (task.phase) {
		case "queued": return operatorExit.queued;
		case "blocked_unknown": return operatorExit.blocked_unknown;
		case "cancel_unknown": return operatorExit.cancel_unknown;
		case "approval_required": return operatorExit.approval_required;
		case "failed": case "cancelled": case "archived": return operatorExit.failed;
		case "succeeded": return operatorExit.ok;
	}
	// Success only once a start is acknowledged; an unacknowledged attempt is never reported as started.
	if (!task.turnId) return operatorExit.not_started;
	return task.result?.executionTerminal && task.result.status === "failed" ? operatorExit.failed : operatorExit.ok;
}

export interface TaskFilters { phases?: Phase[]; node?: string; keyPrefix?: string; since?: number; dispositions?: DispositionKind[]; subject?: string; compact: boolean }
const sinceIso = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|[+-](\d\d):(\d\d))$/;
function parseSince(value: string): number {
	const m = sinceIso.exec(value);
	if (!m) throw new Error("invalid_since_iso");
	const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 ||
		(m[7] !== undefined && (Number(m[7]) > 23 || Number(m[8]) > 59))) throw new Error("invalid_since_iso");
	const at = Date.parse(value);
	if (!Number.isFinite(at)) throw new Error("invalid_since_iso");
	return at;
}
export function parseTaskFilters(args: string[]): TaskFilters {
	const filters: TaskFilters = { compact: false };
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i]!;
		if (seen.has(flag)) throw new Error("duplicate_tasks_filter");
		seen.add(flag);
		if (flag === "--compact") { filters.compact = true; continue; }
		if (!["--phase", "--node", "--key-prefix", "--since", "--disposition", "--subject"].includes(flag)) throw new Error("unknown_tasks_filter");
		// A value-taking flag always consumes the next argument, so values may start with "--".
		const value = args[++i];
		if (!value) throw new Error("tasks_filter_value_required");
		if (flag === "--phase") {
			const values = value.split(",");
			if (values.some(p => !phases.includes(p as Phase))) throw new Error("invalid_task_phase");
			filters.phases = values as Phase[];
		} else if (flag === "--disposition") {
			const values = value.split(",");
			if (values.some(k => !DISPOSITION_KINDS.includes(k as DispositionKind))) throw new Error("invalid_task_disposition");
			filters.dispositions = values as DispositionKind[];
		} else if (flag === "--subject") filters.subject = value;
		else if (flag === "--node") filters.node = value;
		else if (flag === "--key-prefix") filters.keyPrefix = value;
		else filters.since = parseSince(value);
	}
	return filters;
}
function submittedAt(store: FleetStore, id: string): number | undefined {
	const event = store.events(id).find(e => e.kind === "submitted");
	return event ? Date.parse(event.at) : undefined;
}
/** Metadata only (M2): filtering never reads a result body. */
export function filteredTasks(store: FleetStore, filters: TaskFilters): TaskState[] {
	return filterTaskStates(store, store.taskStates(), filters);
}
export function filterTaskStates<T extends TaskState>(store: FleetStore, tasks: readonly T[], filters: TaskFilters): T[] {
	return tasks.filter(task => (!filters.phases || filters.phases.includes(task.phase)) &&
		(!filters.node || task.nodeId === filters.node) &&
		(filters.keyPrefix === undefined || task.input.key.startsWith(filters.keyPrefix)) &&
		(!filters.dispositions || (task.disposition !== undefined && filters.dispositions.includes(task.disposition.kind))) &&
		(filters.subject === undefined || task.input.subject?.taskId === filters.subject) &&
		(filters.since === undefined || (submittedAt(store, task.id) ?? -Infinity) >= filters.since));
}
export function compactTask(store: FleetStore, task: TaskState, now = Date.now()): string {
	const at = submittedAt(store, task.id);
	const age = at === undefined ? "?" : `${Math.max(0, Math.floor((now - at) / 1000))}s`;
	// Escape control characters and whitespace in operator-supplied keys; never print prompts.
	// A disposed task gets one extra column, and a task flagged stalled or finished_unobserved one more (last);
	// every other row is unchanged.
	const marker = progressMarker(task, now);
	// A never-admitted queued task with a placement record gets one extra column: waiting="..." or unplaceable="...".
	const placement = placementView(task);
	return [task.id.slice(0, 12), task.phase, task.nodeId ?? "-", JSON.stringify(task.input.key), age,
		executionOutcome(task) ?? "-", ...(task.disposition ? [dispositionMarker(task.disposition)] : []),
		...(task.withdrawal ? ["withdrawn(operator,never-started)"] : []),
		...(placement ? [`${placement.verdict}=${JSON.stringify(placement.summary)}`] : []), ...(marker ? [marker] : [])].join("\t");
}
/** Compact marker of a disposition: always says it is an operator record, never verification. */
export function dispositionMarker(disposition: TaskDisposition): string {
	const detail = disposition.kind === "deployed" ? `:${disposition.commit}` : disposition.kind === "review-recorded" ? `:${disposition.verdict}` : disposition.kind === "superseded" ? `:by=${disposition.supersededBy!.slice(0, 12)}` : "";
	return `disposed=${disposition.kind}${detail}(operator-record,not-verified)`;
}
/** The watch line of a progress record, only for stalled and finished_unobserved verdicts. */
export function progressLine(entry: { taskId: string; progress: TaskProgress; settled?: boolean }): Record<string, Json> | undefined {
	const p = entry.progress;
	if (!progressFlagged(p)) return undefined;
	return {
		taskId: entry.taskId, observation: "progress", verdict: p.verdict, lastEntryKind: p.lastEntryKind ?? null,
		idleSeconds: p.idleSeconds ?? null, lastProgressAt: p.lastProgressAt ?? null, nodeWrittenAt: p.nodeWrittenAt ?? null, hint: p.hint,
		...(entry.settled !== undefined ? { observationTriggered: true } : {}),
	};
}

export interface RunOptions {
	localNodeId?: string;
	sample: (store: FleetStore) => Promise<ReadonlyMap<string, ResourceSample>>;
	/** Owner lease lifetime of the operator-run claim (renewed while starting). Default 60 s. */
	leaseMs?: number;
	/** Used by the admission only when the node-health switch stored in the fleet DB is on. */
	nodeHealth?: NodeHealthAccess;
}
export interface RunResult {
	task: TaskRecord;
	code: number;
	reused: boolean;
	operationId?: string;
	placement?: Awaited<ReturnType<typeof submitPlacement>>["report"] & { nodeHealth?: HealthOutcome };
}
const defaultLeaseMs = 60_000;
/** A lease is live until it expires, unless its holder is a process on this host that no longer exists. */
export function leaseLive(held: Pick<OperationLease, "expiresAt" | "host" | "pid">, now = Date.now()): boolean {
	if (held.expiresAt <= now) return false;
	if (held.host !== hostname()) return true;
	try {
		process.kill(held.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
/**
 * One admission/start sequence per caller/key. A repeated run resolves the SAME task from its durable state:
 * - absent or queued (never reserved): fresh measured admission, then start;
 * - reserved but unacknowledged: the run that holds the operator-run owner lease continues it with
 *   Fleet.start, whose prepare/create/prompt claims fence any dispatch whose outcome is unknown as
 *   blocked_unknown, so nothing is ever replayed. While another live run holds the lease this run reports
 *   in_progress (7) and sends nothing; a lease whose holder crashed (dead pid on this host) or expired is
 *   taken over. A retained proven before_send prepare refusal is handled by Fleet.start exactly as for a plain
 *   start (side-effect-free preflight, then a fresh attempt id on the same reservation); clearing it carries
 *   this run's claim and lease to the fresh attempt in the same transaction;
 * - acknowledged, unknown, approval, settled or archived: reported as-is with its distinct exit code.
 * Nothing throws after Fleet.start returned: the reported code is always derived from the durable task.
 */
export async function runTask(fleet: Fleet, input: TaskInput, options: RunOptions): Promise<RunResult> {
	const store = fleet.store;
	if (options.localNodeId && !store.nodes().some(node => node.id === options.localNodeId))
		throw new Error("local_node_not_registered");
	const leaseMs = options.leaseMs ?? defaultLeaseMs;
	if (!Number.isSafeInteger(leaseMs) || leaseMs < 100) throw new Error("invalid_lease_ms");
	// Metadata only (M2): locating the caller/key never reads another task's result.
	const existingId = store.taskStates().find(t => t.input.caller === input.caller && t.input.key === input.key)?.id;
	const existing = existingId === undefined ? undefined : store.task(existingId);
	if (existing && existing.inputDigest !== digest(input)) throw new Error("run_input_conflict");
	const reused = existing !== undefined;
	// An archived caller/key is terminal: never admitted, reserved or started again.
	if (existing?.phase === "archived")
		return { task: existing, code: taskExit(existing), reused, operationId: store.getOperation(existing.id, "operator-run")?.id };
	let placement: RunResult["placement"];
	let task = existing;
	if (!task?.attemptId) {
		const placed = await submitPlacement(fleet, input, { samples: await options.sample(store) }, { localNodeId: options.localNodeId, ...(options.nodeHealth ? { nodeHealth: options.nodeHealth } : {}) });
		// With the node-health switch on, the gate's decisions are shown with the report.
		placement = "health" in placed ? { ...placed.report, nodeHealth: placed.health } : placed.report;
		task = placed.task;
		if (!task.attemptId) return { task, code: operatorExit.queued, reused, placement };
	}
	const id = task.id;
	const report = (code?: number, operationId = store.getOperation(id, "operator-run")?.id): RunResult => {
		const current = store.task(id)!;
		return { task: current, code: code ?? taskExit(current), reused, operationId, placement };
	};
	const lease = { owner: randomUUID(), pid: process.pid, host: hostname() };
	const take = (operationId: string, replaceable: (held: OperationLease) => boolean) =>
		store.leaseOperatorRun(id, operationId, { ...lease, expiresAt: Date.now() + leaseMs }, replaceable);
	// Claim and lease the run on the task's current attempt. Clearing a retained refusal (by another run or
	// start) moves the attempt and carries its run claim; a run that read the old attempt re-binds once to
	// the fresh one, where the carried lease of a live clearer reports in_progress.
	let operation: OperationIntent | undefined;
	for (let bind = 0; !operation; bind++) {
		const current = store.task(id)!;
		// Anything already acknowledged, unknown, awaiting approval or settled is never started again.
		if (current.turnId || !["preparing", "dispatching"].includes(current.phase)) return report();
		const moved = (error: unknown) => bind === 0 && error instanceof FleetError &&
			["OPERATION_CONFLICT", "OPERATION_BINDING"].includes(error.code) && store.task(id)!.attemptId !== current.attemptId;
		let claimed: OperationIntent;
		try {
			claimed = store.claimOperation(id, "operator-run", operatorRunPayload(current)) ?? store.getOperation(id, "operator-run")!;
		} catch (error) {
			if (error instanceof FleetError && error.code === "DISPATCH_DISABLED") return report(operatorExit.not_started);
			if (moved(error)) continue;
			throw error;
		}
		// A recorded receipt means an earlier run finished its start; report the durable outcome.
		if (claimed.receipt !== undefined) return report(undefined, claimed.id);
		try {
			if (!take(claimed.id, held => !leaseLive(held))) return report(store.getOperation(id, "operator-run")?.receipt === undefined ? operatorExit.in_progress : undefined, claimed.id);
		} catch (error) {
			if (moved(error)) continue;
			throw error;
		}
		operation = claimed;
	}
	// This run's claim on the current attempt: the leased one, or the one a clear carried this lease to.
	const owned = () => {
		const current = store.getOperation(id, "operator-run");
		return current?.lease?.owner === lease.owner ? current : undefined;
	};
	const renew = setInterval(() => {
		try {
			const current = owned();
			if (current) take(current.id, () => false);
		} catch { /* an unrenewed lease only expires; claims still fence */ }
	}, Math.max(50, Math.floor(leaseMs / 4)));
	try {
		try {
			await fleet.start(id);
		} catch (error) {
			if (error instanceof FleetError && (error.code === "DISPATCH_DISABLED" || error.code === "NODE_NOT_ADMISSIBLE")) return report(operatorExit.not_started);
			throw error;
		}
		const current = store.task(id)!;
		const run = store.getOperation(id, "operator-run");
		if (run && run.receipt === undefined) {
			try {
				store.recordOperationReceipt(id, "operator-run", run.id, { phase: current.phase, sessionId: current.sessionId ?? null, turnId: current.turnId ?? null });
			} catch (error) {
				// Only a taken-over expired lease can race here; the first receipt stands and the task decides.
				if (!(error instanceof FleetError && error.code === "OPERATION_CONFLICT")) throw error;
			}
		}
		return report();
	} finally {
		clearInterval(renew);
		try {
			const current = owned();
			if (current) store.releaseOperatorRun(id, current.id, lease.owner);
		} catch { /* expires; dead pid frees it */ }
	}
}

export interface WatchOptions {
	ids?: string[];
	allActive?: boolean;
	interval?: number;
	maxPolls?: number;
	emit: (value: unknown) => void;
	sleep?: (ms: number) => Promise<void>;
}
/**
 * Bounded observation through the single Fleet.inspect path. Its tolerant mode reports a failed read as
 * OBSERVATION_UNAVAILABLE without marking the task unknown or releasing it; two in a row stop that task (5).
 * With allActive, every task ever seen active stays watched: one that leaves the active set through another
 * actor (a strict poll's fence, a cancel, another watcher's settlement) is reported with its own code. The
 * result is the most severe code by the exit table's rank; the final line is a per-task summary. With nothing
 * active at the first poll the summary is empty and the code is 0 (table row 0).
 */
export async function watchTasks(fleet: Fleet, options: WatchOptions): Promise<number> {
	const store = fleet.store;
	const interval = options.interval ?? 2000;
	const maxPolls = options.maxPolls ?? 1800;
	if (!Number.isSafeInteger(interval) || interval < 10 || interval > 60000 || !Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 100000) throw new Error("invalid_watch_bounds");
	if (!options.allActive && !options.ids?.length) throw new Error("task_id_required");
	const watched = new Set<string>(options.ids ?? []);
	const failures = new Map<string, number>();
	const emitted = new Map<string, string>();
	const progressEmitted = new Map<string, string>();
	const codes = new Map<string, number>();
	const finish = () => {
		const exit = worstExit(codes.values());
		options.emit({ observation: "summary", exit, outcome: exitOutcome(exit), tasks: Object.fromEntries(codes) });
		return exit;
	};
	for (let poll = 0; poll < maxPolls; poll++) {
		if (options.allActive) {
			// Work-unit Step 1: a collected report needs no watching (switch off: the set is empty).
			const collected = collectedTaskIds(store);
			for (const task of store.taskStates()) if (active.has(task.phase) && !collected.has(task.id)) watched.add(task.id);
		}
		for (const id of watched) {
			if (codes.has(id)) continue;
			// Metadata only (M2): the watch decision never reads a result body; one damaged result cannot stop the watch.
			let task: TaskState | undefined = store.taskState(id);
			if (!task) throw new Error("task_not_found");
			if (active.has(task.phase) && !task.result?.executionTerminal) {
				try { task = (await fleet.inspect(id, { tolerateReadFailure: true })).task; failures.delete(id); }
				catch (error) {
					if (!(error instanceof FleetError && error.code === "OBSERVATION_UNAVAILABLE")) throw error;
					const count = (failures.get(id) ?? 0) + 1;
					failures.set(id, count);
					options.emit({ taskId: id, observation: "unavailable", consecutiveFailures: count });
					if (count >= 2) codes.set(id, operatorExit.unavailable);
					continue;
				}
			}
			const line = { taskId: id, phase: task.phase, nodeId: task.nodeId ?? null, sessionId: task.sessionId ?? null,
				turnId: task.turnId ?? null, executionTerminal: task.result?.executionTerminal ?? false, held: task.held };
			const state = digest(line);
			if (emitted.get(id) !== state) { emitted.set(id, state); options.emit(line); }
			if (!active.has(task.phase) || task.result?.executionTerminal || task.phase === "approval_required")
				codes.set(id, taskExit(task));
		}
		if ([...watched].every(id => codes.has(id))) return finish();
		// Lane progress of the tasks still watched (with --all-active: every task in a progress phase, which
		// includes blocked_unknown): one read per node, rate-limited durably per task; an active finished_unobserved
		// task that is still watched gets the normal observation (a blocked_unknown task, or one this watch already
		// stopped, is display only). Emits a line only when a task becomes stalled/finished_unobserved.
		try {
			const live = [...watched].filter(id => !codes.has(id));
			const refreshed = await fleet.refreshProgress(options.allActive ? undefined : live, { settle: live });
			for (const entry of refreshed) {
				const line = progressLine(entry);
				const key = line ? digest({ verdict: line.verdict, nodeWrittenAt: line.nodeWrittenAt }) : "";
				if (line && progressEmitted.get(entry.taskId) !== key) options.emit(line);
				progressEmitted.set(entry.taskId, key);
			}
		} catch {
			// Progress is display only; the watch itself goes on.
		}
		if (poll + 1 < maxPolls) await (options.sleep ?? (ms => Bun.sleep(ms)))(interval);
	}
	options.emit({ observation: "wait_limit", maxPolls });
	for (const id of watched) if (!codes.has(id)) codes.set(id, operatorExit.unavailable);
	return finish();
}
