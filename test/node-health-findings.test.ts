// Review c5cfb46b (round 4) findings H1, M1, M2, L1 ported as behaviour tests. They were written
// before the fix and fail on the round-4 candidate (see RESULT.md); they use only API that both the
// round-4 and the round-5 NodeHealthHistory accept.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeHealthHistory } from "../src/node-health";
import { FleetStore } from "../src/store";

const S = 1000, M = 60 * S, H = 60 * M, BASE = 1_800_000_000_000;
const good = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
const open: NodeHealthHistory[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.close();
	for (const d of dirs.splice(0)) try { rmSync(d, { recursive: true, force: true }); } catch {}
});
const path = () => { const d = mkdtempSync(join(tmpdir(), "nh-find-")); dirs.push(d); return join(d, "h.sqlite"); };
/** One process: its own wall clock (real + offset) and monotonic clock (base + real - frozen).
 * The origin is an integer. A fractional base makes an exact 30s step compare as 29999.999, so one
 * run drops a counted probe and the other does not; the two runs would no longer be the same scenario. */
interface Proc { real: { t: number }; offset: number; base: number; frozen: number }
const proc = (p: string, real: { t: number }, offset = 0, base = Math.floor(Math.random() * 1e9)) => {
	const c: Proc = { real, offset, base, frozen: 0 };
	const h = new NodeHealthHistory(p, {}, { clock: () => BASE + c.real.t + c.offset, monotonic: () => c.base + c.real.t - c.frozen });
	open.push(h);
	return { h, c };
};
const rec = (h: NodeHealthHistory, o: object = good) => h.record("n", { ...o, at: h.now() } as any);
const closeOne = (h: NodeHealthHistory) => { h.close(); open.splice(open.indexOf(h), 1); };
const view = (h: NodeHealthHistory) => { const d = h.dimensions("n"); return { stable: d.stable, count: d.consecutiveGood }; };
/** Property (1): the anomalous run is never ahead of the honest run with the same probes. */
function neverAhead(anomalous: { stable: boolean; count: number }[], honest: { stable: boolean; count: number }[]) {
	expect(anomalous.length).toBe(honest.length);
	anomalous.forEach((a, i) => {
		if (a.stable) expect({ i, honest: honest[i].stable }).toEqual({ i, honest: true });
		expect(a.count).toBeLessThanOrEqual(honest[i].count);
	});
}

test("H1: a long-lived observer every 10 s plus 16 one-shot writers per interval becomes stable within bounded time", () => {
	const real = { t: 0 }, p = path();
	const { h: observer } = proc(p, real);
	let first: number | null = null;
	for (let t = 0; t <= 30 * M && first === null; t += 10 * S) {
		real.t = t; rec(observer);
		if (observer.dimensions("n").stable) first = t;
		for (let j = 1; j <= 16; j++) { real.t = t + j * 500; const o = new NodeHealthHistory(p, {}, { clock: () => BASE + real.t, monotonic: () => real.t }); rec(o); o.close(); }
	}
	expect(first).not.toBeNull();
	expect(first!).toBeLessThanOrEqual(5 * M);
	// A real failure recorded by any one-shot writer resets the node at once.
	const o = new NodeHealthHistory(p, {}, { clock: () => BASE + real.t, monotonic: () => 0 });
	rec(o, { ...good, reachable: false }); o.close();
	expect(observer.dimensions("n").stable).toBe(false);
}, 30_000);

test("H1: far more one-shot writers than any retained-chain capacity (40 per interval) cannot starve the observer", () => {
	const real = { t: 0 }, p = path();
	const { h: observer } = proc(p, real);
	let first: number | null = null;
	for (let t = 0; t <= 30 * M && first === null; t += 10 * S) {
		real.t = t; rec(observer);
		if (observer.dimensions("n").stable) first = t;
		for (let j = 1; j <= 40; j++) { real.t = t + j * 200; const o = new NodeHealthHistory(p, {}, { clock: () => BASE + real.t, monotonic: () => real.t }); rec(o); o.close(); }
	}
	expect(first).not.toBeNull();
	expect(first!).toBeLessThanOrEqual(5 * M);
}, 30_000);

/** Five minutes of probes every 10 s by process A. */
function warmUp(p: string, real: { t: number }) {
	const a = proc(p, real);
	for (let t = 0; t <= 5 * M; t += 10 * S) { real.t = t; rec(a.h); }
	expect(a.h.dimensions("n").stable).toBe(true);
	return a;
}

