import { expect, test } from "bun:test";
import type { OperationIntent, TaskRecord } from "../src/contracts";
import { digest } from "../src/core";
import { heldResultTest } from "../src/store/shared";

test("a pending export review only exposes held test evidence bound to that exact review", () => {
	const held = { test: { argv: ["bun", "test"], exit: 0 } };
	const task: TaskRecord = {
		id: "task", attemptId: "attempt", inputDigest: "input", phase: "completed_unverified", held: false,
		input: {
			schemaVersion: 1, key: "test", caller: "fixture", repoId: "repo",
			baseCommit: "a".repeat(40), prompt: "test", required: {},
		},
		result: {
			status: "completed_unverified", evidence: {}, executionTerminal: true, verified: false,
			exportIncomplete: { subject: {}, reviewDigest: "review", requiredAt: "", resultTestDigest: digest(held) },
		},
	};
	const claim: OperationIntent = {
		id: "test", key: "test", digest: "request", taskId: "task", attemptId: "attempt",
		kind: "result-test", payload: {}, held,
	};
	expect(heldResultTest(task, claim)).toEqual(held);
	expect(heldResultTest(task, { ...claim, held: { test: { argv: ["bun", "test"], exit: 1 } } })).toBeUndefined();
	expect(heldResultTest(task, { ...claim, receipt: held })).toBeUndefined();
	expect(heldResultTest({ ...task, result: undefined }, claim)).toBeUndefined();
	expect(heldResultTest(task, undefined)).toBeUndefined();
});
