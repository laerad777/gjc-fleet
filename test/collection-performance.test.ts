import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectResult, isolatedGitEnvironment, prepareWorkspace, readOwnedFile, run, sha256 } from "../src/workspace";

// Review b85877e2 MEDIUM-2 performance budget: a workspace with 50,000 tracked
// files and a 100,000-entry ignored node_modules collects within
// PERFORMANCE_BUDGET x the base collector's own Git work (+ a fixed allowance for
// process start-up noise). The base collector is the exact command sequence of
// the reviewed base `collectResult` (see `baseCollectorWork`); the probe
// `.local/r5/probes/perf.ts` compares against the real base tree.
const PERFORMANCE_BUDGET = 3;
// Fixed allowance: 700ms catches ≥5× regressions at smoke bases (~500ms) while
// keeping 3 concurrent perf runs green; 1500ms let 5× pass, 300ms floor flaked under load.
const ALLOWANCE_MS = 700;
// A loaded shared runner inflates individual timings with unrelated contention, so
// single-sample comparisons against the fixed allowance flake, while taking the best
// of several independent samples hides a real regression whenever any one sample
// escapes the load. Measure the base collector and the candidate back-to-back in
// alternating pairs: scheduler noise strikes individual measurements, but a pair
// compares both sides under the same conditions, so noise fails at most a pair or
// two. A sustained collector regression fails most pairs. Require REQUIRED_PASSES
// of PAIRS within budget (a majority under the current PAIRS/REQUIRED_PASSES pair).
const PAIRS = 8;
const REQUIRED_PASSES = 5;
// Creating the fixture files is far slower on Windows: a fifth of the fixture keeps the run inside the
// test's own time limit there, under the same budget (review fx-093cc54b F5).
const SCALE = process.platform === "win32" ? 5 : 1;
const TRACKED_FILES = 50_000 / SCALE;
const NODE_MODULES_DIRECTORIES = 9_000 / SCALE;
const FILES_PER_DIRECTORY = 10;

