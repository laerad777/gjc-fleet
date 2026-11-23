import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashTopLevelFiles } from "../scripts/verify-hash-files";

const ALWAYS = ["package.json", "LICENSE", "NOTICE.md", "README.md", "UPSTREAM.md", "license-inventory.json"];
const PRIVATE_ONLY = ["ACCEPTANCE.md", "provenance.json", ".gitignore"];
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tree(names: string[], opts: { repository?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "verify-hash-"));
	roots.push(root);
	for (const name of names) writeFileSync(join(root, name), `content of ${name}`);
	if (opts.repository) mkdirSync(join(root, ".git"));
	return root;
}

describe("verify manifest top-level files", () => {
	test("repository tree: every file is hashed, in the historical order, and nothing is skipped", async () => {
		const { files, skipped } = await hashTopLevelFiles(tree([...ALWAYS, ...PRIVATE_ONLY], { repository: true }));
		expect(Object.keys(files)).toEqual(["package.json", "LICENSE", "NOTICE.md", "README.md", "UPSTREAM.md", "ACCEPTANCE.md", "license-inventory.json", "provenance.json", ".gitignore"]);
		for (const digest of Object.values(files)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(skipped).toEqual([]);
	});
	test("public tree: ACCEPTANCE.md, provenance.json and .gitignore may be absent and are recorded as skipped", async () => {
		const { files, skipped } = await hashTopLevelFiles(tree(ALWAYS));
		expect(Object.keys(files)).toEqual(ALWAYS.filter((n) => n !== "license-inventory.json").concat("license-inventory.json"));
		expect("ACCEPTANCE.md" in files).toBe(false);
		expect("provenance.json" in files).toBe(false);
		expect(skipped).toEqual(["ACCEPTANCE.md", "provenance.json", ".gitignore"]);
	});
	test("repository tree: a missing optional file fails instead of being skipped", async () => {
		for (const missing of PRIVATE_ONLY) {
			const root = tree([...ALWAYS, ...PRIVATE_ONLY.filter((n) => n !== missing)], { repository: true });
			await expect(hashTopLevelFiles(root)).rejects.toThrow(missing);
		}
	});
	test("a missing required file still fails in either tree", async () => {
		const names = ALWAYS.filter((n) => n !== "NOTICE.md");
		await expect(hashTopLevelFiles(tree([...names, ...PRIVATE_ONLY], { repository: true }))).rejects.toThrow("NOTICE.md");
		await expect(hashTopLevelFiles(tree(names))).rejects.toThrow("NOTICE.md");
	});
	test("public tree: each optional file is skipped on its own", async () => {
		for (const missing of PRIVATE_ONLY) {
			const { files, skipped } = await hashTopLevelFiles(tree([...ALWAYS, ...PRIVATE_ONLY.filter((n) => n !== missing)]));
			expect(missing in files).toBe(false);
			expect(Object.keys(files)).toHaveLength(8);
			expect(skipped).toEqual([missing]);
		}
	});
});
