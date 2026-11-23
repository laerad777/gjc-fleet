import { test, expect, spyOn } from "bun:test";
import {
	abortOwnedSession,
	buildSshPublicSdkRemote,
	closeOwnedSession,
	isSafeSdkArgvToken,
	isSshTransportCommand,
	posixShellSingleQuote,
	readExecution,
	readSessionAuthority,
	settledExecution,
} from "../src/execution";
import type { NodeConfig, SessionAuthority } from "../src/contracts";
import { TransportError } from "../src/rpc";
function node(result: unknown): NodeConfig {
	return {
		sdkTransport: {
			command: process.execPath,
			args: [
				"--eval",
				`console.log(JSON.stringify(${JSON.stringify(result)}))`,
				"--",
			],
		},
	} as NodeConfig;
}
const receipt = {
	kind: "prompt",
	commandId: "original-command",
	turnId: "original-turn",
	status: "terminal_ok",
	receiptState: "present",
	terminalAt: 123,
	outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
};
const authority: SessionAuthority = {
	sessionId: 'owned "session"',
	cwd: "/workspace with spaces",
	endpointGeneration: 7,
	endpointIncarnation: "ab".repeat(32),
};
const authorityRow = {
	sessionId: authority.sessionId,
	locator: { cwd: authority.cwd },
	endpointGeneration: authority.endpointGeneration,
	endpointIncarnation: authority.endpointIncarnation,
	live: true,
	ambiguous: false,
	terminalUncertain: false,
	terminal: false,
	pid: 123,
	hostIncarnation: "cd".repeat(32),
};
function listing(sessions: unknown[], extra = {}) {
	return {
		type: "broker_response",
		ok: true,
		result: { indexSeq: 4, sessions, ...extra },
	};
}
function scriptedNode(script: string): NodeConfig {
	return {
		sdkTransport: { command: process.execPath, args: ["--eval", script, "--"] },
	} as NodeConfig;
}
test("authority capture uses only the narrow public raw list and whitelists durable identity", async () => {
	const args = [
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
	];
	const configured = scriptedNode(`
		const input=JSON.parse(await new Response(Bun.stdin.stream()).text());
		const args=process.argv.slice(process.argv.indexOf('sdk'));
		if(JSON.stringify(args)!==${JSON.stringify(JSON.stringify(args))} ||
			JSON.stringify(input)!==${JSON.stringify(JSON.stringify({ resolveSessionId: authority.sessionId }))})process.exit(7);
		console.log(JSON.stringify(${JSON.stringify(listing([authorityRow]))}));
	`);
	expect(
		await readSessionAuthority(configured, authority.sessionId, authority.cwd),
	).toEqual(authority);
});
test("authority capture rejects mismatches, composite identities, pagination and unsafe state", async () => {
	const cases = [
		listing([{ ...authorityRow, endpointIncarnation: undefined }]),
		listing([
			{
				...authorityRow,
				endpointIncarnation: `${authorityRow.hostIncarnation}:${authorityRow.pid}`,
			},
		]),
		listing([{ ...authorityRow, endpointIncarnation: "AB".repeat(32) }]),
		listing([{ ...authorityRow, endpointIncarnation: "ab".repeat(31) }]),
		listing([{ ...authorityRow, sessionId: "another-session" }]),
		listing([{ ...authorityRow, locator: { cwd: authority.cwd + "/" } }]),
		listing([{ ...authorityRow, endpointGeneration: 0 }]),
		listing([{ ...authorityRow, endpointGeneration: 1.5 }]),
		listing([
			{ ...authorityRow, endpointGeneration: Number.MAX_SAFE_INTEGER + 1 },
		]),
		listing([{ ...authorityRow, live: false }]),
		listing([{ ...authorityRow, ambiguous: true }]),
		listing([{ ...authorityRow, ambiguous: undefined }]),
		listing([{ ...authorityRow, terminalUncertain: true }]),
		listing([{ ...authorityRow, terminalUncertain: undefined }]),
		listing([{ ...authorityRow, terminal: true }]),
		listing([{ ...authorityRow, terminal: undefined }]),
		listing([]),
		listing([authorityRow, authorityRow]),
		listing([authorityRow, { ...authorityRow, sessionId: "another-session" }]),
		listing([authorityRow], { continuationCursor: "next-page" }),
		{ ...listing([authorityRow]), continuationCursor: "next-page" },
		...[false, 0, null, "", {}, []].flatMap((continuationCursor) => [
			listing([authorityRow], { continuationCursor }),
			{ ...listing([authorityRow]), continuationCursor },
		]),
		{ ...listing([authorityRow]), ok: false },
		{ ...listing([authorityRow]), type: "query_response" },
		{ type: "broker_response", ok: true, result: { sessions: [authorityRow] } },
		null,
	];
	for (const response of cases)
		await expect(
			readSessionAuthority(node(response), authority.sessionId, authority.cwd),
		).rejects.toThrow("public session authority required");
}, 60_000);
test("authority capture permits unrelated safe list metadata", async () => {
	expect(
		await readSessionAuthority(
			node(listing([authorityRow], { diagnostic: "public metadata" })),
			authority.sessionId,
			authority.cwd,
		),
	).toEqual(authority);
}, 60_000);
test("stdin write errors never judge the response: EPIPE is ignored, anything else still fails", async () => {
	function fakeChild(stdinError: Error, stdoutText: string, exitCode: number) {
		return {
			stdin: {
				write() {
					throw stdinError;
				},
				end() {},
			},
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(stdoutText));
					controller.close();
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			exited: Promise.resolve(exitCode),
			kill() {},
		} as unknown as ReturnType<typeof Bun.spawn>;
	}
	const epipe = Object.assign(new Error("EPIPE: broken pipe, write"), {
		code: "EPIPE",
	});
	// EPIPE from a child that exited before reading stdin: the completed
	// stdout response and exit code still govern, exactly as without EPIPE.
	let spawn = spyOn(Bun, "spawn").mockImplementation(() =>
		fakeChild(epipe, JSON.stringify(listing([authorityRow])), 0),
	);
	try {
		expect(
			await readSessionAuthority(node(null), authority.sessionId, authority.cwd),
		).toEqual(authority);
	} finally {
		spawn.mockRestore();
	}
	// The same EPIPE must not mask a nonzero-exit public refusal.
	const refusal = {
		ok: false,
		operation: "session.close",
		error: { code: "endpoint_identity_mismatch", outcomeCertainty: "unknown" },
	};
	spawn = spyOn(Bun, "spawn").mockImplementation(() =>
		fakeChild(epipe, JSON.stringify(refusal), 1),
	);
	try {
		const error = await closeOwnedSession(
			node(null),
			authority,
			"close-key",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.publicResponse).toEqual(refusal);
	} finally {
		spawn.mockRestore();
	}
	// Any other stdin write error still fails the lookup unchanged.
	spawn = spyOn(Bun, "spawn").mockImplementation(() =>
		fakeChild(
			Object.assign(new Error("EINVAL: unexpected EPIPE text"), {
				code: "EINVAL",
			}),
			JSON.stringify(listing([authorityRow])),
			0,
		),
	);
	try {
		await expect(
			readSessionAuthority(node(null), authority.sessionId, authority.cwd),
		).rejects.toThrow("invalid_public_sdk_response");
	} finally {
		spawn.mockRestore();
	}
});
test("normal close rejects incomplete retained authority and missing durable keys before spawning", async () => {
	const malformed: unknown[] = [
		null,
		undefined,
		{},
		...[
			{ sessionId: undefined },
			{ sessionId: "" },
			{ sessionId: 7 },
			{ cwd: undefined },
			{ cwd: "" },
			{ cwd: 7 },
			{ endpointGeneration: undefined },
			{ endpointGeneration: 0 },
			{ endpointGeneration: -1 },
			{ endpointGeneration: 1.5 },
			{ endpointGeneration: Number.MAX_SAFE_INTEGER + 1 },
			{ endpointGeneration: "7" },
			{ endpointIncarnation: undefined },
			{ endpointIncarnation: "" },
			{ endpointIncarnation: "AB".repeat(32) },
			{ endpointIncarnation: "ab".repeat(31) },
			{ endpointIncarnation: 7 },
		].map((patch) => ({ ...authority, ...patch })),
	];
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw Error("unexpected child spawn");
	});
	try {
		for (const value of malformed)
			await expect(
				closeOwnedSession(node(null), value as SessionAuthority, "close-key"),
			).rejects.toThrow(
				"Complete retained session authority and durable close key required",
			);
		for (const key of [undefined, null, "", 7])
			await expect(
				closeOwnedSession(node(null), authority, key as string),
			).rejects.toThrow(
				"Complete retained session authority and durable close key required",
			);
		expect(spawn).not.toHaveBeenCalled();
	} finally {
		spawn.mockRestore();
	}
});
test("normal close sends only pinned authority and durable key and returns the actual facade", async () => {
	const key = 'durable "close" key';
	const args = [
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
	];
	const input = {
		sessionId: authority.sessionId,
		endpointGeneration: authority.endpointGeneration,
		endpointIncarnation: authority.endpointIncarnation,
	};
	const response = {
		ok: true,
		operation: "session.close",
		result: { sessionId: authority.sessionId },
	};
	const configured = scriptedNode(`
		const input=JSON.parse(await new Response(Bun.stdin.stream()).text());
		const args=process.argv.slice(process.argv.indexOf('sdk'));
		if(JSON.stringify(args)!==${JSON.stringify(JSON.stringify(args))} ||
			JSON.stringify(input)!==${JSON.stringify(JSON.stringify(input))})process.exit(7);
		console.log(JSON.stringify(${JSON.stringify(response)}));
	`);
	expect(await closeOwnedSession(configured, authority, key)).toEqual(response);
	const unrelated = {
		ok: true,
		result: { nested: { closed: true, sessionId: authority.sessionId } },
	};
	expect(await closeOwnedSession(node(unrelated), authority, key)).toEqual(
		unrelated,
	);
});
test("nonzero public refusal preserves actual JSON and public certainty without inventing before-send", async () => {
	for (const outcomeCertainty of ["not-applied", "unknown"]) {
		const response = {
			ok: false,
			operation: "session.close",
			error: { code: "endpoint_identity_mismatch", outcomeCertainty },
		};
		const configured = scriptedNode(
			`console.error('private diagnostic');console.log(${JSON.stringify(JSON.stringify(response))});process.exitCode=1;`,
		);
		const error = await closeOwnedSession(
			configured,
			authority,
			"close-key",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.certainty).toBe("unknown");
		expect(error.publicResponse).toEqual(response);
		expect(error.message).not.toContain("private diagnostic");
	}
}, 60_000);
test("missing or malformed public output remains unknown without a fabricated public response", async () => {
	for (const script of [
		"console.error('private diagnostic');process.exitCode=1;",
		"console.log('not-json');process.exitCode=1;",
		"await Bun.write(Bun.stdout,new Uint8Array([255]));process.exitCode=1;",
		"console.log('x'.repeat(1024*1024+1));",
	]) {
		const error = await closeOwnedSession(
			scriptedNode(script),
			authority,
			"close-key",
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.certainty).toBe("unknown");
		expect(error.publicResponse).toBeUndefined();
		expect(error.message).not.toContain("private diagnostic");
	}
}, 60_000);
test("public original-turn query accepts exact durable result and refuses another turn", async () => {
	expect(
		await readExecution(
			node({ type: "query_response", ok: true, result: receipt }),
			"owned-session",
			"original-command",
			"original-turn",
		),
	).toEqual(receipt);
	await expect(
		readExecution(
			node({
				type: "query_response",
				ok: true,
				result: { ...receipt, turnId: "successor" },
			}),
			"owned-session",
			"original-command",
			"original-turn",
		),
	).rejects.toThrow("Exact original runtime result");
}, 60_000);
test("runtime query transfers exact JSON through stdin rather than shell-sensitive argv", async () => {
	const commandId = 'command with "quotes"',
		turnId = "turn with space";
	const configured = {
		sdkTransport: {
			command: process.execPath,
			args: [
				"--eval",
				`const input=JSON.parse(await new Response(Bun.stdin.stream()).text());if(!process.argv.includes('--json-input-stdin')||process.argv.includes('--json-input')||input.kind!=='prompt')process.exit(7);console.log(JSON.stringify({type:'query_response',ok:true,result:{...${JSON.stringify(receipt)},commandId:input.commandId,turnId:input.turnId}}))`,
				"--",
			],
		},
	} as NodeConfig;
	expect(
		await readExecution(configured, "owned-session", commandId, turnId),
	).toEqual({ ...receipt, commandId, turnId });
}, 60_000);
test("ssh transport detection uses basename (absolute path and .exe)", () => {
	expect(isSshTransportCommand("ssh")).toBe(true);
	expect(isSshTransportCommand("/usr/bin/ssh")).toBe(true);
	expect(isSshTransportCommand("ssh.exe")).toBe(true);
	expect(isSshTransportCommand(String.raw`C:\Windows\System32\OpenSSH\ssh.exe`)).toBe(
		true,
	);
	expect(isSshTransportCommand("/usr/local/bin/gjc")).toBe(false);
	expect(isSshTransportCommand(process.execPath)).toBe(false);
});
test("posix ssh wraps compound remotes so env covers the whole command", () => {
	const remote = "cd /tmp/agent && gjc";
	const args = ["sdk", "session", "raw", "query", "owned-session"];
	const guarded = buildSshPublicSdkRemote("linux", remote, args);
	expect(guarded).toBe(
		`env GJC_SDK_BROKER_AUTOSTART=0 sh -c ${posixShellSingleQuote(`${remote} ${args.join(" ")}`)}`,
	);
	expect(guarded).toContain("cd /tmp/agent && gjc sdk session raw query owned-session");
	expect(guarded.startsWith("env GJC_SDK_BROKER_AUTOSTART=0 cd")).toBe(false);
});
test("win32 ssh injects broker env inside cmd.exe /c remotes", () => {
	expect(
		buildSshPublicSdkRemote("win32", "cmd.exe /c gjc", ["sdk", "session", "list"]),
	).toBe('cmd.exe /c "set GJC_SDK_BROKER_AUTOSTART=0&& gjc sdk session list"');
});
test("over ssh, public SDK argv tokens must be shell-safe before remote join", async () => {
	expect(isSafeSdkArgvToken("owned-session")).toBe(true);
	expect(isSafeSdkArgvToken("00000000-0000-0000-0000-000000000000")).toBe(true);
	expect(isSafeSdkArgvToken('owned "session"')).toBe(false);
	expect(isSafeSdkArgvToken("a;rm -rf /")).toBe(false);
	expect(isSafeSdkArgvToken("a$(id)")).toBe(false);
	expect(isSafeSdkArgvToken("id@host")).toBe(false);
	expect(isSafeSdkArgvToken("id+plus")).toBe(false);
	for (const command of [
		"ssh",
		"/usr/bin/ssh",
		"ssh.exe",
		String.raw`C:\Windows\System32\OpenSSH\ssh.exe`,
	]) {
		const sshNode = {
			os: command.toLowerCase().endsWith(".exe") ? "win32" : "linux",
			sdkTransport: { command, args: ["node.example", "gjc"] },
		} as NodeConfig;
		await expect(
			readExecution(
				sshNode,
				"owned-session;id",
				"original-command",
				"original-turn",
			),
		).rejects.toThrow(/shell-safe/);
		await expect(
			abortOwnedSession(sshNode, "owned-session", "key;evil"),
		).rejects.toThrow(/shell-safe/);
	}
});
test("local transport keeps shell-sensitive session id in real argv", async () => {
	const sessionId = 'owned "session"';
	const configured = scriptedNode(`
		const input=JSON.parse(await new Response(Bun.stdin.stream()).text());
		const args=process.argv.slice(process.argv.indexOf('sdk'));
		if(!args.includes(${JSON.stringify(sessionId)})||input.kind!=='prompt')process.exit(7);
		console.log(JSON.stringify({type:'query_response',ok:true,result:{...${JSON.stringify(receipt)},commandId:input.commandId,turnId:input.turnId}}));
	`);
	expect(
		await readExecution(configured, sessionId, "original-command", "original-turn"),
	).toEqual({
		...receipt,
		commandId: "original-command",
		turnId: "original-turn",
	});
}, 60_000);
test("positive ssh path: absolute ssh keeps command path and wraps a safe remote", async () => {
	const sessionId = "00000000-0000-0000-0000-000000000001";
	// resolveProgram requires a drive-absolute path on Windows; POSIX /usr/bin/ssh is refused there.
	const sshAbs =
		process.platform === "win32"
			? String.raw`C:\Windows\System32\OpenSSH\ssh.exe`
			: "/usr/bin/ssh";
	const seen: string[][] = [];
	const original = Bun.spawn.bind(Bun);
	const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options: any) => {
		seen.push(cmd as string[]);
		return original(
			[
				process.execPath,
				"--eval",
				`console.log(JSON.stringify({type:'query_response',ok:true,result:${JSON.stringify(receipt)}}))`,
			],
			options,
		);
	}) as any);
	try {
		const sshNode = {
			os: "linux",
			sdkTransport: {
				command: sshAbs,
				args: ["node.example", "cd /tmp/agent && gjc"],
			},
		} as NodeConfig;
		expect(
			await readExecution(
				sshNode,
				sessionId,
				"original-command",
				"original-turn",
			),
		).toEqual(receipt);
	} finally {
		spy.mockRestore();
	}
	expect(seen.length).toBe(1);
	expect(seen[0]![0]).toBe(sshAbs);
	expect(seen[0]![1]).toBe("node.example");
	expect(seen[0]![2]).toBe(
		buildSshPublicSdkRemote("linux", "cd /tmp/agent && gjc", [
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
		]),
	);
}, 60_000);
test("acceptance unknown and evicted receipts never imply execution settlement", () => {
	expect(settledExecution(receipt)).toBe(true);
	for (const patch of [
		{ status: "accepted" },
		{ status: "in_flight" },
		{ status: "unknown" },
		{ receiptState: "evicted" },
		{ terminalAt: null },
		{ outcome: null },
		{ outcome: { kind: "pending" } },
		{ outcome: { kind: "" } },
		{ outcome: { kind: "stopped" } },
		{ status: "failed" },
	])
		expect(settledExecution({ ...receipt, ...patch })).toBe(false);
	expect(
		settledExecution({
			...receipt,
			status: "failed",
			outcome: {
				kind: "failed",
				code: "prompt_failed",
				provenance: "agent_failed",
				message: "controlled failure",
			},
		}),
	).toBe(true);
});
function cleanupChild(mode: "timeout" | "overflow" | "read_error" | "decode_error", exitsOn?: "SIGTERM" | "SIGKILL") {
	let finish!: (code: number) => void;
	const signals: (number | NodeJS.Signals | undefined)[] = [];
	const cancelled: string[] = [];
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			if (mode === "overflow") controller.enqueue(new Uint8Array(1024 * 1024 + 1));
			if (mode === "read_error") controller.error(new Error("read failed"));
			if (mode === "decode_error") {
				controller.enqueue(new Uint8Array([255]));
				controller.close();
			}
		},
		cancel() { cancelled.push("stdout"); },
	});
	const stderr = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled.push("stderr");
			return new Promise<void>(() => {});
		},
	});
	const child = {
		stdin: { write() {}, end() {} },
		stdout,
		stderr,
		exited: new Promise<number>((resolve) => { finish = resolve; }),
		kill(signal?: number | NodeJS.Signals) {
			signals.push(signal);
			if (signal === exitsOn) finish(1);
		},
	} as unknown as ReturnType<typeof Bun.spawn>;
	return { child, stdout, stderr, signals, cancelled };
}
for (const mode of ["overflow", "read_error", "decode_error"] as const) {
	test(`public SDK ${mode} escalates termination and releases readers`, async () => {
		const fake = cleanupChild(mode, "SIGKILL");
		const spawn = spyOn(Bun, "spawn").mockImplementation(() => fake.child);
		try {
			const error = await readSessionAuthority(node(null), authority.sessionId, authority.cwd)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(TransportError);
			if (!(error instanceof TransportError)) throw error;
			expect(error.code).toBe(mode === "overflow" ? "execution_query_output_limit" : "invalid_public_sdk_response");
			expect(error.certainty).toBe("unknown");
			expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
			if (mode === "overflow") expect(fake.cancelled.sort()).toEqual(["stderr", "stdout"]);
			else expect(fake.cancelled).toContain("stderr");
			expect(fake.stdout.locked).toBe(false);
			expect(fake.stderr.locked).toBe(false);
		} finally { spawn.mockRestore(); }
	});
}
test("public SDK deadline cancels both readers and waits for escalated exit", async () => {
	const fake = cleanupChild("timeout", "SIGKILL");
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => fake.child);
	try {
		const error = await readSessionAuthority(node(null), authority.sessionId, authority.cwd)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.code).toBe("execution_query_timeout");
		expect(error.certainty).toBe("unknown");
		expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(fake.cancelled.sort()).toEqual(["stderr", "stdout"]);
		expect(fake.stdout.locked).toBe(false);
		expect(fake.stderr.locked).toBe(false);
	} finally { spawn.mockRestore(); }
}, 15_000);
test("public SDK cleanup is bounded when exit never arrives", async () => {
	const fake = cleanupChild("overflow");
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => fake.child);
	try {
		const error = await readSessionAuthority(node(null), authority.sessionId, authority.cwd)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.code).toBe("execution_query_cleanup_timeout");
		expect(error.certainty).toBe("unknown");
		expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(fake.stdout.locked).toBe(false);
		expect(fake.stderr.locked).toBe(false);
	} finally { spawn.mockRestore(); }
}, 3_000);
test("public SDK cleanup does not escalate after graceful exit", async () => {
	const fake = cleanupChild("overflow", "SIGTERM");
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => fake.child);
	try {
		const error = await readSessionAuthority(node(null), authority.sessionId, authority.cwd)
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TransportError);
		if (!(error instanceof TransportError)) throw error;
		expect(error.code).toBe("execution_query_output_limit");
		expect(fake.signals).toEqual(["SIGTERM"]);
		expect(fake.stdout.locked).toBe(false);
		expect(fake.stderr.locked).toBe(false);
	} finally { spawn.mockRestore(); }
});
