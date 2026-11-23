// Review 102b71b4 F2/F3: with the switch on, a health error that the gate turns into an exclusion is
// reported as a fixed code, stage and error class only. A secret planted in the exception message
// must appear in no API result, CLI output (stdout and stderr), database row or dashboard output
// (API state, page and the `ui` producer's stderr line). Real CLI processes, real SQLite.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeHealthHistory } from "../src/node-health";
import { reservePlacement } from "../src/placement-preflight";
import { reconsiderQueue, submitPlacement } from "../src/index";
import { runTask } from "../src/operator-commands";
import { Fleet } from "../src/fleet";
import { FleetError } from "../src/core";
import { getDashboardState, renderDashboardHtml } from "../src/dashboard";
import type { ResourceSample } from "../src/admission";
import { headroom } from "./admission-fixture";
import { access, approval, cleanup, cliPath, clocked, fleetFixture, makeStable, runCli, track } from "./fixtures/node-health";

afterEach(cleanup);

const SECRET = `nh2-planted-secret-${randomUUID()}`;
const unavailable = (stage: string, errorClass: string) => ({ code: "node_health_unavailable", stage, errorClass });
const mirrorFailed = (errorClass: string) => ({ code: "node_health_mirror_failed", stage: "mirror", errorClass });

/**
 * Review 87f348aa L1: `headroom()` samples, except that each one's `at` is read as exactly 10 s before the
 * moment it is read. Admission then judges every sample 10 s old (inside the 15 s window) however long
 * the test has been running, so the outcome never depends on host speed or load.
 */
function steadyHeadroom(nodeIds: string[], tasks: number): { samples: Map<string, ResourceSample> } {
	return { samples: new Map([...headroom(nodeIds, tasks).samples].map(([id, { at: _at, ...sample }]) =>
		[id, Object.defineProperty(sample, "at", { enumerable: true, get: () => Date.now() - 10_000 }) as ResourceSample])) };
}

/** Every row of every table (sqlite_master excluded: it holds the planted trigger itself). */
function databaseText(path: string) {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
		expect(tables.length).toBeGreaterThan(0);
		return tables.map(({ name }) => name + JSON.stringify(db.query(`SELECT * FROM "${name}"`).all())).join("\n");
	} finally { db.close(); }
}

