import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { makeStaging } from "../scripts/export-public";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Private-looking values are assembled at runtime so this tracked source never contains one.
const SECRET_IP = [100, 90, 1, 2].join(".");
const SECRET_HOME = ["", "Users", "jdoe", "work"].join("/");
const SCRIPT = join(import.meta.dir, "..", "scripts", "export-public.ts");

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
	const d = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(d);
	return d;
};
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
		cwd,
		env: gitEnv,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 30_000,
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString();
}
const EXCLUDE = { exclude: [{ path: "report-1.md", reason: "operator run report" }, { path: "gone.md", reason: "stale entry" }] };
function repo(files: Record<string, string | Uint8Array>): string {
	const root = temp("export-src-");
	const all: Record<string, string | Uint8Array> = { "scripts/export-exclude.json": JSON.stringify(EXCLUDE), ...files };
	for (const [name, content] of Object.entries(all)) {
		mkdirSync(join(root, ...name.split("/"), ".."), { recursive: true });
		writeFileSync(join(root, ...name.split("/")), content);
	}
	git(root, "init", "-q");
	git(root, "add", "-A");
	git(root, "commit", "-q", "-m", "seed");
	return root;
}
function exportTo(args: string[], cwd?: string) {
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
const listing = (dir: string): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/"))
		.sort();
const state = (root: string) => [git(root, "rev-parse", "HEAD"), git(root, "status", "--porcelain", "--ignored"), git(root, "remote", "-v")];

test("exports the committed tracked files minus the exclude list into a new directory and passes the scan", () => {
	const src = repo({
		"README.md": "public readme\r\nwith CRLF\r\n",
		"src/a.ts": "export const a = 1;\n",
		"report-1.md": `ran on ${SECRET_IP} in ${SECRET_HOME}\n`,
	});
	writeFileSync(join(src, "untracked.md"), `${SECRET_IP}\n`);
	writeFileSync(join(src, "src", "a.ts"), `// uncommitted ${SECRET_IP}\n`);
	const before = state(src);
	const out = join(temp("export-out-"), "public");
	const r = exportTo(["--repo", src, "--out", out]);
	expect(r.stderr).toContain("privacy scan clean");
	expect(r.code).toBe(0);
	expect(listing(out)).toEqual(["README.md", "scripts/export-exclude.json", "src/a.ts"]);
	expect(readFileSync(join(out, "README.md"), "utf8")).toBe("public readme\r\nwith CRLF\r\n");
	expect(readFileSync(join(out, "src", "a.ts"), "utf8")).toBe("export const a = 1;\n");
	expect(r.stderr).toContain("exclude entry matches no tracked file: gone.md");
	expect(existsSync(join(out, ".git"))).toBe(false);
	expect(state(src)).toEqual(before);
	expect(before[2]).toBe("");
});

test("an existing empty --out is accepted; cwd selects the repository by default", () => {
	const src = repo({ "a.md": "ok\n" });
	const out = temp("export-empty-");
	expect(exportTo(["--out", out], src).code).toBe(0);
	expect(listing(out)).toEqual(["a.md", "scripts/export-exclude.json"]);
});

test("refuses a non-empty --out, a file as --out and an --out inside the repository, writing nothing", () => {
	const src = repo({ "a.md": "ok\n" });
	const before = state(src);
	const out = temp("export-busy-");
	writeFileSync(join(out, "keep.txt"), "mine");
	const busy = exportTo(["--repo", src, "--out", out]);
	expect(busy.code).toBe(2);
	expect(busy.stderr).toContain("not empty");
	expect(readdirSync(out)).toEqual(["keep.txt"]);
	expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("mine");
	expect(exportTo(["--repo", src, "--out", join(out, "keep.txt")]).code).toBe(2);
	const inside = exportTo(["--repo", src, "--out", join(src, "public")]);
	expect(inside.code).toBe(2);
	expect(existsSync(join(src, "public"))).toBe(false);
	expect(exportTo(["--repo", src]).code).toBe(2);
	expect(state(src)).toEqual(before);
});

test("refuses an --out inside the repository whose name starts with '..', writing nothing", () => {
	const src = repo({ "a.md": "ok\n" });
	const before = state(src);
	for (const name of ["..public", "..x"]) {
		const r = exportTo(["--repo", src, "--out", join(src, name)]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("outside the source repository");
		expect(existsSync(join(src, name))).toBe(false);
	}
	expect(state(src)).toEqual(before);
	const sibling = join(temp("export-sib-"), "..public");
	expect(exportTo(["--repo", src, "--out", sibling]).code).toBe(0);
});

test("a committed UTF-16 file with a private value and a committed NUL file fail the export", () => {
	const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`node ${SECRET_IP}\r\n`, "utf16le")]);
	const src = repo({ "ps-out.txt": utf16, "data.bin": new Uint8Array([1, 0, 2]) });
	const r = exportTo(["--repo", src, "--out", join(temp("export-u16-"), "o")]);
	expect(r.code).toBe(1);
	expect(r.stdout.trim().split("\n")).toEqual([
		"data.bin:0:unscanned-binary-file [not scanned: binary, 3 bytes]",
		`ps-out.txt:1:private-ipv4 [redacted private-ipv4 len=${SECRET_IP.length}]`,
	]);
	expect(r.stderr).not.toContain("privacy scan clean");
	expect(r.stdout + r.stderr).not.toContain(SECRET_IP);
});

