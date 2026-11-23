import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { FleetStore } from "../src/store";
import { oneShot } from "../src/node";
import { digest } from "../src/core";
import { authorizeInput, previewInput } from "../src/inputs";
import { preflightPlacement, probePlacementSource, reservePlacement } from "../src/placement-preflight";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";

// Real child stdio, real Git worktrees and SQLite; Coordinator is explicitly CONTROLLED,
// not a remote host or real model/provider. No execution-proof claims follow from these tests.
const helper = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const legacy = fileURLToPath(new URL("../src/node.ts", import.meta.url));
const coordinator = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const directories: string[] = [];
const stores: FleetStore[] = [];
afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const repo = await repositoryFixture("fleet-placement-");
	directories.push(repo.dir);
	const input: TaskInput = { schemaVersion: 1, key: "automatic", caller: "controlled-placement-test", repoId: "fixture", baseCommit: repo.baseCommit, prompt: "Controlled input", required: { modelProfile: "controlled" } };
	async function node(id: string, changes: Partial<NodeConfig> = {}) {
		const state = join(repo.dir, id + "-coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const config = join(repo.dir, id + ".json");
		const value: NodeConfig = { id, os: process.platform, arch: process.arch, roots: { fixture: repo.repo }, workspaceRoot: join(repo.dir, "workspaces-" + id), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: [coordinator, state] }, workspaceTransport: { command: process.execPath, args: [helper, config] }, ...changes };
		await writeFile(config, JSON.stringify(value));
		return { value: JSON.parse(JSON.stringify(value)) as NodeConfig, config, state };
	}
	const admission = (ids: string[]) => ({ ...headroom(ids, 10), held: new Map(), now: Date.now() });
	return { ...repo, input, node, admission };
}

test("read-only preflight checks real child source/base and workspace, not remote execution", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	const before = await readdir(f.dir);
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]));
	expect(report.selection.nodeId).toBe("NODEG");
	expect(report.nodes[0].ready).toBe(true);
	expect(report.nodes[0].executionProven).toBe(false);
	expect(report.nodes[0].checks.source.code).toBe("repo_and_exact_base_present");
	expect(report.nodes[0].checks.workspace.code).toBe("workspace_ancestor_accessible");
	expect(report.nodes[0].checks.model.code).toBe("model_declared_only_execution_unverified");
	expect(await readdir(f.dir)).toEqual(before);
	expect(JSON.parse(await readFile(n.state, "utf8")).calls).toEqual([]);
	expect(f.input.required.nodeId).toBeUndefined();
});

test("catalog and resource success do not hide a missing exact base", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	const report = await preflightPlacement({ ...f.input, baseCommit: "f".repeat(40) }, [n.value], [], f.admission(["NODEG"]));
	expect(report.selection.nodeId).toBeUndefined();
	expect(report.nodes[0].checks.source.ok).toBe(false);
	expect(report.nodes[0].checks.coordinator.ok).toBe(true);
	expect(report.nodes[0].checks.resources.ok).toBe(true);
});

test("same-platform node without workspaceTransport is not implicitly local", async () => {
	const f = await fixture();
	const n = await f.node("MAC_NODE", { workspaceTransport: undefined });
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["MAC_NODE"]));
	expect(report.nodes[0].checks.workspace.code).toBe("workspace_transport_required");
	expect(report.selection.nodeId).toBeUndefined();
	const local = await preflightPlacement(f.input, [n.value], [], f.admission(["MAC_NODE"]), { localNodeId: "MAC_NODE" });
	expect(local.nodes[0].ready).toBe(true);
});

test("legacy helper refusal is actionable, not treated as workspace readiness", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	n.value.workspaceTransport!.args[0] = legacy;
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]));
	expect(report.nodes[0].checks.workspace.code).toBe("workspace_transport_unverified");
	expect(report.nodes[0].checks.workspace.action).toContain("Legacy node.ts");
});

test("remote config identity mismatch fails closed", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	n.value.workspaceRoot += "-changed-on-hub-only";
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]));
	expect(report.nodes[0].checks.workspace.ok).toBe(false);
});

test("model mismatch skips live Coordinator and source probes", async () => {
	const f = await fixture();
	const n = await f.node("NODEG", { modelProfiles: [] });
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]));
	expect(report.nodes[0].checks.model.code).toBe("model_profile_unavailable");
	expect(report.nodes[0].checks.coordinator.code).toBe("hard_ineligible_probe_skipped");
	expect(report.nodes[0].checks.source.code).toBe("hard_ineligible_probe_skipped");
	expect(report.selection.nodeId).toBeUndefined();
});

