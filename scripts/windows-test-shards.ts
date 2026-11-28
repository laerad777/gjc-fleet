import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
// Keep the prior Bun 1.4.4 Windows assignments (run 46136456569), except for
// the two whole files moved from shard 3 to 4 after comparing per-file times.
// New test files are assigned by a stable hash of their portable relative path.
const shards = `
// Shard 1
archive-security.test.ts
backup.test.ts
catch-site-behaviour.test.ts
collection-fuzz.test.ts
collection-review-r2.test.ts
core.test.ts
dashboard-contrast.test.ts
dashboard-queue-layout.test.ts
diagnostic-deny.test.ts
export-incomplete-main.test.ts
failure-diagnostic.test.ts
integration-wiring.test.ts
node-health-dashboard.test.ts
node-health-integration.test.ts
node-health-review5.test.ts
node-refusals.test.ts
onboarding.test.ts
operator.test.ts
preparation-paths.test.ts
receiptless-diagnostic.test.ts
refusal-release.test.ts
resource-return-r4.test.ts
result-store-refusal-lease.test.ts
result-upgrade.test.ts
rpc-path.test.ts
selected-custody.test.ts
spawn.test.ts
verify-hash-files.test.ts
work-unit.test.ts

// Shard 2
archive-session-shapes.test.ts
bounded-text.test.ts
clawhip-control.test.ts
collection-hazards.test.ts
collection-review-r5.test.ts
daemon-note.test.ts
dashboard-flat-look.test.ts
dashboard-sampling-exit.test.ts
discovery.test.ts
export-public-error.test.ts
git-program.test.ts
license.test.ts
node-health-diagnostics.test.ts
node-health-low-fixes.test.ts
node-health-secret.test.ts
node-unregister.test.ts
openat-create.test.ts
ordinary.test.ts
privacy-scan.test.ts
receiptless-late-receipt.test.ts
refusal-review.test.ts
resource-return.test.ts
result-store-report-text.test.ts
results-atomic-deadline.test.ts
rpc-timeout.test.ts
settlement-consistency.test.ts
stack-interactions.test.ts
windows-native.test.ts
workspace-shapes.test.ts

// Shard 3
archive.test.ts
cancel-interleave.test.ts
cli-differential.test.ts
collection-identity.test.ts
collection-review-r6.test.ts
daemon.test.ts
dashboard-map-view.test.ts
dashboard-selection-reason.test.ts
dispose-differential.test.ts
export-public.test.ts
git-version-requirement.test.ts
local-backlog.test.ts
node-health-placement.test.ts
observability.test.ts
operation-receipts.test.ts
placement-preflight.test.ts
progress.test.ts
receiptless-settlement.test.ts
release-probe-readonly.test.ts
result-export.test.ts
result-store-resource-return.test.ts
review-dispatch.test.ts
rpc.test.ts
source-transfer-budget.test.ts
stack-operator-interactions.test.ts
windows-reader.test.ts
workspace.test.ts

// Shard 4
autocustody-scheduler.test.ts
candidate-package-hang.test.ts
cli-error.test.ts
collection-performance.test.ts
collection-rv10.test.ts
dashboard-clear-focus.test.ts
dashboard-poll-view.test.ts
dashboard-status.test.ts
dispose.test.ts
export-record-review.test.ts
held-return.test.ts
node-answer.test.ts
node-health-differential.test.ts
node-health-findings.test.ts
node-health-port.test.ts
node-health-switch-off-ui.test.ts
node-health-switch.test.ts
observation-deadline.test.ts
operator-commands.test.ts
planted-program.test.ts
queue-unplaceable.test.ts
recovery-regressions.test.ts
resource-return-diagnostic.test.ts
result-store-backup-retry.test.ts
result-store-watch.test.ts
reviewer-adversarial.test.ts
sdk-ui.test.ts
source-transfer-key-allocation.test.ts
storage-faults.test.ts
windows-writer.test.ts

// Shard 5
autocustody.test.ts
candidate-package.test.ts
cli-poll-public.test.ts
collection-result-store.test.ts
coordinator-fixture.test.ts
dashboard-completion-labels.test.ts
dashboard-pushkey.test.ts
dashboard.test.ts
execution.test.ts
export-review-rollback.test.ts
inputs.test.ts
node-health-daemon-merge.test.ts
node-health-gate.test.ts
node-health-property.test.ts
node-health.test.ts
onboarding-public-error.test.ts
operator-exit-codes.test.ts
preflight-claim-fixes.test.ts
read-only.test.ts
refusal-low-fixes.test.ts
resource-return-fenced.test.ts
result-store-diagnostic.test.ts
result-store.test.ts
rollback.test.ts
selected-custody-cache.test.ts
source-transfer.test.ts
subject-link.test.ts
work-unit-differential.test.ts
`.trim().split(/\n\n/).map((group) =>
	group.split("\n").filter((name) => !name.startsWith("//")).map((name) => `test/${name}`),
);

const expected = readdirSync(resolve(root, "test"), { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile() && /(?:[._](?:test|spec))\.[cm]?[jt]sx?$/.test(entry.name))
	.map((entry) => relative(root, resolve(entry.parentPath, entry.name)).split(sep).join("/"))
	.sort();
const expectedFiles = new Set(expected);
const historic = shards.flat();
const historicalSet = new Set(historic);
const duplicates = [...new Set(historic.filter((file, idx) => historic.indexOf(file) !== idx))];
if (shards.length !== 5 || duplicates.length)
	throw new Error(`Invalid Windows shard manifest: ${JSON.stringify({ duplicates })}`);

const stale = historic.filter((file) => !expectedFiles.has(file));
const current = shards.map((shard) => shard.filter((file) => expectedFiles.has(file)));
const newcomers = expected.filter((file) => !historicalSet.has(file)).map((file) => {
	const index = createHash("sha256").update(file).digest().readUInt32BE(0) % current.length;
	current[index]!.push(file);
	return { file, shard: index + 1 };
});
current.forEach((shard) => shard.sort());
const listed = current.flat();
const assigned = new Set(listed);
if (assigned.size !== listed.length || assigned.size !== expectedFiles.size || expected.some((file) => !assigned.has(file)))
	throw new Error("Windows shard assignment does not cover each discovered test exactly once");

const [arg, mode, ...extra] = process.argv.slice(2);
if (!arg || !/^[1-5]$/.test(arg) || (mode && mode !== "--list") || extra.length)
	throw new Error("Usage: bun run scripts/windows-test-shards.ts SHARD [--list]");
if (stale.length) console.error(`Windows shard retired paths: ${JSON.stringify(stale)}`);
if (newcomers.length) console.error(`Windows shard new assignments: ${JSON.stringify(newcomers)}`);
const shard = current[Number(arg) - 1]!;
// Never invoke Bun with no paths: an empty argument list would run the full suite.
if (!shard.length) throw new Error(`Windows shard ${arg} is empty`);
if (mode === "--list") {
	console.log(shard.join("\n"));
} else {
	const tests = Bun.spawnSync([process.execPath, "test", ...shard.map((path) => `./${path}`)], {
		cwd: root,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	process.exit(tests.exitCode ?? 1);
}
