# `fleet daemon`: the single owner of periodic work

`bun src/cli.ts --db DB [--local-node-id ID] daemon run [--cycle-ms MS] [--lease-ms MS] [--queue-limit N] [--grace-ms MS]`

`bun src/cli.ts --db DB [--read-only] daemon status` (exit 0 alive, 10 not running; 10 is outside the operator exit-code table, where 3 means
`blocked_unknown`)

One supervised loop per Fleet database. While it runs, nothing else needs to poll: the dashboard, scripts and
operators read its published status instead of starting their own observation loops. Every command keeps its
behaviour without the daemon (`poll`, `watch`, `queue reconsider`, `return`, ... are unchanged).

## What one cycle does

The cycle (default 5 s) refreshes a metadata-only scheduling index and dispatches node work through one gate
per node.

- **Index.** `FleetStore.schedulingIndex()` projects scalars only (phase, ids, held, reason, terminal and
  settlement facts, whether a result is stored), extracted by SQLite. No result body, prompt or observation
  evidence reaches the process. After the first full projection, only rows whose task changed since the last
  cycle are projected again. Changes come from `schedulingChanges(cursor)`: every task write commits an audit
  event in the same transaction, and new tasks get a larger rowid. A full rebuild runs every 10 min as a
  backstop.
- **(a) Queue.** Up to `--queue-limit` (default 10, max 100) unattempted queued tasks per pass are re-checked
  with fresh measurements, in rotating order. Each enabled node is measured at most once per pass; a failed
  sample stands for the rest of the pass. Every sample and probe holds only its own node's gate for that one
  call, so a slow or unreachable node does not stop observation or return on other nodes; a node whose sample
  failed, or whose gate stays busy, is not probed. Candidates no node can admit by the fresh sample are deferred with exponential backoff (cycle .. 60 s), and
  no probe or store scan is spent on them. For the others it runs the read-only placement preflight (the one
  `queue reconsider` runs; Coordinator catalog probe, then workspace probe, one call at a time per node) and
  publishes the admissible ones in `status.queue.admissible` (`taskId`, `nodeId`, `checkedAt`); each is
  re-checked after its backoff. **The daemon never reserves or starts a task**: a reservation holds capacity
  and must be followed by a start, and starting sends the task's prompt. The task stays `queued`, holds no
  capacity, and `queue reconsider` places and starts it as before.
- **(b) Observation.** Every observable task is visited round-robin, least recently visited first, with at most
  one observation per task at a time. It goes through `Fleet.inspect(id, {tolerateReadFailure:true})`, the
  existing poll path. Observable means one of:
  - an exact session/turn in preparing, dispatching, active, approval_required, or a non-terminal
    completed_unverified;
  - a read-failure `blocked_unknown`;
  - a receipt-less failed settlement inside its late-receipt window (read-only check, 10 min).

  An observation whose result is identical to the one already applied (same observation digest) writes no
  receipt and no audit row, so a long-lived unchanged task does not grow the store.

  Each node has one in-flight call at a time and a minimum pause between calls: 15 s on win32 (calls take
  30-90 s), 1 s elsewhere. A failed read backs the node off exponentially (5 s .. 300 s); it never marks the
  task unknown, because the tolerant read records an abandoned poll. While a node is backed off after a failed
  call, the next observation first runs a reachability check that writes nothing (the same Coordinator
  connection and tool catalog, then closed); only when it succeeds is a poll issued, so an unreachable node
  adds no `abandoned_poll` row and no task-row rewrite per retry. Unchanged tasks back off 30 s .. 120 s,
  and a change resets the task to 30 s. A slow node delays only its own tasks.

  When a poll was actually issued and `OBSERVATION_UNAVAILABLE` repeats on the same task (reachable node,
  same failed read — for example `transport:execution_query_failed` inside inspect), that task's observation
  interval stretches beyond the ordinary 120 s unchanged max, up to `observeFailureMaxEveryMs` (default 15×
  the unchanged max, 30 min in production). Observation is never stopped permanently and the attempt is never
  completed or replayed; after the second consecutive polled failure the daemon writes a once-per-attempt
  `daemon_note` `observation_repeated_failure_operator_recovery_required` so operators see recovery is needed
  while infrequent polls continue. Reachability-only misses (no poll issued) keep the ordinary unchanged
  ceiling and write no note.
