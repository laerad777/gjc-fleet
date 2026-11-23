// Review 7ce0a1da L-1: the stdout reports of `migrate results --apply` (failed[].message) and `results check`
// (rows[].problem) print Fleet's code and fixed text only, never text taken from the error. Both cases run the real
// CLI in its own process against a store with a real fault and parse its stdout. The tests after the first two (review
// 50b85191 F-1/F-2) drive each failure class through the real migrateResults/resultInventory catch, with real SQLite
// faults where one exists and injected thrown values for the rest.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, FleetError } from "../src/core";
import { FleetStore } from "../src/store";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dirs: string[] = [];
const locked: string[] = [];
afterEach(() => {
	for (const dir of locked.splice(0)) chmodSync(dir, 0o700);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "result-store-report-text-"));
	dirs.push(dir);
	return join(dir, "fleet.sqlite");
}
const node = {
	id: "node", os: "linux", arch: "arm64", roots: { repo: "/repos/repo" }, workspaceRoot: "/work", maxConcurrency: 4,
	enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"],
	transport: { command: "gjc", args: ["acp"] }, operations: ["read", "write"],
};
const input = (key: string) => ({ schemaVersion: 1, key, caller: "actor", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} });
function running(store: FleetStore, key: string): string {
	store.putNode(node as any);
	const task = store.reserve(store.submit(input(key) as any).id)!;
	store.recordSession(task.id, `session-${key}`);
	store.recordTurn(task.id, `turn-${key}`);
	return task.id;
}
const enable = (store: FleetStore) => store.enableResultStore({ actor: "tester", reason: "report text test" });
function rowOf(path: string, id: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string }).data;
	} finally {
		db.close();
	}
}
function cli(path: string, ...args: string[]): { exit: number; stdout: string; report: any } {
	const run = Bun.spawnSync([process.execPath, CLI, "--db", path, ...args], { stdout: "pipe", stderr: "pipe" });
	const stdout = run.stdout.toString();
	return { exit: run.exitCode, stdout, report: JSON.parse(stdout) };
}

// chmod cannot make a directory unwritable for root, and has no such effect on Windows.
const unwritable = process.platform === "win32" || process.getuid?.() === 0;

test.skipIf(unwritable)("migrate results --apply: an OS write failure is reported with code and fixed text, without the OS error text or path", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	const id = running(store, "legacy");
	store.saveResult(id, { patch: "m".repeat(5000), status: "verified" });
	enable(store);
	store.close();
	const before = rowOf(path, id);
	// A plain result directory the process cannot create entries in: publishing the blob fails with an OS error
	// (EACCES, naming the path) inside the migration transaction.
	const results = `${path}.results`;
	mkdirSync(results, { mode: 0o700 });
	chmodSync(results, 0o500);
	locked.push(results);
	const run = cli(path, "migrate", "results", "--apply");
	expect(run.exit).toBe(1);
	expect(run.report).toMatchObject({ ok: false, dryRun: false, externalisation: "on", eligible: 1, migrated: 0 });
	expect(run.report.failed).toEqual([
		{ taskId: id, code: "RESULT_DIR_DENIED", message: "Result directory not writable (permission denied or read-only file system); row left inline" },
	]);
	expect(run.stdout).not.toContain(results);
	expect(run.stdout).not.toContain("EACCES");
	// The row is untouched (still inline).
	expect(rowOf(path, id)).toBe(before);
});

test("results check: a row that fails rehydration after its blobs verified is reported with fixed text, without the error text", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	enable(store);
	const id = running(store, "external");
	store.saveResult(id, { patch: "p".repeat(5000), status: "verified" });
	store.close();
	// A second reference to the same (intact) blob with a different size: results check verifies each blob once by
	// its first reference, so the blob is not missing/corrupt; rehydration of this row then fails while reading the
	// second reference (the error text names the blob digest and the read failure).
	const row = JSON.parse(rowOf(path, id));
	const [ref] = row.resultExternal.blobs;
	row.resultExternal.skeleton.files = [{ contentBase64: null }];
	row.resultExternal.blobs.push({ path: ["files", 0, "contentBase64"], sha256: ref.sha256, bytes: ref.bytes + 1 });
	const db = new Database(path);
	db.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson(row), id);
	db.close();
	for (const mode of [[], ["--read-only"]]) {
		const run = Bun.spawnSync([process.execPath, CLI, ...mode, "--db", path, "results", "check"], { stdout: "pipe", stderr: "pipe" });
		const stdout = run.stdout.toString();
		expect(run.exitCode).toBe(1);
		const report = JSON.parse(stdout);
		expect(report).toMatchObject({ ok: false, missing: [], corrupt: [] });
		expect(report.rows).toEqual([
			{
				taskId: id,
				problem: "Externalised result does not verify (invalid manifest or blob reference, unreadable blob, or skeleton/digest mismatch)",
			},
		]);
		expect(JSON.stringify(report.rows)).not.toContain(ref.sha256);
		expect(stdout).not.toContain("size or digest mismatch");
	}
});

