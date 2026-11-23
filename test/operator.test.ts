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

describe("operator CLI and atomic admission", () => {
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
const proof={ok:true,selection:"owned",turn:${JSON.stringify(abortMode === "nested" ? "stopped" : abortMode)},ownedWork:"stopped",automaticDelivery:"none",resumeOnOwnedCompletion:false};
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
	async function uiFixture() {
		const f = await ownedFixture();
		const attached: ApprovalSessionContext[] = [];
		const sent: unknown[] = [];
		const bound: string[] = [];
		let closed = 0;
		let complete = true;
		let corrupt = false;
		let consumed = false;
		let rejectAnswer = false;
		let loseSend = false;
		let discoveryError: Error | undefined;
		let question: NativeWorkflowQuestion;
		const backend: TaskApprovalBackend = {
			contract: "sdk-ui-waiter-v1",
			async attach(context, key) {
				expect(calls(await f.state(), "send_prompt")).toHaveLength(0);
				expect(f.store.getOperation(context.taskId, "prompt")).toBeUndefined();
				expect(f.store.getOperation(context.taskId, "approval-attach")!.key).toBe(key);
				attached.push(context);
				const authority = { kind: "sdk_ui_waiter" as const, requestId: "native-request", connectionId: "native-connection", leaseId: "native-lease", attachmentAuthorityId: "original-attachment", endpointGeneration: context.sessionAuthority.endpointGeneration };
				const form = { title: "Review", questions: [{ id: "decision", question: "Approve?", options: [{ label: "Approve" }, { label: "Reject" }] }] };
				const workflow = { stage: "ralplan" as const, kind: "approval" as const, toolCallId: "native-ask-call", questionId: "native-question", evidence: { toolName: "Ask", arguments: { workflowGate: { stage: "ralplan", kind: "approval" } } } };
				question = { questionId: "native-question", authority, form, workflow, status: "pending", answerBinding: digest({ context, authority, form, workflow, questionId: "native-question" }) };
				return {
					context, receipt: { registered: true, requestKey: key },
					bindTurn(turn) { bound.push(turn); },
					async discover(): Promise<ApprovalDiscovery> { if (discoveryError) throw discoveryError; return { contract: context.contract, sessionId: context.sessionId, complete, questions: consumed ? [] : [{ ...question, answerBinding: corrupt ? "stale" : question.answerBinding }], consumed: consumed ? [{ questionId: question.questionId, authority, toolCallId: workflow.toolCallId, evidence: { type: "tool_end", toolCallId: workflow.toolCallId } }] : [], evidence: { coverage: "controlled original UI" } }; },
					validateAnswer(_question, answer) { if (rejectAnswer || (answer as any)?.decision !== "Approve") throw new Error("invalid native answer"); },
					async answer(row, answer, operationKey) { sent.push({ row, answer, operationKey }); if (loseSend) throw new Error("original native send unknown"); return { contract: context.contract, questionId: row.questionId, authority: row.authority, delivery: "sent_unconfirmed", consumption: "unproven" }; },
					async close() { closed++; },
				};
			},
		};
		const fleet = new Fleet(f.store, { approvalBackends: [backend], localNodeId: f.node.id });
		const input = { ...f.input, approvalContract: "sdk-ui-waiter-v1" as const };
		return { ...f, fleet, input, attached, sent, bound, get question() { return question; }, setComplete(value: boolean) { complete = value; }, setCorrupt() { corrupt = true; }, setConsumed() { consumed = true; }, loseSend() { loseSend = true; }, failDiscovery(error: Error) { discoveryError = error; }, rejectAnswer() { rejectAnswer = true; }, get closed() { return closed; } };
	}
	test("UI selection is explicit, digest-bound and missing backends reject before effects", async () => {
		const f = await uiFixture();
		expect(() => validateTaskInput(f.input)).not.toThrow();
		for (const approvalContract of ["", "coordinator", null, 1, {}, "sdk-ui-waiter-v2"]) {
			expect(() => validateTaskInput({ ...f.input, approvalContract })).toThrow("Unknown approval contract");
		}
		expect(() => validateTaskInput({ ...f.input, unknownApproval: true })).toThrow("Unexpected field");
		const { approvalContract, ...ordinaryInput } = f.input;
		expect(digest(f.input)).not.toBe(digest(ordinaryInput));
		const noBackend = new Fleet(f.store);
		expect(() => noBackend.submit(f.input)).toThrow("Explicit approval backend");
		expect(() => f.fleet.submit({ ...f.input, approvalContract: "unknown" } as any)).toThrow("Unknown approval contract");
		expect(await f.state()).toEqual({ calls: [] });
		const reserved = f.fleet.submit(f.input);
		await expect(noBackend.start(reserved.id)).rejects.toThrow("Explicit approval backend");
		expect(f.store.getOperation(reserved.id, "prepare")).toBeUndefined();
		expect(await f.state()).toEqual({ calls: [] });
	});
	test("UI registers once before prompt with original context and retains original claim receipt", async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		expect(task.phase).toBe("active");
		expect(f.attached).toHaveLength(1);
		expect<unknown>(f.attached[0]).toEqual({ contract: f.input.approvalContract, taskId: task.id, attemptId: task.attemptId, nodeId: task.nodeId, inputDigest: task.inputDigest, sessionId: task.sessionId, workspacePath: (task.workspace as any).path, createOperationId: f.store.getOperation(task.id, "create")!.id, sessionAuthority: { sessionId: task.sessionId, cwd: (task.workspace as any).path, endpointGeneration: 7, endpointIncarnation: "a".repeat(64) } });
		expect(f.bound).toEqual([task.turnId!]);
		const op = f.store.getOperation(task.id, "approval-attach")!;
		expect(op.receipt).toEqual({ registered: true, requestKey: op.key });
		expect(op.digest).toBe(digest(op.payload));
		expect(() => f.store.recordOperationReceipt(task.id, op.kind, op.id, { changed: true })).toThrow("immutable");
		await f.fleet.start(task.id);
		expect(f.attached).toHaveLength(1);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(1);
		await f.fleet.close();
		expect(f.closed).toBe(1);
		expect((await f.fleet.start(task.id)).held).toBe(true);
		expect(f.attached).toHaveLength(1);
	});
	test("claimed UI registration without live original channel never prompts or reattaches", async () => {
		const f = await ownedFixture();
		let attaches = 0;
		const backend: TaskApprovalBackend = { contract: "sdk-ui-waiter-v1", async attach() { attaches++; throw new Error("registration unknown"); } };
		const fleet = new Fleet(f.store, { approvalBackends: [backend], localNodeId: f.node.id });
		const task = await fleet.start(fleet.submit({ ...f.input, approvalContract: backend.contract }).id);
		expect(task).toMatchObject({ phase: "blocked_unknown", held: true });
		expect(f.store.getOperation(task.id, "approval-attach")).toBeDefined();
		expect(f.store.getOperation(task.id, "prompt")).toBeUndefined();
		await fleet.start(task.id);
		await new Fleet(f.store, { approvalBackends: [backend] }).start(task.id);
		expect(attaches).toBe(1);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(0);
	});
	test("UI exact CAS and caller turn validation precede once-only native answer; sent is not consumed", async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const snapshot = await f.fleet.inspect(task.id);
		expect(snapshot.task.phase).toBe("approval_required");
		const discovery = snapshot.questions as ApprovalDiscovery;
		expect(discovery.questions[0]).not.toHaveProperty("turn_id");
		expect(discovery.questions[0]).not.toHaveProperty("C");
		expect(discovery.questions[0]).not.toHaveProperty("T");
		expect(calls(await f.state(), "list_questions")).toHaveLength(0);
		const request = { contract: f.input.approvalContract, sessionId: task.sessionId!, expectedTurnId: task.turnId!, questionId: f.question.questionId, answerBinding: f.question.answerBinding, answer: { decision: "Approve" } };
		for (const patch of [{ contract: undefined }, { sessionId: "wrong" }, { expectedTurnId: "wrong" }, { questionId: "wrong" }, { answerBinding: "wrong" }, { answer: { decision: "invalid" } }]) {
			await expect(f.fleet.answer(task.id, { ...request, ...patch })).rejects.toThrow();
			expect(f.store.getOperation(task.id, "answer:" + request.questionId)).toBeUndefined();
		}
		expect(await f.fleet.answer(task.id, request)).toMatchObject({ delivery: "sent_unconfirmed", consumption: "unproven" });
		expect(f.sent).toHaveLength(1);
		for (const answer of [request.answer, { decision: "Reject" }]) await expect(f.fleet.answer(task.id, { ...request, answer })).rejects.toThrow();
		expect(f.sent).toHaveLength(1);
		expect((await f.fleet.inspect(task.id)).questions).toMatchObject({ consumed: [] });
		expect(f.store.task(task.id)!.result?.executionTerminal).not.toBe(true);
		f.setConsumed();
		expect((await f.fleet.inspect(task.id)).questions).toMatchObject({ consumed: [{ toolCallId: "native-ask-call", evidence: { type: "tool_end" } }] });
		expect(f.store.task(task.id)!.held).toBe(true);
		expect(calls(await f.state(), "submit_question_answer")).toHaveLength(0);
		await f.fleet.close();
	});
	test("unknown UI answer retains original native error and durable claim without resend", async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		await f.fleet.inspect(task.id);
		f.loseSend();
		const request = { contract: f.input.approvalContract, sessionId: task.sessionId!, expectedTurnId: task.turnId!, questionId: f.question.questionId, answerBinding: f.question.answerBinding, answer: { decision: "Approve" } };
		await expect(f.fleet.answer(task.id, request)).rejects.toThrow("original native send unknown");
		expect(f.store.task(task.id)).toMatchObject({ phase: "blocked_unknown", held: true });
		expect(f.store.getOperation(task.id, "answer:" + request.questionId)).toBeDefined();
		await expect(f.fleet.answer(task.id, request)).rejects.toThrow();
		expect(f.sent).toHaveLength(1);
		await f.fleet.close();
	});
	test("UI answer discovery failure keeps its error, marks unknown before any claim and records a discovery diagnostic", async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		expect((await f.fleet.inspect(task.id)).task.phase).toBe("approval_required");
		const secret = "discovery failed for alice@build01 C:\\Users\\alice\\.ssh\\id_rsa token=ghp_ABCDEFGHIJKLMNOP";
		f.failDiscovery(new Error(secret));
		const request = { contract: f.input.approvalContract, sessionId: task.sessionId!, expectedTurnId: task.turnId!, questionId: f.question.questionId, answerBinding: f.question.answerBinding, answer: { decision: "Approve" } };
		await expect(f.fleet.answer(task.id, request)).rejects.toThrow(secret);
		expect(f.store.task(task.id)).toMatchObject({ phase: "blocked_unknown", held: true, reason: "approval_discovery_unknown_original_attempt_held" });
		expect(f.store.getOperation(task.id, "answer:" + request.questionId)).toBeUndefined();
		expect(f.sent).toHaveLength(0);
		const event = f.store.events(task.id).findLast((e) => e.kind === "unknown")!;
		expect(event.data).toMatchObject({ reason: "approval_discovery_unknown_original_attempt_held" });
		expect(event.data).not.toHaveProperty("failure");
		// diagnostic-assertions-begin
		expect((event.data as any).failureDiagnostic).toEqual({
			version: 1,
			use: "diagnostic_only_not_evidence",
			source: "Fleet.answer.discovery",
			phase: "call",
			errorClass: "Error",
			code: "unclassified",
			message: "Unclassified failure; no code recorded",
		});
		for (const leak of ["alice", "build01", "id_rsa", "ghp_", "discovery failed", String(secret.length)]) expect(JSON.stringify((event.data as any).failureDiagnostic)).not.toContain(leak);
		for (const leak of ["alice", "build01", "id_rsa", "ghp_", "discovery failed"]) expect(JSON.stringify(event)).not.toContain(leak);
		// diagnostic-assertions-end
		await f.fleet.close();
	});
	for (const mode of ["incomplete", "corrupt", "lost"] as const) test(`UI ${mode} discovery remains unknown and held`, async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		if (mode === "incomplete") f.setComplete(false);
		if (mode === "corrupt") f.setCorrupt();
		if (mode === "lost") await f.fleet.close();
		const snapshot = await f.fleet.inspect(task.id);
		expect(snapshot.task.phase).toBe("blocked_unknown");
		expect(snapshot.task.held).toBe(true);
		expect(f.attached).toHaveLength(1);
		expect(f.sent).toHaveLength(0);
		await f.fleet.close();
	});
	for (const mode of ["incomplete", "corrupt", "lost"] as const) test(`tolerant inspect: UI ${mode} discovery ${mode === "incomplete" ? "is an unavailable read; nothing marked" : "is a binding fault fenced like strict"}`, async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		if (mode === "incomplete") f.setComplete(false);
		if (mode === "corrupt") f.setCorrupt();
		if (mode === "lost") await f.fleet.close();
		if (mode === "incomplete") {
			await expect(f.fleet.inspect(task.id, { tolerateReadFailure: true })).rejects.toMatchObject({ code: "OBSERVATION_UNAVAILABLE" });
			expect(f.store.task(task.id)).toMatchObject({ phase: "active", held: true });
			expect(f.store.events(task.id).map(e => e.kind)).toContain("abandoned_poll");
		} else {
			const snapshot = await f.fleet.inspect(task.id, { tolerateReadFailure: true });
			expect(snapshot.task).toMatchObject({ phase: "blocked_unknown", held: true, reason: "observation_unavailable_original_attempt_held" });
			expect(f.store.events(task.id).map(e => e.kind)).not.toContain("abandoned_poll");
		}
		expect(f.store.events(task.id).filter(e => e.kind === "unknown")).toHaveLength(mode === "incomplete" ? 0 : 1);
		expect(f.attached).toHaveLength(1);
		expect(f.sent).toHaveLength(0);
		await f.fleet.close();
	});
	test("registered UI backend never replaces the unselected Coordinator route", async () => {
		const f = await uiFixture();
		const { approvalContract, ...input } = f.input;
		const task = await f.fleet.start(f.fleet.submit(input).id);
		await f.update({ questions: "bound" });
		expect((await f.fleet.inspect(task.id)).task.phase).toBe("approval_required");
		expect(f.attached).toHaveLength(0);
		expect(calls(await f.state(), "list_questions")).toHaveLength(1);
	});
	test("rollback and read-only prevent UI effects while original receipt remains immutable", async () => {
		const f = await uiFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		await f.fleet.inspect(task.id);
		const op = f.store.getOperation(task.id, "approval-attach")!;
		const receipt = op.receipt!;
		f.store.enterRollback();
		expect(f.store.recordOperationReceipt(task.id, op.kind, op.id, receipt)).toEqual(op);
		expect(f.store.getOperation(task.id, op.kind)).toEqual(op);
		await expect(f.fleet.answer(task.id, { contract: f.input.approvalContract, sessionId: task.sessionId!, expectedTurnId: task.turnId!, questionId: f.question.questionId, answerBinding: f.question.answerBinding, answer: { decision: "Approve" } })).rejects.toThrow();
		expect(f.sent).toHaveLength(0);
		await expect(f.fleet.start(task.id)).rejects.toThrow();
		expect(f.attached).toHaveLength(1);
		await f.fleet.close();
		close(f.store);
		const readonly = new FleetStore(f.db, 2, { readOnly: true });
		try {
			expect(() => readonly.recordOperationReceipt(task.id, op.kind, op.id, receipt)).toThrow("read-only");
			const readonlyFleet = new Fleet(readonly);
			await expect(readonlyFleet.answer(task.id, { questionId: "never", answerBinding: "never", answer: {} })).rejects.toThrow();
		} finally { readonly.close(); }
	});
	test("original authority is reserved, bound and immutable before prompt", async () => {
		const f = await ownedFixture();
		const record = f.store.recordSessionAuthority.bind(f.store);
		let captured = false;
		f.store.recordSessionAuthority = (id, authority) => {
			const task = f.store.task(id)!;
			expect(task.sessionId).toBe(authority.sessionId);
			expect(task.turnId).toBeUndefined();
			expect(f.store.getOperation(id, "prompt")).toBeUndefined();
			expect(() =>
				f.store.claimOperation(id, "prompt", {
					session_id: authority.sessionId,
				}),
			).toThrow("Original session authority");
			for (const invalid of [
				{ ...authority, cwd: authority.cwd + "-wrong" },
				{ ...authority, sessionId: "unrelated" },
				{ ...authority, endpointGeneration: 0 },
				{ ...authority, endpointGeneration: Number.MAX_SAFE_INTEGER + 1 },
				{ ...authority, endpointIncarnation: "not-an-incarnation" },
			]) {
				expect(() => record(id, invalid)).toThrow(
					"before any prompt intent or turn",
				);
			}
			for (const kind of ["session-authority", "session-ownership"]) {
				expect(() => f.store.claimOperation(id, kind, {})).toThrow(
					"transactional admission",
				);
				expect(() => f.store.beginOperation(id, kind, {})).toThrow(
					"transactional admission",
				);
			}
			const receipt = record(id, authority);
			expect(record(id, authority)).toEqual(receipt);
			expect(() =>
				record(id, {
					...authority,
					endpointGeneration: authority.endpointGeneration + 1,
				}),
			).toThrow("immutable");
			expect((receipt.payload as any).ownershipOperationId).toBe(
				f.store.getOperation(id, "session-ownership")!.id,
			);
			captured = true;
			return receipt;
		};
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		expect(captured).toBe(true);
		expect(task.phase).toBe("active");
		expect(() =>
			record(
				task.id,
				f.store.getOperation(task.id, "session-authority")!.payload as any,
			),
		).toThrow("before any prompt intent or turn");
	});
	test("failed initial authority read keeps confirmed session and never prompts or replays create", async () => {
		const f = await ownedFixture();
		await writeFile(f.authorityState, JSON.stringify({ absent: true }));
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		expect(task).toMatchObject({
			sessionId: "controlled-session",
			held: true,
			phase: "blocked_unknown",
		});
		expect(f.store.getOperation(task.id, "session-ownership")).toBeDefined();
		expect(f.store.getOperation(task.id, "session-authority")).toBeUndefined();
		expect(f.store.getOperation(task.id, "prompt")).toBeUndefined();
		await f.fleet.start(task.id);
		expect(calls(await f.state(), "start_session")).toHaveLength(1);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(0);
	});
	for (const authority of [
		{ absent: true },
		{ generation: 8, incarnation: "a".repeat(64) },
		{ generation: 7, incarnation: "b".repeat(64) },
	]) {
		test(`missing or changed fresh authority refuses before intent: ${JSON.stringify(authority)}`, async () => {
			const f = await ownedFixture();
			const task = await f.fleet.start(f.fleet.submit(f.input).id);
			const original = f.store.getOperation(task.id, "session-authority");
			await writeFile(f.authorityState, JSON.stringify(authority));
			await expect(f.fleet.cancel(task.id)).rejects.toThrow();
			expect(f.store.getOperation(task.id, "cancel")).toBeUndefined();
			expect(f.store.getOperation(task.id, "session-authority")).toEqual(
				original,
			);
			expect(await Bun.file(f.log).exists()).toBe(false);
		});
	}
	test("restart captures authority only for pre-prompt new owners; historical routes are never retrofitted", async () => {
		for (const historical of [false, true]) {
			const f = await ownedFixture();
			let prePrompt: any;
			const record = f.store.recordSession.bind(f.store);
			f.store.recordSession = (...args) => {
				const task = record(...args);
				prePrompt = structuredClone(task);
				return task;
			};
			const active = await f.fleet.start(f.fleet.submit(f.input).id);
			// Only this controlled temporary store is rewound to a crash boundary.
			const owner = f.store.getOperation(active.id, "session-ownership")!;
			if (historical) delete (owner.payload as any).retirementRoute;
			owner.digest = digest(owner.payload);
			close(f.store);
			const db = new Database(f.db);
			try {
				db.query("UPDATE tasks SET data=? WHERE id=?").run(
					JSON.stringify(prePrompt),
					active.id,
				);
				db.query(
					"DELETE FROM operations WHERE task_id=? AND kind IN ('prompt','session-authority')",
				).run(active.id);
				db.query("UPDATE operations SET data=? WHERE id=?").run(
					JSON.stringify(owner),
					owner.id,
				);
			} finally {
				db.close();
			}
			const store = open(f.db),
				fleet = new Fleet(store);
			const restarted = await fleet.start(active.id);
			expect(restarted.turnId).toBe(active.turnId);
			expect(Boolean(store.getOperation(active.id, "session-authority"))).toBe(
				!historical,
			);
			if (historical)
				await expect(fleet.cancel(active.id)).rejects.toThrow(
					"Fresh exclusive ephemeral ownership",
				);
			expect(calls(await f.state(), "start_session")).toHaveLength(1);
		}
	});
	test("inspection-to-admission mutation race refuses before abort", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const inspect = f.fleet.inspect.bind(f.fleet);
		f.fleet.inspect = async (id) => {
			const snapshot = await inspect(id);
			f.store.claimOperation(id, "answer:racing", { answer: true });
			return snapshot;
		};
		await expect(f.fleet.cancel(task.id)).rejects.toThrow(
			"Existing answer consumption",
		);
		expect(f.store.getOperation(task.id, "cancel")).toBeUndefined();
		expect(await Bun.file(f.log).exists()).toBe(false);
	});
	test("controlled new-owned cancellation proves exact close and releases once; workspace and sentinel remain", async () => {
		const f = await ownedFixture();
		const sentinel = join(f.dir, "unrelated-sentinel");
		await writeFile(sentinel, "do not touch");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const workspaceMarker = join(
			(task.workspace as any).path,
			"cancel-preservation-marker",
		);
		await writeFile(workspaceMarker, "workspace preserved");
		const result: any = await f.fleet.cancel(task.id);
		expect(result).toMatchObject({
			ok: true,
			task: {
				phase: "cancelled",
				held: false,
				sessionId: task.sessionId,
				attemptId: task.attemptId,
				turnId: task.turnId,
				result: { executionTerminal: true },
			},
		});
		expect(result.close).toEqual({
			ok: true,
			operation: "session.close",
			result: { sessionId: task.sessionId },
		});
		const reads = (await readFile(f.authorityLog, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(reads.map((read) => read.prompted)).toEqual([false, true]);
		expect(JSON.parse(reads[0].input)).toEqual({
			resolveSessionId: task.sessionId,
		});
		const retirement = JSON.parse((await readFile(f.closeLog, "utf8")).trim());
		expect(JSON.parse(retirement.input)).toEqual({
			sessionId: task.sessionId,
			endpointGeneration: 7,
			endpointIncarnation: "a".repeat(64),
		});
		expect(retirement.argv).toContain(
			f.store.getOperation(task.id, "cancel-close")!.key,
		);
		expect(calls(await f.state(), "stop_session")).toHaveLength(0);
		expect(await readFile(sentinel, "utf8")).toBe("do not touch");
		expect(await readFile(workspaceMarker, "utf8")).toBe("workspace preserved");
		await f.fleet.cancel(task.id);
		expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(1);
		expect(
			f.store.events(task.id).filter((e) => e.kind === "released"),
		).toHaveLength(1);
		const dispatch = JSON.parse((await readFile(f.log, "utf8")).trim());
		expect(dispatch.argv).toContain(
			f.store.getOperation(task.id, "cancel")!.key,
		);
		expect(JSON.parse(dispatch.input)).toEqual({
			mode: "terminal",
			scope: "owned",
			operator: true,
		});
		expect(dispatch.autostart).toBe("0");
	});
	for (const [abort, close] of [
		["lost", "closed"],
		["uncertain", "closed"],
		["no_active_turn", "closed"],
		["no_effect", "closed"],
		["no_store", "closed"],
		["nested", "closed"],
		["stopped", "lost"],
		["stopped", "accepted"],
		["stopped", "wrong-session"],
		["stopped", "nested"],
		["stopped", "coordinator"],
	]) {
		test(`controlled ${abort}/${close} cancellation stays held without replay or key replacement`, async () => {
			const f = await ownedFixture(abort, close);
			const task = await f.fleet.start(f.fleet.submit(f.input).id);
			expect(await f.fleet.cancel(task.id)).toMatchObject({
				ok: false,
				task: { phase: "cancel_unknown", held: true },
			});
			const original = f.store.getOperation(task.id, "cancel");
			await f.fleet.cancel(task.id);
			expect(f.store.getOperation(task.id, "cancel")).toEqual(original);
			expect((await readFile(f.log, "utf8")).trim().split("\n")).toHaveLength(
				1,
			);
			if (abort === "stopped")
				expect(
					(await readFile(f.closeLog, "utf8")).trim().split("\n"),
				).toHaveLength(1);
			else expect(await Bun.file(f.closeLog).exists()).toBe(false);
			expect(
				f.store.events(task.id).filter((e) => e.kind === "released"),
			).toHaveLength(0);
		});
	}
	test("controlled non-ephemeral and unknown ownership refuse before SDK dispatch", async () => {
		for (const ephemeral of [false, true]) {
			const f = await ownedFixture("stopped", "closed", ephemeral);
			const task = await f.fleet.start(f.fleet.submit(f.input).id);
			if (ephemeral) f.store.markUnknown(task.id, "historical_unknown");
			await expect(f.fleet.cancel(task.id)).rejects.toThrow();
			expect(await Bun.file(f.log).exists()).toBe(false);
			expect(f.store.getOperation(task.id, "cancel")).toBeUndefined();
		}
	});
	test("native terminal evidence during abort survives retirement and later contradictory observations", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const retain = f.store.retainCancellationReply.bind(f.store);
		const body = {
			sessionId: task.sessionId!,
			turnId: task.turnId!,
			status: "completed_unverified" as const,
			terminal: true,
			evidence: { command: "original-native", outcome: "completed" },
		};
		f.store.retainCancellationReply = (id, stage, reply) => {
			retain(id, stage, reply);
			if (stage === "abort") {
				const observed = f.store.observe(id, {
					...body,
					eventId: "native-during-abort",
					digest: observationDigest(body),
				});
				expect(observed.held).toBe(true);
				expect(
					f.store.events(id).filter((event) => event.kind === "released"),
				).toHaveLength(0);
			}
		};
		const result: any = await f.fleet.cancel(task.id);
		expect(result).toMatchObject({
			ok: true,
			task: {
				held: false,
				phase: "cancelled",
				result: {
					status: "completed_unverified",
					executionTerminal: true,
					evidence: body.evidence,
				},
			},
		});
		const late = {
			...body,
			evidence: { outcome: "contradictory-late-result" },
		};
		f.store.observe(task.id, {
			...late,
			eventId: "native-after-retirement",
			digest: observationDigest(late),
		});
		expect(f.store.task(task.id)?.result?.evidence).toEqual(body.evidence);
		expect(
			f.store.events(task.id).filter((event) => event.kind === "released"),
		).toHaveLength(1);
	});
	test("transactional cancellation fences answers and late terminal observations without losing evidence", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const sequence = f.store.beginObservation(task.id)!;
		const latestSequence = f.store.beginObservation(task.id)!;
		f.store.admitCancellation(
			task.id,
			task,
			f.store.getOperation(task.id, "session-authority")!.payload as any,
		);
		expect(() => f.store.claimOperation(task.id, "answer:late", {})).toThrow(
			"Cancellation fences",
		);
		const body = {
			sessionId: task.sessionId!,
			turnId: task.turnId!,
			status: "completed_unverified" as const,
			terminal: true,
			evidence: {
				nativeCommand: "original",
				nativeTurn: "original",
				successful: true,
			},
		};
		expect(
			f.store.observe(
				task.id,
				{ ...body, eventId: "stale-native", digest: observationDigest(body) },
				sequence,
			).held,
		).toBe(true);
		expect(f.store.task(task.id)?.result?.executionTerminal).toBe(false);
		expect(
			f.store.observe(
				task.id,
				{ ...body, eventId: "late-native", digest: observationDigest(body) },
				latestSequence,
			).held,
		).toBe(true);
		expect(f.store.task(task.id)?.result).toMatchObject({
			status: "completed_unverified",
			executionTerminal: true,
			evidence: body.evidence,
		});
		expect(() =>
			f.store.claimOperation(task.id, "verify-test", { argv: ["never-run"] }),
		).toThrow("Cancellation fences");
		expect(() =>
			f.store.admitCancellation(
				task.id,
				{ ...task, sessionId: "unrelated" },
				f.store.getOperation(task.id, "session-authority")!.payload as any,
			),
		).toThrow();
		f.store.cancellationUnknown(task.id, "lost_reply");
		expect(f.store.task(task.id)?.held).toBe(true);
		expect(
			f.store
				.events(task.id)
				.some(
					(e) =>
						e.kind === "observation" &&
						(e.data as any).eventId === "late-native",
				),
		).toBe(true);
		expect(
			f.store.events(task.id).filter((e) => e.kind === "released"),
		).toHaveLength(0);
	});
	test("old registered sessions, stale snapshots and mismatched fresh public identity cannot dispatch cancellation", async () => {
		const f = await ownedFixture();
		const reserved = f.fleet.submit(f.input);
		f.store.recordSession(reserved.id, "historical-registered-session", true);
		f.store.recordTurn(reserved.id, "historical-turn");
		await expect(f.fleet.cancel(reserved.id)).rejects.toThrow(
			"Fresh exclusive ephemeral ownership",
		);
		expect(await Bun.file(f.log).exists()).toBe(false);
		const other = await ownedFixture();
		const task = await other.fleet.start(other.fleet.submit(other.input).id);
		for (const stale of [
			{ ...task, sessionId: "unrelated-session" },
			{ ...task, attemptId: "old-attempt" },
			{
				...task,
				workspace: { ...(task.workspace as any), path: "wrong-workspace" },
			},
		]) {
			expect(() =>
				other.store.admitCancellation(
					task.id,
					stale,
					other.store.getOperation(task.id, "session-authority")!
						.payload as any,
				),
			).toThrow("current active exact attempt");
		}
		await other.update({ terminal: true, terminalFault: "wrong_session" });
		await expect(other.fleet.cancel(task.id)).rejects.toThrow();
		expect(await Bun.file(other.log).exists()).toBe(false);
	});
	test("controlled pending answer prevents cancellation and CLI awaits actual cancellation task", async () => {
		const f = await ownedFixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		f.store.claimOperation(task.id, "answer:pending", { answer: true });
		expect(() =>
			f.store.admitCancellation(
				task.id,
				task,
				f.store.getOperation(task.id, "session-authority")!.payload as any,
			),
		).toThrow("Existing answer consumption");
		expect(await Bun.file(f.log).exists()).toBe(false);
		const other = await ownedFixture();
		const active = await other.fleet.start(other.fleet.submit(other.input).id);
		other.store.saveResult(active.id, {
			privateEvidence: "CANCEL_PRIVATE_ARTIFACT_CANARY",
			files: [],
			tests: [],
		});
		const result = await cli(other.db, "cancel", active.id);
		expect(result.exit).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: true,
			task: { id: active.id, held: false, phase: "cancelled" },
		});
		expect(result.stdout).not.toContain(other.input.prompt);
		expect(JSON.parse(result.stdout).task.nodeSnapshot).toBeUndefined();
		expect(JSON.parse(result.stdout).task.result.evidence).toEqual({
			digest: expect.any(String),
		});
		expect(result.stdout).not.toContain('"publicTurn"');
		expect(result.stdout).not.toContain("CANCEL_PRIVATE_ARTIFACT_CANARY");
		expect(JSON.parse(result.stdout).task.resultManifest).toMatchObject({
			digest: expect.any(String),
			files: 0,
			tests: 0,
		});
	});
	for (const mode of ["refused"]) {
		test(`public close ${mode} remains an exact retained refusal, not a lost reply`, async () => {
			const f = await ownedFixture("stopped", mode);
			const task = await f.fleet.start(f.fleet.submit(f.input).id);
			const expected = {
				ok: false,
				operation: "session.close",
				error: { code: "close_failed", message: "unavailable" },
			};
			const result: any = await f.fleet.cancel(task.id);
			expect(result).toMatchObject({
				ok: false,
				close: expected,
				task: { phase: "cancel_unknown", held: true },
			});
			expect(result.transportFailure).toBeUndefined();
			expect(
				f.store.getOperation(task.id, "cancel-close-reply")?.payload,
			).toEqual(expected);
			const original = f.store.getOperation(task.id, "cancel");
			const close = f.store.getOperation(task.id, "cancel-close");
			expect(await f.fleet.cancel(task.id)).toMatchObject({
				ok: false,
				close: expected,
			});
			expect(f.store.getOperation(task.id, "cancel")).toEqual(original);
			expect(f.store.getOperation(task.id, "cancel-close")).toEqual(close);
			expect(
				(await readFile(f.closeLog, "utf8")).trim().split("\n"),
			).toHaveLength(1);
			expect(
				f.store.events(task.id).filter((e) => e.kind === "released"),
			).toHaveLength(0);
		});
	}
	test("lost close reply retains only bounded typed transport failure and no remote receipt", async () => {
		const f = await ownedFixture("stopped", "lost");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const result: any = await f.fleet.cancel(task.id);
		expect(result.transportFailure).toEqual({
			stage: "close",
			code: "invalid_public_sdk_response",
			certainty: "unknown",
		});
		expect(result.close).toBeUndefined();
		expect(f.store.getOperation(task.id, "cancel-close-reply")).toBeUndefined();
		const reason = result.task.reason;
		expect(reason).toBe(
			"cancel_transport_failure:close:unknown:invalid_public_sdk_response",
		);
		await f.fleet.cancel(task.id);
		expect(f.store.task(task.id)?.reason).toBe(reason);
		expect(f.store.task(task.id)?.held).toBe(true);
		expect(
			(await readFile(f.closeLog, "utf8")).trim().split("\n"),
		).toHaveLength(1);
		const cancel = f.store.getOperation(task.id, "cancel"),
			closeIntent = f.store.getOperation(task.id, "cancel-close");
		close(f.store);
		const reopened = open(f.db);
		expect(await new Fleet(reopened).cancel(task.id)).toMatchObject({
			ok: false,
			task: { held: true, reason },
		});
		expect(reopened.getOperation(task.id, "cancel")).toEqual(cancel);
		expect(reopened.getOperation(task.id, "cancel-close")).toEqual(closeIntent);
		expect(
			(await readFile(f.closeLog, "utf8")).trim().split("\n"),
		).toHaveLength(1);
	});
	test("lost close reply records a close-step diagnostic beside the unchanged cancel_unknown reason", async () => {
		const f = await ownedFixture("stopped", "lost");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const result: any = await f.fleet.cancel(task.id);
		expect(result.task).toMatchObject({
			phase: "cancel_unknown",
			held: true,
			reason: "cancel_transport_failure:close:unknown:invalid_public_sdk_response",
		});
		const event = f.store.events(task.id).findLast((e) => e.kind === "cancel_unknown")!;
		const close = f.store.getOperation(task.id, "cancel-close")!;
		expect((event.data as any).failureDiagnostic).toEqual({
			version: 1,
			use: "diagnostic_only_not_evidence",
			source: "Fleet.cancel.close",
			phase: "call",
			operationKind: "cancel-close",
			operationId: close.id,
			errorClass: "TransportError",
			code: "transport:invalid_public_sdk_response",
			message: "Public SDK reply was invalid",
		});
		expect((event.data as any).failure).toMatchObject({ source: "Fleet.cancel.close", operationKind: "cancel-close" });
	});
	test("audit: a repeated cancel re-recording cancel_unknown names the retained cancel claim instead of recording no diagnostic", async () => {
		const f = await ownedFixture("stopped", "lost");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const first: any = await f.fleet.cancel(task.id);
		const before = f.store.events(task.id).filter((e) => e.kind === "cancel_unknown").length;
		const again: any = await f.fleet.cancel(task.id);
		expect(again).toMatchObject({ ok: false, task: { phase: "cancel_unknown", held: true, reason: first.task.reason } });
		const events = f.store.events(task.id).filter((e) => e.kind === "cancel_unknown");
		expect(events).toHaveLength(before + 1);
		const cancel = f.store.getOperation(task.id, "cancel")!;
		const condition = {
			version: 1,
			use: "diagnostic_only_not_evidence",
			source: "Fleet.cancel.abort",
			phase: "claim",
			operationKind: "cancel",
			operationId: cancel.id,
			errorClass: "none",
			code: "condition:operation_already_claimed",
			message: "Effect intent already claimed; not replayed",
		};
		expect(events.at(-1)!.data).toMatchObject({ reason: first.task.reason, failureDiagnostic: condition });
		// show names the event that set the current reason: the repeat, not an empty diagnostic.
		expect(f.store.reasonDiagnostic(task.id)?.diagnostic).toEqual(condition as any);
		expect((await readFile(f.closeLog, "utf8")).trim().split("\n")).toHaveLength(1);
	});
	test("SDK close refusal retains public stdout without private stderr", async () => {
		const f = await ownedFixture("stopped", "refused");
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const result = await f.fleet.cancel(task.id);
		expect(JSON.stringify(result)).not.toContain(
			"CONTROLLED_PRIVATE_STDERR_CANARY",
		);
		expect(
			f.store.getOperation(task.id, "cancel-close-reply")?.payload,
		).toEqual({
			ok: false,
			operation: "session.close",
			error: { code: "close_failed", message: "unavailable" },
		});
	});
	test("missing sidecar turn needs exact durable public result, never arbitrary terminal metadata", async () => {
		const f = await fixture();
		const { fleet, store } = f.setup();
		const runtime = {
			kind: "prompt",
			commandId: "controlled-runtime-command",
			turnId: "controlled-runtime-turn",
			status: "terminal_ok",
			receiptState: "present",
			terminalAt: 123,
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
		};
		store.putNode({
			...f.node,
			sdkTransport: {
				command: process.execPath,
				args: [
					"--eval",
					`console.log(JSON.stringify(${JSON.stringify({ type: "query_response", ok: true, result: runtime })}))`,
					"--",
				],
			},
		});
		const task = await fleet.start(fleet.submit(f.input).id);
		await f.update({
			terminal: true,
			sidecarTurnOmitted: true,
			terminalFault: "metadata",
		});
		expect((await fleet.inspect(task.id)).task.held).toBe(true);
		await f.update({ sidecarTurnOmitted: false, terminalFault: "wrong_turn" });
		expect((await fleet.inspect(task.id)).task.held).toBe(true);
		await f.update({ terminalFault: undefined, sidecarTurnOmitted: true });
		const observed = await fleet.inspect(task.id);
		expect(observed.task.held).toBe(false);
		expect((observed.task.result?.evidence as any).execution).toEqual(runtime);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(1);
	});
	test("model profiles require explicit eligibility and use public mpreset independently of model pins", async () => {
		const f = await fixture();
		const { fleet, store } = f.setup();
		const input = {
			...f.input,
			required: { ...f.input.required, modelProfile: "controlled-profile" },
		};
		const queued = fleet.submit(input);
		expect(queued.held).toBe(false);
		expect((await f.state()).calls).toEqual([]);
		expect(selectNode(input, [f.node], []).exclusions[0]?.reasons).toContain(
			"model_profile_unavailable",
		);
		store.putNode({ ...f.node, modelProfiles: ["controlled-profile"] });
		const started = await fleet.start(fleet.submit(input).id);
		expect(started.phase).toBe("active");
		const create = calls(await f.state(), "start_session")[0]!;
		expect(create.args.mpreset).toBe("controlled-profile");
		expect(create.args.model).toBe("controlled-model");
	});
	test("explicit verification failure remains a nonzero operator exit with genuine command evidence", async () => {
		const f = await fixture();
		const { fleet, store } = f.setup();
		store.putNode(f.node);
		const task = await fleet.start(fleet.submit(f.input).id);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		const argv = join(f.dir, "failing-argv.json");
		await writeFile(
			argv,
			JSON.stringify([
				process.execPath,
				"--eval",
				"console.error('controlled failure');process.exit(7)",
			]),
		);
		const result = await cli(f.db, "result", task.id, argv);
		expect(result.exit).toBe(1);
		const manifest = JSON.parse(result.stdout);
		expect(manifest.status).toBe("tests_failed");
		expect(manifest.tests[0].exit).toBe(7);
		expect(manifest.tests[0].stderr).toBe("controlled failure\n");
	});
	test("malformed authorized-looking input cannot reserve capacity or create a task", async () => {
		const f = await fixture();
		const { fleet, store } = f.setup();
		const malformed = {
			schemaVersion: 1,
			repoId: "repo",
			baseCommit: f.baseCommit,
			digest: "0".repeat(64),
			authorization: { digest: "0".repeat(64), reference: "claimed" },
			changes: [{ path: "tracked.txt", before: null, after: null }],
		};
		expect(() =>
			fleet.submit({ ...f.input, inputPackage: malformed as any }),
		).toThrow();
		expect(store.tasks()).toEqual([]);
		expect((await f.state()).calls).toEqual([]);
	});
	test("ordinary status and poll views do not copy private prompt evidence or artifact bytes", async () => {
		const f = await fixture();
		const { fleet, store } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		const polled = await cli(f.db, "poll", task.id);
		expect(polled.exit).toBe(0);
		expect(polled.stdout).not.toContain(f.input.prompt);
		expect(
			(store.task(task.id)?.result?.evidence as any).publicTurn.turn.prompt
				.text,
		).toBe(f.input.prompt);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		const path = (task.workspace as any).path;
		await writeFile(
			join(path, "private-result.txt"),
			"CONTROLLED_PRIVATE_ARTIFACT_CANARY",
		);
		const manifest = await fleet.result(task.id);
		const content = manifest.files.find(
			(file) => file.path === "private-result.txt",
		)!.contentBase64;
		const shown = await cli(f.db, "show", task.id);
		expect(shown.exit).toBe(0);
		expect(shown.stdout).not.toContain(f.input.prompt);
		expect(shown.stdout).not.toContain(content);
		expect(JSON.parse(shown.stdout).resultManifest.files).toBe(
			manifest.files.length,
		);
	});
	test("incomplete or pending workflow questions veto settlement and fresh polling resumes the same turn", async () => {
		const f = await fixture();
		const { store, fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		await fleet.inspect(task.id);
		await f.update({ terminal: true, questionsComplete: false });
		const unknown = await fleet.inspect(task.id);
		expect(unknown.task.phase).toBe("blocked_unknown");
		expect(unknown.task.held).toBe(true);
		await f.update({ questions: "bound", questionsComplete: true });
		const waiting = await fleet.inspect(task.id);
		expect(waiting.task.phase).toBe("approval_required");
		expect(waiting.task.result?.executionTerminal).toBe(false);
		await expect(fleet.result(task.id)).rejects.toThrow(
			"Authoritative runtime settlement",
		);
		await fleet.answer(task.id, {
			questionId: "controlled-question",
			answerBinding: "current-binding",
			answer: { choice: "controlled only" },
		});
		expect(store.task(task.id)?.phase).toBe("approval_required");
		await f.update({ terminal: false, questions: "absent" });
		expect((await fleet.inspect(task.id)).task.phase).toBe("active");
		await f.update({ terminal: true });
		expect((await fleet.inspect(task.id)).task.held).toBe(false);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(1);
		expect(
			store.events(task.id).filter((e) => e.kind === "released"),
		).toHaveLength(1);
	});
	test("authorized selected input and exact object closure reach the admitted task workspace", async () => {
		const f = await fixture();
		const { fleet } = f.setup();
		await writeFile(
			join(f.repo, "tracked.txt"),
			"explicit selected dirty input\n",
		);
		await writeFile(
			join(f.repo, "user-sentinel.txt"),
			"unselected user bytes\n",
		);
		const pkg = await previewInput({
			repo: f.repo,
			repoId: "repo",
			baseCommit: f.baseCommit,
			paths: ["tracked.txt"],
			includeObjects: true,
		});
		const task = await fleet.start(
			fleet.submit({
				...f.input,
				inputPackage: authorizeInput(
					pkg,
					pkg.digest,
					"controlled-explicit-input",
				),
			}).id,
		);
		expect(task.phase).toBe("active");
		expect((task.workspace as any).inputPackageDigest).toBe(pkg.digest);
		expect((task.workspace as any).inputDigest).not.toBe(pkg.digest);
		expect(
			await readFile(join((task.workspace as any).path, "tracked.txt"), "utf8"),
		).toBe("explicit selected dirty input\n");
		expect(await readFile(join(f.repo, "user-sentinel.txt"), "utf8")).toBe(
			"unselected user bytes\n",
		);
		expect(dirname((task.workspace as any).repo)).toBe(
			join(f.workspaceRoot, ".inputs"),
		);
		expect(basename((task.workspace as any).repo)).toBe(
			task.id + "-" + task.attemptId,
		);
	});
	test("input CLI stages then digest-authorizes and imports without overwriting an existing destination", async () => {
		const f = await fixture();
		await writeFile(join(f.repo, "tracked.txt"), "selected CLI input");
		const request = join(f.dir, "request.json"),
			pending = join(f.dir, "pending.json"),
			approved = join(f.dir, "approved.json");
		await writeFile(
			request,
			JSON.stringify({
				repo: f.repo,
				repoId: "repo",
				baseCommit: f.baseCommit,
				paths: ["tracked.txt"],
				includeObjects: true,
			}),
		);
		const preview = await cli(f.db, "input", "preview", request, pending);
		expect(preview.exit).toBe(0);
		const staged = JSON.parse(preview.stdout);
		expect(staged.authorized).toBe(false);
		expect(preview.stdout).not.toContain("selected CLI input");
		expect(
			(
				await cli(
					f.db,
					"input",
					"authorize",
					pending,
					"0".repeat(64),
					"operator",
					approved,
				)
			).exit,
		).toBe(1);
		expect(
			(
				await cli(
					f.db,
					"input",
					"authorize",
					pending,
					staged.digest,
					"operator",
					approved,
				)
			).exit,
		).toBe(0);
		const destination = join(f.dir, "new-import");
		expect(
			(await cli(f.db, "input", "import", approved, destination)).exit,
		).toBe(0);
		expect(
			(await cli(f.db, "input", "import", approved, destination)).exit,
		).toBe(1);
		expect(await readFile(join(destination, "tracked.txt"), "utf8")).toBe(
			"base bytes\n",
		);
	});
	test("a crash after manifest commit recovers acceptance without rerunning the command", async () => {
		const f = await fixture();
		let { store, fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		store.verifyResult = () => {
			throw new Error("injected crash after manifest commit");
		};
		const argv = [
			process.execPath,
			"--eval",
			'import {appendFileSync} from "node:fs";appendFileSync("counter.txt","once\\n")',
		];
		await expect(fleet.result(task.id, argv)).rejects.toThrow("injected crash");
		expect(store.task(task.id)?.resultManifest).toBeDefined();
		expect(store.task(task.id)?.result?.verified).toBe(false);
		close(store);
		store = open(f.db);
		fleet = new Fleet(store);
		expect((await fleet.result(task.id)).status).toBe("verified");
		expect(store.task(task.id)?.phase).toBe("succeeded");
		expect(
			await readFile(join((task.workspace as any).path, "counter.txt"), "utf8"),
		).toBe("once\n");
	});
	test("creation validation is durable and an unvalidated session never receives a prompt after reopen", async () => {
		const f = await fixture();
		let { store, fleet } = f.setup();
		await f.update({ sessionCwdMismatch: true });
		const task = await fleet.start(fleet.submit(f.input).id);
		expect(task.sessionId).toBe("controlled-session");
		expect(task.sessionValidated).toBe(false);
		expect(task.phase).toBe("blocked_unknown");
		close(store);
		store = open(f.db);
		fleet = new Fleet(store);
		await fleet.start(task.id);
		expect(calls(await f.state(), "send_prompt")).toHaveLength(0);
		expect(calls(await f.state(), "start_session")).toHaveLength(1);
	});
	test("known test receipt survives collection failure and is not executed again", async () => {
		const f = await fixture();
		const { store, fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		const root = (task.workspace as any).path;
		await writeFile(join(root, ".env"), "CONTROLLED_EXCLUDED_OUTPUT");
		const argv = [
			process.execPath,
			"--eval",
			'import {appendFileSync} from "node:fs";appendFileSync("counter.txt","once\\n");console.log("retained test response")',
		];
		await expect(fleet.result(task.id, argv)).rejects.toThrow(
			"node_failed:unsafe_path:unsafe_entry",
		);
		expect(JSON.stringify(store.events(task.id).filter(event => event.kind === "node_operation_failure"))).toContain("node_failed:unsafe_path:unsafe_entry");
		expect((store.task(task.id)?.testReceipt as any).stdout).toBe(
			"retained test response\n",
		);
		await unlink(join(root, ".env"));
		const result = await fleet.result(task.id);
		expect(result.status).toBe("verified");
		expect(result.tests[0]?.argv).toEqual(argv);
		expect(await readFile(join(root, "counter.txt"), "utf8")).toBe("once\n");
	});
	test("collecting without tests never silently claims a later explicit command was run", async () => {
		const f = await fixture();
		const { fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		expect((await fleet.result(task.id)).status).toBe("not_run");
		const argv = [process.execPath, "--eval", 'console.log("must not be silently skipped")'];
		const verified = await fleet.result(task.id, argv);
		expect(verified.status).toBe("verified");
		expect(verified.tests[0]?.argv).toEqual(argv);
		expect(verified.tests[0]?.stdout).toBe("must not be silently skipped\n");
	});
	test("stop uses only supported idle owned close and cancel never fakes an execution abort", async () => {
		const f = await fixture();
		const { fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		await expect(fleet.cancel(task.id)).rejects.toThrow(
			"Fresh exclusive ephemeral ownership",
		);
		await expect(fleet.stop(task.id)).rejects.toThrow("Only a proven settled");
		expect(calls(await f.state(), "stop_session")).toHaveLength(0);
		await f.update({ terminal: true });
		await fleet.inspect(task.id);
		expect(await fleet.stop(task.id)).toMatchObject({
			ok: true,
			stopped: true,
			session_id: task.sessionId,
		});
		await expect(fleet.stop(task.id)).rejects.toThrow(
			"Stop was already requested",
		);
		expect(calls(await f.state(), "stop_session")).toHaveLength(1);
	});
	test("real CLI help, node add, submit/dedup and show redact the prompt without losing durable input", async () => {
		const f = await fixture();
		const help = await cli(f.db, "--help");
		expect(help.exit).toBe(0);
		expect(help.stderr).toBe("");
		expect(help.stdout).toContain("node add CONFIG.json");
		expect(help.stdout).toContain("No automatic retries");
		const config = join(f.dir, "node.json");
		const taskFile = join(f.dir, "task.json");
		await writeFile(config, JSON.stringify(f.node));
		await writeFile(taskFile, JSON.stringify(f.input));
		const added = await cli(f.db, "node", "add", config);
		expect(added.exit).toBe(0);
		expect(added.stderr).toBe("");
		expect(JSON.parse(added.stdout)).toEqual({ ok: true });
		const submitted = await cli(f.db, "submit", taskFile);
		expect(submitted.exit).toBe(0);
		expect(submitted.stderr).toBe("");
		const { placement, ...task } = JSON.parse(submitted.stdout);
		expect(placement.nodes[0].ready).toBe(true);
		expect(task).toMatchObject({
			nodeId: "alpha",
			held: true,
			phase: "preparing",
			input: { prompt: "[omitted; retained in private database]" },
		});
		expect(task.attemptId).toBeString();
		expect(submitted.stdout).not.toContain(f.input.prompt);
		const duplicate = await cli(f.db, "submit", taskFile);
		expect(duplicate.exit).toBe(0);
		const { placement: duplicatePlacement, ...duplicateTask } = JSON.parse(duplicate.stdout);
		expect(duplicateTask).toEqual(task);
		const shown = await cli(f.db, "show", task.id);
		expect(shown.exit).toBe(0);
		expect(shown.stderr).toBe("");
		expect(JSON.parse(shown.stdout)).toEqual(task);
		const store = open(f.db);
		expect(store.task(task.id)?.input.prompt).toBe(f.input.prompt);
		expect(
			store.events(task.id).filter((event) => event.kind === "reserved"),
		).toHaveLength(1);
		expect((await f.state()).calls).toEqual([]);
	});

	test("two eligible nodes are selected by core and independent CLI admissions cannot overbook measured headroom", async () => {
		const f = await fixture();
		const store = open(f.db);
		const beta: NodeConfig = {
			...f.node,
			id: "beta",
			workspaceRoot: join(f.dir, "beta-workspaces"),
		};
		const betaConfig = join(f.dir, "beta-node.json");
		beta.workspaceTransport = { command: process.execPath, args: [fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url)), betaConfig] };
		await writeFile(betaConfig, JSON.stringify(beta));
		store.putNode(beta);
		store.putNode(f.node);
		expect(selectNode(f.input, [beta, f.node], []).nodeId).toBe("alpha");
		expect(
			selectNode({ ...f.input, preferences: ["beta"] }, [f.node, beta], [])
				.nodeId,
		).toBe("beta");
		const files = await Promise.all(
			Array.from({ length: 6 }, async (_, index) => {
				const path = join(f.dir, `task-${index}.json`);
				await writeFile(
					path,
					JSON.stringify({ ...f.input, key: `parallel-${index}` }),
				);
				return path;
			}),
		);
		const outputs = await Promise.all(
			files.map((file) => cli(f.db, "submit", file)),
		);
		for (const result of outputs) {
			const submitted = JSON.parse(result.stdout);
			expect(result.exit).toBe(submitted.attemptId ? 0 : 1);
			expect(result.stderr).toBe("");
			expect(submitted.placement).toBeDefined();
		}
		const tasks = store.tasks();
		const held = tasks.filter((task) => task.held);
		expect(tasks).toHaveLength(6);
		expect(held).toHaveLength(2);
		expect(held.map((task) => task.nodeId).sort()).toEqual(["alpha", "beta"]);
		expect(new Set(held.map((task) => task.attemptId)).size).toBe(2);
		expect(
			tasks
				.filter((task) => !task.held)
				.every(
					(task) =>
						task.phase === "queued" &&
						task.reason === "no_eligible_node" &&
						!task.attemptId,
				),
		).toBe(true);
		const now = Date.now();
		const full = selectNode(f.input, [f.node, beta], tasks, {
			...headroom(["alpha", "beta"], 1),
			held: store.heldCharges(),
			now,
		});
		expect(full.nodeId).toBeUndefined();
		expect(full.exclusions).toEqual([
			{ nodeId: "alpha", reasons: ["memory_low"] },
			{ nodeId: "beta", reasons: ["memory_low"] },
		]);
		expect((await f.state()).calls).toEqual([]);
	});
});

describe("CONTROLLED stdio Coordinator contracts (not real GJC)", () => {
	test("Fleet.start binds exact workspace/session/turn and same-key/reopen never creates or sends twice", async () => {
		const f = await fixture();
		let { store, fleet } = f.setup();
		const reserved = fleet.submit(f.input);
		const active = await fleet.start(reserved.id);
		expect(active.phase).toBe("active");
		expect(active.held).toBe(true);
		expect(active.sessionId).toBe("controlled-session");
		expect(active.turnId).toBe("controlled-turn");
		const workspace = active.workspace as any;
		expect(workspace).toMatchObject({
			taskId: active.id,
			attemptId: active.attemptId,
			nodeId: "alpha",
			inputDigest: active.inputDigest,
			baseCommit: f.baseCommit,
			repo: f.repo,
			path: join(f.workspaceRoot, active.id + "-" + active.attemptId),
		});
		const state = await f.state();
		expect(calls(state, "start_session")).toHaveLength(1);
		expect(calls(state, "send_prompt")).toHaveLength(1);
		expect(calls(state, "start_session")[0]!.args).toEqual({
			cwd: workspace.path,
			allow_mutation: true,
			model: "controlled-model",
			idempotency_key: store.getOperation(active.id, "create")!.key,
		});
		expect(calls(state, "send_prompt")[0]!.args).toEqual({
			session_id: active.sessionId,
			prompt: f.input.prompt,
			allow_mutation: true,
			idempotency_key: store.getOperation(active.id, "prompt")!.key,
		});
		expect(fleet.submit(f.input).id).toBe(active.id);
		expect((await fleet.start(active.id)).turnId).toBe(active.turnId);
		close(store);
		store = open(f.db);
		fleet = new Fleet(store);
		expect(await fleet.start(active.id)).toMatchObject({
			id: active.id,
			attemptId: active.attemptId,
			sessionId: active.sessionId,
			turnId: active.turnId,
		});
		const observed = await fleet.inspect(active.id);
		expect(observed.task).toMatchObject({
			phase: "active",
			held: true,
			sessionId: active.sessionId,
			turnId: active.turnId,
		});
		const after = await f.state();
		expect(calls(after, "start_session")).toHaveLength(1);
		expect(calls(after, "send_prompt")).toHaveLength(1);
		expect(calls(after, "read_turn")[0]!.args).toEqual({
			session_id: active.sessionId,
			turn_id: active.turnId,
		});
		expect(calls(after, "list_questions")[0]!.args).toEqual({
			session_id: active.sessionId,
			turn_id: active.turnId,
			status: "pending",
		});
		await expect(fleet.result(active.id)).rejects.toThrow(
			"Authoritative runtime settlement",
		);
	});

	test("terminal metadata holds slots until acknowledged nonqueued runtime, live idle SDK and exact terminal session state agree", async () => {
		const f = await fixture();
		const { store, fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		for (const terminalFault of [
			"queued",
			"unacknowledged",
			"no_runtime",
			"empty_runtime",
			"metadata",
			"not_live",
			"streaming",
			"wrong_session",
			"wrong_turn",
		] as const) {
			await f.update({ terminal: true, terminalFault });
			const observed = await fleet.inspect(task.id);
			expect(observed.task.phase).toBe("completed_unverified");
			expect(observed.task.held).toBe(true);
			expect(observed.task.result?.executionTerminal).toBe(false);
			await expect(fleet.result(task.id)).rejects.toThrow(
				"Authoritative runtime settlement",
			);
		}
		await f.update({ terminal: true, terminalFault: undefined });
		const settled = await fleet.inspect(task.id);
		expect(settled.task).toMatchObject({
			phase: "completed_unverified",
			held: false,
			result: { executionTerminal: true, verified: false },
		});
		const publicTurn = settled.publicTurn as any;
		expect(publicTurn.turn.delivery).toMatchObject({
			prompt_acknowledged: true,
			queued: false,
			runtime_turn_id: "controlled-runtime-turn",
		});
		expect(publicTurn.advisory_status).toEqual({
			authority: "sdk",
			live: true,
			is_streaming: false,
		});
		expect(publicTurn.session_state).toEqual({
			session_id: task.sessionId,
			current_turn_id: task.turnId,
			state: "completed",
		});
		expect(
			store.events(task.id).filter((event) => event.kind === "released"),
		).toHaveLength(1);
		const result = await fleet.result(task.id, [
			process.execPath,
			"--eval",
			'console.log("controlled actual test command")',
		]);
		expect(result.status).toBe("verified");
		expect(result.identity.taskId).toBe(task.id);
		expect(result.tests[0]).toMatchObject({
			exit: 0,
			stdout: "controlled actual test command\n",
			cwd: (task.workspace as any).path,
		});
		expect(store.task(task.id)?.result?.verified).toBe(true);
		expect(store.task(task.id)?.phase).toBe("succeeded");
		await expect(
			fleet.result(task.id, [
				process.execPath,
				"--eval",
				'console.log("a different command")',
			]),
		).rejects.toThrow("Cached result does not verify");
	});

	for (const lose of ["start", "send", "read"] as const) {
		test(`lost ${lose} response holds original attempt across reopen and never causes a second send`, async () => {
			const f = await fixture();
			let { store, fleet } = f.setup();
			await f.update({ lose });
			const reserved = fleet.submit(f.input);
			let unknown = await fleet.start(reserved.id);
			if (lose === "read") unknown = (await fleet.inspect(reserved.id)).task;
			expect(unknown.phase).toBe("blocked_unknown");
			expect(unknown.held).toBe(true);
			expect(unknown.attemptId).toBe(reserved.attemptId);
			const before = await f.state();
			expect(calls(before, "start_session")).toHaveLength(1);
			expect(calls(before, "send_prompt")).toHaveLength(
				lose === "start" ? 0 : 1,
			);
			close(store);
			store = open(f.db);
			fleet = new Fleet(store);
			await f.update({ lose: undefined });
			expect(fleet.submit(f.input).attemptId).toBe(reserved.attemptId);
			const retried = await fleet.start(reserved.id);
			expect(retried).toMatchObject({
				phase: "blocked_unknown",
				held: true,
				attemptId: reserved.attemptId,
			});
			expect((await f.state()).calls).toEqual(before.calls);
			const next = fleet.submit({ ...f.input, key: "second-request" }, headroom(["alpha"], 1));
			expect(next.held).toBe(false);
			expect(next.reason).toBe("no_eligible_node");
			expect(store.getOperation(reserved.id, "create")).toBeDefined();
			if (lose !== "start")
				expect(store.getOperation(reserved.id, "prompt")).toBeDefined();
		});
	}

	test("only a freshly discovered exact bound question may be answered; absent and stale bindings never fall back", async () => {
		const f = await fixture();
		const { store, fleet } = f.setup();
		const task = await fleet.start(fleet.submit(f.input).id);
		const request = {
			questionId: "controlled-question",
			answerBinding: "current-binding",
			answer: { choice: "approve controlled fixture only" },
		};
		await expect(fleet.answer(task.id, request)).rejects.toThrow(
			"Discover current bound workflow question",
		);
		await f.update({ questions: "bound" });
		const pending = await fleet.inspect(task.id);
		expect(pending.task.phase).toBe("approval_required");
		expect((pending.questions as any).questions[0]).toMatchObject({
			question_id: request.questionId,
			answer_binding: request.answerBinding,
			session_id: task.sessionId,
			turn_id: task.turnId,
			answer_schema: { type: "object" },
		});
		for (const questions of ["absent", "stale"] as const) {
			await f.update({ questions });
			await expect(fleet.answer(task.id, request)).rejects.toThrow(
				"Missing or stale workflow binding",
			);
			expect(calls(await f.state(), "submit_question_answer")).toHaveLength(0);
			expect(
				store.getOperation(task.id, "answer:" + request.questionId),
			).toBeUndefined();
		}
		await f.update({ questions: "bound" });
		expect(await fleet.answer(task.id, request)).toMatchObject({
			ok: true,
			accepted: true,
			session_id: task.sessionId,
			turn_id: task.turnId,
		});
		const sent = calls(await f.state(), "submit_question_answer");
		expect(sent).toHaveLength(1);
		expect(sent[0]!.args).toEqual({
			session_id: task.sessionId,
			turn_id: task.turnId,
			question_id: request.questionId,
			answer_binding: request.answerBinding,
			answer: request.answer,
			allow_mutation: true,
			idempotency_key: store.getOperation(
				task.id,
				"answer:" + request.questionId,
			)!.key,
		});
		await expect(fleet.answer(task.id, request)).rejects.toThrow(
			"answer_already_sent_reconcile_consumption",
		);
		expect(calls(await f.state(), "submit_question_answer")).toHaveLength(1);
		expect(
			(await f.state()).calls.some((call) => call.name === "ask.answer"),
		).toBe(false);
	});
});
