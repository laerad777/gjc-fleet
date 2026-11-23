import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, isReportPath } from "../scripts/local-backlog";

test("backlog classification never promotes report prose or missing receipts", () => {
 expect(classify("report", "CLEAN tests passed")).toBe("unknown_missing_receipt");
 expect(classify("report", "CLEAN", {})).toBe("unknown_missing_receipt");
 expect(classify("report", "", { status: "completed" })).toBe("unknown_missing_receipt");
 expect(classify("c710e792", "CLEAN", { status: "completed" })).toBe("excluded_no_fix");
 expect(classify("run", "partial", { status: "failed", failureCode: "provider_quota_429" })).toBe("blocked_quota");
 expect(classify("run", "done", { status: "in_flight" })).toBe("unresolved_in_flight");
 expect(classify("run", "CLEAN", { status: "completed" })).toBe("collected_unverified");
});

test("isReportPath matches by basename for / and Windows \\ inventory keys", () => {
 expect(isReportPath("report-root.md")).toBe(true);
 expect(isReportPath("docs/reports/report-abc.md")).toBe(true);
 expect(isReportPath("docs\\reports\\report-abc.md")).toBe(true);
 expect(isReportPath("docs\\reports\\RESULT.md")).toBe(false);
 expect(isReportPath("docs\\reports\\not-report-abc.md")).toBe(false);
 // A POSIX filename that literally contains `\` is not rewritten into a nested path.
 expect(isReportPath("weird\\name-not-a-report.md")).toBe(false);
 expect(isReportPath("weird\\report-kept.md")).toBe(true);
});

test("local backlog lists report-*.md under docs/reports and still lists a root report", async () => {
 const root = await mkdtemp(join(tmpdir(), "backlog-reports-"));
 try {
  await mkdir(join(root, "docs", "reports"), { recursive: true });
  await writeFile(join(root, "docs", "reports", "report-abc.md"), "moved report\n");
  await writeFile(join(root, "docs", "reports", "RESULT.md"), "not a report id\n");
  await writeFile(join(root, "docs", "reports", "not-report-abc.md"), "prefix does not count\n");
  await writeFile(join(root, "report-root.md"), "root report\n");
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../scripts/local-backlog.ts")], {
   cwd: root,
   stdout: "pipe",
   stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
   new Response(proc.stdout).text(),
   new Response(proc.stderr).text(),
   proc.exited,
  ]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  const body = JSON.parse(stdout);
  const paths = body.reports.map((report: { path: string }) => report.path).sort();
  // Inventory keys keep the platform separator; do not hard-code `/` here.
  expect(paths).toEqual([join("docs", "reports", "report-abc.md"), "report-root.md"].sort());
  // Report path keys stay aligned with inventory/receipts (no slash rewriting).
  for (const report of body.reports as { path: string; sha256: string }[]) {
   expect(body.files[report.path]).toBe(report.sha256);
  }
 } finally {
  await rm(root, { recursive: true, force: true });
 }
});
