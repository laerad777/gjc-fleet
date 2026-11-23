import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";
import { FleetStore } from "../src/store";
import { resourceReasons, type ResourceSample } from "../src/admission";
import { preflightPlacement, probePlacementSource } from "../src/placement-preflight";
import { evaluateHealth, NodeHealthHistory, stepHealth } from "../src/node-health";
import { Fleet } from "../src/fleet";
import { reconsiderQueue } from "../src/index";
import { FleetDaemon } from "../src/daemon";
import { getDashboardState } from "../src/dashboard";
import { runTask } from "../src/operator-commands";
import { isRoleTask } from "../src/work-unit";
import {
	canonicalJson,
	FleetError,
	PLACEMENT_BLOCKING_LIMIT,
	PLACEMENT_REASON_CLASSES,
	PLACEMENT_REASON_PREFIXES,
	placementVerdict,
	PREFLIGHT_STAGES,
	reasonClass,
	reconsiderCandidates,
	selectNode,
} from "../src/core";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

// Real FleetStore/Fleet/CLI on temporary databases. Node transports are local stand-ins that only append to a
// marker file, so a test can prove that a command contacted no node.
const root = resolve(import.meta.dir, "..");
const CLI = join(root, "src/cli.ts");
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const BASE = "a".repeat(40);
const REPO = "example-repo";

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-unplaceable-"));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => store.close());
	const marker = join(dir, "node-calls.log");
	const node = (id: string, roots: Record<string, string> = {}, extra: Partial<NodeConfig> = {}): NodeConfig => ({
		id, os: process.platform, arch: process.arch, roots, workspaceRoot: join(dir, "ws"), enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: ["--eval", `require("fs").appendFileSync(${JSON.stringify(marker)}, "call\\n")`] },
		...extra,
	});
	const input = (key: string, extra: Partial<TaskInput> = {}): TaskInput => ({
		schemaVersion: 1, key, caller: "unplaceable-test", repoId: REPO, baseCommit: BASE, prompt: `SECRET PROMPT ${key}`, required: {}, ...extra,
	});
	const fleet = new Fleet(store);
	const selections = (id: string) => store.events(id).filter((event) => event.kind === "selection").length;
	const calls = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);
	return { dir, path, store, fleet, node, input, selections, calls };
}
type Fixture = ReturnType<typeof fixture>;
/** headroom() samples taken 1 s ago (14 s of freshness left), so a busy machine does not turn them stale mid-test. */
function fresh(ids: string[]) {
	const { samples } = headroom(ids, 50);
	for (const sample of samples.values()) sample.at = Date.now() - 1_000;
	return { samples };
}
/** A repository-pinned shape: NODEB does not serve the repository, NODEA does; the task is pinned to NODEB. */
function production(f: Fixture) {
	f.store.putNode(f.node("NODEB", { other: join(f.dir, "other") }));
	f.store.putNode(f.node("NODEA", { [REPO]: join(f.dir, "repo") }));
	// NODEB is not measured (resources_unknown), as in production.
	return fresh(["NODEA"]);
}
async function cli(path: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, CLI, "--db", path, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, exit };
}

// ---- A. classification -------------------------------------------------------------------------------------

