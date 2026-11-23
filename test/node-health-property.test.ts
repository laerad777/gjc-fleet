// Randomized property test of the clock-free stability rule (RESULT.md design note).
//
// Every scenario is a real-time schedule of probes of one node by writer processes on hosts:
// long-lived producers (optionally restarting), crash loops (one probe per lifetime), one-shot
// writers, several concurrent producers, failure bursts, unobservable dimensions, and DB copies to
// another host (both the original and the copy continue). Clock anomalies are per host: monotonic
// suspends (frozen), slow periods, backward jumps, and arbitrary wall steps (display only). The
// trust assumption is only that a monotonic clock never runs faster than real time.
//
// Each DB history is folded twice with the same probes, writers and outcomes: with the anomalous
// clocks, and with honest clocks (monotonic = base + real time). Checked at every probe:
//  (1) the anomalous run is never ahead: count <= honest count, stable => honest stable;
//  (2) every real failure resets both runs (count 0, not stable);
//  (3) a healthy node probed by one long-lived writer at cadence c is stable after at most
//      1 + (need - 1) * ceil(spacingMs / c) probes (separate generator, honest clocks);
//  (4) in every run, anomalous included, a good streak with all dimensions observed and good probes
//      from more than (need - 1) * restartFallbackWriters distinct writers is stable, so no restart
//      pattern keeps a probed healthy node ineligible forever.
// A subset of scenarios is replayed through real NodeHealthHistory instances (one per process) on
// SQLite files, including file copies, and must match the pure fold exactly.
import { afterAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHealthHistory, defaultHealthPolicy as P, evaluateHealth, stepHealth, type Anchor, type HealthProbe, type NodeHealthState } from "../src/node-health";

