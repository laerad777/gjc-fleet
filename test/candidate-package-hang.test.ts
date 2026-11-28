// Special files and git children that never finish (review 28f9fd87 R1), verify's exclusion shape (R2) and
// non-path git answers (R3). Every repository and stub lives under the OS temp dir.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { MANIFEST_MEMBER, VERSION, packageCandidate, tarHeader, verifyCandidate } from "../scripts/candidate-package";
import * as cp from "../scripts/candidate-package";
import { unixSocketSkipReason } from "./support/unix-socket-capability";

const TOOL = join(import.meta.dir, "../scripts/candidate-package.ts");
const win = process.platform === "win32";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cand-hang-"));
	const root = join(dir, "repo");
	mkdirSync(root);
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: win ? "NUL" : "/dev/null" };
	const g = (...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "-C", root, ...args], { env });
		if (r.exitCode !== 0) throw Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString();
	};
	const w = (p: string, d: string | Uint8Array) => {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), d);
	};
	g("init", "-q");
	w("a.txt", "a\n");
	g("add", ".");
	g("commit", "-qm", "a");
	const out = join(dir, "c.tar.gz");
	return { dir, root, g, w, out, done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) };
}
type Fixture = ReturnType<typeof fixture>;

async function refusal(p: Promise<unknown>): Promise<string> {
	try {
		await p;
	} catch (e) {
		expect((e as Error).name).toBe("CandidateRefusal");
		return (e as Error).message;
	}
	throw new Error("expected a CandidateRefusal, got success");
}
const mkfifo = (p: string) => expect(Bun.spawnSync(["mkfifo", p]).exitCode).toBe(0);
async function socketAt(p: string): Promise<Server> {
	const s = createServer();
	await new Promise<void>((res, reject) => {
		s.once("error", reject);
		s.listen(p, () => { s.removeListener("error", reject); res(); });
	});
	return s;
}
// Bun's node:net Unix listen error omits errno. Corroborate it independently only
// on an ordinary local run; CI stays strict and still executes every Unix case.
async function localUnixSocketUnavailable(): Promise<boolean> {
	if (win) return false;
	const ci = Boolean(process.env.CI || process.env.GITHUB_ACTIONS);
	if (ci) return Boolean(await unixSocketSkipReason(ci));
	const dir = mkdtempSync(join(tmpdir(), "cand-sock-"));
	const path = join(dir, "s");
	try {
		const reason = await unixSocketSkipReason(ci, async () => {
			const server = await socketAt(path);
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}, () => {
			const node = Bun.which("node");
			if (!node) return;
			const probe = Bun.spawnSync([node, "-e", [
				'const s = require("node:net").createServer();',
				's.once("error", e => process.stdout.write(e.code || ""));',
				's.listen(process.argv[1], () => s.close());',
			].join(" "), path], { timeout: 3000 });
			return probe.exitCode === 0 ? probe.stdout.toString().trim() : undefined;
		});
		if (reason) console.warn(reason);
		return Boolean(reason);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
const noUnixSockets = await localUnixSocketUnavailable();
/** Processes whose command line mentions `needle` (the fixture's unique temp path). */
function processesMentioning(needle: string): string[] {
	const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,stat=,command="]);
	return r.stdout
		.toString()
		.split("\n")
		.filter((l) => l.includes(needle));
}
/** Neither present nor a zombie; polls because a killed grandchild is reaped by init asynchronously. */
async function gone(pid: number, ms = 5000): Promise<boolean> {
	for (const end = Date.now() + ms; ; await Bun.sleep(50)) {
		const st = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]).stdout.toString().trim();
		if (st === "") return true;
		if (Date.now() > end) return false;
	}
}
function expectNoOutput(f: Fixture) {
	expect(existsSync(f.out)).toBe(false);
	expect(existsSync(f.out + ".manifest.json")).toBe(false);
}

const SHORT = { commandMs: 1500, versionMs: 1500, reapMs: 2000 };
/** Upper bound on a timed-out run: the deadline, the reap grace and generous scheduling slack. */
const BOUND = SHORT.commandMs + SHORT.reapMs + 5000;

test("R1: GIT_TIMEOUTS bound every git child (finite, positive, version <= command)", () => {
	for (const v of Object.values(cp.GIT_TIMEOUTS ?? { missing: NaN })) expect(Number.isFinite(v) && v > 0).toBe(true);
	expect(cp.GIT_TIMEOUTS?.versionMs).toBeLessThanOrEqual(cp.GIT_TIMEOUTS?.commandMs);
	expect(Object.isFrozen(cp.GIT_TIMEOUTS)).toBe(true);
});

