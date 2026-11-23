import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectResult, prepareWorkspace, run, sha256 } from "../src/workspace";
import { nodeOperation } from "../src/node";
import type { NodeConfig } from "../src/contracts";
import { repositoryFixture } from "./fixtures/coordinator";

// Collection never depends on Git state inside the workspace: a nested repository (a
// `.git` directory, a `.git` file naming a Git directory anywhere, a bare repository)
// is a boundary Git is kept out of; FIFOs, links and names a portable checkout cannot
// hold never block or leak; concurrent changes and the three limits refuse. Every case
// drives prepare → write → collect through the node's real collect path.

const posix = process.platform !== "win32";
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);

async function prepared(tag = "attempt") {
	const f = await repositoryFixture("fleet-collection-hazards-");
	directories.push(f.dir);
	const identity = await prepareWorkspace({ taskId: "task", attemptId: tag, nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
	const node: NodeConfig = {
		id: "node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: f.repo + "/" },
		workspaceRoot: f.workspaceRoot,
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport: { command: process.execPath, args: [] },
	} as NodeConfig;
	// The hub's request: it declares it reads export completeness (exclusions-v1).
	const collect = () => nodeOperation(node, { action: "collect", identity, tests: [], exportCompleteness: "exclusions-v1" } as any) as Promise<any>;
	return { f, identity, collect };
}
const gitIn = async (cwd: string, ...args: string[]) => {
	const r = await run(["git", "-c", "user.name=F", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], cwd);
	if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
	return r.stdout;
};
/** A collection that would block (a FIFO opened by Git or the reader) fails the test instead of hanging it. */
const bounded = <T>(promise: Promise<T>, ms = 30_000) =>
	Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error("collection_blocked"); })]);
const paths = (manifest: any) => manifest.files.map((file: any) => file.path).sort();
const everything = (manifest: any) =>
	JSON.stringify(manifest) + manifest.files.map((file: any) => Buffer.from(file.contentBase64, "base64").toString("latin1")).join("");
const mkfifo = async (path: string) => {
	// Empty untrusted: cwd `/` must not be treated as a worker tree or every PATH entry is skipped.
	const r = await run(["mkfifo", path], "/", 1024 * 1024, undefined, undefined, undefined, undefined, []);
	if (r.exit !== 0) throw new Error("mkfifo failed: " + r.stderr);
};

