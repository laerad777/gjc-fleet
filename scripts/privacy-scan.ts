// Privacy gate for the public export.
//
// Scans a tree for operator-private material and reports every finding as
//   <file>:<line>:<rule> [redacted <rule> len=<n>]
// Line 0 is the file itself: a match in its relative path, or a file that could not be scanned.
// UTF-16 files with a byte-order mark are decoded and scanned. A UTF-32 byte-order mark, a NUL byte
// (also a decoded U+0000) or an invalid UTF-16 sequence is an unscanned-binary-file finding; a file
// that is not valid UTF-8 is an unscanned-undecodable finding. Both are exemptible only by an allow
// entry whose sha256 is the digest of the whole file. Files over 5 MB and entries that are not regular files are always findings.
// The matched text itself is never printed: only its rule name and length (and, with the
// explicit --show-digest flag, its SHA-256 so an operator can write an allow-list entry).
//
// Usage:
//   bun scripts/privacy-scan.ts                       scan the tracked files (`git ls-files`)
//   bun scripts/privacy-scan.ts --dir PATH            scan every file under PATH (.git skipped)
//   options: --deny-list FILE   literal words, one per line ('#' comments and blank lines ignored)
//            --allow-list FILE  default: <root>/scripts/privacy-allow.json when it exists
//            --show-digest      append sha256 of each matched text (opt-in: short values are guessable)
// Exit status: 0 no finding, 1 at least one finding, 2 usage or configuration error.
// A file is read only through the descriptor that was actually opened (O_NOFOLLOW, non-blocking):
// after the open, fstat() of that descriptor must be a regular file, every parent between it and the
// root must still be a real directory, and the path must still name the same file (device and inode)
// and resolve inside the root; otherwise it is an unscanned-not-regular finding, so a symlink swapped
// in between the check and the open is never followed. A failing git command is reported only as its
// subcommand and exit status: its stderr is never read into a message.
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnGitSync } from "../src/spawn";

export const MAX_SCAN_BYTES = 5 * 1024 * 1024;
export const LARGE_FILE_RULE = "unscanned-large-file";
export const DENY_LIST_RULE = "deny-list";
export const BINARY_FILE_RULE = "unscanned-binary-file";
export const UNDECODABLE_RULE = "unscanned-undecodable";
export const NOT_REGULAR_RULE = "unscanned-not-regular";

export interface Match {
	rule: string;
	index: number;
	text: string;
}

export interface Finding {
	file: string;
	line: number;
	rule: string;
	length: number;
	sha256: string;
}

export interface AllowEntry {
	file: string;
	rule: string;
	sha256: string;
}

export interface ScanOptions {
	denyWords?: readonly string[];
	allow?: readonly AllowEntry[];
}

/** Test seam: called right before and right after a scanned file is opened (no effect otherwise). */
export interface ScanHooks {
	beforeOpen?(path: string): void;
	afterOpen?(path: string): void;
}

export interface ScanReport {
	findings: Finding[];
	scanned: number;
}

export class ConfigError extends Error {}

export const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
export const sha256Bytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Placeholder account names that are not private (documentation and CI runner homes). */
const PLACEHOLDER_NAMES = new Set([
	"user",
	"username",
	"name",
	"you",
	"yourname",
	"me",
	"someone",
	"example",
	"runner",
	"runneradmin",
	"shared",
	"public",
	"default",
]);
const isPlaceholderName = (name: string): boolean => PLACEHOLDER_NAMES.has(name.toLowerCase());

// ---------------------------------------------------------------------------------------------
// Rules. Each rule is a pure function line -> matches so it can be unit-tested on its own.

// Not preceded by a digit or by "<digit>." and not followed by a digit or ".<digit>": a longer
// dotted run (a.b.c.d.e, version strings) is not an address. Letters may touch it (host10.x...).
const IPV4 = /(?<![0-9]|[0-9]\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![0-9]|\.[0-9])/g;

