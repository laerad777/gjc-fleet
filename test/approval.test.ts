import { expect, test } from "bun:test";
import { SDK_UI_APPROVAL_CONTRACT } from "../src/approval";
import { validateTaskInput } from "../src/core";

const input = {
	schemaVersion: 1,
	key: "approval-contract",
	caller: "test",
	repoId: "repo",
	baseCommit: "a".repeat(40),
	prompt: "test",
	required: {},
};

test("the versioned SDK approval contract is opt-in and accepts only its exact identifier", () => {
	expect(SDK_UI_APPROVAL_CONTRACT).toBe("sdk-ui-waiter-v1");
	const omitted = { ...input };
	expect(() => validateTaskInput(omitted)).not.toThrow();
	expect(Object.hasOwn(omitted, "approvalContract")).toBe(false);
	expect(() => validateTaskInput({ ...input, approvalContract: SDK_UI_APPROVAL_CONTRACT })).not.toThrow();
	for (const approvalContract of ["sdk-ui-waiter-v2", null]) {
		expect(() => validateTaskInput({ ...input, approvalContract })).toThrow(
			expect.objectContaining({ code: "INVALID_INPUT", message: "Unknown approval contract" }),
		);
	}
});
