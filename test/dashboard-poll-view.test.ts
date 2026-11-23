import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LateReceipt, ReceiptlessSettlement } from "../src/contracts";
import {
	publicCommandError,
	publicExitError,
	publicLateReceipt,
	publicPollCliBody,
	publicPollDetails,
	publicSettlement,
} from "../src/dashboard-poll-view";
import { getDashboardState, probeNode, startResourceStreams } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { observationDigest } from "../src/core";
import { activeOn, node } from "./fixtures/daemon";
import { stubPrograms } from "./support/stub-path";

const SECRET = "synthetic_private_token_123456";

test("public redaction helpers expose only fixed codes and bounded poll fields", () => {
	expect(publicCommandError("broker_unavailable")).toBe("broker_unavailable");
	expect(publicCommandError("quota_exceeded")).toBe("command_failed");
	expect(publicCommandError(undefined)).toBe("command_failed");
	expect(publicExitError(null)).toBe("query_timeout");
	expect(publicExitError(1)).toBe("command_failed");
	const settlement: ReceiptlessSettlement = {
		kind: "failed_without_receipt",
		receiptState: "absent",
		cause: SECRET,
		settledAt: "2020-01-01T00:00:00.000Z",
		lateObservationUntil: "2020-01-02T00:00:00.000Z",
	};
	expect(publicSettlement({ ...settlement, kind: "ended_without_receipt" }).cause).toBe("ended_without_receipt");
	expect(publicSettlement(settlement).cause).toBe("failed_without_receipt");
	expect(JSON.stringify(publicSettlement(settlement))).not.toContain(SECRET);
	const late: LateReceipt = {
		status: "failed",
		digest: "d".repeat(64),
		terminalAt: 1,
		outcome: { detail: SECRET },
		sessionId: "s",
		turnId: "t",
		runtimeCommandId: "c",
		runtimeTurnId: "r",
		observedAt: "2020-01-01T00:00:00.000Z",
		settlementKind: "failed_without_receipt",
	};
	expect(publicLateReceipt(late).outcome).toEqual({});
	expect(JSON.stringify(publicLateReceipt(late))).not.toContain(SECRET);
	expect(
		publicPollDetails({
			publicTurn: { turn: { status: "running", prompt: { text: SECRET } }, session_state: { state: "active" } },
			questions: { questions: [{ id: "q1" }, { id: "q2" }] },
		}),
	).toEqual({ poll: { turnStatus: "running", sessionState: "active" }, questionCount: 2 });
	expect(publicPollDetails({ publicTurn: { turn: { status: "weird" } } })).toEqual({
		poll: { turnStatus: "unknown", sessionState: "unknown" },
	});
	expect(
		publicPollCliBody(
			{
				publicTurn: { turn: { status: "running", secret: SECRET }, session_state: { state: "active" } },
				questions: { questions: [{ id: "q1" }] },
				leakedFutureField: SECRET,
			} as any,
			{ id: "task", phase: "active" },
		),
	).toEqual({
		task: { id: "task", phase: "active" },
		poll: { turnStatus: "running", sessionState: "active" },
		questionCount: 1,
	});
	expect(JSON.stringify(publicPollCliBody({ leaked: SECRET } as any, {}))).not.toContain(SECRET);
	expect(publicPollCliBody({ lateReceipt: null } as any, { id: "t" })).not.toHaveProperty("lateReceipt");
	expect(publicPollCliBody({ lateReceipt: undefined } as any, { id: "t" })).not.toHaveProperty("lateReceipt");
	expect(publicPollCliBody({ lateReceipt: late }, { id: "t" }).lateReceipt).toEqual(publicLateReceipt(late));
});

