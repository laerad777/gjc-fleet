// Behavior tests for the two LOW findings of independent review 5d0cecbc (refusal re-evaluation).
// LOW-1: a typed-refusal helper without `preflight` is a protocol mismatch (unavailable), not the old cause.
// LOW-2: a held attempt whose retained refusal was not cleared records why it waits.
// All Git fixtures live under the OS temp directory.
import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const nodeTs = resolve(import.meta.dir, "../src/node.ts");

/** Helper shim: records each action; `mode` selects an emulated reply, otherwise forwards to node.ts. */
async function fixture(key: string) {
	const f = await repositoryFixture("refusal-low-fixes-");
	dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const node: any = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot, maxConcurrency: 1, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [resolve(import.meta.dir, "fixtures/coordinator.ts"), state] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const counter = join(f.dir, "dispatches");
	const mode = join(f.dir, "mode");
	const shim = join(f.dir, "helper.ts");
	// The typed invalid_request envelope is exactly what the earlier-patch helper answers to an
	// action outside its whitelist (prepare/test/collect).
	const typedInvalid = JSON.stringify({ ok: false, error: "invalid_request", detail: "request", certainty: "before_send" });
	await writeFile(
		shim,
		`import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';try{action=String(JSON.parse(input).action)}catch{}
appendFileSync(${JSON.stringify(counter)},action+'\\n');
const mode=existsSync(${JSON.stringify(mode)})?readFileSync(${JSON.stringify(mode)},'utf8'):'';
if(mode==='unavailable'&&action==='preflight')process.exit(3);
if((mode==='typed-no-preflight'&&action==='preflight')||mode==='invalid-all'){console.log(${JSON.stringify(typedInvalid)});process.exit(1);}
const child=Bun.spawn([process.execPath,${JSON.stringify(nodeTs)},${JSON.stringify(config)}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;`,
	);
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	store.putNode({ ...node, workspaceTransport: { command: process.execPath, args: [shim] } });
	const t = store.submit({ schemaVersion: 1, key, caller: "low-fixes", repoId: "repo", baseCommit: f.baseCommit, prompt: "low fixes", required: {} });
	const resources = headroom(["node"], 1);
	resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
	store.reserve(t.id, resources);
	return {
		...f, store, task: store.task(t.id)!,
		setMode: (value: string) => writeFile(mode, value),
		dispatches: async () => (await Bun.file(counter).exists()) ? (await readFile(counter, "utf8")).trim().split("\n") : [],
		events: (kind: string) => store.events(t.id).filter(e => e.kind === kind),
	};
}
async function caught(p: Promise<unknown>): Promise<any> {
	try { await p; } catch (error) { return error; }
	throw new Error("expected rejection");
}

test("LOW-1: typed-refusal helper without preflight is unavailable, not still_refused; upgrade clears it", async () => {
	const f = await fixture("low1");
	try {
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		const first = await caught(new Fleet(f.store).start(f.task.id));
		expect(first.code).toBe("node_refused:root_denied:allowlist");
		const refused = f.store.getOperation(f.task.id, "prepare")!;
		// Cause fixed, but the helper does not know `preflight` and refuses it as invalid_request.
		await f.git("config", "--remove-section", "filter.fleet-refusal");
		await f.setMode("typed-no-preflight");
		for (let i = 0; i < 2; i++)
			expect((await caught(new Fleet(f.store).start(f.task.id))).code).toBe("node_refused:invalid_request:request");
		expect(await f.dispatches()).toEqual(["prepare", "preflight", "preflight"]);
		expect(f.events("preparation_reevaluation").map(e => e.data)).toMatchObject([
			{ operationId: refused.id, outcome: "unavailable", code: "node_refused:invalid_request:request" },
			{ operationId: refused.id, outcome: "unavailable", code: "node_refused:invalid_request:request" },
		]);
		// Only the original refusal is audited as a node operation failure; the mismatch names no cause.
		expect(f.events("node_operation_failure").map(e => (e.data as any).code)).toEqual(["node_refused:root_denied:allowlist"]);
		expect(f.store.task(f.task.id)).toMatchObject({
			attemptId: f.task.attemptId, held: true, phase: "dispatching", reason: "preparation_refusal_retained:unavailable",
		});
		expect(f.store.getOperation(f.task.id, "prepare")).toEqual(refused);
		expect(f.events("unknown")).toHaveLength(0);
		// Helper upgraded: the next start re-evaluates, clears the refusal and prepares a fresh attempt.
		await f.setMode("");
		const started = await new Fleet(f.store).start(f.task.id);
		expect(started.attemptId).not.toBe(f.task.attemptId);
		expect(started.workspace).toMatchObject({ attemptId: started.attemptId });
		expect(started.reason).toBeUndefined();
		expect(await f.dispatches()).toEqual(["prepare", "preflight", "preflight", "preflight", "prepare"]);
	} finally {
		f.store.close();
	}
}, 30000);

