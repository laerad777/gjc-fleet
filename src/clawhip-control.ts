#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { canonicalJson, digest, receiptlessUnverifiable } from "./core";
import type { TaskRecord } from "./contracts";
import { Fleet, retainedResult } from "./fleet";
import { FleetStore } from "./store";
import { isRoleTask } from "./work-unit";

export interface ControlBinding {
	taskId: string;
	taskKey: string;
	inputDigest: string;
	attemptId: string;
	sessionId: string | null;
	turnId: string | null;
}
export interface ControlCommand {
	schema: 1;
	thread: string;
	key: string;
	action: "start" | "inspect" | "collect";
	binding: ControlBinding;
	testArgv: string[] | null;
}
export interface ControlPolicy { thread: string; fleetDb: string }
export type ControlExecutor = Pick<Fleet, "start" | "inspect" | "result">;
type State = "staged" | "pending" | "claimed" | "done" | "unknown";
type Row = { key: string; ref: string; command: string; state: State; receipt: string | null; error: string | null };
type Owner = { task_id: string; binding: string; start_key: string };
export interface ControlReceipt {
	command_ref: string;
	command: ControlCommand;
	state: State;
	status: "staged" | "pending" | "done" | "unknown_no_replay";
	receipt: unknown;
	error: string | null;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}(?![\s\S])/;
