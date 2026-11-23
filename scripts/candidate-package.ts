// Deterministic candidate packager and bounded, streaming verifier.
//
// package: inventories a Git working tree (tracked working-tree bytes plus untracked,
// nonignored files), cross-checks that inventory against an independent filesystem walk,
// and writes a restricted-USTAR .tar.gz whose first member is the manifest itself.
// verify: checks a package against its sidecar manifest without extracting anything,
// enforcing hard size/count/path bounds before and during decompression.
//
// Every refusal is a CandidateRefusal whose message starts with "[rule-name]".
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants, createReadStream, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import type { Stats } from "node:fs";
import { once } from "node:events";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createGzip, createInflateRaw, crc32 } from "node:zlib";
import { dlopen, FFIType } from "bun:ffi";
import { isolatedGitEnvironment } from "../src/workspace";

export const VERSION = "2.0.0";
/** Archive member that carries the manifest; covered by the archive SHA256. */
export const MANIFEST_MEMBER = ".candidate-manifest.json";

export interface Limits {
	/** Maximum .tar.gz size in bytes. */
	compressedBytes: number;
	/** Maximum total uncompressed tar stream in bytes (headers, data, padding, trailer). */
	uncompressedBytes: number;
	/** Maximum size of one member in bytes. */
	memberBytes: number;
	/** Maximum number of file members (excluding the manifest member). */
	members: number;
	/** Maximum portable path length in UTF-8 bytes. */
	pathBytes: number;
	/** Maximum sidecar manifest / expected-list size in bytes. */
	manifestBytes: number;
}
export const LIMITS: Readonly<Limits> = Object.freeze({
	compressedBytes: 512 * 1024 * 1024,
	uncompressedBytes: 1024 * 1024 * 1024,
	memberBytes: 256 * 1024 * 1024,
	members: 50_000,
	pathBytes: 240,
	manifestBytes: 32 * 1024 * 1024,
});
/** Zero bytes allowed after the last member: at least two blocks, at most one 10240-byte record. */
const TRAILER_MIN = 1024;
const TRAILER_MAX = 10240;
const GIT_STDOUT_MAX = 64 * 1024 * 1024;
const GIT_VERSION_MAX = 4096;
const IDENTITY_MAX = 64 * 1024;
const CHUNK = 1024 * 1024;
/** Exact gzip header the packager writes: no flags, mtime 0, XFL 2 (level 9), OS 255. */
const GZIP_HEADER = Buffer.from("1f8b08000000000002ff", "hex");

export class CandidateRefusal extends Error {
	constructor(
		readonly rule: string,
		detail: string,
	) {
		super(`[${rule}] ${detail}`);
		this.name = "CandidateRefusal";
	}
}
const refuse = (rule: string, detail: string): never => {
	throw new CandidateRefusal(rule, detail);
};