test("library API: every failing stage reports a fixed code, stage and class; the secret is returned, stored and rendered nowhere", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["A"]);
	h.setSelectionGating(true, approval);
	const fleet = new Fleet(f.store);
	const resources = steadyHeadroom(["A"], 10);
	const pin = { ...f.input.required, nodeId: "A" };
	class Throws extends NodeHealthHistory {
		constructor(private readonly at: "retainNodes" | "record" | "admit" | "auditPinnedAdmission", private readonly value: unknown) { super(f.path, {}, { clock: () => clock.now, monotonic: () => clock.now }); }
		override retainNodes(ids: string[]) { if (this.at === "retainNodes") throw this.value; return super.retainNodes(ids); }
		override record(...args: Parameters<NodeHealthHistory["record"]>) { if (this.at === "record") throw this.value; return super.record(...args); }
		override admit(...args: Parameters<NodeHealthHistory["admit"]>) { if (this.at === "admit") throw this.value; return super.admit(...args); }
		override auditPinnedAdmission(...args: Parameters<NodeHealthHistory["auditPinnedAdmission"]>) { if (this.at === "auditPinnedAdmission") throw this.value; return super.auditPinnedAdmission(...args); }
	}
	const cases = [
		{ name: "open", nodeHealth: { history: () => { throw new Error(SECRET); } }, error: unavailable("history_open", "Error") },
		{ name: "retain", nodeHealth: access(track(new Throws("retainNodes", new TypeError(SECRET))), resources), error: unavailable("history_retain", "TypeError") },
		{ name: "record", nodeHealth: access(track(new Throws("record", new FleetError("INVALID_INPUT", SECRET))), resources), error: unavailable("record", "FleetError") },
		{ name: "admit", nodeHealth: access(track(new Throws("admit", SECRET)), resources), error: unavailable("admit", "non_error") },
		{ name: "admit-proxy", nodeHealth: access(track(new Throws("admit", new Proxy(new Error(SECRET), {}))), resources), error: unavailable("admit", "unclassified") },
	];
	const results: unknown[] = [];
	for (const c of cases) {
		const auto = await submitPlacement(fleet, { ...f.input, key: "auto-" + c.name }, resources, { nodeHealth: c.nodeHealth });
		expect(auto.task.phase).toBe("queued");
		expect((auto as any).health).toEqual({ mode: "enforce", decisions: [{ nodeId: "A", pinned: false, allowed: false, failingDimensions: ["node_health_unavailable"] }], error: c.error });
		const pinned = await submitPlacement(fleet, { ...f.input, key: "pin-" + c.name, required: pin }, resources, { nodeHealth: c.nodeHealth });
		expect(pinned.task.nodeId).toBe("A");
		expect((pinned as any).health.error).toEqual(c.error);
		const queued = f.store.submit({ ...f.input, key: "reserve-" + c.name });
		const reserved = await reservePlacement(f.store, queued.id, resources, { nodeHealth: c.nodeHealth });
		expect((reserved as any).health.error).toEqual(c.error);
		const run = await runTask(fleet, { ...f.input, key: "run-" + c.name }, { sample: async () => resources.samples, nodeHealth: c.nodeHealth });
		expect<unknown>(run.placement!.nodeHealth!.error).toEqual(c.error);
		results.push(auto, pinned, reserved, run, await reconsiderQueue(fleet, async () => resources.samples, { nodeHealth: c.nodeHealth }));
	}
	// A failed sidecar copy of a committed pinned warning (B has no history, so pinning it warns).
	f.store.putNode(await f.node("B"));
	const both = steadyHeadroom(["A", "B"], 10);
	const mirror = await submitPlacement(fleet, { ...f.input, key: "mirror", required: { ...pin, nodeId: "B" } }, both, { nodeHealth: access(track(new Throws("auditPinnedAdmission", new RangeError(SECRET))), both) });
	expect(mirror.task.nodeId).toBe("B");
	expect(f.store.events(mirror.task.id).some(e => e.kind === "node_health_warning")).toBe(true);
	expect((mirror as any).health.healthWarningMirrorError).toEqual(mirrorFailed("RangeError"));
	results.push(mirror);
	const text = JSON.stringify(results);
	expect(text).toContain("node_health_unavailable");
	expect(text).not.toContain(SECRET);
	expect(JSON.stringify(f.store.tasks().map(task => f.store.events(task.id)))).not.toContain(SECRET);
	expect(databaseText(f.path)).not.toContain(SECRET);
	expect(JSON.stringify(getDashboardState(f.store, undefined, new Map(), undefined, h))).not.toContain(SECRET);
}, 180_000);

