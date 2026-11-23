import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectResult, prepareWorkspace, run, sha256 } from "../src/workspace";
import { validateResult } from "../src/fleet";
import { repositoryFixture } from "./fixtures/coordinator";

// Round 9 (review e265ea63): collection reads no worker-writable Git state. A worker
// may write any configuration key with any value at any scope it can reach (the
// shared repository config, a per-worktree config, an included file, the shared
// info/exclude); the export must stay byte-identical to the one collected before.

const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** Deterministic PRNG (mulberry32): a failure names its seed and step. */
function prng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const KEYS = [
	"core.worktree", "core.excludesFile", "core.attributesFile", "core.hooksPath", "core.bare", "core.ignoreCase",
	"core.precomposeUnicode", "core.autocrlf", "core.eol", "core.safecrlf", "core.fileMode", "core.symlinks",
	"core.quotePath", "core.untrackedCache", "core.fsmonitor", "core.splitIndex", "core.sparseCheckout",
	"core.sparseCheckoutCone", "core.checkStat", "core.trustctime", "core.bigFileThreshold", "core.repositoryFormatVersion",
	"core.sharedRepository", "core.protectNTFS", "core.protectHFS", "core.longpaths", "core.gitProxy",
	"extensions.worktreeConfig", "extensions.objectFormat", "extensions.partialClone", "extensions.preciousObjects",
	"index.sparse", "index.version", "index.skipHash", "status.showUntrackedFiles", "status.relativePaths",
	"diff.external", "diff.noprefix", "diff.mnemonicPrefix", "diff.renames", "diff.algorithm", "diff.context",
	"diff.ignoreSubmodules", "diff.fleet.textconv", "diff.fleet.command", "filter.fleet.clean", "filter.fleet.smudge",
	"filter.fleet.process", "filter.fleet.required", "include.path", "includeIf.gitdir:/.path", "includeIf.onbranch:**.path",
	"submodule.recurse", "safe.directory", "uploadpack.packObjectsHook", "gc.auto", "fetch.recurseSubmodules",
	"remote.origin.url", "branch.main.remote", "alias.status", "pager.diff", "color.ui", "advice.statusHints",
	"feature.manyFiles", "worktree.guessRemote", "init.defaultBranch", "user.name",
];

