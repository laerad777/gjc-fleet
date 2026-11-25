import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, stat, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readAnchored, readAnchoredFile } from "./safe-reader";
import { canonicalJson, REVIEW_BRANCH } from "./core";
import {
	FLEET_GIT_NAME,
	isolatedGitEnvironment,
	resolveProgram,
	spawnGit,
	spawnTrusted,
	UntrustedProgramError,
} from "./spawn";
export { isolatedGitEnvironment } from "./spawn";

export const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
/**
 * Win32 first-checkout basename for `git worktree add`: Git's administrative
 * directory under the common dir is derived from this name, so it stays short
 * and stable for a task/attempt pair.
 */
export function win32PrepareWorktreeBasename(
	taskId: string,
	attemptId: string,
): string {
	return (
		".fleet-prepare-" + sha256(taskId + "\0" + attemptId).slice(0, 24)
	);
}
/**
 * Absolute path already in **syntactic** resolved form:
 * `isAbsolute(path) && path === resolve(path)`.
 */
export function requireResolvedRoot(path: string, label: string): string {
	if (!path || !isAbsolute(path) || path !== resolve(path))
		throw new Error("unresolved_path_root:" + label);
	return path;
}
/** Resolve `git rev-parse --git-common-dir` against the repository root. */
export function resolveGitCommonDir(
	commonDir: string,
	repoRoot: string,
): string {
	const root = requireResolvedRoot(repoRoot, "repo");
	const trimmed = commonDir.trim();
	if (!trimmed) throw new Error("git_common_dir_missing");
	return isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed);
}
/** Git administrative worktree directory: `<common>/worktrees/<basename>`. */
export function gitAdminWorktreePath(
	commonDir: string,
	worktreeBasename: string,
): string {
	const common = requireResolvedRoot(commonDir, "common_dir");
	if (
		!worktreeBasename ||
		worktreeBasename.includes("/") ||
		worktreeBasename.includes("\\") ||
		worktreeBasename === "." ||
		worktreeBasename === ".."
	)
		throw new Error("invalid_worktree_basename");
	return join(common, "worktrees", worktreeBasename);
}
export type PreparationPathProjection = {
	commonDir: string;
	worktreeBasename: string;
	adminPath: string;
	checkoutPath: string;
	finalPath: string;
	lengths: {
		commonDir: number;
		adminPath: number;
		checkoutPath: number;
		finalPath: number;
	};
};
export const PREPARATION_PATH_PLATFORMS = [
	"win32",
	"linux",
	"darwin",
] as const;
export type PreparationPathPlatform =
	(typeof PREPARATION_PATH_PLATFORMS)[number];
export function requirePreparationPathPlatform(
	platform: string,
): PreparationPathPlatform {
	if (
		platform === "win32" ||
		platform === "linux" ||
		platform === "darwin"
	)
		return platform;
	throw new Error("unsupported_node_os");
}
/** Project preparation paths from a Git common dir (not `repo/.git` by fiat). */
export function projectPreparationPaths(input: {
	repoRoot: string;
	commonDir: string;
	workspaceRoot: string;
	taskId: string;
	attemptId: string;
	platform?: string;
}): PreparationPathProjection {
	const repoRoot = requireResolvedRoot(input.repoRoot, "repo");
	const workspaceRoot = requireResolvedRoot(
		input.workspaceRoot,
		"workspace_root",
	);
	const commonDir = resolveGitCommonDir(input.commonDir, repoRoot);
	const platform = requirePreparationPathPlatform(
		input.platform ?? process.platform,
	);
	const finalPath = join(workspaceRoot, input.taskId + "-" + input.attemptId);
	const worktreeBasename =
		platform === "win32"
			? win32PrepareWorktreeBasename(input.taskId, input.attemptId)
			: basename(finalPath);
	const checkoutPath =
		platform === "win32"
			? join(workspaceRoot, worktreeBasename)
			: finalPath;
	const adminPath = gitAdminWorktreePath(commonDir, worktreeBasename);
	return {
		commonDir,
		worktreeBasename,
		adminPath,
		checkoutPath,
		finalPath,
		lengths: {
			commonDir: commonDir.length,
			adminPath: adminPath.length,
			checkoutPath: checkoutPath.length,
			finalPath: finalPath.length,
		},
	};
}
export function safeRelative(path: string): string {
	if (
		!path ||
		isAbsolute(path) ||
		path.includes("\\") ||
		/[<>:"|?*]/.test(path) ||
		/[\x00-\x1f\x7f]/.test(path) ||
		path
			.split("/")
			.some(
				(p) =>
					p === ".." ||
					p === "." ||
					!p ||
					/[. ]$/.test(p) ||
					/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p),
			)
	)
		throw new Error("unsafe_relative_path");
	return path;
}
/**
 * Canonical comparison key of a relative path, per `/`-separated component: Windows
 * trailing dots/spaces removed (NTFS resolves `name.` and `name ` to `name`), then
 * Unicode NFC and case folded (APFS is normalization-insensitive; APFS and NTFS
 * default to case-insensitive). Two spellings one of these filesystems resolves
 * to the same entry always get the same key; distinct entries may share a key
 * (for example on a case-sensitive volume), which callers treat as ambiguous and
 * resolve towards withholding. Component count is preserved. Windows 8.3 short
 * names cannot be keyed; exported files are additionally checked by filesystem
 * identity (see `boundaryAncestor`).
 */
export function pathKey(path: string): string {
	if (/^[\x00-\x7f]*$/.test(path) && !/[. ](\/|$)/.test(path)) return path.toLowerCase();
	return path
		.split("/")
		.map((component) => {
			const trimmed = component.replace(/[. ]+$/, "") || component;
			return trimmed.normalize("NFC").toUpperCase().toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
		})
		.join("/");
}
export function excluded(path: string): boolean {
	return path
		.split("/")
		.some((p) =>
			/^(\.env.*|\.ssh|\.gjc|\.git|node_modules|\.cache|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|ecdsa|ed25519)(\.pub)?|credentials?(\.(json|ya?ml|toml|db))?|secrets?\.(json|ya?ml|toml)|tokens?\.(json|db)|auth\.(json|db)|.*\.(pem|key|p12))$/i.test(
				p,
			),
		);
}
/** Exact portable relative regular-file names, never globs or aliases. Ordering is canonical. */
export function validateSelectedOutputs(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > 1024) throw new Error("invalid_selected_outputs");
	const seen = new Set<string>();
	for (const path of value) {
		if (typeof path !== "string") throw new Error("invalid_selected_outputs");
		safeRelative(path);
		// Windows short-name aliases are not canonical selectors. Fail closed before reading.
		const key = pathKey(path);
		if (/[\[\]{}]/.test(path) || /~[0-9]/.test(path) || excluded(path) || key === ".fleet-identity.json" || seen.has(key)) throw new Error("invalid_selected_outputs");
		seen.add(key);
	}
	return [...value].sort();
}

/** CreateProcess bound of one Windows command line in UTF-16 units, terminating NUL included. */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
/**
 * UTF-16 length of `argv` as one Windows command line, quoted as libuv does (`quote_cmd_arg`):
 * an argument with no space, tab or `"` is copied, one without `"` and `\` is wrapped in quotes,
 * otherwise each `"` and every backslash run before a `"` or the end is escaped. Arguments are
 * separated by one space; the terminating NUL counts.
 */
export function windowsCommandLineLength(argv: readonly string[]): number {
	let length = argv.length;
	for (const arg of argv) {
		if (!arg.length) length += 2;
		else if (!/[ \t"]/.test(arg)) length += arg.length;
		else if (!/["\\]/.test(arg)) length += arg.length + 2;
		else {
			length += arg.length + 2;
			let escaping = true;
			for (let index = arg.length - 1; index >= 0; index--) {
				const char = arg[index];
				if (escaping && char === "\\") length++;
				else if (char === '"') {
					escaping = true;
					length++;
				} else escaping = false;
			}
		}
	}
	return length;
}
/** Refuses, before spawning, a command line the platform cannot pass (`command_line_limit`). */
export function requireCommandLine(argv: readonly string[], platform: string = process.platform): void {
	if (platform === "win32" && windowsCommandLineLength(argv) > WINDOWS_COMMAND_LINE_LIMIT) throw new Error("command_line_limit");
}
/**
 * Run argv in cwd. argv[0] comes from the trusted PATH only (`spawnTrusted`);
 * `untrusted` lists worker-controlled trees and defaults to cwd itself.
 * Collector timeouts/child tracking stay positional ahead of stdin/untrusted.
 */
export async function run(
	argv: string[],
	cwd: string,
	maxBytes = 4 * 1024 * 1024,
	env?: Record<string, string | undefined>,
	timeoutMs?: number,
	children?: Set<Promise<unknown>>,
	stdin?: string,
	untrusted: readonly string[] = [cwd],
): Promise<{ argv: string[]; exit: number; stdout: string; stderr: string }> {
	if (
		!argv.length ||
		argv.some((x) => typeof x !== "string" || x.includes("\0"))
	)
		throw new Error("invalid_argv");
	requireCommandLine(argv);
	const child = spawnTrusted(argv, {
		cwd,
		untrusted,
		...(env ? { env: { ...process.env, ...env } } : {}),
		...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf8"),
		stdout: "pipe",
		stderr: "pipe",
	});
	children?.add(child.exited);
	return {
		argv,
		...(await collect(
			{
				stdout: child.stdout!,
				stderr: child.stderr!,
				exited: child.exited,
				kill: (signal) => child.kill(signal),
			},
			maxBytes,
		)),
	};
}
/** Git against repo through the hardened choke point; same bounded collection as run(). */
export async function runGit(
	repo: string,
	args: string[],
	maxBytes = 4 * 1024 * 1024,
	untrusted: readonly string[] = [],
	stdin?: string,
): Promise<{ exit: number; stdout: string; stderr: string }> {
	const child = spawnGit(repo, args, {
		untrusted,
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf8"),
		stderr: "pipe",
	});
	return collect(
		{
			stdout: child.stdout!,
			stderr: child.stderr!,
			exited: child.exited,
			kill: (signal) => child.kill(signal),
		},
		maxBytes,
	);
}
async function collect(
	child: {
		stdout: ReadableStream<Uint8Array>;
		stderr: ReadableStream<Uint8Array>;
		exited: Promise<number>;
		kill(signal?: "SIGKILL" | NodeJS.Signals | number): void;
	},
	maxBytes: number,
): Promise<{ exit: number; stdout: string; stderr: string }> {
	const readers = [child.stdout.getReader(), child.stderr.getReader()];
	const read = async (
		reader: ReadableStreamDefaultReader<Uint8Array> | { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> },
	) => {
		let size = 0;
		const chunks: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value!.length;
			if (size > maxBytes) throw new Error("command_output_limit");
			chunks.push(value!);
		}
		return Buffer.concat(chunks).toString("utf8");
	};
	try {
		const [stdout, stderr, exit] = await Promise.all([
			read(readers[0]!),
			read(readers[1]!),
			child.exited,
		]);
		return { exit, stdout, stderr };
	} catch (error) {
		child.kill("SIGKILL");
		// A locked reader over a pipe that still holds unread bytes keeps Bun's event loop alive on
		// POSIX, so the calling process would never exit. Release both pipe ends explicitly.
		for (const reader of readers) reader.cancel().catch(() => {});
		throw error;
	}
}
/**
 * The one Git program every Fleet Git command runs, resolved on every call through
 * `resolveProgram` (trusted PATH only; PATH entries inside untrusted trees are skipped).
 */
export function gitProgram(untrusted: string[]): string {
	try {
		return resolveProgram(FLEET_GIT_NAME, { untrusted });
	} catch (error) {
		if (error instanceof UntrustedProgramError) throw new Error("git_untrusted_location");
		if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT")
			throw new Error("git_unavailable");
		throw error;
	}
}
/** The trees a worker can write to or name for a task workspace: its own, its siblings', the source repository. */
export function workspaceTrees(identity: WorkspaceIdentity): string[] {
	return [identity.path, dirname(identity.path), identity.repo];
}
/**
 * Fixed `git_failed:exit=N` for a failed Git child: the exit code only.
 * Raw Git stdout/stderr can carry credentials and local paths, and collector
 * errors are copied into shared logs and result artifacts, so no snippet of it
 * ever leaves the process (code review, verify/pr17).
 */
export function gitFailedMessage(exit: number): string {
	return `git_failed:exit=${exit}`;
}
function gitArgv(repo: string | undefined, args: string[], untrusted: readonly string[]): string[] {
	return [
		gitProgram([...(repo === undefined ? [] : [repo]), ...untrusted]),
		...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
		"-c",
		"core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
		"-c",
		"core.fsmonitor=false",
		...(repo === undefined ? [] : ["-C", repo]),
		...args,
	];
}
/**
 * A Git process that never discovers a repository: `GIT_DIR` is a node-created
 * neutral directory, `GIT_WORK_TREE` the workspace, `GIT_INDEX_FILE` a node-owned
 * index, and no system, global or repository configuration but the neutral one
 * is read (see `neutralRepository`).
 */
export interface NeutralGit {
	/** Node-owned working directory of every process (never inside the workspace). */
	readonly cwd: string;
	readonly workTree: string;
	readonly gitDir: string;
	readonly env: Record<string, string | undefined>;
	/** Exit of every Git process started over this neutral directory; all settle before it is removed. */
	readonly children: Set<Promise<unknown>>;
	/** Trees a worker can write (see `gitProgram`): the Git program never runs from inside one. */
	readonly untrusted: readonly string[];
}
/** A source repository path (trusted, node-owned) or a neutral Git over a workspace. */
type GitTarget = string | NeutralGit;
/**
 * Upper bound for one Git process over a workspace. The walk keeps Git out of every
 * nested repository and refuses special rule files it found, but a worker still
 * running can plant a FIFO (or a `.git` file naming one) after the walk; Git would
 * then block forever. Such a process is killed and the collection fails (`git_failed`).
 */
export const COLLECTION_GIT_TIMEOUT_MS = 5 * 60 * 1000;
/** `untrusted`: for a source repository path, the trees beside it a worker can write (see `gitProgram`). */
const gitSpawn = (target: GitTarget, args: string[], untrusted: readonly string[]) =>
	typeof target === "string"
		? { argv: gitArgv(target, args, untrusted), cwd: target, env: isolatedGitEnvironment(target), timeoutMs: undefined, children: undefined }
		: { argv: gitArgv(undefined, args, [target.workTree, ...target.untrusted]), cwd: target.cwd, env: target.env, timeoutMs: COLLECTION_GIT_TIMEOUT_MS, children: target.children };
function gitUntrusted(target: GitTarget, untrusted: readonly string[]): readonly string[] {
	return typeof target === "string"
		? [target, ...untrusted]
		: [target.workTree, ...target.untrusted, ...untrusted];
}
async function git(target: GitTarget, args: string[], untrusted: readonly string[] = [], stdin?: string): Promise<string> {
	const spec = gitSpawn(target, args, untrusted);
	const r = await run(
		spec.argv,
		spec.cwd,
		4 * 1024 * 1024,
		spec.env,
		spec.timeoutMs,
		spec.children,
		stdin,
		gitUntrusted(target, untrusted),
	);
	if (r.exit !== 0) throw new Error(gitFailedMessage(r.exit));
	return args[0] === "diff" ? r.stdout : r.stdout.trimEnd();
}
/** Upper bound for one streamed Git listing (never truncated: exceeding it fails). */
export const GIT_LISTING_LIMIT = 256 * 1024 * 1024;
/**
 * One isolated Git process whose NUL-terminated stdout records are parsed while
 * they stream, so a large listing is neither capped at 4 MiB nor buffered as one
 * string. `input` records are written NUL-terminated to stdin (one process for
 * any number of paths). Returns the records and a digest of the raw output.
 */
async function gitRecords(
	target: GitTarget,
	args: string[],
	input?: readonly string[],
	okExits: readonly number[] = [0],
	untrusted: readonly string[] = [],
): Promise<{ records: string[]; digest: string }> {
	const spec = gitSpawn(target, args, untrusted);
	requireCommandLine(spec.argv);
	const child = spawnTrusted(spec.argv, {
		cwd: spec.cwd,
		untrusted: gitUntrusted(target, untrusted),
		env: { ...process.env, ...spec.env },
		...(spec.timeoutMs ? { timeout: spec.timeoutMs, killSignal: "SIGKILL" as const } : {}),
		stdin: input ? Buffer.from(input.map((record) => record + "\0").join("")) : "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	spec.children?.add(child.exited);
	const drainStderr = async () => {
		const reader = child.stderr.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(chunks).toString("utf8");
			size += value.length;
			if (size > 64 * 1024) {
				// Match collect(): overflow teardown is final; SIGTERM alone can be trapped.
				child.kill("SIGKILL");
				throw new Error("command_output_limit");
			}
			chunks.push(value);
		}
	};
	const readRecords = async () => {
		const hash = createHash("sha256");
		const records: string[] = [];
		const reader = child.stdout.getReader();
		let size = 0;
		let pending = Buffer.alloc(0);
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > GIT_LISTING_LIMIT) {
				child.kill("SIGKILL");
				throw new Error("command_output_limit");
			}
			hash.update(value);
			const chunk = pending.length ? Buffer.concat([pending, value]) : Buffer.from(value);
			let start = 0;
			for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
				records.push(chunk.toString("utf8", start, end));
				start = end + 1;
			}
			pending = Buffer.from(chunk.subarray(start));
		}
		if (pending.length) throw new Error("git_failed");
		return { records, digest: hash.digest("hex") };
	};
	const [result, stderr, exit] = await Promise.all([readRecords(), drainStderr(), child.exited]);
	if (!okExits.includes(exit)) throw new Error(gitFailedMessage(exit));
	return result;
}
/** Bounds for the filesystem walk that discovers nested repositories (no depth bound: Git has none, review fx-397df5a5 F6). */
export const WORKSPACE_SCAN_LIMITS = Object.freeze({ maxEntries: 2_000_000 });
/**
 * Bounds for the walk below directories Git never enters (review fx-397df5a5 F4): after every
 * `classifyInterval` listed entries the walk asks Git which directories it found are ignored
 * (`ScanIgnore`); once more than `maxEntries` entries were listed below such directories, one
 * holding no base-tree entry is no longer walked (`WorkspaceScan.unwalked`) and the collector
 * withholds its outermost ignored ancestor as one boundary.
 */
export const IGNORED_SCAN_LIMITS = Object.freeze({ classifyInterval: 100_000, maxEntries: 500_000 });
/** Outer-tracked entries (base tree, HEAD tree, index) considered per collection. */
export const TRACKED_ENTRY_LIMIT = 2_000_000;
const separatorBytes = Buffer.from(sep);
/** A child path; raw name bytes (or a raw parent) keep the whole path as exact bytes. */
const childPath = (directory: Buffer | string, name: Buffer | string): Buffer | string =>
	typeof directory === "string" && typeof name === "string"
		? directory + sep + name
		: Buffer.concat([Buffer.from(directory), separatorBytes, Buffer.from(name)]);
/** Filesystem identity (device and inode/file index) of a directory, never following a final link. */
function directoryIdentity(path: Buffer | string): string | undefined {
	const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
	return stats?.isDirectory() ? stats.dev + ":" + stats.ino : undefined;
}
/**
 * Index of the first component of `path` (1-based depth) whose directory has one of
 * the boundary `identities`, else 0. The filesystem resolves every alias of the
 * spelling (normalization, case, Windows 8.3 short names, trailing dots/spaces),
 * so this holds wherever a spelling comparison cannot. A path that vanished or
 * is not a directory chain is reported as its deepest existing prefix.
 */
export function boundaryAncestor(root: string, path: string, identities: ReadonlySet<string>): number {
	if (!identities.size) return 0;
	const parts = path.split("/");
	let current = root;
	for (let depth = 1; depth <= parts.length; depth++) {
		current = join(current, parts[depth - 1]!);
		let identity: string | undefined;
		try {
			identity = directoryIdentity(current);
		} catch (error: any) {
			if (error.code === "ENOTDIR") return 0;
			throw scanError(error);
		}
		if (identity === undefined) return 0;
		if (identities.has(identity)) return depth;
	}
	return 0;
}
/** Filesystem errors never leave the walk raw: no host path, one bounded code. */
function scanError(error: any): Error {
	return typeof error?.code === "string" ? new Error("workspace_scan_unreadable") : error;
}
/** What the walk saw at one directory entry, by `lstat` type only (a link is never followed). */
export type WalkKind = "dir" | "repo" | "file" | "link" | "other";
export interface WalkEntry {
	/** Name as listed (a name that is not UTF-8 decodes lossily; `raw` then holds its exact bytes). */
	name: string;
	raw?: Buffer;
	kind: WalkKind;
}
export interface WorkspaceScan {
	/** Nested repository roots as spelled on disk (sorted; names that are not UTF-8 decode lossily). */
	repositories: string[];
	/** Filesystem identity of each repository root (same order). */
	identities: string[];
	/**
	 * Directories shaped like a bare repository (`HEAD`, `objects/` and `refs/` and no `.git`
	 * entry): walked like any directory; the collector treats those outside the base tree as
	 * repository roots (sorted, same shape as `repositories`).
	 */
	bare: { path: string; identity: string }[];
	/** `pathKey` of each directory ("" is the root) holding an entry keyed `.gitignore` (sorted). */
	ruleDirectories: string[];
	/**
	 * Walk path of every `.gitignore` or `.gitattributes` entry (in a listed directory or a
	 * repository root) that is neither a regular file nor a link: Git opens rule files
	 * without following links, but a FIFO, socket or device there blocks it forever.
	 */
	specialRuleFiles: string[];
	/**
	 * Every listed directory's entries (walk path → entries; `.git` entries excluded), except
	 * directories Git reports ignored that hold no base-tree entry (`ScanIgnore`).
	 */
	listings: Map<string, WalkEntry[]>;
	/**
	 * Walk paths of directories that could not be listed (too long a path, no permission):
	 * neither listed nor descended. Accepted only below a directory Git never enters, which the
	 * collector then withholds as one boundary (`deepBoundaries`, review fx-397df5a5 F3); only
	 * recorded with `ScanIgnore` (else the walk fails `workspace_scan_unreadable`).
	 */
	unreadable: string[];
	/** Walk paths of ignored directories not walked once `IGNORED_SCAN_LIMITS` was exceeded (see there). */
	unwalked: string[];
	/** Every directory the walk listed or recorded as a repository root, as it was then (see `verifyScan`). */
	stamps: DirectoryStamp[];
	/** Every listed directory: walk path, depth below the root and number of entries listed (`.git` included). */
	counts: { path: string; depth: number; entries: number }[];
}
/**
 * A directory as the walk observed it: its identity and change times, taken
 * immediately before its listing. Adding, removing or renaming any entry (a new
 * `.git`, `.gitignore` or subdirectory among them) changes the directory's mtime
 * and ctime. A directory whose times are not clearly older than the walk (within
 * `STAMP_MARGIN_NS` of its start, or later) also keeps a digest of its listing,
 * so a change within one timestamp tick of the listing is still seen.
 */
interface DirectoryStamp {
	absolute: Buffer | string;
	stamp: string;
	listing?: string;
}
/** Times this close to the walk start (or later) are not trusted to prove "unchanged since". */
const STAMP_MARGIN_NS = 2_000_000_000n;
function listingDigest(absolute: Buffer | string): string {
	const hash = createHash("sha256");
	for (const raw of (readdirSync(absolute, { encoding: "buffer" }) as Buffer[]).sort(Buffer.compare)) hash.update(raw).update("\0");
	return hash.digest("hex");
}
/**
 * Whether the workspace is still as `scan` walked it, without walking it again:
 * one `lstat` per walked directory (and its listing again only where its times are
 * not older than the walk). Any difference fails closed as a concurrent change.
 */
export async function verifyScan(scan: WorkspaceScan): Promise<void> {
	const check = async (entry: DirectoryStamp) => {
		const stats = await lstat(entry.absolute, { bigint: true });
		if (!stats.isDirectory() || stats.dev + ":" + stats.ino + ":" + stats.mtimeNs + ":" + stats.ctimeNs !== entry.stamp) throw new Error("result_changed_during_collection");
		if (entry.listing !== undefined && listingDigest(entry.absolute) !== entry.listing) throw new Error("result_changed_during_collection");
	};
	try {
		for (let start = 0; start < scan.stamps.length; start += SCAN_CONCURRENCY) await Promise.all(scan.stamps.slice(start, start + SCAN_CONCURRENCY).map(check));
	} catch (error: any) {
		if (error?.message === "result_changed_during_collection") throw error;
		if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new Error("result_changed_during_collection");
		throw scanError(error);
	}
}
/** Listings and `lstat` calls of one walk in flight at once (the walk is bound by system calls, not CPU). */
const SCAN_CONCURRENCY = 32;
/** Every `.git` entry type counts: directory, worktree/submodule file or symlink. Case-insensitive filesystems resolve case variants here, as Git does. */
async function hasGitMarkerAsync(directory: Buffer | string): Promise<boolean> {
	return (await entryKind(childPath(directory, ".git"))) !== undefined;
}
/** The `lstat` type of a path (never following a final link), `undefined` when absent. Nothing is opened or read. */
async function entryKind(path: Buffer | string): Promise<Exclude<WalkKind, "repo"> | undefined> {
	try {
		const stats = await lstat(path);
		return stats.isDirectory() ? "dir" : stats.isFile() ? "file" : stats.isSymbolicLink() ? "link" : "other";
	} catch (error: any) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
		throw Object.assign(scanError(error), { cause: error?.code });
	}
}
const direntKind = (entry: { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }): Exclude<WalkKind, "repo"> =>
	entry.isDirectory() ? "dir" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "link" : "other";