export type ExclusionReason = "git-dir" | "nested-repository" | "nested-bare-repository" | "submodule" | "ignored";
export interface ManifestFile {
	path: string;
	size: number;
	sha256: string;
	mode: number;
}
export interface Manifest {
	toolVersion: string;
	baseCommit: string;
	identity: unknown;
	exclusions: { path: string; reason: ExclusionReason }[];
	files: ManifestFile[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const pad512 = (n: number) => Math.ceil(n / 512) * 512;
const json = (v: unknown) => JSON.stringify(v);

/** Read-only open that never follows a final symbolic link and never blocks on a FIFO or device (POSIX). */
const OPEN_READ = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
/**
 * Opens `path` for reading only if it is a regular file, or returns null: lstat (no link followed) must report a
 * regular file, the open itself neither follows a final link (O_NOFOLLOW) nor blocks (O_NONBLOCK), and fstat of
 * the opened descriptor must report a regular file that is the one lstat saw (st_dev + st_ino; on Windows the
 * volume serial number and file id, which Bun reports alike for lstat and fstat). So a FIFO, socket, device or link
 * is never read, even if it replaces the file between the check and the open (Windows has no O_NOFOLLOW: a link
 * swapped in is followed, and the identity comparison refuses it). lstat and open errors other than a link met by
 * O_NOFOLLOW are thrown.
 */
function openRegular(path: string): number | null {
	const before = lstatSync(path, { bigint: true });
	if (!before.isFile()) return null;
	let fd: number;
	try {
		fd = openSync(path, OPEN_READ);
	} catch (error: any) {
		if (error?.code === "ELOOP") return null;
		throw error;
	}
	const after = fstatSync(fd, { bigint: true });
	if (after.isFile() && after.dev === before.dev && after.ino === before.ino) return fd;
	closeSync(fd);
	return null;
}

// ---------------------------------------------------------------------------------------
// Portable path policy (shared by package and verify)
// ---------------------------------------------------------------------------------------
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$|clock\$)$/i;
/** Code points HFS+ ignores when comparing names (git's is_hfs_dotgit list). */
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** Any 8.3-shaped name containing a ~N tail; such a name can alias an arbitrary long name (e.g. GIT~1 -> .git). */
const SHORT_NAME_ALIAS = /^[^.]*~[0-9]+(\.[^.]*)?$/;

export function safePath(name: string, limits: Pick<Limits, "pathBytes"> = LIMITS): void {
	if (typeof name !== "string" || name === "") refuse("path-empty", "empty path");
	if (Buffer.byteLength(name) > limits.pathBytes) refuse("path-too-long", `${Buffer.byteLength(name)} UTF-8 bytes > ${limits.pathBytes}: ${json(name.slice(0, 80))}`);
	if (name.isWellFormed && !name.isWellFormed()) refuse("path-invalid-unicode", json(name));
	if (name !== name.normalize("NFC")) refuse("path-not-nfc", json(name));
	if (name.includes("\\")) refuse("path-backslash", json(name));
	if (name.startsWith("/")) refuse("path-absolute", json(name));
	for (const seg of name.split("/")) {
		if (seg === "" || seg === "." || seg === "..") refuse("path-dot-or-empty-segment", json(name));
		if (/[\x00-\x1f\x7f]/.test(seg)) refuse("path-control-char", json(name));
		if (seg.includes(":")) refuse("path-alternate-data-stream", `':' (drive or NTFS stream syntax) in ${json(name)}`);
		if (/[<>"|?*]/.test(seg)) refuse("path-reserved-char", json(name));
		if (/[. ]$/.test(seg)) refuse("path-trailing-dot-or-space", json(name));
		const folded = seg.replace(HFS_IGNORABLE, "").toLowerCase();
		if (folded === ".git") refuse("path-git-dir", `.git (case/HFS-ignorable variant) segment in ${json(name)}`);
		if (SHORT_NAME_ALIAS.test(seg)) refuse("path-8dot3-alias", `NTFS short-name form (could alias .git) in ${json(name)}`);
		const stem = seg.split(".")[0].replace(/ +$/, "");
		if (DEVICE.test(stem)) refuse("path-device-name", `Windows device name ${json(stem)} in ${json(name)}`);
		if (seg.toLowerCase() === MANIFEST_MEMBER && seg === name) refuse("path-reserved-manifest-name", json(name));
	}
}

/**
 * Case key of a name for alias checks. toLowerCase() alone misses names a case-insensitive APFS/HFS+ volume
 * stores as one file, because those apply full Unicode case folding ("ß"/"ss", "ſ"/"s", "σ"/"ς", "ﬀ"/"ff",
 * "µ"/"μ"). Lower-casing, then upper- and lower-casing again until nothing changes, equates every such pair
 * and everything toLowerCase() equates (NTFS); NFD first and NFC last so combining marks compare alike.
 * HFS+ (older Unicode tables) additionally ignores HFS_IGNORABLE code points and folds Georgian Mkhedruli
 * U+10D0..U+10F5 onto Asomtavruli U+10A0..U+10C5, whose key is Nuskhuri U+2D00..U+2D25.
 * Measured against real volumes (fold-scan): 0 aliases missed on APFS (U+0001..U+1FFFF) and HFS+ (BMP).
 */
export function caseKey(name: string): string {
	let key = name.normalize("NFD").replace(HFS_IGNORABLE, "").toLowerCase();
	for (let previous = ""; key !== previous; ) {
		previous = key;
		key = key.toUpperCase().toLowerCase();
	}
	return key.replace(/[\u10d0-\u10f5]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x10d0 + 0x2d00)).normalize("NFC");
}

/** Case-insensitive file/file and file/directory aliasing check (Windows/macOS extraction targets). */
function checkCollisions(paths: string[]): void {
	const prefixes = new Map<string, string>();
	const files = new Set(paths.map(caseKey));
	for (const path of paths) {
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const key = caseKey(prefix);
			const previous = prefixes.get(key);
			if ((previous !== undefined && previous !== prefix) || (i < parts.length && files.has(key))) refuse("path-case-collision", json(path));
			prefixes.set(key, prefix);
		}
	}
}

// ---------------------------------------------------------------------------------------
// USTAR (restricted subset: regular files, fixed metadata)
// ---------------------------------------------------------------------------------------
/**
 * Canonical USTAR split of a path longer than 100 bytes: the longest prefix (<= 155 bytes) whose
 * remainder fits the name field (<= 100 bytes). Every '/' is tried, last first, so the split is
 * unique and identical to the last-'/' split whenever that one fits. Returns -1 if none fits.
 */
function ustarSplit(name: string): number {
	for (let n = name.lastIndexOf("/"); n > 0; n = name.lastIndexOf("/", n - 1)) {
		if (Buffer.byteLength(name.slice(n + 1)) > 100) return -1; // earlier slashes only lengthen the name part
		if (Buffer.byteLength(name.slice(0, n)) <= 155) return n;
	}
	return -1;
}

export function tarHeader(name: string, size: number, mode: number): Buffer {
	const h = Buffer.alloc(512);
	let leaf = name;
	let prefix = "";
	if (Buffer.byteLength(name) > 100) {
		const n = ustarSplit(name);
		if (n < 0) refuse("path-ustar-split", `no '/' splits it into USTAR prefix(<=155 bytes)/name(<=100 bytes): ${json(name)}`);
		prefix = name.slice(0, n);
		leaf = name.slice(n + 1);
	}
	h.write(leaf, 0);
	h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
	h.write("0000000\0", 108);
	h.write("0000000\0", 116);
	h.write(size.toString(8).padStart(11, "0") + "\0", 124);
	h.write("00000000000\0", 136);
	h.fill(32, 148, 156);
	h[156] = 48;
	h.write("ustar\0", 257);
	h.write("00", 263);
	h.write(prefix, 345);
	const sum = h.reduce((a, b) => a + b, 0);
	h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
	return h;
}

// ---------------------------------------------------------------------------------------
// Git (explicit config, isolated environment, stderr is fatal)
// ---------------------------------------------------------------------------------------
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
/**
 * Oldest accepted git. GIT_NO_LAZY_FETCH / --no-lazy-fetch (git 2.44) is the only switch that stops a
 * partial clone from lazily fetching a missing object while `rev-parse`/`ls-files` read it, and that fetch
 * runs repository-configured programs (remote.<n>.uploadpack, core.sshCommand, ext:: urls, remote helpers).
 */
export const MIN_GIT_VERSION = "2.44.0";
/**
 * Every option that affects what git reports or what it may run; nothing is taken from system/global config
 * or GIT_* env, and command-line -c outranks repository config for the same key.
 */
export const GIT_OPTIONS = [
	"--no-pager",
	// git >= 2.44 only: an older git exits 129 here (a second layer behind the version check).
	"--no-lazy-fetch",
	"--no-replace-objects",
	// Transports are never needed; a repository protocol.<name>.allow=always cannot outrank these.
	"-c", "protocol.allow=never",
	...["file", "git", "ssh", "http", "https", "ext"].flatMap((p) => ["-c", `protocol.${p}.allow=never`]),
	"-c", "core.longpaths=true",
	"-c", "core.quotepath=false",
	"-c", "core.autocrlf=false",
	"-c", "core.safecrlf=false",
	"-c", "core.fsmonitor=false",
	"-c", "core.untrackedCache=false",
	"-c", "core.precomposeunicode=false",
	"-c", "core.protectNTFS=true",
	"-c", `core.hooksPath=${NULL_DEVICE}`,
	"-c", `core.excludesFile=${NULL_DEVICE}`,
	"-c", `core.attributesFile=${NULL_DEVICE}`,
	"-c", "status.showUntrackedFiles=all",
];
const GIT_EXE = process.platform === "win32" ? "git.exe" : "git";

let kernel32: Record<string, (...args: any[]) => any> | undefined;
// Win32 FFI symbols are called with heterogeneous argument shapes; bun:ffi typing cannot express them per symbol here.
type K32 = Record<string, (...args: any[]) => any>;
function k32(): K32 {
	return k32Raw();
}
function k32Raw() {
	return (kernel32 ??= dlopen("kernel32.dll", {
		GetDriveTypeW: { args: [FFIType.ptr], returns: FFIType.u32 },
		GetVolumeNameForVolumeMountPointW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetVolumePathNamesForVolumeNameW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		GetFullPathNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
		CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.i64], returns: FFIType.i64 },
		GetFileInformationByHandleEx: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetFinalPathNameByHandleW: { args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u32 },
		DeviceIoControl: { args: [FFIType.i64, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
		FindFirstFileNameW: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
		FindNextFileNameW: { args: [FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		FindClose: { args: [FFIType.i64], returns: FFIType.i32 },
		CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
		SetInformationJobObject: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		QueryInformationJobObject: { args: [FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.i64 },
		AssignProcessToJobObject: { args: [FFIType.i64, FFIType.i64], returns: FFIType.i32 },
		TerminateJobObject: { args: [FFIType.i64, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	}).symbols as unknown as K32);
}
const wide = (s: string) => Buffer.from(s + "\0", "utf16le");
const DRIVE_FIXED = 3;
const WIDE_MAX = 32768;
const ATTR_DIRECTORY = 0x10;
const ATTR_REPARSE_POINT = 0x400;
/** Junctions and volume mount points (the target says which). */
const TAG_MOUNT_POINT = 0xa0000003;
const TAG_SYMLINK = 0xa000000c;
/** The I/O manager's limit on reparse points followed while opening one name. */
const MAX_REPARSE = 63;
/** "\\?\Volume{...}\" - the volume-GUID root of a final path. */
const VOLUME_ROOT = /^\\\\\?\\Volume\{[0-9A-Fa-f-]+\}\\/;
const lower = (s: string) => s.toLowerCase();

/** The mount manager's volume GUID path ("\\?\Volume{...}\") of a mount point such as "C:\", or null. */
function volumeOf(mountPoint: string): string | null {
	const buf = Buffer.alloc(2 * 64);
	return k32().GetVolumeNameForVolumeMountPointW(wide(mountPoint), buf, 64) ? buf.toString("utf16le").split("\0")[0] : null;
}

/**
 * Why `path` is not a trusted location for git, or null. Decided from the path and the drive alone, never
 * from the workspace and without touching the path itself. Windows: only a drive-letter absolute path
 * ("X:\...") on a fixed local drive that the mount manager knows as a volume mount point. Refused: UNC
 * (\\host\share, //host/share), \\?\ and \\.\ device-namespace forms (including \\?\UNC and volume GUIDs),
 * drive-relative ("\dir", "C:dir") and relative paths, network (mapped), removable, optical, RAM or unknown
 * drives, and subst/DefineDosDevice redirections (they are not volume mount points). POSIX: absolute paths.
 */
export function untrustedLocation(path: string): string | null {
	if (process.platform !== "win32") return isAbsolute(path) ? null : "not an absolute path";
	if (path.includes("\0") || !/^[A-Za-z]:[\\/]/.test(path)) return "not a drive-letter absolute path (UNC, device namespace, drive-relative or relative)";
	const drive = path[0].toUpperCase() + ":";
	const type = k32().GetDriveTypeW(wide(drive + "\\")) as number;
	if (type !== DRIVE_FIXED) return `drive ${drive} is not a fixed local drive (GetDriveType ${type})`;
	if (!volumeOf(drive + "\\")) return `drive ${drive} is not a volume mount point (a subst or DefineDosDevice redirection)`;
	return null;
}

/** What one open of a path reports (Windows: one CreateFileW handle; POSIX: stat + realpath). */
export interface PathProbe {
	/** Volume serial + file id (Windows FileIdInfo), st_dev:st_ino (POSIX); null when unreadable. */
	id: string | null;
	/** FILE_ATTRIBUTE_* and reparse tag of the opened object; -1 when unreadable. */
	attributes: number;
	tag: number;
	/** Final path in volume-GUID form ("\\?\Volume{...}\dir\file"; POSIX: realpath); null when unavailable. */
	final: string | null;
	/** Final path in drive-letter form ("C:\dir\file"; POSIX: realpath); null when unavailable. */
	dos: string | null;
	/** Substitute name and relative flag of a mount point or symbolic link that was opened itself. */
	target?: { path: string; relative: boolean };
}
/** `follow`: false opens a link itself (FILE_FLAG_OPEN_REPARSE_POINT). null: the path cannot be opened. */
export type Probe = (path: string, follow: boolean) => PathProbe | null;

function finalName(h: bigint, flags: number): string | null {
	const buf = Buffer.alloc(2 * WIDE_MAX);
	const n = k32().GetFinalPathNameByHandleW(h, buf, WIDE_MAX, flags) as number;
	return n > 0 && n < WIDE_MAX ? buf.toString("utf16le", 0, n * 2) : null;
}

export function probePath(path: string, follow: boolean): PathProbe | null {
	if (process.platform !== "win32") {
		try {
			const st = statSync(path, { bigint: true });
			const real = realpathSync(path);
			return { id: `${st.dev}:${st.ino}`, attributes: st.isDirectory() ? ATTR_DIRECTORY : 0, tag: 0, final: real, dos: real };
		} catch {
			return null;
		}
	}
	// FILE_READ_ATTRIBUTES, share read/write/delete, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS (directories),
	// FILE_FLAG_OPEN_REPARSE_POINT unless following.
	const h = BigInt(k32().CreateFileW(wide(path), 0x80, 7, null, 3, 0x02000000 | (follow ? 0 : 0x00200000), 0n));
	if (h === -1n || h === 0n) return null;
	try {
		const tagInfo = Buffer.alloc(8);
		const basicInfo = Buffer.alloc(40);
		let attributes = -1;
		let tag = 0;
		if (k32().GetFileInformationByHandleEx(h, 9 /* FileAttributeTagInfo */, tagInfo, 8)) {
			attributes = tagInfo.readUInt32LE(0);
			if (attributes & ATTR_REPARSE_POINT) tag = tagInfo.readUInt32LE(4);
		} else if (k32().GetFileInformationByHandleEx(h, 0 /* FileBasicInfo */, basicInfo, 40)) {
			// File systems without reparse points (FAT, exFAT) do not answer FileAttributeTagInfo; their attributes
			// still say whether the object is a reparse point, and if it were, its tag would be unknown -> -1.
			const basic = basicInfo.readUInt32LE(32);
			if (!(basic & ATTR_REPARSE_POINT)) attributes = basic;
		}
		const idInfo = Buffer.alloc(24);
		const id =
			k32().GetFileInformationByHandleEx(h, 18 /* FileIdInfo */, idInfo, 24) && !idInfo.subarray(8).every((b) => b === 0)
				? `${idInfo.subarray(0, 8).toString("hex")}:${idInfo.subarray(8).toString("hex")}`
				: null;
		const final = finalName(h, 1 /* VOLUME_NAME_GUID */);
		const dos = finalName(h, 0 /* VOLUME_NAME_DOS */)?.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, "") ?? null;
		const probe: PathProbe = { id, attributes, tag, final, dos };
		if (tag === TAG_MOUNT_POINT || tag === TAG_SYMLINK) {
			const data = Buffer.alloc(16 * 1024);
			const got = Buffer.alloc(4);
			if (k32().DeviceIoControl(h, 0x000900a8 /* FSCTL_GET_REPARSE_POINT */, null, 0, data, data.length, got, null) && data.readUInt32LE(0) === tag) {
				const base = tag === TAG_SYMLINK ? 20 : 16;
				const offset = data.readUInt16LE(8);
				const length = data.readUInt16LE(10);
				if (base + offset + length <= got.readUInt32LE(0))
					probe.target = { path: data.toString("utf16le", base + offset, base + offset + length), relative: tag === TAG_SYMLINK && (data.readUInt32LE(16) & 1) === 1 };
			}
		}
		return probe;
	} finally {
		k32().CloseHandle(h);
	}
}

/**
 * Filesystem identity of an existing file or directory (links followed): volume serial + file id on Windows
 * (FileIdInfo: 64-bit serial, 128-bit id), st_dev + st_ino on POSIX. Equal for every alias of the same
 * object however it is spelled. null when it cannot be read.
 */
export function fileIdentity(path: string): string | null {
	return probePath(path, true)?.id ?? null;
}

/**
 * Every name of the file at `path` (its hard links on its volume) in volume-GUID form, or null when they
 * cannot be listed. Windows only (FindFirstFileNameW returns names relative to the file's volume root, which
 * is prefixed with that volume's GUID path, never with a drive letter); POSIX has no such enumeration ->
 * [realpath].
 */
export function hardLinkNames(path: string): string[] | null {
	if (process.platform !== "win32") return [realpathSync(path)];
	const volume = probePath(path, false)?.final?.match(VOLUME_ROOT)?.[0];
	if (!volume) return null;
	const names: string[] = [];
	const buf = Buffer.alloc(2 * WIDE_MAX);
	const len = Buffer.alloc(4);
	const take = () => names.push(volume + buf.toString("utf16le", 0, (len.readUInt32LE(0) - 1) * 2).replace(/^\\/, ""));
	len.writeUInt32LE(WIDE_MAX);
	const h = BigInt(k32().FindFirstFileNameW(wide(path), 0, len, buf));
	if (h === -1n || h === 0n) return null;
	try {
		take();
		for (;;) {
			len.writeUInt32LE(WIDE_MAX);
			if (!k32().FindNextFileNameW(h, len, buf)) break;
			take();
		}
	} finally {
		k32().FindClose(h);
	}
	return names;
}

/** Win32 full-path normalization (what CreateFileW applies to a non-"\\?\" name before any lookup). */
function fullPath(path: string): string | null {
	const buf = Buffer.alloc(2 * WIDE_MAX);
	const n = k32().GetFullPathNameW(wide(path), WIDE_MAX, buf, null) as number;
	return n > 0 && n < WIDE_MAX ? buf.toString("utf16le", 0, n * 2) : null;
}
/** Root ("C:\" or "\\?\Volume{...}\") and components of a normalized absolute path; null for any other form. */
function splitRoot(path: string): { root: string; parts: string[] } | null {
	const root = /^[A-Za-z]:\\/.test(path) ? path.slice(0, 3) : path.match(VOLUME_ROOT)?.[0];
	return root ? { root, parts: path.slice(root.length).split("\\").filter(Boolean) } : null;
}
const openName = (root: string, parts: string[]) => (root.startsWith("\\\\?\\") ? root : "\\\\?\\" + root) + parts.join("\\");
/** A link's absolute NT target as a local root, or why it is not local. */
function localTarget(target: string): { path: string } | { why: string } {
	const drive = /^\\\?\?\\([A-Za-z]:\\.*)$/.exec(target);
	if (drive) {
		const why = untrustedLocation(drive[1]);
		return why === null ? { path: drive[1] } : { why };
	}
	const volume = /^\\\?\?\\(Volume\{[0-9A-Fa-f-]+\}\\.*)$/.exec(target);
	if (volume) {
		const path = "\\\\?\\" + volume[1];
		const type = k32().GetDriveTypeW(wide(path.match(VOLUME_ROOT)![0])) as number;
		return type === DRIVE_FIXED ? { path } : { why: `the volume is not a fixed local drive (GetDriveType ${type})` };
	}
	return { why: `the target ${json(target)} is not on a local drive (UNC, device or GLOBALROOT path)` };
}

type Located = { kind: "found"; path: string } | { kind: "missing" } | { kind: "untrusted"; why: string; last: boolean };
/**
 * Resolves every reparse point of the absolute drive-letter path `path` the way the I/O manager does while
 * opening it - one component at a time, restarting with the rewritten name after each junction, symbolic
 * link or volume mount point - but opens only each link itself, never what it points to. So a link to a
 * network share or a non-fixed volume is reported without being traversed (no network I/O), and a reparse
 * point of any other type is refused. Returns the reparse-point-free path ("C:\..." or "\\?\Volume{...}\...").
 */
function locate(path: string, probe: Probe): Located {
	let current = fullPath(path);
	for (let hops = 0; ; ) {
		const split = current === null ? null : splitRoot(current);
		if (!split) return { kind: "untrusted", why: `${json(current ?? path)} is not a local absolute path`, last: false };
		const { root, parts } = split;
		let rewritten: string | null = null;
		for (let i = 0; i < parts.length && rewritten === null; i++) {
			const name = openName(root, parts.slice(0, i + 1));
			const p = probe(name, false);
			if (!p) return { kind: "missing" };
			if (p.attributes === -1) refuse("git-identity-unavailable", `cannot read the attributes of ${json(name)}`);
			if (!(p.attributes & ATTR_REPARSE_POINT)) continue;
			if (p.tag !== TAG_MOUNT_POINT && p.tag !== TAG_SYMLINK) refuse("git-reparse-unknown", `${json(name)} is a reparse point of unknown type 0x${p.tag.toString(16)} (only junctions, symbolic links and volume mount points are followed)`);
			if (!p.target) refuse("git-identity-unavailable", `cannot read the target of the reparse point ${json(name)}`);
			if (++hops > MAX_REPARSE) return { kind: "untrusted", why: `more than ${MAX_REPARSE} reparse points`, last: false };
			const rest = parts.slice(i + 1);
			if (p.target!.relative) {
				// Relative symbolic link: lexical against the link's directory; a leading "\" means the current root.
				const stack = p.target!.path.startsWith("\\") ? [] : parts.slice(0, i);
				for (const c of p.target!.path.split("\\")) {
					if (c === "" || c === ".") continue;
					if (c === "..") stack.pop();
					else stack.push(c);
				}
				rewritten = root + [...stack, ...rest].join("\\");
			} else {
				const t = localTarget(p.target!.path);
				if ("why" in t) return { kind: "untrusted", why: `${json(name)} links to a non-local location: ${t.why}`, last: rest.length === 0 };
				rewritten = [t.path.replace(/\\+$/, ""), ...rest].join("\\");
				if (/^[A-Za-z]:$/.test(rewritten) || VOLUME_ROOT.test(rewritten + "\\")) rewritten += "\\";
			}
		}
		if (rewritten === null) return { kind: "found", path: openName(root, parts) };
		current = rewritten;
	}
}

/** "\\?\Volume{G}\a\b" -> "\\?\Volume{G}\a"; "\\?\Volume{G}\a" -> "\\?\Volume{G}\"; a volume root -> null. */
function guidParent(path: string): string | null {
	const root = path.match(VOLUME_ROOT)?.[0];
	if (!root || path.length === root.length) return null;
	const cut = path.lastIndexOf("\\");
	return cut < root.length ? root : path.slice(0, cut);
}
/** Every registered mount point of a volume ("C:\", "C:\data\vol\"), or null when they cannot be listed. */
function mountPoints(volume: string): string[] | null {
	const buf = Buffer.alloc(2 * WIDE_MAX);
	const len = Buffer.alloc(4);
	if (!k32().GetVolumePathNamesForVolumeNameW(wide(volume), buf, WIDE_MAX, len)) return null;
	return buf.toString("utf16le", 0, Math.min(len.readUInt32LE(0), WIDE_MAX) * 2).split("\0").filter(Boolean);
}

/**
 * Refuses when the workspace (identity `rootId`) is `dir` or any directory above it. Windows: `dir` is a final
 * volume-GUID path; each directory is opened by its final path (links not followed) and must report that same
 * final path, no reparse point and a readable identity. At a volume root the walk continues, for every
 * registered mount point of the volume, from the mount point directory up its host volume - so a volume
 * mounted in a folder is checked where it is mounted, however deep. A volume without any mount point, or a
 * mount point that does not lead back to the volume, cannot be placed and is refused.
 */
function assertOutside(dir: string, rootId: string, rootPath: string, probe: Probe, git: string, volumes: Set<string>): void {
	const inside = (at: string) => refuse("git-inside-workspace", `PATH resolves git to ${json(git)}; ${json(at)} is the workspace being packaged ${json(rootPath)}`);
	const unavailable = (detail: string) => refuse("git-identity-unavailable", `${detail} (git ${json(git)})`);
	if (process.platform !== "win32") {
		for (let d = dir; ; d = dirname(d)) {
			const id = probe(d, true)?.id;
			if (!id) unavailable(`cannot read the filesystem identity of ${json(d)}`);
			if (id === rootId) inside(d);
			if (dirname(d) === d) return;
		}
	}
	for (let d: string | null = dir; d !== null; ) {
		const p = probe(d, false);
		if (!p?.id) return unavailable(`cannot read the filesystem identity of ${json(d)}`);
		if (p.attributes === -1 || p.attributes & ATTR_REPARSE_POINT)
			return p.attributes !== -1 && p.tag !== TAG_MOUNT_POINT && p.tag !== TAG_SYMLINK
				? refuse("git-reparse-unknown", `${json(d)} in git's final path is a reparse point of unknown type 0x${p.tag.toString(16)} (git ${json(git)})`)
				: unavailable(`${json(d)} in git's final path is not a plain directory (changed while being checked?)`);
		if (!p.final || lower(p.final) !== lower(d)) return unavailable(`${json(d)} now opens as ${json(p.final)} (changed while being checked)`);
		if (p.id === rootId) inside(p.dos ?? d);
		const up = guidParent(d);
		if (up !== null) {
			d = up;
			continue;
		}
		if (volumes.has(lower(d))) return;
		volumes.add(lower(d));
		const type = k32().GetDriveTypeW(wide(d)) as number;
		if (type !== DRIVE_FIXED) refuse("git-untrusted-location", `git ${json(git)} is on volume ${json(d)}, which is not a fixed local drive (GetDriveType ${type})`);
		const points = mountPoints(d);
		if (!points?.length) return unavailable(`volume ${json(d)} has no mount point, so its place in the directory tree is unknown`);
		for (const point of points) {
			if (/^[A-Za-z]:\\$/.test(point)) continue;
			const at = point.replace(/\\+$/, "");
			const m = probe(at, false);
			const target = m?.target && !m.target.relative ? /^\\\?\?\\(Volume\{[0-9A-Fa-f-]+\}\\)$/.exec(m.target.path)?.[1] : undefined;
			if (!m?.id || !m.final || m.tag !== TAG_MOUNT_POINT || !target || lower("\\\\?\\" + target) !== lower(d)) return unavailable(`mount point ${json(point)} of volume ${json(d)} cannot be verified`);
			if (m.id === rootId) inside(at);
			const host = guidParent(m.final);
			if (host === null) return unavailable(`mount point ${json(point)} has no parent directory`);
			assertOutside(host, rootId, rootPath, probe, git, volumes);
		}
		return;
	}
}

/**
 * Absolute path of the git executable. Only PATH entries that are trusted locations (untrustedLocation() ===
 * null) are searched; any other entry - relative, empty, UNC, device namespace, network, subst - is skipped
 * without being touched. Never the current directory or the workspace: on Windows a bare "git" is looked up in
 * the spawn cwd before PATH. Only git.exe is accepted on Windows (a .bat/.cmd would run through cmd.exe).
 *
 * Containment is decided on final paths and filesystem identities, never on path spelling. Windows: every
 * reparse point on the way to `<entry>\git.exe` is resolved by locate() (junctions, symbolic links, volume
 * mount points; a link off the local fixed volumes skips the entry, or refuses if it is git.exe itself; any
 * other reparse type refuses). Then, for the workspace root and for git, the final volume-GUID path
 * (GetFinalPathNameByHandleW) and identity are read from an open handle; for every name of the binary (hard
 * links), every directory from it up to its volume root, and through every mount point of each volume crossed
 * up to a drive root, is opened and compared with the workspace root's identity. POSIX: realpath, then every
 * directory up to "/" by st_dev:st_ino. Any identity, attribute, final path or link list that cannot be read
 * fails closed. Returns the final drive-letter path of git.
 */
export function resolveGit(workspace: string, pathEnv: string | undefined = process.env.PATH, probe: Probe = probePath): string {
	const ws = probe(workspace, true);
	const rootPath = ws?.dos ?? workspace;
	if (!ws?.id || !ws.final) refuse("git-identity-unavailable", `cannot read the filesystem identity and final path of the workspace ${json(workspace)}`);
	const rootId = ws!.id!;
	const rootFinal = lower(ws!.final!).replace(/\\?$/, "\\");
	for (let entry of (pathEnv ?? "").split(delimiter)) {
		if (process.platform === "win32") entry = entry.replace(/^"(.*)"$/, "$1");
		if (untrustedLocation(entry) !== null) continue;
		const candidate = join(entry, GIT_EXE);
		let found: string;
		if (process.platform === "win32") {
			const loc = locate(candidate, probe);
			if (loc.kind === "missing") continue;
			if (loc.kind === "untrusted") {
				if (!loc.last) continue;
				refuse("git-untrusted-location", `PATH resolves git to ${json(candidate)}, which is not trusted: ${loc.why}`);
			}
			found = (loc as { path: string }).path;
		} else {
			const st = statOrNull(candidate);
			if (!st?.isFile()) continue;
			try {
				accessSync(candidate, fsConstants.X_OK);
			} catch {
				continue;
			}
			found = candidate;
		}
		const g = probe(found, process.platform !== "win32");
		if (!g) continue;
		if (g.attributes !== -1 && g.attributes & ATTR_DIRECTORY) continue;
		if (!g.id || !g.final || !g.dos || g.attributes === -1) refuse("git-identity-unavailable", `cannot read the filesystem identity and final path of ${json(candidate)}`);
		if (g.attributes & ATTR_REPARSE_POINT) refuse("git-reparse-unknown", `${json(candidate)} is a reparse point of type 0x${g.tag.toString(16)}`);
		const real = g.dos!;
		const why = untrustedLocation(real);
		if (why !== null) refuse("git-untrusted-location", `PATH resolves git to ${json(candidate)}, whose final path ${json(real)} is not trusted: ${why}`);
		if (process.platform === "win32" && lower(g.final!).startsWith(rootFinal)) refuse("git-inside-workspace", `PATH resolves git to ${json(candidate)} (final path ${json(g.final)}), inside the workspace being packaged ${json(ws!.final)}`);
		// Every name of the binary (hard links included), not only the one PATH reached it by.
		const names = process.platform === "win32" ? hardLinkNames(g.final!) : [g.final!];
		if (!names?.length) refuse("git-identity-unavailable", `cannot list the hard links of ${json(real)}`);
		const volumes = new Set<string>();
		for (const name of names!) {
			const n = probe(name, false);
			if (!n?.id || n.id !== g.id) refuse("git-identity-unavailable", `hard link ${json(name)} of ${json(real)} cannot be verified`);
			const parent = process.platform === "win32" ? guidParent(name) : dirname(name);
			if (parent === null) refuse("git-identity-unavailable", `${json(name)} has no parent directory`);
			assertOutside(parent!, rootId, rootPath, probe, name === g.final ? real : `${real}, also named ${name}`, volumes);
		}
		// The drive-letter name that will be spawned must still be the object that was checked.
		if (probe(real, true)?.id !== g.id) refuse("git-identity-unavailable", `${json(real)} no longer opens the checked git ${json(g.final)}`);
		return real;
	}
	return refuse("git-unavailable", `no ${GIT_EXE} in any trusted PATH entry`);
}

/** "git version X.Y.Z..." -> [X, Y, Z]; anything else -> null. */
export function parseGitVersion(text: string): [number, number, number] | null {
	const m = /^git version (\d+)\.(\d+)\.(\d+)(?=$|[.\-\s])/.exec(text);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Why packaging/verification require MIN_GIT_VERSION (kept as a stable public label). */
export const MIN_GIT_VERSION_REASON = "GIT_NO_LAZY_FETCH" as const;

export type GitVersionAssessment = {
	required: string;
	reason: typeof MIN_GIT_VERSION_REASON;
	detectedText: string;
	parsed: [number, number, number] | null;
	status: "ok" | "too_old" | "unknown";
	rule: null | "git-too-old" | "git-version-unknown";
	/** Operator-facing one-liner: requirement first, then detected result. */
	message: string;
};

function compareParsedGitVersion(a: readonly [number, number, number], b: readonly [number, number, number]): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Pure classification of `git --version` output against MIN_GIT_VERSION.
 * Used by packageCandidate (via checkGitVersion) and by scripts/verify.ts so verification
 * can announce the requirement before any packaging tests run — without a second gate.
 */
export function assessGitVersion(versionOutput: string): GitVersionAssessment {
	const required = MIN_GIT_VERSION;
	const reason = MIN_GIT_VERSION_REASON;
	const detectedText = versionOutput.trim();
	const parsed = parseGitVersion(detectedText);
	const requirement = `Git ${required} or newer is required for packaging verification (${reason})`;
	if (!parsed) {
		return {
			required,
			reason,
			detectedText,
			parsed: null,
			status: "unknown",
			rule: "git-version-unknown",
			message: `${requirement}; could not parse git --version output: ${json(detectedText.slice(0, 200))}`,
		};
	}
	const min = required.split(".").map(Number) as [number, number, number];
	if (compareParsedGitVersion(parsed, min) < 0) {
		return {
			required,
			reason,
			detectedText,
			parsed,
			status: "too_old",
			rule: "git-too-old",
			message: `${requirement}; detected ${json(detectedText)}`,
		};
	}
	return {
		required,
		reason,
		detectedText,
		parsed,
		status: "ok",
		rule: null,
		message: `${requirement}; detected ${json(detectedText)} (ok)`,
	};
}

/** git's environment: built from scratch; PATH is git's own directory only (no caller or workspace programs). */
function gitEnvironment(gitExe: string, root: string): Record<string, string | undefined> {
	return { ...isolatedGitEnvironment(root), PATH: dirname(gitExe) };
}

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64): 144 bytes; BasicLimitInformation.LimitFlags at offset 16. */
const JOB_EXTENDED_LIMITS = 9;
const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: 48 bytes; ActiveProcesses at offset 40. */
const JOB_ACCOUNTING = 1;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

/**
 * Windows: a job object that only this process holds (the handle is not inheritable). It allows no breakaway, so
 * every process a member starts is a member too: the Git for Windows launcher (cmd\git.exe), the real git it
 * starts, and anything git starts. TerminateJobObject ends all of them; closing the handle ends whatever is still
 * in it (KILL_ON_JOB_CLOSE), also if this process dies.
 */
class GitJob {
	private constructor(private readonly handle: bigint) {}
	static create(): GitJob {
		const handle = BigInt(k32().CreateJobObjectW(null, null));
		if (handle === 0n) refuse("git-unavailable", `cannot create a job object for git (Win32 error ${k32().GetLastError()})`);
		const job = new GitJob(handle);
		const limits = Buffer.alloc(144);
		limits.writeUInt32LE(JOB_LIMIT_KILL_ON_JOB_CLOSE, 16);
		if (!k32().SetInformationJobObject(handle, JOB_EXTENDED_LIMITS, limits, limits.length)) {
			const error = k32().GetLastError();
			job.close();
			refuse("git-unavailable", `cannot configure the job object for git (Win32 error ${error})`);
		}
		return job;
	}
	/** Puts the process `pid` (a child this process holds and has not reaped) in the job; null, or why not. */
	assign(pid: number): string | null {
		const child = BigInt(k32().OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA, 0, pid));
		if (child === 0n) return `OpenProcess failed (Win32 error ${k32().GetLastError()})`;
		try {
			return k32().AssignProcessToJobObject(this.handle, child) ? null : `AssignProcessToJobObject failed (Win32 error ${k32().GetLastError()})`;
		} finally {
			k32().CloseHandle(child);
		}
	}
	terminate(): void {
		k32().TerminateJobObject(this.handle, 1);
	}
	/** Processes still running in the job, or -1 if the job cannot be queried. */
	active(): number {
		const info = Buffer.alloc(48);
		return k32().QueryInformationJobObject(this.handle, JOB_ACCOUNTING, info, info.length, null) ? info.readUInt32LE(40) : -1;
	}
	/** Waits at most `ms` for the job to have no running process; returns the number still running (-1: unknown). */
	async emptied(ms: number): Promise<number> {
		for (const end = Date.now() + ms; ; await Bun.sleep(10)) {
			const n = this.active();
			if (n === 0 || Date.now() >= end) return n;
		}
	}
	close(): void {
		k32().CloseHandle(this.handle);
	}
}

/** First words a Windows git launcher writes to stderr (before exiting 127) when git itself cannot be started. */
const LAUNCH_FAILED = "candidate-package launcher: cannot start git: ";
/**
 * Windows: the program the same Bun runtime (process.execPath) runs as the direct child. It starts nothing before
 * it has read all of stdin, which the packager writes only after the launcher is in the job; then it runs git with
 * the argv, directory and environment given there, stdout and stderr inherited (the packager's pipes), and exits
 * with git's exit code. So git and everything it starts are in the job from their first instruction.
 */
const WIN_LAUNCHER = `const c=[];for await(const b of process.stdin)c.push(b);const r=JSON.parse(Buffer.concat(c).toString("utf8"));let p;try{p=Bun.spawn(r.argv,{cwd:r.cwd,env:r.env,stdin:"ignore",stdout:"inherit",stderr:"inherit"})}catch(e){process.stderr.write(${JSON.stringify(LAUNCH_FAILED)}+String(e));process.exit(127)}process.exit(await p.exited)`;
/** The launcher's own environment: nothing from the caller and no HOME (a Bun config there could preload code). */
const launcherEnvironment = () => ({ SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR });

/** Wall-clock bounds on each git child process, in milliseconds. */
export interface GitTimeouts {
	/** `git --version`. */
	versionMs: number;
	/** Each repository command (rev-parse, ls-files). */
	commandMs: number;
	/** After the process group (Windows: job object) is killed: how long to wait for its processes to end. */
	reapMs: number;
}
/**
 * git opens workspace-controlled files (.gitignore, .git/info/exclude, config include targets, .git, HEAD, the
 * index) with blocking open(2); a FIFO there blocks it forever. Every git child therefore has a deadline. The
 * largest measured inventory (30001 files, 2000 ignored directories, macOS) takes about 5 s for the whole run;
 * 120 s per repository command leaves more than 20x headroom on slow disks and still ends an unattended run.
 * `--version` reads no repository file; 30 s covers a cold xcrun shim. On expiry the child's process group is
 * killed (SIGKILL) and the child reaped (Windows: the job object holding git and every process it started is
 * terminated); the run is refused [git-timeout] before any output exists.
 */
export const GIT_TIMEOUTS: Readonly<GitTimeouts> = Object.freeze({ versionMs: 30_000, commandMs: 120_000, reapMs: 5_000 });

interface GitRun {
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	/** stdout or stderr exceeded the byte bound; the child was killed. */
	overflow: boolean;
}

/**
 * Runs the resolved git binary with argv from its own directory and the isolated environment. POSIX: the child
 * leads a new process group (setsid), so a deadline or output overflow kills it and everything it started with
 * one SIGKILL to the group; the group is signalled only while the child is unreaped or a member still exists,
 * so its id cannot have been reused. Windows: git is started by WIN_LAUNCHER inside a GitJob, and the whole job
 * is terminated (the Git for Windows cmd\git.exe is itself a launcher; ending only the direct child would leave
 * the real git running). Never waits past `timeoutMs` + `reapMs`.
 */
async function runGit(gitExe: string, root: string, argv: string[], timeoutMs: number, reapMs: number, maxBytes: number, what: string): Promise<GitRun> {
	if (process.platform !== "win32") return runGitIn(undefined, gitExe, root, argv, timeoutMs, reapMs, maxBytes, what);
	const job = GitJob.create();
	try {
		return await runGitIn(job, gitExe, root, argv, timeoutMs, reapMs, maxBytes, what);
	} finally {
		job.close();
	}
}
async function runGitIn(job: GitJob | undefined, gitExe: string, root: string, argv: string[], timeoutMs: number, reapMs: number, maxBytes: number, what: string): Promise<GitRun> {
	let proc: ReturnType<typeof Bun.spawn<"pipe" | "ignore", "pipe", "pipe">>;
	try {
		proc = job
			? Bun.spawn([process.execPath, "--no-env-file", "-e", WIN_LAUNCHER], { cwd: dirname(process.execPath), env: launcherEnvironment(), stdin: "pipe", stdout: "pipe", stderr: "pipe" })
			: Bun.spawn([gitExe, ...argv], { cwd: dirname(gitExe), env: gitEnvironment(gitExe, root), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
	} catch (error) {
		return refuse("git-unavailable", String(error));
	}
	const kill = () => {
		try {
			if (job) job.terminate();
			else process.kill(-proc.pid, "SIGKILL");
		} catch {
			// ESRCH: the group is already gone.
		}
	};
	if (job) {
		// The launcher is held unreaped here, so its pid names it; it starts git only after reading stdin.
		const why = job.assign(proc.pid);
		if (why !== null) {
			proc.kill("SIGKILL");
			const reaped = await reap(proc.exited, reapMs);
			return refuse("git-unavailable", `cannot put the git launcher in a job object: ${why}; git was not started and the launcher was killed${reaped ? "" : `, but had not exited ${reapMs} ms later`}`);
		}
		try {
			const stdin = proc.stdin as import("bun").FileSink;
			stdin.write(JSON.stringify({ argv: [gitExe, ...argv], cwd: dirname(gitExe), env: gitEnvironment(gitExe, root) }));
			await stdin.end();
		} catch (error) {
			kill();
			await reap(proc.exited, reapMs);
			return refuse("git-unavailable", `the git launcher did not accept its request: ${String(error)}`);
		}
	}
	let overflow = false;
	const readers = [proc.stdout.getReader(), proc.stderr.getReader()];
	const drain = async (reader: (typeof readers)[number]) => {
		const chunks: Buffer[] = [];
		let n = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks);
			n += value.length;
			if (n <= maxBytes) chunks.push(Buffer.from(value));
			else if (!overflow) {
				overflow = true;
				kill();
			}
		}
	};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((res) => (timer = setTimeout(() => res(null), timeoutMs)));
	const work = Promise.all([drain(readers[0]), drain(readers[1]), proc.exited]);
	let result: [Buffer, Buffer, number] | null;
	try {
		result = await Promise.race([work, deadline]);
	} catch (error) {
		kill();
		await reap(proc.exited, reapMs);
		return refuse("git-failed", `git ${what}: reading its output failed: ${String(error)}`);
	} finally {
		clearTimeout(timer);
	}
	if (result === null) {
		work.catch(() => {});
		kill();
		const started = Date.now();
		const reaped = await reap(proc.exited, reapMs);
		const left = job ? await job.emptied(Math.max(0, reapMs - (Date.now() - started))) : 0;
		for (const r of readers) r.cancel().catch(() => {});
		// Windows: the launcher is a member of the job, so an empty job means it has ended too.
		if (job) return refuse("git-timeout", `git ${what} did not finish within ${timeoutMs} ms; its job object (git and every process it started) was terminated${left === 0 ? " and every process in it ended" : `, but ${left < 0 ? "an unknown number of" : left} process(es) in it had not ended ${reapMs} ms later`}`);
		return refuse("git-timeout", `git ${what} did not finish within ${timeoutMs} ms; its process group was killed${reaped ? " and the child reaped" : `, but the child had not exited ${reapMs} ms later`}`);
	}
	const stderr = result[1].toString("utf8").trim();
	if (job && proc.exitCode === 127 && stderr.startsWith(LAUNCH_FAILED)) refuse("git-unavailable", stderr.slice(0, 500));
	return { exitCode: proc.exitCode, stdout: result[0], stderr, overflow };
}
/** Waits at most `ms` for an exit; true when it happened. */
async function reap(exited: Promise<number>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([exited.then(() => true), new Promise<boolean>((res) => (timer = setTimeout(() => res(false), ms)))]);
	} finally {
		clearTimeout(timer);
	}
}

/** Refuses a git that cannot be identified or is older than MIN_GIT_VERSION, before any repository command. */
export async function checkGitVersion(gitExe: string, root: string, timeouts: GitTimeouts = GIT_TIMEOUTS): Promise<void> {
	const r = await runGit(gitExe, root, ["--version"], timeouts.versionMs, timeouts.reapMs, GIT_VERSION_MAX, "--version");
	const text = r.stdout.toString("utf8").trim();
	if (r.exitCode !== 0 || r.overflow) {
		return refuse("git-version-unknown", `${json(gitExe)} --version exited ${r.exitCode}: ${json(text.slice(0, 200))}`);
	}
	const assessment = assessGitVersion(text);
	if (assessment.status === "ok") return;
	if (assessment.rule === "git-too-old") {
		refuse("git-too-old", `${json(gitExe)} is ${json(assessment.detectedText)}; ${assessment.required} or newer is required (${assessment.reason})`);
	}
	refuse("git-version-unknown", `${json(gitExe)} --version: ${json(assessment.detectedText.slice(0, 200))}`);
}

/** Runs the resolved git binary from its own directory (outside the workspace); -C selects the repository. */
async function git(gitExe: string, root: string, args: string[], timeouts: GitTimeouts): Promise<string> {
	const r = await runGit(gitExe, root, [...GIT_OPTIONS, "-C", root, ...args], timeouts.commandMs, timeouts.reapMs, GIT_STDOUT_MAX, args.join(" "));
	if (r.overflow) refuse("git-output-too-large", `git ${args.join(" ")} exceeded ${GIT_STDOUT_MAX} bytes`);
	if (r.exitCode !== 0) refuse("git-failed", `git ${args.join(" ")} exited ${r.exitCode}: ${r.stderr}`);
	// Git reports skipped/unreadable paths ("Filename too long", "could not open directory") as
	// warnings with exit 0. Any stderr output means the listing may be incomplete.
	if (r.stderr) refuse("git-stderr", `git ${args.join(" ")} wrote to stderr: ${r.stderr.slice(0, 500)}`);
	return r.stdout.toString("utf8");
}
const zlist = (s: string) => s.split("\0").filter(Boolean);

// ---------------------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------------------
/** Exact set comparison between the git inventory and the independent filesystem walk. */
export function assertComplete(expected: ReadonlySet<string>, found: ReadonlySet<string>, tracked: ReadonlySet<string>): void {
	const missing = [...expected].filter((p) => !found.has(p)).sort();
	const deleted = missing.filter((p) => tracked.has(p));
	if (deleted.length) refuse("tracked-file-missing", `tracked path(s) absent from the working tree: ${json(deleted.slice(0, 10))}`);
	const unlisted = [...found].filter((p) => !expected.has(p)).sort();
	if (missing.length || unlisted.length)
		refuse("completeness-mismatch", `git inventory and filesystem walk differ; only-git=${json(missing.slice(0, 10))} only-filesystem=${json(unlisted.slice(0, 10))}`);
}

function isUnder(path: string, dirs: Iterable<string>): boolean {
	for (const d of dirs) if (path === d || path.startsWith(d + "/")) return true;
	return false;
}

/** Mirrors git's is_git_directory(): objects/ and refs/ directories and a valid HEAD (no links followed). */
function isBareRepository(dir: string): boolean {
	const objects = lstatOrNull(join(dir, "objects"));
	const refs = lstatOrNull(join(dir, "refs"));
	const head = lstatOrNull(join(dir, "HEAD"));
	if (!objects?.isDirectory() || !refs?.isDirectory() || !head?.isFile() || head.size > 4096) return false;
	const fd = openRegular(join(dir, "HEAD"));
	if (fd === null) return false;
	let text: string;
	try {
		text = readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
	return /^(?:ref: refs\/[^\0\n]+|[0-9a-f]{40}|[0-9a-f]{64})\n?$/.test(text);
}

interface Inventory {
	files: { path: string; mode: number; full: string }[];
	exclusions: Manifest["exclusions"];
}

async function inventory(git: (args: string[]) => Promise<string>, root: string, limits: Limits): Promise<Inventory> {
	const exclusions: Manifest["exclusions"] = [];
	const stage = zlist(await git(["ls-files", "-z", "--stage", "--full-name"]));
	const tracked = new Map<string, number>();
	const gitlinks = new Set<string>();
	for (const line of stage) {
		const tab = line.indexOf("\t");
		const mode = line.slice(0, 6);
		const path = line.slice(tab + 1);
		if (tab < 0) refuse("git-unexpected-output", json(line));
		if (line.slice(tab - 1, tab) !== "0") refuse("unmerged-index-entry", `resolve the merge conflict first: ${json(path)}`);
		if (mode === "160000") gitlinks.add(path);
		else if (mode === "120000") refuse("symlink", `tracked symbolic link: ${json(path)}`);
		else if (mode === "100644" || mode === "100755") tracked.set(path, mode === "100755" ? 0o755 : 0o644);
		else refuse("git-unexpected-output", `index mode ${mode} for ${json(path)}`);
	}
	for (const g of gitlinks) exclusions.push({ path: g + "/", reason: "submodule" });
	const ignored = zlist(await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"]));
	const ignoredDirs = ignored.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1));
	const ignoredFiles = new Set(ignored.filter((p) => !p.endsWith("/")));
	const untracked = zlist(await git(["ls-files", "-z", "--others", "--exclude-standard"]));
	const nestedRepos = new Set(untracked.filter((p) => p.endsWith("/")).map((p) => p.slice(0, -1)));
	const trackedDirs = new Set<string>();
	for (const p of tracked.keys()) for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) trackedDirs.add(p.slice(0, i));
	const trackedUnder = (dir: string) => trackedDirs.has(dir);

	// Independent filesystem enumeration.
	const found = new Set<string>();
	const excludedDirs: string[] = [...gitlinks];
	const fsCall = <T>(p: string, fn: () => T): T => {
		try {
			return fn();
		} catch (error: any) {
			return refuse("filesystem-unreadable", `${json(p || ".")}: ${error?.code ?? error}`);
		}
	};
	const walk = (rel: string) => {
		const dir = rel ? join(root, ...rel.split("/")) : root;
		for (const ent of fsCall(rel, () => readdirSync(dir, { withFileTypes: true }))) {
			const p = rel ? `${rel}/${ent.name}` : ent.name;
			const full = join(dir, ent.name);
			if (!rel && ent.name.toLowerCase() === ".git") {
				exclusions.push({ path: ent.name, reason: "git-dir" });
				continue;
			}
			if (gitlinks.has(p)) continue;
			const st = fsCall(p, () => lstatSync(full));
			const ignoredDir = ignoredDirs.includes(p) && !trackedUnder(p);
			if (ignoredFiles.has(p) && !tracked.has(p)) {
				exclusions.push({ path: p, reason: "ignored" });
				continue;
			}
			if (ignoredDir) {
				exclusions.push({ path: p + "/", reason: "ignored" });
				continue;
			}
			if (st.isSymbolicLink()) refuse("symlink", `symbolic link or junction in working tree: ${json(p)}`);
			if (st.isDirectory()) {
				const names = fsCall(p, () => readdirSync(full));
				if (names.some((n) => n.toLowerCase() === ".git")) {
					if (trackedUnder(p)) refuse("nested-repository-with-tracked-content", json(p));
					// Git itself decides: it reports a nested repository as "dir/" instead of listing its files.
					if (!nestedRepos.has(p))
						refuse("nested-git-entry-not-repository", `${json(p + "/")} has a .git entry that git does not treat as a repository (git lists the directory's files as untracked, but never the .git entry)`);
					exclusions.push({ path: p + "/", reason: "nested-repository" });
					excludedDirs.push(p);
					continue;
				}
				if (!trackedUnder(p) && names.includes("HEAD") && names.includes("objects") && names.includes("refs")) {
					// Git lists a bare repository's files as untracked; exclude them only if it really is one.
					if (!isBareRepository(full))
						refuse("nested-bare-repository-unrecognized", `${json(p + "/")} has HEAD/objects/refs entries but is not a bare repository (objects/ and refs/ directories, HEAD a symbolic ref or object id)`);
					exclusions.push({ path: p + "/", reason: "nested-bare-repository" });
					excludedDirs.push(p);
					continue;
				}
				walk(p);
				continue;
			}
			if (!st.isFile()) refuse("non-regular-file", `not a regular file: ${json(p)}`);
			if (st.nlink > 1) refuse("hardlink", `file has ${st.nlink} hard links (bytes may belong to another tree): ${json(p)}`);
			if (isUnder(p, ignoredDirs) && !tracked.has(p)) {
				exclusions.push({ path: p, reason: "ignored" });
				continue;
			}
			found.add(p);
		}
	};
	walk("");

	const untrackedFiles: string[] = [];
	for (const p of untracked) {
		if (isUnder(p.replace(/\/$/, ""), excludedDirs)) continue;
		if (p.endsWith("/")) refuse("git-unexpected-output", `unexpected directory entry from git: ${json(p)}`);
		untrackedFiles.push(p);
	}
	const expected = new Set([...tracked.keys(), ...untrackedFiles]);
	const all = [...expected].sort();
	for (const p of all) safePath(p, limits);
	checkCollisions(all);
	assertComplete(expected, found, new Set(tracked.keys()));
	if (all.length > limits.members) refuse("bound-member-count", `${all.length} files > ${limits.members}`);
	return {
		files: all.map((path) => ({ path, mode: tracked.get(path) ?? 0o644, full: join(root, ...path.split("/")) })),
		exclusions: exclusions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
	};
}

/** Streams one regular file in fixed chunks; refuses if it changes size while being read. */
async function readFileChunks(full: string, path: string, size: number, onChunk: (b: Buffer) => unknown): Promise<string> {
	let opened: number | null;
	try {
		opened = openRegular(full);
	} catch (error: any) {
		return refuse("filesystem-unreadable", `${json(path)}: ${error?.code ?? error}`);
	}
	if (opened === null) return refuse("file-changed-during-package", `no longer a regular file: ${json(path)}`);
	const fd = opened;
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size !== size) refuse("file-changed-during-package", json(path));
		const h = createHash("sha256");
		const buf = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
		let done = 0;
		while (done < size) {
			const n = readSync(fd, buf, 0, Math.min(buf.length, size - done), done);
			if (n <= 0) refuse("file-changed-during-package", `short read: ${json(path)}`);
			const c = buf.subarray(0, n);
			h.update(c);
			await onChunk(c);
			done += n;
		}
		if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) refuse("file-changed-during-package", `grew while reading: ${json(path)}`);
		return h.digest("hex");
	} finally {
		closeSync(fd);
	}
}

