import { digest } from "../src/core";
import { spawnTrusted } from "../src/spawn";
import { sha256 } from "../src/workspace";
import {
	assessGitVersion,
	GIT_TIMEOUTS,
	MIN_GIT_VERSION,
	MIN_GIT_VERSION_REASON,
	type GitVersionAssessment,
} from "./candidate-package";

/** Same ceiling as packageCandidate's version probe; verify must not hang on a silent git. */
export const VERIFY_GIT_VERSION_TIMEOUT_MS = GIT_TIMEOUTS.versionMs;
export const VERIFY_GIT_VERSION_MAX_BYTES = 64 * 1024;

export type VerificationGitProbeError =
	| "missing"
	| "spawn_failed"
	| "timeout"
	| "output_limit"
	| "nonzero_exit";

export type VerificationGitPrerequisite = {
	kind: "verification-prerequisite";
	tool: "git";
	required: string;
	reason: typeof MIN_GIT_VERSION_REASON;
	status: "ok" | "too_old" | "unknown" | "failed";
	rule:
		| null
		| "git-too-old"
		| "git-version-unknown"
		| "git-probe-failed"
		| "git-probe-timeout"
		| "git-probe-output-limit";
	detectedText: string;
	parsed: [number, number, number] | null;
	message: string;
	exit: number | null;
	probeError: VerificationGitProbeError | null;
};

export type VerificationStopManifest = {
	schemaVersion: 1;
	kind: "local-independent-module-verification";
	runtime: { bun: string; platform: string; arch: string };
	prerequisite: VerificationGitPrerequisite;
	commands: unknown[];
	sourceFiles: Record<string, string>;
	sourceDigest: string;
	liveExecutionClaim: false;
	passed: false;
};

const requirementLead = () =>
	`Git ${MIN_GIT_VERSION} or newer is required for packaging verification (${MIN_GIT_VERSION_REASON})`;

function fromAssessment(
	assessment: GitVersionAssessment,
	exit: number,
): VerificationGitPrerequisite {
	return {
		kind: "verification-prerequisite",
		tool: "git",
		required: assessment.required,
		reason: assessment.reason,
		status: assessment.status,
		rule: assessment.rule,
		detectedText: assessment.detectedText,
		parsed: assessment.parsed,
		message: assessment.message,
		exit,
		probeError: null,
	};
}

function failedProbe(
	partial: {
		probeError: VerificationGitProbeError;
		rule: NonNullable<VerificationGitPrerequisite["rule"]>;
		message: string;
		detectedText?: string;
		exit?: number | null;
	},
): VerificationGitPrerequisite {
	return {
		kind: "verification-prerequisite",
		tool: "git",
		required: MIN_GIT_VERSION,
		reason: MIN_GIT_VERSION_REASON,
		status: "failed",
		rule: partial.rule,
		detectedText: partial.detectedText ?? "",
		parsed: null,
		message: partial.message,
		exit: partial.exit ?? null,
		probeError: partial.probeError,
	};
}

async function readBounded(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
	onOverflow: (partial: string) => void,
): Promise<{ text: string; overflow: boolean }> {
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) {
				const partial = Buffer.concat(chunks).toString("utf8");
				onOverflow(partial);
				await reader.cancel().catch(() => {});
				return { text: partial, overflow: true };
			}
			chunks.push(value);
		}
		return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
	} catch {
		await reader.cancel().catch(() => {});
		return { text: Buffer.concat(chunks).toString("utf8"), overflow: false };
	}
}

/**
 * Probe host git for verify.ts. Failures (missing binary, spawn error, timeout,
 * output overflow, nonzero exit) are classified before version text is trusted,
 * so prerequisite.status is never "ok" when the probe itself failed.
 *
 * Output overflow is signaled as soon as either stream exceeds the byte cap —
 * without waiting for process exit — so a flooding child cannot hang verify.
 */