// ---- Review 50b85191 F-1 / F-2: every failure class of a migration row has its own code and true fixed text, and
// none of them prints text taken from the error. All cases go through the real migrateResults/resultInventory catch.
const HOSTILE = "HOSTILE-7f3a token=sk-live-123 \u001b[31m /etc/shadow C:\\secret\\path\nsecond line";
const TEXT = {
	RESULT_INTEGRITY: "Result integrity check failed; row left inline (run results check)",
	RESULT_STORE_OFF: "Result store switch is off; row left inline",
	SCHEMA_VERSION: "Unsupported database format version; row left inline",
	MIGRATION_NOT_APPLIED: "Row update was not applied",
	DB_BUSY: "Database is locked by another connection; row left inline (retry when the other writer is done)",
	DB_FULL: "Database or disk is full; row left inline",
	DB_CONSTRAINT: "Database constraint refused the migration write; row left inline",
	DB_ERROR: "Database error; row left inline",
	RESULT_DIR_DENIED: "Result directory not writable (permission denied or read-only file system); row left inline",
	RESULT_DIR_FULL: "No space left for the result directory (disk full or quota); row left inline",
	RESULT_DIR_ERROR: "Result directory file operation failed; row left inline",
	STORE_ERROR: "Error not classified further; row left inline",
	OTHER: "Row not migrated; row left inline",
	REHYDRATE_INTEGRITY:
		"Externalised result does not verify (invalid manifest or blob reference, unreadable blob, or skeleton/digest mismatch)",
	REHYDRATE_OTHER: "Externalised result could not be read",
};
/** An open store with `count` inline legacy results saved before the switch was turned on. */
function legacy(count = 1): { path: string; store: FleetStore; ids: string[] } {
	const path = dbPath();
	const store = new FleetStore(path);
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const id = running(store, `legacy-${i}`);
		store.saveResult(id, { patch: String(i).repeat(5000), status: "verified" });
		ids.push(id);
	}
	enable(store);
	return { path, store, ids };
}
function blobEntries(path: string): string[] {
	return existsSync(`${path}.results`) ? readdirSync(`${path}.results`) : [];
}
function expectNoHostile(store: FleetStore, report: unknown, ids: string[]): void {
	expect(JSON.stringify(report)).not.toContain("HOSTILE");
	for (const id of ids) expect(JSON.stringify(store.events(id))).not.toContain("HOSTILE");
}

test("migrate results --apply (CLI): a result directory that is not a plain directory is RESULT_INTEGRITY with its fixed text", () => {
	const { path, store, ids } = legacy();
	store.close();
	const before = rowOf(path, ids[0]);
	writeFileSync(`${path}.results`, "not a directory");
	const run = cli(path, "migrate", "results", "--apply");
	expect(run.exit).toBe(1);
	expect(run.report).toMatchObject({ ok: false, eligible: 1, migrated: 0 });
	expect(run.report.failed).toEqual([{ taskId: ids[0], code: "RESULT_INTEGRITY", message: TEXT.RESULT_INTEGRITY }]);
	expect(run.stdout).not.toContain("plain directory");
	expect(run.stdout).not.toContain(`${path}.results`);
	expect(rowOf(path, ids[0])).toBe(before);
});

test("migrate results --apply: a concurrent writer holding the database lock is DB_BUSY, nothing is published, and a later run migrates the row", () => {
	const { path, store, ids } = legacy();
	try {
		const before = rowOf(path, ids[0]);
		// Only SQLite's own wait on this owned connection is shortened (10 s -> 50 ms); the lock is real.
		((store as any).db as Database).exec("PRAGMA busy_timeout=50");
		const writer = new Database(path);
		writer.exec("BEGIN IMMEDIATE");
		let report;
		try {
			report = store.migrateResults(true);
		} finally {
			writer.exec("ROLLBACK");
			writer.close();
		}
		expect(report).toMatchObject({ eligible: 1, migrated: 0 });
		expect(report.failed).toEqual([{ taskId: ids[0], code: "DB_BUSY", message: TEXT.DB_BUSY }]);
		expect(JSON.stringify(report)).not.toContain("database is locked");
		expect(rowOf(path, ids[0])).toBe(before);
		expect(blobEntries(path)).toEqual([]);
		expect(store.migrateResults(true)).toMatchObject({ eligible: 1, migrated: 1, failed: [] });
	} finally {
		store.close();
	}
});

