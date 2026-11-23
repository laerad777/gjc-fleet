#!/usr/bin/env bun
/**
 * Read-only release identity probe for a launchd-managed Fleet process.
 *
 * Reports only: SERVICE_PID, START, CWD, LOAD_PATH, TREE_HEAD / TREE_REF.
 * Does not dump argv or plist ProgramArguments, open a DB, checkout, or restart.
 *
 * TREE_HEAD is the on-disk git HEAD via plain file reads (not a load SHA).
 * LOAD_PATH is unknown unless an open file under …/src/(cli|daemon|dashboard)*.(ts|js) is found.
 *
 * Every file probe and external command has a timeout. Failures are
 * `timeout` (deadline / ETIMEDOUT only) vs `read_failed` / `unreadable` / `unknown`.
 *
 * Usage:
 *   bun scripts/release-probe-readonly.ts --label LABEL [--expect-pid N] [--tree PATH]
 *   bun scripts/release-probe-readonly.ts --help
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { isAbsolute, join } from "node:path";

export const DEFAULT_FILE_TIMEOUT_MS = 3_000;
export const DEFAULT_CMD_TIMEOUT_MS = 8_000;
export const DEFAULT_BIN_TIMEOUT_MS = 2_000;

/** Candidate absolute paths — never Bun.which (unbounded). First executable wins. */
export const BIN_CANDIDATES: Record<keyof ProbeBins, readonly string[]> = {
	test: ["/bin/test", "/usr/bin/test"],
	head: ["/usr/bin/head", "/bin/head"],
	launchctl: ["/bin/launchctl"],
	ps: ["/bin/ps", "/usr/bin/ps"],
	lsof: ["/usr/sbin/lsof", "/usr/bin/lsof"],
};

const HEX40 = /^[0-9a-f]{40}$/;
/** Allow spaces in directory names (e.g. `gjc-fleet …`); leaf under src/(cli|daemon|dashboard)*.(ts|js). */
const CODE_PATH =
	/\/(?:gjc-fleet[^/]*|(?<=\/)fleet)\/src\/(?:cli|daemon|dashboard)[^/]*\.(?:ts|js)$/;

export type TreeHeadResult =
	| { kind: "sha"; sha: string; ref?: string }
	| { kind: "unreadable" }
	| { kind: "unknown" }
	| { kind: "timeout" }
	| { kind: "read_failed" };

export type TimedOk<T> = { ok: true; value: T };
export type TimedErr = { ok: false; reason: "timeout" | "read_failed" };
export type TimedResult<T> = TimedOk<T> | TimedErr;

export type SpawnFn = (
	command: string,
	args: string[],
	opts: { encoding: "utf8"; timeout: number },
) => SpawnSyncReturns<string>;

export type ProbeBins = {
	test: string;
	head: string;
	launchctl: string;
	ps: string;
	lsof: string;
};

export type ProbeDeps = {
	spawn: SpawnFn;
	bins: ProbeBins;
	fileTimeoutMs: number;
	cmdTimeoutMs: number;
};

export function isExactSha40(value: string): boolean {
	return HEX40.test(value.trim());
}

/** Accept only refs/... relative paths; reject absolute paths and `..`. */
export function isSafeGitRefPath(ref: string): boolean {
	if (!ref.startsWith("refs/")) return false;
	if (ref.startsWith("/") || ref.includes("..")) return false;
	return !ref.includes("\0");
}

export function classifyCodeLoadPath(path: string): string | undefined {
	return CODE_PATH.test(path) ? path : undefined;
}

/**
 * Timeout only when the spawn deadline fired (ETIMEDOUT).
 * A bare SIGTERM/SIGKILL without ETIMEDOUT is read_failed — not a deadline.
 */
export function classifySpawnFailure(
	r: Pick<SpawnSyncReturns<string>, "error" | "signal" | "status">,
): "timeout" | "read_failed" {
	const err = r.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
	if (err?.code === "ETIMEDOUT") return "timeout";
	return "read_failed";
}

export function timedSpawn(
	spawn: SpawnFn,
	command: string,
	args: string[],
	timeoutMs: number,
): TimedResult<{ stdout: string; status: number | null }> {
	const r = spawn(command, args, { encoding: "utf8", timeout: timeoutMs });
	if (r.error || r.signal) {
		return { ok: false, reason: classifySpawnFailure(r) };
	}
	return { ok: true, value: { stdout: r.stdout ?? "", status: r.status } };
}