export async function probeVerificationGit(options: {
	argv?: string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	maxBytes?: number;
} = {}): Promise<VerificationGitPrerequisite> {
	const argv = options.argv ?? ["git", "--version"];
	const cwd = options.cwd ?? process.cwd();
	const timeoutMs = options.timeoutMs ?? VERIFY_GIT_VERSION_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? VERIFY_GIT_VERSION_MAX_BYTES;

	let child: ReturnType<typeof spawnTrusted> | undefined;
	try {
		child = spawnTrusted(argv, {
			cwd,
			untrusted: [cwd],
			...(options.env ? { env: { ...process.env, ...options.env } } : {}),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const err = error as { code?: string; message?: string };
		const missing = err.code === "ENOENT";
		return failedProbe({
			probeError: missing ? "missing" : "spawn_failed",
			rule: "git-probe-failed",
			message: `${requirementLead()}; git version probe could not start (${missing ? "missing executable" : err.message ?? "spawn failed"})`,
		});
	}

	// Bun's Subprocess stdout/stderr are ReadableStreams under "pipe"; node/bun type roots diverge on Reader.
	const stdoutReader = (child.stdout as ReadableStream<Uint8Array>).getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
	const stderrReader = (child.stderr as ReadableStream<Uint8Array>).getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;

	const { promise: overflowPromise, resolve: resolveOverflow } = Promise.withResolvers<{
		kind: "overflow";
		text: string;
	}>();
	let overflowSettled = false;
	const noteOverflow = (partial: string) => {
		if (overflowSettled) return;
		overflowSettled = true;
		resolveOverflow({ kind: "overflow", text: partial });
	};

	const stdoutRead = readBounded(stdoutReader, maxBytes, noteOverflow);
	const stderrRead = readBounded(stderrReader, maxBytes, noteOverflow);
	const exitPromise = child.exited.then((exit) => ({ kind: "exit" as const, exit }));
	// One absolute deadline covers process exit, overflow, AND post-exit stream drains
	// (a grandchild can keep stdout open after the probed process has already exited).
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
		timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
	});

	const abortProbe = async () => {
		try {
			child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		await stdoutReader.cancel().catch(() => {});
		await stderrReader.cancel().catch(() => {});
	};

	try {
		const winner = await Promise.race([exitPromise, timeoutPromise, overflowPromise]);
		if (winner.kind === "overflow") {
			await abortProbe();
			return failedProbe({
				probeError: "output_limit",
				rule: "git-probe-output-limit",
				message: `${requirementLead()}; git version probe exceeded ${maxBytes} bytes of output`,
				detectedText: winner.text.slice(0, 200),
				exit: null,
			});
		}
		if (winner.kind === "timeout") {
			await abortProbe();
			return failedProbe({
				probeError: "timeout",
				rule: "git-probe-timeout",
				message: `${requirementLead()}; git version probe timed out after ${timeoutMs}ms`,
				exit: null,
			});
		}

		const drained = Promise.all([stdoutRead, stderrRead]).then(([stdoutResult, stderrResult]) => ({
			kind: "drained" as const,
			stdoutResult,
			stderrResult,
		}));
		const afterExit = await Promise.race([drained, timeoutPromise, overflowPromise]);
		if (afterExit.kind === "overflow") {
			await abortProbe();
			return failedProbe({
				probeError: "output_limit",
				rule: "git-probe-output-limit",
				message: `${requirementLead()}; git version probe exceeded ${maxBytes} bytes of output`,
				detectedText: afterExit.text.slice(0, 200),
				exit: winner.exit,
			});
		}
		if (afterExit.kind === "timeout") {
			await abortProbe();
			return failedProbe({
				probeError: "timeout",
				rule: "git-probe-timeout",
				message: `${requirementLead()}; git version probe timed out after ${timeoutMs}ms`,
				exit: winner.exit,
			});
		}

		const { stdoutResult, stderrResult } = afterExit;
		if (stdoutResult.overflow || stderrResult.overflow) {
			await abortProbe();
			return failedProbe({
				probeError: "output_limit",
				rule: "git-probe-output-limit",
				message: `${requirementLead()}; git version probe exceeded ${maxBytes} bytes of output`,
				detectedText: (stdoutResult.text || stderrResult.text).slice(0, 200),
				exit: winner.exit,
			});
		}

		// Nonzero exit: never trust version text on stderr/stdout as "ok".
		if (winner.exit !== 0) {
			const detectedText = (stdoutResult.text || stderrResult.text).trim();
			return failedProbe({
				probeError: "nonzero_exit",
				rule: "git-probe-failed",
				message: `${requirementLead()}; git --version exited ${winner.exit}${detectedText ? `; output ${JSON.stringify(detectedText.slice(0, 200))}` : ""}`,
				detectedText,
				exit: winner.exit,
			});
		}

		return fromAssessment(assessGitVersion(stdoutResult.text), winner.exit);
	} finally {
		if (timeoutHandle) clearTimeout(timeoutHandle);
	}
}

export function buildFailedVerificationManifest(
	prerequisite: VerificationGitPrerequisite,
	runtime: { bun: string; platform: string; arch: string } = {
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
	},
): VerificationStopManifest {
	return {
		schemaVersion: 1,
		kind: "local-independent-module-verification",
		runtime,
		prerequisite,
		commands: [],
		sourceFiles: {},
		sourceDigest: digest({}),
		liveExecutionClaim: false,
		passed: false,
	};
}

export function verificationStopSummary(
	manifestPath: string,
	manifestText: string,
	manifest: VerificationStopManifest,
) {
	return {
		manifest: manifestPath,
		sha256: sha256(manifestText),
		sourceDigest: manifest.sourceDigest,
		passed: false as const,
		stoppedAt: "git-version-prerequisite" as const,
	};
}