test("Coordinator transport failure cannot be replaced by declared operations", async () => {
	const f = await fixture();
	const n = await f.node("NODEG", { transport: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]), { timeoutMs: 1000 });
	expect(report.nodes[0].checks.coordinator.code).toBe("coordinator_unavailable");
	expect(report.nodes[0].checks.source.ok).toBe(true);
	expect(report.selection.nodeId).toBeUndefined();
});

test("stale samples and held task memory charges still exclude ready source hosts", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	const admission = f.admission(["NODEG"]);
	admission.samples.get("NODEG")!.at = Date.now() - 60_000;
	let report = await preflightPlacement(f.input, [n.value], [], admission);
	expect(report.nodes[0].checks.resources.code).toBe("resources_stale");
	const charged = { ...headroom(["NODEG"], 1), held: new Map([["NODEG", [{ reservedAt: Date.now(), started: false }]]]), now: Date.now() };
	report = await preflightPlacement(f.input, [n.value], [], charged);
	expect(report.nodes[0].checks.resources.code).toBe("memory_low");
	expect(report.selection.nodeId).toBeUndefined();
});

test("SQLite reservation selects non-NODEM from actual headroom without modifying input or registry", async () => {
	const f = await fixture();
	const nodeM = await f.node("NODEM");
	const nodeG = await f.node("NODEG");
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	stores.push(store);
	store.putNode(nodeM.value);
	store.putNode(nodeG.value);
	const originalNodes = digest(store.nodes());
	const task = store.submit(f.input);
	const resources = headroom(["NODEM", "NODEG"], 10);
	resources.samples.get("NODEM")!.cpuPct = 99;
	const result = await reservePlacement(store, task.id, resources);
	expect(result.task.nodeId).toBe("NODEG");
	expect(result.task.held).toBe(true);
	expect(result.task.phase).toBe("preparing");
	expect(result.task.input.required.nodeId).toBeUndefined();
	expect(digest(store.nodes())).toBe(originalNodes);
	expect(result.report.nodes.find(node => node.nodeId === "NODEM")!.checks.resources.code).toBe("cpu_busy");
	// The same new helper executes the REAL existing prepare/test/collect protocol.
	const identity = await oneShot(nodeG.value.workspaceTransport!.command, nodeG.value.workspaceTransport!.args, { action: "prepare", input: { taskId: task.id, attemptId: result.task.attemptId, nodeId: "NODEG", inputDigest: task.inputDigest, repoId: f.input.repoId, baseCommit: f.baseCommit } });
	expect(await readFile(join(identity.path, "tracked.txt"), "utf8")).toBe("base bytes\n");
	const evidence = await oneShot(nodeG.value.workspaceTransport!.command, nodeG.value.workspaceTransport!.args, { action: "test", identity, argv: [process.execPath, "-e", "if(await Bun.file('tracked.txt').text() !== 'base bytes\\n') process.exit(1); console.log('REAL_WORKSPACE_OK')"] });
	expect(evidence.exit).toBe(0);
	expect(evidence.stdout).toContain("REAL_WORKSPACE_OK");
	const manifest = await oneShot(nodeG.value.workspaceTransport!.command, nodeG.value.workspaceTransport!.args, { action: "collect", identity, tests: [evidence] });
	expect(manifest.identity.baseCommit).toBe(f.baseCommit);
	expect(manifest.status).toBe("verified");
	await expect(reservePlacement(store, task.id, resources)).rejects.toThrow("placement_already_reserved");
});

test("unready nodes lose admission samples but shared registry and queued input stay unchanged", async () => {
	const f = await fixture();
	const n = await f.node("NODEG", { workspaceTransport: undefined });
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	stores.push(store);
	store.putNode(n.value);
	const task = store.submit(f.input);
	const result = await reservePlacement(store, task.id, headroom(["NODEG"], 10));
	expect(result.task.phase).toBe("queued");
	expect(result.task.attemptId).toBeUndefined();
	expect(result.report.selection.exclusions[0].reasons).toContain("workspace:workspace_transport_required");
	expect(store.nodes()[0].enabled).toBe(true);
});

test("workspace symlinks and repository subdirectories are refused without writes", async () => {
	const f = await fixture();
	await mkdir(join(f.dir, "actual-workspaces"));
	await symlink(join(f.dir, "actual-workspaces"), join(f.dir, "linked-workspaces"));
	const n = await f.node("NODEG", { roots: { fixture: join(f.repo, "subdir") }, workspaceRoot: join(f.dir, "linked-workspaces") });
	await mkdir(join(f.repo, "subdir"));
	const result = await probePlacementSource(n.value, f.input);
	expect(result.source.ok).toBe(false);
	expect(result.workspace.ok).toBe(false);
});

