// P1/P2 of integration review ce9c36ad, re-established on production main 6b95dde through the real
// code paths: real FleetStore (SQLite), real Fleet, real src/node.ts behind a recording shim, the
// controlled coordinator fixture behind a switchable wrapper. Git fixtures live under the OS temp
// directory. Nothing here reads production source text.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { observationDigest } from "../src/core";
import { authorizeInput, previewInput } from "../src/inputs";
import { reconsiderQueue } from "../src/index";
import { runTask } from "../src/operator-commands";

const MARKER = "PRIVATE_SOURCE_MARKER_7f3a";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const nodeTs = resolve(import.meta.dir, "../src/node.ts");
const coordinatorTs = resolve(import.meta.dir, "fixtures/coordinator.ts");

async function caught(p: Promise<unknown>): Promise<any> {
	try {
		await p;
	} catch (error) {
		return error;
	}
	throw new Error("expected rejection");
}

function codeOf(fn: () => unknown): string | undefined {
	try {
		fn();
	} catch (error: any) {
		return error?.code;
	}
	return undefined;
}

/** One node "node" whose workspace helper and Coordinator transport record every request they receive. */
async function sendFixture(prefix: string, options: { submit?: boolean } = {}) {
	const f = await repositoryFixture(prefix);
	cleanups.push(() => rm(f.dir, { recursive: true, force: true }));
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const down = join(f.dir, "coordinator-down");
	const coordinator = join(f.dir, "coordinator-wrapper.ts");
	await writeFile(coordinator, `import {existsSync,appendFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(f.dir, "connects"))},'connect\\n');
if(existsSync(${JSON.stringify(down)}))process.exit(1);
const child=Bun.spawn([process.execPath,${JSON.stringify(coordinatorTs)},${JSON.stringify(state)}],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;`);
	const node: any = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot, maxConcurrency: 1, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [coordinator] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const log = join(f.dir, "helper-requests");
	const refuse = join(f.dir, "refuse-prepare");
	const shim = join(f.dir, "helper.ts");
	// Records action and whether the request carried source bytes, then forwards to the real helper.
	// With the refuse-prepare flag the next prepare is answered as a typed proven before_send refusal.
	await writeFile(shim, `import {appendFileSync,existsSync,rmSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';try{action=String(JSON.parse(input).action)}catch{}
appendFileSync(${JSON.stringify(log)},JSON.stringify({action,source:input.includes(${JSON.stringify(MARKER)})||input.includes('contentBase64')})+'\\n');
if(action==='prepare'&&existsSync(${JSON.stringify(refuse)})){rmSync(${JSON.stringify(refuse)});process.stdout.write(JSON.stringify({ok:false,error:'root_denied',detail:'allowlist',certainty:'before_send'}));process.exit(1);}
const child=Bun.spawn([process.execPath,${JSON.stringify(nodeTs)},${JSON.stringify(config)}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;`);
	const full = { ...node, workspaceTransport: { command: process.execPath, args: [shim] } };
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	store.putNode(full);
	await writeFile(join(f.repo, "selected.txt"), MARKER + "\n");
	const preview = await previewInput({ repo: f.repo, repoId: "repo", baseCommit: f.baseCommit, paths: ["selected.txt"], includeObjects: true });
	const input = {
		schemaVersion: 1 as const, key: prefix, caller: "preflight-claim", repoId: "repo", baseCommit: f.baseCommit,
		prompt: "PROMPT_" + MARKER, required: {}, inputPackage: authorizeInput(preview, preview.digest, "local-only-authorization"),
	};
	const resources = headroom(["node"], 4);
	resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
	let task: any;
	if (options.submit !== false) {
		task = store.submit(input);
		store.reserve(task.id, resources);
		task = store.task(task.id)!;
		expect(task.attemptId).toBeDefined();
	}
	const requests = async (): Promise<{ action: string; source: boolean }[]> =>
		existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const calls = async (): Promise<string[]> => (JSON.parse(await readFile(state, "utf8")).calls as any[]).map((c) => c.name);
	return {
		...f, store, node: full, input, resources, task, shim, config, coordinator, requests, calls,
		refuseNextPrepare: () => writeFile(refuse, "1"),
		coordinatorDown: (value: boolean) => (value ? writeFile(down, "1") : rm(down, { force: true })),
		events: (kind: string) => store.events(task.id).filter((e: any) => e.kind === kind),
	};
}

// ---------------------------------------------------------------------------------------------
// P1: no source byte, archive, prompt or secret reaches a node that is not admissible at send time
// ---------------------------------------------------------------------------------------------

