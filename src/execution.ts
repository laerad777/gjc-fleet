import { basename } from "node:path";
import type {
	Json,
	NodeConfig,
	ReceiptlessSettlement,
	SessionAuthority,
} from "./contracts";
import { demand, digest } from "./core";
import { TransportError } from "./rpc";
import { spawnTrusted } from "./spawn";

/**
 * Tokens that may appear in public-SDK argv. Over `ssh`, OpenSSH joins remote
 * argv with spaces into a shell command, so whitespace and shell metacharacters
 * would be interpreted on the node. Same charset as dashboard `gjcBatch`.
 * Covers progress UUID session ids (`[0-9a-f-]{36}`); `@+,~` are not accepted
 * because a joined remote word would still be shell-expanded (`~`) or left
 * ambiguous relative to coordinator identity — refuse rather than guess.
 */
export const SAFE_SDK_ARGV_TOKEN = /^[\w.:/=-]+$/;

/** True when `value` is safe to place in public-SDK argv (including over ssh). */
export function isSafeSdkArgvToken(value: unknown): value is string {
	return typeof value === "string" && SAFE_SDK_ARGV_TOKEN.test(value);
}

/** True when the transport program is OpenSSH (bare, absolute, or `.exe`). */
export function isSshTransportCommand(command: string): boolean {
	// Normalize Windows separators so basename works on every host.
	const base = basename(command.replace(/\\/g, "/")).toLowerCase();
	return base === "ssh" || base === "ssh.exe";
}

/** POSIX single-quote so a compound remote (`cd x && gjc`) stays one `sh -c` word. */
export function posixShellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

/**
 * Last ssh argv element: the remote command OpenSSH hands to the node shell.
 * Disables broker autostart for the whole remote (including `cd … && gjc`).
 */
export function buildSshPublicSdkRemote(
	os: NodeConfig["os"],
	remote: string,
	args: string[],
): string {
	const suffix = args.length ? ` ${args.join(" ")}` : "";
	if (os === "win32") {
		if (/^cmd\.exe \/c /i.test(remote)) {
			return `cmd.exe /c "set GJC_SDK_BROKER_AUTOSTART=0&& ${remote.replace(/^cmd\.exe \/c /i, "")}${suffix}"`;
		}
		return remote + suffix;
	}
	return `env GJC_SDK_BROKER_AUTOSTART=0 sh -c ${posixShellSingleQuote(remote + suffix)}`;
}

/** Fresh, exact, unpaginated public session.list for one session id; read-only, attach-only. */
export async function listSession(
	node: NodeConfig,
	sessionId: string,
): Promise<unknown> {
	return publicSdk(
		node,
		[
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.list",
			"--json-input-stdin",
			"--attach-only",
			"--page",
			"--limit",
			"2",
			"--json",
		],
		{ resolveSessionId: sessionId },
	);
}

/** Capture public authority for persistence before any retirement effect. */
export async function readSessionAuthority(
	node: NodeConfig,
	sessionId: string,
	cwd: string,
): Promise<SessionAuthority> {
	const response: any = await listSession(node, sessionId);
	const result = response?.result;
	demand(
		response?.type === "broker_response" &&
			response.ok === true &&
			Number.isSafeInteger(result?.indexSeq) &&
			result.indexSeq >= 0 &&
			Array.isArray(result.sessions) &&
			result.sessions.length === 1 &&
			response.continuationCursor === undefined &&
			result.continuationCursor === undefined,
		"SESSION_AUTHORITY_REQUIRED",
		"Exact unpaginated public session authority required",
	);
	const row = result.sessions[0];
	demand(
		row?.sessionId === sessionId &&
			row.locator?.cwd === cwd &&
			Number.isSafeInteger(row.endpointGeneration) &&
			row.endpointGeneration > 0 &&
			typeof row.endpointIncarnation === "string" &&
			/^[a-f0-9]{64}$/.test(row.endpointIncarnation) &&
			row.live === true &&
			row.ambiguous === false &&
			row.terminalUncertain === false &&
			row.terminal === false,
		"SESSION_AUTHORITY_REQUIRED",
		"Exact live public session authority required",
	);
	return {
		sessionId: row.sessionId,
		cwd: row.locator.cwd,
		endpointGeneration: row.endpointGeneration,
		endpointIncarnation: row.endpointIncarnation,
	};
}

