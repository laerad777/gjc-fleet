// Builds the clean public export tree.
//
// Usage: bun scripts/export-public.ts --out PATH [--repo PATH] [--exclude FILE] [--deny-list FILE]
//
// Copies every file tracked at HEAD of --repo (default: the repository containing cwd) into the
// NEW directory --out (refused when it exists and is not empty), except the paths listed in the
// exclude file (default: scripts/export-exclude.json as committed at HEAD). The files are written
// to a private staging directory next to --out and the privacy scan runs on it; only a clean scan
// publishes it as --out (one rename). Any finding fails the export (exit 1); then, as on every
// other failure, nothing is published and the staging directory is removed. Usage, refusal and
// filesystem errors exit 2 (a filesystem error prints only its errno code; a git error only its
// subcommand and exit status, never its stderr). HEAD paths that the candidate packager's safePath() refuses
// (scripts/candidate-package.ts: .git in any case/HFS form, device names, reserved characters,
// non-NFC, 8.3 aliases, over-long paths, ...) are refused before anything is written, on every host.
// Every path a message prints goes through the privacy scan's redaction, with the deny words loaded.
// The scan of the output walks .git directories too.
//
// Not to be confused with src/result-export.ts (the Fleet `export` command for run results).
//
// Read-only towards the source repository: it only runs `git rev-parse`, `git ls-tree` and
// `git cat-file`. It never pushes, never configures a remote and never initialises a repository.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnGitSync } from "../src/spawn";
import { CandidateRefusal, safePath } from "./candidate-package";
import { ConfigError, formatFinding, fsErrorCode, gitFailure, loadDenyWords, loadOptions, redactPath, scanFiles, summarize, walkDirectory } from "./privacy-scan";

export const EXCLUDE_FILE = "scripts/export-exclude.json";

export interface ExcludeEntry {
	path: string;
	reason: string;
}

export interface ExportResult {
	code: number;
	stdout: string[];
	stderr: string[];
}

export function parseExcludeList(text: string): ExcludeEntry[] {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		throw new ConfigError("exclude list is not valid JSON");
	}
	const entries = (data as { exclude?: unknown })?.exclude;
	if (!Array.isArray(entries)) throw new ConfigError('exclude list must be {"exclude": [{"path", "reason"}]}');
	return entries.map((entry, i) => {
		const { path, reason } = (entry ?? {}) as ExcludeEntry;
		if (typeof path !== "string" || path === "" || path.includes("\\") || path.startsWith("/") || path.split("/").some((s) => s === "" || s === "." || s === ".."))
			throw new ConfigError(`exclude entry ${i}: path must be a repository-relative '/'-separated file path`);
		if (typeof reason !== "string" || reason.trim() === "") throw new ConfigError(`exclude entry ${i}: a reason is required`);
		return { path, reason };
	});
}

interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

function git(cwd: string, args: string[], input?: Uint8Array): Buffer {
	// stderr is not captured: it can carry the repository path, a gitdir, a remote URL or a token, so a
	// failure reports only the subcommand and its exit status. Absolute git + cwd outside the repo
	// (spawnGitSync) so a planted `git` under the tree cannot run.
	const r = spawnGitSync(cwd, args, {
		flags: ["-c", "core.quotepath=off"],
		stdin: input ?? "ignore",
		stderr: "ignore",
	});
	if (r.exitCode !== 0) throw gitFailure(args[0]!, r.exitCode);
	return Buffer.from(r.stdout);
}

function headTree(root: string): TreeEntry[] {
	const out = git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]).toString("utf8");
	return out
		.split("\0")
		.filter((l) => l !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, type, oid] = line.slice(0, tab).split(" ") as [string, string, string];
			return { mode, type, oid, path: line.slice(tab + 1) };
		});
}

/** Reads the blobs with one `git cat-file --batch` process. */
function readBlobs(root: string, oids: readonly string[]): Map<string, Buffer> {
	const out = git(root, ["cat-file", "--batch"], new TextEncoder().encode(oids.map((o) => `${o}\n`).join("")));
	const blobs = new Map<string, Buffer>();
	let pos = 0;
	for (const oid of oids) {
		const nl = out.indexOf(10, pos);
		const [gotOid, type, size] = out.subarray(pos, nl).toString("utf8").split(" ");
		if (gotOid !== oid || type !== "blob") throw new ConfigError(`unexpected object for ${oid}`);
		const start = nl + 1;
		const end = start + Number(size);
		blobs.set(oid, out.subarray(start, end));
		pos = end + 1;
	}
	return blobs;
}