function statOrNull(p: string): Stats | null {
	try {
		return statSync(p);
	} catch {
		return null;
	}
}

function lstatOrNull(p: string): Stats | null {
	try {
		return lstatSync(p);
	} catch (error: any) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

export interface PackageOptions {
	/**
	 * Test seam: the search path resolveGit() is given instead of process.env.PATH. Every trust check of
	 * resolveGit() still applies (absolute entries only, final path and identity outside the workspace).
	 */
	gitSearchPath?: string;
	/** Test seam: shorter bounds for the git children than GIT_TIMEOUTS. */
	gitTimeouts?: Partial<GitTimeouts>;
}

export async function packageCandidate(workspace: string, output: string, limits: Limits = LIMITS, options: PackageOptions = {}): Promise<string> {
	let root = "";
	try {
		root = realpathSync.native(workspace);
	} catch (error: any) {
		refuse("workspace-missing", `${json(workspace)}: ${error?.code ?? error}`);
	}
	// The parent may be reached through links (macOS /tmp -> private/tmp): containment and the O_EXCL create below
	// use its final path, and only the output name itself must not be a link.
	const parent = statOrNull(dirname(resolve(output)));
	if (!parent?.isDirectory()) refuse("output-parent-missing", json(dirname(resolve(output))));
	const out = join(realpathSync.native(dirname(resolve(output))), basename(output));
	const rel = relative(root, out);
	if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) refuse("output-inside-workspace", json(out));
	const sidecar = out + ".manifest.json";
	for (const target of [out, sidecar]) if (lstatOrNull(target)) refuse("output-exists", `refusing to overwrite or follow existing path: ${json(target)}`);
	const gitExe = resolveGit(root, options.gitSearchPath);
	const timeouts: GitTimeouts = { ...GIT_TIMEOUTS, ...options.gitTimeouts };
	await checkGitVersion(gitExe, root, timeouts);
	const run = (args: string[]) => git(gitExe, root, args, timeouts);
	const top = (await run(["rev-parse", "--show-toplevel"])).trim();
	let topFinal: string | null = null;
	try {
		if (isAbsolute(top)) topFinal = realpathSync.native(top);
	} catch {
		// Not an existing path: refused below.
	}
	if (topFinal === null) refuse("git-unexpected-output", `git rev-parse --show-toplevel printed ${json(top.slice(0, 200))}, which is not an existing absolute path`);
	if (topFinal !== root) refuse("workspace-not-repository-root", `${json(root)} is not the top level (${json(top)})`);
	const baseCommit = (await run(["rev-parse", "--verify", "HEAD^{commit}"])).trim();
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) refuse("git-unexpected-output", `git rev-parse --verify HEAD^{commit} printed ${json(baseCommit.slice(0, 200))}, which is not a full object id`);

	const inv = await inventory(run, root, limits);
	const files: ManifestFile[] = [];
	let total = 0;
	for (const f of inv.files) {
		const st = lstatSync(f.full);
		if (!st.isFile()) refuse("file-changed-during-package", json(f.path));
		if (st.size > limits.memberBytes) refuse("bound-member-size", `${f.path}: ${st.size} bytes > ${limits.memberBytes}`);
		tarHeader(f.path, st.size, f.mode);
		const digest = await readFileChunks(f.full, f.path, st.size, () => {});
		files.push({ path: f.path, size: st.size, sha256: digest, mode: f.mode });
		total += 512 + pad512(st.size);
	}
	let identity: unknown = null;
	const idPath = join(root, ".fleet-identity.json");
	const idStat = lstatOrNull(idPath);
	if (idStat) {
		if (!idStat.isFile() || idStat.size > IDENTITY_MAX) refuse("identity-invalid", "identity must be a regular file <= 64 KiB");
		let fd: number | null = null;
		try {
			fd = openRegular(idPath);
		} catch {
			refuse("identity-invalid", "identity is not JSON");
		}
		if (fd === null) refuse("identity-invalid", "identity must be a regular file <= 64 KiB");
		try {
			identity = JSON.parse(readFileSync(fd!, "utf8"));
		} catch {
			refuse("identity-invalid", "identity is not JSON");
		} finally {
			closeSync(fd!);
		}
	}
	const manifest: Manifest = { toolVersion: VERSION, baseCommit, identity, exclusions: inv.exclusions, files };
	const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
	if (manifestBytes.length > limits.manifestBytes) refuse("bound-manifest-size", `${manifestBytes.length} > ${limits.manifestBytes}`);
	total += 512 + pad512(manifestBytes.length) + TRAILER_MIN;
	if (total > limits.uncompressedBytes) refuse("bound-uncompressed-total", `${total} > ${limits.uncompressedBytes}`);

	// "wx" = O_CREAT|O_EXCL: never follows or replaces a pre-existing (possibly dangling) link.
	const created: string[] = [];
	try {
		const fd = openSync(out, "wx+");
		created.push(out);
		try {
			const gz = createGzip({ level: 9 });
			let written = 0;
			const sink = new Promise<void>((res, rej) => {
				gz.on("data", (c: Buffer) => {
					writeSync(fd, c, 0, c.length, written);
					written += c.length;
				});
				gz.on("end", res);
				gz.on("error", rej);
			});
			// Honour backpressure so at most a few chunks are buffered (constant memory).
			const put = async (b: Buffer) => {
				if (!gz.write(Buffer.from(b))) await once(gz, "drain");
			};
			const padding = async (size: number) => {
				if (size % 512) await put(Buffer.alloc(512 - (size % 512)));
			};
			await put(tarHeader(MANIFEST_MEMBER, manifestBytes.length, 0o644));
			await put(manifestBytes);
			await padding(manifestBytes.length);
			for (const f of files) {
				await put(tarHeader(f.path, f.size, f.mode));
				const again = await readFileChunks(join(root, ...f.path.split("/")), f.path, f.size, put);
				if (again !== f.sha256) refuse("file-changed-during-package", `content changed between hash and archive: ${json(f.path)}`);
				await padding(f.size);
			}
			await put(Buffer.alloc(TRAILER_MIN));
			gz.end();
			await sink;
			if (written > limits.compressedBytes) refuse("bound-compressed-size", `${written} > ${limits.compressedBytes}`);
			const head = Buffer.alloc(10);
			readSync(fd, head, 0, 10, 0);
			if (!head.subarray(0, 9).equals(GZIP_HEADER.subarray(0, 9))) refuse("gzip-header", `unexpected compressor header ${head.toString("hex")}`);
			// The OS byte is not content; normalize it so hashes are platform-independent.
			writeSync(fd, Buffer.from([0xff]), 0, 1, 9);
		} finally {
			closeSync(fd);
		}
		const mfd = openSync(sidecar, "wx");
		created.push(sidecar);
		try {
			writeSync(mfd, manifestBytes);
		} finally {
			closeSync(mfd);
		}
		return await sha256File(out, limits.compressedBytes);
	} catch (error) {
		for (const p of created) unlinkSync(p);
		throw error;
	}
}

