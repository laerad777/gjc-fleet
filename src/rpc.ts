import type { NodeConfig } from "./contracts";
import { nodeObservationTimeoutMs, nodeRpcTimeoutMs } from "./core";
import { spawnTrusted } from "./spawn";
import { sha256 } from "./workspace";

export class TransportError extends Error {
	/** The per-call limit that expired; set only on `transport_timeout` from StdioRpc. */
	declare timeoutMs?: number;
	constructor(
		public code: string,
		public certainty: "before_send" | "unknown",
		message = code,
		public publicResponse?: unknown,
	) {
		super(message);
	}
}
/**
 * The only constructor of a node's Coordinator RPC client. The per-call limit is the node's effective
 * `transport.timeoutMs` (see nodeRpcTimeoutMs), and nodeObservationTimeoutMs for the observation reads,
 * unless a caller with its own documented deadline (onboarding probe, placement preflight) passes one
 * explicitly; that one then bounds every request.
 */
export function nodeRpc(node: Pick<NodeConfig, "os" | "transport">, timeoutMs?: number): StdioRpc {
	return timeoutMs === undefined
		? new StdioRpc(node.transport.command, node.transport.args, nodeRpcTimeoutMs(node), nodeObservationTimeoutMs(node))
		: new StdioRpc(node.transport.command, node.transport.args, timeoutMs);
}
/** Read-only Coordinator tools; their calls are bounded by the observation limit of the client. */
export const OBSERVATION_TOOLS: ReadonlySet<string> = new Set(["gjc_coordinator_read_turn", "gjc_coordinator_list_questions"]);
/**
 * What a refused `gjc_coordinator_start_session` (create) call proves, by refusal reason. Deny-by-default:
 * only a reason listed here as `failed_before_effect` proves that no session exists for the call, so the
 * attempt may settle as failed and release its reservation. Every other reason, a bare `tool_refused`
 * without a reason, and every non-refusal transport failure stays `unknown` (held, never re-sent).
 *
 * - `spawn_failed`: the Broker observed that the agent process could not be spawned and the Coordinator
 *   forwards that primary code verbatim (with its lifecycle diagnostic) only when no session identity was
 *   produced; recorded evidence from a real run (missing
 *   provider credentials, no SID and no SEND) matches.
 * - `broker_compensation_unobserved`: the Coordinator's broad wrapper for ANY unobserved primary error,
 *   possibly after a session was created and a compensating close was attempted; proves nothing.
 */
export const CREATE_REFUSAL_CLASSES: Readonly<Record<string, "failed_before_effect" | "unknown">> = Object.freeze({
	spawn_failed: "failed_before_effect",
	broker_compensation_unobserved: "unknown",
});
/**
 * Class of a thrown create failure. `failed_before_effect` requires a tool refusal whose reply is an explicit
 * `ok:false` refusal carrying that exact reason and no session identity at all.
 */
