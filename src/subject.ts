import type { Database } from "bun:sqlite";
import type { Json, TaskInput, TaskState } from "./contracts";
import { demand, digest } from "./core";

/**
 * Subject linkage (DESIGN step 2): a task names one file of another task's STORED result manifest in its
 * input (`subject: {taskId, path, sha256, otherNode?}`). The input is the only state: it is bound into the
 * input digest and deduplicated by caller/key like every other field. No table, column or migration.
 * Everything here is hub-only SQL over the tasks table; no node is contacted and no result blob is read.
 */

/** At most this many reviews are shown on `show SUBJECT`: the most recently submitted, newest first. */
export const SUBJECT_REVIEWS_SHOWN = 100;

/** The manifest root of a task row: the inline manifest, or the skeleton of an externalised one. */
const ROOT = "CASE WHEN json_type(data,'$.resultExternal') IS NOT NULL THEN '$.resultExternal.skeleton' WHEN json_type(data,'$.resultManifest') IS NOT NULL THEN '$.resultManifest' END";

/**
 * FleetStore.submit, inside its transaction, for a NEW task with a subject (a repeat of the same
 * caller/key/input is deduplicated before this and never re-checked). The subject task must exist and
 * have a stored result whose manifest holds exactly one live (not deleted) entry at `path` with exactly
 * `sha256`. Paths, SHA-256s and the deleted flag are skeleton fields, never externalised, so no blob is read.
 * With `otherNode: true`, a pin (`required.nodeId`) on the subject's node can never be placed: refused here.
 */
export function assertSubject(db: Database, input: TaskInput): void {
	const subject = input.subject;
	if (!subject) return;
	const row = db
		.query<{ node: unknown; root: string | null }, [string]>(`SELECT json_extract(data,'$.nodeId') AS node, ${ROOT} AS root FROM tasks WHERE id=?`)
		.get(subject.taskId);
	demand(row, "SUBJECT_NOT_FOUND", `Subject task ${subject.taskId} does not exist in this store`);
	demand(row.root !== null, "SUBJECT_NOT_COLLECTED", `Subject task ${subject.taskId} has no stored result; collect it first (result or export)`);
	const entries = db
		.query<{ sha256: unknown; deleted: unknown; type: unknown }, [string, string, string]>(
			`SELECT json_extract(f.value,'$.sha256') AS sha256, json_extract(f.value,'$.deleted') AS deleted, json_extract(f.value,'$.type') AS type
			FROM tasks, json_each(tasks.data, ?2) AS f
			WHERE tasks.id=?1 AND json_type(tasks.data, ?2) = 'array' AND json_extract(f.value,'$.path') = ?3`,
		)
		.all(subject.taskId, `${row.root}.files`, subject.path);
	const mismatch = (why: string) => `Subject file ${JSON.stringify(subject.path)} of task ${subject.taskId}: ${why}`;
	demand(entries.length > 0, "SUBJECT_FILE_MISMATCH", mismatch("not in the stored result"));
	demand(entries.length === 1, "SUBJECT_FILE_MISMATCH", mismatch("listed more than once in the stored result"));
	const entry = entries[0]!;
	demand(entry.deleted === 0 && entry.type === "regular", "SUBJECT_FILE_MISMATCH", mismatch("deleted in the stored result"));
	demand(entry.sha256 === subject.sha256, "SUBJECT_FILE_MISMATCH", mismatch(`stored SHA-256 is ${String(entry.sha256)}, not ${subject.sha256}`));
	demand(
		!(subject.otherNode === true && typeof row.node === "string" && input.required.nodeId === row.node),
		"SUBJECT_NODE_PINNED",
		`required.nodeId pins the subject's node ${String(row.node)} while subject.otherNode is true; the task could never be placed`,
	);
}

/**
 * The stored-result digest a listing reports (taskListing), read for one task without its result body, by the
 * listing's own rule: null when nothing is stored or the stored root is falsy (the listing shows the value, not a
 * digest); else the external digest or the last string `result_saved` audit digest; else the hash of the inline
 * manifest, whatever its JSON type.
 */