test("migrate results --apply: SQLite capacity full is DB_FULL; a database constraint is DB_CONSTRAINT; another SQLite error is DB_ERROR", () => {
	const { path, store, ids } = legacy(1);
	try {
		// The first row takes the v2 -> v3 step, so the later rows' transactions change only their own row.
		expect(store.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
		const fresh = ["full", "constraint", "error"].map((key) => running(store, `fresh-${key}`));
		// saveResult on a v3 store with the switch on externalises; plant inline (legacy-form) results directly.
		const raw = new Database(path);
		const db = (store as any).db as Database;
		let report;
		try {
			for (const id of fresh) {
				const row = JSON.parse(rowOf(path, id));
				raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...row, resultManifest: { patch: id.repeat(200), status: "verified" } }), id);
			}
			// One fault per row: a row write that needs pages beyond capacity, a constraint.
			raw.exec(`CREATE TABLE probe_pad (x BLOB);
				CREATE TRIGGER probe_full AFTER UPDATE ON tasks WHEN NEW.id='${fresh[0]}' BEGIN INSERT INTO probe_pad VALUES (randomblob(1000000)); END;
				CREATE TRIGGER probe_constraint BEFORE UPDATE ON tasks WHEN NEW.id='${fresh[1]}' BEGIN SELECT RAISE(ABORT, 'HOSTILE-7f3a token=sk-live-123 /etc/shadow'); END;`);
			// Pager capacity on this owned connection only (as in storage-faults.test.ts), not a physical disk-full.
			const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
			db.exec(`PRAGMA max_page_count=${pages}`);
			try {
				report = store.migrateResults(true);
			} finally {
				db.exec("PRAGMA max_page_count=1073741823");
			}
			expect(report).toMatchObject({ eligible: 3, migrated: 1 });
			expect(report.failed).toEqual([
				{ taskId: fresh[0], code: "DB_FULL", message: TEXT.DB_FULL },
				{ taskId: fresh[1], code: "DB_CONSTRAINT", message: TEXT.DB_CONSTRAINT },
			]);
			for (const id of fresh.slice(0, 2)) expect(JSON.parse(rowOf(path, id))).toHaveProperty("resultManifest");
			raw.exec("DROP TRIGGER probe_full; DROP TRIGGER probe_constraint;");
			// A trigger whose body names a missing table: every row update then fails to compile (SQLITE_ERROR).
			raw.exec(`CREATE TRIGGER probe_error BEFORE UPDATE ON tasks BEGIN INSERT INTO "HOSTILE_missing_table" VALUES (1); END;`);
			const error = store.migrateResults(true);
			expect(error).toMatchObject({ eligible: 2, migrated: 0 });
			expect(error.failed).toEqual(fresh.slice(0, 2).map((taskId) => ({ taskId, code: "DB_ERROR", message: TEXT.DB_ERROR })));
			for (const one of [report, error]) {
				expectNoHostile(store, one, fresh);
				expect(JSON.stringify(one)).not.toContain("SQLITE");
			}
			// Each failed row is still inline.
			for (const id of fresh.slice(0, 2)) expect(JSON.parse(rowOf(path, id))).toHaveProperty("resultManifest");
			raw.exec("DROP TRIGGER probe_error; DROP TABLE probe_pad;");
		} finally {
			raw.close();
		}
		// With the faults gone every row migrates and verifies.
		expect(store.migrateResults(true)).toMatchObject({ migrated: 2, failed: [] });
		for (const id of fresh) expect(JSON.parse(rowOf(path, id))).toHaveProperty("resultExternal");
		expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
	} finally {
		store.close();
	}
});