test("fails when a private value remains, redacts it, and publishes nothing (no --out, no staging left)", () => {
	const src = repo({ "docs/notes.md": `intro\nworkspace ${SECRET_HOME}\n`, "report-1.md": `${SECRET_IP}\n` });
	const before = state(src);
	const parent = temp("export-dirty-");
	const out = join(parent, "public");
	const r = exportTo(["--repo", src, "--out", out]);
	expect(r.code).toBe(1);
	expect(r.stdout.trim()).toBe(`docs/notes.md:2:home-path-macos [redacted home-path-macos len=${SECRET_HOME.length - "/work".length}]`);
	expect(r.stderr).toContain("FAILED privacy scan; nothing was published to --out");
	for (const s of [SECRET_HOME, SECRET_IP, "jdoe"]) expect(r.stdout + r.stderr).not.toContain(s);
	expect(existsSync(out)).toBe(false);
	expect(readdirSync(parent)).toEqual([]);
	expect(state(src)).toEqual(before);
});

test("a failed scan leaves an existing empty --out empty; a clean scan publishes the tree there with no staging left", () => {
	const dirty = repo({ "a.md": `node ${SECRET_IP}\n` });
	const parent = temp("export-keep-");
	const out = join(parent, "public");
	mkdirSync(out);
	const r = exportTo(["--repo", dirty, "--out", out]);
	expect(r.code).toBe(1);
	expect(readdirSync(out)).toEqual([]);
	expect(readdirSync(parent)).toEqual(["public"]);
	const clean = exportTo(["--repo", repo({ "a.md": "ok\n" }), "--out", out]);
	expect(clean.code).toBe(0);
	expect(clean.stderr).toContain("privacy scan clean; published to --out");
	expect(listing(out)).toEqual(["a.md", "scripts/export-exclude.json"]);
	expect(readdirSync(parent)).toEqual(["public"]);
});

test("a git error is printed redacted: no absolute path, deny word or private value of the gitdir", () => {
	const words = join(temp("export-gitwords-"), "words");
	writeFileSync(words, "zorblax\n");
	const broken = temp("export-gitdir-");
	// A .git file pointing at a missing gitdir: git names that absolute path in its error.
	writeFileSync(join(broken, ".git"), `gitdir: ${join(broken, `zorblax-${SECRET_IP}`, "missing")}\n`);
	const parent = temp("export-gitout-");
	const r = exportTo(["--repo", broken, "--out", join(parent, "o"), "--deny-list", words]);
	expect(r.code).toBe(2);
	// Only the command and its exit status: no stderr text, not even redacted.
	expect(r.stderr).toMatch(/^export-public: git rev-parse failed \(exit \d+\)$/m);
	expect(r.stderr).not.toContain("[path]");
	for (const s of [broken, SECRET_IP, "zorblax", tmpdir()]) expect((r.stdout + r.stderr).toLowerCase()).not.toContain(s.toLowerCase());
	expect(readdirSync(parent)).toEqual([]);
});

