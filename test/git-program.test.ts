import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, linkSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NodeConfig } from "../src/contracts";
import { authorizeInput, previewInput } from "../src/inputs";
import { prepareWorkspace, sha256 } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

// Real Git, real child processes. Every planted "git" records that it ran in a file named `ran` next to
// itself and exits 1. Each scenario runs Fleet in a fresh Bun process, so Fleet resolves Git for the
// first time under exactly the PATH/PATHEXT and start directory of that scenario.
const windows = process.platform === "win32";
const workspaceModule = fileURLToPath(new URL("../src/workspace.ts", import.meta.url));
const inputsModule = fileURLToPath(new URL("../src/inputs.ts", import.meta.url));
const preflightModule = fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url));
const nodeModule = fileURLToPath(new URL("../src/node.ts", import.meta.url));
const realGit = Bun.which("git");
if (!realGit) throw new Error("test requires git on PATH");
/** Fleet Git resolves `git.exe` on Windows; may differ from Bun.which("git") when that is a .cmd/.bat. */
const fleetGitName = windows ? "git.exe" : "git";
const fleetGit = windows ? (Bun.which("git.exe") ?? realGit) : realGit;
const fleetGitDir = dirname(fleetGit);
const systemTail = windows ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")] : ["/usr/bin", "/bin"];

let shared = "";
let markerExe = "";
beforeAll(async () => {
	shared = await realpath(await mkdtemp(join(tmpdir(), "fleet-git-program-")));
	await writeFile(join(shared, "driver.ts"), [
		"const [modulePath, name, argsJson] = process.argv.slice(2);",
		"const mod = await import(modulePath);",
		"try {",
		"	const value = await mod[name](...JSON.parse(argsJson));",
		"	console.log(JSON.stringify({ ok: true, value }));",
		"} catch (error) {",
		"	console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));",
		"}",
		"",
	].join("\n"));
	if (windows) {
		// A real PE executable: a planted git.exe must be refused exactly like a planted git.cmd/git.bat.
		await writeFile(join(shared, "marker.ts"), [
			'import { appendFileSync } from "node:fs";',
			'import { dirname, join } from "node:path";',
			'appendFileSync(join(dirname(process.execPath), "ran"), "exe\\n");',
			"process.exit(1);",
			"",
		].join("\n"));
		markerExe = join(shared, "marker.exe");
		const build = Bun.spawnSync([process.execPath, "build", "--compile", join(shared, "marker.ts"), "--outfile", markerExe], { cwd: shared, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		if (build.exitCode !== 0 || !existsSync(markerExe)) throw new Error("marker build failed: " + build.stderr.toString());
	}
}, 150_000);
afterAll(async () => {
	if (shared) await rm(shared, { recursive: true, force: true });
});
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function plant(dir: string, kinds: ("exe" | "cmd" | "bat")[] = ["exe", "cmd", "bat"]) {
	await mkdir(dir, { recursive: true });
	if (!windows) {
		await writeFile(join(dir, "git"), '#!/bin/sh\necho ran >> "$(dirname "$0")/ran"\nexit 1\n', { mode: 0o755 });
		return dir;
	}
	if (kinds.includes("exe")) linkSync(markerExe, join(dir, "git.exe"));
	for (const ext of ["cmd", "bat"] as const)
		if (kinds.includes(ext)) await writeFile(join(dir, "git." + ext), '@echo ran>>"%~dp0ran"\r\n@exit /b 1\r\n');
	return dir;
}
const ran = (dir: string) => existsSync(join(dir, "ran"));

async function fixture() {
	const f = await repositoryFixture("fleet-git-program-");
	directories.push(f.dir);
	// Planted programs inside the source checkout or a workspace are not results.
	await mkdir(join(f.repo, ".git", "info"), { recursive: true });
	await appendFile(join(f.repo, ".git", "info", "exclude"), "\ngit\ngit.exe\ngit.cmd\ngit.bat\nran\nbin/\ntools/\n");
	const input = { taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: sha256("input"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot };
	return { ...f, input };
}

function fleetEnv(path: string[], pathext?: string) {
	const env: Record<string, string | undefined> = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|pathext)$/i.test(key)));
	env.PATH = path.join(delimiter);
	if (windows) env.PATHEXT = pathext ?? ".COM;.EXE;.BAT;.CMD";
	return env;
}
/** Runs `module[name](...args)` in a fresh Bun process with exactly this PATH (and PATHEXT on Windows). */
function fleet(modulePath: string, name: string, args: unknown[], o: { cwd: string; path: string[]; pathext?: string }) {
	const env = fleetEnv(o.path, o.pathext);
	const child = Bun.spawnSync([process.execPath, join(shared, "driver.ts"), pathToFileURL(modulePath).href, name, JSON.stringify(args)], { cwd: o.cwd, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	const line = child.stdout.toString().trim().split("\n").pop() ?? "";
	try {
		return JSON.parse(line) as { ok: true; value?: any } | { ok: false; error: string }; // JSON.stringify drops an undefined value
	} catch {
		throw new Error(`driver exit ${child.exitCode}: ${child.stdout}\n${child.stderr}`);
	}
}

test("collectResult never runs a git planted in the workspace via the start directory or '.', empty or relative PATH entries", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const top = await plant(identity.path);
	const bin = await plant(join(identity.path, "bin"));
	await writeFile(join(identity.path, "result.txt"), "worker result\n");
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: identity.path, path: [".", "", "bin", fleetGitDir, ...systemTail] });
	expect(ran(top)).toBe(false);
	expect(ran(bin)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	expect((r as any).value.files.map((file: any) => file.path)).toEqual(["result.txt"]);
}, 120_000);