test("helper timeout and wrong platform refuse instead of inventing remote success", async () => {
	const f = await fixture();
	const n = await f.node("NODEG", { workspaceTransport: { command: process.execPath, args: ["-e", "await Bun.sleep(60000)"] } });
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]), { timeoutMs: 100 });
	expect(report.nodes[0].checks.workspace.ok).toBe(false);
	const mismatch = await probePlacementSource({ ...n.value, os: "other" }, f.input);
	expect(mismatch.source.code).toBe("probe_platform_mismatch");
});

test("resources expire during a slow probe rather than staying green at the old admission time", async () => {
	const f = await fixture();
	const preload = join(f.dir, "delay.ts");
	await writeFile(preload, "await Bun.sleep(200);\n");
	const state = join(f.dir, "NODEG-coordinator.json");
	const n = await f.node("NODEG", { transport: { command: process.execPath, args: ["--preload", preload, coordinator, state] } });
	const admission = f.admission(["NODEG"]);
	admission.samples.get("NODEG")!.at = Date.now();
	const report = await preflightPlacement(f.input, [n.value], [], { ...admission, policy: { maxSampleAgeMs: 100, maxCpuPct: 85, minFreeMemBytes: 0, minFreeDiskBytes: 0, taskMemReserveBytes: 0, balloonTrust: 0 } });
	expect(report.nodes[0].checks.coordinator.ok).toBe(true);
	expect(report.nodes[0].checks.resources.code).toBe("resources_stale");
	expect(report.selection.nodeId).toBeUndefined();
});

test("registry mutation while probing refuses reservation without changing the queued task", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	stores.push(store);
	store.putNode(n.value);
	const task = store.submit(f.input);
	const pending = reservePlacement(store, task.id, headroom(["NODEG"], 10));
	store.putNode({ ...n.value, draining: true });
	await expect(pending).rejects.toThrow("placement_changed_during_preflight");
	expect(store.task(task.id)!.attemptId).toBeUndefined();
	expect(store.nodes()[0].draining).toBe(true);
});

test("unbound successful-looking workspace response is not accepted as evidence", async () => {
	const f = await fixture();
	const response = JSON.stringify({ ok: true, value: { source: { ok: true }, workspace: { ok: true } } });
	const n = await f.node("NODEG", { workspaceTransport: { command: process.execPath, args: ["-e", `console.log(${JSON.stringify(response)})`] } });
	const report = await preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]));
	expect(report.nodes[0].checks.workspace.code).toBe("workspace_transport_unverified");
	expect(report.selection.nodeId).toBeUndefined();
});

test("dangling workspace symlink cannot borrow its parent's write permission", async () => {
	const f = await fixture();
	const link = join(f.dir, "dangling");
	await symlink(join(f.dir, "nonexistent-target"), link);
	const n = await f.node("NODEG", { workspaceRoot: link });
	const result = await probePlacementSource(n.value, f.input);
	expect(result.source.ok).toBe(true);
	expect(result.workspace.ok).toBe(false);
});

test("duplicate registry identity and invalid timeout are rejected before transports execute", async () => {
	const f = await fixture();
	const n = await f.node("NODEG");
	await expect(preflightPlacement(f.input, [n.value, n.value], [], f.admission(["NODEG"]))).rejects.toThrow("duplicate_node_id");
	await expect(preflightPlacement(f.input, [n.value], [], f.admission(["NODEG"]), { timeoutMs: 0 })).rejects.toThrow("invalid_preflight_timeout");
});

test("authorized source objects prepare a real workspace without any preexisting target repository", async () => {
	const f = await fixture();
	await writeFile(join(f.repo, "selected.txt"), "explicitly selected bytes\n");
	const preview = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["selected.txt"], includeObjects: true });
	const pkg = authorizeInput(preview, preview.digest, "controlled-owned-fixture-approval");
	const n = await f.node("NODEG", { roots: { fixture: join(f.dir, "not-installed-source") } });
	const input = { ...f.input, inputPackage: pkg };
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	stores.push(store);
	store.putNode(n.value);
	const task = store.submit(input);
	const { report, task: reserved } = await reservePlacement(store, task.id, headroom(["NODEG"], 10));
	expect(reserved.nodeId).toBe("NODEG");
	expect(report.nodes[0].checks.source.code).toBe("authorized_source_objects_available_import_unverified");
	expect(report.nodes[0].executionProven).toBe(false);
	const identity = await oneShot(n.value.workspaceTransport!.command, n.value.workspaceTransport!.args, { action: "prepare", input: { taskId: task.id, attemptId: reserved.attemptId, nodeId: "NODEG", inputDigest: task.inputDigest, repoId: input.repoId, baseCommit: input.baseCommit, inputPackage: pkg } });
	expect(identity.repo).toContain(".inputs");
	expect(await readFile(join(identity.path, "tracked.txt"), "utf8")).toBe("base bytes\n");
	expect(await readFile(join(identity.path, "selected.txt"), "utf8")).toBe("explicitly selected bytes\n");
	expect(identity.inputPackageDigest).toBe(pkg.digest);
	await expect(preflightPlacement({ ...input, inputPackage: { ...pkg, objects: [] } }, [n.value], [], f.admission(["NODEG"]))).rejects.toThrow();
});