test("P1 fixed: readiness preflight and queue reconsideration never probe or send to a disabled node", async () => {
	const f = await sendFixture("p1-queue", { submit: false });
	f.store.setNodeState("node", { enabled: false });
	const queued = f.store.submit(f.input);
	expect(f.store.task(queued.id)!.attemptId).toBeUndefined();
	const pass = await reconsiderQueue(new Fleet(f.store), async () => f.resources.samples);
	expect(pass.map((t) => [t.id, t.phase, t.attemptId, t.reason])).toEqual([[queued.id, "queued", undefined, "no_eligible_node"]]);
	expect(f.store.task(queued.id)!.attemptId).toBeUndefined();
	expect(await f.requests()).toEqual([]);
	expect(existsSync(join(f.dir, "connects"))).toBe(false);
}, 60_000);

for (const state of [{ enabled: false }, { draining: true }] as const)
	test(`P1: a node made ${Object.keys(state)[0] === "enabled" ? "disabled" : "draining"} after admission receives no source bytes, session or prompt from start; restoring it starts once`, async () => {
		const f = await sendFixture("p1-start-" + Object.keys(state)[0]);
		f.store.setNodeState("node", state);
		const refused = await caught(new Fleet(f.store).start(f.task.id));
		expect(refused.code).toBe("NODE_NOT_ADMISSIBLE");
		expect(await f.requests()).toEqual([]);
		expect(existsSync(join(f.dir, "connects"))).toBe(false);
		// Nothing was claimed and nothing is unknown: the reservation stays held and retryable.
		expect(f.store.getOperation(f.task.id, "prepare")).toBeUndefined();
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "preparing", held: true, attemptId: f.task.attemptId });
		expect(f.events("refused").map((e: any) => e.data.code)).toContain("NODE_NOT_ADMISSIBLE");
		f.store.setNodeState("node", { enabled: true, draining: false });
		const started = await new Fleet(f.store).start(f.task.id);
		expect(started.phase).toBe("active");
		expect((await f.requests()).map((r) => r.action)).toEqual(["prepare"]);
		expect(await f.calls()).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
	}, 60_000);

test("P1: retry after a proven refusal sends no preflight (which carries the source package) to a draining node", async () => {
	const f = await sendFixture("p1-preflight");
	await f.refuseNextPrepare();
	const first = await caught(new Fleet(f.store).start(f.task.id));
	expect(first.code).toBe("node_refused:root_denied:allowlist");
	expect(await f.requests()).toEqual([{ action: "prepare", source: true }]);
	f.store.setNodeState("node", { draining: true });
	const refused = await caught(new Fleet(f.store).start(f.task.id));
	expect(refused.code).toBe("NODE_NOT_ADMISSIBLE");
	expect(await f.requests()).toEqual([{ action: "prepare", source: true }]);
	// The retained refusal is untouched and still re-evaluable once the node is active again.
	expect(f.store.retainedPreparationRefusal(f.task.id)).toBeDefined();
	f.store.setNodeState("node", { draining: false });
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare", "preflight", "prepare"]);
	expect(await f.calls()).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
}, 60_000);

test("P1: a node disabled while its workspace is prepared receives no session or prompt; re-enabling continues without replay", async () => {
	const f = await sendFixture("p1-prompt");
	const fleet = new Fleet(f.store);
	const node = (fleet as any).node.bind(fleet);
	(fleet as any).node = async (task: unknown, request: any) => {
		const value = await node(task, request);
		if (request.action === "prepare") f.store.setNodeState("node", { enabled: false });
		return value;
	};
	const refused = await caught(fleet.start(f.task.id));
	expect(refused.code).toBe("NODE_NOT_ADMISSIBLE");
	// At most the read-only Coordinator handshake happened; no session creation and no prompt.
	expect(await f.calls()).toEqual([]);
	expect(f.store.getOperation(f.task.id, "create")).toBeUndefined();
	const held = f.store.task(f.task.id)!;
	expect(held.workspace).toBeDefined();
	expect(held.sessionId).toBeUndefined();
	expect(held).toMatchObject({ held: true, attemptId: f.task.attemptId });
	expect(held.phase).not.toBe("blocked_unknown");
	f.store.setNodeState("node", { enabled: true });
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare"]);
	expect(await f.calls()).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
}, 60_000);

