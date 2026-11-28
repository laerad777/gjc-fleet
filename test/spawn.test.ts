import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FLEET_GIT_NAME, GIT_HARDENING, isolatedGitEnvironment, NULL_DEVICE, resolveProgram, spawnGit, spawnGitSync, spawnTrusted, trustedPathValue, UntrustedProgramError } from "../src/spawn";
import { runGit } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";
import { planter, type Planter } from "./support/planted";

const WIN = process.platform === "win32";
const DELIM = WIN ? ";" : ":";
const realGit = Bun.which("git")!;
const gitDir = dirname(realGit);
/** Fleet Git path: `git.exe` on Windows; same as `realGit` elsewhere. */
const fleetGit = resolveProgram(FLEET_GIT_NAME);
let T: string;
let P: Planter;
const savedPath = process.env.PATH;
const cleanup: string[] = [];
beforeAll(() => {
	// Long-name form, so the 8.3 alias below is a genuinely different spelling.
	T = realpathSync.native(mkdtempSync(join(tmpdir(), "fleet-spawn-")));
	P = planter(T);
});
afterEach(() => {
	process.env.PATH = savedPath;
});
afterAll(() => {
	for (const dir of [...cleanup, T]) rmSync(dir, { recursive: true, force: true });
});
function dir(name: string) {
	const d = join(T, name);
	mkdirSync(d, { recursive: true });
	return d;
}
/** Windows 8.3 short form of an existing path, or undefined when the volume has none. */
function shortName(path: string): string | undefined {
	const { dlopen, FFIType, ptr } = require("bun:ffi");
	const kernel = dlopen("kernel32.dll", { GetShortPathNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 } });
	try {
		const input = Buffer.from(path + "\0", "utf16le"), output = Buffer.alloc(65536);
		const n = kernel.symbols.GetShortPathNameW(ptr(input), ptr(output), 32768);
		const out = output.toString("utf16le", 0, n * 2);
		return n && out.toLowerCase() !== path.toLowerCase() ? out : undefined;
	} finally {
		kernel.close();
	}
}

test("bare names resolve exactly like Bun.which from a clean cwd", () => {
	for (const name of ["git", "tar", "ssh", "sh", "bun", "cmd", "powershell"]) {
		const expected = Bun.which(name);
		if (expected) expect(resolveProgram(name, { cwd: T })).toBe(expected);
	}
});

test("a planted program in the spawn cwd or the parent cwd is never chosen", () => {
	for (const kind of P.kinds) {
		const hostile = dir("cwd" + kind);
		P.plant(hostile, "git", kind);
		expect(resolveProgram("git", { cwd: hostile })).toBe(realGit);
		const previous = process.cwd();
		process.chdir(hostile);
		try {
			expect(resolveProgram("git")).toBe(realGit);
		} finally {
			process.chdir(previous);
		}
	}
});

test("empty, relative, drive-relative, root-relative and UNC PATH entries are never searched", () => {
	const hostile = dir("relative");
	P.plant(hostile, "git", P.kinds[0]!);
	const entries = ["", ".", "relative", WIN ? "C:relative" : "./relative", ...(WIN ? ["\\relative", "\\\\localhost\\" + hostile[0] + "$" + hostile.slice(2)] : []), gitDir];
	process.env.PATH = entries.join(DELIM);
	expect(resolveProgram("git", { cwd: hostile })).toBe(realGit);
	expect(resolveProgram("git", { cwd: T })).toBe(realGit);
	expect(trustedPathValue()).toBe(gitDir);
});

test("a PATH entry equal to the cwd is skipped even when absolute", () => {
	const hostile = dir("equal");
	P.plant(hostile, "git", P.kinds[0]!);
	process.env.PATH = [hostile, gitDir].join(DELIM);
	expect(resolveProgram("git", { cwd: hostile })).toBe(realGit);
});

