import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScanLimits, collectResult, prepareWorkspace, requireCommandLine, scanWorkspace, sha256, WINDOWS_COMMAND_LINE_LIMIT, windowsCommandLineLength } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

// Review fx-bef2673f findings F3 (Windows command line, cleanup masking the cause), F4 (collection
// limits at limit-1/limit/limit+1) and F9 (no `^` revision on a collection command line).

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const posix = process.platform !== "win32";
const files = (result: any) => result.files.map((file: any) => file.path);
async function prepared() {
	const f = await repositoryFixture("fleet-collection-r2-");
	directories.push(f.dir);
	const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
	return { f, identity };
}
/** Runs `body` with `values` set in the process environment (restored afterwards). */
async function withEnv<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
	Object.assign(process.env, values);
	try {
		return await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
/** A Git shim first on PATH: `script` runs before the real Git (POSIX sh). */
async function gitShim(dir: string, script: string) {
	const bin = join(dir, "shim-bin");
	await mkdir(bin);
	const real = Bun.which("git")!;
	await writeFile(join(bin, "git"), `#!/bin/sh\n${script}\nexec '${real}' "$@"\n`);
	await chmod(join(bin, "git"), 0o700);
	return { PATH: bin + ":" + process.env.PATH };
}

describe("F3: a Git command line is bounded by the Windows limit before it is spawned", () => {
	/** An argv whose Windows command line is exactly `length` UTF-16 units long. */
	const argvOfLength = (length: number) => {
		const head = ["git", "status"];
		const base = windowsCommandLineLength([...head, ""]) - 2;
		return [...head, "x".repeat(length - base)];
	};
	test("limit-1 and limit pass, limit+1 is refused command_line_limit (win32), never on other platforms", () => {
		for (const length of [WINDOWS_COMMAND_LINE_LIMIT - 1, WINDOWS_COMMAND_LINE_LIMIT, WINDOWS_COMMAND_LINE_LIMIT + 1])
			expect(windowsCommandLineLength(argvOfLength(length))).toBe(length);
		expect(() => requireCommandLine(argvOfLength(WINDOWS_COMMAND_LINE_LIMIT - 1), "win32")).not.toThrow();
		expect(() => requireCommandLine(argvOfLength(WINDOWS_COMMAND_LINE_LIMIT), "win32")).not.toThrow();
		expect(() => requireCommandLine(argvOfLength(WINDOWS_COMMAND_LINE_LIMIT + 1), "win32")).toThrow(/^command_line_limit$/);
		expect(() => requireCommandLine(argvOfLength(WINDOWS_COMMAND_LINE_LIMIT + 1), "linux")).not.toThrow();
	});
	test("the length counts Windows quoting: spaces, quotes and backslash runs before a quote or the end", () => {
		// `git status` and the terminating NUL: 3 + 1 + 6 + 1
		expect(windowsCommandLineLength(["git", "status"])).toBe(11);
		expect(windowsCommandLineLength([""])).toBe(3); // ""
		expect(windowsCommandLineLength(["a b"])).toBe(6); // "a b"
		expect(windowsCommandLineLength(['a"b'])).toBe(7); // "a\"b"
		expect(windowsCommandLineLength(["a b\\"])).toBe(8); // "a b\\" (a backslash run before the closing quote doubles)
		expect(windowsCommandLineLength(['a\\\\"b'])).toBe(11); // "a\\\\\"b"
		expect(windowsCommandLineLength(["C:\\x y\\z"])).toBe(11); // "C:\x y\z" (backslashes not before a quote stay single)
	});
	test.if(process.platform === "win32")("Windows: a workspace whose repository-root pathspecs exceed the command line is refused command_line_limit, leaving no temp directory", async () => {
		const { f, identity } = await prepared();
		// Review fx-9abb2530 F4/F9: unignored roots (ignored ones collapse into one boundary), at most 1,024.
		for (let index = 0; index < 1024; index++) {
			const root = join(identity.path, "cache", "github.com", "some-organisation", "some-project-name-" + index + "@v1.2.3");
			await mkdir(root, { recursive: true });
			await writeFile(join(root, ".git"), "gitdir: C:/nowhere\n");
		}
		const temp = await realpath(await mkdtemp(join(f.dir, "temp-")));
		const error = await withEnv({ TEMP: temp, TMP: temp }, () => collectResult(identity, []).then(() => undefined, (error) => error));
		expect(error?.message).toBe("command_line_limit");
		expect(await readdir(temp)).toEqual([]);
	}, 300_000);
	test.if(posix)("a failed collection reports its own cause only after every Git child it started has exited, and removes its temp directory", async () => {
		const { f, identity } = await prepared();
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		const log = join(f.dir, "children.log");
		// `status` fails at once; each `diff` listing is still running for a second after that.
		const env = await gitShim(f.dir, `for a in "$@"; do\n  case "$a" in\n    status) exit 3;;\n    diff) sleep 1; printf 'diff-exited\\n' >> '${log}'; break;;\n  esac\ndone`);
		const temp = await realpath(await mkdtemp(join(f.dir, "temp-")));
		const error = await withEnv({ ...env, TMPDIR: temp }, () => collectResult(identity, []).then(() => undefined, (error) => error));
		expect(error?.message).toBe("git_failed:exit=3");
		// Both concurrent diff listings had exited when the failure was reported.
		expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["diff-exited", "diff-exited"]);
		expect(await readdir(temp)).toEqual([]);
	}, 60_000);
});

