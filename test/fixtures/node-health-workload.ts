// Randomized scheduling workload for the base-vs-patched differential test (review caba7bbd H1).
// `runWorkload(root, …)` imports every module from `root`, so the same seed can be replayed through
// main (a pristine extract) and through the patched tree. Only the patched tree can seed a history.
// The result is a normalized record of every decision: per operation the returned phase / node /
// exit code / readiness / selection, and per task its final phase, node, reserved and held flags,
// every audit event kind and every selection audit payload (exclusions included).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type HistoryKind = "none" | "empty" | "stable" | "mixed" | "recovering" | "random" | "corrupt" | "toggled" | "producer" | "enforced";
export const HISTORIES: HistoryKind[] = ["none", "empty", "stable", "mixed", "recovering", "random", "corrupt", "toggled", "producer"];
/** Negative control only: a stable history with the switch left ON, so the gate does take part. */
export const ENFORCED: HistoryKind = "enforced";
const brokerList = fileURLToPath(new URL("./broker-list.ts", import.meta.url));

function rng(seed: number) {
	return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export interface WorkloadOptions { seed: number; history: HistoryKind; operations?: number }
export async function runWorkload(root: string, options: WorkloadOptions) {
	const { FleetStore } = await import(join(root, "src/store.ts"));
	const { Fleet } = await import(join(root, "src/fleet.ts"));
	const { submitPlacement, reconsiderQueue } = await import(join(root, "src/index.ts"));
	const { reservePlacement } = await import(join(root, "src/placement-preflight.ts"));
	const { runTask } = await import(join(root, "src/operator-commands.ts"));
	const { repositoryFixture } = await import(join(root, "test/fixtures/coordinator.ts"));
	const { headroom } = await import(join(root, "test/admission-fixture.ts"));
	const rand = rng(options.seed * 7919 + 17);
	const pick = <T>(values: readonly T[]) => values[Math.floor(rand() * values.length)]!;
	const repo = await repositoryFixture("fleet-nh-diff-");
	const helper = join(root, "src/placement-preflight.ts");
	const coordinator = join(root, "test/fixtures/coordinator.ts");
	const input = { schemaVersion: 1, key: "k", caller: "differential", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	// A slow (6 s) Broker on A: any Broker probe on a scheduling path would expire 10 s old samples.
	const specs: Record<string, { broker?: string | null; broken?: boolean; profile?: string; draining?: boolean }> = {
		A: { broker: "ok,slow=6000" }, B: { broker: "fail" }, C: { broker: null }, D: { broken: true }, E: { profile: "other" }, F: { draining: true }, G: {},
	};
	const NODES = Object.keys(specs);
	async function node(id: string) {
		const spec = specs[id]!;
		const state = join(repo.dir, id + "-coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const config = join(repo.dir, id + ".json");
		const value: any = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces-" + id), enabled: true, draining: spec.draining === true, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: [spec.profile ?? "controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: spec.broken ? { command: "/usr/bin/false", args: [] } : { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] } };
		if (spec.broker !== null) value.sdkTransport = { command: process.execPath, args: [brokerList, spec.broker ?? "ok"] };
		await writeFile(config, JSON.stringify(value));
		return value;
	}
	const path = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(path);
	for (const id of NODES) store.putNode(await node(id));
	const closers: (() => void | Promise<void>)[] = [];
	// The history has its own random stream, so the workload is the same for every history kind.
	if (options.history !== "none") closers.push(...await seedHistory(path, options.history, rng(options.seed * 104729 + 3), NODES));
	const fleet = new Fleet(store);
	// Access that must never be used while the switch is off; any use is recorded and reported.
	const misuse: string[] = [];
	const { NodeHealthHistory } = options.history === "enforced" ? await import("../../src/node-health") : { NodeHealthHistory: undefined };
	let enforced: any;
	if (NodeHealthHistory) closers.push(() => enforced?.close());
	const nodeHealth = NodeHealthHistory
		? { history: () => (enforced ??= new NodeHealthHistory(path)) }
		: { history: () => { misuse.push("history"); throw new Error("history_opened_with_switch_off"); }, sample: async () => { misuse.push("sample"); throw new Error("health_sample_with_switch_off"); } };
	const health = options.history === "none" ? {} : { nodeHealth };
	/** Random samples: a subset of nodes, ages 0 / 5 / 10 s (fresh) or 30 s (stale), some busy or failed. */
	const samples = () => {
		const out = new Map<string, any>();
		for (const id of NODES) {
			if (rand() < 0.2) continue;
			const sample = { ...headroom([id], 10).samples.get(id)!, at: Date.now() - pick([0, 5_000, 10_000, 30_000]) };
			const r = rand();
			out.set(id, r < 0.1 ? { ok: false, at: sample.at, error: "x" } : r < 0.2 ? { ...sample, cpuPct: 99 } : sample);
		}
		return out;
	};
	const pin = () => pick(["A", "B", "C", "D", "E", "F", "G"]);
	const ops: unknown[] = [];
	const report = (r: any) => r?.report ? { ready: r.report.nodes.map((n: any) => [n.nodeId, n.ready, Object.entries(n.checks).filter(([, c]: any) => !c.ok).map(([k, c]: any) => k + ":" + c.code)]), selection: r.report.selection } : null;
	const count = options.operations ?? 8;
	for (let i = 0; i < count; i++) {
		const kind = pick(["submit", "submit-pinned", "reserve", "reconsider", "run", "run-pinned", "drain"] as const);
		const key = `op${i}-${kind}`;
		if (kind === "submit" || kind === "submit-pinned") {
			const task = kind === "submit" ? { ...input, key } : { ...input, key, required: { ...input.required, nodeId: pin() } };
			const r = await submitPlacement(fleet, task, { samples: samples() }, { ...health });
			ops.push({ kind, phase: r.task.phase, nodeId: r.task.nodeId ?? null, ...report(r) });
		} else if (kind === "reserve") {
			const task = store.submit({ ...input, key });
			const r = await reservePlacement(store, task.id, { samples: samples() }, { ...health });
			ops.push({ kind, phase: r.task.phase, nodeId: r.task.nodeId ?? null, ...report(r) });
		} else if (kind === "reconsider") {
			const fixed = samples();
			const r = await reconsiderQueue(fleet, async () => fixed, { ...health, limit: 3 });
			ops.push({ kind, results: r.map((t: any) => [t.input.key, t.phase, t.nodeId ?? null]) });
		} else if (kind === "run" || kind === "run-pinned") {
			const task = kind === "run" ? { ...input, key } : { ...input, key, required: { ...input.required, nodeId: pin() } };
			const fixed = samples();
			const r = await runTask(fleet, task, { sample: async () => fixed, leaseMs: 5_000, ...health });
			ops.push({ kind, code: r.code, phase: r.task.phase, nodeId: r.task.nodeId ?? null, placement: r.placement ? report({ report: r.placement }) : null });
		} else {
			const id = pick(["A", "B", "G"]);
			const draining = rand() < 0.5;
			store.setNodeState(id, draining ? { draining: true } : { enabled: true, draining: false });
			ops.push({ kind, id, draining });
		}
	}
	for (const close of closers) await close();
	const drop = new Set(["taskId", "attemptId", "sessionId", "id", "at", "checkedAt", "inputDigest", "nodeDigest", "nodeDigests", "createdAt", "updatedAt", "turnId", "operationId", "seq", "elapsedMs", "latencyMs", "sampleAgeMs", "ageMs", "time", "pid", "observability", "expiresAt", "owner", "host"]);
	const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
	const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => drop.has(k) ? undefined : typeof x === "string" ? x.split(repo.dir).join("<dir>").split(root).join("<root>").replace(uuid, "<uuid>") : x));
	const tasks = store.tasks().map((task: any) => {
		const events = store.events(task.id);
		return { key: task.input.key, phase: task.phase, nodeId: task.nodeId ?? null, reserved: !!task.attemptId, held: !!task.held, reason: task.reason ?? null,
			kinds: events.map((e: any) => e.kind), selections: events.filter((e: any) => e.kind === "selection").map((e: any) => e.data) };
	}).sort((a: any, b: any) => a.key.localeCompare(b.key));
	store.close();
	const { rm } = await import("node:fs/promises");
	await rm(repo.dir, { recursive: true, force: true });
	return { decisions: norm({ ops, tasks }), misuse };
}