test("migrate results --apply: a row update that SQLite silently skips is MIGRATION_NOT_APPLIED with its fixed text", () => {
	const { path, store, ids } = legacy();
	try {
		const before = rowOf(path, ids[0]);
		const raw = new Database(path);
		raw.exec("CREATE TRIGGER skip BEFORE UPDATE ON tasks BEGIN SELECT RAISE(IGNORE); END;");
		raw.close();
		const report = store.migrateResults(true);
		expect(report).toMatchObject({ eligible: 1, migrated: 0 });
		expect(report.failed).toEqual([{ taskId: ids[0], code: "MIGRATION_NOT_APPLIED", message: TEXT.MIGRATION_NOT_APPLIED }]);
		expect(rowOf(path, ids[0])).toBe(before);
	} finally {
		store.close();
	}
});

test("migrate results --apply: the switch turned off by another process between rows is RESULT_STORE_OFF for the later row", () => {
	const { path, store, ids } = legacy(2);
	try {
		const transaction = (store as any).transaction.bind(store);
		let rows = 0;
		// Sequencing only: before the second row's transaction an operator in another store disables the switch.
		(store as any).transaction = (action: string, ...rest: unknown[]) => {
			if (action === "migrateResults" && ++rows === 2) {
				const operator = new FleetStore(path);
				try {
					operator.disableResultStore({ actor: "operator", reason: "between rows" });
				} finally {
					operator.close();
				}
			}
			return transaction(action, ...rest);
		};
		const report = store.migrateResults(true);
		expect(report).toMatchObject({ eligible: 2, migrated: 1 });
		expect(report.failed).toEqual([{ taskId: ids[1], code: "RESULT_STORE_OFF", message: TEXT.RESULT_STORE_OFF }]);
		expect(JSON.parse(rowOf(path, ids[1]))).toHaveProperty("resultManifest");
	} finally {
		store.close();
	}
});

test("migrate results --apply: every other thrown value gets its class code and fixed text; unknown values are STORE_ERROR; no error text, getter or trap of the value is used", () => {
	let getterRuns = 0;
	const withCode = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(HOSTILE), { code, ...extra });
	const getterCode = new Error(HOSTILE);
	Object.defineProperty(getterCode, "code", { get: () => (getterRuns++, "EACCES") });
	const getterName = Object.assign(new Error(HOSTILE), { code: "SQLITE_BUSY" });
	Object.defineProperty(getterName, "name", { get: () => (getterRuns++, "SQLiteError") });
	const trap = () => {
		throw new Error(HOSTILE);
	};
	const proxy = new Proxy(new FleetError("RESULT_INTEGRITY", HOSTILE), { get: trap, getOwnPropertyDescriptor: trap, has: trap, ownKeys: trap });
	const cases: [string, unknown, string, string][] = [
		["unknown Fleet code", new FleetError("FUTURE_CODE", HOSTILE), "FUTURE_CODE", TEXT.OTHER],
		["Fleet RESULT_INTEGRITY", new FleetError("RESULT_INTEGRITY", HOSTILE), "RESULT_INTEGRITY", TEXT.RESULT_INTEGRITY],
		["Fleet RESULT_STORE_OFF", new FleetError("RESULT_STORE_OFF", HOSTILE), "RESULT_STORE_OFF", TEXT.RESULT_STORE_OFF],
		["Fleet SCHEMA_VERSION", new FleetError("SCHEMA_VERSION", HOSTILE), "SCHEMA_VERSION", TEXT.SCHEMA_VERSION],
		["Fleet MIGRATION_NOT_APPLIED", new FleetError("MIGRATION_NOT_APPLIED", HOSTILE), "MIGRATION_NOT_APPLIED", TEXT.MIGRATION_NOT_APPLIED],
		["Fleet error with a code outside the pattern", new FleetError("bad code", HOSTILE), "STORE_ERROR", TEXT.STORE_ERROR],
		["SQLite busy", withCode("SQLITE_BUSY", { name: "SQLiteError" }), "DB_BUSY", TEXT.DB_BUSY],
		["SQLite locked", withCode("SQLITE_LOCKED", { name: "SQLiteError" }), "DB_BUSY", TEXT.DB_BUSY],
		["SQLite full", withCode("SQLITE_FULL", { name: "SQLiteError" }), "DB_FULL", TEXT.DB_FULL],
		["SQLite constraint", withCode("SQLITE_CONSTRAINT_CHECK", { name: "SQLiteError" }), "DB_CONSTRAINT", TEXT.DB_CONSTRAINT],
		["SQLite I/O error", withCode("SQLITE_IOERR_WRITE", { name: "SQLiteError" }), "DB_ERROR", TEXT.DB_ERROR],
		["SQLite-looking code on another error", withCode("SQLITE_BUSY"), "STORE_ERROR", TEXT.STORE_ERROR],
		["EACCES", withCode("EACCES"), "RESULT_DIR_DENIED", TEXT.RESULT_DIR_DENIED],
		["EPERM", withCode("EPERM"), "RESULT_DIR_DENIED", TEXT.RESULT_DIR_DENIED],
		["EROFS", withCode("EROFS"), "RESULT_DIR_DENIED", TEXT.RESULT_DIR_DENIED],
		["ENOSPC", withCode("ENOSPC"), "RESULT_DIR_FULL", TEXT.RESULT_DIR_FULL],
		["EDQUOT", withCode("EDQUOT"), "RESULT_DIR_FULL", TEXT.RESULT_DIR_FULL],
		["EIO", withCode("EIO"), "RESULT_DIR_ERROR", TEXT.RESULT_DIR_ERROR],
		["lower-case code", withCode("eacces"), "STORE_ERROR", TEXT.STORE_ERROR],
		["OS code on a non-Error object", { code: "EACCES", message: HOSTILE }, "STORE_ERROR", TEXT.STORE_ERROR],
		["code getter", getterCode, "STORE_ERROR", TEXT.STORE_ERROR],
		["name getter", getterName, "STORE_ERROR", TEXT.STORE_ERROR],
		["TypeError", new TypeError(HOSTILE), "STORE_ERROR", TEXT.STORE_ERROR],
		["thrown string", HOSTILE, "STORE_ERROR", TEXT.STORE_ERROR],
		["thrown undefined", undefined, "STORE_ERROR", TEXT.STORE_ERROR],
		["Proxy with throwing traps", proxy, "STORE_ERROR", TEXT.STORE_ERROR],
	];
	const { path, store, ids } = legacy();
	try {
		const before = rowOf(path, ids[0]);
		const results = (store as any).results;
		for (const [name, thrown, code, message] of cases) {
			results.externalise = () => {
				throw thrown;
			};
			const report = store.migrateResults(true);
			expect({ name, failed: report.failed }).toEqual({ name, failed: [{ taskId: ids[0], code, message }] });
			expectNoHostile(store, report, ids);
			expect(rowOf(path, ids[0])).toBe(before);
		}
		expect(getterRuns).toBe(0);
		delete results.externalise;
		expect(store.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
	} finally {
		store.close();
	}
});