/** Normal lifecycle close consumes only the previously persisted exact authority.
 * The broker rejects a generation/incarnation mismatch with endpoint_stale before any
 * effect. ifIdle additionally asks the host to refuse with busy unless it can atomically
 * fence an idle host (used for settled-session resource return). */
export async function closeOwnedSession(
	node: NodeConfig,
	authority: SessionAuthority,
	key: string,
	options: { ifIdle?: boolean } = {},
): Promise<unknown> {
	demand(
		typeof authority?.sessionId === "string" &&
			authority.sessionId.length > 0 &&
			typeof authority.cwd === "string" &&
			authority.cwd.length > 0 &&
			Number.isSafeInteger(authority.endpointGeneration) &&
			authority.endpointGeneration > 0 &&
			typeof authority.endpointIncarnation === "string" &&
			/^[a-f0-9]{64}$/.test(authority.endpointIncarnation) &&
			typeof key === "string" &&
			key.length > 0,
		"SESSION_AUTHORITY_REQUIRED",
		"Complete retained session authority and durable close key required",
	);
	return publicSdk(
		node,
		[
			"sdk",
			"session",
			"raw",
			"global",
			"--op",
			"session.close",
			"--idempotency-key",
			key,
			"--json-input-stdin",
			"--attach-only",
			"--json",
		],
		{
			sessionId: authority.sessionId,
			endpointGeneration: authority.endpointGeneration,
			endpointIncarnation: authority.endpointIncarnation,
			...(options.ifIdle === true ? { ifIdle: true } : {}),
		},
		30000,
	);
}

/** Read-only, exact original-command lookup through the configured public SDK CLI. */
export async function readExecution(
	node: NodeConfig,
	sessionId: string,
	commandId: string,
	turnId: string,
): Promise<unknown> {
	const response: any = await publicSdk(
		node,
		[
			"sdk",
			"session",
			"raw",
			"query",
			sessionId,
			"--query",
			"turn.result",
			"--json-input-stdin",
			"--attach-only",
			"--json",
		],
		{ kind: "prompt", commandId, turnId },
	);
	demand(
		response.type === "query_response" &&
			response.ok === true &&
			response.result?.kind === "prompt" &&
			response.result.commandId === commandId &&
			response.result.turnId === turnId,
		"EXECUTION_BINDING",
		"Exact original runtime result required",
	);
	return response.result;
}

/** Public Broker operator route returns {ok,result}, not a filesystem one-shot envelope. */
export async function abortOwnedSession(
	node: NodeConfig,
	sessionId: string,
	key: string,
): Promise<unknown> {
	return publicSdk(
		node,
		[
			"sdk",
			"session",
			"raw",
			"control",
			sessionId,
			"--op",
			"turn.abort",
			"--json-input-stdin",
			"--idempotency-key",
			key,
			"--confirm",
			"--attach-only",
			"--json",
		],
		{ mode: "terminal", scope: "owned", operator: true },
	);
}

