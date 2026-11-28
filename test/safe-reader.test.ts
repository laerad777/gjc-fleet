import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAnchoredFile } from "../src/safe-reader";

test("anchored reader rejects a parent path component before opening a file", () => {
	const root = mkdtempSync(join(tmpdir(), "fleet-safe-reader-"));
	try {
		expect(() => readAnchoredFile(root, ["..", "not-read.txt"], 64)).toThrow("unsafe_artifact_path");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"anchored reader rejects a directory link beyond its root",
	() => {
		const temp = realpathSync(mkdtempSync(join(tmpdir(), "fleet-safe-reader-")));
		try {
			const root = join(temp, "root"), sibling = join(temp, "sibling");
			mkdirSync(root);
			mkdirSync(sibling);
			writeFileSync(join(root, "sample.txt"), "local fixture");
			writeFileSync(join(sibling, "sample.txt"), "sibling fixture");
			symlinkSync(sibling, join(root, "linked"), "dir");
			expect(readAnchoredFile(root, ["sample.txt"], 64).bytes.toString("utf8")).toBe("local fixture");
			expect(() => readAnchoredFile(root, ["linked", "sample.txt"], 64)).toThrow("unsafe_artifact_parent");
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	},
);
