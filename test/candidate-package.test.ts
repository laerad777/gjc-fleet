import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { dlopen, FFIType } from "bun:ffi";
import { MANIFEST_MEMBER, VERSION, assertComplete, packageCandidate, resolveGit, safePath, tarHeader, verifyCandidate } from "../scripts/candidate-package";
import * as cp from "../scripts/candidate-package";

const TOOL = join(import.meta.dir, "../scripts/candidate-package.ts");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const win = process.platform === "win32";

/** Every fixture lives under the OS temp dir; git ignores user/global config and never converts bytes. */
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cand-"));
	const root = join(dir, "repo");
	mkdirSync(root);
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: win ? "NUL" : "/dev/null" };
	const g = (...args: string[]) => {
		const r = Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", "-C", root, ...args], { env });
		if (r.exitCode !== 0) throw Error(`git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout.toString();
	};
	const w = (p: string, d: string | Uint8Array) => {
		mkdirSync(dirname(join(root, p)), { recursive: true });
		writeFileSync(join(root, p), d);
	};
	g("init", "-q");
	const out = (name = "c.tar.gz") => join(dir, name);
	const manifest = (name = "c.tar.gz") => JSON.parse(readFileSync(out(name) + ".manifest.json", "utf8"));
	const done = () => rmSync(dir, { recursive: true, force: true });
	return { dir, root, g, w, out, manifest, done, env };
}
async function rejects(p: Promise<unknown> | (() => unknown), rule: string) {
	let error: unknown;
	try {
		await (typeof p === "function" ? p() : p);
	} catch (e) {
		error = e;
	}
	expect(String(error)).toContain(`[${rule}]`);
}

/** Canonical gzip exactly as the packager writes it (mtime 0, OS byte 255). */
const gz = (tar: Buffer) => {
	const b = gzipSync(tar, { level: 9 });
	b[9] = 0xff;
	return b;
};
const member = (name: string, data: Buffer, mode = 0o644, header = tarHeader(name, data.length, mode)) =>
	Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
/** Self-consistent attacker package: sidecar manifest, embedded manifest member, and members. */
function craft(dir: string, files: { path: string; data: Buffer; mode?: number }[], opts: { members?: Buffer[]; trailer?: Buffer; mutate?: (tar: Buffer) => Buffer } = {}) {
	const manifest = {
		toolVersion: VERSION,
		baseCommit: "a".repeat(40),
		identity: null,
		exclusions: [],
		files: files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data), mode: f.mode ?? 0o644 })),
	};
	const side = Buffer.from(JSON.stringify(manifest));
	const body = opts.members ?? files.map((f) => member(f.path, f.data, f.mode));
	let tar: Buffer = Buffer.concat([member(MANIFEST_MEMBER, side), ...body, opts.trailer ?? Buffer.alloc(1024)]);
	if (opts.mutate) tar = opts.mutate(tar);
	const archive = join(dir, `x${Math.random().toString(36).slice(2)}.tar.gz`);
	writeFileSync(archive, gz(tar));
	writeFileSync(archive + ".json", side);
	return { archive, manifest: archive + ".json", side };
}
/** Rewrites a raw header block with a fresh checksum. */
function rechecksum(h: Buffer) {
	h.fill(32, 148, 156);
	h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
	return h;
}

test("real git: tracked, untracked and tracked-ignored files included; ignored, .git and nested repos excluded and listed; deterministic; tamper refused", async () => {
	const f = fixture();
	try {
		f.w(".gitignore", "ignored\nbuild/\n.fleet-identity.json\n*.log\n");
		f.w("tracked.ts", "export const x = 1;\r\n");
		f.w("bin/run.sh", "#!/bin/sh\n");
		f.w("keep.log", "t");
		f.g("add", ".");
		f.g("add", "-f", "keep.log");
		f.g("update-index", "--chmod=+x", "bin/run.sh");
		f.g("commit", "-qm", "base");
		f.w(".fleet-identity.json", JSON.stringify({ taskId: "real-task" }));
		f.w("tracked.ts", "modified\r\n");
		f.w("untracked.ts", "export const y = 2;\n");
		f.w("RESULT.md", "real result");
		f.w("ignored", "secret");
		f.w("build/a.js", "a");
		f.w("build/b.js", "b");
		mkdirSync(join(f.root, "nested"));
		expect(Bun.spawnSync(["git", "-C", join(f.root, "nested"), "init", "-q"]).exitCode).toBe(0);
		f.w("nested/hidden", "no");
		const digest = await packageCandidate(f.root, f.out());
		expect(await packageCandidate(f.root, f.out("b.tar.gz"))).toBe(digest);
		const m = f.manifest();
		expect(m.files.map((x: any) => x.path)).toEqual([".gitignore", "RESULT.md", "bin/run.sh", "keep.log", "tracked.ts", "untracked.ts"]);
		expect(m.files.find((x: any) => x.path === "bin/run.sh").mode).toBe(0o755);
		expect(m.files.find((x: any) => x.path === "tracked.ts").sha256).toBe(sha(Buffer.from("modified\r\n")));
		expect(m.exclusions).toEqual([
			{ path: ".fleet-identity.json", reason: "ignored" },
			{ path: ".git", reason: "git-dir" },
			{ path: "build/", reason: "ignored" },
			{ path: "ignored", reason: "ignored" },
			{ path: "nested/", reason: "nested-repository" },
		]);
		expect(m.identity).toEqual({ taskId: "real-task" });
		expect(m.baseCommit).toBe(f.g("rev-parse", "HEAD").trim());
		const tar = gunzipSync(readFileSync(f.out()));
		expect(tar.subarray(0, MANIFEST_MEMBER.length).toString()).toBe(MANIFEST_MEMBER);
		expect(await verifyCandidate(f.out(), f.out() + ".manifest.json", digest, m.files.map((x: any) => x.path))).toEqual({ sha256: digest, files: 6 });
		await rejects(verifyCandidate(f.out(), f.out() + ".manifest.json", "0".repeat(64)), "sha256-mismatch");
		await rejects(verifyCandidate(f.out(), f.out() + ".manifest.json", undefined, ["missing.ts"]), "expected-list-mismatch");
		const flipped = Buffer.from(tar);
		const last = flipped.length - 1024 - 512;
		flipped[last] ^= 1;
		writeFileSync(f.out("t.tar.gz"), gz(flipped));
		await rejects(verifyCandidate(f.out("t.tar.gz"), f.out() + ".manifest.json"), "tar-member-content-mismatch");
		const cli = Bun.spawnSync([process.execPath, TOOL, "verify", f.out(), f.out() + ".manifest.json", digest]);
		expect(cli.exitCode).toBe(0);
		expect(JSON.parse(cli.stdout.toString()).files).toBe(6);
		const pkg = Bun.spawnSync([process.execPath, TOOL, "package", f.root, f.out("cli.tar.gz")]);
		expect(pkg.exitCode).toBe(0);
		expect(pkg.stdout.toString().trim()).toBe(digest);
	} finally {
		f.done();
	}
}, 60_000);

test("F1: untracked file beyond MAX_PATH (abs > 260 chars, rel 234 bytes) is packaged, not silently dropped", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const seg = "d".repeat(50);
		// USTAR prefix <= 155 bytes and leaf <= 100 bytes, so 152-byte prefix + 81-byte leaf.
		const rel = `${[seg, seg, seg].join("/")}/${"f".repeat(77)}.txt`;
		expect(rel.length).toBe(234);
		f.w(rel, "deep");
		// MAX_PATH is a Windows limit; POSIX temp roots are short (e.g. /tmp/cand-XXXXXX/repo), so only the 234-byte relative path matters there.
		if (win) expect(join(f.root, rel).length).toBeGreaterThan(260);
		const digest = await packageCandidate(f.root, f.out());
		expect(f.manifest().files.map((x: any) => x.path)).toEqual(["a.txt", rel]);
		expect((await verifyCandidate(f.out(), f.out() + ".manifest.json", digest, ["a.txt", rel])).files).toBe(2);
	} finally {
		f.done();
	}
}, 30_000);

/** name and prefix fields of a header, each up to its first NUL. */
const fields = (h: Buffer) => {
	const z = (b: Buffer) => b.subarray(0, b.indexOf(0) < 0 ? b.length : b.indexOf(0)).toString("utf8");
	return { name: z(h.subarray(0, 100)), prefix: z(h.subarray(345, 500)) };
};

test("N2: USTAR split tries every '/' (longest fitting prefix); boundaries name 100/101 and prefix 155/156 bytes", () => {
	const s = (c: string, n: number) => c.repeat(n);
	// <= 100 bytes: no split, even with slashes.
	expect(fields(tarHeader(s("a", 100), 0, 0o644))).toEqual({ name: s("a", 100), prefix: "" });
	expect(fields(tarHeader(`${s("d", 49)}/${s("f", 50)}`, 0, 0o644))).toEqual({ name: `${s("d", 49)}/${s("f", 50)}`, prefix: "" });
	// 101 bytes without '/': unrepresentable.
	expect(() => tarHeader(s("a", 101), 0, 0o644)).toThrow("[path-ustar-split]");
	// Exact maxima: prefix 155 + name 100.
	expect(fields(tarHeader(`${s("p", 155)}/${s("n", 100)}`, 0, 0o644))).toEqual({ name: s("n", 100), prefix: s("p", 155) });
	expect(fields(tarHeader(`${s("p", 77)}/${s("q", 77)}/${s("n", 100)}`, 0, 0o644))).toEqual({ name: s("n", 100), prefix: `${s("p", 77)}/${s("q", 77)}` });
	// One over on either side with a single '/': refused.
	expect(() => tarHeader(`${s("p", 156)}/${s("n", 100)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	expect(() => tarHeader(`${s("p", 155)}/${s("n", 101)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	expect(() => tarHeader(`p/${s("n", 101)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	// Last '/' leaves a 156-byte prefix, an earlier '/' fits: split there (was refused before N2).
	const seg = s("d", 50);
	const four = `${[seg, seg, seg, seg].join("/")}/${s("f", 30)}`; // the re-review's 234-byte 4x50+leaf layout
	expect(Buffer.byteLength(four)).toBe(234);
	expect(fields(tarHeader(four, 0, 0o644))).toEqual({ prefix: [seg, seg, seg].join("/"), name: `${seg}/${s("f", 30)}` });
	// Earlier split chosen at exactly prefix 155 / name 100 when later slashes overflow the prefix.
	const a = `${s("p", 155)}/${s("x", 40)}/${s("y", 59)}`;
	expect(fields(tarHeader(a, 0, 0o644))).toEqual({ prefix: s("p", 155), name: `${s("x", 40)}/${s("y", 59)}` });
	// ... and refused when that earlier split leaves a 101-byte name.
	expect(() => tarHeader(`${s("p", 155)}/${s("x", 40)}/${s("y", 60)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	// Longest prefix wins when several splits fit; with a fitting last '/', the split is unchanged.
	const many = `${s("a", 60)}/${s("b", 60)}/${s("c", 20)}/${s("e", 20)}`;
	expect(fields(tarHeader(many, 0, 0o644))).toEqual({ prefix: `${s("a", 60)}/${s("b", 60)}/${s("c", 20)}`, name: s("e", 20) });
	// No '/' gives both a prefix <= 155 and a name <= 100.
	expect(() => tarHeader(`${s("a", 60)}/${s("b", 100)}/${s("c", 60)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	// Limits are UTF-8 bytes: 51 Hangul (153 B) + '/' + 33 Hangul (99 B) fits; 52 (156 B) does not.
	const k = "€";
	expect(fields(tarHeader(`${s(k, 51)}/${s(k, 33)}`, 0, 0o644))).toEqual({ prefix: s(k, 51), name: s(k, 33) });
	expect(() => tarHeader(`${s(k, 52)}/${s(k, 33)}`, 0, 0o644)).toThrow("[path-ustar-split]");
	expect(fields(tarHeader(`${s(k, 26)}/${s(k, 25)}/${s(k, 33)}`, 0, 0o644))).toEqual({ prefix: `${s(k, 26)}/${s(k, 25)}`, name: s(k, 33) });
	expect(fields(tarHeader(`${s(k, 26)}/${s(k, 26)}/${s(k, 7)}`, 0, 0o644))).toEqual({ prefix: s(k, 26), name: `${s(k, 26)}/${s(k, 7)}` });
	expect(() => tarHeader(`${s(k, 26)}/${s(k, 26)}/${s(k, 7)}x`, 0, 0o644)).toThrow("[path-ustar-split]");
});

test("N2: a 233-byte path whose last-'/' prefix exceeds 155 bytes is packaged, verified, read back by tar, and an alternative split is non-canonical", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const seg = "d".repeat(50);
		const rel = `${[seg, seg, seg, seg].join("/")}/${"f".repeat(25)}.txt`;
		expect(Buffer.byteLength(rel.slice(0, rel.lastIndexOf("/")))).toBe(203);
		// 240 bytes = LIMITS.pathBytes, split 155/84.
		const max = `${"p".repeat(155)}/${"q".repeat(40)}/${"r".repeat(39)}.txt`;
		expect(Buffer.byteLength(max)).toBe(240);
		f.w(rel, "deep");
		f.w(max, "max");
		const digest = await packageCandidate(f.root, f.out());
		const names = ["a.txt", rel, max];
		expect(f.manifest().files.map((x: any) => x.path)).toEqual(names);
		expect((await verifyCandidate(f.out(), f.out() + ".manifest.json", digest, names)).files).toBe(3);
		const listed = Bun.spawnSync(["tar", "-tzf", f.out()]);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout.toString().split(/\r?\n/).filter(Boolean)).toEqual([MANIFEST_MEMBER, "a.txt", rel, max]);
		// Two valid splits (prefix 121/name 20 is canonical): the member re-split at prefix 60/name 81 is refused.
		const two = `${"x".repeat(60)}/${"y".repeat(60)}/${"z".repeat(20)}`;
		expect(fields(tarHeader(two, 4, 0o644))).toEqual({ prefix: two.slice(0, 121), name: "z".repeat(20) });
		const data = Buffer.from("deep");
		const alt = tarHeader(two, data.length, 0o644);
		alt.fill(0, 0, 100);
		alt.fill(0, 345, 500);
		alt.write(two.slice(61), 0);
		alt.write(two.slice(0, 60), 345);
		const good = craft(f.dir, [{ path: two, data }]);
		expect((await verifyCandidate(good.archive, good.manifest)).files).toBe(1);
		const bad = craft(f.dir, [{ path: two, data }], { members: [member(two, data, 0o644, rechecksum(alt))] });
		await rejects(verifyCandidate(bad.archive, bad.manifest), "tar-header-noncanonical");
	} finally {
		f.done();
	}
}, 30_000);

test("F1: any git stderr about an unreadable path is a hard failure", async () => {
	const f = fixture();
	const locked = join(f.root, "sub", "locked");
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		if (win) {
			// A junction to a missing directory: git prints "warning: could not open directory 'sub/locked/'" and exits 0.
			mkdirSync(join(f.root, "sub"));
			symlinkSync(join(f.dir, "missing-dir"), locked, "junction");
		} else {
			f.w("sub/locked/secret.txt", "x");
			expect(Bun.spawnSync(["chmod", "000", locked]).exitCode).toBe(0);
		}
		// LC_ALL=C: a gettext-enabled git (Homebrew on macOS) translates this warning from the user's language
		// preference even when no LANG/LC_* is set; the packager refuses on any stderr text regardless.
		const probe = Bun.spawnSync(["git", "-c", "core.longpaths=true", "-C", f.root, "ls-files", "--others", "--exclude-standard"], { env: { ...process.env, LC_ALL: "C" } });
		expect(probe.exitCode).toBe(0);
		expect(probe.stderr.toString()).toContain("could not open directory");
		await rejects(packageCandidate(f.root, f.out()), "git-stderr");
		expect(existsSync(f.out())).toBe(false);
	} finally {
		if (!win) Bun.spawnSync(["chmod", "755", locked]);
		f.done();
	}
}, 30_000);

test("completeness: git inventory must equal the independent filesystem walk", () => {
	const s = (...p: string[]) => new Set(p);
	assertComplete(s("a", "b"), s("a", "b"), s("a"));
	expect(() => assertComplete(s("a"), s("a", "dropped-by-git"), s())).toThrow("[completeness-mismatch]");
	expect(() => assertComplete(s("a", "u"), s("a"), s("a"))).toThrow("[completeness-mismatch]");
	expect(() => assertComplete(s("a", "t"), s("a"), s("a", "t"))).toThrow("[tracked-file-missing]");
});

test("F2: decompression bombs and oversize inputs are refused by hard bounds, with or without a trusted hash", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cand-bomb-"));
	try {
		const A = Buffer.from("hello\r\n");
		// 64 MiB of zero "trailer" after a valid package: refused once past the 10240-byte trailer bound.
		const bomb = craft(dir, [{ path: "a.txt", data: A }], { trailer: Buffer.alloc(64 * 1024 * 1024) });
		await rejects(verifyCandidate(bomb.archive, bomb.manifest), "bound-uncompressed-total");
		// Header claiming a huge member is refused from the header, before its data is inflated.
		const big = Buffer.alloc(0);
		const hdr = rechecksum(tarHeader("a.txt", 0, 0o644));
		hdr.write((8 * 1024 ** 3).toString(8).padStart(11, "0") + "\0", 124);
		const huge = craft(dir, [{ path: "a.txt", data: big }], { members: [rechecksum(hdr)] });
		await rejects(verifyCandidate(huge.archive, huge.manifest), "bound-member-size");
		const good = craft(dir, [{ path: "a.txt", data: A }, { path: "b/c.txt", data: A }]);
		expect((await verifyCandidate(good.archive, good.manifest)).files).toBe(2);
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { compressedBytes: 64 }), "bound-compressed-size");
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { uncompressedBytes: 2048 }), "bound-uncompressed-total");
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { memberBytes: 4 }), "bound-member-size");
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { members: 1 }), "bound-member-count");
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { pathBytes: 6 }), "path-too-long");
		await rejects(verifyCandidate(good.archive, good.manifest, undefined, undefined, { manifestBytes: 16 }), "bound-manifest-size");
		// Bomb in a subprocess: refused fast with small peak memory (1 GiB of zeros, ~1 MB compressed).
		const probe = join(dir, "probe.ts");
		writeFileSync(
			probe,
			`import { verifyCandidate, tarHeader, VERSION, MANIFEST_MEMBER } from ${JSON.stringify(TOOL.replace(/\\/g, "/"))};
import { createGzip } from "node:zlib"; import { createWriteStream, writeFileSync } from "node:fs"; import { once } from "node:events";
const side = Buffer.from(JSON.stringify({ toolVersion: VERSION, baseCommit: "a".repeat(40), identity: null, exclusions: [], files: [] }));
const a = process.argv[2]; const g = createGzip({ level: 9 }); const ws = createWriteStream(a); g.pipe(ws);
g.write(Buffer.concat([tarHeader(MANIFEST_MEMBER, side.length, 0o644), side, Buffer.alloc(512 - side.length % 512)]));
const z = Buffer.alloc(1 << 20); for (let i = 0; i < 1024; i++) if (!g.write(z)) await once(g, "drain");
g.end(); await once(ws, "finish"); const fd = (await import("node:fs")).openSync(a, "r+"); (await import("node:fs")).writeSync(fd, Buffer.from([255]), 0, 1, 9);
writeFileSync(a + ".json", side); const before = process.memoryUsage().rss; const t = Date.now(); let r;
try { r = await verifyCandidate(a, a + ".json"); } catch (e) { r = String(e); }
console.log(JSON.stringify({ r, ms: Date.now() - t, growthMB: Math.round((process.memoryUsage().rss - before) / 1048576) }));`,
		);
		const p = Bun.spawnSync([process.execPath, probe, join(dir, "bomb1g.tar.gz")]);
		const res = JSON.parse(p.stdout.toString());
		expect(res.r).toContain("[bound-uncompressed-total]");
		expect(res.ms).toBeLessThan(5000);
		expect(res.growthMB).toBeLessThan(64);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

