import { spawnTrusted } from "./spawn";
/**
 * Discovery-only ordinary asks through the PUBLIC, Broker-bound CLI.
 * A retained action is evidence for display, not proof of a current owned ask.
 * No operation in this module can answer an ask or approve a workflow.
 */
export interface OrdinaryTransport {
	command: string;
	/** Trusted argv prefix, e.g. a node-local CLI or an authenticated SSH wrapper. */
	args: string[];
}
export interface OrdinaryBinding {
	sessionId: string;
	coordinatorTurnId: string;
	runtimeTurnId: string;
}
export const ordinaryContractEvidence = [
	{
		path: "packages/coding-agent/src/sdk/router/session-router.ts",
		lines: "100-115,223-233,535-577,958-1040",
		fact: "Managed public SessionRouter provides current attachment/generation dispatch checks and optional commandId/turnId correlation. Optional consumer fields do not prove the real action producer supplies them.",
	},
	{
		path: "crates/pi-natives/src/sdk.rs",
		lines: "483-493,1276-1286",
		fact: "Ordinary registerAsk parses a typed ActionNeeded and registers it without injecting original runtime command/turn correlation.",
	},
	{
		path: "crates/gjc-sdk/src/protocol.rs",
		lines: "120-156",
		fact: "Typed ordinary ActionNeeded has no commandId/turnId; optional Router consumer fields cannot recover identities the producer omits.",
	},
	{
		path: "crates/gjc-sdk/src/server.rs",
		lines: "895-905,2382-2461,2610-2667",
		fact: "Native ordinary emission is direct action_needed, not a correlated event envelope. Reply claims fence delivered action identity and connection generation once; this is not original-runtime-turn ownership or a public durable answer-result lookup.",
	},
	{
		path: "docs/sdk-session-cli.md",
		lines: "49-77,234-277",
		fact: "Broker/Router authority; --attach-only; tail --all-events --strict is retained observation, not a current-action query.",
	},
	{
		path: "docs/sdk.md",
		lines: "185-215,426-450,850-864",
		fact: "Opaque action IDs are transient; workflow correlation is distinct; prompt runtime turn receipts and Coordinator workflow ownership do not establish ordinary action ownership.",
	},
	{
		path: "packages/coding-agent/src/sdk/cli/rows.ts",
		lines: "22-88,287-320",
		fact: "Tail v2: {ok:true,result:{version:2,source,session,checkpoint?,gap?,items}}; items have kind, revision/generation/seq, payload. Session identity includes endpointGeneration and optional hostIncarnation.",
	},
	{
		path: "packages/coding-agent/src/sdk/cli/session-cli.ts",
		lines: "480-505,2080-2108,2203-2219,2252-2288",
		fact: "--json-input-stdin supplies JSON without argv; tail internally uses Router event_replay; raw control/query are Broker-bound. event_replay is not a public raw observer query.",
	},
	{
		path: "packages/coding-agent/src/sdk/protocol/operation-registry.ts",
		lines: "83-85,153-192,378-393",
		fact: "ask.answer is an ordered control, not an idempotent mutation. Public queries contain no current ordinary-action/owned-runtime-turn observer query.",
	},
] as const;
const limitation =
	"Retained candidates are not answer authority in this inspected CLI tuple. Managed Router alternatives exist, but the inspected native ordinary producer does not supply original command/turn correlation. This does not establish universal SDK absence. No answer or workflow approval was performed.";
const requiredContract =
	"A version-paired Broker/Router public current ordinary-action observation with authoritative original-runtime ownership and current native attachment/host fencing, continuity for replayed evidence, an atomic original-turn conditional answer fence and documented acknowledgement reconciliation.";
