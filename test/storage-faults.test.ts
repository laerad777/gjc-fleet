import { expect, test } from "bun:test";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { FleetStore } from "../src/store";

const storeModule = new URL("../src/store.ts", import.meta.url).href;

function input(key: string): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "storage-fault-owner",
		repoId: "owned-repo",
		baseCommit: "a".repeat(40),
		prompt: "PRIVATE_STORAGE_FAULT_PROMPT: local SQLite test only",
		required: { nodeId: "owned-node", operations: ["prepare", "create"] },
	};
}

function node(root: string): NodeConfig {
	return {
		id: "owned-node",
		os: process.platform,
		arch: process.arch,
		roots: { "owned-repo": root },
		workspaceRoot: root,
		maxConcurrency: 2,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: ["prepare", "create"],
		// Configuration only: no test invokes a transport or SDK.
		transport: { command: process.execPath, args: [] },
	};
}

async function bounded<T>(
	promise: Promise<T>,
	milliseconds: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Owned child deadline exceeded")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function ownedChild(program: string, deadline: number) {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`setTimeout(() => process.exit(73), ${deadline});\n${program}\nsetInterval(() => {}, 1000);`,
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	// Drain diagnostics without publishing child payloads or prompting pipe backpressure.
	const diagnostics = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	return {
		child,
		async ready(): Promise<string> {
			return await bounded(
				(async () => {
					while (!pending.includes("\n")) {
						const chunk = await reader.read();
						if (chunk.done) throw new Error("Owned child exited before READY");
						pending += decoder.decode(chunk.value, { stream: true });
						if (pending.length > 65536)
							throw new Error("Owned child handshake exceeds bound");
					}
					const end = pending.indexOf("\n");
					const line = pending.slice(0, end);
					pending = pending.slice(end + 1);
					return line;
				})(),
				2000,
			);
		},
		async stop(): Promise<number> {
			// Only this fresh Bun child handle is ever killed; no PID/tree lookup.
			if (child.exitCode === null) child.kill("SIGKILL");
			const exitCode = await bounded(child.exited, 2000);
			// Keep stdout open throughout the lock protocol; cancel only after exit.
			await reader.cancel();
			await bounded(diagnostics, 500);
			return exitCode;
		},
	};
}

function caught(action: () => unknown): unknown {
	try {
		action();
		return undefined;
	} catch (error) {
		return error;
	}
}

function expectSqliteFault(error: unknown, code: string, errno: number): void {
	expect(error).toBeInstanceOf(SQLiteError);
	expect((error as SQLiteError).code).toBe(code);
	expect((error as SQLiteError).errno).toBe(errno);
}

function assertPrivateAudits(store: FleetStore, taskId: string): void {
	expect(JSON.stringify(store.events(taskId))).not.toContain(
		"PRIVATE_STORAGE_FAULT",
	);
}

