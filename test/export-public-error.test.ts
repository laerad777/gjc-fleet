import { expect, test } from "bun:test";
import { FleetError } from "../src/core";
import { publicExportFailure } from "../src/result-export";

test("publicExportFailure keeps the code and redacts secret-shaped free text", () => {
	const line = publicExportFailure(
		"task-1",
		new FleetError(
			"EXPORT_REQUIRED_MISSING",
			"Required deliverable not in the collected result: deleted.txt password=hunter2-secret https://deploy:S3cr3tPw@git.example/x",
		),
	);
	const json = JSON.parse(line) as { ok: false; taskId: string; code: string; error: string };
	expect(json).toMatchObject({ ok: false, taskId: "task-1", code: "EXPORT_REQUIRED_MISSING" });
	expect(json.error).toContain("Required deliverable");
	expect(json.error).toContain("deleted.txt");
	expect(json.error).toContain("password=[redacted]");
	expect(json.error).not.toContain("hunter2");
	expect(json.error).toContain("https://[redacted]@git.example/x");
	expect(json.error).not.toContain("S3cr3tPw");
});
