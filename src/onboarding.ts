import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { posix, win32 } from "node:path";
import type { NodeConfig } from "./contracts";
import type { ReadinessCheck } from "./placement-preflight";
import { canonicalJson, digest, validateNode } from "./core";
import { nodeRpc, type StdioRpc } from "./rpc";
import { spawnGit, spawnTrusted } from "./spawn";

/**
 * Public onboarding stderr: allowlisted fixed codes only (never Error.message
 * free text, paths, or credential-shaped leaves). Unknown messages collapse to
 * `onboarding_failed`.
 */
const PUBLIC_ONBOARDING_CODES = new Set([
	"onboarding_failed",
	"discovery_output_limit",
	"request_limit",
	"usage_onboarding",
]);
export function publicOnboardingFailure(error: unknown): string {
	if (!(error instanceof Error)) return "onboarding_failed";
	const code = error.message.trim();
	if (code.startsWith("Usage:")) return "usage_onboarding";
	if (PUBLIC_ONBOARDING_CODES.has(code)) return code;
	return "onboarding_failed";
}

export interface Registration {
 node: NodeConfig;
 physicalHostId: string;
 /** Operator-verified existing authentication; never bootstrap SSH trust here. */
 authenticatedTransport: boolean;
 paths: { executable: string; bun: string; git: string; helper: string };
 source: { repoId: string; baseCommit: string };
 /** An existing authenticated command running this module's probe on the target. */
 discovery: { command: string; args: string[] };
 sharedCapacityConfirmed?: boolean;
}
const check = (ok: boolean, code: string, action: string): ReadinessCheck => ({ ok, code, action: ok ? "none" : action });
const absolute = (s: unknown): s is string => typeof s === "string" && (posix.isAbsolute(s) || win32.isAbsolute(s));

/** Pure validation: configured settings are not activation or execution evidence. */
export function validateRegistration(value: Registration): ReadinessCheck[] {
 const checks: ReadinessCheck[] = [];
 try { validateNode(value?.node); } catch { checks.push(check(false, "node_config_required", "Supply a complete NodeConfig accepted by validateNode; thread labels are not node identities.")); }
 checks.push(check(typeof value?.physicalHostId === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value.physicalHostId), "physical_host_id_required", "Supply an explicit stable physicalHostId; a VM and its host share physical capacity."));
 checks.push(check(value?.authenticatedTransport === true, "authenticated_transport_required", "Verify an existing authenticated transport and set authenticatedTransport=true; supply the known username and pretrusted host key externally. No trust bootstrap is performed."));
 for (const key of ["executable", "bun", "git", "helper"] as const) checks.push(check(absolute(value?.paths?.[key]), `${key}_path_required`, `Supply paths.${key} as an absolute path on the target host.`));
 checks.push(check(!!value?.source?.repoId && absolute(value?.node?.roots?.[value.source.repoId]) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value?.source?.baseCommit ?? ""), "source_base_required", "Supply source.repoId matching node.roots and source.baseCommit as an exact full commit hash."));
 checks.push(check(absolute(value?.discovery?.command) && Array.isArray(value?.discovery?.args) && value.discovery.args.every(x => typeof x === "string"), "discovery_transport_required", "Supply an absolute discovery.command and string args invoking onboarding.ts probe on the authenticated target; never use a service-start command."));
 return checks;
}