test("probeNode session list timeout keeps query_timeout even with JSON on stdout", async () => {
	const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const stubs = stubPrograms(["gjc"]);
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		if (cmd[0] === stubs.program("gjc") && cmd.includes("--version")) {
			return {
				stdout: new Response("1.0.0").body,
				stderr: new Response("").body,
				exited: Promise.resolve(0),
				exitCode: 0,
			};
		}
		if (cmd[0] === stubs.program("gjc") && cmd.includes("session")) {
			return {
				stdout: new Response(JSON.stringify({ ok: false, error: { code: "quota_exceeded", message: SECRET } })).body,
				stderr: new Response("").body,
				exited: Promise.resolve(null),
				exitCode: null,
			};
		}
		throw new Error("unexpected spawn");
	}) as any);
	try {
		const probe = await probeNode(
			{ id: "n", os: "linux", sdkTransport: { command: stubs.program("gjc"), args: [] } } as any,
			{ version: "1", versionAt: Date.now(), titles: new Map([[id, null]]) },
		);
		expect(probe.sessionsError).toBe("query_timeout");
		expect(JSON.stringify(probe)).not.toContain(SECRET);
	} finally {
		spawn.mockRestore();
		stubs.restore();
	}
});

test("probeNode surfaces spawn and command failures without private stderr", async () => {
	const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const stubs = stubPrograms(["gjc", "sh"]);
	const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
		if (cmd[0] === stubs.program("gjc") && cmd.includes("--version")) {
			return {
				stdout: new Response("").body,
				stderr: new Response(SECRET).body,
				exited: Promise.resolve(1),
				exitCode: 1,
			};
		}
		if (cmd[0] === stubs.program("gjc") && cmd.includes("session")) {
			return {
				stdout: new Response(JSON.stringify({ ok: false, error: { code: "broker_unavailable", message: SECRET } })).body,
				stderr: new Response("").body,
				exited: Promise.resolve(1),
				exitCode: 1,
			};
		}
		throw new Error(SECRET);
	}) as any);
	try {
		const versionFail = await probeNode({ id: "n", os: "linux", sdkTransport: { command: stubs.program("gjc"), args: [] } } as any);
		expect(versionFail.error).toBe("command_failed");
		expect(JSON.stringify(versionFail)).not.toContain(SECRET);
		const broker = await probeNode(
			{ id: "n2", os: "linux", sdkTransport: { command: stubs.program("gjc"), args: [] } } as any,
			{ version: "1", versionAt: Date.now(), titles: new Map([[id, null]]) },
		);
		expect(broker.sessionsError).toBe("broker_unavailable");
		expect(JSON.stringify(broker)).not.toContain(SECRET);
	} finally {
		spawn.mockRestore();
		stubs.restore();
	}
});

test("dashboard state redacts settlement cause", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fleet-dash-poll-view-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const id = activeOn(store, "n", "settle-test");
		const body = {
			sessionId: `session-${id}`,
			turnId: `turn-${id}`,
			status: "failed" as const,
			terminal: true,
			evidence: { native: "settled" },
			settlement: {
				kind: "failed_without_receipt" as const,
				receiptState: "absent",
				cause: SECRET,
				settledAt: "2020-01-01T00:00:00.000Z",
				lateObservationUntil: "2020-01-02T00:00:00.000Z",
			},
		};
		store.observe(id, { eventId: "ev", digest: observationDigest(body), ...body });
		const task = getDashboardState(store).tasks.find((row) => row.id === id)!;
		expect(task.settlement?.cause).toBe("failed_without_receipt");
		expect(JSON.stringify(task)).not.toContain(SECRET);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("resource stream errors use fixed public codes", async () => {
	const node = { id: "UNSUPPORTED", os: "freebsd" } as any;
	let errors: string[] = [];
	const streams = startResourceStreams(() => [node], (_id, resources) => errors.push(resources.error ?? ""), {
		command: () => undefined,
	});
	try {
		await Bun.sleep(100);
		expect(errors).toContain("resource_stream_refused");
	} finally {
		streams.stop();
	}
	errors = [];
	const reject = startResourceStreams(
		() => [{ id: "E", os: "linux" } as any],
		(_id, resources) => errors.push(resources.error ?? ""),
		{ command: () => ({ argv: ["sh", "-c", "echo E no-sshd-session; sleep 1"], script: "\n" }) },
	);
	try {
		await Bun.sleep(300);
		expect(errors).toContain("resource_stream_refused");
	} finally {
		reject.stop();
	}
});