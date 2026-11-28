import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import * as ws from "../src/workspace";
import { checkPreparation, collectResult, prepareWorkspace, run, sha256 } from "../src/workspace";
import { nodeOperation } from "../src/node";
import { Fleet, validateResult } from "../src/fleet";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { FleetStore } from "../src/store";
import { failureDiagnostic, DIAGNOSTIC_TEXT } from "../src/diagnostic";
import { FleetError } from "../src/core";

// Review rv10 (a4e2fc48) regressions. Operator rules (the source repository's
// `info/exclude`, the repository-selected `core.excludesFile`, the node's own
// excludes file) win over every in-tree negation (MEDIUM-1); the source rules
// and collection configuration come from the operator's node configuration
// (`collectionRules[repoId]`) when it holds them, so an earlier worker on the same
// source root cannot change them, and no worker action blocks a later preparation
// (MEDIUM-2, review fx-9abb2530 F2); an identity without a snapshot collects with
// completeness unknown (LOW-1, review fx-9abb2530 F5); no collection Git process
// runs inside the workspace (LOW-2); snapshot files are never written through a
// planted link (LOW-3).

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const gitOk = async (argv: string[], cwd: string) => {
	const r = await run(["git", "-c", "user.name=Review", "-c", "user.email=r@example.invalid", "-c", "commit.gpgsign=false", ...argv], cwd);
	if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
	return r.stdout;
};
const files = (result: any) => result.files.map((file: any) => file.path);
/** The rules of a source root as the operator records them in the node configuration (`collectionRules`). */
const rulesOf = (repo: string) => ws.collectionRules(repo);