/** Canonical form of a path that may not exist yet: realpath of its nearest existing ancestor. */
function canonical(path: string): string {
	const rest: string[] = [];
	let cur = resolve(path);
	while (!existsSync(cur)) {
		const parent = dirname(cur);
		if (parent === cur) break;
		rest.unshift(basename(cur));
		cur = parent;
	}
	return join(realpathSync.native(cur), ...rest);
}

/** The safePath() rule a HEAD path breaks, or undefined when it is portable. */
function unportableRule(path: string): string | undefined {
	try {
		safePath(path);
		return undefined;
	} catch (error) {
		// Only the rule: the refusal detail quotes the raw path.
		if (error instanceof CandidateRefusal) return error.rule;
		throw error;
	}
}

/** The absolute target of a HEAD path under outAbs; refuses anything that would resolve outside it. */
function targetInside(outAbs: string, path: string, shown: (path: string) => string): string {
	const target = resolve(outAbs, ...path.split("/"));
	const rel = relative(outAbs, target);
	if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`))
		throw new ConfigError(`tracked path resolves outside --out: ${shown(path)}`);
	return target;
}

/**
 * Checks --out (absent, or an empty directory) without populating it; creates its parent when missing
 * and returns true then. A created parent is never removed, also not when the export fails.
 */
function prepareOut(out: string): boolean {
	try {
		if (existsSync(out)) {
			const info = lstatSync(out);
			if (!info.isDirectory()) throw new ConfigError("--out exists and is not a directory");
			if (readdirSync(out).length > 0) throw new ConfigError("--out exists and is not empty");
		} else if (!existsSync(dirname(out))) {
			mkdirSync(dirname(out), { recursive: true });
			return true;
		}
		return false;
	} catch (error) {
		const code = fsErrorCode(error);
		if (code === undefined) throw error;
		throw new ConfigError(`cannot create --out (${code})`);
	}
}

/**
 * A private staging directory next to --out (same file system, so publishing is one rename): created
 * by mkdtemp with a random suffix, forced to 0700 and checked to be a real directory owned by us.
 */
export function makeStaging(out: string): string {
	try {
		const staging = mkdtempSync(join(dirname(out), `.${basename(out)}.staging-`));
		if (process.platform !== "win32") {
			chmodSync(staging, 0o700);
			const info = lstatSync(staging);
			if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid()))
				throw new ConfigError("staging directory is not private; nothing was published");
		}
		return staging;
	} catch (error) {
		if (error instanceof ConfigError) throw error;
		const code = fsErrorCode(error);
		if (code === undefined) throw error;
		throw new ConfigError(`cannot create --out (${code})`);
	}
}

/** Moves the scanned staging directory to --out. An --out that is no longer empty is never replaced. */
function publish(staging: string, out: string): void {
	try {
		if (process.platform !== "win32") chmodSync(staging, 0o777 & ~process.umask());
		// posix rename() replaces only an empty directory (ENOTEMPTY/EEXIST otherwise); win32 needs rmdir.
		if (process.platform === "win32" && existsSync(out)) rmdirSync(out);
		renameSync(staging, out);
	} catch (error) {
		const code = fsErrorCode(error);
		if (code === undefined) throw error;
		throw new ConfigError(`cannot publish --out (${code}); nothing was published`);
	}
}

export function runExport(argv: readonly string[], cwd = process.cwd()): ExportResult {
	const result: ExportResult = { code: 0, stdout: [], stderr: [] };
	let createdParent = false;
	let out: string | undefined;
	let repo = cwd;
	let excludePath: string | undefined;
	let deny: string | undefined;
	try {
		for (let i = 0; i < argv.length; i++) {
			const arg = argv[i]!;
			const value = () => {
				const v = argv[++i];
				if (v === undefined || v === "") throw new ConfigError(`${arg} needs a value`);
				return isAbsolute(v) ? v : resolve(cwd, v);
			};
			if (arg === "--out") out = value();
			else if (arg === "--repo") repo = value();
			else if (arg === "--exclude") excludePath = value();
			else if (arg === "--deny-list") deny = value();
			else throw new ConfigError(`unknown argument: ${arg}`);
		}
		if (out === undefined) throw new ConfigError("--out PATH is required");
		// Loaded first, so every message below prints its paths redacted with the deny words.
		const denyWords = deny === undefined ? undefined : loadDenyWords(deny);
		const redact = (path: string) => redactPath(path, { denyWords });
		const shown = (path: string) => JSON.stringify(redact(path));
		const root = canonical(git(repo, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
		const outAbs = resolve(out);
		const rel = relative(root, canonical(outAbs));
		// Outside only when relative() climbs out: ".." or "../..."; a child named "..public" is inside.
		const outside = isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
		if (rel === "" || !outside)
			throw new ConfigError("--out must be outside the source repository");
		const tree = headTree(root);
		for (const e of tree)
			if (e.type !== "blob" || e.mode === "120000") throw new ConfigError(`tracked entry is not a regular file (mode ${e.mode}): ${redact(e.path)}`);
		for (const e of tree) {
			const rule = unportableRule(e.path);
			if (rule !== undefined) throw new ConfigError(`tracked path is not portable (${rule}): ${shown(e.path)}`);
		}
		let excludeText: string;
		if (excludePath !== undefined) {
			if (!existsSync(excludePath)) throw new ConfigError("exclude list file not found");
			if (!statSync(excludePath).isFile()) throw new ConfigError("exclude list is not a regular file");
			excludeText = readFileSync(excludePath, "utf8");
		}
		else {
			const entry = tree.find((e) => e.path === EXCLUDE_FILE);
			if (!entry) throw new ConfigError(`${EXCLUDE_FILE} is not committed at HEAD`);
			excludeText = readBlobs(root, [entry.oid]).get(entry.oid)!.toString("utf8");
		}
		const excluded = new Set(parseExcludeList(excludeText).map((e) => e.path));
		const tracked = new Set(tree.map((e) => e.path));
		for (const path of excluded) if (!tracked.has(path)) result.stderr.push(`export-public: exclude entry matches no tracked file: ${redact(path)}`);
		const selected = tree.filter((e) => !excluded.has(e.path));
		const targets = selected.map((e) => targetInside(outAbs, e.path, shown));
		createdParent = prepareOut(outAbs);
		const blobs = readBlobs(root, [...new Set(selected.map((e) => e.oid))]);
		// Written and scanned in staging; --out appears only after a clean scan.
		const staging = makeStaging(outAbs);
		let published = false;
		try {
			selected.forEach((e, i) => {
				const target = join(staging, relative(outAbs, targets[i]!));
				try {
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(target, blobs.get(e.oid)!, { flag: "wx" });
					if (e.mode === "100755" && process.platform !== "win32") chmodSync(target, 0o755);
				} catch (error) {
					// Only the code: an fs message carries absolute operator paths. EEXIST is a case or
					// duplicate collision at HEAD.
					const code = (error as NodeJS.ErrnoException).code ?? "unknown error";
					throw new ConfigError(`cannot write ${shown(e.path)} (${code}); nothing was published`);
				}
			});
			result.stderr.push(`export-public: copied ${selected.length} file(s), excluded ${tree.length - selected.length}`);
			let report;
			try {
				// .git is walked too: the output is never a work tree, so nothing in it may go unscanned.
				report = scanFiles(staging, walkDirectory(staging, false), loadOptions(staging, deny));
			} catch (error) {
				const code = fsErrorCode(error);
				if (code === undefined) throw error;
				throw new ConfigError(`cannot scan the output (${code}); nothing was published`);
			}
			for (const f of report.findings) result.stdout.push(formatFinding(f));
			result.stderr.push(summarize(report));
			if (report.findings.length > 0) {
				result.stderr.push("export-public: FAILED privacy scan; nothing was published to --out");
				result.code = 1;
			} else {
				publish(staging, outAbs);
				published = true;
				result.stderr.push("export-public: privacy scan clean; published to --out");
			}
		} finally {
			let removed = true;
			try {
				rmSync(staging, { recursive: true, force: true });
			} catch (error) {
				removed = false;
				result.stderr.push(`export-public: cannot remove the staging directory (${fsErrorCode(error) ?? "unknown error"})`);
			}
			// On failure the staging directory is named (its basename only, redacted, never an absolute
			// path) so leftovers can be checked next to --out.
			if (!published)
				result.stderr.push(
					`export-public: staging directory ${redact(basename(staging))} next to --out: ${removed ? "removed" : "NOT removed, check and delete it by hand"}`,
				);
		}
	} catch (error) {
		const code = fsErrorCode(error);
		if (!(error instanceof ConfigError) && code === undefined) throw error;
		result.stderr.push(`export-public: ${error instanceof ConfigError ? error.message : `filesystem error (${code})`}`);
		result.code = 2;
	}
	if (result.code !== 0 && createdParent)
		result.stderr.push("export-public: created the missing parent directory of --out; it is left in place");
	return result;
}

if (import.meta.main) {
	const r = runExport(process.argv.slice(2));
	if (r.stdout.length) process.stdout.write(`${r.stdout.join("\n")}\n`);
	if (r.stderr.length) process.stderr.write(`${r.stderr.join("\n")}\n`);
	process.exitCode = r.code;
}