/** Git's own test for a bare repository directory (`is_git_directory`), by entry types only: `HEAD`, `objects/`, `refs/`. */
function looksBare(entries: readonly WalkEntry[]): boolean {
	let head = false;
	let objects = false;
	let refs = false;
	for (const entry of entries) {
		const key = pathKey(entry.name);
		if (key === "head" && entry.kind !== "dir") head = true;
		else if (key === "objects" && entry.kind === "dir") objects = true;
		else if (key === "refs" && entry.kind === "dir") refs = true;
	}
	return head && objects && refs;
}
/** Git's ignore decisions for the walk (see `IGNORED_SCAN_LIMITS`). */
export interface ScanIgnore {
	/**
	 * Of each walk path (a directory), whether Git reports it ignored (a negated match is not).
	 * `specialRuleFiles` are those the walk found so far: one Git would open refuses first.
	 */
	ignored(paths: string[], specialRuleFiles: readonly string[]): Promise<boolean[]>;
	/** Base-tree entries at or below a walk path (called only after `ignored` resolved). */
	tracked(path: string): number;
}
/** Listing failures that leave a directory unwalked below an ignored directory instead of failing the walk. */
const UNREADABLE_CODES = new Set(["ENAMETOOLONG", "EACCES", "EPERM"]);
/**
 * Walk the workspace filesystem itself, independent of Git status and of every
 * ignore source, so tracked, untracked and ignored locations are treated alike.
 * Symlinks are never followed (directory entries are classified without
 * following links), the outer `.git` at the root is never entered, and a
 * discovered repository or opaque (gitlink) root is never descended into. Only
 * directory listings and `.git` existence are observed; no file bytes are read.
 * Up to `SCAN_CONCURRENCY` listings run at once, so the walk costs about what
 * Git's own traversal does. Exceeding the entry bound fails closed. With `ignore`,
 * the walk below directories Git reports ignored is bounded separately
 * (`IGNORED_SCAN_LIMITS`) and their listings are not kept.
 *
 * Children are addressed by their exact name bytes, never by a re-encoded
 * decoded name: a directory holding a name that is not valid UTF-8 (possible on
 * Linux) is listed again as raw bytes. Opaque roots are matched by `pathKey`.
 */
export async function scanWorkspace(
	root: string,
	/** `null`: bounded afterwards by `checkScanLimits`, outside the trees Git reports ignored. */
	limits: { maxEntries: number } | null = WORKSPACE_SCAN_LIMITS,
	opaque: ReadonlySet<string> = new Set(),
	/** Git's ignore decisions (the collector's walk): bounds the walk below ignored directories. */
	ignore?: ScanIgnore,
	ignoredLimits: { classifyInterval: number; maxEntries: number } = IGNORED_SCAN_LIMITS,
): Promise<WorkspaceScan> {
	const opaqueKeys = new Set([...opaque].map(pathKey));
	const repositories: { path: string; identity: string }[] = [];
	const bare: { path: string; identity: string }[] = [];
	const ruleDirectories = new Set<string>();
	const specialRuleFiles: string[] = [];
	const unreadable: string[] = [];
	const unwalked: string[] = [];
	const listings = new Map<string, WalkEntry[]>();
	const stamps: DirectoryStamp[] = [];
	const counts: WorkspaceScan["counts"] = [];
	// With `ignore`: entries listed in directories not (yet) known ignored, entries listed below
	// ignored ones, and the directories listed since Git was last asked (path → entries).
	let entered = 0;
	let ignoredEntries = 0;
	let unasked = new Map<string, number>();
	const recent = BigInt(Date.now()) * 1_000_000n - STAMP_MARGIN_NS;
	const stampOf = async (absolute: Buffer | string) => {
		const stats = await lstat(absolute, { bigint: true });
		if (!stats.isDirectory()) throw new Error("result_changed_during_collection");
		const times = stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs;
		const stamp = stats.dev + ":" + stats.ino + ":" + stats.mtimeNs + ":" + stats.ctimeNs;
		const entry: DirectoryStamp = { absolute, stamp, ...(times >= recent ? { listing: listingDigest(absolute) } : {}) };
		stamps.push(entry);
		return { stats, entry };
	};
	type WalkItem = { path: string; absolute: Buffer | string; depth: number; ignored: boolean };
	let entries = 0;
	const visit = async ({ path, absolute, depth, ignored }: WalkItem): Promise<WalkItem[]> => {
		if (ignored && ignoredEntries > ignoredLimits.maxEntries && !ignore!.tracked(path)) {
			unwalked.push(path);
			return [];
		}
		let children: WalkEntry[];
		let identity: string;
		let stamped: DirectoryStamp | undefined;
		try {
			// Re-check immediately before listing: a directory replaced by a link is not entered.
			const { stats, entry } = await stampOf(absolute);
			stamped = entry;
			identity = stats.dev + ":" + stats.ino;
			const listing = await readdir(absolute, { withFileTypes: true });
			children = listing.map((entry) => ({ name: entry.name, kind: direntKind(entry) }));
			if (listing.some((entry) => entry.name.includes("\ufffd")))
				// Decoded names may not round-trip: classify every child by its raw bytes.
				children = (readdirSync(absolute, { encoding: "buffer" }) as Buffer[]).map((raw) => ({
					name: raw.toString("utf8"),
					raw,
					kind: direntKind(lstatSync(childPath(absolute, raw))),
				}));
		} catch (error: any) {
			if (error?.message === "result_changed_during_collection" || error.code === "ENOENT" || error.code === "ENOTDIR") throw new Error("result_changed_during_collection");
			if (ignore && path && UNREADABLE_CODES.has(error?.code)) {
				// Not listed: nothing of it is stamped, the collector decides (`deepBoundaries`).
				if (stamped) stamps.splice(stamps.indexOf(stamped), 1);
				unreadable.push(path);
				return [];
			}
			throw scanError(error);
		}
		entries += children.length;
		if (!ignore && limits && entries > limits.maxEntries) throw new Error("workspace_scan_limit");
		if (ignored) ignoredEntries += children.length;
		else if (ignore) {
			entered += children.length;
			unasked.set(path, children.length);
		}
		counts.push({ path, depth, entries: children.length });
		const next: WalkItem[] = [];
		const directories: { entry: WalkEntry; child: string; childAbsolute: Buffer | string }[] = [];
		const listed: WalkEntry[] = [];
		for (const entry of children) {
			const name = entry.name;
			if (name.charCodeAt(0) === 46 /* . */) {
				const key = pathKey(name);
				if (key === ".gitignore") ruleDirectories.add(pathKey(path));
				if ((key === ".gitignore" || key === ".gitattributes") && entry.kind === "other") specialRuleFiles.push(path ? path + "/" + name : name);
				// Git never lists or enters an entry named `.git`; at the root it is the workspace's own.
				if (key === ".git") continue;
			}
			listed.push(entry);
			if (entry.kind !== "dir") continue;
			const child = path ? path + "/" + name : name;
			if (opaqueKeys.size && opaqueKeys.has(pathKey(child))) continue;
			directories.push({ entry, child, childAbsolute: childPath(absolute, entry.raw ?? name) });
		}
		// Kept for the base-tree checks of the collector only: none apply where Git never enters.
		if (!ignored || ignore!.tracked(path)) listings.set(path, listed);
		if (path && looksBare(listed)) bare.push({ path, identity });
		await Promise.all(
			directories.map(async ({ entry, child, childAbsolute }) => {
				let marker: boolean;
				try {
					marker = await hasGitMarkerAsync(childAbsolute);
				} catch (error) {
					if (ignore && UNREADABLE_CODES.has((error as any)?.cause)) {
						unreadable.push(child);
						return;
					}
					throw error;
				}
				if (!marker) {
					next.push({ path: child, absolute: childAbsolute, depth: depth + 1, ignored });
					return;
				}
				entry.kind = "repo";
				let identity: string;
				try {
					// A repository root is not descended; its own entries (its `.git` marker) are stamped.
					const { stats } = await stampOf(childAbsolute);
					identity = stats.dev + ":" + stats.ino;
					// Git still reads the rule files of a base-tree directory that became a repository.
					for (const rule of [".gitignore", ".gitattributes"])
						if ((await entryKind(childPath(childAbsolute, rule))) === "other") specialRuleFiles.push(child + "/" + rule);
				} catch (error: any) {
					if (error?.message === "result_changed_during_collection" || error?.code === "ENOENT" || error?.code === "ENOTDIR") throw new Error("result_changed_during_collection");
					throw scanError(error);
				}
				repositories.push({ path: child, identity });
			}),
		);
		return next;
	};
	// A bounded pool over the breadth-first frontier; the first failure fails the walk.
	const queue: WalkItem[] = [{ path: "", absolute: root, depth: 0, ignored: false }];
	let next = 0;
	/**
	 * With `ignore`, every `classifyInterval` entries: the walk drains, then Git is asked about
	 * every directory listed since, and every queued one, not known ignored. Below an ignored
	 * directory everything is ignored (Git never enters it), so it is never asked again.
	 */
	const classify = async () => {
		const queued = queue.slice(next).filter((item) => !item.ignored);
		const paths = [...[...unasked.keys()].filter(Boolean), ...queued.map((item) => item.path)].filter((path) => !path.includes("\ufffd"));
		const listed = unasked;
		unasked = new Map();
		const answers = await ignore!.ignored(paths, [...specialRuleFiles]);
		const ignoredPaths = new Set(paths.filter((_, index) => answers[index]));
		for (const [path, count] of listed)
			if (ignoredPaths.has(path)) {
				entered -= count;
				ignoredEntries += count;
				if (!ignore!.tracked(path)) listings.delete(path);
			}
		for (const item of queued) if (ignoredPaths.has(item.path)) item.ignored = true;
		// Entries in directories Git enters stay bounded inline (as `checkScanLimits` bounds them exactly).
		if (limits && entered > limits.maxEntries) throw new Error("workspace_scan_limit");
	};
	await new Promise<void>((resolveWalk, rejectWalk) => {
		let active = 0;
		let failed = false;
		let checkpoint = ignore ? ignoredLimits.classifyInterval : Infinity;
		let classifying = false;
		const fail = (error: unknown) => {
			failed = true;
			rejectWalk(error);
		};
		const pump = () => {
			if (failed || classifying) return;
			if (entries >= checkpoint) {
				if (active) return;
				classifying = true;
				classify().then(() => {
					classifying = false;
					checkpoint = entries + ignoredLimits.classifyInterval;
					pump();
				}, fail);
				return;
			}
			if (active === 0 && next >= queue.length) return resolveWalk();
			while (active < SCAN_CONCURRENCY && next < queue.length) {
				const item = queue[next++]!;
				active++;
				visit(item).then((children) => {
					active--;
					for (const child of children) queue.push(child);
					pump();
				}, fail);
			}
		};
		pump();
	});
	const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	repositories.sort(byPath);
	bare.sort(byPath);
	return {
		repositories: repositories.map((entry) => entry.path),
		identities: repositories.map((entry) => entry.identity),
		bare,
		ruleDirectories: [...ruleDirectories].sort(),
		specialRuleFiles: specialRuleFiles.sort(),
		listings,
		unreadable: unreadable.sort(),
		unwalked: unwalked.sort(),
		stamps,
		counts,
	};
}
/**
 * The boundaries that withhold what the walk did not list (`WorkspaceScan.unreadable` and
 * `unwalked`; review fx-397df5a5 F3, F4): for each such path, the outermost directory at or
 * below a root Git reports ignored (`ignoredRoots`, Git spellings, directories end in `/`)
 * that holds no base-tree entry. Git never enters it, so the export is unchanged, but nested
 * repositories below it cannot be ruled out: it is withheld like an ignored directory holding
 * a repository (`collapseIgnored`), which makes the export incomplete (operator review). An
 * unreadable path is withheld only strictly below such a root (an ignored directory that cannot
 * itself be read is not below one). A path with no such directory refuses the collection: an
 * unreadable one with `workspace_scan_unreadable`, an unwalked one with `workspace_scan_limit`.
 */
