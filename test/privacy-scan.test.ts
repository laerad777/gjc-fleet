import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SCAN_BYTES, RULES, denyListMatches, gitFailure, isPrivateIPv4, isPublicIPv4, isReportableIPv6, parentsInsideRoot, parseIPv6, parseAllowList, redactText, scanFiles, scanLine, sha256, walkDirectory } from "../scripts/privacy-scan";

// Every private-looking value in this file is assembled at runtime so that the tracked source of
// this test never contains a literal the privacy scan would report.
const ip = (...octets: number[]) => octets.join(".");
const v6 = (...groups: string[]) => groups.join(":");
const at = (local: string, domain: string) => `${local}@${domain}`;
const path = (...parts: string[]) => parts.join("/");
const winPath = (sep: string, ...parts: string[]) => parts.join(sep);
const digits = (n: number) => Array.from({ length: n }, (_, i) => String((i + 1) % 10)).join("");

const SCRIPT = join(import.meta.dir, "..", "scripts", "privacy-scan.ts");
const roots: string[] = [];
afterAll(() => {
	for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function tree(files: Record<string, string | Uint8Array>): string {
	const root = mkdtempSync(join(tmpdir(), "privacy-scan-"));
	roots.push(root);
	for (const [name, content] of Object.entries(files)) {
		const target = join(root, ...name.split("/"));
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}
function cli(args: string[], cwd?: string) {
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}
const rulesOf = (line: string, deny: string[] = []) => scanLine(line, deny).map((m) => m.rule);
const one = (rule: string, line: string) => RULES[rule]!(line).map((m) => m.text);

describe("private-ipv4", () => {
	test("CGNAT 100.64/10 boundaries", () => {
		expect(one("private-ipv4", ip(100, 63, 255, 255))).toEqual([]);
		expect(one("private-ipv4", ip(100, 64, 0, 0))).toEqual([ip(100, 64, 0, 0)]);
		expect(one("private-ipv4", ip(100, 127, 255, 255))).toEqual([ip(100, 127, 255, 255)]);
		expect(one("private-ipv4", ip(100, 128, 0, 0))).toEqual([]);
	});
	test("10/8, 172.16/12 and 192.168/16 boundaries", () => {
		expect(one("private-ipv4", ip(10, 0, 0, 0))).toHaveLength(1);
		expect(one("private-ipv4", ip(10, 255, 255, 255))).toHaveLength(1);
		expect(one("private-ipv4", `${ip(11, 0, 0, 1)} ${ip(9, 255, 255, 255)}`)).toEqual([]);
		expect(one("private-ipv4", `${ip(172, 15, 255, 255)} ${ip(172, 32, 0, 0)}`)).toEqual([]);
		expect(one("private-ipv4", ip(172, 16, 0, 0))).toHaveLength(1);
		expect(one("private-ipv4", ip(172, 31, 255, 255))).toHaveLength(1);
		expect(one("private-ipv4", ip(192, 168, 0, 1))).toHaveLength(1);
		expect(one("private-ipv4", `${ip(192, 167, 255, 255)} ${ip(192, 169, 0, 0)}`)).toEqual([]);
	});
	test("loopback, documentation ranges and invalid octets are not reported", () => {
		expect(one("private-ipv4", "127.0.0.1 192.0.2.10 198.51.100.7 203.0.113.255 0.0.0.0 255.255.255.255")).toEqual([]);
		expect(one("private-ipv4", `${ip(10, 0, 0, 256)} ${ip(192, 168, 300, 1)}`)).toEqual([]);
		expect(isPrivateIPv4([10, 0, 0])).toBe(false);
	});
	test("an address inside a longer token is reported; a longer dotted number is not", () => {
		const addr = ip(192, 168, 7, 9);
		expect(one("private-ipv4", `http://${addr}:8080/x`)).toEqual([addr]);
		expect(one("private-ipv4", `host${addr}abc`)).toEqual([addr]);
		expect(one("private-ipv4", `${addr}/24,`)).toEqual([addr]);
		expect(one("private-ipv4", `1.${addr}`)).toEqual([]);
		expect(one("private-ipv4", `${addr}.5`)).toEqual([]);
		const wide = ip(192, 168, 7, 199);
		expect(one("private-ipv4", `${wide}5`)).toEqual([]);
		expect(one("private-ipv4", `5${wide}`)).toEqual([]);
	});
});

describe("public-ipv4", () => {
	test("globally routable addresses are reported, also inside a longer token", () => {
		expect(one("public-ipv4", ip(8, 8, 8, 8))).toEqual([ip(8, 8, 8, 8)]);
		expect(one("public-ipv4", `host ${ip(11, 0, 0, 1)}.`)).toEqual([ip(11, 0, 0, 1)]);
		expect(one("public-ipv4", ip(203, 0, 114, 1))).toEqual([ip(203, 0, 114, 1)]);
	});
	test("private and CGNAT ranges are not reported", () => {
		expect(one("public-ipv4", `${ip(10, 1, 2, 3)} ${ip(172, 16, 0, 1)} ${ip(172, 31, 255, 255)} ${ip(192, 168, 0, 1)} ${ip(100, 64, 0, 1)}`)).toEqual([]);
	});
	test("loopback, link-local, documentation, benchmark, multicast and reserved ranges are not reported", () => {
		expect(one("public-ipv4", "127.0.0.1 169.254.1.1 0.0.0.0 192.0.2.10 198.51.100.7 203.0.113.255 198.18.0.1 198.19.255.255 224.0.0.1 240.0.0.1 255.255.255.255")).toEqual([]);
	});
	test("invalid octets and malformed input are not reported", () => {
		expect(one("public-ipv4", `${ip(192, 168, 300, 1)} ${ip(10, 0, 0, 256)}`)).toEqual([]);
		expect(isPublicIPv4([8, 8, 8])).toBe(false);
		expect(isPublicIPv4([8, 8, 8, 256])).toBe(false);
	});
});

describe("ipv6", () => {
	const ula = v6("fd12", "3456", "789a", "1", "0", "0", "0", "1");
	const ulaShort = `fd00${":"}${":"}1`;
	const global = v6("2606", "4700", "4700", "0", "0", "0", "0", "1111");
	const globalShort = `2001${":"}4860${":"}${":"}8888`;
	test("unique-local first byte fd and global unicast first three bits 001 are reported, full and compressed", () => {
		expect(one("ipv6", ula)).toEqual([ula]);
		expect(one("ipv6", ulaShort)).toEqual([ulaShort]);
		expect(one("ipv6", global)).toEqual([global]);
		expect(one("ipv6", `ssh [${globalShort}]:22`)).toEqual([globalShort]);
		expect(one("ipv6", `host ${globalShort}.`)).toEqual([globalShort]);
		expect(one("ipv6", `addr=${ulaShort}, next`)).toEqual([ulaShort]);
	});
	test("loopback, unspecified, link-local, multicast, IPv4-mapped and the documentation prefix are not reported", () => {
		const doc = `2001${":"}db8${":"}${":"}1`;
		const docUpper = `2001${":"}DB8${":"}${":"}1`;
		const docFull = v6("2001", "0db8", "0", "0", "0", "0", "0", "1");
		for (const text of [`${":"}${":"}1`, `${":"}${":"}`, `fe80${":"}${":"}1`, `ff02${":"}${":"}1`, `${":"}${":"}ffff${":"}1`, doc, docUpper, docFull, `fc00${":"}${":"}1`, `4000${":"}${":"}1`, `1fff${":"}${":"}1`])
			expect(one("ipv6", text)).toEqual([]);
	});
	test("range edges: 2000 and 3fff start/end are reported, fd00 and fdff are reported, fe00 is not", () => {
		for (const first of ["2000", "3fff", "fd00", "fdff"]) expect(one("ipv6", `${first}${":"}${":"}1`)).toEqual([`${first}${":"}${":"}1`]);
		expect(one("ipv6", `fe00${":"}${":"}1`)).toEqual([]);
	});
	test("seven groups before a trailing :: are candidates (regression: the repetition upper bound dropped them)", () => {
		const sevenUla = `${v6("fd00", "1", "2", "3", "4", "5", "6")}${":"}${":"}`;
		const sevenGlobal = `${v6("2001", "4860", "4860", "0", "0", "0", "8888")}${":"}${":"}`;
		expect(one("ipv6", sevenUla)).toEqual([sevenUla]);
		expect(one("ipv6", sevenGlobal)).toEqual([sevenGlobal]);
		// Eight groups before `::` stay invalid, and a nine-group run still does not parse.
		expect(one("ipv6", `${v6("fd00", "1", "2", "3", "4", "5", "6", "7")}${":"}${":"}`)).toEqual([]);
		expect(one("ipv6", v6("fd00", "1", "2", "3", "4", "5", "6", "7", "8"))).toEqual([]);
	});
	test("code, times, MAC addresses and malformed text are not candidates", () => {
		for (const text of ["std::string", "Foo::bar::baz", "12:34:56", "00:1a:2b:3c:4d:5e", "a:b", "2606:4700:4700::1111::1", v6("2606", "4700", "4700", "0", "0", "0", "1111"), v6("2606", "4700", "4700", "0", "0", "0", "0", "0", "1111"), `x${v6("2606", "4700", "4700", "0", "0", "0", "0", "1111")}`, `${v6("2606", "4700", "4700", "0", "0", "0", "0", "1111")}:`, `${v6("2606", "4700", "4700", "0", "0", "0", "0", "1111")}.5`, `2606${":"}${":"}g`])
			expect(one("ipv6", text)).toEqual([]);
	});
	test("parseIPv6 and isReportableIPv6 handle compression and invalid input", () => {
		expect(parseIPv6(`1${":"}${":"}2`)).toEqual([1, 0, 0, 0, 0, 0, 0, 2]);
		expect(parseIPv6(`${":"}${":"}`)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
		expect(parseIPv6(`1${":"}2`)).toBeUndefined();
		expect(parseIPv6(`12345${":"}${":"}1`)).toBeUndefined();
		expect(isReportableIPv6([0x2606, 0, 0, 0, 0, 0, 0, 1])).toBe(true);
		expect(isReportableIPv6([0x2606, 0, 0, 0])).toBe(false);
	});
	test("the rule is part of scanLine", () => {
		expect(scanLine(`at ${ula} ok`).map((m) => m.rule)).toEqual(["ipv6"]);
	});
});

describe("email", () => {
	test("real-looking addresses are reported, also inside a longer token", () => {
		const addr = at("jane.doe+tag", "corp.test");
		expect(one("email", `mailto:${addr}`)).toEqual([addr]);
		expect(one("email", `<${addr}>,`)).toEqual([addr]);
		expect(one("email", at("x", "sub.mail.co"))).toHaveLength(1);
	});
	test("documentation domains and noreply addresses are allowed", () => {
		for (const allowed of [
			at("someone", "example.com"),
			at("a.b", "example.org"),
			at("ops", "ci.example.invalid"),
			at("noreply", "vendor.tld"),
			at("no-reply", "vendor.tld"),
			at("do-not-reply", "vendor.tld"),
		])
			expect(one("email", allowed)).toEqual([]);
	});
	test("look-alike domains and per-user noreply addresses are reported", () => {
		expect(one("email", at("a", "example.com.evil.test"))).toHaveLength(1);
		expect(one("email", at("a", "notexample.com"))).toHaveLength(1);
		expect(one("email", at("12345+someone", "users.noreply.github.com"))).toHaveLength(1);
		expect(one("email", at("noreply-bot", "vendor.tld"))).toHaveLength(1);
	});
	test("scoped package names and decorators are not addresses", () => {
		expect(one("email", '"@gjc/fleet" @test x@y')).toEqual([]);
	});
});

describe("home paths", () => {
	test("macOS /Users/<account>", () => {
		const p = path("", "Users", "jdoe");
		expect(one("home-path-macos", `cd ${p}/src`)).toEqual([p]);
		expect(one("home-path-macos", `"${p}"`)).toEqual([p]);
		expect(one("home-path-macos", path("", "Users", "<name>", "x"))).toEqual([]);
		expect(one("home-path-macos", path("", "Users", "user", "x"))).toEqual([]);
		expect(one("home-path-macos", path("", "Users", "Shared", "x"))).toEqual([]);
		expect(one("home-path-macos", `https://host.tld${path("", "Users", "jdoe")}`)).toEqual([]);
	});
	test("Linux /home/<account>", () => {
		const p = path("", "home", "jdoe");
		expect(one("home-path-linux", `${p}/.ssh`)).toEqual([p]);
		expect(one("home-path-linux", path("", "home", "user", "x"))).toEqual([]);
		expect(one("home-path-linux", path("", "home", "<user>", "x"))).toEqual([]);
		expect(one("home-path-linux", "/home/")).toEqual([]);
	});
	test("Windows drive:\\Users\\<account> in raw, escaped and forward-slash forms", () => {
		for (const sep of ["\\", "\\\\", "/"]) {
			const p = winPath(sep, "C:", "Users", "jdoe");
			expect(one("home-path-windows", `${p}${sep}AppData`)).toEqual([p]);
		}
		const lower = winPath("\\", "d:", "users", "Alice Example");
		expect(one("home-path-windows", `${lower}\\x`)).toEqual([lower]);
		expect(one("home-path-windows", winPath("\\", "C:", "Users", "<name>", "x"))).toEqual([]);
		expect(one("home-path-windows", winPath("\\", "C:", "Users", "Public", "x"))).toEqual([]);
		expect(one("home-path-windows", "C:\\Program Files\\x")).toEqual([]);
	});
	test("Git-Bash/MSYS /c/Users, WSL /mnt/c/Users and Cygwin /cygdrive/c/Users are reported", () => {
		for (const prefix of [["", "c"], ["", "mnt", "c"], ["", "cygdrive", "D"]]) {
			const p = path(...prefix, "Users", "jdoe");
			expect(one("home-path-windows", `cd ${p}/src`)).toEqual([p]);
			expect(rulesOf(`${p}/src`)).toEqual(["home-path-windows"]);
		}
		const spaced = path("", "c", "Users", "Alice Example");
		expect(one("home-path-windows", `${spaced}/x`)).toEqual([spaced]);
	});
	test("drive-letter POSIX forms: placeholders, non-drive segments and URL paths are not reported", () => {
		expect(one("home-path-windows", path("", "c", "Users", "user", "x"))).toEqual([]);
		expect(one("home-path-windows", path("", "mnt", "c", "Users", "Public", "x"))).toEqual([]);
		expect(one("home-path-windows", path("", "cygdrive", "c", "Users", "Default"))).toEqual([]);
		expect(rulesOf(path("", "mnt", "data", "Users", "jdoe"))).toEqual([]);
		expect(rulesOf(path("", "cygdrive", "cd", "Users", "jdoe"))).toEqual([]);
		expect(rulesOf(`https://host.tld${path("", "c", "Users", "jdoe")}`)).toEqual([]);
		expect(rulesOf("/c/Users/")).toEqual([]);
	});
	test("UNC administrative share \\\\HOST\\c$\\Users\\<account>, raw and escaped", () => {
		for (const sep of ["\\", "\\\\"]) {
			const p = `${sep}${sep}${winPath(sep, "FILESRV", "c$", "Users", "jdoe")}`;
			expect(one("home-path-windows", `${p}${sep}AppData`)).toEqual([p]);
		}
	});
	test("UNC: a non-administrative share and a placeholder account are not reported", () => {
		expect(rulesOf(`\\\\${winPath("\\", "FILESRV", "share", "Users", "jdoe")}`)).toEqual([]);
		expect(rulesOf(`\\\\${winPath("\\", "FILESRV", "c$", "Users", "Public", "x")}`)).toEqual([]);
	});
	test("UNC default Users share \\\\HOST\\Users\\<account>, raw and escaped; a placeholder account is not reported", () => {
		for (const sep of ["\\", "\\\\"]) {
			const p = `${sep}${sep}${winPath(sep, "FILESRV", "Users", "jdoe")}`;
			expect(one("home-path-windows", `${p}${sep}AppData`)).toEqual([p]);
			expect(rulesOf(`${sep}${sep}${winPath(sep, "FILESRV", "Users", "Public", "x")}`)).toEqual([]);
		}
	});
	test("Unicode account names are reported in full on every platform form", () => {
		const hangul = "\u{D64D}\u{AE38}\u{B3D9}";
		const accented = "Jos\u{E9}";
		const win = winPath("\\", "C:", "Users", hangul);
		expect(one("home-path-windows", `${win}\\x`)).toEqual([win]);
		const linux = path("", "home", accented);
		expect(one("home-path-linux", `${linux}/x`)).toEqual([linux]);
		const mac = path("", "Users", `${accented}.M\u{FC}ller`);
		expect(one("home-path-macos", `${mac}/x`)).toEqual([mac]);
		const msys = path("", "c", "Users", hangul);
		expect(one("home-path-windows", msys)).toEqual([msys]);
	});
	test("Unicode: punctuation and symbols are not account names", () => {
		expect(rulesOf(path("", "home", "\u{2014}x"))).toEqual([]);
		expect(rulesOf(winPath("\\", "C:", "Users", "\u{300C}name\u{300D}", "x"))).toEqual([]);
		expect(rulesOf(path("", "Users", "\u{2026}"))).toEqual([]);
	});
	test("/Volumes/<volume> is always reported", () => {
		const p = path("", "Volumes", "Backup Disk");
		expect(one("volumes-path", `${p}/x`)).toEqual([p]);
		expect(one("volumes-path", path("", "Volumes", "x"))).toHaveLength(1);
		expect(one("volumes-path", "/Volumes/")).toEqual([]);
	});
});

describe("snowflake-id", () => {
	test("16 and 21 digits are not identifiers; 17 and 20 are", () => {
		expect(one("snowflake-id", digits(16))).toEqual([]);
		expect(one("snowflake-id", digits(17))).toEqual([digits(17)]);
		expect(one("snowflake-id", digits(20))).toEqual([digits(20)]);
		expect(one("snowflake-id", digits(21))).toEqual([]);
	});
	test("an identifier inside a longer token is reported; a digit run inside a hash is not", () => {
		const id = digits(19);
		expect(one("snowflake-id", `channels/${id}/x`)).toEqual([id]);
		expect(one("snowflake-id", `thread${id}x`)).toEqual([id]);
		expect(one("snowflake-id", `pilot-${id}`)).toEqual([id]);
		expect(one("snowflake-id", `ab${id}cdef0123456789`)).toEqual([]);
	});
});

describe("deny-list", () => {
	test("literal words match case-insensitively anywhere in a line", () => {
		expect(scanLine("ssh Zorblax-MBP.local", ["zorblax"]).map((m) => [m.rule, m.text])).toEqual([["deny-list", "Zorblax"]]);
		expect(rulesOf("nothing here", ["zorblax"])).toEqual([]);
		expect(rulesOf("zorblax zorblax", ["zorblax"])).toEqual(["deny-list", "deny-list"]);
	});
	test("a character whose lower case is longer (U+0130) does not shift the match", () => {
		const line = "\u{130}\u{130}\u{130}\u{130}zorblaxhost/a.txt";
		expect(denyListMatches(line, ["zorblaxhost"])).toEqual([{ rule: "deny-list", index: 4, text: "zorblaxhost" }]);
		expect(denyListMatches("a.b ZORBLAX(1)", ["zorblax(1)", "a.b"]).map((m) => [m.index, m.text])).toEqual([[4, "ZORBLAX(1)"], [0, "a.b"]]);
		expect(denyListMatches("axb", ["a.b"])).toEqual([]);
	});
});

describe("allow-list format", () => {
	test("only exact (file, rule, sha256) triples are accepted", () => {
		const digest = sha256("x");
		expect(parseAllowList(JSON.stringify({ allow: [{ file: "a.md", rule: "email", sha256: digest }] }))).toHaveLength(1);
		for (const bad of [
			{ allow: [{ file: "a.md", rule: "email", text: "x" }] },
			{ allow: [{ file: "a.md", rule: "email", sha256: digest, text: "x" }] },
			{ allow: [{ file: "a.md", rule: "no-such-rule", sha256: digest }] },
			{ allow: [{ file: "a.md", rule: "email", sha256: digest.toUpperCase() }] },
			{ allow: [{ file: "a.md", rule: "email", sha256: digest.slice(1) }] },
			{ allow: [], extra: true },
			[],
		])
			expect(() => parseAllowList(JSON.stringify(bad))).toThrow();
	});
});

describe("CLI", () => {
	const secretIp = ip(100, 101, 102, 103);
	const secretMail = at("jane", "corp.test");
	const secretHome = path("", "Users", "jdoe");
	const secretId = digits(18);
	const secrets = [secretIp, secretMail, secretHome, secretId, "zorblax"];

	test("reports file:line:rule with the value redacted to rule and length; clean tree exits 0", () => {
		const root = tree({
			"docs/a.md": `intro\nnode at ${secretIp} owner ${secretMail}\n`,
			"b.txt": `x\ny\nrepo ${secretHome}/src thread ${secretId}\n`,
			"clean.md": "127.0.0.1 and 192.0.2.1 are fine\n",
		});
		const r = cli(["--dir", root]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`b.txt:3:home-path-macos [redacted home-path-macos len=${secretHome.length}]`,
			`b.txt:3:snowflake-id [redacted snowflake-id len=${secretId.length}]`,
			`docs/a.md:2:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
			`docs/a.md:2:email [redacted email len=${secretMail.length}]`,
		]);
		for (const s of secrets) {
			expect(r.stdout).not.toContain(s);
			expect(r.stderr).not.toContain(s);
		}
		expect(cli(["--dir", tree({ "ok.md": "nothing private\n" })]).code).toBe(0);
	});

	test("the deny-list is read from --deny-list and never echoed", () => {
		const root = tree({ "a.md": "built on ZORBLAX-mini\n" });
		const deny = join(tree({ "words": "# comment\n\nzorblax\r\n" }), "words");
		expect(cli(["--dir", root]).code).toBe(0);
		const r = cli(["--dir", root, "--deny-list", deny]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim()).toBe("a.md:1:deny-list [redacted deny-list len=7]");
		expect((r.stdout + r.stderr).toLowerCase()).not.toContain("zorblax");
		expect(cli(["--dir", root, "--deny-list", join(root, "missing")]).code).toBe(2);
	});

	test("allow-list exempts exact (file, rule, digest) triples only", () => {
		const root = tree({ "a.md": `${secretIp}\n`, "b.md": `${secretIp}\n` });
		const allow = (entries: unknown) => {
			const file = join(tree({ "allow.json": JSON.stringify({ allow: entries }) }), "allow.json");
			return cli(["--dir", root, "--allow-list", file]);
		};
		const exact = allow([{ file: "a.md", rule: "private-ipv4", sha256: sha256(secretIp) }]);
		expect(exact.code).toBe(1);
		expect(exact.stdout.trim()).toBe(`b.md:1:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`);
		expect(allow([{ file: "a.md", rule: "email", sha256: sha256(secretIp) }]).stdout).toContain("a.md:1:");
		expect(allow([{ file: "a.md", rule: "private-ipv4", sha256: sha256(`${secretIp} `) }]).stdout).toContain("a.md:1:");
		const both = allow(["a.md", "b.md"].map((file) => ({ file, rule: "private-ipv4", sha256: sha256(secretIp) })));
		expect(both.code).toBe(0);
		const plain = allow([{ file: "a.md", rule: "private-ipv4", text: secretIp }]);
		expect(plain.code).toBe(2);
		expect(plain.stdout + plain.stderr).not.toContain(secretIp);
	});

	test("the default allow-list is <root>/scripts/privacy-allow.json", () => {
		const root = tree({
			"a.md": `${secretMail}\n`,
			"scripts/privacy-allow.json": JSON.stringify({ allow: [{ file: "a.md", rule: "email", sha256: sha256(secretMail) }] }),
		});
		expect(cli(["--dir", root]).code).toBe(0);
	});

	test("--show-digest prints the digest an allow-list entry needs, still not the value", () => {
		const root = tree({ "a.md": `${secretMail}\n` });
		const r = cli(["--dir", root, "--show-digest"]);
		expect(r.stdout).toContain(`sha256=${sha256(secretMail)}`);
		expect(r.stdout).not.toContain(secretMail);
	});

	test("a file with a NUL byte is an unscanned-binary-file finding, not skipped; CRLF lines are numbered correctly", () => {
		const blob = new Uint8Array([...new TextEncoder().encode(secretIp), 0, 1, 2]);
		const root = tree({
			"blob.bin": blob,
			"crlf.md": `one\r\ntwo\r\nthree ${secretIp}\r\nfour ${secretId}\r\n`,
		});
		const r = cli(["--dir", root]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`blob.bin:0:unscanned-binary-file [not scanned: binary, ${blob.length} bytes]`,
			`crlf.md:3:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
			`crlf.md:4:snowflake-id [redacted snowflake-id len=${secretId.length}]`,
		]);
		expect(cli(["--dir", tree({ "only.bin": blob })]).code).toBe(1);
	});

	test("a binary file is exempt only by an allow entry with the sha256 of the whole file", () => {
		const blob = new Uint8Array([...new TextEncoder().encode(secretIp), 0, 1, 2]);
		const wholeFile = createHash("sha256").update(blob).digest("hex");
		const root = tree({ "blob.bin": blob });
		const allow = (entries: unknown) => {
			const file = join(tree({ "allow.json": JSON.stringify({ allow: entries }) }), "allow.json");
			return cli(["--dir", root, "--allow-list", file]);
		};
		expect(allow([{ file: "blob.bin", rule: "unscanned-binary-file", sha256: wholeFile }]).code).toBe(0);
		const shown = cli(["--dir", root, "--show-digest"]);
		expect(shown.stdout).toContain(`sha256=${wholeFile}`);
		for (const wrong of [
			{ file: "blob.bin", rule: "unscanned-binary-file", sha256: sha256(secretIp) },
			{ file: "blob.bin", rule: "private-ipv4", sha256: sha256(secretIp) },
			{ file: "other.bin", rule: "unscanned-binary-file", sha256: wholeFile },
		]) {
			const r = allow([wrong]);
			expect(r.code).toBe(1);
			expect(r.stdout).toContain("blob.bin:0:unscanned-binary-file");
		}
	});

	test("UTF-16LE and UTF-16BE files with a byte-order mark are decoded and scanned", () => {
		const le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
		const be = (text: string) => {
			const body = Buffer.from(text, "utf16le");
			for (let i = 0; i < body.length; i += 2) [body[i], body[i + 1]] = [body[i + 1]!, body[i]!];
			return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
		};
		const root = tree({
			"ps-out.txt": le(`intro\r\nnode ${secretIp} in ${secretHome}\r\n`),
			"be.txt": be(`thread ${secretId}\n`),
			"clean16.txt": le("nothing private\r\n"),
		});
		const r = cli(["--dir", root]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`be.txt:1:snowflake-id [redacted snowflake-id len=${secretId.length}]`,
			`ps-out.txt:2:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
			`ps-out.txt:2:home-path-macos [redacted home-path-macos len=${secretHome.length}]`,
		]);
		for (const s of secrets) expect(r.stdout + r.stderr).not.toContain(s);
		expect(cli(["--dir", tree({ "clean16.txt": le("nothing private\r\n") })]).code).toBe(0);
		// A byte-order mark followed by an odd number of bytes is not valid UTF-16: binary finding.
		const odd = cli(["--dir", tree({ "odd.txt": Buffer.concat([le("abc"), Buffer.from([0x41])]) })]);
		expect(odd.code).toBe(1);
		expect(odd.stdout).toContain("odd.txt:0:unscanned-binary-file");
	});

	test("file and directory names are scanned as line 0, also against the deny-list, and redacted", () => {
		const dirName = `zorblax-${secretIp}`;
		const root = tree({ [`fixtures/${dirName}/a.txt`]: "ok\n", [`ids/${secretId}.md`]: `${secretMail}\n` });
		const deny = join(tree({ words: "zorblax\n" }), "words");
		const r = cli(["--dir", root, "--deny-list", deny]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			"fixtures/[redacted]-[redacted]/a.txt:0:deny-list [redacted deny-list len=7]",
			`fixtures/[redacted]-[redacted]/a.txt:0:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
			`ids/[redacted].md:0:snowflake-id [redacted snowflake-id len=${secretId.length}]`,
			`ids/[redacted].md:1:email [redacted email len=${secretMail.length}]`,
		]);
		for (const s of [...secrets, "zorblax"]) expect((r.stdout + r.stderr).toLowerCase()).not.toContain(s.toLowerCase());
		expect(cli(["--dir", tree({ [`fixtures/${dirName}/a.txt`]: "ok\n" })]).stdout.trim()).toBe(
			`fixtures/zorblax-[redacted]/a.txt:0:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
		);
	});

	test("files over 5 MB are a finding, not silently skipped; exactly 5 MB is scanned", () => {
		const big = Buffer.alloc(MAX_SCAN_BYTES + 1, 0x61);
		// One 5 MB line full of '@' also proves the e-mail rule does not backtrack quadratically.
		const limit = Buffer.alloc(MAX_SCAN_BYTES, "a@");
		limit.write(` ${secretIp}\n`, MAX_SCAN_BYTES - 40);
		const r = cli(["--dir", tree({ "big.log": big, "limit.log": limit })]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`big.log:0:unscanned-large-file [not scanned: ${MAX_SCAN_BYTES + 1} bytes > ${MAX_SCAN_BYTES}]`,
			`limit.log:1:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`,
		]);
	}, 60_000);

	test(".git is skipped in --dir mode", () => {
		expect(cli(["--dir", tree({ ".git/config": `${secretMail}\n`, "a.md": "ok\n" })]).code).toBe(0);
	});

	test("default mode scans only the tracked files of the repository containing cwd", () => {
		const root = tree({ "tracked.md": `${secretIp}\n`, "sub/clean.md": "ok\n", "untracked.md": `${secretMail}\n` });
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
		for (const args of [["init", "-q"], ["add", "tracked.md", "sub/clean.md"]]) {
			const g = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
			expect(g.exitCode).toBe(0);
		}
		const r = cli([], join(root, "sub"));
		expect(r.code).toBe(1);
		expect(r.stdout.trim()).toBe(`tracked.md:1:private-ipv4 [redacted private-ipv4 len=${secretIp.length}]`);
	});

	test("default mode: a tracked file missing from the working tree and a tracked symlink are findings", () => {
		const root = tree({ "gone.md": "ok\n", "keep.md": "ok\n" });
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
		const withLink = process.platform !== "win32";
		if (withLink) symlinkSync(secretHome, join(root, "link"));
		for (const args of [["init", "-q"], ["add", "-A"]]) {
			const g = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
			expect(g.exitCode).toBe(0);
		}
		rmSync(join(root, "gone.md"));
		const r = cli([], root);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			"gone.md:0:unscanned-not-regular [not scanned: not a regular file]",
			...(withLink ? ["link:0:unscanned-not-regular [not scanned: not a regular file]"] : []),
		]);
		expect(r.stdout + r.stderr).not.toContain(secretHome);
	});

	test.skipIf(process.platform === "win32")("default mode: a tracked file under a parent directory replaced by a symlink is not followed", () => {
		const outside = tree({ "a.md": `${secretIp}\n`, "deep/b.md": `${secretMail}\n` });
		const root = tree({ "sub/a.md": "ok\n", "x/y/deep/b.md": "ok\n", "keep.md": "ok\n" });
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		for (const args of [["init", "-q"], ["add", "-A"]]) {
			const g = Bun.spawnSync(["git", ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
			expect(g.exitCode).toBe(0);
		}
		// A leaf parent and a middle parent become symlinks to a tree outside the repository.
		rmSync(join(root, "sub"), { recursive: true });
		symlinkSync(outside, join(root, "sub"));
		rmSync(join(root, "x", "y"), { recursive: true });
		symlinkSync(outside, join(root, "x", "y"));
		const r = cli([], root);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			"sub/a.md:0:unscanned-not-regular [not scanned: not a regular file]",
			"x/y/deep/b.md:0:unscanned-not-regular [not scanned: not a regular file]",
		]);
		expect(r.stdout + r.stderr).not.toContain(secretIp);
		expect(parentsInsideRoot(root, "keep.md")).toBe(true);
		for (const f of ["sub/a.md", "x/y/deep/b.md", "../a.md", "x/../keep.md", "/keep.md", "keep.md/z"]) expect(parentsInsideRoot(root, f)).toBe(false);
		expect(scanFiles(root, ["../a.md"]).findings.map((f) => f.rule)).toEqual(["unscanned-not-regular"]);
	});

	test("default mode: a git error is printed redacted, never the raw path, deny word or private value", () => {
		const broken = tree({});
		writeFileSync(join(broken, ".git"), `gitdir: ${join(broken, `zorblax-${secretIp}`, "missing")}\n`);
		const deny = join(tree({ words: "zorblax\n" }), "words");
		const r = cli(["--deny-list", deny], broken);
		expect(r.code).toBe(2);
		// Only the command and its exit status: no stderr text, not even redacted.
		expect(r.stderr).toMatch(/^privacy-scan: git rev-parse failed \(exit \d+\)$/m);
		expect(r.stderr).not.toContain("[path]");
		expect(r.stderr).not.toContain("fatal");
		for (const s of [broken, secretIp, "zorblax", tmpdir()]) expect((r.stdout + r.stderr).toLowerCase()).not.toContain(s.toLowerCase());
	});

	test("redactText masks absolute paths, URL credentials, tokens, rule matches and deny words", () => {
		const token = ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("_");
		const lines = [
			`fatal: not a git repository: ${path("", "private", "tmp", "zorblax", ".git")}`,
			`fatal: unable to access 'https://bob:${token}@github.test/o/r.git/'`,
			`remote: Authorization: Bearer ${token}`,
			`error: '${winPath("\\", "C:", "Users", "jdoe", "repo")}' owner ${secretMail} at ${secretIp}`,
			"error: pathspec 'origin/main' did not match",
		];
		const out = redactText(lines.join("\n"), ["zorblax"]);
		for (const s of ["zorblax", "bob", token, "jdoe", secretMail, secretIp, "private"]) expect(out).not.toContain(s);
		expect(out.split("\n")).toEqual([
			"fatal: not a git repository: [path]",
			"fatal: unable to access 'https://[redacted]@github.test/o/r.git/'",
			"remote: Authorization: Bearer [redacted]",
			"error: '[path]' owner [redacted] at [redacted]",
			"error: pathspec 'origin/main' did not match",
		]);
	});

	test("gitFailure carries only the subcommand and the exit status", () => {
		expect(gitFailure("ls-files", 128).message).toBe("git ls-files failed (exit 128)");
		expect(gitFailure("cat-file", null).message).toBe("git cat-file failed (exit signal)");
	});

	test("a deny word after a U+0130 in a path is redacted in full on line 0", () => {
		const dir = "\u{130}\u{130}\u{130}\u{130}zorblaxhost";
		const deny = join(tree({ words: "zorblaxhost\n" }), "words");
		const r = cli(["--dir", tree({ [`${dir}/a.txt`]: "ok\n" }), "--deny-list", deny]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim()).toBe("\u{130}\u{130}\u{130}\u{130}[redacted]/a.txt:0:deny-list [redacted deny-list len=11]");
		expect((r.stdout + r.stderr).toLowerCase()).not.toContain("zorb");
	});

	test("a file that is not valid UTF-8 (Windows-1252, cp949) is an unscanned-undecodable finding, never decoded lossily", () => {
		// "C:\Users\<name>\x" with the name written in a legacy code page: Windows-1252 0xD6 and cp949.
		const legacy = (name: number[]) => Buffer.concat([Buffer.from("C:\\Users\\"), Buffer.from(name), Buffer.from("\\x\r\n")]);
		const latin = legacy([0xd6, 0x6c, 0x61, 0x66]);
		const korean = legacy([0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf]);
		const root = tree({ "se-log.txt": latin, "ko-log.txt": korean, "utf8.txt": `${winPath("\\", "C:", "Users", "\u{D6}laf", "x")}\n` });
		const r = cli(["--dir", root]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`ko-log.txt:0:unscanned-undecodable [not scanned: not valid UTF-8, ${korean.length} bytes]`,
			`se-log.txt:0:unscanned-undecodable [not scanned: not valid UTF-8, ${latin.length} bytes]`,
			"utf8.txt:1:home-path-windows [redacted home-path-windows len=13]",
		]);
		expect(r.stderr).toContain("1 scanned");
	});

	test("an undecodable file is exempt only by an allow entry with the sha256 of the whole file", () => {
		const latin = Buffer.from([0x4a, 0xfc, 0x72, 0x67, 0x65, 0x6e, 0x0a]);
		const wholeFile = createHash("sha256").update(latin).digest("hex");
		const root = tree({ "names.txt": latin });
		const allow = (entries: unknown) => cli(["--dir", root, "--allow-list", join(tree({ "allow.json": JSON.stringify({ allow: entries }) }), "allow.json")]);
		expect(allow([{ file: "names.txt", rule: "unscanned-undecodable", sha256: wholeFile }]).code).toBe(0);
		expect(cli(["--dir", root, "--show-digest"]).stdout).toContain(`sha256=${wholeFile}`);
		for (const wrong of [
			{ file: "names.txt", rule: "unscanned-binary-file", sha256: wholeFile },
			{ file: "names.txt", rule: "unscanned-undecodable", sha256: sha256("J\u{FC}rgen\n") },
		]) {
			const r = allow([wrong]);
			expect(r.code).toBe(1);
			expect(r.stdout.trim()).toBe(`names.txt:0:unscanned-undecodable [not scanned: not valid UTF-8, ${latin.length} bytes]`);
		}
	});

	test("UTF-32 byte-order marks and a decoded U+0000 in UTF-16 are unscanned-binary-file findings", () => {
		const text = `node ${secretIp} in ${secretHome}\n`;
		const le32 = Buffer.alloc(4 + text.length * 4);
		const be32 = Buffer.alloc(4 + text.length * 4);
		le32.writeUInt32LE(0xfeff, 0);
		be32.writeUInt32BE(0xfeff, 0);
		for (let i = 0; i < text.length; i++) {
			le32.writeUInt32LE(text.charCodeAt(i), 4 + i * 4);
			be32.writeUInt32BE(text.charCodeAt(i), 4 + i * 4);
		}
		const nul16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`a\u0000${secretIp}\n`, "utf16le")]);
		const r = cli(["--dir", tree({ "le32.txt": le32, "be32.txt": be32, "nul16.txt": nul16 })]);
		expect(r.code).toBe(1);
		expect(r.stdout.trim().split("\n")).toEqual([
			`be32.txt:0:unscanned-binary-file [not scanned: binary, ${be32.length} bytes]`,
			`le32.txt:0:unscanned-binary-file [not scanned: binary, ${le32.length} bytes]`,
			`nul16.txt:0:unscanned-binary-file [not scanned: binary, ${nul16.length} bytes]`,
		]);
		expect(r.stderr).toContain("0 scanned");
	});

	test("--deny-list or --allow-list naming a directory is a configuration error (exit 2), not an uncaught error", () => {
		const root = tree({ "a.md": "ok\n" });
		const dir = tree({ "x.txt": "" });
		const deny = cli(["--dir", root, "--deny-list", dir]);
		expect([deny.code, deny.stderr.trim()]).toEqual([2, "privacy-scan: deny-list is not a regular file"]);
		const allow = cli(["--dir", root, "--allow-list", dir]);
		expect([allow.code, allow.stderr.trim()]).toEqual([2, "privacy-scan: allow-list is not a regular file"]);
	});

	test("usage errors exit 2", () => {
		expect(cli(["--bogus"]).code).toBe(2);
		expect(cli(["--dir"]).code).toBe(2);
		expect(cli(["--dir", join(tree({}), "missing")]).code).toBe(2);
	});

	test("walkDirectory(dir, false) walks .git directories at any depth, as the export's scan of --out does", () => {
		const root = tree({ ".git/config": `${secretIp}\n`, "sub/.git/notes.md": `${secretMail}\n`, "a.md": "ok\n" });
		expect(walkDirectory(root)).toEqual(["a.md"]);
		const all = walkDirectory(root, false);
		expect(all).toEqual([".git/config", "a.md", "sub/.git/notes.md"]);
		expect(scanFiles(root, all).findings.map((f) => `${f.file}:${f.rule}`)).toEqual([".git/config:private-ipv4", "sub/.git/notes.md:email"]);
	});

	// The UNC rule once retried at every position of a backslash run (quadratic: 128 KiB took 10 s).
	test("a 1 MiB line of backslashes that matches nothing is scanned in linear time", () => {
		const run = Buffer.alloc(1024 * 1024, "\\");
		const unc = `\\\\${winPath("\\", "HOST", "Users", "jdoe")}`;
		const root = tree({ "run.txt": Buffer.concat([run, Buffer.from(`\n${unc}\n`)]) });
		const started = performance.now();
		const r = Bun.spawnSync([process.execPath, SCRIPT, "--dir", root], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
		const elapsed = performance.now() - started;
		expect(r.exitCode).toBe(1);
		expect(r.stdout.toString().trim()).toBe(`run.txt:2:home-path-windows [redacted home-path-windows len=${unc.length}]`);
		expect(elapsed).toBeLessThan(20_000);
	}, 60_000);

	// Elevated Windows tokens (this host, GitHub's windows-latest) hold SeBackupPrivilege, so no
	// permission can make a file unreadable there; root ignores mode 000 on posix.
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a file that cannot be read exits 2 with only the errno code, no stack trace or path",
		() => {
			const root = tree({ "a.md": "ok\n", "locked.md": "x\n" });
			chmodSync(join(root, "locked.md"), 0o000);
			try {
				const r = cli(["--dir", root]);
				expect(r.code).toBe(2);
				expect(r.stderr.trim()).toBe("privacy-scan: cannot read a file to scan (EACCES)");
				expect(r.stdout).toBe("");
			} finally {
				chmodSync(join(root, "locked.md"), 0o644);
			}
		},
	);
});

describe.skipIf(process.platform === "win32")("a path swapped between the check and the open (TOCTOU)", () => {
	const leak = at("jane", "corp.test");
	const setup = () => {
		const outside = tree({ "d/a.md": `${leak}\n` });
		const root = tree({ "d/a.md": `${"x".repeat(200)}\n` });
		return { outside, root, dir: join(root, "d"), keep: join(root, "d.orig"), leaf: join(root, "d", "a.md") };
	};
	const rules = (r: { findings: { rule: string }[] }) => r.findings.map((f) => f.rule);

	test("control: without a swap the file is scanned normally", () => {
		const { root } = setup();
		const r = scanFiles(root, ["d/a.md"], {}, { beforeOpen: () => {}, afterOpen: () => {} });
		expect(r.findings).toEqual([]);
		expect(r.scanned).toBe(1);
	});

	test("a parent directory replaced by a symlink right before the open is not followed", () => {
		const { outside, dir, keep, root } = setup();
		const r = scanFiles(root, ["d/a.md"], {}, { beforeOpen: () => { renameSync(dir, keep); symlinkSync(join(outside, "d"), dir); } });
		expect(rules(r)).toEqual(["unscanned-not-regular"]);
		expect(r.scanned).toBe(0);
	});

	test("a parent swapped before the open and restored right after it: the opened file is still refused", () => {
		const { outside, dir, keep, root } = setup();
		const r = scanFiles(root, ["d/a.md"], {}, {
			beforeOpen: () => { renameSync(dir, keep); symlinkSync(join(outside, "d"), dir); },
			afterOpen: () => { unlinkSync(dir); renameSync(keep, dir); },
		});
		expect(rules(r)).toEqual(["unscanned-not-regular"]);
		expect(r.scanned).toBe(0);
	});

	test("the leaf replaced by a symlink right before the open is not followed", () => {
		const { outside, leaf, root } = setup();
		const r = scanFiles(root, ["d/a.md"], {}, { beforeOpen: () => { rmSync(leaf); symlinkSync(join(outside, "d", "a.md"), leaf); } });
		expect(rules(r)).toEqual(["unscanned-not-regular"]);
		expect(r.scanned).toBe(0);
	});
});