test("P1: a node whose registered route was replaced after admission is not sent to through the stale snapshot", async () => {
	const f = await sendFixture("p1-route");
	const other = join(f.dir, "other-helper.ts");
	await writeFile(other, "process.exit(1)");
	f.store.putNode({ ...f.node, workspaceTransport: { command: process.execPath, args: [other] } });
	const refused = await caught(new Fleet(f.store).start(f.task.id));
	expect(refused.code).toBe("NODE_NOT_ADMISSIBLE");
	expect(await f.requests()).toEqual([]);
	expect(f.store.getOperation(f.task.id, "prepare")).toBeUndefined();
	f.store.putNode(f.node);
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
}, 60_000);

test("P1: an operator run against a node drained after reservation reports not_started and sends nothing", async () => {
	const f = await sendFixture("p1-run");
	f.store.setNodeState("node", { draining: true });
	const out = await runTask(new Fleet(f.store), f.input, { sample: async () => f.resources.samples });
	expect(out.task.id).toBe(f.task.id);
	expect(out.code).toBe(9);
	expect(await f.requests()).toEqual([]);
	f.store.setNodeState("node", { draining: false });
	const again = await runTask(new Fleet(f.store), f.input, { sample: async () => f.resources.samples });
	expect(again.task.phase).toBe("active");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare"]);
}, 60_000);

test("P1: the store refuses a send claim for an inactive node atomically, whatever the caller checked before", async () => {
	const f = await sendFixture("p1-claim");
	f.store.setNodeState("node", { enabled: false });
	for (const kind of ["prepare", "create", "approval-attach", "prompt"])
		expect(codeOf(() => f.store.claimOperation(f.task.id, kind, { kind }))).toBe("NODE_NOT_ADMISSIBLE");
	expect(f.store.getOperation(f.task.id, "prepare")).toBeUndefined();
	// Not a send of new work: the operator-run start lease and post-execution claims are not gated here.
	expect(f.store.claimOperation(f.task.id, "operator-run", { run: 1 })).toBeDefined();
}, 60_000);

// ---------------------------------------------------------------------------------------------
// P2: no durable claim stays behind when the precondition it depends on fails before the send
// ---------------------------------------------------------------------------------------------

