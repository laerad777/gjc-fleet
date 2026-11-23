import { afterEach, describe, expect, test } from "bun:test";
import {
	access,
	chmod,
	link,
	mkdir,
	readFile,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	checkPreparation,
	collectResult,
	gitFailedMessage,
	prepareWorkspace,
	readOwnedFile,
	run,
	safeRelative,
	sha256,
	testWorkspace,
	type IgnoreSource,
} from "../src/workspace";
import { validateResult } from "../src/fleet";
import { nodeOperation, oneShot } from "../src/node";
import type { NodeConfig } from "../src/contracts";
import { repositoryFixture } from "./fixtures/coordinator";

const directories: string[] = [];
async function fixture() {
	const f = await repositoryFixture("fleet-workspace-owned-");
	directories.push(f.dir);
	const input = {
		taskId: "task",
		attemptId: "attempt",
		nodeId: "node",
		inputDigest: sha256("input"),
		repo: f.repo,
		baseCommit: f.baseCommit,
		workspaceRoot: f.workspaceRoot,
	};
	return { ...f, input };
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
/** Operator action before preparation: commit `files` to the source repository and make it the task base. */
async function commitBase(f: Awaited<ReturnType<typeof fixture>>, files: Record<string, string>) {
	for (const [name, content] of Object.entries(files)) {
		await mkdir(join(f.repo, name, ".."), { recursive: true });
		await writeFile(join(f.repo, name), content);
	}
	const git = (...args: string[]) => run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "-C", f.repo, ...args], f.dir);
	expect((await git("add", "-f", "--", ...Object.keys(files))).exit).toBe(0);
	expect((await git("commit", "-qm", "base")).exit).toBe(0);
	f.baseCommit = f.input.baseCommit = (await git("rev-parse", "HEAD")).stdout.trim();
}
// Removing the large fixtures outlasts the default hook timeout on a loaded host.
afterEach(async () => {
	for (const dir of directories.splice(0))
		await rm(dir, { recursive: true, force: true });
}, 120_000);