/** Read a small text file via `head` so the OS call itself is killable on timeout. */
export function timedReadTextFile(
	spawn: SpawnFn,
	headBin: string,
	path: string,
	timeoutMs: number,
): TimedResult<string> {
	const r = timedSpawn(spawn, headBin, ["-c", "8192", path], timeoutMs);
	if (!r.ok) return r;
	if (r.value.status !== 0) return { ok: false, reason: "read_failed" };
	return { ok: true, value: r.value.stdout };
}

/**
 * `test -f` / `test -e`: exit 0 or 1 are definitive answers; exit ≥2 is an error.
 */
export function timedTestFlag(
	spawn: SpawnFn,
	testBin: string,
	flag: "-f" | "-e" | "-x",
	path: string,
	timeoutMs: number,
): TimedResult<boolean> {
	const r = timedSpawn(spawn, testBin, [flag, path], timeoutMs);
	if (!r.ok) return r;
	const status = r.value.status ?? 1;
	if (status === 0) return { ok: true, value: true };
	if (status === 1) return { ok: true, value: false };
	return { ok: false, reason: "read_failed" };
}

export function timedIsRegularFile(
	spawn: SpawnFn,
	testBin: string,
	path: string,
	timeoutMs: number,
): TimedResult<boolean> {
	return timedTestFlag(spawn, testBin, "-f", path, timeoutMs);
}

export function timedPathExists(
	spawn: SpawnFn,
	testBin: string,
	path: string,
	timeoutMs: number,
): TimedResult<boolean> {
	return timedTestFlag(spawn, testBin, "-e", path, timeoutMs);
}

/**
 * Resolve one absolute bin from candidates using timed `test -x` only
 * (no Bun.which — that call has no deadline).
 */
export function resolveAbsBinTimed(
	spawn: SpawnFn,
	testBin: string,
	candidates: readonly string[],
	timeoutMs: number,
): TimedResult<string> {
	for (const c of candidates) {
		if (!isAbsolute(c)) continue;
		const r = timedTestFlag(spawn, testBin, "-x", c, timeoutMs);
		if (!r.ok) return r;
		if (r.value) return { ok: true, value: c };
	}
	return { ok: false, reason: "read_failed" };
}

/**
 * Resolve all probe bins under a shared deadline budget.
 * `test` itself is bootstrapped from known absolute candidates via timed spawn of
 * the first candidate as the test program (`/bin/test -x /bin/test`).
 */
export function resolveProbeBinsTimed(
	spawn: SpawnFn,
	binTimeoutMs: number = DEFAULT_BIN_TIMEOUT_MS,
): TimedResult<ProbeBins> {
	let testBin: string | undefined;
	for (const c of BIN_CANDIDATES.test) {
		const r = timedSpawn(spawn, c, ["-x", c], binTimeoutMs);
		if (!r.ok) return r;
		if (r.value.status === 0) {
			testBin = c;
			break;
		}
		if ((r.value.status ?? 1) >= 2) return { ok: false, reason: "read_failed" };
	}
	if (!testBin) return { ok: false, reason: "read_failed" };

	const head = resolveAbsBinTimed(spawn, testBin, BIN_CANDIDATES.head, binTimeoutMs);
	if (!head.ok) return head;
	const launchctl = resolveAbsBinTimed(
		spawn,
		testBin,
		BIN_CANDIDATES.launchctl,
		binTimeoutMs,
	);
	if (!launchctl.ok) return launchctl;
	const ps = resolveAbsBinTimed(spawn, testBin, BIN_CANDIDATES.ps, binTimeoutMs);
	if (!ps.ok) return ps;
	const lsof = resolveAbsBinTimed(spawn, testBin, BIN_CANDIDATES.lsof, binTimeoutMs);
	if (!lsof.ok) return lsof;

	return {
		ok: true,
		value: {
			test: testBin,
			head: head.value,
			launchctl: launchctl.value,
			ps: ps.value,
			lsof: lsof.value,
		},
	};
}

/** Parse `lsof -Fn` name fields (`n…` lines). Paths may contain spaces. */
export function parseLsofFnNames(stdout: string): string[] {
	const names: string[] = [];
	for (const line of stdout.split("\n")) {
		if (line.startsWith("n") && line.length > 1) names.push(line.slice(1));
	}
	return names;
}

export type RefBody =
	| { kind: "ok"; body: string }
	| { kind: "unreadable" }
	| { kind: "timeout" }
	| { kind: "read_failed" };

