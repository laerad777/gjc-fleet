import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";

test("scheduling deltas deduplicate task IDs and request a full refresh on overflow", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-deltas-test-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		const start = store.schedulingCursor();
		expect(store.schedulingChanges(start, 1)).toEqual([]);
		const add = (key: string) => store.submit({
			schemaVersion: 1, key, caller: "fixture", repoId: "repo",
			baseCommit: "a".repeat(40), prompt: "test", required: {},
		}).id;
		const first = add("first");
		expect(store.schedulingChanges(start, 1)).toEqual([first]);
		const next = store.schedulingCursor();
		const second = add("second");
		expect(store.schedulingChanges(next, 1)).toEqual([second]);
		expect(store.schedulingChanges(start, 2)?.sort()).toEqual([first, second].sort());
		expect(store.schedulingChanges(start, 1)).toBeUndefined();
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
