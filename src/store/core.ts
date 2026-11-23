import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Json, TaskProgress, TaskRecord, TaskState } from "../contracts";
import { FleetError, canonicalJson, demand, digest, object, positiveCap, text } from "../core";
import { FailureDiagnostic, failureDiagnostic, normalizeDiagnostic } from "../diagnostic";
import { ExternalManifest, ResultStore, syncDirectory } from "../result-store";
import { NODE_HEALTH_TABLE } from "../node-health";
import { ARCHIVE_VERSION, BACKUP_OWNER, BACKUP_PUBLISH_INTENT, BACKUP_RESULTS_INTENT, BACKUP_RESULTS_OWNER, BACKUP_TOOL, DurationOperation, DurationOutcome, FEATURES_VERSION, FailureContext, KNOWN_FEATURES, LEGACY_VERSION, RESULT_STORE_FEATURE, durationBounds, fileIdentity, nodeFailureCode, observableRefusalCodes, recoverBackupLeftovers, removeBackupResults, removeBackupStaging, resultValidationCodes, safeFailureContext } from "./shared";

export abstract class StoreCore {
	protected readonly results: ResultStore;

	/** Stored form of manifests this instance decoded or externalised; reused only while the digest is unchanged. */
	protected externalised = new WeakMap<object, ExternalManifest>();

	protected readonly db: Database;

	protected readonly readOnly: boolean;

	protected readonly enqueueOrigins = new Map<string, number>();

	protected readonly durationHistograms = new Map<
		string,
		{
			operation: DurationOperation;
			outcome: DurationOutcome;
			count: number;
			sumMs: number;
			buckets: number[];
		}
	>();

	protected telemetryFailures = 0;

	protected missingEnqueueOrigins = 0;

	protected evictedEnqueueOrigins = 0;

	protected durationNoops = 0;

	protected idempotentReuses = 0;

	protected operationClaimsSuppressed = 0;

	readonly globalCap: number;

	readonly deferTerminalRelease: boolean;

	/** False for a --read-only store: observation paths then skip progress reads they could not record. */
	get writable(): boolean {
		return !this.readOnly;
	}

