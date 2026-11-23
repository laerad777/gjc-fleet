import { join } from "node:path";
import type { NodeConfig, Phase, TaskProgress, TaskProgressEntryKind, TaskProgressVerdict, TaskState } from "./contracts";
import { TransportError } from "./rpc";
import { spawnTrusted } from "./spawn";

/**
 * Lane progress, read on the node from the GJC session transcript `<agentDir>/sessions/<dir>/<ts>_<sessionId>.jsonl`.
 *
 * The broker heartbeat is per node (every session of a node shows the same `lastHeartbeatAt`) and
 * `activity.state` stays "active" for a hung session, so neither can show a stuck session. The transcript can:
 * GJC appends one JSON line per entry, so the file's modification time is the time of the last write and the
 * last line is the last entry. The node-side command reports only, per session: whether exactly one transcript
 * exists, its modification time, the node's own clock, the last line's entry `type`, its `message.role`,
 * the distinct `stopReason` value(s) of an assistant line, whether the line is complete, and the number of tool
 * calls of the last assistant line that have no toolResult line yet (counted over the last PROGRESS_TAIL_LINES
 * lines: a parallel tool batch writes each result when that tool finishes, so a finished first result must not
 * read as "waiting for the model" while a long second tool still runs), and the `stopReason` of the window's last
 * message line when that line is an assistant line (a finished turn can be followed by non-message entries such as
 * `model_change` or `custom`). It never prints
 * transcript text, never runs `gjc` (so it can neither attach to, prompt nor start anything), and runs once per
 * node for all of that node's sessions.
 *
 * Format-dependent (verified on GJC 0.19.3 transcripts, session header version 5): entry lines start with
 * `{"type":"<type>"`; message entries carry `"message":{"role":"<role>"` within their first 512 bytes; an
 * assistant line carries its top-level `"stopReason":"<value>"` once (it can sit more than 40 KB before the end
 * of the line, after `providerPayload`), so the whole last line is scanned for it; each tool call of an assistant
 * line is one `"type":"toolCall"` content block (count exact on 1523 local assistant lines), each result one
 * `message` line with role `toolResult` (other entries such as `custom` can sit between them); JSON string escaping keeps
 * transcript text from ever matching these unescaped key patterns. Other entry types (`model_change`, which
 * has its own top-level `"role":"default"`, `thinking_level_change`, `custom`, `compaction`, ...) are reported
 * as `other`.
 */
export const PROGRESS_DEFAULTS = Object.freeze({
	/** Waiting for the model with no transcript write for MORE than this = stalled_model (model stream idle limit is 300 s). */
	modelStallSeconds: 480,
	/** A tool running with no transcript write for MORE than this = stalled_tool. */
	toolStallSeconds: 2400,
	/** A task whose progress was read less than this long ago is not read again by watch/queue/poll. */
	minIntervalSeconds: 60,
	/** A finished_unobserved active task triggers the normal observation at most once per transcript write, or again after this long. */
	settleRetrySeconds: 300,
	posixTimeoutMs: 20_000,
	win32TimeoutMs: 60_000,
});
export type ProgressConfig = {
	modelStallSeconds: number;
	toolStallSeconds: number;
	minIntervalSeconds: number;
	settleRetrySeconds: number;
	posixTimeoutMs: number;
	win32TimeoutMs: number;
};
/** Largest accepted threshold or interval: 7 days, in each key's own unit (`*Seconds` keys in s, `*Ms` keys in ms). */
export const PROGRESS_MAX_SECONDS = 7 * 24 * 3600;
export function progressConfig(value: Partial<ProgressConfig> = {}): ProgressConfig {
	const config = { ...PROGRESS_DEFAULTS, ...value };
	for (const [key, n] of Object.entries(config))
		if (!Number.isSafeInteger(n) || n < 1 || n > (key.endsWith("Ms") ? PROGRESS_MAX_SECONDS * 1000 : PROGRESS_MAX_SECONDS)) throw new Error("invalid_progress_" + key);
	return config;
}
/** Sessions per node read in one command; more are read on the next refresh (least recently read first). */
export const PROGRESS_SESSION_LIMIT = 64;
/**
 * Longest remote command sent to a win32 node over ssh: Windows OpenSSH runs it through the node's default shell,
 * and cmd.exe refuses a command line above 8191 characters (margin for its own `cmd.exe /c` prefix).
 */