test("F2: verify memory stays constant for a large legitimate member", async () => {
	const f = fixture();
	try {
		const big = Buffer.alloc(160 * 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i * 2654435761 >>> 0, i);
		f.w("big.bin", big);
		f.g("add", ".");
		f.g("commit", "-qm", "big");
		const digest = await packageCandidate(f.root, f.out());
		const probe = join(f.dir, "probe.ts");
		writeFileSync(probe, `import { verifyCandidate } from ${JSON.stringify(TOOL.replace(/\\/g, "/"))};
const before = process.memoryUsage().rss; const r = await verifyCandidate(process.argv[2], process.argv[2] + ".manifest.json", process.argv[3]);
console.log(JSON.stringify({ r, growthMB: Math.round((process.memoryUsage().rss - before) / 1048576) }));`);
		const res = JSON.parse(Bun.spawnSync([process.execPath, probe, f.out(), digest]).stdout.toString());
		expect(res.r).toEqual({ sha256: digest, files: 1 });
		expect(res.growthMB).toBeLessThan(64);
	} finally {
		f.done();
	}
}, 120_000);

test("F3/F10: Windows aliases, reserved names and stream syntax are refused, naming the rule", async () => {
	const cases: [string, string][] = [
		["GIT~1/hooks/post-checkout", "path-8dot3-alias"],
		["git~2/config", "path-8dot3-alias"],
		["GI7EBA~1/config", "path-8dot3-alias"],
		["src/PROGRA~1.TXT", "path-8dot3-alias"],
		[".git/config", "path-git-dir"],
		[".GIT/hooks/x", "path-git-dir"],
		["a/.Git", "path-git-dir"],
		[".git\u200c/config", "path-git-dir"],
		[".git./x", "path-trailing-dot-or-space"],
		[".git /x", "path-trailing-dot-or-space"],
		["x.", "path-trailing-dot-or-space"],
		["y ", "path-trailing-dot-or-space"],
		["name:stream", "path-alternate-data-stream"],
		["a::$DATA", "path-alternate-data-stream"],
		[".git::$INDEX_ALLOCATION/x", "path-alternate-data-stream"],
		["C:/x", "path-alternate-data-stream"],
		["CON", "path-device-name"],
		["con.tar.gz", "path-device-name"],
		["COM1.txt", "path-device-name"],
		["LPT9", "path-device-name"],
		["COM\u00b9", "path-device-name"],
		["lpt\u00b3.log", "path-device-name"],
		["CONIN$", "path-device-name"],
		["conout$.txt", "path-device-name"],
		["NUL .txt", "path-device-name"],
		["d/aux", "path-device-name"],
		["a\u007fb", "path-control-char"],
		["a\u0001b", "path-control-char"],
		["a<b", "path-reserved-char"],
		["../evil", "path-dot-or-empty-segment"],
		["a//b", "path-dot-or-empty-segment"],
		["/abs", "path-absolute"],
		["a\\b", "path-backslash"],
		["e\u0301", "path-not-nfc"],
		["z".repeat(241), "path-too-long"],
		[MANIFEST_MEMBER, "path-reserved-manifest-name"],
	];
	for (const [p, rule] of cases) expect(() => safePath(p), p).toThrow(`[${rule}]`);
	for (const ok of ["src/valid.ts", "a~b.txt", "x~1y.tar.gz", "git", ".github/x.yml", "console.ts", "d/.gitignore"]) safePath(ok);
	// Self-consistent archive + manifest carrying GIT~1 is refused by the verifier (bypasses safePath in craft).
	const dir = mkdtempSync(join(tmpdir(), "cand-alias-"));
	try {
		const A = Buffer.from("#!/bin/sh\n");
		for (const [p, rule] of [["GIT~1/hooks/post-checkout", "path-8dot3-alias"], [".GIT/hooks/x", "path-git-dir"], ["CONIN$", "path-device-name"]]) {
			const c = craft(dir, [{ path: p, data: A }]);
			await rejects(verifyCandidate(c.archive, c.manifest), rule);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("F3: tracked index entries with unsafe names are refused before any file read", async () => {
	for (const [name, rule] of [["GIT~1/HEAD", "path-8dot3-alias"], ["aux.txt", "path-device-name"], ["CON/x", "path-device-name"]]) {
		const f = fixture();
		try {
			f.w("ok.txt", "o");
			f.g("add", ".");
			const blob = f.g("hash-object", "-w", join(f.root, "ok.txt")).trim();
			f.g("-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
			f.g("-c", "core.protectNTFS=false", "commit", "-qm", "unsafe");
			await rejects(packageCandidate(f.root, f.out()), rule);
		} finally {
			f.done();
		}
	}
}, 30_000);

test("F4: submodules and uninitialised gitlinks are excluded and listed, not fatal", async () => {
	const f = fixture();
	const sub = fixture();
	try {
		sub.w("s.txt", "s");
		sub.g("add", ".");
		sub.g("commit", "-qm", "s");
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		f.g("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.root.replace(/\\/g, "/"), "sub");
		f.g("update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},lib`);
		f.g("commit", "-qm", "subs");
		const digest = await packageCandidate(f.root, f.out());
		const m = f.manifest();
		expect(m.files.map((x: any) => x.path)).toEqual([".gitmodules", "a.txt"]);
		expect(m.exclusions).toContainEqual({ path: "sub/", reason: "submodule" });
		expect(m.exclusions).toContainEqual({ path: "lib/", reason: "submodule" });
		expect((await verifyCandidate(f.out(), f.out() + ".manifest.json", digest)).files).toBe(2);
	} finally {
		f.done();
		sub.done();
	}
}, 30_000);

test("F5: manifest provenance is bound to the archive (forged baseCommit/identity/exclusions refused, even with the trusted hash)", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const digest = await packageCandidate(f.root, f.out());
		const m = f.manifest();
		for (const forged of [{ ...m, baseCommit: "f".repeat(40) }, { ...m, identity: { taskId: "someone-else" } }, { ...m, exclusions: [] }]) {
			writeFileSync(f.out("forged.json"), JSON.stringify(forged, null, 2) + "\n");
			await rejects(verifyCandidate(f.out(), f.out("forged.json"), digest, ["a.txt"]), "manifest-sidecar-mismatch");
			await rejects(verifyCandidate(f.out(), f.out("forged.json")), "manifest-sidecar-mismatch");
		}
	} finally {
		f.done();
	}
}, 30_000);

test("F6: git runs isolated - repo core.fsmonitor never executes, inherited GIT_DIR and global excludes have no effect", async () => {
	const f = fixture();
	const other = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		other.w("OTHER.txt", "o");
		other.g("add", ".");
		other.g("commit", "-qm", "o");
		const marker = join(f.dir, "PWNED");
		writeFileSync(join(f.dir, "hook.sh"), `#!/bin/sh\necho x > "${marker.replace(/\\/g, "/")}"\nexit 1\n`);
		f.g("config", "core.fsmonitor", join(f.dir, "hook.sh").replace(/\\/g, "/"));
		f.w("untracked.ts", "u");
		writeFileSync(join(f.dir, "global-excludes"), "untracked.ts\n");
		writeFileSync(join(f.dir, "gitconfig"), `[core]\n\texcludesFile = ${join(f.dir, "global-excludes").replace(/\\/g, "/")}\n`);
		const r = Bun.spawnSync([process.execPath, TOOL, "package", f.root, f.out()], {
			env: { ...process.env, GIT_DIR: join(other.root, ".git"), GIT_WORK_TREE: other.root, GIT_CONFIG_GLOBAL: join(f.dir, "gitconfig") },
		});
		expect(r.stderr.toString()).toBe("");
		expect(r.exitCode).toBe(0);
		expect(existsSync(marker)).toBe(false);
		const m = f.manifest();
		expect(m.baseCommit).toBe(f.g("rev-parse", "HEAD").trim());
		expect(m.files.map((x: any) => x.path)).toEqual(["a.txt", "untracked.ts"]);
		expect(f.g("rev-parse", "HEAD").trim()).not.toBe(other.g("rev-parse", "HEAD").trim());
	} finally {
		f.done();
		other.done();
	}
}, 30_000);

test("F7: empty, uppercase or malformed expected SHA256 fails closed (API and CLI)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cand-hash-"));
	try {
		const c = craft(dir, [{ path: "a.txt", data: Buffer.from("a") }]);
		const real = sha(readFileSync(c.archive));
		for (const bad of ["", real.toUpperCase(), "abc", " " + real]) await rejects(verifyCandidate(c.archive, c.manifest, bad), "expected-sha256-malformed");
		const cli = Bun.spawnSync([process.execPath, TOOL, "verify", c.archive, c.manifest, ""]);
		expect(cli.exitCode).toBe(1);
		expect(cli.stderr.toString()).toContain("[expected-sha256-malformed]");
		expect(Bun.spawnSync([process.execPath, TOOL, "verify", c.archive, c.manifest, "-"]).exitCode).toBe(0);
		expect(Bun.spawnSync([process.execPath, TOOL, "verify", c.archive, c.manifest, real]).exitCode).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test("F8/F9/F12: verifier refuses tar/gzip forms an extractor would interpret differently", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cand-tar-"));
	try {
		const A = Buffer.from("hello\r\n");
		const B = Buffer.from("world");
		const files = [{ path: "a.txt", data: A }, { path: "d/b.txt", data: B }];
		const raw = (h: Buffer, data: Buffer) => Buffer.concat([rechecksum(h), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
		const base = (name: string, data: Buffer) => Buffer.from(tarHeader(name, data.length, 0o644));
		const ph = base("d/b.txt", B);
		ph.fill(0, 0, 100);
		ph.write("d/b.txt", 345);
		const badUtf8 = base("a.txt", A);
		badUtf8.fill(0, 0, 100);
		Buffer.from([0x61, 0xff, 0x2e, 0x74]).copy(badUtf8, 0);
		const uid = base("a.txt", A);
		uid.write("0001750\0", 108);
		const mtime = base("a.txt", A);
		mtime.write("14000000000\0", 136);
		const link = base("a.txt", A);
		link.write("../../etc/passwd", 157);
		const gnu = base("a.txt", A);
		gnu.write("ustar  \0", 257, "latin1");
		const split = base("d/b.txt", B);
		split.fill(0, 0, 100);
		split.write("b.txt", 0);
		split.write("d", 345);
		const cases: [string, Parameters<typeof craft>[2], string][] = [
			["prefix-only member", { members: [member("a.txt", A), raw(ph, B)] }, "tar-empty-name-field"],
			["invalid utf-8 name", { members: [raw(badUtf8, A), member("d/b.txt", B)] }, "tar-name-invalid-utf8"],
			["uid", { members: [raw(uid, A), member("d/b.txt", B)] }, "tar-header-noncanonical"],
			["mtime", { members: [raw(mtime, A), member("d/b.txt", B)] }, "tar-header-noncanonical"],
			["linkname", { members: [raw(link, A), member("d/b.txt", B)] }, "tar-header-noncanonical"],
			["prefix split", { members: [member("a.txt", A), raw(split, B)] }, "tar-header-noncanonical"],
			["symlink type", { members: [raw(Object.assign(base("a.txt", A), { 156: 50 }), A), member("d/b.txt", B)] }, "tar-member-type"],
			["pax", { members: [raw(Object.assign(base("a.txt", A), { 156: 120 }), A), member("d/b.txt", B)] }, "tar-member-type"],
			["setuid", { members: [raw(Buffer.from(tarHeader("a.txt", A.length, 0o4755)), A), member("d/b.txt", B)] }, "tar-member-mode-mismatch"],
			["gnu magic", { members: [raw(gnu, A), member("d/b.txt", B)] }, "tar-format-unsupported"],
			["extra", { members: [member("a.txt", A), member("d/b.txt", B), member("x.txt", B)] }, "tar-member-unexpected"],
			["missing", { members: [member("a.txt", A)] }, "tar-member-missing"],
			["duplicate", { members: [member("a.txt", A), member("a.txt", A), member("d/b.txt", B)] }, "tar-member-unexpected"],
			["case duplicate", { members: [member("a.txt", A), member("A.txt", A), member("d/b.txt", B)] }, "tar-member-unexpected"],
			["hidden after one zero block", { members: [member("a.txt", A), member("d/b.txt", B), Buffer.alloc(512), member("evil.txt", B)] }, "tar-trailer-invalid"],
			["short trailer", { trailer: Buffer.alloc(512) }, "tar-trailer-invalid"],
			["bad checksum", { members: [Object.assign(member("a.txt", A), { 0: 0x62 }), member("d/b.txt", B)] }, "tar-header-checksum"],
			["nonzero padding", { members: [Buffer.concat([tarHeader("a.txt", A.length, 0o644), A, Buffer.alloc(504, 1)]), member("d/b.txt", B)] }, "tar-padding-nonzero"],
		];
		for (const [label, opts, rule] of cases) {
			const c = craft(dir, files, opts);
			let error: unknown;
			try {
				await verifyCandidate(c.archive, c.manifest);
			} catch (e) {
				error = e;
			}
			expect(`${label}: ${error}`).toContain(`[${rule}]`);
		}
		const good = craft(dir, files);
		const bytes = readFileSync(good.archive);
		writeFileSync(good.archive + "g", Buffer.concat([bytes, Buffer.from("TRAILING-GARBAGE")]));
		writeFileSync(good.archive + "z", Buffer.concat([bytes, Buffer.alloc(16)]));
		writeFileSync(good.archive + "2", Buffer.concat([bytes, gz(Buffer.alloc(0))]));
		writeFileSync(good.archive + "h", Buffer.concat([gzipSync(gunzipSync(bytes))]));
		writeFileSync(good.archive + "t", bytes.subarray(0, bytes.length - 20));
		for (const [suffix, rule] of [["g", "gzip-trailing-data"], ["z", "gzip-trailing-data"], ["2", "gzip-trailing-data"], ["h", "gzip-header"], ["t", "gzip-"]]) {
			let error: unknown;
			try {
				await verifyCandidate(good.archive + suffix, good.manifest);
			} catch (e) {
				error = e;
			}
			expect(`${suffix}: ${error}`).toContain(`[${rule}`);
		}
		const unsorted = { toolVersion: VERSION, baseCommit: "a".repeat(40), identity: null, exclusions: [], files: [{ path: "b", size: 0, sha256: sha(Buffer.alloc(0)), mode: 420 }, { path: "a", size: 0, sha256: sha(Buffer.alloc(0)), mode: 420 }] };
		writeFileSync(join(dir, "u.json"), JSON.stringify(unsorted));
		await rejects(verifyCandidate(good.archive, join(dir, "u.json")), "manifest-not-sorted");
		writeFileSync(join(dir, "c.json"), JSON.stringify({ ...unsorted, files: [{ ...unsorted.files[1], path: "A" }, unsorted.files[1]] }));
		await rejects(verifyCandidate(good.archive, join(dir, "c.json")), "path-case-collision");
		writeFileSync(join(dir, "v.json"), JSON.stringify({ ...unsorted, toolVersion: "1.0.0" }));
		await rejects(verifyCandidate(good.archive, join(dir, "v.json")), "manifest-version");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 30_000);

test("F11: an existing or dangling-link output target is never written through", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		mkdirSync(join(f.dir, "elsewhere"));
		const victim = join(f.dir, "elsewhere", "victim.bin");
		let linked = true;
		try {
			symlinkSync(victim, f.out(), "file");
		} catch {
			linked = false;
		}
		if (linked) {
			await rejects(packageCandidate(f.root, f.out()), "output-exists");
			expect(existsSync(victim)).toBe(false);
		}
		writeFileSync(f.out("exists.tar.gz"), "keep");
		await rejects(packageCandidate(f.root, f.out("exists.tar.gz")), "output-exists");
		expect(readFileSync(f.out("exists.tar.gz"), "utf8")).toBe("keep");
		await rejects(packageCandidate(f.root, join(f.root, "inside.tar.gz")), "output-inside-workspace");
		await rejects(packageCandidate(f.root, join(f.dir, "no-such-dir", "x.tar.gz")), "output-parent-missing");
		mkdirSync(join(f.root, "subdir"));
		await rejects(packageCandidate(join(f.root, "subdir"), f.out("sub.tar.gz")), "workspace-not-repository-root");
	} finally {
		f.done();
	}
}, 30_000);

test("M5: an output directory reached through a link (macOS /tmp -> private/tmp) is written at its final path; a link into the workspace is still refused", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const real = join(f.dir, "real-out");
		mkdirSync(real);
		symlinkSync(real, join(f.dir, "out-link"), win ? "junction" : "dir");
		const digest = await packageCandidate(f.root, join(f.dir, "out-link", "p.tar.gz"));
		expect(sha(readFileSync(join(real, "p.tar.gz")))).toBe(digest);
		expect((await verifyCandidate(join(real, "p.tar.gz"), join(real, "p.tar.gz.manifest.json"), digest)).files).toBe(1);
		symlinkSync(f.root, join(f.dir, "into-ws"), win ? "junction" : "dir");
		await rejects(packageCandidate(f.root, join(f.dir, "into-ws", "p.tar.gz")), "output-inside-workspace");
		expect(existsSync(join(f.root, "p.tar.gz"))).toBe(false);
		if (process.platform === "darwin") {
			const out = join("/tmp", `cand-m5-${process.pid}-${Date.now()}.tar.gz`);
			try {
				expect(await packageCandidate(f.root, out)).toBe(digest);
			} finally {
				rmSync(out, { force: true });
				rmSync(out + ".manifest.json", { force: true });
			}
		}
	} finally {
		f.done();
	}
}, 30_000);

test("F12: hardlinks, junction/symlink parents and tracked-deleted files are refused; tracked bare-looking fixtures kept", async () => {
	const outside = mkdtempSync(join(tmpdir(), "cand-outside-"));
	try {
		writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
		{
			const f = fixture();
			try {
				f.w("a.txt", "a");
				f.g("add", ".");
				f.g("commit", "-qm", "a");
				linkSync(join(outside, "secret.txt"), join(f.root, "hard.txt"));
				await rejects(packageCandidate(f.root, f.out()), "hardlink");
			} finally {
				f.done();
			}
		}
		{
			const f = fixture();
			try {
				f.w("d/x.txt", "x");
				f.g("add", ".");
				f.g("commit", "-qm", "a");
				rmSync(join(f.root, "d"), { recursive: true });
				mkdirSync(join(outside, "d2"));
				writeFileSync(join(outside, "d2", "x.txt"), "OUTSIDE-SECRET");
				symlinkSync(join(outside, "d2"), join(f.root, "d"), "junction");
				await rejects(packageCandidate(f.root, f.out()), "symlink");
			} finally {
				f.done();
			}
		}
		{
			const f = fixture();
			try {
				f.w("a.txt", "a");
				f.w("b.txt", "b");
				f.g("add", ".");
				f.g("commit", "-qm", "a");
				rmSync(join(f.root, "a.txt"));
				await rejects(packageCandidate(f.root, f.out()), "tracked-file-missing");
			} finally {
				f.done();
			}
		}
		{
			const f = fixture();
			try {
				f.w("fixtures/bare.git/HEAD", "ref: refs/heads/main\n");
				f.w("fixtures/bare.git/objects/info/x", "o");
				f.w("fixtures/bare.git/refs/heads/x", "r");
				f.g("add", ".");
				f.g("commit", "-qm", "fixture");
				mkdirSync(join(f.root, "untracked-bare", "objects"), { recursive: true });
				mkdirSync(join(f.root, "untracked-bare", "refs"));
				f.w("untracked-bare/HEAD", "ref: refs/heads/main\n");
				f.w("untracked-bare/objects/y", "y");
				await packageCandidate(f.root, f.out());
				const m = f.manifest();
				expect(m.files.map((x: any) => x.path)).toEqual(["fixtures/bare.git/HEAD", "fixtures/bare.git/objects/info/x", "fixtures/bare.git/refs/heads/x"]);
				expect(m.exclusions).toContainEqual({ path: "untracked-bare/", reason: "nested-bare-repository" });
			} finally {
				f.done();
			}
		}
	} finally {
		rmSync(outside, { recursive: true, force: true });
	}
}, 60_000);

test("N3: nested repositories are excluded only when git (or a real bare-repository layout) agrees; look-alikes holding untracked content are refused", async () => {
	const base = () => {
		const f = fixture();
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		return f;
	};
	const refused: [string, (f: ReturnType<typeof fixture>) => void, string, string][] = [
		["non-gitfile .git file", (f) => f.w("notes/.git", "not a gitfile\n"), "notes/IMPORTANT.md", "nested-git-entry-not-repository"],
		["empty .git directory", (f) => mkdirSync(join(f.root, "notes", ".git"), { recursive: true }), "notes/IMPORTANT.md", "nested-git-entry-not-repository"],
		["upper-case .GIT file", (f) => f.w("notes/.GIT", "x"), "notes/IMPORTANT.md", "nested-git-entry-not-repository"],
		["HEAD/objects/refs plain files", (f) => ["HEAD", "objects", "refs"].forEach((n) => f.w(`docs/${n}`, n)), "docs/IMPORTANT.md", "nested-bare-repository-unrecognized"],
		["objects/refs dirs, HEAD not a ref", (f) => {
			f.w("docs/HEAD", "meeting notes\n");
			f.w("docs/objects/o.txt", "o");
			f.w("docs/refs/r.txt", "r");
		}, "docs/IMPORTANT.md", "nested-bare-repository-unrecognized"],
	];
	for (const [label, plant, important, rule] of refused) {
		const f = base();
		try {
			plant(f);
			f.w(important, "must not be dropped");
			// Precondition: git itself lists the content as untracked.
			expect(f.g("ls-files", "--others", "--exclude-standard").split("\n"), label).toContain(important);
			await rejects(packageCandidate(f.root, f.out()), rule);
			expect(existsSync(f.out()), label).toBe(false);
		} finally {
			f.done();
		}
	}
	// Real ones are still excluded and listed: git-reported nested repo via a gitfile, and a real bare repository.
	const f = base();
	const other = fixture();
	try {
		f.w("wt/.git", `gitdir: ${join(other.root, ".git").replace(/\\/g, "/")}\n`);
		f.w("wt/inner.txt", "inner");
		expect(f.g("ls-files", "--others", "--exclude-standard").split("\n")).toContain("wt/");
		expect(Bun.spawnSync(["git", "init", "-q", "--bare", join(f.root, "scratch.git")], { env: f.env }).exitCode).toBe(0);
		f.w("keep/IMPORTANT.md", "kept");
		await packageCandidate(f.root, f.out());
		const m = f.manifest();
		expect(m.files.map((x: any) => x.path)).toEqual(["a.txt", "keep/IMPORTANT.md"]);
		expect(m.exclusions).toEqual([
			{ path: ".git", reason: "git-dir" },
			{ path: "scratch.git/", reason: "nested-bare-repository" },
			{ path: "wt/", reason: "nested-repository" },
		]);
	} finally {
		f.done();
		other.done();
	}
}, 60_000);

test("unmerged index entries are refused", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "base\n");
		f.g("add", ".");
		f.g("commit", "-qm", "base");
		f.g("checkout", "-qb", "other");
		f.w("a.txt", "other\n");
		f.g("commit", "-qam", "other");
		f.g("checkout", "-q", "-");
		f.w("a.txt", "mine\n");
		f.g("commit", "-qam", "mine");
		Bun.spawnSync(["git", "-c", "core.autocrlf=false", "-c", "user.email=t@e", "-c", "user.name=T", "-C", f.root, "merge", "-q", "other"], { env: f.env });
		await rejects(packageCandidate(f.root, f.out()), "unmerged-index-entry");
	} finally {
		f.done();
	}
}, 30_000);