/** Operator rules in place before anything runs: info/exclude, a repository-selected excludes file, the node's XDG ignore. */
async function operatorFixture(options: { operator?: boolean; xdgRules?: string } = {}) {
	const f = await repositoryFixture("fleet-collection-rv10-");
	directories.push(f.dir);
	await mkdir(join(f.repo, ".git", "info"), { recursive: true });
	await writeFile(join(f.repo, ".git", "info", "exclude"), "info.secret\nsecrets/\n");
	const repoRules = join(f.dir, "repo-rules.ignore");
	await writeFile(repoRules, "repo.secret\n");
	await gitOk(["-C", f.repo, "config", "core.excludesFile", repoRules], f.dir);
	const xdg = join(f.dir, "xdg");
	await mkdir(join(xdg, "git"), { recursive: true });
	await writeFile(join(xdg, "git", "ignore"), options.xdgRules ?? "node.secret\n");
	const operator = options.operator === false ? undefined : await rulesOf(f.repo);
	const prepare = (attemptId = "attempt", taskId = "task", collectionRules = operator) =>
		prepareWorkspace({ taskId, attemptId, nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot, ...(collectionRules ? { collectionRules } : {}) });
	return { f, xdg, operator, prepare, repoRules };
}
async function withXdg<T>(xdg: string, body: () => Promise<T>): Promise<T> {
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdg;
	try {
		return await body();
	} finally {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
}
const SECRETS = ["INFO_SECRET", "REPO_SECRET", "NODE_SECRET", "DIR_SECRET", "SUB_SECRET"];
async function plantSecrets(path: string) {
	await writeFile(join(path, "info.secret"), "INFO_SECRET");
	await writeFile(join(path, "repo.secret"), "REPO_SECRET");
	await writeFile(join(path, "node.secret"), "NODE_SECRET");
	await mkdir(join(path, "secrets"), { recursive: true });
	await writeFile(join(path, "secrets", "k.txt"), "DIR_SECRET");
	await mkdir(join(path, "sub"), { recursive: true });
	await writeFile(join(path, "sub", "info.secret"), "SUB_SECRET");
	await writeFile(join(path, "d.txt"), "deliverable");
}
const leaked = (result: any) => SECRETS.filter((secret) => JSON.stringify(result).includes(secret) || result.files.some((file: any) => Buffer.from(file.contentBase64, "base64").toString("latin1").includes(secret)));

describe("rv10 MEDIUM-1: operator rules win over in-tree negations", () => {
	const negations: Record<string, Record<string, string>> = {
		"N1 root .gitignore negates every operator pattern": { ".gitignore": "!info.secret\n!repo.secret\n!node.secret\n!secrets/\n" },
		"N2 root .gitignore re-includes everything": { ".gitignore": "!*\n!*/\n" },
		"N3 nested .gitignore negates the info/exclude pattern": { "sub/.gitignore": "!info.secret\n" },
		"N4 negated directory plus a .gitignore inside it": { ".gitignore": "!secrets/\n", "secrets/.gitignore": "!*\n" },
	};
	for (const [name, rules] of Object.entries(negations))
		test(name + ": nothing an operator rule matches is exported, and the export is incomplete", async () => {
			const { xdg, prepare } = await operatorFixture();
			await withXdg(xdg, async () => {
				const identity = await prepare();
				await plantSecrets(identity.path);
				for (const [file, text] of Object.entries(rules)) await writeFile(join(identity.path, file), text);
				const result = await collectResult(identity, []);
				expect(leaked(result)).toEqual([]);
				expect(result.exportComplete).toBe(false);
				expect(files(result)).toContain("d.txt");
				const withheld = Object.fromEntries((result.exclusions ?? []).map((entry: any) => [entry.path, entry.source]));
				expect(withheld).toMatchObject({ "info.secret": "info_exclude", "repo.secret": "excludes_file", "node.secret": "excludes_file", secrets: "info_exclude", "sub/info.secret": "info_exclude" });
				expect(() => validateResult(identity, result)).not.toThrow();
			});
		});

	test("the node's live excludes file wins over an in-tree negation too", async () => {
		const { xdg, prepare } = await operatorFixture({ xdgRules: "" });
		const identity = await withXdg(xdg, () => prepare());
		await writeFile(join(xdg, "git", "ignore"), "live.secret\n");
		await writeFile(join(identity.path, "live.secret"), "LIVE_SECRET");
		await writeFile(join(identity.path, ".gitignore"), "!live.secret\n");
		await writeFile(join(identity.path, "d.txt"), "d");
		const result = await withXdg(xdg, () => collectResult(identity, []));
		expect(JSON.stringify(result)).not.toContain("LIVE_SECRET");
		expect(files(result)).toEqual([".gitignore", "d.txt"]);
		expect(result.exclusions).toEqual([{ path: "live.secret", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "excludes_file" }]);
	});

	test("in-tree rules stay the worker's own: a negation of an in-tree pattern still exports, complete", async () => {
		const { xdg, prepare } = await operatorFixture();
		await withXdg(xdg, async () => {
			const identity = await prepare();
			await writeFile(join(identity.path, ".gitignore"), "*.log\n!keep.log\n");
			await writeFile(join(identity.path, "keep.log"), "k");
			await writeFile(join(identity.path, "drop.log"), "x");
			const result = await collectResult(identity, []);
			expect(files(result)).toEqual([".gitignore", "keep.log"]);
			expect(result.exportComplete).toBe(true);
			expect(result.ignored).toEqual({ count: 1, unlisted: 0, paths: ["drop.log"] });
		});
	});
});

describe("review fx-9abb2530 F2: collection rules come from operator-owned state; no worker action blocks a later preparation", () => {
	const tampering: Record<string, (workspace: string, f: any) => Promise<void>> = {
		"T1 attempt-1 worker empties the shared info/exclude": async (workspace) => {
			const common = (await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspace)).trim();
			await writeFile(join(common, "info", "exclude"), "");
		},
		"T2 attempt-1 worker points core.excludesFile at a missing file": async (workspace) => {
			await gitOk(["config", "core.excludesFile", "/nonexistent/rules"], workspace);
		},
		"T3 attempt-1 worker, through its own workspace Git only": async (workspace) => {
			await gitOk(["config", "core.excludesFile", ""], workspace);
			const common = (await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspace)).trim();
			await writeFile(join(common, "info", "exclude"), "# nothing\n");
		},
		"T4 attempt-1 worker changes the shared collection configuration": async (workspace) => {
			await gitOk(["config", "core.ignorecase", "true"], workspace);
		},
	};
	for (const [name, poison] of Object.entries(tampering)) {
		test(name + ": with operator rules the next preparation proceeds and still withholds every operator file", async () => {
			const { xdg, prepare } = await operatorFixture();
			await withXdg(xdg, async () => {
				const first = await prepare("attempt1");
				await poison(first.path, undefined);
				const second = await prepare("attempt2");
				await plantSecrets(second.path);
				const result = await collectResult(second, []);
				expect(leaked(result)).toEqual([]);
				expect(files(result)).toEqual(["d.txt"]);
				expect(result.exportComplete).toBe(false);
			});
		});
		test(name + ": without operator rules the next preparation is never refused", async () => {
			const { f, xdg, prepare } = await operatorFixture({ operator: false });
			await withXdg(xdg, async () => {
				const first = await prepare("attempt1");
				await poison(first.path, f);
				const second = await prepare("attempt2");
				expect(existsSync(join(f.workspaceRoot, ".collection-snapshots", "task-attempt2.json"))).toBe(true);
				await writeFile(join(second.path, "d.txt"), "deliverable");
				expect(files(await collectResult(second, []))).toEqual(["d.txt"]);
			});
		});
	}

	test("the node takes the operator's collectionRules[repoId] over the root's shared .git", async () => {
		const { f, xdg } = await operatorFixture({ operator: false });
		const node = { id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: "unused", args: [] } };
		const request = (attemptId: string, action = "prepare") => ({ action, input: { taskId: "task", attemptId, nodeId: "node", inputDigest: sha256("input"), repoId: "repo", baseCommit: f.baseCommit } });
		await withXdg(xdg, async () => {
			const operator = { ...node, collectionRules: { repo: await rulesOf(f.repo) } };
			await writeFile(join(f.repo, ".git", "info", "exclude"), "");
			for (const action of ["preflight", "prepare"]) expect(await nodeOperation(operator as any, request("attempt1", action))).toBeTruthy();
			const identity: any = await nodeOperation(operator as any, request("attempt2"));
			await plantSecrets(identity.path);
			const result: any = await nodeOperation(operator as any, { action: "collect", identity, tests: [], exportCompleteness: ws.EXPORT_COMPLETENESS } as any);
			expect(leaked(result)).toEqual([]);
			expect(result.exclusions.find((entry: any) => entry.path === "info.secret")).toMatchObject({ source: "info_exclude" });
			// Without operator rules the root's live (now empty) info/exclude applies.
			const live: any = await nodeOperation(node as any, request("attempt3"));
			await plantSecrets(live.path);
			const plain: any = await nodeOperation(node as any, { action: "collect", identity: live, tests: [], exportCompleteness: ws.EXPORT_COMPLETENESS } as any);
			expect(plain.files.map((file: any) => file.path)).toContain("info.secret");
		});
	});
});

