import { test, expect } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { FleetStore } from "../src/store";
import { discover, preview, validateRegistration, type Registration } from "../src/onboarding";
const registration = (): Registration => ({
 node: { id: "new", os: process.platform, arch: process.arch, roots: { repo: "/repo" }, workspaceRoot: "/work", enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["configured"], transport: { command: "/known/attach", args: [] }, operations: [] },
 physicalHostId: "physical-1", authenticatedTransport: true,
 paths: { executable: "/known/gjc", bun: process.execPath, git: "/usr/bin/git", helper: resolve(import.meta.dir, "../src/node.ts") },
 source: { repoId: "repo", baseCommit: "a".repeat(40) }, discovery: { command: process.execPath, args: [] },
});
test("missing fields produce actionable exact codes", () => {
 const checks = validateRegistration({} as Registration);
 expect(checks.filter(c => !c.ok).map(c => c.code)).toEqual(["node_config_required", "physical_host_id_required", "authenticated_transport_required", "executable_path_required", "bun_path_required", "git_path_required", "helper_path_required", "source_base_required", "discovery_transport_required"]);
 expect(checks.every(c => c.action.length > 10)).toBe(true);
});
test("real SQLite dry-run, disabled enrollment, duplicate preservation and shared host confirmation", async () => {
 const dir = await mkdtemp(join(tmpdir(), "onboarding-")); const path = join(dir, "fleet.sqlite");
 try {
  const store = new FleetStore(path); store.close();
  const value = registration();
  expect(preview(path, value).enrolled).toBe(false);
  let inventory = new FleetStore(path); expect(inventory.nodes()).toHaveLength(0); inventory.close();
  expect(preview(path, value, { enroll: true }).enrolled).toBe(true);
  inventory = new FleetStore(path); const before = inventory.nodes(); inventory.close();
  expect(before[0]).toMatchObject({ enabled: false, reachable: false, sdkReady: false, modelReady: false });
  expect(preview(path, value, { enroll: true }).enrolled).toBe(false);
  value.node.id = "vm";
  expect(preview(path, value, { enroll: true }).checks.find(c => c.code === "shared_capacity_confirmation")?.ok).toBe(false);
  value.sharedCapacityConfirmed = true;
  expect(preview(path, value, { enroll: true }).enrolled).toBe(true);
  inventory = new FleetStore(path); expect(inventory.nodes().find(n => n.id === "new")).toEqual(before[0]); inventory.close();
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test("SQLite enrollment rolls back both metadata and inventory on audit failure", async () => {
 const dir = await mkdtemp(join(tmpdir(), "onboarding-")); const path = join(dir, "fleet.sqlite");
 try {
  const store = new FleetStore(path); store.close(); const db = new Database(path);
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'controlled failure'); END"); db.close();
  expect(() => preview(path, registration(), { enroll: true })).toThrow();
  const read = new Database(path); expect(read.query("SELECT * FROM nodes").all()).toHaveLength(0);
  expect(read.query("SELECT name FROM sqlite_master WHERE name='onboarding_hosts'").get()).toBeNull(); read.close();
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test("controlled subprocess binds nonce and digest; reachable never proves execution", async () => {
 const dir = await mkdtemp(join(tmpdir(), "onboarding-"));
 try {
  const script = join(dir, "probe.ts");
  await writeFile(script, `const r=await Bun.stdin.json(); console.log(JSON.stringify({nonce:r.nonce,digest:r.digest,checks:[{ok:true,code:'transport_reachable',action:'none'}]}));`);
  const value = registration(); value.discovery.args = [script];
  expect(await discover(value)).toEqual({ checks: [{ ok: true, code: "transport_reachable", action: "none" }], executionProven: false });
  await writeFile(script, `console.log(JSON.stringify({nonce:'wrong',checks:[]}));`);
  expect((await discover(value)).checks[0]?.code).toBe("discovery_failed");
 } finally { await rm(dir, { recursive: true, force: true }); }
});
test("onboarding preview and enrollment never create a missing inventory database", async () => {
 const dir = await mkdtemp(join(tmpdir(), "onboarding-missing-db-"));
 const path = join(dir, "inventory.sqlite");
 try {
  for (const enroll of [false, true]) {
   expect(() => preview(path, registration(), { enroll })).toThrow();
   expect(await readdir(dir)).toEqual([]);
  }
 } finally { await rm(dir, { recursive: true, force: true }); }
});