// ---------------------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------------------
/** Hashes an open descriptor from offset 0 to its end in fixed chunks (the descriptor stays open). */
function sha256Fd(fd: number, path: string, maxBytes: number): string {
	const h = createHash("sha256");
	const buf = Buffer.alloc(64 * 1024);
	let n = 0;
	for (let r; (r = readSync(fd, buf, 0, buf.length, n)) > 0; ) {
		n += r;
		if (n > maxBytes) refuse("bound-compressed-size", `${path} exceeds ${maxBytes} bytes`);
		h.update(buf.subarray(0, r));
	}
	return h.digest("hex");
}
function sha256File(path: string, maxBytes: number): string {
	const fd = openRegular(path);
	if (fd === null) return refuse("input-not-regular-file", json(path));
	try {
		return sha256Fd(fd, path, maxBytes);
	} finally {
		closeSync(fd);
	}
}
/** Both descriptors are the same file (st_dev + st_ino; Windows: volume serial number + file id). */
function sameFile(a: number, b: number): boolean {
	const x = fstatSync(a, { bigint: true });
	const y = fstatSync(b, { bigint: true });
	return x.dev === y.dev && x.ino === y.ino;
}

function readBounded(path: string, max: number, rule: string): Buffer {
	const st = lstatOrNull(path);
	if (!st?.isFile()) refuse("input-not-regular-file", json(path));
	if (st!.size > max) refuse(rule, `${st!.size} bytes > ${max}: ${json(path)}`);
	const opened = openRegular(path);
	if (opened === null) return refuse("input-not-regular-file", json(path));
	const fd = opened;
	try {
		const buf = Buffer.alloc(st!.size + 1);
		let n = 0;
		for (let r; (r = readSync(fd, buf, n, buf.length - n, n)) > 0; ) n += r;
		if (n > st!.size || n > max) refuse(rule, `grew while reading: ${json(path)}`);
		return buf.subarray(0, n);
	} finally {
		closeSync(fd);
	}
}

