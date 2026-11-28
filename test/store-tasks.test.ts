import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";

test("a result listing distinguishes absent manifests from stored falsy legacy values", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-listing-test-"));
	const path = join(dir, "fleet.db");
	const store = new FleetStore(path);
	try {
		const add = (key: string) => store.submit({
			schemaVersion: 1, key, caller: "fixture", repoId: "repo",
			baseCommit: "a".repeat(40), prompt: "test", required: {},
		}).id;
		const missing = add("absent");
		const legacy = [null, false, 0, ""].map((value, i) => ({ value, id: add("legacy-" + i) }));
		const db = new Database(path);
		try {
			const update = db.query("UPDATE tasks SET data=json_set(data, '$.resultManifest', json(?)) WHERE id=?");
			for (const { id, value } of legacy) update.run(JSON.stringify(value), id);
		} finally {
			db.close();
		}
		const listing = store.taskListing();
		expect(listing.map(({ state }) => state.id)).toEqual([missing, ...legacy.map(({ id }) => id)]);
		expect(listing.map(({ result }) => result)).toEqual([
			undefined, ...legacy.map(({ value }) => ({ stored: "inline" as const, value })),
		]);
		expect(listing.every(({ state }) => !Object.hasOwn(state, "resultManifest"))).toBe(true);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
