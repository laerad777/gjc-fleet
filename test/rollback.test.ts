import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";
import { FleetError, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import {
	repositoryFixture,
	type ControlledState,
} from "./fixtures/coordinator";

// Controlled local evidence only: no remote fence, old-writer exclusion, or
// cancellation of operations already claimed/possibly forwarded is established.
const coordinator = fileURLToPath(
	new URL("./fixtures/coordinator.ts", import.meta.url),
);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const directories: string[] = [];
const stores = new Set<FleetStore>();
function open(path: string, readOnly = false) {
	const store = new FleetStore(path, 2, { readOnly });
	stores.add(store);
	return store;
}
function close(store: FleetStore) {
	store.close();
	stores.delete(store);
}
afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
});
async function disabled(action: () => unknown) {
	let caught: unknown;
	try {
		await action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(FleetError);
	expect((caught as FleetError).code).toBe("DISPATCH_DISABLED");
}
async function fixture(readTools?: string[]) {
	const repo = await repositoryFixture("fleet-rollback-owned-");
	directories.push(repo.dir);
	const statePath = join(repo.dir, "state.json");
	const capabilitiesPath = join(repo.dir, "capabilities.json");
	await writeFile(capabilitiesPath, "null");
	await writeFile(
		statePath,
		JSON.stringify({ calls: [] } satisfies ControlledState),
	);
	let args = [coordinator, statePath];
	if (readTools) {
		const filterPath = join(repo.dir, "read-capabilities.ts");
		// Preload in the directly owned fixture process: no proxy/grandchild whose
		// cleanup depends on signals being delivered during Windows termination.
		await writeFile(
			filterPath,
			`
import { readFileSync } from "node:fs";
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (...args) {
 const chunk = args[0];
 let response;
 // The controlled fixture writes one complete JSON response plus newline.
 // Leave buffers, partial writes and all unrelated bytes/overloads untouched.
 if(typeof chunk === "string" && chunk.endsWith("\\n")) {
  try { response = JSON.parse(chunk); } catch {}
 }
 if(Array.isArray(response?.result?.tools)) {
  const allowed = JSON.parse(readFileSync(${JSON.stringify(capabilitiesPath)}, "utf8"));
  if(Array.isArray(allowed)) {
   response.result.tools = response.result.tools.filter(tool => allowed.includes(tool.name));
   args[0] = JSON.stringify(response) + "\\n";
  }
 }
 // Preserve encoding/callback arguments, return value and stream ownership.
 return originalWrite(...args);
};
`,
		);
		args = ["--preload", filterPath, coordinator, statePath];
	}
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
		transport: { command: process.execPath, args },
		operations: ["read", "write"],
	};
	const input: TaskInput = {
		schemaVersion: 1,
		key: "request",
		caller: "rollback-controlled",
		repoId: "repo",
		baseCommit: repo.baseCommit,
		prompt: "CONTROLLED local rollback test",
		required: {
			os: process.platform,
			arch: process.arch,
			model: "controlled-model",
			operations: ["write"],
		},
	};
	const store = open(db);
	store.putNode(node);
	const fleet = new Fleet(store, { localNodeId: node.id });
	const state = async (): Promise<ControlledState> =>
		JSON.parse(await readFile(statePath, "utf8"));
	const update = async (patch: Partial<ControlledState>) =>
		writeFile(statePath, JSON.stringify({ ...(await state()), ...patch }));
	const calls = async (suffix: string) =>
		(await state()).calls.filter((c) => c.name === "gjc_coordinator_" + suffix);
	const limitTools = async (allowed = readTools) =>
		writeFile(capabilitiesPath, JSON.stringify(allowed));
	return {
		...repo,
		db,
		node,
		input,
		store,
		fleet,
		state,
		update,
		calls,
		limitTools,
	};
}
function intents(store: FleetStore, id: string) {
	return store.events(id).filter((e) => e.kind === "operation_intent");
}
function markerCount(path: string) {
	const db = new Database(path, { readonly: true });
	try {
		return db
			.query<{ count: number }, []>(
				"SELECT count(*) AS count FROM audit WHERE task_id IS NULL AND kind='rollback_dispatch_disabled'",
			)
			.get()!.count;
	} finally {
		db.close();
	}
}
function terminal(store: FleetStore, task: TaskRecord) {
	const body = {
		sessionId: task.sessionId!,
		turnId: task.turnId!,
		status: "completed_unverified" as const,
		terminal: true,
		evidence: { controlled: "exact original runtime completed" },
	};
	return store.observe(task.id, {
		...body,
		eventId: task.attemptId + ":terminal",
		digest: observationDigest(body),
	});
}
async function cli(db: string, ...args: string[]) {
	const child = Bun.spawn(
		[process.execPath, cliPath, "--db", db, "--cap", "2", ...args],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}

describe("one-way local rollback", () => {
	test("exact rollback lookup searches the global-kind index with unrelated audit history", async () => {
		const f = await fixture();
		const task = f.fleet.submit(f.input);
		const db = new Database(f.db);
		const query =
			"SELECT sequence FROM audit WHERE task_id IS NULL AND kind='rollback_dispatch_disabled' LIMIT 1";
		function expectIndexedLookup(present: boolean) {
			const details = db
				.query<{ detail: string }, []>("EXPLAIN QUERY PLAN " + query)
				.all()
				.map((row) => row.detail)
				.join("\n");
			expect(details).toMatch(
				/SEARCH audit USING (?:COVERING )?INDEX audit_global_kind/,
			);
			expect(details).not.toMatch(/SCAN audit\b/);
			expect(db.query(query).get() !== null).toBe(present);
		}
		try {
			const insert = db.query(
				"INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)",
			);
			db.transaction(() => {
				for (let i = 0; i < 10000; i++)
					insert.run(
						task.id,
						"controlled_unrelated_history",
						"2026-01-01T00:00:00.000Z",
						"{}",
					);
			})();
			expectIndexedLookup(false);
			expect(f.store.dispatchStatus().disabled).toBe(false);
			close(f.store);
			const reopened = open(f.db);
			expect(reopened.dispatchStatus().disabled).toBe(false);
			reopened.enterRollback();
			expectIndexedLookup(true);
			expect(reopened.dispatchStatus().disabled).toBe(true);
			close(reopened);
			expect(open(f.db).dispatchStatus().disabled).toBe(true);
			expectIndexedLookup(true);
		} finally {
			db.close();
		}
	});

	test("persisted marker spans handles and reopen; no fresh admission or identity substitution", async () => {
		const f = await fixture();
		const reserved = f.fleet.submit(f.input);
		const queued = f.store.submit({ ...f.input, key: "queued" });
		const other = open(f.db);
		const before = f.store.task(reserved.id)!;
		let workspaceCalls = 0;
		(f.fleet as any).node = async () => {
			workspaceCalls++;
			throw new Error("forbidden preparation");
		};
		const status = other.enterRollback();
		expect(status).toMatchObject({
			disabled: true,
			scope: "local_admission_and_new_effect_claims_only",
			remoteFence: false,
			preexistingClaims: "held_not_cancelled_or_retired",
			olderSnapshotsAndWriters: "not_proven_safe",
		});
		expect(Object.isFrozen(status)).toBe(true);
		expect(f.store.dispatchStatus()).toEqual(status);
		await disabled(() => f.fleet.start(reserved.id));
		await disabled(() => f.fleet.submit({ ...f.input, key: "new" }));
		await disabled(() => f.store.reserve(queued.id));
		expect(f.fleet.submit(f.input)).toEqual(before);
		expect(f.store.task(reserved.id)).toEqual(before);
		expect(f.store.task(queued.id)).toEqual(queued);
		expect(f.store.tasks()).toHaveLength(2);
		expect(intents(f.store, reserved.id)).toEqual([]);
		expect(workspaceCalls).toBe(0);
		expect(await f.calls("start_session")).toHaveLength(0);
		expect(await f.calls("send_prompt")).toHaveLength(0);
		close(other);
		close(f.store);
		const reopened = open(f.db);
		expect(reopened.enterRollback()).toEqual(status);
		expect(markerCount(f.db)).toBe(1);
		await disabled(() => reopened.claimOperation(reserved.id, "prepare", {}));
		expect(reopened.task(reserved.id)).toEqual(before);
	});

	test("marker persistence failure is not successful rollback and leaves admission available", async () => {
		const f = await fixture();
		const db = new Database(f.db);
		try {
			db.exec(
				"CREATE TRIGGER reject_rollback BEFORE INSERT ON audit WHEN NEW.kind='rollback_dispatch_disabled' BEGIN SELECT RAISE(ABORT,'controlled_marker_failure'); END;",
			);
			expect(() => f.store.enterRollback()).toThrow(
				"controlled_marker_failure",
			);
			expect(markerCount(f.db)).toBe(0);
			expect(f.fleet.submit(f.input).held).toBe(true);
		} finally {
			db.close();
		}
	});

	test("owned preparation completes after rollback but no create or prompt claim follows", async () => {
		const f = await fixture();
		const task = f.fleet.submit(f.input);
		let ready!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let prepares = 0;
		const workspace = {
			taskId: task.id,
			attemptId: task.attemptId!,
			nodeId: task.nodeId!,
			inputDigest: task.inputDigest,
			baseCommit: task.input.baseCommit,
			path: join(f.dir, "controlled-prepared"),
		};
		(f.fleet as any).node = async (_task: TaskRecord, request: any) => {
			expect(request.action).toBe("prepare");
			prepares++;
			ready();
			await barrier;
			return workspace;
		};
		const pending = f.fleet.start(task.id);
		await entered;
		const original = f.store.task(task.id)!;
		const prepare = f.store.getOperation(task.id, "prepare");
		const other = open(f.db);
		other.enterRollback();
		const refused = disabled(() => pending);
		release();
		await refused;
		expect(prepares).toBe(1);
		expect(f.store.task(task.id)).toEqual({ ...original, workspace });
		expect(f.store.getOperation(task.id, "prepare")).toEqual(prepare);
		expect(intents(f.store, task.id)).toHaveLength(1);
		expect(f.store.getOperation(task.id, "create")).toBeUndefined();
		expect(f.store.getOperation(task.id, "prompt")).toBeUndefined();
		expect(await f.calls("start_session")).toHaveLength(0);
		expect(await f.calls("send_prompt")).toHaveLength(0);
		await disabled(() => f.fleet.start(task.id));
		expect(prepares).toBe(1);
	});

	test("claimed intent reuse remains observational, never a new dispatch", async () => {
		const f = await fixture();
		const task = f.fleet.submit(f.input);
		const payload = { exact: "original prepare" };
		const original = f.store.claimOperation(task.id, "prepare", payload)!;
		const before = f.store.task(task.id);
		f.store.enterRollback();
		expect(f.store.claimOperation(task.id, "prepare", payload)).toBeNull();
		expect(f.store.beginOperation(task.id, "prepare", payload)).toEqual(
			original,
		);
		expect(f.store.task(task.id)).toEqual(before);
		expect(intents(f.store, task.id)).toHaveLength(1);
		expect((await f.state()).calls).toHaveLength(0);
	});

	test("new answer, abort, close and terminal test/stop claims refuse before intent", async () => {
		const f = await fixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const body = {
			sessionId: task.sessionId!,
			turnId: task.turnId!,
			status: "approval_required" as const,
			terminal: false,
			evidence: { controlled: "question pending" },
		};
		f.store.observe(task.id, {
			...body,
			eventId: "question",
			digest: observationDigest(body),
		});
		const before = f.store.task(task.id)!;
		const originalIntents = intents(f.store, task.id);
		const originalCalls = (await f.state()).calls;
		f.store.enterRollback();
		await disabled(() =>
			f.fleet.answer(task.id, {
				questionId: "q",
				answerBinding: "binding",
				answer: "yes",
			}),
		);
		await disabled(() => f.store.claimOperation(task.id, "answer:q", {}));
		await disabled(() => f.fleet.cancel(task.id));
		expect(f.store.task(task.id)).toEqual(before);
		expect(intents(f.store, task.id)).toEqual(originalIntents);
		expect((await f.state()).calls).toEqual(originalCalls);
		const settled = terminal(f.store, task);
		let workspaceCalls = 0;
		(f.fleet as any).node = async () => {
			workspaceCalls++;
			throw new Error("forbidden workspace effect");
		};
		await disabled(() =>
			f.fleet.result(task.id, [process.execPath, "--version"]),
		);
		await disabled(() => f.fleet.stop(task.id));
		expect(workspaceCalls).toBe(0);
		expect(f.store.task(task.id)).toEqual(settled);
		expect(f.store.getOperation(task.id, "verify-test")).toBeUndefined();
		expect(f.store.getOperation(task.id, "stop")).toBeUndefined();
		expect(intents(f.store, task.id)).toEqual(originalIntents);
		expect((await f.state()).calls).toEqual(originalCalls);
	});

	test("original cancellation authority is retained; rollback blocks new abort and close admission", async () => {
		const f = await fixture();
		// Direct store contracts use owned identities without invoking any SDK.
		f.store.putNode({
			...f.node,
			sdkTransport: {
				command: process.execPath,
				args: ["--eval", "throw new Error('must not dispatch')"],
			},
		});
		const task = f.fleet.submit(f.input);
		const workspace = {
			taskId: task.id,
			attemptId: task.attemptId!,
			nodeId: task.nodeId!,
			inputDigest: task.inputDigest,
			baseCommit: task.input.baseCommit,
			path: join(f.dir, "owned-workspace"),
		};
		f.store.claimOperation(task.id, "prepare", workspace);
		f.store.setWorkspace(task.id, workspace);
		const create = f.store.claimOperation(task.id, "create", {
			cwd: workspace.path,
		})!;
		f.store.recordSession(task.id, "owned-session", true, {
			operationId: create.id,
			ephemeral: true,
			cwd: workspace.path,
		});
		const authority = {
			sessionId: "owned-session",
			cwd: workspace.path,
			endpointGeneration: 7,
			endpointIncarnation: "a".repeat(64),
		};
		const authorityIntent = f.store.recordSessionAuthority(task.id, authority);
		f.store.claimOperation(task.id, "prompt", {
			session_id: "owned-session",
			prompt: f.input.prompt,
		});
		f.store.recordTurn(task.id, "owned-turn");
		const body = {
			sessionId: "owned-session",
			turnId: "owned-turn",
			status: "active" as const,
			terminal: false,
			evidence: { controlled: "original active turn" },
		};
		const active = f.store.observe(task.id, {
			...body,
			eventId: "owned-active",
			digest: observationDigest(body),
		});
		// A snapshot copy permits two independent rollback points without deleting
		// the one-way marker or manufacturing a replacement attempt.
		const snapshot = f.store.backup(join(f.dir, "before-cancel.sqlite"));
		const abortBlocked = open(snapshot.path);
		abortBlocked.enterRollback();
		await disabled(() =>
			abortBlocked.admitCancellation(task.id, active, authority),
		);
		expect(abortBlocked.task(task.id)).toEqual(active);
		expect(abortBlocked.getOperation(task.id, "cancel")).toBeUndefined();
		const cancel = f.store.admitCancellation(task.id, active, authority);
		const before = f.store.task(task.id);
		f.store.enterRollback();
		const abort = {
			ok: true,
			result: {
				ok: true,
				selection: "owned",
				turn: "stopped",
				ownedWork: "stopped",
				automaticDelivery: "none",
				resumeOnOwnedCompletion: false,
			},
		};
		// Evidence completion for an already owned operation remains durable.
		f.store.retainCancellationReply(task.id, "abort", abort);
		const originalIntents = intents(f.store, task.id);
		await disabled(() => f.store.claimCancellationClose(task.id, abort));
		expect(f.store.task(task.id)).toEqual(before);
		expect(f.store.getOperation(task.id, "cancel")).toEqual(cancel);
		expect(f.store.getOperation(task.id, "session-authority")).toEqual(
			authorityIntent,
		);
		expect(
			f.store.getOperation(task.id, "cancel-abort-reply")?.payload,
		).toEqual(abort);
		expect(f.store.getOperation(task.id, "cancel-close")).toBeUndefined();
		expect(
			f.store.getOperation(task.id, "cancel-abort-receipt"),
		).toBeUndefined();
		expect(intents(f.store, task.id)).toEqual(originalIntents);
		expect((await f.state()).calls).toHaveLength(0);
	});

	test("read-only endpoint observes exact original turn after rollback, reconciles unknown and backs up", async () => {
		const f = await fixture([
			"gjc_coordinator_read_turn",
			"gjc_coordinator_list_questions",
		]);
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		const originalIntents = intents(f.store, task.id);
		// Exercise the real observation failure path, not a manually retagged
		// generic unknown (which must remain sticky even after a successful poll).
		await f.limitTools([]);
		const unavailable = await f.fleet.inspect(task.id);
		expect(unavailable.task).toMatchObject({
			id: task.id,
			attemptId: task.attemptId,
			sessionId: task.sessionId,
			turnId: task.turnId,
			phase: "blocked_unknown",
			reason: "observation_unavailable_original_attempt_held",
			held: true,
			pollIssued: 1,
		});
		expect(unavailable.publicTurn).toBeUndefined();
		expect(await f.calls("read_turn")).toHaveLength(0);
		expect(await f.calls("list_questions")).toHaveLength(0);
		expect(intents(f.store, task.id)).toEqual(originalIntents);
		// Restore only actual read capabilities before entering local rollback.
		await f.limitTools();
		f.store.enterRollback();
		const observed = await f.fleet.inspect(task.id);
		expect(observed.task).toMatchObject({
			id: task.id,
			attemptId: task.attemptId,
			sessionId: task.sessionId,
			turnId: task.turnId,
			phase: "active",
			held: true,
			pollIssued: 2,
			pollApplied: 2,
		});
		expect(observed.publicTurn).toBeDefined();
		expect(
			f.store.events(task.id).filter((e) => e.kind === "unknown_reconciled"),
		).toHaveLength(1);
		expect(await f.calls("read_turn")).toHaveLength(1);
		expect(await f.calls("list_questions")).toHaveLength(1);
		expect((await f.calls("read_turn"))[0]!.args).toEqual({
			session_id: task.sessionId,
			turn_id: task.turnId,
		});
		expect((await f.calls("list_questions"))[0]!.args).toEqual({
			session_id: task.sessionId,
			turn_id: task.turnId,
			status: "pending",
		});
		const backup = f.store.backup(join(f.dir, "rollback-backup.sqlite"));
		expect(intents(f.store, task.id)).toEqual(originalIntents);
		expect(await f.calls("start_session")).toHaveLength(1);
		expect(await f.calls("send_prompt")).toHaveLength(1);
		expect(backup.bytes).toBeGreaterThan(0);
		const copy = open(backup.path, true);
		expect(copy.task(task.id)).toEqual(observed.task);
		expect(copy.dispatchStatus()).toEqual(f.store.dispatchStatus());
		expect(() => copy.enterRollback()).toThrow();
		expect(() => copy.beginObservation(task.id)).toThrow();
		close(f.store);
		const reopened = open(f.db);
		expect(reopened.task(task.id)).toEqual(observed.task);
		expect(reopened.events(task.id).some((e) => e.kind === "observation")).toBe(
			true,
		);
	});

	for (const missing of [
		"gjc_coordinator_read_turn",
		"gjc_coordinator_list_questions",
	]) {
		test(`missing mandatory ${missing} leaves original held without synthetic evidence`, async () => {
			const f = await fixture(
				["gjc_coordinator_read_turn", "gjc_coordinator_list_questions"].filter(
					(name) => name !== missing,
				),
			);
			const task = await f.fleet.start(f.fleet.submit(f.input).id);
			await f.limitTools();
			const observations = f.store
				.events(task.id)
				.filter((e) => e.kind === "observation");
			f.store.enterRollback();
			const result = await f.fleet.inspect(task.id);
			expect(result.task).toMatchObject({
				id: task.id,
				attemptId: task.attemptId,
				sessionId: task.sessionId,
				turnId: task.turnId,
				held: true,
				phase: "blocked_unknown",
				pollIssued: 1,
			});
			expect(result.questions).toBeUndefined();
			expect(result.task.result?.executionTerminal).not.toBe(true);
			expect(
				f.store.events(task.id).filter((e) => e.kind === "observation"),
			).toEqual(observations);
			expect(await f.calls("start_session")).toHaveLength(1);
			expect(await f.calls("send_prompt")).toHaveLength(1);
		});
	}

	test("incomplete questions never synthesize settlement during rollback observation", async () => {
		const f = await fixture();
		const task = await f.fleet.start(f.fleet.submit(f.input).id);
		await f.update({ terminal: true, questionsComplete: false });
		const previousCalls = (await f.calls("send_prompt")).length;
		f.store.enterRollback();
		const result = await f.fleet.inspect(task.id);
		expect(result.task).toMatchObject({
			id: task.id,
			attemptId: task.attemptId,
			sessionId: task.sessionId,
			turnId: task.turnId,
			held: true,
			phase: "blocked_unknown",
		});
		expect(result.task.result?.executionTerminal).not.toBe(true);
		expect(await f.calls("send_prompt")).toHaveLength(previousCalls);
	});

	test("no original SID remains held without any transport or replacement attempt", async () => {
		const f = await fixture();
		const task = f.fleet.submit(f.input);
		f.store.markUnknown(task.id, "original_create_response_lost");
		const before = f.store.task(task.id)!;
		f.store.enterRollback();
		expect((await f.fleet.inspect(task.id)).task).toEqual(before);
		expect(await f.fleet.start(task.id)).toEqual(before);
		expect((await f.state()).calls).toHaveLength(0);
	});

	test("CLI rollback is durable/idempotent, while physical read-only refuses before mutation", async () => {
		const f = await fixture();
		const task = f.fleet.submit(f.input);
		const before = f.store.task(task.id);
		const refusal = await cli(f.db, "--read-only", "rollback");
		expect(refusal.exit).toBe(1);
		expect(refusal.stderr).toContain("READ_ONLY");
		expect(markerCount(f.db)).toBe(0);
		for (let i = 0; i < 2; i++) {
			const result = await cli(f.db, "rollback");
			expect(result.exit).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				disabled: true,
				remoteFence: false,
				olderSnapshotsAndWriters: "not_proven_safe",
			});
		}
		expect(markerCount(f.db)).toBe(1);
		expect(f.store.task(task.id)).toEqual(before);
		expect((await f.state()).calls).toHaveLength(0);
		const view = await cli(f.db, "--read-only", "show", task.id);
		expect(view.exit).toBe(0);
		expect(JSON.parse(view.stdout)).toMatchObject({
			id: task.id,
			attemptId: task.attemptId,
			held: true,
		});
	});
});
