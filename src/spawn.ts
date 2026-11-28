import {
	spawn as nodeSpawn,
	type ChildProcessWithoutNullStreams,
	type SpawnOptions,
} from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

/**
 * The single process-start choke point.
 *
 * Bun (libuv) resolves a bare program name on Windows in the spawn working
 * directory (or the parent's, when none is given) BEFORE PATH, so starting
 * `git` with a worker-controlled tree as cwd runs a planted git.exe/.cmd/.bat.
 * Every process this package starts goes through `resolveProgram`, which only
 * ever returns an absolute path found in a trusted PATH entry:
 * - never the working directory (no implicit `.`; empty/relative entries skipped);
 * - never a PATH entry equal to the spawn working directory;
 * - never a directory inside, or aliasing, a caller-declared worker-controlled
 *   root, nor a file whose real path lies inside one. Aliases are compared by
 *   long, case-normalized real path (symlinks, junctions, 8.3 names) and by
 *   filesystem identity of every ancestor (UNC/admin-share forms);
 * - on Windows, never a UNC, device-namespace or drive/root-relative entry.
 */

const WIN = process.platform === "win32";
/** Executable suffixes Bun's own Windows lookup tries, in its order. */
const WIN_SUFFIXES = [".exe", ".cmd", ".bat"];
/**
 * Bare name Fleet Git resolves. On Windows this is `git.exe` only so a trusted
 * PATH directory that holds only `git.cmd`/`git.bat` cannot win ahead of a later
 * `git.exe` (general `resolveProgram` still searches `.exe`/`.cmd`/`.bat`).
 */
export const FLEET_GIT_NAME = WIN ? "git.exe" : "git";
export const NULL_DEVICE = WIN ? "NUL" : "/dev/null";

export class UntrustedProgramError extends Error {
	readonly code = "EACCES";
	constructor(program: string) {
		super("untrusted_program_path:" + program);
	}
}

function notFound(program: string): Error {
	// Same message, code and errno Bun.spawn uses for an unresolvable bare name.
	return Object.assign(
		new Error(`Executable not found in $PATH: "${program}"`),
		{ code: "ENOENT", errno: WIN ? -4058 : -2, path: program },
	);
}

/** Absolute in the strict sense: drive-absolute on Windows (no UNC, device, root- or drive-relative). */
function strictlyAbsolute(path: string): boolean {
	return WIN ? /^[A-Za-z]:[\\/]/.test(path) : posix.isAbsolute(path);
}
function hasSeparator(path: string): boolean {
	return path.includes("/") || (WIN && path.includes("\\"));
}