export function deepBoundaries(
	scan: Pick<WorkspaceScan, "unreadable" | "unwalked">,
	ignoredRoots: readonly string[],
	countTracked: (path: string) => number,
): string[] {
	if (!scan.unreadable.length && !scan.unwalked.length) return [];
	const roots = new Set(ignoredRoots.filter((root) => root.endsWith("/")).map((root) => pathKey(root.slice(0, -1))));
	const boundaries = new Set<string>();
	const withhold = (path: string, refusal: string, strictlyBelow: boolean) => {
		const parts = path.split("/");
		let below = false;
		for (let length = 1; length <= parts.length; length++) {
			const prefix = parts.slice(0, length).join("/");
			below ||= (!strictlyBelow || length < parts.length) && roots.has(pathKey(prefix));
			if (below && !countTracked(prefix)) {
				boundaries.add(prefix);
				return;
			}
		}
		throw new Error(refusal);
	};
	for (const path of scan.unreadable) withhold(path, "workspace_scan_unreadable", true);
	for (const path of scan.unwalked) withhold(path, "workspace_scan_limit", false);
	return [...boundaries].sort();
}
/**
 * The walk's bounds (`WORKSPACE_SCAN_LIMITS`), applied to what Git itself traverses (review
 * fx-093cc54b F4): a directory at or below a root Git reports ignored (`ignoredRoots`, Git
 * spellings, directories end in `/`) is walked to find nested repositories, but its entries
 * are not counted, since Git never enters it (as the collector before the walk never did).
 * Its name still counts as an entry of its parent. No depth is bounded (Git bounds none).
 */
export function checkScanLimits(
	scan: Pick<WorkspaceScan, "counts">,
	ignoredRoots: readonly string[],
	limits: { maxEntries: number } = WORKSPACE_SCAN_LIMITS,
): void {
	const ignored = new Set(ignoredRoots.filter((root) => root.endsWith("/")).map((root) => pathKey(root.slice(0, -1))));
	const isIgnored = (path: string) => {
		if (!ignored.size || !path) return false;
		const parts = pathKey(path).split("/");
		for (let length = 1; length <= parts.length; length++) if (ignored.has(parts.slice(0, length).join("/"))) return true;
		return false;
	};
	let entries = 0;
	for (const directory of scan.counts) {
		if (isIgnored(directory.path)) continue;
		entries += directory.entries;
		if (entries > limits.maxEntries) throw new Error("workspace_scan_limit");
	}
}
/** Nested repository roots only (see `scanWorkspace`). */
export async function scanWorkspaceRepositories(
	root: string,
	limits: { maxEntries: number } = WORKSPACE_SCAN_LIMITS,
	opaque: ReadonlySet<string> = new Set(),
): Promise<string[]> {
	return (await scanWorkspace(root, limits, opaque)).repositories;
}
const nullDevice = () => (process.platform === "win32" ? "NUL" : "/dev/null");
/**
 * Read one `core.excludesFile` value with the node's own environment (every `GIT_*`
 * variable removed; `gitDir` pins the repository conditional includes are evaluated
 * against). Only ever run in the source repository at preparation or in a neutral
 * collection repository, never in a workspace.
 */
async function readExcludesConfig(cwd: string, scope: string[], gitDir: string | undefined, untrusted: readonly string[]): Promise<string | undefined> {
	const r = await run(
		[gitProgram([cwd, ...untrusted]), "-C", cwd, "config", ...scope, "--type=path", "--get", "core.excludesFile"],
		cwd,
		64 * 1024,
		{
			...Object.fromEntries(Object.keys(process.env).filter((key) => /^GIT_/i.test(key)).map((key) => [key, undefined])),
			...(gitDir ? { GIT_DIR: gitDir } : {}),
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
		},
		undefined,
		undefined,
		undefined,
		[cwd, ...untrusted],
	);
	if (r.exit === 0) return r.stdout.replace(/\r?\n$/, "");
	if (r.exit === 1 && !r.stdout) return undefined;
	throw new Error("ignore_rules_unresolved");
}
/** Git's default global excludes file: `$XDG_CONFIG_HOME/git/ignore` (non-empty XDG_CONFIG_HOME) or `$HOME/.config/git/ignore`. */
function defaultExcludesFile(): string {
	const xdg = process.env.XDG_CONFIG_HOME;
	const home = process.env.HOME || (process.platform === "win32" ? process.env.USERPROFILE : undefined);
	return xdg ? join(xdg, "git", "ignore") : home ? join(home, ".config", "git", "ignore") : "";
}
/** Absolute excludes file path; an empty value means none. A file inside the workspace is refused. */
async function checkedExcludesFile(workspace: string, cwd: string, file: string): Promise<string> {
	// Git treats an empty value as "no excludes file".
	if (!file) return nullDevice();
	const absolute = resolve(cwd, file);
	let real = absolute;
	try {
		real = await realpath(absolute);
	} catch (error: any) {
		if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw new Error("ignore_rules_unresolved");
		try {
			real = join(await realpath(dirname(absolute)), basename(absolute));
		} catch {}
	}
	for (const candidate of [absolute, real])
		if (candidate === workspace || candidate.startsWith(workspace + sep)) throw new Error("ignore_rules_inside_workspace");
	return absolute;
}
/**
 * The node's own excludes file as it is now: the global, else system
 * `core.excludesFile` (unconditional includes followed; conditional ones are
 * evaluated against an empty node-created repository, never against the
 * workspace or the source repository), else Git's default
 * `$XDG_CONFIG_HOME/git/ignore` or `$HOME/.config/git/ignore`. These files are the
 * operator's, outside everything a worker can write; a rule file that resolves
 * inside the workspace is refused, because the worker could rewrite it.
 */
async function liveNodeExcludesFile(workspace: string, untrusted: readonly string[]): Promise<string> {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "fleet-node-rules-")));
	try {
		// An empty Git directory of the node's own: conditional includes see no repository facts
		// (`gitdir:` names this directory, `onbranch:` sees a detached HEAD, no remotes).
		const gitDir = join(cwd, "git");
		for (const sub of ["objects", "refs"]) await mkdir(join(gitDir, sub), { recursive: true, mode: 0o700 });
		await writeFile(join(gitDir, "HEAD"), "0".repeat(39) + "1\n", { mode: 0o600 });
		return await checkedExcludesFile(workspace, cwd, await nodeExcludesValue(cwd, gitDir, untrusted));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}
async function nodeExcludesValue(cwd: string, gitDir: string | undefined, untrusted: readonly string[]): Promise<string> {
	// Both scopes are read at once; the system scope (and its failure) counts only without a global value.
	const system = readExcludesConfig(cwd, ["--system", "--includes"], gitDir, untrusted).then((value) => ({ value }), (error) => ({ error }));
	const global = await readExcludesConfig(cwd, ["--global", "--includes"], gitDir, untrusted);
	const fallback = await system;
	if (global !== undefined) return global;
	if ("error" in fallback) throw fallback.error;
	return fallback.value ?? defaultExcludesFile();
}
/** Absolute path of an excludes value relative to `cwd`; "" (Git: no excludes file) stays "". */
const resolveExcludesValue = (cwd: string, value: string) => (value ? resolve(cwd, value) : "");
/** At most this many paths are listed per ignored/junk summary; the counts stay exact. */
export const IGNORED_LIST_LIMIT = 256;
/** At most this many `ignored_out_of_tree` exclusions are listed; beyond it they aggregate to ancestors. */
export const OUT_OF_TREE_LIST_LIMIT = 256;
/**
 * OS metadata files. Ignored only by an out-of-tree source, they are withheld and
 * summarised in `junk` without making the export incomplete (case-insensitive,
 * files only).
 */
export const OS_JUNK_NAMES: readonly string[] = Object.freeze([".DS_Store", "Thumbs.db", "ehthumbs.db", "desktop.ini", "Icon\r"]);
const junkNames = new Set(OS_JUNK_NAMES.map((name) => name.toLowerCase()));
export type IgnoreSource = "info_exclude" | "excludes_file" | "unexported_gitignore" | "unattributed" | "mixed";
export const IGNORE_SOURCES: readonly IgnoreSource[] = Object.freeze(["info_exclude", "excludes_file", "unexported_gitignore", "unattributed", "mixed"]);
/** Exclusion path for the workspace root (an aggregate, or the parent of names that cannot be listed). */
export const ROOT_EXCLUSION = ".";
/** Portable and losslessly decoded (a name that is not UTF-8 decodes to U+FFFD and is never listed). */
const isPortable = (path: string) => {
	if (path.includes("\ufffd")) return false;
	try {
		safeRelative(path);
		return true;
	} catch {
		return false;
	}
};
/** The deepest portable ancestor directory of a path whose name is not portable (`.` when none). */
function portableAncestor(path: string): string {
	const parts = path.split("/");
	let portable = 0;
	while (portable < parts.length - 1 && isPortable(parts.slice(0, portable + 1).join("/"))) portable++;
	return portable ? parts.slice(0, portable).join("/") : ROOT_EXCLUSION;
}
/** The collector's own state (`.gjc/` at any depth) and identity marker are never classified. */
const collectorOwned = (path: string) => path === ".fleet-identity.json" || path.split("/").slice(0, -1).includes(".gjc");
/** Root (or root-covered path) lookup: files match exactly, directories (trailing `/`) cover everything below. */
function coveringRoot(roots: ReadonlySet<string>, path: string): string | undefined {
	for (let slash = path.indexOf("/"); slash !== -1 && slash < path.length - 1; slash = path.indexOf("/", slash + 1)) {
		const ancestor = path.slice(0, slash + 1);
		if (roots.has(ancestor)) return ancestor;
	}
	return roots.has(path) ? path : undefined;
}
/** First index of the sorted `paths` not below `target` (binary search). */
function lowerBoundOf(paths: readonly string[], target: string): number {
	let low = 0;
	let high = paths.length;
	while (low < high) {
		const middle = (low + high) >> 1;
		if (paths[middle]! < target) low = middle + 1;
		else high = middle;
	}
	return low;
}
/** Whether the sorted `paths` contain `path` or a path below it. */
function hasPathAtOrBelow(paths: readonly string[], path: string): boolean {
	if (paths[lowerBoundOf(paths, path)] === path) return true;
	return paths[lowerBoundOf(paths, path + "/")]?.startsWith(path + "/") ?? false;
}
/** At most this many argv bytes of opaque-root exclude pathspecs; more refuse the collection. */
export const OPAQUE_PATHSPEC_BYTES = 256 * 1024;
/**
 * Pathspecs that keep a Git traversal of the workspace out of every repository root and
 * bare-repository directory the walk found. Without them Git probes a nested `.git` (a
 * directory, or a file naming a Git directory anywhere, even outside the workspace) to
 * decide whether it is a repository, and a FIFO there blocks it forever. With them Git
 * never opens, lists or follows anything at or below those roots.
 */
function opaqueExcludes(opaque: readonly string[]): string[] {
	if (!opaque.length) return [];
	const specs = opaque.map((path) => ":(top,exclude,literal)" + path);
	if (specs.reduce((size, spec) => size + spec.length + 1, 0) > OPAQUE_PATHSPEC_BYTES) throw new Error("workspace_scan_limit");
	return ["--", ":(top)", ...specs];
}
/**
 * Whether the opaque roots, each its own exclusion and pathspec, stay inside the collection
 * limits: 1,024 exclusions, `OPAQUE_PATHSPEC_BYTES`, and on Windows the command line of the
 * patch listing that excludes every one of them (`requireCommandLine`).
 */
