import { Json, OperationIntent, TaskRecord } from "../contracts";
import { canonicalJson, demand, digest, nonemptyEvidence, text } from "../core";
import { ResultInventory } from "../result-store";
import { OUTPUT_HEAD_CREATED, OUTPUT_HEAD_UNPROVEN, OutputHeadProof, WorkUnitAccess, isRoleTask, recordInSave } from "../work-unit";
import { ARCHIVE_VERSION, DataRow, FEATURES_VERSION, MIGRATION_FAILURE_OTHER, MIGRATION_FAILURE_TEXT, REHYDRATE_INTEGRITY_TEXT, REHYDRATE_OTHER_TEXT, RESULT_FORM_TRIGGERS, RESULT_STORE_FEATURE, RESULT_STORE_OFF_MESSAGE, RESULT_SWITCH_TABLE, isResultIntegrity, migrationFailureCode } from "./shared";
import { StoreTasks } from "./tasks";

export abstract class StoreResults extends StoreTasks {
	/**
	 * Ladder step v2 -> v3 plus the result-store capability row and its row-form
	 * triggers, in the caller's write transaction. Only encodeTask calls it, in
	 * the transaction that commits the first externalised row, and only while
	 * the operator switch is on: opening, listing, enabling, inline saves and
	 * dry-runs never move the ladder. fleet_meta is rebuilt because its CHECK
	 * pins the version (as the v1 -> v2 step does).
	 */
	protected stepResultStoreFormat(): void {
		demand(
			!this.readOnly && this.db.inTransaction,
			"STORE_ERROR",
			"The format fence is set only under the write lock",
		);
		const version = this.userVersion();
		if (version === ARCHIVE_VERSION) {
			demand(
				!this.hasFeatureTable(),
				"SCHEMA_VERSION",
				"Unsupported database schemaVersion: a format fence table below ladder version 3",
			);
			this.validateMetadata(ARCHIVE_VERSION);
			this.db.exec(`ALTER TABLE fleet_meta RENAME TO fleet_meta_v2;
				CREATE TABLE fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=3), global_cap INTEGER NOT NULL CHECK(global_cap>0));
				INSERT INTO fleet_meta SELECT id,3,global_cap FROM fleet_meta_v2;
				DROP TABLE fleet_meta_v2;
				CREATE TABLE fleet_features (name TEXT PRIMARY KEY NOT NULL CHECK(length(name) BETWEEN 1 AND 64)) WITHOUT ROWID;
				PRAGMA user_version=3;`);
		} else
			demand(
				version === FEATURES_VERSION && this.hasFeatureTable(),
				"SCHEMA_VERSION",
				"Unsupported database schemaVersion",
			);
		this.validateMetadata(FEATURES_VERSION);
		// L2: a row can never hold both forms, whichever process writes it. A
		// process of older code that opened the database before this step
		// checks the version only at open; these triggers refuse its write of
		// an inline result onto an externalised row (and any other writer's).
		this.db.exec(RESULT_FORM_TRIGGERS);
		if (!this.validateFeatures().includes(RESULT_STORE_FEATURE))
			this.db.query("INSERT INTO fleet_features(name) VALUES (?)").run(RESULT_STORE_FEATURE);
	}

