import { expect, test } from "bun:test";
import type { OperationIntent } from "../src/contracts";
import { exportCompleteness } from "../src/fleet/shared";
import { sha256, type ResultManifest } from "../src/workspace";

test("a legacy export cannot be marked complete without a retained exclusions observation", () => {
	const head = "a".repeat(40);
	const legacy: ResultManifest = {
		schemaVersion: 1,
		identity: {
			schemaVersion: 1, taskId: "task", attemptId: "attempt", nodeId: "node",
			inputDigest: "input", baseCommit: head, repo: "/repo", path: "/work/task",
		},
		outputHead: head, producer: { platform: "linux", arch: "x64", bun: "fixture" },
		patch: "", patchDigest: sha256(""), files: [], tests: [], status: "not_run",
	};
	const claim: OperationIntent = {
		id: "test", key: "test", digest: "request", taskId: "task", attemptId: "attempt",
		kind: "result-test", payload: {},
	};
	const exclusions = [{ path: "vendor", reason: "gitlink", outerTrackedEntries: 1 }] as const;
	expect(exportCompleteness(legacy, claim)).toEqual({ completeness: "unknown", exclusions: null });
	expect(exportCompleteness(legacy, { ...claim, receipt: {} })).toEqual({ completeness: "unknown", exclusions: null });
	expect(exportCompleteness(legacy, { ...claim, receipt: { observedExclusions: [] } })).toEqual({ completeness: "complete", exclusions: [] });
	expect(exportCompleteness(legacy, { ...claim, receipt: { observedExclusions: [...exclusions] } })).toEqual({
		completeness: "incomplete", exclusions: [...exclusions],
	});
	const current: ResultManifest = { ...legacy, exclusions: [...exclusions], exportComplete: false };
	expect(exportCompleteness(current, { ...claim, receipt: { observedExclusions: [] } })).toEqual({
		completeness: "incomplete", exclusions: [...exclusions],
	});
});
