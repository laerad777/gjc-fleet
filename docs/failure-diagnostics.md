# Failure diagnostics: catch-site table

Review documentation for the deny-by-default `failureDiagnostic` (see `src/diagnostic.ts` and README). It lists every
place where Fleet turns an error, a refusal or an already-retained claim into a persisted
unknown / blocked / cancel_unknown / refused / node-blocked / override record, and what it records there.

This table is documentation, not a test input. It is enforced by behaviour:

- `test/catch-site-behaviour.test.ts` drives every **D** row below through the public Fleet / resource-return API.
  It uses a controlled node, coordinator, UI, SDK CLI stand-in (`test/fixtures/scripted-sdk.ts`) or store fault, or a
  controlled reply, so that exactly that site converts. It then compares the converting events the run persisted with
  the expected `<event> <source>/<phase> <errorClass>`.
- `test/diagnostic-guard.ts` wraps the store's state-converting methods and its audit writer (including the
  `Store.transaction` refusal writer) for that whole test file. Any conversion without a valid diagnostic is a violation.
- A sweep in the same file faults every seam call of every scenario under the guard. Any converting event whose
  (event, source/phase) is not a row of the test table fails as an unlisted site. Any Fleet/Transport error stored as
  `unclassified` fails as a code missing from the code table.
- The 958c3122 injected-failure matrix (12858 runs) was also run under the same guard (fix lane e5723b8a). Its script (`harness/matrix-guarded.ts`) is not in the repository; this is historical evidence only.

Kinds:
- **D**: records a diagnostic (sources/phases listed).
- **R**: rethrows; the converting site is elsewhere.
- **N**: no persisted conversion, or an observation that is not an error or refusal. A record here would change behaviour.
- **NA**: converts in a store whose schema has no diagnostic field.
- **G**: guard that keeps diagnostic construction from ever throwing.

## D: sites that record a diagnostic (each driven in `catch-site-behaviour.test.ts`)

### fleet (`src/fleet/*.ts`; `src/fleet.ts` only re-exports)

**`Fleet.start` catch → `markUnknown` → `unknown`.** Every step label is driven:
- `Fleet.start.prepare`: precondition, claim, call, validate, record
- `Fleet.start.connect`: precondition, call
- `Fleet.start.create`: claim, call, validate, record
- `Fleet.start.authority`: precondition, call, record
- `Fleet.start.approval_attach`: precondition, claim, call, record, validate (the original-channel check after the prompt)
- `Fleet.start.prompt`: claim, call, validate, record (including the approval turn binding)
- `Fleet.start.close/call`

`DISPATCH_DISABLED`, `NODE_NOT_ADMISSIBLE` and a retained refusal are rethrown (N; base writes nothing here). `NODE_NOT_ADMISSIBLE` comes from `FleetStore.assertNodeAdmissible` (Fleet.start.prepare/precondition, before the source-carrying preflight of a retained refusal) or from the same check inside the transaction of a new prepare/create/approval-attach/prompt claim; both are `Store.transaction` refusals and record `refused Store.transaction/record FleetError` (fleet:node_not_admissible) there. Nothing is sent or claimed and the task is not marked unknown; `reconsiderQueue` stops its pass on it (index.ts, R) and `runTask` reports `not_started` (operator-commands.ts, N).

**Other D rows in `src/fleet/*.ts`:**