function opaqueWithinLimits(repo: NeutralGit, opaque: readonly string[]): boolean {
	if (opaque.length > 1024) return false;
	const specs = opaque.map((path) => ":(top,exclude,literal)" + path);
	if (specs.reduce((size, spec) => size + spec.length + 1, 0) > OPAQUE_PATHSPEC_BYTES) return false;
	if (process.platform !== "win32") return true;
	const argv = gitSpawn(repo, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--", ":(top)", ":(top,exclude,literal).fleet-identity.json", ...specs], []).argv;
	return windowsCommandLineLength(argv) <= WINDOWS_COMMAND_LINE_LIMIT;
}
/**
 * Opaque roots beyond the collection limits (`opaqueWithinLimits`) that lie inside (or at)
 * an ignored directory holding no base-tree entry collapse into the outermost such
 * directory (review fx-9abb2530 F4): Git never descends into an ignored directory, so one
 * boundary (one `nested_repository` exclusion, one pathspec) keeps exactly the same
 * content out of the export, however many repositories it holds. Within the limits every
 * root stays its own exclusion, as before. The ancestors are queried in one `check-ignore`
 * process (stdin), under the same rules as `ignoreView`; a negated (`!`) match is not
 * ignored. `collapsed`: the directories that replaced roots. `ignoredRoots`: the roots at or
 * inside such a directory (asked for by `classify`, else only when collapsing).
 */
async function collapseIgnored(
	repo: NeutralGit,
	excludesFile: string,
	opaque: readonly string[],
	countTracked: (path: string) => number,
	classify: boolean,
): Promise<{ opaque: string[]; collapsed: string[]; ignoredRoots: string[] }> {
	const within = opaqueWithinLimits(repo, opaque);
	if (!opaque.length || (within && !classify)) return { opaque: [...opaque], collapsed: [], ignoredRoots: [] };
	const ancestors = new Set<string>();
	for (const path of opaque) {
		const parts = path.split("/");
		for (let depth = 1; depth <= parts.length; depth++) ancestors.add(parts.slice(0, depth).join("/") + "/");
	}
	const queries = [...ancestors].sort();
	const config = ["-c", "core.excludesFile=" + excludesFile, "-c", "core.untrackedCache=false"];
	const check = await gitRecords(repo, [...config, "check-ignore", "--verbose", "--non-matching", "-z", "--stdin"], queries, [0, 1]);
	if (check.records.length !== queries.length * 4) throw new Error("result_changed_during_collection");
	const ignored = new Set<string>();
	queries.forEach((query, index) => {
		if (check.records[index * 4 + 3] !== query) throw new Error("result_changed_during_collection");
		const directory = query.slice(0, -1);
		if (check.records[index * 4] && !check.records[index * 4 + 2]!.startsWith("!") && !countTracked(directory)) ignored.add(directory);
	});
	const kept = new Set<string>();
	const collapsed = new Set<string>();
	const ignoredRoots: string[] = [];
	for (const path of opaque) {
		const parts = path.split("/");
		let outer: string | undefined;
		for (let depth = 1; depth <= parts.length && outer === undefined; depth++) {
			const ancestor = parts.slice(0, depth).join("/");
			if (ignored.has(ancestor)) outer = ancestor;
		}
		if (outer === undefined) kept.add(path);
		else {
			collapsed.add(outer);
			ignoredRoots.push(path);
		}
	}
	if (within) return { opaque: [...opaque], collapsed: [], ignoredRoots };
	return { opaque: [...kept, ...collapsed].sort(), collapsed: [...collapsed].sort(), ignoredRoots: [...ignoredRoots, ...collapsed].sort() };
}
/**
 * `check-ignore` (stdin, the rules of `ignoreView`) of walk paths, each queried without a
 * trailing `/`, so Git reads the rule files of its ancestors only, up to the first one it
 * finds ignored, and never the path's own: per path whether it is ignored (a negated match
 * is not) and the rule file that decided it. Every query is a directory, which Git's traversal
 * matches against the rules whatever the index holds at that path, so `--no-index`: with the
 * index, `check-ignore` scans every index entry once per stdin path (quadratic in the base tree).
 */
async function checkIgnored(repo: NeutralGit, excludesFile: string, paths: readonly string[]): Promise<{ ignored: boolean; source: string }[]> {
	if (!paths.length) return [];
	const config = ["-c", "core.excludesFile=" + excludesFile, "-c", "core.untrackedCache=false"];
	const check = await gitRecords(repo, [...config, "check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], paths, [0, 1]);
	if (check.records.length !== paths.length * 4) throw new Error("result_changed_during_collection");
	return paths.map((path, index) => {
		if (check.records[index * 4 + 3] !== path) throw new Error("result_changed_during_collection");
		const source = check.records[index * 4]!;
		return { ignored: !!source && !check.records[index * 4 + 2]!.startsWith("!"), source };
	});
}
/**
 * The special rule files (FIFO, socket or device named `.gitignore`/`.gitattributes`) Git
 * would open (review fx-397df5a5 F2). Git never reads a rule file in a directory that an
 * in-tree `.gitignore` ignores (so every traversing listing, `ls-files` with in-tree rules
 * only among them, skips it) and that holds no base-tree entry (no tracked path there needs
 * its attributes). The directory of each is asked (`checkIgnored`), shallowest rule files
 * first: such a query reads only the rule files of ancestors up to the first ignored one,
 * and a special one among those was decided at a shallower level (it was exempt, else the
 * first opened one ends the search). A name that cannot be spelled as a query, and a rule
 * file at the root, are never exempt.
 */
async function openedRuleFiles(repo: NeutralGit, excludesFile: string, files: readonly string[], countTracked: (path: string) => number): Promise<string[]> {
	const directoryOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");
	const levelOf = (file: string) => file.split("/").length;
	const ordered = [...files].sort((a, b) => levelOf(a) - levelOf(b) || (a < b ? -1 : a > b ? 1 : 0));
	const exempt = new Map<string, boolean>();
	const opened: string[] = [];
	for (let index = 0; index < ordered.length && !opened.length; ) {
		const level: string[] = [];
		const depth = levelOf(ordered[index]!);
		while (index < ordered.length && levelOf(ordered[index]!) === depth) level.push(ordered[index++]!);
		const queries = [...new Set(level.map(directoryOf))].filter((directory) => directory && !exempt.has(directory) && !directory.includes("\ufffd")).sort();
		(await checkIgnored(repo, excludesFile, queries)).forEach(({ ignored, source }, position) =>
			exempt.set(queries[position]!, ignored && isInTreeRule(source, excludesFile) && !countTracked(queries[position]!)),
		);
		for (const file of level) if (exempt.get(directoryOf(file)) !== true) opened.push(file);
	}
	return opened;
}
/** Whether a `check-ignore`/`status` rule source is an in-tree `.gitignore` (not `info/exclude` or an excludes file). */
const isInTreeRule = (rule: string, excludesFile: string) =>
	!!rule && !isAbsolute(rule) && rule !== excludesFile && (rule === ".gitignore" || rule.endsWith("/.gitignore"));
/** Out-of-tree-ignored directories checked with argv pathspecs (at most 16 KiB) in one listing; more use one whole-tree listing. */
const VISIBILITY_PATHSPEC_LIMIT = 32;
interface IgnoreView {
	excludesFile: string;
	/** Untracked, not ignored paths (nested repositories end in `/`). */
	untracked: string[];
	/** Ignored roots exactly as Git matches them; directories end in `/` and are never descended. */
	roots: string[];
	/** Per root: the rule file whose pattern decided it ("" when Git attributes none). */
	sources: string[];
	digest: string;
}
/**
 * Git's own view of the workspace under one excludes file: one `git status`
 * (`--ignored=matching`, so an ignored directory is reported once and never
 * descended) and one batched `check-ignore -v` for the deciding rule file of
 * every ignored root. Two processes regardless of the number of paths.
 */
async function ignoreView(repo: NeutralGit, excludesFile: string, opaque: readonly string[]): Promise<IgnoreView> {
	const config = ["-c", "core.excludesFile=" + excludesFile, "-c", "core.untrackedCache=false"];
	const status = await gitRecords(repo, [...config, "status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all", "--ignore-submodules=all", "--no-renames", ...opaqueExcludes(opaque)]);
	const untracked: string[] = [];
	const roots: string[] = [];
	for (let index = 0; index < status.records.length; index++) {
		const record = status.records[index]!;
		const code = record.slice(0, 2);
		const path = record.slice(3);
		// A rename/copy record is followed by its origin path (not produced with --no-renames).
		if (/[RC]/.test(code)) index++;
		if (!path || collectorOwned(path)) continue;
		if (code === "??") untracked.push(path);
		else if (code === "!!") roots.push(path);
	}
	const sources: string[] = [];
	if (roots.length) {
		const check = await gitRecords(repo, [...config, "check-ignore", "--verbose", "--non-matching", "-z", "--stdin"], roots, [0, 1]);
		if (check.records.length !== roots.length * 4) throw new Error("result_changed_during_collection");
		roots.forEach((root, index) => {
			if (check.records[index * 4 + 3] !== root) throw new Error("result_changed_during_collection");
			sources.push(check.records[index * 4]!);
		});
	}
	return { excludesFile, untracked, roots, sources, digest: status.digest };
}
interface IgnoredSummary {
	count: number;
	unlisted: number;
	paths: string[];
}
/** Exact count; portable paths sorted and bounded; names that are not portable are counted only. */
function ignoredSummary(paths: string[]): IgnoredSummary {
	const listable = paths.filter((path) => isPortable(path.endsWith("/") ? path.slice(0, -1) : path)).sort();
	return { count: paths.length, unlisted: paths.length - listable.length, paths: listable.slice(0, IGNORED_LIST_LIMIT) };
}
type OutOfTreeExclusion = { path: string; reason: "ignored_out_of_tree"; outerTrackedEntries: number; source: IgnoreSource };
/** `count` withheld entries below `path` (a portable directory or `.`) whose names cannot be listed; never withholds `path`'s other contents. */
type UnlistedExclusion = { path: string; reason: "unlisted"; count: number; outerTrackedEntries: number };
const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ROOT_EXCLUSION);
const depthOf = (path: string) => (path === ROOT_EXCLUSION ? 0 : path.split("/").length);
const keyOf = (path: string) => (path === ROOT_EXCLUSION ? ROOT_EXCLUSION : pathKey(path));
/** Keys of `key` and of each of its ancestors, outermost first (`.` first). */
const ancestorKeys = (key: string) => {
	if (key === ROOT_EXCLUSION) return [ROOT_EXCLUSION];
	const parts = key.split("/");
	return [ROOT_EXCLUSION, ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
};
/**
 * Exclusions for out-of-tree-ignored roots, plus `unlisted` entries for withheld
 * entries whose names cannot be listed (not portable, not UTF-8, or aliasing
 * another name): each is counted at its nearest portable ancestor directory (`.`
 * when there is none), so portable siblings keep their own entries. Beyond
 * `budget` entries the deepest entries aggregate to their parent directories; an
 * aggregate is an annotation (Git already withholds the paths), never a reason
 * to withhold its other contents. Entries are merged by `pathKey`; an `unlisted`
 * entry at or below a listed `ignored_out_of_tree` entry is absorbed into it.
 */
function outOfTreeExclusions(
	hidden: { path: string; source: IgnoreSource; outerTrackedEntries: number }[],
	unlistedEntries: { path: string; outerTrackedEntries: number }[],
	budget: number,
): (OutOfTreeExclusion | UnlistedExclusion)[] {
	const listed = new Map<string, { path: string; sources: Set<IgnoreSource>; outerTrackedEntries: number }>();
	const unlisted = new Map<string, { path: string; count: number; outerTrackedEntries: number }>();
	const addListed = (path: string, sources: Iterable<IgnoreSource>, outerTrackedEntries: number) => {
		const key = keyOf(path);
		const entry = listed.get(key) ?? { path, sources: new Set<IgnoreSource>(), outerTrackedEntries: 0 };
		for (const source of sources) entry.sources.add(source);
		entry.outerTrackedEntries += outerTrackedEntries;
		listed.set(key, entry);
	};
	const addUnlisted = (path: string, count: number, outerTrackedEntries: number) => {
		const key = keyOf(path);
		const entry = unlisted.get(key) ?? { path, count: 0, outerTrackedEntries: 0 };
		entry.count += count;
		entry.outerTrackedEntries += outerTrackedEntries;
		unlisted.set(key, entry);
	};
	for (const root of hidden)
		if (isPortable(root.path)) addListed(root.path, [root.source], root.outerTrackedEntries);
		else addUnlisted(portableAncestor(root.path), 1, root.outerTrackedEntries);
	for (const entry of unlistedEntries) addUnlisted(isPortable(entry.path) ? parentOf(entry.path) : portableAncestor(entry.path), 1, entry.outerTrackedEntries);
	const settle = () => {
		// Outermost listed entries only; then unlisted entries at or below a listed one are absorbed.
		for (const key of [...listed.keys()].sort()) {
			const covering = ancestorKeys(key).slice(0, -1).find((ancestor) => ancestor !== key && listed.has(ancestor));
			if (!covering) continue;
			const entry = listed.get(key)!;
			const outer = listed.get(covering)!;
			for (const source of entry.sources) outer.sources.add(source);
			outer.outerTrackedEntries += entry.outerTrackedEntries;
			listed.delete(key);
		}
		for (const [key, entry] of [...unlisted]) {
			const covering = ancestorKeys(key).find((ancestor) => listed.has(ancestor));
			if (!covering) continue;
			listed.get(covering)!.outerTrackedEntries += entry.outerTrackedEntries;
			unlisted.delete(key);
		}
	};
	settle();
	while (listed.size + unlisted.size > budget) {
		const deepest = Math.max(...[...listed.values(), ...unlisted.values()].map((entry) => depthOf(entry.path)));
		if (deepest === 0) break;
		for (const [key, entry] of [...listed]) {
			if (depthOf(entry.path) !== deepest) continue;
			listed.delete(key);
			addListed(parentOf(entry.path), entry.sources, entry.outerTrackedEntries);
		}
		for (const [key, entry] of [...unlisted]) {
			if (depthOf(entry.path) !== deepest) continue;
			unlisted.delete(key);
			addUnlisted(parentOf(entry.path), entry.count, entry.outerTrackedEntries);
		}
		settle();
	}
	if (listed.size + unlisted.size > budget) throw new Error("exclusion_count_limit");
	return [
		...[...listed.values()].map((entry) => ({
			path: entry.path,
			reason: "ignored_out_of_tree" as const,
			outerTrackedEntries: entry.outerTrackedEntries,
			source: entry.sources.size === 1 ? [...entry.sources][0]! : ("mixed" as const),
		})),
		...[...unlisted.values()].map((entry) => ({ path: entry.path, reason: "unlisted" as const, count: entry.count, outerTrackedEntries: entry.outerTrackedEntries })),
	].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
/** `coveringRoot` under `pathKey`: returns the covering root as Git spelled it. */
function keyedRoots(roots: Iterable<string>): (path: string) => string | undefined {
	const byKey = new Map<string, string>();
	for (const root of roots) {
		const key = pathKey(root);
		if (!byKey.has(key)) byKey.set(key, root);
	}
	const keys = new Set(byKey.keys());
	return (path) => {
		const key = coveringRoot(keys, pathKey(path));
		return key === undefined ? undefined : byKey.get(key);
	};
}
type Exclusion = NonNullable<ResultManifest["exclusions"]>[number];
/**
 * `exclusions` plus withheld names that cannot be listed (`unlisted` at their
 * parent). A name at or below a listed `ignored_out_of_tree` entry is already
 * annotated there; same-key `unlisted` entries are merged.
 */
function withUnlistedNames(exclusions: Exclusion[], withheld: { path: string; outerTrackedEntries: number }[]): Exclusion[] {
	if (!withheld.length) return exclusions;
	const result: Exclusion[] = exclusions.map((entry) => ({ ...entry }));
	for (const { path, outerTrackedEntries } of withheld) {
		const parent = parentOf(path);
		const keys = ancestorKeys(keyOf(parent));
		const outer = result.find((entry) => entry.reason === "ignored_out_of_tree" && keys.includes(keyOf(entry.path)));
		if (outer) {
			outer.outerTrackedEntries += outerTrackedEntries;
			continue;
		}
		const existing = result.find((entry): entry is UnlistedExclusion => entry.reason === "unlisted" && keyOf(entry.path) === keyOf(parent));
		if (existing) {
			existing.count++;
			existing.outerTrackedEntries += outerTrackedEntries;
		} else result.push({ path: parent, reason: "unlisted", count: 1, outerTrackedEntries });
	}
	if (result.length > 1024) throw new Error("exclusion_count_limit");
	return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
interface OperatorMatch extends OperatorRuleFile {
	/** Outermost matched roots among the queried paths (a matched ancestor directory ends in `/`). */
	roots: string[];
	digest: string;
}
/**
 * The queried paths one operator rule file matches ON ITS OWN: Git as a pure matcher
 * (`check-ignore --no-index`, one process per rule file for any number of paths, `-z`
 * streams) in a node-owned Git directory whose work tree is always empty, so no
 * `.gitignore` of the workspace (and no other rule file) can negate an operator
 * pattern. Every ancestor directory is queried too, so a directory pattern
 * (`secrets/`) withholds everything below it, as in Git's own walk. A name that is
 * not valid UTF-8 cannot be queried exactly; while any operator rule exists it is
 * withheld as matched by the first rule file (fail closed).
 */
async function operatorMatches(rules: NeutralRules, paths: readonly string[]): Promise<OperatorMatch[]> {
	if (!rules.operator.length) return [];
	const queries = new Set<string>();
	const lossy: string[] = [];
	for (const path of paths) {
		if (path.includes("\ufffd")) {
			lossy.push(path);
			continue;
		}
		const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
		for (let depth = 1; depth < parts.length; depth++) queries.add(parts.slice(0, depth).join("/") + "/");
		queries.add(path);
	}
	const sorted = [...queries].sort();
	return Promise.all(
		rules.operator.map(async (rule, index) => {
			const matched = new Set<string>();
			let digest = sha256("");
			if (sorted.length) {
				const check = await gitRecords(rules.matcher, ["-c", "core.excludesFile=" + rule.file, "check-ignore", "--no-index", "--verbose", "--non-matching", "-z", "--stdin"], sorted, [0, 1]);
				if (check.records.length !== sorted.length * 4) throw new Error("git_failed");
				sorted.forEach((query, at) => {
					if (check.records[at * 4 + 3] !== query) throw new Error("git_failed");
					const pattern = check.records[at * 4 + 2]!;
					if (pattern && !pattern.startsWith("!")) matched.add(query);
				});
				digest = check.digest;
			}
			const roots = new Set<string>(index === 0 ? lossy : []);
			for (const path of paths) {
				if (path.includes("\ufffd")) continue;
				const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
				let root: string | undefined;
				for (let depth = 1; depth < parts.length && root === undefined; depth++) {
					const ancestor = parts.slice(0, depth).join("/") + "/";
					if (matched.has(ancestor)) root = ancestor;
				}
				if (root === undefined && matched.has(path)) root = path;
				if (root !== undefined) roots.add(root);
			}
			return { ...rule, roots: [...roots].sort(), digest };
		}),
	);
}
/**
 * Classify every untracked path Git ignores on this node. The export follows
 * Git's effective view; each operator rule file is then matched on its own
 * (see `operatorMatches`), and an untracked path any of them matches is not exported.
 * Every comparison between paths from different listings uses `pathKey`.
 *
 * - Decided by an exported in-tree `.gitignore` (or, for a directory decided out
 *   of tree, every path below it is ignored by exported in-tree rules and no
 *   `.gitignore` lies inside it): outside the deliverable by declaration → `ignored`.
 * - A file named like OS junk that the node's own excludes file ignores → `junk`.
 * - Anything else, including rules from a `.gitignore` that is itself not
 *   exported → `ignored_out_of_tree` exclusion with its source (export incomplete).
 */
async function ignoreClassification(
	repo: NeutralGit,
	opaque: readonly string[],
	effectiveView: Promise<IgnoreView>,
	rules: NeutralRules,
	inBoundary: (path: string) => boolean,
	ruleDirectories: string[],
	countTracked: (path: string) => number,
	unlistedBoundaries: { path: string; outerTrackedEntries: number }[],
	budget: number,
) {
	const effective = await effectiveView;
	const roots = effective.roots.map((path, index) => ({ path, source: effective.sources[index]!, excludesFile: effective.excludesFile }));
	// Operator rules win over every in-tree rule: each operator rule file is matched on its
	// own against everything the effective view would export (and against OS-junk-named
	// files it ignores, which are junk only when a node-owned file matches them). A path
	// any operator file matches is withheld whatever the in-tree `.gitignore` files say.
	const junkNamed = effective.roots.filter((path) => !path.endsWith("/") && junkNames.has(basename(path).toLowerCase()));
	const matches = await operatorMatches(rules, [...effective.untracked, ...junkNamed]);
	let exportUntracked = effective.untracked;
	const nodeViews: ((path: string) => string | undefined)[] = [];
	const nodeCovers = (path: string) => nodeViews.some((covers) => covers(path) !== undefined);
	for (const view of matches) {
		const covers = keyedRoots(view.roots);
		if (view.node) nodeViews.push(covers);
		const withheld = new Set<string>();
		exportUntracked = exportUntracked.filter((path) => {
			const root = covers(path);
			if (root) withheld.add(root);
			return !root;
		});
		for (const path of [...withheld].sort()) roots.push({ path, source: view.file, excludesFile: view.source === "excludes_file" ? view.file : "" });
	}
	const coveredByRoot = keyedRoots(roots.map((root) => root.path));
	// A `.gitignore` Git ignores is not exported, so its rules would apply invisibly.
	const unexportedRuleDirectories = new Set(
		roots.filter((root) => /(^|\/)\.gitignore$/i.test(root.path)).map((root) => pathKey(root.path.includes("/") ? root.path.slice(0, root.path.lastIndexOf("/")) : "")),
	);
	const inTree: string[] = [];
	const junk: string[] = [];
	const hidden: { path: string; source: IgnoreSource }[] = [];
	const candidates: { path: string; root: string; source: IgnoreSource }[] = [];
	for (const root of roots) {
		const directory = root.path.endsWith("/");
		const path = directory ? root.path.slice(0, -1) : root.path;
		// A repository boundary at or above the root is its own exclusion.
		if (inBoundary(path)) continue;
		const rule = root.source;
		if (rule && !isAbsolute(rule) && rule !== root.excludesFile && (rule === ".gitignore" || rule.endsWith("/.gitignore"))) {
			if (coveredByRoot(rule)) hidden.push({ path, source: "unexported_gitignore" });
			else inTree.push(root.path);
			continue;
		}
		const source: IgnoreSource = !rule ? "unattributed" : rule === root.excludesFile ? "excludes_file" : "info_exclude";
		// Junk only by the node's own excludes file: a worker-writable source never declares a file junk.
		if (source !== "unattributed" && !directory && junkNames.has(basename(path).toLowerCase()) && nodeCovers(path)) junk.push(root.path);
		else if (source !== "unattributed" && directory) candidates.push({ path, root: root.path, source });
		else hidden.push({ path, source });
	}
	// An out-of-tree-ignored directory is declared in-tree only when the exported
	// rules alone ignore everything below it: no `.gitignore` inside it (Git never
	// reads those), no unexported rule file above it, and nothing below it visible
	// to the in-tree rules (one listing for all such directories).
	const visible = new Set<string>();
	for (const candidate of candidates) {
		const key = pathKey(candidate.path);
		const parts = key.split("/");
		const ruleInside = hasPathAtOrBelow(ruleDirectories, key);
		const unexportedAbove = parts.some((_, length) => unexportedRuleDirectories.has(parts.slice(0, length).join("/")));
		if (ruleInside || unexportedAbove) visible.add(candidate.root);
	}
	const pending = new Set(candidates.map((candidate) => candidate.root).filter((root) => !visible.has(root)));
	if (pending.size) {
		// Up to VISIBILITY_PATHSPEC_LIMIT candidates restrict the traversal to themselves and
		// `--directory` collapses wholly visible directories inside them. Beyond it: one exact
		// (streamed, uncollapsed) whole-tree listing, so an untracked parent never hides the answer.
		const sortedPending = [...pending].sort();
		const pendingByKey = new Map(sortedPending.map((root) => [pathKey(root), root]));
		const pendingKeys = [...pendingByKey.keys()].sort();
		const pendingCovers = keyedRoots(sortedPending);
		const pathspecs = sortedPending.map((root) => ":(top,literal)" + root);
		const restricted = pathspecs.length <= VISIBILITY_PATHSPEC_LIMIT && pathspecs.join("").length <= 16 * 1024;
		const excludes = opaqueExcludes(opaque).slice(2);
		const listing = await gitRecords(repo, [
			"ls-files", "--others", "--exclude-per-directory=.gitignore", "--exclude=.gjc/", "-z",
			...(restricted ? ["--directory", "--no-empty-directory", "--", ...pathspecs, ...excludes] : excludes.length ? ["--", ":(top)", ...excludes] : []),
		]);
		// A repository root Git was kept out of counts as visible content of every candidate it
		// lies in (Git lists an unignored nested repository as `root/`; one the in-tree rules
		// ignore is reported as visible too, which only ever withholds more).
		for (const root of opaque) {
			const candidate = pendingCovers(root + "/");
			if (candidate) visible.add(candidate);
		}
		for (const entry of listing.records) {
			// Visible content inside a candidate, or a collapsed visible directory around candidates.
			const root = pendingCovers(entry);
			if (root) visible.add(root);
			if (entry.endsWith("/")) {
				const key = pathKey(entry);
				for (let index = lowerBoundOf(pendingKeys, key); index < pendingKeys.length && pendingKeys[index]!.startsWith(key); index++)
					visible.add(pendingByKey.get(pendingKeys[index]!)!);
			}
		}
	}
	for (const candidate of candidates)
		if (visible.has(candidate.root)) hidden.push({ path: candidate.path, source: candidate.source });
		else inTree.push(candidate.root);
	// Outermost hidden roots only, so tracked counts are not double counted.
	const hiddenCovers = keyedRoots(hidden.map((entry) => entry.path + "/"));
	const outermost = hidden.filter((entry) => {
		const covering = hiddenCovers(entry.path);
		return !covering || pathKey(covering) === pathKey(entry.path + "/");
	});
	if ((outermost.length || unlistedBoundaries.length) && budget < 1) throw new Error("exclusion_count_limit");
	return {
		outOfTree: outOfTreeExclusions(outermost.map((entry) => ({ ...entry, outerTrackedEntries: countTracked(entry.path) })), unlistedBoundaries, budget),
		ignored: ignoredSummary(inTree),
		junk: ignoredSummary(junk),
		untracked: exportUntracked,
		digests: [effective.digest, ...matches.map((match) => match.source + ":" + match.digest)],
	};
}
export interface WorkspaceIdentity {
	schemaVersion: 1;
	taskId: string;
	attemptId: string;
	nodeId: string;
	inputDigest: string;
	inputPackageDigest?: string;
	repo: string;
	baseCommit: string;
	path: string;
	/** SHA256 of the node-owned collection snapshot recorded at preparation (see `CollectionSnapshot`). */
	collectionSnapshot?: string;
}
/** Node-owned storage for collection snapshots, next to (never inside) the task workspaces. */
export const COLLECTION_SNAPSHOT_DIRECTORY = ".collection-snapshots";
const RULES_LIMIT = 1024 * 1024;
/**
 * Source repository configuration that decides how Git hashes, compares and prints
 * workspace files. Read at preparation and replayed into the neutral repository;
 * no other configuration reaches a collection command.
 */
const COLLECTION_CONFIG_KEYS = Object.freeze([
	"core.autocrlf", "core.bigfilethreshold", "core.checkstat", "core.eol", "core.filemode", "core.ignorecase",
	"core.precomposeunicode", "core.protecthfs", "core.protectntfs", "core.quotepath", "core.safecrlf", "core.symlinks",
	"core.trustctime", "diff.algorithm", "diff.context", "diff.indentheuristic", "diff.interhunkcontext",
	"diff.mnemonicprefix", "diff.noprefix", "diff.suppressblankempty",
]);
/** The operator's ignore rules (rule text, "" when a source holds no pattern). */
interface OperatorRules {
	/** `$GIT_COMMON_DIR/info/exclude` of the source repository. */
	info_exclude: string;
	/** The effective `core.excludesFile` of the source repository (every scope and include, conditions evaluated
	 * on it) when it is not the node's own one: a repository-selected file ("" otherwise). */
	excludes_file: string;
	/** The node's own global/system `core.excludesFile` (else Git's default), evaluated on the source repository. */
	node_excludes_file: string;
}
/** What preparation reads from the source repository (trusted, node-owned) before the worker exists. */
interface SourceFacts {
	objectFormat: "sha1" | "sha256";
	/** Canonical path of the source repository's object directory (the trusted object store). */
	objects: string;
	config: Record<string, string>;
	rules: OperatorRules;
}
/**
 * Everything collection needs besides the workspace files, recorded by the node at
 * preparation outside the workspace and bound to the identity by digest. Collection
 * never reads the workspace's `.git`, admin directory, index, HEAD, refs, config or
 * the source repository's (worker-writable) config and `info/exclude`.
 */
interface CollectionSnapshot extends SourceFacts {
	schema: "fleet-collection-snapshot-v1";
	baseCommit: string;
	/** Filesystem identity (device:inode) of the workspace directory. */
	root: string;
	/** SHA256 of the index file: exactly the base tree, with stat data of the fresh checkout. */
	index: string;
}
const snapshotPath = (workspaceRoot: string, taskId: string, attemptId: string, suffix: "json" | "index") =>
	join(workspaceRoot, COLLECTION_SNAPSHOT_DIRECTORY, taskId + "-" + attemptId + "." + suffix);
/** Rules text, or "" when it holds no pattern (only blank and comment lines, e.g. Git's template). */
async function readRules(file: string): Promise<string> {
	if (!file) return "";
	let text: string;
	try {
		const stats = await stat(file);
		if (!stats.isFile() || stats.size > RULES_LIMIT) throw new Error("ignore_rules_unresolved");
		text = (await readFile(file)).toString("utf8");
	} catch (error: any) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR") return "";
		throw new Error("ignore_rules_unresolved");
	}
	return ruleText(text);
}
/**
 * Operator-owned collection rules of a source root: the node configuration's
 * `collectionRules[repoId]`, in the shape `collectionRules` prints. When set, preparation
 * takes the collection configuration and operator rule text from here and never from
 * the root's shared `.git`, which every worker on the root can write.
 */
export interface CollectionRules {
	config: Record<string, string>;
	info_exclude: string;
	excludes_file: string;
}
/** Rule text holding no pattern (only blank and comment lines) is no rule. */
const ruleText = (text: string) => (text.split(/\r?\n/).some((line) => line.trim() && !line.startsWith("#")) ? text : "");
const configEntry = (key: string, value: string) => {
	if (!COLLECTION_CONFIG_KEYS.includes(key) || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw new Error("collection_config_unsupported");
};
/** The operator's rules as preparation applies them (`collection_config_unsupported` when they cannot be). */
function operatorRules(rules: CollectionRules): Pick<SourceFacts, "config"> & { info_exclude: string; excludes_file: string } {
	const config: Record<string, string> = {};
	for (const [key, value] of Object.entries(rules.config)) {
		configEntry(key, value);
		config[key] = value;
	}
	for (const text of [rules.info_exclude, rules.excludes_file]) if (Buffer.byteLength(text) > RULES_LIMIT) throw new Error("collection_config_unsupported");
	return { config, info_exclude: ruleText(rules.info_exclude), excludes_file: ruleText(rules.excludes_file) };
}
/**
 * Read-only facts of the source repository: object format and store, the
 * collection-relevant configuration (`COLLECTION_CONFIG_KEYS`, as an isolated Git
 * reads it there) and the operator's ignore rules: the shared `info/exclude`, the
 * effective `core.excludesFile` (every scope and include; conditions such as
 * `gitdir:`, `onbranch:` and `hasconfig:remote.*.url:` evaluated on the source
 * repository now) and the node's own global/system excludes file. With `operator`
 * rules (see `CollectionRules`) the configuration, `info/exclude` and repository
 * excludes text are the operator's and the root's shared `.git` is not read for them.
 */
/**
 * Like Promise.all, but settles only after every read has settled, so no Git child started for
 * a check outlives its refusal (review fx-093cc54b F2); the first rejection in order is thrown.
 */
async function allReads<T extends readonly unknown[] | []>(reads: T): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
	const outcomes = await Promise.allSettled(reads);
	for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
	return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value) as { -readonly [K in keyof T]: Awaited<T[K]> };
}
async function sourceFacts(repo: string, untrusted: readonly string[], operator?: CollectionRules): Promise<SourceFacts> {
	const own = operator ? operatorRules(operator) : undefined;
	const [[format, objects, common], config, effective, node] = await allReads([
		gitPaths(repo, untrusted),
		own ? own.config : collectionConfig(repo, untrusted),
		own ? "" : readExcludesConfig(repo, [], undefined, untrusted).then((value) => resolveExcludesValue(repo, value ?? defaultExcludesFile())),
		nodeExcludesValue(repo, undefined, untrusted).then((value) => resolveExcludesValue(repo, value)),
	]);
	if (format !== "sha1" && format !== "sha256") throw new Error("git_failed");
	const [info_exclude, excludes_file, node_excludes_file] = await allReads([
		own ? own.info_exclude : readRules(join(common, "info", "exclude")),
		own ? own.excludes_file : effective && effective !== node ? readRules(effective) : "",
		readRules(node),
	]);
	return { objectFormat: format, objects: await realpath(objects), config, rules: { info_exclude, excludes_file, node_excludes_file } };
}
/**
 * Object format, object directory and common directory of a source repository in one Git
 * process (preparation cost, review fx-9abb2530 F12). A path holding a newline cannot be
 * split from that output: such a repository is read one question at a time.
 */
async function gitPaths(repo: string, untrusted: readonly string[]): Promise<[string, string, string]> {
	const questions = [["--show-object-format"], ["--path-format=absolute", "--git-path", "objects"], ["--path-format=absolute", "--git-common-dir"]];
	if (repo.includes("\n")) return (await allReads(questions.map((question) => git(repo, ["rev-parse", ...question], untrusted)))) as [string, string, string];
	const lines = (await git(repo, ["rev-parse", ...questions.flat()], untrusted)).split("\n");
	if (lines.length !== 3) throw new Error("git_failed");
	return lines as [string, string, string];
}
/** The `COLLECTION_CONFIG_KEYS` values of a repository as an isolated Git reads them (no system or global scope). */
async function collectionConfig(repo: string, untrusted: readonly string[]): Promise<Record<string, string>> {
	const listing = await run(gitArgv(repo, ["config", "--null", "--get-regexp", "^(" + COLLECTION_CONFIG_KEYS.map((key) => key.replace(".", "[.]")).join("|") + ")$"], untrusted), repo, 64 * 1024, isolatedGitEnvironment(repo), undefined, undefined, undefined, [repo, ...untrusted]);
	if (listing.exit !== 0 && (listing.exit !== 1 || listing.stdout))
		throw new Error(gitFailedMessage(listing.exit));
	const config: Record<string, string> = {};
	for (const record of listing.stdout.split("\0").filter(Boolean)) {
		const newline = record.indexOf("\n");
		const key = (newline === -1 ? record : record.slice(0, newline)).toLowerCase();
		// A key without a value is a boolean true; the last value wins, as in Git.
		const value = newline === -1 ? "true" : record.slice(newline + 1);
		configEntry(key, value);
		config[key] = value;
	}
	return config;
}
/**
 * The collection rules a source root holds now (`gjc-fleet collection-rules REPO`), exactly
 * as preparation would read them without operator rules. The operator reviews them and
 * records them as the node configuration's `collectionRules[repoId]`.
 */
export async function collectionRules(repo: string): Promise<CollectionRules> {
	const facts = await sourceFacts(await realpath(repo), []);
	return { config: facts.config, info_exclude: facts.rules.info_exclude, excludes_file: facts.rules.excludes_file };
}
/** A double-quoted Git configuration value. */
const configValue = (value: string) => '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
/** One operator rule file, matched on its own (see `operatorMatches`). */
interface OperatorRuleFile {
	/** Absolute path of the node-written copy of the rule text. */
	file: string;
	source: "info_exclude" | "excludes_file";
	/** The node's own excludes file (global/system/default, at preparation or now). */
	node: boolean;
}
/** Rule files of a neutral repository (absolute paths). */
interface NeutralRules {
	/** The effective excludes file (`nullDevice()` when it holds no pattern). */
	excludesFile: string;
	/** Every operator rule file holding a pattern: snapshotted `info/exclude`, snapshotted repository
	 * excludes file, the node's excludes file as snapshotted and (when it differs) as it is now. */
	operator: OperatorRuleFile[];
	/** A Git directory and an always-empty work tree in which operator rules are matched as a pure matcher. */
	matcher: NeutralGit;
}
/**
 * A throwaway Git directory the node creates in the OS temp dir: `HEAD` is the base
 * commit, objects come from the source repository's store (an alternate; nothing is
 * written there), `info/exclude` and the excludes files hold the snapshotted rules,
 * the configuration is written here from `facts.config` alone, and the index is the
 * snapshotted one (at preparation: the base tree, read here). Git runs with this `GIT_DIR`, the workspace as `GIT_WORK_TREE`, no
 * system or global configuration, and `HOME`/`XDG_CONFIG_HOME` inside this directory;
 * it never discovers or reads the workspace's `.git`. The workspace contributes
 * only its files (the in-tree `.gitignore` and `.gitattributes` among them).
 */
async function neutralRepository(facts: SourceFacts, baseCommit: string, workTree: string, index: SnapshotIndex | undefined, liveNodeRules: string, untrusted: readonly string[]) {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "fleet-collect-")));
	const children = new Set<Promise<unknown>>();
	try {
		const gitDir = join(dir, "git");
		for (const sub of ["objects/info", "refs/heads", "refs/tags", "info"]) await mkdir(join(gitDir, sub), { recursive: true, mode: 0o700 });
		await writeFile(join(gitDir, "HEAD"), baseCommit + "\n", { mode: 0o600 });
		await writeFile(join(gitDir, "objects", "info", "alternates"), facts.objects + "\n", { mode: 0o600 });
		await writeFile(join(gitDir, "info", "exclude"), facts.rules.info_exclude, { mode: 0o600 });
		const ruleFile = async (name: string, text: string) => {
			if (!text) return undefined;
			const file = join(dir, name);
			await writeFile(file, text, { mode: 0o600 });
			return file;
		};
		// Git's own precedence applies to the repository-selected excludes file when there
		// was one at preparation, else to the node's own excludes file as it is now.
		const excludesFile = (await ruleFile("excludes", facts.rules.excludes_file || liveNodeRules)) ?? nullDevice();
		const operator: OperatorRuleFile[] = [];
		for (const [name, text, source, node] of [
			["operator-info-exclude", facts.rules.info_exclude, "info_exclude", false],
			["operator-excludes", facts.rules.excludes_file, "excludes_file", false],
			["node-excludes", facts.rules.node_excludes_file, "excludes_file", true],
			["live-node-excludes", liveNodeRules === facts.rules.node_excludes_file ? "" : liveNodeRules, "excludes_file", true],
		] as const) {
			const file = await ruleFile(name, text);
			if (file) operator.push({ file, source, node });
		}
		const config = (excludes: string) => {
			const sections: Record<string, string[]> = {
				core: [
					"repositoryformatversion = " + (facts.objectFormat === "sha1" ? "0" : "1"),
					"bare = false",
					"attributesFile = " + configValue(nullDevice()),
					"excludesFile = " + configValue(excludes),
					"hooksPath = " + configValue(nullDevice()),
					"fsmonitor = false",
					"untrackedCache = false",
					"splitIndex = false",
					"sparseCheckout = false",
				],
				diff: [],
				index: ["sparse = false"],
				...(facts.objectFormat === "sha1" ? {} : { extensions: ["objectFormat = sha256"] }),
			};
			for (const [key, value] of Object.entries(facts.config)) sections[key.slice(0, key.indexOf("."))]!.push(key.slice(key.indexOf(".") + 1) + " = " + value);
			return Object.entries(sections).map(([name, lines]) => "[" + name + "]\n" + lines.map((line) => "\t" + line + "\n").join("")).join("");
		};
		await writeFile(join(gitDir, "config"), config(excludesFile), { mode: 0o600 });
		const environment = (gitDirectory: string, tree: string, indexFile: string) => ({
			...isolatedGitEnvironment(dir),
			XDG_CONFIG_HOME: dir,
			GIT_DIR: gitDirectory,
			GIT_WORK_TREE: tree,
			GIT_INDEX_FILE: indexFile,
			GIT_ATTR_NOSYSTEM: "1",
		});
		const git: NeutralGit = { cwd: dir, workTree, gitDir, env: environment(gitDir, workTree, join(dir, "index")), children, untrusted };
		// The operator-rule matcher: the same collection configuration (case folding, Unicode
		// composition), no excludes file of its own, an empty `info/exclude` and an empty work
		// tree, so no in-tree `.gitignore` can ever take part in an operator match.
		const matcherDir = join(dir, "matcher");
		const matcherTree = join(dir, "matcher-tree");
		for (const sub of ["objects", "refs", "info"]) await mkdir(join(matcherDir, sub), { recursive: true, mode: 0o700 });
		await mkdir(matcherTree, { mode: 0o700 });
		await writeFile(join(matcherDir, "HEAD"), "ref: refs/heads/matcher\n", { mode: 0o600 });
		await writeFile(join(matcherDir, "config"), config(nullDevice()), { mode: 0o600 });
		const matcher: NeutralGit = { cwd: dir, workTree: matcherTree, gitDir: matcherDir, env: environment(matcherDir, matcherTree, join(dir, "matcher-index")), children, untrusted: [workTree, ...untrusted] };
		const rules: NeutralRules = { excludesFile, operator, matcher };
		// The trusted object store must still hold the base tree (a moved or pruned source repository
		// does not); checked while the collection runs, awaited before any result is returned.
		// `<commit>:` names the root tree without `^`, which a `.cmd`/`.bat` Git shim cannot receive.
		const objectsPresent = run(gitArgv(undefined, ["cat-file", "-e", baseCommit + ":"], [workTree, ...untrusted]), dir, 4096, git.env, undefined, children, undefined, [workTree, ...untrusted]).then((r) => {
			if (r.exit !== 0) throw new Error("source_repository_missing");
		});
		objectsPresent.catch(() => {});
		if (index) {
			await writeFile(join(dir, "index"), index.bytes, { mode: 0o600 });
			// The copy keeps the time its stat data was taken (see `SnapshotIndex`): Git trusts an
			// entry's stat data only when the index file is newer than the file, so a copy dated now
			// would hide a same-size edit made within the stat granularity of preparation.
			await utimes(join(dir, "index"), index.time, index.time);
		}
		// Without one: the index of exactly the base tree, built here; it needs no work tree, so
		// the caller refreshes its stat data (`refreshIndex`) once the files are in place.
		else
			await gitWithIndexWrites(git, ["read-tree", baseCommit]).catch(async (error) => {
				// A source object store without the base tree: report that cause.
				await objectsPresent;
				throw error;
			});
		return { git, dir, rules, objectsPresent };
	} catch (error) {
		await Promise.allSettled([...children]);
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
}
/** Stat data of the work tree's files into a freshly built base index (see `neutralRepository`). */
const refreshIndex = (neutral: NeutralGit) => gitWithIndexWrites(neutral, ["update-index", "-q", "--refresh"], [0, 1]);
/** Every Git child started over a neutral directory exits, then the directory is removed. */
async function removeNeutral(neutral: { git: NeutralGit; dir: string }): Promise<void> {
	for (let settled = -1; settled !== neutral.git.children.size; ) {
		settled = neutral.git.children.size;
		await Promise.allSettled([...neutral.git.children]);
	}
	await rm(neutral.dir, { recursive: true, force: true });
}
/** A neutral-repository command that writes its own (node-owned) index. */
async function gitWithIndexWrites(neutral: NeutralGit, args: string[], okExits: readonly number[] = [0]): Promise<void> {
	const r = await run(gitArgv(undefined, args, [neutral.workTree, ...neutral.untrusted]), neutral.cwd, 64 * 1024, { ...neutral.env, GIT_OPTIONAL_LOCKS: undefined }, undefined, neutral.children, undefined, [neutral.workTree, ...neutral.untrusted]);
	if (!okExits.includes(r.exit)) throw new Error(gitFailedMessage(r.exit));
}
const directoryKey = (stats: { dev: bigint; ino: bigint }) => stats.dev + ":" + stats.ino;
/** The workspace is still the directory preparation created (never a link; same filesystem identity). */
function requireWorkspaceRoot(identity: WorkspaceIdentity, root: string | undefined): void {
	let stats;
	try {
		stats = lstatSync(identity.path, { bigint: true, throwIfNoEntry: false });
		if (stats?.isDirectory() && realpathSync(identity.path) === identity.path && (root === undefined || directoryKey(stats) === root)) return;
	} catch {}
	throw new Error("workspace_identity_mismatch");
}
const SNAPSHOT_FILE_LIMIT = 8 * 1024 * 1024;
/**
 * Write a snapshot file without ever following what is at its name: the bytes go to a
 * fresh, exclusively created (`O_CREAT|O_EXCL`, never through a link) name in the same
 * directory, which is then renamed over the final name. A link or file planted there
 * (the directory is reachable by a same-uid worker) is replaced, never written through.
 */
async function writeSnapshotFile(file: string, bytes: string | Buffer): Promise<void> {
	const temporary = file + "." + randomUUID() + ".tmp";
	try {
		await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
async function readSnapshotFile(file: string, limit: number): Promise<Buffer> {
	try {
		const stats = await lstat(file);
		if (!stats.isFile() || stats.size > limit) throw new Error("collection_snapshot_mismatch");
		return await readFile(file);
	} catch {
		throw new Error("collection_snapshot_mismatch");
	}
}
/**
 * A snapshot pair whose task workspace is gone is never read again: collection and
 * verification need the workspace itself (`workspace_missing` without it). Every
 * preparation removes such pairs, so snapshot files stay bounded by the workspaces
 * that still exist on the node.
 */
async function evictSnapshots(root: string, directory: string): Promise<void> {
	for (const name of await readdir(directory)) {
		const owner = /^([a-zA-Z0-9_-]{1,128}-[a-zA-Z0-9_-]{1,128})\.(?:json|index)$/.exec(name)?.[1];
		if (owner === undefined || lstatSync(join(root, owner), { throwIfNoEntry: false }) !== undefined) continue;
		await rm(join(directory, name), { force: true });
	}
}
/**
 * The verified collection inputs of a prepared workspace. An identity without a
 * snapshot (prepared by a release before snapshots) takes the source root's facts
 * as they are now and a fresh base index: those rules are worker-writable, so the
 * node reports its result with completeness unknown (see `legacyManifest`).
 */
/**
 * A snapshot index and the time Git must take it to have been written: the snapshot index
 * file's modification time in whole seconds (never 0, which disables Git's racy check). That
 * file is written after the index stat data were taken and before preparation returns, so it is
 * never later than any edit a worker or verifier makes afterwards.
 */
interface SnapshotIndex {
	bytes: Buffer;
	time: number;
}
async function collectionInputs(identity: WorkspaceIdentity, untrusted: readonly string[]): Promise<{ facts: SourceFacts; index: SnapshotIndex | undefined; root: string | undefined }> {
	if (identity.collectionSnapshot === undefined) return { facts: await sourceFacts(identity.repo, untrusted), index: undefined, root: undefined };
	const workspaceRoot = dirname(identity.path);
	const bytes = await readSnapshotFile(snapshotPath(workspaceRoot, identity.taskId, identity.attemptId, "json"), SNAPSHOT_FILE_LIMIT);
	if (sha256(bytes) !== identity.collectionSnapshot) throw new Error("collection_snapshot_mismatch");
	const snapshot = JSON.parse(bytes.toString("utf8")) as CollectionSnapshot;
	if (snapshot.schema !== "fleet-collection-snapshot-v1" || snapshot.baseCommit !== identity.baseCommit) throw new Error("collection_snapshot_mismatch");
	const indexFile = snapshotPath(workspaceRoot, identity.taskId, identity.attemptId, "index");
	const index = await readSnapshotFile(indexFile, GIT_LISTING_LIMIT);
	if (sha256(index) !== snapshot.index) throw new Error("collection_snapshot_mismatch");
	let time: number;
	try {
		time = Math.max(1, Math.floor((await lstat(indexFile)).mtimeMs / 1000));
	} catch {
		throw new Error("collection_snapshot_mismatch");
	}
	const { objectFormat, objects, config, rules } = snapshot;
	return { facts: { objectFormat, objects, config, rules }, index: { bytes: index, time }, root: snapshot.root };
}
export interface PreparationInput {
	taskId: string;
	attemptId: string;
	nodeId: string;
	inputDigest: string;
	inputPackageDigest?: string;
	repo: string;
	baseCommit: string;
	workspaceRoot: string;
	/** Work-unit role task (R7): the base tree must not track anything under fleet-review/. */
	reviewDirAbsent?: true;
	/** Work-unit review task: the ref named exactly `refs/heads/<reviewBranch>` must point at `baseCommit`. */
	reviewBranch?: string;
	/** The operator's rules of the source root (node configuration `collectionRules[repoId]`, see `CollectionRules`). */
	collectionRules?: CollectionRules;
}
const checked = Symbol("checkedPreparation");
/** A preparation that passed checkPreparation; `repo` is canonical, `sourceFacts` read before any effect. */
export type CheckedPreparation = PreparationInput & { readonly [checked]: true; readonly sourceFacts: SourceFacts };
export async function prepareWorkspace(
	input: PreparationInput,
): Promise<WorkspaceIdentity> {
	return materializeWorkspace(await checkPreparation(input));
}
/**
 * Every check prepareWorkspace makes before its first effect, and nothing else. It reads only the
 * request, the repository configuration, the operator's ignore rule files (`sourceFacts`:
 * `info/exclude`, the effective and the node's `core.excludesFile`) and the committed tree of `baseCommit`:
 * never the working tree, so ignored or untracked content of the source checkout (installed
 * dependencies, symlinks, nested or linked checkouts) cannot change its outcome, exactly as it
 * cannot change what preparation materializes. Read-only: Git runs with optional locks, hooks,
 * fsmonitor and lazy fetch disabled and no directory is created.
 */
export async function checkPreparation(
	input: PreparationInput,
): Promise<CheckedPreparation> {
	for (const id of [input.taskId, input.attemptId, input.nodeId])
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("invalid_identity");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseCommit))
		throw new Error("exact_commit_required");
	if (!/^[a-f0-9]{64}$/.test(input.inputDigest))
		throw new Error("input_digest_required");
	if (
		input.inputPackageDigest !== undefined &&
		!/^[a-f0-9]{64}$/.test(input.inputPackageDigest)
	)
		throw new Error("input_package_digest_required");
	const repo = await realpath(input.repo);
	if (repo !== resolve(input.repo))
		throw new Error("repository_symlink_forbidden");
	const trees = [input.workspaceRoot];
	// Every read below is independent and read-only: all start at once (one Git round trip on
	// the critical path), and their outcomes are taken in this order, so the first failing
	// check is the one reported, exactly as if they ran one after another.
	const started = <T>(read: () => Promise<T>) => {
		const value = read();
		value.catch(() => {});
		return value;
	};
	const toplevel = started(() => git(repo, ["rev-parse", "--show-toplevel"], trees));
	const commit = started(() => git(repo, ["rev-parse", input.baseCommit + "^{commit}"], trees));
	// No checkout filters, fsmonitor or hooks may run during source preparation.
	const filtersRead = started(async () => run(
		[gitProgram([repo, ...trees]), "-C", repo, "config", "--get-regexp", "^filter[.]"],
		repo,
		4 * 1024 * 1024,
		isolatedGitEnvironment(repo),
		undefined,
		undefined,
		undefined,
		[repo, ...trees],
	));
	// Streamed: a large base tree is not capped at 4 MiB.
	const treeRead = started(() => gitRecords(repo, [
		"ls-tree",
		"-rz",
		"--full-tree",
		input.baseCommit,
	], undefined, [0], trees));
	// The collection configuration and operator rules (see sourceFacts): the operator's own
	// when the node configuration holds them, else the root's. An unreadable rule file or an
	// unsupported configuration is thereby a proven before_send refusal.
	const factsRead = started(() => sourceFacts(repo, trees, input.collectionRules));
	try {
		return await checkedReads();
	} finally {
		// A refusal is returned only after every Git read above has exited (review fx-093cc54b F2).
		await Promise.allSettled([toplevel, commit, filtersRead, treeRead, factsRead]);
	}
	async function checkedReads(): Promise<CheckedPreparation> {
		if ((await realpath(await toplevel)) !== repo)
			throw new Error("repository_root_required");
		if ((await commit) !== input.baseCommit)
			throw new Error("base_commit_mismatch");
		if (input.reviewBranch !== undefined) {
			if (!REVIEW_BRANCH.test(input.reviewBranch)) throw new Error("invalid_identity");
			// Exact, case-sensitive refname from the ref listing (loose and packed alike): rev-parse would resolve a
			// case variant through a case-insensitive file system.
			const wanted = "refs/heads/" + input.reviewBranch + " " + input.baseCommit;
			// Only the named ref (and refs under it) is listed, never every branch, so the output cap is never reached.
			const refs = await git(repo, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/" + input.reviewBranch], trees);
			if (!refs.split("\n").includes(wanted)) throw new Error("review_branch_mismatch");
		}
		const filters = await filtersRead;
		if (filters.exit !== 1 || filters.stdout)
			throw new Error("checkout_filters_not_authorized");
		const tree = await treeRead;
		const names = new Map<string, string>();
		const leaves = new Set<string>();
		for (const row of tree.records.filter(Boolean)) {
			const tab = row.indexOf("\t");
			const name = safeRelative(row.slice(tab + 1));
			if (name === ".fleet-identity.json")
				throw new Error("reserved_identity_path");
			if (excluded(name)) throw new Error("excluded_input:" + name);
			if (input.reviewDirAbsent && name.split("/")[0]!.normalize("NFC").toLowerCase() === "fleet-review")
				throw new Error("role_base_has_review_dir");
			if (leaves.has(name)) throw new Error("case_collision");
			leaves.add(name);
			const components = name.split("/");
			for (let length = 1; length <= components.length; length++) {
				const prefix = components.slice(0, length).join("/");
				const lower = pathKey(prefix);
				if (names.has(lower) && names.get(lower) !== prefix)
					throw new Error("case_collision");
				names.set(lower, prefix);
			}
			// A committed gitlink (submodule) is a nested repository preparation cannot materialize.
			if (row.startsWith("160000 ")) throw new Error("nested_repository");
			if (!row.startsWith("100644 ") && !row.startsWith("100755 "))
				throw new Error("unsupported_tree_entry:" + name);
		}
		return { ...input, repo, sourceFacts: await factsRead, [checked]: true };
	}
}
/** The effectful half of prepareWorkspace; only accepts the result of checkPreparation. */
export async function materializeWorkspace(
	input: CheckedPreparation,
): Promise<WorkspaceIdentity> {
	if (input[checked] !== true) throw new Error("unchecked_preparation");
	const repo = input.repo;
	await mkdir(input.workspaceRoot, { recursive: true, mode: 0o700 });
	const root = await realpath(input.workspaceRoot);
	if (root !== resolve(input.workspaceRoot))
		throw new Error("workspace_root_symlink_forbidden");
	const path = join(root, input.taskId + "-" + input.attemptId);
	try {
		await lstat(path);
		throw new Error("workspace_exists_conflict");
	} catch (e: any) {
		if (e.code !== "ENOENT") throw e;
	}
	// Git for Windows derives its administrative directory from the first
	// checkout basename. Keep that identity short, then use Git's supported move
	// so the final public task/attempt path remains unchanged. No retry/fallback:
	// both paths are new, exclusively owned preparation directories.
	const checkout =
		process.platform === "win32"
			? join(
					root,
					".fleet-prepare-" +
						sha256(input.taskId + "\0" + input.attemptId).slice(0, 24),
				)
			: path;
	const snapshotDirectory = join(root, COLLECTION_SNAPSHOT_DIRECTORY);
	await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
	if ((await realpath(snapshotDirectory)) !== snapshotDirectory) throw new Error("workspace_root_symlink_forbidden");
	await evictSnapshots(root, snapshotDirectory);
	// The collection snapshot, recorded before the worker exists: the source facts read by
	// checkPreparation, the workspace directory's identity and an index of exactly the base
	// tree carrying the fresh checkout's stat data, built in a neutral repository (so
	// later collection compares against the base, never the workspace's own index). The
	// base index is built while Git checks the workspace out; only its stat refresh waits
	// for the checkout. The names are owned by this task attempt (its workspace path was
	// just checked absent); a leftover from a failed preparation is replaced.
	const facts = input.sourceFacts;
	const building = neutralRepository(facts, input.baseCommit, path, undefined, "", [root, repo]);
	building.catch(() => {});
	let index: Buffer;
	try {
		await mkdir(checkout, { mode: 0o700 });
		await git(repo, ["worktree", "add", "--detach", checkout, input.baseCommit], [root]);
		if (checkout !== path) await git(repo, ["worktree", "move", checkout, path], [root]);
		if ((await git(path, ["rev-parse", "HEAD"], [root, repo])) !== input.baseCommit)
			throw new Error("prepared_head_mismatch");
		const neutral = await building;
		try {
			await refreshIndex(neutral.git);
			index = await readFile(neutral.git.env.GIT_INDEX_FILE!);
		} finally {
			await removeNeutral(neutral);
		}
	} catch (error) {
		await building.then(removeNeutral, () => {}).catch(() => {});
		throw error;
	}
	const snapshot: CollectionSnapshot = {
		schema: "fleet-collection-snapshot-v1",
		baseCommit: input.baseCommit,
		root: directoryKey(await lstat(path, { bigint: true })),
		index: sha256(index),
		...facts,
	};
	const snapshotBytes = canonicalJson(snapshot);
	await writeSnapshotFile(snapshotPath(root, input.taskId, input.attemptId, "index"), index);
	await writeSnapshotFile(snapshotPath(root, input.taskId, input.attemptId, "json"), snapshotBytes);
	const identity: WorkspaceIdentity = {
		schemaVersion: 1,
		taskId: input.taskId,
		attemptId: input.attemptId,
		nodeId: input.nodeId,
		inputDigest: input.inputDigest,
		...(input.inputPackageDigest
			? { inputPackageDigest: input.inputPackageDigest }
			: {}),
		repo,
		baseCommit: input.baseCommit,
		path,
		collectionSnapshot: sha256(snapshotBytes),
	};
	await writeFile(
		join(path, ".fleet-identity.json"),
		JSON.stringify(identity),
		{ flag: "wx", mode: 0o600 },
	);
	return identity;
}
export async function readOwnedFile(
	root: string,
	file: string,
	limit = 4 * 1024 * 1024,
): Promise<Buffer> {
	safeRelative(file);
	if (excluded(file)) throw new Error("excluded_artifact");
	await lstat(join(root, file));
	return readAnchored(root, file.split("/"), limit);
}
export interface TestEvidence {
	argv: string[];
	cwd: string;
	exit: number;
	stdout: string;
	stderr: string;
	stdoutDigest: string;
	stderrDigest: string;
	startedAt: string;
	endedAt: string;
}
/** The manifest schema a hub declares it reads (`collect` request `exportCompleteness`). */
export const EXPORT_COMPLETENESS = "exclusions-v1";
export interface ResultManifest {
	schemaVersion: 1;
	/** Absent means full-workspace custody. Selected custody scopes the diff and bytes to these files. */
	custody?: { kind: "selected"; paths: string[]; selectionDigest: string };
	identity: WorkspaceIdentity;
	outputHead: string;
	producer: { platform: string; arch: string; bun: string };
	patch: string;
	patchDigest: string;
	files: {
		path: string;
		bytes: number;
		sha256: string;
		contentBase64: string;
		deleted: boolean;
		mode: number;
		type: "regular" | "deleted";
	}[];
	/** Repository boundaries (`nested_repository`, `gitlink`: nothing at or below them is exported),
	 * out-of-tree-ignored entries (`ignored_out_of_tree` with the deciding `source`; Git already withholds
	 * them, so an aggregated ancestor never withholds its other contents; `.` is the workspace root) and
	 * `unlisted` counts of withheld entries below `path` whose names cannot be listed (not portable, not
	 * UTF-8, or aliasing another name under `pathKey`). Paths compare under `pathKey`. */
	exclusions?: (
		| { path: string; reason: "nested_repository" | "gitlink"; outerTrackedEntries: number }
		| { path: string; reason: "ignored_out_of_tree"; outerTrackedEntries: number; source: IgnoreSource }
		| UnlistedExclusion
	)[];
	// Absent only on stored legacy manifests. Status describes tests, not export.
	exportComplete?: boolean;
	/** Untracked paths ignored by the exported in-tree rules (directories end in `/`): exact count,
	 * names that are not portable counted in `unlisted`, first IGNORED_LIST_LIMIT sorted portable
	 * paths. Absent only on legacy manifests. */
	ignored?: IgnoredSummary;
	/** OS junk files (`OS_JUNK_NAMES`) ignored only out of tree: withheld, same summary shape, never
	 * an exclusion. Absent only on legacy manifests. */
	junk?: IgnoredSummary;
	tests: TestEvidence[];
	status: "verified" | "tests_failed" | "not_run";
}
/**
 * Work-unit review evidence, never part of a result manifest (the node's `provenance` action). Deny by default:
 * any git failure (including "not an ancestor") is false. True only when this workspace's HEAD is still `head`,
 * `head` is a proper descendant of baseCommit, and EVERY commit in baseCommit..head is unreachable from every
 * ref (`refs/*`), from the HEAD and the per-worktree refs (`refs/worktree/*`, `refs/bisect/*`, …) of every
 * other worktree of the repository, and from the reflogs of the repository's refs and main-worktree HEAD. A
 * commit that nothing ever referenced (or that only another linked worktree's reflog names, or that was
 * imported without a ref, such as FETCH_HEAD) cannot be told apart from a new one.
 * The other worktrees are the admin entries of the common dir (a directory listing, never a capped git output),
 * passed to git as `^worktrees/<name>/HEAD` on stdin (never argv): their number is not bounded by either limit.
 * Their per-worktree refs are always loose files under `<entry>/refs/` (a directory listing too), passed the
 * same way as `^worktrees/<name>/<ref>`.
 * This workspace must be a linked worktree of the repository, and the repository root must be its main worktree
 * (not itself a linked worktree); anything else is false.
 */
/** The loose refs under one admin entry's `refs/` (per-worktree refs are never packed); none when it has no `refs/`. */
async function perWorktreeRefs(entry: string, dir = "refs"): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(`${entry}/${dir}`, { withFileTypes: true });
	} catch (e: any) {
		// Only a missing top-level refs/ means "no per-worktree refs"; anything else fails the proof (false).
		if (dir === "refs" && e?.code === "ENOENT") return [];
		throw e;
	}
	const refs: string[] = [];
	for (const e of entries) {
		const name = `${dir}/${e.name}`;
		if (e.isDirectory()) refs.push(...(await perWorktreeRefs(entry, name)));
		else refs.push(name);
	}
	return refs;
}
export async function outputHeadCreated(identity: WorkspaceIdentity, head: string): Promise<boolean> {
	if (typeof head !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head) || head === identity.baseCommit) return false;
	try {
		const trees = workspaceTrees(identity);
		if ((await git(identity.path, ["rev-parse", "HEAD"], trees)) !== head) return false;
		await git(identity.path, ["merge-base", "--is-ancestor", identity.baseCommit, head], trees);
		// Both paths from git itself, in one path form: this workspace's admin entry must be <common>/worktrees/<name>.
		const [ownDir, ownCommon, extra] = (await git(identity.path, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], trees)).split("\n");
		// The repository root must be the main worktree (its git dir is the common dir): ^HEAD, --single-worktree
		// --reflog and the admin entries below cover only that layout. A linked-worktree root is false.
		const [repoDir, common, repoExtra] = (await git(identity.repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], trees)).split("\n");
		if (repoExtra !== undefined || !common || repoDir !== common) return false;
		const admin = `${common}/worktrees/`;
		if (extra !== undefined || ownCommon !== common || !ownDir?.startsWith(admin)) return false;
		const own = ownDir.slice(admin.length);
		if (!own || own.includes("/")) return false;
		const others = (await readdir(admin, { withFileTypes: true })).filter((e) => e.isDirectory() && e.name !== own).map((e) => e.name);
		if (others.some((name) => /[\r\n]/.test(name))) return false;
		const otherRefs: string[] = [];
		for (const name of others) for (const ref of await perWorktreeRefs(admin + name)) otherRefs.push(`worktrees/${name}/${ref}`);
		if (otherRefs.some((ref) => /[\r\n]/.test(ref))) return false;
		const range = await git(identity.repo, ["rev-list", "--count", head, "--not", identity.baseCommit], trees);
		// Run in the repository itself: --single-worktree keeps this workspace's own HEAD reflog out of --reflog.
		// ^HEAD there is the main worktree's HEAD; every other linked worktree's HEAD and per-worktree refs come on stdin.
		const negatives = ["^HEAD", ...others.map((name) => `^worktrees/${name}/HEAD`), ...otherRefs.map((ref) => `^${ref}`)].join("\n") + "\n";
		const outside = await git(identity.repo, ["rev-list", "--count", "--single-worktree", "--stdin", head, "--not", identity.baseCommit, "--glob=refs/*", "--reflog"], trees, negatives);
		return /^[1-9][0-9]*$/.test(range) && outside === range;
	} catch {
		return false;
	}
}
/**
 * Collect a workspace's result. The trust model (DESIGN.md): the worker controls the
 * workspace's files, and nothing else is trusted from it. Collection never reads the
 * workspace's `.git` file or directory, its administrative directory (index, HEAD,
 * refs, `config.worktree`, hooks), the source repository's configuration,
 * `info/exclude`, refs or index: all of those are writable by the worker. It reads
 * - the collection snapshot recorded by the node at preparation (base commit, an index
 *   of exactly the base tree, the operator's ignore rules and collection configuration,
 *   the workspace directory's identity), bound to the identity by digest;
 * - the node's own global/system excludes file as it is now;
 * - the base objects from the source repository's object store (content-addressed);
 * - the workspace directory tree itself: walked without following links or entering
 *   nested repositories, and listed, matched and compared by Git running in a neutral
 *   repository (`neutralRepository`) fed only the inputs above.
 * Every export decision is made against the base tree: worker commits, index edits,
 * refs, config, hooks or alternates change neither what is exported nor what is withheld.
 */