test("the deny-list is forwarded to the scan of the output", () => {
	const src = repo({ "a.md": "deployed from zorblax-mini\n" });
	const deny = join(temp("export-deny-"), "words");
	writeFileSync(deny, "zorblax\n");
	expect(exportTo(["--repo", src, "--out", join(temp("export-d1-"), "o")]).code).toBe(0);
	const r = exportTo(["--repo", src, "--out", join(temp("export-d2-"), "o"), "--deny-list", deny]);
	expect(r.code).toBe(1);
	expect(r.stdout.trim()).toBe("a.md:1:deny-list [redacted deny-list len=7]");
});

test("an explicit --exclude file replaces the committed list; malformed lists are refused", () => {
	const src = repo({ "a.md": "ok\n", "b.md": "ok\n" });
	const lists = temp("export-lists-");
	const good = join(lists, "good.json");
	writeFileSync(good, JSON.stringify({ exclude: [{ path: "b.md", reason: "not public" }] }));
	const out = join(temp("export-x-"), "o");
	expect(exportTo(["--repo", src, "--out", out, "--exclude", good]).code).toBe(0);
	expect(listing(out)).toEqual(["a.md", "scripts/export-exclude.json"]);
	for (const bad of [{ exclude: [{ path: "b.md" }] }, { exclude: [{ path: "../b.md", reason: "x" }] }, { exclude: [{ path: "a\\b.md", reason: "x" }] }, {}]) {
		const file = join(lists, "bad.json");
		writeFileSync(file, JSON.stringify(bad));
		const target = join(temp("export-bad-"), "o");
		expect(exportTo(["--repo", src, "--out", target, "--exclude", file]).code).toBe(2);
		expect(existsSync(target)).toBe(false);
	}
});