export interface OrdinaryCandidate {
	id: string;
	question: string;
	options: string[];
	recommendedIndex?: number;
	revision: number;
	generation: number;
	seq: number;
}
export interface OrdinaryObservation {
	hostIncarnation: string;
	endpointGeneration: number;
	checkpoint: { revision: number; generation: number; seq: number };
}
export interface OrdinaryDiscovery {
	status: "discovery_only" | "refused" | "unknown";
	reason: string;
	binding: OrdinaryBinding;
	bindingVerified: false;
	answerSupported: false;
	workflowApproval: false;
	candidates: OrdinaryCandidate[];
	observation?: OrdinaryObservation;
	limitation: string;
	requiredContract: string;
	evidence: typeof ordinaryContractEvidence;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 16384 &&
		!value.includes("\0")
	);
}
function coordinate(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function validBinding(binding: OrdinaryBinding): boolean {
	return (
		record(binding) &&
		[binding.sessionId, binding.coordinatorTurnId, binding.runtimeTurnId].every(
			(value) =>
				text(value) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value),
		)
	);
}
function result(
	binding: OrdinaryBinding,
	status: OrdinaryDiscovery["status"],
	reason: string,
	candidates: OrdinaryCandidate[] = [],
	observation?: OrdinaryObservation,
): OrdinaryDiscovery {
	return {
		status,
		reason,
		binding: { ...binding },
		bindingVerified: false,
		answerSupported: false,
		workflowApproval: false,
		candidates,
		...(observation ? { observation } : {}),
		limitation,
		requiredContract,
		evidence: ordinaryContractEvidence,
	};
}

/** One bounded, shell-free observation. Never retries, never infers Coordinator transport. */
async function observe(
	transport: OrdinaryTransport,
	sessionId: string,
): Promise<unknown> {
	if (
		!record(transport) ||
		!text(transport.command) ||
		!Array.isArray(transport.args) ||
		transport.args.length > 128 ||
		!transport.args.every(
			(arg) =>
				typeof arg === "string" && !arg.includes("\0") && arg.length <= 16384,
		)
	)
		throw new Error("invalid_transport");
	const child = spawnTrusted(
		[
			transport.command,
			...transport.args,
			"sdk",
			"session",
			"tail",
			sessionId,
			"--all-events",
			"--strict",
			"--timeout-ms",
			"1000",
			"--attach-only",
			"--json",
		],
		{
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" },
		},
	);
	child.stdin.end();
	let timer: ReturnType<typeof setTimeout>;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("observation_timeout"));
		}, 5000);
	});
	async function bounded(
		stream: ReadableStream<Uint8Array>,
		limit: number,
	): Promise<string> {
		const reader = stream.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > limit) {
				child.kill("SIGKILL");
				throw new Error("output_limit");
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	try {
		const [stdout, , exit] = await Promise.race([
			Promise.all([
				bounded(child.stdout, 1024 * 1024),
				bounded(child.stderr, 65536),
				child.exited,
			]),
			deadline,
		]);
		const envelope: unknown = JSON.parse(stdout);
		if (exit !== 0) {
			// Only one fixed public code is needed; do not leak subprocess output.
			if (
				record(envelope) &&
				record(envelope.error) &&
				envelope.error.code === "retention_gap"
			)
				throw new Error("retention_gap");
			throw new Error("observation_failed");
		}
		return envelope;
	} finally {
		clearTimeout(timer!);
		child.kill("SIGKILL");
	}
}