async function collectSelected(
	identity: WorkspaceIdentity,
	tests: TestEvidence[],
	selection: string[],
	repo: NeutralGit,
): Promise<ResultManifest> {
	// Same nested-repository identities full collection uses (`boundaryAncestor` /
	// `identitySet`): a selected path under a nested or bare repo must never export
	// those bytes. NeutralGit's cwd is the throwaway GIT_DIR parent, so pathspecs use
	// `:(top,…)` against GIT_WORK_TREE (the workspace), matching collectWorkspace.
	const scan = await scanWorkspace(identity.path, WORKSPACE_SCAN_LIMITS);
	const identitySet = new Set<string>([...scan.identities, ...scan.bare.map((entry) => entry.identity)]);
	for (const path of selection) {
		if (boundaryAncestor(identity.path, path, identitySet)) throw new Error("selected_nested_repository:" + path);
	}
	let total = 0;
	const head = await workspaceHead(identity);
	const files: ResultManifest["files"] = selection.map((path) => {
		const read = readAnchoredFile(identity.path, path.split("/"), 4 * 1024 * 1024);
		total += read.bytes.length;
		if (total > 16 * 1024 * 1024) throw new Error("artifact_total_limit");
		return {
			path,
			bytes: read.bytes.length,
			sha256: sha256(read.bytes),
			contentBase64: read.bytes.toString("base64"),
			deleted: false,
			mode: read.mode,
			type: "regular" as const,
		};
	});
	const diffArgs = [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--binary",
		identity.baseCommit,
		"--",
		...selection.map((path) => ":(top,literal)" + path),
	];
	const patch = await git(repo, diffArgs);
	if ((await workspaceHead(identity)) !== head || (await git(repo, diffArgs)) !== patch)
		throw new Error("result_changed_during_collection");
	for (const file of files) {
		const again = readAnchoredFile(identity.path, file.path.split("/"), 4 * 1024 * 1024);
		if (again.mode !== file.mode || sha256(again.bytes) !== file.sha256) throw new Error("result_changed_during_collection");
	}
	const legacy = identity.collectionSnapshot === undefined;
	return {
		schemaVersion: 1,
		custody: { kind: "selected", paths: selection, selectionDigest: sha256(canonicalJson(selection)) },
		identity,
		outputHead: head,
		producer: { platform: process.platform, arch: process.arch, bun: Bun.version },
		patch,
		patchDigest: sha256(patch),
		files,
		...(legacy
			? {}
			: {
					exclusions: [],
					exportComplete: true,
					ignored: { count: 0, unlisted: 0, paths: [] },
					junk: { count: 0, unlisted: 0, paths: [] },
				}),
		tests,
		status: !tests.length ? "not_run" : tests.every((test) => test.exit === 0) ? "verified" : "tests_failed",
	};
}
export async function collectResult(
	identity: WorkspaceIdentity,
	tests: TestEvidence[],
	selectedOrCompleteness?: string[] | boolean,
): Promise<ResultManifest> {
	const selectedOutputs = Array.isArray(selectedOrCompleteness) ? selectedOrCompleteness : undefined;
	const readsCompleteness = typeof selectedOrCompleteness === "boolean" ? selectedOrCompleteness : true;
	const selection = selectedOutputs === undefined ? undefined : validateSelectedOutputs(selectedOutputs);
	// The node's own excludes file as it is now (operator-owned), beside the one snapshotted
	// at preparation; read while the snapshot is verified.
	const trees = workspaceTrees(identity);
	const liveRules = liveNodeExcludesFile(identity.path, trees).then((file) => (file === nullDevice() ? "" : readRules(file)));
	liveRules.catch(() => {});
	const inputs = await collectionInputs(identity, trees);
	requireWorkspaceRoot(identity, inputs.root);
	const marker = JSON.parse(
		(await readOwnedFile(identity.path, ".fleet-identity.json")).toString(),
	);
	if (canonicalJson(marker) !== canonicalJson(identity))
		throw new Error("workspace_identity_mismatch");
	const neutral = await neutralRepository(inputs.facts, identity.baseCommit, identity.path, inputs.index, await liveRules, trees);
	let failed = true;
	try {
		if (inputs.index === undefined) await refreshIndex(neutral.git);
		const result = selection
			? await collectSelected(identity, tests, selection, neutral.git)
			: await collectWorkspace(identity, tests, neutral.git, neutral.rules, inputs.root, readsCompleteness).catch(async (error) => {
			// A source object store without the base tree makes every command fail: report that cause.
			await neutral.objectsPresent;
			throw error;
		});
		await neutral.objectsPresent;
		failed = false;
		return result;
	} finally {
		// Every Git child started over the neutral directory exits before it is removed (a
		// process still running there keeps it busy on Windows); a cleanup failure never
		// replaces the collection's own failure.
		for (let settled = -1; settled !== neutral.git.children.size; ) {
			settled = neutral.git.children.size;
			await Promise.allSettled([...neutral.git.children]);
		}
		const removed = rm(neutral.dir, { recursive: true, force: true });
		if (failed) await removed.catch(() => {});
		else await removed;
	}
}
async function collectWorkspace(
	identity: WorkspaceIdentity,
	tests: TestEvidence[],
	repo: NeutralGit,
	rules: NeutralRules,
	root: string | undefined,
	readsCompleteness: boolean,
): Promise<ResultManifest> {
	const validateEntry = (path: string, entryClass: string) => {
		try {
			return safeRelative(path);
		} catch {
			throw new Error("unsafe_result_entry:" + entryClass);
		}
	};
	// The base tree: the node-owned index (streamed; a large repository is not capped at 4 MiB).
	// Consider all outer-tracked entries, not only changed paths. Git continues
	// reporting tracked files even when an ancestor becomes a repository.
	// Every Git listing that does not depend on another starts now and runs beside the walk.
	const stage = gitRecords(repo, ["ls-files", "--stage", "-z"]);
	// No Git process traverses the workspace before the walk: it decides what Git may
	// enter (`opaqueExcludes`) and refuses what Git cannot read without blocking.
	// Bounded inline where Git's ignore decisions are known (`IGNORED_SCAN_LIMITS`), exactly
	// once Git's view says which trees it never enters (`checkScanLimits`).
	let tracking: ((path: string) => number) | undefined;
	const trackingReady = Promise.withResolvers<void>();
	const firstWalk = scanWorkspace(identity.path, WORKSPACE_SCAN_LIMITS, new Set(), {
		ignored: async (paths, special) => {
			await trackingReady.promise;
			if (special.length && (await openedRuleFiles(repo, rules.excludesFile, special, tracking!)).length) throw new Error("unsafe_result_entry:special_file");
			return (await checkIgnored(repo, rules.excludesFile, paths)).map((answer) => answer.ignored);
		},
		tracked: (path) => tracking!(path),
	});
	firstWalk.catch(() => {});
	const trackedSet = new Set<string>();
	for (const row of (await stage).records) {
		// Preparation refuses a base tree holding a gitlink; nothing else can add one here.
		if (row.startsWith("160000 ")) throw new Error("unsafe_result_entry:gitlink");
		trackedSet.add(row.slice(row.indexOf("\t") + 1));
	}
	if (trackedSet.size > TRACKED_ENTRY_LIMIT) throw new Error("tracked_entry_limit");
	for (const path of trackedSet) validateEntry(path, "tracked");
	// Outer-tracked entries sorted by `pathKey`, so a walk-derived spelling finds every
	// Git spelling of the same path (keys preserve the component count).
	const trackedEntries = [...trackedSet].map((path) => ({ key: pathKey(path), path })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	const trackedKeys = trackedEntries.map((entry) => entry.key);
	/** Tracked entries keyed equal to `key` or below `key/`: count and the Git spellings of `key` among them. */
	const trackedUnder = (key: string) => {
		const ranges: [number, number][] = [
			[lowerBoundOf(trackedKeys, key), lowerBoundOf(trackedKeys, key + "\0")],
			[lowerBoundOf(trackedKeys, key + "/"), lowerBoundOf(trackedKeys, key + "0")],
		];
		const depth = key.split("/").length;
		const spellings = new Set<string>();
		let count = 0;
		for (const [start, end] of ranges)
			for (let index = start; index < end; index++) {
				count++;
				spellings.add(trackedEntries[index]!.path.split("/").slice(0, depth).join("/"));
			}
		return { count, spellings };
	};
	const countTracked = (path: string) => trackedUnder(pathKey(path)).count;
	tracking = countTracked;
	trackingReady.resolve();
	/**
	 * What Git may not enter, and what Git cannot read at all. Repository roots and
	 * bare-repository directories holding no base-tree entry are opaque. A rule file
	 * that is a FIFO, socket or device and that Git would open (`openedRuleFiles`), or a
	 * base-tree path that is one, is refused before any traversing Git command runs: Git
	 * would block on it or fail without saying why.
	 */
	const gitSafety = async (scan: WorkspaceScan) => {
		if (scan.specialRuleFiles.length && (await openedRuleFiles(repo, rules.excludesFile, scan.specialRuleFiles, countTracked)).length) throw new Error("unsafe_result_entry:special_file");
		for (const [directory, entries] of scan.listings)
			for (const entry of entries)
				if (entry.kind === "other" && countTracked(directory ? directory + "/" + entry.name : entry.name)) throw new Error("unsafe_result_entry:special_file");
		const bare = scan.bare.filter((entry) => !countTracked(entry.path));
		// Paths that decoded with U+FFFD cannot be Git pathspecs. Keep them out of `opaque`
		// (so no pathspec is emitted) and still report them as non-portable boundaries below;
		// operator ignores / walk collapse must keep Git from entering them.
		const opaque = [...scan.repositories, ...bare.map((entry) => entry.path)].filter(
			(path) => !path.includes("\ufffd"),
		);
		return { bare, opaque: opaque.sort() };
	};
	const safety = async (scan: WorkspaceScan) => {
		const { bare, opaque } = await gitSafety(scan);
		return { scan, bare, ...(await collapseIgnored(repo, rules.excludesFile, opaque, countTracked, !readsCompleteness)) };
	};
	const firstScan = firstWalk.then(safety);
	firstScan.catch(() => {});
	// Changed and deleted tracked names do not depend on the snapshot.
	// The node-owned index holds exactly the base tree: index-to-files is base-to-files.
	const trackedListings = firstScan.then(({ opaque }) =>
		Promise.all([
			git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", ...opaqueExcludes(opaque)]),
			git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--diff-filter=D", "--name-only", "-z", ...opaqueExcludes(opaque)]),
		]),
	);
	trackedListings.catch(() => {});
	const firstViews = firstScan.then(({ opaque }) => ignoreView(repo, rules.excludesFile, opaque));
	firstViews.catch(() => {});
	// Repository boundaries come from the filesystem walk; ignore classification from Git.
	// Walk and Git spellings meet only under `pathKey`; a boundary inside an
	// out-of-tree-ignored directory stays its own exclusion; at the same root the
	// boundary wins.
	// The recheck after reading does not walk again: it proves every walked directory
	// unchanged (`verifyScan`) and reuses the walk; Git's views run again in full.
	let walked: WorkspaceScan | undefined;
	let views0: Promise<IgnoreView> | undefined;
	const exclusionSnapshot = async () => {
		const boundaryEntries = new Map<string, { path: string; reason: "nested_repository" }>();
		// Discovery walks the filesystem, not Git's (ignore-filtered) view of it; the recheck
		// proves the walk unchanged before Git's view runs again.
		if (walked) await verifyScan(walked);
		const { scan, bare, opaque, collapsed, ignoredRoots } = walked ? await safety(walked) : await firstScan;
		walked = scan;
		const views = views0 ? ignoreView(repo, rules.excludesFile, opaque) : (views0 = firstViews);
		views.catch(() => {});
		checkScanLimits(scan, (await views).roots);
		// An ignored directory holding what the walk did not list is one boundary too.
		const withheld = [...new Set([...collapsed, ...deepBoundaries(scan, (await views).roots, countTracked)])].sort();
		// A bare repository directory is a repository root to the collector (Git would list its files).
		// An ignored directory holding repositories is one boundary; those below it are covered by it.
		for (const path of [...withheld, ...scan.repositories, ...bare.map((entry) => entry.path)])
			if (!boundaryEntries.has(pathKey(path))) boundaryEntries.set(pathKey(path), { path, reason: "nested_repository" });
		const collapsedIdentities = withheld.map((path) => {
			const found = directoryIdentity(join(identity.path, path));
			if (found === undefined) throw new Error("result_changed_during_collection");
			return found;
		});
		const identities = new Set([...scan.identities, ...bare.map((entry) => entry.identity), ...collapsedIdentities]);
		const boundaryKeys = new Set<string>();
		const inBoundary = (path: string) => {
			if (!boundaryKeys.size) return false;
			const parts = pathKey(path).split("/");
			for (let length = 1; length <= parts.length; length++) if (boundaryKeys.has(parts.slice(0, length).join("/"))) return true;
			return false;
		};
		const result: NonNullable<ResultManifest["exclusions"]> = [];
		const unlistedBoundaries: { path: string; outerTrackedEntries: number }[] = [];
		// Every spelling of every boundary (walk and Git), each excluded from the patch.
		const spellings = new Set<string>();
		for (const key of [...boundaryEntries.keys()].sort()) {
			const entry = boundaryEntries.get(key)!;
			if (inBoundary(entry.path)) continue;
			boundaryKeys.add(key);
			const tracked = trackedUnder(key);
			spellings.add(entry.path);
			for (const spelling of tracked.spellings) spellings.add(spelling);
			// Reported as Git spells it when exactly one Git spelling exists; a name that
			// cannot be listed is counted at its nearest portable ancestor.
			const path = tracked.spellings.size === 1 ? [...tracked.spellings][0]! : entry.path;
			if (isPortable(path)) result.push({ path, reason: entry.reason, outerTrackedEntries: tracked.count });
			else unlistedBoundaries.push({ path, outerTrackedEntries: tracked.count });
		}
		if (result.length + unlistedBoundaries.length > 1024) throw new Error("exclusion_count_limit");
		const ignore = await ignoreClassification(
			repo,
			opaque,
			views,
			rules,
			inBoundary,
			scan.ruleDirectories,
			countTracked,
			unlistedBoundaries,
			Math.min(OUT_OF_TREE_LIST_LIMIT, 1024 - result.length),
		);
		result.push(...ignore.outOfTree);
		result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		return {
			exclusions: result,
			ignored: ignore.ignored,
			junk: ignore.junk,
			untracked: ignore.untracked,
			digests: ignore.digests,
			boundaries: [...spellings].sort(),
			walk: scan.repositories,
			collapsed: withheld,
			ignoredRoots,
			identities: [...identities].sort(),
			inBoundary,
			identitySet: identities,
		};
	};
	// Everything a second snapshot must reproduce exactly (status output digests included).
	const snapshotDigest = (value: Awaited<ReturnType<typeof exclusionSnapshot>>) => {
		const { inBoundary: _, identitySet: __, ...comparable } = value;
		return comparable;
	};
	const snapshot = await exclusionSnapshot();
	const { ignored, junk, inBoundary } = snapshot;
	const [tracked, deletedListing] = await trackedListings;
	const deleted = new Set(deletedListing.split("\0").filter(Boolean));
	const files: ResultManifest["files"] = [];
	const untrackedNames: string[] = [];
	for (const entry of snapshot.untracked) {
		// Git represents an opaque nested repository/worktree with one trailing slash.
		// Nothing at or below a boundary is exported, whatever its name.
		const directory = entry.endsWith("/");
		const path = directory ? entry.slice(0, -1) : entry;
		if (inBoundary(path)) continue;
		// A link the walk never follows (a Windows junction to a directory holding `.git`) that Git
		// followed and reports as a repository: a stable refusal, not a concurrent change (review fx-6f923f88 F7).
		if (directory) throw new Error((await entryKind(join(identity.path, path))) === "link" ? "unsafe_result_entry:link" : "result_changed_during_collection");
		untrackedNames.push(validateEntry(path, "untracked"));
	}
	// Out-of-tree-ignored roots keyed by `pathKey`: a case/normalization rename that Git reports
	// as deleting `Lib/...` while `lib/` is ignored shares that key. Withhold those deletions
	// (resolve toward withholding); live tracked edits under the ignore still win via the diff.
	const outOfTreeIgnoreKeys = new Set(
		snapshot.exclusions
			.filter((entry) => entry.reason === "ignored_out_of_tree")
			.map((entry) => pathKey(entry.path)),
	);
	const underOutOfTreeIgnore = (path: string) => {
		const parts = pathKey(path).split("/");
		for (let length = 1; length <= parts.length; length++)
			if (outOfTreeIgnoreKeys.has(parts.slice(0, length).join("/"))) return true;
		return false;
	};
	const candidates = [
		...new Set([
			...tracked
				.split("\0")
				.filter(Boolean)
				.map((path) => validateEntry(path, "tracked")),
			...untrackedNames,
		]),
	]
		.filter(
			(path) =>
				path !== ".fleet-identity.json" &&
				!inBoundary(path) &&
				!(deleted.has(path) && underOutOfTreeIgnore(path)),
		)
		.sort();
	// Filesystem identity decides containment wherever spellings cannot (for example
	// Windows 8.3 short names): a name whose directory chain reaches a boundary is
	// withheld, and its Git spelling of that boundary is excluded from the patch.
	// Names that alias each other under `pathKey` cannot be matched to exactly one
	// disk entry: all of them are withheld and counted as `unlisted`.
	const withheldSpellings = new Set<string>();
	// Deletions filtered above still need a pathspec exclude so the binary patch omits them.
	for (const path of deleted)
		if (underOutOfTreeIgnore(path)) withheldSpellings.add(path);
	const byKey = new Map<string, string[]>();
	for (const path of candidates) {
		const depth = boundaryAncestor(identity.path, path, snapshot.identitySet);
		if (depth) {
			withheldSpellings.add(path.split("/").slice(0, depth).join("/"));
			continue;
		}
		const key = pathKey(path);
		const group = byKey.get(key);
		if (group) group.push(path);
		else byKey.set(key, [path]);
	}
	const ambiguous: string[] = [];
	const names: string[] = [];
	for (const group of byKey.values())
		if (group.length === 1) names.push(group[0]!);
		else
			for (const path of group) {
				ambiguous.push(path);
				if (trackedSet.has(path)) withheldSpellings.add(path);
			}
	names.sort();
	const exclusions = withUnlistedNames(snapshot.exclusions, ambiguous.map((path) => ({ path, outerTrackedEntries: trackedSet.has(path) ? 1 : 0 })));
	if (names.length > 1024) throw new Error("artifact_count_limit");
	const patchPaths = [
		"--",
		":(top)",
		":(top,exclude,literal).fleet-identity.json",
		...[...new Set([...snapshot.boundaries, ...withheldSpellings])].sort().map((path) => ":(top,exclude,literal)" + path),
	];
	// Binary diff is bounded by run(); truncated command output is never accepted.
	const patch = await git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...patchPaths]);
	const exportableUntracked = new Set(untrackedNames);
	let total = 0;
	for (const path of names) {
		safeRelative(path);
		if (excluded(path)) throw new Error("excluded_result:" + path);
		// Deleted from Git's view yet present on disk and not an exportable untracked
		// file: Git ignores those bytes, so they are never read (only the deletion).
		if (deleted.has(path) && !exportableUntracked.has(path)) {
			files.push({ path, bytes: 0, sha256: sha256(""), contentBase64: "", deleted: true, mode: 0, type: "deleted" });
			continue;
		}
		try {
			await lstat(join(identity.path, path));
			const { bytes, mode } = readAnchoredFile(
				identity.path,
				path.split("/"),
				4 * 1024 * 1024,
			);
			total += bytes.length;
			if (total > 16 * 1024 * 1024) throw new Error("artifact_total_limit");
			files.push({
				path,
				bytes: bytes.length,
				sha256: sha256(bytes),
				contentBase64: bytes.toString("base64"),
				deleted: false,
				mode,
				type: "regular",
			});
		} catch (e: any) {
			// A listed file that vanished before it was read is a concurrent change (never a raw host path).
			if (e.code === "ENOENT" && !deleted.has(path)) throw new Error("result_changed_during_collection");
			if (e.code !== "ENOENT") throw e;
			files.push({
				path,
				bytes: 0,
				sha256: sha256(""),
				contentBase64: "",
				deleted: true,
				mode: 0,
				type: "deleted",
			});
		}
	}
	// Recheck everything after reading: the Git commands start first and run
	// concurrently with the second walk.
	const recheck = git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--binary", ...patchPaths]);
	recheck.catch(() => {});
	const second = await exclusionSnapshot();
	const patchAfter = await recheck;
	requireWorkspaceRoot(identity, root);
	if (canonicalJson(snapshotDigest(second)) !== canonicalJson(snapshotDigest(snapshot)) || patchAfter !== patch)
		throw new Error("result_changed_during_collection");
	// A hub that does not read export completeness (a release before it) ignores exclusions and
	// would verify the export as complete. It is refused (as that release's collector refused a
	// nested repository) whenever a boundary withholds anything: a name that cannot be listed,
	// or a repository boundary holding a base-tree entry or any entry besides its `.git`. What
	// that release never exported either (ignored content, repositories inside an ignored
	// directory, a `.git` marker alone) stays collectable.
	if (!readsCompleteness) {
		const ignoredKeys = new Set(snapshot.ignoredRoots.map(pathKey));
		for (const entry of exclusions) {
			if (entry.reason === "ignored_out_of_tree" || ignoredKeys.has(pathKey(entry.path))) continue;
			if (entry.reason === "unlisted" || entry.outerTrackedEntries > 0) throw new Error("unsafe_result_entry:export_completeness");
			let names: string[];
			try {
				names = await readdir(join(identity.path, entry.path));
			} catch {
				throw new Error("result_changed_during_collection");
			}
			if (names.some((name) => pathKey(name) !== ".git")) throw new Error("unsafe_result_entry:export_completeness");
		}
	}
	// The export is a diff against the base commit, not against any worker-moved HEAD. `outputHead`
	// stays the workspace HEAD as Git reports it (production's work-unit provenance reads it).
	const head = await workspaceHead(identity);
	return {
		schemaVersion: 1,
		identity,
		outputHead: head,
		producer: {
			platform: process.platform,
			arch: process.arch,
			bun: Bun.version,
		},
		patch,
		patchDigest: sha256(patch),
		files,
		exclusions,
		exportComplete: exclusions.length === 0,
		ignored,
		junk,
		tests,
		status: !tests.length
			? "not_run"
			: tests.every((t) => t.exit === 0)
				? "verified"
				: "tests_failed",
	};
}
/**
 * The workspace HEAD for `outputHead` (provenance only, never an export decision): the one Git
 * process of collection that discovers the worker-controlled workspace `.git` (and whatever a `.git`
 * file names), bounded by `COLLECTION_GIT_TIMEOUT_MS` and by `GIT_CEILING_DIRECTORIES` at the
 * workspace parent so a missing `.git` cannot adopt an ancestor checkout. Any failure, timeout or
 * output that is not a
 * commit id gives the base commit, which `outputHeadCreated` treats as no output head created
 * (deny by default; review fx-6f923f88 F4). It runs with `-C` from a node-owned directory, never
 * with its cwd inside the workspace (rv10 LOW-2). A directory it cannot remove (on Windows a timed-out
 * Git's orphaned child can keep it busy) is left behind and never changes the value (review b7481b8b F2).
 */