test.skipIf(win)("POSIX: FIFOs in the working tree are refused as non-regular files", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		expect(Bun.spawnSync(["mkfifo", join(f.root, "pipe")]).exitCode).toBe(0);
		await rejects(packageCandidate(f.root, f.out()), "non-regular-file");
	} finally {
		f.done();
	}
});

test("N1: git.exe/git.bat/git.cmd planted in the workspace root (tracked, untracked, ignored) never run during packaging (API and CLI)", async () => {
	const f = fixture();
	const mark = join(f.dir, "PLANTED-GIT-RAN.txt");
	try {
		f.w(".gitignore", "git.exe\n");
		f.w("a.txt", "a");
		if (win) {
			const src = join(f.dir, "marker.js");
			writeFileSync(src, `require("node:fs").appendFileSync(${JSON.stringify(mark)}, "git.exe " + process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(3);\n`);
			expect(Bun.spawnSync([process.execPath, "build", "--compile", src, "--outfile", join(f.root, "git.exe")]).exitCode).toBe(0);
			f.w("git.cmd", `@echo git.cmd %* >> "${mark}"\r\n@exit /b 3\r\n`);
			f.w("git.bat", `@echo git.bat %* >> "${mark}"\r\n@exit /b 3\r\n`);
			f.g("add", ".gitignore", "a.txt", "git.cmd");
		} else {
			f.w("git", `#!/bin/sh\necho git "$@" >> '${mark}'\nexit 3\n`);
			f.g("add", ".gitignore", "a.txt", "git");
			f.g("update-index", "--chmod=+x", "git");
			expect(Bun.spawnSync(["chmod", "755", join(f.root, "git")]).exitCode).toBe(0);
		}
		f.g("commit", "-qm", "planted");
		if (win) {
			// Precondition on this host: a bare "git" spawned with the workspace as cwd runs the planted program.
			const control = Bun.spawnSync(["git", "--version"], { cwd: f.root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
			expect(control.exitCode).toBe(3);
			expect(existsSync(mark)).toBe(true);
			rmSync(mark);
		}
		const digest = await packageCandidate(f.root, f.out());
		expect(existsSync(mark)).toBe(false);
		const m = f.manifest();
		expect(m.files.map((x: any) => x.path)).toEqual(win ? [".gitignore", "a.txt", "git.bat", "git.cmd"] : [".gitignore", "a.txt", "git"]);
		if (win) expect(m.exclusions).toContainEqual({ path: "git.exe", reason: "ignored" });
		expect(m.baseCommit).toBe(f.g("rev-parse", "HEAD").trim());
		// CLI started from inside the workspace ("." as the workspace argument).
		const cli = Bun.spawnSync([process.execPath, TOOL, "package", ".", f.out("cli.tar.gz")], { cwd: f.root });
		expect(cli.stderr.toString()).toBe("");
		expect(cli.exitCode).toBe(0);
		expect(cli.stdout.toString().trim()).toBe(digest);
		expect(existsSync(mark)).toBe(false);
	} finally {
		f.done();
	}
}, 60_000);

test("N1: git is resolved from absolute PATH entries only; a git inside the workspace or an alias of it is refused before anything runs", async () => {
	const f = fixture();
	const cwd = process.cwd();
	const savedPath = process.env.PATH;
	const exe = win ? "git.exe" : "git";
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const root = realpathSync.native(f.root);
		const real = resolveGit(f.root);
		expect(isAbsolute(real)).toBe(true);
		expect(basename(real).toLowerCase()).toBe(exe);
		expect(relative(root, real).startsWith("..")).toBe(true);
		const realDir = dirname(real);
		// Never executed: resolution refuses before any spawn, so the content is irrelevant.
		f.w(exe, "not git");
		f.w(`tools/${exe}`, "not git");
		if (!win) for (const p of [exe, `tools/${exe}`]) expect(Bun.spawnSync(["chmod", "755", join(f.root, p)]).exitCode).toBe(0);
		symlinkSync(f.root, join(f.dir, "alias"), win ? "junction" : "dir");
		const P = (...entries: string[]) => entries.join(delimiter);
		// Workspace root, a subdirectory, the canonical path, and an outside junction/symlink aliasing the workspace.
		for (const entry of [f.root, join(f.root, "tools"), root, join(f.dir, "alias"), join(f.dir, "alias", "tools")]) {
			await rejects(() => resolveGit(f.root, P(entry, realDir)), "git-inside-workspace");
		}
		if (win) {
			// os.tmpdir() can be an 8.3 short path (C:\Users\RUNNER~1\...); f.root is that alias of the canonical root.
			await rejects(() => resolveGit(root, P(f.root, realDir)), "git-inside-workspace");
			await rejects(() => resolveGit(root, P(`"${f.root}"`, realDir)), "git-inside-workspace");
			expect(resolveGit(f.root, P(`"${realDir}"`))).toBe(real);
			// .bat/.cmd are never accepted as git.
			f.w("cmdonly/git.cmd", "@exit /b 3\r\n");
			f.w("cmdonly/git.bat", "@exit /b 3\r\n");
			expect(resolveGit(f.root, P(join(f.root, "cmdonly"), realDir))).toBe(real);
		}
		// Relative and empty entries resolve against the cwd and are skipped, even with the cwd inside the workspace.
		process.chdir(f.root);
		expect(resolveGit(f.root, P("", ".", "tools", `.${win ? "\\" : "/"}tools`, realDir))).toBe(real);
		process.chdir(cwd);
		// A directory named git.exe/git, and no git at all.
		mkdirSync(join(f.dir, "dironly", exe), { recursive: true });
		expect(resolveGit(f.root, P(join(f.dir, "dironly"), realDir))).toBe(real);
		await rejects(() => resolveGit(f.root, P(join(f.dir, "dironly"))), "git-unavailable");
		await rejects(() => resolveGit(f.root, ""), "git-unavailable");
		// End to end: a PATH that puts the workspace first refuses packaging and writes nothing.
		process.env.PATH = P(f.root, savedPath ?? "");
		await rejects(packageCandidate(f.root, f.out()), "git-inside-workspace");
		expect(existsSync(f.out())).toBe(false);
		process.env.PATH = savedPath;
		await packageCandidate(f.root, f.out("ok.tar.gz"));
	} finally {
		process.env.PATH = savedPath;
		process.chdir(cwd);
		f.done();
	}
}, 30_000);

test("case-insensitive collisions forced through the index are refused", async () => {
	const f = fixture();
	try {
		f.g("config", "core.ignorecase", "false");
		f.w("A.txt", "A");
		f.g("add", ".");
		const blob = f.g("hash-object", "-w", join(f.root, "A.txt")).trim();
		f.g("update-index", "--add", "--cacheinfo", `100644,${blob},a.txt`);
		f.g("commit", "-qm", "collide");
		await rejects(packageCandidate(f.root, f.out()), "path-case-collision");
	} finally {
		f.done();
	}
});

// Pairs a case-insensitive APFS volume stores as one file (measured on macOS 27.2: creating the first name makes
// the second exist), although String.prototype.toLowerCase() keeps them apart: APFS applies full Unicode case folding.
const APFS_FOLDED_PAIRS: [string, string][] = [
	["σ", "ς"], ["s", "ſ"], ["ﬀ", "ff"], ["ß", "ss"], ["ǰ", "J̌"], ["ι", "ͅ"], ["ϐ", "β"], ["ϑ", "θ"],
	["ϕ", "φ"], ["ϖ", "π"], ["ϰ", "κ"], ["ϱ", "ρ"], ["ϵ", "ε"], ["ẛ", "ṡ"], ["µ", "μ"], ["ᲀ", "в"],
	// HFS+ (measured on a case-insensitive HFS+ image): ignorable format characters, Georgian Mkhedruli/Asomtavruli.
	["a\u200c", "a"], ["a\u202e", "a\ufeff"], ["ა", "Ⴀ"], ["ჵ", "Ⴥ"],
];

test("M3: names that alias under full Unicode case folding (APFS/HFS+ extraction targets) are refused by package and verify", async () => {
	for (const [a, b] of APFS_FOLDED_PAIRS) {
		expect(a.normalize("NFC") === a && b.normalize("NFC") === b && a.toLowerCase() !== b.toLowerCase()).toBe(true);
		// verify: a self-consistent crafted package with both names (file/file and file/directory).
		const dir = mkdtempSync(join(tmpdir(), "cand-fold-"));
		try {
			const pair = [`x${a}.txt`, `x${b}.txt`].sort();
			const c = craft(dir, pair.map((path) => ({ path, data: Buffer.from(path) })));
			await rejects(verifyCandidate(c.archive, c.manifest), "path-case-collision");
			const d = craft(dir, [`d${a}/f.txt`, `d${b}`].sort().map((path) => ({ path, data: Buffer.from(path) })));
			await rejects(verifyCandidate(d.archive, d.manifest), "path-case-collision");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	// package: both names forced into the index (any platform: the second name need not exist on disk to be listed).
	const f = fixture();
	try {
		f.g("config", "core.ignorecase", "false");
		f.w("ass.txt", "A");
		f.g("add", ".");
		const blob = f.g("hash-object", "-w", join(f.root, "ass.txt")).trim();
		f.g("update-index", "--add", "--cacheinfo", `100644,${blob},aß.txt`);
		f.g("commit", "-qm", "collide");
		await rejects(packageCandidate(f.root, f.out()), "path-case-collision");
	} finally {
		f.done();
	}
});

// ---------------------------------------------------------------------------------------
// R1 / R2 (review ce2991af): planted programs that must never run during packaging
// ---------------------------------------------------------------------------------------
const NUL = win ? "NUL" : "/dev/null";
let markerProgram: { exe: string; mark: string; dir: string } | undefined;
/**
 * One marker program for the whole file, outside every workspace. When run it appends its own file
 * name and argv to `mark` and exits 3; when run as exactly `<name> --version` next to a `<name>.version`
 * file it prints that file instead (a fake git that only reports a version).
 */
function marker() {
	if (markerProgram) return markerProgram;
	const dir = mkdtempSync(join(tmpdir(), "cand-marker-"));
	const mark = join(dir, "PLANTED-PROGRAM-RAN.txt");
	const exe = join(dir, win ? "marker.exe" : "marker");
	if (win) {
		const src = join(dir, "marker.js");
		writeFileSync(
			src,
			`const fs = require("node:fs"), p = require("node:path");\n` +
				`const me = process.execPath, args = process.argv.slice(2), v = me + ".version";\n` +
				`if (args.length === 1 && args[0] === "--version" && fs.existsSync(v)) { process.stdout.write(fs.readFileSync(v, "utf8")); process.exit(0); }\n` +
				`fs.appendFileSync(${JSON.stringify(mark)}, p.basename(me) + " " + args.join(" ") + "\\n");\nprocess.exit(3);\n`,
		);
		expect(Bun.spawnSync([process.execPath, "build", "--compile", src, "--outfile", exe]).exitCode).toBe(0);
	} else {
		// Shell builtins only: the packager runs git with PATH = git's own directory, so no cat/basename is found.
		writeFileSync(
			exe,
			`#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = --version ] && [ -f "$0.version" ]; then while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$0.version"; exit 0; fi\nprintf '%s %s\\n' "\${0##*/}" "$*" >> '${mark}'\nexit 3\n`,
		);
		expect(Bun.spawnSync(["chmod", "755", exe]).exitCode).toBe(0);
	}
	markerProgram = { exe, mark, dir };
	return markerProgram;
}
afterAll(() => {
	if (markerProgram) rmSync(markerProgram.dir, { recursive: true, force: true });
});
const ran = () => existsSync(marker().mark);
const markLog = () => (ran() ? readFileSync(marker().mark, "utf8") : "");
const clearMark = () => rmSync(marker().mark, { force: true });
/** Copies (never hardlinks: the packager refuses hardlinked workspace files) the marker to `dest`. */
function plant(dest: string) {
	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(marker().exe, dest);
	if (!win) expect(Bun.spawnSync(["chmod", "755", dest]).exitCode).toBe(0);
}
async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		return "ok " + (await p);
	} catch (e) {
		return String((e as Error).message);
	}
}

test.skipIf(!win)("R1: UNC, \\\\?\\UNC, device-namespace, drive-relative and subst spellings of the workspace on PATH are never searched; a planted git.exe there never runs (API and CLI)", async () => {
	const f = fixture();
	const saved = process.env.PATH;
	const substLetter = ["Q:", "R:", "W:", "Y:"].find((l) => !existsSync(l + "\\"));
	let substed = false;
	try {
		f.w(".gitignore", "git.exe\n");
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		plant(join(f.root, "git.exe"));
		plant(join(f.root, "tools", "git.exe"));
		const root = realpathSync.native(f.root);
		const real = resolveGit(f.root);
		const realDir = dirname(real);
		const share = (host: string) => `\\\\${host}\\${root[0]}$${root.slice(2)}`;
		const unc = [share("localhost"), share("127.0.0.1"), `\\\\?\\UNC\\localhost\\${root[0]}$${root.slice(2)}`, share("localhost") + "\\tools", share("localhost").replace(/\\/g, "/")];
		// Precondition: the administrative share reaches the planted program, i.e. the vector is live on this host.
		const live = existsSync(join(share("localhost"), "git.exe"));
		if (live) {
			clearMark();
			expect(Bun.spawnSync([join(share("localhost"), "git.exe"), "--version"]).exitCode).toBe(3);
			expect(ran()).toBe(true);
			clearMark();
		} else console.warn("R1: \\\\localhost admin share unavailable on this host; UNC entries checked by classification only");
		const entries = [...unc, `\\\\?\\${root}`, `\\\\.\\${root}`, `\\\\?\\GLOBALROOT\\Device\\Mup\\localhost\\${root[0]}$${root.slice(2)}`, root.slice(2), root.slice(0, 2) + "tools"];
		if (substLetter) {
			expect(Bun.spawnSync(["subst", substLetter, f.dir]).exitCode).toBe(0);
			substed = true;
			expect(existsSync(`${substLetter}\\repo\\git.exe`)).toBe(true);
			entries.push(`${substLetter}\\repo`, `${substLetter}\\repo\\tools`);
		}
		for (const entry of entries) {
			clearMark();
			process.env.PATH = [entry, saved].join(delimiter);
			const r = await outcome(packageCandidate(f.root, f.out(`e${entries.indexOf(entry)}.tar.gz`)));
			process.env.PATH = saved;
			expect(`${entry}: ${markLog()}`).toBe(`${entry}: `);
			expect(`${entry}: ${r}`).toStartWith(`${entry}: ok `);
			expect(resolveGit(f.root, [entry, realDir].join(delimiter)), entry).toBe(real);
			expect(cp.untrustedLocation(entry), entry).not.toBeNull();
		}
		// CLI with every alias first on PATH, started from inside the workspace.
		const cli = Bun.spawnSync([process.execPath, TOOL, "package", ".", f.out("cli.tar.gz")], { cwd: f.root, env: { ...process.env, PATH: [...entries, saved].join(delimiter) } });
		expect(cli.stderr.toString()).toBe("");
		expect(cli.exitCode).toBe(0);
		expect(ran()).toBe(false);
		// A local PATH entry whose git.exe is a symlink to the UNC alias: the canonical target is not local -> refused, not run.
		mkdirSync(join(f.dir, "unclink"));
		let linked = true;
		try {
			symlinkSync(join(share("localhost"), "git.exe"), join(f.dir, "unclink", "git.exe"), "file");
		} catch {
			linked = false;
		}
		console.log(`R1 coverage: admin share live=${live}, subst=${substed ? substLetter : "none"}, symlink-to-UNC=${linked && live}`);
		if (linked && live) {
			await rejects(() => resolveGit(f.root, [join(f.dir, "unclink"), realDir].join(delimiter)), "git-untrusted-location");
			process.env.PATH = [join(f.dir, "unclink"), saved].join(delimiter);
			await rejects(packageCandidate(f.root, f.out("unclink.tar.gz")), "git-untrusted-location");
			process.env.PATH = saved;
			expect(ran()).toBe(false);
		}
	} finally {
		process.env.PATH = saved;
		if (substed) Bun.spawnSync(["subst", substLetter!, "/D"]);
		clearMark();
		f.done();
	}
}, 120_000);

test("R1: git's location is trusted by drive type and filesystem identity, never by path spelling; unreadable identity fails closed", async () => {
	const f = fixture();
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const real = resolveGit(f.root);
		const realDir = dirname(real);
		const root = realpathSync.native(f.root);
		expect(cp.untrustedLocation(realDir)).toBeNull();
		expect(cp.untrustedLocation(root)).toBeNull();
		if (win) {
			const unused = "ABDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((l) => !existsSync(l + ":\\"));
			for (const p of ["\\\\server\\share\\git", "//server/share/git", "\\\\?\\UNC\\server\\share", "\\\\?\\C:\\Windows", "\\\\.\\C:\\Windows", "\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\x", "\\Windows", "C:Windows", "relative\\dir", "", `${unused}:\\git`])
				expect(cp.untrustedLocation(p), p).not.toBeNull();
		} else for (const p of ["relative/dir", "", "./bin"]) expect(cp.untrustedLocation(p), p).not.toBeNull();
		// Identity, not spelling: any directory in git's canonical chain with the workspace root's identity is refused,
		// whatever its path looks like (bind mounts, network redirectors, aliases not yet known).
		const rootId = cp.fileIdentity(root);
		expect(rootId).toBeTruthy();
		expect(cp.fileIdentity(f.root)).toBe(rootId);
		expect(cp.fileIdentity(realDir)).not.toBe(rootId);
		// The walk opens each directory of git's final path; injected probes change what one of them reports.
		const finalOf = (p: string) => cp.probePath(p, true)!.final!;
		const guidForm = (p: string) => !win || p.startsWith("\\\\?\\Volume{");
		const rewrite = (dir: string, change: (r: cp.PathProbe) => cp.PathProbe, only = (_: string) => true) => {
			const target = finalOf(dir);
			return (p: string, follow: boolean) => {
				const r = cp.probePath(p, follow);
				return r && r.final === target && only(p) ? change(r) : r;
			};
		};
		const alias = (dir: string) => rewrite(dir, (r) => ({ ...r, id: rootId }));
		await rejects(() => resolveGit(f.root, realDir, alias(realDir)), "git-inside-workspace");
		await rejects(() => resolveGit(f.root, realDir, alias(dirname(realDir))), "git-inside-workspace");
		if (win) expect(finalOf(realDir)).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}\\/i);
		// Fail closed: the identity of the workspace or of any directory in git's chain cannot be read.
		await rejects(() => resolveGit(f.root, realDir, rewrite(root, (r) => ({ ...r, id: null }))), "git-identity-unavailable");
		await rejects(() => resolveGit(f.root, realDir, rewrite(dirname(realDir), (r) => ({ ...r, id: null }))), "git-identity-unavailable");
		if (win) {
			// A reparse point of unknown type met while resolving the PATH entry, or in git's final path; an unreadable
			// attribute set; a directory of the final path that opens as something else (changed while being checked).
			const odd = (r: cp.PathProbe) => ({ ...r, attributes: r.attributes | 0x400, tag: 0x80000099 });
			await rejects(() => resolveGit(f.root, realDir, rewrite(dirname(realDir), odd, (p) => !guidForm(p))), "git-reparse-unknown");
			await rejects(() => resolveGit(f.root, realDir, rewrite(dirname(realDir), odd, guidForm)), "git-reparse-unknown");
			await rejects(() => resolveGit(f.root, realDir, rewrite(dirname(realDir), (r) => ({ ...r, attributes: -1 }))), "git-identity-unavailable");
			await rejects(() => resolveGit(f.root, realDir, rewrite(dirname(realDir), (r) => ({ ...r, final: r.final + "x" }), guidForm)), "git-identity-unavailable");
			// A final path of git or of the workspace that cannot be read.
			await rejects(() => resolveGit(f.root, realDir, rewrite(root, (r) => ({ ...r, final: null }))), "git-identity-unavailable");
			await rejects(() => resolveGit(f.root, realDir, rewrite(real, (r) => ({ ...r, final: null }))), "git-identity-unavailable");
		}
		expect(resolveGit(f.root, realDir)).toBe(real);
	} finally {
		f.done();
	}
}, 30_000);

