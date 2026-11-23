import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../scripts/local-backlog";

test("backlog classification never promotes report prose or missing receipts", () => {
 expect(classify("report", "CLEAN tests passed")).toBe("unknown_missing_receipt");
 expect(classify("report", "CLEAN", {})).toBe("unknown_missing_receipt");
 expect(classify("report", "", { status: "completed" })).toBe("unknown_missing_receipt");
 expect(classify("c710e792", "CLEAN", { status: "completed" })).toBe("excluded_no_fix");
 expect(classify("run", "partial", { status: "failed", failureCode: "provider_quota_429" })).toBe("blocked_quota");
 expect(classify("run", "done", { status: "in_flight" })).toBe("unresolved_in_flight");
 expect(classify("run", "CLEAN", { status: "completed" })).toBe("collected_unverified");
});

test("local backlog lists report-*.md under docs/reports and still lists a root report", async () => {
 const root = await mkdtemp(join(tmpdir(), "backlog-reports-"));
 try {
  await mkdir(join(root, "docs", "reports"), { recursive: true });
  await writeFile(join(root, "docs", "reports", "report-abc.md"), "moved report\n");
  await writeFile(join(root, "docs", "reports", "RESULT.md"), "not a report id\n");
  await writeFile(join(root, "docs", "reports", "not-report-abc.md"), "prefix does not count\n");
  await writeFile(join(root, "report-root.md"), "root report\n");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../scripts/local-backlog.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const body = JSON.parse(stdout);
  expect(body.reports.map((report: { path: string }) => report.path).sort()).toEqual([
   "docs/reports/report-abc.md",
   "report-root.md",
  ]);
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});