async function fuzzWorkspace() {
	const f = await repositoryFixture("fleet-collection-fuzz-");
	directories.push(f.dir);
	// Operator rules in force at preparation: info/exclude and the node's own excludes file (XDG).
	await mkdir(join(f.repo, ".git", "info"), { recursive: true });
	await writeFile(join(f.repo, ".git", "info", "exclude"), "operator.secret\n");
	const xdg = join(f.dir, "xdg");
	await mkdir(join(xdg, "git"), { recursive: true });
	await writeFile(join(xdg, "git", "ignore"), ".DS_Store\nnode.secret\n");
	const identity = await prepareWorkspace({ taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
	const p = (...parts: string[]) => join(identity.path, ...parts);
	await writeFile(p(".gitignore"), "*.log\nbuild/\n");
	await writeFile(p("tracked.txt"), "changed bytes\n");
	await rm(p("deleted.txt"));
	await writeFile(p("new.txt"), "new deliverable\n");
	await mkdir(p("src"));
	await writeFile(p("src", "a.ts"), "export const a = 1;\n");
	await writeFile(p("debug.log"), "INTREE_IGNORED_SECRET");
	await mkdir(p("build"));
	await writeFile(p("build", "out.bin"), "BUILD_SECRET");
	await writeFile(p("operator.secret"), "OPERATOR_SECRET");
	await writeFile(p("node.secret"), "NODE_SECRET");
	await writeFile(p(".DS_Store"), "JUNK_SECRET");
	await mkdir(p("vendor", "lib"), { recursive: true });
	expect((await run(["git", "init", "-q", p("vendor", "lib")], f.dir)).exit).toBe(0);
	await writeFile(p("vendor", "lib", "x.txt"), "NESTED_SECRET");
	// What the worker can reach: the shared config, its own admin directory, files in the workspace.
	const admin = (await run(["git", "rev-parse", "--path-format=absolute", "--git-dir"], identity.path)).stdout.trim();
	const elsewhere = join(f.dir, "elsewhere");
	await mkdir(elsewhere);
	await writeFile(join(elsewhere, "foreign.txt"), "FOREIGN_SECRET");
	await writeFile(p("evil.cfg"), "[core]\n\texcludesFile = /dev/null\n\tworktree = " + elsewhere + "\n");
	return { f, xdg, identity, p, admin, elsewhere };
}

test("fuzz: random worker configuration keys and values never change the export", async () => {
	const seed = Number(process.env.FLEET_FUZZ_SEED ?? 20260913);
	const steps = Number(process.env.FLEET_FUZZ_STEPS ?? 60);
	const random = prng(seed);
	const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
	const { f, xdg, identity, p, admin, elsewhere } = await fuzzWorkspace();
	const saved = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = xdg;
	// `outputHead` is the workspace HEAD as Git reports it (production's work-unit provenance), not the export.
	const strip = (result: any) => ({ ...result, outputHead: undefined, tests: [] });
	try {
		const collected = await collectResult(identity, []);
		const baseline = strip(collected);
		// The baseline exercises every class: exported, in-tree ignored, operator and node exclusions, junk, a nested repository.
		expect(baseline.files.map((file: any) => file.path)).toEqual([".gitignore", "deleted.txt", "evil.cfg", "new.txt", "src/a.ts", "tracked.txt"]);
		expect(baseline.exclusions.map((entry: any) => entry.path + ":" + entry.reason)).toEqual(["node.secret:ignored_out_of_tree", "operator.secret:ignored_out_of_tree", "vendor/lib:nested_repository"]);
		expect(baseline.ignored.paths).toEqual(["build/", "debug.log"]);
		expect(baseline.junk.paths).toEqual([".DS_Store"]);
		expect(() => validateResult(identity, collected)).not.toThrow();
		const values = [
			"true", "false", "0", "1", "yes", "off", "input", "lf", "crlf", "/dev/null", "", "-1", "999999999", "garbage value",
			elsewhere, identity.path, p("evil.cfg"), p(".git"), admin, f.repo, join(f.repo, ".git"), "../..", "~/x", "!sh -c 'exit 1'",
			"patience", "sha256", "4", "all", "no", "normal", "minimal", "\"quoted\"", "a\\\\b",
		];
		// The included evil.cfg is a workspace file (its bytes are a deliverable), so it is written once, above.
		const configFiles = [join(f.repo, ".git", "config"), join(admin, "config.worktree")];
		const secrets = ["INTREE_IGNORED_SECRET", "BUILD_SECRET", "OPERATOR_SECRET", "NODE_SECRET", "JUNK_SECRET", "NESTED_SECRET", "FOREIGN_SECRET"];
		const applied: string[] = [];
		for (let step = 0; step < steps; step++) {
			const file = pick(configFiles);
			const key = pick(KEYS);
			const value = pick(values);
			// Written as a file edit: Git would refuse some values, a worker's editor does not.
			const r = await run(["git", "config", "--file", file, "--add", key, value], f.dir);
			if (r.exit !== 0) continue;
			applied.push(`${file.replace(f.dir, "<dir>")} ${key}=${JSON.stringify(value)}`);
			if (random() < 0.2) {
				const rules = pick(["", "!operator.secret\n", "*\n", "!*\n", "!node.secret\n!.DS_Store\n"]);
				await writeFile(join(f.repo, ".git", "info", "exclude"), rules);
				applied.push(`info/exclude=${JSON.stringify(rules)}`);
			}
			if (random() < 0.1) {
				await writeFile(join(admin, "HEAD"), pick(["ref: refs/heads/main\n", "0".repeat(40) + "\n", "garbage\n"]));
				applied.push("HEAD rewritten");
			}
			const label = `seed ${seed} step ${step}: ${applied.join("; ")}`;
			let result: any;
			try {
				result = strip(await collectResult(identity, []));
			} catch (error: any) {
				// As in production, a workspace whose HEAD Git cannot read refuses the collection (no
				// outputHead): only then, and only as git_failed.
				if (error.message.startsWith("git_failed") && (await run(["git", "-c", "core.fsmonitor=false", "-C", identity.path, "rev-parse", "HEAD"], f.dir)).exit !== 0) continue;
				throw new Error(label + " -> " + error.message);
			}
			const blob = JSON.stringify(result);
			expect([label, secrets.filter((secret) => blob.includes(secret))]).toEqual([label, []]);
			expect([label, result]).toEqual([label, baseline]);
		}
		// The fuzzer actually reached the worker-writable scopes.
		expect(applied.length).toBeGreaterThan(steps / 2);
		expect(await readFile(join(f.repo, ".git", "config"), "utf8")).not.toBe("");
	} finally {
		if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = saved;
	}
}, 300_000);