/** Seeds a history with the patched tree's NodeHealthHistory on the fleet DB; never turns the switch on at the end. */
async function seedHistory(path: string, kind: HistoryKind, rand: () => number, nodes: string[]) {
	const { NodeHealthHistory } = await import("../../src/node-health");
	const clock = { wall: 1_800_000_000_000, mono: 1_000 };
	const make = () => new NodeHealthHistory(path, {}, { clock: () => clock.wall, monotonic: () => clock.mono });
	let h = make();
	const good = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
	const bad = (k: string) => ({ ...good, [k]: false });
	const spaced = (n: string, count: number) => { for (let i = 0; i < count; i++) { clock.mono += 30_000; clock.wall += 30_000; h.record(n, good); } };
	const all = [...nodes, "Z"];
	if (kind === "stable" || kind === "enforced") for (const n of all) spaced(n, 4);
	if (kind === "enforced") h.setSelectionGating(true, { operator: "ops", reason: "negative control" });
	if (kind === "mixed") { spaced("A", 4); h.record("B", bad("reachable")); spaced("C", 1); h.record("Z", bad("resourceSampleOk")); h.auditPinnedAdmission("t", "G", ["reachable"]); h.retainNodes(nodes); }
	if (kind === "recovering") for (const n of all) { spaced(n, 4); h.record(n, bad("brokerSessionListOk")); spaced(n, 2); }
	if (kind === "toggled") { spaced("A", 4); h.setSelectionGating(true, { operator: "ops", reason: "t" }); clock.wall += 1; h.setSelectionGating(false, { operator: "ops", reason: "t" }); }
	if (kind === "corrupt") {
		spaced("A", 4);
		const { Database } = await import("bun:sqlite");
		const db = new Database(path);
		db.query("UPDATE node_health_state SET data='{' WHERE node='A'").run();
		db.close();
	}
	if (kind === "random" || kind === "producer") {
		for (let i = 0; i < 120; i++) {
			if (rand() < 0.05) { h.close(); h = make(); }
			const step = rand();
			clock.mono += step < 0.1 ? -50_000 : step < 0.2 ? 0 : step < 0.25 ? 1e9 : Math.floor(rand() * 40_000);
			clock.wall += Math.floor((rand() - 0.3) * 1e7);
			const n = all[Math.floor(rand() * all.length)]!;
			const f = rand();
			h.record(n, f < 0.15 ? bad(["reachable", "brokerSessionListOk", "resourceSampleOk"][Math.floor(rand() * 3)]!) : { ...good, brokerSessionListOk: rand() < 0.2 ? null : true, resourceSampleOk: rand() < 0.2 ? null : true });
		}
	}
	if (kind !== "producer") { h.close(); return []; }
	// A concurrent hub producer recording real probes on the same DB while the workload runs.
	const { observeNodeHealth } = await import("../../src/node-health-gate");
	const { FleetStore } = await import("../../src/store");
	const store = new FleetStore(path);
	let stopped = false;
	const loop = (async () => {
		while (!stopped) {
			h.retainNodes(store.nodes().map((node: any) => node.id));
			await observeNodeHealth(store.nodes(), h, { timeoutMs: 2_000 });
			await Bun.sleep(50);
		}
	})();
	return [async () => { stopped = true; await loop; h.close(); store.close(); }];
}

/** Standalone: `bun test/fixtures/node-health-workload.ts ROOT SEED HISTORY [OPERATIONS]` prints the result. */
if (import.meta.main) {
	const [root, seed, history, operations] = process.argv.slice(2);
	const result = await runWorkload(root!, { seed: Number(seed), history: history as HistoryKind, ...(operations ? { operations: Number(operations) } : {}) });
	console.log(JSON.stringify(result));
}