async function publicSdk(
	node: NodeConfig,
	args: string[],
	input: unknown,
	timeoutMs = 10000,
): Promise<unknown> {
	const transport = node.sdkTransport;
	demand(
		transport,
		"SDK_TRANSPORT_REQUIRED",
		"Exact execution lookup requires explicit public SDK transport",
	);
	const env = { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" };
	let argv: string[];
	if (isSshTransportCommand(transport.command)) {
		// OpenSSH joins the remote argv into one shell command; refuse anything that
		// would be reinterpreted, and disable broker autostart on the remote side.
		demand(
			args.every(isSafeSdkArgvToken),
			"UNSAFE_SDK_ARGV",
			"Public SDK argv must be shell-safe over ssh",
		);
		const head = transport.args.slice(0, -1);
		const remote = transport.args.at(-1) ?? "";
		argv = [
			transport.command,
			...head,
			buildSshPublicSdkRemote(node.os, remote, args),
		];
	} else {
		argv = [transport.command, ...transport.args, ...args];
	}
	const child = spawnTrusted(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env,
	});
	// Own the transport only. Its exit does not prove a remote turn was aborted.
	let didExit = false;
	void child.exited.then(() => { didExit = true; }, () => {});
	const readers = new Set<{
		cancel(reason?: unknown): Promise<void>;
		releaseLock(): void;
	}>();
	async function waitForExit(ms: number): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				child.exited.then(() => true, () => false),
				new Promise<false>((resolve) => {
					timer = setTimeout(() => resolve(false), ms);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new TransportError("execution_query_timeout", "unknown"));
		}, timeoutMs);
	});
	async function bounded(stream: ReadableStream<Uint8Array>) {
		const reader = stream.getReader();
		readers.add(reader as { cancel(reason?: unknown): Promise<void>; releaseLock(): void });
		try {
			let size = 0;
			const chunks: Uint8Array[] = [];
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > 1024 * 1024) {
					try { void reader.cancel().catch(() => {}); } catch {}
					throw new TransportError("execution_query_output_limit", "unknown");
				}
				chunks.push(value);
			}
			return new TextDecoder("utf-8", { fatal: true }).decode(
				Buffer.concat(chunks),
			);
		} finally {
			readers.delete(reader);
			reader.releaseLock();
		}
	}
	try {
		const request = JSON.stringify(input);
		try {
			child.stdin.write(request);
			child.stdin.end();
		} catch (error) {
			// Only stdin EPIPE is non-authoritative; stdout and exit still decide.
			if (
				!(error instanceof Error) ||
				(error as { code?: unknown }).code !== "EPIPE"
			) {
				throw error;
			}
		}
		const [stdout, , exit] = await Promise.race([
			Promise.all([bounded(child.stdout), bounded(child.stderr), child.exited]),
			deadline,
		]);
		const response: unknown = JSON.parse(stdout);
		if (exit !== 0)
			throw new TransportError(
				"EXECUTION_QUERY_FAILED",
				"unknown",
				"Public SDK execution lookup refused",
				response,
			);
		return response;
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw new TransportError("invalid_public_sdk_response", "unknown");
	} finally {
		clearTimeout(timer!);
		// cancel() settles pending reads even if the source's cancel hook hangs.
		// Do not await that hook: cleanup itself must stay bounded.
		for (const reader of readers) {
			try { void reader.cancel().catch(() => {}); } catch {}
		}
		if (!didExit) {
			try { child.kill("SIGTERM"); } catch {}
			if (!(await waitForExit(250))) {
				try { child.kill("SIGKILL"); } catch {}
				if (!(await waitForExit(750)))
					throw new TransportError("execution_query_cleanup_timeout", "unknown");
			}
		}
	}
}

/**
 * Minimum Fleet-clock separation between the two identical observations that
 * prove a receipt-less turn is over. A single read is never sufficient.
 */
export const RECEIPTLESS_CONFIRM_INTERVAL_MS = 60_000;
/**
 * After a receipt-less settlement, `inspect` keeps a read-only check of the exact
 * original command's runtime record for this long (Fleet clock, measured from the
 * confirming poll). The check stops earlier once a late receipt is recorded or the
 * task is archived. Outside the window nothing is read; finality never changes.
 */
export const LATE_RECEIPT_WINDOW_MS = 24 * 60 * 60_000;
/** Upper bound of node-supplied cause text retained by Fleet. */
export const CAUSE_TEXT_LIMIT = 1024;

/** One observation's conclusion that a turn without a receipt is over. */
export interface ReceiptlessEnd {
	kind: ReceiptlessSettlement["kind"];
	receiptState: string;
	/** Digest of every fact the conclusion rests on; both observations must match. */
	fingerprint: string;
	cause: { [key: string]: Json };
	causeText: string;
}