test("PATH entries inside or aliasing an untrusted root are skipped (case, junction/symlink, 8.3, UNC)", () => {
	const root = dir("root");
	const bin = dir("root/bin");
	P.plant(bin, "git", P.kinds[0]!);
	const aliases: Record<string, string> = { direct: bin, case: WIN ? bin.toUpperCase() : bin };
	const link = join(T, "alias-link");
	try {
		symlinkSync(root, link, WIN ? "junction" : "dir");
		aliases.junction = join(link, "bin");
	} catch {}
	if (WIN) {
		const short = shortName(bin);
		if (short) aliases.shortName = short;
	}
	console.log("alias forms exercised:", JSON.stringify(aliases));
	for (const [label, entry] of Object.entries(aliases)) {
		process.env.PATH = [entry, gitDir].join(DELIM);
		expect({ label, resolved: resolveProgram("git", { cwd: T, untrusted: [root] }) }).toEqual({ label, resolved: realGit });
		expect({ label, path: trustedPathValue({ untrusted: [root] }) }).toEqual({ label, path: gitDir });
		// The same entry is used when nothing marks it untrusted: the filter, not the PATH, decided.
		expect(resolveProgram("git", { cwd: T })).not.toBe(realGit);
	}
	if (WIN) {
		// The untrusted root given in UNC admin-share form still matches a drive-letter PATH entry.
		const unc = "\\\\localhost\\" + root[0] + "$" + root.slice(2);
		process.env.PATH = [bin, gitDir].join(DELIM);
		expect(resolveProgram("git", { cwd: T, untrusted: [unc] })).toBe(realGit);
		// Untrusted roots also match through the 8.3 form and case.
		const short = shortName(root);
		if (short) expect(resolveProgram("git", { cwd: T, untrusted: [short] })).toBe(realGit);
		expect(resolveProgram("git", { cwd: T, untrusted: [root.toUpperCase()] })).toBe(realGit);
	}
});

test("a trusted PATH entry whose program is a link into an untrusted root is skipped", () => {
	const root = dir("linkroot");
	const target = P.plant(root, "git", P.kinds[0]!);
	const trusted = dir("trusted-bin");
	try {
		symlinkSync(target, join(trusted, WIN ? "git" + P.kinds[0] : "git"));
	} catch {
		return; // file symlinks need a privilege this host may lack; junctions are covered above
	}
	process.env.PATH = [trusted, gitDir].join(DELIM);
	expect(resolveProgram("git", { cwd: T, untrusted: [root] })).toBe(realGit);
});

test("explicit program paths: relative refused, inside untrusted refused, missing passed through to Bun's ENOENT", () => {
	const root = dir("explicit");
	const planted = P.plant(root, "tool", P.kinds[0]!);
	expect(() => resolveProgram(WIN ? ".\\tool" : "./tool", { cwd: root })).toThrow(UntrustedProgramError);
	expect(() => resolveProgram("sub/tool", { cwd: root })).toThrow("untrusted_program_path:sub/tool");
	expect(() => resolveProgram(planted, { untrusted: [root] })).toThrow("untrusted_program_path:");
	expect(resolveProgram(planted)).toBe(planted);
	const missing = join(T, "missing", WIN ? "x.exe" : "x");
	expect(resolveProgram(missing)).toBe(missing);
	let bunError: any, ourError: any;
	try { Bun.spawn([missing]); } catch (e) { bunError = e; }
	try { spawnTrusted([missing], {}); } catch (e) { ourError = e; }
	expect(ourError?.message).toBe(bunError?.message);
	expect(ourError?.code).toBe(bunError?.code);
});

