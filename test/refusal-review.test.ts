// Behavior tests for independent review 2e398559 (R1-R4). Each started as a reviewer probe that
// reproduced the defect; here it asserts the required behavior. All Git fixtures live under the
// OS temp directory; synthetic secrets only.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import * as helperModule from "../src/node";
import { NodeReplyError, oneShot, nodeErrorLogSupportsNoFollow } from "../src/node";
import { prepareWorkspace, sha256 } from "../src/workspace";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";

const secret = "REVIEW_SYNTHETIC_SECRET_9cb142";
const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});
const nodeTs = resolve(import.meta.dir, "../src/node.ts");
const forwardingTs = resolve(import.meta.dir, "../src/placement-preflight.ts");

async function fixture() {
	const f = await repositoryFixture(secret + "-");
	dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const node: any = {
		id: "node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot,
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport: {
			command: process.execPath,
			args: [resolve(import.meta.dir, "fixtures/coordinator.ts"), state],
		},
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const input = {
		taskId: "task",
		attemptId: "attempt",
		nodeId: "node",
		repoId: "repo",
		baseCommit: f.baseCommit,
		inputDigest: sha256("input"),
	};
	const identity = await prepareWorkspace({
		...input,
		repo: f.repo,
		workspaceRoot: f.workspaceRoot,
	});
	return { ...f, state, node, config, input, identity };
}
function clean(value: unknown) {
	expect(JSON.stringify(value)).not.toContain(secret);
}
async function raw(
	helper: string,
	config: string,
	request: string,
	env: Record<string, string> = {},
) {
	const child = Bun.spawn([process.execPath, helper, config], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, REVIEW_SECRET_ENV: secret, ...env },
	});
	child.stdin.write(request);
	child.stdin.end();
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clean({ stdout, stderr });
	return { stdout, stderr, exit, reply: JSON.parse(stdout) };
}
async function caught(p: Promise<unknown>): Promise<any> {
	try {
		await p;
	} catch (error: any) {
		clean({ code: error.code, message: error.message, reply: error.reply });
		return error;
	}
	throw new Error("expected rejection");
}
/** Task-owned Git wrapper that records each real Git invocation, then delegates. */
async function countingGit(dir: string) {
	const bin = join(dir, "bin");
	await mkdir(bin);
	const marker = join(dir, "git-executed");
	const real = Bun.which("git")!;
	if (process.platform === "win32") {
		// Fleet runs only a git.exe on Windows (never a .cmd/.bat), so the wrapper is a real executable.
		const source = join(dir, "counting-git.ts");
		await writeFile(
			source,
			`require("node:fs").appendFileSync(${JSON.stringify(marker)}, "ran\\n");\n` +
				`const r = Bun.spawnSync([${JSON.stringify(real)}, ...process.argv.slice(2)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });\n` +
				`process.exit(r.exitCode ?? 1);\n`,
		);
		const build = Bun.spawnSync(
			[process.execPath, "build", "--compile", source, "--outfile", join(bin, "git.exe")],
			{ stdout: "pipe", stderr: "pipe", timeout: 120_000 },
		);
		if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	} else {
		await writeFile(
			join(bin, "git"),
			`#!/bin/sh\nprintf 'ran\\n' >> '${marker}'\nexec '${real}' "$@"\n`,
		);
		await chmod(join(bin, "git"), 0o700);
	}
	const sep = process.platform === "win32" ? ";" : ":";
	return {
		marker,
		env: { PATH: bin + sep + process.env.PATH },
		count: async () =>
			(await Bun.file(marker).exists())
				? (await readFile(marker, "utf8")).trim().split(/\r?\n/).length
				: 0,
	};
}