/** True for 10/8, 172.16/12, 192.168/16 and 100.64/10 (CGNAT, used by overlay VPNs). */
export function isPrivateIPv4(octets: readonly number[]): boolean {
	if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
	const [a, b] = octets as [number, number, number, number];
	if (a === 10) return true;
	if (a === 172) return b >= 16 && b <= 31;
	if (a === 192) return b === 168;
	if (a === 100) return b >= 64 && b <= 127;
	return false;
}

/**
 * True for a globally routable (public) address: outside the private ranges above and every
 * non-public special range — this-network 0/8, loopback 127/8, link-local 169.254/16, the
 * documentation ranges 192.0.2/24, 198.51.100/24 and 203.0.113/24, benchmark 198.18/15, and
 * multicast/reserved 224/4+.
 */
export function isPublicIPv4(octets: readonly number[]): boolean {
	if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;
	if (isPrivateIPv4(octets)) return false;
	const [a, b, c] = octets as [number, number, number, number];
	if (a === 0 || a === 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 192 && b === 0 && c === 2) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a === 198 && b === 51 && c === 100) return false;
	if (a === 203 && b === 0 && c === 113) return false;
	if (a >= 224) return false;
	return true;
}

function privateIPv4(line: string): Match[] {
	const out: Match[] = [];
	for (const m of line.matchAll(IPV4)) {
		if (isPrivateIPv4(m[0].split(".").map(Number))) out.push({ rule: "private-ipv4", index: m.index, text: m[0] });
	}
	return out;
}

function publicIPv4(line: string): Match[] {
	const out: Match[] = [];
	for (const m of line.matchAll(IPV4)) {
		if (isPublicIPv4(m[0].split(".").map(Number))) out.push({ rule: "public-ipv4", index: m.index, text: m[0] });
	}
	return out;
}

// Anchored on each '@' with bounded local part (64) and domain (255) windows, so a long line
// (minified file, base64 blob) costs linear time rather than quadratic backtracking.
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/;
const ALLOWED_EMAIL_DOMAINS = ["example.com", "example.org", "example.net", "example.invalid"];
const NOREPLY_LOCAL = /^(?:no-?reply|do-?not-?reply)$/i;

/**
 * Allowed: documentation domains (and their subdomains) and role noreply local parts such as
 * noreply@vendor.tld. GitHub per-user noreply addresses embed the account name and are flagged.
 */
