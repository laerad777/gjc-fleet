import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHealthHistory, type HealthProbe } from "../src/node-health";
import { reservePlacement } from "../src/placement-preflight";
import { bootstrapNodeHealth } from "../src/node-health-gate";
import { FleetStore } from "../src/store";
import type { NodeConfig, TaskInput } from "../src/contracts";
import type { ResourceSample } from "../src/admission";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";
import { access } from "./fixtures/node-health";

// Real child probes (controlled Coordinator / Broker fixtures), real SQLite and FleetStore.
const good: HealthProbe = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
const bad: HealthProbe = { ...good, reachable: false };
const open: NodeHealthHistory[] = [];
const dirs: string[] = [];
afterEach(() => {
	for (const h of open.splice(0)) h.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/**
 * The hub path with the stored switch on: fresh samples measured after the decision probes, each
 * stamped on receipt by the history it probes with (review 36ebedc2 L1, review caba7bbd L2).
 */
const hub = (h: NodeHealthHistory, resources: { samples: ReadonlyMap<string, ResourceSample> }) => [resources, { nodeHealth: access(h, resources) }] as const;
function clocked(path = ":memory:") {
	const clock = { now: 1_800_000_000_000 };
	const h = new NodeHealthHistory(path, {}, { clock: () => clock.now, monotonic: () => clock.now });
	open.push(h);
	return { h, clock };
}
const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const brokerList = fileURLToPath(new URL("./fixtures/broker-list.ts", import.meta.url));
async function fixture() {
	const repo = await repositoryFixture("fleet-health-int-");
	dirs.push(repo.dir);
	const input: TaskInput = { schemaVersion: 1, key: "automatic", caller: "health-int", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	async function node(id: string, changes: Partial<NodeConfig> = {}) {
		const state = join(repo.dir, id + "-coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const config = join(repo.dir, id + ".json");
		const value: NodeConfig = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces-" + id), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] }, sdkTransport: { command: process.execPath, args: [brokerList, "ok"] }, ...changes };
		await writeFile(config, JSON.stringify(value));
		return JSON.parse(JSON.stringify(value)) as NodeConfig;
	}
	return { ...repo, input, node };
}

test("a node that was not probed (pinned elsewhere / hard-ineligible) records nothing and keeps its state", async () => {
	const { h, clock } = clocked();
	const node: any = { id: "healthy-other", os: process.platform, arch: process.arch, roots: { fixture: "C:/fixture" }, workspaceRoot: "C:/fixture-work", enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: [], transport: { command: process.execPath, args: [] } };
	for (let i = 0; i < 3; i++) { if (i) clock.now += 30_000; h.record(node.id, good); }
	const before = h.dimensions(node.id);
	expect(before.stable).toBe(true);
	for (const required of [{ nodeId: "different-node", modelProfile: "controlled" }, { modelProfile: "absent-profile" }]) {
		const input: any = { schemaVersion: 1, key: "pin", caller: "review", repoId: "fixture", baseCommit: "a".repeat(40), prompt: "review", required };
		const task: any = { id: "t", input };
		const store: any = { task: () => task, nodes: () => [node], taskStates: () => [], heldCharges: () => new Map(), reserve: () => task, nodeHealthGating: () => ({ enabled: true }) };
		const result = await reservePlacement(store, "t", { samples: new Map() }, { nodeHealth: access(h) });
		expect(result.report.nodes[0].checks.coordinator.code).toBe("hard_ineligible_probe_skipped");
		expect((result as any).health).toEqual({ mode: "enforce", decisions: [] });
	}
	expect(h.observations(node.id)).toHaveLength(3);
	expect(h.dimensions(node.id)).toEqual(before);
	expect(h.trackedNodes()).toEqual([node.id]);
});

test("all nodes unstable: the durable selection audit names node_unstable and the cause; a pinned warning commits with its reservation", async () => {
	const f = await fixture();
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	const { h, clock } = clocked(join(f.dir, "fleet.sqlite"));
	// Gating is the operator switch stored in the fleet DB (default off).
	h.setSelectionGating(true, { operator: "test", reason: "enforce" });
	try {
		for (const id of ["A", "B"]) store.putNode(await f.node(id));
		const task = store.submit(f.input);
		const first = await reservePlacement(store, task.id, ...hub(h, headroom(["A", "B"], 10)));
		expect(first.task.nodeId).toBeUndefined();
		expect(first.task.reason).toBe("no_eligible_node");
		const audit = store.events(task.id).filter(e => e.kind === "selection").at(-1)!.data as any;
		expect(audit.reason).toBe("no_eligible_node");
		expect(audit.exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "consecutive_observations"] }, { nodeId: "B", reasons: ["node_unstable", "consecutive_observations"] }]);
		// A reachability failure is named as the cause while the node recovers.
		h.record("B", bad);
		clock.now += 30_000;
		const second = await reservePlacement(store, task.id, ...hub(h, headroom(["A", "B"], 10)));
		expect(second.task.nodeId).toBeUndefined();
		expect((store.events(task.id).filter(e => e.kind === "selection").at(-1)!.data as any).exclusions).toEqual([{ nodeId: "A", reasons: ["node_unstable", "consecutive_observations"] }, { nodeId: "B", reasons: ["node_unstable", "reachable", "consecutive_observations"] }]);
		// Pinned dispatch onto the unstable node: warning event in the reservation transaction; a failed mirror does not undo it.
		const pinned = store.submit({ ...f.input, key: "pinned", required: { ...f.input.required, nodeId: "A" } });
		class MirrorFails extends NodeHealthHistory { override auditPinnedAdmission(): void { throw new Error("SQLITE_BUSY: database is locked"); } }
		const failing = new MirrorFails(join(f.dir, "fleet.sqlite"), {}, { clock: () => clock.now, monotonic: () => clock.now });
		open.push(failing);
		const reserved = await reservePlacement(store, pinned.id, ...hub(failing, headroom(["A", "B"], 10)));
		expect(reserved.task.nodeId).toBe("A");
		expect((reserved as any).health.healthWarningMirrorError).toEqual({ code: "node_health_mirror_failed", stage: "mirror", errorClass: "Error" });
		const kinds = store.events(pinned.id).map(e => e.kind);
		expect(kinds.slice(kinds.indexOf("reserved"), kinds.indexOf("reserved") + 2)).toEqual(["reserved", "node_health_warning"]);
		expect(store.events(pinned.id).find(e => e.kind === "node_health_warning")!.data).toMatchObject({ nodeId: "A", pinned: true, failingDimensions: ["consecutive_observations"] });
		// A pinned attempt rejected by ordinary resource admission writes no warning event.
		const refusedTask = store.submit({ ...f.input, key: "pinned-refused", required: { ...f.input.required, nodeId: "B" } });
		const refused = await reservePlacement(store, refusedTask.id, { samples: new Map() }, { nodeHealth: access(h, { samples: new Map() }) });
		expect(refused.task.attemptId).toBeUndefined();
		expect(store.events(refusedTask.id).some(e => e.kind === "node_health_warning")).toBe(false);
		// Probes 30 s apart through the same instance: A becomes automatically eligible.
		const auto = store.submit({ ...f.input, key: "auto" });
		clock.now += 30_000;
		const later = await reservePlacement(store, auto.id, ...hub(h, headroom(["A", "B"], 10)));
		expect(later.task.nodeId).toBe("A");
	} finally { store.close(); }
}, 120_000);

test("bootstrap: bounded by its own monotonic clock, fixed budget, every completed probe recorded, failures stop it", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	const sample = async (node: NodeConfig) => headroom([node.id], 10).samples.get(node.id);
	{
		// Each pause takes 80 s: the third probe would start after the 130 s deadline.
		const { h, clock } = clocked();
		const waits: number[] = [];
		const res = await bootstrapNodeHealth([n], h, { reason: "slow", sampleResources: sample, wait: async ms => { waits.push(ms); clock.now += 80_000; } });
		expect(res).toEqual([{ nodeId: "NODEG", outcome: "deadline_exceeded", observations: 2 }]);
		expect(waits).toEqual([30_000, 30_000]);
		expect(h.observations("NODEG")).toHaveLength(2);
		expect(h.bootstraps("NODEG")).toEqual([expect.objectContaining({ outcome: "deadline_exceeded", observations: 2 })]);
	}
	{
		// The budget does not scale with timeoutMs; a stable node is skipped.
		const { h, clock } = clocked();
		const res = await bootstrapNodeHealth([n], h, { reason: "budget", timeoutMs: 120_000, sampleResources: sample, wait: async ms => { clock.now += ms; } });
		expect(res).toEqual([{ nodeId: "NODEG", outcome: "stable", observations: 3 }]);
		const row = h.bootstraps("NODEG")[0] as any;
		expect(row.deadline_at - row.started_at).toBe(130_000);
		expect(await bootstrapNodeHealth([n], h, { reason: "again", sampleResources: sample, wait: async () => {} })).toEqual([{ nodeId: "NODEG", outcome: "skipped_stable", observations: 0 }]);
	}
	{
		// Recovering from a failure: 5 counted probes, 6-probe / 210 s plan.
		const { h, clock } = clocked();
		h.record("NODEG", bad);
		const waits: number[] = [];
		const res = await bootstrapNodeHealth([n], h, { reason: "after failure", sampleResources: sample, wait: async ms => { waits.push(ms); clock.now += ms; } });
		expect(res).toEqual([{ nodeId: "NODEG", outcome: "stable", observations: 5 }]);
		expect(waits).toEqual([30_000, 30_000, 30_000, 30_000]);
		expect((h.bootstraps("NODEG")[0] as any).deadline_at - (h.bootstraps("NODEG")[0] as any).started_at).toBe(210_000);
		expect(() => h.beginBootstrap("NODEG2", "too long", 210_001)).toThrow("invalid_bootstrap_duration");
	}
	{
		// Concurrent runs are audited separately and only add real probes.
		const { h, clock } = clocked();
		const w = async (ms: number) => { clock.now += ms / 2; };
		const res = await Promise.all([bootstrapNodeHealth([n], h, { reason: "first", sampleResources: sample, wait: w }), bootstrapNodeHealth([n], h, { reason: "second", sampleResources: sample, wait: w })]);
		const rows = h.bootstraps("NODEG") as any[];
		expect(rows.map(r => r.reason).sort()).toEqual(["first", "second"]);
		expect(rows.map(r => [r.outcome, r.observations]).sort()).toEqual(res.map(r => [r[0].outcome, r[0].observations]).sort());
		expect(h.observations("NODEG")).toHaveLength(res[0][0].observations + res[1][0].observations);
	}
	{
		// Without a resource sampler the resource dimension stays unobserved: bootstrap alone is not stability.
		const { h, clock } = clocked();
		const res = await bootstrapNodeHealth([n], h, { reason: "no sampler", wait: async ms => { clock.now += ms; } });
		expect(res).toEqual([{ nodeId: "NODEG", outcome: "unstable", observations: 4 }]);
		expect(h.dimensions("NODEG").failingDimensions).toEqual(["unobserved:resourceSampleOk"]);
	}
}, 300_000);

test("simulation: hibernating host (60 s up / 600 s down, 30 s polling) is never automatically admitted", () => {
	const { h, clock } = clocked();
	const start = clock.now;
	let up = 0, allowed = 0;
	for (let t = 0; t <= 6 * 3_600_000; t += 30_000) {
		clock.now = start + t;
		const awake = t % 660_000 < 60_000;
		up += awake ? 1 : 0;
		const record = h.record("hibernator", awake ? good : bad);
		if (h.admit("hibernator", false, record).allowed) allowed++;
	}
	expect(up).toBe(66);
	expect(allowed).toBe(0);
});

test("simulation: healthy host with one transient failure is excluded until recoveryConsecutive spaced probes", () => {
	const { h, clock } = clocked();
	const allowed: boolean[] = [];
	for (let t = 0; t <= 240_000; t += 30_000) {
		if (t) clock.now += 30_000;
		const record = h.record("healthy", t === 90_000 ? bad : good);
		allowed.push(h.admit("healthy", false, record).allowed);
	}
	expect(allowed).toEqual([false, false, true, false, false, false, false, false, true]);
});