test("F5: collectResult skips, and never runs, a git on PATH inside the workspace root or the source repository", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const sibling = await plant(join(dirname(identity.path), "sibling-workspace"));
	const inRepo = await plant(join(identity.repo, "tools"));
	for (const dir of [sibling, inRepo]) {
		const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [dir, fleetGitDir, ...systemTail] });
		expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	}
	expect(ran(sibling)).toBe(false);
	expect(ran(inRepo)).toBe(false);
}, 120_000);

test.skipIf(!windows)("PATHEXT ordering cannot make Fleet run a git.cmd or git.bat ahead of git.exe", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const tools = await plant(join(f.dir, "tools"), ["cmd", "bat"]);
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [tools, fleetGitDir, ...systemTail], pathext: ".CMD;.BAT;.EXE;.COM" });
	expect(ran(tools)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
}, 120_000);

test.skipIf(!windows)("Fleet Git resolves only git.exe, skipping a trusted PATH that holds only git.cmd/git.bat", async () => {
	const tools = await plant(join(shared, "trusted-cmd-only"), ["cmd", "bat"]);
	const r = fleet(workspaceModule, "gitProgram", [[]], { cwd: shared, path: [tools, fleetGitDir, ...systemTail], pathext: ".CMD;.BAT;.EXE;.COM" });
	expect(ran(tools)).toBe(false);
	expect(r).toEqual({ ok: true, value: fleetGit });
	expect(String((r as { ok: true; value: string }).value).toLowerCase().endsWith("\\" + fleetGitName)).toBe(true);
}, 120_000);

test("prepareWorkspace never runs a git planted in the source repository via the start directory or '.'", async () => {
	const f = await fixture();
	const planted = await plant(f.repo);
	const r = fleet(workspaceModule, "prepareWorkspace", [f.input], { cwd: f.repo, path: [".", fleetGitDir, ...systemTail] });
	expect(ran(planted)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { baseCommit: f.baseCommit, path: join(f.workspaceRoot, "task-attempt") } });
}, 120_000);

test("prepareWorkspace skips, and never runs, a git on PATH inside the workspace root or the source repository", async () => {
	for (const where of ["sibling", "inRepo"] as const) {
		const f = await fixture();
		const planted =
			where === "sibling"
				? await plant(join(f.workspaceRoot, "sibling-workspace"))
				: await plant(join(f.repo, "tools"));
		const r = fleet(workspaceModule, "prepareWorkspace", [f.input], {
			cwd: f.dir,
			path: [planted, fleetGitDir, ...systemTail],
		});
		expect(r).toMatchObject({ ok: true, value: { baseCommit: f.baseCommit } });
		expect(ran(planted)).toBe(false);
	}
}, 120_000);