// Windows hosted runners need more than the default 5 s for three SQLite copy/warm loops.
test("M1: a DB copied to a host whose clock is behind by the transfer time is never ahead of the honest copy; admission needs the decision's own probe", () => {
	for (const gap of [10 * M, H, 24 * H]) {
		const run = (anomalous: boolean) => {
			const real = { t: 0 }, p = path();
			const a = warmUp(p, real);
			closeOne(a.h);
			const q = path(); copyFileSync(p, q);
			real.t += gap;
			const b = proc(q, real, anomalous ? -gap + 5 * S : 0);
			const out = [view(b.h)];
			// Nothing was probed on the new host: no admission without this decision's own probe.
			expect(b.h.admit("n", false).allowed).toBe(false);
			for (let i = 0; i < 12; i++) { real.t += 10 * S; rec(b.h); out.push(view(b.h)); }
			return out;
		};
		neverAhead(run(true), run(false));
	}
}, 30_000);

test("M1: a new process after an unobserved hour and a backward wall step is never ahead of the honest run", () => {
	const run = (anomalous: boolean) => {
		const real = { t: 0 }, p = path();
		const a = warmUp(p, real);
		closeOne(a.h);
		real.t += H;
		const b = proc(p, real, anomalous ? -H + 5 * S : 0);
		const out = [view(b.h)];
		for (let i = 0; i < 12; i++) { rec(b.h); out.push(view(b.h)); real.t += 10 * S; }
		return out;
	};
	neverAhead(run(true), run(false));
}, 30_000);

test("M1: a suspend with a frozen monotonic clock and a coincident backward wall step is never ahead of the honest run", () => {
	const run = (anomalous: boolean) => {
		const real = { t: 0 }, p = path();
		const a = warmUp(p, real);
		real.t += H;
		if (anomalous) { a.c.frozen = H; a.c.offset = -H + 5 * S; }
		const out = [view(a.h)];
		for (let i = 0; i < 12; i++) { real.t += 10 * S; rec(a.h); out.push(view(a.h)); }
		// The suspended host failed one probe after resume: both runs reset.
		rec(a.h, { ...good, brokerSessionListOk: false });
		out.push(view(a.h));
		expect(out.at(-1)).toEqual({ stable: false, count: 0 });
		return out;
	};
	neverAhead(run(true), run(false));
});

// Reopening the SQLite database for every probe can exceed Bun’s default 5 s on hosted Windows.
const restartTimeoutMs = process.platform === "win32" ? 30_000 : undefined;

test("M2: a producer that restarts every 10 s (probing every 10 s) on one host still reaches stable", () => {
	const real = { t: 0 }, p = path();
	let first: number | null = null;
	for (let t = 0; t <= 30 * M && first === null; t += 10 * S) {
		real.t = t;
		const h = new NodeHealthHistory(p, {}, { clock: () => BASE + real.t, monotonic: () => real.t - t });
		rec(h);
		if (h.dimensions("n").stable) first = t;
		h.close();
	}
	expect(first).not.toBeNull();
}, restartTimeoutMs);

test("M2: restart downtime + cadence above 35 s with one probe per lifetime still reaches stable within the stated probe bound", () => {
	// c = 30 s, lifetime 30 s, downtime 10 s; one writer per probe, so bound 1 + (consecutive - 1) * restartFallbackWriters = 129 probes.
	const real = { t: 0 }, p = path();
	let probes = 0, stableAt: number | null = null;
	while (probes < 200 && stableAt === null) {
		const h = new NodeHealthHistory(p, {}, { clock: () => BASE + real.t, monotonic: () => real.t });
		rec(h); probes++;
		if (h.dimensions("n").stable) stableAt = probes;
		h.close();
		real.t += 40 * S;
	}
	expect(stableAt).not.toBeNull();
	expect(stableAt!).toBeLessThanOrEqual(129);
}, restartTimeoutMs);

test("L1: opening the sidecar first on a new shared fleet DB path does not make FleetStore refuse the file", () => {
	const p = path();
	const h = new NodeHealthHistory(p);
	rec(h);
	h.close();
	const store = new FleetStore(p);
	expect(store.tasks()).toHaveLength(0);
	store.close();
	const again = new NodeHealthHistory(p);
	expect(again.observations("n")).toHaveLength(1);
	rec(again);
	again.close();
	const reopened = new FleetStore(p);
	reopened.close();
	// A database that is neither a FleetStore DB nor a node-health sidecar is refused, never written.
	const other = path();
	const db = new Database(other); db.exec("CREATE TABLE unrelated (x)"); db.close();
	expect(() => new NodeHealthHistory(other)).toThrow("node_health_unrelated_database");
	const check = new Database(other);
	expect((check.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name)).toEqual(["unrelated"]);
	check.close();
});