	/** The operator switch row, read in the caller's snapshot; undefined = off. */
	protected resultSwitch(): { enabledAt: string; enabledBy: string; reason: string } | undefined {
		if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(RESULT_SWITCH_TABLE)) return undefined;
		const row = this.db
			.query<{ enabled_at: string; enabled_by: string; reason: string }, []>(
				`SELECT enabled_at, enabled_by, reason FROM ${RESULT_SWITCH_TABLE} WHERE id=1`,
			)
			.get();
		return row ? { enabledAt: row.enabled_at, enabledBy: row.enabled_by, reason: row.reason } : undefined;
	}

	/** The switch as committed now (one short read snapshot). */
	protected externalisationOn(): boolean {
		return this.db.inTransaction
			? this.resultSwitch() !== undefined
			: this.db.transaction(() => this.resultSwitch() !== undefined).deferred();
	}

	protected hasResultFormTriggers(): boolean {
		return (
			this.db
				.query<{ n: number }, []>(
					"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='tasks' AND name IN ('result_form_fence_insert','result_form_fence_update')",
				)
				.get()!.n === 2
		);
	}

	/** True when externalised rows are valid here: ladder v3 with the result-store capability (and only known ones). */
	protected resultFenced(): boolean {
		if (this.resultFenceCommitted) return true;
		const read = () =>
			this.userVersion() === FEATURES_VERSION &&
			this.hasFeatureTable() &&
			this.validateFeatures().includes(RESULT_STORE_FEATURE);
		// One snapshot (L1): inside the caller's transaction, or a short read transaction.
		const fenced = this.db.inTransaction ? read() : this.db.transaction(read).deferred();
		if (fenced && !this.db.inTransaction) this.resultFenceCommitted = true;
		return fenced;
	}

	/**
	 * Move inline legacy manifests to the result store, one row per write
	 * transaction. Each row is shrunk only after its new encoding decodes back
	 * to exactly the original row (full canonical equality, not only blob
	 * digests). A failing row is reported and left untouched; the run continues.
	 */
	migrateResults(apply = false) {
		demand(!apply || !this.readOnly, "READ_ONLY", "Store is read-only");
		const externalisation = this.externalisationOn() ? ("on" as const) : ("off" as const);
		// Shrinking existing rows is a separate explicit step after the audited switch;
		// its first migrated row takes the one-way ladder step.
		demand(!apply || externalisation === "on", "RESULT_STORE_OFF", RESULT_STORE_OFF_MESSAGE);
		const report = {
			dryRun: !apply,
			externalisation,
			eligible: 0,
			eligibleBytes: 0,
			migrated: 0,
			alreadyExternal: 0,
			/** Inline results of archived tasks without a disposition: never externalised. */
			archived: 0,
			failed: [] as { taskId: string; code: string; message: string }[],
		};
		const select = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?");
		const ids = this.db
			.query<{ id: string }, []>("SELECT id FROM tasks ORDER BY rowid")
			.all()
			.map((row) => row.id);
		for (const id of ids) {
			const scanned = select.get(id);
			const parsed = scanned ? JSON.parse(scanned.data) : undefined;
			if (!parsed || !Object.hasOwn(parsed, "resultManifest")) continue;
			if (parsed.phase === "archived" && !parsed.disposition) {
				report.archived++;
				continue;
			}
			report.eligible++;
			report.eligibleBytes += Buffer.byteLength(canonicalJson(parsed.resultManifest));
			if (!apply) continue;
			try {
				const outcome = this.transaction("migrateResults", id, () => {
					const row = select.get(id);
					if (!row) return "alreadyExternal" as const;
					const legacy = JSON.parse(row.data);
					if (!Object.hasOwn(legacy, "resultManifest")) return "alreadyExternal" as const;
					if (legacy.phase === "archived" && !legacy.disposition) return "archived" as const;
					const encoded = this.encodeTask(legacy, true);
					demand(
						canonicalJson(this.decodeTask(encoded)) === canonicalJson(legacy),
						"RESULT_INTEGRITY",
						"Migration round trip mismatch",
					);
					const changes = this.db
						.query("UPDATE tasks SET data=? WHERE id=? AND data=?")
						.run(encoded, id, row.data).changes;
					demand(changes === 1, "MIGRATION_NOT_APPLIED", "Row update was not applied");
					return "migrated" as const;
				});
				report[outcome]++;
			} catch (error) {
				const code = migrationFailureCode(error);
				report.failed.push({ taskId: id, code, message: MIGRATION_FAILURE_TEXT.get(code) ?? MIGRATION_FAILURE_OTHER });
			}
		}
		// Freed pages stay in the file until the operator runs VACUUM (I4).
		const pages = this.db
			.query<{ free: number; size: number }, []>(
				"SELECT (SELECT freelist_count FROM pragma_freelist_count) AS free, (SELECT page_size FROM pragma_page_size) AS size",
			)
			.get()!;
		return { ...report, freeBytes: pages.free * pages.size };
	}

	/**
	 * Blob references of every externalised row, read one row at a time; inline
	 * rows are filtered out by SQLite and never parsed here. Rows whose stored
	 * form is unusable are reported in `rows` (L2), not thrown, so one bad row
	 * cannot hide the others. `unknownReferences` is true when some row's blob
	 * list cannot be read, so the referenced set is incomplete and gc must not run.
	 */
	protected referencedResults(): {
		referenced: Map<string, { bytes: number; taskIds: string[] }>;
		rows: { taskId: string; problem: string }[];
		unknownReferences: boolean;
		externalRows: string[];
	} {
		const referenced = new Map<string, { bytes: number; taskIds: string[] }>();
		const rows: { taskId: string; problem: string }[] = [];
		const externalRows: string[] = [];
		let unknownReferences = false;
		const fenced = this.resultFenced();
		const select = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?");
		const ids = this.db
			.query<{ id: string }, []>(
				"SELECT id FROM tasks WHERE json_type(data,'$.resultExternal') IS NOT NULL ORDER BY rowid",
			)
			.all();
		for (const { id } of ids) {
			const row = select.get(id);
			if (!row) continue;
			const parsed = JSON.parse(row.data);
			const stored = parsed.resultExternal;
			if (Object.hasOwn(parsed, "resultManifest"))
				rows.push({ taskId: id, problem: "Inline and externalised manifests both present" });
			else if (!fenced)
				rows.push({ taskId: id, problem: "Externalised result in a database without the result-store format fence" });
			else externalRows.push(id);
			const blobs: unknown[] | undefined = Array.isArray(stored?.blobs) ? stored.blobs : undefined;
			const valid =
				blobs?.every(
					(ref: any) =>
						typeof ref?.sha256 === "string" &&
						/^[a-f0-9]{64}$/.test(ref.sha256) &&
						Number.isSafeInteger(ref.bytes) &&
						ref.bytes >= 0,
				) ?? false;
			if (!valid) {
				unknownReferences = true;
				rows.push({ taskId: id, problem: "Invalid externalised result manifest or blob reference" });
				const at = externalRows.indexOf(id);
				if (at >= 0) externalRows.splice(at, 1);
				continue;
			}
			for (const ref of blobs as { sha256: string; bytes: number }[]) {
				const entry = referenced.get(ref.sha256) ?? { bytes: ref.bytes, taskIds: [] };
				if (!entry.taskIds.includes(id)) entry.taskIds.push(id);
				referenced.set(ref.sha256, entry);
			}
		}
		return { referenced, rows, unknownReferences, externalRows };
	}

	/**
	 * References and the directory listing, taken under the write lock when the
	 * store is writable: no writer then holds published blobs whose row has not
	 * committed, so the unreferenced/temporary lists are exact. A read-only
	 * store cannot take the lock and reports exact: false.
	 */
	protected resultListing() {
		const take = () => {
			const references = this.referencedResults();
			return { references, listing: this.results.listEntries(references.referenced) };
		};
		if (this.readOnly) return { ...take(), exact: false };
		return { ...this.transaction("resultListing", undefined, take), exact: true };
	}

	/**
	 * Verifies every referenced blob (outside the lock: gc never removes a
	 * referenced blob) and lists missing/corrupt (with task ids), unreferenced,
	 * temporary and unknown entries.
	 */
	resultInventory(): ResultInventory & { exact: boolean; rows: { taskId: string; problem: string }[] } {
		const { references, listing, exact } = this.resultListing();
		const blobs = this.results.verifyReferenced(references.referenced);
		// Row level: every externalised row whose blobs are all intact must also
		// rehydrate to its recorded digest (skeleton and reference list included).
		const damaged = new Set([...blobs.missing, ...blobs.corrupt].flatMap((entry) => entry.taskIds));
		const rows = [...references.rows];
		const select = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?");
		for (const id of references.externalRows) {
			if (damaged.has(id)) continue;
			const row = select.get(id);
			if (!row) continue;
			try {
				this.results.rehydrate(JSON.parse(row.data).resultExternal);
			} catch (error) {
				rows.push({
					taskId: id,
					problem: isResultIntegrity(error) ? REHYDRATE_INTEGRITY_TEXT : REHYDRATE_OTHER_TEXT,
				});
			}
		}
		return { ...blobs, ...listing, rows, exact };
	}

	/** Dry-run by default. --apply removes unreferenced blobs and abandoned temporaries while holding the write lock. */
	collectResults(apply = false) {
		demand(!apply || !this.readOnly, "READ_ONLY", "Store is read-only");
		if (!apply) {
			const { listing, exact, references } = this.resultListing();
			demand(!references.unknownReferences, "RESULT_INTEGRITY", "A row's result references cannot be read; run results check");
			return {
				dryRun: true,
				exact,
				removable: [...listing.unreferenced.map((entry) => entry.sha256), ...listing.temporary],
			};
		}
		return {
			dryRun: false,
			...this.transaction("collectResults", undefined, () => {
				const { referenced, unknownReferences, rows, externalRows } = this.referencedResults();
				demand(!unknownReferences && rows.length === 0, "RESULT_INTEGRITY", "A row's result references cannot be read; run results check");
				// A plausible blob array is not proof that its references are complete.
				// Validate the entire stored form before deleting anything, under the
				// same write lock as collection. Damaged rows must be repaired first.
				const select = this.db.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?");
				for (const id of externalRows)
					this.results.rehydrate(JSON.parse(select.get(id)!.data).resultExternal);
				return this.results.collect(referenced);
			}),
		};
	}

	/**
	 * The operator switch (on). Result externalisation is off until an operator
	 * calls this: deploying the code, opening, saving results, listing and
	 * dry-runs never change the format. Enabling itself changes no ladder
	 * version either: it records the switch row (an additive table ladder-v2
	 * code ignores) and a `result_store_enabled` audit event in one write
	 * transaction, so the database still opens in ladder-v2 builds and
	 * disableResultStore() fully undoes it until the first externalised row.
	 * The one-way step v2 -> v3 happens only in the transaction that commits the
	 * first externalised row (a later save, or migrateResults(true)).
	 * Idempotent: a second call changes nothing.
	 */
	enableResultStore(request: { actor: string; reason: string }) {
		return this.transaction("enableResultStore", undefined, () => {
			this.switchRequest(request);
			const userVersion = this.userVersion();
			const fenced = this.resultFenced();
			if (this.resultSwitch())
				return { enabled: true, changed: false, userVersion, oneWayStepTaken: fenced };
			this.db.exec(
				`CREATE TABLE IF NOT EXISTS ${RESULT_SWITCH_TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL, enabled_by TEXT NOT NULL CHECK(length(enabled_by) BETWEEN 1 AND 200), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000))`,
			);
			this.db
				.query(`INSERT INTO ${RESULT_SWITCH_TABLE}(id, enabled_at, enabled_by, reason) VALUES (1,?,?,?)`)
				.run(new Date().toISOString(), request.actor, request.reason);
			const counts = this.resultCounts();
			this.audit("result_store_enabled", {
				actor: request.actor,
				reason: request.reason,
				userVersion,
				feature: RESULT_STORE_FEATURE,
				inlineResults: counts.inline,
				externalResults: counts.external,
				oneWayStepTaken: fenced,
				oneWayAt: fenced ? "taken" : "first externalised row",
			});
			return { enabled: true, changed: true, userVersion, oneWayStepTaken: fenced };
		});
	}

	/**
	 * The operator switch (off). New results are stored inline again from the
	 * next write transaction on. Before the first externalised row this removes
	 * every trace of the switch except its audit events: the database is the
	 * ladder-v2 format older builds open. After the one-way step the database
	 * stays at ladder v3 and every externalised row stays readable; migrate
	 * --apply is refused until the switch is on again. Idempotent.
	 */
	disableResultStore(request: { actor: string; reason: string }) {
		return this.transaction("disableResultStore", undefined, () => {
			this.switchRequest(request);
			const userVersion = this.userVersion();
			const fenced = this.resultFenced();
			if (!this.resultSwitch())
				return { enabled: false, changed: false, userVersion, oneWayStepTaken: fenced };
			this.db.exec(`DROP TABLE ${RESULT_SWITCH_TABLE}`);
			const counts = this.resultCounts();
			this.audit("result_store_disabled", {
				actor: request.actor,
				reason: request.reason,
				userVersion,
				inlineResults: counts.inline,
				externalResults: counts.external,
				oneWayStepTaken: fenced,
			});
			return { enabled: false, changed: true, userVersion, oneWayStepTaken: fenced };
		});
	}

	/** Committed fences are never removed, so a fence seen outside a transaction is cached. */
	protected resultFenceCommitted = false;

	protected switchRequest(request: { actor: string; reason: string }): void {
		text(request?.actor);
		text(request.reason);
		demand(request.reason.length <= 1000 && request.actor.length <= 200, "INVALID_INPUT", "Reason or actor too long");
	}

	protected resultCounts(): { inline: number; external: number } {
		return this.db
			.query<{ inline: number; external: number }, []>(
				"SELECT COALESCE(SUM(json_type(data,'$.resultManifest') IS NOT NULL),0) AS inline, COALESCE(SUM(json_type(data,'$.resultExternal') IS NOT NULL),0) AS external FROM tasks",
			)
			.get()!;
	}

	/** Read-only report of the externalisation switch, the ladder and where results are stored. */
	resultStoreStatus() {
		return this.db
			.transaction(() => {
				const userVersion = this.userVersion();
				const features = this.hasFeatureTable() ? this.validateFeatures() : [];
				const counts = this.resultCounts();
				const enabled = this.resultSwitch();
				return {
					externalisation: enabled ? ("on" as const) : ("off" as const),
					userVersion,
					features,
					/** True once the first externalised row moved the database to ladder v3. */
					oneWayStepTaken: this.resultFenced(),
					inlineResults: counts.inline,
					externalResults: counts.external,
					...(enabled ? { enabledAt: enabled.enabledAt, enabledBy: enabled.enabledBy, reason: enabled.reason } : {}),
				};
			})
			.deferred();
	}

	/** Bind selected collection before node contact, including failed requests and retries. */
	bindResultCustody(taskId: string, paths: string[] | null): void {
		this.transaction("bindResultCustody", taskId, () => {
			const task = this.requireTask(taskId);
			demand(task.attemptId && task.result?.executionTerminal && !task.disposition, "RESULT_NOT_READY", "Settled attempt required");
			const request = { attemptId: task.attemptId, paths };
			if (task.input.autoCustody) demand(canonicalJson(paths) === canonicalJson(task.input.autoCustody.paths), "RESULT_CONFLICT", "Submission selector is immutable");
			if (task.resultCustodyRequest) {
				demand(canonicalJson(task.resultCustodyRequest) === canonicalJson(request), "RESULT_CONFLICT", "Result custody request is immutable");
				return;
			}
			if (task.resultManifest) {
				const cached = task.resultManifest as { custody?: { paths?: unknown } };
				demand(canonicalJson(cached.custody?.paths ?? null) === canonicalJson(paths), "RESULT_CONFLICT", "Cached custody differs from requested selection");
			}
			task.resultCustodyRequest = request;
			this.audit("result_custody_bound", request, taskId);
			this.save(task);
		});
	}

	/**
	 * `proof`: the node's separate provenance outcome for this manifest's outputHead (work-unit review evidence).
	 * Kept out of the manifest and every digest: its own `output_head_created` audit row, or an
	 * `output_head_unproven` row with the reason (and diagnostic) when it was asked and not obtained, written only
	 * with the first save. Undefined (switch off, role task): no row, exactly as without work units.
	 */
	saveResult(taskId: string, manifest: Json, proof?: OutputHeadProof, custodyOperationId?: string): TaskRecord {
		return this.transaction("saveResult", taskId, () => {
			nonemptyEvidence(manifest);
			const task = this.requireTask(taskId);
			// A collection that was in flight when a disposition committed never lands on the disposed record.
			if (task.input.autoCustody) {
				demand(!this.autoCustodyRefusal(taskId), "AUTO_CUSTODY_REFUSED", "Custody eligibility changed before save");
				demand(canonicalJson((manifest as any).custody?.paths ?? null) === canonicalJson(task.input.autoCustody.paths), "RESULT_CONFLICT", "Manifest differs from submission selector");
			}
			if (task.resultCustodyRequest) demand(task.resultCustodyRequest.attemptId === task.attemptId && canonicalJson((manifest as any).custody?.paths ?? null) === canonicalJson(task.resultCustodyRequest.paths), "RESULT_CONFLICT", "Manifest differs from durable custody request");
			demand(!task.disposition, "ARCHIVED_TASK", "A disposed task is an operator record; a late collected result is never saved onto it");
			demand(
				task.attemptId,
				"NO_ATTEMPT",
				"Results belong to a reserved attempt",
			);
			if (task.resultCustodyRequest) {
				const selected = (manifest as { custody?: { paths?: unknown } }).custody?.paths ?? null;
				demand(
					task.resultCustodyRequest.attemptId === task.attemptId && canonicalJson(selected) === canonicalJson(task.resultCustodyRequest.paths),
					"RESULT_CONFLICT",
					"Manifest differs from durable custody request",
				);
			}
			// Publish custody and its dispatch prerequisite in the same transaction. Never nest
			// recordOperationReceipt here: StoreCore.transaction uses BEGIN IMMEDIATE.
			if (custodyOperationId !== undefined) {
				text(custodyOperationId);
				const kind = "auto-custody";
				const row = this.db.query<DataRow, [string, string, string, string]>(
					"SELECT data FROM operations WHERE task_id=? AND attempt_id=? AND kind=? AND id=?",
				).get(taskId, task.attemptId ?? "", kind, custodyOperationId);
				const intent: OperationIntent | undefined = row ? JSON.parse(row.data) : undefined;
				demand(task.input.autoCustody && task.attemptId && intent &&
					intent.taskId === taskId && intent.attemptId === task.attemptId && intent.kind === kind &&
					intent.id === custodyOperationId && intent.key === intent.id &&
					intent.digest === digest(intent.payload) && canonicalJson(intent.payload) === canonicalJson({
						inputDigest: task.inputDigest, paths: task.input.autoCustody.paths,
					}), "OPERATION_BINDING", "Exact original custody claim required");
				const receipt: Json = { manifestDigest: digest(manifest) };
				const encodedReceipt = canonicalJson(receipt);
				if (intent.receipt !== undefined) {
					demand(canonicalJson(intent.receipt) === encodedReceipt, "OPERATION_CONFLICT", "Custody receipt is immutable");
				} else {
					intent.receipt = JSON.parse(encodedReceipt);
					this.db.query("UPDATE operations SET data=? WHERE task_id=? AND attempt_id=? AND kind=? AND id=?")
						.run(canonicalJson(intent), taskId, task.attemptId, kind, custodyOperationId);
					this.audit("operation_receipt", { operationId: custodyOperationId, kind, digest: digest(receipt) }, taskId);
				}
			}
			if (task.resultManifest !== undefined) {
				demand(
					canonicalJson(task.resultManifest) === canonicalJson(manifest),
					"RESULT_CONFLICT",
					"Result manifest is immutable",
				);
				return task;
			}
			task.resultManifest = manifest;
			this.audit("result_saved", { digest: digest(manifest) }, taskId);
			const head = (manifest as { outputHead?: unknown }).outputHead;
			if (proof !== undefined && typeof head === "string") {
				if (proof.created === true) this.audit(OUTPUT_HEAD_CREATED, { outputHead: head }, taskId);
				else this.audit(OUTPUT_HEAD_UNPROVEN, { outputHead: head, reason: proof.reason, ...this.diagnosticData(proof.diagnostic) }, taskId);
			}
			const saved = this.save(task);
			// Work-unit Step 1 (a): role tasks only; under its own savepoint, never able to undo this save.
			if (isRoleTask(saved)) recordInSave(this.workUnitAccess(), saved, manifest);
			return saved;
		});
	}

	/** Narrow access for src/work-unit.ts: its own tables, the audit writer and the refusal-audited transaction. */
	workUnitAccess(): WorkUnitAccess {
		return {
			db: this.db,
			readOnly: this.readOnly,
			transaction: (action, taskId, body) => this.transaction(action, taskId, body),
			audit: (kind, value, taskId) => this.audit(kind, value, taskId),
			dispatchDisabled: () => this.dispatchStatus().disabled,
		};
	}

	// Implemented by later classes in the chain
	abstract autoCustodyRefusal(taskId: string): string | undefined;
}
