import { randomUUID } from "node:crypto";
import { canonicalJson as canonical, digest } from "./core";
import {
	SDK_UI_APPROVAL_CONTRACT,
	type ApprovalAnswerDispatch,
	type ApprovalDiscovery,
	type ApprovalSessionContext,
	type NativeWorkflowQuestion,
	type TaskApprovalBackend,
	type TaskApprovalChannel,
} from "./approval";

type Json = ApprovalDiscovery["evidence"];
type RecordValue = Record<string, unknown>;

/** Structural public Router surface; the application owns the SDK import. */
export interface SdkUiAttachment {
	readonly sessionId: string;
	readonly generation: number;
	readonly connectionId?: string;
	readonly authorityId?: string;
	isCurrent(): boolean;
	send(frame: RecordValue): void | Promise<void>;
	sendMaintenance(leaseId: string): void | Promise<void>;
}
export interface SdkUiDispatchContext {
	frame: RecordValue;
	connectionId: string | undefined;
	generation: number;
}
export interface SdkUiRouter {
	start(): Promise<void>;
	stop(): Promise<void>;
	attachment(sessionId: string): SdkUiAttachment | undefined;
	request(sessionId: string, frame: RecordValue, generation: number, attachment: SdkUiAttachment, options: {
		timeoutMs: number;
		beforeDispatch(context: SdkUiDispatchContext): void;
		onDispatch(context: SdkUiDispatchContext): void;
	}): Promise<RecordValue>;
}
export interface SdkUiRouterOptions {
	agentDir: string;
	sessionIds: string[];
	attachFilter(sessionId: string): boolean;
	observer: true;
	turnStream: true;
	deps: { onFrame(attachment: SdkUiAttachment, frame: { body: RecordValue; [key: string]: unknown }): void };
}
export interface SdkUiApprovalOptions {
	agentDir: string;
	maxDurationMs: number;
	routerFactory(options: SdkUiRouterOptions): SdkUiRouter;
}

