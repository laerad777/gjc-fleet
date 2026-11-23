import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { digest, observationDigest, selectNode, validateTaskInput } from "../src/core";
import { Fleet } from "../src/fleet";
import { headroom } from "./admission-fixture";
import type { ApprovalDiscovery, ApprovalSessionContext, NativeWorkflowQuestion, TaskApprovalBackend } from "../src/approval";
import { previewInput, authorizeInput } from "../src/inputs";
import { FleetStore } from "../src/store";
import {
	repositoryFixture,
	type ControlledState,
} from "./fixtures/coordinator";

// All Coordinator assertions below are CONTROLLED contract/mock evidence, not live GJC proof.
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const coordinatorPath = fileURLToPath(
	new URL("./fixtures/coordinator.ts", import.meta.url),
);
const directories: string[] = [];
const stores = new Set<FleetStore>();
function open(path: string) {
	const store = new FleetStore(path, 2);
	stores.add(store);
	return store;
}
function close(store: FleetStore) {
	store.close();
	stores.delete(store);
}
async function fixture() {
	const repo = await repositoryFixture("fleet-operator-owned-");
	directories.push(repo.dir);
	const statePath = join(repo.dir, "controlled-state.json");
	await writeFile(
		statePath,
		JSON.stringify({ calls: [] } satisfies ControlledState),
	);
	const db = join(repo.dir, "fleet.sqlite");
	const node: NodeConfig = {
		id: "alpha",
		os: process.platform,
		arch: process.arch,
		roots: { repo: repo.repo },
		workspaceRoot: repo.workspaceRoot,
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: ["controlled-model"],
		transport: {
			command: process.execPath,
			args: [coordinatorPath, statePath],
		},
		operations: ["read", "write"],
	};
	const input: TaskInput = {
		schemaVersion: 1,
		key: "request",
		caller: "controlled-operator",
		repoId: "repo",
		baseCommit: repo.baseCommit,
		prompt: "CONTROLLED prompt, never sent to a real GJC",
		required: {
			os: process.platform,
			arch: process.arch,
			model: "controlled-model",
			operations: ["write"],
		},
	};
	const helperConfig = join(repo.dir, "workspace-node.json");
	node.workspaceTransport = { command: process.execPath, args: [fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url)), helperConfig] };
	await writeFile(helperConfig, JSON.stringify(node));
	const state = async (): Promise<ControlledState> =>
		JSON.parse(await readFile(statePath, "utf8"));
	async function update(patch: Partial<ControlledState>) {
		await writeFile(
			statePath,
			JSON.stringify({ ...(await state()), ...patch }),
		);
	}
	function setup() {
		const store = open(db);
		const { workspaceTransport, ...localNode } = node;
		store.putNode(localNode);
		return { store, fleet: new Fleet(store, { localNodeId: node.id }) };
	}
	return { ...repo, db, node, input, state, update, setup };
}
/** CLI submit uses recorded samples so tests never depend on this machine's live load. */
async function cli(db: string, ...args: string[]) {
	const resources = join(dirname(db), "admission-samples.json");
	if (args[0] === "submit" && !(await Bun.file(resources).exists()))
		await writeFile(resources, JSON.stringify(Object.fromEntries(headroom(["alpha", "beta"], 1).samples)));
	const child = Bun.spawn(
		[process.execPath, cliPath, "--db", db, "--cap", "2", ...(args[0] === "submit" ? ["--resources", resources] : []), ...args],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}
function calls(state: ControlledState, suffix: string) {
	return state.calls.filter(
		(call) => call.name === "gjc_coordinator_" + suffix,
	);
}
afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("cancellation interleavings (T0341 A1, B3, D2)", () => {
	async function ownedFixture(
		abortMode = "stopped",
		closeMode = "closed",
		ephemeral = true,
	) {
		const f = await fixture();
		const proxy = join(f.dir, "owned-coordinator.ts");
		await writeFile(
			proxy,
			`
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
const child = Bun.spawn([process.execPath, ${JSON.stringify(coordinatorPath)}, ${JSON.stringify(join(f.dir, "controlled-state.json"))}], {stdin:"pipe",stdout:"pipe",stderr:"inherit"});
process.on("SIGTERM", () => { child.kill(); process.exit(0); });
process.on("exit", () => child.kill());
const requests = new Map();
createInterface({input:process.stdin}).on("line", line => { const request=JSON.parse(line); requests.set(request.id, request); child.stdin.write(line+"\\n"); });
for await (const line of createInterface({input:Readable.fromWeb(child.stdout)})) {
 const response=JSON.parse(line); const request=requests.get(response.id);
 if(request?.params?.name && response.result?.structuredContent) {
  const value=response.result.structuredContent;
  if(request.params.name === "gjc_coordinator_start_session" && value.session) value.session.ephemeral=${ephemeral};
 }
 console.log(JSON.stringify(response));
}
`,
		);
		const log = join(f.dir, "abort-calls.jsonl");
		const closeLog = join(f.dir, "close-calls.jsonl");
		const authorityLog = join(f.dir, "authority-calls.jsonl");
		const authorityState = join(f.dir, "authority-state.json");
		await writeFile(
			authorityState,
			JSON.stringify({ generation: 7, incarnation: "a".repeat(64) }),
		);
		const sdk = join(f.dir, "owned-sdk.ts");
		await writeFile(
			sdk,
			`
import { appendFileSync, readFileSync } from "node:fs";
const argv=process.argv.slice(2),input=await Bun.stdin.text();
if(argv.includes("session.list")) {
 const state=JSON.parse(readFileSync(${JSON.stringify(join(f.dir, "controlled-state.json"))},"utf8"));
 const authority=JSON.parse(readFileSync(${JSON.stringify(authorityState)},"utf8"));
 appendFileSync(${JSON.stringify(authorityLog)},JSON.stringify({argv,input,prompted:state.calls.some(c=>c.name==="gjc_coordinator_send_prompt")})+"\\n");
 console.log(JSON.stringify({type:"broker_response",ok:true,result:{indexSeq:1,sessions:authority.absent ? [] : [{sessionId:JSON.parse(input).resolveSessionId,locator:{cwd:state.session.cwd},endpointGeneration:authority.generation,endpointIncarnation:authority.incarnation,live:true,ambiguous:false,terminalUncertain:false,terminal:false}]}}));
 process.exit(0);
}
if(argv.includes("session.close")) {
 appendFileSync(${JSON.stringify(closeLog)},JSON.stringify({argv,input,autostart:process.env.GJC_SDK_BROKER_AUTOSTART})+"\\n");
 const mode=${JSON.stringify(closeMode)};
 if(mode==="slow") await Bun.sleep(33000);
 if(mode==="lost") process.exit(0);
 if(mode==="refused") {
  console.error("CONTROLLED_PRIVATE_STDERR_CANARY");
  console.log(JSON.stringify({ok:false,operation:"session.close",error:{code:"close_failed",message:"unavailable"}})); process.exit(1);
 }
 const result={sessionId:mode==="wrong-session" ? "unrelated-session" : JSON.parse(input).sessionId};
 console.log(JSON.stringify(mode==="coordinator" ? {ok:true,closed:true,session_id:JSON.parse(input).sessionId} :
  {ok:true,operation:"session.close",result:mode==="accepted" ? {accepted:true} : mode==="nested" ? {nested:result} : result}));
 process.exit(0);
}
if(argv.includes("query")) {
 console.log(JSON.stringify({type:"query_response",ok:true,result:{...JSON.parse(input),status:"in_flight",receiptState:"pending"}}));
 process.exit(0);
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv,input,autostart:process.env.GJC_SDK_BROKER_AUTOSTART})+"\\n");
if(${JSON.stringify(abortMode)} === "lost") process.exit(0);
if(${JSON.stringify(abortMode)} === "slow") await Bun.sleep(12000);
const proof=${JSON.stringify(abortMode)} === "no_active_turn" ? {ok:true,selection:"owned",turn:"no_active_turn",terminal:"terminal_no_effect"} : {ok:true,selection:"owned",turn:${JSON.stringify(abortMode === "nested" || abortMode === "slow" ? "stopped" : abortMode)},ownedWork:"stopped",automaticDelivery:"none",resumeOnOwnedCompletion:false};
console.log(JSON.stringify({ok:true,result:${JSON.stringify(abortMode)} === "nested" ? {nested:proof} : proof}));
`,
		);
		const { store, fleet } = f.setup();
		store.putNode({
			...f.node,
			transport: { command: process.execPath, args: [proxy] },
			sdkTransport: { command: process.execPath, args: [sdk] },
		});
		return { ...f, store, fleet, log, closeLog, authorityLog, authorityState };
	}

	const released = (f: any, id: string) => f.store.events(id).filter((e: any) => e.kind === "released").length;
	const kinds = (f: any, id: string) => f.store.events(id).map((e: any) => e.kind).filter((k: string) => ["released", "cancel_unknown", "unknown_reconciled", "observation"].includes(k));
	const slots = (f: any) => (f.store.observability() as any).gauges.reserved_slots as number;
	const terminalBody = (task: any) => ({ sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const, terminal: true, evidence: { command: "native", outcome: "completed" } });
	const log = (name: string, v: unknown) => console.log(`[T0341-fix] ${name}: ${JSON.stringify(v)}`);

	test("A1 a duplicate cancel while this process is still settling the first is refused CANCEL_PENDING, not cancel_unknown", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const claim = f.store.claimCancellationClose.bind(f.store);
		let second: Promise<any> | undefined;
		let midPhase: string | undefined;
		f.store.claimCancellationClose = (id: string, r: any) => {
			const op = claim(id, r);
			second = f.fleet.cancel(id).then((v) => ({ value: v }), (e: any) => ({ code: e?.code }));
			midPhase = f.store.task(id)!.phase;
			return op;
		};
		const first: any = await f.fleet.cancel(task.id);
		const dup: any = await second;
		const final = f.store.task(task.id)!;
		log("A1", { first: { ok: first.ok, phase: first.task?.phase }, dup, midPhase, final: { phase: final.phase, held: final.held }, released: released(f, task.id), events: kinds(f, task.id) });
		expect(dup?.code).toBe("CANCEL_PENDING");
		expect(midPhase).toBe("active");
		expect(kinds(f, task.id).filter((k: string) => k === "cancel_unknown")).toHaveLength(0);
		expect(first.ok).toBe(true);
		expect(final).toMatchObject({ phase: "cancelled", held: false });
		expect(released(f, task.id)).toBe(1);
		expect(slots(f)).toBe(0);
	}, 30000);

	test("A1 without proof that a cancel is in flight (a later call) the held reservation is kept as before", async () => {
		const f = await ownedFixture("stopped", "lost");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const r: any = await f.fleet.cancel(task.id);
		const again: any = await f.fleet.cancel(task.id);
		const final = f.store.task(task.id)!;
		log("A1-unproven", { ok: r.ok, againOk: again.ok, phase: final.phase, held: final.held, reason: final.reason });
		expect(again.ok).toBe(false);
		expect(final).toMatchObject({ phase: "cancel_unknown", held: true });
		expect(released(f, task.id)).toBe(0);
		expect((await readFile(f.closeLog, "utf8")).trim().split("\n")).toHaveLength(1);
	}, 60000);

	test("B3 dispatch disabled after the abort reply records cancel_unknown at once and sends no close", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const retain = f.store.retainCancellationReply.bind(f.store);
		f.store.retainCancellationReply = (id: string, stage: any, reply: any) => { retain(id, stage, reply); if (stage === "abort") f.store.enterRollback(); };
		let thrown: any;
		try { await f.fleet.cancel(task.id); } catch (e: any) { thrown = e?.code ?? String(e); }
		const mid = f.store.task(task.id)!;
		log("B3", { thrown, phase: mid.phase, held: mid.held, reason: mid.reason, events: kinds(f, task.id) });
		expect(thrown).toBe("DISPATCH_DISABLED");
		expect(mid.phase).toBe("cancel_unknown");
		expect(mid.held).toBe(true);
		expect(mid.reason).toBe("cancel_transport_failure:close:before_send:dispatch_disabled");
		expect(kinds(f, task.id).filter((k: string) => k === "cancel_unknown")).toHaveLength(1);
		expect(f.store.getOperation(task.id, "cancel-close")).toBeUndefined();
		expect(await Bun.file(f.closeLog).exists()).toBe(false);
		expect(released(f, task.id)).toBe(0);
	}, 30000);

	test("B3 dispatch disabled before admission records nothing", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		f.store.enterRollback();
		let thrown: any;
		try { await f.fleet.cancel(task.id); } catch (e: any) { thrown = e?.code; }
		const t = f.store.task(task.id)!;
		expect(thrown).toBe("DISPATCH_DISABLED");
		expect(f.store.getOperation(task.id, "cancel")).toBeUndefined();
		expect(t.phase).toBe("active");
		expect(kinds(f, task.id).filter((k: string) => k === "cancel_unknown")).toHaveLength(0);
		expect(await Bun.file(f.log).exists()).toBe(false);
	}, 30000);

	test("D2 natural completion of the same turn before the abort reply: exact close, released exactly once", async () => {
		const f = await ownedFixture("no_active_turn", "closed");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const retain = f.store.retainCancellationReply.bind(f.store);
		f.store.retainCancellationReply = (id: string, stage: any, reply: any) => { if (stage === "abort") { const b = terminalBody(task); f.store.observe(id, { ...b, eventId: "native-before-abort", digest: observationDigest(b) } as any); } retain(id, stage, reply); };
		const r: any = await f.fleet.cancel(task.id);
		const final = f.store.task(task.id)!;
		log("D2", { ok: r.ok, phase: final.phase, held: final.held, reason: final.reason, status: final.result?.status, released: released(f, task.id), slots: slots(f) });
		expect(r.ok).toBe(true);
		expect(final.result).toMatchObject({ status: "completed_unverified", executionTerminal: true });
		expect(final.held).toBe(false);
		expect(released(f, task.id)).toBe(1);
		expect(slots(f)).toBe(0);
		expect((await readFile(f.closeLog, "utf8")).trim().split("\n")).toHaveLength(1);
		expect(r.abort.result).toEqual({ ok: true, selection: "owned", turn: "no_active_turn", terminal: "terminal_no_effect" });
		const again: any = await f.fleet.cancel(task.id);
		expect(again.ok).toBe(true);
		expect(released(f, task.id)).toBe(1);
		expect(slots(f)).toBe(0);
	}, 30000);

	test("D2 a real no_active_turn abort reply without native terminal evidence stays held (no release)", async () => {
		const f = await ownedFixture("no_active_turn", "closed");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const r: any = await f.fleet.cancel(task.id);
		const final = f.store.task(task.id)!;
		log("D2-no-evidence", { ok: r.ok, phase: final.phase, held: final.held, reason: final.reason });
		expect(r.ok).toBe(false);
		expect(final).toMatchObject({ phase: "cancel_unknown", held: true });
		expect(released(f, task.id)).toBe(0);
		expect(await Bun.file(f.closeLog).exists()).toBe(false);
	}, 30000);

	test("D2 a non-SDK turn value (completed) is refused even with native terminal evidence", async () => {
		const f = await ownedFixture("completed", "closed");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const retain = f.store.retainCancellationReply.bind(f.store);
		f.store.retainCancellationReply = (id: string, stage: any, reply: any) => { if (stage === "abort") { const b = terminalBody(task); f.store.observe(id, { ...b, eventId: "native-before-abort", digest: observationDigest(b) } as any); } retain(id, stage, reply); };
		const r: any = await f.fleet.cancel(task.id);
		const final = f.store.task(task.id)!;
		expect(r.ok).toBe(false);
		expect(final.held).toBe(true);
		expect(released(f, task.id)).toBe(0);
		expect(await Bun.file(f.closeLog).exists()).toBe(false);
	}, 30000);
});