export const PROGRESS_WIN32_SSH_COMMAND_LIMIT = 8000;
export const PROGRESS_STDOUT_LIMIT = 64 * 1024;
export const PROGRESS_STDERR_LIMIT = 64 * 1024;
/** A transcript written more than this far in the node's own future cannot be aged. */
export const PROGRESS_CLOCK_TOLERANCE_SECONDS = 120;
/** Transcript lines (from the end) read for the pending tool-call count of a parallel tool batch. */
export const PROGRESS_TAIL_LINES = 64;
/** Windows reads at most this many bytes from the end for those lines (a longer last entry reads as unreadable). */
export const PROGRESS_WIN32_TAIL_BYTES = 16 * 1024 * 1024;
/** Phases whose session is expected to be making progress (approval_required waits on a human). */
export const PROGRESS_PHASES: readonly Phase[] = ["active", "blocked_unknown"];
/**
 * A stall that recovers is audited (progress_recovered) only once no new stall followed within this long; a stall
 * within it continues the same episode (counted in `stall.coalesced`). At most one stalled/recovered pair per
 * task per this long plus one read interval is audited, whatever the thresholds.
 */
export const PROGRESS_EPISODE_COALESCE_SECONDS = 3600;
/**
 * Hub ms by which a stored read may have been issued after a later-landing read and still be the newer one (an
 * overlapping read finishes within its deadline). A stored read issued further in the future than this is a hub
 * clock that stepped back: the new read is accepted instead of freezing the record until the clock catches up.
 */
