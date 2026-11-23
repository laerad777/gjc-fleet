import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { Json, NodeConfig, TaskState } from "./contracts";
import type { ResourceSample } from "./admission";
import { digest, FleetError, selectNode } from "./core";
import { type Fleet, lateReceiptWatched } from "./fleet";
import { preflightPlacement } from "./placement-preflight";
import { inputOptions } from "./work-unit";
import { leaseLive } from "./operator-commands";
import { type ReturnConnection, returnHistory, returnResources } from "./resource-return";
import { DAEMON_STATUS_LIMIT, type FleetStore, type SchedulingRow } from "./store";

/**
 * `fleet daemon`: the ONE supervised owner of periodic work on one Fleet database.
 *
 * Every cycle it reads the metadata-only scheduling index (never a result body) and, under an owner lease
 * in the store, runs three kinds of node work through one gate per node (at most one in-flight call per
 * node, so a slow node only delays its own tasks):
 *  - queue: unattempted queued tasks are re-checked with fresh measurements and the read-only placement
 *    preflight; the ones admissible now are published with their node. The daemon never reserves them (a
 *    reservation must be followed by a start, which sends the prompt): `queue reconsider` stays the operator's;
 *  - observation: every observable task is visited round-robin (least recently visited first), one
 *    observation per task at a time, through the single Fleet.inspect path (tolerant mode), so settlement,
 *    late-receipt and unknown handling stay there;
 *  - return: a settled task whose result is already collected is returned with returnResources where its
 *    durable history allows it without operator judgement; otherwise the reason is noted once.
 *  - custody: an opted-in successful exact runtime receipt authorizes only the submission's selected files,
 *    through Fleet.result and a durable non-replayable claim, before the existing return path.
 * It never sends prompts, answers questions or approvals, archives, verifies or resends.
 *
 * Extension points for the parallel lanes: observationKind (which tasks are observed, e.g. after an
 * uncertain send) and the observation step observe() which only calls Fleet.inspect, where the stalled-
 * session verdict and the poll fence live.
 */

/** Phases whose execution is not settled: observed until the task settles. */
const OBSERVED_PHASES = new Set(["preparing", "dispatching", "active", "approval_required", "completed_unverified"]);
/** Read-failure unknown: the only unknown a fresh exact observation may reconcile (see FleetStore.observe). */
const READ_FAILURE_UNKNOWN = "observation_unavailable_original_attempt_held";

export type ObservationKind = "poll" | "late_receipt";
/**
 * THE daemon eligibility rule for observation. Undefined = not observed by the daemon:
 * - no exact session/turn yet, archived, settled (outside a late-receipt window) or a cancellation;
 * - an approval-contract task: its observation needs the original UI channel held only by the process that
 *   started it; another process would turn a local channel check into an unknown;
 * - blocked_unknown other than a read failure (an effect outcome unknown is never resolved by reading).
 */
export function observationKind(row: SchedulingRow, now: number): ObservationKind | undefined {
	if (row.phase === "archived" || !row.attemptId || !row.nodeId || !row.sessionId || !row.turnId) return undefined;
	if (row.approvalContract !== undefined) return undefined;
	const facts = {
		phase: row.phase,
		result: {
			executionTerminal: row.executionTerminal,
			...(row.settledAt !== undefined && row.lateObservationUntil !== undefined ? { settlement: { settledAt: row.settledAt, lateObservationUntil: row.lateObservationUntil } } : {}),
			...(row.lateReceipt ? { lateReceipt: true } : {}),
		},
	};
	if (lateReceiptWatched(facts, now)) return "late_receipt";
	if (row.executionTerminal) return undefined;
	if (OBSERVED_PHASES.has(row.phase)) return "poll";
	if (row.phase === "blocked_unknown" && row.reason === READ_FAILURE_UNKNOWN) return "poll";
	return undefined;
}

export interface DaemonOptions {
	/** Epoch-millisecond clock, shared with owner-lease persistence. Timers remain real; tests may drive cycle() directly. */
	now?: () => number;
	localNodeId?: string;
	/** Scheduler cycle: index refresh, queue pass, node pumping. Default 5 s. */
	cycleMs?: number;
	/** Owner lease lifetime; renewed every leaseMs/3 with the published status. Default 30 s. */
	leaseMs?: number;
	/** reconsiderQueue limit per pass (1..100). Default 10. */
	queueLimit?: number;
	/** Longest per-candidate deferral after a pass that did not place it. Default 60 s. */
	queueMaxBackoffMs?: number;
	/** How long a queue pass waits for a busy node's gate before leaving it out of the pass. Default 5 s. */
	placementWaitMs?: number;
	/** Base interval between observations of one task; doubled while nothing changes. Default 30 s. */
	observeEveryMs?: number;
	/** Longest interval between observations of one unchanged task. Default 120 s. */
	observeMaxEveryMs?: number;
	/**
	 * Longest interval between observations of one task after repeated same-code read failures.
	 * Defaults to 30 min. Observation is never stopped permanently; the interval only stretches here.
	 */
	observeFailureMaxEveryMs?: number;
	/** Interval of the read-only late-receipt check of a receipt-less settlement. Default 600 s. */
	lateReceiptEveryMs?: number;
	/** Minimum pause between two calls to one node (its budget). Default win32 15 s, others 1 s. */
	nodeGapMs?: (node: { id: string; os?: string }) => number;
	/** First node backoff after a failed call; doubles to backoffMaxMs. Defaults 5 s / 300 s. */
	backoffMs?: number;
	backoffMaxMs?: number;
	/** Listing-only automatic return re-checks per attempt (never a new close). Default 3. */
	returnRetries?: number;
	/** Interval between automatic return re-checks of one task. Default 120 s. */
	returnEveryMs?: number;
	/** returnResources pacing. Default 250 ms. */
	returnPaceMs?: number;
	/** Graceful stop: how long in-flight calls may finish before they are abandoned. Default 60 s. */
	graceMs?: number;
	/** Full re-projection of every row (backstop to the incremental change feed). Default 10 min. */
	indexRebuildMs?: number;
	/** Quiet period after taking over an expired lease whose holder may still be alive. Default leaseMs. */
	takeoverQuietMs?: number;
	sampleTimeoutMs?: number;
	/** One fresh resource sample of one node. Default sampleResourcesOnce. */
	sample?: (node: NodeConfig) => Promise<ResourceSample>;
	/** Return connection (default connectResourceReturn: the node's public SDK CLI). */
	connectReturn?: (node: NodeConfig) => Promise<ReturnConnection>;
	/** One JSON line per state change (never per poll). */
	log?: (event: Record<string, Json>) => void;
}

