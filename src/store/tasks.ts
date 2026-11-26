import type { FleetStore } from "./fleet-store";
import { randomUUID } from "node:crypto";
import { Json, NodeConfig, OperationIntent, TaskInput, TaskRecord, TaskState } from "../contracts";
import { FleetError, canonicalJson, demand, digest, object, placementRecord, selectNodeWithReason, sendRefusals, subjectNodeId, text, validateNode, validateTaskInput } from "../core";
import { DEFAULT_ADMISSION_POLICY, HeldCharge } from "../admission";
import { progressSettled } from "../progress";
import { ExternalManifest } from "../result-store";
import { assertFleetCommit, fleetCommitSubject, inputOptions } from "../work-unit";
import { assertSubject, subjectLinks } from "../subject";
import { DataRow, FEATURES_VERSION, RESULT_STORE_FEATURE, RESULT_STORE_OFF_MESSAGE, ReserveResources, ResultListing, STATE_COLUMN } from "./shared";
import { StoreCore } from "./core";

export abstract class StoreTasks extends StoreCore {
	/** Row JSON → TaskRecord. An externalised manifest is fully rehydrated and digest-verified, never summarised from claims. */
	protected decodeTask(data: string): TaskRecord {
		const row = JSON.parse(data);
		if (!Object.hasOwn(row, "resultExternal")) return row;
		const { resultExternal, ...rest } = row;
		let resultManifest: TaskRecord["resultManifest"];
		try {
			demand(!Object.hasOwn(row, "resultManifest"), "RESULT_INTEGRITY", "Inline and externalised manifests both present");
			demand(this.resultFenced(), "RESULT_INTEGRITY", "Externalised result in a database without the result-store format fence");
			resultManifest = this.results.rehydrate(resultExternal);
		} catch (error) {
			throw new FleetError("RESULT_INTEGRITY", `Task ${row.id} result: ${(error as Error).message}`);
		}
		// Same top-level key order as the inline row (canonicalJson sorts keys), so `show` prints both forms identically.
		const task = Object.fromEntries(
			Object.entries({ ...rest, resultManifest }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		) as unknown as TaskRecord;
		if (typeof task.resultManifest === "object" && task.resultManifest !== null)
			this.externalised.set(task.resultManifest, resultExternal);
		return task;
	}

	/**
	 * TaskRecord → row JSON. Must run under the write lock: blob publication
	 * happens before the row commit.
	 * Switch off and never stepped (the default; ladder v2): the row is exactly
	 * what code without this feature writes, canonicalJson(task).
	 * Switch on: a result already stored inline stays inline (only
	 * migrateResults moves it) and an archived task's result is never
	 * externalised (a disposed one's only by migrateResults); any other result is externalised, and the first such row
	 * takes the one-way ladder step v2 -> v3 in this same transaction.
	 * Switch off after the step: new results are stored inline again; a result
	 * already externalised stays externalised (and readable).
	 */
	protected encodeTask(task: TaskRecord, migrate = false): string {
		if (task.resultManifest === undefined) return canonicalJson(task);
		const fenced = this.resultFenced();
		const on = this.resultSwitch() !== undefined;
		if (!fenced && !on) {
			demand(!migrate, "RESULT_STORE_OFF", RESULT_STORE_OFF_MESSAGE);
			return canonicalJson(task);
		}
		const { resultManifest, ...rest } = task;
		const object =
			typeof resultManifest === "object" && resultManifest !== null
				? resultManifest
				: undefined;
		const manifestDigest = digest(resultManifest);
		const cached = fenced && object ? this.externalised.get(object) : undefined;
		let known = cached?.digest === manifestDigest ? cached : undefined;
		if (!known) {
			if (!migrate) {
				const current = this.db
					.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?")
					.get(task.id);
				const row = current ? JSON.parse(current.data) : undefined;
				if (row && Object.hasOwn(row, "resultManifest")) {
					demand(
						digest(row.resultManifest) === manifestDigest,
						"RESULT_CONFLICT",
						"Result manifest is immutable",
					);
					return canonicalJson(task);
				}
				// An externalised result this instance did not decode keeps its stored
				// form once it rehydrates to exactly this manifest (switch on or off).
				if (fenced && row && Object.hasOwn(row, "resultExternal") && row.resultExternal?.digest === manifestDigest) {
					demand(
						canonicalJson(this.results.rehydrate(row.resultExternal)) === canonicalJson(resultManifest),
						"RESULT_INTEGRITY",
						"Externalised result does not match the saved manifest",
					);
					known = row.resultExternal as ExternalManifest;
				}
			}
			if (!known) {
				// A disposed task's inline result stays eligible for the explicit migrateResults step.
				if (task.phase === "archived" && !(migrate && task.disposition)) return canonicalJson(task);
				if (!on) {
					demand(!migrate, "RESULT_STORE_OFF", RESULT_STORE_OFF_MESSAGE);
					return canonicalJson(task);
				}
			}
		}
		const stored = known ?? this.results.externalise(resultManifest);
		if (!fenced) {
			// The one-way point: only here, in the transaction that commits the first externalised row.
			const fromVersion = this.userVersion();
			const enabled = this.resultSwitch()!;
			this.stepResultStoreFormat();
			this.audit("result_store_format_step", {
				fromVersion,
				toVersion: FEATURES_VERSION,
				feature: RESULT_STORE_FEATURE,
				firstTaskId: task.id,
				by: migrate ? "migrate" : "save",
				enabledBy: enabled.enabledBy,
				reason: enabled.reason,
				oneWay: true,
			});
		}
		if (object) this.externalised.set(object, stored);
		return canonicalJson({ ...rest, resultExternal: stored } as unknown as Json);
	}

	protected save(task: TaskRecord): TaskRecord {
		// A settled task's progress record is never shown again (progressShown): drop it rather than keep it forever.
		if (task.progress && progressSettled(task)) delete task.progress;
		this.db
			.query("UPDATE tasks SET data=? WHERE id=?")
			.run(this.encodeTask(task), task.id);
		return task;
	}

	protected requireTask(id: string): TaskRecord {
		text(id);
		const task = this.task(id);
		demand(task, "NOT_FOUND", "Task does not exist");
		return task;
	}

	/** requireTask without the result: for reads that need row metadata only. */
	protected requireTaskState(id: string): TaskState {
		const task = this.taskState(id);
		demand(task, "NOT_FOUND", "Task does not exist");
		return task;
	}

	protected mutableAttempt(task: TaskRecord): void {
		demand(
			!this.getOperation(task.id, "cancel"),
			"CANCEL_PENDING",
			"Cancellation fences new effects",
		);
		demand(
			task.attemptId && task.held && !task.result?.executionTerminal,
			"NO_HELD_ATTEMPT",
			"Task has no mutable held attempt",
		);
		demand(
			task.phase !== "blocked_unknown" &&
				task.phase !== "cancel_unknown" &&
				task.phase !== "completed_unverified",
			"UNKNOWN_EXECUTION",
			"Unknown execution requires authoritative observation, not another effect",
		);
	}

	protected requireAdmissibleNode(task: TaskRecord): void {
		const current = task.nodeId === undefined ? undefined : this.nodes().find((node) => node.id === task.nodeId);
		demand(
			sendRefusals(task.input, task.nodeSnapshot, current).length === 0,
			"NODE_NOT_ADMISSIBLE",
			"The admitted node is not active for this task now; nothing is sent and the reservation stays held",
		);
	}

	/**
	 * Send-time admission: the task's admitted node, as registered NOW, is still hard-eligible for this
	 * task and still has the admitted route (see core sendRefusals). Callers check this immediately
	 * before a send that carries source, an archive, a prompt or session-creation arguments; the
	 * prepare/create/approval-attach/prompt claims check it again atomically. A refusal is audited
	 * (`refused`, NODE_NOT_ADMISSIBLE) and changes no task state: the reservation stays held.
	 */
	assertNodeAdmissible(taskId: string): void {
		this.transaction("assertNodeAdmissible", taskId, () => {
			this.requireAdmissibleNode(this.requireTask(taskId));
		});
	}

	putNode(node: NodeConfig): void {
		this.transaction("putNode", undefined, () => {
			validateNode(node);
			this.db
				.query(
					"INSERT INTO nodes(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
				)
				.run(node.id, canonicalJson(node));
			this.audit("node_updated", { nodeId: node.id });
		});
	}

	/** Remove a node from the inventory. Refused while any task record still points at it. */
	removeNode(nodeId: string): void {
		this.transaction("removeNode", undefined, () => {
			if (!this.nodes().some((node) => node.id === nodeId)) throw new Error("node_not_found");
			if (this.taskStates().some((task) => task.nodeId === nodeId)) throw new Error("node_has_tasks");
			this.db.query("DELETE FROM nodes WHERE id=?").run(nodeId);
			this.audit("node_removed", { nodeId });
		});
	}

	/** Archive disabled inventory only; never settle, release or replay its tasks. */
	unregisterNode(nodeId: string): void {
		this.transaction("unregisterNode", undefined, () => {
			text(nodeId);
			const node = this.nodes().find((node) => node.id === nodeId);
			if (!node) {
				const archived = this.db
					.query<{ found: number }, [string]>(
						"SELECT 1 AS found FROM audit WHERE task_id IS NULL AND kind='node_unregistered' AND json_extract(data,'$.nodeId')=? LIMIT 1",
					)
					.get(nodeId);
				demand(archived, "NOT_FOUND", "Node does not exist and has not been unregistered");
				return;
			}
			demand(!node.enabled, "NODE_ENABLED", "Disable the node before unregistering it");
			demand(
				!this.taskStates().some(
					(task) =>
						(task.nodeId === nodeId || task.nodeSnapshot?.id === nodeId) &&
						["preparing", "dispatching", "active", "approval_required"].includes(task.phase),
				),
				"NODE_HAS_LIVE_TASKS",
				"Node has preparing, dispatching, active or approval-waiting tasks",
			);
			this.db.query("DELETE FROM nodes WHERE id=?").run(nodeId);
			this.audit("node_unregistered", {
				nodeId,
				archivedNode: JSON.parse(canonicalJson(node)),
				scope: "inventory_only_no_task_release_or_remote_fence",
			});
		});
	}

	nodes(): NodeConfig[] {
		return this.db
			.query<DataRow, []>("SELECT data FROM nodes ORDER BY id")
			.all()
			.map((row) => JSON.parse(row.data));
	}

	submit(input: TaskInput): TaskRecord {
		let inserted = false;
		let knownInputDigest: string | undefined;
		const result = this.transaction(
			"submit",
			undefined,
			() => {
				validateTaskInput(input, inputOptions(this as unknown as FleetStore, input));
				const inputDigest = digest(input);
				knownInputDigest = inputDigest;
				const existing = this.db
					.query<DataRow, [string, string]>(
						"SELECT data FROM tasks WHERE caller=? AND request_key=?",
					)
					.get(input.caller, input.key);
				if (existing) {
					const task = this.decodeTask(existing.data);
					// The only way an input can name itself: its caller/key already identifies the subject task.
					demand(input.subject?.taskId !== task.id, "SUBJECT_SELF", "A task cannot be its own subject: this caller/key identifies the subject task");
					demand(
						task.inputDigest === inputDigest,
						"KEY_CONFLICT",
						"Caller/key already identifies a different task input",
					);
					return task;
				}
				this.assertDispatchEnabled();
				if (input.workUnit?.role === "review") assertFleetCommit(input, fleetCommitSubject(this.db, input.workUnit.subject.taskId));
				assertSubject(this.db, input);
				const task: TaskRecord = {
					id: randomUUID(),
					input: JSON.parse(canonicalJson(input)),
					inputDigest,
					phase: "queued",
					held: false,
				};
				this.db
					.query(
						"INSERT INTO tasks(id,caller,request_key,input_digest,data) VALUES (?,?,?,?,?)",
					)
					.run(
						task.id,
						input.caller,
						input.key,
						inputDigest,
						canonicalJson(task),
					);
				this.audit("submitted", { inputDigest }, task.id);
				inserted = true;
				return task;
			},
			(): Record<string, Json> =>
				knownInputDigest ? { inputDigest: knownInputDigest } : {},
		);
		if (!inserted) this.idempotentReuses++;
		if (inserted) {
			try {
				const origin = this.clock();
				if (origin !== undefined) {
					if (this.enqueueOrigins.size >= 1024) {
						this.enqueueOrigins.delete(
							this.enqueueOrigins.keys().next().value!,
						);
						this.evictedEnqueueOrigins++;
					}
					this.enqueueOrigins.set(result.id, origin);
				}
			} catch {
				this.telemetryFailures++;
			}
		}
		return result;
	}

	/** Every task with its fully verified result; one unreadable result fails the whole list. */
	tasks(): TaskRecord[] {
		return this.db
			.query<DataRow, []>("SELECT data FROM tasks ORDER BY rowid")
			.all()
			.map((row) => this.decodeTask(row.data));
	}

	/**
	 * Every task without its result. Scheduling, placement, the queue, the
	 * dashboard and listings use this, so one damaged result cannot stop
	 * admission of other work; results are verified where they are consumed
	 * (task(), tasks()). SQLite drops both result forms before the row reaches
	 * JavaScript, so an inline result is never copied into a JS string or
	 * parsed here and result blobs are never opened. SQLite itself still reads
	 * and JSON-parses every full row in this process, one row at a time: peak
	 * memory follows the largest single row, not the total size of all results,
	 * and no fixed memory figure is guaranteed.
	 */
	taskStates(): TaskState[] {
		return this.db
			.query<DataRow, []>(`SELECT ${STATE_COLUMN} AS data FROM tasks ORDER BY rowid`)
			.all()
			.map((row) => JSON.parse(row.data));
	}

	/** `show` fields of the subject linkage (src/subject.ts); {} for an unlinked task. */
	subjectLinks(task: Pick<TaskState, "id" | "input">, options: { reviews: boolean }): Record<string, Json> {
		return subjectLinks(this.db, task, options);
	}

	/** One task without its result (see taskStates). */
	taskState(id: string): TaskState | undefined {
		text(id);
		const row = this.db
			.query<DataRow, [string]>(`SELECT ${STATE_COLUMN} AS data FROM tasks WHERE id=?`)
			.get(id);
		return row ? JSON.parse(row.data) : undefined;
	}

	/**
	 * Listing rows: each task without its result plus the listing summary of
	 * its result (the CLI `tasks` contract: digest, status, files, tests), all
	 * read without the result body. SQLite hands JS only the scalars: status,
	 * the files/tests counts, the truthiness of the manifest value and, for an
	 * externalised row, its recorded digest (verified on every full read). An
	 * inline row's digest is the one its `result_saved` audit event recorded
	 * (results are immutable once saved); only a row without that event (written
	 * by hand or by a pre-audit build) is hashed here, one row at a time.
	 * show TASK_ID (task()) reads and verifies the result itself.
	 */
	taskListing(): { state: TaskState; result?: ResultListing }[] {
		return this.db
			.transaction(() => {
				const saved = new Map<string, string>();
				for (const row of this.db
					.query<{ task_id: string; digest: unknown }, []>(
						"SELECT task_id, json_extract(data,'$.digest') AS digest FROM audit WHERE kind='result_saved' AND task_id IS NOT NULL ORDER BY sequence",
					)
					.all())
					if (typeof row.digest === "string") saved.set(row.task_id, row.digest);
				const inlineManifest = this.db.query<{ manifest: string }, [string]>(
					"SELECT data -> '$.resultManifest' AS manifest FROM tasks WHERE id=?",
				);
				return this.db
					.query<
						{ id: string; data: string; stored: "inline" | "external" | null; falsy: string | null; external_digest: unknown; status: string | null; files: number | null; tests: number | null },
						[]
					>(
						`SELECT id, state AS data, stored, external_digest,
							CASE json_type(full, root) WHEN 'null' THEN 'null' WHEN 'false' THEN 'false'
								WHEN 'integer' THEN CASE WHEN json_extract(full, root) = 0 THEN '0' END
								WHEN 'real' THEN CASE WHEN json_extract(full, root) = 0 THEN '0' END
								WHEN 'text' THEN CASE WHEN length(json_extract(full, root)) = 0 THEN '""' END END AS falsy,
							full -> (root || '.status') AS status,
							CASE json_type(full, root || '.files') WHEN 'array' THEN json_array_length(full, root || '.files') END AS files,
							CASE json_type(full, root || '.tests') WHEN 'array' THEN json_array_length(full, root || '.tests') END AS tests
						FROM (SELECT rowid AS position, id, ${STATE_COLUMN} AS state, data AS full,
							CASE WHEN json_type(data,'$.resultExternal') IS NOT NULL THEN 'external' WHEN json_type(data,'$.resultManifest') IS NOT NULL THEN 'inline' END AS stored,
							CASE WHEN json_type(data,'$.resultExternal') IS NOT NULL THEN '$.resultExternal.skeleton' WHEN json_type(data,'$.resultManifest') IS NOT NULL THEN '$.resultManifest' END AS root,
							json_extract(data,'$.resultExternal.digest') AS external_digest
						FROM tasks) ORDER BY position`,
					)
					.all()
					.map((row) => {
						const state = JSON.parse(row.data) as TaskState;
						if (!row.stored) return { state };
						if (row.falsy !== null) return { state, result: { stored: row.stored, value: JSON.parse(row.falsy) } };
						const recorded = row.stored === "external" ? row.external_digest : saved.get(row.id);
						const result: ResultListing = {
							stored: row.stored,
							digest:
								typeof recorded === "string"
									? recorded
									: digest(JSON.parse(inlineManifest.get(row.id)?.manifest ?? "null")),
							...(row.status !== null ? { status: JSON.parse(row.status) } : {}),
							...(row.files !== null ? { files: row.files } : {}),
							...(row.tests !== null ? { tests: row.tests } : {}),
						};
						return { state, result };
					});
			})
			.deferred();
	}

	task(id: string): TaskRecord | undefined {
		text(id);
		const row = this.db
			.query<DataRow, [string]>("SELECT data FROM tasks WHERE id=?")
			.get(id);
		return row ? this.decodeTask(row.data) : undefined;
	}

	setNodeState(
		id: string,
		state: { enabled?: boolean; draining?: boolean },
	): NodeConfig {
		return this.transaction("setNodeState", undefined, () => {
			text(id);
			canonicalJson(state);
			object(state);
			demand(
				Object.keys(state).every(
					(key) => key === "enabled" || key === "draining",
				),
				"INVALID_INPUT",
				"Only enabled and draining can be changed",
			);
			for (const value of Object.values(state))
				demand(
					typeof value === "boolean",
					"INVALID_INPUT",
					"Node state must be boolean",
				);
			const row = this.db
				.query<DataRow, [string]>("SELECT data FROM nodes WHERE id=?")
				.get(id);
			demand(row, "NOT_FOUND", "Node does not exist");
			const node: NodeConfig = { ...JSON.parse(row.data), ...state };
			this.db
				.query("UPDATE nodes SET data=? WHERE id=?")
				.run(canonicalJson(node), id);
			this.audit("node_state", { nodeId: id, ...state });
			return node;
		});
	}

	/** Held tasks per node with their latest reservation time and whether a session exists yet. */
	heldCharges(states: readonly TaskState[] = this.taskStates()): Map<string, HeldCharge[]> {
		const out = new Map<string, HeldCharge[]>();
		const reservedAt = new Map(
			this.db
				.query<{ task_id: string; at: string }, []>("SELECT task_id, MAX(at) AS at FROM audit WHERE kind='reserved' AND task_id IS NOT NULL GROUP BY task_id")
				.all()
				.map((row) => [row.task_id, Date.parse(row.at)] as const)
				.filter(([, at]) => Number.isFinite(at)),
		);
		for (const task of states) {
			if (!task.held || !task.nodeId) continue;
			const list = out.get(task.nodeId) ?? [];
			// A missing or unparsable time counts as "after the sample" so it is always charged.
			list.push({ reservedAt: reservedAt.get(task.id) ?? Number.POSITIVE_INFINITY, started: Boolean(task.sessionId) });
			out.set(task.nodeId, list);
		}
		return out;
	}

	/**
	 * Admit a task onto a node. With `resources`, a node is eligible only while its fresh sample shows
	 * headroom (see admission.ts); there are no slot limits either way.
	 */
	reserve(taskId: string, resources?: ReserveResources): TaskRecord {
		return this.reserveInternal(taskId, resources);
	}

	protected reserveInternal(
		taskId: string,
		resources?: ReserveResources,
		eligible?: (task: TaskRecord) => boolean,
	): TaskRecord {
		const excluded = new Map<string, string[]>();
		for (const row of resources?.exclusions ?? []) {
			text(row?.nodeId);
			demand(Array.isArray(row.reasons) && row.reasons.length > 0 && !excluded.has(row.nodeId), "INVALID_INPUT", "Exclusions need unique nodes and reasons");
			for (const reason of row.reasons) text(reason);
			excluded.set(row.nodeId, [...row.reasons]);
		}
		const warning = resources?.healthWarning;
		if (warning) {
			text(warning.nodeId);
			demand(Array.isArray(warning.failingDimensions), "INVALID_INPUT", "Health warning needs failing dimensions");
			for (const dimension of warning.failingDimensions) text(dimension);
		}
		const start = this.clock();
		let outcome: "reserved" | "rejected" | "failed" | undefined;
		try {
			const result = this.transaction("reserve", taskId, () => {
				const task = this.requireTask(taskId);
				if (eligible && !eligible(task)) return task;
				demand(task.phase !== "archived", "ARCHIVED_TASK", "Archived tasks cannot be reserved");
				if (task.attemptId) return task;
				this.assertDispatchEnabled();
				const origin = this.enqueueOrigins.get(taskId);
				if (origin === undefined) this.missingEnqueueOrigins++;
				else if (start !== undefined)
					this.duration(
						"enqueue_to_admission",
						"admission_start",
						origin,
						start,
					);
				this.enqueueOrigins.delete(taskId);
				const now = Date.now();
				const policy = resources?.policy ?? DEFAULT_ADMISSION_POLICY;
				const states = this.taskStates();
				const selection = selectNodeWithReason(
					task.input,
					this.nodes().filter((node) => !excluded.has(node.id)),
					states,
					resources
						? {
								samples: resources.samples,
								held: this.heldCharges(),
								now,
								policy,
							}
						: undefined,
					subjectNodeId(task.input, states),
				);
				selection.exclusions = [
					...[...excluded].map(([nodeId, reasons]) => ({ nodeId, reasons })),
					...selection.exclusions,
				];
				// A rejection with exactly the exclusions already recorded on the task is counted on its placement
				// record instead of appending another identical selection row (bounded audit growth).
				const rejection = selection.nodeId
					? undefined
					: placementRecord(task.placement, task.input, selection.exclusions, new Date(now).toISOString());
				if (!rejection?.repeat)
					this.audit(
						"selection",
						{
							...JSON.parse(canonicalJson(selection)),
							outcome: selection.nodeId ? "selected" : "rejected",
							...(!selection.nodeId
								? { reason: "no_eligible_node" }
								: {}),
						},
						taskId,
					);
				if (rejection) {
					outcome = "rejected";
					task.reason = "no_eligible_node";
					task.placement = rejection.placement;
					return this.save(task);
				}
				task.nodeId = selection.nodeId;
				task.nodeSnapshot = this.nodes().find(
					(node) => node.id === selection.nodeId,
				)!;
				task.attemptId = randomUUID();
				task.phase = "preparing";
				task.held = true;
				delete task.reason;
				delete task.placement;
				this.audit(
					"reserved",
					{ nodeId: task.nodeId, attemptId: task.attemptId } as unknown as Json,
					taskId,
					task,
				);
				if (warning && warning.nodeId === task.nodeId)
					this.audit(
						"node_health_warning",
						{ nodeId: task.nodeId, pinned: true, failingDimensions: [...warning.failingDimensions] },
						taskId,
						task,
					);
				outcome = "reserved";
				return this.save(task);
			});
			if (outcome === undefined) this.idempotentReuses++;
			return result;
		} catch (error) {
			outcome = "failed";
			throw error;
		} finally {
			if (outcome) this.duration("admission", outcome, start);
			else this.durationNoops++;
		}
	}

	/** Atomic eligibility check and reservation; only the winning caller receives the attempt. */
	reserveQueued(taskId: string, resources: Omit<ReserveResources, "policy">): TaskRecord | undefined {
		let selected = false;
		const result = this.reserveInternal(taskId, resources, task => {
			if (task.phase !== "queued" || task.attemptId || task.sessionId || task.held ||
				this.db.query("SELECT 1 FROM operations WHERE task_id=? LIMIT 1").get(taskId)) return false;
			selected = true;
			return true;
		});
		return selected ? result : undefined;
	}

	/**
	 * The node-health selection gating switch (latest row of the additive `node_health_gating` table,
	 * written only by `NodeHealthHistory.setSelectionGating`). A plain read on this connection: no
	 * write lock, no table creation, also on a read-only store. No table or no row means off.
	 */
	nodeHealthGating(): { enabled: boolean; operator?: string; reason?: string; at?: number } {
		if (!this.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_health_gating'").get()) return { enabled: false };
		const row = this.db.query("SELECT enabled, operator, reason, at FROM node_health_gating ORDER BY id DESC LIMIT 1").get() as { enabled: number; operator: string; reason: string; at: number } | null;
		return row ? { enabled: row.enabled === 1, operator: row.operator, reason: row.reason, at: row.at } : { enabled: false };
	}

	// Implemented by later classes in the chain
	protected abstract stepResultStoreFormat(): void;
	protected abstract resultSwitch(): { enabledAt: string; enabledBy: string; reason: string } | undefined;
	protected abstract resultFenced(): boolean;
	protected abstract getOperation(taskId?: string, kind?: string): OperationIntent | undefined;
}