for (const make of ["fifo", "socket"] as const) {
	test.skipIf(win || (make === "socket" && noUnixSockets))(`R1: a ${make} at a tracked path is refused as a non-regular file without any git timeout (production bounds)`, async () => {
		const f = fixture();
		let server: Server | undefined;
		try {
			rmSync(join(f.root, "a.txt"));
			if (make === "fifo") mkfifo(join(f.root, "a.txt"));
			else server = await socketAt(join(f.root, "a.txt"));
			const t = Date.now();
			expect(await refusal(packageCandidate(f.root, f.out))).toContain("[non-regular-file]");
			expect(Date.now() - t).toBeLessThan(20_000);
			expectNoOutput(f);
		} finally {
			server?.close();
			f.done();
		}
	}, 60_000);
}

test.skipIf(win || noUnixSockets)("R1: an untracked socket is refused, never opened", async () => {
	const f = fixture();
	let server: Server | undefined;
	try {
		server = await socketAt(join(f.root, "s.sock"));
		expect(await refusal(packageCandidate(f.root, f.out))).toContain("[non-regular-file]");
		expectNoOutput(f);
	} finally {
		server?.close();
		f.done();
	}
}, 60_000);

test.skipIf(win)("R1: FIFO symlinks are refused, never opened", async () => {
	const f = fixture();
	try {
		mkfifo(join(f.dir, "outside-fifo"));
		symlinkSync(join(f.dir, "outside-fifo"), join(f.root, "link"));
		expect(await refusal(packageCandidate(f.root, f.out))).toContain("[symlink]");
		rmSync(join(f.root, "link"));
		rmSync(join(f.root, "a.txt"));
		symlinkSync(join(f.dir, "outside-fifo"), join(f.root, "a.txt"));
		expect(await refusal(packageCandidate(f.root, f.out))).toContain("[symlink]");
		expectNoOutput(f);
	} finally {
		f.done();
	}
}, 60_000);

/** Each setup makes git itself open a FIFO (blocking) during one of the packager's commands. */
const GIT_FIFO_CASES: [string, (f: Fixture) => void][] = [
	["FIFO .gitignore (top level)", (f) => mkfifo(join(f.root, ".gitignore"))],
	["FIFO .gitignore (subdirectory)", (f) => (f.w("sub/x.txt", "x"), mkfifo(join(f.root, "sub", ".gitignore")))],
	["FIFO .git/info/exclude", (f) => (rmSync(join(f.root, ".git", "info", "exclude"), { force: true }), mkdirSync(join(f.root, ".git", "info"), { recursive: true }), mkfifo(join(f.root, ".git", "info", "exclude")))],
	["FIFO config include target", (f) => (mkfifo(join(f.root, "cfg")), writeFileSync(join(f.root, ".git", "config"), "[include]\n\tpath = ../cfg\n", { flag: "a" }))],
	[
		".git/info/exclude symlink to a FIFO outside the workspace",
		(f) => (mkfifo(join(f.dir, "outside-fifo")), rmSync(join(f.root, ".git", "info", "exclude"), { force: true }), mkdirSync(join(f.root, ".git", "info"), { recursive: true }), symlinkSync(join(f.dir, "outside-fifo"), join(f.root, ".git", "info", "exclude"))),
	],
];
for (const [name, setup] of GIT_FIFO_CASES)
	test.skipIf(win)(`R1: ${name}: git is killed at its deadline -> [git-timeout], no package, no git process left`, async () => {
		const f = fixture();
		try {
			setup(f);
			const t = Date.now();
			const message = await refusal(packageCandidate(f.root, f.out, undefined, { gitTimeouts: SHORT }));
			const elapsed = Date.now() - t;
			expect(message).toContain("[git-timeout]");
			expect(message).toContain("process group was killed and the child reaped");
			expect(elapsed).toBeGreaterThanOrEqual(SHORT.commandMs - 50);
			expect(elapsed).toBeLessThan(BOUND);
			expectNoOutput(f);
			// git's argv carries `-C <root>`, unique to this fixture.
			expect(processesMentioning(f.root)).toEqual([]);
		} finally {
			f.done();
		}
	}, 30_000);