/** Read-only target probe. No shell, install, fetch, workspace creation, or model call. */
export async function probeRegistration(value: Registration) {
 const checks = validateRegistration(value);
 if (checks.some(c => !c.ok)) return checks;
 for (const key of ["executable", "bun", "git", "helper"] as const) {
  try { await access(value.paths[key], key === "helper" ? constants.R_OK : constants.X_OK); checks.push(check(true, `${key}_accessible`, "")); }
  catch { checks.push(check(false, `${key}_unavailable`, `Provision the explicit paths.${key} on this target; onboarding never installs software.`)); }
 }
 checks.push(check(value.node.os === process.platform && value.node.arch === process.arch, "target_platform", "Run discovery on the configured target OS and architecture."));
 const repo = value.node.roots[value.source.repoId]!;
 const settle = async (child: { stdout: ReadableStream<Uint8Array>; exited: Promise<number>; kill(): void }) => {
  const timer = setTimeout(() => child.kill(), 5000);
  try { const output = await bounded(child.stdout, () => child.kill()); if (await child.exited !== 0) throw Error(); return output.trim(); } finally { clearTimeout(timer); child.kill(); }
 };
 const run = (argv: string[]) => settle(spawnTrusted(argv, { untrusted: [repo, value.node.workspaceRoot], stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } }));
 for (const key of ["bun", "git"] as const) {
  try { await run([value.paths[key], "--version"]); checks.push(check(true, `${key}_runs`, "")); }
  catch { checks.push(check(false, `${key}_failed`, `Repair paths.${key}; accessibility alone does not prove it runs.`)); }
 }
 try {
  if (await realpath(repo) !== repo) throw Error();
  const git = (args: string[]) => settle(spawnGit(repo, args, { program: value.paths.git, untrusted: [value.node.workspaceRoot], stderr: "ignore" }));
  if (await git(["rev-parse", "--show-toplevel"]) !== repo || await git(["rev-parse", "--verify", value.source.baseCommit + "^{commit}"]) !== value.source.baseCommit) throw Error();
  checks.push(check(true, "source_verified", ""));
 } catch { checks.push(check(false, "source_unavailable", "Provision the canonical allowlisted repository and exact base commit on this target; no clone/fetch was attempted.")); }
 try { if (await realpath(value.node.workspaceRoot) !== value.node.workspaceRoot) throw Error(); await access(value.node.workspaceRoot, constants.W_OK | constants.X_OK); checks.push(check(true, "workspace_accessible", "")); }
 catch { checks.push(check(false, "workspace_unavailable", "Provide an existing canonical writable workspaceRoot on the target.")); }
 let rpc: StdioRpc | undefined;
 try {
  rpc = nodeRpc(value.node, 5000);
  await rpc.initialize(); const tools = await rpc.tools();
  const required = ["start_session", "send_prompt", "read_turn", "list_questions"].map(x => "gjc_coordinator_" + x);
  const missing = required.filter(x => !tools.some(t => t.name === x));
  checks.push(check(!missing.length, "coordinator_catalog", "Expose Coordinator catalog tools: " + missing.join(", ")));
 } catch { checks.push(check(false, "coordinator_catalog", "Verify the existing attach-only authenticated Coordinator command; no service was started.")); }
 finally { rpc?.close(); }
 return checks;
}
async function bounded(stream: ReadableStream<Uint8Array>, kill: () => void) {
 const reader = stream.getReader(); const chunks: Uint8Array[] = []; let size = 0;
 for (;;) { const { done, value } = await reader.read(); if (done) return Buffer.concat(chunks).toString(); size += value.length; if (size > 1024 * 1024) { kill(); throw Error("discovery_output_limit"); } chunks.push(value); }
}
export async function discover(value: Registration) {
 value = structuredClone(value);
 const checks = validateRegistration(value);
 if (checks.some(c => !c.ok)) return { checks, executionProven: false as const };
 const nonce = randomUUID();
 const child = spawnTrusted([value.discovery.command, ...value.discovery.args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
 const timer = setTimeout(() => child.kill(), 15000);
 try {
  child.stdin.write(canonicalJson({ nonce, digest: digest(value), registration: value })); child.stdin.end();
  const output = await bounded(child.stdout, () => child.kill());
  if (await child.exited !== 0) throw Error();
  const result = JSON.parse(output);
  if (result.nonce !== nonce || result.digest !== digest(value) || !Array.isArray(result.checks) || !result.checks.length || !result.checks.every((c: any) => typeof c.ok === "boolean" && typeof c.code === "string" && typeof c.action === "string")) throw Error();
  return { checks: result.checks as ReadinessCheck[], executionProven: false as const };
 } catch { return { checks: [check(false, "discovery_failed", "Run the explicit authenticated discovery command with onboarding.ts probe; verify target paths and protocol. No username or host trust is inferred.")], executionProven: false as const }; }
 finally { clearTimeout(timer); child.kill(); }
}

/** Default dry-run; opens ONLY an explicitly supplied existing Fleet SQLite database. */
export function preview(dbPath: string, value: Registration, options: { enroll?: boolean } = {}) {
 value = structuredClone(value);
 const checks = validateRegistration(value);
 if (checks.some(c => !c.ok)) return { enrolled: false, checks };
 const db = new Database(dbPath, options.enroll ? { readwrite: true, create: false } : { readonly: true });
 try {
  if (options.enroll) db.exec("BEGIN IMMEDIATE");
  const nodes = db.query<{ id: string; data: string }, []>("SELECT id,data FROM nodes").all();
  checks.push(check(!nodes.some(n => n.id === value.node.id), "node_id_exists", "Choose a new node ID; existing nodes are never overwritten. Thread labels do not create hosts."));
  const hasHosts = !!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='onboarding_hosts'").get();
  const hosts = hasHosts ? db.query<{ node_id: string; physical_host_id: string }, []>("SELECT node_id,physical_host_id FROM onboarding_hosts").all() : [];
  const shared = hosts.filter(h => h.physical_host_id === value.physicalHostId);
  const unknown = nodes.filter(n => !hosts.some(h => h.node_id === n.id));
  checks.push(check((!shared.length && !unknown.length) || value.sharedCapacityConfirmed === true, "shared_capacity_confirmation", `Confirm sharedCapacityConfirmed=true after reviewing physical capacity: same physical host nodes [${shared.map(h => h.node_id).join(", ")}]; legacy nodes with unknown physical identity [${unknown.map(n => n.id).join(", ")}]. VM-vs-host capacity is shared, not additive; thread labels are not nodes.`));
  const node: NodeConfig = { ...value.node, enabled: false, draining: false, reachable: false, sdkReady: false, modelReady: false };
  if (!options.enroll || checks.some(c => !c.ok)) { if (options.enroll) db.exec("ROLLBACK"); return { enrolled: false, node, checks, sharedHostNodes: shared.map(h => h.node_id), unclassifiedNodes: unknown.map(n => n.id), executionProven: false }; }
  // INSERT, never UPSERT. Identity metadata and inventory commit under one writer lock.
  db.exec("CREATE TABLE IF NOT EXISTS onboarding_hosts(node_id TEXT PRIMARY KEY REFERENCES nodes(id),physical_host_id TEXT NOT NULL)");
  db.query("INSERT INTO nodes(id,data) VALUES (?,?)").run(node.id, canonicalJson(node));
  db.query("INSERT INTO onboarding_hosts VALUES (?,?)").run(node.id, value.physicalHostId);
  db.query("INSERT INTO audit(task_id,kind,at,data) VALUES (NULL,?,?,?)").run("node_updated", new Date().toISOString(), canonicalJson({ nodeId: node.id, onboarding: true, physicalHostId: value.physicalHostId }));
  db.exec("COMMIT");
  return { enrolled: true, node, checks, executionProven: false };
 } catch (error) { if (options.enroll) { try { db.exec("ROLLBACK"); } catch {} } throw error; }
 finally { db.close(); }
}
export const proofBoundaries = { coordinatorCatalog: "Tools/list only; not broker or model proof", broker: "Unproven: separately verify authenticated session authority without starting services", model: "Unproven: configured models/profiles are settings, not provider authentication or execution", activation: "Enrollment is disabled inventory only; use existing explicit activation controls after independent verification" };

if (import.meta.main) {
 try {
  const [stage = "validate", file, dbPath, flag] = process.argv.slice(2);
  if (stage === "probe") {
   const raw = await bounded(Bun.stdin.stream(), () => { throw Error("request_limit"); }); const request = JSON.parse(raw);
   console.log(canonicalJson({ nonce: request.nonce, digest: digest(request.registration), checks: await probeRegistration(request.registration) }));
  } else {
   if (!file) throw Error("Usage: bun src/onboarding.ts validate|discover|preview|enroll registration.json [explicit-existing-db] [--confirm-enroll]");
   const value = await Bun.file(file).json();
   let result: unknown;
   if (stage === "validate") result = validateRegistration(value);
   else if (stage === "discover") result = await discover(value);
   else if (stage === "preview" || stage === "enroll") {
    if (!dbPath || (stage === "enroll" && flag !== "--confirm-enroll")) throw Error("Explicit existing database required; enroll also requires --confirm-enroll");
    result = preview(dbPath, value, { enroll: stage === "enroll" });
   } else throw Error("Unknown onboarding stage");
   console.log(canonicalJson({ result, proofBoundaries }));
  }
 } catch (error) { console.error(publicOnboardingFailure(error)); process.exitCode = 1; }
}
