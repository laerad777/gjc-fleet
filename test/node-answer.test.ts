import { describe, expect, test } from "bun:test";
import { answer, NodeReplyError, nodeFailure } from "../src/node";

// Plain Errors with unknown messages classify as "internal" and get a correlationId; logged() then
// appends src/.node-errors.log (git-ignored) or falls back to console.error. Known messages such as
// "workspace_missing" avoid that write.
const parse = (line: string) => JSON.parse(line);

describe("answer certainty", () => {
	test("success returns the body line with exit 0", async () => {
		expect(await answer({ executed: false }, async () => '{"ok":true}')).toEqual({ line: '{"ok":true}', exitCode: 0 });
	});
	test("known failure before any effect is a before_send refusal", async () => {
		const r = await answer({ executed: false }, async () => { throw new Error("workspace_missing"); });
		expect(r.exitCode).toBe(1);
		expect(parse(r.line)).toEqual({ ok: false, error: "workspace_missing", detail: "workspace", certainty: "before_send" });
	});
	test("unknown failure before any effect is internal/exception with a correlationId", async () => {
		const r = await answer({ executed: false }, async () => { throw new Error("boom"); });
		const reply = parse(r.line);
		expect(reply).toMatchObject({ ok: false, error: "internal", detail: "exception", certainty: "before_send" });
		expect(typeof reply.correlationId).toBe("string");
	});
	test("any failure after executed is set is never before_send", async () => {
		const r1 = await answer({ executed: true }, async () => { throw new Error("encode failed"); });
		expect(parse(r1.line)).toMatchObject({ error: "executed_reply_failed", detail: "reply", certainty: "unknown" });
		expect(typeof parse(r1.line).correlationId).toBe("string");
		const r2 = await answer({ executed: true }, async () => { throw new Error("workspace_missing"); });
		expect(parse(r2.line)).toMatchObject({ error: "executed_reply_failed", certainty: "unknown" });
	});
	test("a before_send NodeReplyError is downgraded to unknown once executed", async () => {
		const err = new NodeReplyError({ ok: false, error: "invalid_request", detail: "request", certainty: "before_send" });
		expect(parse((await answer({ executed: true }, async () => { throw err; })).line).certainty).toBe("unknown");
		expect(parse((await answer({ executed: false }, async () => { throw err; })).line).certainty).toBe("before_send");
	});
	test("NodeReplyError code prefix encodes certainty", () => {
		const a = new NodeReplyError({ ok: false, error: "timeout", detail: "deadline", certainty: "before_send" });
		const b = new NodeReplyError({ ok: false, error: "timeout", detail: "deadline", certainty: "unknown" });
		expect(a.message).toBe("node_refused:timeout:deadline");
		expect(b.message).toBe("node_failed:timeout:deadline");
		expect(a.certainty).toBe("before_send");
		expect(b.certainty).toBe("unknown");
	});
});

describe("nodeFailure classification", () => {
	test("passes a NodeReplyError reply through unchanged", async () => {
		const reply = { ok: false, error: "root_denied", detail: "allowlist", certainty: "before_send" } as const;
		expect(await nodeFailure(new NodeReplyError(reply), "unknown")).toBe(reply);
	});
	const cases = [
		[new Error("nested_repository"), "nested_repository", "git_entry"],
		[Object.assign(new Error("x"), { code: "ROOT_DENIED" }), "root_denied", "allowlist"],
		[new Error("repository_root_required"), "root_denied", "allowlist"],
		[Object.assign(new Error("x"), { code: "IDENTITY_MISMATCH" }), "identity_mismatch", "identity"],
		[new Error("base_commit_mismatch"), "identity_mismatch", "identity"],
		[new Error("command_output_limit"), "output_limit", "bytes"],
		[new Error("git_failed:status"), "git_failed", "git_exit"],
		[new Error("workspace_path_too_long:abc"), "workspace_path_too_long", "path_budget"],
		[new SyntaxError("bad json"), "invalid_request", "request"],
		[Object.assign(new Error("x"), { code: "INVALID_INPUT" }), "invalid_request", "request"],
		[new Error("unresolved_path_root:C"), "invalid_request", "request"],
		[new Error("case_collision"), "unsafe_path", "unsafe_entry"],
		[new Error("excluded_input:foo"), "unsafe_path", "unsafe_entry"],
	] as const;
	for (const [error, category, detail] of cases) {
		test(`${(error as Error).message || "error"} -> ${category}`, async () => {
			expect(await nodeFailure(error, "before_send")).toEqual({ ok: false, error: category, detail, certainty: "before_send" });
		});
	}
	test("only an explicit before_send is a refusal; anything else is unknown", async () => {
		expect((await nodeFailure(new Error("workspace_missing"), "unknown")).certainty).toBe("unknown");
	});
	test("substring lookalikes do not match exact-message categories", async () => {
		const r = await nodeFailure(new Error("workspace_missing_extra"), "before_send");
		expect(r).toMatchObject({ error: "internal", detail: "exception" });
	});
	test("a non-Error throw classifies as internal", async () => {
		expect(await nodeFailure("workspace_missing", "before_send")).toMatchObject({ error: "internal" });
	});
});
