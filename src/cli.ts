#!/usr/bin/env bun
import { resolve } from "node:path";
import { lstatSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { FleetStore, nodeFailureCode, refusalCode, type ResultListing } from "./store";
import { digest, executionOutcome, exportReviewPending, FleetError, nodeRpcTimeoutMs, placementView } from "./core";
import type { TaskRecord } from "./contracts";
import type { ResourceSample } from "./admission";
import { submitPlacement, reconsiderQueue } from "./index";
import { NodeHealthHistory } from "./node-health";
import type { NodeHealthAccess } from "./node-health-gate";
import { deliverableCommand, workUnitsCommand } from "./work-unit-cli";
import { deliverableField, deliverableViews } from "./work-unit";
import { PROGRESS_MAX_SECONDS, progressShown } from "./progress";
import { compactTask, exitCodeHelp, exitOutcome, filteredTasks, filterTaskStates, operatorExit, parseTaskFilters, progressLine, runTask, watchTasks } from "./operator-commands";
import { publicLateReceipt, publicPollCliBody, publicSettlement } from "./dashboard-poll-view";

const help = `GJC Fleet — independent local single-hub operator CLI (Bun)
Usage: bun src/cli.ts [--db PATH] [--cap INTEGER] [--resources SAMPLES.json] [--local-node-id ID] [--read-only]
       [--stall-model-seconds N] [--stall-tool-seconds N] COMMAND
  node add CONFIG.json          enroll explicit nonsecret node configuration; optional transport.timeoutMs
                                (5000-600000) bounds each Coordinator call (default 30000, win32 120000);
                                read_turn/list_questions use max(it, 30000; win32 180000). Part of the node
                                identity: put the same value in the target NODE_CONFIG (helper upgraded first)
  node list                     inventory (not a live readiness assertion) + effectiveRpcTimeoutMs
  node drain|enable|disable ID   change new admission, never move live tasks
  node remove ID                drop a node from inventory; refused if any task references it
  node unregister ID            archive and remove disabled inventory only; refuses live/approval tasks
                                preserves task history and unknown/held effects; no replay, release or remote fence
  submit TASK.json              validate, deduplicate and admit onto a node with measured headroom
                                optional autoCustody:{paths:[sorted exact output paths]} authorizes
                                daemon selected collection only after confirmed successful execution
  queue reconsider [LIMIT]      reconsider at most 10 (maximum 100) unattempted queued tasks and start;
                                unplaceable tasks (only an operator change can place them) never take the
                                slots of waiting ones and are re-checked least recently checked first
  queue withdraw ID --reason TEXT [--actor NAME]
                                audited withdrawal of a queued task that never had an admitted attempt
                                (local DB only, never contacts a node): phase archived (exit table: failed);
                                reason/actor at most 200 characters; a repeat is already_withdrawn;
                                refused WITHDRAW_ATTEMPTED once an attempt exists (cancel/return own it)
  start TASK_ID                 prepare exact input, create then send once
  run TASK.json [--wait]        freshly measure/admit and start once; a repeat resolves the same task
                                (continues an unstarted attempt under an owner lease, never replays an
                                unknown effect; an archived task is reported, never run); exit codes below
  tasks [--phase P[,P]] [--node ID] [--key-prefix S] [--since ISO] [--disposition K[,K]] [--compact]
                                durable local state, no remote mutation; JSON unless --compact; lists
                                only where a result is stored
                                --subject TASK_ID: only tasks whose input subject names TASK_ID
  show TASK_ID                  durable local state, no remote mutation; reads and verifies the result
                                subject linkage: "subject" (with that task's phase); show TASK_ID --reviews
                                adds "reviews" (newest 100; scans every task row, so opt-in)
  poll TASK_ID                  public exact-turn observation and questions; a receipt-less failed
                                settlement keeps a read-only late-receipt check for 24 h
  answer TASK_ID ANSWER.json    exact fresh workflow binding, never auto-approve
  ordinary TASK_ID              retained ordinary candidates, NOT answer authority
  result TASK_ID [ARGV.json] [--select PATH]...
                                retrieve bound bytes; optionally run explicit test. --select takes exact
                                relative regular files, not globs; immutable selected-only custody and
                                selected-path diff. Omit for unchanged full-workspace collection.
  export TASK_ID DEST [--include GLOB]... [--require GLOB]...
                                copy files of the task's ONE collected result (stored: no node contact; else
                                the normal result collection, settled tasks only) into the new directory
                                DEST with fleet-export.json (SHA-256s, manifestDigest). --require: refused
                                (EXPORT_REQUIRED_MISSING) unless each pattern matches. DEST is never created
                                on a refusal; when no result is stored the normal collection runs and is
                                saved first, as result does. Never verification or success
  export review TASK_ID         export completeness, exclusions and the review digest to quote
  export accept TASK_ID REVIEW_DIGEST --operator NAME
                                audited operator acceptance of a completed_unverified task
                                whose export is incomplete (result.exportIncomplete);
                                refused if the exclusion set differs from REVIEW_DIGEST
  events TASK_ID                task-bound audit facts
  observability                 coherent local gauges, safe logs and coverage (not remote live)
  backup NEW_DESTINATION        consistent DB + NEW_DESTINATION.results; restore both together
  results status                result externalisation on/off, ladder version, inline/external counts
  results enable --confirm-one-way --reason TEXT
                                audited switch ON: new results' >=1 KiB fields leave the row. The DB stays
                                ladder v2 until the first externalised row, whose transaction takes the
                                ONE-WAY step to v3 (older builds then refuse the DB). Off by default
  results disable --reason TEXT audited switch OFF: new results inline again; externalised rows stay
                                readable; before the first externalised row the DB is plain ladder v2 again
  migrate results [--apply]     dry-run inline result migration; --apply (only when enabled) verifies each
                                row round trip then shrinks it; run VACUUM afterwards to shrink the file
  results check                 verify every referenced result blob and externalised row; list missing/corrupt/
                                rows/unreferenced/temporary
  results gc [--apply]          dry-run; --apply removes unreferenced blobs and abandoned temporaries
  rollback                      permanently suppress local new admissions/effect claims
  workunits status              work-unit switch on/off/inconsistent and deliverable record counts
  workunits enable --reason TEXT
                                audited switch ON: role tasks (input "workUnit": {"role": "review"|"report"},
                                prompt naming fleet-review/report.md) are accepted; a collected report is
                                recorded as a deliverable fact. Never a verification; phase stays unverified
  workunits disable --reason TEXT
                                audited switch OFF; refused while a role task has not started. Records stay
  deliverable TASK_ID           record a role task's collected report (local DB only, no node contact)
  deliverable TASK_ID --legacy-report PATH --sha256 HEX --role review|report --actor NAME --reason TEXT
                                Step 1b: operator classification of one role-less task whose only collected
                                file is PATH (report-<uuid>.md or fleet-review/report.md) with that SHA-256;
                                proves byte identity, not that anyone read the report. Never a verification
  Lane progress: poll, watch, run --wait and queue reconsider also read each live session's transcript on
  its node (one read-only command per node, at most once a minute per task) and record progress: stalled_model
  after more than --stall-model-seconds (default 480) without a write while waiting for the model, stalled_tool
  after more than --stall-tool-seconds (default 2400) while a tool runs, finished_unobserved (then the normal
  observation runs). Shown by tasks --compact, show, observability and the dashboard. Detection only: Fleet
  never kills, closes, resends or reassigns. An unreachable node adds up to its read deadline (POSIX 20 s,
  win32 60 s) to each of these commands, queue reconsider included even when it admits nothing.
  cancel TASK_ID                exact fresh exclusively owned ephemeral session abort and close
  stop TASK_ID                  legacy single-shot coordinator stop (session id only; prefer return)
  return TASK_ID...             settled-session resource return: fresh exact listing, then at most one
                                durable idle-only close fenced by the recorded generation/incarnation;
                                never replays an unanswered close; endpoint_stale is re-listed and is
                                not_ours only for another incarnation; exit 0 only if all returned.
                                Collected custody (result TASK_ID) first for every attempt; a refused
                                report keeps reason and adds refusal (not_settled, custody_missing, ...)
  return-override TASK_ID JSON  audited operator release of an unprovable held reservation
                                ({"operator","reason"} required); takes one fresh listing, sends no close,
                                releases at most once; refused if the listing shows the session gone,
                                live and not idle (possibly running a turn), or exact, live and idle
                                with no close tried. Reported released_by_operator_unconfirmed (exit 3),
                                never returned: the session was NOT observed gone and stays shown as
                                possibly running until a later fresh listing (return) shows it gone
  return-unblock NODE_ID JSON   audited operator clear of a node block after its GJC lifecycle
                                ledger is repaired ({"operator","reason"})
  node-health show [NODE_ID]    read-only: node stability, the selection gating switch, its audited
                                changes and what switching on would exclude (also under --read-only)
  node-health gating on [--force] JSON | gating off JSON
                                audited operator switch ({"operator","reason"}), stored in this DB,
                                default off. Off: submit, run, queue reconsider and reserve decide exactly
                                as without node health and never probe or record. on is refused while any
                                enabled node is not stable unless --force; it prints that preview
  node-health bootstrap NODE_ID --reason TEXT
                                explicit audited bootstrap: bounded real probes of one node
                                (fresh resource sample per probe); exit 0 only when stable
                                refused (node_health_gating_off) while gating is off
  task archive ID [--notes FILE] [--operator-override KIND --reason TEXT]
                  [--no-session-confirmation KIND --no-session-reason TEXT]
                                query original node and archive failed/unknown task
  task dispose ID --as deployed --commit SHA --reason TEXT
  task dispose ID --as superseded --by TASK_ID --reason TEXT
  task dispose ID --as review-recorded --subject TEXT --verdict clean|not-clean --reason TEXT
  task dispose ID --as discarded --reason TEXT
       (each also [--node-retired REASON] [--actor NAME] [--dry-run])
  task dispose --batch ITEMS.json [--actor NAME] [--dry-run]
                                audited operator RECORD for a completed_unverified task whose execution
                                ended: archives it (archivedFrom keeps phase, reason, result reference and
                                settlement) after the same fresh read-only session listing as task archive
                                (refused while the original session is live). Never releases a reservation:
                                a task still held is refused (DISPOSE_RESOURCE_UNPROVEN); run return ID
                                (or return-override) first. NOT verification and NOT
                                success: deployed records the operator's statement that the work landed in
                                SHA (7-40 hex), which Fleet cannot see or verify. The result is never read,
                                re-collected, rewritten, externalised or deleted. A same-actor repeat of the
                                same disposition is a no-op; a different one is refused. --dry-run writes
                                nothing. --batch: a JSON list of {taskId,as,reason,commit|by|subject+verdict,
                                nodeRetired?} (max 500), validated first (any malformed item: nothing
                                applied), then each item applied independently; exit 0 only if all disposed
  task accept-late-receipt ID --reason TEXT
                                re-read and accept a recorded late terminal_ok receipt of a
                                receipt-less failed settlement; task becomes completed_unverified
                                and only the normal verifier (result ID ARGV.json) can verify it
  ui [--port PORT] [--host IP] [--no-probe]
                                serve single-hub web dashboard (default: 127.0.0.1:8080);
                                --no-probe skips live SSH/GJC node measurement
  daemon run [--cycle-ms MS] [--lease-ms MS] [--queue-limit N] [--grace-ms MS]
                                the ONE supervised owner of periodic work on this DB (owner lease; a
                                second daemon is refused): re-checks queued tasks with fresh measurements
                                and publishes the ones admissible now (never reserves or starts them:
                                queue reconsider does), observes every observable task through poll (one
                                observation per task, one call per node, per-node pacing and backoff) and
                                returns settled sessions whose result is collected where return needs no
                                operator decision (at most the first close of an attempt), else notes why
                                once. Never sends prompts, answers, archives, verifies, collects or
                                resends. SIGTERM/SIGINT/SIGHUP stop it gracefully (in-flight calls get
                                --grace-ms, default 60000; on Windows only a console Ctrl+C does: a signal
                                sent by another process ends it at once); JSON lines on stdout
  daemon status                 the daemon's owner lease and published status: alive, last cycle,
                                per-node last success and backlog (exit 0 alive, 10 not running)
  watch TASK_ID [--interval MS] stream live poll observations until terminal
  watch --all-active [--interval MS] [--max-polls N]
                                bounded poll of every task seen active; a failed read is reported, not
                                marked unknown; a task ended by another actor is reported; exit codes below
  collection-rules REPO         on the node host, read-only: print the collection rules source root
                                REPO holds now (collection config, info/exclude, repository excludes
                                file); review them, then record them as node configuration
                                collectionRules[repoId] so no worker can change them
  input preview REQUEST OUT     stage explicit selected snapshots/object closure
  input authorize PKG SHA REF OUT  bind explicit authorization to exact digest
  input import PKG DEST         import only into a new task-owned repository
No slot limits: submit measures each node once over its registered transport and admits only where
CPU, memory and workspace disk have headroom; unmeasured or stale nodes are excluded.
--resources uses recorded samples ({"NODE": {ok, at, cpuPct, memTotal, memUsed, disks}}) instead of measuring.
--local-node-id explicitly identifies this host; matching platform alone never grants local probes.
Submit checks source, workspace and Coordinator readiness before resource admission; not execution proof.
--cap is kept for existing databases and is not enforced.
No automatic retries, merge, push, deployment or service installation.
Coordinator metadata cancellation is not execution cancellation.
Rollback still permits observation and backup; already claimed/forwarded effects are not stopped.
It is not a remote fence or proof that older snapshots/writers are safe.
Node health shares this DB (node_health_* tables only; schema version and fleet_meta unchanged). Only ui (not
--read-only) started with gating on records probes in the background (it stops once gating reads off), plus
node-health bootstrap (refused while gating is off); with gating on, submit, run and queue reconsider also
probe and record each decision.
A sample is health evidence only when this process measured it.
--read-only permits only tasks, show, events, observability, node list, results status, results check,
daemon status and node-health show on an existing compatible DB.
This is a local snapshot view, NOT live remote settlement or permission to replay work.
${exitCodeHelp()}
`;
// Only exact, reviewed diagnostic codes may cross the CLI's public output boundary.
// Do not accept arbitrary token-shaped messages: credentials can have that shape too.
const publicCliErrors = new Set(`
DIGEST_MISMATCH DISPATCH_DISABLED INPUT_AUTHORIZATION INVALID_EVIDENCE INVALID_INPUT NODE_NOT_ADMISSIBLE
OBSERVATION_UNAVAILABLE OPERATION_BINDING OPERATION_CONFLICT READ_ONLY ROLE_PROMPT_CONTRACT SCHEMA_VERSION
WORK_UNIT_SWITCH_INCONSISTENT archive_confirmation_requires_reason archive_override_requires_reason
atomic_publish_failed atomic_write_failed authorized_input_required authorized_objects_required
backup_source_required base_commit_mismatch before_base_mismatch cap_value_required
case_normalization_collision content_digest_mismatch current_before_mismatch current_file_conflict
daemon_requires_fresh_measurement db_path_required delete_failed destination_required
digest_reference_output_required directory_entry_limit dispose_option_value_required duplicate_object
duplicate_path empty_change exact_commit_required explicit_authorization_required extraneous_object
file_directory_collision git_object_digest_mismatch git_output_limit import_git_metadata_mismatch
import_head_mismatch import_object_mismatch import_parent_required input_byte_limit input_digest_mismatch
input_file_limit input_materialization_byte_limit input_object_limit input_tree_entry_limit
invalid_archive_option invalid_authorization invalid_commit invalid_content invalid_dispose_option
invalid_file_metadata invalid_identity invalid_input_limits invalid_input_package invalid_input_shape
invalid_object invalid_path invalid_result_arguments invalid_tree invalid_tree_name json_file_required
json_input_limit local_node_id_required local_node_not_registered missing_or_wrong_object
node_health_gating_off node_id_required node_not_found noncanonical_tree_order operation_failed
output_path_required repository_root_required resources_file_required run_requires_fresh_measurement
safe_writer_platform_unsupported selected_path_missing selected_path_required short_read short_write
source_changed source_index_conflict stall_seconds_positive_integer_required task_id_required task_not_found
task_owned_root_required tree_cycle_or_depth_limit tree_depth_limit unchanged_input unknown_command_use_help
unknown_input_command unknown_node_command unsafe_parent unsafe_workspace_root unsafe_write_leaf
unsafe_write_parent unsupported_source_entry unsupported_tree_entry usage_backup_NEW_DESTINATION
usage_collection_rules_REPO usage_daemon_run usage_daemon_run_or_status usage_daemon_status
usage_export_review_or_accept usage_migrate_results_apply usage_node_health usage_node_unregister
usage_queue_reconsider_LIMIT usage_queue_withdraw_ID_--reason_TEXT usage_results_disable_--reason_TEXT
usage_results_enable_--confirm-one-way_--reason_TEXT usage_results_status_enable_disable_check_or_gc_apply
usage_return_TASK_ID usage_return_override usage_return_unblock usage_rollback usage_run_TASK_JSON_wait
usage_task_accept_late_receipt_ID_--reason_TEXT usage_task_archive_ID
usage_task_dispose_--batch_FILE_[--actor_NAME]_[--dry-run] usage_task_dispose_ID_--as_KIND
usage_task_dispose_ID_--as_KIND_or_--batch_FILE usage_watch_all_active workspace_base_or_root_mismatch
workspace_head_mismatch workspace_identity_mismatch wrong_object_type
ARCHIVED_TASK RESULT_INTEGRITY SUBJECT_FILE_MISMATCH SUBJECT_NODE_PINNED SUBJECT_NOT_COLLECTED SUBJECT_NOT_FOUND
BACKUP_EXISTS BACKUP_FAILED DAEMON_RUNNING DAEMON_LEASE_LOST
DISPOSE_CONFLICT DISPOSE_INPUT DISPOSE_NOT_TERMINAL DISPOSE_PHASE DISPOSE_RESOURCE_UNPROVEN DISPOSE_RETURN_IN_PROGRESS DISPOSE_ROW_FORM DISPOSE_SUPERSEDER
EXPORT_REVIEW_CHANGED EXPORT_REVIEW_NOT_REQUIRED NOT_FOUND OVERRIDE_LISTING_REQUIRED RETURN_NOT_HELD
WITHDRAW_ATTEMPTED WITHDRAW_INPUT
backup_destination_exists duplicate_tasks_filter invalid_since_iso invalid_task_disposition invalid_task_phase
invalid_watch_bounds node_has_tasks selection_gating_approval_required
tasks_filter_value_required unknown_tasks_filter
usage_deliverable_TASK_ID
usage_deliverable_TASK_ID_--legacy-report_PATH_--sha256_HEX_--role_review|report_--actor_NAME_--reason_TEXT
usage_export_TASK_ID_DEST_[--include_GLOB]..._[--require_GLOB]...
`.trim().split(/\s+/));
for (let exit = 1; exit <= 255; exit++) publicCliErrors.add(`git_failed:exit=${exit}`);
const publicNodeTransport = new Set(["node_transport_failed", "node_timeout", "node_output_limit"]);
export function publicCliError(error: unknown): string {
	const code = error instanceof FleetError ? error.code : error instanceof Error ? error.message : "";
	// Only structured helper codes (nodeFailureCode) and the fixed transport trio are public; a bare
	// Error.message that happens to start with "node_" stays operation_failed.
	if (publicCliErrors.has(code) || publicNodeTransport.has(code) || nodeFailureCode.test(code)) return code;
	return "operation_failed";
}
export async function cli(argv: string[]): Promise<number> {
	const scope = { operator: false };
	try {
		return await runCli(argv, scope);
	} catch (error) {
		// The exit table's error row: once the global options parse, every error of run or watch --all-active
		// (usage, --read-only, store open, input, dispatch) also ends stdout with one JSON result line.
		if (scope.operator)
			console.log(JSON.stringify({ ok: false, error: publicCliError(error), exit: operatorExit.error, outcome: exitOutcome(operatorExit.error) }));
		throw error;
	}
}
async function runCli(argv: string[], scope: { operator: boolean }): Promise<number> {
	let db = resolve(".local/fleet.sqlite");
	let cap = 2;
	let readOnly = false;
	let resourcesFile: string | undefined;
	let localNodeId: string | undefined;
	const progress: { modelStallSeconds?: number; toolStallSeconds?: number } = {};
	const args: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--db") {
			if (!argv[i + 1] || argv[i + 1]!.startsWith("--"))
				throw new Error("db_path_required");
			db = resolve(argv[++i]!);
		} else if (argv[i] === "--cap") {
			if (!argv[i + 1] || argv[i + 1]!.startsWith("--"))
				throw new Error("cap_value_required");
			cap = Number(argv[++i]);
		} else if (argv[i] === "--resources") {
			if (!argv[i + 1] || argv[i + 1]!.startsWith("--"))
				throw new Error("resources_file_required");
			resourcesFile = resolve(argv[++i]!);
		} else if (argv[i] === "--local-node-id") {
			if (!argv[i + 1] || argv[i + 1]!.startsWith("--") || !argv[i + 1]!.trim())
				throw new Error("local_node_id_required");
			localNodeId = argv[++i]!;
		} else if (argv[i] === "--read-only") {
			readOnly = true;
		} else if (argv[i] === "--stall-model-seconds" || argv[i] === "--stall-tool-seconds") {
			const value = Number(argv[i + 1]);
			if (!/^\d{1,9}$/.test(argv[i + 1] ?? "") || value < 1 || value > PROGRESS_MAX_SECONDS) throw new Error("stall_seconds_positive_integer_required");
			progress[argv[i] === "--stall-model-seconds" ? "modelStallSeconds" : "toolStallSeconds"] = value;
			i++;
		} else args.push(argv[i]!);
	}
	if (!args.length || args[0] === "--help" || args[0] === "help") {
		process.stdout.write(help);
		return 0;
	}
	const [command, first, second] = args;
	// --all-active may appear anywhere among the watch arguments.
	const allActive = command === "watch" && args.includes("--all-active");
	scope.operator = command === "run" || allActive;
	const metadata =
		(["tasks", "observability", "ui"].includes(command!) && args.length >= 1) ||
		(["show", "events", "watch"].includes(command!) && args.length >= 2) ||
		(command === "node" && first === "list" && args.length === 2) ||
		(command === "results" && (first === "check" || first === "status") && args.length === 2) ||
		(command === "daemon" && first === "status" && args.length === 2) ||
		(command === "node-health" && first === "show");
	if (readOnly && !metadata) throw new Error("READ_ONLY");
	async function json(path: string | undefined) {
		if (!path) throw new Error("json_file_required");
		const file = Bun.file(path);
		if (file.size > 32 * 1024 * 1024) throw new Error("json_input_limit");
		return file.json();
	}
	/** stored: a listing's result summary read without the body (taskListing); same keys and place as for a full task. */
	function summary(task: TaskRecord, stored?: ResultListing) {
		const { input, nodeSnapshot, ...state } = stored
			? (Object.fromEntries(Object.entries({ ...task, resultManifest: "value" in stored ? stored.value : null }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) as unknown as TaskRecord)
			: task;
		const { inputPackage, ...withoutPackage } = input;
		const custodySummary = state.resultCustodyRequest?.paths
			? { custody: { kind: "selected", paths: state.resultCustodyRequest.paths, selectionDigest: digest(state.resultCustodyRequest.paths) } }
			: {};
		return {
			...state,
			// Lane progress only while the task is in a progress phase (a settled task's record is a frozen last read).
			...(state.progress && !progressShown(state) ? { progress: undefined } : {}),
			// Waiting for capacity vs unplaceable, in operator words; only while the task is a never-admitted queued task.
			...(state.placement ? { placement: placementView({ ...state, input }) } : {}),
			...(state.result
				? {
						result: {
							...state.result,
							evidence: { digest: digest(state.result.evidence) },
							...(state.result.verificationEvidence
								? {
										verificationEvidence: {
											digest: digest(state.result.verificationEvidence),
										},
									}
								: {}),
							...(state.result.settlement ? { settlement: publicSettlement(state.result.settlement) } : {}),
							...(state.result.lateReceipt ? { lateReceipt: publicLateReceipt(state.result.lateReceipt) } : {}),
						},
					}
				: {}),
			...(stored && "digest" in stored
				? { resultManifest: { digest: stored.digest, status: stored.status, files: stored.files, tests: stored.tests, ...custodySummary } }
				: state.resultManifest
				? {
						resultManifest: {
							...custodySummary,
							digest: digest(state.resultManifest),
							status: (state.resultManifest as any).status,
							files: (state.resultManifest as any).files?.length,
							tests: (state.resultManifest as any).tests?.length,
						},
					}
				: {}),
			...(state.testReceipt
				? {
						testReceipt: {
							digest: digest(state.testReceipt),
							exit: (state.testReceipt as any).exit,
						},
					}
				: {}),
			input: {
				...withoutPackage,
				prompt: "[omitted; retained in private database]",
				...(inputPackage
					? {
							inputPackage: {
								digest: inputPackage.digest,
								baseCommit: inputPackage.baseCommit,
								paths: inputPackage.changes.map((c) => c.path),
								objects: inputPackage.objects?.length ?? 0,
							},
						}
					: {}),
			},
		};
	}
	if (args[0] === "collection-rules") {
		// Node-local and read-only: no database is opened and the repository is never written.
		if (args.length !== 2 || !args[1]) throw new Error("usage_collection_rules_REPO");
		const { collectionRules } = await import("./workspace");
		console.log(JSON.stringify({ ok: true, repository: resolve(args[1]), collectionRules: await collectionRules(resolve(args[1])) }, null, 2));
		return 0;
	}
	if (args[0] === "input") {
		const { previewInput, authorizeInput, importRepository } = await import(
			"./inputs"
		);
		let value: unknown;
		if (args[1] === "preview") {
			if (!args[3]) throw new Error("output_path_required");
			const pkg = await previewInput(await json(args[2]));
			await writeFile(args[3], JSON.stringify(pkg), {
				flag: "wx",
				mode: 0o600,
			});
			value = {
				ok: true,
				digest: pkg.digest,
				baseCommit: pkg.baseCommit,
				paths: pkg.changes.map((c) => c.path),
				changes: pkg.changes.map((c) => ({
					path: c.path,
					operation:
						c.after === null
							? "delete"
							: c.before === null
								? "create"
								: "modify",
					before: c.before,
					after: c.after
						? {
								sha256: c.after.sha256,
								bytes: c.after.bytes,
								mode: c.after.mode,
							}
						: null,
				})),
				objects: pkg.objects?.length ?? 0,
				transferBytes:
					(pkg.objects ?? []).reduce((sum, o) => sum + o.size, 0) +
					pkg.changes.reduce((sum, c) => sum + (c.after?.bytes ?? 0), 0),
				authorized: false,
			};
		} else if (args[1] === "authorize") {
			if (!args[3] || !args[4] || !args[5])
				throw new Error("digest_reference_output_required");
			const pkg = authorizeInput(await json(args[2]), args[3], args[4]);
			await writeFile(args[5], JSON.stringify(pkg), {
				flag: "wx",
				mode: 0o600,
			});
			value = { ok: true, digest: pkg.digest, authorized: true };
		} else if (args[1] === "import") {
			if (!args[3]) throw new Error("destination_required");
			value = {
				ok: true,
				repository: await importRepository(
					resolve(args[3]),
					await json(args[2]),
				),
			};
		} else throw new Error("unknown_input_command");
		console.log(JSON.stringify(value, null, 2));
		return 0;
	}
	if (args[0] === "backup") {
		if (args.length !== 2 || !args[1])
			throw new Error("usage_backup_NEW_DESTINATION");
		try {
			if (!lstatSync(db).isFile()) throw new Error("backup_source_required");
		} catch {
			throw new Error("backup_source_required");
		}
	}
	const store = new FleetStore(db, cap, {
		readOnly:
			readOnly ||
			command === "observability" ||
			(command === "daemon" && first === "status") ||
			(command === "node-health" && first === "show"),
	});
	// The writable node-health history on this DB, opened only on first use (see nodeHealth).
	let health: NodeHealthHistory | undefined;
	try {
		if (command === "daemon" && first === "status") {
			if (args.length !== 2) throw new Error("usage_daemon_status");
			const daemon = store.daemonStatus();
			console.log(JSON.stringify({ ok: true, running: daemon?.alive === true, daemon: daemon ?? null }, null, 2));
			// 10: outside the operator exit-code table (there 3 is blocked_unknown).
			return daemon?.alive ? 0 : 10;
		}
		if (command === "return-override" || command === "return-unblock") {
			if (args.length !== 3 || !first) throw new Error(`usage_${command.replace("-", "_")}`);
			const approval = await json(second);
			if (command === "return-override") {
				const { operatorReleaseResource } = await import("./resource-return");
				const released = await operatorReleaseResource(store, first, approval);
				console.log(JSON.stringify({ ok: true, ...released }, null, 2));
				// Distinct non-zero exit: released, but the session was NOT observed gone.
				return 3;
			}
			store.clearResourceReturnNodeBlock(first, approval);
			console.log(JSON.stringify({ ok: true, nodeId: first, unblocked: true }, null, 2));
			return 0;
		}
		if (command === "return") {
			if (args.length < 2) throw new Error("usage_return_TASK_ID");
			const { returnResources } = await import("./resource-return");
			const reports = await returnResources(store, args.slice(1));
			console.log(JSON.stringify(reports, null, 2));
			return reports.every((report) => report.state === "returned") ? 0 : 1;
		}
		if (command === "rollback") {
			if (args.length !== 1) throw new Error("usage_rollback");
			console.log(JSON.stringify(store.enterRollback(), null, 2));
			return 0;
		}
		if (command === "node-health") {
			const { bootstrapNodeHealth, gatingPreview } = await import("./node-health-gate");
			if (first === "show" && args.length <= 3) {
				// Read-only view: never creates a table, migrates or takes a write lock.
				const view = new NodeHealthHistory(db, {}, { readOnly: true });
				try {
					const ids = second ? [second] : store.nodes().map((node) => node.id);
					console.log(JSON.stringify({ gating: store.nodeHealthGating(), gatingAudit: view.selectionGatingAudit(), nodes: ids.map((id) => view.dimensions(id)), preview: gatingPreview(store.nodes(), view) }, null, 2));
				} finally {
					view.close();
				}
				return 0;
			}
			if (first === "gating" && (second === "on" || second === "off")) {
				const force = second === "on" && args[3] === "--force";
				const file = args[force ? 4 : 3];
				if (!file || args.length !== (force ? 5 : 4)) throw new Error("usage_node_health");
				const { gatingApproval } = await import("./node-health");
				const approval = gatingApproval(await json(file));
				const refuse = (preview: ReturnType<typeof gatingPreview>) => {
					console.log(JSON.stringify({ ok: false, error: "node_health_not_stable", gating: store.nodeHealthGating(), preview }, null, 2));
					return 1;
				};
				if (second === "on" && !force) {
					// A refusal decided on the read-only view creates no table and writes nothing (review 5d0d5336 L2).
					// The writable open can only make a node less stable (migration restarts state), so a node unstable
					// here is unstable there too; the check is repeated on the writable history below.
					const view = new NodeHealthHistory(db, {}, { readOnly: true });
					let early: ReturnType<typeof gatingPreview>;
					try {
						early = gatingPreview(store.nodes(), view);
					} finally {
						view.close();
					}
					if (early.wouldBeExcluded.length) return refuse(early);
				}
				if (second === "off") {
					// Already off (no switch table, no row, or an off row): print the current state and write
					// nothing (no table, index, migration or row; review 55d3ca61 P2-1, r6 sweep).
					const current = store.nodeHealthGating();
					if (!current.enabled) {
						console.log(JSON.stringify({ ok: true, gating: current, unchanged: true }, null, 2));
						return 0;
					}
				}
				health = new NodeHealthHistory(db);
				if (second === "off") {
					console.log(JSON.stringify({ ok: true, gating: health.setSelectionGating(false, approval) }, null, 2));
					return 0;
				}
				// Switching on with nodes that are not stable would exclude them at once: refuse unless forced.
				const preview = gatingPreview(store.nodes(), health);
				if (preview.wouldBeExcluded.length && !force) return refuse(preview);
				console.log(JSON.stringify({ ok: true, forced: force, gating: health.setSelectionGating(true, approval), preview }, null, 2));
				return 0;
			}
			if (first === "bootstrap" && second && args.length === 5 && args[3] === "--reason" && args[4]) {
				// Switch off writes nothing: refuse before the history is opened (no table, row or probe; review b7eb69c8 F1).
				if (!store.nodeHealthGating().enabled) throw new Error("node_health_gating_off");
				const node = store.nodes().find((candidate) => candidate.id === second);
				if (!node) throw new Error("node_not_found");
				health = new NodeHealthHistory(db);
				const { sampleResourcesOnce } = await import("./dashboard");
				const [result] = await bootstrapNodeHealth([node], health, { reason: args[4], sampleResources: async (target) => (await sampleResourcesOnce([target])).get(target.id) });
				console.log(JSON.stringify({ ...result, health: health.dimensions(second) }, null, 2));
				return result!.outcome === "stable" || result!.outcome === "skipped_stable" ? 0 : 1;
			}
			throw new Error("usage_node_health");
		}
		// Handed to every admission; used only when the stored node-health switch is on. Samples taken
		// through it are stamped on receipt; recorded --resources files are never health evidence.
		const nodeHealth: NodeHealthAccess = {
			history: () => (health ??= new NodeHealthHistory(db)),
			...(resourcesFile
				? {}
				: {
						sample: async (stamp) => {
							const { sampleResourcesOnce } = await import("./dashboard");
							const nodes = store.nodes().filter((node) => node.enabled && !node.draining);
							return nodes.length ? sampleResourcesOnce(nodes, undefined, stamp) : new Map();
						},
					}),
		};
		// The same local projection serves normal and read-only observation; no
		// runtime adapter or Fleet is needed for metadata.
		if (
			["tasks", "show", "events", "observability"].includes(command!) ||
			(command === "node" && first === "list")
		) {
			let value: unknown;
			// An operator release is shown as possibly still running until a fresh listing shows it gone; a
			// held attempt whose prepare the node provably refused before send is shown with its typed refusal.
			// Work-unit Step 1: undefined while the switch is not on, so the views stay exactly as without it.
			const deliverables = command === "tasks" || command === "show" ? deliverableViews(store) : undefined;
			const view = (task: TaskRecord, stored?: ResultListing) => {
				const resourceReturn = store.resourceReturnStatus(task.id);
				const refused = store.retainedPreparationRefusal(task.id);
				const refusal = (refused?.receipt as any)?.nodeRefusal;
				return {
					...summary(task, stored),
					...(refused ? { preparationRefusal: { operationId: refused.id, attemptId: refused.attemptId, code: refusalCode(refusal), certainty: refusal.certainty } } : {}),
					...(resourceReturn ? { resourceReturn } : {}),
					...deliverableField(deliverables, task.id),
				};
			};
			if (command === "tasks") {
				const filters = parseTaskFilters(args.slice(1));
				if (filters.compact) {
					for (const task of filteredTasks(store, filters)) console.log(compactTask(store, task));
					return 0;
				}
				// A listing never reads result bodies (taskListing); show TASK_ID reads and verifies the result.
				const listing = store.taskListing();
				const kept = new Set(filterTaskStates(store, listing.map(({ state }) => state), filters).map((task) => task.id));
				value = listing.filter(({ state }) => kept.has(state.id)).map(({ state, result }) => view(state as TaskRecord, result));
			} else if (command === "observability") value = store.observability();
			else if (command === "events") value = store.events(first!);
			else if (command === "node") value = store.nodes().map((node) => ({ ...node, effectiveRpcTimeoutMs: nodeRpcTimeoutMs(node) }));
			else {
				const task = store.task(first!);
				if (!task) throw new Error("task_not_found");
				// Diagnostic of the event that set the current reason, display only; never an input to any decision.
				const cause = store.reasonDiagnostic(task.id);
				// Subject linkage: absent on an unlinked task, so its view is unchanged. `reviews` scans every
				// tasks row, so only `show TASK_ID --reviews` reads them; plain show stays a per-task read.
				value = { ...view(task), ...store.subjectLinks(task, { reviews: args.slice(2).includes("--reviews") }), ...(cause ? { failureDiagnostic: { event: cause.event, sequence: cause.sequence, ...cause.diagnostic } } : {}) };
			}
			console.log(JSON.stringify(value, null, 2));
			return 0;
		}
		if (args[0] === "backup") {
			console.log(
				JSON.stringify({ ok: true, ...store.backup(args[1]!) }, null, 2),
			);
			return 0;
		}
		if (command === "workunits") return workUnitsCommand(store, args);
		if (command === "deliverable") return await deliverableCommand(store, args);
		if (command === "migrate") {
			if (first !== "results" || args.length > 3 || (args.length === 3 && args[2] !== "--apply"))
				throw new Error("usage_migrate_results_apply");
			const report = store.migrateResults(args.length === 3);
			console.log(JSON.stringify({ ok: report.failed.length === 0, ...report }, null, 2));
			return report.failed.length === 0 ? 0 : 1;
		}
		if (command === "results") {
			if (first === "status" && args.length === 2) {
				console.log(JSON.stringify({ ok: true, ...store.resultStoreStatus() }, null, 2));
				return 0;
			}
			if (first === "enable") {
				// The deliberate, audited switch: never implied by deploy, save or migrate. It permits
				// the one-way step, which the first externalised row's transaction then takes.
				if (args.length !== 5 || args[2] !== "--confirm-one-way" || args[3] !== "--reason" || !args[4])
					throw new Error("usage_results_enable_--confirm-one-way_--reason_TEXT");
				console.log(JSON.stringify({ ok: true, ...store.enableResultStore({ actor: "operator", reason: args[4] }) }, null, 2));
				return 0;
			}
			if (first === "check" && args.length === 2) {
				const report = store.resultInventory();
				const ok = report.missing.length === 0 && report.corrupt.length === 0 && report.rows.length === 0;
				console.log(JSON.stringify({ ok, ...report }, null, 2));
				return ok ? 0 : 1;
			}
			if (first === "gc" && (args.length === 2 || (args.length === 3 && args[2] === "--apply"))) {
				console.log(JSON.stringify({ ok: true, ...store.collectResults(args.length === 3) }, null, 2));
				return 0;
			}
			if (first === "disable") {
				if (args.length !== 4 || args[2] !== "--reason" || !args[3])
					throw new Error("usage_results_disable_--reason_TEXT");
				console.log(JSON.stringify({ ok: true, ...store.disableResultStore({ actor: "operator", reason: args[3] }) }, null, 2));
				return 0;
			}
			throw new Error("usage_results_status_enable_disable_check_or_gc_apply");
		}
		const { Fleet } = await import("./fleet");
		const fleet = new Fleet(store, { localNodeId, progress });
		if (command === "export" && first !== "review" && first !== "accept") {
			const { exportCommand } = await import("./result-export");
			return await exportCommand(fleet, args);
		}
		if (command === "daemon") {
			if (first !== "run") throw new Error("usage_daemon_run_or_status");
			if (resourcesFile) throw new Error("daemon_requires_fresh_measurement");
			if (localNodeId && !store.nodes().some(node => node.id === localNodeId)) throw new Error("local_node_not_registered");
			const flags: Record<string, keyof import("./daemon").DaemonOptions> = { "--cycle-ms": "cycleMs", "--lease-ms": "leaseMs", "--queue-limit": "queueLimit", "--grace-ms": "graceMs" };
			const options: Record<string, number> = {};
			for (let i = 2; i < args.length; i += 2) {
				const key = flags[args[i]!];
				const value = Number(args[i + 1]);
				if (!key || options[key] !== undefined || args[i + 1] === undefined || !Number.isSafeInteger(value)) throw new Error("usage_daemon_run");
				options[key] = value;
			}
			const { FleetDaemon } = await import("./daemon");
			const daemon = new FleetDaemon(fleet, { ...options, ...(localNodeId ? { localNodeId } : {}), log: event => console.log(JSON.stringify(event)) });
			daemon.acquire();
			const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
			const onSignal = () => daemon.stop();
			for (const signal of signals) process.on(signal, onSignal);
			try {
				const { abandoned } = await daemon.run();
				// Abandoned in-flight reads are dropped with this process; their issued polls are superseded later.
				if (abandoned) setTimeout(() => process.exit(process.exitCode ?? 0), 0).unref?.();
				return 0;
			} finally {
				for (const signal of signals) process.off(signal, onSignal);
			}
		}
		if (command === "run") {
			if (!first || args.length > 3 || (args[2] !== undefined && args[2] !== "--wait")) throw new Error("usage_run_TASK_JSON_wait");
			if (resourcesFile) throw new Error("run_requires_fresh_measurement");
			const result = await runTask(fleet, await json(first), { localNodeId, sample: async store => {
				const { sampleResourcesOnce } = await import("./dashboard");
				const nodes = store.nodes().filter(node => node.enabled && !node.draining);
				return nodes.length ? sampleResourcesOnce(nodes) : new Map();
			}, nodeHealth });
			console.log(JSON.stringify({ taskId: result.task.id, nodeId: result.task.nodeId ?? null, sessionId: result.task.sessionId ?? null,
				phase: result.task.phase, operationId: result.operationId ?? null, reused: result.reused, placement: result.placement,
				exit: result.code, outcome: exitOutcome(result.code) }));
			if (args[2] === "--wait" && result.code === operatorExit.ok)
				return await watchTasks(fleet, { ids: [result.task.id], emit: value => console.log(JSON.stringify(value)) });
			return result.code;
		}
		if (allActive) {
			if (readOnly) throw new Error("READ_ONLY");
			let interval = 2000;
			let maxPolls = 1800;
			let flag = false;
			for (let i = 1; i < args.length; i++) {
				if (args[i] === "--all-active" && !flag) flag = true;
				else if (args[i] === "--interval" && args[i + 1]) interval = Number(args[++i]);
				else if (args[i] === "--max-polls" && args[i + 1]) maxPolls = Number(args[++i]);
				else throw new Error("usage_watch_all_active");
			}
			return await watchTasks(fleet, { allActive: true, interval, maxPolls, emit: value => console.log(JSON.stringify(value)) });
		}
		let value: unknown;
		switch (command) {
			case "queue": {
				if (first === "withdraw") {
					// Local DB only: never contacts a node (the task never had an attempt).
					const flags = new Map<string, string>();
					for (let i = 3; i < args.length; i += 2) {
						if (!["--reason", "--actor"].includes(args[i]!) || flags.has(args[i]!) || args[i + 1] === undefined) throw new Error("usage_queue_withdraw_ID_--reason_TEXT");
						flags.set(args[i]!, args[i + 1]!);
					}
					if (!second || !flags.has("--reason")) throw new Error("usage_queue_withdraw_ID_--reason_TEXT");
					const withdrawn = store.withdrawQueued(second, flags.get("--reason")!, flags.get("--actor") ?? "operator");
					value = { ok: true, ...withdrawn, task: summary(withdrawn.task as TaskRecord) };
					break;
				}
				if (first !== "reconsider" || args.length > 3) throw new Error("usage_queue_reconsider_LIMIT");
				const { sampleResourcesOnce } = await import("./dashboard");
				value = (await reconsiderQueue(fleet, async () => resourcesFile
					? new Map(Object.entries(await json(resourcesFile)))
					: sampleResourcesOnce(store.nodes().filter(node => node.enabled && !node.draining)),
					{ localNodeId, limit: second === undefined ? 10 : Number(second), nodeHealth })).map((task) => summary(task));
				break;
			}
			case "task":
				if (first === "accept-late-receipt") {
					// Audited operator acceptance; the normal verifier (`result ID ARGV.json`) still decides.
					if (!second || args.length !== 5 || args[3] !== "--reason" || !args[4]) throw new Error("usage_task_accept_late_receipt_ID_--reason_TEXT");
					value = summary(await fleet.acceptLateReceipt(second, { reason: args[4] }));
					break;
				}
				if (first === "dispose") {
					// Operator record through the archive machinery; never verification, never success, result untouched.
					const flags: Record<string, string | true> = {};
					const valued: Record<string, string> = { "--as": "kind", "--commit": "commit", "--by": "supersededBy", "--subject": "subject", "--verdict": "verdict", "--reason": "reason", "--node-retired": "nodeRetired", "--actor": "", "--batch": "" };
					const batch = second === "--batch";
					if (!second || (second.startsWith("--") && !batch)) throw new Error("usage_task_dispose_ID_--as_KIND_or_--batch_FILE");
					for (let i = batch ? 2 : 3; i < args.length; i++) {
						const flag = args[i]!;
						if (flags[flag] !== undefined || !(flag === "--dry-run" || Object.hasOwn(valued, flag))) throw new Error("invalid_dispose_option");
						if (flag === "--dry-run") { flags[flag] = true; continue; }
						const v = args[++i];
						if (v === undefined || v === "") throw new Error("dispose_option_value_required");
						flags[flag] = v;
					}
					const actor = (flags["--actor"] as string | undefined) ?? "operator";
					const dryRun = flags["--dry-run"] === true;
					if (batch) {
						if (Object.keys(flags).some((flag) => !["--batch", "--actor", "--dry-run"].includes(flag)) || typeof flags["--batch"] !== "string")
							throw new Error("usage_task_dispose_--batch_FILE_[--actor_NAME]_[--dry-run]");
						const items = await fleet.disposeBatch(await json(flags["--batch"] as string), actor, { dryRun });
						const refused = items.filter((item) => !item.ok).length;
						console.log(JSON.stringify({ ok: refused === 0, dryRun, total: items.length, refused, items }, null, 2));
						return refused === 0 ? 0 : 1;
					}
					if (flags["--batch"] !== undefined || typeof flags["--as"] !== "string") throw new Error("usage_task_dispose_ID_--as_KIND");
					const request: Record<string, string> = {};
					for (const [flag, field] of Object.entries(valued)) if (field && typeof flags[flag] === "string") request[field] = flags[flag] as string;
					value = { ok: true, ...(await fleet.dispose(second, request as any, actor, { dryRun })) };
					break;
				}
				if (first !== "archive" || !second) throw new Error("usage_task_archive_ID");
				{
					const options: Record<string, string> = {};
					for (let i = 3; i < args.length; i += 2) {
						const flag = args[i]!;
						if (!["--notes", "--operator-override", "--reason", "--no-session-confirmation", "--no-session-reason"].includes(flag) || !args[i+1] || options[flag]) throw new Error("invalid_archive_option");
						options[flag] = args[i+1]!;
					}
					if (!!options["--operator-override"] !== !!options["--reason"]) throw new Error("archive_override_requires_reason");
					if (!!options["--no-session-confirmation"] !== !!options["--no-session-reason"]) throw new Error("archive_confirmation_requires_reason");
					value = summary(await fleet.archive(second, {
						...(options["--notes"] ? {notes: await json(options["--notes"])} : {}),
						...(options["--no-session-confirmation"] ? {noSessionConfirmation: {kind: options["--no-session-confirmation"] as any, reason: options["--no-session-reason"]!}} : {}),
						...(options["--operator-override"] ? {operatorOverride: {kind: options["--operator-override"] as any, reason: options["--reason"]!}} : {}),
					}));
				}
				break;
			case "node":
				if (first === "add") {
					store.putNode(await json(second));
					value = { ok: true };
				} else if (["drain", "enable", "disable"].includes(first!)) {
					if (!second) throw new Error("node_id_required");
					store.setNodeState(
						second,
						first === "drain"
							? { draining: true }
							: first === "enable"
								? { enabled: true, draining: false }
								: { enabled: false },
					);
					value = { ok: true };
				} else if (first === "remove") {
					if (!second) throw new Error("node_id_required");
					store.removeNode(second);
					value = { ok: true };
				} else if (first === "unregister") {
					if (!second) throw new Error("node_id_required");
					if (args.length !== 3) throw new Error("usage_node_unregister");
					store.unregisterNode(second);
					value = { ok: true };
				} else throw new Error("unknown_node_command");
				break;
			case "submit":
				{
					// Admission is bounded by fresh measured headroom on each node, never by slot counts.
					const input = await json(first);
					let samples: Map<string, ResourceSample>;
					if (resourcesFile) samples = new Map(Object.entries(await json(resourcesFile)));
					else {
						const { sampleResourcesOnce } = await import("./dashboard");
						samples = await sampleResourcesOnce(store.nodes().filter((node) => node.enabled && !node.draining));
					}
					if (localNodeId && !store.nodes().some(node => node.id === localNodeId))
						throw new Error("local_node_not_registered");
					const placed = await submitPlacement(fleet, input, { samples }, { localNodeId, nodeHealth });
					// With the node-health switch on, the gate's decisions are shown with the report.
					value = { ...summary(placed.task), placement: "health" in placed ? { ...placed.report, nodeHealth: placed.health } : placed.report };
				}
				break;
			case "start":
				value = summary(await fleet.start(first!));
				break;
			case "poll": {
				const result = await fleet.inspect(first!);
				// The poll just observed the turn; only progress is recorded here (no second observation).
				let refreshed: Awaited<ReturnType<typeof fleet.refreshProgress>>[number] | undefined;
				try {
					refreshed = (await fleet.refreshProgress([first!], { settle: false })).find((entry) => entry.taskId === result.task.id);
				} catch {
					// Progress is display only: the poll result stands.
				}
				value = publicPollCliBody(
					result,
					summary(refreshed ? { ...result.task, progress: refreshed.progress } : result.task),
				);
				break;
			}
			case "answer":
				value = await fleet.answer(first!, await json(second));
				break;
			case "ordinary":
				value = await fleet.ordinary(first!);
				break;
			case "result": {
				const selectors: string[] = [];
				let testFile: string | undefined;
				for (let i = 2; i < args.length; i++) {
					if (args[i] === "--select") {
						const selector = args[++i];
						if (!selector || selector.startsWith("--")) throw new Error("selected_path_required");
						selectors.push(selector);
					} else if (args[i]!.startsWith("--") || testFile) throw new Error("invalid_result_arguments");
					else testFile = args[i];
				}
				value = await fleet.result(
					first!,
					testFile ? await json(testFile) : undefined,
					selectors.length ? selectors : undefined,
				);
				break;
			}
			case "export": {
				if (first === "review" && args.length === 3) value = fleet.exportReview(second!);
				else if (first === "accept" && args.length === 6 && args[4] === "--operator")
					value = summary(fleet.acceptIncompleteExport(second!, { operator: args[5]!, reviewDigest: args[3]! }));
				else throw new Error("usage_export_review_or_accept");
				break;
			}
			case "cancel": {
				const result = (await fleet.cancel(first!)) as { task: TaskRecord };
				value = { ...result, task: summary(result.task) };
				break;
			}
			case "stop":
				value = await fleet.stop(first!);
				break;
			case "ui": {
				const { startDashboardServer } = await import("./dashboard");
				let port = 8080;
				let host = "127.0.0.1";
				let probeNodes = true;
				for (let i = 0; i < args.length; i++) {
					if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
					else if (args[i] === "--host" && args[i + 1]) host = String(args[++i]);
					else if (args[i] === "--no-probe") probeNodes = false;
				}
				// The long-lived hub producer records health only while the stored switch is on. Switch off,
				// read-only or --no-probe: a read-only view that only displays (no table, row or probe).
				health = new NodeHealthHistory(db, {}, { readOnly: readOnly || !probeNodes || !store.nodeHealthGating().enabled });
				const server = startDashboardServer(store, port, host, { probeNodes, healthHistory: health });
				console.log(JSON.stringify({ ok: true, url: `http://${host}:${server.port}` }));
				// Run until a signal, then stop the server so its node resource streams are closed.
				await new Promise<void>((resolve) => {
					for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, () => resolve());
				});
				server.stop(true);
				process.exit(0);
				break;
			}
			case "watch": {
				if (!first) throw new Error("task_id_required");
				let interval = 2000;
				for (let i = 0; i < args.length; i++) {
					if (args[i] === "--interval" && args[i + 1]) interval = Number(args[++i]);
				}
				let lastDigest = "";
				let lastProgress = "";
				while (true) {
					// Metadata only (M2): never reads the result body.
					const task = store.taskState(first);
					if (!task) throw new Error("task_not_found");
					let publicTurn: any;
					let questionCount = 0;
					if (task.attemptId && task.nodeSnapshot && task.phase === "active") {
						try {
							const result = await fleet.inspect(first);
							publicTurn = result.publicTurn;
							questionCount = (result.questions as any)?.questions?.length ?? 0;
						} catch {
							// read-only or offline inspect fallback
						}
						try {
							// One line when the task becomes stalled or finished_unobserved; nothing otherwise.
							for (const entry of await fleet.refreshProgress([first])) {
								const shown = progressLine(entry);
								const key = shown ? digest({ verdict: shown.verdict, nodeWrittenAt: shown.nodeWrittenAt }) : "";
								if (shown && key !== lastProgress) console.log(JSON.stringify({ at: new Date().toISOString(), ...shown }));
								lastProgress = key;
							}
						} catch {
							// Progress is display only.
						}
					}
					const stateObj = {
						phase: task.phase,
						held: task.held,
						nodeId: task.nodeId ?? null,
						turnStatus: publicTurn?.turn?.status ?? null,
						questions: questionCount,
						resultStatus: executionOutcome(task),
						// Only on a task whose passing commands met an incomplete export.
						...(task.result?.exportIncomplete
							? { exportReview: task.result.exportIncomplete.acceptance ? "accepted" : "required" }
							: {}),
					};
					const currentDigest = digest(stateObj);
					if (currentDigest !== lastDigest) {
						lastDigest = currentDigest;
						console.log(JSON.stringify({
							at: new Date().toISOString(),
							...stateObj,
						}));
					}
					// An incomplete export awaiting operator acceptance is decided: watching cannot change it.
					const terminal = ["succeeded", "failed", "cancelled", "blocked_unknown", "cancel_unknown", "archived"].includes(task.phase) || exportReviewPending(task.result);
					if (terminal) break;
					await new Promise((r) => setTimeout(r, interval));
				}
				return 0;
			}
			default:
				throw new Error("unknown_command_use_help");
		}
		console.log(JSON.stringify(value, null, 2));
		const outcome = value as any;
		if (
			outcome?.ok === false ||
			(command === "submit" && !outcome?.attemptId) ||
			(command === "result" && outcome?.status === "tests_failed") ||
			(command === "start" && outcome?.phase === "blocked_unknown") ||
			(command === "poll" && outcome?.task?.phase === "blocked_unknown") ||
			(command === "ordinary" &&
				["refused", "unknown"].includes(outcome?.status))
		)
			return 1;
		return 0;
	} finally {
		health?.close();
		store.close();
	}
}
if (import.meta.main) {
	try {
		process.exitCode = await cli(process.argv.slice(2));
	} catch (error) {
		const code = publicCliError(error);
		console.error(JSON.stringify({ ok: false, error: code }));
		process.exitCode = 1;
	}
}