export function isAllowedEmail(address: string): boolean {
	const at = address.lastIndexOf("@");
	const local = address.slice(0, at);
	const domain = address.slice(at + 1).toLowerCase();
	if (ALLOWED_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
	return NOREPLY_LOCAL.test(local);
}

function email(line: string): Match[] {
	const out: Match[] = [];
	for (let at = line.indexOf("@"); at !== -1; at = line.indexOf("@", at + 1)) {
		let start = at;
		while (start > 0 && at - start < 64 && LOCAL_CHAR.test(line[start - 1]!)) start--;
		while (start < at && /[._%+-]/.test(line[start]!)) start++;
		if (start === at) continue;
		const domain = DOMAIN.exec(line.slice(at + 1, at + 256));
		if (!domain) continue;
		const text = line.slice(start, at + 1 + domain[0].length);
		if (!isAllowedEmail(text)) out.push({ rule: "email", index: start, text });
	}
	return out;
}

// Account names may contain any Unicode letter or digit.
const NAME = "[\\p{L}\\p{N}._-]+";
const HOME_MACOS = new RegExp(`(?<![A-Za-z0-9_.-])/Users/(${NAME})`, "gu");
const HOME_LINUX = new RegExp(`(?<![A-Za-z0-9_.-])/home/(${NAME})`, "gu");
const VOLUMES = new RegExp(`(?<![A-Za-z0-9_.-])/Volumes/(${NAME}(?: ${NAME})*)`, "gu");
// Drive letter, any run of separators (\, \\ as written in JSON/TS strings, or /), Users, name.
const HOME_WINDOWS = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:(?:\\\\|/)+Users(?:\\\\|/)+(${NAME}(?: ${NAME})*)`, "giu");
// The same home as printed by Git-Bash/MSYS (/c/Users), WSL (/mnt/c/Users) and Cygwin (/cygdrive/c/Users).
const HOME_WINDOWS_POSIX = new RegExp(`(?<![A-Za-z0-9_.-])/(?:mnt/|cygdrive/)?[A-Za-z]/Users/(${NAME}(?: ${NAME})*)`, "giu");
// UNC administrative share \\HOST\c$\Users\<name> and the default share \\HOST\Users\<name>
// (also with doubled backslashes as escaped in strings). A match starts only at the first
// backslash of a run, so a long run is consumed once (linear time), never retried at every position.
const HOME_WINDOWS_UNC = new RegExp(String.raw`(?<!\\)\\{2,}[^\\/\s]+\\+(?:[A-Za-z]\$\\+)?Users\\+(${NAME}(?: ${NAME})*)`, "giu");

function pathRule(rule: string, res: readonly RegExp[], allowPlaceholder: boolean) {
	return (line: string): Match[] => {
		const out: Match[] = [];
		for (const m of res.flatMap((re) => [...line.matchAll(re)])) {
			const name = m[1]!.replace(/[.]+$/, "");
			if (name === "" || (allowPlaceholder && isPlaceholderName(name))) continue;
			out.push({ rule, index: m.index, text: m[0].slice(0, m[0].length - (m[1]!.length - name.length)) });
		}
		return out;
	};
}

const SNOWFLAKE = /(?<![0-9])[0-9]{17,20}(?![0-9])/g;

function snowflake(line: string): Match[] {
	const out: Match[] = [];
	for (const m of line.matchAll(SNOWFLAKE)) {
		// A digit run inside a long hexadecimal token (hash, object id) is not an identifier.
		let start = m.index;
		let end = m.index + m[0].length;
		while (start > 0 && m.index - start < 64 && /[0-9a-fA-F]/.test(line[start - 1]!)) start--;
		while (end < line.length && end - m.index < 84 && /[0-9a-fA-F]/.test(line[end]!)) end++;
		if (end - start >= 32 && /[a-fA-F]/.test(line.slice(start, end))) continue;
		out.push({ rule: "snowflake-id", index: m.index, text: m[0] });
	}
	return out;
}

// IPv6: a candidate is a run of hex groups and colons that no letter, digit or colon touches (so
// `std::string`, `Foo::bar` and times are never candidates). It must parse as a full 8-group address or
// as a single `::` compression. Reported: unique-local first byte fd and global unicast first three bits 001, except the
// documentation prefix 2001:0db8 /32. Loopback, unspecified, link-local (fe80::/10), multicast, IPv4-mapped
// and everything else outside those two ranges are not reported. The repetition allows 8 groups:
// an address with seven groups before a trailing `::` needs the eighth (empty) group for the second colon.
const IPV6 = /(?<![0-9A-Za-z:])(?:[0-9A-Fa-f]{0,4}:){2,8}[0-9A-Fa-f]{0,4}(?![0-9A-Za-z:]|\.[0-9])/g;

/** Parses a textual IPv6 address into 8 numeric groups, or undefined when it is not a valid address. */
export function parseIPv6(text: string): number[] | undefined {
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const part = (value: string): string[] | undefined => {
		if (value === "") return [];
		const groups = value.split(":");
		return groups.every((g) => /^[0-9A-Fa-f]{1,4}$/.test(g)) ? groups : undefined;
	};
	const left = part(halves[0]!);
	const right = halves.length === 2 ? part(halves[1]!) : [];
	if (left === undefined || right === undefined) return undefined;
	let groups: string[];
	if (halves.length === 1) {
		if (left.length !== 8) return undefined;
		groups = left;
	} else {
		const missing = 8 - left.length - right.length;
		if (missing < 1) return undefined;
		groups = [...left, ...Array<string>(missing).fill("0"), ...right];
	}
	return groups.map((g) => parseInt(g, 16));
}

/** True for first byte fd and first three bits 001, excluding the documentation range 2001:0db8 /32. */
export function isReportableIPv6(groups: readonly number[]): boolean {
	if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return false;
	const first = groups[0]!;
	if ((first & 0xff00) === 0xfd00) return true;
	if (first >= 0x2000 && first <= 0x3fff) return !(first === 0x2001 && groups[1] === 0x0db8);
	return false;
}

function ipv6(line: string): Match[] {
	const out: Match[] = [];
	for (const m of line.matchAll(IPV6)) {
		const groups = parseIPv6(m[0]);
		if (groups !== undefined && isReportableIPv6(groups)) out.push({ rule: "ipv6", index: m.index, text: m[0] });
	}
	return out;
}

export const RULES: Readonly<Record<string, (line: string) => Match[]>> = {
	"private-ipv4": privateIPv4,
	"public-ipv4": publicIPv4,
	ipv6,
	email,
	"home-path-macos": pathRule("home-path-macos", [HOME_MACOS], true),
	"home-path-linux": pathRule("home-path-linux", [HOME_LINUX], true),
	"home-path-windows": pathRule("home-path-windows", [HOME_WINDOWS, HOME_WINDOWS_POSIX, HOME_WINDOWS_UNC], true),
	"volumes-path": pathRule("volumes-path", [VOLUMES], false),
	"snowflake-id": snowflake,
};

// Matched case-insensitively on the original line, so indices never drift when lower-casing would
// change the length of a character (U+0130 lower-cases to two code units).
export function denyListMatches(line: string, words: readonly string[]): Match[] {
	const out: Match[] = [];
	for (const word of words) {
		const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		for (const m of line.matchAll(re)) out.push({ rule: DENY_LIST_RULE, index: m.index, text: m[0] });
	}
	return out;
}

/** Every match of every rule (and the deny-list) on one line, in column order. */
export function scanLine(line: string, denyWords: readonly string[] = []): Match[] {
	const out: Match[] = [];
	for (const rule of Object.values(RULES)) out.push(...rule(line));
	out.push(...denyListMatches(line, denyWords));
	return out.sort((a, b) => a.index - b.index || a.rule.localeCompare(b.rule));
}

// ---------------------------------------------------------------------------------------------
// Configuration files.

export function parseDenyList(text: string): string[] {
	const words = new Set<string>();
	for (const raw of text.split(/\r?\n/)) {
		const word = raw.trim();
		if (word !== "" && !word.startsWith("#")) words.add(word);
	}
	return [...words];
}

export function parseAllowList(text: string): AllowEntry[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ConfigError("allow-list is not valid JSON");
	}
	const entries = (data as { allow?: unknown })?.allow;
	if (typeof data !== "object" || data === null || Object.keys(data).some((k) => k !== "allow") || !Array.isArray(entries))
		throw new ConfigError('allow-list must be {"allow": [{"file", "rule", "sha256"}]}');
	return entries.map((entry, i) => {
		const keys = entry && typeof entry === "object" ? Object.keys(entry).sort() : [];
		if (keys.join(",") !== "file,rule,sha256")
			throw new ConfigError(`allow-list entry ${i} must have exactly the keys file, rule, sha256 (never plain text)`);
		const { file, rule, sha256: digest } = entry as AllowEntry;
		if (typeof file !== "string" || file === "" || file.includes("\\") || typeof rule !== "string" || !(rule in RULES || rule === DENY_LIST_RULE || rule === BINARY_FILE_RULE || rule === UNDECODABLE_RULE))
			throw new ConfigError(`allow-list entry ${i} has an invalid file or unknown rule`);
		if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest))
			throw new ConfigError(`allow-list entry ${i} sha256 must be 64 lowercase hex digits`);
		return { file, rule, sha256: digest };
	});
}

// ---------------------------------------------------------------------------------------------
// Scanning.

/** Reads up to bytes from the start of an open descriptor. */
function readFd(fd: number, bytes: number): Buffer {
	const buf = Buffer.alloc(bytes);
	let n = 0;
	while (n < bytes) {
		const got = readSync(fd, buf, n, bytes - n, n);
		if (got === 0) break;
		n += got;
	}
	return buf.subarray(0, n);
}

// O_NOFOLLOW refuses a symlinked leaf (ELOOP); O_NONBLOCK keeps a FIFO from blocking the open (it is
// then refused by fstat). Neither exists on win32, where the post-open checks below still apply.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const inside = (root: string, path: string): boolean => {
	const rel = relative(root, path);
	return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

/**
 * True when the opened descriptor (its fstat info) is the file the relative path names inside root
 * right now: the parents are still real directories, the path lstat's to the same device and inode,
 * and its realpath (and, where /proc exposes it, the descriptor's own path) is inside realpath(root).
 */
function openedInsideRoot(root: string, file: string, path: string, fd: number, opened: Stats): boolean {
	try {
		if (!parentsInsideRoot(root, file)) return false;
		const now = lstatSync(path);
		if (!now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) return false;
		const realRoot = realpathSync.native(root);
		if (!inside(realRoot, realpathSync.native(path))) return false;
		let fdPath: string | undefined;
		try {
			fdPath = readlinkSync(`/proc/self/fd/${fd}`);
		} catch {
			fdPath = undefined; // no /proc (macOS, win32): the device/inode binding above is the check
		}
		return fdPath === undefined || inside(realRoot, fdPath);
	} catch {
		return false;
	}
}

const allowKeys = (options: ScanOptions): Set<string> => new Set((options.allow ?? []).map((a) => `${a.file}\0${a.rule}\0${a.sha256}`));

function scanLines(file: string, lines: readonly string[], firstLine: number, options: ScanOptions, allowed: Set<string>): Finding[] {
	const findings: Finding[] = [];
	for (let i = 0; i < lines.length; i++) {
		for (const m of scanLine(lines[i]!, options.denyWords)) {
			const digest = sha256(m.text);
			if (allowed.has(`${file}\0${m.rule}\0${digest}`)) continue;
			findings.push({ file, line: firstLine + i, rule: m.rule, length: m.text.length, sha256: digest });
		}
	}
	return findings;
}

export function scanText(file: string, text: string, options: ScanOptions = {}): Finding[] {
	return scanLines(file, text.split(/\r\n|\n|\r/), 1, options, allowKeys(options));
}

/**
 * Text of a file, or the rule of the unscanned finding when it cannot be scanned as text. A UTF-32
 * byte-order mark is binary. UTF-16 with a byte-order mark is decoded; an invalid sequence or a
 * decoded U+0000 makes it binary. Otherwise a NUL byte means binary, and anything that is not valid
 * UTF-8 is undecodable (never decoded lossily).
 */
export function decodeText(bytes: Uint8Array): { text: string } | { rule: string } {
	const utf32 =
		(bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00) ||
		(bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff);
	if (utf32) return { rule: BINARY_FILE_RULE };
	const le = bytes[0] === 0xff && bytes[1] === 0xfe;
	const be = bytes[0] === 0xfe && bytes[1] === 0xff;
	if (le || be) {
		const body = Uint8Array.from(bytes.subarray(2));
		if (be) for (let i = 0; i + 1 < body.length; i += 2) [body[i], body[i + 1]] = [body[i + 1]!, body[i]!];
		try {
			const text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(body);
			return text.includes("\0") ? { rule: BINARY_FILE_RULE } : { text };
		} catch {
			return { rule: BINARY_FILE_RULE };
		}
	}
	if (bytes.includes(0)) return { rule: BINARY_FILE_RULE };
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
	} catch {
		return { rule: UNDECODABLE_RULE };
	}
}

/**
 * True when every parent directory of file (relative to root) is a real directory: no symlink or
 * junction, no missing or non-directory segment, and no empty, '.' or '..' segment. Otherwise the
 * file could resolve outside root, so it is never read.
 */
export function parentsInsideRoot(root: string, file: string): boolean {
	const segments = file.split("/");
	if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
	let cur = root;
	for (const segment of segments.slice(0, -1)) {
		cur = join(cur, segment);
		try {
			const info = lstatSync(cur);
			if (info.isSymbolicLink() || !info.isDirectory()) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Scans one file: its relative path as line 0, then its content. */
function scanFile(root: string, file: string, options: ScanOptions, allowed: Set<string>, report: ScanReport, hooks: ScanHooks = {}): Finding[] {
	const findings = scanLines(file, [file], 0, options, allowed);
	const notRegular = () => {
		findings.push({ file, line: 0, rule: NOT_REGULAR_RULE, length: 0, sha256: "" });
		return findings;
	};
	const path = join(root, ...file.split("/"));
	// Cheap pre-check; the decisive checks run on the opened descriptor below.
	if (!parentsInsideRoot(root, file)) return notRegular();
	hooks.beforeOpen?.(path);
	let fd: number;
	try {
		fd = openSync(path, OPEN_FLAGS);
	} catch (error) {
		// A symlinked leaf (ELOOP, EMLINK on BSD), or a path that vanished or stopped being a directory
		// chain: not a regular file. Anything else (EACCES, ...) is a read error, exit 2 as before.
		if (["ELOOP", "EMLINK", "ENOENT", "ENOTDIR", "ENXIO"].includes(fsErrorCode(error) ?? "")) return notRegular();
		throw error;
	}
	let bytes: Buffer;
	try {
		hooks.afterOpen?.(path);
		const info = fstatSync(fd);
		if (!info.isFile() || !openedInsideRoot(root, file, path, fd, info)) return notRegular();
		if (info.size > MAX_SCAN_BYTES) {
			findings.push({ file, line: 0, rule: LARGE_FILE_RULE, length: info.size, sha256: "" });
			return findings;
		}
		bytes = info.size === 0 ? Buffer.alloc(0) : readFd(fd, info.size);
	} finally {
		closeSync(fd);
	}
	const decoded = decodeText(bytes);
	if ("rule" in decoded) {
		const digest = sha256Bytes(bytes);
		if (!allowed.has(`${file}\0${decoded.rule}\0${digest}`))
			findings.push({ file, line: 0, rule: decoded.rule, length: bytes.length, sha256: digest });
		return findings;
	}
	report.scanned++;
	findings.push(...scanLines(file, decoded.text.split(/\r\n|\n|\r/), 1, options, allowed));
	return findings;
}

/** The path with every non-allowed match replaced by [redacted], so a report never prints the value. */
function redactedPath(file: string, options: ScanOptions, allowed: Set<string>): string {
	let out = "";
	let pos = 0;
	for (const m of scanLine(file, options.denyWords)) {
		if (allowed.has(`${file}\0${m.rule}\0${sha256(m.text)}`)) continue;
		const end = m.index + m.text.length;
		if (end <= pos) continue;
		if (m.index >= pos) out += `${file.slice(pos, m.index)}[redacted]`;
		pos = end;
	}
	return out + file.slice(pos);
}

/** Scans the given files (paths relative to root, '/'-separated). */
export function scanFiles(root: string, files: readonly string[], options: ScanOptions = {}, hooks: ScanHooks = {}): ScanReport {
	const report: ScanReport = { findings: [], scanned: 0 };
	const allowed = allowKeys(options);
	for (const file of files) {
		const findings = scanFile(root, file, options, allowed, report, hooks);
		// Allow-list keys use the real path; every reported line shows the redacted one.
		const shown = redactedPath(file, options, allowed);
		for (const f of findings) report.findings.push({ ...f, file: shown });
	}
	return report;
}

/** A path as every report prints it: each match of a rule or deny word (no allow-list) is [redacted]. */
export function redactPath(file: string, options: ScanOptions): string {
	return redactedPath(file, { denyWords: options.denyWords }, new Set());
}

/**
 * Every regular file and symlink under dir ('/'-separated, sorted). Directories named .git are
 * skipped only when skipGit is true (a real work tree); a tree that must be scanned in full, such as
 * the export output, passes false.
 */
export function walkDirectory(dir: string, skipGit = true): string[] {
	const out: string[] = [];
	const visit = (abs: string, rel: string) => {
		for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!skipGit || entry.name !== ".git") visit(join(abs, entry.name), childRel);
			} else out.push(childRel);
		}
	};
	visit(dir, "");
	return out;
}

// Credentials a git message can carry: URL userinfo, well-known token prefixes, auth headers.
const SECRET_TOKENS: readonly RegExp[] = [
	/(?<=[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+(?=@)/g,
	/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,})/g,
	/(?<=\b(?:authorization|bearer|token|password|passwd)\s*[:=]?\s*)[^\s'"]{8,}/gi,
];
// An absolute path (posix, drive letter or UNC) that starts a word or follows a quote: in a git
// message it is an operator path (repository, gitdir, cwd) and is never printed.
const ABSOLUTE_PATH = /(?<=^|[\s'"`(=<])(?:\/|[A-Za-z]:[\\/]|\\\\)[^\s'"`)>]*/g;

/**
 * Free text (a git error message) with every credential, absolute path, rule match and deny word
 * replaced, so it can be printed. Paths become [path]; everything else becomes [redacted].
 */
export function redactText(text: string, denyWords: readonly string[] = []): string {
	return text
		.split(/\r\n|\n|\r/)
		.map((line) => {
			let out = line;
			for (const re of SECRET_TOKENS) out = out.replace(re, "[redacted]");
			out = out.replace(ABSOLUTE_PATH, "[path]");
			return redactPath(out, { denyWords });
		})
		.join("\n");
}

/**
 * The error for a failed git command: only the subcommand and the exit status. git's stderr can name
 * the repository, a gitdir, a remote URL or a credential, and pattern redaction cannot be proven
 * complete, so it is never part of the message (callers do not even capture it).
 */
export function gitFailure(subcommand: string, exitCode: number | null): ConfigError {
	return new ConfigError(`git ${subcommand} failed (exit ${exitCode ?? "signal"})`);
}

/** Tracked files of the repository containing cwd, relative to its top level. */
export function trackedFiles(cwd: string): { root: string; files: string[] } {
	const git = (dir: string, ...args: string[]) => {
		// Absolute git + cwd outside the tree: a planted `git` under dir must never run.
		const r = spawnGitSync(dir, args, {
			flags: ["-c", "core.quotepath=off"],
			stderr: "ignore",
		});
		if (r.exitCode !== 0) throw gitFailure(args[0]!, r.exitCode);
		return Buffer.from(r.stdout).toString();
	};
	const root = git(cwd, "rev-parse", "--show-toplevel").trim();
	const files = git(root, "ls-files", "-z").split("\0").filter((f) => f !== "");
	return { root, files };
}

export function formatFinding(f: Finding, showDigest = false): string {
	const what =
		f.rule === LARGE_FILE_RULE
			? `[not scanned: ${f.length} bytes > ${MAX_SCAN_BYTES}]`
			: f.rule === BINARY_FILE_RULE
				? `[not scanned: binary, ${f.length} bytes]`
				: f.rule === UNDECODABLE_RULE
					? `[not scanned: not valid UTF-8, ${f.length} bytes]`
					: f.rule === NOT_REGULAR_RULE
						? "[not scanned: not a regular file]"
						: `[redacted ${f.rule} len=${f.length}]`;
	return `${f.file}:${f.line}:${f.rule} ${what}${showDigest && f.sha256 ? ` sha256=${f.sha256}` : ""}`;
}

export function summarize(report: ScanReport): string {
	const perRule = new Map<string, number>();
	for (const f of report.findings) perRule.set(f.rule, (perRule.get(f.rule) ?? 0) + 1);
	const files = new Set(report.findings.map((f) => f.file)).size;
	const rules = [...perRule].sort().map(([r, n]) => `${r}=${n}`).join(" ");
	return (
		`privacy-scan: ${report.findings.length} finding(s) in ${files} file(s); ${report.scanned} scanned${rules ? `; ${rules}` : ""}`
	);
}

export interface CliResult {
	code: number;
	stdout: string[];
	stderr: string[];
}

export function loadDenyWords(denyListPath: string): string[] {
	if (!existsSync(denyListPath)) throw new ConfigError("deny-list file not found");
	if (!statSync(denyListPath).isFile()) throw new ConfigError("deny-list is not a regular file");
	return parseDenyList(readFileSync(denyListPath, "utf8"));
}

/**
 * The errno code of a filesystem error, or undefined. Callers print only this code: an fs message
 * and its stack trace carry absolute operator paths.
 */
export function fsErrorCode(error: unknown): string | undefined {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return !(error instanceof ConfigError) && typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
}

export function loadOptions(root: string, denyListPath?: string, allowListPath?: string): ScanOptions {
	const options: ScanOptions = {};
	if (denyListPath !== undefined) options.denyWords = loadDenyWords(denyListPath);
	const allowPath = allowListPath ?? join(root, "scripts", "privacy-allow.json");
	if (allowListPath !== undefined && !existsSync(allowPath)) throw new ConfigError("allow-list file not found");
	if (existsSync(allowPath) && !statSync(allowPath).isFile()) throw new ConfigError("allow-list is not a regular file");
	if (existsSync(allowPath)) options.allow = parseAllowList(readFileSync(allowPath, "utf8"));
	return options;
}

export function runCli(argv: readonly string[], cwd = process.cwd()): CliResult {
	const result: CliResult = { code: 0, stdout: [], stderr: [] };
	let dir: string | undefined;
	let deny: string | undefined;
	let allow: string | undefined;
	let showDigest = false;
	try {
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i]!;
			const value = () => {
				const v = argv[++i];
				if (v === undefined || v === "") throw new ConfigError(`${arg} needs a value`);
				return isAbsolute(v) ? v : resolve(cwd, v);
			};
			if (arg === "--dir") dir = value();
			else if (arg === "--deny-list") deny = value();
			else if (arg === "--allow-list") allow = value();
			else if (arg === "--show-digest") showDigest = true;
			else throw new ConfigError(`unknown argument: ${arg}`);
		}
		let root: string;
		let files: string[];
		if (dir !== undefined) {
			if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new ConfigError("--dir is not a directory");
			root = dir;
			files = walkDirectory(dir);
		} else {
			if (deny !== undefined) loadDenyWords(deny); // a bad deny-list is reported before git runs, as before
			({ root, files } = trackedFiles(cwd));
		}
		const options = loadOptions(root, deny, allow);
		let report: ScanReport;
		try {
			report = scanFiles(root, files, options);
		} catch (error) {
			const code = fsErrorCode(error);
			if (code === undefined) throw error;
			throw new ConfigError(`cannot read a file to scan (${code})`);
		}
		for (const f of report.findings) result.stdout.push(formatFinding(f, showDigest));
		result.stderr.push(summarize(report));
		result.code = report.findings.length > 0 ? 1 : 0;
	} catch (error) {
		const code = fsErrorCode(error);
		if (!(error instanceof ConfigError) && code === undefined) throw error;
		result.stderr.push(`privacy-scan: ${error instanceof ConfigError ? error.message : `filesystem error (${code})`}`);
		result.code = 2;
	}
	return result;
}

if (import.meta.main) {
	const r = runCli(process.argv.slice(2));
	if (r.stdout.length) process.stdout.write(`${r.stdout.join("\n")}\n`);
	if (r.stderr.length) process.stderr.write(`${r.stderr.join("\n")}\n`);
	process.exitCode = r.code;
}
