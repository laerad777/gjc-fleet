import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * One real probe of one node. Only a node that was actually probed produces a probe; a skipped node
 * writes nothing. `null` means the dimension was not observable in this probe (no guarded
 * sdkTransport for the Broker list, no fresh hub resource sample): it is neither a failure nor a
 * success, and stability requires every dimension to have been observed `true` at least once since
 * the last reset. Busy utilization is NOT a failure: a successful busy sample is `true`.
 */
export interface HealthProbe {
	/** Coordinator tools/list round trip completed (and the workspace transport answered when probed). */
	reachable: boolean;
	/** Broker `sdk session list --attach-only` result through the node's guarded sdkTransport. */
	brokerSessionListOk: boolean | null;
	/** Hub resource sampler reached the node and returned a successful sample that is fresh by the
	 * probing process's own monotonic clock (`stampSample`); a wall-stamped sample can only be `false`. */
	resourceSampleOk: boolean | null;
	latencyMs: number;
}
/** A recorded probe; `at` is the store's wall clock at recording, for display only. */
export interface HealthObservation extends HealthProbe { at: number }

/**
 * Admission policy, in real probes:
 * - `consecutive` counted good probes make a node that never failed stable;
 * - after any failure, `recoveryConsecutive` counted good probes are needed;
 * - a good probe counts when its writer proves, with its own monotonic clock, that it is at least
 *   `spacingMs` after one of its own probes since the last counted probe, or (restart fallback,
 *   no clock) when good probes from `restartFallbackWriters` distinct writers (process lifetimes)
 *   were recorded since the last counted probe;
 * - `capacity` rows per node are retained for display (evaluation never reads rows).
 * Defaults: 3 probes over >= 60 s fresh, 5 probes over >= 120 s after a failure, both proven inside
 * one process; otherwise good probes from at most 1 + (need - 1) * 64 writers, with no failure.
 */
export interface HealthPolicy { consecutive: number; recoveryConsecutive: number; spacingMs: number; restartFallbackWriters: number; capacity: number }
export const defaultHealthPolicy: Readonly<HealthPolicy> = Object.freeze({ consecutive: 3, recoveryConsecutive: 5, spacingMs: 30_000, restartFallbackWriters: 64, capacity: 128 });
/** Hard bounds: the checks can be neither disabled (single probe, no spacing, tiny fallback) nor made unbounded. */
export const healthPolicyBounds = Object.freeze({
	consecutive: [2, 64],
	recoveryConsecutive: [2, 256],
	spacingMs: [5_000, 3_600_000],
	restartFallbackWriters: [16, 1024],
	capacity: [16, 4096],
} as const);
/** Pinned-dispatch warnings retained verbatim; older ones are rolled up per node, never silently dropped. */
export const WARNING_CAPACITY = 4096;
/** Unregistered nodes that keep only an unrecovered failure state, at most this many nodes. */
export const TOMBSTONE_CAPACITY = 4096;
/** Per-instance in-memory anchors (one per probed node); evicting one only withholds credit. */
export const ANCHOR_CAPACITY = 4096;
/** Fixed per-probe allowance of a bootstrap run; its deadline never scales with a caller timeout. */
export const BOOTSTRAP_PROBE_ALLOWANCE_MS = 10_000;
const BOOTSTRAP_AUDIT_PER_NODE = 8;
/** Retained selection-gating switch changes (newest kept). */
export const GATING_AUDIT_CAPACITY = 256;
/** Rollup key for warnings of collected nodes; node ids are `[a-zA-Z0-9_-]` so this cannot collide. */
export const REMOVED_NODES_ROLLUP = "*removed";
/** Tables owned by the sidecar; FleetStore accepts a fresh file that holds only these. */
export const NODE_HEALTH_TABLE = /^node_health(_|$)/;
const FLEET_STORE_APPLICATION_ID = 0x47464c54;

/** An audited switch change needs `{operator, reason}`: non-empty strings of at most 512 characters. */
export function gatingApproval(approval: { operator: string; reason: string }) {
	for (const value of [approval?.operator, approval?.reason]) if (typeof value !== "string" || !value.trim() || value.length > 512) throw new Error("selection_gating_approval_required");
	return approval;
}