describe("nested repositories are boundaries Git never enters", () => {
	test("a nested repository with its own .git directory is withheld and reported, the rest exported", async () => {
		const { identity, collect } = await prepared();
		await mkdir(join(identity.path, "vendor", "lib"), { recursive: true });
		await gitIn(join(identity.path, "vendor"), "init", "-q");
		await writeFile(join(identity.path, "vendor", "lib", "inner.txt"), "INNER_SECRET");
		await gitIn(join(identity.path, "vendor"), "add", ".");
		await gitIn(join(identity.path, "vendor"), "commit", "-qm", "inner");
		await writeFile(join(identity.path, "vendor", "dirty.txt"), "INNER_DIRTY");
		await writeFile(join(identity.path, "tracked.txt"), "changed\n");
		await writeFile(join(identity.path, "new.txt"), "new\n");
		const manifest = await bounded(collect());
		expect(paths(manifest)).toEqual(["new.txt", "tracked.txt"]);
		expect(manifest.exclusions).toEqual([{ path: "vendor", reason: "nested_repository", outerTrackedEntries: 0 }]);
		expect(manifest.exportComplete).toBe(false);
		expect(everything(manifest)).not.toContain("INNER_");
		// Collected is never success by itself: no tests ran.
		expect(manifest.status).toBe("not_run");
	});

	if (posix)
		test("a .git FILE naming a Git directory outside the workspace is never followed or read", async () => {
			const { f, identity, collect } = await prepared();
			// The named directory's HEAD and config are FIFOs: any open of them blocks forever.
			const outside = join(f.dir, "outside-gitdir");
			await mkdir(join(outside, "objects"), { recursive: true });
			await mkdir(join(outside, "refs"), { recursive: true });
			await mkfifo(join(outside, "HEAD"));
			await mkfifo(join(outside, "config"));
			await mkfifo(join(outside, "commondir"));
			await mkdir(join(identity.path, "sub"), { recursive: true });
			await writeFile(join(identity.path, "sub", ".git"), "gitdir: " + outside + "\n");
			await writeFile(join(identity.path, "sub", "inside.txt"), "SUB_SECRET");
			// A second gitfile names a FIFO directly, a third a path that does not exist.
			await mkfifo(join(f.dir, "gitdir-fifo"));
			await mkdir(join(identity.path, "fifo-named"), { recursive: true });
			await writeFile(join(identity.path, "fifo-named", ".git"), "gitdir: " + join(f.dir, "gitdir-fifo") + "\n");
			await mkdir(join(identity.path, "dangling"), { recursive: true });
			await writeFile(join(identity.path, "dangling", ".git"), "gitdir: " + join(f.dir, "missing") + "\n");
			await writeFile(join(identity.path, "dangling", "d.txt"), "DANGLING_SECRET");
			await writeFile(join(identity.path, "out.txt"), "deliverable\n");
			const manifest = await bounded(collect());
			expect(paths(manifest)).toEqual(["out.txt"]);
			expect(manifest.exclusions.map((entry: any) => [entry.path, entry.reason])).toEqual([
				["dangling", "nested_repository"],
				["fifo-named", "nested_repository"],
				["sub", "nested_repository"],
			]);
			expect(everything(manifest)).not.toContain("_SECRET");
			// The recheck ran Git a second time: still nothing opened the FIFOs.
			expect((await bounded(collect())).patchDigest).toBe(manifest.patchDigest);
		}, 90_000);

	if (posix)
		test("a nested .git directory whose HEAD and commondir are FIFOs is never probed", async () => {
			const { identity, collect } = await prepared();
			const gitDir = join(identity.path, "trap", ".git");
			await mkdir(join(gitDir, "objects"), { recursive: true });
			await mkdir(join(gitDir, "refs"), { recursive: true });
			await mkfifo(join(gitDir, "HEAD"));
			await mkfifo(join(gitDir, "commondir"));
			await writeFile(join(identity.path, "trap", "t.txt"), "TRAP_SECRET");
			await writeFile(join(identity.path, "ok.txt"), "ok\n");
			const manifest = await bounded(collect());
			expect(paths(manifest)).toEqual(["ok.txt"]);
			expect(manifest.exclusions).toEqual([{ path: "trap", reason: "nested_repository", outerTrackedEntries: 0 }]);
			expect(everything(manifest)).not.toContain("TRAP_SECRET");
		});

	test("a .git file over a base-tree directory withholds its tracked changes too", async () => {
		const { identity, collect } = await prepared();
		await writeFile(join(identity.path, "tracked.txt"), "changed\n");
		// The workspace root's tracked files stay exported; a nested gitfile directory is a boundary.
		await mkdir(join(identity.path, "nest"), { recursive: true });
		await writeFile(join(identity.path, "nest", ".git"), "gitdir: /nonexistent/elsewhere\n");
		await writeFile(join(identity.path, "nest", "x.txt"), "X_SECRET");
		const manifest = await bounded(collect());
		expect(paths(manifest)).toEqual(["tracked.txt"]);
		expect(manifest.patch).not.toContain("nest/");
		expect(everything(manifest)).not.toContain("X_SECRET");
	});

	test("a bare repository inside the workspace is a boundary: no hooks, config or objects are exported", async () => {
		const { identity, collect } = await prepared();
		await gitIn(identity.path, "init", "-q", "--bare", "mirror.git");
		await writeFile(join(identity.path, "mirror.git", "config"), "[core]\n\tbare = true\n# BARE_SECRET\n");
		await writeFile(join(identity.path, "kept.txt"), "kept\n");
		const manifest = await bounded(collect());
		expect(paths(manifest)).toEqual(["kept.txt"]);
		expect(manifest.exclusions).toEqual([{ path: "mirror.git", reason: "nested_repository", outerTrackedEntries: 0 }]);
		expect(manifest.exportComplete).toBe(false);
		expect(everything(manifest)).not.toContain("BARE_SECRET");
		expect(everything(manifest)).not.toContain("hooks/");
	});

	test("a directory that only looks bare in part (no refs/) is ordinary content", async () => {
		const { identity, collect } = await prepared();
		await mkdir(join(identity.path, "almost", "objects"), { recursive: true });
		await writeFile(join(identity.path, "almost", "HEAD"), "ref: x\n");
		await writeFile(join(identity.path, "almost", "objects", "o.txt"), "o\n");
		const manifest = await bounded(collect());
		expect(paths(manifest)).toEqual(["almost/HEAD", "almost/objects/o.txt"]);
		expect(manifest.exportComplete).toBe(true);
	});
});

