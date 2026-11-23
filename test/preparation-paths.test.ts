import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { nodeFailureCode } from "../src/store/shared";
import { nodeFailure } from "../src/node";
import { projectNodePreparationPaths } from "../src/placement-preflight";
import {
	gitAdminWorktreePath,
	projectPreparationPaths,
	requirePreparationPathPlatform,
	requireResolvedRoot,
	resolveGitCommonDir,
	win32PrepareWorktreeBasename,
} from "../src/workspace";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("Git common-dir preparation path projection (pure)", () => {
	test("requireResolvedRoot is syntactic resolve, not realpath", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fleet-resolve-root-"));
		tempDirs.push(dir);
		const target = join(dir, "target");
		const link = join(dir, "link");
		await mkdir(target);
		await Bun.write(join(target, ".keep"), "x");
		await symlink(target, link);
		expect(resolve(link)).toBe(link);
		expect(requireResolvedRoot(link, "repo")).toBe(link);
		const disk = await realpath(link);
		expect(disk).not.toBe(link);
		// realpath policy is caller-side; this helper still accepts the link path.
		expect(requireResolvedRoot(disk, "repo")).toBe(disk);
	});

	test("requires syntactically resolved absolute roots before common-dir interpretation", () => {
		expect(requireResolvedRoot(resolve("/repos/fleet"), "repo")).toBe(
			resolve("/repos/fleet"),
		);
		expect(() => requireResolvedRoot("repos/fleet", "repo")).toThrow(
			"unresolved_path_root:repo",
		);
		expect(() =>
			requireResolvedRoot(resolve("/repos/fleet") + "/../fleet", "repo"),
		).toThrow("unresolved_path_root:repo");
		expect(() => resolveGitCommonDir(".git", "relative-repo")).toThrow(
			"unresolved_path_root:repo",
		);
	});

	test("resolves relative and absolute common dirs against the repo root", () => {
		const repo = resolve("/repos/fleet");
		expect(resolveGitCommonDir(".git", repo)).toBe(resolve(repo, ".git"));
		expect(resolveGitCommonDir("/var/git/fleet.git", repo)).toBe(
			resolve("/var/git/fleet.git"),
		);
		expect(() => resolveGitCommonDir("  ", repo)).toThrow(
			"git_common_dir_missing",
		);
	});

	test("admin path is under common/worktrees, not join(repo,'.git') by fiat", () => {
		const common = resolve("/data/objects/fleet.git");
		const repoWorktree = resolve("/deep/checkouts/fleet");
		const basename = win32PrepareWorktreeBasename("task", "attempt");
		const projected = projectPreparationPaths({
			repoRoot: repoWorktree,
			commonDir: common,
			workspaceRoot: resolve("/work"),
			taskId: "task",
			attemptId: "attempt",
			platform: "win32",
		});
		expect(projected.commonDir).toBe(common);
		expect(projected.worktreeBasename).toBe(basename);
		expect(projected.adminPath).toBe(
			gitAdminWorktreePath(common, basename),
		);
		expect(projected.adminPath).toBe(
			join(common, "worktrees", basename),
		);
		expect(projected.adminPath.startsWith(join(repoWorktree, ".git"))).toBe(
			false,
		);
		expect(projected.checkoutPath).toBe(join(resolve("/work"), basename));
		expect(projected.finalPath).toBe(
			join(resolve("/work"), "task-attempt"),
		);
		expect(projected.lengths.adminPath).toBe(projected.adminPath.length);
	});

	test("naive repo/.git projection differs when common dir is external", () => {
		const repo = resolve("/Users/example/src/fleet");
		const common = resolve("/Volumes/git/fleet.git");
		const basename = win32PrepareWorktreeBasename("t1", "a1");
		const naive = join(repo, ".git", "worktrees", basename);
		const actual = projectPreparationPaths({
			repoRoot: repo,
			commonDir: common,
			workspaceRoot: resolve("/Users/example/work"),
			taskId: "t1",
			attemptId: "a1",
			platform: "win32",
		}).adminPath;
		expect(actual).not.toBe(naive);
		expect(actual).toBe(join(common, "worktrees", basename));
	});

	test("posix keeps checkout at the final task-attempt path", () => {
		const projected = projectPreparationPaths({
			repoRoot: resolve("/repos/fleet"),
			commonDir: ".git",
			workspaceRoot: resolve("/work"),
			taskId: "task",
			attemptId: "attempt",
			platform: "linux",
		});
		expect(projected.worktreeBasename).toBe("task-attempt");
		expect(projected.checkoutPath).toBe(projected.finalPath);
		expect(projected.adminPath).toBe(
			join(resolve("/repos/fleet/.git"), "worktrees", "task-attempt"),
		);
	});

	test("rejects unsafe worktree basenames", () => {
		expect(() =>
			gitAdminWorktreePath(resolve("/repo/.git"), "../x"),
		).toThrow("invalid_worktree_basename");
		expect(() => gitAdminWorktreePath(resolve("/repo/.git"), "")).toThrow(
			"invalid_worktree_basename",
		);
	});
});