async function inputFixture() {
	const f = await fixture();
	await writeFile(join(f.repo, "tracked.txt"), "authorized input bytes\n");
	const pkg = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["tracked.txt"], includeObjects: false });
	const approved = authorizeInput(pkg, pkg.digest, "operator:fixture");
	const identity = await prepareWorkspace({ ...f.input, inputPackageDigest: pkg.digest });
	return { f, approved, identity };
}

test("applyInput never runs a git planted in the workspace via the start directory or '.'", async () => {
	const { approved, identity } = await inputFixture();
	const planted = await plant(identity.path);
	const r = fleet(inputsModule, "applyInput", [identity, approved], { cwd: identity.path, path: [".", fleetGitDir, ...systemTail] });
	expect(ran(planted)).toBe(false);
	expect(r).toEqual({ ok: true });
	expect(await Bun.file(join(identity.path, "tracked.txt")).text()).toBe("authorized input bytes\n");
}, 120_000);

test("applyInput skips, and never runs, a git on PATH inside the task workspace", async () => {
	const { approved, identity } = await inputFixture();
	const planted = await plant(join(identity.path, "bin"));
	const r = fleet(inputsModule, "applyInput", [identity, approved], { cwd: dirname(identity.repo), path: [planted, fleetGitDir, ...systemTail] });
	expect(r).toEqual({ ok: true });
	expect(ran(planted)).toBe(false);
	expect(await Bun.file(join(identity.path, "tracked.txt")).text()).toBe("authorized input bytes\n");
}, 120_000);

test("placement source probe never runs a git planted in the repository, via the start directory, '.' or an absolute PATH entry", async () => {
	const f = await fixture();
	const planted = await plant(f.repo);
	const node: NodeConfig = { id: "NODEG", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: [], transport: { command: process.execPath, args: [] } };
	const r = fleet(preflightModule, "probePlacementSource", [node, { repoId: "fixture", baseCommit: f.baseCommit }], { cwd: f.repo, path: [".", fleetGitDir, ...systemTail] });
	expect(ran(planted)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { source: { ok: true, code: "repo_and_exact_base_present" } } });
	const tools = await plant(join(f.repo, "tools"));
	const skipped = fleet(preflightModule, "probePlacementSource", [node, { repoId: "fixture", baseCommit: f.baseCommit }], { cwd: f.dir, path: [tools, fleetGitDir, ...systemTail] });
	expect(ran(tools)).toBe(false);
	expect(skipped).toMatchObject({ ok: true, value: { source: { ok: true, code: "repo_and_exact_base_present" } } });
}, 120_000);