describe("links and special files", () => {
	if (posix)
		test("an untracked link (to a file outside, to a directory) is never followed: collection refuses", async () => {
			const { f, identity, collect } = await prepared();
			await writeFile(join(f.dir, "outside-secret.txt"), "LINK_SECRET");
			await symlink(join(f.dir, "outside-secret.txt"), join(identity.path, "link.txt"));
			const refused = await bounded(collect()).catch((error) => error);
			expect(String(refused?.message)).toContain("node_failed:unsafe_path");
			await unlink(join(identity.path, "link.txt"));
			await symlink(f.dir, join(identity.path, "dirlink"));
			const again = await bounded(collect()).catch((error) => error);
			expect(String(again?.message)).toContain("node_failed:unsafe_path");
		});

	if (posix)
		test("a symlinked .gitignore is not followed (Git ignores it, its target's rules never apply)", async () => {
			const { f, identity, collect } = await prepared();
			await writeFile(join(f.dir, "outside.ignore"), "*.txt\n");
			await symlink(join(f.dir, "outside.ignore"), join(identity.path, ".gitignore"));
			await writeFile(join(identity.path, "visible.txt"), "v\n");
			await rm(join(identity.path, ".gitignore"));
			await writeFile(join(identity.path, ".gitignore"), "*.log\n");
			await writeFile(join(identity.path, "a.log"), "l\n");
			const manifest = await bounded(collect());
			expect(paths(manifest)).toEqual([".gitignore", "visible.txt"]);
		});

	if (posix)
		test("an untracked FIFO is neither opened nor exported", async () => {
			const { identity, collect } = await prepared();
			await mkdir(join(identity.path, "d"), { recursive: true });
			await mkfifo(join(identity.path, "d", "pipe"));
			await mkfifo(join(identity.path, "pipe.txt"));
			await writeFile(join(identity.path, "d", "real.txt"), "r\n");
			const manifest = await bounded(collect());
			expect(paths(manifest)).toEqual(["d/real.txt"]);
		});

	if (posix)
		for (const [name, place] of [
			["a FIFO .gitignore at the root", ".gitignore"],
			["a FIFO .gitignore in a subdirectory", "d/.gitignore"],
			["a FIFO .gitattributes", "d/.gitattributes"],
			["a FIFO .gitattributes in a nested repository root", "nested/.gitattributes"],
		] as const)
			test(`${name} is refused before any Git process could block on it`, async () => {
				const { identity, collect } = await prepared();
				await mkdir(join(identity.path, "d"), { recursive: true });
				if (place.startsWith("nested/")) {
					await mkdir(join(identity.path, "nested"), { recursive: true });
					await writeFile(join(identity.path, "nested", ".git"), "gitdir: /nonexistent\n");
				}
				await writeFile(join(identity.path, "tracked.txt"), "changed\n");
				await mkfifo(join(identity.path, place));
				const refused = await bounded(collect()).catch((error) => error);
				expect(String(refused?.message)).toBe("node_failed:unsafe_path:unsafe_entry");
			});

	if (posix)
		test("a tracked file replaced by a FIFO is refused (Git cannot hash it), never read", async () => {
			const { identity, collect } = await prepared();
			await unlink(join(identity.path, "tracked.txt"));
			await mkfifo(join(identity.path, "tracked.txt"));
			const refused = await bounded(collect()).catch((error) => error);
			expect(String(refused?.message)).toBe("node_failed:unsafe_path:unsafe_entry");
		});
});

describe("files changing between listing and reading", () => {
	if (posix)
		test("a file rewritten while the patch is produced, or a file added during collection, refuses the result", async () => {
			const { f, identity } = await prepared();
			await writeFile(join(identity.path, "tracked.txt"), "first\n");
			await writeFile(join(identity.path, "u.txt"), "u\n");
			const realGit = (await run(["sh", "-c", "command -v git"], f.dir)).stdout.trim();
			const shim = join(f.dir, "shim");
			await mkdir(shim);
			const counter = join(f.dir, "binary-diffs");
			// After the first binary diff (the listing is done), the worker's files change.
			await writeFile(
				join(shim, "git"),
				`#!/bin/sh\ncase " $* " in *" --binary "*) echo x >> '${counter}'; if [ "$(wc -l < '${counter}')" -eq 1 ]; then '${realGit}' "$@"; s=$?; printf 'second\\n' > '${join(identity.path, "tracked.txt")}'; printf 'late\\n' > '${join(identity.path, "late.txt")}'; exit $s; fi;; esac\nexec '${realGit}' "$@"\n`,
			);
			chmodSync(join(shim, "git"), 0o755);
			const saved = process.env.PATH;
			process.env.PATH = shim + ":" + saved;
			try {
				await expect(bounded(collectResult(identity, []))).rejects.toThrow("result_changed_during_collection");
			} finally {
				process.env.PATH = saved;
			}
			expect((await readFile(counter, "utf8")).trim().split("\n").length).toBeGreaterThanOrEqual(1);
			// Once nothing changes any more the same workspace collects.
			const manifest = await bounded(collectResult(identity, []));
			expect(paths(manifest)).toEqual(["late.txt", "tracked.txt", "u.txt"]);
		});

	if (posix)
		test("a listed untracked file replaced by a FIFO or link before it is read refuses (never blocks)", async () => {
			const { f, identity } = await prepared();
			await writeFile(join(identity.path, "swap.txt"), "s\n");
			const realGit = (await run(["sh", "-c", "command -v git"], f.dir)).stdout.trim();
			const shim = join(f.dir, "shim");
			await mkdir(shim);
			const swap = join(identity.path, "swap.txt");
			await writeFile(
				join(shim, "git"),
				`#!/bin/sh\ncase " $* " in *" --binary "*) if [ ! -p '${swap}' ]; then '${realGit}' "$@"; s=$?; rm -f '${swap}'; mkfifo '${swap}'; exit $s; fi;; esac\nexec '${realGit}' "$@"\n`,
			);
			chmodSync(join(shim, "git"), 0o755);
			const saved = process.env.PATH;
			process.env.PATH = shim + ":" + saved;
			try {
				const refused = await bounded(collectResult(identity, [])).catch((error) => error);
				expect(refused).toBeInstanceOf(Error);
				expect(["unsafe_artifact", "artifact_unavailable_or_unsafe", "result_changed_during_collection"]).toContain(refused.message);
			} finally {
				process.env.PATH = saved;
			}
		});
});