/** Durable per-poll record retained as `evidence.receiptless`. */
export interface ReceiptlessCandidate {
	kind: ReceiptlessSettlement["kind"];
	receiptState: string;
	fingerprint: string;
	firstObservedAt: number;
	firstPoll: number;
	observedAt: number;
	poll: number;
	minIntervalMs: number;
	confirmed: boolean;
	cause: { [key: string]: Json };
	causeText: string;
}

const instant = (value: unknown): value is string =>
	typeof value === "string" &&
	value.trim().length > 0 &&
	Number.isFinite(Date.parse(value));
const label = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;
const SECRET =
	/(gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|sk-[A-Za-z0-9_-]{6,}|xox[abprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_.-]{8,})/g;
const SECRET_ASSIGNMENT =
	/\b(token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|authorization|cookie|session[_-]?key)([ \t]*[=:][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&]+)/gi;
/** Decoded JSON object keys that redact their following value (case-insensitive). */
const SECRET_JSON_KEY_NAME =
	/^(token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|authorization|cookie|session[_-]?key)$/i;
/** Max chars inside a JSON []/{} value (excluding the opening bracket). Overflow fail-closes. */
const JSON_CONTAINER_CHARS = 256;
/** Max nesting depth for JSON []/{} under a secret key. Overflow fail-closes. */
const JSON_CONTAINER_DEPTH = 32;
/**
 * Local `"key":` spans only (≤256 content chars). Independent matches — no global quote state,
 * so a stray earlier `"` cannot swallow a later secret key.
 */