function resultDigest(db: Database, id: string): string | null {
	const row = db
		.query<{ root: string | null; external: unknown; falsy: number }, [string]>(
			`SELECT root, external, CASE json_type(full, root) WHEN 'null' THEN 1 WHEN 'false' THEN 1
				WHEN 'integer' THEN json_extract(full, root) = 0 WHEN 'real' THEN json_extract(full, root) = 0
				WHEN 'text' THEN length(json_extract(full, root)) = 0 ELSE 0 END AS falsy
			FROM (SELECT data AS full, ${ROOT} AS root, json_extract(data,'$.resultExternal.digest') AS external FROM tasks WHERE id=?)`,
		)
		.get(id);
	if (!row?.root || row.falsy) return null;
	const recorded =
		row.root === "$.resultExternal.skeleton"
			? row.external
			: db
					.query<{ digest: unknown }, [string]>(
						"SELECT json_extract(data,'$.digest') AS digest FROM audit WHERE kind='result_saved' AND task_id=? AND json_type(data,'$.digest')='text' ORDER BY sequence DESC LIMIT 1",
					)
					.get(id)?.digest;
	if (typeof recorded === "string") return recorded;
	const inline = db.query<{ manifest: string | null }, [string]>("SELECT data -> '$.resultManifest' AS manifest FROM tasks WHERE id=?").get(id);
	return digest(JSON.parse(inline?.manifest ?? "null"));
}

/**
 * The `show` fields of the linkage, in one read snapshot: `subject` (the input's subject plus the subject
 * task's current phase and node, one primary-key read) on a task that has one, and, only with `reviews`
 * (`show --reviews`), `reviews` on a task other tasks name as their subject. Finding reviews scans every tasks
 * row's JSON (no index: that would be a schema change), so plain `show` never does it. Archiving or disposing
 * either side changes nothing here: rows are never deleted and the input is immutable, so the link stays
 * readable and only the shown phase changes. Empty for unlinked tasks.
 */
export function subjectLinks(db: Database, task: Pick<TaskState, "id" | "input">, options: { reviews: boolean }): Record<string, Json> {
	return db
		.transaction(() => {
			const out: Record<string, Json> = {};
			const subject = task.input.subject;
			if (subject) {
				const row = db
					.query<{ phase: unknown; node: unknown }, [string]>("SELECT json_extract(data,'$.phase') AS phase, json_extract(data,'$.nodeId') AS node FROM tasks WHERE id=?")
					.get(subject.taskId);
				out.subject = {
					...subject,
					phase: typeof row?.phase === "string" ? row.phase : null,
					nodeId: typeof row?.node === "string" ? row.node : null,
				};
			}
			if (!options.reviews) return out;
			const total = db
				.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM tasks WHERE json_extract(data,'$.input.subject.taskId')=?")
				.get(task.id)!.n;
			if (total > 0) {
				const rows = db
					.query<{ id: string; phase: unknown; node: unknown; path: unknown; sha256: unknown }, [string, number]>(
						`SELECT id, json_extract(data,'$.phase') AS phase, json_extract(data,'$.nodeId') AS node,
							json_extract(data,'$.input.subject.path') AS path, json_extract(data,'$.input.subject.sha256') AS sha256
						FROM tasks WHERE json_extract(data,'$.input.subject.taskId')=? ORDER BY rowid DESC LIMIT ?`,
					)
					.all(task.id, SUBJECT_REVIEWS_SHOWN);
				out.reviews = rows.map((row) => ({
					taskId: row.id,
					phase: row.phase as string,
					nodeId: typeof row.node === "string" ? row.node : null,
					path: row.path as string,
					sha256: row.sha256 as string,
					resultDigest: resultDigest(db, row.id),
				}));
				if (total > rows.length) out.reviewsOmitted = total - rows.length;
			}
			return out;
		})
		.deferred();
}