| site | event | source/phase |
|---|---|---|
| `Fleet.start` catch: typed before_send node refusal | node_operation_failure | the failing step (driven: Fleet.start.prepare/call) |
| preflight re-evaluation of a retained refusal: still_refused | node_operation_failure + preparation_reevaluation | Fleet.start.preflight/call |
| preflight re-evaluation: unavailable | preparation_reevaluation | Fleet.start.preflight/call |
| condition: preflight reply is not a pass | preparation_reevaluation | Fleet.start.preflight/call (errorClass none) |
| conditions: effect intent already claimed (prepare, create, approval-attach, prompt) | unknown | Fleet.start.{prepare,create,approval_attach,prompt}/claim (none; names the claim when it can be read) |
| `Fleet.inspect` catch, strict → `markObservationUnknown` | unknown (stale_poll_failure when a newer read decides) | Fleet.inspect.connect/call, read_turn/call, read_turn/validate, list_questions/call, approval_discovery/call, read_execution/call, observe/record, receiptless/validate, receiptless/record |
| condition: strict inspect, question reconciliation incomplete | unknown | Fleet.inspect.list_questions/validate (none) |
| `Fleet.inspect` catch, tolerant → `abandonObservation` | abandoned_poll | Fleet.inspect.connect/call, read_turn/call, list_questions/call |
| deferred strict failure applied by an abandoned tolerant read | unknown | the deferred strict failure's own diagnostic |
| UI answer discovery → `markUnknown` | unknown | Fleet.answer.discovery/call |
| UI answer send → `markUnknown` | unknown | Fleet.answer.submit/call, Fleet.answer.submit/validate |
| ordinary answer submit → `markUnknown` | unknown | Fleet.answer.submit/call |
| `Fleet.cancel` catch → `cancellationUnknown` | cancel_unknown | Fleet.cancel.abort/call, abort/record, Fleet.cancel.close/claim, close/call, close/record |
| condition: repeated cancel | cancel_unknown | Fleet.cancel.abort/claim (none; names the cancel claim when it can be read) |
| `Fleet.start` catch: create refusal that proves no session exists (`src/rpc.ts` `CREATE_REFUSAL_CLASSES`: `spawn_failed`) → `settleCreateRefusal` (failed, released; an attempt an overlapping start already recorded as `blocked_unknown` also gets `unknown_reconciled` {before `blocked_unknown`, after `failed`, cause `create_refused_before_effect`} in the same transaction; every other refusal stays the `unknown` row above) | create_refused | Fleet.start.create/call (none; condition `create_refused_before_effect`) |
| `Fleet.result` catch | result_validation_rejected / node_operation_failure | Fleet.result/validate |
| `Fleet.result` verifier claim whose request provably never reached the node (proven before_send failure of the test request, or any failure of the read-only pre-verifier collect/compare of `result-test`): the exact unreceipted `verify-test`/`result-test` claim is released (`FleetStore.releaseUnsentClaim`) | operation_claim_released (not a converting event; carries the diagnostic of the failure) + the `Fleet.result` catch row above | Fleet.result/call |
| `Fleet.result` catch: `VERIFICATION_CONFLICT` → `recordVerificationConflict` (first occurrence per attempt and requested argv, at most `VERIFICATION_RECORDED_REQUESTS` = 8 distinct requests per attempt; `task.verification.count` and `firstAt` cover every recorded conflicting request of the attempt, so a repeat of any recorded request only advances `count` and writes neither event; an archived task, a requested argv that is itself retained evidence (for example a node verifier reply for another argv) or a request past the bound records nothing and writes only result_validation_rejected) | verification_conflict, then result_validation_rejected | Fleet.result/validate (none; condition `verification_conflict`) |
| condition: unreceipted verify-test / result-test claim whose owner is gone → `recordVerifierOwnerGone` (once per claim; collection of a task with an unreceipted verify-test still throws `TEST_UNKNOWN`, because the admitted test process may outlive its claimer; a later receipt of that exact claim, or its release as never sent, clears the record and its `verification_outcome_unknown` reason without a new event) | verification_owner_gone | Fleet.result/validate (none; condition `verification_owner_gone`) |

### resource-return.ts