test("LOW-1: a retained invalid_request refusal answered invalid_request by preflight stays still_refused", async () => {
	const f = await fixture("low1-genuine");
	try {
		await f.setMode("invalid-all");
		const first = await caught(new Fleet(f.store).start(f.task.id));
		expect(first.code).toBe("node_refused:invalid_request:request");
		expect(f.store.getOperation(f.task.id, "prepare")!.receipt).toMatchObject({ nodeRefusal: { error: "invalid_request", certainty: "before_send" } });
		expect((await caught(new Fleet(f.store).start(f.task.id))).code).toBe(first.code);
		expect(f.events("preparation_reevaluation").map(e => (e.data as any).outcome)).toEqual(["still_refused"]);
		expect(f.events("node_operation_failure").map(e => (e.data as any).code)).toEqual([first.code, first.code]);
		expect(f.store.task(f.task.id)).toMatchObject({ held: true, reason: "preparation_refusal_retained:still_refused" });
		expect(await f.dispatches()).toEqual(["prepare", "preflight"]);
	} finally {
		f.store.close();
	}
}, 30000);

test("LOW-2: a held retained refusal records why it waits, tracks the latest outcome, and clears on renewal", async () => {
	const f = await fixture("low2");
	try {
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		await caught(new Fleet(f.store).start(f.task.id));
		await caught(new Fleet(f.store).start(f.task.id));
		expect(f.store.task(f.task.id)?.reason).toBe("preparation_refusal_retained:still_refused");
		await f.git("config", "--remove-section", "filter.fleet-refusal");
		await f.setMode("unavailable");
		expect((await caught(new Fleet(f.store).start(f.task.id))).code).toBe("node_transport_failed");
		expect(f.store.task(f.task.id)).toMatchObject({
			attemptId: f.task.attemptId, held: true, phase: "dispatching", reason: "preparation_refusal_retained:unavailable",
		});
		expect(f.events("unknown")).toHaveLength(0);
		await f.setMode("");
		const started = await new Fleet(f.store).start(f.task.id);
		expect(started.workspace).toBeDefined();
		expect(started.reason).toBeUndefined();
	} finally {
		f.store.close();
	}
}, 30000);

test("LOW-2: re-evaluation never overwrites another reason or touches a task that is not held", async () => {
	const f = await fixture("low2-guard");
	try {
		const submitted = f.store.submit({ ...f.task.input, key: "low2-queued" });
		f.store.reserve(submitted.id, { samples: new Map() });
		const queued = f.store.task(submitted.id)!;
		expect(queued).toMatchObject({ phase: "queued", reason: "no_eligible_node" });
		f.store.recordPreparationReevaluation(queued.id, "operation", "unavailable", "node_transport_failed");
		expect(f.store.task(queued.id)).toEqual(queued);
		expect(f.store.events(queued.id).filter(e => e.kind === "preparation_reevaluation")).toHaveLength(1);
	} finally {
		f.store.close();
	}
}, 30000);