test("R2: git older than 2.44 (no GIT_NO_LAZY_FETCH) is refused after `--version` and before any repository command runs", async () => {
	const f = fixture();
	const saved = process.env.PATH;
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const fake = join(f.dir, "fakegit", win ? "git.exe" : "git");
		plant(fake);
		const P = [dirname(fake), saved].join(delimiter);
		for (const [version, rule] of [["git version 2.43.0.windows.1\n", "git-too-old"], ["git version 1.99.99\n", "git-too-old"], ["not git\n", "git-version-unknown"]]) {
			writeFileSync(fake + ".version", version);
			clearMark();
			process.env.PATH = P;
			await rejects(packageCandidate(f.root, f.out()), rule);
			process.env.PATH = saved;
			expect(markLog(), version).toBe(""); // only `--version` ran; no repository command reached the binary
			expect(existsSync(f.out())).toBe(false);
		}
		// Control: a version that passes the gate makes the next (repository) command reach the same binary.
		writeFileSync(fake + ".version", "git version 2.44.0\n");
		clearMark();
		process.env.PATH = P;
		await rejects(packageCandidate(f.root, f.out()), "git-failed");
		process.env.PATH = saved;
		expect(markLog()).toContain("rev-parse --show-toplevel");
		expect(cp.MIN_GIT_VERSION).toBe("2.44.0");
		for (const [text, v] of [["git version 2.44.0\n", [2, 44, 0]], ["git version 2.43.0.windows.1\n", [2, 43, 0]], ["git version 2.43.7", [2, 43, 7]], ["git version 3.0.0", [3, 0, 0]], ["git version 2.100.1.vfs.0.0", [2, 100, 1]], ["git version 2.44.0-rc0", [2, 44, 0]]] as const)
			expect(cp.parseGitVersion(text), text).toEqual(v as any);
		for (const text of ["", "git version", "git version 2.44", "version 2.44.0", "git version x.y.z", "hub version 2.44.0"]) expect(cp.parseGitVersion(text), text).toBeNull();
	} finally {
		process.env.PATH = saved;
		clearMark();
		f.done();
	}
}, 60_000);

