// Review 5a4b253e HIGH-1: no source checkout or task workspace shape that main prepares, tests or
// collects may be newly refused by the node helper. Main prepares from the committed tree
// (`git ls-tree`) and collects from `git diff` plus unignored untracked files, so content outside
// those views (ignored dependencies, symlinks, nested or linked checkouts, large ignored trees) must
// not change any outcome. Every case runs the actual helper process (src/node.ts) end to end.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { oneShot, PREFLIGHT_PASSED } from "../src/node";
import { sha256, type WorkspaceIdentity } from "../src/workspace";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
	const f = await repositoryFixture("workspace-shapes-");
	dirs.push(f.dir);
	const node = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot, maxConcurrency: 1, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const args = [resolve(import.meta.dir, "../src/node.ts"), config];
	const call = (request: unknown) => oneShot(process.execPath, args, request);
	let n = 0;
	const input = () => ({
		taskId: "task", attemptId: "attempt" + n++, nodeId: "node", inputDigest: sha256("input"),
		repoId: "repo", baseCommit: f.baseCommit,
	});
	/** Preflight then prepare a fresh attempt; both must pass and materialize exactly the committed tree. */
	const prepare = async (): Promise<WorkspaceIdentity> => {
		const request = input();
		expect(await call({ action: "preflight", input: request })).toEqual(PREFLIGHT_PASSED);
		const identity = (await call({ action: "prepare", input: request })) as WorkspaceIdentity;
		expect(identity).toMatchObject({ attemptId: request.attemptId, baseCommit: f.baseCommit });
		expect(await Bun.file(join(identity.path, "tracked.txt")).text()).toBe("base bytes\n");
		expect(await Bun.file(join(identity.path, "node_modules")).exists()).toBe(false);
		expect(await Bun.file(join(identity.path, "vendor", "lib", ".git", "HEAD")).exists()).toBe(false);
		return identity;
	};
	/** test runs the command and collect returns exactly the task's own unignored changes. */
	const testAndCollect = async (identity: WorkspaceIdentity, expected: string[]) => {
		const marker = join(f.dir, "ran-" + identity.attemptId);
		const evidence = (await call({
			action: "test", identity,
			argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
		})) as any;
		expect(evidence.exit).toBe(0);
		expect(await Bun.file(marker).text()).toBe("ran");
		const manifest = (await call({ action: "collect", identity })) as any;
		expect(manifest.files.map((file: any) => file.path).sort()).toEqual([...expected].sort());
		return manifest;
	};
	return { ...f, call, input, prepare, testAndCollect };
}
async function exclude(gitDir: string, patterns: string[]) {
	await mkdir(join(gitDir, "info"), { recursive: true });
	await writeFile(join(gitDir, "info", "exclude"), patterns.join("\n") + "\n");
}
async function installedDependencies(root: string) {
	await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
	await writeFile(join(root, "node_modules", "tool.js"), "x");
	await symlink("../tool.js", join(root, "node_modules", ".bin", "tool"));
}
async function nestedRepositories(root: string) {
	// A real nested checkout (.git directory), a submodule-style checkout (.git file) and a dangling
	// symlink, all inside one ignored vendor/ directory.
	await mkdir(join(root, "vendor", "lib", ".git"), { recursive: true });
	await writeFile(join(root, "vendor", "lib", ".git", "HEAD"), "ref: refs/heads/main\n");
	await mkdir(join(root, "vendor", "sub"), { recursive: true });
	await writeFile(join(root, "vendor", "sub", ".git"), "gitdir: ../../.git/modules/sub\n");
	await symlink("/nonexistent-target", join(root, "vendor", "dangling"));
}
function largeTree(root: string, count: number) {
	// More entries than the removed 100000-entry filesystem scan allowed.
	for (let d = 0; d * 1000 < count; d++) {
		const dir = join(root, "node_modules", "big", String(d));
		mkdirSync(dir, { recursive: true });
		for (let i = d * 1000; i < Math.min(count, (d + 1) * 1000); i++) writeFileSync(join(dir, String(i)), "");
	}
}