const DEFAULTS = {
	cycleMs: 5_000,
	leaseMs: 30_000,
	queueLimit: 10,
	queueMaxBackoffMs: 60_000,
	placementWaitMs: 5_000,
	observeEveryMs: 30_000,
	observeMaxEveryMs: 120_000,
	observeFailureMaxEveryMs: 1_800_000,
	lateReceiptEveryMs: 600_000,
	backoffMs: 5_000,
	backoffMaxMs: 300_000,
	returnRetries: 3,
	returnEveryMs: 120_000,
	returnPaceMs: 250,
	graceMs: 60_000,
	indexRebuildMs: 600_000,
	sampleTimeoutMs: 15_000,
};
export const DAEMON_DEFAULTS = Object.freeze({ ...DEFAULTS, nodeGapMs: { win32: 15_000, other: 1_000 } });
/** Upper bound of per-node entries in the published status. */
const STATUS_NODES = 200;

/** One call slot per node: holder, or FIFO waiters; the scheduler never jumps the queue. */
class Gate {
	holder: string | undefined;
	since = 0;
	private waiters: { label: string; grant: () => void }[] = [];
	constructor(private readonly now: () => number) {}
	get waiting(): boolean { return this.waiters.length > 0; }
	tryAcquire(label: string): boolean {
		if (this.holder !== undefined || this.waiters.length) return false;
		this.holder = label;
		this.since = this.now();
		return true;
	}
	acquire(label: string, waitMs: number): Promise<boolean> {
		if (this.tryAcquire(label)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const waiter = { label, grant: () => { clearTimeout(timer); resolve(true); } };
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w !== waiter);
				resolve(false);
			}, waitMs);
			this.waiters.push(waiter);
		});
	}
	release(): void {
		const next = this.waiters.shift();
		this.holder = next?.label;
		this.since = this.now();
		next?.grant();
	}
}
interface NodeLane {
	id: string;
	os?: string;
	gate: Gate;
	nextAt: number;
	failures: number;
	calls: number;
	lastSuccessAt?: number;
	lastFailureAt?: number;
	lastCallMs?: number;
	/** A queue pass left this node out while it was busy: no new node work until the next pass had it. */
	placementWantedUntil: number;
	timer?: ReturnType<typeof setTimeout>;
}
interface Visit {
	lastAt?: number;
	dueAt: number;
	interval: number;
	signature?: string;
	errors: Set<string>;
	/** Consecutive OBSERVATION_UNAVAILABLE failures with the same Fleet error code. */
	sameFailureCode?: string;
	sameFailureCount: number;
}
interface ReturnVisit {
	/** Facts of the index row this decision was made for; a change re-evaluates. */
	facts: string;
	dueAt: number;
	lastAt?: number;
	/** done: nothing more for this attempt (returned, or needs the operator); wait: re-check at dueAt. */
	state: "eligible" | "wait" | "done";
}
type Work = { kind: "observe"; row: SchedulingRow; observation: ObservationKind; lastAt: number } | { kind: "return" | "custody"; row: SchedulingRow; lastAt: number };