/** Partial clone whose HEAD commit object is missing: reading HEAD^{commit} triggers a lazy fetch from `origin`. */
function lazyFixture(configure: (f: ReturnType<typeof fixture>, src: ReturnType<typeof fixture>) => void) {
	const src = fixture();
	src.w("a.txt", "a\n");
	src.g("add", ".");
	src.g("commit", "-qm", "c");
	const f = fixture();
	f.w("a.txt", "a\n");
	f.g("add", ".");
	writeFileSync(join(f.root, ".git", "refs", "heads", f.g("symbolic-ref", "--short", "HEAD").trim()), src.g("rev-parse", "HEAD"));
	f.g("config", "core.repositoryformatversion", "1");
	f.g("config", "extensions.partialClone", "origin");
	f.g("config", "remote.origin.promisor", "true");
	f.g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
	configure(f, src);
	return { f, src, done: () => (f.done(), src.done()) };
}
const fwd = (p: string) => p.replace(/\\/g, "/");

test.skipIf(!process.env.CANDIDATE_OLD_GIT)("R2: with a real git < 2.44 first on PATH (CANDIDATE_OLD_GIT=<dir of git>) the repository's promisor uploadpack/sshCommand never runs", async () => {
	const oldDir = process.env.CANDIDATE_OLD_GIT!;
	const oldGit = join(oldDir, win ? "git.exe" : "git");
	const version = Bun.spawnSync([oldGit, "--version"]).stdout.toString();
	expect(Number(/^git version 2\.(\d+)\./.exec(version)?.[1])).toBeLessThan(44);
	const saved = process.env.PATH;
	const M = fwd(marker().exe);
	for (const kind of ["uploadpack", "sshCommand"]) {
		const l = lazyFixture((f, src) => {
			if (kind === "uploadpack") {
				f.g("config", "remote.origin.url", fwd(src.root));
				f.g("config", "remote.origin.uploadpack", M);
			} else {
				f.g("config", "remote.origin.url", "ssh://example.invalid/x.git");
				f.g("config", "core.sshCommand", M);
			}
			f.g("config", "protocol.file.allow", "always");
			f.g("config", "protocol.ssh.allow", "always");
		});
		try {
			// Control: the old git runs the program during the lazy fetch. (Without GIT_NO_LAZY_FETCH: some distribution
			// builds of 2.43, e.g. Ubuntu 24.04's, carry the CVE-2024-32004 backport that honours it; upstream 2.43.0 does not.)
			clearMark();
			const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NUL, GIT_NO_LAZY_FETCH: "1" };
			const controlEnv: Record<string, string | undefined> = { ...env };
			delete controlEnv.GIT_NO_LAZY_FETCH;
			Bun.spawnSync([oldGit, "-C", l.f.root, "rev-parse", "--verify", "HEAD^{commit}"], { env: controlEnv, timeout: 30_000 });
			expect(ran(), kind).toBe(true);
			clearMark();
			// Second layer, independent of the version gate: the packager's own argv makes an old git exit 129 up front.
			const direct = Bun.spawnSync([oldGit, ...cp.GIT_OPTIONS, "-C", l.f.root, "rev-parse", "--verify", "HEAD^{commit}"], { env, timeout: 30_000 });
			expect(direct.exitCode).toBe(129);
			expect(ran(), kind).toBe(false);
			process.env.PATH = [oldDir, saved].join(delimiter);
			await rejects(packageCandidate(l.f.root, l.f.out()), "git-too-old");
			process.env.PATH = saved;
			expect(markLog(), kind).toBe("");
		} finally {
			process.env.PATH = saved;
			clearMark();
			l.done();
		}
	}
}, 120_000);