| site | event | source/phase |
|---|---|---|
| per-id eligibility refusal (`returnResources`, before any read or close; report `state: "refused"` with its `refusal` code). Never written again while the task has an identical `resource_return_refused` row (same attempt, session, code and diagnostic), however many audit rows came in between, alternating refusals included. All refusals of one call are written in one transaction after the per-id loop | resource_return_refused (`reason` = the refusal code) | ResourceReturn.precondition/precondition (the precondition's own Fleet code, e.g. `fleet:return_custody_missing`, `fleet:result_digest`, `fleet:test_evidence`, `fleet:result_integrity`; a non-Fleet error is its class with `unclassified`) |
| operator release with a failing listing | resource_return_operator_override | ResourceReturn.connect/call, ResourceReturn.release_listing/call |
| per-task pass catch | resource_return_unknown | ResourceReturn.precondition/precondition, connect/call, list/call, list/validate, close/precondition, close/claim, close/record, record/record |
| close claim refused by a block written meanwhile (`RETURN_NODE_BLOCKED`) | resource_return_unknown (node_blocked_by_*) | ResourceReturn.close/claim |
| fenced close throws, no public answer | resource_return_unknown | ResourceReturn.close/call |
| fenced close throws a public answer (L-2): legacy / suspect-legacy | resource_return_blocked_by_node + stopped rest of pass (resource_return_unknown) | ResourceReturn.close/call |
| fenced close throws a public answer (L-2): unclassified, or endpoint_stale with the exact incarnation still listed | resource_return_unknown (+ stopped rest of pass for unclassified) | ResourceReturn.close/call |
| conditions: returned (not thrown) answers, same classes | as above | ResourceReturn.close/validate (none) |
| conditions: Fleet's own no-replay refusals | resource_return_unknown | prior close unanswered/unknown, node already blocked, attempts exhausted: ResourceReturn.close/precondition (none). Close claimed by another controller: ResourceReturn.close/claim (none) |

### store (`src/store/*.ts`; `src/store.ts` only re-exports)

| site | event | source/phase |
|---|---|---|
| every `Store.transaction` refusal (incl. unblock, override, claimResourceReturnClose, archive, dispose (its pre-observation check and its write, action `dispose`), operator run, reservation, and a store error inside any transaction) | refused | Store.transaction/record |

### `src/fleet/*.ts` / `src/progress.ts` / `src/store/*.ts`: lane progress (driven in `test/progress.test.ts`, under the same guard)

A failed node-side progress read is not a task conversion: phase, hold, reason and every claim stay as they were.
It is recorded as the task's `progress` record with verdict `unknown` and that record's `diagnostic` (same
deny-by-default normaliser). `store.recordProgress` is wrapped by `test/diagnostic-guard.ts`: a failed reading
without a valid diagnostic is a violation. The `progress_stalled` / `progress_recovered` audit events are
observations, not converting events, and carry no diagnostic.

| site | record | source/phase (errorClass, code) |
|---|---|---|
| node has no registered route this hub can run (`ProgressRouteError`: no ssh head/args, OS mismatch, invalid or ambiguous (quoted/escaped embedded, or holding `&` `|` `<` `>`) agent dir, invalid session id, a win32 ssh remote command above 8000 characters) | progress.verdict unknown | Fleet.progress.read/precondition (none, condition:progress_route_unavailable) |
| node command could not be spawned | progress.verdict unknown | Fleet.progress.read/call (TransportError, transport:progress_spawn_failed) |
| node command past its deadline (posix 20 s, win32 60 s); its process group is killed | progress.verdict unknown | Fleet.progress.read/call (TransportError, transport:progress_timeout) |
| stdout or stderr above 64 KiB | progress.verdict unknown | Fleet.progress.read/call (TransportError, transport:progress_output_limit) |
| node command exit status not 0 | progress.verdict unknown | Fleet.progress.read/call (TransportError, transport:progress_exit) |
| reply not one complete `FLEETPROGRESS` block, not UTF-8, or a line for an unrequested/duplicated session | progress.verdict unknown (every session of that read) | Fleet.progress.read/validate (TransportError, transport:progress_reply_invalid) |
| conditions per session line: transcript missing, ambiguous, unreadable; malformed or absent line; transcript time more than 120 s ahead of the node clock | progress.verdict unknown (that session) | Fleet.progress.read/validate (none, condition:transcript_missing / transcript_ambiguous / transcript_unreadable / progress_reply_invalid / progress_clock_inconsistent) |

### `src/store/*.ts` / `src/result-store.ts`: result store (driven in `test/result-store-diagnostic.test.ts`)

Every result-store conversion is a `Store.transaction` refusal, so it records the row above; no result-store code
calls a state-converting store method itself. The codes it throws are in the code table (`fleet:result_integrity`,
`fleet:result_store_off`, `fleet:migration_not_applied`, `fleet:backup_leftover`, `fleet:store_error`).

| site | event | source/phase (errorClass, code) |
|---|---|---|
| `enableResultStore` / `disableResultStore` refused (invalid actor/reason) | refused | Store.transaction/record (FleetError, fleet:invalid_input) |
| a damaged externalised result read inside a transaction (`decodeTask` via `requireTask`: saveResult, markUnknown and every other task write on that task) | refused | Store.transaction/record (FleetError, fleet:result_integrity) |
| `collectResults(true)` (`results gc --apply`) with unreadable references | refused | Store.transaction/record (FleetError, fleet:result_integrity) |
| `migrateResults(true)` (`migrate results --apply`) per-row refusal: result directory not plain (driven); round-trip mismatch, row not updated (same writer, not driven: no deterministic fault seam) | refused | Store.transaction/record (FleetError, fleet:result_integrity / fleet:migration_not_applied) |
| `resultListing` (`results check`, `results gc` dry-run, writable) with a result directory that is not plain | refused | Store.transaction/record (FleetError, fleet:result_integrity) |
| blob publication failing inside a saveResult/migrate transaction with a non-Fleet error (I/O, `directory_flush_*`); same writer, not driven (no deterministic fault seam) | refused | Store.transaction/record (Error, unclassified: class only) |

### work-unit.ts: deliverable records (driven in `test/work-unit.test.ts`)

Every work-unit refusal is a `Store.transaction` refusal, so it records the row above; no work-unit code calls a
state-converting store method and none writes `tasks.data`. The codes it throws are in the code table
(`fleet:work_unit_switch_inconsistent`, `fleet:work_unit_role_tasks_pending`, `fleet:classification_mismatch`,
`fleet:non_fleet_commit`, `fleet:verification_conflict`, `fleet:invalid_input`, `fleet:dispatch_disabled`). `ROLE_NO_TESTS` and
`ROLE_PROMPT_CONTRACT` are thrown before any transaction (a plain refusal, as `RESULT_NOT_READY` is).

| site | event | source/phase (errorClass, code) |
|---|---|---|
| `enableWorkUnits` / `disableWorkUnits` refused (invalid actor/reason, inconsistent switch, unexpected schema, role tasks not started, rollback entered) | refused | Store.transaction/record (FleetError, fleet:invalid_input / fleet:work_unit_switch_inconsistent / fleet:work_unit_role_tasks_pending / fleet:dispatch_disabled) |
| `recordDeliverable` (`deliverable TASK_ID`, path b/c) refused: a different record exists, or a Step 1b classification mismatch (classified inside the transaction) | refused | Store.transaction/record (FleetError, fleet:verification_conflict / fleet:classification_mismatch) |
| `store.submit` of a role input while the switch is inconsistent | refused | Store.transaction/record (FleetError, fleet:work_unit_switch_inconsistent) |
| `store.submit` of a role input with an input package, or of a review without a valid `subject` | refused | Store.transaction/record (FleetError, fleet:invalid_input) |
| `store.submit` of a review whose baseCommit is not the commit its subject Fleet task made, or whose subject result was saved without the node's separate creation proof (its `output_head_created` audit row) (`assertFleetCommit`; reads the subject row and its `output_head_created` / `output_head_unproven` audit rows, never a result blob; the message names the recorded unproven reason, or that no proof was asked) | refused | Store.transaction/record (FleetError, fleet:non_fleet_commit) |

## N: conversions without a diagnostic by design (the guard allows exactly these)

| site | why |
|---|---|
| resource-return.ts `listing_changed_between_observations`, `host_liveness_unproven`, `close_acknowledged_awaiting_terminal_listing` | observations, not an error or refusal |
| resource-return.ts operator release whose fresh listing succeeded | an operator decision, not a failure |
| resource-return.ts operator release of a task with no recorded session/node (`no_recorded_session_or_node`) | listing unavailable by precondition, not by a failure |
| `src/fleet/inspection.ts` `Fleet.inspect`: a reported execution failure without proof of end, held as `completed_unverified` (not terminal) with reason `execution_failure_reported_end_unproven` (`observation` event) | an observation of the node's own report, not a Fleet error or refusal; nothing is settled or released |
| `src/fleet/inspection.ts` `Fleet.inspect`: a durable failed receipt of the exact command settles `failed` (`observation` + `released`) | a settlement by proof, like a terminal observation |
| resource-return.ts per-id refusal of an id whose task row was not loaded (`task_not_found`; a blank or invalid id, `unclassified`) | no task row to record on; report only. Only a loaded row, or a row whose externalised manifest is damaged (`custody_invalid`), is recorded |

## NA

| site | why |
|---|---|
| clawhip-control.ts: a control command ending `unknown` (`Outcome unknown; replay prohibited, observation only`) | Separate control DB; `commands` has no diagnostic column, so recording one would need a schema change (prohibited) or different stored text (a behaviour change). A Fleet-side diagnostic exists only when the command's Fleet operation itself failed in Fleet. The execution deadline (`Execution deadline; observation only`) and the post-execution checks (`Start identifiers unavailable`, `Receipt unavailable or oversized`) leave **no diagnostic anywhere** (review 9fbbbd8d I-1). |

## R / N / G catch sites that do not convert (review classification)

- **clawhip-control.ts**: R: control DB file check (ENOENT only), control DB open failure. N: cache-only collect re-read (command keeps its unknown state), CLI entry fixed stderr.
- **cli.ts**:
  - N: operator run/watch error line on stdout, then rethrow (pre-existing B-I1).
  - R: fixed-code rethrow.
  - N: watch display fallback (a strict inspect failure was already recorded by `Fleet.inspect`).
  - N: poll/watch progress refresh (display only; a failed read is already the progress record above).
  - N: top-level stderr line.
- **daemon.ts** (`fleet daemon`, daemon lane). The daemon converts nothing itself: every conversion it causes is
  recorded by an existing row above, through `Fleet.inspect`, `returnResources` or a `Store.transaction`
  refusal. `test/daemon.test.ts` runs a daemon under this guard and finds no violation. Its own `daemon_note`
  audit event is not a converting event: it records why the daemon took no action, and nothing about the task
  changes.
  - N: failed cycle (logged once per code; the store is unchanged and the next cycle retries).
  - N: observation failure (Fleet.inspect already recorded `abandoned_poll`/`unknown`; the daemon only backs
    off the node), and a failed reachability check before a poll of a backed-off node (no poll was issued and
    nothing about the task changed; the daemon only backs off the node).
  - N: return pass failure (returnResources already recorded its outcome).
  - N: queue pass failure, resource sample failure, note write failure, logging failure.
  - N: lease renew and release (the lease is not task state).
  - R: none.
- **dashboard.ts** (18 catches) and **onboarding.ts** (10): N. These are read-only probes, child-process cleanup, readiness report codes, enrollment rollback with rethrow, and CLI stderr. They hold no task state.
- **`src/fleet/*.ts`**:
  - R: archive session query (`Fleet.archiveObservation`, shared by `archive` and `dispose`).
  - N: `disposeBatch` per-item catch: report only. A refusal made inside a `Store.transaction` (`checkDisposition`, `dispose`) was already recorded as its `refused` row. The Fleet-side refusals of `Fleet.dispose` (`TASK_NOT_FOUND`, `DISPOSE_INPUT`, the `ARCHIVE_NODE` registry checks, and `ARCHIVE_TRANSPORT` / `ARCHIVE_OUTPUT_LIMIT` / `ARCHIVE_QUERY` from `archiveObservation`) are thrown outside any transaction and are not recorded, exactly as for `task archive`. A non-Fleet error (for example an unparsable node listing) converts nothing, is not recorded, and is reported by class only.
  - G: `diagnose`, `claimed` guards.
  - R: connect close-then-rethrow, close-step labelling, inspect timing.
  - N: read-only late-receipt check.
  - N: `refreshProgress`: a refused `recordProgress` (already a `Store.transaction` refusal, telemetry noted) and the tolerant settle `inspect` of an `active` finished_unobserved task (never a blocked_unknown one) (its own failures are recorded by the `Fleet.inspect` rows).
  - G: a failed result refusal record (telemetry only).
  - G: a failed release of an unsent verifier claim (telemetry only; the claim then stays and the task reports TEST_UNKNOWN, never a rerun).
  - R: `withResultTest` receipt `observedExclusions` validation (rethrow as `VERIFICATION_CONFLICT`).
  - N: `legacyWithheld` (2 catches: canonical JSON of the node's `withheldFiles` evidence, and `validateExclusions` of its boundary evidence). Malformed node file or boundary evidence gives no withheld set (`undefined`), so the caller refuses `ARTIFACT_CHANGED`. That refusal passes through the `Fleet.result` catch row; before the verifier is sent it is recorded by the verifier-claim release row (`operation_claim_released`, Fleet.result/call). Driven in `test/collection-review-r6.test.ts` (review b7481b8b F1).
  - G: `condition` (condition diagnostics never throw), and a failed verification-conflict record (telemetry only; the conflict is still thrown and recorded as `result_validation_rejected`).
  - N: `Fleet.outputHeadProof` (work-unit switch on, role-less task, first collection only): a failed or refused
    `provenance` query converts nothing (the result is saved and returned as without it). Its outcome is recorded
    in the same `saveResult` transaction as an `output_head_unproven` audit row with a fixed reason
    (`node_refused` = typed before_send refusal, `node_failed` = anything else) and the deny-by-default
    `failureDiagnostic` (Fleet.result/call); a `{created:false}` reply is `not_created`, any other reply
    `reply_invalid`. Never asked again; a later review submit names the reason in its NON_FLEET_COMMIT refusal.
- **index.ts**: R. The local backlog stops on a typed node refusal (recorded by the `Fleet.start` row) and rethrows others; it also stops after a start that settled `failed` by a create refusal (recorded by the `create_refused` row), leaving the other candidates queued. N: the queue-reconsider progress refresh (display only: `settle: false`, it never observes a task; it also runs after the node-health gated pass).
- **progress.ts**: R: `runProgressCommand` maps every spawn/read/exit failure to a `progress_*` TransportError; `readNodeProgress` maps an invocation failure to `ProgressRouteError`. G: process-group kill and reader cancel after the read. N: `progressSessionLimit` probe; an invocation that does not fit is reported by the read as `progress_route_unavailable`.
- **operator-commands.ts**:
  - N: lease liveness probe, lease renew and lease release.
  - N: run claim refused, start under rollback, receipt race (the refusals themselves are `Store.transaction` refusals).
  - N: watch after an abandoned tolerant read.
  - N: watch progress refresh (display only).
  - R: lease take.
- **placement-preflight.ts**: N for the readiness report codes, including `probe_deferred_node_busy` (only a
  `nodeCall` gate refusal typed `FleetError` `NODE_BUSY`; any other `nodeCall` rejection is rethrown, R). R
  for the workspace ancestor walk.
- **resource-return.ts**:
  - R: operator-release gone check.
  - G: `diagnose`, `noted`, and the diagnostic-only lookup of a competing close claim.
  - D: per-id eligibility (now `resource_return_refused`, row above; an id whose task row was not loaded stays report only). N: the listing after an operator release (report only).
  - N: a failed write of that `resource_return_refused` record (report only, counted as telemetry once per call: all refusals of a call are one write). A failure inside the write's transaction is already the `Store.transaction` `refused` row of `recordResourceReturnRefused` (store row above); READ_ONLY or a failed `BEGIN` writes nothing.
- **result-store.ts** (result store, rebase lane): R: `entry` (ENOENT/ENOTDIR only), `syncDirectory` (EINVAL/ENOTSUP only), `entries`/`ensureDirectory`/`read` (rethrow as RESULT_INTEGRITY), publication rename race (rethrow unless a concurrent publisher won). N: `verifyReferenced` (corrupt list, report only), `listEntries` size probe (report only).
- **`src/store/*.ts`** (result store, rebase lane): R: `fileIdentity` (ENOENT only), `decodeTask` (rethrow as RESULT_INTEGRITY), backup cleanup then rethrow. N: `deadBackupStaging` (unreadable owner record or live pid = not provably dead), `backupResultsRemoval` (unreadable = never removed), backup leftover/cleanup probes, `migrateResults` per-row report (the refusal itself is the `Store.transaction` row), `resultInventory` row report. Both stdout reports carry only a code and the fixed text chosen by that code (`failed[].message`, `rows[].problem`), never text from the error. The migrate report code is read only from the prototype chain and own data properties (no getter or Proxy trap runs): a Fleet error keeps its own code (texts for `RESULT_INTEGRITY`, `RESULT_STORE_OFF`, `SCHEMA_VERSION`, `MIGRATION_NOT_APPLIED`; any other Fleet code: generic "row not migrated" text); a bun:sqlite error (own `name` `SQLiteError`, own `SQLITE_*` code) is `DB_BUSY` (BUSY/LOCKED), `DB_FULL`, `DB_CONSTRAINT` or `DB_ERROR`; an Error with an own OS code is `RESULT_DIR_DENIED` (EACCES/EPERM/EROFS), `RESULT_DIR_FULL` (ENOSPC/EDQUOT) or `RESULT_DIR_ERROR`; anything else is `STORE_ERROR` ("Error not classified further"). These report codes are not FleetError codes and are not stored. `rows[].problem` is the integrity text only for Fleet's own RESULT_INTEGRITY, otherwise a generic "could not be read" text.
- **work-unit.ts** (work-unit Step 1/1b):
  - N: `recordInSave` SAVEPOINT catch inside `saveResult`: rolls back only its own savepoint, so the evidence save
    commits exactly as without work units (R9); no row, no audit, nothing converted. `deliverable TASK_ID` records later.
  - N: `recordCached` (cached branch of `result ID`): best effort, never changes the reply; nothing written.
  - R: `recordDeliverable` rethrows Fleet refusals; any other error (SQLite, I/O) becomes `DeliverableUnavailable`
    (CLI `outcome: "unavailable"`, never a rejection or a success). A v3 `RESULT_INTEGRITY` read is `not_ready`.
  - N: `principal` (unreadable OS user is recorded as `unknown`).
  - N: `fileFact` `TextDecoder` catch: a report that is not valid UTF-8 is the classification
    `report_rejected`/`report_not_utf8` (a fact about the collected bytes, stored as the record's reason), not a
    failure; the decoder error carries nothing else, so no diagnostic is recorded and no task state changes.
- **work-unit-cli.ts** (`deliverable TASK_ID`):
  - N: `deliverableCommand` prints a `DeliverableUnavailable` as `outcome: "unavailable"` (exit 1) and rethrows
    every other error. Nothing is written or converted: `recordDeliverable` wrote no record and the task is
    unchanged, so there is no row to carry a diagnostic; the outcome is unknown, never a rejection or a success.
- **result-export.ts** (`export TASK_ID DEST`): nothing is converted and no row is written by these sites (a
  collection inside `Fleet.result` keeps its own rows).
  - R: `absent` (ENOENT only) and the DEST parent probe (ENOENT/ENOTDIR only: `EXPORT_DEST_PARENT`); every other
    error is rethrown.
  - R: `publishStaging`: a failed final rename is reclassified as `EXPORT_DEST_EXISTS` only when DEST now exists;
    otherwise the original error is rethrown. No row is written.
  - R: staging cleanup, then rethrow: the private staging directory is removed and the error propagates unchanged.
  - N: `exportCommand` prints a `FleetError` as one stdout JSON line `{ok:false,taskId,code,error}` (exit 1) and
    rethrows every other error to the top-level stderr line.
- **`src/store/*.ts`**:
  - R: DB path/create, migration rollback, open failure, reserve timing, backup checks.
  - N: telemetry (clock, durations, rollback, refused-audit write, enqueue origin, backup fd close).
  - G: failure attributes, `diagnosticData`, `refusalDiagnostic`, a failed `result_validation_rejected` record.

## Node-health sites (stacked node-health patch)

The node-health patch adds **no D row**: none of its sites writes an unknown / blocked / cancel_unknown / refused /
node-blocked / override record. With the operator switch off none of them runs on a scheduling path. With the switch
on, a conversion reached through a gated decision is recorded by main's existing D row with the same event and
diagnostic as with the switch off: a `Store.transaction` refusal inside the gated `reserve` / `submit` / `reserveQueued`
(`refused` Store.transaction/record) and a node refusal or failure inside `Fleet.start` called by the gated operator run or
queue reconsider (`node_operation_failure` / `unknown` Fleet.start.*). `test/node-health-diagnostics.test.ts` drives each
row below under `test/diagnostic-guard.ts` for the whole file and compares the switch-on converting events with the
switch-off ones. `test/node-health-secret.test.ts` plants a secret in the exception message at every gate stage (library
faults, and database triggers that abort health writes with it) and checks that it appears in no API result, CLI
stdout/stderr, database row, dashboard state/page or `ui` producer stderr line (review 102b71b4 F2/F3).

| site | kind | why |
|---|---|---|
| node-health-gate.ts `probeForDecision` catch (history open/retain, decision probes, recording) and `enforce` per-node catch | N | Fails closed as a placement exclusion: automatic candidates get the durable selection reasons `node_unstable`, `node_health_unavailable`; the task stays `queued` with `no_eligible_node` (the same outcome as main's readiness exclusions, N); a pinned ready node is reserved with a `node_health_warning`. No unknown/blocked/refused record. Reported (never stored) only as `placement.nodeHealth.error` = `{code, stage, errorClass}`: fixed code `node_health_unavailable` (or `node_health_access_required` with stage `access`, errorClass `none`, when the caller supplies no access), the Fleet-defined stage (`history_open`, `history_retain`, `decision_probe`, `record`, `admit`) and the error class from `diagnosticErrorClass` (the same trap-free prototype-chain walk as `failureDiagnostic`). No message or other text from the error is returned, printed or stored. |
| node-health-gate.ts `mirror` catch (bounded sidecar copy of a pinned warning) | N | Returned (never stored) as `healthWarningMirrorError` = `{code: "node_health_mirror_failed", stage: "mirror", errorClass}`, no error text; the reservation and its `node_health_warning` audit row are already committed by the store. |
| node-health-gate.ts `reconsiderEnforced` catch around `Fleet.start` | R | Same code as main's `reconsiderQueue` (index.ts R): a typed node refusal is already recorded by the `Fleet.start` row; the pass stops, others rethrow. |
| node-health-gate.ts `bootstrapNodeHealth` catch of `beginBootstrap` | N / R | `node_health_stable` → `skipped_stable` (a precondition, not a failure); anything else rethrows. |
| node-health-gate.ts `probeReach` → placement-preflight `coordinatorProbe` | N | Readiness code `coordinator_unavailable` (placement-preflight.ts N), stored only as the health observation `reachable=false`. |
| dashboard.ts `probeBrokerSessionList` catch | N | Health observation `brokerSessionListOk=false`; no task state. |
| dashboard.ts `ui` producer (`observeHealth`) catch | N | Fixed-form stderr line `{"ok":false,"error":"node_health_observe_failed","errorClass":<diagnosticErrorClass>}` (no error text); the next tick is scheduled only when the switch read on in this tick (an unreadable switch stops the producer). |
| node-health.ts `NodeHealthHistory` open (read-only and writable) catch | R | Close-then-rethrow. |
| `src/store/tasks.ts` `reserveInternal` checks of `exclusions` / `healthWarning` | N | Caller-argument checks before the transaction (`INVALID_INPUT`, nothing read or written, no `refused` row), the same pattern as main's bounded-outcome check in `recordPreparationReevaluation`. Only the gate supplies these arguments. |
| cli.ts `node-health gating on` refused while nodes are unstable | N | Operator-command precondition (exit 1 with a preview); no task state, no audit row. |
| audit kind `node_health_warning` (pinned dispatch onto an unstable node, switch on) | N | An observation written in the reservation transaction, not a converting event; not in `CONVERTING_EVENTS`. |

## Change in the held-return lane (src)

- The per-id eligibility catch of `returnResources` converted a refusal into a report only. It now also records
  `resource_return_refused` with the stable refusal code (`not_settled`, `custody_missing`, `custody_invalid`,
  `custody_binding_mismatch`, `authority_missing`, `ownership_missing`, `cancel_pending`, `unclassified`) and the
  classified diagnostic. Anything thrown while a collected manifest is validated, and a damaged externalised manifest
  found while loading the task, is `custody_invalid`. The record reads row metadata only (so a damaged result does not
  prevent it) and is never written again while the task has an identical `resource_return_refused` row, however many
  audit rows came in between (other events and other refusals in between do not count). All refusals of one call are
  recorded in one write transaction after the per-id loop, so a held write lock costs the call at most one busy wait.
  The identical-refusal lookup is one scan of the audit table per call (audit has no task index); no index or other
  schema object is added. A refusal row does not move the dashboard `lastEventAt` of the task; it is shown in the
  task timeline and counts in the `observability()` newest-100 audit window. The
  report keeps its earlier `reason` values and gains `refusal`. The guard lists `recordResourceReturnRefused` and
  `resource_return_refused`, and `catch-site-behaviour.test.ts` drives the row.
- No new Fleet code and no change to which attempts may be closed: custody first for every attempt, as before.

## Change in fix lane e5723b8a (src)

The guard found one site that converted without a diagnostic:
- In `Fleet.claimed` (start claim conditions, repeated cancel), the diagnostic-only read of the retained claim threw. The `unknown` / `cancel_unknown` was then recorded with no diagnostic at all.
- Now the condition `operation_already_claimed` is still recorded, without the claim id. This matches the resource-return claim race.
- Nothing else changed: no decision, reason, event kind, exit code or exception.

## Change in the per-node RPC timeout lane (src)

No catch site was added, removed or reclassified; every row above records what it recorded before.
- A diagnostic with `errorClass` `TransportError` and `code` `transport:transport_timeout` now also carries
  `timeoutMs`: the per-call limit that expired (the node's `transport.timeoutMs`, else its OS default
  30000 / win32 120000; or the explicit onboarding / preflight deadline). It is read from the thrown
  TransportError's own data property only (no getter, toString or Proxy trap), and kept only when it is an
  integer from 1 to 600000. Any other code or class never carries it; `normalizeDiagnostic` rebuilds it under
  the same rule, so a forged or out-of-range value is dropped, and a stored diagnostic without it still loads.
- The diagnostic stays version 1 and is still never read by a decision: the timeout is still recorded
  `unknown` and never re-sent.

## Change in fix lane preflight-claim (src)

- Send-time node admission (`FleetStore.assertNodeAdmissible`, and inside the prepare/create/approval-attach/prompt claims):
  a refusal is a `Store.transaction` refusal row (`refused Store.transaction/record FleetError`, code
  `fleet:node_not_admissible`), already a listed pair. `Fleet.start` rethrows it like `DISPATCH_DISABLED`: no
  `unknown`, nothing sent, the reservation stays held.
- `operation_claim_released` is a new, non-converting audit event: the released claim's id, kind and digest plus the
  deny-by-default diagnostic (Fleet.result/call) of the failure that proved the verifier request was not sent.
- `Fleet.stop` connects before it claims (no conversion site added or removed).

## Observation-read limit (call-deadlines r2)

No catch site, event kind, source, phase, error class or code was added, moved or removed.
- `timeoutMs` (already present for `transport:transport_timeout`) is now the limit of the request that expired:
  the node's observation limit (`nodeObservationTimeoutMs`) for `read_turn` / `list_questions`, otherwise the
  node's transport limit (`nodeRpcTimeoutMs`). Its bound (1..600000) is unchanged; the observation limit never exceeds 600000.
- A request refused because a request with a different limit is pending on the same connection is recorded with the
  existing `transport:too_many_requests` code (certainty `before_send`: nothing was written).

## Change in the task-dispose lane

- `task dispose` (`Fleet.dispose`, `Fleet.disposeBatch`, `FleetStore.checkDisposition`, `FleetStore.dispose`) adds no catch site that converts. Every refusal it can persist is a `Store.transaction` refusal (action `dispose`), so it records the store.ts **D** row above with the refusal's own code. The new codes are in the code table: `fleet:dispose_conflict`, `fleet:dispose_input`, `fleet:dispose_not_terminal`, `fleet:dispose_phase`, `fleet:dispose_resource_unproven`, `fleet:dispose_return_in_progress`, `fleet:dispose_row_form`, `fleet:dispose_superseder`. The archive codes it shares (`fleet:archive_live_session`, `fleet:archive_evidence`, ...) are unchanged.
- Not persisted, by design (N, the same as the Fleet-side checks of `task archive`): every refusal thrown by `Fleet.dispose` before `FleetStore.checkDisposition` / `FleetStore.dispose` runs, namely input/usage validation (`DISPOSE_INPUT`, including a malformed `--batch` list), `TASK_NOT_FOUND`, the `ARCHIVE_NODE` registry checks, and the session-listing failures of `archiveObservation` (`ARCHIVE_TRANSPORT`, `ARCHIVE_OUTPUT_LIMIT`, `ARCHIVE_QUERY`, and a non-Fleet error such as an unparsable listing); and every `--dry-run` refusal (a dry run writes nothing at all). The operator sees each of them as the command's error (or the batch item's `code`).
- Driven under the guard in `test/dispose.test.ts` (live session and conflicting disposition: `refused` with `fleet:archive_live_session` / `fleet:dispose_conflict`, no violation).
- `Store.archive` itself is unchanged in behaviour: its observation checks moved verbatim into `archiveObservationChecks`, which `dispose` also runs.
- A disposition never releases a reservation and never judges a session listing for one. A task that still holds its reservation is refused with `DISPOSE_RESOURCE_UNPROVEN` in the pre-observation check (a `Store.transaction` refusal, recorded; with `--node-retired` too), before the node is contacted, and stays held exactly as the resource-return rules leave it; `return TASK_ID` (or the audited `return-override`) releases it, then the task can be disposed.
- After a disposition the result path is closed: `Fleet.result` (collect or `--test`) refuses a disposed task with the existing code `ARCHIVED_TASK` before any node contact. A `result` that was already in flight when the disposition committed is refused at its write instead: `Store.saveResult`, `Store.recordVerification`, the `verify-test` / `result-test` claims, the `result-test` receipt (`recordOperationReceipt`) and `Store.verifyResult` all refuse a disposed task with `ARCHIVED_TASK` inside their existing `Store.transaction`, so the refusal is recorded (`refused`, action `saveResult` etc.) and nothing is written onto the disposed row; the node effect that already ran (collect or the verifier command) is not undone and its output is not retained. `Fleet.result` keeps its existing catch (`recordResultValidationRejected`, source `Fleet.result`) and the CLI exits non-zero. No new code and no new catch site.

## Change in the queue-unplaceable lane

- `queue withdraw ID --reason TEXT [--actor NAME]` (`FleetStore.withdrawQueued`) adds no catch site that converts. Every refusal it can persist is a `Store.transaction` refusal (action `withdraw`), so it records the store.ts **D** row above with the refusal's own code. The new codes are in the code table:
  - `fleet:withdraw_attempted` (`WITHDRAW_ATTEMPTED`): the task has an admitted attempt or anything an attempt leaves (attempt id, node snapshot, session, held reservation, workspace, or an operation row). Nothing is changed; the task keeps the existing `cancel` / `return` / `task archive` paths. This is also the losing side of a race with a concurrent reserve (both run in one `BEGIN IMMEDIATE` transaction, so exactly one of them wins).
  - `fleet:withdraw_phase` (`WITHDRAW_PHASE`): the task is not `queued` (and is not an already withdrawn task).
  - `fleet:withdraw_input` (`WITHDRAW_INPUT`): empty reason/actor, or longer than 200 characters.
- A repeat on a withdrawn task is not a refusal: it returns `outcome: "already_withdrawn"` and writes nothing. An unknown task id is the existing `NOT_FOUND`. `withdrawQueued` never contacts a node (`nodeContacted: false` in its result and its `withdrawn` audit row).
- A withdrawn task is `archived` (an existing terminal phase); a later `reserve` / `start` / `run` refuses it with the existing `ARCHIVED_TASK`.
- Audit kind `withdrawn` is a decision row written in the same transaction (actor, reason, `archivedFrom`, the last `placement` record, `nodeContacted:false`), not a converting event; not in `CONVERTING_EVENTS`.
- The `placement` record on a queued task and the suppressed repeat `selection` row (an identical exclusion set) add no catch site, event kind, phase, error class or code.