// R1 ---------------------------------------------------------------------------------------
test("R1: executed collection whose reply cannot be encoded is executed_reply_failed/unknown, never a refusal", async () => {
	const f = await fixture();
	const git = await countingGit(f.dir);
	// ~400 KB, below the request limit; parses, but cannot be canonically re-encoded afterwards.
	const request = `{"action":"collect","identity":${JSON.stringify(f.identity)},"tests":[${"[".repeat(200000)}0${"]".repeat(200000)}]}`;
	const r = await raw(nodeTs, f.config, request, git.env);
	expect(await git.count()).toBeGreaterThan(0);
	expect(r.exit).toBe(1);
	expect(r.reply).toEqual({
		ok: false,
		error: "executed_reply_failed",
		detail: "reply",
		certainty: "unknown",
		correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
	});
	// Without O_NOFOLLOW (Windows), file logging is fail-closed; assert stderr fallback instead.
	if (nodeErrorLogSupportsNoFollow) {
		const log = await readFile(resolve(import.meta.dir, "../src/.node-errors.log"), "utf8");
		expect(log).toContain(
			JSON.stringify({ correlationId: r.reply.correlationId, error: "executed_reply_failed" }),
		);
		clean(log);
	} else {
		expect(r.stderr).toContain(r.reply.correlationId);
		expect(r.stderr).not.toContain(f.dir);
		clean(r.stderr);
	}
	// The same answer through the caller is an unknown outcome, not a refusal.
	const helper = join(f.dir, "replay.ts");
	await writeFile(helper, `console.log(${JSON.stringify(r.stdout.trim())});process.exitCode=1;`);
	const error = await caught(oneShot(process.execPath, [helper], {}));
	expect(error).toBeInstanceOf(NodeReplyError);
	expect(error.certainty).toBe("unknown");
	expect(error.code).toBe(`node_failed:executed_reply_failed:reply:${r.reply.correlationId}`);
}, 30000);
test("R1: the same request without executing (identity refusal) stays a before_send refusal with no Git run", async () => {
	const f = await fixture();
	const git = await countingGit(f.dir);
	const request = `{"action":"collect","identity":${JSON.stringify({ ...f.identity, nodeId: "other" })},"tests":[${"[".repeat(200000)}0${"]".repeat(200000)}]}`;
	const r = await raw(nodeTs, f.config, request, git.env);
	expect(await git.count()).toBe(0);
	expect(r.reply).toEqual({
		ok: false,
		error: "identity_mismatch",
		detail: "identity",
		certainty: "before_send",
	});
}, 30000);
test("R1: forwarding helper keeps forwarded execution inside the same certainty boundary", async () => {
	const f = await fixture();
	const git = await countingGit(f.dir);
	const request = `{"action":"collect","identity":${JSON.stringify(f.identity)},"tests":[${"[".repeat(200000)}0${"]".repeat(200000)}]}`;
	const r = await raw(forwardingTs, f.config, request, git.env);
	expect(await git.count()).toBeGreaterThan(0);
	// JSON.stringify also exceeds the stack on this value after the collect ran.
	expect(r.exit).toBe(1);
	expect(r.reply).toEqual({
		ok: false,
		error: "executed_reply_failed",
		detail: "reply",
		certainty: "unknown",
		correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/),
	});
}, 30000);
test("R1: answer() never reports a refusal once progress.executed is set", async () => {
	const before = await helperModule.answer({ executed: false }, async () => {
		throw new Error("/outside/" + secret);
	});
	expect(JSON.parse(before.line)).toMatchObject({
		error: "internal",
		certainty: "before_send",
	});
	const after = await helperModule.answer({ executed: true }, async () => {
		throw new RangeError("Maximum call stack size exceeded " + secret);
	});
	expect(after.exitCode).toBe(1);
	expect(JSON.parse(after.line)).toMatchObject({
		error: "executed_reply_failed",
		detail: "reply",
		certainty: "unknown",
	});
	clean([before, after]);
});
test("R1: forged executed_reply_failed claiming before_send is not accepted as a reply", async () => {
	const forged = {
		ok: false,
		error: "executed_reply_failed",
		detail: "reply",
		certainty: "before_send",
		correlationId: "801967f0-9877-4cbc-92e7-5138176ff33f",
	};
	const error = await caught(
		oneShot(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(forged))});process.exitCode=1`], {}),
	);
	expect(error).toMatchObject({ code: "node_transport_failed", certainty: "unknown" });
}, 30000);

// R2 ---------------------------------------------------------------------------------------
async function countingHelper(f: Awaited<ReturnType<typeof fixture>>) {
	const counter = join(f.dir, "dispatches");
	const unavailable = join(f.dir, "preflight-unavailable");
	const script = join(f.dir, "helper.ts");
	await writeFile(
		script,
		`import {appendFileSync,existsSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';try{action=String(JSON.parse(input).action)}catch{}
appendFileSync(${JSON.stringify(counter)},action+'\\n');
if(action==='preflight'&&existsSync(${JSON.stringify(unavailable)}))process.exit(3);
const child=Bun.spawn([process.execPath,${JSON.stringify(nodeTs)},${JSON.stringify(f.config)}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;`,
	);
	return {
		args: [script],
		unavailable,
		dispatches: async () =>
			(await Bun.file(counter).exists())
				? (await readFile(counter, "utf8")).trim().split("\n")
				: [],
	};
}
function submit(store: FleetStore, f: { baseCommit: string }, key: string) {
	const t = store.submit({
		schemaVersion: 1,
		key,
		caller: "review",
		repoId: "repo",
		baseCommit: f.baseCommit,
		prompt: "review",
		required: {},
	});
	store.reserve(t.id, headroom(["node"], 1));
	return store.task(t.id)!;
}
test("R2: retained refusal is re-evaluated by preflight; stays held while the cause persists, proceeds (audited) after it is fixed, including across reopen", async () => {
	const f = await fixture();
	const helper = await countingHelper(f);
	const db = join(f.dir, "wedge.sqlite");
	let store = new FleetStore(db);
	try {
		store.putNode({
			...f.node,
			workspaceTransport: { command: process.execPath, args: helper.args },
		});
		const t = submit(store, f, "wedge");
		const originalAttempt = t.attemptId!;
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		const first = await caught(new Fleet(store).start(t.id));
		expect(first.code).toBe("node_refused:root_denied:allowlist");
		const refused = store.getOperation(t.id, "prepare")!;
		expect(refused.receipt).toMatchObject({
			nodeRefusal: { error: "root_denied", certainty: "before_send" },
		});
		// Cause persists: only the side-effect-free preflight is dispatched.
		const second = await caught(new Fleet(store).start(t.id));
		expect(second.code).toBe(first.code);
		expect(await helper.dispatches()).toEqual(["prepare", "preflight"]);
		expect(store.task(t.id)).toMatchObject({
			attemptId: originalAttempt,
			held: true,
			phase: "dispatching",
		});
		expect(store.getOperation(t.id, "prepare")).toEqual(refused);
		expect(
			store.events(t.id).filter((e) => e.kind === "preparation_reevaluation"),
		).toMatchObject([
			{ data: { operationId: refused.id, outcome: "still_refused", code: first.code } },
		]);
		// Fix the cause, reopen the store; the next start proceeds on a fresh attempt.
		await f.git("config", "--remove-section", "filter.fleet-refusal");
		store.close();
		store = new FleetStore(db);
		const started = await new Fleet(store).start(t.id);
		expect(await helper.dispatches()).toEqual([
			"prepare",
			"preflight",
			"preflight",
			"prepare",
		]);
		expect(started.attemptId).not.toBe(originalAttempt);
		expect(started.workspace).toMatchObject({ attemptId: started.attemptId });
		expect(started.phase).not.toBe("blocked_unknown");
		const cleared = store
			.events(t.id)
			.filter((e) => e.kind === "preparation_refusal_cleared");
		expect(cleared).toMatchObject([
			{
				data: {
					previousAttemptId: originalAttempt,
					attemptId: started.attemptId,
					operationId: refused.id,
					code: first.code,
					certainty: "before_send",
					preflight: "passed",
				},
			},
		]);
		expect(store.events(t.id).filter((e) => e.kind === "unknown")).toHaveLength(0);
		// The refused claim and its receipt are retained, never replaced.
		const retained = (store as any).db
			.query("SELECT data FROM operations WHERE id=?")
			.get(refused.id);
		expect(JSON.parse(retained.data)).toEqual(refused);
		clean(store.events(t.id));
	} finally {
		store.close();
	}
}, 30000);
test("R2: an unavailable preflight keeps the refused attempt held without unknown or redispatch", async () => {
	const f = await fixture();
	const helper = await countingHelper(f);
	const store = new FleetStore(join(f.dir, "unavailable.sqlite"));
	try {
		store.putNode({
			...f.node,
			workspaceTransport: { command: process.execPath, args: helper.args },
		});
		const t = submit(store, f, "unavailable");
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		await caught(new Fleet(store).start(t.id));
		await f.git("config", "--remove-section", "filter.fleet-refusal");
		await writeFile(helper.unavailable, "");
		for (let i = 0; i < 2; i++) {
			const error = await caught(new Fleet(store).start(t.id));
			expect(error.code).toBe("node_transport_failed");
		}
		expect(await helper.dispatches()).toEqual(["prepare", "preflight", "preflight"]);
		expect(store.task(t.id)).toMatchObject({
			attemptId: t.attemptId,
			held: true,
			phase: "dispatching",
		});
		expect(store.task(t.id)?.workspace).toBeUndefined();
		expect(store.events(t.id).filter((e) => e.kind === "unknown")).toHaveLength(0);
		expect(
			store
				.events(t.id)
				.filter((e) => e.kind === "preparation_reevaluation")
				.map((e) => (e.data as any).outcome),
		).toEqual(["unavailable", "unavailable"]);
		// Once the preflight answers again, the original refusal is cleared normally.
		await rm(helper.unavailable);
		expect((await new Fleet(store).start(t.id)).workspace).toBeDefined();
	} finally {
		store.close();
	}
}, 30000);
test("R2: unknown preparation outcome is never renewed or redispatched", async () => {
	const f = await fixture();
	const helper = await countingHelper(f);
	const store = new FleetStore(join(f.dir, "unknown.sqlite"));
	try {
		store.putNode({
			...f.node,
			workspaceTransport: { command: process.execPath, args: helper.args },
		});
		// The attempt's workspace path already exists: preparation began (the workspace root was
		// ensured) and fails afterwards => unknown, never a refusal.
		const t = submit(store, f, "unknown");
		await mkdir(join(f.workspaceRoot, t.id + "-" + t.attemptId), { recursive: true });
		const first = await new Fleet(store).start(t.id);
		expect(first.phase).toBe("blocked_unknown");
		expect(store.getOperation(t.id, "prepare")?.receipt).toBeUndefined();
		for (let i = 0; i < 2; i++)
			expect((await new Fleet(store).start(t.id)).phase).toBe("blocked_unknown");
		expect(await helper.dispatches()).toEqual(["prepare"]);
		expect(() =>
			store.renewRefusedPreparation(t.id, store.getOperation(t.id, "prepare")!.id),
		).toThrow();
		clean(store.events(t.id));
	} finally {
		store.close();
	}
}, 30000);
test("R2: a claimed preparation without a refusal receipt cannot be renewed", async () => {
	const f = await fixture();
	const store = new FleetStore(join(f.dir, "claim.sqlite"));
	try {
		store.putNode(f.node);
		const t = submit(store, f, "claim");
		const op = store.claimOperation(t.id, "prepare", { attempt: t.attemptId! })!;
		expect(() => store.renewRefusedPreparation(t.id, op.id)).toThrow(
			"Only a lone, proven before_send preparation refusal can be renewed",
		);
		expect(store.task(t.id)?.attemptId).toBe(t.attemptId);
	} finally {
		store.close();
	}
}, 30000);

// R3 ---------------------------------------------------------------------------------------
test("R3: older helper's bare failure envelopes are answered refused/legacy_unspecified with unknown certainty", async () => {
	for (const legacy of ["node_operation_refused", "placement_operation_refused"]) {
		const error = await caught(
			oneShot(process.execPath, ["-e", `console.log(JSON.stringify({ok:false,error:${JSON.stringify(legacy)}}));process.exitCode=1`], {}),
		);
		expect(error).toBeInstanceOf(NodeReplyError);
		expect(error.code).toBe("node_failed:refused:legacy_unspecified");
		expect(error.certainty).toBe("unknown");
		expect(error.reply).toEqual({
			ok: false,
			error: "refused",
			detail: "legacy_unspecified",
			certainty: "unknown",
		});
	}
	// Not the exact legacy answer: still a transport failure.
	for (const script of [
		"console.log(JSON.stringify({ok:false,error:'node_operation_refused'}))",
		"console.log(JSON.stringify({ok:false,error:'node_operation_refused',why:'x'}));process.exitCode=1",
		"console.log(JSON.stringify({ok:false,error:'refused',detail:'legacy_unspecified',certainty:'before_send'}));process.exitCode=1",
		"console.log(JSON.stringify({ok:false,error:'node_operation_refused'}));process.exitCode=2",
	])
		expect(
			await caught(oneShot(process.execPath, ["-e", script], {})),
		).toMatchObject({ code: "node_transport_failed", certainty: "unknown" });
}, 30000);
test("R3: caller treats a legacy answer as unknown outcome: held, audited, never redispatched", async () => {
	const f = await fixture();
	const counter = join(f.dir, "legacy-dispatches");
	const legacy = join(f.dir, "legacy.ts");
	await writeFile(
		legacy,
		`import {appendFileSync} from 'node:fs';await Bun.stdin.text();appendFileSync(${JSON.stringify(counter)},'x\\n');console.log(JSON.stringify({ok:false,error:'node_operation_refused'}));process.exitCode=1;`,
	);
	const store = new FleetStore(join(f.dir, "legacy.sqlite"));
	try {
		store.putNode({
			...f.node,
			workspaceTransport: { command: process.execPath, args: [legacy] },
		});
		const t = submit(store, f, "legacy");
		for (let i = 0; i < 2; i++)
			expect(await new Fleet(store).start(t.id)).toMatchObject({
				phase: "blocked_unknown",
				reason: "node_failed:refused:legacy_unspecified",
				held: true,
			});
		expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
		expect(store.getOperation(t.id, "prepare")?.receipt).toBeUndefined();
	} finally {
		store.close();
	}
}, 30000);

// R4 ---------------------------------------------------------------------------------------
// Bun startup is ~100 ms here, so deadlines leave the helper time to spawn its descendant.
// A detached descendant escapes the helper's job object (Windows) or process group (POSIX)
// and keeps the inherited pipes open; the deadline must not wait for it.
const deadlineMs = 400;
const slackMs = 300;
function holder(lifetimeMs: number, detached: boolean, marker?: string) {
	const body = `${marker ? `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'x'),1500);` : ""}setTimeout(()=>{},${lifetimeMs})`;
	return `Bun.spawn([process.execPath,'-e',${JSON.stringify(body)}],{stdout:'inherit',stderr:'inherit',detached:${detached}});`;
}
async function timed(script: string) {
	const start = performance.now();
	const error = await caught(oneShot(process.execPath, ["-e", script], {}, deadlineMs));
	return { error, elapsedMs: performance.now() - start };
}
test("R4: deadline fires on time although a detached descendant holds the inherited pipes", async () => {
	const { error, elapsedMs } = await timed(holder(3000, true) + "setTimeout(()=>{},5000)");
	expect(error).toMatchObject({ code: "node_timeout", certainty: "unknown" });
	// Before the fix this returned only when the 3000 ms descendant closed the pipes.
	expect(elapsedMs).toBeLessThan(deadlineMs + slackMs);
}, 15000);
test("R4: helper that answered and exited while a descendant still holds the pipes times out on time", async () => {
	const { error, elapsedMs } = await timed(
		holder(3000, true) + "console.log(JSON.stringify({ok:true,value:1}))",
	);
	expect(error).toMatchObject({ code: "node_timeout", certainty: "unknown" });
	expect(elapsedMs).toBeLessThan(deadlineMs + slackMs);
}, 15000);
test("R4: deadline kills the helper's process tree; an ordinary descendant does not survive", async () => {
	const dir = (await repositoryFixture("deadline-")).dir;
	dirs.push(dir);
	const marker = join(dir, "descendant-survived");
	const { error, elapsedMs } = await timed(holder(3000, false, marker) + "setTimeout(()=>{},5000)");
	expect(error).toMatchObject({ code: "node_timeout", certainty: "unknown" });
	expect(elapsedMs).toBeLessThan(deadlineMs + slackMs);
	await Bun.sleep(2000);
	expect(await Bun.file(marker).exists()).toBe(false);
}, 15000);
test("R4: ordinary replies are unaffected by the deadline machinery", async () => {
	expect(
		await oneShot(process.execPath, ["-e", "console.log(JSON.stringify({ok:true,value:{a:1}}))"], {}, 5000),
	).toEqual({ a: 1 });
	const exit = await caught(oneShot(process.execPath, ["-e", "process.exit(1)"], {}));
	expect(exit).toMatchObject({ code: "node_transport_failed", certainty: "unknown" });
});

// Retained reviewer regressions (passed before this lane; must keep passing) -----------------
test("no-leak: secret path, environment, identity and file contents stay out of both helpers' diagnostics", async () => {
	const f = await fixture();
	// The source root's own configuration carries the secret; refusing on it must not echo it.
	await f.git("config", "filter." + secret + ".clean", secret);
	for (const helper of [nodeTs, forwardingTs])
		for (const request of [
			{ action: "prepare", input: f.input },
			{ action: "preflight", input: f.input },
			{ action: "collect", identity: { ...f.identity, nodeId: secret } },
			{ action: "collect", identity: { ...f.identity, path: "/outside/" + secret } },
			{ action: secret },
			{ action: "test", identity: { ...f.identity, extra: secret }, argv: [secret] },
		]) {
			const r = await raw(helper, f.config, JSON.stringify(request));
			expect(r.exit).toBe(1);
			expect(r.reply.certainty).toBe("before_send");
		}
	const log = await readFile(resolve(import.meta.dir, "../src/.node-errors.log"), "utf8").catch(() => "");
	clean(log);
}, 60000);
test("no-leak: partially executed test is failed/unknown, never refused; later collect failure stays unknown", async () => {
	const f = await fixture();
	const marker = join(f.dir, "side-effect");
	const r = await raw(
		nodeTs,
		f.config,
		JSON.stringify({
			action: "test",
			identity: f.identity,
			argv: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write((process.env.REVIEW_SECRET_ENV+'x').repeat(200000))`],
		}),
	);
	expect(await readFile(marker, "utf8")).toBe("ran");
	expect(r.reply).toMatchObject({ error: "output_limit", certainty: "unknown" });
	await writeFile(join(f.identity.path, ".env." + secret), secret);
	const c = await raw(nodeTs, f.config, JSON.stringify({ action: "collect", identity: f.identity }));
	expect(c.reply).toMatchObject({ error: "unsafe_path", certainty: "unknown" });
}, 30000);
test("no-leak: malformed, forged, contradictory and oversized replies never become a refusal", async () => {
	const replies: unknown[] = [
		null,
		[],
		{},
		{ ok: false, error: "nested_repository", detail: secret, certainty: "before_send" },
		{ ok: false, error: "nested_repository", detail: "git_entry", certainty: "before_send", secret },
		{ ok: false, error: "internal", detail: "exception", certainty: "before_send", correlationId: secret },
		{ ok: false, error: "unsafe_path", detail: "unsafe_entry", certainty: "probably" },
		{ ok: false, error: "node_operation_refused", secret },
		{ ok: true, value: secret, extra: true },
	];
	for (const reply of replies) {
		const error = await caught(
			oneShot(process.execPath, ["-e", `console.log(${JSON.stringify(JSON.stringify(reply))});process.exitCode=1`], {}),
		);
		expect(error).toMatchObject({ code: "node_transport_failed", certainty: "unknown" });
	}
	for (const [stream, bytes] of [["stdout", 33 * 1024 * 1024], ["stderr", 2 * 1024 * 1024]] as const) {
		const error = await caught(
			oneShot(process.execPath, ["-e", `process.${stream}.write('x'.repeat(${bytes}));setTimeout(()=>{},2000)`], {}),
		);
		expect(error).toMatchObject({ code: "node_output_limit", certainty: "unknown" });
	}
}, 60000);
test("preflight: passes without creating any workspace, and refuses exactly like prepare", async () => {
	const f = await fixture();
	const input = { ...f.input, attemptId: "preflight-only" };
	const ok = await raw(nodeTs, f.config, JSON.stringify({ action: "preflight", input }));
	expect(ok.exit).toBe(0);
	expect(ok.reply).toEqual({ ok: true, value: { preflight: "passed" } });
	expect(await Bun.file(join(f.workspaceRoot, "task-preflight-only", ".fleet-identity.json")).exists()).toBe(false);
	await f.git("config", "filter.fleet-refusal.clean", "cat");
	for (const action of ["preflight", "prepare"]) {
		const r = await raw(nodeTs, f.config, JSON.stringify({ action, input }));
		expect(r.reply).toEqual({ ok: false, error: "root_denied", detail: "allowlist", certainty: "before_send" });
	}
	expect(await Bun.file(join(f.workspaceRoot, "task-preflight-only", ".fleet-identity.json")).exists()).toBe(false);
}, 30000);