/** Windows: a named pipe served by this test process that accepts every connection and never writes. */
async function pipeServer() {
	const sockets = new Set<import("node:net").Socket>();
	let open = 0;
	const server = createServer((s) => {
		sockets.add(s);
		open++;
		s.on("close", () => open--);
		s.on("error", () => {});
	});
	const path = `\\\\.\\pipe\\cand-hang-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await new Promise<void>((res) => server.listen(path, res));
	return {
		path,
		accepted: () => sockets.size,
		/** Every accepted connection was closed by its client within `ms`. */
		async allClosed(ms: number): Promise<boolean> {
			for (const end = Date.now() + ms; open > 0 && Date.now() < end; ) await Bun.sleep(20);
			return open === 0;
		},
		/** Breaks every connection: a git still blocked reading the pipe then fails and exits by itself. */
		async stop() {
			for (const s of sockets) s.destroy();
			server.close();
			await Bun.sleep(300);
		},
	};
}

// Windows has no FIFO in the filesystem; the real git blocks on a named pipe a config include names. On a Git for
// Windows install that git is started by the cmd\git.exe launcher, so ending only the direct child leaves it running.
for (const form of ["\\\\.\\pipe\\", "//./pipe/"] as const)
	test.if(win)(`R1 (Windows): a config include naming a named pipe (${form}...): git, its launcher and every process they started are ended at the deadline -> [git-timeout], the pipe closed and the workspace released`, async () => {
		const f = fixture();
		const pipe = await pipeServer();
		try {
			f.g("config", "include.path", form === "//./pipe/" ? pipe.path.replaceAll("\\", "/") : pipe.path);
			const t = Date.now();
			const message = await refusal(packageCandidate(f.root, f.out, undefined, { gitTimeouts: SHORT }));
			const elapsed = Date.now() - t;
			expect(message).toContain("[git-timeout]");
			expect(message).toContain("git rev-parse --show-toplevel");
			expect(message).toContain(WIN_JOB_ENDED);
			expect(elapsed).toBeGreaterThanOrEqual(SHORT.commandMs - 50);
			expect(elapsed).toBeLessThan(BOUND);
			expectNoOutput(f);
			// git really blocked on the pipe, and every git that opened it has ended (its end of the pipe closed) ...
			expect(pipe.accepted()).toBeGreaterThan(0);
			expect(await pipe.allClosed(SHORT.reapMs)).toBe(true);
			// ... and no process still has the workspace (git's `-C <root>`) as its current directory.
			expect(await released(f.root)).toBe(true);
		} finally {
			await pipe.stop();
			f.done();
		}
	}, 30_000);

for (const make of ["symlink-to-fifo", "socket"] as const) {
	test.skipIf(win || (make === "socket" && noUnixSockets))(`R1: a ${make} .gitignore is refused by git's own warning ([git-stderr]), not a hang`, async () => {
		const f = fixture();
		let server: Server | undefined;
		try {
			if (make === "socket") server = await socketAt(join(f.root, ".gitignore"));
			else {
				mkfifo(join(f.dir, "outside-fifo"));
				symlinkSync(join(f.dir, "outside-fifo"), join(f.root, ".gitignore"));
			}
			const t = Date.now();
			const message = await refusal(packageCandidate(f.root, f.out, undefined, { gitTimeouts: SHORT }));
			expect(message, make).toContain("[git-stderr]");
			expect(message, make).toContain(".gitignore");
			expect(Date.now() - t).toBeLessThan(BOUND);
			expectNoOutput(f);
		} finally {
			server?.close();
			f.done();
		}
	}, 60_000);
}