describe("real task-owned Git workspaces (not live GJC proof)", () => {
	test.skipIf(process.platform === "win32")("gitRecords SIGKILLs a SIGTERM-trapping git on stderr overflow", async () => {
		const f = await fixture();
		const pidFile = join(f.dir, "git-records-pid");
		const shim = await gitShim(
			f.dir,
			[
				`case " $* " in`,
				`*" ls-tree "*)`,
				`  trap '' TERM`,
				`  echo $$ >${JSON.stringify(pidFile)}`,
				`  dd if=/dev/zero bs=1024 count=80 >&2`,
				`  while true; do sleep 1; done`,
				`  ;;`,
				`esac`,
			].join("\n"),
		);
		await withEnv(shim, async () => {
			const error = await checkPreparation(f.input).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("command_output_limit");
			const pid = (await readFile(pidFile, "utf8")).trim();
			expect(pid).toMatch(/^\d+$/);
			const goneUntil = Date.now() + 500;
			let gone = false;
			while (Date.now() < goneUntil) {
				try {
					process.kill(Number(pid), 0);
				} catch {
					gone = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(gone).toBe(true);
		});
	});
	test("review regressions: outer-tracked nested files never escape and completeness is explicit", async () => {
		const f = await fixture();
		// Outer-tracked means tracked by the base commit (the node's index), not by any worker commit.
		await commitBase(f, { "nested/answer.txt": "initial" });
		const identity = await prepareWorkspace(f.input);
		expect((await run(["git", "init", join(identity.path, "nested")], f.dir)).exit).toBe(0);
		await writeFile(join(identity.path, "nested/answer.txt"), "LEAK_NESTED_BYTES");
		const result = await collectResult(identity, [await testWorkspace(identity, ["git", "status", "--porcelain"])]);
		expect(result.files).toEqual([]);
		expect(result.patch).toBe("");
		expect(result.exclusions).toEqual([{path: "nested", reason: "nested_repository", outerTrackedEntries: 1}]);
		expect(result.exportComplete).toBe(false);
		expect(result.status).toBe("verified");
		expect(() => validateResult(identity, result)).not.toThrow();
		await unlink(join(identity.path, "nested/answer.txt"));
		const deleted = await collectResult(identity, []);
		expect(deleted.files).toEqual([]);
		expect(deleted.patch).toBe("");
		expect(deleted.exclusions).toEqual(result.exclusions);
	});
	test("review regressions: exclusion validation is not optional", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const result = await collectResult(identity, []);
		for (const exclusions of [null, [{path: "../escape", reason: "bogus"}]])
			expect(() => validateResult(identity, {...result, exclusions})).toThrow();
	});
	test("review regressions: hidden deliverables and malformed exclusion manifests", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "deliverable"));
		expect((await run(["git", "init", join(identity.path, "deliverable")], f.dir)).exit).toBe(0);
		await writeFile(join(identity.path, "deliverable/answer.txt"), "SECRET_DELIVERABLE");
		const result = await collectResult(identity, []);
		expect(result.exportComplete).toBe(false);
		const entry = {path: "deliverable", reason: "nested_repository", outerTrackedEntries: 0};
		for (const exclusions of [null, [{...entry, path: "../escape"}], [{...entry, reason: "bogus"}], [entry, entry], [{...entry, outerTrackedEntries: -1}], [{...entry, outerTrackedEntries: 1.5}], [{...entry, outerTrackedEntries: 2_000_001}], [{...entry, path: "z"}, entry], Array(1025).fill(entry)]) {
			expect(() => validateResult(identity, {...result, exclusions})).toThrow();
			expect(() => validateResult(identity, {...result, exclusions, exportComplete: undefined})).toThrow();
		}
		for (const path of ["/absolute", "a\\b", "a/../b", "a//b", "CON", "bad:stream", "bad\nname", "trailing."]) {
			expect(() => validateResult(identity, {...result, exclusions: [{...entry, path}]})).toThrow();
		}
		for (const exclusions of [[entry, {...entry, path: "deliverable/child"}], [{...entry, path: "Deliverable"}, entry]]) {
			expect(() => validateResult(identity, {...result, exclusions})).toThrow();
		}
		await writeFile(join(identity.path, "normal.txt"), "outer");
		const mixed = await collectResult(identity, []);
		expect(() => validateResult(identity, {...mixed, exclusions: [{...entry, path: "normal.txt"}]})).toThrow();
		expect(() => validateResult(identity, {...result, exportComplete: true})).toThrow();
		const legacy: any = {...result};
		delete legacy.exclusions;
		delete legacy.exportComplete;
		delete legacy.ignored;
		delete legacy.junk;
		expect(() => validateResult(identity, legacy)).not.toThrow();
	});
	test("collection excludes real nested repositories and embedded worktrees deterministically", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const nested = join(identity.path, "review-copy", "repo");
		await mkdir(nested, { recursive: true });
		expect((await run(["git", "init", nested], f.dir)).exit).toBe(0);
		await writeFile(join(nested, "private.txt"), "NESTED_PRIVATE_BYTES");
		const embedded = join(identity.path, "embedded");
		expect(
			(
				await run(
					[
						"git",
						"-C",
						f.repo,
						"worktree",
						"add",
						"--detach",
						embedded,
						f.baseCommit,
					],
					f.dir,
				)
			).exit,
		).toBe(0);
		const first = await collectResult(identity, []);
		expect(first.files).toEqual([]);
		expect(first.exclusions).toEqual([
			{ path: "embedded", reason: "nested_repository", outerTrackedEntries: 0 },
			{ path: "review-copy/repo", reason: "nested_repository", outerTrackedEntries: 0 },
		]);
		expect(await collectResult(identity, [])).toEqual(first);
		await writeFile(join(identity.path, "normal.txt"), "normal bytes");
		const mixed = await collectResult(identity, []);
		expect(mixed.files.map((file) => file.path)).toEqual(["normal.txt"]);
		expect(mixed.exclusions).toEqual(first.exclusions);
		expect(JSON.stringify(mixed)).not.toContain("NESTED_PRIVATE_BYTES");
		expect(() => validateResult(identity, mixed)).not.toThrow();
	});
	// Round 9: the index is node-owned. A worker-staged or worker-committed gitlink is not
	// a node fact; the export is the filesystem against the base commit.
	test("a worker-staged or committed gitlink changes nothing: the index and HEAD are node-owned", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const baseline = await collectResult(identity, []);
		const g = (...args: string[]) => run(["git", "-c", "user.name=Fixture", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", "-C", identity.path, ...args], f.dir);
		expect((await g("update-index", "--add", "--cacheinfo", `160000,${f.baseCommit},fixture-link`)).exit).toBe(0);
		expect((await g("rm", "-q", "--cached", "tracked.txt")).exit).toBe(0);
		const staged = await collectResult(identity, []);
		expect(staged.files).toEqual([]);
		expect(staged.patch).toBe("");
		expect(staged.exclusions).toEqual([]);
		expect(staged.exportComplete).toBe(true);
		expect((await g("commit", "-qm", "gitlink fixture")).exit).toBe(0);
		const committed = await collectResult(identity, []);
		// Production keeps `outputHead` as the workspace HEAD (work-unit provenance); the export itself is unchanged.
		expect(committed.outputHead).toBe((await g("rev-parse", "HEAD")).stdout.trim());
		expect(committed.outputHead).not.toBe(f.baseCommit);
		expect({ ...committed, outputHead: staged.outputHead }).toEqual(staged);
		expect({ ...committed, outputHead: baseline.outputHead, tests: [] }).toEqual({ ...baseline, tests: [] });
	});
	test.skipIf(process.platform === "win32")(
		"collection refuses unsafe untracked entries with a bounded entry-class error",
		async () => {
			const f = await fixture();
			const identity = await prepareWorkspace(f.input);
			for (const name of ["CON", "bad\nname", "bad:stream"]) {
				await writeFile(join(identity.path, name), "unsafe");
				await expect(collectResult(identity, [])).rejects.toThrow(
					"unsafe_result_entry:untracked",
				);
				await unlink(join(identity.path, name));
			}
		},
	);
	test("runtime-owned untracked .gjc state is never read or exported as a result", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, ".gjc", "state"), { recursive: true });
		await writeFile(
			join(identity.path, ".gjc", "state", "private-runtime"),
			"CONTROLLED_PRIVATE_RUNTIME",
		);
		await writeFile(join(identity.path, "result.txt"), "actual result\n");
		const manifest = await collectResult(identity, []);
		expect(manifest.files.map((file) => file.path)).toEqual(["result.txt"]);
		expect(JSON.stringify(manifest)).not.toContain(
			"CONTROLLED_PRIVATE_RUNTIME",
		);
	});
	test.skipIf(process.platform === "win32")(
		"checkout is private before files materialize even below an existing shared parent",
		async () => {
			const f = await fixture();
			await mkdir(f.workspaceRoot, { mode: 0o755 });
			await chmod(f.workspaceRoot, 0o755);
			const identity = await prepareWorkspace(f.input);
			expect((await stat(identity.path)).mode & 0o777).toBe(0o700);
		},
	);
	test("git_failed carries only the exit code, never raw Git output", () => {
		// Collector errors are copied into shared logs and result artifacts, so the
		// message is the fixed code plus the exit code and nothing Git printed.
		expect(gitFailedMessage(1)).toBe("git_failed:exit=1");
		expect(gitFailedMessage(128)).toBe("git_failed:exit=128");
	});
	test("failing Git during preparation surfaces git_failed with the exit code only", async () => {
		const f = await fixture();
		await expect(
			prepareWorkspace({ ...f.input, baseCommit: "f".repeat(40) }),
		).rejects.toThrow("git_failed:exit=128");
		try {
			await prepareWorkspace({ ...f.input, baseCommit: "f".repeat(40) });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toBe("git_failed:exit=128");
			expect(message).not.toContain("fatal");
			expect(message).not.toContain(f.dir);
			expect(message).not.toContain(f.repo);
		}
	});
	// Each real Git exit failure below must surface through gitFailedMessage: the exact exit
	// code and no stdout/stderr snippet, never the pre-#17 bare "git_failed".
	test.if(process.platform !== "win32")("failing Git status during collection surfaces git_failed with the exact exit code and no raw output", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const env = await gitShim(f.dir, `for a in "$@"; do\n  case "$a" in\n    status) printf '%s\\n' 'fatal: cannot open /home/ops/secret-repo/.git/index: Permission denied (ghp_abcdef123456)' >&2; exit 3;;\n  esac\ndone`);
		const error = await withEnv(env, () => collectResult(identity, []).then(() => undefined, (error: unknown) => error));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("git_failed:exit=3");
	});
	test.if(process.platform !== "win32")("failing Git read-tree during preparation surfaces git_failed with the exact exit code and no raw output", async () => {
		const f = await fixture();
		const env = await gitShim(f.dir, `for a in "$@"; do\n  case "$a" in\n    read-tree) printf '%s\\n' 'fatal: cannot read tree from /home/ops/secret-repo/objects: bad object (ghp_abcdef123456)' >&2; exit 5;;\n  esac\ndone`);
		const error = await withEnv(env, () => prepareWorkspace(f.input).then(() => undefined, (error: unknown) => error));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("git_failed:exit=5");
	});
	test.if(process.platform !== "win32")("failing Git collection-config read during preparation surfaces git_failed with the exact exit code and no raw output", async () => {
		const f = await fixture();
		const env = await gitShim(f.dir, `isconfig=0; isnull=0\nfor a in "$@"; do\n  case "$a" in\n    config) isconfig=1;;\n    --null) isnull=1;;\n  esac\ndone\nif [ "$isconfig" = 1 ] && [ "$isnull" = 1 ]; then\n  printf '%s\\n' 'fatal: bad config line 7 in file /home/ops/secret-repo/.git/config' >&2\n  exit 9\nfi`);
		const error = await withEnv(env, () => prepareWorkspace(f.input).then(() => undefined, (error: unknown) => error));
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("git_failed:exit=9");
	});
	test("local Git replacement refs cannot change the declared exact input commit", async () => {
		const f = await fixture();
		await writeFile(
			join(f.repo, "tracked.txt"),
			"replacement must not become input\n",
		);
		await f.git("add", "tracked.txt");
		await f.git("commit", "-m", "task-owned replacement fixture");
		const replacement = await f.git("rev-parse", "HEAD");
		await f.git("replace", f.baseCommit, replacement);
		const identity = await prepareWorkspace(f.input);
		expect(await readFile(join(identity.path, "tracked.txt"), "utf8")).toBe(
			"base bytes\n",
		);
	});
	test("preparation cannot run repository-controlled checkout hooks", async () => {
		const f = await fixture();
		const marker = join(f.dir, "hook-must-not-run");
		for (const dir of [
			join(f.repo, ".git", "hooks"),
			join(f.repo, ".fleet-disabled-hooks"),
		]) {
			await mkdir(dir, { recursive: true });
			const hook = join(dir, "post-checkout");
			await writeFile(hook, '#!/bin/sh\nprintf bad > "' + marker + '"\n');
			await chmod(hook, 0o755);
		}
		await prepareWorkspace(f.input);
		await expect(access(marker)).rejects.toThrow();
	});
	test("workspace Git ignores ambient global and injected filters without changing their configuration", async () => {
		const f = await fixture();
		const globalFile = join(f.dir, "global.gitconfig");
		const config =
			'[filter "ambient"]\n\tsmudge = must-not-execute\n\trequired = true\n';
		await writeFile(globalFile, config);
		const script = `const {prepareWorkspace}=await import(${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)});console.log(JSON.stringify(await prepareWorkspace(${JSON.stringify(f.input)})));`;
		const result = await run(
			[process.execPath, "--eval", script],
			f.dir,
			1024 * 1024,
			{
				GIT_CONFIG_GLOBAL: globalFile,
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "filter.injected.smudge",
				GIT_CONFIG_VALUE_0: "also-must-not-execute",
			},
		);
		expect(result.exit).toBe(0);
		const identity = JSON.parse(result.stdout);
		expect(await readFile(join(identity.path, "tracked.txt"), "utf8")).toBe(
			"base bytes\n",
		);
		expect(await readFile(globalFile, "utf8")).toBe(config);
		await f.git("config", "--local", "filter.local.smudge", "must-not-execute");
		await expect(
			prepareWorkspace({ ...f.input, attemptId: "local-filter" }),
		).rejects.toThrow("checkout_filters_not_authorized");
	});
	test("review fx-093cc54b F2: a preparation refusal returns only after its Git reads exited (the repository can be removed at once)", async () => {
		for (let round = 0; round < 3; round++) {
			const filtered = await fixture();
			await filtered.git("config", "--local", "filter.local.smudge", "must-not-execute");
			await expect(prepareWorkspace(filtered.input)).rejects.toThrow("checkout_filters_not_authorized");
			// No retry: a Git child still running in the repository holds it on Windows (EBUSY).
			await rm(filtered.repo, { recursive: true, force: true });
			await expect(access(filtered.repo)).rejects.toThrow();
			const nested = await fixture();
			await mkdir(join(nested.repo, "sub"));
			await expect(prepareWorkspace({ ...nested.input, repo: join(nested.repo, "sub") })).rejects.toThrow("repository_root_required");
			await rm(nested.repo, { recursive: true, force: true });
			await expect(access(nested.repo)).rejects.toThrow();
		}
	});
	test.skipIf(process.platform === "win32")(
		"a task-created FIFO is refused instead of blocking the synchronous reader (POSIX FIFO cannot exist in a Windows disk worktree)",
		async () => {
			const f = await fixture();
			const identity = await prepareWorkspace(f.input);
			const path = join(identity.path, "fifo");
			expect((await run(["mkfifo", path], f.dir)).exit).toBe(0);
			await expect(readOwnedFile(identity.path, "fifo")).rejects.toThrow(
				"unsafe_artifact",
			);
		},
	);
	test("checks out the exact older commit detached without touching a dirty user sentinel", async () => {
		const f = await fixture();
		await writeFile(join(f.repo, "tracked.txt"), "newer committed bytes\n");
		await f.git("add", "--", "tracked.txt");
		await f.git("commit", "-m", "task-owned newer fixture");
		const upstreamHead = await f.git("rev-parse", "HEAD");
		await writeFile(join(f.repo, "tracked.txt"), "DIRTY USER SENTINEL\n");
		await writeFile(
			join(f.repo, "untracked-user.txt"),
			"never move or delete\n",
		);
		const before = await f.git("status", "--porcelain=v1");
		const identity = await prepareWorkspace(f.input);
		expect(identity.baseCommit).toBe(f.baseCommit);
		expect(identity.path).toBe(join(f.workspaceRoot, "task-attempt"));
		expect(await readFile(join(identity.path, "tracked.txt"), "utf8")).toBe(
			"base bytes\n",
		);
		const head = await run(["git", "rev-parse", "HEAD"], identity.path);
		const detached = await run(
			["git", "symbolic-ref", "-q", "HEAD"],
			identity.path,
		);
		expect(head.stdout.trim()).toBe(f.baseCommit);
		expect(detached.exit).toBe(1);
		expect(await f.git("rev-parse", "HEAD")).toBe(upstreamHead);
		expect(await f.git("status", "--porcelain=v1")).toBe(before);
		expect(await readFile(join(f.repo, "tracked.txt"), "utf8")).toBe(
			"DIRTY USER SENTINEL\n",
		);
		expect(await readFile(join(f.repo, "untracked-user.txt"), "utf8")).toBe(
			"never move or delete\n",
		);
		await expect(prepareWorkspace(f.input)).rejects.toThrow(
			"workspace_exists_conflict",
		);
	});

	test("rejects tracked secret .env before creating any checkout", async () => {
		const f = await fixture();
		await writeFile(
			join(f.repo, ".env"),
			"CONTROLLED_FIXTURE_SECRET=not-a-real-secret\n",
		);
		await f.git("add", "--", ".env");
		await f.git("commit", "-m", "task-owned excluded fixture");
		const baseCommit = await f.git("rev-parse", "HEAD");
		const worktrees = await f.git("worktree", "list", "--porcelain");
		await expect(prepareWorkspace({ ...f.input, baseCommit })).rejects.toThrow(
			"excluded_input:.env",
		);
		await expect(access(f.workspaceRoot)).rejects.toThrow();
		expect(await f.git("worktree", "list", "--porcelain")).toBe(worktrees);
	});

	test("rejects case-colliding and reserved tree names without depending on host filename behavior", async () => {
		const f = await fixture();
		const blob = await f.git("rev-parse", f.baseCommit + ":tracked.txt");
		for (const names of [
			["Upper.txt", "upper.txt"],
			["Upper/one.txt", "upper/two.txt"],
			["CON.txt"],
			["safe:stream"],
			["trailing."],
		]) {
			await f.git("read-tree", f.baseCommit);
			for (const name of names)
				await f.git(
					"-c",
					"core.protectNTFS=false",
					"update-index",
					"--add",
					"--cacheinfo",
					`100644,${blob},${name}`,
				);
			const tree = await f.git("write-tree");
			const commit = await f.git(
				"commit-tree",
				tree,
				"-p",
				f.baseCommit,
				"-m",
				"task-owned hostile tree",
			);
			await expect(
				prepareWorkspace({ ...f.input, baseCommit: commit }),
			).rejects.toThrow(
				names.length === 2 ? "case_collision" : "unsafe_relative_path",
			);
			await expect(access(f.workspaceRoot)).rejects.toThrow();
		}
	});

	test("rejects symlink, hardlink and nested symlink-parent artifacts", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const outside = join(f.dir, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.txt"), "OUTSIDE CONTROLLED SENTINEL");
		await symlink(
			join(outside, "secret.txt"),
			join(identity.path, "symbolic.txt"),
		);
		await expect(
			readOwnedFile(identity.path, "symbolic.txt"),
		).rejects.toThrow();
		await expect(collectResult(identity, [])).rejects.toThrow();
		await unlink(join(identity.path, "symbolic.txt"));
		await link(join(outside, "secret.txt"), join(identity.path, "hard.txt"));
		const hardlinkError =
			process.platform === "win32"
				? "unsafe_windows_artifact"
				: "unsafe_artifact";
		await expect(readOwnedFile(identity.path, "hard.txt")).rejects.toThrow(
			hardlinkError,
		);
		await expect(collectResult(identity, [])).rejects.toThrow(hardlinkError);
		await unlink(join(identity.path, "hard.txt"));
		await mkdir(join(identity.path, "nested"));
		await symlink(outside, join(identity.path, "nested", "escape"));
		await expect(
			readOwnedFile(identity.path, "nested/escape/secret.txt"),
		).rejects.toThrow(
			process.platform === "win32"
				? "unsafe_windows_artifact"
				: "unsafe_artifact_parent",
		);
		expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
			"OUTSIDE CONTROLLED SENTINEL",
		);
	});

	test("rejects traversal, Windows ADS/device names, ambiguous trailing names and control bytes", () => {
		for (const path of [
			"",
			"../x",
			"a/../x",
			"./x",
			"/absolute",
			"a//b",
			"a\\b",
			"C:/x",
			"file:stream",
			"file?.txt",
			"file*.txt",
			"file|stream",
			'file"quote',
			"CON",
			"con.txt",
			"aux",
			"NUL.json",
			"PRN",
			"COM1.log",
			"lPt9",
			"dir/COM9.txt",
			"end.",
			"end ",
			"a/./b",
			"a\0b",
			"a\nb",
		]) {
			expect(() => safeRelative(path)).toThrow("unsafe_relative_path");
		}
		expect(safeRelative("src/console.ts")).toBe("src/console.ts");
		expect(safeRelative("src/COM10.txt")).toBe("src/COM10.txt");
	});

	test("real argv output/exits and binary bytes, untracked files and deletions round-trip through the node adapter", async () => {
		const f = await fixture();
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
		};
		const identity = await prepareWorkspace(f.input);
		const binary = Buffer.from([0, 255, 128, 10, 13, 1]);
		await expect(
			nodeOperation(
				{ ...node, os: process.platform === "win32" ? "linux" : "win32" },
				{ action: "collect", identity },
			),
		).rejects.toThrow("node_refused:identity_mismatch:identity");
		await expect(
			nodeOperation(
				{ ...node, arch: process.arch === "arm64" ? "x64" : "arm64" },
				{ action: "collect", identity },
			),
		).rejects.toThrow("node_refused:identity_mismatch:identity");
		await writeFile(join(identity.path, "tracked.txt"), "changed tracked\n");
		await writeFile(join(identity.path, "untracked.bin"), binary);
		await unlink(join(identity.path, "deleted.txt"));
		const argv = [
			process.execPath,
			"--eval",
			'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}));process.stderr.write("controlled stderr\\n");process.exit(7)',
			"literal ; $(not-a-shell) argument",
		];
		const evidence = await testWorkspace(identity, argv);
		expect(evidence.argv).toEqual(argv);
		expect(evidence.exit).toBe(7);
		expect(JSON.parse(evidence.stdout)).toEqual({
			cwd: identity.path,
			arg: argv[3],
		});
		expect(evidence.stderr).toBe("controlled stderr\n");
		expect(evidence.stdoutDigest).toBe(sha256(evidence.stdout));
		expect(evidence.stderrDigest).toBe(sha256(evidence.stderr));
		expect(Date.parse(evidence.endedAt)).toBeGreaterThanOrEqual(
			Date.parse(evidence.startedAt),
		);
		const config = join(f.dir, "node.json");
		await writeFile(config, JSON.stringify(node));
		const manifest = await oneShot(
			process.execPath,
			[fileURLToPath(new URL("../src/node.ts", import.meta.url)), config],
			{ action: "collect", identity, tests: [evidence] },
		);
		expect(() => validateResult(identity, manifest)).not.toThrow();
		expect(manifest.status).toBe("tests_failed");
		expect(manifest.outputHead).toBe(f.baseCommit);
		expect(manifest.patch).toContain("changed tracked");
		expect(manifest.patch).toContain("deleted file mode");
		expect(manifest.patchDigest).toBe(sha256(manifest.patch));
		expect(manifest.files.map((file: any) => file.path).sort()).toEqual([
			"deleted.txt",
			"tracked.txt",
			"untracked.bin",
		]);
		for (const file of manifest.files) {
			const bytes = Buffer.from(file.contentBase64, "base64");
			expect(bytes.length).toBe(file.bytes);
			expect(sha256(bytes)).toBe(file.sha256);
		}
		const added = manifest.files.find(
			(file: any) => file.path === "untracked.bin",
		);
		expect(Buffer.from(added.contentBase64, "base64")).toEqual(binary);
		expect(
			manifest.files.find((file: any) => file.path === "deleted.txt"),
		).toMatchObject({
			deleted: true,
			bytes: 0,
			contentBase64: "",
			sha256: sha256(""),
		});
		const success = (await nodeOperation(node, {
			action: "test",
			identity,
			argv: [
				process.execPath,
				"--eval",
				'console.log("actual passing command")',
			],
		})) as Awaited<ReturnType<typeof testWorkspace>>;
		expect(success.exit).toBe(0);
		expect(success.stdout).toBe("actual passing command\n");
		expect((await collectResult(identity, [success])).status).toBe("verified");
		expect((await collectResult(identity, [])).status).toBe("not_run");
	});

	test("validateResult rejects cross-task identity, patch/file/test digest tampering and case aliases", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, "result.txt"), "real collected bytes");
		const evidence = await testWorkspace(identity, [
			process.execPath,
			"--eval",
			'console.log("evidence")',
		]);
		const manifest = await collectResult(identity, [evidence]);
		expect(() => validateResult(identity, manifest)).not.toThrow();
		for (const mutate of [
			(m: any) => {
				m.identity.taskId = "other-task";
			},
			(m: any) => {
				m.identity.attemptId = "other-attempt";
			},
			(m: any) => {
				m.patch += "tampered";
			},
			(m: any) => {
				m.files[0].contentBase64 = Buffer.from("tampered").toString("base64");
			},
			(m: any) => {
				m.files[0].sha256 = "0".repeat(64);
			},
			(m: any) => {
				m.tests[0].stdout += "tampered";
			},
			(m: any) => {
				m.tests[0].cwd = f.repo;
			},
			(m: any) => {
				m.files.push({ ...m.files[0], path: "RESULT.TXT" });
			},
			(m: any) => {
				m.files[0].path = "result.txt:stream";
			},
			(m: any) => {
				m.status = "tests_failed";
			},
		]) {
			const altered = structuredClone(manifest);
			mutate(altered);
			expect(() => validateResult(identity, altered)).toThrow();
		}
	});
});