export function classifyCreateRefusal(error: unknown): { class: "failed_before_effect" | "unknown"; reason?: string } {
	if (!(error instanceof TransportError)) return { class: "unknown" };
	const match = /^tool_refused:([a-zA-Z0-9_:.-]{1,128})$/.exec(error.code);
	if (!match) return { class: "unknown" };
	const reason = match[1]!;
	const reply = error.publicResponse as any;
	const exact =
		typeof reply === "object" && reply !== null && !Array.isArray(reply) &&
		reply.ok === false &&
		reply.error?.code === reason &&
		reply.session === undefined && reply.session_id === undefined && reply.sessionId === undefined &&
		reply.error?.session_id === undefined && reply.error?.sessionId === undefined;
	const known = Object.hasOwn(CREATE_REFUSAL_CLASSES, reason) ? CREATE_REFUSAL_CLASSES[reason]! : "unknown";
	return { class: exact ? known : "unknown", reason };
}
/** Authenticated local process or an explicitly configured SSH stdio command; no shell or PTY. */
export class StdioRpc {
	private child: ReturnType<typeof Bun.spawn>;
	private nextId = 0;
	private pending = new Map<
		number,
		{
			resolve: (value: any) => void;
			reject: (e: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			limitMs: number;
		}
	>();
	private stopped = false;
	private stderrBytes = 0;
	private stderrHash = "";
	constructor(
		command: string,
		args: string[] = [],
		private timeoutMs = 30000,
		private observationTimeoutMs = timeoutMs,
	) {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") env[key] = value;
		}
		this.child = spawnTrusted([command, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		this.readOutput();
		this.drainStderr();
		this.child.exited.then(() =>
			this.fail(new TransportError("transport_exited", "unknown")),
		);
	}
	private fail(error: Error) {
		if (this.stopped) return;
		this.stopped = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		this.pending.clear();
		// Tear-down is final: SIGKILL immediately so a SIGTERM trap (or a stuck SSH child) cannot
		// outlive close()/timeout the way a grace-only kill would. Matches dashboard stream stop.
		try {
			this.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
	private async drainStderr() {
		try {
			const reader = (
				this.child.stderr as ReadableStream<Uint8Array>
			).getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				this.stderrBytes += value.length;
				this.stderrHash = sha256(this.stderrHash + sha256(value));
				if (this.stderrBytes > 1024 * 1024) {
					this.fail(new TransportError("stderr_limit", "unknown"));
					break;
				}
			}
		} catch {
			this.fail(new TransportError("stderr_failure", "unknown"));
		}
	}
	/** False once the transport failed or was closed: a request now would be refused before send. */
	get open(): boolean {
		return !this.stopped;
	}
	diagnostics() {
		return {
			stderrBytes: this.stderrBytes,
			stderrChainDigest: this.stderrHash,
		};
	}
	private async readOutput() {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		let buffer = "";
		try {
			const reader = (
				this.child.stdout as ReadableStream<Uint8Array>
			).getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					buffer += decoder.decode();
					if (buffer.trim()) throw new Error("incomplete_frame");
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer) > 4 * 1024 * 1024)
					throw new Error("frame_limit");
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (!line.trim()) continue;
					const message = JSON.parse(line);
					if (message.jsonrpc !== "2.0") throw new Error("invalid_rpc");
					if (message.id === undefined) continue;
					if (typeof message.id !== "number") throw new Error("invalid_rpc_id");
					const request = this.pending.get(message.id);
					if (!request) continue;
					this.pending.delete(message.id);
					clearTimeout(request.timer);
					if (message.error)
						request.reject(new TransportError("rpc_error", "unknown"));
					else if ("result" in message) request.resolve(message.result);
					else
						request.reject(new TransportError("invalid_rpc_result", "unknown"));
				}
			}
		} catch {
			this.fail(new TransportError("invalid_transport_output", "unknown"));
		}
	}
	async request(method: string, params: unknown, limitMs = this.timeoutMs): Promise<any> {
		if (this.stopped)
			throw new TransportError("transport_closed", "before_send");
		if (this.pending.size >= 16)
			throw new TransportError("too_many_requests", "before_send");
		// Any expiry fails the whole connection, so a pending request with another limit would be bounded by
		// the earlier one: requests with different limits never overlap; refused before anything is written.
		for (const pending of this.pending.values())
			if (pending.limitMs !== limitMs) throw new TransportError("too_many_requests", "before_send");
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const timeout = new TransportError("transport_timeout", "unknown");
				timeout.timeoutMs = limitMs;
				this.fail(timeout);
			}, limitMs);
			this.pending.set(id, { resolve, reject, timer, limitMs });
			try {
				(this.child.stdin as any).write(
					JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
				);
			} catch {
				this.fail(new TransportError("transport_write_failed", "unknown"));
			}
		});
	}
	async initialize() {
		const result = await this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "gjc-fleet", version: "0.1.0" },
		});
		(this.child.stdin as any).write(
			JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
				"\n",
		);
		return result;
	}
	async tools(): Promise<any[]> {
		const list = await this.request("tools/list", {});
		if (!Array.isArray(list.tools))
			throw new TransportError("invalid_tools", "unknown");
		return list.tools;
	}
	async call(name: string, args: Record<string, unknown>): Promise<any> {
		const r = await this.request("tools/call", { name, arguments: args }, OBSERVATION_TOOLS.has(name) ? this.observationTimeoutMs : this.timeoutMs);
		let value = r.structuredContent;
		if (value === undefined) {
			const chunks = r.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text);
			if (!chunks?.length)
				throw new TransportError("missing_tool_content", "unknown");
			try {
				value = JSON.parse(chunks.join("\n"));
			} catch {
				throw new TransportError("non_json_tool_content", "unknown");
			}
		}
		if (r.isError) {
			const reason = value?.error?.code ?? value?.reason;
			const code =
				typeof reason === "string" && /^[a-zA-Z0-9_:.-]{1,128}$/.test(reason)
					? "tool_refused:" + reason
					: "tool_refused";
			throw new TransportError(code, "unknown", code, value);
		}
		return value;
	}
	close() {
		this.fail(new TransportError("transport_closed", "unknown"));
	}
}