const SECRET_JSON_KEY_SPAN = /"((?:\\.|[^"\\]){1,256})"([ \t]*:[ \t]*)/g;
const SECRET_FLAG =
	/(--(?:password|passwd|token|api-?key|secret)|-(?:p|t))([ \t]{1,64})(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/gi;
// Userinfo is everything between :// and @ before the first / (includes empty user `https://:pw@`).
const URL_USERINFO = /(https?:\/\/)[^/\s]+@/gi;
const BEARER = /\bbearer[ \t]+[A-Za-z0-9._~+/-]+=*/gi;
const JSON_SCALAR = /^(true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/**
 * End index after a quote/escape-aware JSON string starting at `start` (on the opening quote).
 * If `budget` content chars are exceeded before a close, returns `text.length` (fail-closed).
 */
function scanQuotedJson(text: string, start: number, budget = Infinity): number {
	const quote = text[start]!;
	let i = start + 1;
	let escaped = false;
	let content = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (escaped) {
			escaped = false;
			i++;
			content++;
			if (content > budget) return text.length;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			i++;
			content++;
			if (content > budget) return text.length;
			continue;
		}
		if (ch === quote) return i + 1;
		i++;
		content++;
		if (content > budget) return text.length;
	}
	// Unclosed string: fail-closed — consume the remainder.
	return text.length;
}

/**
 * End index after a JSON []/{} value starting at `start`.
 * Quote/escape-aware; depth or length overflow fail-closes by consuming through end of text.
 */
function scanJsonContainer(text: string, start: number): number {
	const open = text[start]!;
	const close = open === "[" ? "]" : "}";
	const stack: string[] = [close];
	let i = start + 1;
	let content = 0;
	let inString: '"' | "'" | null = null;
	let escaped = false;
	while (i < text.length) {
		if (stack.length > JSON_CONTAINER_DEPTH) return text.length;
		const ch = text[i]!;
		if (inString) {
			if (escaped) {
				escaped = false;
				i++;
				content++;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				i++;
				content++;
				continue;
			}
			if (ch === inString) inString = null;
			i++;
			content++;
			if (content > JSON_CONTAINER_CHARS) return text.length;
			continue;
		}
		if (ch === '"' || ch === "'") {
			inString = ch;
			i++;
			content++;
			if (content > JSON_CONTAINER_CHARS) return text.length;
			continue;
		}
		if (ch === "[" || ch === "{") {
			stack.push(ch === "[" ? "]" : "}");
			i++;
			content++;
			if (content > JSON_CONTAINER_CHARS) return text.length;
			continue;
		}
		if (ch === "]" || ch === "}") {
			if (stack[stack.length - 1] !== ch) return text.length;
			stack.pop();
			i++;
			if (stack.length === 0) return i;
			content++;
			if (content > JSON_CONTAINER_CHARS) return text.length;
			continue;
		}
		i++;
		content++;
		if (content > JSON_CONTAINER_CHARS) return text.length;
	}
	return text.length;
}

/** End index of the JSON value at `start`, or `text.length` when fail-closed. */
function scanJsonValueEnd(text: string, start: number): number {
	if (start >= text.length) return start;
	const ch = text[start]!;
	if (ch === '"' || ch === "'") return scanQuotedJson(text, start);
	if (ch === "[" || ch === "{") return scanJsonContainer(text, start);
	const lit = JSON_SCALAR.exec(text.slice(start));
	if (lit) return start + lit[0].length;
	// Unrecognized value — fail-closed through the next structural delimiter or EOS
	// so `"password":hunter2` cannot leave the bare token after a redacted key.
	let i = start;
	while (i < text.length && text[i] !== "," && text[i] !== "}" && text[i] !== "]") i++;
	return i;
}

/**
 * Redact JSON secret keys without global quote pairing.
 * Find local `"…":` spans (short, ≤256), JSON.parse-decode the key (incl. `\uXXXX`),
 * and if it is a secret name, mask its value. Ambiguous/overflow values fail-closed to EOS.
 * Stray quotes elsewhere cannot skip a later `"password":` span.
 */
function redactJsonSecrets(text: string): string {
	let out = "";
	let last = 0;
	SECRET_JSON_KEY_SPAN.lastIndex = 0;
	for (let match = SECRET_JSON_KEY_SPAN.exec(text); match; match = SECRET_JSON_KEY_SPAN.exec(text)) {
		let decoded: unknown;
		try {
			decoded = JSON.parse(`"${match[1]}"`);
		} catch {
			continue;
		}
		if (typeof decoded !== "string" || !SECRET_JSON_KEY_NAME.test(decoded)) continue;
		const keyAt = match.index;
		const sep = match[2]!;
		const valueAt = keyAt + match[0].length;
		const valueEnd = scanJsonValueEnd(text, valueAt);
		out += text.slice(last, keyAt) + JSON.stringify(decoded) + sep + '"[redacted]"';
		last = valueEnd;
		SECRET_JSON_KEY_SPAN.lastIndex = valueEnd;
		if (valueEnd >= text.length) break;
	}
	return out + text.slice(last);
}

/**
 * Node-supplied free text is untrusted: strip ANSI/control characters, redact
 * credential-shaped values and cap the length. Codes stay structured elsewhere.
 * Also covers URL userinfo, CLI secret flags, and JSON secret keys (review-found gap).
 */
export function boundedText(value: unknown, limit = CAUSE_TEXT_LIMIT): string {
	let text = String(value)
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
		.replace(/[\t\n]+/g, " ")
		// Collapse runs of spaces once (linear) so secret patterns never backtrack across them.
		.replace(/ {2,}/g, " ")
		.replace(URL_USERINFO, "$1[redacted]@")
		// Capture flag + separator; emit a fixed redacted token (do not re-search the value).
		.replace(SECRET_FLAG, (_m, flag: string, sep: string) => flag + sep + "[redacted]")
		.replace(BEARER, "Bearer [redacted]");
	text = redactJsonSecrets(text);
	text = text
		.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string) => key + sep + "[redacted]")
		.replace(SECRET, "[redacted]");
	if (text.length > limit) {
		const omitted = text.length - limit;
		text = text.slice(0, limit) + "…[" + omitted + " chars truncated]";
	}
	return text;
}
function boundedError(value: unknown): Json {
	if (value === undefined || value === null) return null;
	if (typeof value !== "object")
		return boundedText(value);
	const error = value as Record<string, unknown>;
	const out: { [key: string]: Json } = {};
	for (const key of ["code", "provenance", "phase", "category", "kind", "reason"])
		if (label(error[key])) out[key] = boundedText(error[key], 128);
	if (label(error.message)) out.message = boundedText(error.message);
	return out;
}
const fact = (value: unknown): Json =>
	value === undefined
		? null
		: value === null || ["string", "number", "boolean"].includes(typeof value)
			? (value as Json)
			: digest(value);