// Re-review 95958066 finding 1: nested repositories are discovered from the
// workspace filesystem itself, independent of Git status and every ignore source.
describe("round-3 review regressions: filesystem nested-repository discovery", () => {
	const gitOk = async (argv: string[], cwd: string) => {
		const r = await run(["git", "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...argv], cwd);
		if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
		return r.stdout;
	};
	const nestedRepo = async (dir: string, secret: string) => {
		await mkdir(dir, { recursive: true });
		await gitOk(["init", dir], dir);
		await writeFile(join(dir, "answer.txt"), secret);
	};
	const ignoreVectors: [string, (f: any, identity: any) => Promise<void>][] = [
		["in-tree .gitignore", async (_f, identity) => writeFile(join(identity.path, ".gitignore"), "nested/\n")],
		["repository info/exclude", async (f) => {
			await mkdir(join(f.repo, ".git", "info"), { recursive: true });
			await writeFile(join(f.repo, ".git", "info", "exclude"), "nested/\n");
		}],
		["repository core.excludesFile", async (f) => {
			const file = join(f.dir, "global-excludes");
			await writeFile(file, "nested/\n");
			await gitOk(["-C", f.repo, "config", "core.excludesFile", file], f.dir);
		}],
		["collector HOME global excludes", async (_f, identity) => {
			await mkdir(join(identity.path, ".config", "git"), { recursive: true });
			await writeFile(join(identity.path, ".config", "git", "ignore"), "nested/\n.config/\n");
		}],
	];
	for (const [label, ignore] of ignoreVectors)
		test(`ignored nested repository is excluded and makes export incomplete (${label})`, async () => {
			const f = await fixture();
			const identity = await prepareWorkspace(f.input);
			await ignore(f, identity);
			await nestedRepo(join(identity.path, "nested"), "IGNORED_NESTED_SECRET");
			const result = await collectResult(identity, [await testWorkspace(identity, ["git", "status", "--porcelain"])]);
			expect(result.exclusions).toEqual([{ path: "nested", reason: "nested_repository", outerTrackedEntries: 0 }]);
			expect(result.exportComplete).toBe(false);
			expect(result.status).toBe("verified");
			expect(JSON.stringify(result)).not.toContain("IGNORED_NESTED_SECRET");
			expect(() => validateResult(identity, result)).not.toThrow();
		});
	test("repositories and embedded worktrees deep inside ignored ordinary directories are excluded", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "build/\nscratch/\n");
		await nestedRepo(join(identity.path, "build", "deep", "a", "repo"), "DEEP_SECRET");
		await mkdir(join(identity.path, "scratch"), { recursive: true });
		await gitOk(["-C", f.repo, "worktree", "add", "--detach", join(identity.path, "scratch", "wt"), f.baseCommit], f.dir);
		await writeFile(join(identity.path, "scratch", "wt", "hidden.txt"), "WORKTREE_SECRET");
		await writeFile(join(identity.path, "build", "output.log"), "ordinary ignored build output");
		const result = await collectResult(identity, []);
		expect(result.exclusions).toEqual([
			{ path: "build/deep/a/repo", reason: "nested_repository", outerTrackedEntries: 0 },
			{ path: "scratch/wt", reason: "nested_repository", outerTrackedEntries: 0 },
		]);
		expect(result.exportComplete).toBe(false);
		expect(result.files.map((file) => file.path)).toEqual([".gitignore"]);
		for (const secret of ["DEEP_SECRET", "WORKTREE_SECRET", "ordinary ignored build output"])
			expect(JSON.stringify(result)).not.toContain(secret);
	});
	// Round 9: a gitlink can only come from the worker's index, which the node never reads;
	// a base gitlink is refused at preparation.
	test("tracked, untracked, ignored and .git-symlink boundaries each yield exactly one exclusion; a staged gitlink is not a boundary", async () => {
		const f = await fixture();
		await commitBase(f, { "tracked/a.txt": "outer" });
		const identity = await prepareWorkspace(f.input);
		await gitOk(["init", join(identity.path, "tracked")], f.dir);
		await nestedRepo(join(identity.path, "untracked"), "U");
		await writeFile(join(identity.path, ".gitignore"), "ignored/\n");
		await nestedRepo(join(identity.path, "ignored"), "I");
		await gitOk(["update-index", "--add", "--cacheinfo", `160000,${f.baseCommit},link`], identity.path);
		await mkdir(join(identity.path, "linked"));
		await symlink(join(f.dir, "does-not-matter"), join(identity.path, "linked", ".git"));
		const result = await collectResult(identity, []);
		expect(result.exclusions).toEqual([
			{ path: "ignored", reason: "nested_repository", outerTrackedEntries: 0 },
			{ path: "linked", reason: "nested_repository", outerTrackedEntries: 0 },
			{ path: "tracked", reason: "nested_repository", outerTrackedEntries: 1 },
			{ path: "untracked", reason: "nested_repository", outerTrackedEntries: 0 },
		]);
		expect(result.files.map((file) => file.path)).toEqual([".gitignore"]);
		expect(await collectResult(identity, [])).toEqual(result);
	});
	// Review 5cf4c1e0 HIGH-1 replaced the earlier "only in-tree rules apply" test:
	// nothing Git ignores is exported, under any ignore source.
	test("in-tree-ignored paths are listed, never exported, and keep the export complete; out-of-tree-ignored paths are exclusions", async () => {
		const f = await fixture();
		// Operator rules are fixed at preparation.
		await mkdir(join(f.repo, ".git", "info"), { recursive: true });
		await writeFile(join(f.repo, ".git", "info", "exclude"), "hidden-info.txt\n");
		const excludes = join(f.dir, "config-excludes");
		await writeFile(excludes, "hidden-config.txt\n");
		await gitOk(["-C", f.repo, "config", "core.excludesFile", excludes], f.dir);
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "*.log\ncache-dir/\n");
		await writeFile(join(identity.path, "debug.log"), "IGNORED_BY_TREE_RULE");
		await mkdir(join(identity.path, "cache-dir"));
		await writeFile(join(identity.path, "cache-dir", "x"), "IGNORED_DIR_BY_TREE_RULE");
		const clean = await collectResult(identity, []);
		expect(clean.files.map((file) => file.path)).toEqual([".gitignore"]);
		expect(clean.exclusions).toEqual([]);
		expect(clean.exportComplete).toBe(true);
		expect(clean.ignored).toEqual({ count: 2, unlisted: 0, paths: ["cache-dir/", "debug.log"] });
		expect(() => validateResult(identity, clean)).not.toThrow();
		for (const name of ["hidden-info.txt", "hidden-config.txt"])
			await writeFile(join(identity.path, name), "OUT_OF_TREE_SECRET " + name);
		const result = await collectResult(identity, []);
		expect(result.files.map((file) => file.path)).toEqual([".gitignore"]);
		expect(result.exclusions).toEqual([
			{ path: "hidden-config.txt", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "excludes_file" },
			{ path: "hidden-info.txt", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
		]);
		expect(result.exportComplete).toBe(false);
		expect(result.ignored).toEqual({ count: 2, unlisted: 0, paths: ["cache-dir/", "debug.log"] });
		for (const secret of ["IGNORED_BY_TREE_RULE", "IGNORED_DIR_BY_TREE_RULE", "OUT_OF_TREE_SECRET"])
			expect(JSON.stringify(result)).not.toContain(secret);
		expect(() => validateResult(identity, result)).not.toThrow();
	});
	// Round 5 (b85877e2): collected as an incomplete export instead of refused.
	test("ignore rules that are themselves ignored (invisible to the export) make what they hide an exclusion", async () => {
		const unexported = (path: string, outerTrackedEntries = 0) => ({ path, reason: "ignored_out_of_tree", outerTrackedEntries, source: "unexported_gitignore" });
		for (const [rules, extra, exclusions, ignored] of [
			[".gitignore\nsecret-out/\n", undefined, [unexported(".gitignore")], []],
			["sub/.gitignore\n", "sub", [unexported("sub/deliverable.txt")], ["sub/.gitignore"]],
		] as const) {
			const f = await fixture();
			const identity = await prepareWorkspace(f.input);
			await writeFile(join(identity.path, ".gitignore"), rules);
			if (extra) {
				await mkdir(join(identity.path, extra));
				await writeFile(join(identity.path, extra, ".gitignore"), "deliverable.txt\n");
				await writeFile(join(identity.path, extra, "deliverable.txt"), "HIDDEN");
			}
			const result = await collectResult(identity, []);
			expect(result.exclusions).toEqual(exclusions as any);
			expect(result.ignored).toEqual({ count: ignored.length, unlisted: 0, paths: [...ignored] });
			expect(result.exportComplete).toBe(false);
			expect(JSON.stringify(result)).not.toContain("HIDDEN");
			expect(() => validateResult(identity, result)).not.toThrow();
		}
	});
	test("discovery never follows symlinks; an ignored symlink to an outside repository adds no exclusion", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const outside = join(f.dir, "outside-repo");
		await nestedRepo(outside, "OUTSIDE");
		await writeFile(join(identity.path, ".gitignore"), "outside-link\n");
		await symlink(outside, join(identity.path, "outside-link"));
		const result = await collectResult(identity, []);
		expect(result.exclusions).toEqual([]);
		expect(result.exportComplete).toBe(true);
		expect(JSON.stringify(result)).not.toContain("OUTSIDE");
	});
	test("discovery is bounded, never descends into a found repository or the outer .git, and fails closed at its limits", async () => {
		const { scanWorkspaceRepositories } = (await import("../src/workspace")) as any;
		expect(typeof scanWorkspaceRepositories).toBe("function");
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await nestedRepo(join(identity.path, "big"), "x");
		for (let i = 0; i < 40; i++) await writeFile(join(identity.path, "big", `f${i}`), "x");
		// The outer repository's own .git (a file in a worktree) and the nested
		// repository's contents are never listed, so a small budget suffices.
		expect(await scanWorkspaceRepositories(identity.path, { maxEntries: 8 })).toEqual(["big"]);
		for (let i = 0; i < 20; i++) await writeFile(join(identity.path, `wide${i}`), "x");
		await expect(scanWorkspaceRepositories(identity.path, { maxEntries: 10 })).rejects.toThrow("workspace_scan_limit");
	});
});