	protected transaction<T>(
		action: string,
		taskId: string | undefined,
		body: () => T,
		failureContext?: () => Record<string, Json>,
	): T {
		demand(!this.readOnly, "READ_ONLY", "Store is read-only");
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = body();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			// Encodings cached before a failed commit may refer to unreferenced blobs.
			// GC can remove those blobs before a caller retries with the same object.
			this.externalised = new WeakMap<object, ExternalManifest>();
			try {
				if (this.db.inTransaction) this.db.exec("ROLLBACK");
			} catch {
				this.telemetryFailures++;
			}
			// Refusals contain only stable codes and a deny-by-default diagnostic (error class, allowlisted
			// code, fixed text), never rejected prompts, payloads, credentials or anything derived from error text.
			try {
				this.db.exec("BEGIN IMMEDIATE");
				this.audit(
					"refused",
					{
						action,
						code: error instanceof FleetError ? error.code : "STORE_ERROR",
						certainty: "local_transaction_rolled_back",
						...failureContext?.(),
						...this.diagnosticData(this.refusalDiagnostic(error)),
					},
					typeof taskId === "string" ? taskId : undefined,
				);
				this.db.exec("COMMIT");
			} catch {
				this.telemetryFailures++;
				try {
					if (this.db.inTransaction) this.db.exec("ROLLBACK");
				} catch {
					this.telemetryFailures++;
				}
			}
			throw error;
		}
	}

	constructor(
		dbPath: string,
		globalCap = 2,
		options: { readOnly?: boolean; deferTerminalRelease?: boolean } = {},
	) {
		text(dbPath);
		positiveCap(globalCap);
		demand(
			options !== null &&
				typeof options === "object" &&
				(options.readOnly === undefined ||
					typeof options.readOnly === "boolean"),
			"INVALID_INPUT",
			"readOnly must be boolean",
		);
		this.readOnly = options.readOnly === true;
		demand(options.deferTerminalRelease === undefined || typeof options.deferTerminalRelease === "boolean", "INVALID_INPUT", "deferTerminalRelease must be boolean");
		this.deferTerminalRelease = options.deferTerminalRelease === true;
		this.results = new ResultStore(`${dbPath}.results`, { readOnly: this.readOnly });
		this.globalCap = globalCap;
		demand(
			dbPath !== ":memory:",
			"INVALID_INPUT",
			"A durable local database path is required",
		);
		if (!this.readOnly)
			mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
		const checkFile = (path: string, required = false) => {
			try {
				const stat = lstatSync(path);
				demand(
					stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
					"UNSAFE_DB_PATH",
					"Database files must be regular unshared local files",
				);
			} catch (error) {
				if (required && (error as NodeJS.ErrnoException).code === "ENOENT")
					throw new FleetError(
						"UNSAFE_DB_PATH",
						"Existing database file required",
					);
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		};
		for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
			checkFile(path, this.readOnly && path === dbPath);
		if (!this.readOnly && !existsSync(dbPath)) {
			try {
				closeSync(openSync(dbPath, "wx", 0o600));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		checkFile(dbPath);
		// A real readonly connection retains committed WAL visibility. SQLite may
		// still use SHM/read locks; immutable URIs would incorrectly hide live WAL.
		this.db = new Database(
			dbPath,
			this.readOnly
				? { readonly: true, create: false, strict: true }
				: { strict: true },
		);
		try {
			this.db.exec("PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
			if (this.readOnly) this.db.exec("PRAGMA query_only=ON;");
			// L2: the whole format fence is validated in one read transaction before
			// this process changes any file (no chmod, no journal-mode change).
			// L1: one snapshot, so a fence committing concurrently is seen either
			// entirely or not at all.
			this.db.transaction(() => this.inspectFormat()).deferred();
			if (this.readOnly) return;
			chmodSync(dbPath, 0o600);
			this.db.exec(
				"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;",
			);
			try {
				// Re-read under the write lock: another process may have upgraded or
				// fenced the database since the snapshot above.
				const locked = this.inspectFormat();
				if (locked === LEGACY_VERSION) {
					this.db.exec(`ALTER TABLE fleet_meta RENAME TO fleet_meta_v1;
					CREATE TABLE fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=2), global_cap INTEGER NOT NULL CHECK(global_cap>0));
					INSERT INTO fleet_meta SELECT id,2,global_cap FROM fleet_meta_v1;
					DROP TABLE fleet_meta_v1;`);
				}
				this.db.exec(`
          CREATE TABLE IF NOT EXISTS fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=2), global_cap INTEGER NOT NULL CHECK(global_cap>0));
          CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, caller TEXT NOT NULL, request_key TEXT NOT NULL, input_digest TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(caller,request_key));
          CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), attempt_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(attempt_id,kind));
          CREATE TABLE IF NOT EXISTS receipts (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS audit_global_kind ON audit(kind) WHERE task_id IS NULL;
          CREATE TRIGGER IF NOT EXISTS archived_phase_fence BEFORE UPDATE OF data ON tasks
          WHEN json_extract(OLD.data,'$.phase')='archived' AND json_extract(NEW.data,'$.phase') IS NOT 'archived'
          BEGIN SELECT RAISE(ABORT,'Archived phase is immutable'); END;
          CREATE TABLE IF NOT EXISTS resource_return_leases (node_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS resource_return_node_blocks (node_id TEXT PRIMARY KEY, data TEXT NOT NULL);
        `);
				this.db
					.query("INSERT OR IGNORE INTO fleet_meta VALUES (1,2,?)")
					.run(globalCap);
				// Opening only ever reaches ladder v2; v3 is never set here.
				const target = locked === FEATURES_VERSION ? FEATURES_VERSION : ARCHIVE_VERSION;
				this.validateMetadata(target);
				this.db.exec(
					locked === target
						? "PRAGMA application_id=1195789396; COMMIT;"
						: `PRAGMA application_id=1195789396; PRAGMA user_version=${target}; COMMIT;`,
				);
			} catch (error) {
				try {
					if (this.db.inTransaction) this.db.exec("ROLLBACK");
				} catch {}
				throw error;
			}
			this.secureFiles(dbPath);
		} catch (error) {
			this.db.close();
			throw error;
		}
	}

	protected secureFiles(path: string): void {
		for (const file of [path, `${path}-wal`, `${path}-shm`])
			if (existsSync(file)) chmodSync(file, 0o600);
	}

	protected validateMetadata(expectedVersion: number): void {
		const meta = this.db
			.query<{ schema_version: number; global_cap: number }, []>(
				"SELECT schema_version,global_cap FROM fleet_meta WHERE id=1",
			)
			.get();
		demand(
			meta?.schema_version === expectedVersion && meta.global_cap === this.globalCap,
			"SCHEMA_VERSION",
			"Database schemaVersion or global cap differs from configuration",
		);
	}

	protected userVersion(): number {
		return this.db
			.query<{ user_version: number }, []>("PRAGMA user_version")
			.get()!.user_version;
	}

	protected hasFeatureTable(): boolean {
		return Boolean(
			this.db
				.query(
					"SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_features'",
				)
				.get(),
		);
	}

	/** Every recorded capability must be one this build understands (must-understand). */
	protected validateFeatures(): string[] {
		const features = this.db
			.query<{ name: unknown }, []>("SELECT name FROM fleet_features ORDER BY name")
			.all()
			.map((row) => String(row.name));
		const unknown = features.filter((name) => !KNOWN_FEATURES.has(name));
		demand(
			unknown.length === 0,
			"SCHEMA_VERSION",
			`Database requires format features this build does not support: ${unknown.join(", ").slice(0, 200)}`,
		);
		return features;
	}

	/**
	 * Validates the ladder version, application id, fleet_meta and the format
	 * fence. Reads only; callers run it inside one read or write transaction so
	 * every value comes from the same snapshot. Returns the ladder version
	 * (0 only for a new, empty database opened writable).
	 */
	protected inspectFormat(): number {
		const version = this.userVersion();
		demand(
			version === LEGACY_VERSION ||
				version === ARCHIVE_VERSION ||
				version === FEATURES_VERSION ||
				(!this.readOnly && version === 0),
			"SCHEMA_VERSION",
			"Unsupported database schemaVersion",
		);
		const tables = this.db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
			)
			.all();
		// Ladder v3 and the fence table exist together or not at all.
		const features = tables.some((table) => table.name === "fleet_features");
		demand(
			features === (version === FEATURES_VERSION),
			"SCHEMA_VERSION",
			features
				? "Unsupported database schemaVersion: a format fence table below ladder version 3"
				: "Unsupported database schemaVersion: ladder version 3 requires the format fence table",
		);
		const applicationId = this.db
			.query<{ application_id: number }, []>("PRAGMA application_id")
			.get()!.application_id;
		// A fresh file, or one that only holds the node-health sidecar (opened first on a shared path).
		demand(
			applicationId === 0x47464c54 ||
				(!this.readOnly &&
					applicationId === 0 &&
					version === 0 &&
					tables.every((table) => NODE_HEALTH_TABLE.test(table.name))),
			"SCHEMA_VERSION",
			"Refusing an unrelated database",
		);
		if (features && this.validateFeatures().includes(RESULT_STORE_FEATURE))
			demand(
				this.hasResultFormTriggers(),
				"SCHEMA_VERSION",
				"Unsupported database schemaVersion: the result-store format requires its row-form triggers",
			);
		if (version !== 0) this.validateMetadata(version);
		return version;
	}

	protected audit(
		kind: string,
		data: Json,
		taskId?: string,
		knownTask?: TaskState,
	): void {
		// Only facts known at this event are retained. Never enrich historical
		// events from a later task row or infer a hub epoch from endpoint state.
		// Attribution needs row metadata only: the result is never read here.
		const task = knownTask ?? (taskId ? this.taskState(taskId) : undefined);
		const attributes: Record<string, Json> = {};
		if (taskId) attributes.taskId = taskId;
		if (task) {
			attributes.inputDigest = task.inputDigest;
			for (const key of ["attemptId", "nodeId", "sessionId", "turnId"] as const)
				if (task[key]) attributes[key] = task[key]!;
		}
		const value = data as Record<string, Json>;
		if (["unknown", "stale_poll_failure", "abandoned_poll", "cancel_unknown"].includes(kind))
			Object.assign(
				attributes,
				this.failureAttributes(value.failure as FailureContext | undefined),
			);
		for (const key of [
			"nodeId",
			"inputDigest",
			"payloadDigest",
			"operationId",
			"operationKey",
		])
			if (typeof value[key] === "string") attributes[key] = value[key]!;
		if (kind === "operation_intent") {
			attributes.operationId = value.id!;
			attributes.operationKey = value.key!;
			attributes.payloadDigest = value.digest!;
		}
		if (kind === "observation" || kind === "stale_poll") {
			attributes.receiptEventId = value.eventId!;
			attributes.receiptDigest = value.digest!;
		}
		if (
			["workspace_recorded", "result_saved", "verification_receipt"].includes(
				kind,
			)
		)
			attributes.contentDigest = value.digest!;
		this.db
			.query("INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)")
			.run(
				taskId ?? null,
				kind,
				new Date().toISOString(),
				canonicalJson({
					...value,
					observability: { version: 1, attributes },
				}),
			);
	}

	hasTable(name: string): boolean {
		return Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
	}

	close(): void {
		this.db.close();
	}

	/**
	 * Consistent local snapshot of the whole database (every table: tasks,
	 * operations, audit, nodes, resource-return leases and node blocks, the
	 * result switch and fence) plus, when the snapshot has externalised
	 * results, exactly the blobs they reference in DEST.results.
	 * SQLite's VACUUM INTO writes one committed read snapshot page by page into
	 * a new private file next to the destination: no size limit, no whole-file
	 * buffer in memory, free pages dropped. The copy is switched to rollback
	 * (DELETE) journal mode, checked, its blobs are copied and verified, and only
	 * then is it published under the destination name with an exclusive link,
	 * so DEST never names an incomplete backup. Any failure removes everything
	 * this call created.
	 */
	backup(destination: string): {
		path: string;
		sha256: string;
		bytes: number;
		directorySynced: boolean;
		results: { path: string | null; blobs: number; bytes: number; inventorySha256: string };
	} {
		demand(!this.readOnly, "READ_ONLY", "Store is read-only");
		let fd: number | undefined;
		// Artifacts this call created exclusively; removed if the backup fails.
		const created: string[] = [];
		let stagingDirectory: string | undefined;
		let resultsDirectory: string | undefined;
		try {
			text(destination);
			const path = resolve(destination);
			const resultsPath = `${path}.results`;
			// A backup to this destination that was killed leaves its staging directory (and possibly an
			// unpublished DEST.results). Remove only what is provably its own; name anything else.
			recoverBackupLeftovers(path, resultsPath);
			// Refuse stale SQLite companions too: opening the copy must never replay
			// a pre-existing journal. The parent directory must be operator-owned.
			// An existing result directory is never merged into.
			for (const file of [
				path,
				`${path}-wal`,
				`${path}-shm`,
				`${path}-journal`,
				resultsPath,
			]) {
				try {
					lstatSync(file);
					throw new FleetError("BACKUP_EXISTS", "backup_destination_exists");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			// VACUUM INTO only creates a new file: give it an exclusive owner-only directory.
			const token = randomUUID();
			stagingDirectory = `${path}.backup-${token}`;
			mkdirSync(stagingDirectory, { mode: 0o700 });
			created.push(stagingDirectory);
			// The ownership record a retry after a kill uses as proof (recoverBackupLeftovers).
			writeFileSync(join(stagingDirectory, BACKUP_OWNER), JSON.stringify({ tool: BACKUP_TOOL, token, destination: path, host: hostname(), pid: process.pid }), { flag: "wx", mode: 0o600 });
			const staging = join(stagingDirectory, "snapshot.sqlite");
			this.db.query("VACUUM INTO ?").run(staging);
			chmodSync(staging, 0o600);
			const copy = new Database(staging, {
				readwrite: true,
				create: false,
				strict: true,
			});
			const external: string[] = [];
			try {
				copy.exec("PRAGMA busy_timeout=10000; PRAGMA synchronous=FULL;");
				// Readers of the copy need no WAL/SHM (sqlite.org/wal.html#read_only_databases).
				const mode = copy
					.query<{ journal_mode: string }, []>("PRAGMA journal_mode=DELETE")
					.get();
				demand(mode?.journal_mode === "delete", "BACKUP_FAILED", "backup_failed");
				demand(
					copy.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check === "ok",
					"BACKUP_FAILED",
					"backup_failed",
				);
				const header = copy
					.query<{ user_version: number; application_id: number }, []>(
						"SELECT (SELECT user_version FROM pragma_user_version) AS user_version, (SELECT application_id FROM pragma_application_id) AS application_id",
					)
					.get()!;
				const meta = copy
					.query<{ schema_version: number }, []>("SELECT schema_version FROM fleet_meta WHERE id=1")
					.get();
				demand(
					header.application_id === 0x47464c54 && meta?.schema_version === header.user_version,
					"BACKUP_FAILED",
					"backup_failed",
				);
				// Only the small stored forms reach this process, one row at a time.
				for (const row of copy
					.query<{ stored: string }, []>(
						"SELECT data -> '$.resultExternal' AS stored FROM tasks WHERE json_type(data,'$.resultExternal') IS NOT NULL ORDER BY rowid",
					)
					.iterate())
					external.push(row.stored);
			} finally {
				copy.close(true);
			}
			// Blobs before the database name: DEST only appears once every referenced
			// blob is copied byte-for-byte and the copy's results rehydrate.
			const blobs = new Map<string, number>();
			if (external.length > 0) {
				writeFileSync(join(stagingDirectory, BACKUP_RESULTS_INTENT), "", { flag: "wx", mode: 0o600 });
				mkdirSync(resultsPath, { mode: 0o700 });
				created.push(resultsPath);
				resultsDirectory = resultsPath;
				writeFileSync(join(stagingDirectory, BACKUP_RESULTS_OWNER), fileIdentity(resultsPath)!, { flag: "wx", mode: 0o600 });
				const target = new ResultStore(resultsPath);
				for (const stored of external)
					for (const ref of this.results.copyTo(target, JSON.parse(stored)))
						blobs.set(ref.sha256, ref.bytes);
			}
			fd = openSync(staging, "r+");
			fsyncSync(fd);
			const hash = createHash("sha256");
			const chunk = Buffer.allocUnsafe(1024 * 1024);
			let bytes = 0;
			for (let n: number; (n = readSync(fd, chunk, 0, chunk.length, bytes)) > 0; bytes += n)
				hash.update(chunk.subarray(0, n));
			closeSync(fd);
			fd = undefined;
			demand(bytes > 0, "BACKUP_FAILED", "backup_failed");
			const sha256 = hash.digest("hex");
			// From here a retry after a kill treats an absent DEST as published and moved away (its results stay).
			writeFileSync(join(stagingDirectory, BACKUP_PUBLISH_INTENT), "", { flag: "wx", mode: 0o600 });
			// Exclusive publication: never replaces a destination created meanwhile.
			linkSync(staging, path);
			created.push(path);
			removeBackupStaging(stagingDirectory);
			// Flushes the entries of both the database file and its result directory.
			const directorySynced = syncDirectory(dirname(path));
			const inventory = [...blobs]
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([sha, size]) => `${sha} ${size}\n`)
				.join("");
			created.length = 0;
			return {
				path,
				sha256,
				bytes,
				directorySynced,
				results: {
					path: external.length > 0 ? resultsPath : null,
					blobs: blobs.size,
					bytes: [...blobs.values()].reduce((sum, n) => sum + n, 0),
					inventorySha256: createHash("sha256").update(inventory).digest("hex"),
				},
			};
		} catch (error) {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {}
				fd = undefined;
			}
			// Staging last: its ownership record outlives the other artifacts if this cleanup is killed. A
			// DEST.results holding anything this call did not write is kept, with the staging directory as the
			// proof a retry names (BACKUP_LEFTOVER).
			let keepStaging = false;
			for (const file of created.reverse()) {
				try {
					if (file === stagingDirectory) {
						if (!keepStaging) removeBackupStaging(file);
					} else if (file === resultsDirectory) {
						if (!removeBackupResults(file)) keepStaging = true;
					} else rmSync(file, { recursive: true, force: true });
				} catch {}
			}
			if (error instanceof FleetError) throw error;
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new FleetError("BACKUP_EXISTS", "backup_destination_exists");
			throw new FleetError("BACKUP_FAILED", "backup_failed");
		}
	}

	protected clock(): number | undefined {
		try {
			const now = performance.now();
			if (Number.isFinite(now) && now >= 0) return now;
		} catch {
			/* Exposed as a bounded diagnostic, never a primary failure. */
		}
		this.telemetryFailures++;
		return undefined;
	}

	/** One-way local control, not a remote fence or proof about older snapshots. */
	dispatchStatus() {
		const disabled = !!this.db
			.query<{ sequence: number }, []>(
				"SELECT sequence FROM audit WHERE task_id IS NULL AND kind='rollback_dispatch_disabled' LIMIT 1",
			)
			.get();
		return Object.freeze({
			disabled,
			scope: "local_admission_and_new_effect_claims_only" as const,
			preexistingClaims: "held_not_cancelled_or_retired" as const,
			remoteFence: false as const,
			olderSnapshotsAndWriters: "not_proven_safe" as const,
		});
	}

	enterRollback() {
		return this.transaction("enterRollback", undefined, () => {
			if (!this.dispatchStatus().disabled)
				this.audit("rollback_dispatch_disabled", {
					scope: "local_admission_and_new_effect_claims_only",
				});
			return this.dispatchStatus();
		});
	}

	/** Preflight for routes which read before claiming; claims also check atomically. */
	assertDispatchEnabled(): void {
		demand(
			!this.dispatchStatus().disabled,
			"DISPATCH_DISABLED",
			"Local rollback suppresses new admission and effect claims; existing operations remain held",
		);
	}

	protected duration(
		operation: DurationOperation,
		outcome: DurationOutcome,
		start: number | undefined,
		completedAt?: number,
	): void {
		if (start === undefined) return;
		try {
			const end = completedAt ?? this.clock();
			if (end === undefined) return;
			const elapsed = end - start;
			if (!Number.isFinite(elapsed) || elapsed < 0) {
				this.telemetryFailures++;
				return;
			}
			const key = operation + ":" + outcome;
			const histogram = this.durationHistograms.get(key) ?? {
				operation,
				outcome,
				count: 0,
				sumMs: 0,
				buckets: durationBounds.map(() => 0).concat(0),
			};
			if (
				!Number.isFinite(histogram.sumMs + elapsed) ||
				!Number.isSafeInteger(histogram.count + 1)
			) {
				this.telemetryFailures++;
				return;
			}
			histogram.count++;
			histogram.sumMs += elapsed;
			for (let i = 0; i < durationBounds.length; i++)
				if (elapsed <= durationBounds[i]!)
					histogram.buckets[i] = histogram.buckets[i]! + 1;
			histogram.buckets[durationBounds.length] =
				histogram.buckets[durationBounds.length]! + 1;
			this.durationHistograms.set(key, histogram);
		} catch {
			this.telemetryFailures++;
		}
	}

	/** Start/finish are instance-local monotonic instrumentation, never durable authority. */
	beginReconcileTiming(): number | undefined {
		return this.clock();
	}

	noteTelemetryFailure(): void {
		this.telemetryFailures++;
	}

	finishReconcileTiming(
		start: number | undefined,
		outcome: "applied" | "stale" | "unknown" | "failed",
	): void {
		if (!["applied", "stale", "unknown", "failed"].includes(outcome)) {
			this.telemetryFailures++;
			return;
		}
		this.duration("reconcile", outcome, start);
	}

	/** Saved custody stays successful when its opt-in review child cannot be submitted; the refusal is an audit row. */
	recordReviewDispatchFailed(taskId: string, code: string): void {
		if (this.readOnly) { this.telemetryFailures++; return; }
		try {
			this.transaction("reviewDispatch", taskId, () => this.audit("review_dispatch_failed", { code }, taskId));
		} catch {
			this.telemetryFailures++;
		}
	}
	recordResultValidationRejected(taskId: string, code: string, diagnostic?: FailureDiagnostic): void {
		demand(!this.readOnly, "READ_ONLY", "Store is read-only");
		const nodeFailure = nodeFailureCode.test(code);
		if (!resultValidationCodes.has(code) && !nodeFailure) return;
		try {
			this.transaction("resultValidation", taskId, () => {
				this.audit(
					nodeFailure ? "node_operation_failure" : "result_validation_rejected",
					{ code, certainty: nodeFailure ? (code.startsWith("node_refused:") ? "before_send" : "unknown") : "local_validation", ...this.diagnosticData(diagnostic) },
					taskId,
				);
			});
		} catch {
			this.telemetryFailures++;
		}
	}

	observability() {
		return this.db
			.transaction(() => {
				const collectedAt = new Date().toISOString();
				const daemon = this.daemonStatus();
				const gauges = this.db
					.query<
						{
							reserved_slots: number;
							active_tasks: number;
							unknown_tasks: number;
							approval_tasks: number;
						},
						[]
					>(`SELECT
				COALESCE(SUM(json_extract(data,'$.held')=1),0) AS reserved_slots,
				COALESCE(SUM(json_extract(data,'$.phase')='active'),0) AS active_tasks,
				COALESCE(SUM(json_extract(data,'$.phase') IN ('blocked_unknown','cancel_unknown')),0) AS unknown_tasks,
				COALESCE(SUM(json_extract(data,'$.phase')='approval_required'),0) AS approval_tasks
				FROM tasks`)
					.get()!;
				const heldUnknown = this.db
					.query<{ count: number }, []>(
						"SELECT COUNT(*) AS count FROM tasks WHERE json_extract(data,'$.held')=1 AND json_extract(data,'$.phase') IN ('blocked_unknown','cancel_unknown')",
					)
					.get()!.count;
				const count = (condition: string, ...params: string[]) =>
					this.db
						.query<{ count: number }, string[]>(
							`SELECT COUNT(*) AS count FROM audit WHERE ${condition}`,
						)
						.get(...params)!.count;
				const total = count("1=1");
				const enriched = count(
					"json_extract(data,'$.observability.version')=1",
				);
				const logs = this.db
					.query<
						{ sequence: number; kind: string; at: string; data: string },
						[]
					>(
						"SELECT sequence,kind,at,data FROM audit ORDER BY sequence DESC LIMIT 100",
					)
					.all()
					.reverse()
					.map((row) => {
						const data = JSON.parse(row.data);
						// A strict projection: never forward arbitrary legacy audit bodies,
						// reasons, transport errors, replies, payloads, paths or argv.
						const source =
							data.observability?.version === 1
								? data.observability.attributes
								: undefined;
						const attributes: Record<string, Json> = {};
						if (
							["unknown", "stale_poll_failure", "abandoned_poll", "cancel_unknown"].includes(
								row.kind,
							)
						)
							Object.assign(
								attributes,
								this.failureAttributes(source as FailureContext | undefined),
							);
						for (const key of [
							"taskId",
							"attemptId",
							"nodeId",
							"sessionId",
							"turnId",
							"inputDigest",
							"operationId",
							"operationKey",
							"payloadDigest",
							"receiptEventId",
							"receiptDigest",
							"contentDigest",
						])
							if (typeof source?.[key] === "string")
								attributes[key] = source[key];
						if (row.kind === "unknown_reconciled") {
							for (const key of [
								"before",
								"after",
								"receiptEventId",
								"receiptDigest",
							])
								if (typeof data[key] === "string") attributes[key] = data[key];
						}
						if (
							row.kind === "refused" ||
							row.kind === "result_validation_rejected"
						) {
							if (
								typeof data.code === "string" &&
								observableRefusalCodes.has(data.code)
							)
								attributes.code = data.code;
							if (
								["local_validation", "local_transaction_rolled_back"].includes(
									data.certainty,
								)
							)
								attributes.certainty = data.certainty;
						}
						return {
							sequence: row.sequence,
							kind: row.kind,
							at: row.at,
							coverage: source
								? "event_time_context"
								: "historical_sparse_unenriched",
							attributes,
						};
					});
				const recorded = [
					{
						operation: "submit",
						outcome: "rejected",
						reason: "key_conflict",
						count: count(
							"kind='refused' AND json_extract(data,'$.action')='submit' AND json_extract(data,'$.code')='KEY_CONFLICT'",
						),
					},
					...(["global_capacity", "no_eligible_node"] as const).map(
						(reason) => ({
							operation: "admission",
							outcome: "admission_rejected",
							reason,
							count: count(
								"kind='selection' AND json_extract(data,'$.outcome')='rejected' AND json_extract(data,'$.reason')=?",
								reason,
							),
						}),
					),
					{
						operation: "reconcile",
						outcome: "stale",
						reason: "local_poll_sequence",
						count: count("kind IN ('stale_poll','stale_poll_failure')"),
					},
					{
						operation: "reconcile",
						outcome: "reconciled",
						reason: "authoritative_observation",
						count: count("kind='unknown_reconciled'"),
					},
					...Array.from(resultValidationCodes).map((code) => ({
						operation: "result",
						outcome: "validation_rejected",
						reason: code,
						count: count(
							"kind='result_validation_rejected' AND json_extract(data,'$.code')=?",
							code,
						),
					})),
					...(
						[
							"CANCEL_PENDING",
							"UNKNOWN_EXECUTION",
							"AUTHORITY_CONFLICT",
						] as const
					).map((code) => ({
						operation: "local_mutation",
						outcome: "rejected",
						reason: code,
						count: count(
							"kind='refused' AND json_extract(data,'$.code')=?",
							code,
						),
					})),
				];
				// Lane progress of tasks in a progress phase that have a record (absent without any: unchanged output).
				const progressRows = this.db
					.query<{ id: string; progress: string }, []>(
						"SELECT id, json_extract(data,'$.progress') AS progress FROM tasks WHERE json_type(data,'$.progress') = 'object' AND json_extract(data,'$.phase') IN ('active','blocked_unknown') AND COALESCE(json_extract(data,'$.result.executionTerminal'),0) = 0 ORDER BY rowid",
					)
					.all()
					.map((row) => ({ id: row.id, progress: JSON.parse(row.progress) as TaskProgress }));
				const verdicts = ["progressing", "stalled_model", "stalled_tool", "finished_unobserved", "unknown"] as const;
				const flagged = progressRows.filter((row) => ["stalled_model", "stalled_tool", "finished_unobserved"].includes(row.progress.verdict));
				const progress = progressRows.length
					? {
							progress: {
								scope: "persisted_last_node_read_per_task",
								source: "node_transcript_file_time_and_last_entry_kind",
								counts: Object.fromEntries(verdicts.map((verdict) => [verdict, progressRows.filter((row) => row.progress.verdict === verdict).length])),
								flagged: flagged.slice(0, 100).map((row) => ({
									taskId: row.id,
									verdict: row.progress.verdict,
									lastEntryKind: row.progress.lastEntryKind ?? null,
									idleSeconds: row.progress.idleSeconds ?? null,
									lastProgressAt: row.progress.lastProgressAt ?? null,
									observedAt: row.progress.observedAt,
									stalledSince: row.progress.stall && !row.progress.stall.recovered ? row.progress.stall.since : null,
									hint: row.progress.hint,
								})),
								flaggedLimit: 100,
								action: "detection_and_operator_hint_only_never_kill_close_resend_or_reassign",
							},
						}
					: {};
				const progressWarnings = (["stalled_model", "stalled_tool", "finished_unobserved"] as const).flatMap((verdict) => {
					const n = flagged.filter((row) => row.progress.verdict === verdict).length;
					return n ? [{ reason: verdict === "finished_unobserved" ? "progress_finished_unobserved" : "progress_" + verdict, count: n }] : [];
				});
				return {
					scope: "persisted_local_snapshot",
					collectedAt,
					collectedAtSource:
						"local_wall_clock_label_not_remote_event_time_or_duration",
					gauges,
					coverage: {
						remoteLive: "unavailable_no_remote_queries",
						pendingQuestions:
							"unavailable_no_current_public_complete_question_observation",
						hubEpoch: "unavailable_not_established",
						codeRevision: "unavailable_not_established",
						audits: {
							total,
							eventTimeContext: enriched,
							historicalSparse: total - enriched,
							returnedLogs: logs.length,
							logLimit: 100,
						},
						admissionRejected:
							"new_selection_outcomes_only_historical_sparse_not_reconstructed",
						resultValidationRejected:
							"new_typed_local_validation_events_only_untyped_errors_not_classified",
						localFenceRejected:
							"recorded_typed_local_refusals_only_not_remote_fence_receipts",
						remoteFenceRejected: "unavailable_no_typed_public_remote_boundary",
						remoteCursorGaps: "unavailable_no_typed_public_remote_boundary",
						transportErrorCertainty:
							"new_typed_transport_failure_events_only_historical_and_unclassified_unavailable",
					},
					counters: {
						scope: "all_matching_recorded_audits",
						values: recorded,
						instance: {
							scope: "store_instance",
							idempotent_reuse: this.idempotentReuses,
							operation_claim_suppressed: this.operationClaimsSuppressed,
							coverage:
								"successful_submit_reserve_and_operation_reuse_only_nonpersistent_no_additional_writes_no_restart_history",
						},
					},
					durations: {
						scope: "store_instance",
						clock: "monotonic_performance_now",
						unit: "milliseconds",
						status: this.durationHistograms.size ? "available" : "unavailable",
						coverage:
							"completed_same_instance_spans_only_no_restart_or_wall_clock_reconstruction",
						boundaries: {
							enqueue_to_admission:
								"successful_submit_commit_to_first_reserve_entry_with_known_origin",
							admission:
								"reserve_entry_to_commit_or_failure_including_sqlite_busy_wait_and_failure_diagnostics",
							reconcile:
								"actual_inspect_entry_to_outcome_and_connection_cleanup_noop_excluded",
						},
						unavailableReason: this.durationHistograms.size
							? null
							: "no_completed_spans_in_this_store_instance",
						enqueueOriginLimit: 1024,
						enqueueOriginCoverage:
							"new_submissions_in_this_instance_only_oldest_origin_evicted_at_limit_no_wall_clock_fallback",
						missingEnqueueOrigins: this.missingEnqueueOrigins,
						noopsWithoutSample: this.durationNoops,
						evictedEnqueueOrigins: this.evictedEnqueueOrigins,
						telemetryFailures: this.telemetryFailures,
						boundsMs: [...durationBounds],
						finalBucket: "infinity",
						operations: (
							["enqueue_to_admission", "admission", "reconcile"] as const
						).map((operation) => ({
							operation,
							status: Array.from(this.durationHistograms.values()).some(
								(value) => value.operation === operation,
							)
								? "available"
								: "unavailable_no_completed_same_instance_span",
						})),
						values: Array.from(this.durationHistograms.values()).map(
							(value) => ({ ...value, buckets: [...value.buckets] }),
						),
					},
					warnings: [
						...(heldUnknown
							? [
									{
										reason: "held_unknown_requires_original_observation",
										count: heldUnknown,
									},
								]
							: []),
						...(gauges.approval_tasks
							? [
									{
										reason: "approval_requires_explicit_operator_review",
										count: gauges.approval_tasks,
									},
								]
							: []),
						...progressWarnings,
					],
					warningScope:
						"operator_local_only_not_external_alert_delivery_not_remote_settlement",
					logs,
					// Only while a daemon lease row exists (running, or crashed and not yet taken over).
					...(daemon ? { daemon } : {}),
					...progress,
				};
			})
			.deferred();
	}

	protected failureAttributes(context?: FailureContext): Record<string, Json> {
		try {
			return safeFailureContext(context);
		} catch {
			this.noteTelemetryFailure();
			return {};
		}
	}

	/** Operator diagnostic only: validated, rebuilt and stored beside the event; never read by decisions. */
	protected diagnosticData(diagnostic?: FailureDiagnostic): Record<string, Json> {
		if (diagnostic === undefined) return {};
		try {
			const safe = normalizeDiagnostic(diagnostic);
			if (safe) return { failureDiagnostic: safe as unknown as Json };
		} catch {}
		this.noteTelemetryFailure();
		return {};
	}

	protected progressDiagnostic(diagnostic?: FailureDiagnostic): { diagnostic?: Json } {
		const data = this.diagnosticData(diagnostic);
		return data.failureDiagnostic ? { diagnostic: data.failureDiagnostic } : {};
	}

	protected refusalDiagnostic(error: unknown): FailureDiagnostic | undefined {
		try {
			return failureDiagnostic(error, { source: "Store.transaction", phase: "record" });
		} catch {
			return undefined;
		}
	}

	/**
	 * Diagnostic of the event that set the task's current reason (latest unknown/blocked/cancel_unknown
	 * event carrying that reason), for read-only display. Not evidence for any decision.
	 */
	reasonDiagnostic(taskId: string): { event: string; sequence: number; diagnostic: FailureDiagnostic } | undefined {
		text(taskId);
		const reason = this.task(taskId)?.reason;
		if (typeof reason !== "string") return undefined;
		const row = this.db
			.query<{ sequence: number; kind: string; data: string }, [string, string]>(
				"SELECT sequence, kind, data FROM audit WHERE task_id=? AND kind IN ('unknown','blocked','cancel_unknown') AND json_extract(data,'$.reason')=? ORDER BY sequence DESC LIMIT 1",
			)
			.get(taskId, reason);
		const diagnostic = row ? normalizeDiagnostic(JSON.parse(row.data).failureDiagnostic) : undefined;
		return row && diagnostic ? { event: row.kind, sequence: row.sequence, diagnostic } : undefined;
	}

	// Implemented by later classes in the chain
	protected abstract taskState(id?: string): TaskState | undefined;
	protected abstract task(id?: string): TaskRecord | undefined;
	protected abstract hasResultFormTriggers(): boolean;
	protected abstract daemonStatus(now?: any): { alive: boolean; leaseExpiresAt: string; owner: string; pid: number; host: string; startedAt: string; status: Json } | undefined;
}