/**
 * Parse `.git/HEAD` text. `readRef(rel)` returns the body for a relative
 * ref under `.git/`, or a failure kind.
 */
export function parseGitHeadText(
	headText: string,
	readRef: (rel: string) => RefBody,
): TreeHeadResult {
	const H = headText.replace(/\r?\n$/, "");
	if (H.startsWith("ref: ")) {
		const ref = H.slice("ref: ".length).trim();
		if (!isSafeGitRefPath(ref)) return { kind: "unknown" };
		const body = readRef(ref);
		if (body.kind !== "ok") return { kind: body.kind };
		const sha = body.body.trim();
		if (!isExactSha40(sha)) return { kind: "unknown" };
		return { kind: "sha", sha, ref };
	}
	if (isExactSha40(H)) return { kind: "sha", sha: H };
	return { kind: "unknown" };
}

export function readTreeHeadFromGitDir(
	gitDir: string,
	deps: Pick<ProbeDeps, "spawn" | "bins" | "fileTimeoutMs">,
): TreeHeadResult {
	const { spawn, bins, fileTimeoutMs } = deps;
	const exists = timedPathExists(spawn, bins.test, gitDir, fileTimeoutMs);
	if (!exists.ok) return { kind: exists.reason };
	if (!exists.value) return { kind: "unreadable" };

	// gitfile / worktree pointer — do not follow
	const asFile = timedIsRegularFile(spawn, bins.test, gitDir, fileTimeoutMs);
	if (!asFile.ok) return { kind: asFile.reason };
	if (asFile.value) return { kind: "unreadable" };

	const headPath = join(gitDir, "HEAD");
	const headIsFile = timedIsRegularFile(spawn, bins.test, headPath, fileTimeoutMs);
	if (!headIsFile.ok) return { kind: headIsFile.reason };
	if (!headIsFile.value) return { kind: "unreadable" };

	const head = timedReadTextFile(spawn, bins.head, headPath, fileTimeoutMs);
	if (!head.ok) return { kind: head.reason };

	return parseGitHeadText(head.value, (rel) => {
		const p = join(gitDir, rel);
		const isFile = timedIsRegularFile(spawn, bins.test, p, fileTimeoutMs);
		if (!isFile.ok) return { kind: isFile.reason };
		if (!isFile.value) return { kind: "unreadable" };
		const body = timedReadTextFile(spawn, bins.head, p, fileTimeoutMs);
		if (!body.ok) return { kind: body.reason };
		return { kind: "ok", body: body.value };
	});
}

export type ProbeInput = {
	label: string;
	expectPid?: number;
	tree?: string;
};

export type ProbeLines = string[];

function launchctlPid(
	label: string,
	deps: ProbeDeps,
): TimedResult<string | undefined> {
	const r = timedSpawn(
		deps.spawn,
		deps.bins.launchctl,
		["list"],
		deps.cmdTimeoutMs,
	);
	if (!r.ok) return r;
	if (r.value.status !== 0) return { ok: false, reason: "read_failed" };
	for (const line of r.value.stdout.split("\n")) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 3 && parts[2] === label) {
			return { ok: true, value: parts[0] };
		}
	}
	return { ok: true, value: undefined };
}

function processStart(pid: string, deps: ProbeDeps): string {
	const r = timedSpawn(
		deps.spawn,
		deps.bins.ps,
		["-p", pid, "-o", "lstart="],
		deps.cmdTimeoutMs,
	);
	if (!r.ok) return r.reason;
	if (r.value.status !== 0) return "read_failed";
	const s = r.value.stdout.trim();
	return s || "unknown";
}

function processCwd(pid: string, deps: ProbeDeps): string {
	const r = timedSpawn(
		deps.spawn,
		deps.bins.lsof,
		["-a", "-p", pid, "-d", "cwd", "-Fn"],
		deps.cmdTimeoutMs,
	);
	if (!r.ok) return r.reason;
	if (r.value.status !== 0) return "read_failed";
	const names = parseLsofFnNames(r.value.stdout);
	return names[0] || "unknown";
}

function processLoadPath(pid: string, deps: ProbeDeps): string {
	const r = timedSpawn(
		deps.spawn,
		deps.bins.lsof,
		["-p", pid, "-Fn"],
		deps.cmdTimeoutMs,
	);
	if (!r.ok) return r.reason;
	if (r.value.status !== 0) return "read_failed";
	for (const path of parseLsofFnNames(r.value.stdout)) {
		const hit = classifyCodeLoadPath(path);
		if (hit) return hit;
	}
	return "unknown";
}

