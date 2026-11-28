# Fleet Gated Two-Cell Survivor Fixture

Test-only lane for the Fleet revision under review. Use a disposable Linux **local** Docker daemon, never the fleet or a shared production Docker context. No credentials, host networking, published ports, socket mounts, or production node addresses are required. No code in the fixture is installed on a Fleet worker.

## Run on a disposable Linux runner

From this directory in a disposable checkout, set `FLEET_FIXTURE_SHA` to the reviewed commit you intend to test (the PR merge-test SHA for CI parity, if applicable). The checkout must already be verified and clean:

```sh
export FLEET_FIXTURE_REPO=/absolute/path/to/isolated/gjc-fleet
test -n "$FLEET_FIXTURE_SHA" &&
  test "$(git -C "$FLEET_FIXTURE_REPO" rev-parse HEAD)" = "$FLEET_FIXTURE_SHA" &&
  test -z "$(git -C "$FLEET_FIXTURE_REPO" status --porcelain)" &&
  docker --context default build -t fleet-cell-fixture:local ./image &&
  FLEET_CELL_IMAGE=fleet-cell-fixture:local bash ./run-linux.sh
```

Image build is a separate provisioning step (Bun 1.4.4 Debian image and OS Git). The runner itself requires a local image and rejects a missing container engine instead of skipping. It mounts just the Fleet source tree and two fixture files read-only. Each run creates a fresh randomized Compose project with an internal network and state volume per cell. No image pulls occur during the acceptance run. The runner checks the actual Docker network and mounts and cleans up only its own labeled project. The PASS message is contingent on successful teardown.

## Acceptance sequence

1. Start A's real Fleet daemon as PID 1 and verify its DB lease matches the process. Before the outage, the existing Coordinator fixture records one prompt request and withholds its reply; Fleet must retain that attempt as `blocked_unknown`.
2. SIGKILL A and assert exit 137, not running, with no executable endpoint. Confirm networks and volumes are independent and that B cannot see A's volume sentinel. B must not have any existing task.
3. While A remains down, use B's real CLI to submit, retry submission, start, poll and verify one new B-owned task. A local fixture supplies synthetic Coordinator responses, but verification executes a real command that exclusively creates and fsyncs a proof file. Reopen B's DB from a separate process; assert one reservation, one release, one verification, verified success, and the proof file. Assert exactly one session-create and prompt request was received.
4. Check A remained down through B's proof. Recover A's original volume through a new process; retry the uncertain task and require that the existing physical prompt count stays at one, with its capacity still held.

A PASS is synthetic same-host cross-container evidence, not a real cross-host/Tailnet, provider, automatic-work, leader-election, authority-fencing or distributed failover test. The driver explicitly submits and starts the new B work; A's daemon does not perform admission and the fixture does not implement scheduling. Do not label wrong-home routing, a stale writer on a separate DB copy, or packet partitions as covered. Those are separate acceptance cases for the relevant implementations.

## Real-node preflight

`preflight-real-node.ts` reads one local JSON file and does not connect to a host.
It does not replace a real-node run. Passing this check is not evidence that two
hosts admitted work, opened a database, or failed a peer connection.

```sh
bun test/fixtures/cell-acceptance/preflight-real-node.ts evidence.json
```

The file is one object: `runId`, `hosts` (roles `a` and `b`, each with
`machineId`, `canonicalPath`, `identity.device`, `identity.inode`),
`productionChecks` (one per host, `checked` and `dbs`), `peerOpen`
(one each way, `opened: false`, same `runId`), and `restart` for A
after an exit on the original host and file.

A same machine id fails like this:

```text
Fleet real-node preflight FAILED: machine ids are the same
```

`preflight-real-node.ts` reads one local evidence file and does not connect to a host.
It aborts unless the machine ids differ, each host has one production-DB check
(an empty list is allowed only when that check was recorded), each test DB's
host-observed canonical path and file identity are outside that check, each
direction has one same-run peer observation of the actual target file that failed
to open, and A's restart record is the same run, the same file, and a start after
an exit on the original host.

## Evidence boundary

- Bun 1.4.4: local fixture helper exercised on separate disposable state roots; real B CLI submit/start/poll/result, independent exclusive proof file, reopened DB counts, and A's no-replay check passed. Local helper checks did not run a cross-container outage.
- For hosted evidence, see the `Two isolated cells (Linux)` job in `Fleet cell acceptance` for the exact candidate. A local syntax check alone does not exercise Compose, PID 1 lease, SIGKILL, or cross-container execution.
- Existing same-host proof is `test/cell-survival.test.ts` in this repository; it is not a substitute for the Compose run.