/** A working git that records each run in `ran` beside itself and delegates to the real Git. */
async function forwardingGit(dir: string) {
	await mkdir(dir, { recursive: true });
	if (!windows) {
		const program = join(dir, "git");
		await writeFile(program, `#!/bin/sh\necho ran >> "$(dirname "$0")/ran"\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
		return program;
	}
	const source = join(dir, "forwarding-git.ts");
	await writeFile(source, [
		'import { appendFileSync } from "node:fs";',
		'import { dirname, join } from "node:path";',
		'appendFileSync(join(dirname(process.execPath), "ran"), "exe\\n");',
		`const r = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });`,
		"process.exit(r.exitCode ?? 1);",
		"",
	].join("\n"));
	const program = join(dir, "git.exe");
	const build = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", program], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	if (build.exitCode !== 0 || !existsSync(program)) throw new Error("forwarding git build failed: " + build.stderr.toString());
	return program;
}

function nodeConfig(f: { workspaceRoot: string }, roots: Record<string, string>): NodeConfig {
	return { id: "node", os: process.platform, arch: process.arch, roots, workspaceRoot: f.workspaceRoot, maxConcurrency: 1, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [] } } as NodeConfig;
}

test("F1: prepare and preflight with authorized source objects skip, and never run, a git on PATH inside the workspace root", async () => {
	const f = await fixture();
	await writeFile(join(f.repo, "selected.txt"), "explicitly selected bytes\n");
	const preview = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["selected.txt"], includeObjects: true });
	const pkg = authorizeInput(preview, preview.digest, "operator:fixture");
	const sibling = await plant(join(f.workspaceRoot, "sibling-workspace"));
	const node = nodeConfig(f, { fixture: join(f.dir, "not-installed-source") });
	const input = { taskId: "task", attemptId: "attempt", nodeId: node.id, inputDigest: sha256("input"), repoId: "fixture", baseCommit: f.baseCommit, inputPackage: pkg };
	for (const action of ["prepare", "preflight"]) {
		const r = fleet(nodeModule, "nodeOperation", [node, { action, input }], { cwd: f.dir, path: [sibling, fleetGitDir, ...systemTail] });
		// Trusted PATH still has a real git outside the workspace: skip the planted entry and continue.
		expect(r.ok).toBe(true);
	}
	expect(ran(sibling)).toBe(false);
}, 120_000);

test("F1: applyInput skips, and never runs, a git on PATH inside the workspace root or the source repository", async () => {
	for (const where of ["sibling", "inRepo"] as const) {
		const { f, approved, identity } = await inputFixture();
		const planted =
			where === "sibling"
				? await plant(join(f.workspaceRoot, "sibling-workspace"))
				: await plant(join(f.repo, "tools"));
		const r = fleet(inputsModule, "applyInput", [identity, approved], {
			cwd: f.dir,
			path: [planted, fleetGitDir, ...systemTail],
		});
		expect(r).toEqual({ ok: true });
		expect(ran(planted)).toBe(false);
		expect(await Bun.file(join(identity.path, "tracked.txt")).text()).toBe(
			"authorized input bytes\n",
		);
	}
}, 120_000);

test("F2: when the Git program on PATH is removed within one process, the next Git call uses the next PATH entry", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const upgraded = join(f.dir, "upgraded-git");
	const program = await forwardingGit(upgraded);
	const script = join(f.dir, "collect-twice.ts");
	await writeFile(script, [
		'import { rmSync } from "node:fs";',
		`const { collectResult } = await import(${JSON.stringify(pathToFileURL(workspaceModule).href)});`,
		"const out: string[] = [];",
		"for (const step of [0, 1]) {",
		`\ttry { out.push((await collectResult(${JSON.stringify(identity)}, [])).outputHead); } catch (e) { out.push("error:" + (e as Error).message); }`,
		`\tif (step === 0) rmSync(${JSON.stringify(program)});`,
		"}",
		"console.log(JSON.stringify(out));",
		"",
	].join("\n"));
	const child = Bun.spawnSync([process.execPath, script], { cwd: f.dir, env: fleetEnv([upgraded, fleetGitDir, ...systemTail]), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	expect(ran(upgraded)).toBe(true);
	expect(JSON.parse(child.stdout.toString().trim().split("\n").pop() || "null")).toEqual([f.baseCommit, f.baseCommit]);
}, 180_000);

test.skipIf(windows || process.getuid?.() === 0)("F3: a git whose mode has an execute bit this user lacks is skipped, as the PATH lookup did", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const dir = join(f.dir, "not-executable");
	await mkdir(dir);
	await writeFile(join(dir, "git"), '#!/bin/sh\necho ran >> "$(dirname "$0")/ran"\nexit 1\n');
	await chmod(join(dir, "git"), 0o610);
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [dir, fleetGitDir, ...systemTail] });
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	expect(ran(dir)).toBe(false);
}, 120_000);

test("F5: a PATH entry that is a symlink or junction into the workspace root is skipped, never run", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const sibling = await plant(join(f.workspaceRoot, "sibling-workspace"));
	const link = join(f.dir, "linked-tools");
	await symlink(sibling, link, windows ? "junction" : "dir");
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [link, fleetGitDir, ...systemTail] });
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	expect(ran(sibling)).toBe(false);
}, 120_000);

test("F5: a git in a workspace-root directory whose name starts with '..' is inside the root, skipped, never run", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const dotted = await plant(join(f.workspaceRoot, "..sibling"));
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [dotted, fleetGitDir, ...systemTail] });
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	expect(ran(dotted)).toBe(false);
}, 120_000);

/**
 * A multicall launcher outside every untrusted tree that acts as Git only when invoked under the name `git`
 * (snap, mise-style shims): it records the invoked name in `log` and forwards to the real Git, and under
 * any other name exits 64. `bin/git(.exe)` is a symlink to it.
 */
async function multicallGit(dir: string, log: string) {
	await mkdir(join(dir, "mc"), { recursive: true });
	await mkdir(join(dir, "bin"), { recursive: true });
	let program = join(dir, "mc", "multicall");
	if (!windows) {
		await writeFile(program, `#!/bin/sh\nname=$(basename "$0")\necho "$name" >> '${log}'\n[ "$name" = git ] || exit 64\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
	} else {
		const source = join(dir, "multicall.ts");
		await writeFile(source, [
			'import { appendFileSync } from "node:fs";',
			'import { basename } from "node:path";',
			'const name = basename(process.argv0).replace(/\\.exe$/i, "");',
			`appendFileSync(${JSON.stringify(log)}, name + "\\n");`,
			'if (name !== "git") process.exit(64);',
			`const r = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });`,
			"process.exit(r.exitCode ?? 1);",
			"",
		].join("\n"));
		program += ".exe";
		const build = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", program], { cwd: dir, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		if (build.exitCode !== 0 || !existsSync(program)) throw new Error("multicall build failed: " + build.stderr.toString());
	}
	await symlink(program, join(dir, "bin", windows ? "git.exe" : "git"), "file");
	return join(dir, "bin");
}