describe("placement preflight path projection helper", () => {
	test("uses node os to choose win32 short basename", () => {
		const projected = projectNodePreparationPaths({
			repoRoot: resolve("/src/fleet"),
			commonDir: ".git",
			workspaceRoot: resolve("/work"),
			taskId: "task",
			attemptId: "attempt",
			os: "win32",
		});
		expect(projected.worktreeBasename.startsWith(".fleet-prepare-")).toBe(
			true,
		);
		expect(projected.worktreeBasename.length).toBe(
			".fleet-prepare-".length + 24,
		);
	});

	test("rejects unsupported node os without falling back to linux", () => {
		expect(() => requirePreparationPathPlatform("freebsd")).toThrow(
			"unsupported_node_os",
		);
		expect(() =>
			projectNodePreparationPaths({
				repoRoot: resolve("/src/fleet"),
				commonDir: ".git",
				workspaceRoot: resolve("/work"),
				taskId: "task",
				attemptId: "attempt",
				os: "freebsd",
			}),
		).toThrow("unsupported_node_os");
	});
});

describe("workspace_path_too_long refusal classification", () => {
	test("maps to typed path_budget pair, not internal", async () => {
		for (const message of [
			"workspace_path_too_long",
			"workspace_path_too_long:admin",
			"workspace_path_too_long:short_still_over_budget",
		]) {
			const reply = await nodeFailure(new Error(message), "before_send");
			expect(reply).toMatchObject({
				ok: false,
				error: "workspace_path_too_long",
				detail: "path_budget",
				certainty: "before_send",
			});
			expect(nodeFailureCode.test(`node_refused:${reply.error}:${reply.detail}`)).toBe(
				true,
			);
			expect("correlationId" in reply && reply.correlationId).toBeFalsy();
		}
	});

	test("common-dir helper faults stay invalid_request, not internal", async () => {
		for (const message of [
			"git_common_dir_missing",
			"invalid_worktree_basename",
			"unsupported_node_os",
			"unresolved_path_root:repo",
			"unresolved_path_root:workspace_root",
		]) {
			const reply = await nodeFailure(new Error(message), "before_send");
			expect(reply).toMatchObject({
				ok: false,
				error: "invalid_request",
				detail: "request",
				certainty: "before_send",
			});
		}
	});
});

describe("git_failed diagnostic message classification", () => {
	test("bare and prefixed git_failed:exit=… both map to git_failed/git_exit", async () => {
		for (const message of [
			"git_failed",
			"git_failed:exit=128:fatal: gitfile does not point to a valid repository: <path>/.git",
			"git_failed:exit=1",
		]) {
			const reply = await nodeFailure(new Error(message), "before_send");
			expect(reply).toMatchObject({
				ok: false,
				error: "git_failed",
				detail: "git_exit",
				certainty: "before_send",
			});
			expect(nodeFailureCode.test(`node_refused:${reply.error}:${reply.detail}`)).toBe(
				true,
			);
		}
	});

	test("nodeFailure reply never forwards the git stderr snippet", async () => {
		const message =
			"git_failed:exit=128:fatal: gitfile does not point to a valid repository: 'C:\\Users\\example\\deep\\.git'";
		const reply = await nodeFailure(new Error(message), "before_send");
		const serialized = JSON.stringify(reply);
		expect(reply.error).toBe("git_failed");
		expect(serialized).not.toContain("gitfile");
		expect(serialized).not.toContain("Users\\example");
		expect(serialized).not.toContain("git_failed:exit=");
		expect(serialized).not.toContain("C:\\");
	});
});