test("R2: no repository-, workspace- or environment-configured program runs during the packager's git commands (each vector with a live control)", async () => {
	const M = fwd(marker().exe);
	const credIn = "protocol=https\nhost=example.invalid\n\n";
	type F = ReturnType<typeof fixture>;
	type Case = {
		id: string;
		/** Repository/workspace setup; returns the environment the caller's process has during packaging. */
		setup: (f: F) => Record<string, string | undefined> | void;
		/** A git command, run on the same repository with that environment but none of the packager's isolation, that runs the program. */
		control: string[] | null;
		input?: string;
		lazy?: (f: F, src: F) => void;
		/** Expected packager outcome: "ok" or a refusal rule. */
		expect?: string;
	};
	const hookScript = (dir: string, name: string) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, name), `#!/bin/sh\n"${M}" hook-${name}\nexit 1\n`);
		if (!win) Bun.spawnSync(["chmod", "755", join(dir, name)]);
	};
	const fsmonitorFile = (p: string) => writeFileSync(p, `[core]\n\tfsmonitor = ${M}\n`);
	const commit = ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "--allow-empty", "-q"];
	const cfg = (f: F, ...kv: string[]) => {
		for (let i = 0; i < kv.length; i += 2) f.g("config", kv[i], kv[i + 1]);
	};
	const lazyControl = ["rev-parse", "--verify", "HEAD^{commit}"];
	const status = ["status", "--porcelain"];
	const ssh = ["ls-remote", "ssh://example.invalid/x.git"];
	const gitProto = ["ls-remote", "git://example.invalid/x.git"];
	const cred = ["credential", "fill"];
	const cases: Case[] = [
		// Lazy fetch from `rev-parse --verify HEAD^{commit}`.
		{ id: "lazy fetch: remote.origin.uploadpack + protocol.file.allow=always", setup: () => {}, lazy: (f, src) => cfg(f, "remote.origin.url", fwd(src.root), "remote.origin.uploadpack", M, "protocol.file.allow", "always"), control: lazyControl, expect: "git-failed" },
		{ id: "lazy fetch: ssh url + core.sshCommand + protocol.ssh.allow=always", setup: () => {}, lazy: (f) => cfg(f, "remote.origin.url", "ssh://example.invalid/x.git", "core.sshCommand", M, "protocol.ssh.allow", "always"), control: lazyControl, expect: "git-failed" },
		{ id: "lazy fetch: ext:: url + protocol.ext.allow=always", setup: () => {}, lazy: (f) => cfg(f, "remote.origin.url", `ext::${M} %S`, "protocol.ext.allow", "always"), control: lazyControl, expect: "git-failed" },
		{ id: "lazy fetch: remote helper rvx:: (git-remote-rvx on the caller's PATH) + protocol.rvx.allow=always", setup: (f) => (plant(join(f.dir, "helpers", win ? "git-remote-rvx.exe" : "git-remote-rvx")), { PATH: [join(f.dir, "helpers"), process.env.PATH].join(delimiter) }), lazy: (f) => cfg(f, "remote.origin.url", "rvx::x", "protocol.rvx.allow", "always"), control: lazyControl, expect: "git-failed" },
		// Repository configuration (also reached through include.path and config.worktree).
		{ id: "core.fsmonitor", setup: (f) => cfg(f, "core.fsmonitor", M), control: status },
		{ id: "core.fsmonitor via include.path (workspace file)", setup: (f) => (fsmonitorFile(join(f.root, "inc.cfg")), cfg(f, "include.path", "../inc.cfg")), control: status },
		{ id: "core.fsmonitor via extensions.worktreeConfig + config.worktree", setup: (f) => (cfg(f, "extensions.worktreeConfig", "true"), void f.g("config", "--worktree", "core.fsmonitor", M)), control: status },
		{ id: "core.hooksPath (workspace dir) pre-commit/post-index-change", setup: (f) => (hookScript(join(f.root, "hooks"), "pre-commit"), hookScript(join(f.root, "hooks"), "post-index-change"), cfg(f, "core.hooksPath", fwd(join(f.root, "hooks")))), control: [...commit, "-m", "x"] },
		{ id: ".git/hooks pre-commit/post-index-change", setup: (f) => (hookScript(join(f.root, ".git", "hooks"), "pre-commit"), hookScript(join(f.root, ".git", "hooks"), "post-index-change")), control: [...commit, "-m", "x"] },
		{ id: "alias.rev-parse / alias.ls-files (builtins are never aliased; control runs alias.rvx)", setup: (f) => cfg(f, "alias.rev-parse", `!"${M}" alias`, "alias.ls-files", `!"${M}" alias`, "alias.rvx", `!"${M}" alias`), control: ["rvx"] },
		{ id: "core.editor", setup: (f) => cfg(f, "core.editor", `"${M}" editor`), control: commit },
		{ id: "credential.helper", setup: (f) => cfg(f, "credential.helper", `!"${M}" cred`), control: cred, input: credIn },
		{ id: "core.askPass", setup: (f) => cfg(f, "core.askPass", M), control: cred, input: credIn },
		{ id: "gpg.program + commit.gpgSign", setup: (f) => cfg(f, "gpg.program", M, "commit.gpgSign", "true"), control: [...commit, "-m", "x"] },
		{ id: "diff.external", setup: (f) => (cfg(f, "diff.external", M), f.w("a.txt", "changed")), control: ["diff"] },
		{ id: "filter.<n>.clean/process, required (.gitattributes)", setup: (f) => (f.w(".gitattributes", "*.txt filter=rv\n"), cfg(f, "filter.rv.clean", `"${M}" clean`, "filter.rv.process", `"${M}" process`, "filter.rv.required", "true"), f.w("a.txt", "changed")), control: ["add", "a.txt"] },
		{ id: "filter.<n>.smudge, required (.gitattributes)", setup: (f) => (f.w(".gitattributes", "*.txt filter=rs\n"), cfg(f, "filter.rs.smudge", `"${M}" smudge`, "filter.rs.required", "true"), rmSync(join(f.root, "a.txt"))), control: ["checkout", "--", "a.txt"], expect: "tracked-file-missing" },
		{ id: "core.sshCommand + protocol.ssh.allow=always", setup: (f) => cfg(f, "core.sshCommand", M, "protocol.ssh.allow", "always"), control: ssh },
		{ id: "core.gitProxy + protocol.git.allow=always", setup: (f) => cfg(f, "core.gitProxy", M, "protocol.git.allow", "always"), control: gitProto },
		{ id: "core.pager / pager.ls-files / pager.rev-parse (stdout is never a terminal; no control)", setup: (f) => cfg(f, "core.pager", M, "pager.ls-files", M, "pager.rev-parse", M), control: null },
		{ id: "core.alternateRefsCommand / uploadpack.packObjectsHook (server side only; no control)", setup: (f) => cfg(f, "core.alternateRefsCommand", M, "uploadpack.packObjectsHook", M), control: null },
		// Caller environment (the packager builds git's environment from scratch).
		{ id: "env GIT_EXEC_PATH (planted git-rvx)", setup: (f) => (plant(join(f.dir, "exec", win ? "git-rvx.exe" : "git-rvx")), { GIT_EXEC_PATH: join(f.dir, "exec") }), control: ["rvx"] },
		{ id: "env GIT_EDITOR", setup: () => ({ GIT_EDITOR: M }), control: commit },
		{ id: "env GIT_SSH_COMMAND", setup: () => ({ GIT_SSH_COMMAND: M }), control: ssh },
		{ id: "env GIT_SSH", setup: () => ({ GIT_SSH: marker().exe }), control: ssh },
		{ id: "env GIT_PROXY_COMMAND", setup: () => ({ GIT_PROXY_COMMAND: M }), control: gitProto },
		{ id: "env GIT_EXTERNAL_DIFF", setup: (f) => (f.w("a.txt", "changed"), { GIT_EXTERNAL_DIFF: M }), control: ["diff"] },
		{ id: "env GIT_ASKPASS", setup: () => ({ GIT_ASKPASS: M }), control: cred, input: credIn },
		{ id: "env SSH_ASKPASS", setup: () => ({ SSH_ASKPASS: M }), control: cred, input: credIn },
		{ id: "env GIT_CONFIG_COUNT/KEY/VALUE core.fsmonitor", setup: () => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: M }), control: status },
		{ id: "env GIT_CONFIG_PARAMETERS core.fsmonitor", setup: () => ({ GIT_CONFIG_PARAMETERS: `'core.fsmonitor'='${M}'` }), control: status },
		{ id: "env GIT_CONFIG_GLOBAL (file with core.fsmonitor)", setup: (f) => (fsmonitorFile(join(f.dir, "global.cfg")), { GIT_CONFIG_GLOBAL: join(f.dir, "global.cfg") }), control: status },
		{ id: "env GIT_CONFIG_SYSTEM (file with core.fsmonitor)", setup: (f) => (fsmonitorFile(join(f.dir, "system.cfg")), { GIT_CONFIG_SYSTEM: join(f.dir, "system.cfg"), GIT_CONFIG_NOSYSTEM: undefined }), control: status },
		{ id: "env HOME/USERPROFILE = workspace with .gitconfig (core.fsmonitor)", setup: (f) => (fsmonitorFile(join(f.root, ".gitconfig")), { HOME: f.root, USERPROFILE: f.root, GIT_CONFIG_GLOBAL: undefined }), control: status },
		// Isolate HOME: when ~/.gitconfig exists (common on agent images), git ignores
		// $XDG_CONFIG_HOME/git/config for the global layer once GIT_CONFIG_GLOBAL is cleared.
		{ id: "env XDG_CONFIG_HOME/git/config (core.fsmonitor)", setup: (f) => (mkdirSync(join(f.dir, "xdg", "git"), { recursive: true }), mkdirSync(join(f.dir, "xdg-home"), { recursive: true }), fsmonitorFile(join(f.dir, "xdg", "git", "config")), { XDG_CONFIG_HOME: join(f.dir, "xdg"), HOME: join(f.dir, "xdg-home"), USERPROFILE: join(f.dir, "xdg-home"), GIT_CONFIG_GLOBAL: undefined }), control: status },
	];
	// Any empty directory serves as the workspace here (not tmpdir() itself: a git installed under it would be inside).
	const probeWorkspace = mkdtempSync(join(tmpdir(), "cand-gitprobe-"));
	const gitExe = resolveGit(probeWorkspace);
	rmSync(probeWorkspace, { recursive: true, force: true });
	const report: string[] = [];
	const restore = (saved: Record<string, string | undefined>) => {
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
	};
	for (const c of cases) {
		let l: ReturnType<typeof lazyFixture> | undefined;
		const f = c.lazy ? (l = lazyFixture(c.lazy)).f : fixture();
		const saved = { ...process.env };
		try {
			if (!c.lazy) {
				f.w("a.txt", "a");
				f.g("add", ".");
				f.g("commit", "-qm", "a");
			}
			const env = c.setup(f) ?? {};
			if (c.control) {
				clearMark();
				// The caller's own editor/pager/askpass settings are dropped so only the planted program can be reached.
				const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|EDITOR$|VISUAL$|PAGER$|SSH_ASKPASS$)/i.test(k)));
				const controlEnv: Record<string, string | undefined> = { ...inherited, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: NUL, GIT_TERMINAL_PROMPT: "0", ...env };
				for (const k of Object.keys(controlEnv)) if (controlEnv[k] === undefined) delete controlEnv[k];
				Bun.spawnSync([gitExe, "-C", f.root, ...c.control], { cwd: f.root, env: controlEnv as any, stdin: c.input ? Buffer.from(c.input) : "ignore", timeout: 30_000 });
				expect(`${c.id}: control ran=${ran()}`).toBe(`${c.id}: control ran=true`);
				clearMark();
			}
			for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
			else process.env[k] = v;
			const r = await outcome(packageCandidate(f.root, f.out()));
			restore(saved);
			report.push(`${ran() ? "RAN " : "safe"} ${c.id}: ${r.slice(0, 120)}`);
			expect(`${c.id}: ${markLog()}`).toBe(`${c.id}: `);
			const want = c.expect ?? "ok";
			expect(`${c.id}: ${r}`).toStartWith(want === "ok" ? `${c.id}: ok ` : `${c.id}: [${want}]`);
		} finally {
			restore(saved);
			clearMark();
			if (l) l.done();
			else f.done();
		}
	}
	console.log(report.join("\n"));
}, 600_000);

