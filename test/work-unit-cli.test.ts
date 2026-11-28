import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { workUnitState } from "../src/work-unit";
import { deliverableCommand, workUnitsCommand } from "../src/work-unit-cli";

test("workunits refuses an unknown subcommand and a trailing flag without enabling the switch", () => {
	const dir = mkdtempSync(join(tmpdir(), "work-unit-cli-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		expect(workUnitState(store)).toBe("off");
		expect(() => workUnitsCommand(store, ["workunits", "inspect"])).toThrow(/usage_workunits/);
		expect(() => workUnitsCommand(store, ["workunits", "enable", "--reason", "test", "--extra"])).toThrow(/usage_workunits/);
		expect(workUnitState(store)).toBe("off");
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deliverable refuses an unknown flag even when the operator argument count is correct", async () => {
	const dir = mkdtempSync(join(tmpdir(), "work-unit-cli-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		await expect(deliverableCommand(store, [
			"deliverable", "task", "--legacy-report", "report.md", "--sha256", "a".repeat(64),
			"--role", "review", "--actor", "test", "--note", "test",
		])).rejects.toThrow(/usage_deliverable/);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