// Real SQLite writer contention. The configured 10000ms busy wait is not a
// throughput/durability measurement, and no elapsed-time attribution is asserted.
test("actual competing writer returns SQLITE_BUSY without partial admission", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-storage-busy-"));
	const path = join(root, "fleet.sqlite");
	let store: FleetStore | undefined;
	let writer: ReturnType<typeof ownedChild> | undefined;
	try {
		store = new FleetStore(path, 2);
		store.putNode(node(root));
		const held = store.reserve(store.submit(input("held-before-busy")).id);
		const prepare = store.beginOperation(held.id, "prepare", {
			repository: "owned-repo",
		});
		const queued = store.submit(input("queued-before-busy"));
		const before = store.tasks();
		const beforeEvents = store.events(queued.id);
		writer = ownedChild(
			`
			const { Database } = await import("bun:sqlite");
			const db = new Database(${JSON.stringify(path)}, { strict: true });
			globalThis.ownedWriterDatabase = db;
			db.exec("BEGIN IMMEDIATE");
			const report = (ready) => process.stdout.write(JSON.stringify({ ready, inTransaction: db.inTransaction }) + "\\n");
			process.stdin.on("data", () => report("STATUS"));
			report("READY");
		`,
			13500,
		);
		const ready = JSON.parse(await writer.ready());
		expect(ready).toEqual({ ready: "READY", inTransaction: true });
		expect(writer.child.exitCode).toBeNull();
		const failure = caught(() => store!.reserve(queued.id));
		writer.child.stdin.write("STATUS\n");
		await writer.child.stdin.flush();
		const status = JSON.parse(await writer.ready());
		expect(status).toEqual({ ready: "STATUS", inTransaction: true });
		expect(writer.child.exitCode).toBeNull();
		expectSqliteFault(failure, "SQLITE_BUSY", 5);
		expect(store.tasks()).toEqual(before);
		expect(store.events(queued.id)).toEqual(beforeEvents);
		expect(store.getOperation(held.id, "prepare")).toEqual(prepare);
		expect(store.getOperation(held.id, "create")).toBeUndefined();
		expect(store.getOperation(queued.id, "prepare")).toBeUndefined();
		expect(store.task(held.id)?.held).toBe(true);
		assertPrivateAudits(store, held.id);
		assertPrivateAudits(store, queued.id);
		expect(writer.child.exitCode).toBeNull();
		const exitCode = await writer.stop();
		expect(typeof exitCode).toBe("number");
		expect(exitCode).not.toBe(73);
		// Once only our competing writer is gone, the original queued task admits.
		const admitted = store.reserve(queued.id);
		expect(admitted.id).toBe(queued.id);
		expect(admitted.held).toBe(true);
		expect(admitted.attemptId).toBeDefined();
	} finally {
		try {
			if (writer) await writer.stop();
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
}, 15000);

// Pager capacity injection, not physical disk exhaustion or fsync assurance.
test("SQLite capacity full preserves tasks, intents, held slots and original SQLITE_FULL", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-storage-full-"));
	const path = join(root, "fleet.sqlite");
	let store: FleetStore | undefined;
	let db: Database | undefined;
	let capacity: number | undefined;
	try {
		store = new FleetStore(path, 2);
		store.putNode(node(root));
		const held = store.reserve(store.submit(input("held-before-full")).id);
		const prepare = store.beginOperation(held.id, "prepare", {
			repository: "owned-repo",
		});
		const before = store.tasks();
		const beforeCriticalEvents = store
			.events(held.id)
			.filter((event) =>
				["reserved", "operation_intent", "released"].includes(event.kind),
			);
		// Deliberately access only this owned connection for pager fault injection
		// and post-fault integrity inspection, never as a production API workaround.
		db = (store as any).db as Database;
		capacity = db
			.query<{ max_page_count: number }, []>("PRAGMA max_page_count")
			.get()!.max_page_count;
		const pages = db
			.query<{ page_count: number }, []>("PRAGMA page_count")
			.get()!.page_count;
		const pageSize = db
			.query<{ page_size: number }, []>("PRAGMA page_size")
			.get()!.page_size;
		db.exec(`PRAGMA max_page_count=${pages}`);
		const largeInput = input("must-not-appear-after-full");
		largeInput.prompt = "PRIVATE_STORAGE_FAULT_FULL:" + "x".repeat(240 * 1024);
		expect(Buffer.byteLength(largeInput.prompt)).toBeGreaterThan(pageSize * 2);
		// Both failures are retained, even if rollback masks the original error.
		const submitFailure = caught(() => store!.submit(largeInput));
		const operationFailure = caught(() =>
			store!.beginOperation(held.id, "create", {
				request: "PRIVATE_STORAGE_FAULT_PAYLOAD:" + "x".repeat(240 * 1024),
			}),
		);
		db.exec(`PRAGMA max_page_count=${capacity}`);
		expect(store.tasks()).toEqual(before);
		expect(store.getOperation(held.id, "prepare")).toEqual(prepare);
		expect(store.getOperation(held.id, "create")).toBeUndefined();
		expect(store.task(held.id)?.held).toBe(true);
		expect(
			store
				.events(held.id)
				.filter((event) =>
					["reserved", "operation_intent", "released"].includes(event.kind),
				),
		).toEqual(beforeCriticalEvents);
		assertPrivateAudits(store, held.id);
		expect(
			db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all(),
		).toEqual([{ integrity_check: "ok" }]);
		const recovered = store.submit(largeInput);
		expect(recovered.input).toEqual(largeInput);
		expect(store.tasks().length).toBe(before.length + 1);
		expect(store.task(held.id)).toEqual(before[0]);
		// Do not accept SQLITE_ERROR from an unconditional ROLLBACK after an
		// SQLite auto-abort: callers must receive the original capacity fault.
		expectSqliteFault(submitFailure, "SQLITE_FULL", 13);
		expectSqliteFault(operationFailure, "SQLITE_FULL", 13);
	} finally {
		try {
			if (db && capacity !== undefined)
				db.exec(`PRAGMA max_page_count=${capacity}`);
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

// Committed WAL recovery after terminating our local Bun process only. This is
// not power-loss durability, a remote acknowledgement, or a crashed GJC/SDK test.
test("owned process crash retains committed WAL attempt and suppresses re-dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-storage-crash-"));
	const path = join(root, "fleet.sqlite");
	let child: ReturnType<typeof ownedChild> | undefined;
	let store: FleetStore | undefined;
	try {
		const taskInput = input("crash-original-key");
		const preparePayload = {
			repository: "owned-repo",
			baseCommit: taskInput.baseCommit,
		};
		const createPayload = {
			request: "PRIVATE_STORAGE_FAULT_CREATE: local intent only",
		};
		child = ownedChild(
			`
			const { FleetStore } = await import(${JSON.stringify(storeModule)});
			const store = new FleetStore(${JSON.stringify(path)}, 2);
			store.putNode(${JSON.stringify(node(root))});
			const task = store.reserve(store.submit(${JSON.stringify(taskInput)}).id);
			const prepare = store.beginOperation(task.id, "prepare", ${JSON.stringify(preparePayload)});
			const create = store.beginOperation(task.id, "create", ${JSON.stringify(createPayload)});
			// All public method calls committed before any READY bytes are emitted.
			process.stdout.write(JSON.stringify({ ready: "READY", task: store.task(task.id), prepare, create }) + "\\n");
		`,
			4000,
		);
		const line = await child.ready();
		const committed = JSON.parse(line);
		expect(committed.ready).toBe("READY");
		// A live WAL with frames exists before killing, not merely a clean close.
		expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
		expect(child.child.exitCode).toBeNull();
		const exitCode = await child.stop();
		// Bun's actual exit result is captured without POSIX-only signal formatting.
		expect(typeof exitCode).toBe("number");
		expect(exitCode).not.toBe(0);
		expect(exitCode).not.toBe(73);
		expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
		store = new FleetStore(path, 2);
		expect(store.tasks()).toEqual([committed.task]);
		expect(store.task(committed.task.id)).toEqual(committed.task);
		expect(committed.task.input).toEqual(taskInput);
		expect(committed.task.held).toBe(true);
		expect(committed.task.phase).toBe("dispatching");
		expect(committed.task.attemptId).toBe(committed.create.attemptId);
		expect(store.getOperation(committed.task.id, "prepare")).toEqual(
			committed.prepare,
		);
		expect(store.getOperation(committed.task.id, "create")).toEqual(
			committed.create,
		);
		const beforeClaims = store
			.events(committed.task.id)
			.filter((event) => event.kind === "operation_intent");
		expect(beforeClaims.length).toBe(2);
		expect(
			store.claimOperation(committed.task.id, "prepare", preparePayload),
		).toBeNull();
		expect(
			store.claimOperation(committed.task.id, "create", createPayload),
		).toBeNull();
		expect(store.submit(taskInput)).toEqual(committed.task);
		expect(store.reserve(committed.task.id)).toEqual(committed.task);
		expect(store.tasks()).toEqual([committed.task]);
		expect(store.getOperation(committed.task.id, "create")).toEqual(
			committed.create,
		);
		expect(
			store
				.events(committed.task.id)
				.filter((event) => event.kind === "operation_intent"),
		).toEqual(beforeClaims);
		expect(
			store
				.events(committed.task.id)
				.some((event) => event.kind === "released"),
		).toBe(false);
		assertPrivateAudits(store, committed.task.id);
	} finally {
		try {
			if (child) await child.stop();
		} finally {
			store?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
});

// Controlled native CHECK auto-abort during schema initialization, not natural
// production input, constructor SQLITE_FULL, physical I/O exhaustion or power loss.
test("constructor preserves native CHECK auto-abort error identity and closes the failed connection", async () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-storage-constructor-"));
	const path = join(root, "fleet.sqlite");
	let child: ReturnType<typeof ownedChild> | undefined;
	let inspection: Database | undefined;
	let recovered: FleetStore | undefined;
	try {
		child = ownedChild(
			`
			const { Database, SQLiteError } = await import("bun:sqlite");
			const { FleetStore } = await import(${JSON.stringify(storeModule)});
			const originalQuery = Database.prototype.query;
			let hits = 0;
			let primary;
			let observed;
			let faultDatabase;
			let inTransactionAtFault;
			let unexpectedStore;
			let connectionClosed = false;
			const describe = (error) => error ? { name: error.name, code: error.code, errno: error.errno, native: error instanceof SQLiteError } : null;
			try {
				Database.prototype.query = function(sql, ...args) {
					if (hits === 0 && sql === "INSERT OR IGNORE INTO fleet_meta VALUES (1,2,?)") {
						hits++;
						faultDatabase = this;
						try {
							originalQuery.call(this, "INSERT OR ROLLBACK INTO fleet_meta VALUES (0,2,2)").run();
						} catch (error) {
							primary = error;
							inTransactionAtFault = this.inTransaction;
							throw error;
						}
					}
					return originalQuery.call(this, sql, ...args);
				};
				try { unexpectedStore = new FleetStore(${JSON.stringify(path)}, 2); }
				catch (error) { observed = error; }
			} finally {
				Database.prototype.query = originalQuery;
				unexpectedStore?.close();
			}
			try {
				if (faultDatabase) originalQuery.call(faultDatabase, "SELECT 1").get();
			} catch { connectionClosed = true; }
			finally {
				// Cleanup only this child's exact connection if constructor cleanup regresses.
				if (faultDatabase && !connectionClosed) faultDatabase.close();
			}
			process.stdout.write(JSON.stringify({ ready: "READY", hits,
				primary: describe(primary), observed: describe(observed),
				sameErrorIdentity: primary !== undefined && observed === primary,
				inTransactionAtFault, connectionClosed,
				prototypeRestored: Database.prototype.query === originalQuery }) + "\\n");
		`,
			4000,
		);
		const proof = JSON.parse(await child.ready());
		expect(proof).toEqual({
			ready: "READY",
			hits: 1,
			primary: {
				name: "SQLiteError",
				code: "SQLITE_CONSTRAINT_CHECK",
				errno: 275,
				native: true,
			},
			observed: {
				name: "SQLiteError",
				code: "SQLITE_CONSTRAINT_CHECK",
				errno: 275,
				native: true,
			},
			sameErrorIdentity: true,
			inTransactionAtFault: false,
			connectionClosed: true,
			prototypeRestored: true,
		});
		expect(child.child.exitCode).toBeNull();
		const exitCode = await child.stop();
		expect(typeof exitCode).toBe("number");
		expect(exitCode).not.toBe(73);
		inspection = new Database(path, { strict: true, create: false });
		expect(inspection.query("PRAGMA integrity_check").all()).toEqual([
			{ integrity_check: "ok" },
		]);
		expect(
			inspection
				.query(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
				)
				.all(),
		).toEqual([]);
		expect(inspection.query("PRAGMA application_id").get()).toEqual({
			application_id: 0,
		});
		expect(inspection.query("PRAGMA user_version").get()).toEqual({
			user_version: 0,
		});
		inspection.close();
		inspection = undefined;
		// New normal initialization of this same owned path, not effect replay.
		recovered = new FleetStore(path, 2);
		expect(recovered.tasks()).toEqual([]);
		expect(recovered.nodes()).toEqual([]);
	} finally {
		try {
			if (child) await child.stop();
		} finally {
			inspection?.close();
			recovered?.close();
			rmSync(root, { recursive: true, force: true });
		}
	}
});