// Plants a HEAD commit built with `git mktree`, so tree entries any client can create (and no
// working tree can hold) reach the export. Each entry is [name, content] or [name, sub-entries].
type Planted = [string, string | Planted[]];
function plantedRepo(entries: Planted[]): string {
	const root = repo({});
	const mktree = (list: Planted[]): string => {
		const lines = list.map(([name, body]) => {
			if (typeof body === "string") {
				const r = Bun.spawnSync(["git", "hash-object", "-w", "--stdin"], { cwd: root, env: gitEnv, stdin: Buffer.from(body), stdout: "pipe" });
				return `100644 blob ${r.stdout.toString().trim()}\t${name}\0`;
			}
			return `040000 tree ${mktree(body)}\t${name}\0`;
		});
		const r = Bun.spawnSync(["git", "mktree", "-z"], { cwd: root, env: gitEnv, stdin: Buffer.from(lines.join("")), stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(`mktree: ${r.stderr.toString()}`);
		return r.stdout.toString().trim();
	};
	const exclude = JSON.stringify(EXCLUDE);
	const tree = mktree([["ok.md", "ok\n"], ["scripts", [["export-exclude.json", exclude]]], ...entries]);
	const commit = git(root, "commit-tree", tree, "-p", "HEAD", "-m", "planted").trim();
	git(root, "update-ref", "HEAD", commit);
	return root;
}

test("refuses HEAD paths with a backslash, colon, control character, '.', '..', empty or win32-reserved segment, writing nothing", () => {
	const leak = `${SECRET_IP}\n`;
	const planted: Planted[][] = [
		[["..\\..\\escaped.txt", leak]],
		[["notes.md:hidden", leak]],
		[["a\u0001b.md", leak]],
		[["line\nbreak.md", leak]],
		[[".", [["escaped.txt", leak]]]],
		[["..", [["escaped.txt", leak]]]],
		[["", [["escaped.txt", leak]]]],
		[["CON", leak]],
		[["nul.txt", leak]],
		[["docs", [["Com1.md", leak]]]],
		[["trail.", leak]],
		[["trail ", leak]],
	];
	for (const entries of planted) {
		const src = plantedRepo(entries);
		const parent = temp("export-path-");
		const out = join(parent, "a", "out");
		const r = exportTo(["--repo", src, "--out", out]);
		expect(r.code).toBe(2);
		expect(r.stderr).not.toContain("privacy scan clean");
		expect(existsSync(join(parent, "a"))).toBe(false);
		expect(readdirSync(parent)).toEqual([]);
		expect(existsSync(join(src, "escaped.txt"))).toBe(false);
	}
	// Names that only resemble a refused form are ordinary files.
	const ok = plantedRepo([["console.md", "ok\n"], ["nullable.ts", "ok\n"], [".github", [["ci.yml", "ok\n"]]], ["a.b", [["c.d.md", "ok\n"]]]]);
	const out = join(temp("export-path-ok-"), "o");
	expect(exportTo(["--repo", ok, "--out", out]).code).toBe(0);
	expect(listing(out)).toEqual([".github/ci.yml", "a.b/c.d.md", "console.md", "nullable.ts", "ok.md", "scripts/export-exclude.json"]);
}, 60_000);

test("refuses a committed symlink (120000) and a submodule gitlink (160000), writing nothing", () => {
	for (const mode of ["120000", "160000"]) {
		const src = repo({ "a.md": "ok\n" });
		const oid = mode === "120000" ? git(src, "rev-parse", "HEAD:a.md").trim() : git(src, "rev-parse", "HEAD").trim();
		git(src, "update-index", "--add", "--cacheinfo", `${mode},${oid},entry`);
		git(src, "commit", "-q", "-m", "special entry");
		const out = join(temp("export-special-"), "o");
		const r = exportTo(["--repo", src, "--out", out]);
		expect(r.code).toBe(2);
		expect(r.stderr).toContain(`tracked entry is not a regular file (mode ${mode}): entry`);
		expect(existsSync(out)).toBe(false);
	}
}, 60_000);

test("a missing or directory --exclude and colliding HEAD paths are refusals (exit 2) that name the path, not uncaught errors", () => {
	const src = repo({ "a.md": "ok\n" });
	for (const exclude of [join(temp("export-noexcl-"), "missing.json"), temp("export-direxcl-")]) {
		const out = join(temp("export-excl-"), "o");
		const r = exportTo(["--repo", src, "--out", out, "--exclude", exclude]);
		expect(r.code).toBe(2);
		expect(r.stderr.trim()).toMatch(/^export-public: exclude list (file not found|is not a regular file)$/);
		expect(existsSync(out)).toBe(false);
	}
	const dup = plantedRepo([["dup.md", "one\n"], ["dup.md", "two\n"]]);
	const dupRun = exportTo(["--repo", dup, "--out", join(temp("export-dup-"), "o")]);
	expect(dupRun.code).toBe(2);
	expect(dupRun.stderr.trim().split("\n").at(-1)).toBe('export-public: cannot write "dup.md" (EEXIST); nothing was published');
	expect(dupRun.stderr).not.toContain("    at ");
	const dupParent = temp("export-dup-clean-");
	expect(exportTo(["--repo", dup, "--out", join(dupParent, "o")]).code).toBe(2);
	expect(readdirSync(dupParent)).toEqual([]);
	// Case-only collisions collide only on a case-insensitive file system (macOS and Windows defaults).
	const probe = temp("export-case-");
	writeFileSync(join(probe, "x"), "");
	const caseInsensitive = existsSync(join(probe, "X"));
	const cased = plantedRepo([["README.md", "one\n"], ["readme.md", "two\n"]]);
	const caseRun = exportTo(["--repo", cased, "--out", join(temp("export-cased-"), "o")]);
	if (caseInsensitive) {
		expect(caseRun.code).toBe(2);
		expect(caseRun.stderr).toContain('cannot write "readme.md" (EEXIST)');
	} else expect(caseRun.code).toBe(0);
}, 60_000);

/** Exports a planted HEAD and asserts a refusal under `rule` with nothing written, on every host. */
function expectUnportable(entries: Planted[], rule: string): void {
	const src = plantedRepo(entries);
	const parent = temp("export-unportable-");
	const r = exportTo(["--repo", src, "--out", join(parent, "a", "out")]);
	expect(r.stderr).toContain(`export-public: tracked path is not portable (${rule}): `);
	expect(r.code).toBe(2);
	expect(r.stderr).not.toContain("privacy scan clean");
	expect(readdirSync(parent)).toEqual([]);
}

test("refuses a .git segment at any depth and in every case/HFS-ignorable/8.3 form before writing", () => {
	const leak = `${SECRET_IP}\n`;
	const planted = [{ name: ".git", rule: "path-git-dir" }, { name: ".GIT", rule: "path-git-dir" }, { name: ".g\u200cit", rule: "path-git-dir" }, { name: "GIT~1", rule: "path-8dot3-alias" }];
	for (const { name, rule } of planted) expectUnportable([[name, [["config", "[core]\n\tfsmonitor = planted-command\n"], ["private-notes.md", leak]]]], rule);
	expectUnportable([["sub", [[".git", [["notes.md", leak]]]]]], "path-git-dir");
}, 60_000);

test("refuses the win32 reserved characters < > \" | ? * on every host before writing", () => {
	for (const c of ["<", ">", '"', "|", "?", "*"]) expectUnportable([["a.md", "ok\n"], [`a${c}b.md`, `${SECRET_IP}\n`]], "path-reserved-char");
}, 60_000);

test("refuses a device name before spaces, a non-NFC name and a path over 240 bytes before writing", () => {
	const leak = `${SECRET_IP}\n`;
	expectUnportable([["NUL .txt", leak]], "path-device-name");
	expectUnportable([["docs", [["com1  .md", leak]]]], "path-device-name");
	expectUnportable([["e\u0301.md", leak]], "path-not-nfc");
	expectUnportable([["d".repeat(200), [[`${"f".repeat(60)}.md`, leak]]]], "path-too-long");
}, 60_000);

test("every refusal and failure message prints its path redacted, with the deny words loaded", () => {
	const words = join(temp("export-words-"), "words");
	writeFileSync(words, "zorblax\n");
	const run = (src: string, extra: string[] = []) => {
		const r = exportTo(["--repo", src, "--out", join(temp("export-redact-"), "o"), "--deny-list", words, ...extra]);
		for (const s of [SECRET_IP, "zorblax"]) expect((r.stdout + r.stderr).toLowerCase()).not.toContain(s);
		return r;
	};
	const colon = run(plantedRepo([[`node-${SECRET_IP}:notes.md`, "ok\n"]]));
	expect([colon.code, colon.stderr.trim()]).toEqual([2, 'export-public: tracked path is not portable (path-alternate-data-stream): "node-[redacted]:notes.md"']);
	const device = run(plantedRepo([["ZorBlax", [["CON", "ok\n"]]]]));
	expect([device.code, device.stderr.trim()]).toEqual([2, 'export-public: tracked path is not portable (path-device-name): "[redacted]/CON"']);
	const dup = run(plantedRepo([[`dup-${SECRET_IP}.md`, "one\n"], [`dup-${SECRET_IP}.md`, "two\n"]]));
	expect([dup.code, dup.stderr.trim().split("\n").at(-1)]).toEqual([2, 'export-public: cannot write "dup-[redacted].md" (EEXIST); nothing was published']);
	const link = repo({ "a.md": "ok\n" });
	git(link, "update-index", "--add", "--cacheinfo", `120000,${git(link, "rev-parse", "HEAD:a.md").trim()},link-${SECRET_IP}.md`);
	git(link, "commit", "-q", "-m", "link");
	const linked = run(link);
	expect([linked.code, linked.stderr.trim()]).toEqual([2, "export-public: tracked entry is not a regular file (mode 120000): link-[redacted].md"]);
	const exclude = join(temp("export-gone-"), "exclude.json");
	writeFileSync(exclude, JSON.stringify({ exclude: [{ path: `gone-zorblax-${SECRET_IP}.md`, reason: "stale" }] }));
	const gone = run(repo({ "a.md": "ok\n" }), ["--exclude", exclude]);
	expect(gone.code).toBe(0);
	expect(gone.stderr).toContain("export-public: exclude entry matches no tracked file: gone-[redacted]-[redacted].md\n");
}, 60_000);

test("an fs error preparing --out (its parent is a regular file) exits 2 with only the errno code", () => {
	const src = repo({ "a.md": "ok\n" });
	const parent = temp("export-notdir-");
	writeFileSync(join(parent, "plain-file"), "mine");
	const r = exportTo(["--repo", src, "--out", join(parent, "plain-file", "o")]);
	expect(r.code).toBe(2);
	// Windows reports ENOENT when a path segment is a file; POSIX often ENOTDIR.
	expect(r.stderr.trim().split(/\r?\n/).at(-1)).toMatch(
		/^export-public: cannot create --out \((?:ENOTDIR|ENOENT)\)$/,
	);
	expect(r.stderr).not.toContain("    at ");
	expect(r.stderr).not.toContain("plain-file");
	expect(readFileSync(join(parent, "plain-file"), "utf8")).toBe("mine");
}, 60_000);

test("docs/public-release.md describes the CI that .github/workflows/ci.yml actually runs", () => {
	const root = join(import.meta.dir, "..");
	const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
	const docs = readFileSync(join(root, "docs", "public-release.md"), "utf8");
	const section = docs.slice(docs.indexOf("## CI"));
	const runsGate = /export-public|privacy-scan/.test(ci);
	// While the gate is not a CI step, the docs must say so and must not list it as one.
	if (!runsGate) {
		expect(section).toContain("does **not** run the clean export or the privacy scan");
		expect(section).not.toMatch(/^\d+\. .*(export-public|privacy-scan)/m);
	}
	const bun = /bun-version:\s*"?([0-9.]+)"?/.exec(ci)?.[1];
	expect(bun).toBeDefined();
	expect(section).toContain(`Bun ${bun}`);
	const os = /os:\s*\[([^\]]*)\]/.exec(ci)![1]!.split(",").map((o) => o.trim());
	for (const o of os) expect(section).toContain(`\`${o}\``);
	const windows = ci.match(/^  windows:\s*\n([\s\S]*?)(?=^  \w+:|(?![\s\S]))/m)?.[1] ?? "";
	expect(windows).toMatch(/^    runs-on: windows-latest$/m);
	expect(section).toContain("`windows-latest`");
	for (const step of ci.matchAll(/^\s*- run: (.+)$/gm)) if (/^bun|^bunx/.test(step[1]!)) expect(section).toContain(`\`${step[1]!.trim()}\``);
});

test.skipIf(process.platform === "win32")("the staging directory is a private (0700) mkdtemp directory next to --out", () => {
	const parent = temp("export-staging-mode-");
	const previous = process.umask(0);
	try {
		const staging = makeStaging(join(parent, "public"));
		const info = lstatSync(staging);
		expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
		expect(info.mode & 0o777).toBe(0o700);
		expect(staging.startsWith(join(parent, ".public.staging-"))).toBe(true);
	} finally {
		process.umask(previous);
	}
});

test("a failed export names its staging directory (no absolute path) and says whether it was removed", () => {
	const parent = temp("export-staging-name-");
	const r = exportTo(["--repo", repo({ "a.md": `node ${SECRET_IP}\n` }), "--out", join(parent, "public")]);
	expect(r.code).toBe(1);
	expect(r.stderr).toMatch(/^export-public: staging directory \.public\.staging-[A-Za-z0-9]{6} next to --out: removed$/m);
	expect(r.stderr).not.toContain(parent);
	expect(readdirSync(parent)).toEqual([]);
});

test("a failed export reports that it created the missing parent of --out and left it in place", () => {
	const base = temp("export-parent-made-");
	const r = exportTo(["--repo", repo({ "a.md": `node ${SECRET_IP}\n` }), "--out", join(base, "made", "public")]);
	expect(r.code).toBe(1);
	expect(r.stderr).toMatch(/^export-public: created the missing parent directory of --out; it is left in place$/m);
	expect(readdirSync(join(base, "made"))).toEqual([]);
	const again = exportTo(["--repo", repo({ "a.md": `node ${SECRET_IP}\n` }), "--out", join(base, "made", "public")]);
	expect(again.stderr).not.toContain("created the missing parent directory");
});