export function healthPolicy(value: Partial<HealthPolicy> = {}): Readonly<HealthPolicy> {
	const invalid = (field: string) => new Error("invalid_health_policy:" + field);
	if (value === null || typeof value !== "object") throw invalid("policy");
	for (const key of Reflect.ownKeys(value)) if (typeof key !== "string" || !Object.hasOwn(healthPolicyBounds, key)) throw invalid(String(key));
	const p = { ...defaultHealthPolicy, ...value };
	for (const [key, [min, max]] of Object.entries(healthPolicyBounds)) {
		const n = (p as any)[key];
		if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid(key);
	}
	// Recovering from a failure never needs less evidence than a node that never failed.
	if (p.recoveryConsecutive < p.consecutive) throw invalid("recoveryConsecutive");
	return Object.freeze(p);
}

const dimensions = ["reachable", "brokerSessionListOk", "resourceSampleOk"] as const;
type Dimension = (typeof dimensions)[number];
export function goodObservation(o: HealthProbe) { return dimensions.every(key => o[key] !== false); }
function validProbe(o: HealthProbe) {
	return !!o && typeof o === "object" && Number.isFinite(o.latencyMs) && o.latencyMs >= 0 && typeof o.reachable === "boolean"
		&& [o.brokerSessionListOk, o.resourceSampleOk].every(v => v === null || typeof v === "boolean");
}

const STATE_VERSION = 5;
/** How a good probe was counted. */
export type CountedBy = "first" | "spacing" | "fallback";
/**
 * Durable per-node state, bounded by restartFallbackWriters and independent of the number of probes.
 * - `count`: counted good probes since the last reset (a failure, or no history).
 * - `recovering`: a failure was recorded; `recoveryConsecutive` applies from then on.
 * - `last`: the last counted probe (sequence, writer and wall time; the wall time is display only).
 * - `pending`: good probes recorded since `last` that did not count.
 * - `writers`: distinct writers with a good probe since `last` (fewer than restartFallbackWriters).
 * - `observed`: dimensions observed `true` since the reset.
 */
export interface NodeHealthState {
	v: typeof STATE_VERSION;
	seq: number;
	latest: HealthObservation;
	latestWriter: string;
	count: number;
	recovering: boolean;
	last: { seq: number; writer: string; at: number } | null;
	pending: number;
	writers: string[];
	observed: Dimension[];
	failure: { seq: number; at: number; dimensions: Dimension[] } | null;
}
/** A writer's (process's) own earliest probe of a node at or after the last counted probe; in memory only. */
export interface Anchor { seq: number; mono: number }
export interface ProbeInput { observation: HealthObservation; seq: number; writer: string; mono: number }
export interface StepResult { state: NodeHealthState; anchor: Anchor | undefined; counted?: CountedBy }

/**
 * Fold one recorded probe into the state; pure. `anchor` is the recording writer's in-memory anchor
 * for this node (undefined for a new process). Time is only ever used to GRANT a count: the writer's
 * monotonic delta from its own anchor. Nothing is reset, expired or shortened by any clock.
 * - Any `false` dimension: reset (`count = 0`, recovering).
 * - Good probe: counts when it is the first after a reset, when spacing is proven inside the writer,
 *   or when good probes from `restartFallbackWriters` distinct writers were recorded since the last
 *   counted probe (this one included).
 *   Otherwise it is pending and becomes the writer's anchor if the writer has none since `last`.
 */