const addRepository = async (dir: string, index: number) => {
	const root = join(dir, "r" + String(index).padStart(4, "0"));
	await mkdir(root, { recursive: true });
	await writeFile(join(root, ".git"), "gitdir: /nonexistent\n");
};
describe("review fx-9abb2530 F4: repositories in an ignored directory are one boundary (Windows and POSIX)", () => {
	test("review fx-9abb2530 F4: 1,023 and 1,024 nested repositories in an ignored cache collect one exclusion each; 1,025 collect as one boundary, the cache", async () => {
		const { identity } = await prepared();
		await writeFile(join(identity.path, ".gitignore"), "cache/\n");
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		const cache = join(identity.path, "cache");
		for (let index = 0; index < 1023; index++) await addRepository(cache, index);
		// On Windows 1,023 exclude pathspecs already exceed the command line: they collapse there too.
		for (const count of [1023, 1024, 1025]) {
			if (count > 1023) await addRepository(cache, count - 1);
			const result = await collectResult(identity, []);
			const each = Array.from({ length: count }, (_, index) => ({ path: "cache/r" + String(index).padStart(4, "0"), reason: "nested_repository" as const, outerTrackedEntries: 0 }));
			expect([count, result.exclusions]).toEqual([count, count > 1024 || !posix ? [{ path: "cache", reason: "nested_repository" as const, outerTrackedEntries: 0 }] : each]);
			expect(files(result)).toEqual([".gitignore", "d.txt"]);
			expect(result.exportComplete).toBe(false);
		}
	}, 300_000);
});