/** Pure probe body for CLI regression tests (injectable spawn). */
export function runProbe(input: ProbeInput, deps: ProbeDeps): {
	lines: ProbeLines;
	exit: number;
} {
	const lines: string[] = [];
	const pidRes = launchctlPid(input.label, deps);
	if (!pidRes.ok) {
		lines.push("SERVICE_PID=unknown");
		lines.push(`ABORT=${pidRes.reason}`);
		return { lines, exit: 3 };
	}
	const pidRaw = pidRes.value;
	if (
		pidRaw === undefined ||
		pidRaw === "-" ||
		pidRaw === "0" ||
		pidRaw === "" ||
		!/^[1-9][0-9]*$/.test(pidRaw)
	) {
		lines.push("SERVICE_PID=unknown");
		lines.push("ABORT=pid_unknown");
		return { lines, exit: 3 };
	}
	if (input.expectPid !== undefined && Number(pidRaw) !== input.expectPid) {
		lines.push(`SERVICE_PID=${pidRaw}`);
		lines.push(`ABORT=pid_mismatch EXPECTED=${input.expectPid}`);
		return { lines, exit: 3 };
	}
	lines.push(`SERVICE_PID=${pidRaw}`);
	lines.push(`START=${processStart(pidRaw, deps)}`);
	const cwd = processCwd(pidRaw, deps);
	lines.push(`CWD=${cwd}`);
	lines.push(`LOAD_PATH=${processLoadPath(pidRaw, deps)}`);

	const root =
		input.tree ??
		(cwd !== "unknown" &&
		cwd !== "timeout" &&
		cwd !== "read_failed"
			? cwd
			: undefined);
	if (!root) {
		lines.push("TREE_HEAD=unknown");
		lines.push(
			"NOTE=TREE_HEAD_is_on_disk_not_load_sha; LOAD_PATH_unknown_does_not_prove_absence",
		);
		return { lines, exit: 0 };
	}
	const result = readTreeHeadFromGitDir(join(root, ".git"), deps);
	switch (result.kind) {
		case "sha":
			if (result.ref) lines.push(`TREE_REF=${result.ref}`);
			lines.push(`TREE_HEAD=${result.sha}`);
			break;
		default:
			lines.push(`TREE_HEAD=${result.kind}`);
			break;
	}
	lines.push(
		"NOTE=TREE_HEAD_is_on_disk_not_load_sha; LOAD_PATH_unknown_does_not_prove_absence",
	);
	return { lines, exit: 0 };
}

function usage(): never {
	console.log(`Usage: bun scripts/release-probe-readonly.ts --label LABEL [--expect-pid N] [--tree PATH]
Read-only. No argv dump, DB open, checkout, or restart.
TREE_HEAD is on-disk HEAD (not load SHA). File/command probes time out separately from read_failed.`);
	process.exit(2);
}

export function parseArgs(argv: string[]): ProbeInput {
	let label: string | undefined;
	let expectPid: number | undefined;
	let tree: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--help" || a === "-h") usage();
		if (a === "--label") {
			label = argv[++i];
			continue;
		}
		if (a === "--expect-pid") {
			const raw = argv[++i];
			if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
				console.error("EXPECT_PID=invalid");
				process.exit(2);
			}
			expectPid = Number(raw);
			continue;
		}
		if (a === "--tree") {
			tree = argv[++i];
			continue;
		}
		console.error(`unknown arg: ${a}`);
		usage();
	}
	if (!label || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,250}$/.test(label)) {
		console.error("LABEL=invalid");
		usage();
	}
	return { label, expectPid, tree };
}

const defaultSpawn: SpawnFn = (command, args, opts) =>
	spawnSync(command, args, opts);

function main() {
	const input = parseArgs(process.argv.slice(2));
	const binsRes = resolveProbeBinsTimed(defaultSpawn, DEFAULT_BIN_TIMEOUT_MS);
	if (!binsRes.ok) {
		console.log(`ABORT=bins_${binsRes.reason}`);
		process.exit(2);
	}
	const { lines, exit } = runProbe(input, {
		spawn: defaultSpawn,
		bins: binsRes.value,
		fileTimeoutMs: DEFAULT_FILE_TIMEOUT_MS,
		cmdTimeoutMs: DEFAULT_CMD_TIMEOUT_MS,
	});
	for (const line of lines) console.log(line);
	process.exit(exit);
}

if (import.meta.main) main();