describe("rv10 LOW-1, review fx-9abb2530 F5: an identity without a collection snapshot collects as legacy-v1", () => {
	test("a legacy identity (no collectionSnapshot) collects through the node with no completeness fields (unknown)", async () => {
		const f = await repositoryFixture("fleet-collection-rv10-");
		directories.push(f.dir);
		const node = { id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: "unused", args: [] } };
		const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		const { collectionSnapshot: _, ...legacy } = identity as any;
		await writeFile(join(identity.path, ".fleet-identity.json"), JSON.stringify(legacy), { mode: 0o600 });
		await writeFile(join(identity.path, "d.txt"), "d");
		const result: any = await nodeOperation(node as any, { action: "collect", identity: legacy, tests: [], exportCompleteness: ws.EXPORT_COMPLETENESS } as any);
		expect(files(result)).toEqual(["d.txt"]);
		for (const field of ["exclusions", "exportComplete", "ignored", "junk"]) expect(result[field]).toBeUndefined();
		expect(() => validateResult(legacy, result)).not.toThrow();
	});
});

describe("rv10 LOW-2: no collection Git process runs with its cwd inside the workspace", () => {
	// A POSIX sh shim (review fx-9abb2530 F9).
	test.skipIf(process.platform === "win32")("every Git process of a collection runs in a node-owned directory", async () => {
		const { f, xdg, prepare } = await operatorFixture();
		const shim = join(f.dir, "shim");
		await mkdir(shim);
		const log = join(f.dir, "git-cwd.log");
		const realGit = (await run(["sh", "-c", "command -v git"], f.dir)).stdout.trim();
		await writeFile(join(shim, "git"), `#!/bin/sh\npwd -P >> '${log}'\nexec '${realGit}' "$@"\n`);
		chmodSync(join(shim, "git"), 0o755);
		await withXdg(xdg, async () => {
			const identity = await prepare();
			await plantSecrets(identity.path);
			await mkdir(join(identity.path, "nested"));
			await gitOk(["init", "-q", join(identity.path, "nested")], f.dir);
			await writeFile(join(identity.path, "nested", "n.txt"), "n");
			const saved = process.env.PATH;
			process.env.PATH = shim + ":" + saved;
			let result: any;
			try {
				result = await collectResult(identity, []);
			} finally {
				process.env.PATH = saved;
			}
			expect(files(result)).toContain("d.txt");
			const cwds = (await readFile(log, "utf8")).trim().split("\n");
			expect(cwds.length).toBeGreaterThan(3);
			const workspace = await realpath(identity.path);
			expect(cwds.filter((cwd) => cwd === workspace || cwd.startsWith(workspace + sep))).toEqual([]);
		});
	});
	// Review b7481b8b F2: the HEAD read's own directory may be impossible to remove (on Windows a
	// timed-out Git's orphaned child keeps it busy). A POSIX sh shim makes that directory
	// unremovable from inside the HEAD read (a non-empty directory without write permission).
	for (const outcome of ["fails", "succeeds"] as const)
		test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(`a HEAD read that ${outcome} and leaves its directory unremovable still collects with ${outcome === "fails" ? "the base commit" : "that HEAD"} (review b7481b8b F2)`, async () => {
			const { f, xdg, prepare } = await operatorFixture();
			const shim = join(f.dir, "shim");
			await mkdir(shim);
			const log = join(f.dir, "head-cwd.log");
			const realGit = (await run(["sh", "-c", "command -v git"], f.dir)).stdout.trim();
			const moved = "1".repeat(40);
			const reply = outcome === "fails" ? "exit 128" : `echo ${moved}; exit 0`;
			await writeFile(join(shim, "git"), `#!/bin/sh\ncase "$(pwd -P)" in */fleet-head-*)\n  pwd -P >> '${log}'\n  mkdir locked && : > locked/held && chmod 555 locked\n  ${reply};;\nesac\nexec '${realGit}' "$@"\n`);
			chmodSync(join(shim, "git"), 0o755);
			await withXdg(xdg, async () => {
				const identity = await prepare();
				await writeFile(join(identity.path, "d.txt"), "d");
				const saved = process.env.PATH;
				process.env.PATH = shim + ":" + saved;
				let result: any;
				try {
					result = await collectResult(identity, []);
				} finally {
					process.env.PATH = saved;
					// The HEAD read's directory is left behind; the test removes it.
					const cwds = existsSync(log) ? (await readFile(log, "utf8")).trim().split("\n") : [];
					for (const cwd of cwds) {
						if (existsSync(join(cwd, "locked"))) chmodSync(join(cwd, "locked"), 0o755);
						directories.push(cwd);
					}
				}
				const cwds = (await readFile(log, "utf8")).trim().split("\n");
				expect(cwds.length).toBe(1);
				expect(existsSync(join(cwds[0], "locked", "held"))).toBe(true);
				expect(files(result)).toEqual(["d.txt"]);
				expect(result.outputHead).toBe(outcome === "fails" ? f.baseCommit : moved);
			});
		});
});