describe.if(posix)("F4: documented collection limits, at limit-1, limit and limit+1", () => {
	test("1,024 exclusions: 1,023 and 1,024 unignored nested repositories collect; 1,025 refuse exclusion_count_limit", async () => {
		const { identity } = await prepared();
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		const vendor = join(identity.path, "vendor");
		for (let index = 0; index < 1023; index++) await addRepository(vendor, index);
		const below = await collectResult(identity, []);
		expect(below.exclusions!.length).toBe(1023);
		expect(files(below)).toEqual(["d.txt"]);
		await addRepository(vendor, 1023);
		const at = await collectResult(identity, []);
		expect(at.exclusions!.length).toBe(1024);
		expect(at.exclusions!.every((entry) => entry.reason === "nested_repository")).toBe(true);
		expect(at.exportComplete).toBe(false);
		await addRepository(vendor, 1024);
		await expect(collectResult(identity, [])).rejects.toThrow(/^exclusion_count_limit$/);
	}, 300_000);
	test("walk depth: a directory 127, 128 or 129 levels below the workspace root collects (no depth bound, review fx-397df5a5 F6)", async () => {
		const { identity } = await prepared();
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		// `deep` is level 1; each `d` adds one level. Not ignored: Git traverses it (review fx-093cc54b F4).
		const chain = (levels: number) => join(identity.path, "deep", ...Array(levels - 1).fill("d"));
		await mkdir(chain(127), { recursive: true });
		expect(files(await collectResult(identity, []))).toEqual(["d.txt"]);
		await mkdir(chain(128));
		expect(files(await collectResult(identity, []))).toEqual(["d.txt"]);
		await mkdir(chain(129));
		expect(files(await collectResult(identity, []))).toEqual(["d.txt"]);
	}, 120_000);
	test("walked entries: exactly maxEntries listed entries pass, one fewer allowed refuses workspace_scan_limit", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-collection-r2-scan-")));
		directories.push(root);
		await mkdir(join(root, "a"));
		await writeFile(join(root, "b.txt"), "b");
		for (const name of ["c.txt", "d.txt", "e.txt"]) await writeFile(join(root, "a", name), name);
		// Five listed entries: `a`, `b.txt` and the three files in `a`.
		await expect(scanWorkspace(root, { maxEntries: 6 })).resolves.toBeDefined();
		await expect(scanWorkspace(root, { maxEntries: 5 })).resolves.toBeDefined();
		await expect(scanWorkspace(root, { maxEntries: 4 })).rejects.toThrow(/^workspace_scan_limit$/);
	});
});

describe("review fx-093cc54b F4: the walk limits count only what Git traverses (ignored trees are walked, not counted)", () => {
	test("an ignored tree deeper than 128 levels collects; the export is complete", async () => {
		const { identity } = await prepared();
		await writeFile(join(identity.path, ".gitignore"), "deep/\n");
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		await mkdir(join(identity.path, "deep", ...Array(139).fill("d")), { recursive: true });
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "d.txt"]);
		expect({ exportComplete: result.exportComplete, ignored: result.ignored }).toEqual({ exportComplete: true, ignored: { count: 1, unlisted: 0, paths: ["deep/"] } });
	}, 120_000);
	test("entries below an ignored root are not counted; its name and everything else are", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-collection-f4-scan-")));
		directories.push(root);
		await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
		for (let index = 0; index < 10; index++) await writeFile(join(root, "node_modules", "pkg", `f${index}.js`), "x");
		await writeFile(join(root, "a.txt"), "a");
		const scan = await scanWorkspace(root, null);
		// Listed: `node_modules` and `a.txt` at the root; `pkg` and ten files below the ignored root.
		const limits = (maxEntries: number) => ({ maxEntries });
		expect(() => checkScanLimits(scan, ["node_modules/"], limits(2))).not.toThrow();
		expect(() => checkScanLimits(scan, ["node_modules/"], limits(1))).toThrow(/^workspace_scan_limit$/);
		expect(() => checkScanLimits(scan, [], limits(12))).toThrow(/^workspace_scan_limit$/);
		expect(() => checkScanLimits(scan, [], limits(13))).not.toThrow();
		// A file root (no trailing `/`) is not a directory Git skips.
		expect(() => checkScanLimits(scan, ["node_modules"], limits(2))).toThrow(/^workspace_scan_limit$/);
	});
});

describe.if(posix)("F9: collection passes no `^` revision on a Git command line", () => {
	test("a collection through a Git shim that cannot receive `^` (as a Windows .cmd shim) succeeds", async () => {
		const { f, identity } = await prepared();
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		const env = await gitShim(f.dir, `for a in "$@"; do\n  case "$a" in\n    *^*) echo "cmd.exe special character" >&2; exit 97;;\n  esac\ndone`);
		const result = await withEnv(env, () => collectResult(identity, []));
		expect(files(result)).toEqual(["d.txt"]);
		expect(result.exportComplete).toBe(true);
	}, 60_000);
});