test("an unresolvable bare name fails with Bun's own error, without searching the cwd", () => {
	const hostile = dir("notfound");
	P.plant(hostile, "fleet-nowhere", P.kinds[0]!);
	P.reset();
	let bunError: any, ourError: any;
	try { Bun.spawn(["fleet-nowhere-else"]); } catch (e) { bunError = e; }
	try { spawnTrusted(["fleet-nowhere-else"], { cwd: hostile }); } catch (e) { ourError = e; }
	expect(ourError?.message).toBe(bunError?.message);
	expect(ourError?.code).toBe(bunError?.code);
	expect(() => spawnTrusted(["fleet-nowhere"], { cwd: hostile })).toThrow('Executable not found in $PATH: "fleet-nowhere"');
	expect(P.ran()).toEqual([]);
});

test("programs found on the trusted PATH still run by absolute path, scripts included (.cmd/.bat shims)", async () => {
	const bin = dir("run-bin");
	for (const kind of P.kinds) {
		const name = "fleet-shim" + kind.replace(".", "-");
		const file = P.plant(bin, name, kind);
		process.env.PATH = [bin, savedPath].join(DELIM);
		P.reset();
		const child = spawnTrusted([name, "arg-one"], { cwd: T, stdout: "pipe", stderr: "pipe" });
		expect(await child.exited).toBe(3);
		const ran = P.ran();
		expect(ran).toHaveLength(1);
		expect(ran[0]).toContain("arg-one");
		expect(resolveProgram(name, { cwd: T })).toBe(file);
	}
	P.reset();
});

test("resolution is cached per PATH snapshot", () => {
	const first = dir("cache-first"), second = dir("cache-second");
	const kind = WIN ? ".cmd" : "";
	const later = P.plant(second, "fleet-cached", kind);
	process.env.PATH = [first, second].join(DELIM);
	expect(resolveProgram("fleet-cached", { cwd: T })).toBe(later);
	// Same PATH: the candidate *paths* are cached, so a program appearing later in an earlier entry is not picked up.
	const earlier = P.plant(first, "fleet-cached", kind);
	expect(resolveProgram("fleet-cached", { cwd: T })).toBe(later);
	// A different PATH is a different cache entry.
	process.env.PATH = [first, second, gitDir].join(DELIM);
	expect(resolveProgram("fleet-cached", { cwd: T })).toBe(earlier);
});

test("cached PATH candidates re-check realpath against untrusted trees at resolve time", () => {
	const bin = dir("cache-trust-bin");
	const hostile = dir("cache-trust-hostile");
	const kind = WIN ? ".cmd" : "";
	const safe = P.plant(bin, "fleet-recheck", kind);
	process.env.PATH = [bin, gitDir].join(DELIM);
	expect(resolveProgram("fleet-recheck", { cwd: T, untrusted: [hostile] })).toBe(safe);
	// After the PATH snapshot is cached, replace the candidate with a symlink into an untrusted tree.
	rmSync(safe);
	mkdirSync(join(hostile, "nested"), { recursive: true });
	const planted = P.plant(join(hostile, "nested"), "fleet-recheck", kind);
	symlinkSync(planted, safe);
	expect(() => resolveProgram("fleet-recheck", { cwd: T, untrusted: [hostile] })).toThrow();
	expect(P.ran()).toEqual([]);
});

test("trustedPathValue re-locates PATH directories after a cached entry becomes an untrusted alias", () => {
	const bin = dir("path-value-bin");
	const hostile = dir("path-value-hostile");
	process.env.PATH = [bin, gitDir].join(DELIM);
	// Warm any process-start location cache while the entry is still outside the untrusted root.
	expect(trustedPathValue({ untrusted: [hostile] })).toBe([bin, gitDir].join(DELIM));
	const nested = dir("path-value-hostile/alias");
	rmSync(bin, { recursive: true, force: true });
	try {
		symlinkSync(nested, bin, WIN ? "junction" : "dir");
	} catch {
		return; // junctions/symlinks may need a privilege this host lacks
	}
	// Direct resolveProgram already re-checks; child PATH must drop the aliased entry too.
	expect(trustedPathValue({ untrusted: [hostile] })).toBe(gitDir);
	expect(trustedPathValue({ untrusted: [hostile] }).split(DELIM)).not.toContain(bin);
});