// Re-review 5cf4c1e0 HIGH-1: the export never contains a path Git itself would
// ignore in the workspace on this node, under any ignore source. Paths hidden
// only by out-of-tree sources are explicit exclusions (export incomplete).
describe("round-4 review regressions: full Git ignore semantics", () => {
	const gitOk = async (argv: string[], cwd: string) => {
		const r = await run(["git", "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...argv], cwd);
		if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
		return r.stdout;
	};
	const files = (result: any) => result.files.map((file: any) => file.path);
	const infoExclude = async (f: any, rules: string) => {
		await mkdir(join(f.repo, ".git", "info"), { recursive: true });
		await writeFile(join(f.repo, ".git", "info", "exclude"), rules);
	};
	/** Point the node's real HOME / XDG_CONFIG_HOME at fixture directories. */
	const withNodeEnv = async <T>(env: { HOME?: string; XDG_CONFIG_HOME?: string }, body: () => Promise<T>) => {
		const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		try {
			return await body();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
	const expectHidden = async (identity: any, path: string, secret: string, source: IgnoreSource = "excludes_file") => {
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["deliverable.txt"]);
		expect(result.exclusions).toEqual([{ path, reason: "ignored_out_of_tree" as const, outerTrackedEntries: 0, source }]);
		expect(result.exportComplete).toBe(false);
		expect(JSON.stringify(result)).not.toContain(secret);
		expect(() => validateResult(identity, result)).not.toThrow();
		return result;
	};
	test("reviewer S1: a file ignored only by the repository info/exclude is never exported", async () => {
		const f = await fixture();
		await infoExclude(f, "local-settings.json\n");
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "local-settings.json"), '{"apiToken":"INFO_EXCLUDE_SECRET_TOKEN"}');
		await expectHidden(identity, "local-settings.json", "INFO_EXCLUDE_SECRET_TOKEN", "info_exclude");
	});
	// Round 9: the repository-selected excludes file is read at preparation (node HOME then).
	test("reviewer S2: repository core.excludesFile applies, and ~ expands to the node HOME, not the workspace", async () => {
		const f = await fixture();
		const home = join(f.dir, "node-home");
		await mkdir(home);
		await writeFile(join(home, "excludes"), "dev.db.dump\n");
		await gitOk(["-C", f.repo, "config", "core.excludesFile", "~/excludes"], f.dir);
		const identity = await withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => prepareWorkspace(f.input));
		// Changing the file or the setting after preparation changes nothing.
		await writeFile(join(home, "excludes"), "");
		await gitOk(["-C", f.repo, "config", "core.excludesFile", "/dev/null"], f.dir);
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "dev.db.dump"), "CORE_EXCLUDESFILE_SECRET");
		await withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => expectHidden(identity, "dev.db.dump", "CORE_EXCLUDESFILE_SECRET"));
	});
	test("reviewer S3: $XDG_CONFIG_HOME/git/ignore (Git's default global excludes) applies", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const xdg = join(f.dir, "xdg");
		await mkdir(join(xdg, "git"), { recursive: true });
		await writeFile(join(xdg, "git", "ignore"), "session.cookie\n");
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "session.cookie"), "XDG_GLOBAL_SECRET");
		await withNodeEnv({ XDG_CONFIG_HOME: xdg }, () => expectHidden(identity, "session.cookie", "XDG_GLOBAL_SECRET"));
	});
	test("$HOME/.config/git/ignore of the node applies when XDG_CONFIG_HOME is unset or empty", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const home = join(f.dir, "node-home");
		await mkdir(join(home, ".config", "git"), { recursive: true });
		await writeFile(join(home, ".config", "git", "ignore"), "terraform.tfstate\n");
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "terraform.tfstate"), "HOME_GLOBAL_SECRET");
		for (const xdg of [undefined, ""])
			await withNodeEnv({ HOME: home, XDG_CONFIG_HOME: xdg }, () => expectHidden(identity, "terraform.tfstate", "HOME_GLOBAL_SECRET"));
	});
	// Round 9: repository rules are snapshotted at preparation, so a later repository
	// setting is not a source at all; the node's own (live) excludes file inside the
	// workspace is refused.
	test("worker-writable in-workspace ignore files are not ignore sources; a node excludes file inside the workspace is refused", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const home = join(f.dir, "empty-home");
		await mkdir(home);
		await mkdir(join(identity.path, ".config", "git"), { recursive: true });
		await writeFile(join(identity.path, ".config", "git", "ignore"), "hidden-home.txt\n");
		await writeFile(join(identity.path, "hidden-home.txt"), "VISIBLE_DELIVERABLE");
		const result = await withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => collectResult(identity, []));
		expect(files(result)).toEqual([".config/git/ignore", "hidden-home.txt"]);
		expect(result.exportComplete).toBe(true);
		for (const value of [join(identity.path, ".config", "git", "ignore"), "relative-rules"]) {
			await gitOk(["-C", f.repo, "config", "core.excludesFile", value], f.dir);
			const after = await withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => collectResult(identity, []));
			expect({ ...after, tests: [] }).toEqual({ ...result, tests: [] });
		}
		// Forward slashes: a Windows path in a .gitconfig value is otherwise read as escapes (review fx-093cc54b F5).
		await writeFile(join(home, ".gitconfig"), "[core]\n\texcludesFile = " + join(identity.path, ".config", "git", "ignore").replace(/\\/g, "/") + "\n");
		await expect(withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => collectResult(identity, []))).rejects.toThrow("ignore_rules_inside_workspace");
		// Through a node-side symlink into the workspace: still refused.
		await symlink(join(identity.path, ".config"), join(home, "linked"));
		await writeFile(join(home, ".gitconfig"), "[core]\n\texcludesFile = ~/linked/git/ignore\n");
		await expect(withNodeEnv({ HOME: home, XDG_CONFIG_HOME: undefined }, () => collectResult(identity, []))).rejects.toThrow("ignore_rules_inside_workspace");
	});
	test("negation patterns: an in-tree negation never un-ignores an operator rule; Git precedence decides everything else", async () => {
		const f = await fixture();
		await infoExclude(f, "keep.log\n!debug.log\n*.tmp\n!a.tmp\n");
		const identity = await prepareWorkspace(f.input);
		// Git lets the in-tree `!keep.log` beat info/exclude; the operator's rule wins here (review
		// rv10 MEDIUM-1): keep.log is withheld as an out-of-tree exclusion. An info/exclude negation
		// still cannot un-ignore an in-tree rule, and its own negation still applies (a.tmp).
		await writeFile(join(identity.path, ".gitignore"), "*.log\n!keep.log\n");
		for (const name of ["keep.log", "debug.log", "a.tmp", "b.tmp"])
			await writeFile(join(identity.path, name), "NEGATION_" + name);
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "a.tmp"]);
		expect(result.exclusions).toEqual([
			{ path: "b.tmp", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
			{ path: "keep.log", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
		]);
		expect(result.exportComplete).toBe(false);
		expect(result.ignored).toEqual({ count: 1, unlisted: 0, paths: ["debug.log"] });
		for (const secret of ["NEGATION_debug.log", "NEGATION_b.tmp", "NEGATION_keep.log"]) expect(JSON.stringify(result)).not.toContain(secret);
		// Git's own decisions, for reference: only keep.log differs (operator rule over in-tree negation).
		for (const [name, ignored] of [["keep.log", false], ["debug.log", true], ["a.tmp", false], ["b.tmp", true]] as const)
			expect((await run(["git", "-C", identity.path, "check-ignore", "-q", name], identity.path)).exit).toBe(ignored ? 0 : 1);
	});
	test("nested .gitignore files apply only below their directory", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "sub", "deeper"), { recursive: true });
		await writeFile(join(identity.path, "sub", ".gitignore"), "local.txt\n!deeper/local.txt\n");
		for (const path of ["local.txt", "sub/local.txt", "sub/deeper/local.txt"])
			await writeFile(join(identity.path, path), "NESTED_RULE " + path);
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["local.txt", "sub/.gitignore", "sub/deeper/local.txt"]);
		expect(result.ignored).toEqual({ count: 1, unlisted: 0, paths: ["sub/local.txt"] });
		expect(result.exportComplete).toBe(true);
		expect(JSON.stringify(result)).not.toContain("NESTED_RULE sub/local.txt");
	});
	test("an ignored directory containing a nested repository is explicit for in-tree and out-of-tree rules", async () => {
		// Operator rules are fixed at preparation: one workspace per rule set.
		const prepared = async (operatorRules?: string) => {
			const f = await fixture();
			if (operatorRules) await infoExclude(f, operatorRules);
			const identity = await prepareWorkspace(f.input);
			await mkdir(join(identity.path, "vendor", "x"), { recursive: true });
			await gitOk(["init", join(identity.path, "vendor", "x")], f.dir);
			await writeFile(join(identity.path, "vendor", "x", "f.txt"), "NESTED_IN_IGNORED");
			await writeFile(join(identity.path, "vendor", "plain.txt"), "PLAIN_IN_IGNORED");
			return identity;
		};
		const first = await prepared();
		await writeFile(join(first.path, ".gitignore"), "vendor/\n");
		const inTree = await collectResult(first, []);
		expect(inTree.exclusions).toEqual([{ path: "vendor/x", reason: "nested_repository", outerTrackedEntries: 0 }]);
		expect(inTree.ignored).toEqual({ count: 1, unlisted: 0, paths: ["vendor/"] });
		expect(inTree.exportComplete).toBe(false);
		expect(() => validateResult(first, inTree)).not.toThrow();
		const second = await prepared("vendor/\n");
		await writeFile(join(second.path, ".gitignore"), "");
		const outOfTree = await collectResult(second, []);
		expect(outOfTree.exclusions).toEqual([
			{ path: "vendor", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
			{ path: "vendor/x", reason: "nested_repository", outerTrackedEntries: 0 },
		]);
		expect(outOfTree.ignored).toEqual({ count: 0, unlisted: 0, paths: [] });
		expect(files(outOfTree)).toEqual([".gitignore"]);
		for (const secret of ["NESTED_IN_IGNORED", "PLAIN_IN_IGNORED"]) {
			expect(JSON.stringify(inTree)).not.toContain(secret);
			expect(JSON.stringify(outOfTree)).not.toContain(secret);
		}
		expect(() => validateResult(second, outOfTree)).not.toThrow();
		// An ignored nested repository root itself: the repository boundary wins.
		const third = await prepared("vendor/x/\n");
		expect((await collectResult(third, [])).exclusions).toEqual([{ path: "vendor/x", reason: "nested_repository", outerTrackedEntries: 0 }]);
	});
	test("tracked files win over every ignore source, as in Git; a worker cannot untrack a base-tracked file", async () => {
		const f = await fixture();
		await infoExclude(f, "tracked.txt\ndeleted.txt\n");
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "tracked.txt\n");
		await writeFile(join(identity.path, "tracked.txt"), "TRACKED_CHANGE\n");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "tracked.txt"]);
		expect(Buffer.from(result.files[1]!.contentBase64, "base64").toString()).toBe("TRACKED_CHANGE\n");
		expect(result.patch).toContain("+TRACKED_CHANGE");
		expect(result.exportComplete).toBe(true);
		// Round 9: the index is node-owned (the base tree). A worker `git rm --cached` does
		// not untrack: the path stays base-tracked, so its content is the deliverable.
		await gitOk(["rm", "--cached", "-q", "deleted.txt"], identity.path);
		await writeFile(join(identity.path, "deleted.txt"), "STILL_TRACKED_BYTES");
		await writeFile(join(identity.path, ".gitignore"), "tracked.txt\ndeleted.txt\n");
		const restaged = await collectResult(identity, []);
		expect(restaged.exclusions).toEqual([]);
		expect(restaged.ignored).toEqual({ count: 0, unlisted: 0, paths: [] });
		expect(files(restaged)).toEqual([".gitignore", "deleted.txt", "tracked.txt"]);
		expect(restaged.files.find((file) => file.path === "deleted.txt")).toMatchObject({ deleted: false, type: "regular" });
		expect(restaged.patch).toContain("+STILL_TRACKED_BYTES");
		// Untracking is deleting the file: only the deletion is exported.
		await unlink(join(identity.path, "deleted.txt"));
		const removed = await collectResult(identity, []);
		expect(removed.files.find((file) => file.path === "deleted.txt")).toMatchObject({ deleted: true, bytes: 0, contentBase64: "" });
		expect(() => validateResult(identity, removed)).not.toThrow();
	});
	test("an out-of-tree-ignored directory is not an exclusion when every path in it is ignored in-tree", async () => {
		const f = await fixture();
		await infoExclude(f, "out/\n");
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "out", "build"), { recursive: true });
		await writeFile(join(identity.path, "out", "build", "o"), "BUILD");
		await writeFile(join(identity.path, ".gitignore"), "out/build/\n");
		const complete = await collectResult(identity, []);
		expect(complete.exclusions).toEqual([]);
		expect(complete.ignored).toEqual({ count: 1, unlisted: 0, paths: ["out/"] });
		await writeFile(join(identity.path, "out", "new.txt"), "OUT_OF_TREE_HIDDEN");
		const incomplete = await collectResult(identity, []);
		expect(incomplete.exclusions).toEqual([{ path: "out", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" }]);
		expect(JSON.stringify(incomplete)).not.toContain("OUT_OF_TREE_HIDDEN");
	});
	test("the ignored list is bounded and sorted while the count stays exact", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "*.log\n");
		for (let i = 0; i < 300; i++) await writeFile(join(identity.path, `f${String(i).padStart(3, "0")}.log`), "x");
		const result = await collectResult(identity, []);
		expect(result.ignored!.count).toBe(300);
		expect(result.ignored!.paths).toHaveLength(256);
		expect(result.ignored!.paths[0]).toBe("f000.log");
		expect(result.ignored!.paths[255]).toBe("f255.log");
		expect(() => validateResult(identity, result)).not.toThrow();
	});
	// Round 5 (b85877e2): rules that are not exported no longer abort collection
	// (base shapes such as pytest/venv self-ignoring caches must collect); what
	// they hide is an exclusion naming the unexported rule file as its source.
	test("a .gitignore hidden by an out-of-tree source: what its rules hide is an exclusion", async () => {
		const f = await fixture();
		await infoExclude(f, "sub/.gitignore\n");
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "sub"));
		await writeFile(join(identity.path, "sub", ".gitignore"), "deliverable.txt\n");
		await writeFile(join(identity.path, "sub", "deliverable.txt"), "HIDDEN");
		const result = await collectResult(identity, []);
		expect(result.exclusions).toEqual([
			{ path: "sub/.gitignore", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "info_exclude" },
			{ path: "sub/deliverable.txt", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "unexported_gitignore" },
		]);
		expect(result.exportComplete).toBe(false);
		expect(files(result)).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("HIDDEN");
		expect(() => validateResult(identity, result)).not.toThrow();
	});
	test("validateResult binds the ignored summary and ignore exclusions", async () => {
		const f = await fixture();
		await infoExclude(f, "vendor/\n");
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "*.log\n");
		await writeFile(join(identity.path, "a.log"), "x");
		await mkdir(join(identity.path, "vendor", "x"), { recursive: true });
		await gitOk(["init", join(identity.path, "vendor", "x")], f.dir);
		const manifest = await collectResult(identity, []);
		expect(manifest.exclusions!.map((entry) => entry.path)).toEqual(["vendor", "vendor/x"]);
		expect(() => validateResult(identity, manifest)).not.toThrow();
		for (const mutate of [
			(m: any) => delete m.ignored,
			(m: any) => (m.ignored = null),
			(m: any) => (m.ignored.count = 0),
			(m: any) => (m.ignored.paths = ["b.log", "a.log"]),
			(m: any) => (m.ignored.paths = ["../a.log"]),
			(m: any) => (m.ignored.extra = 1),
			(m: any) => (m.ignored.count = 2),
			(m: any) => m.files.push({ path: "a.log", bytes: 0, sha256: sha256(""), contentBase64: "", deleted: false, mode: 0o644, type: "regular" }),
			// Only a repository boundary may lie inside an ignored_out_of_tree exclusion.
			(m: any) => (m.exclusions = [m.exclusions[1], { ...m.exclusions[1], path: "vendor/x/y", reason: "ignored_out_of_tree" }]),
			(m: any) => (m.exclusions = [{ ...m.exclusions[1], path: "vendor" }, m.exclusions[0]]),
			(m: any) => (m.exclusions[1].reason = "ignored_out_of_tree"),
			(m: any) => (m.exclusions = [m.exclusions[0]], m.exportComplete = true),
		]) {
			const altered = structuredClone(manifest);
			mutate(altered);
			expect(() => validateResult(identity, altered)).toThrow();
		}
		const legacy: any = structuredClone(manifest);
		delete legacy.exclusions;
		delete legacy.exportComplete;
		expect(() => validateResult(identity, legacy)).toThrow();
		delete legacy.ignored;
		expect(() => validateResult(identity, legacy)).toThrow();
		delete legacy.junk;
		expect(() => validateResult(identity, legacy)).not.toThrow();
	});
	test("review LOW-2: an unreadable directory fails closed with a bounded code and no host path", async () => {
		if (process.platform === "win32" || process.getuid?.() === 0) return;
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "locked/\n");
		await mkdir(join(identity.path, "locked"));
		await chmod(join(identity.path, "locked"), 0);
		try {
			const error = await collectResult(identity, []).then(() => undefined, (e) => e);
			expect(error?.message).toBe("workspace_scan_unreadable");
		} finally {
			await chmod(join(identity.path, "locked"), 0o700);
		}
	});
});