export async function discoverOrdinary(
	transport: OrdinaryTransport,
	binding: OrdinaryBinding,
): Promise<OrdinaryDiscovery> {
	if (!validBinding(binding))
		return result(binding, "refused", "invalid_binding");
	let envelope: unknown;
	try {
		envelope = await observe(transport, binding.sessionId);
	} catch (error) {
		const reason =
			error instanceof Error ? error.message : "observation_failed";
		return result(
			binding,
			reason === "retention_gap" || reason === "invalid_transport"
				? "refused"
				: "unknown",
			[
				"retention_gap",
				"invalid_transport",
				"output_limit",
				"observation_timeout",
			].includes(reason)
				? reason
				: "observation_failed",
		);
	}
	if (!record(envelope) || envelope.ok !== true || !record(envelope.result))
		return result(binding, "refused", "invalid_envelope");
	const body = envelope.result;
	if (
		body.version !== 2 ||
		body.source !== "session" ||
		!record(body.session) ||
		!Array.isArray(body.items)
	)
		return result(binding, "refused", "unsupported_envelope");
	const session = body.session;
	if (session.sessionId !== binding.sessionId)
		return result(binding, "refused", "session_mismatch");
	if (
		session.live !== true ||
		session.deleted !== false ||
		session.terminalUncertain === true ||
		session.ambiguous === true ||
		body.terminal === true
	)
		return result(binding, "refused", "session_not_current");
	if (!text(session.hostIncarnation) || !coordinate(session.endpointGeneration))
		return result(binding, "refused", "host_identity_unavailable");
	if (body.gap !== undefined)
		return result(binding, "refused", "retention_gap");
	const checkpoint = body.checkpoint;
	if (
		!record(checkpoint) ||
		!coordinate(checkpoint.revision) ||
		!coordinate(checkpoint.generation) ||
		!coordinate(checkpoint.seq)
	)
		return result(binding, "refused", "checkpoint_unavailable");
	const observation: OrdinaryObservation = {
		hostIncarnation: session.hostIncarnation,
		endpointGeneration: session.endpointGeneration,
		checkpoint: {
			revision: checkpoint.revision,
			generation: checkpoint.generation,
			seq: checkpoint.seq,
		},
	};
	const candidates: OrdinaryCandidate[] = [];
	const retired = new Set<string>();
	for (const item of body.items) {
		if (!record(item) || typeof item.kind !== "string")
			return result(binding, "refused", "invalid_item");
		if (item.kind !== "action_needed" && item.kind !== "action_resolved")
			continue;
		if (
			!coordinate(item.revision) ||
			!coordinate(item.generation) ||
			!coordinate(item.seq) ||
			!record(item.payload)
		)
			return result(binding, "refused", "action_position_unavailable");
		const action = item.payload;
		if (!text(action.id)) return result(binding, "refused", "invalid_action");
		if (item.kind === "action_resolved") {
			retired.add(action.id);
			continue;
		}
		if (action.sessionId !== binding.sessionId)
			return result(binding, "refused", "action_session_mismatch");
		if (action.kind === "idle") continue;
		if (
			action.kind !== "ask" ||
			"workflowGateId" in action ||
			"questions" in action ||
			"multi" in action
		)
			return result(binding, "refused", "workflow_or_question_kind_ambiguous");
		if (
			!text(action.question) ||
			!Array.isArray(action.options) ||
			action.options.length < 1 ||
			action.options.length > 64 ||
			!action.options.every(text)
		)
			return result(binding, "refused", "invalid_action");
		if (
			item.revision !== checkpoint.revision ||
			item.generation !== checkpoint.generation
		)
			return result(binding, "refused", "stale_revision_or_generation");
		if (candidates.some((candidate) => candidate.id === action.id))
			return result(binding, "refused", "duplicate_action_ambiguous");
		candidates.push({
			id: action.id,
			question: action.question,
			options: [...action.options],
			revision: item.revision,
			generation: item.generation,
			seq: item.seq,
			...(Number.isInteger(action.recommendedIndex) &&
			(action.recommendedIndex as number) >= 0 &&
			(action.recommendedIndex as number) < action.options.length
				? { recommendedIndex: action.recommendedIndex as number }
				: {}),
		});
	}
	const remaining = candidates.filter(
		(candidate) => !retired.has(candidate.id),
	);
	if (remaining.length > 1)
		return result(binding, "refused", "multiple_actions_ambiguous");
	return result(
		binding,
		"discovery_only",
		remaining.length
			? "ordinary_runtime_turn_binding_unsupported"
			: "no_retained_ordinary_candidate",
		remaining,
		observation,
	);
}

/** Re-observe for stale display detection, but NEVER dispatch ask.answer. */
export async function answerOrdinary(
	transport: OrdinaryTransport,
	binding: OrdinaryBinding,
	currentAction: {
		candidate: OrdinaryCandidate;
		observation: OrdinaryObservation;
	},
	_answer: unknown,
): Promise<OrdinaryDiscovery> {
	const latest = await discoverOrdinary(transport, binding);
	if (latest.status !== "discovery_only") return latest;
	if (
		!record(currentAction) ||
		JSON.stringify(latest.observation) !==
			JSON.stringify(currentAction.observation) ||
		latest.candidates.length !== 1 ||
		JSON.stringify(latest.candidates[0]) !==
			JSON.stringify(currentAction.candidate)
	)
		return { ...latest, status: "refused", reason: "stale_action_or_host" };
	return {
		...latest,
		status: "refused",
		reason: "ordinary_runtime_turn_binding_unsupported",
	};
}