const HEX = /^[a-f0-9]{64}(?![\s\S])/;
function check(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message);
}
function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.test(value) && !value.includes("\n");
}
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
	check(value !== null && typeof value === "object" && !Array.isArray(value), "Expected object");
	check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, "Expected plain object");
	const own = Reflect.ownKeys(value);
	check(own.length === fields.length && own.every(key => typeof key === "string" && fields.includes(key)), "Unexpected fields");
	check(fields.every(key => "value" in Object.getOwnPropertyDescriptor(value, key)!), "Accessors forbidden");
}
export function validateControlCommand(value: unknown, thread: string): asserts value is ControlCommand {
	exact(value, ["schema", "thread", "key", "action", "binding", "testArgv"]);
	check(value.schema === 1 && value.thread === thread, "Wrong thread or schema");
	check(matches(value.key, ID), "Invalid command key");
	check(["start", "inspect", "collect"].includes(value.action as string), "Invalid action");
	exact(value.binding, ["taskId", "taskKey", "inputDigest", "attemptId", "sessionId", "turnId"]);
	for (const field of ["taskId", "taskKey", "attemptId"]) check(matches(value.binding[field], ID), "Invalid binding");
	check(matches(value.binding.inputDigest, HEX), "Invalid input digest");
	for (const field of ["sessionId", "turnId"]) check(value.binding[field] === null || matches(value.binding[field], ID), "Invalid execution identifier");
	check(value.binding.turnId === null || value.binding.sessionId !== null, "Turn without session");
	if (value.action === "collect") {
		check(Array.isArray(value.testArgv) && value.testArgv.length > 0 && value.testArgv.length <= 64 && value.testArgv.every(arg => typeof arg === "string" && arg.length > 0 && arg.length <= 4096 && !arg.includes("\0")), "Explicit verifier argv required");
	} else check(value.testArgv === null, "Verifier only allowed for collect");
	check(Buffer.byteLength(canonicalJson(value)) <= 32768, "Command too large");
}
export function controlBinding(task: TaskRecord): ControlBinding {
	check(task.attemptId && task.nodeSnapshot, "Task needs an admitted Fleet attempt");
	return { taskId: task.id, taskKey: task.input.key, inputDigest: task.inputDigest, attemptId: task.attemptId, sessionId: task.sessionId ?? null, turnId: task.turnId ?? null };
}
function same(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }
function regular(path: string): void {
	const stat = lstatSync(path);
	check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, "Unsafe database file");
}
function databasePath(path: string, create = false): string {
	check(isAbsolute(path) && resolve(path) === path && realpathSync(dirname(path)) === dirname(path), "Canonical absolute database path required");
	if (create) {
		// Exclusive creation prevents adopting an unrelated database during init.
		closeSync(openSync(path, "wx", 0o600));
	}
	regular(path);
	for (const suffix of ["-wal", "-shm", "-journal"]) {
		try { regular(path + suffix); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	return path;
}
function decode(row: Row): ControlReceipt {
	return { command_ref: row.ref, command: JSON.parse(row.command), state: row.state, status: row.state === "claimed" || row.state === "unknown" ? "unknown_no_replay" : row.state, receipt: row.receipt === null ? null : JSON.parse(row.receipt), error: row.error };
}

/** Local trusted supervisor stages commands; the subscription can only ingest their digest references.
 * The SQLite file is a private authority store, not an untrusted remote command endpoint. */
export class ClawhipControl {
	private readonly db: Database;
	readonly policy: Readonly<ControlPolicy>;
	constructor(path: string, policy: ControlPolicy, initialize = false) {
		check(matches(policy.thread, /^[0-9]{1,32}(?![\s\S])/), "Invalid allowed thread");
		databasePath(policy.fleetDb);
		check(path !== policy.fleetDb, "Control and Fleet databases must differ");
		databasePath(path, initialize);
		this.policy = Object.freeze({ thread: policy.thread, fleetDb: policy.fleetDb });
		this.db = new Database(path, { create: false, strict: true });
		try {
			this.db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
			if (initialize) {
				this.db.exec(`PRAGMA journal_mode=DELETE;
					CREATE TABLE policy (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL) STRICT;
					CREATE TABLE owners (task_id TEXT PRIMARY KEY, binding TEXT NOT NULL, start_key TEXT NOT NULL UNIQUE) STRICT;
					CREATE TABLE commands (key TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, command TEXT NOT NULL,
					 state TEXT NOT NULL CHECK(state IN ('staged','pending','claimed','done','unknown')), receipt TEXT, error TEXT) STRICT;`);
				this.db.query("INSERT INTO policy VALUES(1,?)").run(canonicalJson(this.policy));
			}
			const saved = this.db.query("SELECT data FROM policy WHERE id=1").get() as { data: string } | null;
			check(saved && saved.data === canonicalJson(this.policy), "Control policy mismatch");
		} catch (error) { this.db.close(); throw error; }
	}
	close(): void { this.db.close(); }
	private row(key: string): Row | null {
		check(matches(key, ID), "Invalid command key");
		return this.db.query("SELECT * FROM commands WHERE key=?").get(key) as Row | null;
	}
	private owner(taskId: string): Owner {
		const owner = this.db.query("SELECT * FROM owners WHERE task_id=?").get(taskId) as Owner | null;
		check(owner, "Task not owned by this thread adapter");
		return owner;
	}
	private task(binding: ControlBinding, store: Pick<FleetStore, "task">): TaskRecord {
		const task = store.task(binding.taskId);
		check(task, "Original task missing");
		const current = controlBinding(task);
		for (const field of ["taskId", "taskKey", "inputDigest", "attemptId"] as const) check(current[field] === binding[field], "Original Fleet attempt mismatch");
		for (const field of ["sessionId", "turnId"] as const) check(binding[field] === null || current[field] === binding[field], "Original execution mismatch");
		return task;
	}
	/** Only fills previously unknown identifiers from the original Fleet attempt. Never retargets. */
	binding(taskId: string, store: Pick<FleetStore, "task">): ControlBinding {
		return this.db.transaction(() => {
			const owner = this.owner(taskId);
			const original: ControlBinding = JSON.parse(owner.binding);
			const current = controlBinding(this.task(original, store));
			this.db.query("UPDATE owners SET binding=? WHERE task_id=?").run(canonicalJson(current), taskId);
			return current;
		}).immediate();
	}
	stage(value: unknown, store: Pick<FleetStore, "task" | "deferTerminalRelease">): ControlReceipt {
		validateControlCommand(value, this.policy.thread);
		// Snapshot before any await or persistence; callers cannot mutate the staged authority.
		const command: ControlCommand = JSON.parse(canonicalJson(value));
		const ref = digest(command);
		return this.db.transaction(() => {
			const existing = this.row(command.key);
			if (existing) {
				check(existing.ref === ref, "Command key content conflict");
				return decode(existing);
			}
			const task = this.task(command.binding, store);
			check(same(controlBinding(task), command.binding), "Exact current binding required");
			if (command.action === "start") {
				check(!task.sessionId && !task.turnId && !task.workspace && !task.result && task.phase === "preparing", "Start requires untouched admitted task");
				check(!this.db.query("SELECT task_id FROM owners WHERE task_id=?").get(task.id), "Task already has a start command; replay prohibited");
				this.db.query("INSERT INTO owners VALUES(?,?,?)").run(task.id, canonicalJson(command.binding), command.key);
			} else {
				check(same(this.binding(task.id, store), command.binding), "Original binding required");
				if (command.action === "collect") this.collectable(task, store.deferTerminalRelease === true);
			}
			this.db.query("INSERT INTO commands(key,ref,command,state) VALUES(?,?,?,'staged')").run(command.key, ref, canonicalJson(command));
			return decode(this.row(command.key)!);
		}).immediate();
	}
	/** Exactly the scalar projection supplied by Clawhip; no execution or Fleet DB opening. */
	ingest(value: unknown): { type: "fleet.control.accepted"; payload: { command_ref: string; message: string } } {
		exact(value, ["command_ref"]);
		check(matches(value.command_ref, HEX), "Invalid command reference");
		const ref = value.command_ref;
		this.db.transaction(() => {
			const row = this.db.query("SELECT * FROM commands WHERE ref=?").get(ref) as Row | null;
			check(row, "Unstaged command reference");
			const command = JSON.parse(row.command);
			validateControlCommand(command, this.policy.thread);
			check(digest(command) === ref && command.key === row.key, "Stored command digest mismatch");
			this.db.query("UPDATE commands SET state='pending' WHERE ref=? AND state='staged'").run(ref);
		}).immediate();
		// No reserved/sensitive keys, session selectors or prompts in subscription output.
		return { type: "fleet.control.accepted", payload: { command_ref: ref, message: ref } };
	}
	snapshot(key: string): ControlReceipt | null { const row = this.row(key); return row ? decode(row) : null; }
	/** In deferTerminalRelease mode a settled attempt keeps its reservation until resource
	 * return, so held alone does not mean unsettled there; executionTerminal is the proof. */
	private collectable(task: TaskRecord, deferTerminalRelease: boolean): void {
		const owner = this.owner(task.id);
		check(this.row(owner.start_key)?.state === "done", "Unknown start held; observation only");
		const unresolved = this.db.query("SELECT key FROM commands WHERE json_extract(command,'$.binding.taskId')=? AND json_extract(command,'$.action')!='inspect' AND state IN ('claimed','unknown')").get(task.id);
		check(!unresolved && (!task.held || deferTerminalRelease) && task.sessionId && task.turnId && task.result?.executionTerminal, "Unsettled execution; observation only");
		// Deterministic refusal up front: a receipt-less settlement is never verified.
		check(!receiptlessUnverifiable(task.result), "Execution ended without a runtime receipt; never verified");
		// Work-unit R10: collect always tests; a role task is refused here, before any claim, never left unknown.
		check(!isRoleTask(task), "Role task: collect it with `fleet result TASK_ID` (no tests); never through clawhip collect");
	}
	/** One bounded invocation, no background loop and no replay, even under a different key.
	 * Timeout cannot cancel a possibly forwarded Fleet operation: late results are ignored. */
	async run(key: string, store: Pick<FleetStore, "task" | "getOperation" | "deferTerminalRelease">, executor: ControlExecutor, timeoutMs = 30000): Promise<ControlReceipt> {
		check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 120000, "Invalid execution timeout");
		const prior = this.row(key);
		if (prior && ["claimed", "unknown"].includes(prior.state)) {
			const command: ControlCommand = JSON.parse(prior.command);
			validateControlCommand(command, this.policy.thread);
			check(digest(command) === prior.ref, "Stored command digest mismatch");
			if (command.action === "collect") {
				const task = this.task(command.binding, store);
				check(same(controlBinding(task), command.binding), "Stale command binding");
				check(this.row(this.owner(task.id).start_key)?.state === "done", "Unknown start held; observation only");
				try {
					// Use Fleet's cache-only reader, never an executor callback that could replay effects.
					const receipt = retainedResult(task, command.testArgv!, store.getOperation(task.id, "result-test"), store.deferTerminalRelease);
					const encoded = JSON.stringify(receipt);
					check(Buffer.byteLength(encoded) <= 1024 * 1024, "Receipt oversized");
					this.db.query("UPDATE commands SET receipt=? WHERE key=? AND state IN ('claimed','unknown')").run(encoded, key);
				} catch { /* Missing or conflicting durable proof keeps the historical unknown fence. */ }
			}
			return this.snapshot(key)!;
		}
		const claim = this.db.transaction(() => {
			const row = this.row(key);
			check(row, "Unknown command key");
			if (row.state !== "pending") return { row, execute: false };
			const command: ControlCommand = JSON.parse(row.command);
			validateControlCommand(command, this.policy.thread);
			check(digest(command) === row.ref, "Stored command digest mismatch");
			const task = this.task(command.binding, store);
			check(same(this.binding(task.id, store), command.binding), "Stale command binding");
			if (command.action === "start") {
				check(this.owner(task.id).start_key === key && !task.sessionId && !task.turnId && !task.workspace && task.phase === "preparing", "Start no longer safe");
			} else if (command.action === "collect") this.collectable(task, store.deferTerminalRelease === true);
			const busy = this.db.query("SELECT key FROM commands WHERE json_extract(command,'$.binding.taskId')=? AND json_extract(command,'$.action')!='inspect' AND state='claimed'").get(task.id);
			// An interrupted/active mutation permits observation only, never another mutation.
			check(!busy || command.action === "inspect", "Original operation unresolved");
			this.db.query("UPDATE commands SET state='claimed' WHERE key=? AND state='pending'").run(key);
			return { row, execute: true };
		}).immediate();
		if (!claim.execute) return decode(claim.row);
		const command: ControlCommand = JSON.parse(claim.row.command);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const receipt = await Promise.race([
				Promise.resolve().then((): Promise<unknown> => command.action === "start" ? executor.start(command.binding.taskId) : command.action === "inspect" ? executor.inspect(command.binding.taskId) : executor.result(command.binding.taskId, command.testArgv!)),
				new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Execution deadline; observation only")), timeoutMs); }),
			]);
			const task = this.task(command.binding, store);
			this.binding(task.id, store);
			check(command.action === "inspect" || !["blocked_unknown", "cancel_unknown"].includes(task.phase), "Fleet outcome unknown; observation only");
			check(command.action !== "start" || (task.sessionId && task.turnId), "Start identifiers unavailable; observation only");
			const encoded = JSON.stringify(receipt);
			check(encoded !== undefined && Buffer.byteLength(encoded) <= 1024 * 1024, "Receipt unavailable or oversized");
			this.db.query("UPDATE commands SET state='done',receipt=? WHERE key=? AND state='claimed'").run(encoded, key);
		} catch {
			// Never persist callback error text that might contain credentials or prompts.
			this.db.query("UPDATE commands SET state='unknown',error='Outcome unknown; replay prohibited, observation only' WHERE key=? AND state='claimed'").run(key);
		} finally { if (timer !== undefined) clearTimeout(timer); }
		return this.snapshot(key)!;
	}
}