export function progressOrderToleranceMs(config: Pick<ProgressConfig, "posixTimeoutMs" | "win32TimeoutMs">): number {
	return Math.max(config.posixTimeoutMs, config.win32TimeoutMs) + PROGRESS_CLOCK_TOLERANCE_SECONDS * 1000;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a task whose session progress Fleet reads. Tasks without a GJC session UUID are never read. */
export function progressEligible(task: TaskState): boolean {
	return (
		PROGRESS_PHASES.includes(task.phase) &&
		!task.result?.executionTerminal &&
		typeof task.sessionId === "string" &&
		UUID.test(task.sessionId) &&
		typeof task.turnId === "string" &&
		typeof task.attemptId === "string" &&
		!!task.nodeSnapshot
	);
}
/** A task's progress record is shown only while it is in a progress phase; afterwards it is a frozen last read. */
export function progressShown(task: Pick<TaskState, "phase" | "result">): boolean {
	return PROGRESS_PHASES.includes(task.phase) && !task.result?.executionTerminal;
}
/** Terminal phases: a task here (or with a terminal execution) is never read or shown again, so its record is dropped. */
const SETTLED_PHASES: readonly Phase[] = ["succeeded", "failed", "cancelled", "archived"];
export function progressSettled(task: Pick<TaskState, "phase" | "result">): boolean {
	return SETTLED_PHASES.includes(task.phase) || task.result?.executionTerminal === true;
}

/** The read a progress record comes from (hub clock, ms). */
export type ProgressRead = { attemptId: string; sessionId: string; startedAt: number; observedAt: number; config: ProgressConfig };
/** One session's classified outcome: node-measured age, or a failure (recorded with a diagnostic). */
export type ProgressReading =
	| { ok: true; kind: TaskProgressEntryKind; stopReason?: string; pendingToolsUnknown?: true; idleSeconds: number; writtenAt: number; nodeNow: number }
	| { ok: false };
/**
 * One session's line of the node reply. `pendingTools` is absent when the read window holds no line that fixes
 * the count (no assistant or user message line and not the session header): an open tool batch may lie before it.
 * `lastMessageStop` is the stopReason of the read window's last message line when it is an assistant line, else `-`.
 */
export type SessionReading =
	| { status: "ok"; mtime: number; nodeNow: number; type: string; role: string; stopReason: string; complete: boolean; pendingTools?: number; lastMessageStop: string }
	| { status: "missing" | "ambiguous" | "unreadable" | "invalid" };
export type NodeProgressReply = Map<string, SessionReading>;

// ---- node-side commands ------------------------------------------------------------------------------
/**
 * The agent dir of the node's route: the whole value of a `GJC_CODING_AGENT_DIR=` argv element (as
 * scripts/local-node.ts writes it, spaces included), or an unquoted word of a remote command string. A quoted or
 * escaped embedded value, or one holding a shell operator (`&`, `|`, `<`, `>`: cmd's `set NAME=value&& gjc`), cannot
 * be split unambiguously here: refused (never a truncated or extended path).
 */
function agentDirOf(node: NodeConfig): string | undefined {
	const transport = node.sdkTransport ?? node.transport;
	for (const arg of transport.args) {
		if (arg.startsWith("GJC_CODING_AGENT_DIR=")) return arg.slice("GJC_CODING_AGENT_DIR=".length);
		const match = /(?:^|\s)GJC_CODING_AGENT_DIR=(\S*)/.exec(arg);
		if (match) {
			if (match[1] === "" || /["'`^&|<>]/.test(match[1]!)) throw new Error("progress_agent_dir_ambiguous");
			return match[1];
		}
	}
	return undefined;
}
/** Agent-dir characters safe inside the scripts' quoting (posix double quotes, PowerShell single quotes). */
const AGENT_DIR_CHARS = String.raw`\p{L}\p{N}\p{M}_ .~()&+,@\-`;
/** POSIX: one `sh` script for all sessions. Contains no single quote, so it can be passed as `sh -c '<script>'`. */
export function posixProgressScript(ids: readonly string[], agentDir?: string): string {
	for (const id of ids) if (!UUID.test(id)) throw new Error("progress_session_id_invalid");
	let dir = '"${GJC_CODING_AGENT_DIR:-$HOME/.gjc/agent}"';
	if (agentDir !== undefined) {
		if (new RegExp(`^~/[${AGENT_DIR_CHARS}/]*$`, "u").test(agentDir)) dir = '"$HOME/' + agentDir.slice(2) + '"';
		else if (new RegExp(`^/[${AGENT_DIR_CHARS}/]*$`, "u").test(agentDir)) dir = '"' + agentDir + '"';
		else throw new Error("progress_agent_dir_invalid");
	}
	const script = [
		"GJC_SDK_BROKER_AUTOSTART=0; export GJC_SDK_BROKER_AUTOSTART; LC_ALL=C; export LC_ALL",
		"d=" + dir,
		// fin: fold the finished line into the pending-tool count: an assistant line opens a batch of its toolCall
		// blocks, each toolResult line closes one, a user line ends the turn. kn: an assistant/user line or the
		// session header (the file's first line) is in the window, so no open batch can lie before it. mr/ms: role and
		// stopReason of the last message line.
		String.raw`fin() { if [ "$lt" = session ]; then kn=1; fi; if [ "$lt" = message ]; then mr=$lr; ms=$ls; case "$lr" in assistant) pc=$lc; pr=0; kn=1;; toolResult) pr=$((pr+1));; user) pc=0; pr=0; kn=1;; esac; fi; }`,
		// val: the value of a "key":"value" token, without a subshell.
		'val() { v=${1%\\"}; v=${v##*\\"}; }',
		'echo "FLEETPROGRESS 1"',
		"for i in " + ids.join(" ") + "; do",
		' set -- "$d"/sessions/*/*_"$i".jsonl',
		' if [ "$#" -gt 1 ]; then echo "S $i ambiguous"; continue; fi',
		" f=$1",
		' if [ ! -e "$f" ]; then echo "S $i missing"; continue; fi',
		' if [ ! -f "$f" ] || [ ! -r "$f" ]; then echo "S $i unreadable"; continue; fi',
		' m=$(stat -c %Y -- "$f" 2>/dev/null) || m=$(stat -f %m -- "$f" 2>/dev/null) || m=',
		" n=$(date +%s)",
		' case "$m" in ""|*[!0-9]*) echo "S $i unreadable"; continue;; esac',
		' case "$n" in ""|*[!0-9]*) echo "S $i unreadable"; continue;; esac',
		// The last PROGRESS_TAIL_LINES lines, reduced by grep to key tokens with line numbers (never text): the
		// line-start entry type, the first message role, each toolCall block and each stopReason. The first token
		// of a line is its type (a line starts with {"type":...); later {"type":"toolCall" tokens are toolCall
		// blocks also where a grep re-anchors ^ after a match.
		String.raw` g=$(tail -n ${PROGRESS_TAIL_LINES} -- "$f" 2>/dev/null | grep -n -o -e "^{\"type\":\"[a-z_]*\"" -e "\"message\":{\"role\":\"[A-Za-z]*\"" -e "\"type\":\"toolCall\"" -e "\"stopReason\":\"[A-Za-z_]*\"")`,
		String.raw` ln=; lt=-; lr=-; lc=0; ls=; pc=0; pr=0; kn=0; mr=-; ms=`,
		String.raw` while IFS= read -r x; do`,
		String.raw`  [ -n "$x" ] || continue`,
		'  q=${x%%:*}; k=${x#*:}',
		String.raw`  if [ "$q" != "$ln" ]; then fin; ln=$q; lt=-; lr=-; lc=0; ls=; o=1; else o=0; fi`,
		String.raw`  case "$k" in`,
		String.raw`   \"type\":\"toolCall\") lc=$((lc+1));;`,
		String.raw`   {\"type\":\"toolCall\") if [ "$o" = 1 ]; then lt=toolCall; else lc=$((lc+1)); fi;;`,
		String.raw`   {\"type\":*) if [ "$o" = 1 ]; then val "$k"; lt=$v; fi;;`,
		String.raw`   \"message\":*) if [ "$lr" = - ]; then val "$k"; lr=$v; fi;;`,
		String.raw`   \"stopReason\":*) val "$k"; if [ -z "$ls" ] || [ "$ls" = "$v" ]; then ls=$v; else ls="*"; fi;;`,
		String.raw`  esac`,
		String.raw` done <<FLEETTOKENS`,
		String.raw`$g`,
		String.raw`FLEETTOKENS`,
		String.raw` fin`,
		String.raw` t=$lt; r=$lr; s=; if [ "$r" = assistant ]; then s=$ls; fi`,
		String.raw` p=0; if [ "$pc" -gt "$pr" ]; then p=$((pc-pr)); fi; if [ "$kn" = 0 ]; then p=?; fi`,
		String.raw` c=0; if [ "$(tail -c 1 -- "$f" 2>/dev/null | od -An -c | tr -d " ")" = "\n" ]; then c=1; fi`,
		String.raw` a=; if [ "$mr" = assistant ]; then a=$ms; fi`,
		' echo "S $i ok $m $n ${t:--} ${r:--} ${s:--} $c $p ${a:--}"',
		"done",
		'echo "FLEETPROGRESS end"',
	].join("\n");
	if (script.includes("'")) throw new Error("progress_script_quote");
	return script;
}
/** Windows PowerShell (5.1 compatible): the same protocol, reading with FileShare ReadWrite|Delete so GJC keeps writing. */
export function win32ProgressScript(ids: readonly string[], agentDir?: string): string {
	for (const id of ids) if (!UUID.test(id)) throw new Error("progress_session_id_invalid");
	let dir = "$(if($env:GJC_CODING_AGENT_DIR){$env:GJC_CODING_AGENT_DIR}else{Join-Path $env:USERPROFILE '.gjc\\agent'})";
	if (agentDir !== undefined) {
		if (!new RegExp(String.raw`^[A-Za-z]:[\\/][${AGENT_DIR_CHARS}\\/]*$`, "u").test(agentDir)) throw new Error("progress_agent_dir_invalid");
		dir = "'" + agentDir + "'";
	}
	const ps = [
		String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$env:GJC_SDK_BROKER_AUTOSTART='0';`,
		String.raw`$d=${dir};$e=New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc);`,
		String.raw`[Console]::Out.WriteLine('FLEETPROGRESS 1');`,
		String.raw`foreach($i in @(${ids.map((id) => `'${id}'`).join(",")})){`,
		String.raw`try{$f=@(Get-ChildItem -Path (Join-Path (Join-Path $d 'sessions') ('*\*_'+$i+'.jsonl')) -File -ErrorAction SilentlyContinue);`,
		String.raw`if($f.Count -eq 0){[Console]::Out.WriteLine("S $i missing");continue};`,
		String.raw`if($f.Count -gt 1){[Console]::Out.WriteLine("S $i ambiguous");continue};`,
		String.raw`$m=[int64][math]::Floor(($f[0].LastWriteTimeUtc-$e).TotalSeconds);$n=[int64][math]::Floor(([DateTime]::UtcNow-$e).TotalSeconds);`,
		String.raw`$s=[IO.File]::Open($f[0].FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]'ReadWrite,Delete');`,
		String.raw`try{$len=$s.Length;$c='0';$end=$len;$ok=$true;`,
		String.raw`if($len -gt 0){$s.Position=$len-1;if($s.ReadByte() -eq 10){$c='1';$end=$len-1}};`,
		// At most the last TAIL_BYTES bytes; their first (partial) line is dropped unless the read starts the file.
		String.raw`$st=[math]::Max(0,$end-${PROGRESS_WIN32_TAIL_BYTES});$nb=[int]($end-$st);$b=New-Object byte[] $nb;$s.Position=$st;$got=0;`,
		String.raw`while($got -lt $nb){$r=$s.Read($b,$got,$nb-$got);if($r -le 0){throw 'short'};$got+=$r};`,
		String.raw`$ls=@([Text.Encoding]::UTF8.GetString($b).Split([char]10));`,
		String.raw`if($st -gt 0){if($ls.Count -le 1){$ok=$false}else{$ls=@($ls[1..($ls.Count-1)])}};`,
		String.raw`if($ls.Count -gt ${PROGRESS_TAIL_LINES}){$ls=@($ls[($ls.Count-${PROGRESS_TAIL_LINES})..($ls.Count-1)])};`,
		String.raw`$ty='-';$ro='-';$sr='-';$pc=0;$pr=0;$kn=$false;$xs='-';`,
		String.raw`if($ok){foreach($l in $ls){$h=$l;if($l.Length -gt 512){$h=$l.Substring(0,512)};$lt='-';$lr='-';$lsr='-';`,
		String.raw`$mt=[regex]::Match($h,'^\{"type":"([a-z_]+)"');if($mt.Success){$lt=$mt.Groups[1].Value};`,
		String.raw`$mr=[regex]::Match($h,'"message":\{"role":"([A-Za-z]+)"');if($mr.Success){$lr=$mr.Groups[1].Value};`,
		String.raw`if($lr -eq 'assistant'){$v=@([regex]::Matches($l,'"stopReason":"([A-Za-z_]+)"')|ForEach-Object{$_.Groups[1].Value}|Select-Object -Unique);if($v.Count -eq 1){$lsr=$v[0]}elseif($v.Count -gt 1){$lsr='*'}};`,
		String.raw`if($lt -eq 'session'){$kn=$true};`,
		String.raw`if($lt -eq 'message'){$xs=$lsr;if($lr -eq 'assistant'){$pc=[regex]::Matches($l,'"type":"toolCall"').Count;$pr=0;$kn=$true}elseif($lr -eq 'toolResult'){$pr++}elseif($lr -eq 'user'){$pc=0;$pr=0;$kn=$true}};`,
		String.raw`$ty=$lt;$ro=$lr;$sr=$lsr}};`,
		String.raw`$p=[math]::Max(0,$pc-$pr);if(-not $kn){$p='?'}`,
		String.raw`if($ok){[Console]::Out.WriteLine("S $i ok $m $n $ty $ro $sr $c $p $xs")}else{[Console]::Out.WriteLine("S $i unreadable")}`,
		String.raw`}finally{$s.Close()}}catch{[Console]::Out.WriteLine("S $i unreadable")}};`,
		String.raw`[Console]::Out.WriteLine('FLEETPROGRESS end')`,
	];
	return ps.join("");
}
function powershellArgs(script: string): string[] {
	return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}
/**
 * The node's registered route (sdkTransport, else transport): an `ssh` transport reaches the node host with its
 * own destination and options; any other command runs on this host. Throws `progress_route_unavailable`.
 */
export function progressInvocation(node: NodeConfig, ids: readonly string[], config: ProgressConfig): { argv: string[]; timeoutMs: number } {
	const transport = node.sdkTransport ?? node.transport;
	const agentDir = agentDirOf(node);
	const win32 = node.os === "win32";
	const script = win32 ? win32ProgressScript(ids, agentDir) : posixProgressScript(ids, agentDir);
	const timeoutMs = win32 ? config.win32TimeoutMs : config.posixTimeoutMs;
	if (transport.command === "ssh") {
		if (transport.args.length < 2) throw new Error("progress_route_unavailable");
		const head = ["ssh", ...transport.args.slice(0, -1)];
		if (win32) {
			const remote = ["powershell", ...powershellArgs(script)].join(" ");
			if (remote.length > PROGRESS_WIN32_SSH_COMMAND_LIMIT) throw new Error("progress_command_too_long");
			return { argv: [...head, remote], timeoutMs };
		}
		const wsl = /^(wsl\.exe .*? -- )/i.exec(transport.args.at(-1) ?? "")?.[1] ?? "";
		return { argv: [...head, wsl + "sh -c '" + script + "'"], timeoutMs };
	}
	if (win32) {
		if (process.platform !== "win32") throw new Error("progress_route_unavailable");
		return { argv: ["powershell.exe", ...powershellArgs(script)], timeoutMs };
	}
	if (process.platform === "win32") throw new Error("progress_route_unavailable");
	return { argv: ["sh", "-c", script], timeoutMs };
}

/**
 * Sessions one command of this node's route carries: PROGRESS_SESSION_LIMIT, fewer for a win32 node over ssh
 * (the most whose remote command stays within PROGRESS_WIN32_SSH_COMMAND_LIMIT; session ids have a fixed length).
 */
export function progressSessionLimit(node: NodeConfig, config: ProgressConfig): number {
	if (node.os !== "win32" || (node.sdkTransport ?? node.transport).command !== "ssh") return PROGRESS_SESSION_LIMIT;
	const id = "00000000-0000-0000-0000-000000000000";
	for (let n = PROGRESS_SESSION_LIMIT; n > 1; n--)
		try {
			progressInvocation(node, Array(n).fill(id), config);
			return n;
		} catch {}
	// Even one session does not fit (or no route): the read itself reports progress_route_unavailable.
	return 1;
}

// ---- bounded one-shot run ------------------------------------------------------------------------------
function killTree(child: ReturnType<typeof Bun.spawn>): void {
	// Match node.ts killTree: Windows needs taskkill /T /F for descendants; POSIX kills the process group.
	if (process.platform === "win32") {
		if (child.exitCode !== null || child.signalCode !== null) return;
		try {
			const killer = spawnTrusted(
				[
					join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					"/PID",
					String(child.pid),
					"/T",
					"/F",
				],
				{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
			);
			// taskkill /F already force-ends the tree; still SIGKILL the Bun handle so a
			// trapped/stale root cannot outlive the deadline (matches POSIX killTree).
			killer.exited.finally(() => child.kill("SIGKILL")).catch(() => {});
		} catch {
			child.kill("SIGKILL");
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {}
	child.kill("SIGKILL");
}
/** Run one node read: bounded stdout/stderr, a deadline, never retried (it is a read; the next refresh reads again). */
export async function runProgressCommand(argv: string[], timeoutMs: number): Promise<string> {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = spawnTrusted(argv, {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
			detached: process.platform !== "win32",
		});
	} catch {
		throw new TransportError("progress_spawn_failed", "before_send");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new TransportError("progress_timeout", "unknown")), timeoutMs);
	});
	const readers = [
		(child.stdout as ReadableStream<Uint8Array>).getReader(),
		(child.stderr as ReadableStream<Uint8Array>).getReader(),
	];
	async function bounded(reader: ReadableStreamDefaultReader<Uint8Array>, limit: number, keep: boolean): Promise<Buffer> {
		let total = 0;
		const parts: Uint8Array[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return Buffer.concat(parts);
			total += value.length;
			if (total > limit) throw new TransportError("progress_output_limit", "unknown");
			if (keep) parts.push(value);
		}
	}
	let completed = false;
	try {
		const [stdout, , exit] = await Promise.race([
			Promise.all([bounded(readers[0]! as unknown as ReadableStreamDefaultReader<Uint8Array>, PROGRESS_STDOUT_LIMIT, true), bounded(readers[1]! as unknown as ReadableStreamDefaultReader<Uint8Array>, PROGRESS_STDERR_LIMIT, false), child.exited]),
			deadline,
		]);
		if (exit !== 0) throw new TransportError("progress_exit", "unknown");
		completed = true;
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(stdout);
		} catch {
			throw new TransportError("progress_reply_invalid", "unknown");
		}
	} catch (error) {
		if (error instanceof TransportError) throw error;
		throw new TransportError("progress_exit", "unknown");
	} finally {
		clearTimeout(timer);
		if (!completed) killTree(child);
		for (const reader of readers) reader.cancel().catch(() => {});
	}
}

/** Strict parse of the node reply. Throws `progress_reply_invalid` for a reply that is not one complete block. */
export function parseProgressReply(stdout: string, ids: readonly string[]): NodeProgressReply {
	const lines = stdout.split(/\r?\n/);
	const start = lines.indexOf("FLEETPROGRESS 1");
	const end = lines.lastIndexOf("FLEETPROGRESS end");
	if (start < 0 || end <= start) throw new TransportError("progress_reply_invalid", "unknown");
	const wanted = new Set(ids);
	const out: NodeProgressReply = new Map();
	for (const line of lines.slice(start + 1, end)) {
		if (line === "") continue;
		const fields = line.split(" ");
		if (fields[0] !== "S" || !wanted.has(fields[1]!) || out.has(fields[1]!)) throw new TransportError("progress_reply_invalid", "unknown");
		const id = fields[1]!;
		if (fields.length === 3 && ["missing", "ambiguous", "unreadable"].includes(fields[2]!)) {
			out.set(id, { status: fields[2] as "missing" | "ambiguous" | "unreadable" });
			continue;
		}
		const [, , status, mtime, nodeNow, type, role, stopReason, complete, pending, lastMessageStop] = fields;
		if (
			fields.length === 11 &&
			status === "ok" &&
			/^\d{1,12}$/.test(mtime!) &&
			/^\d{1,12}$/.test(nodeNow!) &&
			/^(?:-|[a-z_]{1,64})$/.test(type!) &&
			/^(?:-|[A-Za-z]{1,64})$/.test(role!) &&
			/^(?:-|\*|[A-Za-z_]{1,64})$/.test(stopReason!) &&
			/^[01]$/.test(complete!) &&
			/^(?:\d{1,6}|\?)$/.test(pending!) &&
			/^(?:-|\*|[A-Za-z_]{1,64})$/.test(lastMessageStop!)
		)
			out.set(id, {
				status: "ok", mtime: Number(mtime), nodeNow: Number(nodeNow), type: type!, role: role!, stopReason: stopReason!, complete: complete === "1", lastMessageStop: lastMessageStop!,
				...(pending === "?" ? {} : { pendingTools: Number(pending) }),
			});
		else out.set(id, { status: "invalid" });
	}
	for (const id of ids) if (!out.has(id)) out.set(id, { status: "invalid" });
	return out;
}

/** One node read for all given sessions (at most PROGRESS_SESSION_LIMIT). */
export async function readNodeProgress(node: NodeConfig, ids: readonly string[], config: ProgressConfig): Promise<NodeProgressReply> {
	if (ids.length === 0) return new Map();
	if (ids.length > PROGRESS_SESSION_LIMIT) throw new Error("progress_session_limit");
	let invocation: { argv: string[]; timeoutMs: number };
	try {
		invocation = progressInvocation(node, ids, config);
	} catch {
		throw new ProgressRouteError();
	}
	return parseProgressReply(await runProgressCommand(invocation.argv, invocation.timeoutMs), ids);
}
/** The node has no registered route this hub can run the read through (precondition, nothing was run). */
export class ProgressRouteError extends Error {
	constructor() {
		super("progress_route_unavailable");
	}
}

// ---- classification -------------------------------------------------------------------------------------
const finalStop = (stopReason: string) => (["stop", "length", "error", "aborted"].includes(stopReason) ? stopReason : "other");
export function entryKind(reading: Extract<SessionReading, { status: "ok" }>): { kind: TaskProgressEntryKind; stopReason?: string; pendingToolsUnknown?: true } {
	const pending = reading.pendingTools;
	if (reading.type === "message") {
		if (reading.role === "assistant") {
			if (reading.stopReason === "toolUse") return { kind: "tool_running", stopReason: "toolUse" };
			if (reading.stopReason === "-" || reading.stopReason === "*") return { kind: "other" };
			return { kind: "assistant_final", stopReason: finalStop(reading.stopReason) };
		}
		// A parallel tool batch writes each result when it finishes: with a call of the batch still open, a tool runs.
		// Count unknown (the batch's assistant line lies before the read window): a tool may still run.
		if (reading.role === "toolResult") return pending === undefined ? { kind: "other", pendingToolsUnknown: true } : pending > 0 ? { kind: "tool_running" } : { kind: "awaiting_model" };
		if (reading.role === "user") return { kind: "awaiting_model" };
	}
	if (pending === undefined) return reading.type === "-" && reading.role === "-" ? { kind: "none" } : { kind: "other", pendingToolsUnknown: true };
	if (pending > 0) return { kind: "tool_running" };
	// A finished assistant line followed only by non-message entries (model_change, custom, ...): the turn finished.
	if (!["-", "*", "toolUse"].includes(reading.lastMessageStop)) return { kind: "assistant_final", stopReason: finalStop(reading.lastMessageStop) };
	if (reading.type === "-" && reading.role === "-") return { kind: "none" };
	return { kind: "other" };
}
/**
 * The verdict, from the node-side age (node clock minus file time: no hub/node skew) and the hub phase.
 * Thresholds are "more than": exactly at the limit is still progressing. With the pending tool count unknown a
 * tool may still run, so the tool threshold applies (never a model stall while a tool can be running).
 */
export function progressVerdict(
	kind: TaskProgressEntryKind,
	idleSeconds: number,
	phase: Phase,
	config: Pick<ProgressConfig, "modelStallSeconds" | "toolStallSeconds">,
	pendingToolsUnknown = false,
): TaskProgressVerdict {
	if (kind === "assistant_final") return PROGRESS_PHASES.includes(phase) ? "finished_unobserved" : "progressing";
	if (kind === "tool_running" || pendingToolsUnknown) return idleSeconds > config.toolStallSeconds ? "stalled_tool" : "progressing";
	return idleSeconds > config.modelStallSeconds ? "stalled_model" : "progressing";
}
const HINTS: Record<TaskProgressVerdict, string> = {
	progressing: "Transcript is being written; no action needed.",
	stalled_model:
		"No transcript write past the model-wait limit: the session looks stuck waiting for the model. Check it on its node (gjc sdk session inspect); Fleet never kills, closes, resends or reassigns. Cancel only after checking.",
	stalled_tool:
		"No transcript write past the tool limit: a tool call looks hung. Check the process on its node; Fleet never kills, closes, resends or reassigns. Cancel only after checking.",
	finished_unobserved:
		"Transcript shows the turn finished while the hub still records it running; watch observes an active task once per finished state (a blocked_unknown task is display only). If the phase does not change, run poll TASK_ID.",
	unknown: "Progress could not be read; see the diagnostic. Check the node route and the session transcript.",
};
export function progressHint(verdict: TaskProgressVerdict): string {
	return HINTS[verdict];
}
export function progressFlagged(progress: TaskProgress | undefined): boolean {
	return progress?.verdict === "stalled_model" || progress?.verdict === "stalled_tool" || progress?.verdict === "finished_unobserved";
}
/** Compact `tasks` marker, only for a flagged task still in a progress phase; empty otherwise. */
export function progressMarker(task: TaskState, now: number): string {
	const progress = task.progress;
	if (!progressFlagged(progress) || !progressShown(task)) return "";
	if (progress!.verdict === "finished_unobserved") return "FINISHED_UNOBSERVED";
	const at = Date.parse(progress!.lastProgressAt ?? "");
	const idle = Number.isFinite(at) ? `${Math.max(0, Math.floor((now - at) / 1000))}s` : "?";
	return `${progress!.verdict === "stalled_tool" ? "STALLED_TOOL" : "STALLED_MODEL"}:${idle}`;
}