test("hard-ineligible destinations receive no workspace or Coordinator transport", async () => {
	const f = await fixture();
	const marker = join(f.dir, "forbidden-transport");
	const transport = { command: process.execPath, args: ["-e", `await Bun.write(${JSON.stringify(marker)}, 'transport executed'); process.exit(1)`] };
	const disabled = await f.node("DISABLED", { enabled: false, transport, workspaceTransport: transport });
	const mismatch = await f.node("MISMATCH", { transport, workspaceTransport: transport });
	await writeFile(join(f.repo, "selected.txt"), "PRIVATE_SOURCE_MARKER\n");
	const preview = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["selected.txt"], includeObjects: true });
	const input = { ...f.input, required: { ...f.input.required, nodeId: "SELECTED" }, inputPackage: authorizeInput(preview, preview.digest, "local-only-authorization") };
	const disabledReport = await preflightPlacement({ ...input, required: f.input.required }, [disabled.value], [], f.admission(["DISABLED"]));
	const mismatchReport = await preflightPlacement(input, [mismatch.value], [], f.admission(["MISMATCH"]));
	expect([...disabledReport.nodes, ...mismatchReport.nodes].every(row => row.checks.source.code === "hard_ineligible_probe_skipped" && row.checks.coordinator.code === "hard_ineligible_probe_skipped")).toBe(true);
	expect(await Bun.file(marker).exists()).toBe(false);
});

test("eligible nonselected readiness carries only identity-bound metadata, never source or object bytes", async () => {
	const f = await fixture();
	const capture = join(f.dir, "readiness.json");
	const wrapper = join(f.dir, "capture.ts");
	await writeFile(wrapper, `const bytes = await Bun.stdin.bytes(); await Bun.write(process.argv[2], bytes); const result = Bun.spawnSync([process.execPath, process.argv[3], process.argv[4]], { stdin: bytes }); process.stdout.write(result.stdout); process.exit(result.exitCode);`);
	const selected = await f.node("SELECTED");
	const other = await f.node("OTHER");
	other.value.workspaceTransport = { command: process.execPath, args: [wrapper, capture, helper, other.config] };
	await writeFile(other.config, JSON.stringify(other.value));
	await writeFile(join(f.repo, "selected.txt"), "PRIVATE_SOURCE_MARKER\n");
	const preview = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["selected.txt"], includeObjects: true });
	const pkg = authorizeInput(preview, preview.digest, "local-only-authorization");
	const input = { ...f.input, inputPackage: pkg };
	const admission = f.admission(["SELECTED", "OTHER"]);
	admission.samples.get("OTHER")!.cpuPct = 99;
	const report = await preflightPlacement(input, [selected.value, other.value], [], admission);
	expect(report.selection.nodeId).toBe("SELECTED");
	expect(report.nodes.find(row => row.nodeId === "OTHER")!.checks.source.code).toBe("authorized_source_objects_available_import_unverified");
	const wire = await readFile(capture, "utf8");
	const request = JSON.parse(wire);
	expect(request.nodeDigest).toBe(digest(other.value));
	expect(request.input).toEqual({ repoId: input.repoId, baseCommit: input.baseCommit, packageDigest: pkg.digest, packageSummary: { changedFiles: pkg.changes.length, objectCount: pkg.objects!.length, authorizedObjectsAvailable: true } });
	expect(wire).not.toContain("PRIVATE_SOURCE_MARKER");
	expect(wire).not.toContain("contentBase64");
	expect(wire).not.toContain("selected.txt");
	expect(wire).not.toContain(pkg.authorization!.reference);
	for (const value of [...pkg.changes.map(change => change.after?.contentBase64), ...pkg.objects!.map(object => object.contentBase64)]) {
		if (value) expect(wire).not.toContain(value);
	}
});