async function stdinJson(cap: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		check(size <= cap, "Input exceeds limit");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Explicit local entrypoint. No listener, service activation, node admission, or auto-approval. */
export async function clawhipControlCli(args: string[]): Promise<void> {
	const [mode, dbPath, fleetDb, thread, key, timeout] = args;
	check(["init", "stage", "ingest", "run", "show", "binding"].includes(mode!) && dbPath && fleetDb && thread, "Usage: clawhip-control.ts init|stage|ingest|run|show|binding CONTROL_DB FLEET_DB THREAD [KEY_OR_TASK_ID] [TIMEOUT_MS]");
	check(args.length === (mode === "run" ? (timeout === undefined ? 5 : 6) : mode === "show" || mode === "binding" ? 5 : 4), "Unexpected arguments");
	const control = new ClawhipControl(dbPath, { thread, fleetDb }, mode === "init");
	let store: FleetStore | undefined;
	let fleet: Fleet | undefined;
	try {
		let result: unknown;
		if (mode === "init") result = { initialized: true };
		else if (mode === "ingest") result = control.ingest(await stdinJson(4096));
		else if (mode === "show") result = control.snapshot(key!);
		else {
			store = new FleetStore(fleetDb, 2, { readOnly: mode !== "run" });
			if (mode === "binding") result = control.binding(key!, store);
			else if (mode === "stage") result = control.stage(await stdinJson(32768), store);
			else {
				fleet = new Fleet(store);
				result = await control.run(key!, store, fleet, timeout === undefined ? 30000 : Number(timeout));
			}
		}
		process.stdout.write(JSON.stringify(result) + "\n");
	} finally { await fleet?.close(); store?.close(); control.close(); }
}
if (import.meta.main) {
	try { await clawhipControlCli(process.argv.slice(2)); }
	catch { process.stderr.write("Fleet control rejected\n"); process.exitCode = 1; }
}