function validateManifest(bytes: Buffer, limits: Limits): Manifest {
	let m: any;
	try {
		m = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		refuse("manifest-invalid-json", "manifest is not valid UTF-8 JSON");
	}
	if (!m || typeof m !== "object" || Array.isArray(m)) refuse("manifest-invalid", "manifest is not an object");
	const keys = Object.keys(m).sort().join(",");
	if (keys !== "baseCommit,exclusions,files,identity,toolVersion") refuse("manifest-invalid", `unexpected keys ${keys}`);
	if (m.toolVersion !== VERSION) refuse("manifest-version", `toolVersion ${json(m.toolVersion)} != ${VERSION}`);
	if (typeof m.baseCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(m.baseCommit)) refuse("manifest-invalid", "baseCommit is not a full object id");
	if (!Array.isArray(m.exclusions) || !m.exclusions.every((e: any) => e && typeof e.path === "string" && typeof e.reason === "string" && Object.keys(e).length === 2))
		refuse("manifest-invalid", "exclusions must be {path, reason} entries");
	let previousExclusion: string | undefined;
	for (const e of m.exclusions as Manifest["exclusions"]) {
		checkExclusion(e);
		if (previousExclusion !== undefined && !(previousExclusion < e.path)) refuse("manifest-not-sorted", `exclusions: ${json(previousExclusion)} then ${json(e.path)}`);
		previousExclusion = e.path;
	}
	if (!Array.isArray(m.files)) refuse("manifest-invalid", "files must be an array");
	if (m.files.length > limits.members) refuse("bound-member-count", `${m.files.length} files > ${limits.members}`);
	let previous: string | undefined;
	const lower = new Set<string>();
	for (const f of m.files) {
		if (!f || typeof f !== "object" || Object.keys(f).sort().join(",") !== "mode,path,sha256,size") refuse("manifest-invalid", `bad file entry ${json(f)?.slice(0, 120)}`);
		safePath(f.path, limits);
		if (previous !== undefined && !(previous < f.path)) refuse("manifest-not-sorted", `${json(previous)} then ${json(f.path)}`);
		previous = f.path;
		if (lower.has(caseKey(f.path))) refuse("path-case-collision", json(f.path));
		lower.add(caseKey(f.path));
		if (!Number.isSafeInteger(f.size) || f.size < 0) refuse("manifest-invalid", `size for ${json(f.path)}`);
		if (f.size > limits.memberBytes) refuse("bound-member-size", `${f.path}: ${f.size} bytes > ${limits.memberBytes}`);
		if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256)) refuse("manifest-invalid", `sha256 for ${json(f.path)}`);
		if (f.mode !== 0o644 && f.mode !== 0o755) refuse("manifest-invalid", `mode for ${json(f.path)}`);
	}
	checkCollisions(m.files.map((f: ManifestFile) => f.path));
	return m as Manifest;
}

