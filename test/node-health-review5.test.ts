// Review 36ebedc2 (round 5) finding L1 ported as behaviour tests, written before the fix and run on
// the r5 candidate first (they fail there; see RESULT.md). L1: the resource dimension's freshness
// was judged with the hub WALL clock, so a backward wall step made a stale sample count as an
// observed `true` where the honest run never did. Fix: a resource sample is success evidence only
// when the probing process stamped it with the history's own monotonic clock
// (`history.stampSample`, a `sampleResources` callback during the probe); its age is judged with
// that clock. A wall-stamped sample can only report a failure.
import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHealthHistory } from "../src/node-health";
import { bootstrapNodeHealth, observeNodeHealth } from "../src/node-health-gate";
import { reservePlacement } from "../src/placement-preflight";
import { FleetStore } from "../src/store";
import type { NodeConfig, TaskInput } from "../src/contracts";
import type { ResourceSample } from "../src/admission";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

const dirs: string[] = [];
const realNow = Date.now;
afterEach(() => { Date.now = realNow; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const brokerList = fileURLToPath(new URL("./fixtures/broker-list.ts", import.meta.url));

async function fixture(id = "N") {
	const repo = await repositoryFixture("nh-r5-");
	dirs.push(repo.dir);
	const state = join(repo.dir, "c.json");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	const config = join(repo.dir, id + ".json");
	const node = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "ws"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] }, sdkTransport: { command: process.execPath, args: [brokerList, "ok"] } } as NodeConfig;
	writeFileSync(config, JSON.stringify(node));
	const input: TaskInput = { schemaVersion: 1, key: "l1", caller: "l1-test", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	return { dir: repo.dir, node, input };
}
const okSample = (at: number): ResourceSample => ({ ...headroom(["N"], 10).samples.get("N")!, at });

test("L1: a wall-stamped sample never makes the resource dimension observed, whatever the hub wall clock does", async () => {
	const f = await fixture();
	const T0 = realNow();
	const out: Record<string, any> = {};
	for (const run of ["honest", "anomalous"] as const) {
		const mono = { t: 0 };
		const h = new NodeHealthHistory(join(f.dir, run + ".sqlite"), {}, { clock: () => T0, monotonic: () => mono.t });
		const resource: (boolean | null)[] = [];
		for (let i = 0; i < 3; i++) {
			// The reviewer's scenario: the hub's last good sample is from T0, the probes run 10 min later.
			const real = T0 + 10 * 60_000 + i * 30_000;
			Date.now = () => (run === "honest" ? real : real - 10 * 60_000);
			mono.t = i * 30_000;
			const [r] = await observeNodeHealth([f.node], h, { samples: new Map([["N", okSample(T0)]]) });
			resource.push(r!.observation.resourceSampleOk);
		}
		// Even a sample that is fresh by the wall clock is not success evidence.
		Date.now = realNow;
		mono.t += 30_000;
		const [fresh] = await observeNodeHealth([f.node], h, { samples: new Map([["N", okSample(realNow())]]) });
		resource.push(fresh!.observation.resourceSampleOk);
		const d = h.dimensions("N");
		out[run] = { resource, stable: d.stable, failing: d.failingDimensions };
		h.close();
	}
	expect(out.anomalous).toEqual(out.honest);
	expect(out.honest).toEqual({ resource: [null, null, null, null], stable: false, failing: ["unobserved:resourceSampleOk"] });
	// A failed sample is a failure whatever its age: reporting one can only delay.
	const h = new NodeHealthHistory(":memory:");
	try {
		const [failed] = await observeNodeHealth([f.node], h, { samples: new Map([["N", { ok: false, at: 0, error: "x" }]]) });
		expect(failed!.observation.resourceSampleOk).toBe(false);
		expect(h.dimensions("N").failingDimensions).toEqual(["resourceSampleOk", "consecutive_observations"]);
	} finally { h.close(); }
}, 120_000);