/**
 * The single definition of "a turn WITHOUT a command receipt is provably over".
 * Inputs are only the task's exact public read_turn reply and the exact
 * original-command `turn.result` record (already bound by readExecution).
 * Returns null whenever anything is missing, ambiguous or still possibly running;
 * callers then keep today's held behaviour. A non-null result is ONE observation;
 * `confirmReceiptlessEnd` additionally requires a second identical one.
 */
export function receiptlessTurnEnd(
	binding: { sessionId: string; turnId: string },
	publicTurn: any,
	execution: any,
): ReceiptlessEnd | null {
	const turn = publicTurn?.turn;
	const state = publicTurn?.session_state;
	const advisory = publicTurn?.advisory_status;
	const delivery = turn?.delivery;
	if (
		!(
			publicTurn?.ok === true &&
			label(binding.sessionId) &&
			label(binding.turnId) &&
			// Exact task session and exact task turn, never a neighbour's.
			turn?.session_id === binding.sessionId &&
			turn.turn_id === binding.turnId &&
			state?.session_id === binding.sessionId &&
			// Terminal public turn with a completion instant.
			["completed", "failed"].includes(turn.status) &&
			instant(turn.completed_at) &&
			// The prompt was delivered to the runtime and is not waiting in a queue.
			delivery?.prompt_acknowledged === true &&
			delivery.queued === false &&
			label(delivery.runtime_command_id) &&
			label(delivery.runtime_turn_id) &&
			// SDK says nothing streams, no turn is current, the agent loop finished, no tools run.
			advisory?.authority === "sdk" &&
			advisory.is_streaming === false &&
			state.current_turn_id === null &&
			(state.last_turn_id === undefined ||
				state.last_turn_id === null ||
				state.last_turn_id === binding.turnId) &&
			state.activity?.phase === "finished"
		)
	)
		return null;
	const toolCounts = [state.active_tool_count, state.activity?.active_tool_count].filter(
		(count) => count !== undefined,
	);
	if (toolCounts.length === 0 || !toolCounts.every((count) => count === 0))
		return null;
	// The exact original command exists in the runtime but has no receipt. A present
	// receipt belongs to settledExecution; a pending one may still be written.
	if (
		!(
			execution?.kind === "prompt" &&
			execution.commandId === delivery.runtime_command_id &&
			execution.turnId === delivery.runtime_turn_id &&
			["missing", "absent"].includes(execution.receiptState) &&
			["failed", "in_flight"].includes(execution.status)
		)
	)
		return null;
	const failed = turn.status === "failed" || execution.status === "failed";
	if (execution.status === "failed" && execution.outcome?.kind !== "failed")
		return null;
	const ended = ["errored", "ended"].includes(state.state) && instant(state.ended_at);
	// A failed turn needs a session that has itself ended or errored. A completed turn
	// needs the same, or a LIVE SDK view of an idle completed session: a stale/cached
	// view (live false or missing) of a "completed" session never settles.
	if (failed ? !ended : !(ended || (state.state === "completed" && advisory.live === true)))
		return null;
	const kind: ReceiptlessSettlement["kind"] = failed
		? "failed_without_receipt"
		: "ended_without_receipt";
	const outcome = execution.outcome;
	const cause: { [key: string]: Json } = {
		turnStatus: turn.status,
		turnError: boundedError(turn.error),
		executionStatus: execution.status,
		receiptState: execution.receiptState,
		outcome: boundedError(outcome),
		sessionState: state.state,
		sessionError: boundedError(state.error),
	};
	const parts = [
		label(outcome?.message) ? outcome.message : undefined,
		label(outcome?.code)
			? [outcome.code, outcome.provenance, outcome.phase, outcome.category]
					.filter(label)
					.join("/")
			: undefined,
		label(state.error?.message) ? "session: " + state.error.message : undefined,
		label(turn.error?.code) || label(turn.error?.message)
			? "turn: " + [turn.error.code, turn.error.message].filter(label).join(": ")
			: undefined,
	].filter(label);
	const causeText = boundedText(
		(failed ? "" : "turn reported " + turn.status + " but runtime ") +
			(parts.length > 0 ? parts.join("; ") + "; " : "") +
			"no runtime receipt (receiptState=" +
			execution.receiptState +
			", status=" +
			execution.status +
			")",
	);
	// Only the facts the predicate rests on: a per-read field elsewhere in the reply
	// (timestamps, ages) must not prevent two identical conclusions from pairing.
	const fingerprint = digest({
		kind,
		sessionId: binding.sessionId,
		turnId: binding.turnId,
		turn: {
			status: turn.status,
			completedAt: turn.completed_at,
			error: fact(turn.error),
			runtimeCommandId: delivery.runtime_command_id,
			runtimeTurnId: delivery.runtime_turn_id,
			promptAcknowledged: delivery.prompt_acknowledged,
			queued: delivery.queued,
		},
		advisory: {
			authority: advisory.authority,
			isStreaming: advisory.is_streaming,
			live: fact(advisory.live),
		},
		session: {
			state: state.state,
			endedAt: fact(state.ended_at),
			currentTurnId: state.current_turn_id,
			lastTurnId: fact(state.last_turn_id),
			activityPhase: state.activity.phase,
			activeToolCount: fact(state.active_tool_count),
			activityActiveToolCount: fact(state.activity.active_tool_count),
			error: fact(state.error),
		},
		execution: {
			status: execution.status,
			receiptState: execution.receiptState,
			terminalAt: fact(execution.terminalAt),
			outcome: fact(outcome),
		},
	});
	return { kind, receiptState: execution.receiptState, fingerprint, cause, causeText };
}