// Review b85877e2 (round 5): every workspace shape the base collects still
// collects; ignored names that are not portable never abort; out-of-tree
// classification is batched; OS junk does not by itself make an export incomplete.
describe("round-5 review regressions: robust ignore classification", () => {
	const gitOk = async (argv: string[], cwd: string) => {
		const r = await run(["git", "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...argv], cwd);
		if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
		return r.stdout;
	};
	const files = (result: any) => result.files.map((file: any) => file.path);
	const infoExclude = async (f: any, rules: string) => {
		await mkdir(join(f.repo, ".git", "info"), { recursive: true });
		await writeFile(join(f.repo, ".git", "info", "exclude"), rules);
	};
	const withXdg = async <T>(f: any, rules: string, body: () => Promise<T>) => {
		const xdg = join(f.dir, "xdg");
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
	};
	const none = { count: 0, unlisted: 0, paths: [] };
	const outOfTree = (path: string, source: IgnoreSource, outerTrackedEntries = 0) =>
		({ path, reason: "ignored_out_of_tree" as const, outerTrackedEntries, source });
	const unlisted = (path: string, count: number, outerTrackedEntries = 0) =>
		({ path, reason: "unlisted" as const, count, outerTrackedEntries });
	const valid = (identity: any, result: any) => expect(() => validateResult(identity, result)).not.toThrow();

	// Names Windows cannot create (review fx-093cc54b F5).
	test.skipIf(process.platform === "win32")("MEDIUM-1 M10d/M10: in-tree-ignored names that are not portable are counted, not listed, and never abort", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "nul\n*.log\n");
		await writeFile(join(identity.path, "nul"), "NUL_BYTES");
		await writeFile(join(identity.path, "a\nb.log"), "NEWLINE_BYTES");
		await writeFile(join(identity.path, "plain.log"), "PLAIN_LOG");
		await writeFile(join(identity.path, "ok.txt"), "ok");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual([".gitignore", "ok.txt"]);
		expect(result.exclusions).toEqual([]);
		expect(result.exportComplete).toBe(true);
		expect(result.ignored).toEqual({ count: 3, unlisted: 2, paths: ["plain.log"] });
		for (const secret of ["NUL_BYTES", "NEWLINE_BYTES", "PLAIN_LOG"]) expect(JSON.stringify(result)).not.toContain(secret);
		valid(identity, result);
	});
	test("MEDIUM-1 M10e/M09: out-of-tree-ignored names that are not portable are counted at the nearest safe ancestor or the root marker", async () => {
		const f = await fixture();
		await infoExclude(f, "*.bak.\ntrailing\\ \n");
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "sub"));
		await writeFile(join(identity.path, "sub", "y.bak."), "SUB_BAK");
		await writeFile(join(identity.path, "sub", "ok.txt"), "ok");
		await writeFile(join(identity.path, "ok.txt"), "ok");
		const nested = await collectResult(identity, []);
		expect(files(nested)).toEqual(["ok.txt", "sub/ok.txt"]);
		expect(nested.exclusions).toEqual([unlisted("sub", 1)]);
		expect(nested.exportComplete).toBe(false);
		valid(identity, nested);
		// At the workspace root the nearest portable ancestor is the root marker (round 6: counted, never merged).
		await writeFile(join(identity.path, "x.bak."), "ROOT_BAK");
		await writeFile(join(identity.path, "trailing "), "TRAILING");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["ok.txt", "sub/ok.txt"]);
		expect(result.exclusions).toEqual([unlisted(".", 2), unlisted("sub", 1)]);
		expect(result.exportComplete).toBe(false);
		for (const secret of ["ROOT_BAK", "SUB_BAK", "TRAILING"]) expect(JSON.stringify(result)).not.toContain(secret);
		valid(identity, result);
	});
	// A name Windows cannot create (review fx-093cc54b F5).
	test.skipIf(process.platform === "win32")("MEDIUM-1 M10b: a Finder Icon\\r file in a global ignore is OS junk: counted, unlisted, export complete", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, "Icon\r"), "");
		await writeFile(join(identity.path, "ok.txt"), "ok");
		const result = await withXdg(f, "Icon\r\r\n", () => collectResult(identity, []));
		expect(files(result)).toEqual(["ok.txt"]);
		expect(result.exclusions).toEqual([]);
		expect(result.exportComplete).toBe(true);
		expect(result.junk).toEqual({ count: 1, unlisted: 1, paths: [] });
		valid(identity, result);
	});
	test("LOW-3 J1/J2: OS junk ignored only out of tree is listed and counted but keeps the export complete; no directory collapse", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "src"));
		await mkdir(join(identity.path, "img"));
		for (const path of [".DS_Store", "src/.DS_Store", "img/Thumbs.db", "img/desktop.ini"]) await writeFile(join(identity.path, path), "JUNK_BYTES");
		await writeFile(join(identity.path, "src", "a.ts"), "deliverable");
		const result = await withXdg(f, ".DS_Store\nThumbs.db\ndesktop.ini\n", () => collectResult(identity, []));
		expect(files(result)).toEqual(["src/a.ts"]);
		expect(result.exclusions).toEqual([]);
		expect(result.exportComplete).toBe(true);
		expect(result.junk).toEqual({ count: 4, unlisted: 0, paths: [".DS_Store", "img/Thumbs.db", "img/desktop.ini", "src/.DS_Store"] });
		expect(JSON.stringify(result)).not.toContain("JUNK_BYTES");
		valid(identity, result);
	});
	test("LOW-3: any other out-of-tree-ignored file still makes the export incomplete and names its source; junk ignored in-tree is ordinary ignored", async () => {
		const f = await fixture();
		await infoExclude(f, "local.env.json\n");
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "pkg", "__pycache__"), { recursive: true });
		await writeFile(join(identity.path, "pkg", "__pycache__", "m.cpython-312.pyc"), "PYC");
		await writeFile(join(identity.path, "pkg", "m.py"), "print(1)");
		await writeFile(join(identity.path, "pkg", ".DS_Store"), "JUNK");
		await writeFile(join(identity.path, "local.env.json"), "INFO_SECRET");
		await writeFile(join(identity.path, ".gitignore"), "pkg/.DS_Store\n");
		const result = await withXdg(f, "__pycache__/\n.DS_Store\n", () => collectResult(identity, []));
		expect(files(result)).toEqual([".gitignore", "pkg/m.py"]);
		expect(result.exclusions).toEqual([outOfTree("local.env.json", "info_exclude"), outOfTree("pkg/__pycache__", "excludes_file")]);
		expect(result.exportComplete).toBe(false);
		expect(result.junk).toEqual(none);
		expect(result.ignored).toEqual({ count: 1, unlisted: 0, paths: ["pkg/.DS_Store"] });
		valid(identity, result);
	});
	test("LOW-1 M13: a .gitignore inside an out-of-tree-ignored directory never turns the export complete", async () => {
		const f = await fixture();
		await infoExclude(f, "secret/\n");
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "secret"));
		await writeFile(join(identity.path, "secret", ".gitignore"), "*\n");
		await writeFile(join(identity.path, "secret", "deliverable.ts"), "HIDDEN_DELIVERABLE");
		await writeFile(join(identity.path, "a.txt"), "a");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["a.txt"]);
		expect(result.exclusions).toEqual([outOfTree("secret", "info_exclude")]);
		expect(result.exportComplete).toBe(false);
		expect(result.ignored).toEqual(none);
		expect(JSON.stringify(result)).not.toContain("HIDDEN_DELIVERABLE");
		valid(identity, result);
	});
	test("M13b and tool caches: rules in a self-ignored .gitignore collect as an incomplete export instead of failing", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await mkdir(join(identity.path, "secret"));
		await writeFile(join(identity.path, "secret", ".gitignore"), "*\n");
		await writeFile(join(identity.path, "secret", "deliverable.ts"), "HIDDEN_DELIVERABLE");
		await mkdir(join(identity.path, ".pytest_cache", "v"), { recursive: true });
		await writeFile(join(identity.path, ".pytest_cache", ".gitignore"), "# Created by pytest automatically.\n*\n");
		await writeFile(join(identity.path, ".pytest_cache", "v", "lastfailed"), "{}");
		await writeFile(join(identity.path, "a.txt"), "a");
		const result = await collectResult(identity, []);
		expect(files(result)).toEqual(["a.txt"]);
		expect(result.exclusions).toEqual([
			outOfTree(".pytest_cache/.gitignore", "unexported_gitignore"),
			outOfTree(".pytest_cache/v", "unexported_gitignore"),
			outOfTree("secret/.gitignore", "unexported_gitignore"),
			outOfTree("secret/deliverable.ts", "unexported_gitignore"),
		]);
		expect(result.exportComplete).toBe(false);
		expect(JSON.stringify(result)).not.toContain("HIDDEN_DELIVERABLE");
		valid(identity, result);
		// Declared by an exported rule, the same caches are ordinary in-tree ignored output.
		await writeFile(join(identity.path, ".gitignore"), ".pytest_cache/\nsecret/\n");
		const declared = await collectResult(identity, []);
		expect(declared.exclusions).toEqual([]);
		expect(declared.ignored).toEqual({ count: 2, unlisted: 0, paths: [".pytest_cache/", "secret/"] });
	});
	test("LOW-2 W2/W3/W4: worker config cannot redirect the node's global excludes", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "session.cookie"), "NODE_GLOBAL_SECRET");
		await writeFile(join(identity.path, "evil.cfg"), "[core]\n\texcludesFile = /dev/null\n");
		const vectors: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
			["W2", () => gitOk(["config", "core.excludesFile", "/dev/null"], identity.path), () => gitOk(["config", "--unset", "core.excludesFile"], identity.path)],
			["W3", () => gitOk(["config", "include.path", join(identity.path, "evil.cfg")], identity.path), () => gitOk(["config", "--unset", "include.path"], identity.path)],
			["W4", async () => {
				await gitOk(["config", "extensions.worktreeConfig", "true"], identity.path);
				await gitOk(["config", "--worktree", "core.excludesFile", "/dev/null"], identity.path);
			}, () => gitOk(["config", "--worktree", "--unset", "core.excludesFile"], identity.path)],
		];
		for (const [label, apply, undo] of vectors) {
			await apply();
			const result = await withXdg(f, "session.cookie\n", () => collectResult(identity, []));
			expect([label, files(result)]).toEqual([label, ["deliverable.txt", "evil.cfg"]]);
			expect([label, result.exclusions]).toEqual([label, [outOfTree("session.cookie", "excludes_file")]]);
			expect(JSON.stringify(result)).not.toContain("NODE_GLOBAL_SECRET");
			valid(identity, result);
			await undo();
		}
	});
	test("round-8 MEDIUM-A: a worker worktree config redirecting core.worktree changes nothing the node collects", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		const elsewhere = join(f.dir, "elsewhere");
		await mkdir(elsewhere);
		await writeFile(join(elsewhere, "other.txt"), "ELSEWHERE_BYTES");
		await writeFile(join(identity.path, ".gitignore"), "secret.env\n");
		await writeFile(join(identity.path, "secret.env"), "MEDIUM_A_SECRET");
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		const clean = await collectResult(identity, []);
		await gitOk(["config", "extensions.worktreeConfig", "true"], identity.path);
		await gitOk(["config", "--worktree", "core.worktree", elsewhere], identity.path);
		await gitOk(["config", "--worktree", "core.excludesFile", "/dev/null"], identity.path);
		const redirected = await collectResult(identity, []);
		expect(files(redirected)).toEqual([".gitignore", "deliverable.txt"]);
		expect(redirected.ignored).toEqual({ count: 1, unlisted: 0, paths: ["secret.env"] });
		expect(JSON.stringify(redirected)).not.toContain("MEDIUM_A_SECRET");
		expect(JSON.stringify(redirected)).not.toContain("ELSEWHERE_BYTES");
		expect({ ...redirected, tests: [] }).toEqual({ ...clean, tests: [] });
		valid(identity, redirected);
	});
	test("LOW-2 W10: a worker-written info/exclude negation cannot re-include what the node's excludes file ignores", async () => {
		const f = await fixture();
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, "deliverable.txt"), "ok");
		await writeFile(join(identity.path, "session.cookie"), "W10_GLOBAL_SECRET");
		await mkdir(join(identity.path, "cache"));
		await writeFile(join(identity.path, "cache", "blob"), "W10_CACHE_SECRET");
		// The shared $GIT_COMMON_DIR/info/exclude is writable from the workspace.
		await infoExclude(f, "!session.cookie\n!cache/\n");
		const result = await withXdg(f, "session.cookie\ncache/\n", () => collectResult(identity, []));
		expect(files(result)).toEqual(["deliverable.txt"]);
		expect(result.exclusions).toEqual([outOfTree("cache", "excludes_file"), outOfTree("session.cookie", "excludes_file")]);
		expect(JSON.stringify(result)).not.toContain("W10_");
		valid(identity, result);
	});
	test("MEDIUM-2: thousands of individually ignored files never hit a listing or exclusion bound; out-of-tree entries aggregate", async () => {
		const f = await fixture();
		await infoExclude(f, "*.obj\n");
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "*.o\n");
		// 20,000 in-tree-ignored files with long names: the listing alone exceeds 4 MiB.
		const long = "x".repeat(200);
		await mkdir(join(identity.path, "obj"));
		for (let i = 0; i < 20000; i++) await writeFile(join(identity.path, "obj", `${long}-${i}.o`), "");
		await mkdir(join(identity.path, "win", "a"), { recursive: true });
		await mkdir(join(identity.path, "win", "b"), { recursive: true });
		for (let i = 0; i < 1100; i++) await writeFile(join(identity.path, "win", i % 2 ? "a" : "b", `${i}.obj`), "OBJ_BYTES");
		const started = performance.now();
		const result = await collectResult(identity, []);
		const elapsed = performance.now() - started;
		expect(result.ignored!.count).toBe(20000);
		expect(result.ignored!.unlisted).toBe(0);
		expect(result.ignored!.paths).toHaveLength(256);
		expect(result.exclusions).toEqual([outOfTree("win/a", "info_exclude"), outOfTree("win/b", "info_exclude")]);
		expect(result.exportComplete).toBe(false);
		expect(files(result)).toEqual([".gitignore"]);
		expect(JSON.stringify(result)).not.toContain("OBJ_BYTES");
		valid(identity, result);
		// Round 4 took 1.0 s for 10k and 31 s for 60k such files; batched classification is linear.
		// Loaded hosts can multiply that fast-host time; 15 s still bounds it well under the 120 s test timeout.
		expect(elapsed).toBeLessThan(15000);
	}, 120000);
	test("out-of-tree-ignored directories are declared in-tree only when exported rules hide all of them (few and many directories)", async () => {
		for (const packages of [4, 40]) {
			const f = await fixture();
			const identity = await prepareWorkspace(f.input);
			await writeFile(join(identity.path, ".gitignore"), "*.pyc\n");
			const expected: any[] = [];
			for (let i = 0; i < packages; i++) {
				const pkg = `pkg${String(i).padStart(2, "0")}`;
				await mkdir(join(identity.path, pkg, "__pycache__"), { recursive: true });
				await writeFile(join(identity.path, pkg, "m.py"), "x");
				await writeFile(join(identity.path, pkg, "__pycache__", "m.pyc"), "PYC");
				// Every third cache also holds a file the exported rules do not ignore.
				if (i % 3 === 0) {
					await writeFile(join(identity.path, pkg, "__pycache__", "notes.txt"), "VISIBLE_TO_TREE_RULES");
					expected.push(outOfTree(`${pkg}/__pycache__`, "excludes_file"));
				}
			}
			const result = await withXdg(f, "__pycache__/\n", () => collectResult(identity, []));
			expect([packages, result.exclusions]).toEqual([packages, expected]);
			expect(result.ignored!.count).toBe(packages - expected.length);
			expect(JSON.stringify(result)).not.toContain("VISIBLE_TO_TREE_RULES");
			valid(identity, result);
		}
	});
	// Round 9: the index is node-owned; only the filesystem against the base tree counts.
	test("a worker index removal is not a deletion; deleting a base-tracked ignored file exports the deletion only", async () => {
		const f = await fixture();
		await infoExclude(f, "deleted.txt\n");
		const identity = await prepareWorkspace(f.input);
		await gitOk(["rm", "--cached", "-q", "deleted.txt"], identity.path);
		const unchanged = await collectResult(identity, []);
		expect(unchanged.files).toEqual([]);
		expect(unchanged.exclusions).toEqual([]);
		expect(unchanged.exportComplete).toBe(true);
		await unlink(join(identity.path, "deleted.txt"));
		const result = await collectResult(identity, []);
		expect(result.exclusions).toEqual([]);
		expect(result.files).toEqual([{ path: "deleted.txt", bytes: 0, sha256: sha256(""), contentBase64: "", deleted: true, mode: 0, type: "deleted" }]);
		valid(identity, result);
	});
	// `nul` and `x.bak.` cannot be created on Windows (review fx-093cc54b F5).
	test.skipIf(process.platform === "win32")("validateResult binds the junk summary, unlisted counts and exclusion sources", async () => {
		const f = await fixture();
		await infoExclude(f, "*.bak.\nlocal.cfg\n");
		const identity = await prepareWorkspace(f.input);
		await writeFile(join(identity.path, ".gitignore"), "*.log\nnul\n");
		await writeFile(join(identity.path, "a.log"), "x");
		await writeFile(join(identity.path, "nul"), "x");
		await writeFile(join(identity.path, ".DS_Store"), "x");
		await writeFile(join(identity.path, "x.bak."), "x");
		await writeFile(join(identity.path, "local.cfg"), "x");
		// Junk only by the node's own excludes file (round 6 LOW-C).
		const manifest = await withXdg(f, ".DS_Store\n", () => collectResult(identity, []));
		expect(manifest.ignored).toEqual({ count: 2, unlisted: 1, paths: ["a.log"] });
		expect(manifest.junk).toEqual({ count: 1, unlisted: 0, paths: [".DS_Store"] });
		expect(manifest.exclusions).toEqual([unlisted(".", 1), outOfTree("local.cfg", "info_exclude")]);
		valid(identity, manifest);
		for (const mutate of [
			(m: any) => delete m.junk,
			(m: any) => (m.junk.count = 0),
			(m: any) => (m.junk.unlisted = -1),
			(m: any) => (m.ignored.unlisted = 0),
			(m: any) => delete m.ignored.unlisted,
			(m: any) => (m.junk.paths = ["../x"]),
			(m: any) => m.files.push({ path: ".DS_Store", bytes: 0, sha256: sha256(""), contentBase64: "", deleted: false, mode: 0o644, type: "regular" }),
			(m: any) => delete m.exclusions[1].source,
			(m: any) => (m.exclusions[1].source = "elsewhere"),
			(m: any) => (m.exclusions[0].source = "info_exclude"),
			(m: any) => (m.exclusions[0].count = 0),
			(m: any) => delete m.exclusions[0].count,
			(m: any) => (m.exclusions[0].reason = "nested_repository"),
			(m: any) => (m.exclusions[0].reason = "ignored_out_of_tree"),
			(m: any) => (m.exportComplete = true),
			(m: any) => (m.exclusions[0].path = "x.bak."),
			(m: any) => (m.exclusions = [m.exclusions[0], m.exclusions[0]]),
			(m: any) => (m.exclusions = [m.exclusions[1], outOfTree("local.cfg/a", "info_exclude")]),
		]) {
			const altered = structuredClone(manifest);
			mutate(altered);
			let error: unknown;
			try {
				validateResult(identity, altered);
			} catch (caught) {
				error = caught;
			}
			expect([String(mutate), error === undefined]).toEqual([String(mutate), false]);
		}
	});
});