const EXCLUSION_REASONS: ReadonlySet<string> = new Set<ExclusionReason>(["git-dir", "nested-repository", "nested-bare-repository", "submodule", "ignored"]);
/**
 * An exclusion is what the packager writes: a known reason and a relative path of directory-entry names
 * (no empty, "." or ".." segment, no NUL), with a trailing "/" exactly for directories. "git-dir" is the
 * top-level .git entry (any case); submodules and nested repositories are directories; "ignored" is either.
 * Names are not held to safePath(): ignored entries are never archived, and the packager lists them as they
 * are on disk (Windows-reserved characters, NFD, ...), so packages it wrote earlier must still verify.
 */
function checkExclusion(e: { path: string; reason: string }): void {
	const bad = (why: string) => refuse("manifest-invalid", `exclusion ${json(e.path.slice(0, 200))} (${json(e.reason.slice(0, 40))}): ${why}`);
	if (!EXCLUSION_REASONS.has(e.reason)) bad(`reason must be one of ${json([...EXCLUSION_REASONS])}`);
	const dir = e.path.endsWith("/");
	const body = dir ? e.path.slice(0, -1) : e.path;
	if (body.split("/").some((seg) => seg === "" || seg === "." || seg === ".." || seg.includes("\0"))) bad("not a relative path of entry names");
	if (e.reason === "git-dir" && (dir || body.includes("/") || body.toLowerCase() !== ".git")) bad("git-dir must be the top-level .git entry");
	if ((e.reason === "submodule" || e.reason === "nested-repository" || e.reason === "nested-bare-repository") && !dir) bad(`${e.reason} must be a directory (trailing "/")`);
}

