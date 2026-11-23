// Review 5d0d5336 LOW findings (separate low-fixes patch):
// L1: the node-health Coordinator probe waits in the per-destination SSH queue used by every dashboard SSH call.
// L2: a refused `node-health gating on` decides on the read-only view and creates no table.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeHealthHistory } from "../src/node-health";
import { gatingPreview, observeNodeHealth } from "../src/node-health-gate";
import { probeBrokerSessionList } from "../src/dashboard";
import { approval, brokerList, cleanup, clocked, coordinator, fleetFixture, makeStable, runCli, track } from "./fixtures/node-health";

afterEach(cleanup);

const healthTables = (path: string) => {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT name FROM sqlite_master WHERE name LIKE 'node_health%' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
	} finally {
		db.close();
	}
};

test.skipIf(process.platform === "win32")("L1: the producer's Coordinator login to a host waits for an SSH call already queued for that host", async () => {
	const f = await fleetFixture("fleet-nh-l1-");
	// A stand-in `ssh` on PATH: logs begin/end of every login with a hi-res time, then runs the remote command locally.
	const bin = join(f.dir, "bin");
	mkdirSync(bin);
	const log = join(f.dir, "ssh.log");
	writeFileSync(
		join(bin, "ssh"),
		`#!/bin/sh\nfor last; do :; done\nnow() { perl -MTime::HiRes=time -e 'printf "%.6f", time'; }\necho "begin $(now) $last" >> ${JSON.stringify(log)}\nsh -c "$last"\ncode=$?\necho "end $(now) $last" >> ${JSON.stringify(log)}\nexit $code\n`,
	);
	chmodSync(join(bin, "ssh"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = bin + ":" + path;
	try {
		const state = join(f.dir, "A-coordinator.json");
		writeFileSync(state, JSON.stringify({ calls: [] }));
		const node = {
			...(await f.node("A")),
			transport: { command: "ssh", args: ["-T", "host-a", `${process.execPath} ${coordinator} ${state}`] },
			sdkTransport: { command: "ssh", args: ["-T", "host-a", `${process.execPath} ${brokerList} ok,slow=1500`] },
		};
		f.store.putNode(node);
		const { h } = clocked(f.path, Date.now());
		// A dashboard SSH call to host-a is in flight (1.5 s) when the producer probes host-a.
		const dashboardCall = probeBrokerSessionList(node, 20_000);
		const [observed] = await observeNodeHealth([node], h, { timeoutMs: 20_000 });
		expect(await dashboardCall).toBe(true);
		expect(observed!.observation).toMatchObject({ reachable: true, brokerSessionListOk: true });
		const events = readFileSync(log, "utf8").trim().split("\n").map((line) => {
			const [kind, at, ...rest] = line.split(" ");
			return { kind: kind!, at: Number(at), what: rest.join(" ").includes("coordinator") ? "coordinator" : "broker" };
		});
		// Logins to host-a in queue order: the dashboard call, then the producer's Coordinator session, then its Broker probe.
		const begins = events.filter((e) => e.kind === "begin");
		expect(begins.map((e) => e.what)).toEqual(["broker", "coordinator", "broker"]);
		// The Coordinator login started only after the in-flight dashboard login had ended (before the fix it
		// started at once, overlapping it), and the producer's Broker login only after the Coordinator session.
		// (The Coordinator session is closed by a kill, so its stand-in logs no end line.)
		const firstEnd = events.find((e) => e.kind === "end")!;
		expect(events.indexOf(firstEnd)).toBe(1);
		expect(begins[1]!.at).toBeGreaterThanOrEqual(firstEnd.at);
		expect(begins[2]!.at).toBeGreaterThanOrEqual(begins[1]!.at);
		// The recorded latency is the probe's own, not the 1.5 s wait in the queue.
		expect(h.observations("A").at(-1)!.latencyMs).toBeLessThan(1_500);
	} finally {
		process.env.PATH = path;
	}
}, 60_000);

test("L2: a refused `gating on` creates no node_health table; the preview is the one the writable history gives", async () => {
	const f = await fleetFixture("fleet-nh-l2-");
	f.store.putNode(await f.node("A"));
	f.store.putNode(await f.node("B"));
	const file = join(f.dir, "approval.json");
	writeFileSync(file, JSON.stringify(approval));
	// No history at all: refused, and the fleet DB still has no node_health_* object.
	const refused = await runCli(f.path, "node-health", "gating", "on", file);
	expect(refused.exit).toBe(1);
	const output = JSON.parse(refused.stdout);
	expect(output).toMatchObject({ ok: false, error: "node_health_not_stable", gating: { enabled: false }, preview: { wouldBeExcluded: ["A", "B"], allExcluded: true } });
	expect(healthTables(f.path)).toEqual([]);
	// With a history where only A is stable: still refused, the same preview as the writable history, nothing written.
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	const writes = () => (h as any).db.query("SELECT (SELECT COUNT(*) FROM node_health_gating) + (SELECT COUNT(*) FROM node_health_rows) AS n").get().n;
	const before = writes();
	const partial = await runCli(f.path, "node-health", "gating", "on", file);
	expect(partial.exit).toBe(1);
	expect(JSON.parse(partial.stdout).preview).toEqual(JSON.parse(JSON.stringify(gatingPreview(f.store.nodes(), h))));
	expect(writes()).toBe(before);
	expect(f.store.nodeHealthGating().enabled).toBe(false);
	// Every node stable: switched on without --force (the writable path is unchanged).
	makeStable(h, clock, ["B"]);
	const on = await runCli(f.path, "node-health", "gating", "on", file);
	expect(on.exit).toBe(0);
	expect(JSON.parse(on.stdout)).toMatchObject({ ok: true, forced: false, gating: { enabled: true, operator: "ops" } });
	expect(f.store.nodeHealthGating().enabled).toBe(true);
	// `--force` and `off` still open the writable history (they must write the switch row).
	const fresh = await fleetFixture("fleet-nh-l2b-");
	fresh.store.putNode(await fresh.node("C"));
	const forced = await runCli(fresh.path, "node-health", "gating", "on", "--force", file);
	expect(forced.exit).toBe(0);
	expect(healthTables(fresh.path)).toContain("node_health_gating");
	track(new NodeHealthHistory(fresh.path)).setSelectionGating(false, approval);
	expect(fresh.store.nodeHealthGating().enabled).toBe(false);
}, 120_000);