test.skipIf(!win)("I1: an outside git.exe that is a hard link to a workspace file is refused before it runs; hard links between outside files are accepted", async () => {
	const f = fixture();
	const saved = process.env.PATH;
	try {
		f.w(".gitignore", "git.exe\n");
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		plant(join(f.root, "tools", "git.exe"));
		mkdirSync(join(f.dir, "outside"));
		linkSync(join(f.root, "tools", "git.exe"), join(f.dir, "outside", "git.exe"));
		expect(cp.hardLinkNames(realpathSync.native(join(f.dir, "outside", "git.exe")))!.length).toBe(2);
		await rejects(() => resolveGit(f.root, join(f.dir, "outside")), "git-inside-workspace");
		clearMark();
		process.env.PATH = [join(f.dir, "outside"), saved].join(delimiter);
		await rejects(packageCandidate(f.root, f.out()), "git-inside-workspace");
		process.env.PATH = saved;
		expect(ran()).toBe(false);
		// Legitimate installs hard-link git binaries among themselves: accepted (resolution only, never run here).
		mkdirSync(join(f.dir, "other"));
		plant(join(f.dir, "other", "git.exe"));
		mkdirSync(join(f.dir, "linked"));
		linkSync(join(f.dir, "other", "git.exe"), join(f.dir, "linked", "git.exe"));
		expect(resolveGit(f.root, join(f.dir, "linked"))).toBe(realpathSync.native(join(f.dir, "linked", "git.exe")));
		// The real git is unaffected.
		expect(cp.hardLinkNames(resolveGit(f.root))!.length).toBeGreaterThan(0);
	} finally {
		process.env.PATH = saved;
		clearMark();
		f.done();
	}
}, 60_000);