/** Incremental restricted-USTAR checker; holds at most one header block plus a hash state. */
class TarStream {
	private block = Buffer.alloc(512);
	private fill = 0;
	private index = 0;
	private remaining = 0;
	private padding = 0;
	private hash: ReturnType<typeof createHash> | null = null;
	private trailer = 0;
	private inTrailer = false;
	total = 0;
	constructor(
		private readonly members: ManifestFile[],
		private readonly maxTotal: number,
		private readonly limits: Limits,
	) {}
	feed(chunk: Buffer): void {
		this.total += chunk.length;
		if (this.total > this.maxTotal) refuse("bound-uncompressed-total", `inflated stream exceeds ${this.maxTotal} bytes implied by the manifest/limits`);
		let i = 0;
		while (i < chunk.length) {
			if (this.remaining > 0) {
				const n = Math.min(this.remaining, chunk.length - i);
				this.hash!.update(chunk.subarray(i, i + n));
				this.remaining -= n;
				i += n;
				if (this.remaining === 0) this.endData();
				continue;
			}
			if (this.padding > 0) {
				const n = Math.min(this.padding, chunk.length - i);
				for (let k = i; k < i + n; k++) if (chunk[k] !== 0) refuse("tar-padding-nonzero", `after ${json(this.members[this.index - 1].path)}`);
				this.padding -= n;
				i += n;
				continue;
			}
			if (this.inTrailer) {
				for (let k = i; k < chunk.length; k++) if (chunk[k] !== 0) refuse("tar-trailer-invalid", "data after end-of-archive blocks");
				this.trailer += chunk.length - i;
				i = chunk.length;
				continue;
			}
			const n = Math.min(512 - this.fill, chunk.length - i);
			chunk.copy(this.block, this.fill, i, i + n);
			this.fill += n;
			i += n;
			if (this.fill === 512) {
				this.fill = 0;
				this.header(this.block);
			}
		}
	}
	private endData(): void {
		const f = this.members[this.index - 1];
		if (this.hash!.digest("hex") !== f.sha256) refuse(this.index === 1 ? "manifest-sidecar-mismatch" : "tar-member-content-mismatch", json(f.path));
		this.hash = null;
		this.padding = pad512(f.size) - f.size;
	}
	private header(h: Buffer): void {
		if (h.every((b) => b === 0)) {
			if (this.index < this.members.length) refuse("tar-member-missing", `expected ${json(this.members[this.index].path)}`);
			this.inTrailer = true;
			this.trailer = 512;
			return;
		}
		const field = (a: number, b: number) => {
			const raw = h.subarray(a, b);
			const z = raw.indexOf(0);
			return z < 0 ? raw : raw.subarray(0, z);
		};
		const octal = (a: number, b: number, what: string) => {
			const s = field(a, b).toString("latin1").trim();
			if (!/^[0-7]{1,12}$/.test(s)) refuse("tar-header-invalid", `${what} field is not octal`);
			return parseInt(s, 8);
		};
		let sum = 0;
		for (let k = 0; k < 512; k++) sum += k >= 148 && k < 156 ? 32 : h[k];
		if (sum !== octal(148, 156, "checksum")) refuse("tar-header-checksum", `member #${this.index}`);
		if (field(257, 263).toString("latin1") !== "ustar" || h[262] !== 0 || h.subarray(263, 265).toString("latin1") !== "00") refuse("tar-format-unsupported", "only POSIX USTAR is accepted");
		if (h[156] !== 48) refuse("tar-member-type", `typeflag ${h[156]} (only regular files '0' are accepted)`);
		if (field(0, 100).length === 0) refuse("tar-empty-name-field", "member name field is empty (prefix-only names are ambiguous)");
		let name: string;
		try {
			const dec = new TextDecoder("utf-8", { fatal: true });
			const prefix = dec.decode(field(345, 500));
			const leaf = dec.decode(field(0, 100));
			name = prefix ? `${prefix}/${leaf}` : leaf;
		} catch {
			return refuse("tar-name-invalid-utf8", `member #${this.index}`);
		}
		if (this.index > 0) safePath(name, this.limits);
		const f = this.members[this.index];
		if (!f || name !== f.path) refuse("tar-member-unexpected", `${json(name)} where ${f ? json(f.path) : "end of archive"} was expected`);
		const size = octal(124, 136, "size");
		if (size > this.limits.memberBytes) refuse("bound-member-size", `${name}: ${size} bytes > ${this.limits.memberBytes}`);
		if (size !== f.size) refuse(this.index === 0 ? "manifest-sidecar-mismatch" : "tar-member-size-mismatch", `${name}: ${size} != ${f.size}`);
		if (octal(100, 108, "mode") !== f.mode) refuse("tar-member-mode-mismatch", name);
		if (!h.equals(tarHeader(f.path, f.size, f.mode))) refuse("tar-header-noncanonical", `${name}: uid/gid/mtime/owner/link/split fields differ from the canonical header`);
		this.index++;
		this.hash = createHash("sha256");
		this.remaining = size;
		if (size === 0) this.endData();
	}
	finish(): void {
		if (this.remaining > 0 || this.padding > 0 || this.fill !== 0) refuse("tar-truncated", "archive ends inside a member");
		if (this.index < this.members.length) refuse("tar-member-missing", `expected ${json(this.members[this.index].path)}`);
		if (!this.inTrailer || this.trailer < TRAILER_MIN) refuse("tar-trailer-invalid", "missing two zero end-of-archive blocks");
		if (this.trailer > TRAILER_MAX || this.total % 512 !== 0) refuse("tar-trailer-invalid", `trailer of ${this.trailer} bytes`);
	}
}

