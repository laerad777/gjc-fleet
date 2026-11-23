// Shared fixture for the node-health tests: real child Coordinator, workspace helper and Broker-list
// stand-ins, a real FleetStore file, and a history with an injected clock on the same DB.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeHealthHistory, type HealthProbe } from "../../src/node-health";
import type { NodeHealthAccess } from "../../src/node-health-gate";
import { FleetStore } from "../../src/store";
import type { NodeConfig, TaskInput } from "../../src/contracts";
import type { ResourceSample } from "../../src/admission";
import { repositoryFixture } from "./coordinator";

export const good: HealthProbe = { reachable: true, brokerSessionListOk: true, resourceSampleOk: true, latencyMs: 1 };
export const bad: HealthProbe = { ...good, reachable: false };
export const approval = { operator: "ops", reason: "node-health test" };
export const helper = fileURLToPath(new URL("../../src/placement-preflight.ts", import.meta.url));
export const coordinator = fileURLToPath(new URL("./coordinator.ts", import.meta.url));
export const brokerList = fileURLToPath(new URL("./broker-list.ts", import.meta.url));
export const cliPath = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** Closed and removed by `cleanup()` (call it from afterEach). */
const open: { close(): void }[] = [];
const dirs: string[] = [];
export function track<T extends { close(): void }>(value: T) { open.push(value); return value; }
export async function cleanup() {
	const { rmSync } = await import("node:fs");
	for (const value of open.splice(0).reverse()) { try { value.close(); } catch { /* already closed */ } }
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A history with one injected clock for wall and monotonic time (a single honest writer). */
export function clocked(path: string, start = 1_800_000_000_000) {
	const clock = { now: start };
	const h = track(new NodeHealthHistory(path, {}, { clock: () => clock.now, monotonic: () => clock.now }));
	return { h, clock };
}
/** Stable by three probes of `h` 30 s apart on its own clock. */
export function makeStable(h: NodeHealthHistory, clock: { now: number }, ids: string[]) {
	for (let i = 0; i < 3; i++) { clock.now += 30_000; for (const id of ids) h.record(id, good); }
}
/**
 * Access for decisions with the switch on. With `resources`, fresh samples are "measured" after the
 * decision probes and each one is stamped on receipt, as the CLI does.
 */
export function access(h: NodeHealthHistory, resources?: { samples: ReadonlyMap<string, ResourceSample> }): NodeHealthAccess {
	return {
		history: () => h,
		...(resources ? { sample: async (stamp: (id: string, sample: ResourceSample) => void) => { for (const [id, sample] of resources.samples) stamp(id, sample); return resources.samples; } } : {}),
	};
}
/** Access that fails the test if anything opens a history (switch-off paths must not). */
export function forbiddenAccess(): NodeHealthAccess & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		history: () => { calls.push("history"); throw new Error("history_opened_with_switch_off"); },
		sample: async () => { calls.push("sample"); throw new Error("health_sample_with_switch_off"); },
	};
}

export async function fleetFixture(prefix = "fleet-nh-") {
	const repo = await repositoryFixture(prefix);
	dirs.push(repo.dir);
	const input: TaskInput = { schemaVersion: 1, key: "automatic", caller: "node-health", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	async function node(id: string, changes: Partial<NodeConfig> & { broker?: string | null } = {}) {
		const { broker = "ok", ...rest } = changes;
		const state = join(repo.dir, id + "-coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const config = join(repo.dir, id + ".json");
		const value: NodeConfig = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces-" + id), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] }, ...(broker === null ? {} : { sdkTransport: { command: process.execPath, args: [brokerList, broker] } }), ...rest };
		await writeFile(config, JSON.stringify(value));
		return JSON.parse(JSON.stringify(value)) as NodeConfig;
	}
	const path = join(repo.dir, "fleet.sqlite");
	const store = track(new FleetStore(path));
	return { ...repo, input, node, store, path };
}
export const selectionAudit = (store: FleetStore, id: string) => store.events(id).filter(e => e.kind === "selection").at(-1)!.data as any;

export async function runCli(path: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, cliPath, "--db", path, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, exit };
}