test.skipIf(win)("R1: the packager's own opens refuse a FIFO identity file, and verify refuses FIFO / symlink-to-FIFO inputs (no hang)", async () => {
	const f = fixture();
	try {
		f.w(".gitignore", ".fleet-identity.json\n");
		f.g("add", ".gitignore");
		f.g("commit", "-qm", "i");
		// git does not list a FIFO even as ignored, so the walk refuses it; an ignored symlink to a FIFO is
		// excluded by the walk and reaches the identity read, which refuses it without opening it.
		mkfifo(join(f.root, ".fleet-identity.json"));
		expect(await refusal(packageCandidate(f.root, f.out))).toContain("[non-regular-file]");
		rmSync(join(f.root, ".fleet-identity.json"));
		const fifo = join(f.dir, "p.fifo");
		mkfifo(fifo);
		symlinkSync(fifo, join(f.root, ".fleet-identity.json"));
		expect(await refusal(packageCandidate(f.root, f.out))).toContain("[identity-invalid]");
		rmSync(join(f.root, ".fleet-identity.json"));
		const digest = await packageCandidate(f.root, f.out);
		symlinkSync(fifo, join(f.dir, "fifo-link"));
		expect(await refusal(verifyCandidate(fifo, f.out + ".manifest.json"))).toContain("[archive-not-regular-file]");
		expect(await refusal(verifyCandidate(join(f.dir, "fifo-link"), f.out + ".manifest.json"))).toContain("[archive-not-regular-file]");
		expect(await refusal(verifyCandidate(f.out, fifo))).toContain("[input-not-regular-file]");
		expect(await refusal(verifyCandidate(f.out, join(f.dir, "fifo-link")))).toContain("[input-not-regular-file]");
		symlinkSync(f.out, join(f.dir, "archive-link"));
		expect(await refusal(verifyCandidate(join(f.dir, "archive-link"), f.out + ".manifest.json"))).toContain("[archive-not-regular-file]");
		// CLI: the expected-files list as a FIFO.
		const r = Bun.spawnSync([process.execPath, TOOL, "verify", f.out, f.out + ".manifest.json", digest, fifo], { timeout: 20_000 });
		expect(r.exitedDueToTimeout).toBeFalsy();
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("[input-not-regular-file]");
		expect((await verifyCandidate(f.out, f.out + ".manifest.json", digest)).sha256).toBe(digest);
	} finally {
		f.done();
	}
}, 60_000);

// ---------------------------------------------------------------------------------------
// Stub git, selected through resolveGit() via the gitSearchPath seam (never through process.env.PATH)
// ---------------------------------------------------------------------------------------
/**
 * Writes `<dir>/git`, a POSIX sh stub using builtins and absolute paths only (the packager gives git a PATH of
 * git's own directory). `body` runs for every invocation with "$*" = the arguments.
 */
function stubGit(dir: string, body: string): string {
	mkdirSync(dir, { recursive: true });
	const exe = join(dir, "git");
	writeFileSync(exe, `#!/bin/sh\n${body}\n`);
	expect(Bun.spawnSync(["chmod", "755", exe]).exitCode).toBe(0);
	return exe;
}
const VERSION_OK = `if [ "$1" = --version ]; then printf 'git version 2.44.0\\n'; exit 0; fi`;

/**
 * Windows stub git: one `git.exe` compiled with `bun build --compile` per run of this file and run once before the
 * tests (a new executable's first start can be slowed by on-access scanning). Tests run one at a time; each
 * rewrites `stub.json` beside it, which the stub reads (the packager gives git a from-scratch environment).
 * "block" starts a detached grandchild (outside the stub's own Bun job, so it outlives a kill of the stub alone)
 * whose current directory is `sleeperCwd`, then blocks; both exit by themselves after 20 s.
 */
type WinStub =
	| { mode: "block"; phase: "--version" | "a repository command"; sleeperCwd: string }
	| { mode: "flood" }
	| { mode: "mark"; mark: string }
	| { mode: "answers"; toplevel: string; commit: string };
