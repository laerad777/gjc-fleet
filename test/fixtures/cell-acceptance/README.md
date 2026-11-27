# Fleet Gated Two-Cell Survivor Fixture

Test-only lane for Fleet baseline `6c01cb769271fddc8fee8b70731043dc5e7437c5`. Use a disposable Linux **local** Docker daemon, never the fleet or a shared production Docker context. No credentials, host networking, published ports, socket mounts, or production node addresses are required. No code in the fixture is installed on a Fleet worker.

## Run on a disposable Linux runner

From this directory, using an independently verified clean Fleet checkout at the baseline:

```sh
export FLEET_FIXTURE_REPO=/absolute/path/to/isolated/gjc-fleet
test "$(git -C "$FLEET_FIXTURE_REPO" rev-parse HEAD)" = 6c01cb769271fddc8fee8b70731043dc5e7437c5
docker --context default build -t fleet-cell-fixture:6c01cb7 ./image
FLEET_CELL_IMAGE=fleet-cell-fixture:6c01cb7 bash ./run-linux.sh
```

Image build is a separate provisioning step (Bun 1.4.4 Debian image and OS Git). The runner itself requires a local image and rejects a missing container engine instead of skipping. It mounts just the Fleet source tree and two fixture files read-only. Each run creates a fresh randomized Compose project with an internal network and state volume per cell. No image pulls occur during the acceptance run. The runner checks the actual Docker network and mounts and cleans up only its own labeled project. The PASS message is contingent on successful teardown.

## Acceptance sequence

1. Start A's real Fleet daemon as PID 1 and verify its DB lease matches the process. Before the outage, the existing Coordinator fixture records one prompt request and withholds its reply; Fleet must retain that attempt as `blocked_unknown`.
2. SIGKILL A and assert exit 137, not running, with no executable endpoint. Confirm networks and volumes are independent and that B cannot see A's volume sentinel. B must not have any existing task.
3. While A remains down, use B's real CLI to submit, retry submission, start, poll and verify one new B-owned task. A local fixture supplies synthetic Coordinator responses, but verification executes a real command that exclusively creates and fsyncs a proof file. Reopen B's DB from a separate process; assert one reservation, one release, one verification, verified success, and the proof file. Assert exactly one session-create and prompt request was received.
4. Check A remained down through B's proof. Recover A's original volume through a new process; retry the uncertain task and require that the existing physical prompt count stays at one, with its capacity still held.

A PASS is synthetic same-host cross-container evidence, not a real cross-host/Tailnet, provider, automatic-work, leader-election, authority-fencing or distributed failover test. The driver explicitly submits and starts the new B work; A's daemon does not perform admission and the fixture does not implement scheduling. Do not label wrong-home routing, a stale writer on a separate DB copy, or packet partitions as covered. Those are separate acceptance cases for the relevant implementations.

## Evidence boundary

- Bun 1.4.4: local fixture helper exercised on separate disposable state roots; real B CLI submit/start/poll/result, independent exclusive proof file, reopened DB counts, and A's no-replay check passed. Local helper checks did not run a cross-container outage.
- `bash -n` and YAML topology parse passed. No Docker/Podman/nerdctl available here; `run-linux.sh` exited nonzero for missing Docker. Build, actual Compose isolation, PID 1 lease, SIGKILL and cross-container execution are **not run**.
- Existing same-host proof is `test/cell-survival.test.ts` in this repository; it is not a substitute for the Compose run.
