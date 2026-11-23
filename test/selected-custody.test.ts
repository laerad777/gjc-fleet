import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest } from "../src/core";
import { validateResult } from "../src/fleet";
import { collectResult, prepareWorkspace, run, sha256, validateSelectedOutputs } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 60_000);

test("selected custody normalizes a list of exact file names and rejects invalid input types", () => {
	expect(validateSelectedOutputs(["z.txt", "docs/answer.txt"])).toEqual(["docs/answer.txt", "z.txt"]);
	for (const value of [null, "answer.txt", { path: "answer.txt" }, [], [25], ["", "answer.txt"]]) {
		expect(() => validateSelectedOutputs(value)).toThrow();
	}
});

test("selected custody keeps manifest bytes and tracked patch scoped to the selected regular files", async () => {
	const f = await repositoryFixture("fleet-selected-custody-");
	directories.push(f.dir);
	const identity = await prepareWorkspace({
		taskId: "task", attemptId: "attempt", nodeId: "local", inputDigest: sha256("selected custody"),
		repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot,
	});
	await mkdir(join(identity.path, "docs"));
	await writeFile(join(identity.path, "docs", "answer.txt"), "selected answer\n");
	await writeFile(join(identity.path, "tracked.txt"), "selected tracked edit\n");
	await writeFile(join(identity.path, "notes.txt"), "ordinary unselected note\n");
	const paths = ["docs/answer.txt", "tracked.txt"];
	const selected = await collectResult(identity, [], [...paths].reverse());
	expect(selected.custody).toEqual({ kind: "selected", paths, selectionDigest: digest(paths) });
	expect(selected.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64").toString("utf8")])).toEqual([
		["docs/answer.txt", "selected answer\n"],
		["tracked.txt", "selected tracked edit\n"],
	]);
	expect(selected.patch).toContain("+selected tracked edit");
	expect(selected.patch).not.toContain("notes.txt");
	validateResult(identity, JSON.parse(JSON.stringify(selected)));

	const full = await collectResult(identity, []);
	expect(full.custody).toBeUndefined();
	expect(full.files.map((file) => file.path)).toEqual(["docs/answer.txt", "notes.txt", "tracked.txt"]);
}, 120_000);

test("selected custody rejects ambiguous portable names", () => {
	expect(validateSelectedOutputs(["documents/meeting-notes.txt"])).toEqual(["documents/meeting-notes.txt"]);
	expect(() => validateSelectedOutputs(["documents/notes~1.txt"])).toThrow("invalid_selected_outputs");
	expect(() => validateSelectedOutputs(["documents/caf\u00e9.txt", "documents/cafe\u0301.txt"])).toThrow("invalid_selected_outputs");
});

test("selected custody refuses a path inside a nested repository (full custody would withhold it)", async () => {
	const f = await repositoryFixture("fleet-selected-nested-");
	directories.push(f.dir);
	const identity = await prepareWorkspace({
		taskId: "task",
		attemptId: "attempt",
		nodeId: "local",
		inputDigest: sha256("selected nested"),
		repo: f.repo,
		baseCommit: f.baseCommit,
		workspaceRoot: f.workspaceRoot,
	});
	const nested = join(identity.path, "vendor", "subrepo");
	await mkdir(nested, { recursive: true });
	expect((await run(["git", "init", "-q", nested], f.dir)).exit).toBe(0);
	await writeFile(join(nested, "secret.txt"), "NESTED_SELECTED_LEAK\n");
	await writeFile(join(identity.path, "ok.txt"), "outside nested\n");
	await expect(collectResult(identity, [], ["vendor/subrepo/secret.txt"])).rejects.toThrow(
		"selected_nested_repository:vendor/subrepo/secret.txt",
	);
	const ok = await collectResult(identity, [], ["ok.txt"]);
	expect(ok.files.map((file) => file.path)).toEqual(["ok.txt"]);
	expect(Buffer.from(ok.files[0]!.contentBase64, "base64").toString("utf8")).toBe("outside nested\n");
	const full = await collectResult(identity, []);
	expect(full.exclusions).toEqual([{ path: "vendor/subrepo", reason: "nested_repository", outerTrackedEntries: 0 }]);
	expect(full.files.map((file) => file.path)).toContain("ok.txt");
	expect(full.files.some((file) => file.path.includes("secret"))).toBe(false);
}, 120_000);