async function workspaceHead(identity: WorkspaceIdentity): Promise<string> {
	let cwd: string | undefined;
	try {
		cwd = await realpath(await mkdtemp(join(tmpdir(), "fleet-head-")));
		const trees = workspaceTrees(identity);
		const spec = gitSpawn(identity.path, ["rev-parse", "HEAD"], trees);
		// Stop at the workspace parent. A deleted workspace `.git` must not walk into an
		// ancestor repository (TMPDIR nested under another checkout). A `.git` file in this
		// workspace is still read, including a worktree gitdir outside the workspace.
		const ceiling = dirname(realpathSync(identity.path));
		const r = await run(
			spec.argv,
			cwd,
			64 * 1024,
			{ ...spec.env, GIT_CEILING_DIRECTORIES: ceiling },
			COLLECTION_GIT_TIMEOUT_MS,
			undefined,
			undefined,
			trees,
		);
		const head = r.stdout.trimEnd();
		if (r.exit === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) return head;
	} catch {
	} finally {
		if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
	return identity.baseCommit;
}
/**
 * The result of an identity prepared without a collection snapshot, as `legacy-v1`
 * (no exclusions, completeness or ignored summaries): its rules were read at
 * collection from the worker-writable source root, so its export completeness is
 * unknown, and the hub verifies it only after an operator accepts that export.
 */
export function legacyManifest(manifest: ResultManifest): ResultManifest {
	const { exclusions: _exclusions, exportComplete: _complete, ignored: _ignored, junk: _junk, ...legacy } = manifest;
	return legacy;
}
/** What the workspace holds at a stored path the collection withheld (the manifest entry without its content). */
export type WithheldFile = Omit<ResultManifest["files"][number], "contentBase64"> | { path: string; type: "unreadable" };
/**
 * Review fx-1091e277 F2: for each of `stored` (the file paths of a stored legacy-v1 manifest under
 * explicit verification) that `manifest` lacks and that lies at or below one of its boundaries
 * (never the root marker), what the workspace holds there, read as the collector reads a file
 * (no link followed, 4 MiB each, 16 MiB in total), so the hub compares those stored bytes too.
 * A path that does not exist is `deleted`; anything else not readable is `unreadable`, which no
 * stored entry matches (deny by default). Nothing here enters the manifest or a digest.
 */
export async function withheldFiles(root: string, manifest: ResultManifest, stored: readonly string[]): Promise<WithheldFile[]> {
	const present = new Set(manifest.files.map((file) => file.path));
	const boundaries = (manifest.exclusions ?? []).filter((entry) => entry.path !== ROOT_EXCLUSION).map((entry) => pathKey(entry.path));
	const out: WithheldFile[] = [];
	let total = 0;
	for (const path of new Set(stored)) {
		safeRelative(path);
		const key = pathKey(path);
		if (present.has(path) || !boundaries.some((boundary) => key === boundary || key.startsWith(boundary + "/"))) continue;
		try {
			await lstat(join(root, path));
			const { bytes, mode } = readAnchoredFile(root, path.split("/"), 4 * 1024 * 1024);
			total += bytes.length;
			if (total > 16 * 1024 * 1024) throw new Error("artifact_total_limit");
			out.push({ path, bytes: bytes.length, sha256: sha256(bytes), deleted: false, mode, type: "regular" });
		} catch (e: any) {
			if (e?.message === "artifact_total_limit") throw e;
			if (e?.code === "ENOENT" || e?.code === "ENOTDIR") out.push({ path, bytes: 0, sha256: sha256(""), deleted: true, mode: 0, type: "deleted" });
			else out.push({ path, type: "unreadable" });
		}
	}
	return out;
}
export async function testWorkspace(
	identity: WorkspaceIdentity,
	argv: string[],
): Promise<TestEvidence> {
	const marker = JSON.parse(
		(await readOwnedFile(identity.path, ".fleet-identity.json")).toString(),
	);
	if (canonicalJson(marker) !== canonicalJson(identity))
		throw new Error("workspace_identity_mismatch");
	const startedAt = new Date().toISOString();
	const r = await run(
		argv,
		identity.path,
		4 * 1024 * 1024,
		undefined,
		undefined,
		undefined,
		undefined,
		workspaceTrees(identity),
	);
	return {
		...r,
		cwd: identity.path,
		stdoutDigest: sha256(r.stdout),
		stderrDigest: sha256(r.stderr),
		startedAt,
		endedAt: new Date().toISOString(),
	};
}