export function stepHealth(state: NodeHealthState | undefined, input: ProbeInput, anchor: Anchor | undefined, config: Partial<HealthPolicy> = {}): StepResult {
	const p = healthPolicy(config);
	const { observation: o, seq, writer, mono } = input;
	const prior = state?.v === STATE_VERSION ? state : undefined;
	const base = { v: STATE_VERSION, seq, latest: o, latestWriter: writer } as const;
	if (!goodObservation(o)) {
		const failed = dimensions.filter(key => o[key] === false);
		return { state: { ...base, count: 0, recovering: true, last: null, pending: 0, writers: [], observed: [], failure: { seq, at: o.at, dimensions: failed } }, anchor: undefined };
	}
	const own = prior?.last && anchor && anchor.seq >= prior.last.seq ? anchor : undefined;
	const writers = new Set(prior && prior.count > 0 ? prior.writers : []);
	writers.add(writer);
	let counted: CountedBy | undefined;
	if (!prior || prior.count === 0) counted = "first";
	else if (own && mono - own.mono >= p.spacingMs) counted = "spacing";
	else if (writers.size >= p.restartFallbackWriters) counted = "fallback";
	const observed = new Set<Dimension>(prior && prior.count > 0 ? prior.observed : []);
	for (const key of dimensions) if (o[key] === true) observed.add(key);
	const next: NodeHealthState = {
		...base,
		count: (prior?.count ?? 0) + (counted ? 1 : 0),
		recovering: prior?.recovering ?? false,
		last: counted ? { seq, writer, at: o.at } : prior!.last,
		pending: counted ? 0 : prior!.pending + 1,
		writers: counted ? [] : [...writers],
		observed: dimensions.filter(key => observed.has(key)),
		failure: prior?.failure ?? null,
	};
	return { state: next, anchor: counted ? { seq, mono } : own ?? { seq, mono }, ...(counted ? { counted } : {}) };
}

export interface NodeHealth {
	stable: boolean;
	/** Why the node is not stable: `no_history`, the dimensions of the failure it is recovering from,
	 * `consecutive_observations` and `unobserved:<dimension>`. */
	failingDimensions: string[];
	latest?: HealthObservation;
	latestSeq: number;
	/** Counted good probes since the last reset, and how many stability needs. */
	consecutiveGood: number;
	required: number;
	/** Good probes since the last counted one, and how many more distinct writers the restart fallback needs. */
	pendingProbes: number;
	fallbackInWriters?: number;
	/** Dimensions never observed `true` since the last reset ("not observed" is not success). */
	unobserved: string[];
	lastFailure?: { seq: number; at: number; dimensions: string[] };
}
/** Evaluate a state; pure and clock-free. */
export function evaluateHealth(state: NodeHealthState | undefined, config: Partial<HealthPolicy> = {}): NodeHealth {
	const p = healthPolicy(config);
	if (state && state.v !== STATE_VERSION) state = undefined;
	if (!state) return { stable: false, failingDimensions: ["no_history"], latestSeq: 0, consecutiveGood: 0, required: p.consecutive, pendingProbes: 0, unobserved: [...dimensions] };
	const required = state.recovering ? p.recoveryConsecutive : p.consecutive;
	const failing: string[] = [];
	if (state.recovering && state.count < required) failing.push(...state.failure!.dimensions);
	if (state.count < required) failing.push("consecutive_observations");
	const unobserved = dimensions.filter(key => !state!.observed.includes(key));
	if (state.count > 0) failing.push(...unobserved.map(key => "unobserved:" + key));
	return {
		stable: failing.length === 0,
		failingDimensions: failing,
		latest: state.latest,
		latestSeq: state.seq,
		consecutiveGood: state.count,
		required,
		pendingProbes: state.pending,
		...(state.count > 0 && state.count < required ? { fallbackInWriters: p.restartFallbackWriters - state.writers.length } : {}),
		unobserved,
		...(state.failure ? { lastFailure: state.failure } : {}),
	};
}

/**
 * Bootstrap plan: one process probes `spacingMs` apart until stable. It needs at most `required`
 * counted probes plus one anchoring probe; the deadline adds a fixed per-probe allowance.
 * Defaults: 4 probes / 130 s, or 6 probes / 210 s when recovering from a failure.
 */
export function bootstrapPlan(p: HealthPolicy, recovering: boolean) {
	const probes = (recovering ? p.recoveryConsecutive : p.consecutive) + 1;
	return { interval: p.spacingMs, probes, budgetMs: p.spacingMs * (probes - 1) + probes * BOOTSTRAP_PROBE_ALLOWANCE_MS };
}