test("source root: ignored node_modules/.bin symlink, ignored nested .git directory and submodule-style .git file prepare as on main", async () => {
	const f = await fixture();
	await exclude(join(f.repo, ".git"), ["node_modules/", "vendor/"]);
	await installedDependencies(f.repo);
	await nestedRepositories(f.repo);
	await f.testAndCollect(await f.prepare(), []);
}, 60000);
test("source root: untracked, unignored symlink and nested repository do not affect preparation (not in the committed tree)", async () => {
	const f = await fixture();
	await symlink("tracked.txt", join(f.repo, "link"));
	await mkdir(join(f.repo, "nested", ".git"), { recursive: true });
	await mkdir(join(f.repo, "gitfile"), { recursive: true });
	await writeFile(join(f.repo, "gitfile", ".git"), "gitdir: /elsewhere\n");
	const identity = await f.prepare();
	expect(await Bun.file(join(identity.path, "link")).exists()).toBe(false);
	await f.testAndCollect(identity, []);
}, 60000);
test("source root that is itself a linked worktree (.git file), with a nested linked worktree inside it, prepares as on main", async () => {
	const f = await fixture();
	const linked = join(f.dir, "linked-source");
	await f.git("worktree", "add", "--detach", linked, f.baseCommit);
	// A nested linked worktree (its own .git file) inside the source checkout, ignored there.
	await f.git("worktree", "add", "--detach", join(linked, "wt"), f.baseCommit);
	await exclude(join(f.repo, ".git"), ["wt/"]);
	const config = JSON.parse(await Bun.file(join(f.dir, "config.json")).text());
	config.roots = { repo: linked };
	await writeFile(join(f.dir, "config.json"), JSON.stringify(config));
	await f.testAndCollect(await f.prepare(), []);
}, 60000);
test("source root and workspace with a large ignored tree (100,050 entries) prepare, test and collect as on main", async () => {
	const f = await fixture();
	await exclude(join(f.repo, ".git"), ["node_modules/"]);
	largeTree(f.repo, 100050);
	try {
		const identity = await f.prepare();
		largeTree(identity.path, 100050);
		await f.testAndCollect(identity, []);
	} finally {
		// Removing 200k entries outlasts the default hook timeout; do it inside the test budget.
		await rm(f.dir, { recursive: true, force: true });
	}
}, 180000);
test("workspace: ignored node_modules/.bin symlink, nested .git directory, submodule-style .git file and nested linked worktree: test and collect as on main", async () => {
	const f = await fixture();
	const identity = await f.prepare();
	await writeFile(join(identity.path, ".gitignore"), "node_modules/\nvendor/\nwt/\n");
	await installedDependencies(identity.path);
	await nestedRepositories(identity.path);
	await f.git("worktree", "add", "--detach", join(identity.path, "wt"), f.baseCommit);
	await writeFile(join(identity.path, "tracked.txt"), "changed by task\n");
	const manifest = await f.testAndCollect(identity, [".gitignore", "tracked.txt"]);
	expect(manifest.patch).toContain("changed by task");
}, 60000);
test("workspace: unignored nested .git entries still run tests; collect outcome equals main's for each", async () => {
	// Observed on main (fleet-main-52374c9, macOS): head-only .git dir and .git file collect as [],
	// a real nested repository is refused by collect (unsafe_relative_path). Unchanged here, and
	// that refusal is reported only after collection began (unknown), never before_send.
	for (const kind of ["head-only", "gitfile", "repository"] as const) {
		const f = await fixture();
		const identity = await f.prepare();
		const nested = join(identity.path, "nested");
		await mkdir(nested);
		if (kind === "head-only") {
			await mkdir(join(nested, ".git"));
			await writeFile(join(nested, ".git", "HEAD"), "ref: refs/heads/main\n");
		} else if (kind === "gitfile") await writeFile(join(nested, ".git"), "gitdir: /elsewhere\n");
		else {
			expect(Bun.spawnSync(["git", "init", "-q", nested]).exitCode).toBe(0);
			await writeFile(join(nested, "file"), "x");
		}
		if (kind !== "repository") {
			await f.testAndCollect(identity, []);
			continue;
		}
		const marker = join(f.dir, "ran");
		expect(((await f.call({ action: "test", identity, argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`] })) as any).exit).toBe(0);
		expect(await Bun.file(marker).text()).toBe("ran");
		await expect(f.call({ action: "collect", identity })).rejects.toMatchObject({
			code: "node_failed:unsafe_path:unsafe_entry", certainty: "unknown",
		});
	}
}, 60000);
test("caller: a source checkout with installed dependencies and vendored checkouts starts normally through Fleet", async () => {
	const f = await fixture();
	await exclude(join(f.repo, ".git"), ["node_modules/", "vendor/"]);
	await installedDependencies(f.repo);
	await nestedRepositories(f.repo);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	try {
		const node = JSON.parse(await Bun.file(join(f.dir, "config.json")).text());
		store.putNode({
			...node,
			transport: { command: process.execPath, args: [resolve(import.meta.dir, "fixtures/coordinator.ts"), state] },
			workspaceTransport: { command: process.execPath, args: [resolve(import.meta.dir, "../src/node.ts"), join(f.dir, "config.json")] },
		});
		const task = store.submit({ schemaVersion: 1, key: "shapes", caller: "test", repoId: "repo", baseCommit: f.baseCommit, prompt: "test", required: {} });
		const resources = headroom(["node"], 1);
		resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
		store.reserve(task.id, resources);
		const started = await new Fleet(store).start(task.id);
		expect(started.workspace).toMatchObject({ attemptId: started.attemptId });
		expect(started.phase).not.toBe("blocked_unknown");
		expect(store.events(task.id).filter(e => e.kind === "node_operation_failure")).toHaveLength(0);
	} finally {
		store.close();
	}
}, 60000);
