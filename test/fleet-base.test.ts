import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_UI_APPROVAL_CONTRACT, type TaskApprovalBackend } from "../src/approval";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";

test("duplicate approval backend registration refuses ambiguous routing without attaching", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-base-test-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		let attaches = 0;
		const backend: TaskApprovalBackend = {
			contract: SDK_UI_APPROVAL_CONTRACT,
			async attach() { attaches++; throw new Error("registration is not an attach"); },
		};
		expect(new Fleet(store, { approvalBackends: [backend] })).toBeInstanceOf(Fleet);
		expect(() => new Fleet(store, { approvalBackends: [backend, { ...backend }] })).toThrow(
			expect.objectContaining({ code: "APPROVAL_CONTRACT" }),
		);
		expect(attaches).toBe(0);
		expect(store.taskStates()).toEqual([]);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