test("spawnGit: absolute git, cwd outside the repository, -C <repo>, hardening flags and sanitized env", async () => {
	const f = await repositoryFixture("fleet-spawn-git-");
	cleanup.push(f.dir);
	const original = Bun.spawn.bind(Bun);
	let seen: { cmd: string[]; options: any } | undefined;
	const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: any) => {
		seen = { cmd, options };
		return original(cmd, options);
	}) as any);
	process.env.GIT_DIR = join(T, "not-a-repo");
	process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor'='planted'";
	try {
		const r = await runGit(f.repo, ["rev-parse", "HEAD"]);
		expect(r).toEqual({ exit: 0, stdout: f.baseCommit + "\n", stderr: "" });
	} finally {
		spy.mockRestore();
		delete process.env.GIT_DIR;
		delete process.env.GIT_CONFIG_PARAMETERS;
	}
	expect(seen!.cmd).toEqual([fleetGit, ...GIT_HARDENING, "-C", f.repo, "rev-parse", "HEAD"]);
	expect(seen!.options.cwd).toBe(dirname(fleetGit));
	expect(seen!.options.cwd.toLowerCase().startsWith(f.dir.toLowerCase())).toBe(false);
	const env = seen!.options.env;
	expect(env).toEqual(isolatedGitEnvironment(f.repo));
	expect(env.GIT_DIR).toBeUndefined();
	expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
	expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
	expect(env.GIT_CONFIG_GLOBAL).toBe(WIN ? "NUL" : "/dev/null");
});