- **(c) Selected custody (opt-in).** Task submission may include
  `"autoCustody": {"paths": ["RESULT.md", "selection.patch"]}`. Paths must be sorted, unique,
  portable exact relative regular-file names under the existing selected-result rules (1..1024;
  no globs, excluded secrets, traversal, aliases or identity marker). The immutable input digest binds
  this instruction at submission, before an attempt exists. It is explicit collection authority, not
  inferred intent from a prompt or a previous failed collection. No field means no automatic collection.

  Only `completed_unverified` or `succeeded` with authoritative terminal success, an exact original
  `terminal_ok` runtime receipt (agent provenance, not cancellation), the bound session/turn/command,
  workspace identity and exclusive original session authority can enter. Live, unknown, failed,
  cancelled, archived/disposed, receipt-less, foreign/unowned and approval-contract attempts are refused.
  Cancellation claims and operator resource release also fence collection. The store rechecks these
  facts in the same transaction as the claim and before saving. An accepted late receipt does not
  bypass the receipt-less settlement refusal.

  One node gate and the existing pacing/lease/rollback rules apply. `Fleet.automaticCustody` calls the
  existing selected `Fleet.result` path with only the submitted paths and **no verifier**. Foreground
  collection of opted-in tasks shares the unique per-attempt `auto-custody` operation claim; it cannot
  change the selector or start a verifier before initial custody. Once saved, existing explicit cached
  verifier upgrades remain operator-driven. Tasks without the field retain existing behavior.
  On opted-in tasks, omitting the selector in foreground `result` (including export/watch callers)
  uses the submitted selection, never full-workspace collection; an explicit different selector is refused.

  Custody candidates share their node's last custody visit time in the least-recently-visited
  ordering: fresh arrivals cannot continually reset custody priority ahead of due observations
  or returns. Eligibility decisions (including refusals) are cached for at most `observeEveryMs`;
  projection changes, change-feed activity (including other tasks' ownership changes), and index
  rebuilds invalidate the cache sooner. Claim and save still recheck authority transactionally.

  The durable claim is made before node contact. Missing files, invalid replies, timeout or a crash
  without saved custody retain it: **no retry, reset, mutation replay or uncertain duplicate**. A successor
  records `custody_claimed_without_saved_manifest_operator_recovery_required_no_replay`; failures also
  have a bounded `custody_failed_CODE_operator_recovery_required` daemon note. Inspect `show`, `events`
  and retained operation evidence; an absent manifest requires operator investigation, not automatic
  re-execution or claim removal. Saved validated custody is authoritative even if the process died before
  writing the operation receipt: cached `result TASK --select ...` and daemon restart do not recollect.
  `custody_saved` logs and the node lane's `inFlight: "custody"` expose successful/in-progress work.
- **(d) Return.** After settlement, `returnResources` runs for a task whose result is collected, whose original
  session authority is recorded, with no cancellation, operator release or node block. The daemon sends at
  most the first idle-only close of an attempt. After an acknowledged close it only re-lists: every outcome
  recorded after that close counts (still listed, listing unavailable, foreign incarnation, liveness unproven,
  busy), and after 3 re-lists it notes `return_needs_operator_relists_exhausted_after_close` and stops.
  Retryable listing outcomes (unavailable, liveness unproven, changed between observations) are retried at
  most 3 times. In every other case it records why, once per task attempt and reason, as a `daemon_note` audit
  event: result not collected, unanswered or refused close, session busy, retries exhausted, and so on.
  Repeated cycles and restarts add nothing.

## Never

The daemon never sends a prompt, answers a question or approval, archives, verifies, dispatches review,
deploys, deletes, collects undeclared outputs, resends anything, or releases a reservation by operator override. Approval-contract
tasks are not observed: their original UI channel belongs to the process that started them.

## Single instance, crash and takeover

The owner lease is a row `daemon:owner` in the existing token-CAS lease table `resource_return_leases`. The key
can never be a node id. The row holds `{owner, pid, host, startedAt, status}`, is renewed every lease/3
(default 30 s lease), and carries the published status (≤ 64 KiB).

- A second `daemon run` is refused (`Another daemon holds the owner lease`, exit 1) while the lease is live.
- A holder that is a dead process on this host is replaced at once. Any other holder is replaced only after
  its lease expired, followed by a quiet period of one lease before the first node call.
- The lease is **not** the effect fence; durable claims are. A close or opted-in collection is claimed (`UNIQUE(attempt_id,kind)`)
  before it is sent, and an unanswered claim is never re-sent, by this daemon or any successor. An
  observation is fenced by the store's poll sequence.
- If renewal fails or the lease is lost, the daemon starts no new call, lets in-flight calls finish, and exits
  with `DAEMON_LEASE_LOST`.
- SIGTERM, SIGINT and SIGHUP stop it gracefully. No new calls start; in-flight calls get `--grace-ms`
  (default 60 s). The lease row is then deleted, so the store looks as if no daemon ran. A killed daemon leaves
  only its lease row, which expires.
- **Windows.** Only a console Ctrl+C (SIGINT) in the daemon's own console is a graceful stop. A signal sent by
  another process (`kill`, a service manager's stop) terminates it at once, like a crash: in-flight calls are
  dropped and the lease row stays until it expires (or a successor on the same host sees the pid gone).

## Status

`daemon status`, `observability` (key `daemon`, present only while a lease row exists) and the dashboard state
(`/api/state` key `daemon`) all show the same values:

- alive, lease expiry, pid and host;
- cycles, `lastCycleAt`, and whether it is stopping;
- backlog: queued, deferred, observable, due, in flight, awaiting start (reserved by an operator command and
  not started yet), awaiting return;
- queue pass state and the queued tasks admissible now, with their node;
- per node: in-flight call, last success and failure, consecutive failures, next call and backlog.

## Running it as a service (examples; nothing is installed for you)

The Label string in the unit must match the installed LaunchAgent Label exactly.
A dashboard UI process may use a different Label than the daemon example below; always
query the label you intend to manage. Example paths and labels are not a live install.

### Read-only release probe (no restart, no DB)

Before changing a running service tree, identify the process without dumping argv:

```sh
bun scripts/release-probe-readonly.ts --label LABEL [--expect-pid N] [--tree PATH]
```

Reports `SERVICE_PID`, `START`, `CWD`, `LOAD_PATH`, and on-disk `TREE_HEAD` (plain
`.git/HEAD` / `refs/` file reads — not proof of the in-memory load SHA). `LOAD_PATH`
is `unknown` unless an open `src/(cli|daemon|dashboard)*.(ts|js)` file is found.
A matching `TREE_HEAD` alone is not a verified recovery copy.

launchd (`~/Library/LaunchAgents/dev.gjc.fleet-daemon.plist`, `launchctl bootstrap gui/$(id -u) PATH`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>dev.gjc.fleet-daemon</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/bun</string>
		<string>/Users/YOU/fleet/src/cli.ts</string>
		<string>--db</string><string>/Users/YOU/fleet/.local/fleet.sqlite</string>
		<string>daemon</string><string>run</string>
	</array>
	<key>WorkingDirectory</key><string>/Users/YOU/fleet</string>
	<key>RunAtLoad</key><true/>
	<!-- Restart after a crash, not after a clean stop or a refused second instance. -->
	<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
	<key>ThrottleInterval</key><integer>30</integer>
	<!-- launchd sends SIGTERM, then SIGKILL after this many seconds: keep it above --grace-ms. -->
	<key>ExitTimeOut</key><integer>90</integer>
	<key>StandardOutPath</key><string>/Users/YOU/Library/Logs/fleet-daemon.log</string>
	<key>StandardErrorPath</key><string>/Users/YOU/Library/Logs/fleet-daemon.err</string>
</dict>
</plist>
```

systemd (`/etc/systemd/system/fleet-daemon.service` or a user unit):

```ini
[Unit]
Description=GJC Fleet daemon (single owner of periodic work)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=fleet
WorkingDirectory=/srv/fleet
ExecStart=/usr/local/bin/bun /srv/fleet/src/cli.ts --db /srv/fleet/.local/fleet.sqlite daemon run
KillSignal=SIGTERM
# Above --grace-ms (default 60 s): in-flight node calls may finish before SIGKILL.
TimeoutStopSec=90
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

Run one unit per database. A second unit on the same database is refused by the lease with exit 1. With
`Restart=on-failure` (or launchd `SuccessfulExit=false`) it retries every 30 s and takes over only once the
first lease is gone. Use `Restart=on-abnormal` if a refused duplicate should stay down.

## Plug points for other lanes

- **Stalled-session detection.** It belongs in the observation step (`FleetDaemon.observe`, which only calls
  `Fleet.inspect`). A verdict computed in `Fleet.inspect` is picked up with no daemon change. The visit's
  signature (phase, terminal, turn status, question count) is where "unchanged for N visits" is already
  tracked.
- **Unknown-state reconciliation (session_lost).** `observationKind(row, now)` is the single eligibility rule.
  Make a `blocked_unknown` reason observable there once its reconciliation is a read in `Fleet.inspect`.
- **Poll-fence fix.** The daemon never fences polls itself. It always uses the tolerant `Fleet.inspect`, and
  its one-observation-per-task rule sits above the store's poll sequence, so a fence change in
  `beginObservation`/`observe` applies unchanged.