async function settledFixture(prefix: string) {
	const f = await sendFixture(prefix, { submit: false });
	const local = { ...f.node };
	delete local.workspaceTransport;
	f.store.putNode(local);
	const fleet = new Fleet(f.store, { localNodeId: "node" });
	const { inputPackage: _ignored, ...plain } = f.input;
	const task = await fleet.start(fleet.submit({ ...plain, key: prefix + "-plain" }).id);
	const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { injected: "not provider settlement proof" } };
	f.store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
	const counter = join(f.dir, "verifier-count");
	const argv = [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},'once\\n');console.log('ok')`];
	const path = (task.workspace as any).path as string;
	return {
		...f, fleet, task, argv, counter,
		hideWorkspace: () => rename(path, path + ".away"),
		restoreWorkspace: () => rename(path + ".away", path),
	};
}

test("P2: a transiently missing workspace path does not leave the verify-test claim; the repaired path verifies once", async () => {
	const f = await settledFixture("p2-verify");
	await f.hideWorkspace();
	const refused = await caught(f.fleet.result(f.task.id, f.argv));
	expect(refused.code).toBe("node_refused:workspace_missing:workspace");
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeUndefined();
	expect(existsSync(f.counter)).toBe(false);
	expect(f.store.events(f.task.id).filter((e: any) => e.kind === "operation_claim_released").map((e: any) => e.data.kind)).toEqual(["verify-test"]);
	await f.restoreWorkspace();
	const result = await f.fleet.result(f.task.id, f.argv);
	expect(result.status).toBe("verified");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	expect(await f.fleet.result(f.task.id, f.argv)).toEqual(result);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
}, 60_000);

test("P2: a transiently missing workspace path does not consume the once-only result-test upgrade claim", async () => {
	const f = await settledFixture("p2-upgrade");
	const original = await f.fleet.result(f.task.id);
	expect(original.status).toBe("not_run");
	await f.hideWorkspace();
	const refused = await caught(f.fleet.result(f.task.id, f.argv));
	expect(refused.code).toBe("node_refused:workspace_missing:workspace");
	expect(f.store.getOperation(f.task.id, "result-test")).toBeUndefined();
	await f.restoreWorkspace();
	expect((await f.fleet.result(f.task.id, f.argv)).status).toBe("verified");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
}, 60_000);

test("P2: a verifier whose outcome is unknown still stays quarantined (never re-run)", async () => {
	const f = await settledFixture("p2-unknown");
	const node = (f.fleet as any).node.bind(f.fleet);
	(f.fleet as any).node = async (task: unknown, request: any) => {
		const value = await node(task, request);
		if (request.action === "test") throw Error("lost verifier reply");
		return value;
	};
	await expect(f.fleet.result(f.task.id, f.argv)).rejects.toThrow("lost verifier reply");
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeDefined();
	await expect(new Fleet(f.store, { localNodeId: "node" }).result(f.task.id, f.argv)).rejects.toThrow("TEST_UNKNOWN");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
}, 60_000);

test("P2 class: a Coordinator that is transiently unreachable does not leave the stop claim; the repaired transport stops once", async () => {
	const f = await settledFixture("p2-stop");
	await f.coordinatorDown(true);
	await expect(f.fleet.stop(f.task.id)).rejects.toThrow();
	expect(f.store.getOperation(f.task.id, "stop")).toBeUndefined();
	await f.coordinatorDown(false);
	expect(await f.fleet.stop(f.task.id)).toMatchObject({ ok: true, stopped: true });
	expect((await f.calls()).filter((c) => c === "gjc_coordinator_stop_session")).toHaveLength(1);
	await expect(f.fleet.stop(f.task.id)).rejects.toThrow("Stop was already requested");
}, 60_000);

// ---------------------------------------------------------------------------------------------
// States the fixes must not change, and ordering of overlapping callers
// ---------------------------------------------------------------------------------------------

test("P1 statechart: an uncertain prepare claim on a now-disabled node is still fenced blocked_unknown, never re-sent", async () => {
	const f = await sendFixture("p1-uncertain");
	f.store.claimOperation(f.task.id, "prepare", { attempt: f.task.attemptId! });
	f.store.setNodeState("node", { enabled: false });
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("blocked_unknown");
	expect(await f.requests()).toEqual([]);
}, 60_000);

test("P1 statechart: an active execution on a draining node is still observed and its result collected", async () => {
	const f = await sendFixture("p1-active");
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
	f.store.setNodeState("node", { draining: true });
	// start of an already-prompted task sends nothing new and is not refused.
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
	const body = { sessionId: f.store.task(f.task.id)!.sessionId!, turnId: f.store.task(f.task.id)!.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { injected: "not provider settlement proof" } };
	f.store.observe(f.task.id, { ...body, eventId: "settled", digest: observationDigest(body) });
	expect((await new Fleet(f.store).result(f.task.id)).status).toBe("not_run");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare", "collect"]);
}, 60_000);

test("P1 concurrency: overlapping starts against a disabled node both refuse; neither claims nor sends", async () => {
	const f = await sendFixture("p1-overlap");
	f.store.setNodeState("node", { enabled: false });
	const outcomes = await Promise.all([1, 2, 3].map(() => caught(new Fleet(f.store).start(f.task.id))));
	expect(outcomes.map((e) => e.code)).toEqual(["NODE_NOT_ADMISSIBLE", "NODE_NOT_ADMISSIBLE", "NODE_NOT_ADMISSIBLE"]);
	expect(f.store.getOperation(f.task.id, "prepare")).toBeUndefined();
	expect(await f.requests()).toEqual([]);
	f.store.setNodeState("node", { enabled: true });
	const started = await Promise.all([1, 2].map(() => new Fleet(f.store).start(f.task.id).catch((e) => e)));
	// The base no-replay rule still decides the race; exactly one prepare reached the node.
	expect((await f.requests()).filter((r) => r.action === "prepare")).toHaveLength(1);
	expect(started.some((t: any) => t.phase === "active" || t.phase === "blocked_unknown")).toBe(true);
}, 60_000);

test("P2 ordering: a release is exact-claim only, idempotent, and never touches a newer claim or a receipted one", async () => {
	const f = await settledFixture("p2-order");
	const first = f.store.claimOperation(f.task.id, "verify-test", { argv: f.argv })!;
	expect(f.store.releaseUnsentClaim(f.task.id, "verify-test", first.id)).toBe(true);
	expect(f.store.releaseUnsentClaim(f.task.id, "verify-test", first.id)).toBe(false);
	const second = f.store.claimOperation(f.task.id, "verify-test", { argv: f.argv })!;
	expect(second.id).not.toBe(first.id);
	expect(f.store.releaseUnsentClaim(f.task.id, "verify-test", first.id)).toBe(false);
	expect(f.store.getOperation(f.task.id, "verify-test")?.id).toBe(second.id);
	for (const kind of ["prepare", "create", "prompt", "stop", "cancel", "operator-run", "answer:q"])
		expect(codeOf(() => f.store.releaseUnsentClaim(f.task.id, kind, second.id))).toBe("RESERVED_OPERATION");
	const stop = f.store.claimOperation(f.task.id, "stop", { session_id: f.task.sessionId! })!;
	expect(codeOf(() => f.store.releaseUnsentClaim(f.task.id, "stop", stop.id))).toBe("RESERVED_OPERATION");
	f.store.recordOperationReceipt(f.task.id, "verify-test", second.id, { late: true });
	expect(codeOf(() => f.store.releaseUnsentClaim(f.task.id, "verify-test", second.id))).toBe("OPERATION_BINDING");
	expect(f.store.getOperation(f.task.id, "verify-test")?.id).toBe(second.id);
}, 60_000);

test("P2 concurrency: overlapping verifier calls during a transient path failure never run it twice and recover without surgery", async () => {
	const f = await settledFixture("p2-overlap");
	await f.hideWorkspace();
	const outcomes = await Promise.all([1, 2, 3].map(() => caught(f.fleet.result(f.task.id, f.argv))));
	for (const e of outcomes) expect(String(e.code ?? e.message)).toMatch(/^(node_refused:workspace_missing:workspace|TEST_UNKNOWN)/);
	expect(f.store.getOperation(f.task.id, "verify-test")).toBeUndefined();
	await f.restoreWorkspace();
	const results = await Promise.all([1, 2, 3].map(() => f.fleet.result(f.task.id, f.argv).catch((e) => e)));
	expect(results.filter((r: any) => r.status === "verified").length).toBeGreaterThanOrEqual(1);
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
	expect((await f.fleet.result(f.task.id, f.argv)).status).toBe("verified");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
}, 60_000);

// ---------------------------------------------------------------------------------------------
// Review ceb10389 F1/F2
// ---------------------------------------------------------------------------------------------

test("F1: a node edit that adds an unrelated repository root and an sdkTransport after reservation does not refuse the task; its own root change does", async () => {
	const f = await sendFixture("f1-unrelated");
	const elsewhere = join(f.dir, "elsewhere");
	const sdk = join(f.dir, "sdk.ts");
	await writeFile(sdk, "process.exit(1)");
	f.store.putNode({ ...f.node, roots: { ...f.node.roots, other: elsewhere }, sdkTransport: { command: process.execPath, args: [sdk] } });
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("active");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare"]);
	expect(await f.calls()).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
	// The task's own repository root is part of its route: a change there still refuses, sending nothing.
	const next = await sendFixture("f1-own-root");
	next.store.putNode({ ...next.node, roots: { repo: elsewhere } });
	expect((await caught(new Fleet(next.store).start(next.task.id))).code).toBe("NODE_NOT_ADMISSIBLE");
	expect(await next.requests()).toEqual([]);
	expect(next.store.getOperation(next.task.id, "prepare")).toBeUndefined();
}, 60_000);

test("F1 persisted: a database holding a reservation made before an unrelated node edit starts after reopening", async () => {
	const f = await sendFixture("f1-persisted");
	f.store.putNode({ ...f.node, roots: { ...f.node.roots, other: join(f.dir, "elsewhere") } });
	f.store.close();
	const reopened = new FleetStore(join(f.dir, "fleet.sqlite"));
	cleanups.push(() => reopened.close());
	expect((await new Fleet(reopened).start(f.task.id)).phase).toBe("active");
	expect((await f.requests()).map((r) => r.action)).toEqual(["prepare"]);
	expect(await f.calls()).toEqual(["gjc_coordinator_start_session", "gjc_coordinator_send_prompt"]);
}, 60_000);

test("F2: a result-test whose verifier ran with an unknown outcome keeps its claim and is never re-run", async () => {
	const f = await settledFixture("f2-result-test");
	expect((await f.fleet.result(f.task.id)).status).toBe("not_run");
	// The verifier runs, then exceeds the node's output limit: its outcome is unknown, not before_send.
	const argv = [process.execPath, "--eval", `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(f.counter)},'once\\n');process.stdout.write('x'.repeat(4194305))`];
	const lost = await caught(f.fleet.result(f.task.id, argv));
	expect(String(lost.code ?? lost.message)).toContain("output_limit");
	expect(f.store.getOperation(f.task.id, "result-test")).toBeDefined();
	expect(f.store.events(f.task.id).filter((e: any) => e.kind === "operation_claim_released")).toEqual([]);
	expect((await caught(new Fleet(f.store, { localNodeId: "node" }).result(f.task.id, argv))).code).toBe("TEST_UNKNOWN");
	expect(await readFile(f.counter, "utf8")).toBe("once\n");
}, 60_000);
