import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreparation, collectResult, pathKey, prepareWorkspace, run, sha256 } from "../src/workspace";
import { validateResult } from "../src/fleet";
import { repositoryFixture } from "./fixtures/coordinator";

// Round-6 review regressions (334fffda): the collector never decides safety by
// comparing two independently obtained spellings of a path. Walk-derived and
// Git-derived paths meet in one canonical key space (Unicode normalization,
// case, Windows trailing dot/space aliases), exported files are additionally
// checked against repository boundaries by filesystem identity, names that are
// not portable never abort collection, and operator repository-scoped ignore
// sources are snapshotted when the workspace is prepared.

const NFC = "caf\u00e9";
const NFD = "cafe\u0301";
const directories: string[] = [];
// Removing the large fixtures outlasts the default hook timeout on a loaded host.
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const gitOk = async (argv: string[], cwd: string) => {
	const r = await run(["git", "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...argv], cwd);
	if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
	return r.stdout;
};
/** A fresh repository whose base commit tracks `baseFiles`, prepared as a task workspace. */
async function workspace(baseFiles: Record<string, string> = {}, options: { beforePrepare?: (repo: string, dir: string) => Promise<void> } = {}) {
	const f = await repositoryFixture("fleet-collection-identity-");
	directories.push(f.dir);
	for (const [name, content] of Object.entries(baseFiles)) {
		await mkdir(join(f.repo, name, ".."), { recursive: true });
		await writeFile(join(f.repo, name), content);
	}
	if (Object.keys(baseFiles).length) {
		await gitOk(["-C", f.repo, "add", "-f", "--", ...Object.keys(baseFiles)], f.dir);
		await gitOk(["-C", f.repo, "commit", "-qm", "base files"], f.dir);
	}
	await options.beforePrepare?.(f.repo, f.dir);
	const baseCommit = (await gitOk(["-C", f.repo, "rev-parse", "HEAD"], f.dir)).trim();
	const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit, workspaceRoot: f.workspaceRoot });
	return { f, identity, p: (...parts: string[]) => join(identity.path, ...parts) };
}
const files = (result: any) => result.files.map((file: any) => file.path);
/** A path in a .gitconfig value: forward slashes, so a Windows path is not read as escapes (review fx-9abb2530 F9). */
const configPath = (path: string) => path.replace(/\\/g, "/");
const keyed = (exclusions: any[]) => exclusions.map((entry) => ({ ...entry, path: pathKey(entry.path) }));
const valid = (identity: any, result: any) => expect(() => validateResult(identity, result)).not.toThrow();
const rejected = (identity: any, result: any) => expect(() => validateResult(identity, result)).toThrow();
const infoExclude = async (repo: string, rules: string) => {
	await mkdir(join(repo, ".git", "info"), { recursive: true });
	await writeFile(join(repo, ".git", "info", "exclude"), rules);
};
async function withXdg<T>(dir: string, rules: string, body: () => Promise<T>): Promise<T> {
	const xdg = join(dir, "xdg");
	await mkdir(join(xdg, "git"), { recursive: true });
	await writeFile(join(xdg, "git", "ignore"), rules);
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		return await body();
	} finally {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
}
/** Whether the OS temp volume resolves names case-insensitively (APFS/NTFS default) / normalization-insensitively (APFS). */
function volumeProbe() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-volume-probe-"));
	try {
		mkdirSync(join(dir, "Probe" + NFC));
		const exists = (name: string) => lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined;
		return { caseInsensitive: exists("PROBE" + NFC), normalizationInsensitive: exists("Probe" + NFD) };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const volume = volumeProbe();
/** Linux filesystems accept names that are not valid UTF-8; APFS refuses them (EILSEQ). */
function nonUtf8Supported() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-volume-probe-"));
	try {
		mkdirSync(Buffer.concat([Buffer.from(dir + "/"), Buffer.from([0x66, 0xff])]));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("round-6 MEDIUM-A: walk and Git spellings never decide safety on their own", () => {
	test("pathKey folds Unicode normalization, case and Windows trailing dot/space aliases per component", () => {
		expect(pathKey(NFD + "/Answer.TXT")).toBe(pathKey(NFC + "/answer.txt"));
		expect(pathKey("CAF\u00c9")).toBe(pathKey(NFD));
		expect(pathKey("Src/a")).toBe(pathKey("SRC/A"));
		expect(pathKey("\u212a")).toBe(pathKey("k")); // KELVIN SIGN
		expect(pathKey("na\u00efve/x")).toBe(pathKey("nai\u0308ve/X"));
		expect(pathKey("dir./a ")).toBe(pathKey("dir/a"));
		expect(pathKey("dir. . /a")).toBe(pathKey("dir/a"));
		expect(pathKey("a/b")).not.toBe(pathKey("a-b"));
		expect(pathKey("a/b.c")).not.toBe(pathKey("a/bc"));
		for (const path of ["a/b/c", NFD + "/x./y", "\u00e9/\u00c9/E\u0301"]) expect(pathKey(path).split("/")).toHaveLength(path.split("/").length);
	});
	test("reviewer R1n (exact repro): a tracked NFC directory renamed to its NFD spelling and made a repository exports nothing below it", async () => {
		const { f, identity, p } = await workspace({ [NFC + "/answer.txt"]: "orig\n" });
		await rename(p(NFC), p(NFD));
		await gitOk(["init", "-q", p(NFD)], f.dir);
		await writeFile(p(NFD, "answer.txt"), "LEAK_NFD_NESTED");
		const result = await collectResult(identity, []);
		expect(JSON.stringify(result)).not.toContain("LEAK_NFD_NESTED");
		expect(result.patch).not.toContain("LEAK_NFD_NESTED");
		expect(files(result)).toEqual([]);
		expect(result.exportComplete).toBe(false);
		expect(keyed(result.exclusions!)).toEqual([{ path: pathKey(NFC), reason: "nested_repository", outerTrackedEntries: 1 }]);
		// On a normalization-insensitive volume Git and the walk name the same directory: Git's spelling is reported.
		if (volume.normalizationInsensitive) expect(result.exclusions![0]!.path).toBe(NFC);
		valid(identity, result);
	});
	for (const precompose of ["true", "false"])
		test(`R1n with core.precomposeunicode=${precompose}, and mixed normalization inside nested paths`, async () => {
			// Round 9: collection configuration is the source repository's at preparation, never the workspace's.
			const { f, identity, p } = await workspace({
				[NFC + "/answer.txt"]: "orig\n",
				["na\u00efve/" + NFC + "/deep/answer.txt"]: "orig\n",
				["na\u00efve/plain.txt"]: "plain\n",
			}, { beforePrepare: async (repo, dir) => { await gitOk(["-C", repo, "config", "core.precomposeunicode", precompose], dir); } });
			await rename(p(NFC), p(NFD));
			await gitOk(["init", "-q", p(NFD)], f.dir);
			await writeFile(p(NFD, "answer.txt"), "LEAK_TOP_" + precompose);
			// Mixed: an NFC parent spelled NFD on disk, holding an NFD child repository.
			await rename(p("na\u00efve"), p("nai\u0308ve"));
			await rename(p("nai\u0308ve", NFC), p("nai\u0308ve", NFD));
			await gitOk(["init", "-q", p("nai\u0308ve", NFD)], f.dir);
			await writeFile(p("nai\u0308ve", NFD, "deep", "answer.txt"), "LEAK_DEEP_" + precompose);
			await writeFile(p("nai\u0308ve", "plain.txt"), "DELIVERABLE_" + precompose);
			const result = await collectResult(identity, []);
			expect(JSON.stringify(result)).not.toContain("LEAK_");
			expect(result.exportComplete).toBe(false);
			const boundaries = [
				{ path: pathKey(NFC), reason: "nested_repository", outerTrackedEntries: 1 },
				{ path: pathKey("na\u00efve/" + NFC), reason: "nested_repository", outerTrackedEntries: 1 },
			];
			if (volume.normalizationInsensitive && precompose === "true") {
				// Git precomposes what it reads from disk: the tracked sibling is still a deliverable under Git's spelling.
				expect(keyed(result.exclusions!)).toEqual(boundaries);
				expect(files(result)).toEqual(["na\u00efve/plain.txt"]);
				expect(Buffer.from(result.files[0]!.contentBase64, "base64").toString()).toBe("DELIVERABLE_" + precompose);
			} else if (volume.normalizationInsensitive) {
				// Without precomposition Git also lists the decomposed spelling as untracked: two Git
				// names for one disk entry cannot be matched unambiguously, so both are withheld and counted.
				expect(keyed(result.exclusions!)).toEqual([
					boundaries[0],
					{ path: pathKey("na\u00efve"), reason: "unlisted", count: 2, outerTrackedEntries: 1 },
					boundaries[1],
				]);
				expect(files(result)).toEqual([]);
			}
			valid(identity, result);
		});
	test("reviewer R1k/R1k2: case-only renames of a tracked directory made a repository export nothing below it", async () => {
		for (const spelling of ["src", "SRC"]) {
			const { f, identity, p } = await workspace({ "Src/answer.txt": "orig\n" });
			await rename(p("Src"), p(spelling));
			await gitOk(["init", "-q", p(spelling)], f.dir);
			await writeFile(p(spelling, "answer.txt"), "LEAK_CASE_" + spelling);
			const result = await collectResult(identity, []);
			expect([spelling, JSON.stringify(result).includes("LEAK_CASE_")]).toEqual([spelling, false]);
			expect(result.exportComplete).toBe(false);
			if (volume.caseInsensitive) {
				expect(files(result)).toEqual([]);
				expect(result.exclusions).toEqual([{ path: "Src", reason: "nested_repository", outerTrackedEntries: 1 }]);
			}
			valid(identity, result);
		}
	});
	// Round 9: the index is node-owned, so a worker-recorded alias entry is not tracked at all.
	test("a boundary matched by several Git spellings withholds every one of them; a worker index alias is not a tracked entry", async () => {
		const { f, identity, p } = await workspace({ "Src/answer.txt": "orig\n" });
		// The worker records a second, differently cased index entry for the same directory.
		await writeFile(p("Src", "other.txt"), "LEAK_INDEX_ALIAS");
		const blob = (await gitOk(["hash-object", "-w", p("Src", "other.txt")], identity.path)).trim();
		await gitOk(["update-index", "--add", "--cacheinfo", "100644," + blob + ",src/other.txt"], identity.path);
		await writeFile(p("Src", "answer.txt"), "LEAK_TRACKED_ALIAS");
		await gitOk(["init", "-q", p("Src")], f.dir);
		const result = await collectResult(identity, []);
		expect(JSON.stringify(result)).not.toContain("LEAK_");
		expect(files(result)).toEqual([]);
		expect(result.exportComplete).toBe(false);
		expect(keyed(result.exclusions!)).toEqual([{ path: "src", reason: "nested_repository", outerTrackedEntries: 1 }]);
		valid(identity, result);
	});
	test("reviewer A7/A7e/A7k: a .gitignore inside an out-of-tree-ignored directory spelled differently on disk keeps the export incomplete", async () => {
		const cases: [string, string, string, string][] = [
			["A7 info/exclude NFD", NFD, "caf*/\n", "info"],
			["A7e XDG NFD", NFD, "caf*/\n", "xdg"],
			["A7k info/exclude case variant", "lib", "lib/\n", "info"],
		];
		for (const [label, directory, rules, where] of cases) {
			const { f, identity, p } = await workspace(where === "info" && directory === "lib" ? { "Lib/keep.txt": "k" } : {});
			if (directory === "lib") await rename(p("Lib"), p("lib"));
			await mkdir(p(directory), { recursive: true });
			await writeFile(p(directory, ".gitignore"), "*\n");
			await writeFile(p(directory, "answer.ts"), "DELIVERABLE_" + label);
			await writeFile(p("ok.txt"), "ok");
			if (where === "info") await infoExclude(f.repo, rules);
			const result = where === "xdg" ? await withXdg(f.dir, rules, () => collectResult(identity, [])) : await collectResult(identity, []);
			expect([label, result.exportComplete, JSON.stringify(result).includes("DELIVERABLE_")]).toEqual([label, false, false]);
			expect([label, files(result)]).toEqual([label, ["ok.txt"]]);
			valid(identity, result);
		}
	});
	test("reviewer A7c: an untracked NFD-named nested repository is a boundary, not a concurrent change", async () => {
		const { f, identity, p } = await workspace();
		await mkdir(p(NFD));
		await gitOk(["init", "-q", p(NFD)], f.dir);
		await writeFile(p(NFD, "answer.ts"), "NESTED_A7C");
		await writeFile(p("ok.txt"), "ok");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["ok.txt"]);
		expect(keyed(result.exclusions!)).toEqual([{ path: pathKey(NFC), reason: "nested_repository", outerTrackedEntries: 0 }]);
		expect(JSON.stringify(result)).not.toContain("NESTED_A7C");
		valid(identity, result);
	});
	test("validateResult compares files, boundaries and ignored paths under the canonical key", async () => {
		const { identity, p } = await workspace();
		await writeFile(p("ok.txt"), "ok");
		const result = await collectResult(identity, []);
		const file = (path: string) => ({ path, bytes: 1, sha256: sha256("x"), contentBase64: Buffer.from("x").toString("base64"), deleted: false, mode: 0o644, type: "regular" });
		const boundary = (path: string) => ({ path, reason: "nested_repository", outerTrackedEntries: 0 });
		const withFile = (path: string, extra: any) => ({ ...result, files: [file(path)], ...extra });
		valid(identity, withFile(NFC + "/answer.txt", { exclusions: [boundary("other")], exportComplete: false }));
		rejected(identity, withFile(NFC + "/answer.txt", { exclusions: [boundary(NFD)], exportComplete: false }));
		rejected(identity, withFile(NFD + "/answer.txt", { exclusions: [boundary(NFC)], exportComplete: false }));
		rejected(identity, withFile("src/answer.txt", { exclusions: [boundary("SRC")], exportComplete: false }));
		rejected(identity, withFile(NFC + "/answer.txt", { ignored: { count: 1, unlisted: 0, paths: [NFD + "/"] } }));
		rejected(identity, withFile("Thumbs.db", { junk: { count: 1, unlisted: 0, paths: ["thumbs.db"] } }));
		rejected(identity, { ...result, exclusions: [boundary(NFC), boundary(NFD)].sort((a, b) => (a.path < b.path ? -1 : 1)), exportComplete: false });
		rejected(identity, { ...result, files: [file(NFC), file(NFD)] });
	});
});

describe("round-6 MEDIUM-B: names that are not portable never abort collection", () => {
	// Names Windows cannot create (review fx-9abb2530 F9).
	test.skipIf(process.platform === "win32")("reviewer A8: a nested repository with a name that is not portable is withheld and reported at its nearest portable ancestor", async () => {
		const { f, identity, p } = await workspace();
		await writeFile(p(".gitignore"), "node_modules/\n");
		await writeFile(p("ok.txt"), "ok");
		for (const name of ["pkg.", "aux", "x "]) {
			await mkdir(p("node_modules", name), { recursive: true });
			await gitOk(["init", "-q", p("node_modules", name)], f.dir);
			await writeFile(p("node_modules", name, "index.js"), "VENDORED_" + name);
		}
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "ok.txt"]);
		expect(result.exclusions).toEqual([{ path: "node_modules", reason: "unlisted", count: 3, outerTrackedEntries: 0 }]);
		expect(result.exportComplete).toBe(false);
		expect(JSON.stringify(result)).not.toContain("VENDORED_");
		valid(identity, result);
	});
	test.skipIf(process.platform === "win32")("a root-level nested repository with a name that is not portable is withheld without hiding listed exclusions", async () => {
		const { f, identity, p } = await workspace();
		await mkdir(p("con"));
		await gitOk(["init", "-q", p("con")], f.dir);
		await writeFile(p("con", "x.txt"), "NESTED_CON");
		await mkdir(p("deliverable"));
		await gitOk(["init", "-q", p("deliverable")], f.dir);
		await writeFile(p("ok.txt"), "ok");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["ok.txt"]);
		expect(result.exclusions).toEqual([
			{ path: ".", reason: "unlisted", count: 1, outerTrackedEntries: 0 },
			{ path: "deliverable", reason: "nested_repository", outerTrackedEntries: 0 },
		]);
		expect(JSON.stringify(result)).not.toContain("NESTED_CON");
		valid(identity, result);
	});
	test.skipIf(!nonUtf8Supported())("a directory name that is not valid UTF-8 is walked by its exact bytes (Linux)", async () => {
		const { identity, p } = await workspace();
		await writeFile(p(".gitignore"), "node_modules/\n");
		await writeFile(p("ok.txt"), "ok");
		const raw = Buffer.concat([Buffer.from(p("node_modules") + "/"), Buffer.from([0x66, 0xff])]);
		mkdirSync(Buffer.from(p("node_modules")), { recursive: true });
		mkdirSync(raw);
		mkdirSync(Buffer.concat([raw, Buffer.from("/inner")]));
		// Plant `.git` by raw bytes. Do not `git init` via a latin1 argv spelling: that can create a
		// second, UTF-8-encoded directory (U+00FF → c3 bf) beside the invalid-UTF-8 one (66 ff).
		mkdirSync(Buffer.concat([raw, Buffer.from("/inner/.git")]));
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "ok.txt"]);
		expect(result.exclusions).toEqual([{ path: "node_modules", reason: "unlisted", count: 1, outerTrackedEntries: 0 }]);
		valid(identity, result);
	});
});