function object(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function snapshot(value: unknown): Json {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > 256 * 1024) throw new Error("Critical UI evidence exceeds bound.");
	return freeze(JSON.parse(encoded) as Json);
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function expiry(value: unknown): number {
	return typeof value === "string" ? Date.parse(value) : NaN;
}

export class SdkUiApprovalBackend implements TaskApprovalBackend {
	readonly contract = SDK_UI_APPROVAL_CONTRACT;
	readonly #options: SdkUiApprovalOptions;
	readonly #cleanupFailures: unknown[] = [];
	/** Bounded instance diagnostics; never replaces a primary native error. */
	get cleanupFailures(): readonly unknown[] { return [...this.#cleanupFailures]; }
	constructor(options: SdkUiApprovalOptions) {
		if (!options.agentDir || typeof options.routerFactory !== "function" ||
			!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs <= 0 || options.maxDurationMs > 300000) {
			throw new Error("Explicit Router factory, agentDir and finite duration (1..300000 ms) required.");
		}
		this.#options = { ...options };
	}
	async attach(context: Readonly<ApprovalSessionContext>, operationKey: string): Promise<TaskApprovalChannel> {
		if (!operationKey || context.contract !== this.contract || context.sessionId !== context.sessionAuthority.sessionId ||
			context.workspacePath !== context.sessionAuthority.cwd || !Number.isSafeInteger(context.sessionAuthority.endpointGeneration) ||
			context.sessionAuthority.endpointGeneration <= 0 || !/^[0-9a-f]{64}$/i.test(context.sessionAuthority.endpointIncarnation)) {
			throw new Error("Original session authority is required before prompt.");
		}
		const channel = new SdkUiChannel(context, this.#options, operationKey, error => {
			if (this.#cleanupFailures.includes(error)) return;
			if (this.#cleanupFailures.length >= 32) this.#cleanupFailures.shift();
			this.#cleanupFailures.push(error);
		});
		await channel.start();
		return channel;
	}
}

type Producer = { toolCallId: string; question: RecordValue; evidence: Json };
type Waiter = { raw: Json; form: Json; question?: NativeWorkflowQuestion; invalid: boolean; sent?: Json; cancel?: Json };

class SdkUiChannel implements TaskApprovalChannel {
	readonly context: Readonly<ApprovalSessionContext>;
	readonly #options: SdkUiApprovalOptions;
	readonly #operationKey: string;
	readonly #onCleanupFailure: (error: unknown) => void;
	#receipt: Json = null;
	get receipt(): Json { return this.#receipt; }
	#router?: SdkUiRouter;
	#attachment?: SdkUiAttachment;
	#identity?: { sessionId: string; generation: number; connectionId: string; authorityId: string };
	#leaseId?: string;
	#leaseState: Json = null;
	#expiresAt = 0;
	#deadline = 0;
	#confirmed = false;
	#closed = false;
	#reason?: string;
	#turnId?: string;
	#producer?: Producer;
	readonly #waiters = new Map<string, Waiter>();
	readonly #consumed: ApprovalDiscovery["consumed"] = [];
	readonly #keys = new Set<string>();
	readonly #failures: unknown[] = [];
	#count = 0;
	#bytes = 0;
	#lastSeq?: number;
	#renewTimer?: ReturnType<typeof setTimeout>;
	#deadlineTimer?: ReturnType<typeof setTimeout>;
	#confirmTimer?: ReturnType<typeof setTimeout>;
	#confirm?: { resolve(): void; reject(error: Error): void };
	#cleanup?: Promise<void>;

	constructor(context: Readonly<ApprovalSessionContext>, options: SdkUiApprovalOptions, operationKey: string, onCleanupFailure: (error: unknown) => void) {
		this.context = snapshot(context) as unknown as Readonly<ApprovalSessionContext>;
		this.#options = options;
		this.#operationKey = operationKey;
		this.#onCleanupFailure = onCleanupFailure;
	}
	async start(): Promise<void> {
		try {
			const router = this.#options.routerFactory({
				agentDir: this.#options.agentDir, sessionIds: [this.context.sessionId],
				attachFilter: id => id === this.context.sessionId, observer: true, turnStream: true,
				deps: { onFrame: (attachment, frame) => this.#receive(attachment, frame) },
			});
			this.#router = router;
			await router.start();
			const a = router.attachment(this.context.sessionId);
			if (!a?.isCurrent() || a.sessionId !== this.context.sessionId ||
				a.generation !== this.context.sessionAuthority.endpointGeneration || !nonempty(a.connectionId) || !nonempty(a.authorityId)) {
				throw new Error("Original public attachment capability identity is unavailable.");
			}
			this.#attachment = a;
			this.#identity = { sessionId: a.sessionId, generation: a.generation, connectionId: a.connectionId, authorityId: a.authorityId };
			const registration = { type: "register_provider", id: randomUUID(), connectionId: a.connectionId,
				capability: "ui", definitions: [], idempotencyKey: this.#operationKey };
			let before: Json | undefined;
			let sent: Json | undefined;
			let invalid = false;
			const capture = (c: SdkUiDispatchContext): Json => {
				const f = c.frame;
				if (!this.#current() || !nonempty(f.id) || c.connectionId !== this.#identity!.connectionId || f.connectionId !== c.connectionId ||
					f.type !== "register_provider" || f.capability !== "ui" || f.idempotencyKey !== registration.idempotencyKey ||
					!Array.isArray(f.definitions) || f.definitions.length !== 0 || !Number.isSafeInteger(c.generation) || c.generation <= 0) {
					throw new Error("UI registration wire dispatch mismatch.");
				}
				return snapshot({ wireId: f.id, connectionId: c.connectionId, generation: c.generation });
			};
			const ack = await router.request(this.context.sessionId, registration, a.generation, a, {
				timeoutMs: 5000,
				beforeDispatch: c => { if (before) throw new Error("Repeated registration dispatch."); before = capture(c); },
				onDispatch: c => {
					invalid = true;
					const actual = capture(c);
					if (!before || sent || canonical(before) !== canonical(actual)) return;
					sent = actual;
					invalid = false;
				},
			});
			// The correlated ACK owns this lease even when secondary validation fails.
			if (ack.type !== "register_provider_result" || !nonempty(ack.leaseId)) throw new Error("No original UI registration lease ACK.");
			this.#leaseId = ack.leaseId;
			if (this.#reason || invalid || !before || !sent || ack.id !== object(sent)?.wireId ||
				!Array.isArray(ack.registeredNames) || ack.registeredNames.length !== 0 || !(expiry(ack.leaseExpiresAt) > Date.now())) {
				throw new Error("Original UI registration ACK mismatch.");
			}
			this.#expiresAt = expiry(ack.leaseExpiresAt);
			this.#deadline = Date.now() + this.#options.maxDurationMs;
			await this.#renew();
			if (!this.#usable()) throw new Error("Original UI lease expired during initial maintenance.");
			this.#receipt = snapshot({ contract: SDK_UI_APPROVAL_CONTRACT, sessionId: this.context.sessionId,
				endpointGeneration: this.#identity.generation, attachmentAuthorityId: this.#identity.authorityId,
				connectionId: this.#identity.connectionId, leaseId: this.#leaseId, wireId: ack.id,
				beforeDispatch: before, onDispatch: sent, leaseState: this.#leaseState,
				leaseExpiresAt: new Date(this.#expiresAt).toISOString(), leaseStateConfirmed: true });
			this.#deadlineTimer = setTimeout(() => this.#block("finite_deadline"), Math.max(0, this.#deadline - Date.now()));
			this.#schedule();
		} catch (primary) {
			try { await this.#clean(); }
			catch (cleanup) { throw new AggregateError([primary, cleanup], "UI registration and cleanup failed.", { cause: primary }); }
			throw primary;
		}
	}
	bindTurn(turnId: string): void {
		if (!turnId || (this.#turnId && this.#turnId !== turnId)) throw new Error("Original Coordinator turn binding is immutable.");
		this.#turnId = turnId;
	}
	#current(): boolean {
		const a = this.#attachment, i = this.#identity;
		return !!a && !!i && a.isCurrent() && a.sessionId === i.sessionId && a.generation === i.generation &&
			a.connectionId === i.connectionId && a.authorityId === i.authorityId;
	}
	#eligible(): boolean {
		if (!this.#closed && !this.#reason && (!this.#current() || !this.#confirmed ||
			Date.now() >= this.#expiresAt || Date.now() >= this.#deadline)) this.#block("original_lease_unavailable");
		return this.#usable();
	}
	#usable(): boolean {
		return !this.#closed && !this.#reason && this.#confirmed && this.#current() &&
			Date.now() < this.#expiresAt && Date.now() < this.#deadline;
	}
	#block(code: string, error?: unknown): void {
		this.#reason ??= code;
		this.#confirmed = false;
		if (error !== undefined) this.#failures.push(error);
		this.#confirm?.reject(new Error(code));
		// Before the correlated ACK, start() must first retain any returned lease.
		if (this.#leaseId) void this.#clean().catch(() => {});
	}
	async #renew(): Promise<void> {
		if (!this.#current() || this.#closed || this.#reason || !this.#leaseId || Date.now() >= this.#deadline || Date.now() >= this.#expiresAt) {
			throw new Error("Original UI lease is not renewable.");
		}
		const confirmation = new Promise<void>((resolve, reject) => {
			this.#confirm = { resolve, reject };
			this.#confirmTimer = setTimeout(() => reject(new Error("Missing exact UI lease_state.")), 5000);
		});
		try { await Promise.all([Promise.resolve().then(() => this.#attachment!.sendMaintenance(this.#leaseId!)), confirmation]); }
		finally { clearTimeout(this.#confirmTimer); this.#confirm = undefined; }
	}
	#schedule(): void {
		this.#renewTimer = setTimeout(() => {
			void this.#renew().then(() => { if (!this.#closed) this.#schedule(); }, error => {
				if (!this.#closed) this.#block("maintenance_failed", error);
			});
		}, Math.min(5000, Math.max(1, this.#expiresAt - Date.now())));
	}
	#retain(raw: unknown): Json {
		const retained = snapshot(raw);
		const size = Buffer.byteLength(JSON.stringify(retained));
		if (++this.#count > 512 || (this.#bytes += size) > 2 * 1024 * 1024) throw new Error("Critical UI evidence overflow.");
		return retained;
	}
	#receive(a: SdkUiAttachment, frame: { body: RecordValue; [key: string]: unknown }): void {
		if (!this.#attachment || this.#closed) return;
		try {
			if (a !== this.#attachment || !this.#current()) { this.#block("attachment_mismatch"); return; }
			if (frame.seq !== undefined) {
				if (!Number.isSafeInteger(frame.seq) || (this.#lastSeq !== undefined && frame.seq !== this.#lastSeq + 1)) {
					this.#block("native_event_gap"); return;
				}
				this.#lastSeq = frame.seq as number;
			}
			const raw = frame.body;
			if (raw.type === "lease_state") {
				if (!this.#leaseId) return;
				if (raw.connectionId !== this.#identity!.connectionId || raw.leaseId !== this.#leaseId ||
					raw.capability !== "ui" || raw.active !== true || !(expiry(raw.leaseExpiresAt) > Date.now()) ||
					Date.now() >= this.#expiresAt || Date.now() >= this.#deadline) {
					this.#block("lease_state_mismatch"); return;
				}
				this.#expiresAt = expiry(raw.leaseExpiresAt);
				this.#leaseState = snapshot({ type: "lease_state", connectionId: raw.connectionId, capability: "ui",
					leaseId: raw.leaseId, active: true, leaseExpiresAt: raw.leaseExpiresAt });
				this.#confirmed = true;
				this.#confirm?.resolve();
				return;
			}
			if (!this.#eligible()) return;
			if (raw.type === "reverse_request" || raw.type === "reverse_cancel") {
				if (raw.type === "reverse_cancel") {
					if (raw.connectionId !== this.#identity!.connectionId || raw.leaseId !== this.#leaseId || !nonempty(raw.id)) return;
					const waiter = this.#waiters.get(raw.id);
					if (waiter && !waiter.cancel) { waiter.cancel = this.#retain(raw); waiter.invalid = true; }
					return;
				}
				if (raw.connectionId !== this.#identity!.connectionId || raw.leaseId !== this.#leaseId || !nonempty(raw.id)) {
					this.#block("waiter_authority_mismatch"); return;
				}
				const old = this.#waiters.get(raw.id);
				if (old) { if (canonical(old.raw) !== canonical(raw)) this.#block("immutable_waiter_mismatch"); return; }
				if (raw.capability !== "ui" || this.#waiters.size >= 64) { this.#block("unsupported_waiter"); return; }
				const envelope = object(raw.payload), form = object(envelope?.payload);
				if (envelope?.method !== "ui.elicit" || form?.mode !== "form") { this.#block("unsupported_ui_mode"); return; }
				this.#waiters.set(raw.id, { raw: this.#retain(raw), form: snapshot(form), invalid: false });
				this.#link();
				return;
			}
			const event = object(raw.event);
			if (!event || raw.event_type !== event.type) return;
			if (event.type === "tool_execution_start" && event.toolName === "ask") {
				this.#observeAsk(event.toolCallId, event.args, raw);
			} else if (event.type === "message_end") {
				const message = object(event.message);
				if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
				for (const content of message.content) {
					const tool = object(content);
					if (tool?.type === "toolCall" && tool.name === "ask") this.#observeAsk(tool.id, tool.arguments, raw);
				}
			} else if (event.type === "tool_execution_end" && event.toolName === "ask") {
				if (!this.#producer || event.toolCallId !== this.#producer.toolCallId) return;
				const completion = this.#retain(raw);
				for (const waiter of this.#waiters.values()) {
					if (!waiter.invalid && waiter.question?.workflow.toolCallId === event.toolCallId) {
						if (waiter.sent && event.isError === false && Object.hasOwn(event, "result")) {
							this.#consumed.push(freeze({ questionId: waiter.question.questionId, authority: waiter.question.authority,
								toolCallId: this.#producer.toolCallId, evidence: snapshot({ selectedResponse: waiter.sent, completion }) }));
						}
						waiter.invalid = true;
					}
				}
				this.#producer = undefined;
			}
		} catch (error) { this.#block("critical_evidence_invalid_or_overflow", error); }
	}
	#observeAsk(id: unknown, args: unknown, raw: RecordValue): void {
		if (!nonempty(id)) { this.#block("missing_native_tool_id"); return; }
		const questions = object(args)?.questions;
		if (!Array.isArray(questions) || questions.length !== 1) { this.#block("unsupported_native_ask"); return; }
		const q = object(questions[0]), gate = object(q?.workflowGate);
		if (!q || !nonempty(q.id) || !nonempty(q.question) || gate?.stage !== "ralplan" || gate.kind !== "approval" ||
			!Array.isArray(q.options) || q.options.length === 0 || q.options.some(option => !nonempty(object(option)?.label))) {
			this.#block("unsupported_native_workflow"); return;
		}
		if (this.#producer) {
			if (this.#producer.toolCallId !== id || canonical(this.#producer.question) !== canonical(q)) this.#block("ambiguous_native_ask");
			return;
		}
		this.#producer = { toolCallId: id, question: snapshot(q) as RecordValue, evidence: this.#retain(raw) };
		this.#link();
	}
	#link(): void {
		if (!this.#producer || this.#reason) return;
		const active = [...this.#waiters.entries()].filter(([, waiter]) => !waiter.invalid);
		if (active.length > 1) { this.#block("multiple_native_waiters"); return; }
		for (const [id, waiter] of active) {
			if (waiter.question) continue;
			const form = object(waiter.form)!, q = this.#producer.question;
			const schema = object(form.requestedSchema), value = object(object(schema?.properties)?.value);
			const offered = value?.oneOf, options = q.options as RecordValue[];
			if (form.message !== q.question || schema?.type !== "object" || value?.type !== "string" ||
				!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "value" || !Array.isArray(offered) ||
				(offered.length !== options.length && offered.length !== options.length + 1) ||
				options.some((option, i) => object(offered[i])?.const !== `option:${i}` || object(offered[i])?.title !== option.label) ||
				(offered.length > options.length && (object(offered[options.length])?.const !== `option:${options.length}` ||
					object(offered[options.length])?.title !== "Other (type your own)"))) {
				this.#block("native_form_mismatch"); return;
			}
			const authority = { kind: "sdk_ui_waiter" as const, requestId: id, connectionId: this.#identity!.connectionId,
				leaseId: this.#leaseId!, attachmentAuthorityId: this.#identity!.authorityId, endpointGeneration: this.#identity!.generation };
			const workflow = { stage: "ralplan" as const, kind: "approval" as const, toolCallId: this.#producer.toolCallId,
				questionId: q.id as string, evidence: snapshot({ native: this.#producer.evidence, request: waiter.raw }) };
			const questionId = q.id as string;
			// Local CAS only: neither this digest nor the operation key is a native gate/idempotency field.
			const answerBinding = digest({ context: this.context, authority, form: waiter.form, workflow, questionId });
			waiter.question = freeze({ questionId, authority, form: waiter.form, workflow, answerBinding, status: "pending" });
		}
	}
	async discover(): Promise<ApprovalDiscovery> {
		const eligible = this.#eligible();
		const questions = eligible ? [...this.#waiters.values()].filter(w => !w.invalid && w.question).map(w => w.question!) : [];
		const unlinked = [...this.#waiters.values()].some(w => !w.invalid && !w.question);
		const hasEvidence = questions.length > 0 || this.#consumed.length > 0;
		return freeze({ contract: SDK_UI_APPROVAL_CONTRACT, sessionId: this.context.sessionId,
			complete: eligible && !!this.#turnId && !unlinked && hasEvidence, questions, consumed: [...this.#consumed],
			evidence: { source: "public_router_native_waiter", reason: this.#reason ?? (unlinked ? "missing_native_producer" : !this.#turnId ? "unbound_turn" : !hasEvidence ? "empty_native_evidence" : "covered"),
				criticalRecords: this.#count, criticalBytes: this.#bytes, leaseState: this.#leaseState,
				nativeSuccessAck: false, remoteSessionRetired: false } });
	}
	validateAnswer(question: NativeWorkflowQuestion, answer: Json): void {
		if (!this.#usable() || !this.#turnId) throw new Error("Original UI channel is incomplete.");
		const waiter = this.#waiters.get(question.authority.requestId);
		if (!waiter?.question || waiter.invalid || waiter.sent || canonical(waiter.question) !== canonical(question)) throw new Error("Stale or already used native waiter.");
		const response = object(answer), content = object(response?.content);
		const options = this.#producer?.question.options;
		if (!response || Object.keys(response).sort().join(",") !== "action,content" || response.action !== "accept" ||
			!content || Object.keys(content).join(",") !== "value" || !Array.isArray(options) ||
			!options.some((_, index) => content.value === `option:${index}`)) throw new Error("Only an original offered native option may be accepted.");
	}
	async answer(question: NativeWorkflowQuestion, answer: Json, operationKey: string): Promise<ApprovalAnswerDispatch> {
		this.validateAnswer(question, answer);
		if (!operationKey || this.#keys.has(operationKey)) throw new Error("Local answer operation already used.");
		const waiter = this.#waiters.get(question.authority.requestId)!;
		this.#keys.add(operationKey);
		waiter.sent = snapshot(answer);
		waiter.question = freeze({ ...waiter.question!, status: "sent_unconfirmed" });
		try {
			await this.#attachment!.send({ type: "reverse_response", id: question.authority.requestId,
				connectionId: question.authority.connectionId, leaseId: question.authority.leaseId, ok: true, result: waiter.sent });
		} catch (error) { this.#block("response_send_failed", error); throw error; }
		return freeze({ contract: SDK_UI_APPROVAL_CONTRACT, questionId: question.questionId, authority: question.authority,
			delivery: "sent_unconfirmed", consumption: "unproven" });
	}
	#clean(): Promise<void> {
		if (!this.#cleanup) this.#cleanup = this.#cleanOnce();
		return this.#cleanup;
	}
	async #cleanOnce(): Promise<void> {
		this.#closed = true;
		this.#confirmed = false;
		clearTimeout(this.#renewTimer);
		clearTimeout(this.#deadlineTimer);
		clearTimeout(this.#confirmTimer);
		this.#confirm?.reject(new Error("UI channel closed during maintenance."));
		const errors: unknown[] = [];
		try {
			if (this.#leaseId && this.#attachment) {
				if (!this.#current()) throw new Error("Original attachment stale; replacement release forbidden.");
				await this.#attachment.send({ type: "lease_release", connectionId: this.#identity!.connectionId, leaseId: this.#leaseId });
			}
		} catch (error) { errors.push(error); }
		finally { try { await this.#router?.stop(); } catch (error) { errors.push(error); } }
		for (const error of errors) this.#onCleanupFailure(error);
		if (errors.length > 1) throw new AggregateError(errors, "UI lease release and Router stop failed.", { cause: errors[0] });
		if (errors.length) throw errors[0];
	}
	async close(): Promise<void> {
		const errors = [...this.#failures];
		try { await this.#clean(); } catch (error) { errors.push(error); }
		if (errors.length > 1) throw new AggregateError(errors, "UI channel and cleanup failed.", { cause: errors[0] });
		if (errors.length) throw errors[0];
	}
}