test("L1: monotonic-stamped evidence is fresh only by the history's own monotonic clock; the wall clock is irrelevant", async () => {
	const f = await fixture();
	const T0 = realNow();
	const out: Record<string, any> = {};
	for (const run of ["honest", "forward", "backward"] as const) {
		const mono = { t: 1_000_000 };
		const h = new NodeHealthHistory(":memory:", {}, { clock: () => T0, monotonic: () => mono.t });
		const offset = run === "honest" ? 0 : run === "forward" ? 3_600_000 : -3_600_000;
		Date.now = () => realNow() + offset;
		const resource: (boolean | null)[] = [];
		// Stamped right before each probe: fresh, so observed true in every run.
		for (let i = 0; i < 3; i++) {
			mono.t += 30_000;
			const evidence = h.stampSample(okSample(0));
			const [r] = await observeNodeHealth([f.node], h, { resourceEvidence: () => evidence });
			resource.push(r!.observation.resourceSampleOk);
		}
		// Stamped, then the history's monotonic clock moves past maxSampleAgeMs (15 s): unobserved.
		const old = h.stampSample(okSample(realNow()));
		mono.t += 15_001;
		const [stale] = await observeNodeHealth([f.node], h, { resourceEvidence: () => old });
		resource.push(stale!.observation.resourceSampleOk);
		// A stamp that is ahead of the history's monotonic clock is not trusted either.
		const ahead = { ...h.stampSample(okSample(realNow())), mono: mono.t + 1 };
		const [future] = await observeNodeHealth([f.node], h, { resourceEvidence: () => ahead });
		resource.push(future!.observation.resourceSampleOk);
		Date.now = realNow;
		out[run] = { resource, stable: h.dimensions("N").stable };
		h.close();
	}
	expect(out.honest).toEqual({ resource: [true, true, true, null, null], stable: true });
	expect(out.forward).toEqual(out.honest);
	expect(out.backward).toEqual(out.honest);
}, 120_000);

test("L1: the decision probe (switch on) uses the same rule; caller samples stay admission input only", async () => {
	const f = await fixture();
	const path = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const history = new NodeHealthHistory(path);
	try {
		store.putNode(f.node);
		history.setSelectionGating(true, { operator: "ops", reason: "L1" });
		const recorded = () => history.observations("N").at(-1)!.resourceSampleOk;
		const decide = async (resources: { samples: ReadonlyMap<string, ResourceSample> }, nodeHealth: NonNullable<Parameters<typeof reservePlacement>[3]>["nodeHealth"]) =>
			reservePlacement(store, store.submit({ ...f.input, key: "k" + Math.random() }).id, resources, { nodeHealth });
		// Caller-supplied (wall-stamped) samples: admission input, never health success evidence.
		const plain = await decide(headroom(["N"], 10), { history: () => history });
		// Ready by the unchanged pre-feature checks; only the health gate (fresh history) excludes it.
		expect(Object.values(plain.report.nodes[0]!.checks).every(check => check.ok)).toBe(true);
		expect(plain.report.selection.exclusions).toContainEqual({ nodeId: "N", reasons: ["node_unstable", "consecutive_observations", "unobserved:resourceSampleOk"] });
		expect(recorded()).toBeNull();
		// Fresh samples measured through the access and stamped on receipt are success evidence.
		const fresh = headroom(["N"], 10);
		await decide(fresh, { history: () => history, sample: async stamp => { for (const [id, s] of fresh.samples) stamp(id, s); return fresh.samples; } });
		expect(recorded()).toBe(true);
		// A failed sample is a failure, whoever measured it.
		await decide({ samples: new Map([["N", { ok: false, at: Date.now(), error: "x" }]]) }, { history: () => history });
		expect(recorded()).toBe(false);
	} finally { history.close(); store.close(); }
}, 120_000);

test("L1: a bootstrap sample taken during the probe is stamped by the bootstrapping process", async () => {
	const f = await fixture();
	const clock = { now: realNow() };
	const history = new NodeHealthHistory(":memory:", {}, { clock: () => clock.now, monotonic: () => clock.now });
	try {
		// The sampler hands back a sample whose wall stamp is a day old: irrelevant, it was taken now.
		const result = await bootstrapNodeHealth([f.node], history, { reason: "L1", sampleResources: async () => okSample(0), wait: async ms => { clock.now += ms; } });
		expect(result).toEqual([{ nodeId: "N", outcome: "stable", observations: 3 }]);
		expect(history.observations("N").map(o => o.resourceSampleOk)).toEqual([true, true, true]);
	} finally { history.close(); }
}, 120_000);