test("every exclusion reason the producers emit at run time is classified explicitly (selectNode, admission, preflight, node health, gate)", async () => {
	const f = fixture();
	const emitted = new Set<string>();
	// A preflight composite `<stage>:<code>[+<code>]` contributes each of its codes.
	const add = (reasons: readonly string[]) => {
		for (const reason of reasons) {
			const colon = reason.indexOf(":");
			const stage = colon > 0 && (PREFLIGHT_STAGES as readonly string[]).includes(reason.slice(0, colon));
			for (const code of stage ? reason.slice(colon + 1).split("+") : [reason]) emitted.add(code);
		}
	};
	const now = Date.now();
	// selectNode hard filters (registry and task requirements).
	const required = { os: "plan9", arch: "pdp11", model: "m", modelProfile: "p", nodeId: "other", operations: ["op"] } as TaskInput["required"];
	add(selectNode(f.input("hard", { required }), [f.node("N", {}, { enabled: false, draining: true, reachable: false, sdkReady: false, modelReady: false })], []).exclusions[0]!.reasons);
	// admission.ts measured headroom, every branch.
	const wsRoot = join(f.dir, "ws");
	const good = (): ResourceSample => ({ ok: true, at: now, cpuPct: 1, memTotal: 64 * 1024 ** 3, memUsed: 1024 ** 3, disks: [{ path: parse(wsRoot).root, total: 1024 ** 4, used: 0 }] });
	for (const sample of [
		undefined,
		{ ...good(), ok: false },
		{ ...good(), at: now - 60_000 },
		{ ...good(), cpuPct: Number.NaN },
		{ ...good(), cpuPct: 99, memUsed: 64 * 1024 ** 3, disks: [{ path: parse(wsRoot).root, total: 1024 ** 4, used: 1024 ** 4 }] },
		{ ...good(), disks: [] },
	] as (ResourceSample | undefined)[])
		add(resourceReasons(wsRoot, sample, 0, now));
	// Placement preflight: a hard-ineligible node, a remote node without workspace transport whose Coordinator
	// fails, and a node whose workspace transport fails and whose Coordinator lacks the tools.
	const emptyCoordinator = join(f.dir, "empty-coordinator.ts");
	writeFileSync(emptyCoordinator, `let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += new TextDecoder().decode(chunk);
	let nl;
	while ((nl = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
		if (!line.trim()) continue;
		const request = JSON.parse(line);
		if (request.id === undefined) continue;
		const result = request.method === "initialize" ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "empty", version: "1" } } : { tools: [] };
		process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
	}
}`);
	const failing = { command: process.execPath, args: ["--eval", "process.exit(3)"] };
	const repoRoots = { [REPO]: join(f.dir, "repo") };
	const report = await preflightPlacement(f.input("preflight"), [
		f.node("HARD", {}, { enabled: false }),
		f.node("REMOTE", repoRoots, { transport: failing }),
		f.node("XPORT", repoRoots, { transport: { command: process.execPath, args: [emptyCoordinator] }, workspaceTransport: failing }),
	], [], { samples: new Map(), held: new Map(), now }, { timeoutMs: 10_000 });
	for (const row of report.selection.exclusions) add(row.reasons);
	// A node whose probe is deferred because another call to it is in flight.
	const busy = await preflightPlacement(f.input("busy"), [f.node("BUSY", repoRoots)], [], { samples: new Map(), held: new Map(), now }, {
		timeoutMs: 10_000, nodeCall: async () => { throw new FleetError("NODE_BUSY", "busy"); },
	});
	for (const row of busy.selection.exclusions) add(row.reasons);
	// The local read-only source/workspace probe: another platform; a missing repository and a workspace under a file.
	const file = join(f.dir, "a-file");
	writeFileSync(file, "x");
	const other = process.platform === "win32" ? "linux" : "win32";
	for (const node of [f.node("PLAT", repoRoots, { os: other }), f.node("LOCAL", repoRoots, { workspaceRoot: join(file, "ws") }), f.node("NOREPO", {}, { workspaceRoot: join(file, "ws") })]) {
		const probed = await probePlacementSource(node, { repoId: REPO, baseCommit: BASE });
		for (const check of [probed.source, probed.workspace]) if (!check.ok) add([check.code]);
	}
	// Node health: no history, a failed probe (every dimension), a good probe that observed nothing yet.
	add(evaluateHealth(undefined).failingDimensions);
	const observation = (value: boolean | null) => ({ at: now, reachable: value ?? true, brokerSessionListOk: value, resourceSampleOk: value, latencyMs: 1 });
	add(evaluateHealth(stepHealth(undefined, { observation: observation(false), seq: 1, writer: "w", mono: 0 }, undefined).state).failingDimensions);
	add(evaluateHealth(stepHealth(undefined, { observation: observation(null), seq: 1, writer: "w", mono: 0 }, undefined).state).failingDimensions);
	// The decision without its own probe.
	const history = new NodeHealthHistory(join(f.dir, "health.sqlite"));
	cleanups.push(() => history.close());
	const decision = history.admit("UNPROBED", false);
	add([decision.reason!, ...decision.health.failingDimensions]);
	// The gate on a ready node with the switch on and no node-health access: node_unstable + node_health_unavailable.
	const repo = await repositoryFixture("fleet-unplaceable-gate-");
	cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	const state = join(repo.dir, "coordinator.json");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	const ready: NodeConfig = { id: "READY", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
	store.putNode(ready);
	const gating = new NodeHealthHistory(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => gating.close());
	gating.setSelectionGating(true, { operator: "test", reason: "gated vocabulary" });
	const fleet = new Fleet(store, { localNodeId: ready.id });
	const queued = fleet.submit({ schemaVersion: 1, key: "gated", caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled", required: {} }, { samples: new Map() });
	const measured = () => {
		const samples = fresh([ready.id]).samples;
		samples.get(ready.id)!.disks![0]!.path = ready.workspaceRoot;
		return samples;
	};
	expect(await reconsiderQueue(fleet, async () => measured(), { localNodeId: ready.id })).toEqual([expect.objectContaining({ id: queued.id, phase: "queued" })]);
	add(store.task(queued.id)!.placement!.blocking.flatMap((row) => row.reasons));
	const classified = (code: string) =>
		Object.hasOwn(PLACEMENT_REASON_CLASSES, code) || Object.keys(PLACEMENT_REASON_PREFIXES).some((prefix) => code.startsWith(prefix) && code.length > prefix.length);
	expect([...emitted].filter((code) => !classified(code)).sort()).toEqual([]);
	// Not vacuous: the producers reached every classified reason except the legacy slot reasons of older audit rows.
	const reached = new Set([...emitted].map((code) => Object.keys(PLACEMENT_REASON_PREFIXES).find((prefix) => code.startsWith(prefix)) ?? code));
	expect(Object.keys(PLACEMENT_REASON_CLASSES).filter((code) => !reached.has(code)).sort()).toEqual(["global_capacity", "node_capacity"]);
	expect(Object.keys(PLACEMENT_REASON_PREFIXES).filter((prefix) => !reached.has(prefix))).toEqual([]);
}, 120_000);

test("every reason selectNode emits at run time is classified explicitly", () => {
	const f = fixture();
	const input = f.input("runtime", { required: { os: "plan9", arch: "pdp11", model: "m", modelProfile: "p", nodeId: "other", operations: ["op"] } });
	const node = f.node("N", {}, { enabled: false, draining: true, reachable: false, sdkReady: false, modelReady: false });
	const reasons = selectNode(input, [node], [], { samples: new Map(), held: new Map(), now: Date.now() }).exclusions[0]!.reasons;
	expect(reasons.length).toBeGreaterThanOrEqual(12);
	for (const reason of reasons)
		expect({ reason, classified: Object.hasOwn(PLACEMENT_REASON_CLASSES, reason) || Object.keys(PLACEMENT_REASON_PREFIXES).some((prefix) => reason.startsWith(prefix)) })
			.toEqual({ reason, classified: true });
});

test("reason classes: structural only for operator configuration, unknown/new reasons transient, preflight composites", () => {
	for (const reason of ["repo_unavailable", "manual_node_mismatch", "disabled", "os_mismatch", "arch_mismatch", "model_unavailable", "model_profile_unavailable", "operation_unavailable:review", "probe_platform_mismatch"])
		expect([reason, reasonClass(reason)]).toEqual([reason, "structural"]);
	for (const reason of ["resources_unknown", "resources_stale", "cpu_busy", "memory_low", "disk_low", "workspace_disk_unknown", "draining", "unreachable", "sdk_not_ready", "model_not_ready", "node_capacity", "global_capacity", "node_unstable", "unobserved:reachable", "workspace_transport_required", "coordinator_unavailable"])
		expect([reason, reasonClass(reason)]).toEqual([reason, "transient"]);
	// Unknown or new reasons are never structural, also inside a preflight composite or with an unknown stage.
	for (const reason of ["brand_new_reason", "operation_unavailable:", "eligibility:brand_new_reason", "nostage:repo_unavailable", ""])
		expect([reason, reasonClass(reason)]).toEqual([reason, "transient"]);
	expect(reasonClass("eligibility:draining+repo_unavailable")).toBe("structural");
	expect(reasonClass("source:hard_ineligible_probe_skipped")).toBe("transient");
	expect(reasonClass("resources:resources_unknown+cpu_busy")).toBe("transient");
	expect(reasonClass("model:model_profile_unavailable")).toBe("structural");
});

test("verdict boundaries: pinned vs unpinned, one structural + one transient, all structural, unknown reason", () => {
	const input = (required: TaskInput["required"] = {}) => ({ schemaVersion: 1, key: "k", caller: "c", repoId: REPO, baseCommit: BASE, prompt: "p", required }) as TaskInput;
	// Pinned node structurally excluded: unplaceable whatever the other nodes say.
	expect(placementVerdict(input({ nodeId: "A" }), [{ nodeId: "A", reasons: ["repo_unavailable", "resources_unknown"] }, { nodeId: "B", reasons: ["cpu_busy"] }]).verdict).toBe("unplaceable");
	// Pinned node only transiently excluded: waiting, although every other node is structurally excluded.
	expect(placementVerdict(input({ nodeId: "A" }), [{ nodeId: "A", reasons: ["resources_unknown"] }, { nodeId: "B", reasons: ["manual_node_mismatch"] }]).verdict).toBe("waiting");
	// Pinned to a node that is not registered: every node mismatches the pin.
	expect(placementVerdict(input({ nodeId: "GONE" }), [{ nodeId: "B", reasons: ["manual_node_mismatch"] }]).verdict).toBe("unplaceable");
	// Unpinned: one structural + one transient node is waiting; all structural is unplaceable.
	const mixed = placementVerdict(input(), [{ nodeId: "A", reasons: ["repo_unavailable"] }, { nodeId: "B", reasons: ["resources_unknown"] }]);
	expect(mixed.verdict).toBe("waiting");
	expect(mixed.blocking.map((row) => row.nodeId)).toEqual(["B", "A"]);
	expect(placementVerdict(input(), [{ nodeId: "A", reasons: ["repo_unavailable"] }, { nodeId: "B", reasons: ["disabled", "cpu_busy"] }]).verdict).toBe("unplaceable");
	// Unknown reasons and an empty registry never declare a task unplaceable.
	expect(placementVerdict(input(), [{ nodeId: "A", reasons: ["brand_new_reason"] }]).verdict).toBe("waiting");
	expect(placementVerdict(input(), []).verdict).toBe("waiting");
	// The digest ignores order: the same exclusion set in another order is the same record.
	expect(placementVerdict(input(), [{ nodeId: "B", reasons: ["cpu_busy", "disk_low"] }, { nodeId: "A", reasons: ["repo_unavailable"] }]).exclusionsDigest)
		.toBe(placementVerdict(input(), [{ nodeId: "A", reasons: ["repo_unavailable"] }, { nodeId: "B", reasons: ["disk_low", "cpu_busy"] }]).exclusionsDigest);
});

test("pinned-task shape through the real store: pinned task on a node without the repository is unplaceable, record bounded and named", () => {
	const f = fixture();
	const { samples } = production(f);
	const task = f.fleet.submit(f.input("pinned", { required: { nodeId: "NODEB" } }), { samples });
	expect(task.phase).toBe("queued");
	expect(task.reason).toBe("no_eligible_node");
	const placement = f.store.task(task.id)!.placement!;
	expect(placement).toMatchObject({ verdict: "unplaceable", rejections: 1, nodes: 2, blocking: [{ nodeId: "NODEB", reasons: ["repo_unavailable", "resources_unknown"] }, { nodeId: "NODEA", reasons: ["manual_node_mismatch"] }] });
	expect(placement.since).toBe(placement.checkedAt);
	// The full selection audit row is kept exactly as before.
	const row = f.store.events(task.id).find((event) => event.kind === "selection")!.data as any;
	expect(row.exclusions).toEqual([{ nodeId: "NODEA", reasons: ["manual_node_mismatch"] }, { nodeId: "NODEB", reasons: ["repo_unavailable", "resources_unknown"] }]);
	expect(row.reason).toBe("no_eligible_node");
});

test("one structural + one transient node through the real store is waiting; all structural is unplaceable; unknown reason is waiting", () => {
	const f = fixture();
	f.store.putNode(f.node("A", {}));
	f.store.putNode(f.node("B", { [REPO]: join(f.dir, "repo") }));
	// B is not measured: transient.
	const waiting = f.fleet.submit(f.input("mixed"), { samples: fresh(["A"]).samples });
	expect(f.store.task(waiting.id)!.placement).toMatchObject({ verdict: "waiting", blocking: [{ nodeId: "B", reasons: ["resources_unknown"] }, { nodeId: "A", reasons: ["repo_unavailable"] }] });
	f.store.setNodeState("B", { enabled: false });
	const blocked = f.fleet.submit(f.input("structural"), { samples: fresh(["A", "B"]).samples });
	expect(f.store.task(blocked.id)!.placement).toMatchObject({ verdict: "unplaceable", blocking: [{ nodeId: "A", reasons: ["repo_unavailable"] }, { nodeId: "B", reasons: ["disabled"] }] });
	// A caller-side gate's unknown reason on the only node that serves the repository: waiting.
	f.store.setNodeState("B", { enabled: true });
	const unknown = f.store.submit(f.input("unknown"));
	f.store.reserve(unknown.id, { samples: fresh(["A", "B"]).samples, exclusions: [{ nodeId: "B", reasons: ["brand_new_reason"] }] });
	expect(f.store.task(unknown.id)!.placement).toMatchObject({ verdict: "waiting", blocking: [{ nodeId: "B", reasons: ["brand_new_reason"] }, { nodeId: "A", reasons: ["repo_unavailable"] }] });
});

test("record bounded with 50 nodes", () => {
	const f = fixture();
	const ids = Array.from({ length: 50 }, (_, i) => `node-${String(i).padStart(2, "0")}-${"x".repeat(40)}`);
	for (const id of ids) f.store.putNode(f.node(id, {}, { operations: [] }));
	const task = f.fleet.submit(f.input("fifty", { required: { operations: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] } }), { samples: fresh(ids).samples });
	const placement = f.store.task(task.id)!.placement!;
	expect(placement.verdict).toBe("unplaceable");
	expect(placement.nodes).toBe(50);
	expect(placement.blocking).toHaveLength(PLACEMENT_BLOCKING_LIMIT);
	for (const row of placement.blocking) expect(row.reasons.length).toBeLessThanOrEqual(8);
	expect(canonicalJson(placement).length).toBeLessThan(6_000);
	// Sorted: equal distance, so by node id.
	expect(placement.blocking.map((row) => row.nodeId)).toEqual(ids.slice(0, PLACEMENT_BLOCKING_LIMIT));
});

// ---- C. audit growth, reconsider limit, recovery -------------------------------------------------------------

test("100 identical rejections add O(1) selection rows; a changed exclusion set is still audited", () => {
	const f = fixture();
	const { samples } = production(f);
	const task = f.fleet.submit(f.input("repeat", { required: { nodeId: "NODEB" } }), { samples });
	const first = f.store.task(task.id)!.placement!;
	for (let i = 0; i < 100; i++) f.store.reserve(task.id, { samples });
	expect(f.selections(task.id)).toBe(1);
	const after = f.store.task(task.id)!.placement!;
	expect(after.rejections).toBe(101);
	expect(after.since).toBe(first.since);
	expect(Date.parse(after.checkedAt)).toBeGreaterThanOrEqual(Date.parse(first.checkedAt));
	expect(f.store.events(task.id).length).toBe(2); // submitted + the one selection row
	// NODEB gets measured: only a transient reason of a structurally excluded node changes, so the verdict-deciding
	// reasons are the same: counted, not audited, `since` kept, `blocking` shows the latest full reasons.
	const measured = fresh(["NODEA", "NODEB"]).samples;
	f.store.reserve(task.id, { samples: measured });
	expect(f.selections(task.id)).toBe(1);
	expect(f.store.task(task.id)!.placement).toMatchObject({ verdict: "unplaceable", since: first.since, rejections: 102, blocking: [{ nodeId: "NODEB", reasons: ["repo_unavailable"] }, { nodeId: "NODEA", reasons: ["manual_node_mismatch"] }] });
	// A structural change (NODEA disabled): still unplaceable, a new record, audited once.
	f.store.setNodeState("NODEA", { enabled: false });
	f.store.reserve(task.id, { samples: measured });
	expect(f.selections(task.id)).toBe(2);
	expect(f.store.task(task.id)!.placement).toMatchObject({ verdict: "unplaceable", rejections: 1, blocking: [{ nodeId: "NODEB", reasons: ["repo_unavailable"] }, { nodeId: "NODEA", reasons: ["disabled", "manual_node_mismatch"] }] });
	for (let i = 0; i < 20; i++) f.store.reserve(task.id, { samples: i % 2 ? measured : samples });
	expect(f.selections(task.id)).toBe(2);
	// Back to the earlier structural set: a change again, audited again.
	f.store.setNodeState("NODEA", { enabled: true });
	f.store.reserve(task.id, { samples });
	expect(f.selections(task.id)).toBe(3);
});

test("gated reconsider: load alternating on an unrelated, structurally excluded node appends no selection row and keeps since", async () => {
	const f = fixture();
	production(f);
	const gating = new NodeHealthHistory(f.path);
	cleanups.push(() => gating.close());
	gating.setSelectionGating(true, { operator: "test", reason: "gated placement record" });
	expect(f.store.nodeHealthGating().enabled).toBe(true);
	const task = f.fleet.submit(f.input("gated", { required: { nodeId: "NODEB" } }), { samples: new Map() });
	// NODEA serves the repository but is excluded by the pin; only its CPU changes between passes.
	const load = (busy: boolean) => {
		const { samples } = fresh(["NODEA"]);
		samples.get("NODEA")!.cpuPct = busy ? 99 : 1;
		return samples;
	};
	const pass = (busy: boolean) => reconsiderQueue(f.fleet, async () => load(busy), { nodeHealth: { history: () => gating } });
	expect(await pass(false)).toEqual([expect.objectContaining({ id: task.id, phase: "queued" })]);
	const first = f.store.task(task.id)!.placement!;
	const rows = f.selections(task.id);
	expect(first.verdict).toBe("unplaceable");
	expect(first.blocking.find((row) => row.nodeId === "NODEA")!.reasons).toContain("eligibility:manual_node_mismatch");
	for (let i = 1; i <= 20; i++) await pass(i % 2 === 1);
	const idle = f.store.task(task.id)!.placement!;
	expect(f.selections(task.id)).toBe(rows);
	expect(idle).toMatchObject({ verdict: "unplaceable", since: first.since, rejections: first.rejections + 20, exclusionsDigest: first.exclusionsDigest });
	expect(idle.blocking.find((row) => row.nodeId === "NODEA")!.reasons).not.toContain("resources:cpu_busy");
	// The display stays current: after a busy pass, blocking shows NODEA's live reason.
	await pass(true);
	const busy = f.store.task(task.id)!.placement!;
	expect(f.selections(task.id)).toBe(rows);
	expect(busy).toMatchObject({ since: first.since, rejections: first.rejections + 21 });
	expect(busy.blocking.find((row) => row.nodeId === "NODEA")!.reasons).toContain("resources:cpu_busy");
	expect(f.calls()).toBe(0);
}, 60_000);

test("reconsider LIMIT is not consumed by older unplaceable tasks; unplaceable tasks are still re-checked in rotation", async () => {
	const f = fixture();
	const { samples } = production(f);
	// Seeded with the exclusions a reconsider pass sees for them (no node is ready, so no sample is used).
	const stuck = Array.from({ length: 12 }, (_, i) => f.fleet.submit(f.input(`stuck-${i}`, { required: { nodeId: "NODEB" } }), { samples: new Map() }).id);
	expect(f.store.task(stuck[0]!)!.placement!.verdict).toBe("unplaceable");
	// A newer task that is merely waiting (NODEA serves the repository but its Coordinator does not answer).
	const waiting = f.fleet.submit(f.input("waiting"), { samples: new Map() }).id;
	expect(f.store.task(waiting)!.placement!.verdict).toBe("waiting");
	const first = await reconsiderQueue(f.fleet, async () => samples, { limit: 10 });
	expect(first.map((task) => task.id)).toContain(waiting);
	expect(first).toHaveLength(10);
	expect(first.every((task) => task.phase === "queued")).toBe(true);
	const rechecked = new Set(first.map((task) => task.id).filter((id) => id !== waiting));
	expect(rechecked.size).toBe(9);
	// The next pass re-checks the three unplaceable tasks the first pass left out (least recently checked first).
	const second = await reconsiderQueue(f.fleet, async () => samples, { limit: 10 });
	expect(second.map((task) => task.id)).toContain(waiting);
	for (const task of second) if (task.id !== waiting) rechecked.add(task.id);
	expect([...rechecked].sort()).toEqual([...stuck].sort());
	// Re-checks of an unchanged unplaceable task append no selection row.
	for (const id of stuck) expect(f.selections(id)).toBe(1);
	// Limit 1 with both kinds: the waiting task.
	expect((await reconsiderQueue(f.fleet, async () => samples, { limit: 1 })).map((task) => task.id)).toEqual([waiting]);
}, 60_000);

test("reconsider rotation: a candidate the pass skips (role task, work-unit switch off) never holds the re-check slot; LIMIT 1 never re-checks while a task waits", () => {
	const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
	const record = (checkedAt: string, verdict: "waiting" | "unplaceable" = "unplaceable") =>
		({ verdict, since: checkedAt, checkedAt, rejections: 1, exclusionsDigest: "d", nodes: 1, blocking: [{ nodeId: "A", reasons: ["repo_unavailable"] }] });
	const task = (id: string, placement: ReturnType<typeof record>, workUnit?: unknown) =>
		({ id, phase: "queued", held: false, placement, input: { schemaVersion: 1, key: id, caller: "c", repoId: REPO, baseCommit: BASE, prompt: "p", required: {}, ...(workUnit ? { workUnit } : {}) } }) as any;
	// The role task is the least recently checked unplaceable task; the pass skips it, so its checkedAt never advances.
	const role = task("role", record(at(0)), { role: "report" });
	const stuck = [1, 2, 3].map((i) => task(`stuck-${i}`, record(at(i))));
	const waiting = task("waiting", record(at(9), "waiting"));
	const states = [role, ...stuck, waiting];
	const skipped = (candidate: any) => isRoleTask(candidate);
	const rechecked: string[] = [];
	for (let pass = 0; pass < 3; pass++) {
		const chosen = reconsiderCandidates(states, 2, skipped);
		expect(chosen.map((candidate) => candidate.id)).toContain("waiting");
		const recheck = chosen.filter((candidate) => candidate.id !== "waiting");
		expect(recheck).toHaveLength(1);
		rechecked.push(recheck[0]!.id);
		// The pass re-checks it: its checkedAt advances.
		recheck[0]!.placement = record(at(10 + pass));
	}
	expect(rechecked).toEqual(["stuck-1", "stuck-2", "stuck-3"]);
	// Only skipped unplaceable tasks: no slot is held back for them.
	const other = task("waiting-2", record(at(9), "waiting"));
	expect(reconsiderCandidates([role, waiting, other], 2, skipped).map((candidate) => candidate.id)).toEqual(["waiting", "waiting-2"]);
	// LIMIT 1 with a waiting task: the waiting task, never a re-check (documented).
	expect(reconsiderCandidates(states, 1, skipped).map((candidate) => candidate.id)).toEqual(["waiting"]);
});

test("an unplaceable task recovers by itself once the operator adds the repository (reconsider admits and starts it; record cleared)", async () => {
	const repo = await repositoryFixture("fleet-unplaceable-recovery-");
	cleanups.push(() => rmSync(repo.dir, { recursive: true, force: true }));
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	const state = join(repo.dir, "coordinator.json");
	writeFileSync(state, JSON.stringify({ calls: [] }));
	const node: NodeConfig = { id: "NODEB", os: process.platform, arch: process.arch, roots: {}, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
	store.putNode(node);
	const fleet = new Fleet(store, { localNodeId: node.id });
	const measured = () => {
		const samples = fresh([node.id]).samples;
		samples.get(node.id)!.disks![0]!.path = node.workspaceRoot;
		return samples;
	};
	const input: TaskInput = { schemaVersion: 1, key: "recover", caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled recovery", required: { nodeId: node.id } };
	const queued = fleet.submit(input, { samples: measured() });
	expect(store.task(queued.id)!.placement!.verdict).toBe("unplaceable");
	expect(await reconsiderQueue(fleet, async () => measured(), { localNodeId: node.id })).toEqual([expect.objectContaining({ id: queued.id, phase: "queued" })]);
	store.putNode({ ...node, roots: { repo: repo.repo } });
	const [started] = await reconsiderQueue(fleet, async () => measured(), { localNodeId: node.id });
	expect(started!.id).toBe(queued.id);
	const task = store.task(queued.id)!;
	expect(task.attemptId).toBeTruthy();
	expect(task.phase).toBe("active");
	expect(task.placement).toBeUndefined();
	expect(task.reason).toBeUndefined();
}, 60_000);

test("an unplaceable task recovers when the operator re-enables its node (record cleared on admission)", () => {
	const f = fixture();
	f.store.putNode(f.node("ONLY", { [REPO]: join(f.dir, "repo") }, { enabled: false }));
	const { samples } = fresh(["ONLY"]);
	const task = f.fleet.submit(f.input("disabled"), { samples });
	expect(f.store.task(task.id)!.placement).toMatchObject({ verdict: "unplaceable", blocking: [{ nodeId: "ONLY", reasons: ["disabled"] }] });
	f.store.setNodeState("ONLY", { enabled: true });
	const admitted = f.store.reserve(task.id, { samples });
	expect(admitted.attemptId).toBeTruthy();
	expect(f.store.task(task.id)!.placement).toBeUndefined();
});

// ---- B. show ---------------------------------------------------------------------------------------------------

test("show, tasks --compact, queue reconsider and the dashboard distinguish waiting from unplaceable, in operator words, without the prompt", async () => {
	const f = fixture();
	const { samples } = production(f);
	const stuck = f.fleet.submit(f.input("stuck", { required: { nodeId: "NODEB" } }), { samples });
	const waiting = f.fleet.submit(f.input("waiting"), { samples: new Map() });
	const shown = await cli(f.path, "show", stuck.id);
	expect(shown.stderr).toBe("");
	expect(shown.exit).toBe(0);
	expect(shown.stdout).not.toContain("SECRET PROMPT");
	const view = JSON.parse(shown.stdout);
	expect(view.placement.verdict).toBe("unplaceable");
	expect(view.placement.summary).toContain("NODEB does not serve repository example-repo");
	expect(view.placement.summary).toStartWith("unplaceable: ");
	const compact = await cli(f.path, "--read-only", "tasks", "--compact");
	expect(compact.exit).toBe(0);
	expect(compact.stdout).not.toContain("SECRET PROMPT");
	const lines = compact.stdout.trim().split("\n");
	const line = (id: string) => lines.find((row) => row.startsWith(id.slice(0, 12)))!.split("\t");
	expect(line(stuck.id).at(-1)).toBe(`unplaceable=${JSON.stringify(view.placement.summary)}`);
	expect(line(waiting.id).at(-1)).toStartWith('waiting="waiting for capacity: NODEA has no resource measurement');
	// queue reconsider output carries the same view.
	const resources = join(f.dir, "resources.json");
	writeFileSync(resources, JSON.stringify(Object.fromEntries(samples)));
	const pass = await cli(f.path, "--resources", resources, "queue", "reconsider");
	expect(pass.exit).toBe(0);
	expect(pass.stdout).not.toContain("SECRET PROMPT");
	const listed = JSON.parse(pass.stdout) as any[];
	expect(listed.find((task) => task.id === stuck.id).placement).toMatchObject({ verdict: "unplaceable", summary: view.placement.summary });
	expect(listed.find((task) => task.id === waiting.id).placement.verdict).toBe("waiting");
	// Dashboard: separate count, structured blocking reasons, never the prompt.
	const state = getDashboardState(f.store);
	expect(state.summary.queuedTasks).toBe(2);
	expect(state.summary.unplaceableTasks).toBe(1);
	const projected = state.tasks.find((task) => task.id === stuck.id)!;
	expect(projected.placement).toMatchObject({ verdict: "unplaceable", blocking: [{ nodeId: "NODEB", structural: ["repo_unavailable"] }, { nodeId: "NODEA", structural: ["manual_node_mismatch"] }] });
	expect(state.tasks.find((task) => task.id === waiting.id)!.placement!.verdict).toBe("waiting");
	expect(JSON.stringify(state.tasks.map((task) => task.placement))).not.toContain("SECRET PROMPT");
	// Admitted tasks carry no record (an older tree's stale record is never shown).
	f.store.putNode(f.node("NODEB", { [REPO]: join(f.dir, "repo") }));
	f.store.reserve(stuck.id, { samples: fresh(["NODEB", "NODEA"]).samples });
	expect(getDashboardState(f.store).summary.unplaceableTasks).toBe(0);
	expect(JSON.parse((await cli(f.path, "show", stuck.id)).stdout).placement).toBeUndefined();
}, 60_000);

// ---- D. exit ---------------------------------------------------------------------------------------------------

test("queue withdraw: one command, archived, audited actor/reason, idempotent, no node contact; waiting tasks too", async () => {
	const f = fixture();
	const { samples } = production(f);
	const stuck = f.fleet.submit(f.input("stuck", { required: { nodeId: "NODEB" } }), { samples });
	const waiting = f.fleet.submit(f.input("waiting"), { samples: new Map() });
	const callsBefore = f.calls();
	const out = await cli(f.path, "queue", "withdraw", stuck.id, "--reason", "NODEB will never serve example-repo", "--actor", "ops-user");
	expect(out.stderr).toBe("");
	expect(out.exit).toBe(0);
	expect(out.stdout).not.toContain("SECRET PROMPT");
	const value = JSON.parse(out.stdout);
	expect(value).toMatchObject({ ok: true, outcome: "withdrawn", nodeContacted: false, withdrawal: { actor: "ops-user", reason: "NODEB will never serve example-repo" }, task: { id: stuck.id, phase: "archived", held: false } });
	const task = f.store.task(stuck.id)!;
	expect(task).toMatchObject({ phase: "archived", archivedFrom: { phase: "queued", reason: "no_eligible_node" }, archiveActor: "ops-user", withdrawal: { actor: "ops-user" } });
	expect(task.attemptId).toBeUndefined();
	expect(task.placement).toBeUndefined();
	const events = f.store.events(stuck.id).filter((event) => event.kind === "withdrawn");
	expect(events).toHaveLength(1);
	expect(events[0]!.data).toMatchObject({ actor: "ops-user", reason: "NODEB will never serve example-repo", archivedFrom: { phase: "queued" }, nodeContacted: false, placement: { verdict: "unplaceable" } });
	// Idempotent: a repeat writes nothing.
	const rows = f.store.events(stuck.id).length;
	const again = await cli(f.path, "queue", "withdraw", stuck.id, "--reason", "again");
	expect(again.exit).toBe(0);
	expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, outcome: "already_withdrawn", withdrawal: { actor: "ops-user" } });
	expect(f.store.events(stuck.id).length).toBe(rows);
	// A merely waiting task is withdrawable too (default actor).
	const other = await cli(f.path, "queue", "withdraw", waiting.id, "--reason", "not needed any more");
	expect(other.exit).toBe(0);
	expect(f.store.task(waiting.id)!.withdrawal).toMatchObject({ actor: "operator", reason: "not needed any more" });
	expect(f.calls()).toBe(callsBefore);
	// Terminal and known to the exit table: a repeated run of the same caller/key reports it (4), never re-admits.
	const run = await runTask(f.fleet, f.input("stuck", { required: { nodeId: "NODEB" } }), { sample: async () => samples });
	expect(run.code).toBe(4);
	expect(f.store.task(stuck.id)!.attemptId).toBeUndefined();
	expect(() => f.store.reserve(stuck.id, { samples })).toThrow("Archived tasks cannot be reserved");
	// Compact listing names the withdrawal; the dashboard no longer counts it as queued.
	expect((await cli(f.path, "--read-only", "tasks", "--compact")).stdout).toContain("withdrawn(operator,never-started)");
	expect(getDashboardState(f.store).summary).toMatchObject({ queuedTasks: 0, unplaceableTasks: 0 });
}, 60_000);

test("queue withdraw refusals: bounded reason, usage, a task with an attempt (WITHDRAW_ATTEMPTED, unchanged), unknown task", async () => {
	const f = fixture();
	const { samples } = production(f);
	const queued = f.fleet.submit(f.input("queued", { required: { nodeId: "NODEB" } }), { samples });
	expect(() => f.store.withdrawQueued(queued.id, "x".repeat(201), "operator")).toThrow(expect.objectContaining({ code: "WITHDRAW_INPUT" }));
	expect(() => f.store.withdrawQueued(queued.id, "ok", "y".repeat(201))).toThrow(expect.objectContaining({ code: "WITHDRAW_INPUT" }));
	expect(() => f.store.withdrawQueued(queued.id, "   ", "operator")).toThrow(expect.objectContaining({ code: "WITHDRAW_INPUT" }));
	expect(f.store.withdrawQueued(queued.id, "x".repeat(200), "y".repeat(200)).outcome).toBe("withdrawn");
	const usage = await cli(f.path, "queue", "withdraw", queued.id);
	expect(usage.exit).toBe(1);
	expect(usage.stderr).toContain("usage_queue_withdraw_ID_--reason_TEXT");
	const admitted = f.fleet.submit(f.input("admitted"), { samples });
	expect(admitted.attemptId).toBeTruthy();
	const before = f.store.task(admitted.id);
	const refused = await cli(f.path, "queue", "withdraw", admitted.id, "--reason", "too late");
	expect(refused.exit).toBe(1);
	expect(JSON.parse(refused.stderr)).toEqual({ ok: false, error: "WITHDRAW_ATTEMPTED" });
	expect(() => f.store.withdrawQueued(admitted.id, "too late", "operator")).toThrow(expect.objectContaining({ code: "WITHDRAW_ATTEMPTED" }));
	expect(f.store.task(admitted.id)).toEqual(before);
	// The refusal is recorded like every Store.transaction refusal, with its allowlisted diagnostic code.
	const refusal = f.store.events(admitted.id).filter((event) => event.kind === "refused").at(-1)!.data as any;
	expect(refusal).toMatchObject({ action: "withdraw", code: "WITHDRAW_ATTEMPTED", failureDiagnostic: { code: "fleet:withdraw_attempted" } });
	expect(() => f.store.withdrawQueued("00000000-0000-4000-8000-000000000000", "r", "operator")).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
}, 60_000);

test("withdraw is atomic against reserve on the real store, both orders, and in parallel processes", async () => {
	const f = fixture();
	const { samples } = production(f);
	const other = new FleetStore(f.path);
	cleanups.push(() => other.close());
	// withdraw, then reserve: never admitted.
	const a = f.fleet.submit(f.input("withdraw-first"), { samples: new Map() });
	f.store.withdrawQueued(a.id, "first", "operator");
	expect(other.reserveQueued(a.id, { samples })).toBeUndefined();
	expect(() => other.reserve(a.id, { samples })).toThrow(expect.objectContaining({ code: "ARCHIVED_TASK" }));
	expect(other.task(a.id)).toMatchObject({ phase: "archived", held: false });
	expect(other.task(a.id)!.attemptId).toBeUndefined();
	// reserve, then withdraw: refused, admission stands.
	const b = f.fleet.submit(f.input("reserve-first"), { samples: new Map() });
	expect(other.reserveQueued(b.id, fresh(["NODEA"]))!.attemptId).toBeTruthy();
	expect(() => f.store.withdrawQueued(b.id, "late", "operator")).toThrow(expect.objectContaining({ code: "WITHDRAW_ATTEMPTED" }));
	expect(f.store.task(b.id)).toMatchObject({ phase: "preparing", held: true });
	expect(f.store.task(b.id)!.withdrawal).toBeUndefined();
	// Truly concurrent: two processes race on fresh tasks; exactly one of them wins, never both.
	const script = join(f.dir, "race.ts");
	const samplesFile = join(f.dir, "samples.json");
	writeFileSync(script, `import { FleetStore } from ${JSON.stringify(join(root, "src/store.ts"))};
const [path, op, id, samplesFile] = process.argv.slice(2);
const store = new FleetStore(path);
try {
	if (op === "withdraw") { store.withdrawQueued(id, "race", "operator"); console.log(JSON.stringify({ won: true })); }
	else { const task = store.reserveQueued(id, { samples: new Map(JSON.parse(await Bun.file(samplesFile).text())) }); console.log(JSON.stringify({ won: !!task?.attemptId })); }
} catch (error) { console.log(JSON.stringify({ won: false, code: error.code })); }
finally { store.close(); }`);
	const child = async (op: string, id: string) => {
		const proc = Bun.spawn([process.execPath, script, f.path, op, id, samplesFile], { stdout: "pipe", stderr: "pipe" });
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		return JSON.parse(stdout) as { won: boolean; code?: string };
	};
	for (let round = 0; round < 4; round++) {
		const task = f.fleet.submit(f.input(`race-${round}`), { samples: new Map() });
		writeFileSync(samplesFile, JSON.stringify([...fresh(["NODEA"]).samples]));
		const [withdraw, reserve] = await Promise.all([child("withdraw", task.id), child("reserve", task.id)]);
		const final = f.store.task(task.id)!;
		expect(withdraw.won !== reserve.won).toBe(true);
		if (withdraw.won) expect([final.phase, final.attemptId, final.held]).toEqual(["archived", undefined, false]);
		else {
			expect(withdraw.code).toBe("WITHDRAW_ATTEMPTED");
			expect([final.phase, !!final.attemptId, final.withdrawal]).toEqual(["preparing", true, undefined]);
		}
	}
}, 120_000);

test("queue withdraw works while the daemon runs on the same database", async () => {
	const f = fixture();
	const { samples } = production(f);
	const queued = f.fleet.submit(f.input("daemon", { required: { nodeId: "NODEB" } }), { samples });
	const daemonStore = new FleetStore(f.path);
	cleanups.push(() => daemonStore.close());
	const daemon = new FleetDaemon(new Fleet(daemonStore), { cycleMs: 20, leaseMs: 4000, graceMs: 2000, sample: async () => ({ ok: false, at: Date.now(), error: "no_sample" }) } as any);
	daemon.acquire();
	const done = daemon.run();
	try {
		// Loaded hosts: the daemon's first status write can outlast a fixed short sleep; poll for it instead.
		const statusDeadline = Date.now() + 10_000;
		while (f.store.daemonStatus() === undefined && Date.now() < statusDeadline) await Bun.sleep(25);
		expect(f.store.daemonStatus()).toBeDefined();
		const out = await cli(f.path, "queue", "withdraw", queued.id, "--reason", "withdrawn under the daemon");
		expect(out.stderr).toBe("");
		expect(out.exit).toBe(0);
		expect(JSON.parse(out.stdout).outcome).toBe("withdrawn");
		await Bun.sleep(100);
	} finally {
		daemon.stop();
		await done;
	}
	expect(f.store.task(queued.id)).toMatchObject({ phase: "archived", withdrawal: { reason: "withdrawn under the daemon" } });
}, 60_000);

// ---- older tree -------------------------------------------------------------------------------------------------

const baseTree = process.env.FLEET_BASE_TREE ? resolve(process.env.FLEET_BASE_TREE) : undefined;
test.skipIf(!baseTree)("an older tree reads a database carrying the placement and withdrawal fields (FLEET_BASE_TREE)", async () => {
	const f = fixture();
	const { samples } = production(f);
	const stuck = f.fleet.submit(f.input("stuck", { required: { nodeId: "NODEB" } }), { samples });
	const gone = f.fleet.submit(f.input("gone"), { samples: new Map() });
	f.store.withdrawQueued(gone.id, "older tree check", "operator");
	f.store.close();
	const old = async (...args: string[]) => {
		const child = Bun.spawn([process.execPath, join(baseTree!, "src/cli.ts"), "--db", f.path, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { stdout, stderr, exit };
	};
	const shown = await old("--read-only", "show", stuck.id);
	expect(shown.stderr).toBe("");
	expect(shown.exit).toBe(0);
	expect(JSON.parse(shown.stdout)).toMatchObject({ id: stuck.id, phase: "queued", reason: "no_eligible_node" });
	const listed = await old("--read-only", "tasks");
	expect(listed.exit).toBe(0);
	expect((JSON.parse(listed.stdout) as any[]).map((task) => [task.id, task.phase]).sort()).toEqual([[stuck.id, "queued"], [gone.id, "archived"]].sort());
	expect((await old("--read-only", "tasks", "--compact")).exit).toBe(0);
	// The older tree still re-selects the task (its own audit behaviour) without failing on the unknown field.
	const resources = join(f.dir, "resources.json");
	writeFileSync(resources, JSON.stringify(Object.fromEntries(samples)));
	const pass = await old("--resources", resources, "queue", "reconsider");
	expect(pass.exit).toBe(0);
	const db = new Database(f.path, { readonly: true });
	try {
		expect(JSON.parse((db.query("SELECT data FROM tasks WHERE id=?").get(stuck.id) as any).data).placement.verdict).toBe("unplaceable");
	} finally { db.close(); }
}, 60_000);