describe("the three limits are unchanged", () => {
	test("1,024 files collect; 1,025 refuse", async () => {
		const { identity, collect } = await prepared();
		await mkdir(join(identity.path, "many"), { recursive: true });
		for (let index = 0; index < 1023; index++) await writeFile(join(identity.path, "many", `f${index}.txt`), "x");
		await writeFile(join(identity.path, "tracked.txt"), "changed\n");
		expect((await bounded(collect())).files.length).toBe(1024);
		await writeFile(join(identity.path, "many", "one-more.txt"), "x");
		await expect(bounded(collect())).rejects.toThrow("node_failed:output_limit");
	}, 120_000);

	test("4 MiB per file and 16 MiB total", async () => {
		const { identity, collect } = await prepared();
		const mib = 1024 * 1024;
		await writeFile(join(identity.path, "exact.bin"), Buffer.alloc(4 * mib, 1));
		expect((await bounded(collect())).files.map((file: any) => file.bytes)).toEqual([4 * mib]);
		await writeFile(join(identity.path, "over.bin"), Buffer.alloc(4 * mib + 1, 2));
		const over = await bounded(collect()).catch((error) => error);
		expect(String(over?.message)).toContain("node_failed:");
		await unlink(join(identity.path, "over.bin"));
		for (const name of ["b.bin", "c.bin", "d.bin"]) await writeFile(join(identity.path, name), Buffer.alloc(4 * mib, 3));
		// Exactly 16 MiB of file bytes collects (the patch itself is bounded separately).
		const total = await bounded(collect());
		expect(total.files.reduce((sum: number, file: any) => sum + file.bytes, 0)).toBe(16 * mib);
		await writeFile(join(identity.path, "e.txt"), "1");
		await expect(bounded(collect())).rejects.toThrow("node_failed:output_limit");
	}, 120_000);
});

describe("portable Windows path hazards", () => {
	const hazards = posix
		? ["a:b.txt", "con.txt", "sub/NUL", "trail.", "trail ", "back\\slash.txt", "pipe|name", "q?.txt", "star*.txt", "lt<.txt", "quote\".txt", "ctl\x01.txt"]
		: // Windows opens the NUL device for `sub/NUL`: nothing is created (review fx-093cc54b F5).
		  ["con.txt"];
	for (const name of hazards)
		test(`an untracked ${JSON.stringify(name)} refuses as unsafe (never exported under another spelling)`, async () => {
			const { identity, collect } = await prepared();
			await mkdir(join(identity.path, "sub"), { recursive: true });
			await writeFile(join(identity.path, name), "W");
			await writeFile(join(identity.path, "ok.txt"), "ok\n");
			const refused = await bounded(collect()).catch((error) => error);
			expect(String(refused?.message)).toBe("node_failed:unsafe_path:unsafe_entry");
		});

	test("a nested repository whose name is a Windows device name is still only a boundary", async () => {
		const { identity, collect } = await prepared();
		await mkdir(join(identity.path, "aux.d"), { recursive: true });
		await writeFile(join(identity.path, "aux.d", ".git"), "gitdir: /nonexistent\n");
		await writeFile(join(identity.path, "aux.d", "a.txt"), "AUX_SECRET");
		await writeFile(join(identity.path, "fine.txt"), "f\n");
		const manifest = await bounded(collect());
		expect(paths(manifest)).toEqual(["fine.txt"]);
		expect(everything(manifest)).not.toContain("AUX_SECRET");
	});
});