/**
 * Pair this observation with the previously persisted one. Confirmed only when the
 * immediately preceding APPLIED poll (`lastAppliedPoll`, read after this poll was
 * issued) reached the identical conclusion at least the minimum interval ago on
 * the Fleet clock. Any change, any applied poll in between (including an unknown or
 * failed read) or a clock regression restarts the candidate.
 */
export function confirmReceiptlessEnd(
	previous: unknown,
	current: ReceiptlessEnd,
	poll: number,
	now: number,
	lastAppliedPoll?: number,
): ReceiptlessCandidate {
	const prior = previous as Partial<ReceiptlessCandidate> | undefined;
	const continues =
		prior?.confirmed === false &&
		prior.fingerprint === current.fingerprint &&
		Number.isSafeInteger(prior.firstObservedAt) &&
		Number.isSafeInteger(prior.firstPoll) &&
		Number.isSafeInteger(prior.poll) &&
		prior.poll === lastAppliedPoll &&
		prior.poll! < poll &&
		Number.isSafeInteger(prior.observedAt) &&
		prior.firstObservedAt! <= prior.observedAt! &&
		prior.observedAt! <= now;
	const firstObservedAt = continues ? prior!.firstObservedAt! : now;
	const firstPoll = continues ? prior!.firstPoll! : poll;
	return {
		kind: current.kind,
		receiptState: current.receiptState,
		fingerprint: current.fingerprint,
		firstObservedAt,
		firstPoll,
		observedAt: now,
		poll,
		minIntervalMs: RECEIPTLESS_CONFIRM_INTERVAL_MS,
		confirmed:
			continues && firstPoll < poll && now - firstObservedAt >= RECEIPTLESS_CONFIRM_INTERVAL_MS,
		cause: current.cause,
		causeText: current.causeText,
	};
}

/** Exact binding of a settled receipt-less task's original runtime command. */
export interface LateReceiptBinding {
	sessionId: string;
	turnId: string;
	runtimeCommandId: string;
	runtimeTurnId: string;
}
/** A genuine runtime receipt for the SAME session/turn/command, seen after settlement. */
export interface LateReceiptObservation {
	status: string;
	digest: string;
	terminalAt: number;
	outcome: { [key: string]: Json };
}
/**
 * Read-only conclusion for a settled receipt-less task. Non-null only when the
 * public turn reply is the exact task session/turn still delivered as the exact
 * runtime command, and that exact command now carries a receipt that the normal
 * path (`settledExecution`) would accept. Anything else is not this turn's receipt.
 */