export interface VerifyResult {
	sha256: string;
	files: number;
}

export async function verifyCandidate(archive: string, manifestPath: string, expectedHash?: string, expectedFiles?: unknown, limitOverrides: Partial<Limits> = {}): Promise<VerifyResult> {
	const limits: Limits = { ...LIMITS, ...limitOverrides };
	if (expectedHash !== undefined && (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash)))
		refuse("expected-sha256-malformed", `expected SHA256 must be 64 lowercase hex characters, got ${json(String(expectedHash).slice(0, 80))}`);
	// Bounds before any decompression.
	const st = lstatOrNull(archive);
	if (!st?.isFile()) refuse("archive-not-regular-file", json(archive));
	if (st!.size > limits.compressedBytes) refuse("bound-compressed-size", `${st!.size} bytes > ${limits.compressedBytes}`);
	if (st!.size < GZIP_HEADER.length + 8) refuse("gzip-header", "archive too small for gzip");
	const sidecar = readBounded(manifestPath, limits.manifestBytes, "bound-manifest-size");
	const m = validateManifest(sidecar, limits);
	if (expectedFiles !== undefined) {
		if (!Array.isArray(expectedFiles) || !expectedFiles.every((p) => typeof p === "string")) refuse("expected-list-invalid", "expected files must be a JSON array of strings");
		const want = [...(expectedFiles as string[])].sort();
		const have = m.files.map((f) => f.path);
		if (json(want) !== json(have)) refuse("expected-list-mismatch", `manifest files differ from the expected list (${have.length} vs ${want.length})`);
	}
	const members: ManifestFile[] = [{ path: MANIFEST_MEMBER, size: sidecar.length, sha256: sha256(sidecar), mode: 0o644 }, ...m.files];
	const body = members.reduce((n, f) => n + 512 + pad512(f.size), 0);
	if (body + TRAILER_MIN > limits.uncompressedBytes) refuse("bound-uncompressed-total", `manifest implies ${body + TRAILER_MIN} bytes > ${limits.uncompressedBytes}`);
	const maxTotal = Math.min(body + TRAILER_MAX, limits.uncompressedBytes);

	// Every read below goes through this one descriptor of the checked regular file.
	const size = st!.size;
	const opened = openRegular(archive);
	if (opened === null) return refuse("archive-not-regular-file", json(archive));
	const fd = opened;
	try {
		return await verifyOpenArchive(fd, archive, size, members, maxTotal, limits, m, expectedHash);
	} finally {
		closeSync(fd);
	}
}

async function verifyOpenArchive(fd: number, archive: string, size: number, members: ManifestFile[], maxTotal: number, limits: Limits, m: Manifest, expectedHash: string | undefined): Promise<VerifyResult> {
	// Pass 1: hash the compressed bytes (streamed) and check the trusted hash before inflating.
	const digest = sha256Fd(fd, archive, limits.compressedBytes);
	if (expectedHash !== undefined && digest !== expectedHash) refuse("sha256-mismatch", `package SHA256 ${digest} != expected ${expectedHash}`);
	const head = Buffer.alloc(10);
	const tail = Buffer.alloc(8);
	if (fstatSync(fd).size !== size) refuse("archive-changed-during-verify", json(archive));
	readSync(fd, head, 0, 10, 0);
	readSync(fd, tail, 0, 8, size - 8);
	if (!head.equals(GZIP_HEADER)) refuse("gzip-header", `header ${head.toString("hex")} is not the canonical packager header`);

	// Pass 2: re-hash while inflating the raw deflate body; bounded output, constant memory.
	const tar = new TarStream(members, maxTotal, limits);
	const again = createHash("sha256").update(head);
	let crc = 0;
	const inflate = createInflateRaw({ chunkSize: 64 * 1024 });
	// The stream owns (and closes) a second descriptor of the same checked file: Bun's destroy() closes a
	// stream's descriptor even with autoClose false.
	const streamFd = openRegular(archive);
	if (streamFd === null || !sameFile(streamFd, fd)) {
		if (streamFd !== null) closeSync(streamFd);
		refuse("archive-changed-during-verify", json(archive));
	}
	const input = createReadStream("", { fd: streamFd!, start: 10, end: size - 9, highWaterMark: 64 * 1024 });
	try {
		await new Promise<void>((res, rej) => {
			const fail = (e: unknown) => {
				input.unpipe(inflate);
				inflate.destroy();
				rej(e);
			};
			inflate.on("data", (c: Buffer) => {
				try {
					crc = crc32(c, crc);
					tar.feed(c);
				} catch (e) {
					fail(e);
				}
			});
			inflate.on("error", (e) => fail(new CandidateRefusal("gzip-corrupt", String(e))));
			inflate.on("end", res);
			input.on("data", (c) => again.update(c as Buffer));
			input.on("error", fail);
			input.pipe(inflate);
		});
	} finally {
		input.destroy();
	}
	if (inflate.bytesWritten !== size - 18) refuse("gzip-trailing-data", `deflate stream ends at byte ${inflate.bytesWritten + 10} of ${size}`);
	tar.finish();
	if (tail.readUInt32LE(0) !== crc >>> 0 || tail.readUInt32LE(4) !== tar.total % 2 ** 32) refuse("gzip-trailer-mismatch", "CRC32/ISIZE do not match the inflated stream");
	if (again.update(tail).digest("hex") !== digest) refuse("archive-changed-during-verify", json(archive));
	return { sha256: digest, files: m.files.length };
}

const USAGE = "Usage: package WORKSPACE OUTPUT.tar.gz | verify ARCHIVE MANIFEST [SHA256|-] [EXPECTED_FILES.json]";
async function main(argv: string[]): Promise<void> {
	const [cmd, a, b, c, d, ...rest] = argv;
	if (cmd === "package" && a && b && c === undefined) {
		console.log(await packageCandidate(a, b));
		return;
	}
	if (cmd === "verify" && a && b && rest.length === 0) {
		const hash = c === undefined || c === "-" ? undefined : c;
		const list = d === undefined ? undefined : (() => {
			try {
				return JSON.parse(readBounded(d, LIMITS.manifestBytes, "bound-expected-list-size").toString("utf8"));
			} catch (error) {
				if (error instanceof CandidateRefusal) throw error;
				return refuse("expected-list-invalid", "expected files file is not JSON");
			}
		})();
		console.log(JSON.stringify(await verifyCandidate(a, b, hash, list)));
		return;
	}
	refuse("usage", USAGE);
}
if (import.meta.main) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(String(error instanceof CandidateRefusal ? error.message : error));
		process.exitCode = 1;
	});
}