const directories: string[] = [];
// Removing 150,000 fixture files takes longer than the default hook timeout.
afterAll(async () => {
	for (const dir of directories) await rm(dir, { recursive: true, force: true });
}, 120_000);
const git = async (cwd: string, ...args: string[]) => {
	const r = await run(["git", "-c", "user.name=Perf", "-c", "user.email=perf@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], cwd, 64 * 1024 * 1024);
	if (r.exit !== 0) throw new Error("fixture git failed: " + r.stderr);
	return r.stdout.trim();
};
/** The reviewed base collector's Git commands and reads, in its order (no ignore classification). */
async function baseCollectorWork(path: string, baseCommit: string) {
	const g = async (args: string[]) => {
		const r = await run(["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", path, ...args], path, 4 * 1024 * 1024, isolatedGitEnvironment(path));
		if (r.exit !== 0) throw new Error("git_failed");
		return r.stdout;
	};
	await readOwnedFile(path, ".fleet-identity.json");
	await g(["rev-parse", "HEAD"]);
	const patchArgs = ["diff", "--no-ext-diff", "--no-textconv", "--binary", baseCommit, "--", ".", ":(exclude).fleet-identity.json"];
	const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "--exclude=.gjc/", "-z"];
	await g(patchArgs);
	const tracked = await g(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", baseCommit]);
	const untracked = await g(untrackedArgs);
	await g(["diff", "--no-ext-diff", "--no-textconv", "--diff-filter=D", "--name-only", "-z", baseCommit]);
	for (const name of [...tracked.split("\0"), ...untracked.split("\0")].filter((p) => p && p !== ".fleet-identity.json"))
		await readOwnedFile(path, name);
	await g(["rev-parse", "HEAD"]);
	await g(patchArgs);
	await g(untrackedArgs);
}
/**
 * Alternating paired comparison: each pair measures the baseline and the candidate
 * back-to-back and counts a pass when the candidate stays within the budget of its
 * own baseline. Returns the pass count and the per-pair timings for diagnostics.
 */
const pairedBudget = async (baseline: () => Promise<unknown>, candidate: () => Promise<unknown>) => {
	let passes = 0;
	const pairs: { base: number; candidate: number; pass: boolean }[] = [];
	for (let i = 0; i < PAIRS; i++) {
		let started = performance.now();
		await baseline();
		const base = performance.now() - started;
		started = performance.now();
		await candidate();
		const candidateMs = performance.now() - started;
		const pass = candidateMs < PERFORMANCE_BUDGET * base + ALLOWANCE_MS;
		if (pass) passes++;
		pairs.push({ base: Math.round(base), candidate: Math.round(candidateMs), pass });
	}
	return { passes, pairs };
};

test(
	`performance budget: ${TRACKED_FILES.toLocaleString("en-US")} tracked files and a ${(NODE_MODULES_DIRECTORIES * (FILES_PER_DIRECTORY + 1)).toLocaleString("en-US")}-entry ignored node_modules (in-tree or global ignore) collect within 3x the base collector`,
	async () => {
		const dir = await realpath(await mkdtemp(join(tmpdir(), "fleet-collection-perf-")));
		directories.push(dir);
		const repo = join(dir, "repo");
		mkdirSync(repo);
		await git(repo, "init", "-q");
		for (let i = 0; i < TRACKED_FILES; i++) {
			const sub = join(repo, "s", "m" + String(i % 500).padStart(3, "0"));
			if (i < 500) mkdirSync(sub, { recursive: true });
			writeFileSync(join(sub, `c${i}.ts`), `export const v${i} = ${i};\n`);
		}
		writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
		await git(repo, "add", "-A");
		await git(repo, "commit", "-q", "-m", "base");
		const baseCommit = await git(repo, "rev-parse", "HEAD");
		const identity = await prepareWorkspace({ taskId: "perf", attemptId: "attempt", nodeId: "node", inputDigest: sha256("perf"), repo, baseCommit, workspaceRoot: join(dir, "ws") });
		for (let d = 0; d < NODE_MODULES_DIRECTORIES; d++) {
			const sub = join(identity.path, "node_modules", `pkg-${d % 500}`, "lib", `sub-${d}`);
			mkdirSync(sub, { recursive: true });
			for (let i = 0; i < FILES_PER_DIRECTORY; i++) writeFileSync(join(sub, `f${i}.js`), "module.exports = 1;\n");
		}
		writeFileSync(join(identity.path, "s", "m000", "c0.ts"), "export const v0 = 'changed';\n");
		writeFileSync(join(identity.path, "deliverable.txt"), "deliverable\n");

		// In-tree ignore (tracked .gitignore): complete export.
		let result = await collectResult(identity, []);
		const inTree = await pairedBudget(
			() => baseCollectorWork(identity.path, baseCommit),
			async () => (result = await collectResult(identity, [])),
		);
		expect(result.files.map((file) => file.path)).toEqual(["deliverable.txt", "s/m000/c0.ts"]);
		expect(result.exportComplete).toBe(true);
		expect(result.ignored).toEqual({ count: 1, unlisted: 0, paths: ["node_modules/"] });

		// Ignored only by the node's global excludes: an annotated exclusion, same budget.
		const xdg = join(dir, "xdg");
		mkdirSync(join(xdg, "git"), { recursive: true });
		writeFileSync(join(xdg, "git", "ignore"), "node_modules/\n");
		writeFileSync(join(identity.path, ".gitignore"), "");
		const saved = process.env.XDG_CONFIG_HOME;
		process.env.XDG_CONFIG_HOME = xdg;
		let global: Awaited<ReturnType<typeof pairedBudget>>;
		try {
			global = await pairedBudget(
				() => baseCollectorWork(identity.path, baseCommit),
				async () => (result = await collectResult(identity, [])),
			);
		} finally {
			if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = saved;
		}
		expect(result.exclusions).toEqual([{ path: "node_modules", reason: "ignored_out_of_tree", outerTrackedEntries: 0, source: "excludes_file" }]);
		expect(result.files.map((file) => file.path)).toEqual([".gitignore", "deliverable.txt", "s/m000/c0.ts"]);

		console.log(
			`collection performance (paired, ms): inTree ${inTree.passes}/${PAIRS} pairs within budget ${JSON.stringify(inTree.pairs)}; global ${global.passes}/${PAIRS} pairs within budget ${JSON.stringify(global.pairs)}`,
		);
		expect(inTree.passes).toBeGreaterThanOrEqual(REQUIRED_PASSES);
		expect(global.passes).toBeGreaterThanOrEqual(REQUIRED_PASSES);
	},
	// Eight pairs per phase (in-tree and global), plus a warm-up collect: raised with PAIRS 5→8.
	900_000,
);