export interface HealthDecision { allowed: boolean; reason?: "node_unstable"; warning: boolean; health: NodeHealth & { nodeId: string } }
export interface HealthHistoryOptions {
	/** Store wall clock, display only (default Date.now). */
	clock?: () => number;
	/** This process's monotonic clock in ms, trusted not to run faster than real time (default performance.now()). */
	monotonic?: () => number;
	/**
	 * Read-only view for `--read-only` processes: the file is opened read-only, no table is created,
	 * nothing is migrated and every write method throws `READ_ONLY`. A database without the
	 * node-health tables reads as empty (no history, switch off).
	 */
	readOnly?: boolean;
}
export interface RecordResult { node: string; seq: number; at: number; writer: string; counted?: CountedBy }

function hasStateTable(db: Database) {
	return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_health_state'").get();
}

/**
 * Caller-owned durable sidecar. Every probe is a row with a store-assigned sequence; stability is the
 * clock-free fold above over those probes. Each instance is one writer with a random id and keeps
 * its own anchors in memory, so credit is only ever earned inside one process lifetime and nothing
 * about other writers has to be retained or evicted. Any number of instances may write one file.
 */
export class NodeHealthHistory {
	private conn: Database;
	/** Read-only view opened before the node-health tables existed: the read-only file connection, adopted once they appear. */
	private pending?: Database;
	readonly policy: Readonly<HealthPolicy>;
	readonly writer = randomUUID();
	private clock: () => number;
	private monotonic: () => number;
	private anchors = new Map<string, { anchor?: Anchor; latestSeq: number }>();
	readonly readOnly: boolean;
	constructor(path: string, config: Partial<HealthPolicy> = {}, options: HealthHistoryOptions = {}) {
		this.policy = healthPolicy(config);
		this.clock = options.clock ?? Date.now;
		this.monotonic = options.monotonic ?? (() => performance.now());
		this.readOnly = options.readOnly === true;
		if (this.readOnly) {
			this.conn = new Database(path, { readonly: true, create: false });
			try {
				this.conn.exec("PRAGMA busy_timeout=10000; PRAGMA query_only=ON;");
				this.guardDatabase();
				if (hasStateTable(this.conn)) return;
			} catch (error) {
				this.conn.close();
				throw error;
			}
			// Nothing recorded yet: an empty in-memory schema answers reads, the file stays untouched, and the
			// file connection is adopted on the first read after another process creates the tables.
			this.pending = this.conn;
			this.conn = new Database(":memory:");
			this.createSchema();
			this.conn.exec("PRAGMA query_only=ON;");
			return;
		}
		this.conn = new Database(path, { create: true });
		try {
			this.db.exec("PRAGMA busy_timeout=10000");
			this.db.transaction(() => {
				this.guardDatabase();
				this.createSchema();
				this.migrate();
			}).immediate();
		} catch (error) {
			this.db.close();
			throw error;
		}
	}
	private get db(): Database {
		if (this.pending && hasStateTable(this.pending)) {
			this.conn.close();
			this.conn = this.pending;
			this.pending = undefined;
		}
		return this.conn;
	}
	private writable() { if (this.readOnly) throw new Error("READ_ONLY"); }
	private createSchema() {
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, at INTEGER NOT NULL, mono REAL, epoch TEXT NOT NULL, data TEXT NOT NULL)");
		this.db.exec("CREATE INDEX IF NOT EXISTS node_health_rows_node ON node_health_rows(node, seq)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_state (node TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_warnings (id INTEGER PRIMARY KEY, task TEXT NOT NULL, node TEXT NOT NULL, at INTEGER NOT NULL, dimensions TEXT NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_warning_rollup (node TEXT PRIMARY KEY, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_bootstrap (id INTEGER PRIMARY KEY, node TEXT NOT NULL, reason TEXT NOT NULL, started_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT, observations INTEGER NOT NULL DEFAULT 0)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
		this.db.exec("CREATE TABLE IF NOT EXISTS node_health_gating (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), operator TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL)");
	}
	/**
	 * Share a FleetStore database, or own a node-health file (new, empty, or written by an earlier
	 * sidecar). Anything else is refused untouched. A sidecar created first on a path that FleetStore
	 * opens later is accepted by FleetStore (it adopts a file holding only node-health tables).
	 */
	private guardDatabase() {
		const id = (this.db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
		if (id === FLEET_STORE_APPLICATION_ID) return;
		const tables = (this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(r => r.name);
		if (id !== 0 || !tables.every(name => NODE_HEALTH_TABLE.test(name))) throw new Error("node_health_unrelated_database");
	}
	/**
	 * Earlier candidate sidecars (any state version below 5, or the legacy `node_health` /
	 * `node_health_failures` tables) are migrated fail-closed: their incremental state is discarded,
	 * every node with any recorded failure mark restarts as recovering from that failure with zero
	 * counted probes, and the obsolete time-accounting tables are dropped. Display rows are kept.
	 */
	private migrate() {
		const version = (this.db.query("SELECT value FROM node_health_meta WHERE key='state_version'").get() as { value: string } | null)?.value;
		if (version === String(STATE_VERSION)) return;
		const has = (name: string) => !!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
		const failed = new Map<string, Set<Dimension>>();
		const mark = (node: string, dimension: string) => {
			if (!(dimensions as readonly string[]).includes(dimension)) return;
			if (!failed.has(node)) failed.set(node, new Set());
			failed.get(node)!.add(dimension as Dimension);
		};
		for (const table of ["node_health_failures", "node_health_marks"]) if (has(table))
			for (const row of this.db.query(`SELECT node, dimension FROM ${table}`).all() as { node: string; dimension: string }[]) mark(row.node, row.dimension);
		for (const table of ["node_health_failures", "node_health", "node_health_marks", "node_health_anomalies", "node_health_anomaly_rollup"]) if (has(table)) this.db.exec(`DROP TABLE ${table}`);
		this.db.exec("DELETE FROM node_health_state");
		const at = this.clock();
		for (const [node, dims] of failed) {
			const latest: HealthObservation = { at, reachable: !dims.has("reachable"), brokerSessionListOk: dims.has("brokerSessionListOk") ? false : null, resourceSampleOk: dims.has("resourceSampleOk") ? false : null, latencyMs: 0 };
			const state: NodeHealthState = { v: STATE_VERSION, seq: 0, latest, latestWriter: "migration", count: 0, recovering: true, last: null, pending: 0, writers: [], observed: [], failure: { seq: 0, at, dimensions: dimensions.filter(key => dims.has(key)) } };
			this.db.query("INSERT INTO node_health_state VALUES (?,?,?)").run(node, 0, JSON.stringify(state));
		}
		this.db.query("INSERT INTO node_health_meta VALUES ('state_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(STATE_VERSION));
	}
	/**
	 * Operator switch for automatic selection. Off (no row yet, or the latest row disables it): the
	 * history only observes and records; placement uses exactly the pre-feature inputs and the
	 * decisions are reported, not applied. On: unstable nodes are excluded and pinned dispatch onto
	 * an unstable node carries a `node_health_warning`. Every change is an audited row (bounded).
	 */
	selectionGating(): { enabled: boolean; operator?: string; reason?: string; at?: number } {
		const row = this.db.query("SELECT enabled, operator, reason, at FROM node_health_gating ORDER BY id DESC LIMIT 1").get() as { enabled: number; operator: string; reason: string; at: number } | null;
		return row ? { enabled: row.enabled === 1, operator: row.operator, reason: row.reason, at: row.at } : { enabled: false };
	}
	setSelectionGating(enabled: boolean, approval: { operator: string; reason: string }) {
		this.writable();
		if (typeof enabled !== "boolean") throw new Error("invalid_selection_gating");
		gatingApproval(approval);
		this.db.transaction(() => {
			this.db.query("INSERT INTO node_health_gating(enabled, operator, reason, at) VALUES (?,?,?,?)").run(enabled ? 1 : 0, approval.operator, approval.reason, this.clock());
			this.db.query("DELETE FROM node_health_gating WHERE id NOT IN (SELECT id FROM node_health_gating ORDER BY id DESC LIMIT ?)").run(GATING_AUDIT_CAPACITY);
		}).immediate();
		return this.selectionGating();
	}
	selectionGatingAudit() { return this.db.query("SELECT * FROM node_health_gating ORDER BY id").all(); }
	/** Store wall clock (display only). */
	now() { return this.clock(); }
	/** This process's monotonic clock (bootstrap deadlines, resource evidence age; never compared across processes). */
	monotonicNow() {
		const mono = this.monotonic();
		if (!Number.isFinite(mono)) throw new Error("invalid_monotonic_reading");
		return mono;
	}
	/**
	 * Stamp a resource sample this process just received with this instance's monotonic clock. Only
	 * stamped evidence can make the resource dimension `true`, and only while its monotonic age is
	 * within the admission policy's `maxSampleAgeMs`; the sample's wall `at` is never read for health.
	 */
	stampSample<T>(sample: T): { sample: T; mono: number } { return { sample, mono: this.monotonicNow() }; }
	/**
	 * Record one real probe. The write lock is taken before the store reads its clocks, so sequence
	 * order is real-time order across all writers. Every probe is recorded (a failure always resets);
	 * the newest `capacity` rows per node are retained for display.
	 */
	record(node: string, probe: HealthProbe): RecordResult {
		this.writable();
		if (typeof node !== "string" || !node || !validProbe(probe)) throw new Error("invalid_health_observation");
		const memory = this.anchors.get(node);
		const result = this.db.transaction(() => {
			const at = this.clock();
			if (!Number.isFinite(at)) throw new Error("invalid_wall_reading");
			const mono = this.monotonicNow();
			const observation: HealthObservation = { at, reachable: probe.reachable, brokerSessionListOk: probe.brokerSessionListOk, resourceSampleOk: probe.resourceSampleOk, latencyMs: probe.latencyMs };
			const seq = Number(this.db.query("INSERT INTO node_health_rows(node, at, mono, epoch, data) VALUES (?,?,?,?,?)").run(node, at, mono, this.writer, JSON.stringify(observation)).lastInsertRowid);
			const step = stepHealth(this.state(node), { observation, seq, writer: this.writer, mono }, memory?.anchor, this.policy);
			this.db.query("INSERT INTO node_health_state VALUES (?,?,?) ON CONFLICT(node) DO UPDATE SET seq=excluded.seq, data=excluded.data").run(node, seq, JSON.stringify(step.state));
			this.db.query("DELETE FROM node_health_rows WHERE node=? AND seq NOT IN (SELECT seq FROM node_health_rows WHERE node=? ORDER BY seq DESC LIMIT ?)").run(node, node, this.policy.capacity);
			return { step, seq, at };
		}).immediate();
		// Memory changes only after the commit; least recently probed nodes are evicted first.
		this.anchors.delete(node);
		this.anchors.set(node, { anchor: result.step.anchor, latestSeq: result.seq });
		if (this.anchors.size > ANCHOR_CAPACITY) this.anchors.delete(this.anchors.keys().next().value!);
		return { node, seq: result.seq, at: result.at, writer: this.writer, ...(result.step.counted ? { counted: result.step.counted } : {}) };
	}
	private state(node: string): NodeHealthState | undefined {
		const row = this.db.query("SELECT data FROM node_health_state WHERE node=?").get(node) as { data: string } | null;
		const state = row ? JSON.parse(row.data) as NodeHealthState : undefined;
		return state?.v === STATE_VERSION ? state : undefined;
	}
	/** Retained observations in recording (sequence) order, as stamped by the store. */
	observations(node: string): HealthObservation[] { return this.db.query("SELECT data FROM node_health_rows WHERE node=? ORDER BY seq").all(node).map((r: any) => JSON.parse(r.data)); }
	/** Retained rows with their store-assigned sequence, writer and readings. */
	rows(node: string) {
		return (this.db.query("SELECT seq, at, mono, epoch, data FROM node_health_rows WHERE node=? ORDER BY seq").all(node) as any[]).map(r => ({ seq: r.seq as number, at: r.at as number, mono: r.mono as number, writer: r.epoch as string, observation: JSON.parse(r.data) as HealthObservation }));
	}
	/** True when anything is known about the node, including the failure state of a collected node. */
	hasHistory(node: string) { return !!this.db.query("SELECT 1 FROM node_health_state WHERE node=?").get(node); }
	/** Dashboard consumption: exact dimensions and policy stability, not utilization. Clock-free. */
	dimensions(node: string) { return { nodeId: node, ...evaluateHealth(this.state(node), this.policy) }; }
	/**
	 * Pure decision. Automatic admission needs a stable node AND the decision's own probe: `probe`
	 * is the RecordResult of the probe this decision recorded for `node` through this instance
	 * (freshness by sequence, not by clock age; the result's state already includes that probe, so a
	 * node that failed it is not stable). An unstable or unprobed pin is allowed; its warning is
	 * recorded with the reservation.
	 */
	admit(node: string, pinned: boolean, probe?: RecordResult): HealthDecision {
		const dims = this.dimensions(node);
		const fresh = !!probe && probe.node === node && probe.writer === this.writer && this.anchors.has(node) && probe.seq <= dims.latestSeq;
		const health = fresh ? dims : { ...dims, stable: false, failingDimensions: [...dims.failingDimensions, "decision_probe_required"] };
		return { allowed: health.stable || pinned, reason: health.stable ? undefined : "node_unstable", warning: !health.stable && pinned, health };
	}
	/**
	 * Sidecar copy of the warning for one actually reserved pinned task (the authoritative record is
	 * the `node_health_warning` event written by the store in the reservation transaction); bounded
	 * with a per-node rollup.
	 */
	auditPinnedAdmission(task: string, node: string, failingDimensions: readonly string[], now = this.clock()) {
		this.writable();
		this.db.transaction(() => {
			if (this.db.query("SELECT 1 FROM node_health_warnings WHERE task=?").get(task)) return;
			this.db.query("INSERT INTO node_health_warnings(task,node,at,dimensions) VALUES (?,?,?,?)").run(task, node, now, JSON.stringify(failingDimensions));
			const excess = (this.db.query("SELECT COUNT(*) AS n FROM node_health_warnings").get() as { n: number }).n - WARNING_CAPACITY;
			if (excess <= 0) return;
			const old = this.db.query("SELECT id, node, at FROM node_health_warnings ORDER BY id LIMIT ?").all(excess) as { id: number; node: string; at: number }[];
			for (const row of old) {
				this.rollupWarning(row.node, 1, row.at, row.at);
				this.db.query("DELETE FROM node_health_warnings WHERE id=?").run(row.id);
			}
		}).immediate();
	}
	private rollupWarning(node: string, count: number, first: number, last: number) {
		this.db.query("INSERT INTO node_health_warning_rollup VALUES (?,?,?,?) ON CONFLICT(node) DO UPDATE SET count=count+excluded.count, first_at=MIN(first_at,excluded.first_at), last_at=MAX(last_at,excluded.last_at)").run(node, count, first, last);
	}
	warnings() { return this.db.query("SELECT * FROM node_health_warnings ORDER BY id").all(); }
	warningRollups() { return this.db.query("SELECT * FROM node_health_warning_rollup ORDER BY node").all(); }
	/**
	 * Audited start of a bounded bootstrap for a node that is not stable (a stable node is refused with
	 * `node_health_stable`). Bootstrap only adds real probes through `record()` from one process, so
	 * it cannot shorten anything; concurrent runs are harmless and each is audited. `deadline_at` is
	 * the wall-clock display of the run's budget; the run itself is bounded by its monotonic clock.
	 */
	beginBootstrap(node: string, reason: string, durationMs: number) {
		this.writable();
		if (typeof reason !== "string" || !reason.trim() || reason.length > 512) throw new Error("bootstrap_reason_required");
		if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > bootstrapPlan(this.policy, true).budgetMs) throw new Error("invalid_bootstrap_duration");
		return this.db.transaction(() => {
			if (this.dimensions(node).stable) throw new Error("node_health_stable");
			const now = this.clock();
			const id = Number(this.db.query("INSERT INTO node_health_bootstrap(node,reason,started_at,deadline_at) VALUES (?,?,?,?)").run(node, reason, now, now + durationMs).lastInsertRowid);
			this.db.query("DELETE FROM node_health_bootstrap WHERE node=? AND id NOT IN (SELECT id FROM node_health_bootstrap WHERE node=? ORDER BY id DESC LIMIT ?)").run(node, node, BOOTSTRAP_AUDIT_PER_NODE);
			return id;
		}).immediate();
	}
	/** Running count of recorded probes, so an unfinished row still states what its run recorded. */
	bootstrapProgress(id: number, observations: number) {
		this.writable();
		this.db.query("UPDATE node_health_bootstrap SET observations=? WHERE id=?").run(observations, id);
	}
	finishBootstrap(id: number, outcome: "stable" | "failed" | "unstable" | "deadline_exceeded", observations: number) {
		this.writable();
		this.db.query("UPDATE node_health_bootstrap SET finished_at=?, outcome=?, observations=? WHERE id=? AND finished_at IS NULL").run(this.clock(), outcome, observations, id);
	}
	bootstraps(node?: string) {
		return node === undefined ? this.db.query("SELECT * FROM node_health_bootstrap ORDER BY id").all() : this.db.query("SELECT * FROM node_health_bootstrap WHERE node=? ORDER BY id").all(node);
	}
	/** Nodes with retained state, rows or bootstrap rows. */
	trackedNodes(): string[] {
		return (this.db.query("SELECT node FROM node_health_state UNION SELECT node FROM node_health_rows UNION SELECT node FROM node_health_bootstrap ORDER BY node").all() as { node: string }[]).map(r => r.node);
	}
	/** Unregistered nodes kept only because they have not recovered from a failure. */
	tombstones(): string[] {
		return (this.db.query("SELECT node FROM node_health_state WHERE node NOT IN (SELECT node FROM node_health_rows) AND node NOT IN (SELECT node FROM node_health_bootstrap) ORDER BY node").all() as { node: string }[]).map(r => r.node);
	}
	/**
	 * Collect nodes that are no longer registered; clock-free. Collection never makes a node look
	 * healthier: rows and bootstrap rows go, and the state goes unless the node is still recovering
	 * from a failure. Such a state is kept as a tombstone (at most TOMBSTONE_CAPACITY nodes, oldest
	 * failure evicted first and counted), so re-registering cannot launder a failure. The collected
	 * node's warning rollup is folded into REMOVED_NODES_ROLLUP.
	 */
	retainNodes(registered: Iterable<string>) {
		this.writable();
		const keep = new Set(registered);
		const removed: string[] = [];
		this.db.transaction(() => {
			for (const node of this.trackedNodes()) {
				if (keep.has(node)) continue;
				const state = this.state(node);
				const unrecovered = !!state && state.recovering && state.count < this.policy.recoveryConsecutive;
				for (const table of unrecovered ? ["node_health_rows", "node_health_bootstrap"] : ["node_health_rows", "node_health_state", "node_health_bootstrap"]) this.db.query(`DELETE FROM ${table} WHERE node=?`).run(node);
				const rollup = this.db.query("SELECT count, first_at, last_at FROM node_health_warning_rollup WHERE node=?").get(node) as { count: number; first_at: number; last_at: number } | null;
				if (rollup) {
					this.rollupWarning(REMOVED_NODES_ROLLUP, rollup.count, rollup.first_at, rollup.last_at);
					this.db.query("DELETE FROM node_health_warning_rollup WHERE node=?").run(node);
				}
				removed.push(node);
			}
			const tombstones = (this.db.query("SELECT node FROM node_health_state ORDER BY seq, node").all() as { node: string }[]).filter(row => !keep.has(row.node));
			if (tombstones.length > TOMBSTONE_CAPACITY) {
				const evict = tombstones.slice(0, tombstones.length - TOMBSTONE_CAPACITY);
				for (const row of evict) this.db.query("DELETE FROM node_health_state WHERE node=?").run(row.node);
				// Bounded, never silent: evicted tombstones are counted.
				this.db.query("INSERT INTO node_health_meta VALUES ('failure_tombstones_evicted', ?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+CAST(excluded.value AS INTEGER)").run(String(evict.length));
			}
		}).immediate();
		return removed;
	}
	/** Count of failure tombstones evicted by TOMBSTONE_CAPACITY. */
	evictedTombstones() { return Number((this.db.query("SELECT value FROM node_health_meta WHERE key='failure_tombstones_evicted'").get() as { value: string } | null)?.value ?? 0); }
	close() {
		this.pending?.close();
		this.conn.close();
	}
}