export class FleetDaemon {
	readonly owner = randomUUID();
	readonly startedAt: string;
	private readonly o: typeof DEFAULTS;
	private readonly lanes = new Map<string, NodeLane>();
	private readonly visits = new Map<string, Visit>();
	private readonly returns = new Map<string, ReturnVisit>();
	private readonly custodyChecks = new Map<string, { facts: string; dueAt: number; eligible: boolean }>();
	/** Custody shares the node's visit age; fresh arrivals do not reset it to never visited. */
	private readonly custodyLastAt = new Map<string, number>();
	private readonly inFlight = new Set<string>();
	private readonly calls = new Set<Promise<void>>();
	private readonly samples = new Map<string, ResourceSample>();
	private readonly deferred = new Map<string, { until: number; delay: number }>();
	/** The scheduling projection in rowid order, refreshed from the store's change feed every cycle. */
	private rows = new Map<string, SchedulingRow>();
	private index: SchedulingRow[] = [];
	private cursor: { audit: number; rowid: number } | undefined;
	private lastRebuildAt = 0;
	private queue = { running: false, cursor: 0, lastPassAt: undefined as number | undefined, admissibleFound: 0, lastError: undefined as string | undefined };
	/** Queued tasks the last readiness check found admissible now, and on which node (published, never reserved). */
	private readonly admissible = new Map<string, { nodeId: string; at: number }>();
	private cycles = 0;
	private lastCycleAt: number | undefined;
	private stopping = false;
	private leaseHeld = false;
	private leaseUntil = 0;
	private quietUntil = 0;
	private takeover: { fromOwner: string; dead: boolean } | undefined;
	private lostLease = false;
	private wake: (() => void) | undefined;
	private renewTimer: ReturnType<typeof setInterval> | undefined;
	private rollback = false;
	private logged = new Set<string>();
	constructor(
		readonly fleet: Fleet,
		private readonly options: DaemonOptions = {},
	) {
		this.startedAt = new Date(this.now()).toISOString();
		const o = { ...DEFAULTS };
		for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
			const value = options[key];
			if (value === undefined) continue;
			if (!Number.isSafeInteger(value) || value < 0) throw new FleetError("INVALID_INPUT", `Invalid daemon option ${key}`);
			o[key] = value;
		}
		// When the caller only scales the ordinary observation windows (tests), keep the failure
		// ceiling as 15× the unchanged max (production: 120 s → 30 min) unless they set it explicitly.
		if (options.observeFailureMaxEveryMs === undefined)
			o.observeFailureMaxEveryMs = Math.max(o.observeMaxEveryMs, o.observeMaxEveryMs * 15);
		if (o.queueLimit < 1 || o.queueLimit > 100) throw new FleetError("INVALID_INPUT", "Daemon queue limit must be 1 to 100");
		if (o.leaseMs < 1000 || o.leaseMs > 600_000) throw new FleetError("INVALID_INPUT", "Daemon lease must be 1 s to 10 min");
		if (o.cycleMs < 10 || o.cycleMs > o.leaseMs / 2) throw new FleetError("INVALID_INPUT", "Daemon cycle must be at least 10 ms and at most half the lease");
		if (o.observeEveryMs < 1 || o.observeMaxEveryMs < o.observeEveryMs) throw new FleetError("INVALID_INPUT", "Invalid daemon observation interval");
		if (o.observeFailureMaxEveryMs < o.observeMaxEveryMs) throw new FleetError("INVALID_INPUT", "Daemon failure observation interval must be at least the unchanged max");
		if (o.returnPaceMs > 5000) throw new FleetError("INVALID_INPUT", "Daemon return pacing must be at most 5 s");
		this.o = o;
		this.quietUntil = 0;
	}
	private now = (): number => this.options.now?.() ?? Date.now();
	get store(): FleetStore {
		return this.fleet.store;
	}
	private log(event: string, data: Record<string, Json> = {}): void {
		try {
			this.options.log?.({ at: new Date(this.now()).toISOString(), event, ...data });
		} catch {
			/* logging never stops the loop */
		}
	}
	/** Logs one line per distinct key for the life of this process (state changes, not repeats). */
	private logOnce(key: string, event: string, data: Record<string, Json> = {}): void {
		if (this.logged.has(key)) return;
		if (this.logged.size > 10_000) this.logged.clear();
		this.logged.add(key);
		this.log(event, data);
	}
	/**
	 * Single-instance guarantee: claims the owner lease or throws DAEMON_RUNNING. A lease whose holder is
	 * a dead process on this host is taken over at once; any other is taken over only after it expired,
	 * followed by a quiet period (its holder may still have reads in flight; claims fence every effect).
	 */
	acquire(): void {
		const prior = this.store.daemonLease();
		const holder = { owner: this.owner, pid: process.pid, host: hostname(), startedAt: this.startedAt };
		const claimed = this.store.claimDaemonLease(holder, this.o.leaseMs, (held) => !leaseLive({ expiresAt: held.expires, host: held.holder.host, pid: held.holder.pid }, this.now()), this.now);
		if (!claimed) {
			const held = this.store.daemonLease();
			throw new FleetError("DAEMON_RUNNING", `Another daemon holds the owner lease (pid ${held?.holder.pid ?? "?"} on ${held?.holder.host ?? "?"}) until ${held ? new Date(held.expires).toISOString() : "?"}`);
		}
		this.leaseHeld = true;
		this.leaseUntil = this.now() + this.o.leaseMs;
		if (prior) {
			const dead = prior.holder.host === hostname() && prior.holder.pid > 0 && !leaseLive({ expiresAt: Number.MAX_SAFE_INTEGER, host: prior.holder.host, pid: prior.holder.pid }, this.now());
			this.takeover = { fromOwner: prior.holder.owner, dead };
			if (!dead) this.quietUntil = this.now() + (this.options.takeoverQuietMs ?? this.o.leaseMs);
			this.log("lease_taken_over", { fromOwner: prior.holder.owner, fromPid: prior.holder.pid, holderProvablyDead: dead, quietUntil: dead ? null : new Date(this.quietUntil).toISOString() });
		}
		this.log("started", { owner: this.owner, pid: process.pid });
	}
	/**
	 * Runs until stop() (or a lost lease), then lets in-flight calls finish for graceMs and releases the lease.
	 * Resolves with the number of calls abandoned at the grace deadline (their process should then exit).
	 */
	async run(): Promise<{ abandoned: number }> {
		if (!this.leaseHeld) this.acquire();
		this.renewTimer = setInterval(() => this.renew(), Math.max(10, Math.floor(this.o.leaseMs / 3)));
		try {
			this.renew();
			while (!this.stopping) {
				try {
					await this.cycle();
				} catch (error) {
					// A failed cycle (store busy, unreadable row) changes nothing; the next cycle retries.
					this.logOnce(`cycle:${errorCode(error)}`, "cycle_failed", { code: errorCode(error) });
				}
				if (this.stopping) break;
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, this.o.cycleMs);
					this.wake = () => { clearTimeout(timer); resolve(); };
				});
				this.wake = undefined;
			}
		} finally {
			await this.drain();
			clearInterval(this.renewTimer);
			for (const lane of this.lanes.values()) clearTimeout(lane.timer);
			if (!this.lostLease) {
				this.renew();
				try { this.store.releaseDaemonLease(this.owner); } catch { /* the lease expires */ }
			}
			this.log("stopped", { owner: this.owner, abandoned: this.inFlight.size, lostLease: this.lostLease });
		}
		if (this.lostLease) throw new FleetError("DAEMON_LEASE_LOST", "The daemon owner lease was lost; this daemon stopped starting calls");
		return { abandoned: this.calls.size };
	}
	/** Graceful stop: no new calls; run() lets in-flight calls finish (bounded) and releases the lease. */
	stop(): void {
		if (this.stopping) return;
		this.stopping = true;
		this.log("stopping", { inFlight: this.inFlight.size });
		this.wake?.();
	}
	private async drain(): Promise<void> {
		if (!this.calls.size) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			Promise.allSettled([...this.calls]),
			new Promise<void>((resolve) => { timer = setTimeout(resolve, this.o.graceMs); }),
		]);
		clearTimeout(timer);
	}
	private renew(): void {
		if (!this.leaseHeld || this.lostLease) return;
		try {
			const renewed = this.store.renewDaemonLease(this.owner, this.o.leaseMs, this.status(), this.now);
			if (renewed) {
				this.leaseUntil = this.now() + this.o.leaseMs;
				return;
			}
			this.lostLease = true;
		} catch (error) {
			// A busy store only delays renewal; the lease is lost once it would have expired.
			this.logOnce(`renew:${errorCode(error)}`, "lease_renew_failed", { code: errorCode(error) });
			if (this.now() < this.leaseUntil) return;
			this.lostLease = true;
		}
		this.log("lease_lost", { owner: this.owner });
		this.stop();
	}
	/** True while this process may start a new node call: lease held with a quarter of its lifetime to spare. */
	private mayCall(now = this.now()): boolean {
		return this.leaseHeld && !this.lostLease && !this.stopping && now < this.leaseUntil - this.o.leaseMs / 4 && now >= this.quietUntil;
	}
	private lane(id: string, os?: string): NodeLane {
		let lane = this.lanes.get(id);
		if (!lane) {
			lane = { id, os, gate: new Gate(this.now), nextAt: 0, failures: 0, calls: 0, placementWantedUntil: 0 };
			this.lanes.set(id, lane);
		}
		if (os) lane.os = os;
		return lane;
	}
	private gap(lane: NodeLane): number {
		if (this.options.nodeGapMs) return this.options.nodeGapMs({ id: lane.id, os: lane.os });
		return lane.os === "win32" ? DAEMON_DEFAULTS.nodeGapMs.win32 : DAEMON_DEFAULTS.nodeGapMs.other;
	}
	/** One scheduler cycle (also driven directly by tests). */
	async cycle(): Promise<void> {
		const now = this.now();
		this.refreshIndex(now);
		this.rollback = this.store.dispatchStatus().disabled;
		const known = new Set(this.index.map((row) => row.id));
		for (const id of this.visits.keys()) if (!known.has(id)) this.visits.delete(id);
		for (const id of this.returns.keys()) if (!known.has(id)) this.returns.delete(id);
		for (const id of this.deferred.keys()) if (!known.has(id)) this.deferred.delete(id);
		for (const id of this.admissible.keys()) if (!known.has(id)) this.admissible.delete(id);
		for (const node of this.store.nodes()) this.lane(node.id, node.os);
		for (const row of this.index) if (row.nodeId) this.lane(row.nodeId, row.nodeOs);
		if (!this.rollback && !this.queue.running && this.mayCall(now) && this.queueDue(now)) this.track(this.queuePass());
		for (const lane of this.lanes.values()) this.pump(lane);
		this.cycles++;
		this.lastCycleAt = now;
	}
	/**
	 * Incremental: only rows whose task changed since the last cursor are projected again (a large row is
	 * parsed by SQLite once per change, not once per cycle). Full rebuild on start, after a burst of changes,
	 * and every indexRebuildMs as a backstop against a writer that changed a row without its audit event.
	 */
	private refreshIndex(now: number): void {
		const cursor = this.store.schedulingCursor();
		const changed = this.cursor && now - this.lastRebuildAt < this.o.indexRebuildMs ? this.store.schedulingChanges(this.cursor) : undefined;
		// Receipt and ownership changes need not alter the scalar projection. Invalidate across
		// tasks too: another task can acquire the same session. Rebuilds also bound stale checks.
		if (!changed || changed.length) this.custodyChecks.clear();
		if (!changed) {
			this.rows = new Map(this.store.schedulingIndex().map((row) => [row.id, row]));
			this.lastRebuildAt = now;
		} else if (changed.length) {
			const fresh = new Map(this.store.schedulingIndex(changed).map((row) => [row.id, row]));
			for (const id of changed) {
				const row = fresh.get(id);
				if (row) this.rows.set(id, row);
				else this.rows.delete(id);
			}
		}
		this.cursor = cursor;
		if (!changed || changed.length) this.index = [...this.rows.values()];
	}
	private queueCandidates(): SchedulingRow[] {
		return this.index.filter((row) => row.phase === "queued" && !row.attemptId && !row.sessionId && !row.held);
	}
	private queueDue(now: number): boolean {
		return this.queueCandidates().some((row) => !((this.deferred.get(row.id)?.until ?? 0) > now));
	}
	private track(promise: Promise<void>): void {
		this.calls.add(promise);
		promise.finally(() => this.calls.delete(promise));
	}
	/** Start the next due work item of this node if its gate is free and its budget allows a call. */
	private pump(lane: NodeLane): void {
		const now = this.now();
		if (!this.mayCall(now) || lane.gate.holder !== undefined || lane.gate.waiting || now < lane.nextAt || now < lane.placementWantedUntil) return;
		const work = this.next(lane.id, now);
		if (!work || !lane.gate.tryAcquire(work.kind)) return;
		this.inFlight.add(work.row.id);
		this.track(work.kind === "observe" ? this.observe(lane, work.row, work.observation) : work.kind === "custody" ? this.collectCustody(lane, work.row) : this.returnTask(lane, work.row));
	}
	/** Least recently visited due work of this node (never visited first, then index order). */
	private next(nodeId: string, now: number): Work | undefined {
		let best: Work | undefined;
		for (const row of this.index) {
			if (row.nodeId !== nodeId || this.inFlight.has(row.id)) continue;
			let work: Work | undefined;
			const observation = observationKind(row, now);
			if (observation) {
				const visit = this.visit(row.id);
				if (visit.dueAt <= now) work = { kind: "observe", row, observation, lastAt: visit.lastAt ?? -1 };
			} else if (!this.rollback) {
				if (this.custodyDue(row, now)) work = { kind: "custody", row, lastAt: this.custodyLastAt.get(nodeId) ?? -1 };
				else {
					const ret = this.returnDecision(row, now);
					if (ret && ret.state === "eligible" && ret.dueAt <= now) work = { kind: "return", row, lastAt: ret.lastAt ?? -1 };
				}
			}
			if (work && (!best || work.lastAt < best.lastAt)) best = work;
		}
		return best;
	}
	private custodyDue(row: SchedulingRow, now: number): boolean {
		if (!row.autoCustody || row.resultStored || !row.attemptId) return false;
		const facts = JSON.stringify(row);
		const cached = this.custodyChecks.get(row.id);
		if (cached && cached.facts === facts && now < cached.dueAt) return cached.eligible;
		const remember = (eligible: boolean): boolean => {
			this.custodyChecks.set(row.id, { facts, dueAt: now + this.o.observeEveryMs, eligible });
			return eligible;
		};
		if (!["completed_unverified", "succeeded"].includes(row.phase) || !row.executionTerminal) {
			this.note(row.id, "custody_waits_for_successful_terminal_execution");
			return remember(false);
		}
		const claim = this.store.getOperation(row.id, "auto-custody");
		if (claim) {
			if (!claim.receipt) this.note(row.id, "custody_claimed_without_saved_manifest_operator_recovery_required_no_replay");
			return remember(false);
		}
		const refusal = this.store.autoCustodyRefusal(row.id);
		if (refusal) { this.note(row.id, `custody_refused_${refusal}`); return remember(false); }
		return remember(true);
	}
	private async collectCustody(lane: NodeLane, row: SchedulingRow): Promise<void> {
		const started = Date.now();
		this.custodyLastAt.set(lane.id, started);
		this.custodyChecks.delete(row.id);
		let ok = true;
		try {
			await this.fleet.automaticCustody(row.id);
			this.log("custody_saved", { taskId: row.id, nodeId: lane.id });
		} catch (error) {
			ok = false;
			this.note(row.id, `custody_failed_${errorCode(error)}_operator_recovery_required`);
		} finally {
			this.inFlight.delete(row.id);
			this.finishCall(lane, started, ok);
		}
	}
	private visit(id: string): Visit {
		let visit = this.visits.get(id);
		if (!visit) {
			visit = { dueAt: 0, interval: this.o.observeEveryMs, errors: new Set(), sameFailureCount: 0 };
			this.visits.set(id, visit);
		}
		return visit;
	}
	private finishCall(lane: NodeLane, started: number, ok: boolean): void {
		const end = this.now();
		lane.calls++;
		lane.lastCallMs = end - started;
		if (ok) {
			lane.failures = 0;
			lane.lastSuccessAt = end;
			lane.nextAt = end + this.gap(lane);
		} else {
			lane.failures++;
			lane.lastFailureAt = end;
			const backoff = Math.min(this.o.backoffMaxMs, this.o.backoffMs * 2 ** Math.min(lane.failures - 1, 20));
			lane.nextAt = end + Math.max(backoff, this.gap(lane));
			if (lane.failures === 1) this.log("node_backoff", { nodeId: lane.id, untilMs: backoff });
		}
		lane.gate.release();
		this.pumpAt(lane, lane.nextAt);
	}
	/** Pump this lane again when its budget allows the next call (the cycle also pumps every lane). */
	private pumpAt(lane: NodeLane, at: number): void {
		clearTimeout(lane.timer);
		if (this.stopping) return;
		lane.timer = setTimeout(() => this.pump(lane), Math.max(0, at - this.now()));
	}
	/** The observation step: the single Fleet.inspect path, tolerant of a failed read (never marks unknown for it). */
	private async observe(lane: NodeLane, row: SchedulingRow, kind: ObservationKind): Promise<void> {
		const visit = this.visit(row.id);
		const started = this.now();
		let ok = true;
		/** True only after Fleet.inspect was entered (a poll may have been issued / abandoned). */
		let polled = false;
		try {
			// A node in failure backoff gets no new poll sequence until a reachability check that writes nothing
			// succeeds: an unreachable node does not add an abandoned_poll row (and a task row rewrite) per retry.
			if (lane.failures > 0)
				await this.fleet.observationReachable(row.id).catch(() => {
					throw new FleetError("OBSERVATION_UNAVAILABLE", "Node unreachable; no poll issued");
				});
			polled = true;
			// An unchanged observation writes no receipt and no audit row (bounded growth for long-lived tasks).
			const out = await this.fleet.inspect(row.id, { tolerateReadFailure: true, recordUnchanged: false });
			const late = out.lateReceipt as { checked?: boolean; found?: boolean } | undefined;
			if (kind === "late_receipt" && late?.checked === false) ok = false;
			const task = out.task;
			const signature = digest({
				phase: task.phase,
				terminal: task.result?.executionTerminal ?? false,
				turn: (out.publicTurn as any)?.turn?.status ?? null,
				questions: (out.questions as any)?.questions?.length ?? null,
				late: late?.found ?? null,
			});
			const base = kind === "late_receipt" ? this.o.lateReceiptEveryMs : this.o.observeEveryMs;
			const max = Math.max(this.o.observeMaxEveryMs, base);
			// Unchanged (or failed) observations back off to max; any change returns to the base interval.
			visit.interval = !ok || signature === visit.signature ? Math.min(max, Math.max(base, visit.interval * 2)) : base;
			if (task.phase !== row.phase || (task.result?.executionTerminal ?? false) !== row.executionTerminal)
				this.log("observed_change", { taskId: row.id, nodeId: lane.id, from: row.phase, to: task.phase, executionTerminal: task.result?.executionTerminal ?? false });
			visit.signature = signature;
			visit.errors.clear();
			// A successful read clears the repeated-failure streak; end-unknown tasks stay held as they were.
			visit.sameFailureCode = undefined;
			visit.sameFailureCount = 0;
		} catch (error) {
			const code = errorCode(error);
			// OBSERVATION_UNAVAILABLE: the read failed and inspect recorded it as an abandoned poll; the
			// node backs off. Anything else is the task's own (binding, integrity): inspect recorded it.
			if (code === "OBSERVATION_UNAVAILABLE") ok = false;
			if (code === "OBSERVATION_UNAVAILABLE" && polled) {
				visit.sameFailureCount = visit.sameFailureCode === code ? visit.sameFailureCount + 1 : 1;
				visit.sameFailureCode = code;
				// Same polled failure stretches beyond the ordinary unchanged max up to observeFailureMaxEveryMs.
				// Observation is not stopped: the next poll is only deferred. Reachability-only misses do not
				// use this path (they write no abandoned_poll and keep the ordinary unchanged ceiling).
				const failureMax = Math.max(this.o.observeFailureMaxEveryMs, this.o.observeMaxEveryMs);
				visit.interval = Math.min(failureMax, Math.max(this.o.observeEveryMs, visit.interval * 2));
				if (visit.sameFailureCount >= 2)
					this.note(row.id, "observation_repeated_failure_operator_recovery_required");
			} else {
				visit.interval = Math.min(this.o.observeMaxEveryMs, visit.interval * 2);
			}
			if (!visit.errors.has(code)) {
				visit.errors.add(code);
				this.log("observation_failed", { taskId: row.id, nodeId: lane.id, code });
			}
		} finally {
			visit.lastAt = this.now();
			visit.dueAt = visit.lastAt + visit.interval;
			this.inFlight.delete(row.id);
			this.finishCall(lane, started, ok);
		}
	}
	/**
	 * Return policy (no operator judgement): only a settled attempt whose result is collected, with its
	 * original session authority, no cancellation, no operator release and no node block. The daemon's
	 * pass sends at most the FIRST idle-only close of an attempt; once any close is claimed it only
	 * re-lists (bounded) after an acknowledged close, never claims another. Anything else is noted once.
	 */
	private returnDecision(row: SchedulingRow, now: number): ReturnVisit | undefined {
		if (row.phase === "archived" || !row.executionTerminal || !row.attemptId || !row.sessionId || !row.turnId || !row.nodeId) return undefined;
		const facts = `${row.attemptId}|${row.phase}|${row.resultStored}|${row.held}|${row.workspace}|${row.sdkTransport}`;
		let decision = this.returns.get(row.id);
		// Cached until the row's facts change; a waiting decision is re-read from durable history once due.
		if (decision && decision.facts === facts && (decision.state !== "wait" || decision.dueAt > now)) return decision;
		const last = decision?.lastAt;
		decision = { facts, dueAt: now, ...(last !== undefined ? { lastAt: last } : {}), state: "eligible" };
		this.returns.set(row.id, decision);
		const done = (note?: string) => {
			decision!.state = "done";
			if (note) this.note(row.id, note);
			return decision;
		};
		const wait = (note: string) => {
			decision!.state = "wait";
			decision!.dueAt = now + this.o.returnEveryMs;
			this.note(row.id, note);
			return decision;
		};
		const store = this.store;
		const kinds = store.attemptOperationKinds(row.id, row.attemptId);
		if (kinds.has("resource-return-confirmed")) return done();
		if (kinds.has("resource-return-override")) return done("return_operator_release_lists_only");
		if (!row.resultStored) return wait("return_awaits_result_collection");
		if (!row.workspace) return done("return_workspace_identity_missing");
		if (!row.sdkTransport) return done("return_sdk_transport_required");
		if (!kinds.has("session-authority")) return done("return_original_session_authority_missing");
		if (kinds.has("cancel")) return done("return_cancellation_owns_retirement");
		if (store.resourceReturnNodeBlock(row.nodeId)) return wait("return_node_blocked_operator_unblock_required");
		const history = returnHistory(store, row.id, row.attemptId);
		if (history.closes > 0) {
			if (history.lastClose !== "closed") return done(`return_needs_operator_after_close_${history.lastClose ?? "unknown"}`);
			// Every outcome after the close counts (still listed, unavailable, foreign, unproven, busy): bounded.
			if (history.afterClose.length > this.o.returnRetries) return done("return_needs_operator_relists_exhausted_after_close");
			return decision;
		}
		// No close claimed yet: listing-first passes that ended without a close may be repeated (bounded).
		const retryable = new Set(["fresh_authoritative_observation_unavailable_no_replay", "host_liveness_unproven", "listing_changed_between_observations"]);
		const prior = history.outcomes;
		if (prior.some((o) => !retryable.has(o.reason ?? ""))) return done(`return_needs_operator_after_${prior.find((o) => !retryable.has(o.reason ?? ""))!.kind}`);
		if (prior.length > this.o.returnRetries) return done("return_needs_operator_retries_exhausted");
		return decision;
	}
	private note(taskId: string, note: string): void {
		const key = `note:${taskId}:${note}`;
		if (this.logged.has(key)) return;
		try {
			if (this.store.recordDaemonNote(taskId, note)) this.log("noted", { taskId, note });
			this.logged.add(key);
		} catch (error) {
			this.logOnce(`notefail:${taskId}:${note}`, "note_failed", { taskId, code: errorCode(error) });
		}
	}
	private async returnTask(lane: NodeLane, row: SchedulingRow): Promise<void> {
		const started = this.now();
		const decision = this.returns.get(row.id)!;
		let ok = true;
		try {
			const [report] = await returnResources(this.store, [row.id], {
				maxTasks: 1,
				paceMs: this.o.returnPaceMs,
				...(this.options.connectReturn ? { connect: this.options.connectReturn } : {}),
			});
			this.log("return", { taskId: row.id, nodeId: lane.id, state: report!.state, reason: report!.reason ?? null });
			if (report!.state === "returned") decision.state = "done";
			else if (report!.state === "refused") {
				decision.state = "done";
				this.note(row.id, `return_refused_${report!.reason ?? "unknown"}`);
			} else {
				// node_busy (another return pass on this node) or an outcome its own audit already recorded:
				// once due, the decision is made again from the durable history (never a second close).
				decision.state = "wait";
				decision.dueAt = this.now() + this.o.returnEveryMs;
				if (report!.reason === "fresh_authoritative_observation_unavailable_no_replay") ok = false;
			}
		} catch (error) {
			ok = false;
			decision.state = "wait";
			decision.dueAt = this.now() + this.o.returnEveryMs;
			this.logOnce(`return:${row.id}:${errorCode(error)}`, "return_failed", { taskId: row.id, code: errorCode(error) });
		} finally {
			decision.lastAt = this.now();
			this.inFlight.delete(row.id);
			this.finishCall(lane, started, ok);
		}
	}
	private defer(id: string, now: number): void {
		const prior = this.deferred.get(id);
		const delay = Math.min(this.o.queueMaxBackoffMs, prior ? prior.delay * 2 : this.o.cycleMs);
		this.deferred.set(id, { until: now + delay, delay });
	}
	/** Fresh measurement of one node, taken while the queue pass holds that node's gate. */
	private async sampleNode(node: NodeConfig): Promise<ResourceSample> {
		const cached = this.samples.get(node.id);
		if (cached?.ok && this.now() - cached.at < Math.min(5_000, this.o.cycleMs)) return cached;
		let sample: ResourceSample;
		try {
			if (this.options.sample) sample = await this.options.sample(node);
			else {
				const { sampleResourcesOnce } = await import("./dashboard");
				sample = (await sampleResourcesOnce([node], this.o.sampleTimeoutMs)).get(node.id) ?? { ok: false, at: this.now(), error: "no_sample" };
			}
		} catch {
			sample = { ok: false, at: this.now(), error: "sample_failed" };
		}
		this.samples.set(node.id, sample);
		return sample;
	}
	/**
	 * One call of a queue pass to `node` (a sample or a probe), holding that node's gate for this call only, so a
	 * slow or unreachable node never delays another node's work. A busy gate is waited for at most placementWaitMs;
	 * then the call is left out (undefined) and the node is reserved for the next pass.
	 */
	private async placementCall<T>(node: NodeConfig, call: () => Promise<T>): Promise<T | undefined> {
		const lane = this.lane(node.id, node.os);
		if (!(await lane.gate.acquire("placement", this.o.placementWaitMs))) {
			lane.placementWantedUntil = this.now() + 2 * this.o.cycleMs;
			return undefined;
		}
		try {
			return this.mayCall() ? await call() : undefined;
		} finally {
			lane.placementWantedUntil = 0;
			lane.gate.release();
			this.pumpAt(lane, lane.nextAt);
		}
	}
	/**
	 * One bounded queue pass. It measures every enabled node at most once (a failed sample stands for the rest of
	 * the pass), keeps only candidates some measured node can admit now (no network for the rest), runs the
	 * read-only placement preflight for those over the measured nodes only (a node whose sample failed or whose
	 * gate stayed busy is not probed) and publishes the admissible ones. Every sample and probe holds only its own
	 * node's gate for that call. Nothing is reserved or started.
	 */
	private async queuePass(): Promise<void> {
		this.queue.running = true;
		let found = 0;
		try {
			const now = this.now();
			const due = this.queueCandidates().filter((row) => !((this.deferred.get(row.id)?.until ?? 0) > now));
			if (!due.length) return;
			const start = this.queue.cursor % due.length;
			const ordered = [...due.slice(start), ...due.slice(0, start)];
			this.queue.cursor = start + this.o.queueLimit;
			const nodes = this.store.nodes().filter((node) => node.enabled && !node.draining);
			const samples = new Map<string, ResourceSample>();
			await Promise.all(nodes.map(async (node) => {
				const sample = await this.placementCall(node, () => this.sampleNode(node));
				if (sample?.ok) samples.set(node.id, sample);
			}));
			if (!this.mayCall()) return;
			const measured = nodes.filter((node) => samples.has(node.id));
			if (!measured.length) {
				// No measured node: nothing is admissible; no store scan, no probe.
				for (const row of ordered.slice(0, this.o.queueLimit)) this.defer(row.id, this.now());
				return;
			}
			const heldCharges = this.store.heldCharges();
			const loads = this.index.filter((row) => row.held && row.nodeId).map((row) => ({ held: true, nodeId: row.nodeId }) as unknown as TaskState);
			const admissible: string[] = [];
			for (const row of ordered) {
				if (admissible.length >= this.o.queueLimit) break;
				const state = this.store.taskState(row.id);
				if (!state) continue;
				const selection = selectNode(state.input, measured, loads, { samples, held: heldCharges, now: this.now() });
				if (selection.nodeId) admissible.push(row.id);
				else this.defer(row.id, this.now());
			}
			if (!admissible.length) return;
			// Read-only readiness (the same preflight `queue reconsider` runs), never a reservation: a reservation
			// needs a start to follow, and starting sends the task's prompt, which stays with the operator.
			const tasks = this.store.taskStates();
			for (const id of admissible) {
				if (!this.mayCall()) break;
				const state = this.store.taskState(id);
				if (!state || state.phase !== "queued" || state.attemptId) continue;
				// Re-checked after the backoff whatever the answer (or a failure): the published verdict carries its time.
				this.defer(id, this.now());
				const report = await preflightPlacement(state.input, measured, tasks, { samples, held: heldCharges, now: this.now() }, {
					...(this.options.localNodeId ? { localNodeId: this.options.localNodeId } : {}),
					// The work-unit switch state, read as every other placement caller reads it: a role task validates.
					...inputOptions(this.store, state.input),
					nodeCall: async (nodeId, probe) => {
						const out = await this.placementCall(measured.find((node) => node.id === nodeId)!, probe);
						if (out === undefined) throw new FleetError("NODE_BUSY", "node gate busy or no call allowed now");
						return out;
					},
				});
				const nodeId = report.selection.nodeId;
				if (nodeId) {
					found++;
					this.admissible.set(id, { nodeId, at: this.now() });
					this.logOnce(`admissible:${id}:${nodeId}`, "admissible", { taskId: id, nodeId });
				} else this.admissible.delete(id);
			}
			this.queue.lastError = undefined;
		} catch (error) {
			const code = errorCode(error);
			this.queue.lastError = code;
			this.logOnce(`queue:${code}`, "queue_pass_failed", { code });
		} finally {
			this.queue.admissibleFound += found;
			this.queue.lastPassAt = this.now();
			this.queue.running = false;
		}
	}
	/** The published status (lease row, `daemon status`, dashboard, observability): bounded. */
	status(): Json {
		const now = this.now();
		let observable = 0, due = 0, awaitingStart = 0, awaitingReturn = 0, queued = 0, queuedDeferred = 0;
		const admissible: Json[] = [];
		const perNode = new Map<string, { observable: number; due: number; oldestDueMs: number }>();
		const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
		for (const row of this.index) {
			if (row.phase === "queued" && !row.attemptId) {
				queued++;
				if ((this.deferred.get(row.id)?.until ?? 0) > now) queuedDeferred++;
				const found = this.admissible.get(row.id);
				if (found && admissible.length < 100) admissible.push({ taskId: row.id, nodeId: found.nodeId, checkedAt: iso(found.at) });
				continue;
			}
			if (row.attemptId && !row.sessionId && (row.phase === "preparing" || row.phase === "dispatching")) awaitingStart++;
			const kind = observationKind(row, now);
			if (kind && row.nodeId) {
				observable++;
				const node = perNode.get(row.nodeId) ?? { observable: 0, due: 0, oldestDueMs: 0 };
				node.observable++;
				const dueAt = this.visits.get(row.id)?.dueAt || 0;
				if (dueAt <= now) {
					due++;
					node.due++;
					// Never visited: due since this daemon started.
					node.oldestDueMs = Math.max(node.oldestDueMs, now - (dueAt || this.startedAtMs()));
				}
				perNode.set(row.nodeId, node);
			}
			const ret = this.returns.get(row.id);
			if (ret && ret.state !== "done") awaitingReturn++;
		}
		const nodes = [...this.lanes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, STATUS_NODES).map((lane) => ({
			id: lane.id,
			inFlight: lane.gate.holder ?? null,
			inFlightSince: lane.gate.holder ? iso(lane.gate.since) : null,
			lastSuccessAt: iso(lane.lastSuccessAt),
			lastFailureAt: iso(lane.lastFailureAt),
			consecutiveFailures: lane.failures,
			nextCallAt: iso(lane.nextAt || undefined),
			lastCallMs: lane.lastCallMs ?? null,
			calls: lane.calls,
			backlog: perNode.get(lane.id) ?? { observable: 0, due: 0, oldestDueMs: 0 },
		}));
		const value: Record<string, Json> = {
			version: 1,
			cycleMs: this.o.cycleMs,
			leaseMs: this.o.leaseMs,
			cycles: this.cycles,
			lastCycleAt: iso(this.lastCycleAt),
			stopping: this.stopping,
			rollback: this.rollback,
			takeover: this.takeover ? { fromOwner: this.takeover.fromOwner, holderProvablyDead: this.takeover.dead } : null,
			quietUntil: this.quietUntil > now ? iso(this.quietUntil) : null,
			backlog: { queued, queuedDeferred, observable, observeDue: due, inFlight: this.inFlight.size, awaitingStart, awaitingReturn },
			// Admissible now by the last read-only readiness check; `queue reconsider` places and starts them.
			queue: { running: this.queue.running, lastPassAt: iso(this.queue.lastPassAt), admissibleFound: this.queue.admissibleFound, admissible, lastError: this.queue.lastError ?? null },
			nodes,
			nodesTotal: this.lanes.size,
		};
		// Bounded by the store's status limit: drop per-node detail first.
		while (Buffer.byteLength(JSON.stringify(value)) > DAEMON_STATUS_LIMIT - 1024 && (value.nodes as Json[]).length) (value.nodes as Json[]).pop();
		return value;
	}
	private startedAtMs(): number {
		return Date.parse(this.startedAt);
	}
}
function errorCode(error: unknown): string {
	if (error instanceof FleetError) return error.code;
	const code = (error as { code?: unknown })?.code;
	return typeof code === "string" && /^[A-Za-z0-9_:.-]{1,64}$/.test(code) ? code : "error";
}