/** Long, case-normalized real path; a missing tail is appended to the real path of its longest existing prefix. */
function canonical(path: string): string {
	let head = resolve(path);
	const tail: string[] = [];
	for (;;) {
		try {
			const full = join(realpathSync.native(head), ...tail);
			return WIN ? full.toLowerCase() : full;
		} catch (error: any) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
			const parent = dirname(head);
			if (parent === head) {
				const full = join(head, ...tail);
				return WIN ? full.toLowerCase() : full;
			}
			tail.unshift(basename(head));
			head = parent;
		}
	}
}
function identity(path: string): string | undefined {
	try {
		const s = statSync(path, { bigint: true });
		return `${s.dev}:${s.ino}`;
	} catch {
		return undefined;
	}
}
function within(child: string, parent: string): boolean {
	const sep = WIN ? "\\" : "/";
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

interface Root {
	path: string;
	id?: string;
}
function roots(paths: readonly string[]): Root[] {
	return paths.map((p) => {
		const path = canonical(p);
		return { path, id: identity(path) };
	});
}
/** Canonical path plus the filesystem identity of every existing ancestor (itself included). */
interface Location {
	path: string;
	ids: Set<string>;
}
function locate(path: string): Location {
	const canon = canonical(path);
	const ids = new Set<string>();
	for (let p = canon; ; p = dirname(p)) {
		const id = identity(p);
		if (id) ids.add(id);
		if (dirname(p) === p) return { path: canon, ids };
	}
}
/** True when the location is, or is inside, any root: by canonical path or by identity of any ancestor. */
function inside(location: Location, list: Root[]): boolean {
	return list.some((r) => within(location.path, r.path) || (r.id !== undefined && location.ids.has(r.id)));
}

function pathEntries(): string[] {
	const raw = process.env.PATH ?? "";
	return raw
		.split(WIN ? ";" : ":")
		.map((e) => (WIN ? e.replace(/^"(.*)"$/, "$1") : e))
		.filter((e) => e && strictlyAbsolute(e));
}
function executableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		if (!WIN) accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Cached locations of trusted-PATH directories (operator-controlled, so stable for the process). */
const locationCache = new Map<string, Location>();
function cachedLocation(path: string): Location {
	let location = locationCache.get(path);
	if (!location) locationCache.set(path, (location = locate(path)));
	return location;
}
interface Candidate {
	file: string;
	/** PATH entry that held the file when the snapshot was taken (operator-controlled). */
	dir: Location;
}
/**
 * Cache: PATH snapshot + program name -> candidate path strings in lookup order.
 * Cached `realpath` results are never reused: each resolve re-reads the file and
 * re-checks the trust boundary (a PATH entry can become a symlink into an
 * untrusted tree after the snapshot).
 */
const candidateCache = new Map<string, Candidate[]>();
function candidates(program: string): Candidate[] {
	const key = (process.env.PATH ?? "") + "\0" + program;
	const cached = candidateCache.get(key);
	if (cached) return cached;
	const names =
		WIN && !WIN_SUFFIXES.includes(win32.extname(program).toLowerCase())
			? WIN_SUFFIXES.map((s) => program + s)
			: [program];
	const found: Candidate[] = [];
	for (const dir of pathEntries())
		for (const name of names) {
			const file = (WIN ? win32 : posix).join(dir, name);
			if (!executableFile(file)) continue;
			found.push({ file, dir: cachedLocation(dir) });
		}
	candidateCache.set(key, found);
	return found;
}

/** An entry the process may not traverse holds no runnable program, so it is dropped, not fatal. */
function isUnreadable(path: string): boolean {
	try {
		canonical(path);
		return false;
	} catch (error: any) {
		if (error?.code === "EACCES") return true;
		throw error;
	}
}

export interface TrustContext {
	/** Working directory the child will get; the parent's cwd when undefined. */
	cwd?: string;
	/** Worker-controlled trees (workspaces, source/import repositories, candidate roots). */
	untrusted?: readonly string[];
}

/**
 * Absolute program path from the trusted PATH only. A program given with a
 * path must be absolute and outside every untrusted root. A missing absolute
 * path is returned unchanged so the spawn reports Bun's own ENOENT.
 */
export function resolveProgram(program: string, context: TrustContext = {}): string {
	if (typeof program !== "string" || !program || program.includes("\0"))
		throw new Error("invalid_argv");
	const untrusted = roots(context.untrusted ?? []);
	if (hasSeparator(program) || strictlyAbsolute(program)) {
		if (!strictlyAbsolute(program)) throw new UntrustedProgramError(program);
		let real: string;
		try {
			real = realpathSync.native(program);
		} catch {
			return program;
		}
		if (inside(locate(dirname(program)), untrusted) || inside(locate(real), untrusted))
			throw new UntrustedProgramError(program);
		return program;
	}
	const cwd = canonical(context.cwd ?? process.cwd());
	for (const { file, dir } of candidates(program)) {
		// Fresh existence + realpath + trust check every call; never trust a cached real location.
		if (!executableFile(file) || dir.path === cwd || inside(dir, untrusted)) continue;
		let real: string;
		try {
			real = realpathSync.native(file);
		} catch {
			continue;
		}
		if (inside(locate(dirname(file)), untrusted) || inside(locate(real), untrusted)) continue;
		return file;
	}
	throw notFound(program);
}

/**
 * PATH for children: only strictly absolute entries outside every untrusted root.
 * Each entry is re-located on every call (never `cachedLocation`): a PATH directory
 * can become a symlink/junction into an untrusted tree after the process-start snapshot,
 * the same way `resolveProgram` re-checks program realpaths at resolve time.
 */
export function trustedPathValue(context: TrustContext = {}): string {
	const untrusted = roots(context.untrusted ?? []);
	return pathEntries()
		.filter((e) => !isUnreadable(e) && !inside(locate(e), untrusted))
		.join(WIN ? ";" : ":");
}

/** Bun.spawn options plus worker-controlled trees for `resolveProgram`. */
export type TrustedSpawnOptions<
	In extends Bun.SpawnOptions.Writable = Bun.SpawnOptions.Writable,
	Out extends Bun.SpawnOptions.Readable = Bun.SpawnOptions.Readable,
	Err extends Bun.SpawnOptions.Readable = Bun.SpawnOptions.Readable,
> = Bun.SpawnOptions.OptionsObject<In, Out, Err> & {
	untrusted?: readonly string[];
};

/** Bun.spawn with argv[0] resolved by `resolveProgram`; cwd and env are passed through unchanged. */
export function spawnTrusted<
	const In extends Bun.SpawnOptions.Writable = "ignore",
	const Out extends Bun.SpawnOptions.Readable = "pipe",
	const Err extends Bun.SpawnOptions.Readable = "pipe",
>(
	argv: string[],
	options: TrustedSpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
	if (!Array.isArray(argv) || !argv.length) throw new Error("invalid_argv");
	const { untrusted, ...rest } = options;
	const program = resolveProgram(argv[0]!, {
		cwd: typeof rest.cwd === "string" ? rest.cwd : undefined,
		untrusted,
	});
	return Bun.spawn([program, ...argv.slice(1)], rest);
}

/** node:child_process spawn with the command resolved by `resolveProgram` (process-group callers). */
export function spawnTrustedNode(
	command: string,
	args: string[],
	options: SpawnOptions & { untrusted?: readonly string[] },
): ChildProcessWithoutNullStreams {
	const { untrusted, ...rest } = options;
	const cwd = typeof rest.cwd === "string" ? rest.cwd : rest.cwd?.toString();
	return nodeSpawn(
		resolveProgram(command, { cwd, untrusted }),
		args,
		rest,
	) as ChildProcessWithoutNullStreams;
}

/**
 * Environment for every Git child. Starts from nothing (callers that merge it
 * into process.env get every inherited GIT_* variable cleared):
 * PATH = trusted PATH (strictly absolute entries outside repo/untrusted);
 * HOME = repo (unchanged: keeps the user's home files out; with no global
 * config Git still reads <repo>/.config/git/{ignore,attributes}, which only
 * select files/attributes and cannot start a program); on Windows SystemRoot,
 * WINDIR, TEMP, TMP; GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=NUL|/dev/null,
 * GIT_NO_REPLACE_OBJECTS=1, GIT_NO_LAZY_FETCH=1, GIT_TERMINAL_PROMPT=0,
 * GIT_OPTIONAL_LOCKS=0, GIT_EDITOR=: and GIT_SEQUENCE_EDITOR=: (":" is Git's
 * built-in no-op editor; outranks core.editor/sequence.editor). Never edits
 * system, user or repository config.
 */
export function isolatedGitEnvironment(
	repo: string,
	untrusted: readonly string[] = [],
): Record<string, string | undefined> {
	return {
		...Object.fromEntries(
			Object.keys(process.env)
				.filter((key) => /^GIT_/i.test(key))
				.map((key) => [key, undefined]),
		),
		PATH: trustedPathValue({ untrusted: [repo, ...untrusted] }),
		HOME: repo,
		...(WIN
			? {
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					TEMP: process.env.TEMP,
					TMP: process.env.TMP,
				}
			: {}),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: NULL_DEVICE,
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_EDITOR: ":",
		GIT_SEQUENCE_EDITOR: ":",
	};
}

/**
 * Options in front of every Git command: no hooks, no fsmonitor, no untracked
 * cache, no pager, no transport (so no ssh/sshCommand, proxy, credential helper
 * or upload-pack hook), and long paths on Windows.
 */
export const GIT_HARDENING: readonly string[] = [
	...(WIN ? ["-c", "core.longpaths=true"] : []),
	"--no-pager",
	"-c",
	"core.hooksPath=" + NULL_DEVICE,
	"-c",
	"core.fsmonitor=false",
	"-c",
	"core.untrackedCache=false",
	"-c",
	"protocol.allow=never",
];

export interface GitSpawnOptions {
	stdin?: "ignore" | Buffer | Uint8Array;
	stderr?: "pipe" | "ignore";
	/** Worker-controlled trees besides `repo` itself. */
	untrusted?: readonly string[];
	/** Extra top-level options, e.g. --literal-pathspecs. */
	flags?: readonly string[];
	/** Explicit absolute git (onboarding's configured paths.git); otherwise resolved from trusted PATH. */
	program?: string;
}

function gitArgv(repo: string, args: string[], options: GitSpawnOptions = {}) {
	const target = resolve(repo);
	const untrusted = [target, ...(options.untrusted ?? [])];
	const git = resolveProgram(options.program ?? FLEET_GIT_NAME, { untrusted });
	return {
		target,
		git,
		argv: [git, ...GIT_HARDENING, ...(options.flags ?? []), "-C", target, ...args] as string[],
		cwd: dirname(git),
		env: isolatedGitEnvironment(target, options.untrusted),
	};
}

/**
 * Start Git against `repo` via `-C <absolute repo>`, from a working directory
 * outside every worker-controlled tree (the trusted directory holding git).
 */
export function spawnGit(repo: string, args: string[], options: GitSpawnOptions = {}) {
	const prepared = gitArgv(repo, args, options);
	return Bun.spawn(prepared.argv, {
		// Never the repository: the trusted directory holding git (checked above).
		cwd: prepared.cwd,
		env: prepared.env,
		stdin: options.stdin ?? "ignore",
		stdout: "pipe",
		stderr: options.stderr ?? "pipe",
	});
}

/**
 * Synchronous counterpart of `spawnGit` for scripts that must stay sync
 * (`export-public`, `privacy-scan`). Same absolute-git / cwd / hardening rules.
 */
export function spawnGitSync(repo: string, args: string[], options: GitSpawnOptions = {}) {
	const prepared = gitArgv(repo, args, options);
	return Bun.spawnSync(prepared.argv, {
		cwd: prepared.cwd,
		env: prepared.env,
		stdin: options.stdin ?? "ignore",
		stdout: "pipe",
		stderr: options.stderr ?? "pipe",
	});
}