test("spawnGit ignores repository-controlled hooks, fsmonitor, pager, editor, external diff and transports", async () => {
	const f = await repositoryFixture("fleet-spawn-hostile-");
	cleanup.push(f.dir);
	const hooks = dir("hostile-hooks");
	const program = P.plant(dir("hostile-programs"), "helper", P.kinds[0]!);
	for (const hook of ["post-index-change", "reference-transaction", "post-checkout"]) P.plant(hooks, hook, "");
	const set = async (key: string, value: string) => expect((await runGit(f.repo, ["config", key, value])).exit).toBe(0);
	await set("core.hooksPath", hooks);
	await set("core.fsmonitor", program);
	// Pager, sshCommand, editors and diff.external are shell commands: forward slashes survive sh.
	const command = program.replace(/\\/g, "/");
	await set("core.pager", command);
	await set("core.sshCommand", command);
	await set("core.editor", command);
	await set("sequence.editor", command);
	await set("diff.external", command);
	P.reset();
	for (const args of [["status", "--porcelain"], ["update-index", "--refresh"], ["diff", "--no-ext-diff", "--no-textconv", "HEAD"], ["log", "-1", "--format=%H"], ["show", "--no-ext-diff", "--no-textconv", "HEAD"], ["commit", "--amend", "--allow-empty"]]) {
		const r = await runGit(f.repo, args);
		expect({ args, exit: r.exit }).toEqual({ args, exit: 0 });
	}
	const fetch = await runGit(f.repo, ["fetch", "ssh://planted.invalid/repo"]);
	expect(fetch.exit).not.toBe(0);
	expect(fetch.stderr).toContain("not allowed");
	expect(P.ran()).toEqual([]);
	// Control: the same repository does run its configured program without the hardening.
	const bare = { cwd: T, env: { PATH: gitDir, SystemRoot: process.env.SystemRoot, HOME: f.repo, GIT_CONFIG_NOSYSTEM: "1" } };
	Bun.spawnSync([realGit, "-C", f.repo, "status", "--porcelain"], bare);
	expect(P.ran().length).toBeGreaterThan(0);
	P.reset();
	Bun.spawnSync([realGit, "-C", f.repo, "-c", "core.hooksPath=" + NULL_DEVICE, "-c", "core.fsmonitor=false", "commit", "--amend", "--allow-empty"], bare);
	expect(P.ran().length).toBeGreaterThan(0); // the editor runs
	P.reset();
	Bun.spawnSync([realGit, "-C", f.repo, "-c", "core.hooksPath=" + NULL_DEVICE, "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "show", "--ext-diff", "HEAD"], bare);
	expect(P.ran().length).toBeGreaterThan(0); // diff.external runs when external diffs are allowed
});

test("spawnGitSync: absolute git, cwd outside the repository, -C <repo>, hardening flags", async () => {
	const f = await repositoryFixture("fleet-spawn-git-sync-");
	cleanup.push(f.dir);
	const original = Bun.spawnSync.bind(Bun);
	let seen: { cmd: string[]; options: any } | undefined;
	const spy = spyOn(Bun, "spawnSync").mockImplementation(((cmd: string[], options: any) => {
		seen = { cmd, options };
		return original(cmd, options);
	}) as any);
	try {
		const r = spawnGitSync(f.repo, ["rev-parse", "HEAD"]);
		expect(r.exitCode).toBe(0);
		expect(Buffer.from(r.stdout).toString()).toBe(f.baseCommit + "\n");
	} finally {
		spy.mockRestore();
	}
	expect(seen!.cmd).toEqual([fleetGit, ...GIT_HARDENING, "-C", f.repo, "rev-parse", "HEAD"]);
	expect(seen!.options.cwd).toBe(dirname(fleetGit));
	expect(seen!.options.cwd.toLowerCase().startsWith(f.dir.toLowerCase())).toBe(false);
	expect(seen!.options.env).toEqual(isolatedGitEnvironment(f.repo));
});

test("spawnGitSync refuses a planted git under the repository even when PATH leads with it", async () => {
	const f = await repositoryFixture("fleet-spawn-git-sync-planted-");
	cleanup.push(f.dir);
	P.reset();
	const planted = P.plant(f.repo, "git", P.kinds[0]!);
	process.env.PATH = f.repo + DELIM + (savedPath ?? "");
	const r = spawnGitSync(f.repo, ["rev-parse", "HEAD"], { untrusted: [f.repo] });
	expect(r.exitCode).toBe(0);
	expect(Buffer.from(r.stdout).toString()).toBe(f.baseCommit + "\n");
	expect(P.ran()).toEqual([]);
	expect(resolveProgram("git", { untrusted: [f.repo] })).toBe(realGit);
	expect(planted).not.toBe(realGit);
});

test("trustedPathValue skips only EACCES from one locate and still throws other errors", () => {
	const denied = join(dir("locate-eacces"), "bin");
	const broken = join(dir("locate-eio"), "bin");
	const native = realpathSync.native.bind(realpathSync);
	const spy = spyOn(realpathSync, "native").mockImplementation((target) => {
		const text = String(target);
		if (text.includes("locate-eacces")) throw Object.assign(new Error("denied"), { code: "EACCES" });
		if (text.includes("locate-eio")) throw Object.assign(new Error("io"), { code: "EIO" });
		return native(target);
	});
	try {
		process.env.PATH = [denied, gitDir].join(DELIM);
		expect(trustedPathValue()).toBe(gitDir);
		process.env.PATH = [broken, gitDir].join(DELIM);
		let code = "";
		try { trustedPathValue(); } catch (error: any) { code = error?.code ?? ""; }
		expect(code).toBe("EIO");
	} finally {
		spy.mockRestore();
	}
});

const chmodEnforced = !WIN && process.getuid?.() !== 0;
test.skipIf(!chmodEnforced)("trustedPathValue drops a PATH entry the process cannot traverse", () => {
	const denied = dir("path-value-denied");
	const locked = join(denied, "locked");
	mkdirSync(join(locked, "bin"), { recursive: true });
	process.env.PATH = [join(locked, "bin"), gitDir].join(DELIM);
	chmodSync(denied, 0);
	try {
		expect(trustedPathValue()).toBe(gitDir);
	} finally {
		chmodSync(denied, 0o700);
	}
});