const SEEDS = Number(process.env.NODE_HEALTH_PROPERTY_SEEDS ?? 1500);
const REAL_SEEDS = Number(process.env.NODE_HEALTH_PROPERTY_REAL_SEEDS ?? 40);
const S = 1000, M = 60 * S, H = 60 * M;
function rng(seed: number) {
	let s = (seed * 2654435761) >>> 0 || 1;
	return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
}
type R = () => number;
const pick = <T>(r: R, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

/** Per-host clock anomalies. Monotonic progress never exceeds real time; wall is display only. */
interface Host { id: string; frozen: [number, number][]; slow: [number, number][]; back: [number, number][]; wall: [number, number][] }
function overlap([a, b]: [number, number], t: number) { return Math.max(0, Math.min(b, t) - a); }
function monoProgress(h: Host, t: number) {
	let p = t;
	for (const iv of h.frozen) p -= overlap(iv, t);
	for (const iv of h.slow) p -= overlap(iv, t) / 2;
	for (const [at, ms] of h.back) if (at <= t) p -= ms;
	return p;
}
function wallOffset(h: Host, t: number) { let o = 0; for (const [at, ms] of h.wall) if (at <= t) o += ms; return o; }
function host(r: R, id: string, end: number, anomalous: boolean): Host {
	const h: Host = { id, frozen: [], slow: [], back: [], wall: [] };
	if (!anomalous) return h;
	const n = Math.floor(r() * 7);
	for (let i = 0; i < n; i++) {
		const at = r() * end;
		const len = pick(r, [5 * S, 20 * S, 35 * S, 2 * M, 10 * M, H]);
		const kind = pick(r, ["frozen", "slow", "back", "wall", "wall", "frozen+wall"] as const);
		if (kind === "frozen" || kind === "frozen+wall") h.frozen.push([at, at + len]);
		if (kind === "slow") h.slow.push([at, at + len]);
		if (kind === "back") h.back.push([at, pick(r, [1, 1_000, 30 * S, H])]);
		if (kind === "wall" || kind === "frozen+wall") h.wall.push([kind === "wall" ? at : at + len, pick(r, [-365 * 24 * H, -24 * H, -H, -len, -5 * S, 5 * S, len, H, 24 * H])]);
	}
	return h;
}

interface Probe { t: number; writer: string; host: string; base: number; o: HealthProbe }
interface Scenario { end: number; probes: Probe[]; copyAt?: number; hosts: Record<string, Host>; honestHosts: Record<string, Host> }
function scenario(seed: number): Scenario {
	const r = rng(seed);
	const end = pick(r, [10 * M, 30 * M, H, 3 * H]);
	const probes: Probe[] = [];
	let writerSeq = 0;
	const newWriter = () => ({ writer: "w" + seed + "-" + writerSeq++, base: Math.floor(r() * 2 ** 40) });
	const producers = 1 + Math.floor(r() * 3);
	for (let k = 0; k < producers; k++) {
		const c = pick(r, [1 * S, 5 * S, 10 * S, 15 * S, 20 * S, 30 * S, 45 * S, 60 * S, 2 * M]);
		const pattern = pick(r, ["long", "long", "restart", "crash", "oneshot"] as const);
		const lifetime = pattern === "long" ? Infinity : pattern === "restart" ? pick(r, [c, 2 * c, 3 * c, 5 * M, 30 * M]) : 0;
		const downtime = pick(r, [0, 1 * S, 10 * S, 40 * S, 5 * M]);
		const jitter = pick(r, [0, 0, 2 * S]);
		let t = r() * c, w = newWriter(), born = t;
		while (t < end && probes.length < 4000) {
			if (pattern === "oneshot" || pattern === "crash" || t - born > lifetime) { w = newWriter(); born = t; }
			probes.push({ t, ...w, host: "h1", o: { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 } });
			t += c + (jitter ? (r() - 0.5) * jitter : 0) + (pattern === "restart" && t - born + c > lifetime ? downtime : 0) + (pattern === "crash" ? downtime : 0);
		}
	}
	// Bursts of one-shot writers (reservations, CLI processes).
	if (r() < 0.3) {
		const rate = pick(r, [1 / M, 1 / (10 * S), 1 / S, 5 / S]);
		const from = r() * end, to = Math.min(end, from + pick(r, [M, 10 * M, H]));
		for (let t = from; t < to && probes.length < 6000; t += -Math.log(1 - r()) / rate) probes.push({ t, ...newWriter(), host: "h1", o: { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 } });
	}
	probes.sort((a, b) => a.t - b.t);
	// Outages and unobservable dimensions.
	const outages: [number, number][] = [];
	const nOut = pick(r, [0, 0, 1, 2, 5]);
	for (let i = 0; i < nOut; i++) { const at = r() * end; outages.push([at, at + pick(r, [0, 1 * S, 5 * S, 60 * S, 10 * M])]); }
	const nullRate = pick(r, [0, 0, 0.05, 0.3]);
	for (const p of probes) {
		if (outages.some(([a, b]) => p.t >= a && p.t <= b)) p.o = { ...p.o, [pick(r, ["reachable", "brokerSessionListOk", "resourceSampleOk"] as const)]: false };
		else if (r() < nullRate) p.o = { ...p.o, [pick(r, ["brokerSessionListOk", "resourceSampleOk"] as const)]: null };
	}
	const anomalous = r() < 0.85;
	const hosts = { h1: host(r, "h1", end, anomalous), h2: host(r, "h2", end, anomalous || r() < 0.5) };
	const honestHosts = { h1: host(r, "h1", end, false), h2: host(r, "h2", end, false) };
	return { end, probes, hosts, honestHosts, ...(r() < 0.3 ? { copyAt: r() * end } : {}) };
}
/** The probe lists of every DB history: the original, and the copy (new processes on host 2). */
function branches(sc: Scenario): Probe[][] {
	if (sc.copyAt === undefined) return [sc.probes];
	const before = sc.probes.filter(p => p.t < sc.copyAt!);
	const after = sc.probes.filter(p => p.t >= sc.copyAt!);
	return [sc.probes, [...before, ...after.map(p => ({ ...p, writer: p.writer + "@copy", host: "h2" }))]];
}
const mono = (hosts: Record<string, Host>, p: Probe) => p.base + monoProgress(hosts[p.host], p.t);
const wall = (hosts: Record<string, Host>, p: Probe) => 1_800_000_000_000 + p.t + wallOffset(hosts[p.host], p.t);

interface Fold { state?: NodeHealthState; anchors: Map<string, Anchor | undefined>; counted?: string }
function fold(f: Fold, p: Probe, seq: number, hosts: Record<string, Host>) {
	const step = stepHealth(f.state, { observation: { ...p.o, at: wall(hosts, p) }, seq, writer: p.writer, mono: mono(hosts, p) }, f.anchors.get(p.writer));
	f.state = step.state;
	f.anchors.set(p.writer, step.anchor);
	f.counted = step.counted;
	return evaluateHealth(f.state);
}

const stats = { scenarios: 0, histories: 0, probes: 0, stableEvaluations: 0, anomalousBehind: 0, copies: 0, fallbackCounts: 0, spacingCounts: 0, failures: 0, bound4Checks: 0 };
const violations: string[] = [];
function check(seed: number) {
	const sc = scenario(seed);
	stats.scenarios++;
	if (sc.copyAt !== undefined) stats.copies++;
	for (const [b, probes] of branches(sc).entries()) {
		stats.histories++;
		const anomalous: Fold = { anchors: new Map() }, honest: Fold = { anchors: new Map() };
		let streakWriters = new Set<string>(), allObserved = new Set<string>(), recovering = false;
		probes.forEach((p, i) => {
			stats.probes++;
			const seq = i + 1;
			const a = fold(anomalous, p, seq, sc.hosts);
			const h = fold(honest, p, seq, sc.honestHosts);
			const where = `seed ${seed} branch ${b} probe ${i} t=${Math.round(p.t)}`;
			if (a.stable) stats.stableEvaluations++;
			if (anomalous.counted === "fallback") stats.fallbackCounts++;
			if (anomalous.counted === "spacing") stats.spacingCounts++;
			if (a.consecutiveGood < h.consecutiveGood) stats.anomalousBehind++;
			// (1) never ahead of the honest run.
			if (a.consecutiveGood > h.consecutiveGood || (a.stable && !h.stable)) violations.push(`(1) ${where}: anomalous ${a.consecutiveGood}/${a.stable} honest ${h.consecutiveGood}/${h.stable}`);
			const failed = Object.values(p.o).includes(false);
			if (failed) {
				stats.failures++;
				// (2) a real failure always resets.
				if (a.stable || h.stable || a.consecutiveGood || h.consecutiveGood) violations.push(`(2) ${where}`);
				streakWriters = new Set(); allObserved = new Set(); recovering = true;
				return;
			}
			streakWriters.add(p.writer);
			for (const [k, v] of Object.entries(p.o)) if (v === true) allObserved.add(k);
			// (4) bounded liveness under any restart pattern, in both runs.
			const need = recovering ? P.recoveryConsecutive : P.consecutive;
			if (allObserved.size === 3 && streakWriters.size > (need - 1) * P.restartFallbackWriters) {
				stats.bound4Checks++;
				if (!a.stable || !h.stable) violations.push(`(4) ${where}: ${streakWriters.size} writers, anomalous ${a.consecutiveGood} honest ${h.consecutiveGood}`);
			}
		});
	}
}

test(`property: ${SEEDS} randomized scenarios (clock steps, suspends, slow/backward monotonic, restarts, crash loops, one-shot floods, multiple writers, DB copies)`, () => {
	for (let seed = 1; seed <= SEEDS; seed++) check(seed);
	console.log("node-health property", JSON.stringify({ ...stats, violations: violations.length }));
	expect(violations.slice(0, 10)).toEqual([]);
	expect(stats.stableEvaluations).toBeGreaterThan(0);
	expect(stats.anomalousBehind).toBeGreaterThan(0);
	expect(stats.bound4Checks).toBeGreaterThan(0);
	expect(stats.failures).toBeGreaterThan(0);
}, 600_000);

test("property (3): one long-lived writer at cadence c with honest clocks is stable within 1 + (need - 1) * ceil(spacingMs / c) probes, fresh and after a failure", () => {
	const r = rng(7);
	let checked = 0;
	for (let run = 0; run < 400; run++) {
		const c = pick(r, [500, 1 * S, 7 * S, 10 * S, 29 * S, 30 * S, 31 * S, 60 * S, 5 * M]);
		const base = Math.floor(r() * 2 ** 40);
		const failAt = pick(r, [-1, 0, 3, 17]);
		let state: NodeHealthState | undefined, anchor: Anchor | undefined, since = 0, need = P.consecutive;
		for (let i = 0; i < 400; i++) {
			const o: HealthProbe = { reachable: i !== failAt, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
			const step = stepHealth(state, { observation: { ...o, at: 0 }, seq: i + 1, writer: "producer", mono: base + i * c }, anchor);
			state = step.state; anchor = step.anchor;
			if (i === failAt) { since = 0; need = P.recoveryConsecutive; continue; }
			since++;
			const bound = 1 + (need - 1) * Math.ceil(P.spacingMs / c);
			if (since >= bound) { checked++; expect({ c, i, stable: evaluateHealth(state).stable }).toEqual({ c, i, stable: true }); }
		}
	}
	expect(checked).toBeGreaterThan(0);
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch {} });
test(`property: ${REAL_SEEDS} scenarios replayed through real NodeHealthHistory instances (one per process) on SQLite files, with file copies, match the pure fold`, () => {
	let compared = 0, copies = 0;
	for (let seed = 1, done = 0; done < REAL_SEEDS && seed < 10_000; seed++) {
		const sc = scenario(seed);
		if (sc.probes.length > 600) continue;
		done++;
		const dir = mkdtempSync(join(tmpdir(), "nh-prop-")); dirs.push(dir);
		const original = join(dir, "a.sqlite");
		const copy = join(dir, "b.sqlite");
		const world = { t: 0 };
		const instances = new Map<string, NodeHealthHistory>();
		const instance = (path: string, p: Probe) => {
			const key = path + "|" + p.writer;
			let h = instances.get(key);
			if (!h) {
				const hostOf = sc.hosts[p.host], base = p.base;
				h = new NodeHealthHistory(path, {}, { clock: () => 1_800_000_000_000 + world.t + wallOffset(hostOf, world.t), monotonic: () => base + monoProgress(hostOf, world.t) });
				instances.set(key, h);
			}
			return h;
		};
		const [main, copied] = branches(sc);
		const model: Fold = { anchors: new Map() }, copyModel: Fold = { anchors: new Map() };
		// A process ends after its last probe (its instance is closed, its memory is gone).
		const last = (probes: Probe[]) => new Map(probes.map((p, i) => [p.writer, i]));
		const lastMain = last(main);
		let copiedAt = -1, reopened = false;
		const replay = (path: string, probes: Probe[], from: number, f: Fold, lastIndex: Map<string, number>) => {
			for (let i = from; i < probes.length; i++) {
				let p = probes[i];
				if (path === original && sc.copyAt !== undefined && copiedAt < 0 && p.t >= sc.copyAt) {
					// Copy the file while every writer of the original is closed (a backup or a move).
					for (const [key, h] of instances) { h.close(); instances.delete(key); }
					copyFileSync(original, copy);
					copiedAt = i;
					copies++;
					copyModel.state = structuredClone(f.state);
					// Writers of the original reopen as new instances: new processes with new ids and fresh memory.
					reopened = true;
				}
				const closeAfter = lastIndex.get(p.writer) === i;
				if (path === original && reopened) p = { ...p, writer: p.writer + "#reopened" };
				world.t = p.t;
				const h = instance(path, p);
				const rec = h.record("n", p.o);
				const expected = fold(f, p, rec.seq, sc.hosts);
				expect({ seed, path, i, real: h.dimensions("n") }).toEqual({ seed, path, i, real: { nodeId: "n", ...expected } });
				compared++;
				if (closeAfter) { h.close(); instances.delete(path + "|" + p.writer); }
			}
		};
		replay(original, main, 0, model, lastMain);
		if (copied && copiedAt >= 0) {
			// The copy continues from the copied file with new processes on host 2.
			const db = new NodeHealthHistory(copy);
			expect(db.dimensions("n")).toEqual({ nodeId: "n", ...evaluateHealth(copyModel.state) });
			db.close();
			replay(copy, copied, copiedAt, copyModel, last(copied));
		}
		for (const h of instances.values()) h.close();
	}
	console.log("node-health real-instance property", JSON.stringify({ scenarios: REAL_SEEDS, compared, copies }));
	expect(compared).toBeGreaterThan(1000);
}, 600_000);
