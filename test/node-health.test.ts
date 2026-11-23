import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANCHOR_CAPACITY, NodeHealthHistory, REMOVED_NODES_ROLLUP, TOMBSTONE_CAPACITY, WARNING_CAPACITY, defaultHealthPolicy, evaluateHealth, healthPolicy, stepHealth, type HealthPolicy, type HealthProbe } from "../src/node-health";
import { FleetStore } from "../src/store";

const S = 1000;
const good: HealthProbe = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
const bad: HealthProbe = { ...good, reachable: false };
const open: NodeHealthHistory[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempPath = (name = "h.sqlite") => { const d = mkdtempSync(join(tmpdir(), "node-health-")); dirs.push(d); return join(d, name); };
/** One writer (process): wall clock for display, monotonic clock for credit. */
function writer(path = ":memory:", config: Partial<HealthPolicy> = {}, start = { wall: 1_800_000_000_000, mono: 5_000 }) {
	const c = { ...start };
	const h = new NodeHealthHistory(path, config, { clock: () => c.wall, monotonic: () => c.mono });
	open.push(h);
	const tick = (ms: number) => { c.wall += ms; c.mono += ms; };
	return { h, c, tick, rec: (o: HealthProbe = good, node = "n") => h.record(node, o) };
}
const close = (h: NodeHealthHistory) => { h.close(); open.splice(open.indexOf(h), 1); };
const opened = (path: string) => { const h = new NodeHealthHistory(path); open.push(h); return h; };

test("policy: defaults, bounds and cross-field rules; checks can be neither disabled nor made unbounded", () => {
	expect(defaultHealthPolicy).toEqual({ consecutive: 3, recoveryConsecutive: 5, spacingMs: 30_000, restartFallbackWriters: 64, capacity: 128 });
	expect(Object.isFrozen(healthPolicy({}))).toBe(true);
	for (const bad of [{ consecutive: 1 }, { consecutive: 65 }, { recoveryConsecutive: 1 }, { recoveryConsecutive: 257 }, { consecutive: 4, recoveryConsecutive: 3 }, { spacingMs: 0 }, { spacingMs: 4_999 }, { spacingMs: 3_600_001 }, { restartFallbackWriters: 1 }, { restartFallbackWriters: 15 }, { restartFallbackWriters: 1025 }, { capacity: 15 }, { capacity: 4097 },
		{ spacingMs: 30_000.5 }, { spacingMs: Number.NaN }, { spacingMs: Infinity }, { consecutive: "3" }, { consecutive: -3 }, { consecutive: 3n }, { capacity: undefined }, { staleMs: 30_000 }, { spanMs: 60_000 }, { extra: 1 }] as any[])
		expect(() => healthPolicy(bad)).toThrow("invalid_health_policy");
	for (const raw of ['{"__proto__":{"consecutive":1}}', '{"constructor":1}', '{"toString":1}']) expect(() => healthPolicy(JSON.parse(raw))).toThrow("invalid_health_policy");
	expect(() => healthPolicy({ [Symbol("x")]: 1 } as any)).toThrow("invalid_health_policy");
	expect(() => healthPolicy(null as any)).toThrow("invalid_health_policy");
	// Every edge policy is satisfiable by one writer probing spacingMs apart: exactly `consecutive` probes.
	for (const config of [{}, { consecutive: 2, recoveryConsecutive: 2, spacingMs: 5_000, restartFallbackWriters: 16, capacity: 16 }, { consecutive: 64, recoveryConsecutive: 256, spacingMs: 3_600_000, restartFallbackWriters: 1024, capacity: 4096 }]) {
		const p = healthPolicy(config);
		const w = writer(":memory:", config);
		for (let i = 1; i <= p.consecutive; i++) { if (i > 1) w.tick(p.spacingMs); w.rec(); expect(w.h.dimensions("n").stable).toBe(i === p.consecutive); }
	}
});

test("one writer: stable after `consecutive` probes spacingMs apart by its own monotonic clock; faster probes do not count", () => {
	const slow = writer();
	const counted = [0, 1, 2].map(i => { if (i) slow.tick(30 * S); return slow.rec().counted; });
	expect(counted).toEqual(["first", "spacing", "spacing"]);
	expect(slow.h.dimensions("n")).toMatchObject({ stable: true, consecutiveGood: 3, required: 3, failingDimensions: [] });
	// Cadence 10 s: every third probe counts; stable after 7 probes / 60 s.
	const ten = writer();
	const stableAt = Array.from({ length: 9 }, (_, i) => { if (i) ten.tick(10 * S); ten.rec(); return ten.h.dimensions("n").stable; }).indexOf(true);
	expect(stableAt).toBe(6);
	// A burst of 1000 probes from one writer within 1 s: it counts once and never uses the restart fallback.
	const burst = writer();
	for (let i = 0; i < 1000; i++) { burst.tick(1); burst.rec(); }
	expect(burst.h.dimensions("n")).toMatchObject({ stable: false, consecutiveGood: 1, pendingProbes: 999, fallbackInWriters: 63 });
	expect(burst.h.observations("n")).toHaveLength(128);
});

test("a real failure always resets, whatever the clocks do; recovery needs recoveryConsecutive counted probes", () => {
	const w = writer();
	for (let i = 0; i < 5; i++) { w.tick(30 * S); w.rec(); }
	expect(w.h.dimensions("n").stable).toBe(true);
	for (const [o, dim] of [[bad, "reachable"], [{ ...good, brokerSessionListOk: false }, "brokerSessionListOk"], [{ ...good, resourceSampleOk: false }, "resourceSampleOk"]] as const) {
		// Wall stepped back a year and monotonic frozen at the failure: still a reset.
		w.c.wall -= 365 * 24 * 3600 * S;
		w.rec(o);
		expect(w.h.dimensions("n")).toMatchObject({ stable: false, consecutiveGood: 0, required: 5, failingDimensions: [dim, "consecutive_observations"], lastFailure: { dimensions: [dim] } });
		for (let i = 1; i <= 5; i++) { if (i > 1) w.tick(30 * S); w.rec(); expect(w.h.dimensions("n").stable).toBe(i === 5); }
		expect(w.h.dimensions("n").failingDimensions).toEqual([]);
	}
	// A failure between two goods at one instant, by another writer: not hidden.
	const other = new NodeHealthHistory(":memory:", {}, { clock: () => 0, monotonic: () => 0 });
	open.push(other);
	other.record("m", good);
	other.record("m", bad);
	other.record("m", good);
	expect(other.dimensions("m")).toMatchObject({ stable: false, consecutiveGood: 1, failingDimensions: ["reachable", "consecutive_observations"] });
});

test("clock anomalies only withhold credit: frozen, backward or jumping clocks never count and never reset", () => {
	const w = writer();
	w.rec();
	// Monotonic frozen for an hour while the wall moves: nothing counts, nothing resets.
	for (let i = 0; i < 10; i++) { w.c.wall += 10 * 60 * S; w.rec(); }
	expect(w.h.dimensions("n")).toMatchObject({ stable: false, consecutiveGood: 1, pendingProbes: 10 });
	// Monotonic backward: a negative delta is no credit.
	w.c.mono -= 1_000 * S; w.rec();
	expect(w.h.dimensions("n").consecutiveGood).toBe(1);
	// The anchor stays the earliest own probe since the last count, so honest time resumes from it.
	w.c.mono += 1_030 * S; w.rec();
	expect(w.h.dimensions("n").consecutiveGood).toBe(2);
	// Wall clock is display only: evaluation is identical whatever the wall says now.
	const before = w.h.dimensions("n");
	w.c.wall = 0;
	expect(w.h.dimensions("n")).toEqual(before);
	expect(() => { w.c.mono = Number.NaN; w.rec(); }).toThrow("invalid_monotonic_reading");
});

test("writers: a new process anchors on its first probe and counts after its own spacing; one-shot writers count via the restart fallback", () => {
	const path = tempPath();
	const a = writer(path);
	a.rec();
	close(a.h);
	const b = writer(path, {}, { wall: 0, mono: 999_999_999 });
	expect(b.rec().counted).toBeUndefined();
	b.tick(29_999); expect(b.rec().counted).toBeUndefined();
	b.tick(1); expect(b.rec().counted).toBe("spacing");
	b.tick(30 * S); b.rec();
	expect(b.h.dimensions("n")).toMatchObject({ stable: true, consecutiveGood: 3 });
	// One probe per process: the 64th distinct writer since the last count counts; the same writer twice counts once.
	const q = tempPath();
	const first = writer(q); first.rec(); close(first.h);
	for (let i = 1; i <= 64; i++) {
		const one = writer(q, {}, { wall: 0, mono: 0 });
		const r = one.rec();
		expect([i, r.counted]).toEqual([i, i === 64 ? "fallback" : undefined]);
		if (i === 10) { expect(one.rec().counted).toBeUndefined(); expect(one.h.dimensions("n").fallbackInWriters).toBe(54); }
		close(one.h);
	}
	expect(opened(q).dimensions("n")).toMatchObject({ consecutiveGood: 2, pendingProbes: 0 });
}, 30_000);

test("admission needs the decision's own probe through the same instance (freshness by sequence, not clock age)", () => {
	const path = tempPath();
	const w = writer(path);
	const results = [0, 1, 2].map(i => { if (i) w.tick(30 * S); return w.rec(); });
	expect(w.h.dimensions("n").stable).toBe(true);
	expect(w.h.admit("n", false, results[2])).toMatchObject({ allowed: true, warning: false });
	expect(w.h.admit("n", false).health.failingDimensions).toEqual(["decision_probe_required"]);
	expect(w.h.admit("n", false).allowed).toBe(false);
	expect(w.h.admit("other", false, results[2]).allowed).toBe(false);
	// Another instance's record (another process) is not this decision's probe.
	const other = writer(path);
	const foreign = other.rec();
	expect(w.h.admit("n", false, foreign).allowed).toBe(false);
	expect(other.h.admit("n", false, foreign).allowed).toBe(true);
	// The decision's probe failed: not admitted; a pin is admitted with an audited warning.
	const failed = w.rec(bad);
	expect(w.h.admit("n", false, failed).allowed).toBe(false);
	expect(w.h.admit("n", true, failed)).toMatchObject({ allowed: true, warning: true, reason: "node_unstable" });
	const fresh = w.h.admit("new", true);
	expect(fresh).toMatchObject({ allowed: true, warning: true });
	expect(fresh.health.failingDimensions).toEqual(["no_history", "decision_probe_required"]);
});

test("not observed is neither failure nor success", () => {
	const w = writer();
	const partial = { ...good, brokerSessionListOk: null, resourceSampleOk: null };
	for (let i = 0; i < 3; i++) { if (i) w.tick(30 * S); w.rec(partial); }
	expect(w.h.dimensions("n")).toMatchObject({ stable: false, consecutiveGood: 3, unobserved: ["brokerSessionListOk", "resourceSampleOk"], failingDimensions: ["unobserved:brokerSessionListOk", "unobserved:resourceSampleOk"] });
	w.rec();
	expect(w.h.dimensions("n").stable).toBe(true);
	w.tick(30 * S); w.rec(partial);
	expect(w.h.dimensions("n").stable).toBe(true);
});

test("pure fold is clock-free and bounded: 20 000 probes from distinct writers keep the state small", () => {
	let state: any, anchors = new Map<string, any>();
	for (let seq = 1; seq <= 20_000; seq++) {
		const writer = "w" + seq;
		const step = stepHealth(state, { observation: { ...good, at: 0 }, seq, writer, mono: 0 }, anchors.get(writer));
		state = step.state;
	}
	expect(state.writers.length).toBeLessThan(64);
	expect(JSON.stringify(state).length).toBeLessThan(4_000);
	expect(evaluateHealth(state)).toMatchObject({ stable: true, consecutiveGood: 1 + Math.floor(19_999 / 64) });
	// Anchor memory is bounded per instance; evicting an anchor only withholds credit.
	const w = writer();
	for (let i = 0; i <= ANCHOR_CAPACITY; i++) w.rec(good, "node-" + i);
	w.tick(30 * S);
	expect(w.rec(good, "node-0").counted).toBeUndefined();
	expect(w.rec(good, "node-" + ANCHOR_CAPACITY).counted).toBe("spacing");
});

test("pinned warnings are bounded with rollups; unregistered nodes are collected without any clock and failures are kept as tombstones", () => {
	const w = writer();
	for (let i = 0; i < WARNING_CAPACITY + 10; i++) w.h.auditPinnedAdmission("task-" + i, i % 2 ? "fine" : "gone", ["reachable"], i);
	w.h.auditPinnedAdmission("task-" + (WARNING_CAPACITY + 9), "fine", ["reachable"], 0);
	expect(w.h.warnings()).toHaveLength(WARNING_CAPACITY);
	expect((w.h.warningRollups() as { count: number }[]).reduce((sum, r) => sum + r.count, 0)).toBe(10);
	w.rec(bad, "gone");
	w.rec(good, "fine");
	w.rec(good, "kept");
	expect(w.h.retainNodes(["kept"]).sort()).toEqual(["fine", "gone"]);
	expect(w.h.trackedNodes()).toEqual(["gone", "kept"]);
	expect(w.h.tombstones()).toEqual(["gone"]);
	expect(w.h.hasHistory("fine")).toBe(false);
	expect((w.h.warningRollups() as { node: string }[]).map(r => r.node)).toEqual([REMOVED_NODES_ROLLUP]);
	// Re-registering a collected failed node keeps its recovering state.
	w.tick(30 * S);
	w.rec(good, "gone");
	expect(w.h.dimensions("gone")).toMatchObject({ required: 5, consecutiveGood: 1, failingDimensions: ["reachable", "consecutive_observations"] });
	// Tombstones are bounded; evictions are counted.
	for (let i = 0; i < TOMBSTONE_CAPACITY + 3; i++) w.rec(bad, "t" + i);
	w.h.retainNodes(["kept"]);
	expect(w.h.tombstones()).toHaveLength(TOMBSTONE_CAPACITY);
	expect(w.h.evictedTombstones()).toBe(4);
});

test("schema: additive on an existing FleetStore DB, fresh files bootstrap, unrelated databases are refused untouched", () => {
	const path = tempPath("fleet.sqlite");
	new FleetStore(path).close();
	const before = new Database(path);
	const schema = before.query("SELECT name, sql FROM sqlite_master ORDER BY name").all() as { name: string; sql: string }[];
	before.close();
	const w = writer(path);
	w.rec();
	close(w.h);
	const store = new FleetStore(path);
	expect(store.tasks()).toHaveLength(0);
	store.close();
	const db = new Database(path);
	for (const row of schema) expect(db.query("SELECT name, sql FROM sqlite_master WHERE name=?").get(row.name)).toEqual(row);
	db.close();
	// Fresh dedicated file: works and reopens with its history.
	const fresh = tempPath();
	const f = writer(fresh); f.rec(); close(f.h);
	expect(opened(fresh).observations("n")).toHaveLength(1);
	// Unrelated application id.
	const other = tempPath();
	const o = new Database(other); o.exec("PRAGMA application_id=1234"); o.close();
	expect(() => new NodeHealthHistory(other)).toThrow("node_health_unrelated_database");
});

test("migration: earlier candidate sidecars fail closed; a recorded failure mark restarts as recovering, obsolete tables are dropped", () => {
	const path = tempPath("fleet.sqlite");
	new FleetStore(path).close();
	const db = new Database(path);
	// Legacy (round 1) tables.
	db.exec("CREATE TABLE node_health (node TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(node,at))");
	db.exec("CREATE TABLE node_health_failures (node TEXT NOT NULL, dimension TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(node,dimension))");
	db.query("INSERT INTO node_health_failures VALUES (?,?,?)").run("legacy", "brokerSessionListOk", 50);
	db.query("INSERT INTO node_health_failures VALUES (?,?,?)").run("legacy", "unknown_dimension", 50);
	// Round 2-4 tables: state (any version below 5), marks, anomalies.
	db.exec("CREATE TABLE node_health_rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, at INTEGER NOT NULL, mono REAL, epoch TEXT NOT NULL, data TEXT NOT NULL)");
	db.exec("CREATE TABLE node_health_state (node TEXT PRIMARY KEY, seq INTEGER NOT NULL, data TEXT NOT NULL)");
	db.exec("CREATE TABLE node_health_marks (node TEXT NOT NULL, dimension TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, credited_ms INTEGER NOT NULL, goods_since INTEGER NOT NULL, PRIMARY KEY(node, dimension))");
	db.exec("CREATE TABLE node_health_anomalies (id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)");
	db.exec("CREATE TABLE node_health_anomaly_rollup (kind TEXT PRIMARY KEY, count INTEGER NOT NULL, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL)");
	db.exec("CREATE TABLE node_health_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
	db.query("INSERT INTO node_health_meta VALUES ('state_version','4')").run();
	db.query("INSERT INTO node_health_rows(node,at,mono,epoch,data) VALUES (?,?,?,?,?)").run("v4", 1, 1, "e", JSON.stringify({ ...good, at: 1 }));
	db.query("INSERT INTO node_health_state VALUES (?,?,?)").run("v4", 1, JSON.stringify({ v: 4, tail: { count: 99 } }));
	db.query("INSERT INTO node_health_state VALUES (?,?,?)").run("stableV4", 1, JSON.stringify({ v: 4, tail: { count: 99 } }));
	db.query("INSERT INTO node_health_marks VALUES (?,?,?,?,?,?)").run("v4", "reachable", 1, 0, 999_999, 50);
	db.close();
	const w = writer(path);
	expect(w.h.dimensions("legacy")).toMatchObject({ stable: false, required: 5, failingDimensions: ["brokerSessionListOk", "consecutive_observations"] });
	expect(w.h.dimensions("v4")).toMatchObject({ stable: false, required: 5, failingDimensions: ["reachable", "consecutive_observations"] });
	expect(w.h.dimensions("stableV4")).toMatchObject({ stable: false, failingDimensions: ["no_history"] });
	expect(w.h.observations("v4")).toHaveLength(1);
	for (let i = 1; i <= 5; i++) { if (i > 1) w.tick(30 * S); w.rec(good, "v4"); }
	expect(w.h.dimensions("v4").stable).toBe(true);
	close(w.h);
	const check = new Database(path);
	expect((check.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'node_health%' ORDER BY name").all() as { name: string }[]).map(r => r.name))
		.toEqual(["node_health_bootstrap", "node_health_gating", "node_health_meta", "node_health_rows", "node_health_state", "node_health_warning_rollup", "node_health_warnings"]);
	check.close();
	// Reopening a version-5 sidecar keeps its state (no second migration).
	expect(opened(path).dimensions("v4").stable).toBe(true);
	const reopened = new FleetStore(path);
	reopened.close();
});