test("results check: a rehydration failure other than Fleet's RESULT_INTEGRITY has the generic fixed text, never the error text", () => {
	const path = dbPath();
	const store = new FleetStore(path);
	try {
		enable(store);
		const id = running(store, "external");
		store.saveResult(id, { patch: "r".repeat(5000), status: "verified" });
		const trap = () => {
			throw new Error(HOSTILE);
		};
		const cases: [string, unknown, string][] = [
			["Fleet RESULT_INTEGRITY", new FleetError("RESULT_INTEGRITY", HOSTILE), TEXT.REHYDRATE_INTEGRITY],
			["other Fleet code", new FleetError("RESULT_SCHEMA", HOSTILE), TEXT.REHYDRATE_OTHER],
			["RESULT_INTEGRITY code on a plain Error", Object.assign(new Error(HOSTILE), { code: "RESULT_INTEGRITY" }), TEXT.REHYDRATE_OTHER],
			["OS error", Object.assign(new Error(HOSTILE), { code: "EIO" }), TEXT.REHYDRATE_OTHER],
			["TypeError", new TypeError(HOSTILE), TEXT.REHYDRATE_OTHER],
			["thrown string", HOSTILE, TEXT.REHYDRATE_OTHER],
			[
				"Proxy with throwing traps",
				new Proxy(new FleetError("RESULT_INTEGRITY", HOSTILE), { get: trap, getPrototypeOf: trap, getOwnPropertyDescriptor: trap }),
				TEXT.REHYDRATE_OTHER,
			],
		];
		const results = (store as any).results;
		for (const [name, thrown, problem] of cases) {
			results.rehydrate = () => {
				throw thrown;
			};
			const report = store.resultInventory();
			expect({ name, rows: report.rows, missing: report.missing, corrupt: report.corrupt }).toEqual({
				name,
				rows: [{ taskId: id, problem }],
				missing: [],
				corrupt: [],
			});
			expect(JSON.stringify(report)).not.toContain("HOSTILE");
		}
		delete results.rehydrate;
		expect(store.resultInventory().rows).toEqual([]);
	} finally {
		store.close();
	}
});