describe("rv10 LOW-3: snapshot files are never written through a planted link", () => {
	for (const suffix of ["json", "index"] as const)
		test(`a link planted at a later attempt's snapshot ${suffix} name is replaced, its target untouched, and that attempt collects`, async () => {
			const f = await repositoryFixture("fleet-collection-rv10-");
			directories.push(f.dir);
			const prepare = (attemptId: string) => prepareWorkspace({ taskId: "task", attemptId, nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
			await mkdir(join(f.workspaceRoot, ".collection-snapshots"), { recursive: true });
			const victim = join(f.dir, "victim.txt");
			await writeFile(victim, "VICTIM");
			const planted = join(f.workspaceRoot, ".collection-snapshots", "task-attempt2." + suffix);
			await symlink(victim, planted);
			expect(await readlink(planted)).toBe(victim);
			const second = await prepare("attempt2");
			expect(await readFile(victim, "utf8")).toBe("VICTIM");
			await writeFile(join(second.path, "d.txt"), "d");
			const result = await collectResult(second, []);
			expect(files(result)).toEqual(["d.txt"]);
			expect(second.path).toBe(join(f.workspaceRoot, "task-attempt2"));
			expect(second.path).not.toBe(join(f.workspaceRoot, "task-attempt1"));
		});
	test("two attempts keep separate workspace paths", async () => {
		const f = await repositoryFixture("fleet-collection-rv10-pair-");
		directories.push(f.dir);
		const prepare = (attemptId: string) => prepareWorkspace({
			taskId: "task", attemptId, nodeId: "node", inputDigest: sha256("input"),
			repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot,
		});
		const first = await prepare("attempt1");
		const second = await prepare("attempt2");
		expect(first.path).not.toBe(second.path);
		expect(existsSync(first.path)).toBe(true);
		expect(existsSync(second.path)).toBe(true);
	}, 15_000);
});

describe("rv10: checkPreparation stays side-effect free with operator rules", () => {
	test("a check with operator rules reads only and creates nothing", async () => {
		const { f, xdg, operator } = await operatorFixture();
		await withXdg(xdg, async () => {
			const checked = await checkPreparation({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot, collectionRules: operator });
			expect(checked.repo).toBe(f.repo);
			expect(existsSync(f.workspaceRoot)).toBe(false);
		});
	});
});

describe("review fx-9abb2530 F2 through the hub: a worker that changes the root's shared rules never blocks the next task", () => {
	test("a worker that empties the shared info/exclude: the next task on that root prepares; the hub records no pin", async () => {
		const { f } = await operatorFixture({ operator: false });
		const config = join(f.dir, "node.json");
		const node = {
			id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot,
			enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
			transport: { command: "unused", args: [] },
		};
		await writeFile(config, JSON.stringify(node));
		const state = join(f.dir, "coordinator.json");
		await writeFile(state, JSON.stringify({ calls: [] }));
		const store = new FleetStore(join(f.dir, "fleet.sqlite"));
		try {
			store.putNode({
				...node,
				// Absolute paths from this file: suite spawn-guard remaps process.cwd(), so resolve("test/...") breaks.
				transport: {
					command: process.execPath,
					args: [resolve(import.meta.dir, "fixtures/coordinator.ts"), state],
				},
				workspaceTransport: {
					command: process.execPath,
					args: [resolve(import.meta.dir, "../src/node.ts"), config],
				},
			} as any);
			const start = async (key: string) => {
				const task = store.submit({ schemaVersion: 1, key, caller: "test", repoId: "repo", baseCommit: f.baseCommit, prompt: "test", required: {} });
				// Headroom for both tasks: the first one is still active when the second is admitted.
				const resources = headroom(["node"], 2);
				resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
				store.reserve(task.id, resources);
				return new Fleet(store).start(task.id);
			};
			const first = await start("first");
			// The first task's worker, through its own workspace Git, empties the operator's rules.
			const workspace = (first.workspace as any).path;
			const common = (await gitOk(["rev-parse", "--path-format=absolute", "--git-common-dir"], workspace)).trim();
			await writeFile(join(common, "info", "exclude"), "");
			const second = await start("second");
			expect((second.workspace as { collectionSnapshot?: string } | undefined)?.collectionSnapshot).toMatch(/^[a-f0-9]{64}$/);
			expect(existsSync((second.workspace as any).path)).toBe(true);
			for (const task of [first, second]) expect(Object.keys(store.getOperation(task.id, "prepare")!.payload as any)).not.toContain("collectionPin");
			expect(store.events(second.id).filter((e) => e.kind === "node_operation_failure")).toEqual([]);
		} finally {
			store.close();
		}
	}, 60000);
});

describe("review fx-9abb2530 F8: deny-by-default diagnostics cover the collector's refusals", () => {
	test("every Fleet refusal code the collector adds is diagnosed by its own code, never unclassified", () => {
		const step = { source: "Fleet.result", phase: "collect" } as const;
		for (const code of ["EXPORT_REVIEW_CHANGED", "EXPORT_REVIEW_NOT_REQUIRED", "EXPORT_REVIEW_REQUIRED", "RESULT_COMPLETENESS", "RESULT_EXCLUSIONS", "RESULT_IGNORED", "RESULT_SCHEMA", "VERIFICATION_CONFLICT", "ARTIFACT_CHANGED"]) {
			const diagnostic = failureDiagnostic(new FleetError(code, "controlled " + code), step as any);
			expect([code, diagnostic.code]).toEqual([code, "fleet:" + code.toLowerCase()]);
			expect(DIAGNOSTIC_TEXT.get(diagnostic.code)).toBe("Fleet check refused the step");
		}
	});
});

describe("review fx-9abb2530 F6: a hub that does not read export completeness never receives an incomplete export", () => {
	const nodeOf = (f: { repo: string; workspaceRoot: string }) => ({ id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: "unused", args: [] } });
	test("a nested repository with content is refused to such a hub (as that release refused it) and exported to a hub that reads completeness", async () => {
		const f = await repositoryFixture("fleet-collection-rv10-");
		directories.push(f.dir);
		const node = nodeOf(f);
		const identity: any = await nodeOperation(node as any, { action: "prepare", input: { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repoId: "repo", baseCommit: f.baseCommit } });
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		await gitOk(["init", "-q", join(identity.path, "vendor")], f.dir);
		await writeFile(join(identity.path, "vendor", "lib.ts"), "NESTED_DELIVERABLE");
		const refused: any = await nodeOperation(node as any, { action: "collect", identity, tests: [] }).catch((error) => error);
		expect(refused.reply).toMatchObject({ ok: false, error: "unsafe_path", certainty: "unknown" });
		const result: any = await nodeOperation(node as any, { action: "collect", identity, tests: [], exportCompleteness: ws.EXPORT_COMPLETENESS } as any);
		expect(result).toMatchObject({ exportComplete: false, exclusions: [{ path: "vendor", reason: "nested_repository", outerTrackedEntries: 0 }] });
		const malformed: any = await nodeOperation(node as any, { action: "collect", identity, tests: [], exportCompleteness: "exclusions-v2" } as any).catch((error) => error);
		expect(malformed.reply).toMatchObject({ ok: false, error: "invalid_request", certainty: "before_send" });
		// The workspace is left as it was for out-of-band retrieval.
		expect(await readFile(join(identity.path, "vendor", "lib.ts"), "utf8")).toBe("NESTED_DELIVERABLE");
	});
	test("what the previous release never exported either (ignored content, repositories in an ignored directory, a lone .git) still collects for such a hub", async () => {
		const f = await repositoryFixture("fleet-collection-rv10-");
		directories.push(f.dir);
		const node = nodeOf(f);
		const identity: any = await nodeOperation(node as any, { action: "prepare", input: { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repoId: "repo", baseCommit: f.baseCommit } });
		await writeFile(join(identity.path, ".gitignore"), "node_modules/\n");
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		await mkdir(join(identity.path, "node_modules", "pkg"), { recursive: true });
		await gitOk(["init", "-q", join(identity.path, "node_modules", "pkg")], f.dir);
		await writeFile(join(identity.path, "node_modules", "pkg", "index.js"), "x");
		await mkdir(join(identity.path, "empty", ".git"), { recursive: true });
		const result: any = await nodeOperation(node as any, { action: "collect", identity, tests: [] });
		expect(files(result)).toEqual([".gitignore", "d.txt"]);
	});
});

describe("review fx-9abb2530 F2: `collection-rules REPO` prints a root's rules for the operator's node configuration", () => {
	test("it prints the rules without a database, and the printed rules prepare that root", async () => {
		const { f, xdg } = await operatorFixture({ operator: false });
		await writeFile(join(f.repo, ".git", "info", "exclude"), "changed.secret\n");
		const db = join(f.dir, "absent", "fleet.sqlite");
		const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--db", db, "collection-rules", f.repo], { stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_CONFIG_HOME: xdg } });
		expect(r.exitCode).toBe(0);
		const printed = JSON.parse(r.stdout.toString());
		expect(printed).toMatchObject({ ok: true, repository: f.repo, collectionRules: { info_exclude: "changed.secret\n", excludes_file: "repo.secret\n" } });
		expect(existsSync(db)).toBe(false);
		expect(Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/cli.ts"), "--db", db, "collection-rules"], { stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(0);
		await writeFile(join(f.repo, ".git", "info", "exclude"), "");
		await withXdg(xdg, async () => {
			const identity: any = await nodeOperation({ ...nodeOf(f), collectionRules: { repo: printed.collectionRules } } as any, { action: "prepare", input: { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repoId: "repo", baseCommit: f.baseCommit } });
			await writeFile(join(identity.path, "changed.secret"), "CHANGED_SECRET");
			const result: any = await collectResult(identity, []);
			expect(JSON.stringify(result)).not.toContain("CHANGED_SECRET");
		});
	});
	const nodeOf = (f: { repo: string; workspaceRoot: string }) => ({ id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: "unused", args: [] } });
});

describe("review fx-9abb2530 F7: snapshot pairs are bounded by the workspaces that still exist", () => {
	test("a preparation removes the pair of every removed workspace and keeps the pairs of existing ones", async () => {
		const f = await repositoryFixture("fleet-collection-rv10-");
		directories.push(f.dir);
		const prepare = (attemptId: string) => prepareWorkspace({ taskId: "task", attemptId, nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
		const snapshots = join(f.workspaceRoot, ".collection-snapshots");
		const pairs = async () => (await readdir(snapshots)).sort();
		const first = await prepare("attempt1");
		const second = await prepare("attempt2");
		expect(await pairs()).toEqual(["task-attempt1.index", "task-attempt1.json", "task-attempt2.index", "task-attempt2.json"]);
		await rm(first.path, { recursive: true, force: true });
		await writeFile(join(snapshots, "unrelated.txt"), "kept");
		await prepare("attempt3");
		expect(await pairs()).toEqual(["task-attempt2.index", "task-attempt2.json", "task-attempt3.index", "task-attempt3.json", "unrelated.txt"]);
		// The retained workspace still collects from its own pair.
		await writeFile(join(second.path, "d.txt"), "d");
		expect(files(await collectResult(second, []))).toEqual(["d.txt"]);
	});
});