describe("round-6 LOW-B: names that are not portable never erase other withheld names", () => {
	// `nul` and `x.` cannot be created on Windows (review fx-093cc54b F5).
	test.skipIf(process.platform === "win32")("reviewer A1/A2: portable siblings stay listed; the odd name is counted at its nearest portable ancestor", async () => {
		const { identity, p } = await workspace({}, { beforePrepare: (repo) => infoExclude(repo, "nul\nsrc/answer.ts\nsecret.cfg\nsrc/x.\n") });
		await mkdir(p("src"));
		await writeFile(p("nul"), "NUL_BYTES");
		await writeFile(p("secret.cfg"), "SECRET_CFG");
		await writeFile(p("src", "answer.ts"), "ANSWER");
		await writeFile(p("src", "x."), "TRAILING");
		await writeFile(p("src", "visible.ts"), "visible");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["src/visible.ts"]);
		expect(result.exclusions).toEqual([
			{ path: ".", reason: "unlisted", count: 1, outerTrackedEntries: 0 },
			{ path: "secret.cfg", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
			{ path: "src", reason: "unlisted", count: 1, outerTrackedEntries: 0 },
			{ path: "src/answer.ts", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
		]);
		expect(result.exportComplete).toBe(false);
		for (const secret of ["NUL_BYTES", "SECRET_CFG", "ANSWER", "TRAILING"]) expect(JSON.stringify(result)).not.toContain(secret);
		valid(identity, result);
		const entry = (path: string, reason: string, extra: any = {}) => ({ path, reason, outerTrackedEntries: 0, ...extra });
		for (const exclusions of [
			[entry(".", "unlisted", { count: 0 })],
			[entry(".", "unlisted")],
			[entry(".", "unlisted", { count: 1, source: "info_exclude" })],
			[entry("a.", "unlisted", { count: 1 })],
			[entry("d", "nested_repository"), entry("d/e", "unlisted", { count: 1 })],
			[entry("d", "ignored_out_of_tree", { source: "info_exclude" }), entry("d/e", "unlisted", { count: 1 })],
			[entry(".", "ignored_out_of_tree", { source: "info_exclude" }), entry("e", "unlisted", { count: 1 })],
		])
			rejected(identity, { ...result, exclusions });
		// An unlisted count never withholds the portable contents of its directory.
		valid(identity, { ...result, exclusions: [entry(".", "unlisted", { count: 2 })] });
	});
});

describe("round-6 LOW-C/LOW-D: worker-writable ignore sources", () => {
	test("reviewer J6: OS junk is junk only when the node's own excludes file ignores it", async () => {
		const { f, identity, p } = await workspace({}, { beforePrepare: (repo) => infoExclude(repo, "desktop.ini\n") });
		await writeFile(p("desktop.ini"), "DELIVERABLE_INI");
		await writeFile(p("a.txt"), "a");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["a.txt"]);
		expect(result.junk).toEqual({ count: 0, unlisted: 0, paths: [] });
		expect(result.exclusions).toEqual([{ path: "desktop.ini", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" }]);
		expect(result.exportComplete).toBe(false);
		valid(identity, result);
		const global = await withXdg(f.dir, "desktop.ini\n", () => collectResult(identity, []));
		expect(global.junk).toEqual({ count: 1, unlisted: 0, paths: ["desktop.ini"] });
		expect(global.exportComplete).toBe(true);
	});
	test("reviewer W11/W12: the operator's info/exclude and repository core.excludesFile are snapshotted at preparation", async () => {
		const { f, identity, p } = await workspace({}, {
			beforePrepare: async (repo, dir) => {
				await infoExclude(repo, "local-settings.json\n");
				await writeFile(join(dir, "repo-excludes"), "dev.db.dump\n");
				await gitOk(["-C", repo, "config", "core.excludesFile", join(dir, "repo-excludes")], dir);
			},
		});
		await writeFile(p("local-settings.json"), "W11_SECRET");
		await writeFile(p("dev.db.dump"), "W12_SECRET");
		await writeFile(p("deliverable.txt"), "ok");
		const before = await collectResult(identity, []);
		expect(files(before)).toEqual(["deliverable.txt"]);
		// The worker empties the shared info/exclude and unsets the repository excludes file.
		await infoExclude(f.repo, "");
		await gitOk(["config", "--unset", "core.excludesFile"], identity.path);
		const after = await collectResult(identity, []);
		expect(files(after)).toEqual(["deliverable.txt"]);
		expect(after.exclusions).toEqual([
			{ path: "dev.db.dump", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "excludes_file" },
			{ path: "local-settings.json", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
		]);
		expect(JSON.stringify(after)).not.toContain("_SECRET");
		valid(identity, after);
		// The snapshot is bound to the workspace identity: altered rules fail closed.
		const snapshot = join(f.workspaceRoot, ".collection-snapshots", "task-attempt.json");
		const recorded = JSON.parse(await readFile(snapshot, "utf8"));
		expect(recorded.rules).toMatchObject({ info_exclude: "local-settings.json\n", excludes_file: "dev.db.dump\n" });
		await writeFile(snapshot, JSON.stringify({ ...recorded, rules: { ...recorded.rules, info_exclude: "" } }));
		await expect(collectResult(identity, [])).rejects.toThrow("collection_snapshot_mismatch");
	});
});

describe("round-6 LOW-E: preparation streams the base tree listing", () => {
	test("a base tree whose listing exceeds 4 MiB prepares", async () => {
		const f = await repositoryFixture("fleet-collection-identity-");
		directories.push(f.dir);
		// fast-import: 20,000 entries with 220-byte paths (about 5.4 MiB of ls-tree output), one shared blob.
		const lines = ["blob", "mark :1", "data 2", "x", "commit refs/heads/large", "committer R <r@example.invalid> 0 +0000", "data 5", "large", "from " + f.baseCommit];
		for (let i = 0; i < 20000; i++) lines.push(`M 100644 :1 d${String(i % 100).padStart(2, "0")}/${"p".repeat(200)}-${String(i).padStart(5, "0")}.ts`);
		await writeFile(join(f.dir, "stream"), lines.join("\n") + "\n");
		const imported = Bun.spawnSync(["git", "-C", f.repo, "fast-import", "--quiet"], { stdin: Bun.file(join(f.dir, "stream")) });
		expect(imported.exitCode).toBe(0);
		const baseCommit = (await gitOk(["-C", f.repo, "rev-parse", "refs/heads/large"], f.dir)).trim();
		const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit, workspaceRoot: f.workspaceRoot });
		expect(identity.baseCommit).toBe(baseCommit);
	}, 120000);
});

/** The node's real HOME points at `home` (XDG_CONFIG_HOME unset), as for an operator's dotfiles. */
async function withNodeHome<T>(home: string, body: () => Promise<T>): Promise<T> {
	const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
	process.env.HOME = home;
	delete process.env.XDG_CONFIG_HOME;
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
const nodeHome = async (dir: string, files: Record<string, string>) => {
	const home = join(dir, "node-home");
	await mkdir(home, { recursive: true });
	for (const [name, content] of Object.entries(files)) await writeFile(join(home, name), content);
	return home;
};
const expectWithheld = (identity: any, result: any, path: string, source: string, secret: string) => {
	expect(files(result)).toEqual(["d.txt"]);
	expect(result.exclusions).toEqual([{ path, reason: "ignored_out_of_tree", outerTrackedEntries: 0, source }]);
	expect(result.exportComplete).toBe(false);
	expect(JSON.stringify(result)).not.toContain(secret);
	valid(identity, result);
};
// Round-7 review regressions (88a54e74): operator ignore rules that Git reaches
// through include.path/includeIf, rule files that are symlinks, and U+1E9E.
describe("round-7: operator ignore rules reached through includes, symlinked rule files, full case folding", () => {
	for (const layout of ["include", "includeIf-gitdir", "direct"] as const)
		test(`reviewer ${layout === "include" ? "X2" : layout === "direct" ? "X3" : "X2b"} (MEDIUM-1): a node excludes file set in ~/.gitconfig (${layout}) survives the worker's repository core.excludesFile override`, async () => {
			// Round 9: the node's configuration is in force from preparation on; `includeIf` conditions
			// are evaluated on the source repository at preparation (never on the workspace).
			const f = await repositoryFixture("fleet-collection-identity-");
			directories.push(f.dir);
			const rules = join(f.dir, "global-op.ignore");
			await writeFile(rules, "dev.db.dump\n");
			const ops = `[core]\n\texcludesFile = ${configPath(rules)}\n`;
			const gitconfig =
				layout === "direct" ? ops : layout === "include" ? "[include]\n\tpath = ~/.gitconfig.ops\n" : `[includeIf "gitdir:${configPath(f.repo)}/"]\n\tpath = ~/.gitconfig.ops\n`;
			const home = await nodeHome(f.dir, { ".gitconfig": gitconfig, ".gitconfig.ops": ops });
			await withNodeHome(home, async () => {
				const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
				const p = (...parts: string[]) => join(identity.path, ...parts);
				await writeFile(p("dev.db.dump"), "OPERATOR_SECRET_" + layout);
				await writeFile(p("d.txt"), "d");
				await gitOk(["config", "core.excludesFile", "/dev/null"], identity.path);
				expectWithheld(identity, await collectResult(identity, []), "dev.db.dump", "excludes_file", "OPERATOR_SECRET_");
			});
		});
	// Round 9: a repository condition is evaluated on the source repository at preparation;
	// the workspace's branch (worker-controlled) never selects or deselects a node rule.
	for (const preparedUnderHome of [false, true]) {
		test(`includeIf onbranch in ~/.gitconfig is evaluated on the source repository at preparation, never on the workspace's branch [prepared with operator config: ${preparedUnderHome}]`, async () => {
			const f = await repositoryFixture("fleet-collection-identity-");
			directories.push(f.dir);
			const rules = join(f.dir, "global-op.ignore");
			await writeFile(rules, "dev.db.dump\n");
			const sourceBranch = (await gitOk(["-C", f.repo, "symbolic-ref", "--short", "HEAD"], f.dir)).trim();
			const home = await nodeHome(f.dir, {
				".gitconfig": `[includeIf "onbranch:${sourceBranch}"]\n\tpath = ~/.gitconfig.source\n[includeIf "onbranch:ops/**"]\n\tpath = ~/.gitconfig.ops\n`,
				".gitconfig.source": `[core]\n\texcludesFile = ${configPath(rules)}\n`,
				".gitconfig.ops": `[core]\n\texcludesFile = ${configPath(rules)}\n`,
			});
			const prepare = () => prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
			const identity = preparedUnderHome ? await withNodeHome(home, prepare) : await prepare();
			const p = (...parts: string[]) => join(identity.path, ...parts);
			await withNodeHome(home, async () => {
				await writeFile(p("dev.db.dump"), "BRANCH_SCOPED");
				await writeFile(p("d.txt"), "d");
				const check = async (result: any) => {
					if (preparedUnderHome) expectWithheld(identity, result, "dev.db.dump", "excludes_file", "BRANCH_SCOPED");
					else {
						expect(files(result)).toEqual(["d.txt", "dev.db.dump"]);
						expect(result.exportComplete).toBe(true);
					}
				};
				await check(await collectResult(identity, []));
				// The worker switches to a branch the operator's include names, and overrides the repository excludes file.
				await gitOk(["switch", "-q", "-c", "ops/task"], identity.path);
				expect((await run(["git", "check-ignore", "-q", "dev.db.dump"], identity.path, undefined, { HOME: home })).exit).toBe(0);
				await gitOk(["config", "core.excludesFile", "/dev/null"], identity.path);
				await check(await collectResult(identity, []));
			});
		});
	}
	for (const layout of ["include", "includeIf-gitdir"] as const)
		test(`reviewer ${layout === "include" ? "X1" : "X1b"} (LOW-1): a repository core.excludesFile set through ${layout} at preparation survives the worker removing the include`, async () => {
			const section = (repo: string) => (layout === "include" ? "include" : `includeIf.gitdir:${configPath(repo)}/`);
			const { f, identity, p } = await workspace({}, {
				beforePrepare: async (repo, dir) => {
					await writeFile(join(dir, "op.ignore"), "dev.db.dump\n");
					await writeFile(join(dir, "ops.gitconfig"), `[core]\n\texcludesFile = ${configPath(join(dir, "op.ignore"))}\n`);
					await gitOk(["-C", repo, "config", section(repo) + ".path", join(dir, "ops.gitconfig")], dir);
				},
			});
			await withNodeHome(await nodeHome(f.dir, {}), async () => {
				await writeFile(p("dev.db.dump"), "OPERATOR_SECRET_" + layout);
				await writeFile(p("d.txt"), "d");
				await gitOk(["config", "--remove-section", section(f.repo)], identity.path);
				expectWithheld(identity, await collectResult(identity, []), "dev.db.dump", "excludes_file", "OPERATOR_SECRET_");
			});
		});
	test("reviewer X8/X9 (LOW-2): a symlinked info/exclude or repository excludes file prepares, and its rules are kept", async () => {
		for (const source of ["info_exclude", "excludes_file"] as const) {
			const { f, identity, p } = await workspace({}, {
				beforePrepare: async (repo, dir) => {
					await writeFile(join(dir, "real.rules"), "s.cfg\n");
					const link = source === "info_exclude" ? join(repo, ".git", "info", "exclude") : join(dir, "link.rules");
					await mkdir(join(repo, ".git", "info"), { recursive: true });
					await rm(link, { force: true });
					await symlink(join(dir, "real.rules"), link);
					if (source === "excludes_file") await gitOk(["-C", repo, "config", "core.excludesFile", link], dir);
				},
			});
			await withNodeHome(await nodeHome(f.dir, {}), async () => {
				await writeFile(p("s.cfg"), "OPERATOR_SECRET_" + source);
				await writeFile(p("d.txt"), "d");
				expectWithheld(identity, await collectResult(identity, []), "s.cfg", source, "OPERATOR_SECRET_");
			});
		}
	});
	test("reviewer I1 (LOW-3): U+1E9E keys like \u00df and ss, so a boundary spelled \u00df on disk counts the tracked \u1e9e entry", async () => {
		expect(pathKey("\u1e9e")).toBe(pathKey("\u00df"));
		expect(pathKey("\u1e9e/A")).toBe(pathKey("SS/a"));
		const { f, identity, p } = await workspace({ "\u1e9e/answer.txt": "orig\n" });
		await rename(p("\u1e9e"), p("\u00df"));
		await gitOk(["init", "-q", p("\u00df")], f.dir);
		await writeFile(p("\u00df", "answer.txt"), "LEAK_SHARP_S");
		const result = await collectResult(identity, []);
		expect(JSON.stringify(result)).not.toContain("LEAK_SHARP_S");
		expect(result.exportComplete).toBe(false);
		if (volume.caseInsensitive) {
			expect(files(result)).toEqual([]);
			expect(keyed(result.exclusions!)).toEqual([{ path: pathKey("\u1e9e"), reason: "nested_repository", outerTrackedEntries: 1 }]);
		}
		valid(identity, result);
	});
});

// Round-8 review regressions (92d27e99): a worker can neither repoint the workspace's
// Git directory (MEDIUM-1: `includeIf "gitdir:…"` node rules, index, repository config)
// nor switch off a node rule whose include condition depends on repository state it
// can rewrite (LOW-1: `includeIf "hasconfig:remote.*.url:…"`).
describe("round-8: the workspace stays bound to its prepared Git directory; conditional node rules are snapshotted", () => {
	/** Copy the workspace's administrative directory to `target` and point the workspace's .git file at it. */
	async function repointGitDir(identity: any, target: string) {
		const admin = (await gitOk(["rev-parse", "--path-format=absolute", "--git-dir"], identity.path)).trim();
		const common = (await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], identity.path)).trim();
		await mkdir(join(target, ".."), { recursive: true });
		await cp(admin, target, { recursive: true });
		await writeFile(join(target, "commondir"), common + "\n");
		await writeFile(join(identity.path, ".git"), "gitdir: " + target + "\n");
		// Git itself now uses the copied directory.
		expect(await realpath((await gitOk(["rev-parse", "--path-format=absolute", "--git-dir"], identity.path)).trim())).toBe(await realpath(target));
	}
	const operatorRule = async (dir: string, layout: "includeIf-gitdir" | "direct", repo: string) => {
		const rules = join(dir, "global-op.ignore");
		await writeFile(rules, "dev.db.dump\n");
		const ops = `[core]\n\texcludesFile = ${configPath(rules)}\n`;
		return nodeHome(dir, { ".gitconfig": layout === "direct" ? ops : `[includeIf "gitdir:${configPath(repo)}/"]\n\tpath = ~/.gitconfig.ops\n`, ".gitconfig.ops": ops });
	};
	// Round 9: collection never reads the workspace's .git, administrative directory or
	// common directory, so repointing any of them changes nothing the node collects.
	for (const layout of ["includeIf-gitdir", "direct"] as const)
		test(`reviewer ${layout === "direct" ? "Y1c" : "Y1"} (MEDIUM-1): a workspace whose .git file was repointed outside the repository collects exactly as before (${layout} node rule)`, async () => {
			const f = await repositoryFixture("fleet-collection-identity-");
			directories.push(f.dir);
			const home = await operatorRule(f.dir, layout, f.repo);
			await withNodeHome(home, async () => {
				const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
				const p = (...parts: string[]) => join(identity.path, ...parts);
				await writeFile(p("dev.db.dump"), "OPERATOR_SECRET_Y1");
				await writeFile(p("d.txt"), "d");
				const before = await collectResult(identity, []);
				expectWithheld(identity, before, "dev.db.dump", "excludes_file", "OPERATOR_SECRET_Y1");
				const evil = join(mkdtempSync(join(tmpdir(), "fleet-evil-admin-")), "evil-admin");
				directories.push(join(evil, ".."));
				await repointGitDir(identity, evil);
				await gitOk(["config", "core.excludesFile", "/dev/null"], identity.path);
				if (layout === "includeIf-gitdir")
					expect((await run(["git", "check-ignore", "-q", "dev.db.dump"], identity.path, undefined, { HOME: home })).exit).toBe(1);
				expect(await collectResult(identity, [])).toEqual(before);
			});
		});
	test("a workspace repointed to another administrative directory inside the repository's worktrees collects exactly as before", async () => {
		const { identity, p } = await workspace();
		await writeFile(p("d.txt"), "d");
		const before = await collectResult(identity, []);
		const common = (await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], identity.path)).trim();
		await repointGitDir(identity, join(common, "worktrees", "evil"));
		expect(await collectResult(identity, [])).toEqual(before);
	});
	test("a workspace whose administrative directory points at another common directory collects exactly as before", async () => {
		const { f, identity, p } = await workspace();
		await writeFile(p("d.txt"), "d");
		await writeFile(p("hidden.cfg"), "OTHER_REPO_RULES");
		const before = await collectResult(identity, []);
		const other = join(f.dir, "other");
		await gitOk(["init", "-q", other], f.dir);
		await writeFile(join(other, ".git", "info", "exclude"), "d.txt\n");
		const admin = (await gitOk(["rev-parse", "--path-format=absolute", "--git-dir"], identity.path)).trim();
		await writeFile(join(admin, "commondir"), join(other, ".git") + "\n");
		expect(await collectResult(identity, [])).toEqual(before);
	});
	test("an identity prepared before the collection snapshot existed collects under the source's live rules, as the previous release did", async () => {
		// Review fx-9abb2530 F5: such a workspace is collectable again; its completeness is unknown
		// (legacy-v1, the hub requires operator acceptance), see result-upgrade.test.ts.
		const { identity, p } = await workspace({}, { beforePrepare: (repo) => infoExclude(repo, "local.cfg\n") });
		const { collectionSnapshot, ...legacy } = identity;
		expect(collectionSnapshot).toMatch(/^[a-f0-9]{64}$/);
		await rm(p(".fleet-identity.json"));
		await writeFile(p(".fleet-identity.json"), JSON.stringify(legacy), { mode: 0o600 });
		await writeFile(p("d.txt"), "d");
		await writeFile(p("local.cfg"), "LEGACY_SECRET");
		const result = await collectResult(legacy as any, []);
		expect(files(result)).toEqual(["d.txt"]);
		expect(JSON.stringify(result)).not.toContain("LEGACY_SECRET");
	});
	/** A node HOME whose ~/.gitconfig is in force from preparation on. */
	const operatorHome = async (gitconfig: (rules: string) => Record<string, string>) => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-node-home-"));
		directories.push(dir);
		const rules = join(dir, "global-op.ignore");
		await writeFile(rules, "dev.db.dump\n");
		return nodeHome(dir, gitconfig(rules));
	};
	const hasconfigWorkspace = async () => {
		const home = await operatorHome((rules) => ({
			".gitconfig": `[includeIf "hasconfig:remote.*.url:https://ops.example/**"]\n\tpath = ~/.gitconfig.ops\n`,
			".gitconfig.ops": `[core]\n\texcludesFile = ${configPath(rules)}\n`,
		}));
		const prepared = await withNodeHome(home, () =>
			workspace({}, { beforePrepare: async (repo, dir) => void (await gitOk(["-C", repo, "remote", "add", "origin", "https://ops.example/team/app.git"], dir)) }),
		);
		return { ...prepared, home };
	};
	for (const action of ["none", "remove-remote", "local-devnull"] as const)
		test(`reviewer ${action === "none" ? "Y2c" : action === "remove-remote" ? "Y2" : "Y2b"} (LOW-1): a hasconfig:remote.*.url node rule in force at preparation survives ${action === "none" ? "(control)" : action === "remove-remote" ? "the worker removing the remote" : "a repository core.excludesFile override"}`, async () => {
			const { identity, p, home } = await hasconfigWorkspace();
			await withNodeHome(home, async () => {
				expect((await run(["git", "check-ignore", "-q", "dev.db.dump"], identity.path, undefined, { HOME: home })).exit).toBe(0);
				await writeFile(p("dev.db.dump"), "OPERATOR_SECRET_Y2");
				await writeFile(p("d.txt"), "d");
				if (action === "remove-remote") await gitOk(["remote", "remove", "origin"], identity.path);
				if (action === "local-devnull") await gitOk(["config", "core.excludesFile", "/dev/null"], identity.path);
				if (action !== "none")
					expect((await run(["git", "check-ignore", "-q", "dev.db.dump"], identity.path, undefined, { HOME: home })).exit).toBe(1);
				expectWithheld(identity, await collectResult(identity, []), "dev.db.dump", "excludes_file", "OPERATOR_SECRET_Y2");
			});
		});
	test("a node excludes file equal to the effective one is not snapshotted again (no extra Git view)", async () => {
		const home = await operatorHome((rules) => ({ ".gitconfig": `[core]\n\texcludesFile = ${configPath(rules)}\n` }));
		const { f, identity } = await withNodeHome(home, () => workspace());
		const bytes = await readFile(join(f.workspaceRoot, ".collection-snapshots", "task-attempt.json"));
		expect(identity.collectionSnapshot).toBe(sha256(bytes));
		expect(JSON.parse(bytes.toString()).rules).toEqual({ excludes_file: "", info_exclude: "", node_excludes_file: "dev.db.dump\n" });
	});
	test("the snapshot is read by checkPreparation: an unreadable operator rule file refuses before any effect (preflight sees it too)", async () => {
		const f = await repositoryFixture("fleet-collection-identity-");
		directories.push(f.dir);
		const rulesDirectory = join(f.dir, "rules-dir");
		await mkdir(rulesDirectory);
		await gitOk(["-C", f.repo, "config", "core.excludesFile", rulesDirectory], f.dir);
		const input = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot };
		// A node HOME without global rules: the machine's own ~/.config/git/ignore is not the subject.
		await withNodeHome(await nodeHome(f.dir, {}), async () => {
			await expect(checkPreparation(input)).rejects.toThrow("ignore_rules_unresolved");
			await expect(prepareWorkspace(input)).rejects.toThrow("ignore_rules_unresolved");
			expect(lstatSync(f.workspaceRoot, { throwIfNoEntry: false })).toBeUndefined();
			await gitOk(["-C", f.repo, "config", "--unset", "core.excludesFile"], f.dir);
			expect((await checkPreparation(input)).sourceFacts.rules).toEqual({ excludes_file: "", info_exclude: "", node_excludes_file: "" });
		});
	});
});