export function lateReceiptObservation(
	binding: LateReceiptBinding,
	publicTurn: any,
	execution: any,
): LateReceiptObservation | null {
	const turn = publicTurn?.turn;
	if (
		!(
			publicTurn?.ok === true &&
			turn?.session_id === binding.sessionId &&
			turn.turn_id === binding.turnId &&
			publicTurn.session_state?.session_id === binding.sessionId &&
			turn.delivery?.runtime_command_id === binding.runtimeCommandId &&
			turn.delivery?.runtime_turn_id === binding.runtimeTurnId &&
			execution?.kind === "prompt" &&
			execution.commandId === binding.runtimeCommandId &&
			execution.turnId === binding.runtimeTurnId &&
			settledExecution(execution)
		)
	)
		return null;
	return {
		status: execution.status,
		digest: digest(execution),
		terminalAt: execution.terminalAt,
		outcome: boundedError(execution.outcome) as { [key: string]: Json },
	};
}

/**
 * Held reason of a turn whose failure was REPORTED (public turn `failed`, runtime record `failed`, a failed
 * runtime outcome or a runtime error object) while nothing proves the turn is over: no durable receipt and
 * no confirmed receipt-less end. The attempt stays held and provisional (`completed_unverified`, not
 * executionTerminal) with this visible reason; it is never counted as failed or as unverified output.
 * Cleared as soon as an observation no longer reports a failure or settles.
 */
export const EXECUTION_FAILURE_REPORTED = "execution_failure_reported_end_unproven";

/**
 * A durable FAILED runtime receipt of the exact original command that the normal path accepts
 * (`settledExecution`), delivered as this turn's acknowledged, dequeued runtime command. The runtime has
 * recorded the command as over and failed; a present receipt is final, so no other receipt can follow.
 * This settles the attempt as `failed` even when the success-oriented terminal predicate (agent_end final
 * response, live idle SDK view) does not hold, because a failed turn typically has no agent_end.
 */
export function failedExecutionReceipt(publicTurn: any, execution: any): boolean {
	const delivery = publicTurn?.turn?.delivery;
	return Boolean(
		execution?.kind === "prompt" &&
			execution.status === "failed" &&
			settledExecution(execution) &&
			delivery?.prompt_acknowledged === true &&
			delivery.queued === false &&
			label(delivery.runtime_command_id) &&
			execution.commandId === delivery.runtime_command_id &&
			label(delivery.runtime_turn_id) &&
			execution.turnId === delivery.runtime_turn_id,
	);
}

/** Some party reported this turn as failed. On its own this proves neither that the turn is over nor its outcome. */
export function failureReported(publicTurn: any, execution: any): boolean {
	const error = execution?.error;
	return (
		publicTurn?.turn?.status === "failed" ||
		execution?.status === "failed" ||
		execution?.outcome?.kind === "failed" ||
		(typeof error === "object" && error !== null && !Array.isArray(error) && Object.keys(error).length > 0)
	);
}

export function settledExecution(value: any): boolean {
	return Boolean(
		value &&
			["terminal_ok", "failed"].includes(value.status) &&
			value.receiptState === "present" &&
			Number.isFinite(value.terminalAt) &&
			value.terminalAt > 0 &&
			value.outcome &&
			(value.status === "terminal_ok"
				? value.outcome.kind === "stopped" &&
					[
						"end_turn",
						"max_tokens",
						"max_turn_requests",
						"refusal",
						"cancelled",
					].includes(value.outcome.reason) &&
					["agent", "client_cancel"].includes(value.outcome.provenance)
				: value.outcome.kind === "failed" &&
					["prompt_failed", "prompt_deadline_exceeded"].includes(
						value.outcome.code,
					) &&
					["agent_failed", "deadline"].includes(value.outcome.provenance) &&
					typeof value.outcome.message === "string" &&
					value.outcome.message.length > 0),
	);
}