const WIN_STUB_SOURCE = `import { appendFileSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--stub-sleeper") setTimeout(() => process.exit(0), 20000);
else {
	const cfg = JSON.parse(readFileSync(join(dirname(process.execPath), "stub.json"), "utf8"));
	const version = args[0] === "--version";
	const line = args.join(" ");
	if (cfg.mode === "mark") {
		appendFileSync(cfg.mark, line + "\\n");
		process.exit(3);
	} else if (cfg.mode === "flood" && version) {
		const b = Buffer.from(("git version 2.44.0 " + "x".repeat(60) + "\\n").repeat(1000));
		for (;;) writeSync(1, b);
	} else if (cfg.mode === "block" && version === (cfg.phase === "--version")) {
		Bun.spawn([process.execPath, "--stub-sleeper"], { cwd: cfg.sleeperCwd, detached: true, stdio: ["ignore", "ignore", "ignore"] });
		setTimeout(() => process.exit(0), 20000);
	} else if (version) {
		writeSync(1, "git version 2.44.0\\n");
		process.exit(0);
	} else if (cfg.mode === "answers" && line.includes("--show-toplevel")) {
		writeSync(1, readFileSync(cfg.toplevel));
		process.exit(0);
	} else if (cfg.mode === "answers" && line.includes("HEAD^{commit}")) {
		writeSync(1, readFileSync(cfg.commit));
		process.exit(0);
	} else process.exit(3);
}
`;
let compiledStub: string | undefined;
beforeAll(() => {
	if (!win) return;
	const dir = mkdtempSync(join(tmpdir(), "cand-hang-stub-"));
	writeFileSync(join(dir, "stub.ts"), WIN_STUB_SOURCE);
	const r = Bun.spawnSync([process.execPath, "build", "--compile", join(dir, "stub.ts"), "--outfile", join(dir, "git.exe")], { cwd: dir, timeout: 120_000 });
	expect(r.exitCode, r.stderr.toString()).toBe(0);
	compiledStub = join(dir, "git.exe");
	writeFileSync(join(dir, "stub.json"), JSON.stringify({ mode: "warm-up" }));
	const warm = Bun.spawnSync([compiledStub, "--version"], { timeout: 60_000 });
	expect(warm.stdout.toString()).toBe("git version 2.44.0\n");
}, 150_000);
afterAll(() => {
	if (compiledStub) rmSync(dirname(compiledStub), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
/** The stub, set to `behaviour`; with `dir`, a copy placed there instead (for stubs that must never run). */
function winStub(behaviour: WinStub, dir?: string): string {
	let exe = compiledStub!;
	if (dir !== undefined) {
		mkdirSync(dir, { recursive: true });
		copyFileSync(exe, (exe = join(dir, "git.exe")));
	}
	writeFileSync(join(dirname(exe), "stub.json"), JSON.stringify(behaviour));
	return exe;
}
/** Windows: no process has `dir` (or anything below it) as its current directory or open: it can be renamed. */
async function released(dir: string, ms = 3000): Promise<boolean> {
	for (const end = Date.now() + ms; ; await Bun.sleep(100)) {
		try {
			renameSync(dir, dir + ".moved");
			renameSync(dir + ".moved", dir);
			return true;
		} catch (error: any) {
			if (!["EBUSY", "EPERM", "EACCES"].includes(error?.code) || Date.now() > end) return false;
		}
	}
}
/** Windows: the message of a [git-timeout] whose job object was terminated with every process in it ended. */
const WIN_JOB_ENDED = "was terminated and every process in it ended";
/** Records its own pid and a background grandchild's pid, ignores TERM/HUP/INT, then blocks. */
const SLEEPER = (pids: string) => `trap '' TERM HUP INT\nprintf '%s\\n' "$$" > '${pids}.child'\n/bin/sleep 60 &\nprintf '%s\\n' "$!" > '${pids}.grandchild'\nwait\nexit 0`;

for (const phase of ["--version", "a repository command"] as const)
	test.skipIf(win)(`R1: a stub git that blocks during ${phase} is killed with its process group at the deadline and reaped: [git-timeout], no package, no process left`, async () => {
		const f = fixture();
		try {
			const pids = join(f.dir, "pids");
			const stub = stubGit(join(f.dir, "stub"), `${phase === "--version" ? "" : VERSION_OK + "\n"}${SLEEPER(pids)}`);
			const t = Date.now();
			const message = await refusal(packageCandidate(f.root, f.out, undefined, { gitSearchPath: dirname(stub), gitTimeouts: SHORT }));
			const elapsed = Date.now() - t;
			expect(message).toContain("[git-timeout]");
			expect(message).toContain(phase === "--version" ? "git --version" : "git rev-parse --show-toplevel");
			expect(message).toContain("and the child reaped");
			expect(elapsed).toBeGreaterThanOrEqual((phase === "--version" ? SHORT.versionMs : SHORT.commandMs) - 50);
			expect(elapsed).toBeLessThan(BOUND);
			expectNoOutput(f);
			const child = Number(readFileSync(pids + ".child", "utf8"));
			const grandchild = Number(readFileSync(pids + ".grandchild", "utf8"));
			expect(child).toBeGreaterThan(1);
			expect(grandchild).toBeGreaterThan(1);
			// The child was reaped by the packager itself; the grandchild (same process group) was killed too.
			expect(await gone(child, 0)).toBe(true);
			expect(await gone(grandchild)).toBe(true);
			expect(processesMentioning(f.dir)).toEqual([]);
		} finally {
			f.done();
		}
	}, 30_000);

for (const phase of ["--version", "a repository command"] as const)
	test.if(win)(`R1 (Windows): a stub git that blocks during ${phase} after starting a detached grandchild is ended with that grandchild at the deadline: [git-timeout], no package, no process left`, async () => {
		const f = fixture();
		try {
			const sleeperCwd = join(f.dir, "grandchild-cwd");
			mkdirSync(sleeperCwd);
			const stub = winStub({ mode: "block", phase, sleeperCwd });
			const t = Date.now();
			const message = await refusal(packageCandidate(f.root, f.out, undefined, { gitSearchPath: dirname(stub), gitTimeouts: SHORT }));
			const elapsed = Date.now() - t;
			expect(message).toContain("[git-timeout]");
			expect(message).toContain(phase === "--version" ? "git --version" : "git rev-parse --show-toplevel");
			expect(message).toContain(WIN_JOB_ENDED);
			expect(elapsed).toBeGreaterThanOrEqual((phase === "--version" ? SHORT.versionMs : SHORT.commandMs) - 50);
			expect(elapsed).toBeLessThan(BOUND);
			expectNoOutput(f);
			// The grandchild existed (it holds its directory while it runs) and was ended with the stub: the
			// directory is released long before the grandchild's own 20 s exit.
			expect(await released(sleeperCwd)).toBe(true);
			expect(await released(dirname(stub))).toBe(true);
		} finally {
			f.done();
		}
	}, 30_000);

test("R1: a stub git flooding stdout on --version is killed at the output bound ([git-version-unknown]), not waited for", async () => {
	const f = fixture();
	try {
		const stub = win ? winStub({ mode: "flood" }) : stubGit(join(f.dir, "stub"), `trap '' TERM\nwhile :; do printf 'git version 2.44.0 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; done`);
		const t = Date.now();
		// Reaching the deadline instead would be [git-timeout].
		expect(await refusal(packageCandidate(f.root, f.out, undefined, { gitSearchPath: dirname(stub), gitTimeouts: SHORT }))).toContain("[git-version-unknown]");
		expect(Date.now() - t).toBeLessThan(BOUND);
		expectNoOutput(f);
		if (win) expect(await released(dirname(stub))).toBe(true);
		else expect(processesMentioning(f.dir)).toEqual([]);
	} finally {
		f.done();
	}
}, 30_000);

test("R1: the gitSearchPath seam keeps every trust check - a stub inside the workspace or a relative entry is never run", async () => {
	const f = fixture();
	try {
		const mark = join(f.dir, "RAN");
		const inside = win ? winStub({ mode: "mark", mark }, join(f.root, "bin")) : stubGit(join(f.root, "bin"), `printf x > '${mark}'\nexit 3`);
		expect(await refusal(packageCandidate(f.root, f.out, undefined, { gitSearchPath: dirname(inside) }))).toContain("[git-inside-workspace]");
		expect(await refusal(packageCandidate(f.root, f.out, undefined, { gitSearchPath: "bin" }))).toContain("[git-unavailable]");
		expect(existsSync(mark)).toBe(false);
		expectNoOutput(f);
	} finally {
		f.done();
	}
}, 30_000);

test("R3: a non-path answer to --show-toplevel and a non-object-id HEAD are typed refusals ([git-unexpected-output])", async () => {
	const f = fixture();
	try {
		const head = f.g("rev-parse", "HEAD").trim();
		const answer = join(f.dir, "toplevel.txt");
		const commit = join(f.dir, "commit.txt");
		const stub = win ? winStub({ mode: "answers", toplevel: answer, commit }) : stubGit(
			join(f.dir, "stub"),
			`${VERSION_OK}\ncase "$*" in\n*--show-toplevel*) while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < '${answer}'; exit 0;;\n*HEAD^{commit}*) while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < '${commit}'; exit 0;;\nesac\nexit 3`,
		);
		const run = () => packageCandidate(f.root, f.out, undefined, { gitSearchPath: dirname(stub), gitTimeouts: SHORT });
		writeFileSync(commit, head + "\n");
		for (const top of ["not a path", ".", "repo", "", join(f.dir, "does-not-exist"), "\u0000"]) {
			writeFileSync(answer, top + "\n");
			const message = await refusal(run());
			expect(message, JSON.stringify(top)).toContain("[git-unexpected-output]");
			expect(message).toContain("--show-toplevel");
		}
		// An existing absolute path that is not the workspace keeps its own rule.
		writeFileSync(answer, f.dir + "\n");
		expect(await refusal(run())).toContain("[workspace-not-repository-root]");
		writeFileSync(answer, f.root + "\n");
		for (const bad of ["", "HEAD", head.slice(0, 39), head.toUpperCase(), head + "0"]) {
			writeFileSync(commit, bad + "\n");
			const message = await refusal(run());
			expect(message, bad).toContain("[git-unexpected-output]");
			expect(message).toContain("HEAD^{commit}");
		}
		expectNoOutput(f);
	} finally {
		f.done();
	}
}, 60_000);

// ---------------------------------------------------------------------------------------
// R2: verify validates exclusion paths and reasons
// ---------------------------------------------------------------------------------------
const gz = (tar: Buffer) => {
	const b = gzipSync(tar, { level: 9 });
	b[9] = 0xff;
	return b;
};
const member = (name: string, data: Buffer) => Buffer.concat([tarHeader(name, data.length, 0o644), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
/** A self-consistent package (sidecar = embedded manifest) with the given exclusions. */
function craft(dir: string, exclusions: unknown) {
	const data = Buffer.from("a\n");
	const manifest = { toolVersion: VERSION, baseCommit: "a".repeat(40), identity: null, exclusions, files: [{ path: "a.txt", size: data.length, sha256: sha(data), mode: 0o644 }] };
	const side = Buffer.from(JSON.stringify(manifest));
	const archive = join(dir, `x${Math.random().toString(36).slice(2)}.tar.gz`);
	const bytes = gz(Buffer.concat([member(MANIFEST_MEMBER, side), member("a.txt", data), Buffer.alloc(1024)]));
	writeFileSync(archive, bytes);
	writeFileSync(archive + ".json", side);
	return { archive, manifest: archive + ".json", hash: sha(bytes) };
}

test("R2: verify refuses exclusions with an unknown reason, a non-relative path or a reason/shape mismatch, even with the trusted hash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cand-hang-r2-"));
	try {
		const bad: [unknown[], string][] = [
			[[{ path: "x", reason: "bogus" }], "manifest-invalid"],
			[[{ path: "x", reason: "IGNORED" }], "manifest-invalid"],
			[[{ path: "", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "/", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "/etc/passwd", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "../x", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a/../../x", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a//b", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "./a", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a/.", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a//", reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a\u0000b", reason: "ignored" }], "manifest-invalid"],
			[[{ path: ".git/", reason: "git-dir" }], "manifest-invalid"],
			[[{ path: "sub/.git", reason: "git-dir" }], "manifest-invalid"],
			[[{ path: "x", reason: "git-dir" }], "manifest-invalid"],
			[[{ path: "sub", reason: "submodule" }], "manifest-invalid"],
			[[{ path: "nested", reason: "nested-repository" }], "manifest-invalid"],
			[[{ path: "bare", reason: "nested-bare-repository" }], "manifest-invalid"],
			[[{ path: "b", reason: "ignored" }, { path: "a", reason: "ignored" }], "manifest-not-sorted"],
			[[{ path: "a", reason: "ignored" }, { path: "a", reason: "ignored" }], "manifest-not-sorted"],
			[[{ path: 1, reason: "ignored" }], "manifest-invalid"],
			[[{ path: "a", reason: "ignored", extra: 1 }], "manifest-invalid"],
		];
		for (const [exclusions, rule] of bad) {
			const c = craft(dir, exclusions);
			for (const hash of [undefined, c.hash]) {
				const message = await refusal(verifyCandidate(c.archive, c.manifest, hash));
				expect(message, JSON.stringify(exclusions)).toContain(`[${rule}]`);
			}
		}
		// Every shape the packager writes is accepted, including ignored names safePath() would refuse in files.
		const good = [
			{ path: ".GIT", reason: "git-dir" },
			{ path: ".git", reason: "git-dir" },
			{ path: "CON.log", reason: "ignored" },
			{ path: "a:b.log", reason: "ignored" },
			{ path: "build/", reason: "ignored" },
			{ path: "bare/", reason: "nested-bare-repository" },
			{ path: "nested/", reason: "nested-repository" },
			{ path: "trail. ", reason: "ignored" },
			{ path: "vendor/sub/", reason: "submodule" },
			{ path: "x\\y\ny.log", reason: "ignored" },
			{ path: "e\u0301.log", reason: "ignored" },
		].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const c = craft(dir, good);
		expect((await verifyCandidate(c.archive, c.manifest, c.hash)).files).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("R2: a real package with every exclusion reason (and ignored names outside the path policy) still verifies", async () => {
	const f = fixture();
	try {
		f.w(".gitignore", "*.log\nbuild/\n");
		f.w("sub/t.txt", "t");
		f.g("add", ".");
		f.g("commit", "-qm", "b");
		f.w("build/out.bin", "o");
		f.w("weird\\name.log", "w");
		if (!win) f.w("e\u0301.log", "nfd");
		f.g("init", "-q", "nested");
		f.g("init", "-q", "--bare", "bare");
		const digest = await packageCandidate(f.root, f.out);
		const m = JSON.parse(readFileSync(f.out + ".manifest.json", "utf8"));
		const reasons = new Set(m.exclusions.map((e: { reason: string }) => e.reason));
		for (const r of ["git-dir", "ignored", "nested-repository", "nested-bare-repository"]) expect(reasons.has(r)).toBe(true);
		expect((await verifyCandidate(f.out, f.out + ".manifest.json", digest)).sha256).toBe(digest);
		// Determinism of the API within one version: a second package is byte-identical.
		const again = join(f.dir, "again.tar.gz");
		expect(await packageCandidate(f.root, again)).toBe(digest);
		expect(readFileSync(again + ".manifest.json")).toEqual(readFileSync(f.out + ".manifest.json"));
	} finally {
		f.done();
	}
}, 60_000);

// ---------------------------------------------------------------------------------------
// Windows review F3: the file identity (st_dev + st_ino; Windows: volume serial number + file id) is compared on
// every platform. The swap is made deterministic by replacing the file from inside fs.lstatSync.
// ---------------------------------------------------------------------------------------
test("F3: an identity file replaced by a link to an outside file between its lstat and its open is refused, never read ([identity-invalid])", async () => {
	const f = fixture();
	const real = fs.lstatSync;
	let spy: ReturnType<typeof spyOn> | undefined;
	try {
		f.w(".gitignore", ".fleet-identity.json\n");
		f.g("add", ".gitignore");
		f.g("commit", "-qm", "i");
		const idPath = join(f.root, ".fleet-identity.json");
		writeFileSync(idPath, JSON.stringify({ node: "inside" }));
		const outside = join(f.dir, "outside.json");
		writeFileSync(outside, JSON.stringify({ node: "outside" }));
		// Control: untouched, the identity is read from the workspace.
		const control = join(f.dir, "control.tar.gz");
		await packageCandidate(f.root, control);
		expect(JSON.parse(readFileSync(control + ".manifest.json", "utf8")).identity).toEqual({ node: "inside" });
		let swapped = false;
		spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: any) => {
			const st = real(p, o);
			// The checked lstat (bigint) has seen the regular file; the link replaces it before the open.
			if (!swapped && o?.bigint && String(p).endsWith(".fleet-identity.json")) {
				swapped = true;
				rmSync(idPath);
				symlinkSync(outside, idPath, "file");
			}
			return st;
		}) as typeof fs.lstatSync);
		const message = await refusal(packageCandidate(f.root, f.out));
		expect(swapped).toBe(true);
		expect(message).toContain("[identity-invalid]");
		expectNoOutput(f);
	} finally {
		spy?.mockRestore();
		f.done();
	}
}, 60_000);

test("F3: an archive replaced by a byte-identical copy between verify's two opens is refused ([archive-changed-during-verify])", async () => {
	const f = fixture();
	const real = fs.lstatSync;
	let spy: ReturnType<typeof spyOn> | undefined;
	try {
		const digest = await packageCandidate(f.root, f.out);
		const copy = join(f.dir, "copy.tar.gz");
		copyFileSync(f.out, copy);
		// Control: the copy itself verifies, so only the change of file can cause the refusal below.
		copyFileSync(f.out + ".manifest.json", copy + ".manifest.json");
		expect((await verifyCandidate(copy, copy + ".manifest.json", digest)).sha256).toBe(digest);
		let checks = 0;
		let swapped = false;
		spy = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: any) => {
			// The second checked open of the archive (the inflate stream's descriptor) finds the copy in its place,
			// consistently for its own lstat, open and fstat.
			if (o?.bigint && String(p).endsWith("c.tar.gz") && ++checks === 2) {
				// Unlink first: Windows refuses to rename over a file that is open.
				rmSync(f.out);
				renameSync(copy, f.out);
				swapped = true;
			}
			return real(p, o);
		}) as typeof fs.lstatSync);
		const message = await refusal(verifyCandidate(f.out, f.out + ".manifest.json", digest));
		expect(swapped).toBe(true);
		expect(message).toContain("[archive-changed-during-verify]");
	} finally {
		spy?.mockRestore();
		f.done();
	}
}, 60_000);
