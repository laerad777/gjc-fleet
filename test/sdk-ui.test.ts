import { describe, expect, test } from "bun:test";
import type { ApprovalSessionContext, TaskApprovalChannel } from "../src/approval";
import {
	SdkUiApprovalBackend,
	type SdkUiAttachment,
	type SdkUiRouter,
	type SdkUiRouterOptions,
} from "../src/index";

// Controlled structural doubles only: these tests do not execute the SDK/native library.
const context: ApprovalSessionContext = {
	contract: "sdk-ui-waiter-v1", taskId: "task", attemptId: "attempt", nodeId: "node", inputDigest: "input",
	sessionId: "fresh-fixture", workspacePath: "/fixture", createOperationId: "create",
	sessionAuthority: { sessionId: "fresh-fixture", cwd: "/fixture", endpointGeneration: 7, endpointIncarnation: "a".repeat(64) },
};
const labels = ["Refine further", "Approve execution via ultragoal", "Stop here"];
const question = {
	id: "native_execution_approval", question: "Approve this original plan?",
	options: labels.map(label => ({ label })), workflowGate: { stage: "ralplan", kind: "approval" },
};
const response = { action: "accept", content: { value: "option:1" } };
function message(q: unknown = question, id = "source-ask") {
	return { event_type: "message_end", event: { type: "message_end", message: { role: "assistant", content: [
		{ type: "toolCall", id, name: "ask", arguments: { questions: [q] } },
	] } } };
}
function form() {
	return { mode: "form", message: question.question, requestedSchema: { type: "object", required: ["value"], properties: { value: { type: "string", oneOf: [
		...labels.map((title, i) => ({ const: `option:${i}`, title })),
		{ const: "option:3", title: "Other (type your own)" },
	] } } } };
}
function request(id = "waiter", value: unknown = form()) {
	return { type: "reverse_request", id, connectionId: "connection", leaseId: "lease", capability: "ui",
		payload: { method: "ui.elicit", payload: value } };
}
function completion(id = "source-ask", isError = false) {
	return { event_type: "tool_execution_end", event: { type: "tool_execution_end", toolName: "ask", toolCallId: id,
		result: { action: "accept", content: { value: "option:1" } }, isError } };
}
class RouterDouble implements SdkUiRouter {
	options!: SdkUiRouterOptions;
	frames: Record<string, unknown>[] = [];
	registrations: Record<string, unknown>[] = [];
	started = 0;
	stopped = 0;
	current = true;
	ackId = "actual-wire-id";
	ackNames: string[] = [];
	ackExpiry = new Date(Date.now() + 60000).toISOString();
	maintenanceLease = "lease";
	maintenanceActive = true;
	omitSent = false;
	dispatchWireId = "actual-wire-id";
	sentWireId?: string;
	stopError?: Error;
	releaseError?: Error;
	sendError?: Error;
	attachmentValue: SdkUiAttachment = {
		sessionId: context.sessionId, generation: 7, connectionId: "connection", authorityId: "firsthand-public-capability",
		isCurrent: () => this.current,
		send: async frame => {
			this.frames.push(frame);
			if (frame.type === "lease_release" && this.releaseError) throw this.releaseError;
			if (frame.type === "reverse_response" && this.sendError) throw this.sendError;
		},
		sendMaintenance: async leaseId => {
			expect(leaseId).toBe("lease");
			this.emit({ type: "lease_state", id: "", connectionId: "connection", capability: "ui",
				leaseId: this.maintenanceLease, active: this.maintenanceActive, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
		},
	};
	async start() { this.started++; }
	async stop() { this.stopped++; if (this.stopError) throw this.stopError; }
	attachment() { return this.attachmentValue; }
	async request(_sid: string, frame: Record<string, unknown>, _generation: number, _a: SdkUiAttachment,
		options: Parameters<SdkUiRouter["request"]>[4]) {
		this.registrations.push(frame);
		const dispatch = { frame: { ...frame, id: this.dispatchWireId }, connectionId: "connection", generation: 19 };
		options.beforeDispatch(dispatch);
		if (!this.omitSent) options.onDispatch({ ...dispatch, frame: { ...dispatch.frame, id: this.sentWireId ?? this.dispatchWireId } });
		return { type: "register_provider_result", id: this.ackId, leaseId: "lease", registeredNames: this.ackNames,
			leaseExpiresAt: this.ackExpiry };
	}
	emit(body: Record<string, unknown>, seq?: number, attachment = this.attachmentValue) {
		this.options.deps.onFrame(attachment, seq === undefined ? { body } : { body, seq });
	}
}
function fixture(change?: (router: RouterDouble) => void, maxDurationMs = 60000) {
	const router = new RouterDouble();
	change?.(router);
	const backend = new SdkUiApprovalBackend({ agentDir: "/explicit-agent", maxDurationMs,
		routerFactory: options => { router.options = options; return router; } });
	return { router, backend };
}
async function attach(routerFixture: ReturnType<typeof fixture>): Promise<TaskApprovalChannel> {
	const channel = await routerFixture.backend.attach(context, "local-attach");
	channel.bindTurn("original-turn");
	return channel;
}
async function pending(channel: TaskApprovalChannel, router: RouterDouble) {
	router.emit(message());
	router.emit(request());
	const found = await channel.discover();
	expect(found.complete).toBe(true);
	expect(found.questions).toHaveLength(1);
	return found.questions[0]!;
}

describe("sdk-ui-waiter-v1 controlled public Router injection", () => {
	test("inert construction, rewritten wire ID, exact ACK/lease and safe receipt", async () => {
		const f = fixture();
		expect(f.router.started).toBe(0);
		const channel = await attach(f);
		try {
			expect(f.router.started).toBe(1);
			expect(f.router.registrations[0]?.id).not.toBe("actual-wire-id");
			expect(channel.receipt).toMatchObject({ wireId: "actual-wire-id", leaseId: "lease", leaseStateConfirmed: true,
				attachmentAuthorityId: "firsthand-public-capability", endpointGeneration: 7 });
			expect(JSON.stringify(channel.receipt)).not.toContain(context.sessionAuthority.endpointIncarnation);
			expect(f.router.options.attachFilter("different-session")).toBe(false);
		} finally { await channel.close(); }
		expect(f.router.frames).toEqual([{ type: "lease_release", connectionId: "connection", leaseId: "lease" }]);
		expect(f.router.stopped).toBe(1);
		await channel.close();
		expect(f.router.stopped).toBe(1);
	});

	for (const variant of ["wire", "names", "expiry", "dispatch", "sent-wire", "lease", "inactive"] as const) {
		test(`secondary ${variant} failure releases ACK-owned lease`, async () => {
			const f = fixture(r => {
				if (variant === "wire") r.ackId = "caller-or-wrong-id";
				if (variant === "names") r.ackNames = ["unexpected"];
				if (variant === "expiry") r.ackExpiry = "invalid";
				if (variant === "dispatch") r.omitSent = true;
				if (variant === "sent-wire") r.sentWireId = "different-wire-id";
				if (variant === "lease") r.maintenanceLease = "replacement";
				if (variant === "inactive") r.maintenanceActive = false;
			});
			await expect(f.backend.attach(context, "attach")).rejects.toThrow();
			expect(f.router.frames).toContainEqual({ type: "lease_release", connectionId: "connection", leaseId: "lease" });
			expect(f.router.stopped).toBe(1);
		});
	}

	test("no capability identity or wrong original generation fails before registration", async () => {
		for (const change of [
			(r: RouterDouble) => { r.attachmentValue = { ...r.attachmentValue, authorityId: undefined }; },
			(r: RouterDouble) => { r.attachmentValue = { ...r.attachmentValue, generation: 8 }; },
		]) {
			const f = fixture(change);
			await expect(f.backend.attach(context, "attach")).rejects.toThrow();
			expect(f.router.registrations).toHaveLength(0);
			expect(f.router.stopped).toBe(1);
		}
	});

	test("native arguments, source tool ID and raw request bind without fabricated C/T", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			const q = await pending(channel, f.router);
			expect(q.workflow.toolCallId).toBe("source-ask");
			expect(q.workflow.questionId).toBe(question.id);
			expect(q.questionId).toBe(question.id);
			expect(q.answerBinding).toMatch(/^[0-9a-f]{64}$/);
			expect<unknown>(q.workflow.evidence).toEqual({ native: message(), request: request() });
			expect(JSON.stringify(q.workflow.evidence)).not.toContain("turnId");
			expect(JSON.stringify(q.workflow.evidence)).not.toContain("commandId");
			expect(q.authority).toEqual({ kind: "sdk_ui_waiter", requestId: "waiter", connectionId: "connection", leaseId: "lease",
				attachmentAuthorityId: "firsthand-public-capability", endpointGeneration: 7 });
			const original = JSON.stringify(q);
			f.router.emit(request());
			expect(JSON.stringify((await channel.discover()).questions[0])).toBe(original);
		} finally { await channel.close(); }
	});

	test("tool_execution_start uses actual args/toolCallId structure", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			f.router.emit({ event_type: "tool_execution_start", event: { type: "tool_execution_start", toolName: "ask",
				toolCallId: "start-source", args: { questions: [question] } } });
			f.router.emit(request());
			expect((await channel.discover()).questions[0]?.workflow.toolCallId).toBe("start-source");
		} finally { await channel.close(); }
	});

	test("exact option validation, no ACK sent_unconfirmed, duplicates never send", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			const q = await pending(channel, f.router);
			const invalidAnswers: Parameters<TaskApprovalChannel["validateAnswer"]>[1][] = ["Approve execution via ultragoal", { action: "accept", content: { value: "option:3" } },
				{ action: "accept", content: { value: "option:99" } }, { action: "cancel" },
				{ action: "accept", content: { value: "option:1", extra: true } }];
			for (const invalid of invalidAnswers) {
				expect(() => channel.validateAnswer(q, invalid)).toThrow();
			}
			const result = await channel.answer(q, response, "local-once-only");
			expect(result).toMatchObject({ delivery: "sent_unconfirmed", consumption: "unproven" });
			expect(f.router.frames).toEqual([{ type: "reverse_response", id: "waiter", connectionId: "connection",
				leaseId: "lease", ok: true, result: response }]);
			expect((await channel.discover()).consumed).toHaveLength(0);
			expect((await channel.discover()).questions[0]?.status).toBe("sent_unconfirmed");
			await expect(channel.answer(q, response, "local-once-only")).rejects.toThrow();
			await expect(channel.answer(q, response, "different-local-key")).rejects.toThrow();
			expect(f.router.frames).toHaveLength(1);
			f.router.emit(completion("unrelated-tool"));
			expect((await channel.discover()).consumed).toHaveLength(0);
			f.router.emit(completion());
			const consumed = (await channel.discover()).consumed;
			expect(consumed).toHaveLength(1);
			expect(consumed[0]?.toolCallId).toBe("source-ask");
			expect(consumed[0]?.evidence).toEqual({ selectedResponse: response, completion: completion() });
			f.router.emit(completion());
			expect((await channel.discover()).consumed).toHaveLength(1);
		} finally { await channel.close(); }
	});

	for (const variant of ["failed", "cancelled", "unsent"] as const) {
		test(`${variant} is never consumption`, async () => {
			const f = fixture(), channel = await attach(f);
			try {
				const q = await pending(channel, f.router);
				if (variant !== "unsent") await channel.answer(q, response, "operation");
				if (variant === "cancelled") f.router.emit({ type: "reverse_cancel", id: "waiter", connectionId: "connection", leaseId: "lease" });
				f.router.emit(completion("source-ask", variant === "failed"));
				expect((await channel.discover()).consumed).toHaveLength(0);
				await expect(channel.answer(q, response, "retry")).rejects.toThrow();
			} finally { await channel.close(); }
		});
	}

	test("reverse_cancel invalidates only the matching original waiter", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			const q = await pending(channel, f.router);
			f.router.emit({ type: "reverse_cancel", id: "other-waiter", connectionId: "connection", leaseId: "lease" });
			channel.validateAnswer(q, response);
			f.router.emit({ type: "reverse_cancel", id: "waiter", connectionId: "foreign", leaseId: "lease" });
			channel.validateAnswer(q, response);
			f.router.emit({ type: "reverse_cancel", id: "waiter", connectionId: "connection", leaseId: "lease" });
			expect((await channel.discover()).questions).toHaveLength(0);
			expect(() => channel.validateAnswer(q, response)).toThrow();
		} finally { await channel.close(); }
	});

	for (const variant of ["question", "option", "schema", "tag", "ordinary", "input", "empty", "multiple", "multiple-waiters", "mutated", "authority"] as const) {
		test(`unsupported or mismatched ${variant} remains incomplete`, async () => {
			const f = fixture(), channel = await attach(f);
			try {
				if (variant === "tag") f.router.emit(message({ ...question, workflowGate: { stage: "other", kind: "approval" } }));
				else if (variant === "ordinary") f.router.emit(message({ ...question, workflowGate: undefined }));
				else if (variant !== "empty") f.router.emit(message());
				const value = form();
				if (variant === "question") value.message = "Similar but not original";
				if (variant === "option") value.requestedSchema.properties.value.oneOf[0]!.title = "Rewritten";
				if (variant === "schema") value.requestedSchema.properties.value.type = "number";
				if (variant === "input") value.mode = "input";
				f.router.emit(variant === "authority" ? { ...request(), leaseId: "replacement" } : request("waiter", value));
				if (variant === "multiple") f.router.emit(message(question, "second-ask"));
				if (variant === "multiple-waiters") f.router.emit(request("second-waiter"));
				if (variant === "mutated") f.router.emit(request("waiter", { ...form(), message: "changed" }));
				const discovery = await channel.discover();
				expect(discovery.complete).toBe(false);
				expect(discovery.questions).toHaveLength(0);
			} finally { await channel.close(); }
		});
	}

	for (const variant of ["loss", "disconnect", "gap", "overflow"] as const) {
		test(`${variant} prevents further approval`, async () => {
			const f = fixture(), channel = await attach(f);
			const q = await pending(channel, f.router);
			if (variant === "loss") f.router.emit({ type: "lease_state", id: "", connectionId: "connection", capability: "ui",
				leaseId: "lease", active: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() });
			if (variant === "disconnect") f.router.current = false;
			if (variant === "gap") {
				f.router.emit({ event_type: "text_delta", event: { type: "text_delta" } }, 10);
				f.router.emit({ event_type: "text_delta", event: { type: "text_delta" } }, 12);
			}
			if (variant === "overflow") f.router.emit(request("huge", { ...form(), extra: "x".repeat(256 * 1024) }));
			expect((await channel.discover()).complete).toBe(false);
			await expect(channel.answer(q, response, "do-not-send")).rejects.toThrow();
			expect(f.router.frames.filter(frame => frame.type === "reverse_response")).toHaveLength(0);
			if (variant === "overflow" || variant === "disconnect") await expect(channel.close()).rejects.toThrow();
			else await channel.close();
		});
	}

	test("deltas are not captured and do not exhaust critical evidence budget", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			for (let i = 0; i < 1000; i++) f.router.emit({ event_type: "text_delta", event: { type: "text_delta", delta: "not retained" } });
			await pending(channel, f.router);
			expect((await channel.discover()).complete).toBe(true);
		} finally { await channel.close(); }
	});

	test("empty evidence is incomplete; form may link only after original native producer arrives", async () => {
		const f = fixture(), channel = await attach(f);
		try {
			expect((await channel.discover()).complete).toBe(false);
			f.router.emit(request());
			expect((await channel.discover()).complete).toBe(false);
			f.router.emit(message());
			const discovery = await channel.discover();
			expect(discovery.complete).toBe(true);
			expect(discovery.questions[0]?.workflow.toolCallId).toBe("source-ask");
		} finally { await channel.close(); }
	});

	test("finite local deadline releases only the retained lease and stops its Router", async () => {
		const f = fixture(undefined, 100), channel = await attach(f);
		try {
			await new Promise(resolve => setTimeout(resolve, 150));
			expect((await channel.discover()).complete).toBe(false);
			expect(f.router.frames).toEqual([{ type: "lease_release", connectionId: "connection", leaseId: "lease" }]);
			expect(f.router.stopped).toBe(1);
		} finally { await channel.close(); }
	});

	test("primary registration failure and both cleanup failures are preserved", async () => {
		const release = new Error("release failed"), stop = new Error("stop failed");
		const f = fixture(r => { r.ackId = "mismatch"; r.releaseError = release; r.stopError = stop; });
		let failure: unknown;
		try { await f.backend.attach(context, "attach"); } catch (error) { failure = error; }
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).cause).toBe((failure as AggregateError).errors[0]);
		const errors = (failure as AggregateError).errors;
		expect(String(errors[0])).toContain("ACK mismatch");
		expect(errors[1]).toBeInstanceOf(AggregateError);
		expect((errors[1] as AggregateError).errors).toEqual([release, stop]);
		expect((errors[1] as AggregateError).cause).toBe(release);
		expect(f.backend.cleanupFailures).toEqual([release, stop]);
		expect(f.router.stopped).toBe(1);
	});

	test("send failure preserves once-only state and original failure at close", async () => {
		const sendError = new Error("transport failed");
		const f = fixture(r => { r.sendError = sendError; }), channel = await attach(f);
		const q = await pending(channel, f.router);
		await expect(channel.answer(q, response, "key")).rejects.toBe(sendError);
		await expect(channel.answer(q, response, "key2")).rejects.toThrow();
		expect((await channel.discover()).consumed).toHaveLength(0);
		await expect(channel.close()).rejects.toThrow();
		expect(f.router.frames.filter(frame => frame.type === "reverse_response")).toHaveLength(1);
	});
});