test("CLI, database and dashboard: a secret raised by the database itself appears in no output of submit, run, queue reconsider, the read commands or ui", async () => {
	const f = await fleetFixture();
	f.store.putNode(await f.node("A"));
	const { h } = clocked(f.path);
	h.setSelectionGating(true, approval);
	// A tampered database whose own error text carries the secret: every health record and every
	// sidecar warning copy aborts with it.
	const db = track(new Database(f.path));
	db.exec(`CREATE TRIGGER nh2_secret_rows BEFORE INSERT ON node_health_rows BEGIN SELECT RAISE(ABORT, '${SECRET}'); END`);
	db.exec(`CREATE TRIGGER nh2_secret_warnings BEFORE INSERT ON node_health_warnings BEGIN SELECT RAISE(ABORT, '${SECRET}'); END`);
	// The plant is live: the raw error does carry the secret.
	expect(() => h.record("A", { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 })).toThrow(SECRET);
	const resources = join(f.dir, "resources.json");
	writeFileSync(resources, JSON.stringify(Object.fromEntries([...headroom(["A"], 10).samples].map(([id, s]) => [id, { ...s, at: Date.now() }]))));
	const taskFile = (key: string, pinned: boolean) => {
		const file = join(f.dir, key + ".json");
		writeFileSync(file, JSON.stringify({ ...f.input, key, ...(pinned ? { required: { ...f.input.required, nodeId: "A" } } : {}) }));
		return file;
	};
	const outputs: string[] = [];
	const cli = async (...args: string[]) => {
		// run and queue reconsider measure fresh samples themselves (the fixture Coordinator reports headroom).
		const result = await runCli(f.path, ...(["run", "queue"].includes(args[0]!) ? [] : ["--resources", resources]), ...args);
		outputs.push(result.stdout, result.stderr);
		return result;
	};
	const auto = await cli("submit", taskFile("auto", false));
	expect(auto.exit).toBe(1);
	const autoOut = JSON.parse(auto.stdout);
	expect(autoOut.phase).toBe("queued");
	expect(autoOut.placement.nodeHealth).toEqual({ mode: "enforce", decisions: [{ nodeId: "A", pinned: false, allowed: false, failingDimensions: ["node_health_unavailable"] }], error: unavailable("record", "Error") });
	const pinned = await cli("submit", taskFile("pinned", true));
	const pinnedOut = JSON.parse(pinned.stdout);
	expect(pinnedOut.nodeId).toBe("A");
	expect(pinnedOut.placement.nodeHealth.error).toEqual(unavailable("record", "Error"));
	expect(pinnedOut.placement.nodeHealth.healthWarningMirrorError).toEqual(mirrorFailed("Error"));
	const run = await cli("run", taskFile("run-auto", false));
	expect(run.stdout).toContain("node_health_unavailable");
	await cli("queue", "reconsider");
	for (const args of [["tasks"], ["tasks", "--compact"], ["show", autoOut.id], ["events", autoOut.id], ["events", pinnedOut.id], ["observability"], ["node", "list"], ["node-health", "show"], ["--read-only", "events", pinnedOut.id]]) {
		expect((await cli(...args)).exit).toBe(0);
	}
	// ui: the hub producer's record fails on every tick; its stderr line is fixed and the dashboard shows no text.
	const child = Bun.spawn([process.execPath, cliPath, "--db", f.path, "ui", "--port", "0"], { stdout: "pipe", stderr: "pipe" });
	let stderr = "";
	const stderrDone = (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk); })();
	try {
		const reader = child.stdout.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		reader.releaseLock();
		const { url } = JSON.parse(first.split("\n")[0]!);
		const deadline = Date.now() + 30_000;
		while (!stderr.includes("node_health_observe_failed") && Date.now() < deadline) await Bun.sleep(100);
		outputs.push(await (await fetch(url + "/api/state")).text(), await (await fetch(url + "/")).text());
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		await stderrDone;
	}
	outputs.push(stderr);
	const producerLines = stderr.split("\n").filter(line => line.includes("node_health_observe_failed"));
	expect(producerLines.length).toBeGreaterThan(0);
	for (const line of producerLines) expect(JSON.parse(line)).toEqual({ ok: false, error: "node_health_observe_failed", errorClass: "Error" });
	outputs.push(renderDashboardHtml(), JSON.stringify(getDashboardState(f.store, undefined, new Map(), undefined, h)));
	const all = outputs.join("\n");
	expect(all).toContain("node_health_unavailable");
	expect(all).not.toContain(SECRET);
	// Database: no row of any table holds it; only the planted triggers' own definitions do.
	expect(databaseText(f.path)).not.toContain(SECRET);
	const planted = db.query("SELECT sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'nh2_secret_%'").all() as { sql: string }[];
	expect(planted).toHaveLength(2);
	for (const row of planted) expect(row.sql).toContain(SECRET);
}, 180_000);