// ---------------------------------------------------------------------------------------
// S1 (review 322d9824): volumes mounted in a folder (real VHDX; creating one needs an elevated token)
// ---------------------------------------------------------------------------------------
const elevated = win && Bun.spawnSync(["net", "session"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
const run = (cmd: string[]) => {
	const r = Bun.spawnSync(cmd);
	if (r.exitCode !== 0) throw Error(`${cmd.join(" ")} exited ${r.exitCode}: ${r.stdout}${r.stderr}`);
	return r.stdout.toString();
};
/** A 512 MB expandable VHDX under `dir` (NTFS unless `fs`), attached and mounted at `dir\mnt` only (no drive letter). */
function folderMountedVolume(dir: string, fs = "ntfs", at = join(dir, "mnt")) {
	mkdirSync(dir, { recursive: true });
	mkdirSync(at, { recursive: true });
	const vhdx = join(dir, "v.vhdx");
	const diskpart = (...lines: string[]) => {
		writeFileSync(join(dir, "dp.txt"), lines.join("\r\n") + "\r\n");
		return run(["diskpart", "/s", join(dir, "dp.txt")]);
	};
	diskpart(`create vdisk file="${vhdx}" maximum=512 type=expandable`, `select vdisk file="${vhdx}"`, "attach vdisk", "create partition primary", `format fs=${fs} quick label=CANDS1`, `assign mount="${at}"`);
	const volume = run(["mountvol", at + "\\", "/L"]).trim();
	expect(volume).toMatch(/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i);
	const points = new Set([at]);
	// keepOnline last-mount /D is only for the raw Volume{GUID} junction case; default last unmount uses /P.
	let lastMountRemovedWithDOnly = false;
	return {
		mnt: at,
		volume,
		mount(at: string) {
			mkdirSync(at, { recursive: true });
			run(["mountvol", at + "\\", volume]);
			points.add(at);
			lastMountRemovedWithDOnly = false;
		},
		unmount(at: string, opts?: { keepOnline?: boolean }) {
			const last = points.size === 1 && points.has(at);
			const removal = last && !opts?.keepOnline ? "/P" : "/D";
			if (last && removal === "/D") lastMountRemovedWithDOnly = true;
			else if (!last) lastMountRemovedWithDOnly = false;
			run(["mountvol", at + "\\", removal]);
			points.delete(at);
		},
		/**
		 * Removes every mount point first: a recursive delete of the fixture must never reach the volume's files.
		 * Returns whether mounts are confirmed gone. Callers must not recursively delete a tree when this is false.
		 */
		done(): { mountsCleared: boolean; errors: Error[] } {
			// Keep going across volumes even when one step fails; surface every error without erasing mount tracking.
			const errors: Error[] = [];
			const push = (error: unknown) => {
				errors.push(error instanceof Error ? error : new Error(String(error)));
			};
			const under = (path: string, root: string) => {
				try {
					const a = realpathSync.native(path).toLowerCase();
					const b = realpathSync.native(root).toLowerCase();
					return a === b || a.startsWith(b.endsWith("\\") ? b : b + "\\");
				} catch {
					return false;
				}
			};
			// Move cwd off the volume before offline; never recursively delete through a live mount.
			try {
				const cwd = process.cwd();
				if (under(cwd, dir) || [...points].some((m) => under(cwd, m))) process.chdir(tmpdir());
			} catch (error) {
				push(error);
			}
			const mountSnapshot = [...points];
			// Volume{...} on /L means still mounted. Clear tracking only for a confirmed unmount:
			// /D exit 0 with no volume id, or an explicit mountvol "not mounted" status (not generic path errors).
			const explicitNotMounted = (text: string) => /not currently mounted|is not a mounted volume/i.test(text);
			for (const mount of [...points]) {
				try {
					// Removing a name does not dismount the volume. Offline it at the final mount.
					const removal = points.size === 1 ? "/P" : "/D";
					let lastDel = "";
					let lastList = "";
					let cleared = false;
					for (let attempt = 0; attempt < 50; attempt++) {
						const del = Bun.spawnSync(["mountvol", mount + "\\", removal]);
						lastDel = `${del.stdout}${del.stderr}`;
						const listed = Bun.spawnSync(["mountvol", mount + "\\", "/L"]);
						lastList = `${listed.stdout}${listed.stderr}`;
						const hasVolume = /Volume\{[0-9a-f-]+\}/i.test(lastList);
						if (hasVolume) {
							Bun.sleepSync(100);
							continue;
						}
						if (del.exitCode === 0 || explicitNotMounted(lastDel) || explicitNotMounted(lastList)) {
							points.delete(mount);
							cleared = true;
							break;
						}
						if (attempt === 49) break;
						Bun.sleepSync(100);
					}
					if (!cleared) {
						push(
							Error(
								`mountvol did not confirm unmount for ${mount}: ${removal} lastDel=${lastDel}; /L lastList=${lastList}`,
							),
						);
					}
				} catch (error) {
					push(error);
				}
			}
			const mountsCleared = points.size === 0;
			if (!mountsCleared) {
				// Leave points intact so the remaining mounts and paths stay distinguishable.
				push(Error(`mount points still tracked after teardown: ${[...points].join(", ")}`));
				return { mountsCleared, errors };
			}
			// Mounts are confirmed gone: former mount directories are local again, safe to clear leftover names.
			for (const mount of mountSnapshot) {
				try {
					for (const name of readdirSync(mount)) rmSync(join(mount, name), { recursive: true, force: true });
				} catch (error) {
					push(error);
				}
			}
			// openSync("r+") is a shared read-write open on Windows, not CreateFileW with zero share mode.
			const readWriteOpen = (): string => {
				try {
					const fd = openSync(vhdx, "r+");
					closeSync(fd);
					return "ok";
				} catch (error: any) {
					return String(error?.code ?? error);
				}
			};
			// Detach offlines a volume that mid-test left with no folder mount (/D-only last unmount).
			// Do not call mountvol with a volume GUID and /P: /P requires a folder mount path.
			try {
				writeFileSync(join(dir, "dp.txt"), [`select vdisk file="${vhdx}"`, "detach vdisk"].join("\r\n") + "\r\n");
				const detach = Bun.spawnSync(["diskpart", "/s", join(dir, "dp.txt")]);
				const detachText = `${detach.stdout}${detach.stderr}`.trim();
				console.log(
					`[S1-teardown] diskpart detach exit=${detach.exitCode} vhdx=${vhdx} dOnly=${lastMountRemovedWithDOnly} out=${detachText.slice(0, 800)}`,
				);
				if (detach.exitCode !== 0 && !/already detached/i.test(detachText)) {
					push(Error(`diskpart detach exited ${detach.exitCode}: ${detachText}`));
				}
			} catch (error) {
				push(error);
			}
			const postDetachOpen = readWriteOpen();
			console.log(`[S1-teardown] post-detach read-write-open=${postDetachOpen} t=${Date.now()}`);
			// After mounts are cleared and detach succeeds, the VDS/AV lock release is retried for a minute;
			// hosted runners have held it longer than the old 12 s bound. A still-locked file after that is a cleanup failure.
			try {
				let firstReadWriteOkAt: number | undefined;
				for (let attempt = 0; ; attempt++) {
					const openState = readWriteOpen();
					if (openState === "ok" && firstReadWriteOkAt === undefined) {
						firstReadWriteOkAt = Date.now();
						console.log(`[S1-teardown] read-write-open became ok attempt=${attempt} t=${firstReadWriteOkAt}`);
					}
					try {
						rmSync(vhdx, { force: true });
						console.log(
							`[S1-teardown] vhdx rm ok attempt=${attempt} readWriteFirstOk=${firstReadWriteOkAt ?? "never"} postDetachOpen=${postDetachOpen}`,
						);
						break;
					} catch (error: any) {
						if (error?.code !== "EBUSY") throw error;
						if (attempt >= 600) {
							// One-shot redacted probe only: Attached=true|false|unknown plus event id/time.
							// Do not print Defender/VDS message bodies (public CI). Attached=false alone is not proof of AV.
							const ps = [
								`$p = ${JSON.stringify(vhdx)}`,
								`try { $i = Get-DiskImage -ImagePath $p -ErrorAction Stop; if ($i.Attached -eq $true) { 'Attached=true' } elseif ($i.Attached -eq $false) { 'Attached=false' } else { 'Attached=unknown' } } catch { 'Attached=unknown' }`,
								`$since = (Get-Date).AddMinutes(-5)`,
								`try { Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=$since} -MaxEvents 5 -ErrorAction Stop | ForEach-Object { 'Defender id=' + $_.Id + ' t=' + $_.TimeCreated.ToUniversalTime().ToString('o') } } catch { 'Defender=none' }`,
								`try { Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Virtual Disk Service'; StartTime=$since} -MaxEvents 5 -ErrorAction Stop | ForEach-Object { 'VDS id=' + $_.Id + ' t=' + $_.TimeCreated.ToUniversalTime().ToString('o') } } catch { 'VDS=none' }`,
							].join("; ");
							const probe = Bun.spawnSync(["powershell", "-NoProfile", "-Command", ps], {
								stdout: "pipe",
								stderr: "pipe",
								timeout: 5_000,
							});
							const probeText = `${probe.stdout}`.toString().trim().slice(0, 800);
							const attached = /Attached=(true|false|unknown)/.exec(probeText)?.[1] ?? "unknown";
							console.log(`[S1-teardown] EBUSY lock probe exit=${probe.exitCode} attached=${attached}\n${probeText}`);
							throw Error(
								`vhdx still EBUSY after mountvol clear + detach (${vhdx})` +
									(lastMountRemovedWithDOnly ? " [last mount was /D-only before detach]" : "") +
									` [postDetachOpen=${postDetachOpen}; readWriteFirstOk=${firstReadWriteOkAt ?? "never"}; lastReadWrite=${openState}; Attached=${attached}]`,
							);
						}
						Bun.sleepSync(100);
					}
				}
			} catch (error) {
				push(error);
			}
			return { mountsCleared, errors };
		},
	};
}

test.skipIf(!elevated)("S1: a volume mounted in a folder (no drive letter): git's chain is walked on its own volume and across every mount point; a git.exe on or under the workspace never runs, a legitimate one is accepted", async () => {
	const f = fixture();
	const saved = process.env.PATH;
	const v = folderMountedVolume(join(realpathSync.native(f.dir), "vol"));
	const volumes = [v];
	const fake = (p: string) => {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, "not git (resolution refuses before any spawn)");
	};
	try {
		f.w("a.txt", "a");
		f.g("add", ".");
		f.g("commit", "-qm", "a");
		const host = resolveGit(f.root);
		const hostDir = dirname(host);
		const P = (...e: string[]) => [...e, hostDir].join(delimiter);
		// M1: the workspace is the root of the mounted volume.
		fake(join(v.mnt, "bin", "git.exe"));
		plant(join(v.mnt, "git.exe"));
		for (const entry of [v.mnt, v.mnt + "\\", join(v.mnt, "bin")]) await rejects(() => resolveGit(v.mnt, P(entry)), "git-inside-workspace");
		clearMark();
		process.env.PATH = [v.mnt, saved].join(delimiter);
		await rejects(packageCandidate(v.mnt, join(f.dir, "m1.tar.gz")), "git-inside-workspace");
		process.env.PATH = saved;
		expect(markLog()).toBe("");
		// M4: a workspace on the mounted volume with the host git is accepted.
		expect(resolveGit(v.mnt, hostDir)).toBe(host);
		// M2: a workspace on the mounted volume whose volume-relative path also exists on C: (\Users).
		const m2 = join(v.mnt, "Users");
		fake(join(m2, "git.exe"));
		fake(join(m2, "tools", "git.exe"));
		for (const entry of [m2, join(m2, "tools")]) await rejects(() => resolveGit(m2, P(entry)), "git-inside-workspace");
		// I1 on the mounted volume: an outside name hard-linked to a workspace file.
		mkdirSync(join(v.mnt, "outside"));
		linkSync(join(m2, "tools", "git.exe"), join(v.mnt, "outside", "git.exe"));
		await rejects(() => resolveGit(m2, P(join(v.mnt, "outside"))), "git-inside-workspace");
		// M5: a legitimate git on the mounted volume, workspace on C:.
		const legit = join(v.mnt, "tools", "git", "cmd", "git.exe");
		fake(legit);
		expect(resolveGit(f.root, P(dirname(legit)))).toBe(legit);
		// M3: the same volume also mounted inside the C: workspace; every git on it is now inside the workspace.
		const m3 = join(realpathSync.native(f.root), "m");
		v.mount(m3);
		expect(existsSync(join(m3, "git.exe"))).toBe(true);
		for (const entry of [m3, join(m3, "bin"), dirname(legit)]) await rejects(() => resolveGit(f.root, P(entry)), "git-inside-workspace");
		clearMark();
		process.env.PATH = [m3, saved].join(delimiter);
		await rejects(packageCandidate(f.root, f.out("m3.tar.gz")), "git-inside-workspace");
		process.env.PATH = saved;
		expect(markLog()).toBe("");
		v.unmount(m3);
		expect(resolveGit(f.root, P(dirname(legit)))).toBe(legit);
		// Nested: a second volume mounted in a folder of the first; the walk crosses both mount points.
		const w2 = folderMountedVolume(join(f.dir, "vol2"), "ntfs", join(v.mnt, "nest"));
		volumes.push(w2);
		fake(join(w2.mnt, "git.exe"));
		await rejects(() => resolveGit(v.mnt, P(w2.mnt)), "git-inside-workspace");
		expect(resolveGit(f.root, P(w2.mnt))).toBe(join(w2.mnt, "git.exe"));
		expect(resolveGit(w2.mnt, P(join(v.mnt, "tools", "git", "cmd")))).toBe(legit);
		// A junction on C: into the mounted volume: resolved through the mount point to the volume's final path.
		symlinkSync(join(m2, "tools"), join(f.dir, "jm"), "junction");
		await rejects(() => resolveGit(m2, P(join(f.dir, "jm"))), "git-inside-workspace");
		expect(resolveGit(f.root, P(join(f.dir, "jm")))).toBe(join(m2, "tools", "git.exe"));
		rmdirSync(join(f.dir, "jm"));
		// A volume with no mount point at all, reachable only through a raw junction to its GUID path: its place in
		// the tree is unknown -> refused (fail closed), never accepted.
		// keepOnline: /D only so the volume GUID stays resolvable; default last-mount unmount uses /P.
		w2.unmount(w2.mnt, { keepOnline: true });
		expect(Bun.spawnSync(["cmd", "/c", "mklink", "/J", join(f.dir, "jv"), w2.volume]).exitCode).toBe(0);
		await rejects(() => resolveGit(f.root, P(join(f.dir, "jv"))), "git-identity-unavailable");
		rmdirSync(join(f.dir, "jv"));
		// FAT32 (no reparse points, no file ids): a PATH entry there without git.exe is skipped; a git.exe there
		// cannot be identified and fails closed.
		const fat = folderMountedVolume(join(f.dir, "fat"), "fat32");
		volumes.push(fat);
		mkdirSync(join(fat.mnt, "empty"));
		expect(resolveGit(f.root, P(join(fat.mnt, "empty")))).toBe(host);
		fake(join(fat.mnt, "g", "git.exe"));
		await rejects(() => resolveGit(f.root, P(join(fat.mnt, "g"))), "git-identity-unavailable");
	} finally {
		process.env.PATH = saved;
		clearMark();
		// One volume's cleanup failure must not skip the rest. Skip fixture recursive delete unless every mount is confirmed gone.
		const cleanupErrors: Error[] = [];
		let mountsSafe = true;
		for (const x of [...volumes].reverse()) {
			try {
				const result = x.done();
				cleanupErrors.push(...result.errors);
				if (!result.mountsCleared) mountsSafe = false;
			} catch (error) {
				mountsSafe = false;
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		}
		if (mountsSafe) {
			try {
				f.done();
			} catch (error) {
				cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
			}
		} else {
			cleanupErrors.push(Error(`skipped fixture recursive delete; unconfirmed mounts remain (left under ${f.dir})`));
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0]!;
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `S1 cleanup failed (${cleanupErrors.length})`);
	}
}, 180_000);

test.skipIf(!win)("S1/O1/O2: a reparse point of unknown type refuses; a link to an unreachable share is skipped without network I/O; DefineDosDevice redirections are not trusted", async () => {
	const f = fixture();
	const k = dlopen("kernel32.dll", {
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i64], returns: FFIType.i64 },
		DeviceIoControl: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		DefineDosDeviceW: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		QueryDosDeviceW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
	}).symbols;
	const w = (s: string) => Buffer.from(s + "\0", "utf16le");
	const letter = ["N:", "O:", "U:", "V:"].find((l) => !existsSync(l + "\\"));
	const defined: [string, string][] = [];
	try {
		const host = resolveGit(f.root);
		const P = (...e: string[]) => [...e, dirname(host)].join(delimiter);
		mkdirSync(join(f.root, "bin"));
		writeFileSync(join(f.root, "bin", "git.exe"), "not git");
		// A real reparse point of a type nothing handles (tag 0x80000099) on a PATH directory.
		const odd = join(f.dir, "odd");
		mkdirSync(odd);
		const h = BigInt(k.CreateFileW(w(odd), 0x40000080, 7, null, 3, 0x02200000, 0n));
		const data = Buffer.alloc(12);
		data.writeUInt32LE(0x80000099, 0);
		data.writeUInt16LE(4, 4);
		const tagged = h !== -1n && k.DeviceIoControl(h, 0x900a4 /* FSCTL_SET_REPARSE_POINT */, data, data.length, null, 0, Buffer.alloc(4), null) !== 0;
		if (h !== -1n) k.CloseHandle(h);
		if (tagged) {
			expect(cp.probePath(odd, false)!.tag).toBe(0x80000099);
			for (const entry of [odd, join(odd, "bin")]) await rejects(() => resolveGit(f.root, P(entry)), "git-reparse-unknown");
		} else console.warn("S1: FSCTL_SET_REPARSE_POINT refused on this host; unknown reparse types covered by injected probes only");
		// O2: a directory symlink on C: to an unroutable host is skipped from its reparse data alone (no SMB timeout).
		let linked = true;
		try {
			symlinkSync("\\\\10.255.255.1\\share", join(f.dir, "unc"), "dir");
		} catch {
			linked = false;
		}
		console.log(`S1/O1/O2 coverage: unknown reparse tag=${tagged}, symlink to unreachable share=${linked}, DefineDosDevice letter=${letter ?? "none"}`);
		if (linked) {
			const t0 = performance.now();
			expect(resolveGit(f.root, P(join(f.dir, "unc"), join(f.dir, "unc", "bin")))).toBe(host);
			expect(performance.now() - t0).toBeLessThan(3000);
		}
		// O1: DefineDosDevice with a raw \Device\HarddiskVolumeN\<dir> target is not a volume mount point -> never searched;
		// a raw alias of the whole volume device is the volume itself, and the identity walk still finds the workspace.
		if (letter) {
			const dev = Buffer.alloc(2048);
			const device = k.QueryDosDeviceW(w(f.root.slice(0, 2)), dev, 1024) ? dev.toString("utf16le").split("\0")[0] : "";
			expect(device).toMatch(/^\\Device\\/);
			const rel = realpathSync.native(f.root).slice(2);
			for (const target of [device + rel, device]) {
				expect(k.DefineDosDeviceW(1 /* DDD_RAW_TARGET_PATH */, w(letter), w(target))).not.toBe(0);
				defined.push([letter, target]);
				const entry = target === device ? letter + rel + "\\bin" : letter + "\\bin";
				expect(existsSync(join(entry, "git.exe"))).toBe(true);
				if (target === device) {
					expect(cp.untrustedLocation(entry)).toBeNull();
					await rejects(() => resolveGit(f.root, P(entry)), "git-inside-workspace");
				} else {
					expect(cp.untrustedLocation(entry)).toContain("not a volume mount point");
					expect(resolveGit(f.root, P(entry))).toBe(host);
				}
				k.DefineDosDeviceW(1 | 2 | 4, w(letter), w(target));
				defined.pop();
			}
		}
	} finally {
		for (const [l, t] of defined) k.DefineDosDeviceW(1 | 2 | 4, w(l), w(t));
		try {
			rmdirSync(join(f.dir, "unc"));
		} catch {}
		f.done();
	}
}, 60_000);