test("R6-F1: a PATH git that is a symlink to a name-dispatching launcher runs under the name git", async () => {
	const f = await fixture();
	const identity = await prepareWorkspace(f.input);
	const log = join(f.dir, "multicall.log");
	const bin = await multicallGit(join(f.dir, "launcher"), log);
	const r = fleet(workspaceModule, "collectResult", [identity, []], { cwd: f.dir, path: [bin, ...systemTail] });
	expect(r).toMatchObject({ ok: true, value: { outputHead: f.baseCommit } });
	const names = new Set((await Bun.file(log).text()).trim().split(/\r?\n/));
	expect([...names]).toEqual(["git"]);
}, 180_000);

test.skipIf(!windows)("R6-F2: UNC and \\\\?\\ PATH entries are never searched, as documented: only drive-letter entries are", async () => {
	const unc = "\\\\localhost\\" + fleetGitDir[0] + "$" + fleetGitDir.slice(2);
	const r = fleet(workspaceModule, "gitProgram", [[]], { cwd: shared, path: ["\\\\?\\" + fleetGitDir, unc] });
	expect(r).toEqual({ ok: false, error: "git_unavailable" });
	expect(fleet(workspaceModule, "gitProgram", [[]], { cwd: shared, path: [fleetGitDir] })).toEqual({ ok: true, value: fleetGit });
}, 120_000);

function probeNode(f: { repo: string }, workspaceRoot: string): NodeConfig {
	return { id: "NODEG", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: [], transport: { command: process.execPath, args: [] } } as NodeConfig;
}

test("R6-F3: placement source probe skips, and never runs, a git on PATH inside the workspace root", async () => {
	const f = await fixture();
	const sibling = await plant(join(f.workspaceRoot, "sibling-workspace"));
	const r = fleet(preflightModule, "probePlacementSource", [probeNode(f, f.workspaceRoot), { repoId: "fixture", baseCommit: f.baseCommit }], { cwd: f.dir, path: [sibling, fleetGitDir, ...systemTail] });
	expect(ran(sibling)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { source: { ok: true, code: "repo_and_exact_base_present" } } });
}, 120_000);

test("R6-F3: a workspace root named through a junction or symlink still skips its git, never run", async () => {
	const f = await fixture();
	const sibling = await plant(join(f.workspaceRoot, "sibling-workspace"));
	const alias = join(f.dir, "workspace-root-alias");
	await symlink(f.workspaceRoot, alias, windows ? "junction" : "dir");
	const r = fleet(preflightModule, "probePlacementSource", [probeNode(f, alias), { repoId: "fixture", baseCommit: f.baseCommit }], { cwd: f.dir, path: [sibling, fleetGitDir, ...systemTail] });
	expect(ran(sibling)).toBe(false);
	expect(r).toMatchObject({ ok: true, value: { source: { ok: true, code: "repo_and_exact_base_present" } } });
}, 120_000);
