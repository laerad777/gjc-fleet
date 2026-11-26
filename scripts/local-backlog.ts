import { readdir, lstat } from "node:fs/promises";
import { resolve, join, relative, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawnTrusted } from "../src/spawn";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const excluded = new Set([".git", ".gjc", ".local", "node_modules"]);
export async function inventory(root: string): Promise<Record<string, string>> {
 const files: Record<string, string> = {};
 async function walk(dir: string) {
  for (const name of (await readdir(dir)).sort()) {
   if (excluded.has(name) || /identity/i.test(name)) continue;
   const path = join(dir, name), info = await lstat(path);
   if (info.isSymbolicLink()) throw new Error(`Symlink refused: ${path}`);
   if (info.isDirectory()) await walk(path);
   else if (info.isFile()) files[relative(root, path)] = hash(await Bun.file(path).bytes());
  }
 }
 await walk(root);
 return files;
}
export function classify(id: string, text: string | undefined, receipt?: { status?: string; failureCode?: string }) {
 if (/c710/i.test(id)) return "excluded_no_fix";
 if (receipt?.failureCode && /quota|429|exhaust/i.test(receipt.failureCode)) return "blocked_quota";
 if (!text?.trim() || !receipt?.status) return "unknown_missing_receipt";
 if (receipt.status === "in_flight") return "unresolved_in_flight";
 return "collected_unverified";
}

/**
 * Match report-*.md with the host basename so Windows `\` inventory keys
 * still qualify, while a POSIX name that literally contains `\` is not
 * split. Path keys in files/receipts stay as inventory wrote them.
 */
export function isReportPath(path: string): boolean {
 return /^report-.*\.md$/.test(basename(path));
}

// This command reads only local files and executes only this node's local tests/build.
// Report prose, file existence, and historical CLEAN labels never establish success.
if (import.meta.main) {
 const args = process.argv.slice(2);
 const verify = args.includes("--verify");
 const root = resolve(args.find(arg => !arg.startsWith("--")) ?? ".");
 if (root !== process.cwd()) throw new Error("Run from the task-owned candidate directory; other workspaces are read-only inputs, not execution targets");
 const before = await inventory(root);
 const receiptArg = args.find(arg => arg.startsWith("--receipts="));
 const receipts: Record<string, { status?: string; failureCode?: string }> = receiptArg
  ? await Bun.file(resolve(root, receiptArg.slice("--receipts=".length))).json() : {};
 const reports = [];
 for (const path of Object.keys(before).filter(isReportPath)) {
  reports.push({ path, sha256: before[path], classification: classify(path, await Bun.file(join(root, path)).text(), receipts[path]), reason: "Report artifact is not CLEAN; receipt classifications are local evidence only" });
 }
 const commands = [];
 if (verify) {
  for (const argv of [["/opt/homebrew/bin/bun", "test", "test"], ["/opt/homebrew/bin/bun", "run", "build"]]) {
   const child = spawnTrusted(argv, { cwd: root, untrusted: [root], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
   const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
   commands.push({ argv, exit, stdout, stderr, stdoutDigest: hash(stdout), stderrDigest: hash(stderr) });
  }
 }
 const after = await inventory(root);
 const stable = JSON.stringify(before) === JSON.stringify(after);
 console.log(JSON.stringify({ kind: "local-only-backlog-evidence", root, reports, excluded: [{ id: "c710", classification: classify("c710", "") }], quotaPolicy: "Failed quota receipts remain blocked; no retry or production relabel", files: before, sourceDigest: hash(JSON.stringify(before)), stable, commands, localVerification: verify && stable && commands.every(command => command.exit === 0) ? "passed_local_only" : "unverified_or_failed", independentReview: "required", productionStatus: "unchanged_unknown" }, null, 2));
 if (!stable || commands.some(command => command.exit !== 0)) process.exitCode = 1;
}
