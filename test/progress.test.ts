// Lane progress (src/progress.ts, Fleet.refreshProgress, FleetStore.recordProgress) through the real code path:
// the real node-side POSIX command runs through the node's registered `ssh` transport, which here is a CONTROLLED
// `ssh` stand-in on PATH (NOT a remote host). The stand-in logs each invocation, runs a `sh -c` progress command
// locally with a controlled `date` (the node clock), and refuses anything else (so an observation Fleet triggers
// shows up as a refused coordinator connection, and the real gjc is never started). Transcripts are GJC 0.19.3
// format lines written into a controlled agent directory with controlled modification times.
// On a Windows hub the stand-in is a compiled Bun program (`ssh.exe`, built once in beforeAll): it runs the POSIX
// command through Git for Windows `sh` (skipped without it) and a win32 node's PowerShell command through
// `cmd.exe /d /c` exactly as given (cmd.exe being Windows OpenSSH's default remote shell). The win32-only tests
// run the real win32 command (PowerShell) against private transcripts under this file's temporary directory;
// GJC_CODING_AGENT_DIR points there for the whole file, so no read can reach the production agent directory.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { observationDigest } from "../src/core";
import { compactTask, watchTasks } from "../src/operator-commands";
import { reconsiderQueue } from "../src/index";
import { getDashboardState } from "../src/dashboard";
import {
	PROGRESS_DEFAULTS,
	PROGRESS_EPISODE_COALESCE_SECONDS,
	PROGRESS_WIN32_SSH_COMMAND_LIMIT,
	parseProgressReply,
	posixProgressScript,
	progressConfig,
	progressInvocation,
	progressOrderToleranceMs,
	progressSessionLimit,
	readNodeProgress,
	runProgressCommand,
	win32ProgressScript,
} from "../src/progress";
import type { NodeConfig, Observation, TaskInput, TaskProgress } from "../src/contracts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { type DiagnosticGuard, installDiagnosticGuard } from "./diagnostic-guard";

const WIN = process.platform === "win32";
/** Many-session progress tests need a long timeout on every host (Git for Windows `sh` is especially slow). */
const MANY = 120_000;
const root = mkdtempSync(join(tmpdir(), "fleet-progress-"));
const bin = join(root, "bin");
const agent = join(root, "agent");
/** The agent dir as the POSIX command sees it (Git for Windows `sh` on a Windows hub: /c/Users/...). */
const posixPath = (path: string) => (WIN ? "/" + path[0]!.toLowerCase() + path.slice(2).replaceAll("\\", "/") : path);
const posixAgent = posixPath(agent);
/**
 * The POSIX node command needs `sh`. On Windows: Git for Windows' usr\bin\sh.exe itself (its bin\sh.exe launcher
 * puts /usr/bin first on PATH, which would hide the controlled `date`).
 */
const gitSh = WIN ? Bun.which("sh") : null;
const SH = gitSh ? [join(dirname(gitSh), "..", "usr", "bin", "sh.exe"), gitSh].find((p) => existsSync(p)) : undefined;
const sessions = join(agent, "sessions", "--work-repo--");
const log = join(root, "ssh.log");
const NODE_NOW = 1_800_000_000; // node clock (s), via the controlled `date`
const HUB0 = Date.parse("2027-01-15T08:00:00.000Z");
const saved = { PATH: process.env.PATH, GJC_CODING_AGENT_DIR: process.env.GJC_CODING_AGENT_DIR };
let guard: DiagnosticGuard;
const stores: FleetStore[] = [];

beforeAll(() => {
	mkdirSync(bin, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	// Every read in this file resolves to its own private agent directory, never the production one.
	process.env.GJC_CODING_AGENT_DIR = agent;
	if (WIN) {
		const built = Bun.spawnSync([process.execPath, "build", "--compile", join(import.meta.dir, "progress-ssh-standin.ts"), "--outfile", join(bin, "ssh.exe")], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		if (built.exitCode !== 0) throw new Error(`ssh stand-in build failed: ${built.stderr.toString()}`);
		if (!SH) throw new Error("Git for Windows sh is required for the POSIX-route tests");
		process.env.FLEET_TEST_BIN = `${bin};${dirname(SH)}`;
		process.env.FLEET_TEST_SH = SH;
	}
	writeFileSync(
		join(bin, "ssh"),
		[
			"#!/bin/sh",
			'for a; do last=$a; done',
			'case "$last" in',
			' "sh -c "*) echo progress >> "$FLEET_TEST_SSH_LOG";;',
			' *) echo other >> "$FLEET_TEST_SSH_LOG"; exit 7;;',
			"esac",
			'case "$FLEET_TEST_MODE" in',
			" timeout) sleep 30;;",
			" flood) head -c 200000 /dev/zero | tr \"\\000\" x; exit 0;;",
			" exit) exit 3;;",
			" garbage) echo not-a-progress-reply; exit 0;;",
			" truncated) echo \"FLEETPROGRESS 1\"; exit 0;;",
			// pad: the real reply, then newlines up to exactly FLEET_TEST_BYTES bytes of stdout (the parser skips blank lines).
			` pad) out=$(PATH="${bin}:$PATH" sh -c "$last"); printf "%s\\n" "$out"; head -c $((FLEET_TEST_BYTES - \${#out} - 1)) /dev/zero | tr "\\000" "\\n"; exit 0;;`,
			"esac",
			`PATH="${bin}:$PATH" exec sh -c "$last"`,
		].join("\n") + "\n",
	);
	writeFileSync(join(bin, "date"), `#!/bin/sh\nif [ -n "$FLEET_TEST_NOW" ]; then echo "$FLEET_TEST_NOW"; else exec /usr/bin/date "$@"; fi\n`);
	chmodSync(join(bin, "ssh"), 0o755);
	chmodSync(join(bin, "date"), 0o755);
	process.env.PATH = `${bin}${delimiter}${saved.PATH}`;
	process.env.FLEET_TEST_SSH_LOG = log;
	guard = installDiagnosticGuard(FleetStore);
});
afterAll(() => {
	guard.uninstall();
	// Windows cannot remove an open database file: close every store first.
	for (const store of stores)
		try {
			store.close();
		} catch {}
	process.env.PATH = saved.PATH;
	if (saved.GJC_CODING_AGENT_DIR === undefined) delete process.env.GJC_CODING_AGENT_DIR;
	else process.env.GJC_CODING_AGENT_DIR = saved.GJC_CODING_AGENT_DIR;
	delete process.env.FLEET_TEST_BIN;
	delete process.env.FLEET_TEST_SH;
	delete process.env.FLEET_TEST_SSH_LOG;
	delete process.env.FLEET_TEST_NOW;
	delete process.env.FLEET_TEST_MODE;
	rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});
afterEach(() => {
	delete process.env.FLEET_TEST_MODE;
	expect(guard.take().violations).toEqual([]);
});

// ---- GJC 0.19.3 transcript lines (format of ~/.gjc/agent/sessions/<dir>/<ts>_<id>.jsonl) -----------------
let seq = 0;
const base = () => ({ id: `e${++seq}`, parentId: null, timestamp: "2027-01-15T07:00:00.000Z" });
const header = (id: string) => ({ type: "session", version: 5, id, timestamp: "2027-01-15T07:00:00.000Z", cwd: "/work/repo" });
// Assistant text that quotes the probed keys: JSON escaping must keep it from ever matching.
const tricky = 'look: "stopReason":"toolUse" {"type":"toolCall" "message":{"role":"user"';
const assistant = (stopReason: string, calls = 0) => ({
	type: "message", ...base(),
	message: {
		role: "assistant",
		content: [{ type: "text", text: tricky }, ...Array.from({ length: calls }, (_, i) => ({ type: "toolCall", id: `call${i}`, name: "bash", arguments: { command: "bun test" } }))],
		api: "anthropic-messages", provider: "anthropic", model: "model",
		providerPayload: { blob: "p".repeat(42_000) },
		usage: { input: 1, output: 1 }, stopReason, timestamp: 1,
	},
});
const toolResult = (i = 0) => ({ type: "message", ...base(), message: { role: "toolResult", toolCallId: `call${i}`, toolName: "bash", content: [{ type: "text", text: tricky }], isError: false, timestamp: 1 } });
const user = () => ({ type: "message", ...base(), message: { role: "user", content: [{ type: "text", text: tricky }], timestamp: 1 } });
const custom = () => ({ type: "custom", ...base(), customType: "discovered_tools", data: {} });
const modelChange = () => ({ type: "model_change", ...base(), role: "default", model: "model" });

function transcript(sessionId: string, entries: object[], ageSeconds: number, name = `2027-01-15T07-00-00-000Z_${sessionId}.jsonl`) {
	const file = join(sessions, name);
	writeFileSync(file, [header(sessionId), ...entries].map((e) => JSON.stringify(e) + "\n").join(""));
	utimesSync(file, NODE_NOW - ageSeconds, NODE_NOW - ageSeconds);
	return file;
}

// ---- hub ------------------------------------------------------------------------------------------------
const node = (id = "n1"): NodeConfig =>
	({
		id, os: "linux", arch: process.arch, roots: { repo: "/repos/repo" }, workspaceRoot: "/work", enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["read", "write"],
		transport: { command: "ssh", args: ["-o", "BatchMode=yes", `fake-${id}`, `env GJC_SDK_BROKER_AUTOSTART=0 GJC_CODING_AGENT_DIR=${posixAgent} gjc`] },
	}) as unknown as NodeConfig;
const input = (key: string): TaskInput => ({ schemaVersion: 1, key, caller: "progress-test", repoId: "repo", baseCommit: "a".repeat(40), prompt: `private ${key}`, required: {} });

function world(options: { progress?: Record<string, number>; nodes?: NodeConfig[] } = {}) {
	const dir = mkdtempSync(join(root, "db-"));
	const dbPath = join(dir, "fleet.db");
	const store = new FleetStore(dbPath);
	stores.push(store);
	for (const n of options.nodes ?? [node()]) guard.exempt(() => store.putNode(n));
	const clock = { now: HUB0 };
	const fleet = new Fleet(store, { clock: () => clock.now, progress: options.progress as any });
	writeFileSync(log, "");
	process.env.FLEET_TEST_NOW = String(NODE_NOW);
	const active = (key: string, sessionId: string = randomUUID()) =>
		guard.exempt(() => {
			const task = store.reserve(store.submit(input(key)).id);
			store.recordSession(task.id, sessionId);
			store.recordTurn(task.id, `turn-${key}`);
			const o: Omit<Observation, "digest" | "eventId"> = { sessionId, turnId: `turn-${key}`, status: "active", terminal: false, evidence: { source: `seed-${key}` } };
			store.observe(task.id, { ...o, eventId: `event-${key}`, digest: observationDigest(o) });
			return { id: task.id as string, sessionId };
		});
	const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
	const progress = (id: string) => store.task(id)!.progress as TaskProgress | undefined;
	const kinds = (id: string) => store.events(id).map((e) => e.kind).filter((k) => k.startsWith("progress_"));
	const advance = (seconds: number) => {
		clock.now += seconds * 1000;
	};
	return { dir, dbPath, store, fleet, clock, active, calls, progress, kinds, advance };
}

describe("verdicts", () => {
	test("progressing, stalled_model, stalled_tool, finished_unobserved and unknown, in one read of the node", async () => {
		const w = world();
		const a = w.active("progressing");
		transcript(a.sessionId, [user(), assistant("toolUse", 1), toolResult()], 30);
		const b = w.active("stalled-model");
		transcript(b.sessionId, [user(), assistant("toolUse", 1), toolResult()], 481);
		const c = w.active("stalled-tool");
		transcript(c.sessionId, [user(), assistant("toolUse", 1)], 2401);
		const d = w.active("finished");
		transcript(d.sessionId, [user(), assistant("stop")], 5);
		const e = w.active("missing");
		const out = await w.fleet.refreshProgress();
		expect(w.calls().filter((c) => c === "progress")).toHaveLength(1);
		expect(out).toHaveLength(5);
		expect(w.progress(a.id)).toMatchObject({ version: 1, verdict: "progressing", lastEntryKind: "awaiting_model", idleSeconds: 30, observedAt: new Date(HUB0).toISOString(), lastProgressAt: new Date(HUB0 - 30_000).toISOString(), nodeWrittenAt: new Date((NODE_NOW - 30) * 1000).toISOString() });
		expect(w.progress(b.id)).toMatchObject({ verdict: "stalled_model", lastEntryKind: "awaiting_model", idleSeconds: 481, stall: { verdict: "stalled_model", since: new Date(HUB0).toISOString() } });
		expect(w.progress(c.id)).toMatchObject({ verdict: "stalled_tool", lastEntryKind: "tool_running", lastStopReason: "toolUse", idleSeconds: 2401 });
		expect(w.progress(d.id)).toMatchObject({ verdict: "finished_unobserved", lastEntryKind: "assistant_final", lastStopReason: "stop", settle: { requestedAt: new Date(HUB0).toISOString() } });
		expect(w.progress(e.id)).toMatchObject({ verdict: "unknown", diagnostic: { source: "Fleet.progress.read", phase: "validate", code: "condition:transcript_missing" } });
		expect(w.progress(e.id)!.lastProgressAt).toBeUndefined();
		for (const p of [a, b, c, d, e].map((t) => w.progress(t.id)!)) expect(p.hint).toBeString();
		// Detection only: phase, hold and reason are untouched, and nothing but the observation of the finished task ran.
		for (const t of [a, b, c, d, e]) expect(w.store.task(t.id)).toMatchObject({ phase: "active" });
		expect(w.calls().filter((c) => c === "other")).toHaveLength(1);
		// One audit event when a stall starts; none for progressing/finished/unknown.
		expect(w.kinds(a.id)).toEqual([]);
		expect(w.kinds(b.id)).toEqual(["progress_stalled"]);
		expect(w.kinds(c.id)).toEqual(["progress_stalled"]);
		expect(w.kinds(d.id)).toEqual([]);
		expect(w.kinds(e.id)).toEqual([]);
		const stalled = w.store.events(c.id).find((ev) => ev.kind === "progress_stalled")!;
		expect(stalled.data).toMatchObject({ verdict: "stalled_tool", thresholdSeconds: 2400, lastEntryKind: "tool_running", idleSeconds: 2401 });
	});

	test("a stall is audited once, stays one episode while nothing is written, recovers on the next write, and a re-stall within the hour continues it", async () => {
		const w = world();
		const t = w.active("episode");
		transcript(t.sessionId, [user()], 600);
		await w.fleet.refreshProgress();
		w.advance(61);
		process.env.FLEET_TEST_NOW = String(NODE_NOW + 61);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model", idleSeconds: 661, stall: { since: new Date(HUB0).toISOString() } });
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		// A model wait becomes a running tool without a stall in between: recovered (audited once no new stall
		// followed within PROGRESS_EPISODE_COALESCE_SECONDS; review r4 F2).
		transcript(t.sessionId, [user(), assistant("toolUse", 1)], 0);
		w.advance(61);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "tool_running", stall: { verdict: "stalled_model", since: new Date(HUB0).toISOString(), recovered: { at: new Date(HUB0 + 122_000).toISOString(), verdict: "progressing" } } });
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		// The tool then hangs within the hour: the same episode continues (coalesced), nothing is audited.
		process.env.FLEET_TEST_NOW = String(NODE_NOW + 2401);
		w.advance(61);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_tool", stall: { verdict: "stalled_tool", since: new Date(HUB0).toISOString(), coalesced: 1 } });
		expect(w.progress(t.id)!.stall!.recovered).toBeUndefined();
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		// A failed read keeps the last facts and the episode, and audits nothing.
		rmSync(join(sessions, `2027-01-15T07-00-00-000Z_${t.sessionId}.jsonl`));
		w.advance(61);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", lastEntryKind: "tool_running", stall: { verdict: "stalled_tool", coalesced: 1 }, diagnostic: { code: "condition:transcript_missing" } });
		expect(w.kinds(t.id)).toHaveLength(1);
	});

	test("finished_unobserved triggers the normal observation once per finished state, again only after the retry interval", async () => {
		const w = world();
		const t = w.active("finished");
		transcript(t.sessionId, [user(), assistant("stop")], 2);
		const out = await w.fleet.refreshProgress();
		expect(out).toEqual([expect.objectContaining({ taskId: t.id, settled: false })]);
		// The normal tolerant observation ran (here: a refused coordinator route, recorded as an abandoned poll).
		expect(w.calls()).toEqual(["progress", "other"]);
		expect(w.store.events(t.id).map((e) => e.kind)).toContain("abandoned_poll");
		expect(w.store.task(t.id)!.phase).toBe("active");
		w.advance(61);
		await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress", "other", "progress"]);
		w.advance(PROGRESS_DEFAULTS.settleRetrySeconds);
		await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress", "other", "progress", "progress", "other"]);
		// poll's own refresh never observes twice.
		w.advance(PROGRESS_DEFAULTS.settleRetrySeconds + 1);
		await w.fleet.refreshProgress([t.id], { settle: false });
		expect(w.calls().at(-1)).toBe("progress");
		// An assistant error/aborted end is finished too.
		transcript(t.sessionId, [user(), assistant("error")], 2);
		w.advance(61);
		await w.fleet.refreshProgress([t.id], { settle: false });
		expect(w.progress(t.id)).toMatchObject({ verdict: "finished_unobserved", lastStopReason: "error" });
	});

	test("a refresh that will not observe (poll) records no settle request, so the next refresh observes at once", async () => {
		const w = world();
		const t = w.active("poll-settle");
		transcript(t.sessionId, [user(), assistant("stop")], 2);
		await w.fleet.refreshProgress([t.id], { settle: false });
		expect(w.progress(t.id)).toMatchObject({ verdict: "finished_unobserved" });
		expect(w.progress(t.id)!.settle).toBeUndefined();
		expect(w.calls()).toEqual(["progress"]);
		// queue reconsider / watch 61 s later (well within settleRetrySeconds): the observation runs now.
		w.advance(61);
		expect(await w.fleet.refreshProgress()).toEqual([expect.objectContaining({ taskId: t.id, settled: false })]);
		expect(w.calls()).toEqual(["progress", "progress", "other"]);
		expect(w.progress(t.id)!.settle).toMatchObject({ requestedAt: new Date(w.clock.now).toISOString() });
	});

	test("blocked_unknown tasks are read; approval_required, terminal, legacy non-UUID sessions are not", async () => {
		const w = world();
		const blocked = w.active("blocked");
		guard.exempt(() => w.store.markUnknown(blocked.id, "seed_unknown"));
		transcript(blocked.sessionId, [user(), assistant("toolUse", 1)], 3000);
		const legacy = w.active("legacy", "session-legacy");
		await w.fleet.refreshProgress();
		expect(w.progress(blocked.id)).toMatchObject({ verdict: "stalled_tool" });
		expect(w.progress(legacy.id)).toBeUndefined();
		expect(w.calls()).toEqual(["progress"]);
	});

	test("queue reconsider is detection only: an approval-contract task whose turn finished stays active, never observed", async () => {
		const w = world();
		const sessionId = randomUUID();
		const id = guard.exempt(() => {
			const task = w.store.reserve(w.store.submit({ ...input("approval-finished"), approvalContract: "sdk-ui-waiter-v1" }).id);
			w.store.recordSession(task.id, sessionId);
			w.store.recordTurn(task.id, "turn-approval");
			const o: Omit<Observation, "digest" | "eventId"> = { sessionId, turnId: "turn-approval", status: "active", terminal: false, evidence: { source: "seed-approval" } };
			w.store.observe(task.id, { ...o, eventId: "event-approval", digest: observationDigest(o) });
			return task.id as string;
		});
		transcript(sessionId, [user(), assistant("stop")], 30);
		// A coordinator that answers: an observation from this Fleet (no approval channel) would reach the approval check.
		let connects = 0;
		(w.fleet as any).connect = async () => {
			connects++;
			return {
				close() {},
				async call(name: string) {
					if (name === "gjc_coordinator_read_turn") return { ok: true, turn: { session_id: sessionId, turn_id: "turn-approval", status: "active" } };
					throw new Error("unexpected_call");
				},
			};
		};
		const before = w.store.task(id)!;
		const events = w.store.events(id).length;
		expect(await reconsiderQueue(w.fleet, async () => new Map())).toEqual([]);
		const after = w.store.task(id)!;
		expect([after.phase, after.held, after.reason]).toEqual(["active", before.held, before.reason]);
		expect(w.progress(id)).toMatchObject({ verdict: "finished_unobserved", lastEntryKind: "assistant_final" });
		expect(w.progress(id)!.settle).toBeUndefined();
		expect(connects).toBe(0);
		expect(w.calls()).toEqual(["progress"]);
		expect(w.store.events(id).slice(events).map((e) => e.kind)).toEqual([]);
	});
	test("review bc9fe983 F1: with node-health gating ON queue reconsider still reads lane progress (same as: queue reconsider is detection only: an approval-contract tas)", async () => {
		const w = world();
		const sessionId = randomUUID();
		const id = guard.exempt(() => {
			const task = w.store.reserve(w.store.submit({ ...input("approval-finished"), approvalContract: "sdk-ui-waiter-v1" }).id);
			w.store.recordSession(task.id, sessionId);
			w.store.recordTurn(task.id, "turn-approval");
			const o: Omit<Observation, "digest" | "eventId"> = { sessionId, turnId: "turn-approval", status: "active", terminal: false, evidence: { source: "seed-approval" } };
			w.store.observe(task.id, { ...o, eventId: "event-approval", digest: observationDigest(o) });
			return task.id as string;
		});
		transcript(sessionId, [user(), assistant("stop")], 30);
		// A coordinator that answers: an observation from this Fleet (no approval channel) would reach the approval check.
		let connects = 0;
		(w.fleet as any).connect = async () => {
			connects++;
			return {
				close() {},
				async call(name: string) {
					if (name === "gjc_coordinator_read_turn") return { ok: true, turn: { session_id: sessionId, turn_id: "turn-approval", status: "active" } };
					throw new Error("unexpected_call");
				},
			};
		};
		const before = w.store.task(id)!;
		const events = w.store.events(id).length;
		((w.store as any).db as Database).exec("CREATE TABLE IF NOT EXISTS node_health_gating (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), operator TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL); INSERT INTO node_health_gating(enabled, operator, reason, at) VALUES (1, 'operator', 'gated progress', 1)");
		expect(w.store.nodeHealthGating().enabled).toBe(true);
		expect(await reconsiderQueue(w.fleet, async () => new Map())).toEqual([]);
		const after = w.store.task(id)!;
		expect([after.phase, after.held, after.reason]).toEqual(["active", before.held, before.reason]);
		expect(w.progress(id)).toMatchObject({ verdict: "finished_unobserved", lastEntryKind: "assistant_final" });
		expect(w.progress(id)!.settle).toBeUndefined();
		expect(connects).toBe(0);
		expect(w.calls()).toEqual(["progress"]);
		expect(w.store.events(id).slice(events).map((e) => e.kind)).toEqual([]);
	});

	test("blocked_unknown is display only: a finished transcript is never observed, not even after the retry interval", async () => {
		const w = world();
		const blocked = w.active("blocked-finished");
		guard.exempt(() => w.store.markUnknown(blocked.id, "seed_unknown"));
		transcript(blocked.sessionId, [user(), assistant("stop")], 30);
		const before = w.store.task(blocked.id)!;
		const events = w.store.events(blocked.id).length;
		for (let i = 0; i < 3; i++) {
			expect(await w.fleet.refreshProgress()).toEqual([{ taskId: blocked.id, progress: expect.objectContaining({ verdict: "finished_unobserved" }) }]);
			w.advance(PROGRESS_DEFAULTS.settleRetrySeconds + 1);
		}
		expect(w.calls()).toEqual(["progress", "progress", "progress"]);
		expect(w.progress(blocked.id)!.settle).toBeUndefined();
		const after = w.store.task(blocked.id)!;
		expect([after.phase, after.held, after.reason]).toEqual(["blocked_unknown", before.held, before.reason]);
		expect(w.store.events(blocked.id).slice(events).map((e) => e.kind)).toEqual([]);
	});

	test("watch --all-active over a blocked_unknown task with a finished transcript: progress lines only, no observation", async () => {
		const w = world();
		const blocked = w.active("blocked-watch");
		guard.exempt(() => w.store.markUnknown(blocked.id, "seed_unknown"));
		transcript(blocked.sessionId, [user(), assistant("stop")], 30);
		// The watch runs while some task is active; its coordinator reports that turn still running.
		const running = w.active("running-watch");
		transcript(running.sessionId, [user()], 10);
		const reads: string[] = [];
		(w.fleet as any).connect = async () => ({
			close() {},
			async call(name: string, args: any) {
				reads.push(`${name} ${args.session_id}`);
				if (name === "gjc_coordinator_read_turn") return { ok: true, turn: { session_id: args.session_id, turn_id: args.turn_id, status: "active" } };
				if (name === "gjc_coordinator_list_questions") return { ok: true, reconciliation: { complete: true }, questions: [] };
				throw new Error("unexpected_call");
			},
		});
		const events = w.store.events(blocked.id).length;
		const lines: any[] = [];
		await watchTasks(w.fleet, { allActive: true, maxPolls: 3, interval: 10, emit: (v) => lines.push(v), sleep: async () => w.advance(PROGRESS_DEFAULTS.settleRetrySeconds + 1) });
		expect(lines.filter((l) => l.observation === "progress").map((l) => [l.taskId, l.verdict])).toEqual([[blocked.id, "finished_unobserved"]]);
		expect(w.calls()).toEqual(["progress", "progress", "progress"]);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.filter((r) => r.endsWith(blocked.sessionId))).toEqual([]);
		expect(w.progress(blocked.id)!.settle).toBeUndefined();
		expect(w.store.task(blocked.id)!.phase).toBe("blocked_unknown");
		expect(w.store.events(blocked.id).slice(events).map((e) => e.kind)).toEqual([]);
	});
});

describe("threshold boundaries (more than the limit; exactly at it is progressing)", () => {
	const cases = [
		[[user()], 479, "progressing"], [[user()], 480, "progressing"], [[user()], 481, "stalled_model"],
		[[user(), assistant("toolUse", 1), toolResult()], 480, "progressing"], [[user(), assistant("toolUse", 1), toolResult()], 481, "stalled_model"],
		[[user(), assistant("toolUse", 1)], 2399, "progressing"], [[user(), assistant("toolUse", 1)], 2400, "progressing"], [[user(), assistant("toolUse", 1)], 2401, "stalled_tool"],
		[[user(), modelChange()], 481, "stalled_model"], [[user(), assistant("toolUse", 1), modelChange()], 2401, "stalled_tool"],
	] as const;
	for (const [entries, age, verdict] of cases)
		test(`${(entries.at(-1) as any).message?.role ?? (entries.at(-1) as any).type} idle ${age}s -> ${verdict}`, async () => {
			const w = world();
			const t = w.active(`edge-${age}`);
			transcript(t.sessionId, [...entries], age);
			await w.fleet.refreshProgress();
			expect(w.progress(t.id)).toMatchObject({ verdict, idleSeconds: age });
		});

	test("configured thresholds (CLI --stall-*-seconds) at, -1 and +1", async () => {
		const w = world({ progress: { modelStallSeconds: 60, toolStallSeconds: 120 } });
		const ids = [59, 60, 61].map((age) => { const t = w.active(`m${age}`); transcript(t.sessionId, [user()], age); return [t.id, age] as const; });
		const tools = [119, 120, 121].map((age) => { const t = w.active(`t${age}`); transcript(t.sessionId, [user(), assistant("toolUse", 1)], age); return [t.id, age] as const; });
		await w.fleet.refreshProgress();
		expect(ids.map(([id]) => w.progress(id)!.verdict)).toEqual(["progressing", "progressing", "stalled_model"]);
		expect(tools.map(([id]) => w.progress(id)!.verdict)).toEqual(["progressing", "progressing", "stalled_tool"]);
		expect(w.progress(ids[0]![0])!.thresholds).toEqual({ modelSeconds: 60, toolSeconds: 120 });
		expect(() => progressConfig({ modelStallSeconds: 0 })).toThrow("invalid_progress_modelStallSeconds");
		expect(() => progressConfig({ toolStallSeconds: 1.5 })).toThrow("invalid_progress_toolStallSeconds");
	});
});

describe("long test run", () => {
	test("a 39-minute single tool and a parallel batch whose other tool already finished are not flagged", async () => {
		const w = world();
		const single = w.active("single");
		transcript(single.sessionId, [user(), assistant("toolUse", 1)], 39 * 60);
		// Two parallel tools: the quick one wrote its result (with an unrelated entry in between), the test run goes on.
		const batch = w.active("batch");
		transcript(batch.sessionId, [user(), assistant("toolUse", 2), custom(), toolResult(0)], 30 * 60);
		// Same batch, both results in: now waiting for the model, flagged past 8 minutes.
		const done = w.active("done");
		transcript(done.sessionId, [user(), assistant("toolUse", 2), toolResult(0), custom(), toolResult(1)], 9 * 60);
		await w.fleet.refreshProgress();
		expect(w.progress(single.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "tool_running" });
		expect(w.progress(batch.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "tool_running" });
		expect(w.progress(done.id)).toMatchObject({ verdict: "stalled_model", lastEntryKind: "awaiting_model" });
		expect(w.kinds(single.id)).toEqual([]);
		expect(w.kinds(batch.id)).toEqual([]);
	});
});

describe("a finished turn followed only by non-message entries", () => {
	test("is finished_unobserved (never stalled_model); a model wait or a tool result before them is not", async () => {
		const w = world();
		const cases = [
			["stop-model-change", [user(), assistant("stop"), modelChange()], { verdict: "finished_unobserved", lastEntryKind: "assistant_final", lastStopReason: "stop" }],
			["aborted-custom-model-change", [user(), assistant("aborted"), custom(), modelChange()], { verdict: "finished_unobserved", lastEntryKind: "assistant_final", lastStopReason: "aborted" }],
			["user-model-change", [user(), assistant("stop"), user(), modelChange()], { verdict: "stalled_model", lastEntryKind: "other" }],
			["tool-result-custom", [user(), assistant("toolUse", 1), toolResult(), custom()], { verdict: "stalled_model", lastEntryKind: "other" }],
			["tool-use-custom", [user(), assistant("toolUse", 1), custom()], { verdict: "progressing", lastEntryKind: "tool_running" }],
		] as const;
		const ids = cases.map(([key, entries]) => {
			const t = w.active(key);
			transcript(t.sessionId, [...entries], 600);
			return t.id;
		});
		await w.fleet.refreshProgress(undefined, { settle: false });
		cases.forEach(([, , expected], i) => expect(w.progress(ids[i]!)).toMatchObject({ ...expected, idleSeconds: 600 }));
		expect(w.kinds(ids[0]!)).toEqual([]);
		expect(w.kinds(ids[1]!)).toEqual([]);
	});

	test("triggers the normal observation of an active task like a finished last line", async () => {
		const w = world();
		const t = w.active("finished-then-custom");
		transcript(t.sessionId, [user(), assistant("stop"), custom()], 600);
		expect(await w.fleet.refreshProgress()).toEqual([expect.objectContaining({ taskId: t.id, settled: false })]);
		expect(w.calls()).toEqual(["progress", "other"]);
		expect(w.progress(t.id)).toMatchObject({ verdict: "finished_unobserved", settle: { requestedAt: new Date(HUB0).toISOString() } });
	});
});

describe("more than the read window after an open parallel batch", () => {
	test("the pending count is unknown, so the tool limit applies (never a model stall while a tool may run)", async () => {
		const w = world();
		const filler = Array.from({ length: 70 }, () => custom());
		// The batch's assistant line lies before the last 64 lines; one result came in after the filler.
		const open = w.active("window-open");
		transcript(open.sessionId, [user(), assistant("toolUse", 3), toolResult(0), ...filler, toolResult(1)], 600);
		const hung = w.active("window-hung");
		transcript(hung.sessionId, [user(), assistant("toolUse", 3), toolResult(0), ...filler], 2401);
		// Control: the batch's assistant line inside the window is counted exactly.
		const counted = w.active("window-counted");
		transcript(counted.sessionId, [user(), ...filler, assistant("toolUse", 2), toolResult(0), custom()], 600);
		await w.fleet.refreshProgress();
		expect(w.progress(open.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "other", pendingToolsUnknown: true, idleSeconds: 600 });
		expect(w.progress(hung.id)).toMatchObject({ verdict: "stalled_tool", lastEntryKind: "other", pendingToolsUnknown: true, idleSeconds: 2401 });
		expect(w.store.events(hung.id).find((e) => e.kind === "progress_stalled")!.data).toMatchObject({ verdict: "stalled_tool", thresholdSeconds: 2400 });
		expect(w.progress(counted.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "tool_running" });
		expect(w.progress(counted.id)!.pendingToolsUnknown).toBeUndefined();
		expect(w.kinds(open.id)).toEqual([]);
	});
});

describe("clocks", () => {
	test("hub/node skew does not change the age; the offset is recorded", async () => {
		const w = world();
		const t = w.active("skew");
		transcript(t.sessionId, [user()], 100);
		w.clock.now = HUB0 - 3 * 3600_000; // hub 3 h behind the node
		await w.fleet.refreshProgress();
		const p = w.progress(t.id)!;
		expect(p).toMatchObject({ verdict: "progressing", idleSeconds: 100 });
		expect(p.nodeClockOffsetSeconds).toBe(NODE_NOW - Math.floor(w.clock.now / 1000));
		expect(p.lastProgressAt).toBe(new Date(w.clock.now - 100_000).toISOString());
	});

	test("a transcript in the node's future: within tolerance it is age 0, beyond it is unknown", async () => {
		const w = world();
		const near = w.active("near");
		transcript(near.sessionId, [user()], -120);
		const far = w.active("far");
		transcript(far.sessionId, [user()], -121);
		await w.fleet.refreshProgress();
		expect(w.progress(near.id)).toMatchObject({ verdict: "progressing", idleSeconds: 0 });
		expect(w.progress(far.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "validate", errorClass: "none", code: "condition:progress_clock_inconsistent" } });
	});

	test("the hub clock stepping back: the record advances, and the rate limit holds on both sides of the step", async () => {
		const w = world();
		const t = w.active("back");
		transcript(t.sessionId, [user()], 10);
		await w.fleet.refreshProgress();
		// A record from the hub's own near future (step back of 30 s) is "read recently": no node command.
		w.advance(-30);
		await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress"]);
		// A step back of an hour: the session meanwhile idles 600 s on the node and the record shows it.
		w.advance(-3600 + 30);
		process.env.FLEET_TEST_NOW = String(NODE_NOW + 600);
		await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress", "progress"]);
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model", idleSeconds: 610, observedAt: new Date(w.clock.now).toISOString(), readStartedAt: new Date(w.clock.now).toISOString() });
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		// Polling every 2 s from the stepped-back clock: rate-limited again, not one node command per poll.
		for (let i = 0; i < 5; i++) {
			w.advance(2);
			await w.fleet.refreshProgress();
		}
		expect(w.calls()).toHaveLength(2);
	});

	test("the hub clock stepping back 100 s (between the read interval and the order tolerance): no node command until the interval has passed", async () => {
		const w = world();
		const t = w.active("back-100");
		transcript(t.sessionId, [user()], 10);
		await w.fleet.refreshProgress();
		w.advance(-100);
		// Polling every 2 s for 158 s: the stored read stays ahead of the clock or within the interval.
		for (let i = 0; i < 79; i++) {
			w.advance(2);
			await w.fleet.refreshProgress();
		}
		expect(w.clock.now).toBe(HUB0 + 58_000);
		expect(w.calls()).toEqual(["progress"]);
		w.advance(2);
		process.env.FLEET_TEST_NOW = String(NODE_NOW + 60);
		await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress", "progress"]);
		expect(w.progress(t.id)).toMatchObject({ idleSeconds: 70, observedAt: new Date(HUB0 + 60_000).toISOString() });
	}, MANY);

	test("a stored read ahead of the hub clock by exactly the order tolerance is not read again; by 1 ms more it is read and replaced", async () => {
		const tolerance = progressOrderToleranceMs(progressConfig());
		for (const [ahead, reads] of [[tolerance, 1], [tolerance + 1, 2]] as const) {
			const w = world();
			const t = w.active(`ahead-${ahead}`);
			transcript(t.sessionId, [user()], 10);
			await w.fleet.refreshProgress();
			w.clock.now = HUB0 - ahead;
			await w.fleet.refreshProgress();
			expect(w.calls()).toHaveLength(reads);
			expect(w.progress(t.id)!.readStartedAt).toBe(new Date(reads === 1 ? HUB0 : HUB0 - ahead).toISOString());
		}
	});

	test("read ordering: a stored read issued up to the tolerance after this one wins; beyond it the clock stepped back", () => {
		const w = world();
		const t = w.active("order-tolerance");
		const task = w.store.task(t.id)!;
		const tolerance = progressOrderToleranceMs(w.fleet.progressConfig);
		expect(tolerance).toBe(PROGRESS_DEFAULTS.win32TimeoutMs + 120_000);
		const read = (startedAt: number) => ({ attemptId: task.attemptId!, sessionId: t.sessionId, startedAt, observedAt: startedAt + 10, config: w.fleet.progressConfig });
		const ok = (idleSeconds: number) => ({ ok: true as const, kind: "awaiting_model" as const, idleSeconds, writtenAt: NODE_NOW - idleSeconds, nodeNow: NODE_NOW });
		expect(w.store.recordProgress(t.id, read(HUB0), ok(5)).recorded).toBe(true);
		expect(w.store.recordProgress(t.id, read(HUB0 - tolerance), ok(6)).recorded).toBe(false);
		expect(w.progress(t.id)).toMatchObject({ idleSeconds: 5 });
		expect(w.store.recordProgress(t.id, read(HUB0 - tolerance - 1), ok(7)).recorded).toBe(true);
		expect(w.progress(t.id)).toMatchObject({ idleSeconds: 7, readStartedAt: new Date(HUB0 - tolerance - 1).toISOString() });
	});
});

describe("transcript and node failures (verdict unknown with a deny-by-default diagnostic)", () => {
	test("missing, unreadable, ambiguous, a directory, an empty file", async () => {
		const w = world();
		const missing = w.active("missing");
		const unreadable = w.active("unreadable");
		chmodSync(transcript(unreadable.sessionId, [user()], 10), 0o000);
		const ambiguous = w.active("ambiguous");
		transcript(ambiguous.sessionId, [user()], 10);
		mkdirSync(join(agent, "sessions", "--other--"), { recursive: true });
		writeFileSync(join(agent, "sessions", "--other--", `x_${ambiguous.sessionId}.jsonl`), "");
		const directory = w.active("directory");
		mkdirSync(join(sessions, `x_${directory.sessionId}.jsonl`));
		const empty = w.active("empty");
		writeFileSync(join(sessions, `x_${empty.sessionId}.jsonl`), "");
		utimesSync(join(sessions, `x_${empty.sessionId}.jsonl`), NODE_NOW - 900, NODE_NOW - 900);
		await w.fleet.refreshProgress();
		const code = (id: string) => (w.progress(id)!.diagnostic as any)?.code;
		expect(code(missing.id)).toBe("condition:transcript_missing");
		// chmod 000 denies reading only on POSIX (Windows keeps the file readable; root reads anyway).
		const denied = !WIN && process.getuid?.() !== 0;
		if (denied) expect(code(unreadable.id)).toBe("condition:transcript_unreadable");
		expect(code(ambiguous.id)).toBe("condition:transcript_ambiguous");
		expect(code(directory.id)).toBe("condition:transcript_unreadable");
		// An empty transcript is read (no entry yet): a session that never wrote is a model wait.
		expect(w.progress(empty.id)).toMatchObject({ verdict: "stalled_model", lastEntryKind: "none" });
		for (const t of [missing, ...(denied ? [unreadable] : []), ambiguous, directory]) expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { version: 1, use: "diagnostic_only_not_evidence", source: "Fleet.progress.read" } });
		expect(w.calls()).toEqual(["progress"]);
	});

	test("node timeout, output limit, non-zero exit, invalid and truncated replies", async () => {
		const expected = {
			timeout: ["call", "TransportError", "transport:progress_timeout"],
			flood: ["call", "TransportError", "transport:progress_output_limit"],
			exit: ["call", "TransportError", "transport:progress_exit"],
			garbage: ["validate", "TransportError", "transport:progress_reply_invalid"],
			truncated: ["validate", "TransportError", "transport:progress_reply_invalid"],
		} as const;
		for (const [mode, [phase, errorClass, code]] of Object.entries(expected)) {
			// Only the deliberately blocked POSIX stand-in needs a shorter wait.
			// Keep the existing Windows startup allowance and non-timeout deadlines.
			const posixTimeoutMs = mode === "timeout" && !WIN ? 150 : 400;
			const w = world({ progress: { posixTimeoutMs } });
			const a = w.active(`${mode}-a`);
			const b = w.active(`${mode}-b`);
			transcript(a.sessionId, [user()], 10);
			transcript(b.sessionId, [user()], 10);
			process.env.FLEET_TEST_MODE = mode;
			const started = Date.now();
			await w.fleet.refreshProgress();
			expect(Date.now() - started).toBeLessThan(5000);
			for (const t of [a, b]) {
				expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { source: "Fleet.progress.read", phase, errorClass, code } });
				expect(w.store.task(t.id)!.phase).toBe("active");
				expect(w.kinds(t.id)).toEqual([]);
			}
			// Never retried within the interval; one command for both sessions.
			await w.fleet.refreshProgress();
			expect(w.calls()).toEqual(["progress"]);
		}
	});

	test("no registered route: an OS this hub cannot run, a non-ssh foreign route", async () => {
		const w = world({ nodes: [{ ...node("w1"), os: process.platform === "win32" ? "linux" : "win32", transport: { command: "gjc", args: [] } } as unknown as NodeConfig] });
		const t = w.active("route");
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "precondition", errorClass: "none", code: "condition:progress_route_unavailable" } });
		expect(w.calls()).toEqual([]);
	});
});

describe("one bounded command per node", () => {
	test("30 sessions on one node are read in one call; a second node gets its own call", async () => {
		const w = world({ nodes: [node("n1")] });
		const tasks = Array.from({ length: 30 }, (_, i) => w.active(`many-${i}`));
		tasks.forEach((t, i) => transcript(t.sessionId, [user(), assistant("toolUse", 1)], i * 100));
		const out = await w.fleet.refreshProgress();
		expect(w.calls()).toEqual(["progress"]);
		expect(out).toHaveLength(30);
		tasks.forEach((t, i) => expect(w.progress(t.id)).toMatchObject({ idleSeconds: i * 100, verdict: i * 100 > 2400 ? "stalled_tool" : "progressing" }));
		// Rate limit: within minIntervalSeconds nothing is read again, after it everything once more.
		w.advance(59);
		expect(await w.fleet.refreshProgress()).toEqual([]);
		w.advance(1);
		expect(await w.fleet.refreshProgress()).toHaveLength(30);
		expect(w.calls()).toEqual(["progress", "progress"]);
	}, MANY);

	test("more than the per-command limit: least recently read first, the rest on the next pass", async () => {
		const w = world();
		const tasks = Array.from({ length: 70 }, (_, i) => w.active(`limit-${i}`));
		for (const t of tasks) transcript(t.sessionId, [user()], 5);
		expect(await w.fleet.refreshProgress()).toHaveLength(64);
		expect(tasks.filter((t) => w.progress(t.id)).length).toBe(64);
		w.advance(1);
		expect(await w.fleet.refreshProgress()).toHaveLength(6);
		expect(tasks.every((t) => w.progress(t.id))).toBe(true);
		expect(w.calls()).toEqual(["progress", "progress"]);
	}, MANY);

	for (const [count, passes] of [[63, [63]], [64, [64]], [65, [64, 1]]] as const)
		test(`${count} sessions on one node: ${passes.join(" + ")} per pass`, async () => {
			const w = world();
			const tasks = Array.from({ length: count }, (_, i) => w.active(`cap-${count}-${i}`));
			for (const t of tasks) transcript(t.sessionId, [user()], 5);
			const seen: number[] = [];
			for (const _ of passes) {
				seen.push((await w.fleet.refreshProgress()).length);
				w.advance(1);
			}
			expect(seen).toEqual([...passes]);
			expect(await w.fleet.refreshProgress()).toEqual([]);
			expect(w.calls()).toHaveLength(passes.length);
		}, MANY);

	for (const [bytes, ok] of [[64 * 1024 - 1, true], [64 * 1024, true], [64 * 1024 + 1, false]] as const)
		test(`stdout of ${bytes} bytes (limit 65536): ${ok ? "read" : "progress_output_limit"}`, async () => {
			const w = world();
			const t = w.active(`bytes-${bytes}`);
			transcript(t.sessionId, [user()], 5);
			process.env.FLEET_TEST_MODE = "pad";
			process.env.FLEET_TEST_BYTES = String(bytes);
			try {
				await w.fleet.refreshProgress();
			} finally {
				delete process.env.FLEET_TEST_BYTES;
			}
			if (ok) expect(w.progress(t.id)).toMatchObject({ verdict: "progressing", idleSeconds: 5 });
			else expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { code: "transport:progress_output_limit" } });
		});

	test("the node command never runs gjc, never prints transcript text, and has a win32 variant with the same protocol", () => {
		const id = randomUUID();
		const sh = posixProgressScript([id], posixAgent);
		expect(sh).not.toContain("'");
		expect(sh).toContain("GJC_SDK_BROKER_AUTOSTART=0");
		expect(sh).not.toMatch(/(^|[\s;|(])gjc(\s|$)/m);
		const ps = win32ProgressScript([id], "C:\\Users\\op\\.gjc\\agent");
		expect(ps).toContain("$env:GJC_SDK_BROKER_AUTOSTART='0'");
		expect(ps).toContain("[IO.FileShare]'ReadWrite,Delete'");
		expect(ps).not.toMatch(/\bgjc\s/);
		const win = progressInvocation({ ...node("w"), os: "win32", transport: { command: "ssh", args: ["w-host", "cmd.exe /c gjc"] } } as unknown as NodeConfig, [id], progressConfig());
		expect(win.argv.slice(0, 2)).toEqual(["ssh", "w-host"]);
		expect(win.argv[2]).toStartWith("powershell -NoProfile -NonInteractive -EncodedCommand ");
		expect(win.timeoutMs).toBe(PROGRESS_DEFAULTS.win32TimeoutMs);
		const wsl = progressInvocation({ ...node("l"), transport: { command: "ssh", args: ["w-host", "wsl.exe -d Ubuntu -- gjc"] } } as unknown as NodeConfig, [id], progressConfig());
		expect(wsl.argv[1]).toBe("w-host");
		expect(wsl.argv[2]).toStartWith("wsl.exe -d Ubuntu -- sh -c '");
		expect(() => posixProgressScript(["not-a-uuid"])).toThrow("progress_session_id_invalid");
		expect(() => posixProgressScript([id], "/x;rm -rf /")).toThrow("progress_agent_dir_invalid");
	});
});

describe("store safety", () => {
	test("only the progress field changes; no result is externalised; user_version is unchanged", async () => {
		const w = world();
		guard.exempt(() => w.store.enableResultStore({ actor: "test", reason: "result store on, as in production" }));
		const t = w.active("safety");
		transcript(t.sessionId, [user()], 900);
		const userVersion = () => {
			const db = new Database(w.dbPath, { readonly: true });
			try {
				return (db.query("PRAGMA user_version").get() as any).user_version as number;
			} finally {
				db.close();
			}
		};
		const before = userVersion();
		const { progress: _, ...rowBefore } = w.store.task(t.id)!;
		const eventsBefore = w.store.events(t.id).length;
		await w.fleet.refreshProgress();
		const { progress, ...rowAfter } = w.store.task(t.id)!;
		expect(progress).toMatchObject({ verdict: "stalled_model" });
		expect(rowAfter).toEqual(rowBefore);
		expect(w.store.events(t.id).slice(eventsBefore).map((e) => e.kind)).toEqual(["progress_stalled"]);
		expect(userVersion()).toBe(before);
		const db = new Database(w.dbPath, { readonly: true });
		try {
			expect((db.query("SELECT count(*) AS n FROM audit WHERE kind LIKE 'result_store_format%'").get() as any).n).toBe(0);
		} finally {
			db.close();
		}
	});

	test("an older read completing after a newer one, or after the task left its attempt/phase, is ignored", async () => {
		const w = world();
		const t = w.active("order");
		const task = w.store.task(t.id)!;
		const read = (startedAt: number) => ({ attemptId: task.attemptId!, sessionId: t.sessionId, startedAt, observedAt: startedAt + 10, config: w.fleet.progressConfig });
		const ok = (idleSeconds: number) => ({ ok: true as const, kind: "awaiting_model" as const, idleSeconds, writtenAt: NODE_NOW - idleSeconds, nodeNow: NODE_NOW });
		expect(w.store.recordProgress(t.id, read(HUB0 + 1000), ok(5)).recorded).toBe(true);
		expect(w.store.recordProgress(t.id, read(HUB0), ok(900)).recorded).toBe(false);
		expect(w.store.recordProgress(t.id, read(HUB0 + 1000), ok(900)).recorded).toBe(false);
		expect(w.progress(t.id)).toMatchObject({ verdict: "progressing", idleSeconds: 5 });
		expect(w.store.recordProgress(t.id, { ...read(HUB0 + 2000), attemptId: "other" }, ok(900)).recorded).toBe(false);
		guard.exempt(() => w.store.observe(t.id, { sessionId: t.sessionId, turnId: "turn-order", status: "succeeded", terminal: true, evidence: { source: "x" }, eventId: "e-done", digest: observationDigest({ sessionId: t.sessionId, turnId: "turn-order", status: "succeeded", terminal: true, evidence: { source: "x" } }) }));
		expect(w.store.recordProgress(t.id, read(HUB0 + 3000), ok(900)).recorded).toBe(false);
		expect(w.kinds(t.id)).toEqual([]);
	});

	test("overlapping refreshes: both may read, each task ends with one consistent record and one stall event", async () => {
		const w = world();
		const tasks = Array.from({ length: 5 }, (_, i) => w.active(`overlap-${i}`));
		for (const t of tasks) transcript(t.sessionId, [user()], 1000);
		const fleet2 = new Fleet(w.store, { clock: () => w.clock.now + 1 });
		await Promise.all([w.fleet.refreshProgress(), fleet2.refreshProgress()]);
		for (const t of tasks) {
			expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model" });
			expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		}
	});

	test("a store filled to SQLITE_FULL: the caller never fails and nothing but progress can change", async () => {
		const w = world();
		const t = w.active("full");
		transcript(t.sessionId, [user()], 900);
		const { progress: _, ...before } = w.store.task(t.id)!;
		const db = (w.store as any).db as Database;
		db.exec("CREATE TABLE filler(x BLOB)");
		db.exec(`PRAGMA max_page_count=${(db.query("PRAGMA page_count").get() as any).page_count + 4}`);
		let full = false;
		for (let i = 0; i < 10_000 && !full; i++)
			try {
				db.query("INSERT INTO filler VALUES (randomblob(256))").run();
			} catch (error) {
				full = /full/i.test(String(error));
			}
		expect(full).toBe(true);
		await w.fleet.refreshProgress();
		const { progress, ...after } = w.store.task(t.id)!;
		expect(after).toEqual(before);
		expect([undefined, "stalled_model"]).toContain(progress?.verdict);
		db.exec("DROP TABLE filler");
		db.exec("PRAGMA max_page_count=1073741823");
	});

	test("a refused progress write (store error) leaves the task unchanged and the caller does not fail", async () => {
		const w = world();
		const t = w.active("refused");
		transcript(t.sessionId, [user()], 900);
		const before = w.store.task(t.id);
		const db = (w.store as any).db as Database;
		db.exec("CREATE TRIGGER deny_progress BEFORE UPDATE ON tasks WHEN json_type(NEW.data,'$.progress') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END");
		expect(await w.fleet.refreshProgress()).toEqual([]);
		expect(w.store.task(t.id)).toEqual(before);
		expect(w.store.events(t.id).map((e) => e.kind)).toContain("refused");
		expect(w.kinds(t.id)).toEqual([]);
		db.exec("DROP TRIGGER deny_progress");
		w.advance(1);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model" });
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
	});

	test("a read-only store never reads or writes", async () => {
		const w = world();
		const t = w.active("ro");
		transcript(t.sessionId, [user()], 1000);
		w.store.close();
		const ro = new FleetStore(w.dbPath, undefined, { readOnly: true });
		try {
			expect(await new Fleet(ro).refreshProgress()).toEqual([]);
			expect(w.calls()).toEqual([]);
		} finally {
			ro.close();
		}
	});
});

describe("surfaces", () => {
	test("tasks --compact marker, observability counts, dashboard field, watch line; legacy rows unchanged", async () => {
		const w = world();
		const legacy = w.active("legacy-row", "session-legacy-row");
		const quiet = w.active("quiet");
		transcript(quiet.sessionId, [user()], 10);
		const compactBefore = [legacy, quiet].map((t) => compactTask(w.store, w.store.taskState(t.id)!, HUB0));
		const observabilityBefore = w.store.observability() as any;
		expect(observabilityBefore.progress).toBeUndefined();
		const stuck = w.active("stuck");
		transcript(stuck.sessionId, [user(), assistant("toolUse", 1)], 2500);
		const finished = w.active("finished-row");
		transcript(finished.sessionId, [user(), assistant("stop")], 1);
		await w.fleet.refreshProgress(undefined, { settle: false });
		w.store.close();
		const store = new FleetStore(w.dbPath);
		try {
			// Nothing flagged: the compact line is byte-identical (6 columns); flagged lines gain one column.
			expect([legacy, quiet].map((t) => compactTask(store, store.taskState(t.id)!, HUB0))).toEqual(compactBefore);
			expect(compactTask(store, store.taskState(stuck.id)!, HUB0 + 60_000).split("\t")).toHaveLength(7);
			expect(compactTask(store, store.taskState(stuck.id)!, HUB0 + 60_000).split("\t").at(-1)).toBe("STALLED_TOOL:2560s");
			expect(compactTask(store, store.taskState(finished.id)!, HUB0).split("\t").at(-1)).toBe("FINISHED_UNOBSERVED");
			const obs = store.observability() as any;
			expect(obs.progress.counts).toEqual({ progressing: 1, stalled_model: 0, stalled_tool: 1, finished_unobserved: 1, unknown: 0 });
			expect(obs.progress.flagged.map((f: any) => [f.taskId, f.verdict])).toEqual([[stuck.id, "stalled_tool"], [finished.id, "finished_unobserved"]]);
			expect(obs.warnings).toEqual(expect.arrayContaining([{ reason: "progress_stalled_tool", count: 1 }, { reason: "progress_finished_unobserved", count: 1 }]));
			const dash = getDashboardState(store);
			const byId = new Map(dash.tasks.map((t: any) => [t.id, t]));
			expect(byId.get(legacy.id).progress).toBeUndefined();
			expect(byId.get(stuck.id).progress).toMatchObject({ verdict: "stalled_tool", lastEntryKind: "tool_running" });
			expect(byId.get(stuck.id).progress.secondsSinceProgress).toBeNumber();
			// watch --all-active: one progress line per new flagged state, not one per poll.
			const lines: any[] = [];
			const clock = { now: HUB0 + 61_000 };
			const fleet = new Fleet(store, { clock: () => clock.now });
			await watchTasks(fleet, { allActive: true, maxPolls: 3, interval: 10, emit: (v) => lines.push(v), sleep: async () => { clock.now += 61_000; } });
			const progressLines = lines.filter((l) => l.observation === "progress");
			expect(progressLines.map((l) => [l.taskId, l.verdict])).toEqual(expect.arrayContaining([[stuck.id, "stalled_tool"], [finished.id, "finished_unobserved"]]));
			expect(progressLines.filter((l) => l.taskId === stuck.id)).toHaveLength(1);
			expect(progressLines.some((l) => l.taskId === quiet.id)).toBe(false);
			// queue reconsider refreshes too (no queued task: admission is a no-op).
			clock.now += 61_000;
			writeFileSync(log, "");
			await reconsiderQueue(fleet, async () => new Map());
			expect(w.calls().filter((c) => c === "progress")).toHaveLength(1);
		} finally {
			store.close();
		}
	});
});

describe("settled tasks", () => {
	test("a settled task's progress record is dropped and not shown by show, tasks or the dashboard", async () => {
		const w = world();
		const done = w.active("settled-stalled");
		transcript(done.sessionId, [user()], 900);
		const live = w.active("live-stalled");
		transcript(live.sessionId, [user()], 900);
		await w.fleet.refreshProgress();
		expect(w.progress(done.id)).toMatchObject({ verdict: "stalled_model" });
		const o: Omit<Observation, "digest" | "eventId"> = { sessionId: done.sessionId, turnId: "turn-settled-stalled", status: "succeeded", terminal: true, evidence: { source: "x" } };
		guard.exempt(() => w.store.observe(done.id, { ...o, eventId: "e-settled", digest: observationDigest(o) }));
		// The record is dropped with the terminal execution (review r4 F2) and is no longer displayed.
		expect(w.store.task(done.id)!.phase).not.toBe("active");
		expect(w.store.task(done.id)!.result?.executionTerminal).toBe(true);
		expect(w.progress(done.id)).toBeUndefined();
		expect(w.progress(live.id)).toMatchObject({ verdict: "stalled_model" });
		const dash = new Map(getDashboardState(w.store).tasks.map((t: any) => [t.id, t]));
		expect(dash.get(done.id).progress).toBeUndefined();
		expect(dash.get(live.id).progress).toMatchObject({ verdict: "stalled_model" });
		w.store.close();
		const cli = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", w.dbPath, "--read-only", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
			const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			expect(code).toBe(0);
			return JSON.parse(out);
		};
		expect((await cli("show", done.id)).progress).toBeUndefined();
		expect((await cli("show", live.id)).progress).toMatchObject({ verdict: "stalled_model" });
		const listed = new Map(((await cli("tasks")) as any[]).map((t) => [t.id, t]));
		expect(listed.get(done.id).progress).toBeUndefined();
		expect(listed.get(live.id).progress).toMatchObject({ verdict: "stalled_model" });
	});
});

describe("agent dir of the route", () => {
	test("a quoted or escaped embedded GJC_CODING_AGENT_DIR is refused, never read truncated", async () => {
		const quoted = `env GJC_CODING_AGENT_DIR="${posixAgent} x" gjc`;
		const w = world({ nodes: [{ ...node("q1"), transport: { command: "ssh", args: ["fake-q1", quoted] } } as unknown as NodeConfig] });
		const t = w.active("quoted");
		transcript(t.sessionId, [user()], 10);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "precondition", code: "condition:progress_route_unavailable" } });
		expect(w.calls()).toEqual([]);
		const id = randomUUID();
		for (const last of [`set GJC_CODING_AGENT_DIR='C:\\x y'&& gjc`, "env GJC_CODING_AGENT_DIR= gjc", "env GJC_CODING_AGENT_DIR=C:\\a^ b gjc"])
			expect(() => progressInvocation({ ...node("q2"), os: "win32", transport: { command: "ssh", args: ["w", last] } } as unknown as NodeConfig, [id], progressConfig())).toThrow("progress_agent_dir_ambiguous");
		// A shell operator ends a command-string value (cmd's `set NAME=value&& gjc`): refused, never read as part of the dir.
		for (const last of ["cmd.exe /c set GJC_CODING_AGENT_DIR=D:\\gjc\\agent&& gjc", 'cmd.exe /c "set GJC_CODING_AGENT_DIR=D:\\gjc\\agent&& gjc"', "cmd.exe /c set GJC_CODING_AGENT_DIR=D:\\a|more", "cmd.exe /c set GJC_CODING_AGENT_DIR=D:\\a<in", "cmd.exe /c set GJC_CODING_AGENT_DIR=D:\\a>out"])
			expect(() => progressInvocation({ ...node("q3"), os: "win32", transport: { command: "ssh", args: ["w", last] } } as unknown as NodeConfig, [id], progressConfig())).toThrow("progress_agent_dir_ambiguous");
		for (const last of [`env GJC_CODING_AGENT_DIR=${posixAgent}&& gjc`, `env GJC_CODING_AGENT_DIR=${posixAgent}|gjc`])
			expect(() => progressInvocation({ ...node("q4"), transport: { command: "ssh", args: ["p", last] } } as unknown as NodeConfig, [id], progressConfig())).toThrow("progress_agent_dir_ambiguous");
		// Through Fleet: the node is never contacted and the read is progress_route_unavailable (not transcript_missing).
		const cmd = world({ nodes: [{ ...node("q5"), transport: { command: "ssh", args: ["fake-q5", `env GJC_CODING_AGENT_DIR=${posixAgent}&& gjc`] } } as unknown as NodeConfig] });
		const c = cmd.active("cmd-set");
		transcript(c.sessionId, [user()], 10);
		await cmd.fleet.refreshProgress();
		expect(cmd.progress(c.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "precondition", code: "condition:progress_route_unavailable" } });
		expect(cmd.calls()).toEqual([]);
	});

	test.skipIf(WIN)("a GJC_CODING_AGENT_DIR argv element with a space is read whole (POSIX local route)", async () => {
		const spaced = join(root, "agent dir", "x");
		mkdirSync(join(spaced, "sessions", "--w--"), { recursive: true });
		const local = { ...node("sp"), transport: { command: "env", args: ["GJC_SDK_BROKER_AUTOSTART=0", `GJC_CODING_AGENT_DIR=${spaced}`, "gjc"] } } as unknown as NodeConfig;
		const w = world({ nodes: [local] });
		const t = w.active("spaced");
		const file = join(spaced, "sessions", "--w--", `x_${t.sessionId}.jsonl`);
		writeFileSync(file, `${JSON.stringify(header(t.sessionId))}\n${JSON.stringify(user())}\n`);
		utimesSync(file, NODE_NOW - 20, NODE_NOW - 20);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "awaiting_model", idleSeconds: 20 });
	});
});

// ---- the win32 node command, executed: real Windows PowerShell on this host, private transcripts ---------------
describe.skipIf(!WIN)("win32 node command (real PowerShell)", () => {
	// Space, 8.3 short component (this host's %TEMP% is C:\Users\ADMINI~1\...) and non-ASCII: read whole.
	const winAgent = join(root, "win agent ü");
	const winSessions = join(winAgent, "sessions", "--w--");
	const nowS = () => Math.floor(Date.now() / 1000);
	const write = (sessionId: string, text: string, ageSeconds: number, dir = winSessions) => {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, `2027-01-15T07-00-00-000Z_${sessionId}.jsonl`);
		writeFileSync(file, text);
		utimesSync(file, nowS() - ageSeconds, nowS() - ageSeconds);
	};
	const lines = (sessionId: string, entries: object[]) => [header(sessionId), ...entries].map((e) => `${JSON.stringify(e)}\n`).join("");
	const winLocal = { ...node("wl"), os: "win32", transport: { command: "env", args: ["GJC_SDK_BROKER_AUTOSTART=0", `GJC_CODING_AGENT_DIR=${winAgent}`, "gjc"] } } as unknown as NodeConfig;

	test("reports the same key tokens as the POSIX command, with the exact pending count and line completeness", async () => {
		const filler = Array.from({ length: 70 }, () => custom());
		const cases: Array<[string, string, Record<string, unknown>]> = [];
		const add = (text: (id: string) => string, expected: Record<string, unknown>) => {
			const id = randomUUID();
			write(id, text(id), 30);
			cases.push([id, text(id), expected]);
		};
		add((id) => lines(id, [user(), assistant("toolUse", 1)]), { type: "message", role: "assistant", stopReason: "toolUse", complete: true, pendingTools: 1 });
		add((id) => lines(id, [user(), assistant("toolUse", 3), custom(), toolResult(0)]), { type: "message", role: "toolResult", stopReason: "-", complete: true, pendingTools: 2 });
		add((id) => lines(id, [user(), assistant("toolUse", 2), toolResult(0), custom(), toolResult(1)]), { type: "message", role: "toolResult", complete: true, pendingTools: 0 });
		add((id) => lines(id, [user(), assistant("stop")]), { type: "message", role: "assistant", stopReason: "stop", complete: true, pendingTools: 0 });
		add((id) => lines(id, [user(), assistant("aborted")]), { type: "message", role: "assistant", stopReason: "aborted", complete: true, pendingTools: 0 });
		add((id) => lines(id, [user()]) + JSON.stringify(assistant("toolUse", 1)).slice(0, 300), { type: "message", role: "assistant", complete: false });
		add((id) => lines(id, []), { type: "session", role: "-", stopReason: "-", complete: true, pendingTools: 0 });
		add(() => "", { type: "-", role: "-", stopReason: "-", complete: false, pendingTools: undefined });
		add((id) => lines(id, [user(), assistant("toolUse", 3), toolResult(0), ...filler]), { type: "custom", role: "-", complete: true, pendingTools: undefined });
		add((id) => lines(id, [user(), modelChange()]), { type: "model_change", role: "-", complete: true, pendingTools: 0 });
		const missing = randomUUID();
		const ambiguous = randomUUID();
		write(ambiguous, lines(ambiguous, [user()]), 30);
		write(ambiguous, lines(ambiguous, [user()]), 30, join(winAgent, "sessions", "--other--"));
		const ids = [...cases.map(([id]) => id), missing, ambiguous];
		const win = await readNodeProgress(winLocal, ids, progressConfig());
		for (const [id, , expected] of cases) {
			const reading = win.get(id)!;
			expect(reading).toMatchObject({ status: "ok", ...Object.fromEntries(Object.entries(expected).filter(([, v]) => v !== undefined)) });
			if ("pendingTools" in expected && expected.pendingTools === undefined) expect((reading as any).pendingTools).toBeUndefined();
			expect((reading as any).nodeNow - (reading as any).mtime).toBeGreaterThanOrEqual(30);
		}
		expect(win.get(missing)).toEqual({ status: "missing" });
		expect(win.get(ambiguous)).toEqual({ status: "ambiguous" });
		// The POSIX reference on the same files (Git for Windows sh): identical apart from the node clock.
		const posix = parseProgressReply(await runProgressCommand([process.env.FLEET_TEST_SH!, "-c", `PATH=/usr/bin:$PATH; ${posixProgressScript(ids, posixPath(winAgent))}`], 60_000), ids);
		const strip = (m: Map<string, any>) => ids.map((id) => ({ ...m.get(id), nodeNow: undefined }));
		expect(strip(win)).toEqual(strip(posix));
	}, MANY);

	test("Fleet through the win32 local route: verdicts, an open batch beyond the window, the agent dir read whole", async () => {
		const w = world({ nodes: [winLocal] });
		const filler = Array.from({ length: 70 }, () => custom());
		const progressing = w.active("w-progressing");
		write(progressing.sessionId, lines(progressing.sessionId, [user(), assistant("toolUse", 1), toolResult()]), 30);
		const model = w.active("w-model");
		write(model.sessionId, lines(model.sessionId, [user(), assistant("toolUse", 1), toolResult()]), 600);
		const tool = w.active("w-tool");
		write(tool.sessionId, lines(tool.sessionId, [user(), assistant("toolUse", 2), toolResult(0)]), 2500);
		const batch = w.active("w-batch");
		write(batch.sessionId, lines(batch.sessionId, [user(), assistant("toolUse", 3), toolResult(0), ...filler, toolResult(1)]), 600);
		const finished = w.active("w-finished");
		write(finished.sessionId, lines(finished.sessionId, [user(), assistant("stop")]), 5);
		await w.fleet.refreshProgress(undefined, { settle: false });
		expect(w.calls()).toEqual([]);
		expect(w.progress(progressing.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "awaiting_model" });
		expect(w.progress(model.id)).toMatchObject({ verdict: "stalled_model", lastEntryKind: "awaiting_model" });
		expect(w.progress(tool.id)).toMatchObject({ verdict: "stalled_tool", lastEntryKind: "tool_running" });
		expect(w.progress(batch.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "other", pendingToolsUnknown: true });
		expect(w.progress(finished.id)).toMatchObject({ verdict: "finished_unobserved", lastStopReason: "stop" });
		expect(w.progress(model.id)!.idleSeconds).toBeGreaterThanOrEqual(600);
		expect(w.kinds(model.id)).toEqual(["progress_stalled"]);
	}, MANY);

	test("a finished turn followed only by non-message entries: PowerShell and POSIX report the same last message stop, Fleet says finished", async () => {
		const w = world({ nodes: [winLocal] });
		const finished = w.active("w-finished-custom");
		write(finished.sessionId, lines(finished.sessionId, [user(), assistant("stop"), custom(), modelChange()]), 600);
		const waiting = w.active("w-user-custom");
		write(waiting.sessionId, lines(waiting.sessionId, [user(), assistant("stop"), user(), custom()]), 600);
		const ids = [finished.sessionId, waiting.sessionId];
		const win = await readNodeProgress(winLocal, ids, progressConfig());
		expect(win.get(finished.sessionId)).toMatchObject({ status: "ok", type: "model_change", pendingTools: 0, lastMessageStop: "stop" });
		expect(win.get(waiting.sessionId)).toMatchObject({ status: "ok", type: "custom", pendingTools: 0, lastMessageStop: "-" });
		const posix = parseProgressReply(await runProgressCommand([process.env.FLEET_TEST_SH!, "-c", `PATH=/usr/bin:$PATH; ${posixProgressScript(ids, posixPath(winAgent))}`], 60_000), ids);
		const strip = (m: Map<string, any>) => ids.map((id) => ({ ...m.get(id), nodeNow: undefined }));
		expect(strip(win)).toEqual(strip(posix));
		await w.fleet.refreshProgress(undefined, { settle: false });
		expect(w.progress(finished.id)).toMatchObject({ verdict: "finished_unobserved", lastEntryKind: "assistant_final", lastStopReason: "stop" });
		expect(w.progress(waiting.id)).toMatchObject({ verdict: "stalled_model", lastEntryKind: "other" });
	}, MANY);

	test("over ssh with cmd.exe as the remote shell: every command fits 8191 characters, so more than 16 sessions are read", async () => {
		// The stand-in runs the remote command through `cmd.exe /d /c` verbatim; the agent dir comes from the env default.
		process.env.GJC_CODING_AGENT_DIR = winAgent;
		try {
			const winSsh = { ...node("ws"), os: "win32", transport: { command: "ssh", args: ["-o", "BatchMode=yes", "fake-ws", "cmd.exe /c gjc"] } } as unknown as NodeConfig;
			const limit = progressSessionLimit(winSsh, progressConfig());
			expect(limit).toBeGreaterThanOrEqual(1);
			expect(limit).toBeLessThan(17);
			const sample = (n: number) => Array.from({ length: n }, () => randomUUID());
			expect(progressInvocation(winSsh, sample(limit), progressConfig()).argv.at(-1)!.length).toBeLessThanOrEqual(PROGRESS_WIN32_SSH_COMMAND_LIMIT);
			expect(() => progressInvocation(winSsh, sample(limit + 1), progressConfig())).toThrow("progress_command_too_long");
			expect(progressSessionLimit({ ...winSsh, os: "linux" } as NodeConfig, progressConfig())).toBe(64);
			expect(progressSessionLimit(winLocal, progressConfig())).toBe(64);
			for (const count of [16, 17, 64]) {
				const w = world({ nodes: [winSsh] });
				const tasks = Array.from({ length: count }, (_, i) => w.active(`ws-${count}-${i}`));
				for (const t of tasks) write(t.sessionId, lines(t.sessionId, [user()]), 5);
				const passes = Math.ceil(count / limit);
				for (let i = 0; i < passes; i++) {
					await w.fleet.refreshProgress();
					w.advance(1);
				}
				expect(await w.fleet.refreshProgress()).toEqual([]);
				const calls = w.calls();
				expect(calls).toHaveLength(passes);
				for (const call of calls) {
					expect(call).toStartWith("progress-win32 ");
					expect(Number(call.split(" ")[1])).toBeLessThanOrEqual(8191);
				}
				for (const t of tasks) expect(w.progress(t.id)).toMatchObject({ verdict: "progressing", lastEntryKind: "awaiting_model" });
			}
		} finally {
			process.env.GJC_CODING_AGENT_DIR = agent;
		}
	}, MANY);
});

// ---- review r3 findings (round 4) ---------------------------------------------------------------------------------
/** An active task, optionally under the approval contract (whose observation from a CLI Fleet would fence it). */
function seedActive(w: ReturnType<typeof world>, key: string, approval: boolean): { id: string; sessionId: string } {
	if (!approval) return w.active(key);
	const sessionId = randomUUID();
	const id = guard.exempt(() => {
		const task = w.store.reserve(w.store.submit({ ...input(key), approvalContract: "sdk-ui-waiter-v1" }).id);
		w.store.recordSession(task.id, sessionId);
		w.store.recordTurn(task.id, `turn-${key}`);
		const o: Omit<Observation, "digest" | "eventId"> = { sessionId, turnId: `turn-${key}`, status: "active", terminal: false, evidence: { source: `seed-${key}` } };
		w.store.observe(task.id, { ...o, eventId: `event-${key}`, digest: observationDigest(o) });
		return task.id as string;
	});
	return { id, sessionId };
}
/**
 * A watch over two active tasks: the coordinator read of `stopped` fails on the first two polls (the watch stops it
 * with 5), then recovers; its transcript shows a finished turn, so every later progress pass finds it due and finished.
 */
async function watchAfterStop(mode: "all-active" | "ids", approval: boolean) {
	const w = world();
	const stopped = seedActive(w, `stopped-${mode}-${approval}`, approval);
	const running = w.active(`running-${mode}-${approval}`);
	transcript(stopped.sessionId, [user(), assistant("stop")], 30);
	transcript(running.sessionId, [user()], 10);
	let down = true;
	const reads: string[] = [];
	(w.fleet as any).connect = async () => ({
		close() {},
		async call(name: string, args: any) {
			reads.push(args.session_id);
			if (down && args.session_id === stopped.sessionId) throw new Error("coordinator_unreachable");
			if (name === "gjc_coordinator_read_turn") return { ok: true, turn: { session_id: args.session_id, turn_id: args.turn_id, status: "active" } };
			if (name === "gjc_coordinator_list_questions") return { ok: true, reconciliation: { complete: true }, questions: [] };
			throw new Error("unexpected_call");
		},
	});
	const lines: any[] = [];
	const atStop = { reads: -1, observedAt: "" };
	const exit = await watchTasks(w.fleet, {
		...(mode === "all-active" ? { allActive: true } : { ids: [stopped.id, running.id] }),
		maxPolls: 5,
		interval: 10,
		emit: (v) => lines.push(v),
		sleep: async () => {
			if (down && lines.some((l) => l.taskId === stopped.id && l.consecutiveFailures === 2)) {
				down = false;
				atStop.reads = reads.filter((r) => r === stopped.sessionId).length;
				atStop.observedAt = w.progress(stopped.id)?.observedAt ?? "";
			}
			w.advance(PROGRESS_DEFAULTS.settleRetrySeconds + 1);
		},
	});
	const summary = lines.find((l) => l.observation === "summary");
	return { w, stopped, exit, summary, atStop, readsOfStopped: reads.filter((r) => r === stopped.sessionId).length };
}

describe("a task the watch already stopped (review r3 F1, F5 m9)", () => {
	test("watch --all-active never observes a task it stopped after two failed reads, though its turn later shows finished", async () => {
		const { w, stopped, summary, atStop, readsOfStopped } = await watchAfterStop("all-active", false);
		expect(atStop.reads).toBeGreaterThanOrEqual(2);
		expect(summary.tasks[stopped.id]).toBe(5);
		// No coordinator read of the stopped task after the stop; it stays exactly as the watch left it.
		expect(readsOfStopped).toBe(atStop.reads);
		expect(w.store.task(stopped.id)!.phase).toBe("active");
		// Still read and displayed (display only): its progress record is kept current.
		expect(w.progress(stopped.id)).toMatchObject({ verdict: "finished_unobserved" });
		expect(w.progress(stopped.id)!.observedAt > atStop.observedAt).toBe(true);
	});

	test("watch --all-active never fences a stopped approval-contract task to blocked_unknown while reporting 5", async () => {
		const { w, stopped, exit, summary, atStop, readsOfStopped } = await watchAfterStop("all-active", true);
		expect(summary.tasks[stopped.id]).toBe(5);
		expect(exit).toBe(5);
		expect(readsOfStopped).toBe(atStop.reads);
		const task = w.store.task(stopped.id)!;
		expect([task.phase, task.reason]).toEqual(["active", undefined]);
		expect(w.store.events(stopped.id).map((e) => e.kind)).not.toContain("unknown");
	});

	test("watch TASK...: a task it stopped is neither read nor observed again", async () => {
		const { w, stopped, summary, atStop, readsOfStopped } = await watchAfterStop("ids", false);
		expect(summary.tasks[stopped.id]).toBe(5);
		expect(readsOfStopped).toBe(atStop.reads);
		expect(w.progress(stopped.id)!.observedAt).toBe(atStop.observedAt);
		expect(w.store.task(stopped.id)!.phase).toBe("active");
	});
});

describe("named tasks are loaded by id (review r3 F3)", () => {
	test("refreshProgress(ids) (poll, single watch) never scans the tasks table; without ids it does", async () => {
		const w = world();
		const t = w.active("by-id");
		const other = w.active("not-named");
		transcript(t.sessionId, [user()], 900);
		transcript(other.sessionId, [user()], 900);
		const scan = w.store.taskStates.bind(w.store);
		let scans = 0;
		(w.store as any).taskStates = () => {
			scans++;
			return scan();
		};
		const out = await w.fleet.refreshProgress([t.id, t.id, randomUUID()], { settle: false });
		expect(scans).toBe(0);
		expect(out.map((e) => e.taskId)).toEqual([t.id]);
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model" });
		expect(w.progress(other.id)).toBeUndefined();
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		await w.fleet.refreshProgress(undefined, { settle: false });
		expect(scans).toBe(1);
		expect(w.progress(other.id)).toMatchObject({ verdict: "stalled_model" });
	});
});

describe("archive and progress (review r3 F4, F5 m5, F5 m6)", () => {
	/** A blocked_unknown task with a progress record whose node left the registry (archived as node_retired). */
	async function blockedRetired(key: string) {
		const w = world();
		const t = w.active(key);
		guard.exempt(() => w.store.markUnknown(t.id, "seed_unknown"));
		transcript(t.sessionId, [user(), assistant("toolUse", 1)], 3000);
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_tool" });
		const db = new Database(w.dbPath);
		try {
			db.query("DELETE FROM nodes").run();
		} finally {
			db.close();
		}
		const archive = () => w.fleet.archive(t.id, { operatorOverride: { kind: "node_retired", reason: "node retired by operator" } });
		return { w, t, archive };
	}
	const rawRow = (w: ReturnType<typeof world>, id: string) => {
		const db = new Database(w.dbPath, { readonly: true });
		try {
			return JSON.parse((db.query("SELECT data FROM tasks WHERE id=?").get(id) as any).data);
		} finally {
			db.close();
		}
	};

	test("task archive drops the progress record (display only, never shown for an archived task)", async () => {
		const { w, t, archive } = await blockedRetired("archive-drops");
		expect(rawRow(w, t.id).progress).toBeDefined();
		expect((await archive()).phase).toBe("archived");
		expect("progress" in rawRow(w, t.id)).toBe(false);
		expect(w.store.task(t.id)!.progress).toBeUndefined();
		// An archived task is never read again.
		w.advance(61);
		expect(await w.fleet.refreshProgress()).toEqual([]);
	});

	test("archive succeeds across a concurrent progress write, and stays bound to every other field", async () => {
		const { w, t, archive } = await blockedRetired("archive-race");
		const storeArchive = w.store.archive.bind(w.store);
		// A progress refresh lands between Fleet.archive's observation and store.archive.
		(w.store as any).archive = async (...args: Parameters<FleetStore["archive"]>) => {
			transcript(t.sessionId, [user(), assistant("toolUse", 1), toolResult()], 5);
			w.advance(61);
			await w.fleet.refreshProgress([t.id]);
			expect(w.progress(t.id)).toMatchObject({ verdict: "progressing" });
			return storeArchive(...args);
		};
		expect((await archive()).phase).toBe("archived");

		const other = await blockedRetired("archive-bound");
		const otherArchive = other.w.store.archive.bind(other.w.store);
		// Any other change of the row between the observation and store.archive still refuses the archive.
		(other.w.store as any).archive = (...args: Parameters<FleetStore["archive"]>) => {
			guard.exempt(() => other.w.store.markUnknown(other.t.id, "another_reason"));
			return otherArchive(...args);
		};
		await expect(other.archive()).rejects.toMatchObject({ code: "ARCHIVE_AUTHORITY" });
		expect(other.w.store.task(other.t.id)).toMatchObject({ phase: "blocked_unknown", reason: "another_reason" });
	});

	test("a progress read landing after the task left its progress phase (archived meanwhile) is not recorded", async () => {
		const { w, t, archive } = await blockedRetired("phase-left");
		const record = w.store.recordProgress.bind(w.store);
		let archived: Promise<unknown> | undefined;
		// The read is in flight; the operator archives the task before its result is recorded.
		(w.store as any).recordProgress = (...args: Parameters<FleetStore["recordProgress"]>) => {
			archived ??= archive();
			expect(w.store.task(t.id)!.phase).toBe("archived");
			return record(...args);
		};
		transcript(t.sessionId, [user()], 900);
		w.advance(61);
		const events = w.store.events(t.id).length;
		expect(await w.fleet.refreshProgress([t.id])).toEqual([]);
		expect(archived).toBeDefined();
		expect(await archived).toMatchObject({ phase: "archived" });
		expect(w.store.events(t.id).slice(events).map((e) => e.kind).filter((k) => k.startsWith("progress_"))).toEqual([]);
	});
});

describe("queue reconsider latency (review r3 F6)", () => {
	test("an unresponsive node delays queue reconsider by its read deadline, then the read is recorded unknown", async () => {
		const w = world({ progress: { posixTimeoutMs: 1500 } });
		const t = w.active("reconsider-deadline");
		transcript(t.sessionId, [user()], 10);
		process.env.FLEET_TEST_MODE = "timeout";
		const started = Date.now();
		expect(await reconsiderQueue(w.fleet, async () => new Map())).toEqual([]);
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(1400);
		expect(elapsed).toBeLessThan(10_000);
		expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "call", errorClass: "TransportError", code: "transport:progress_timeout" } });
		expect(w.store.task(t.id)!.phase).toBe("active");
		expect(w.calls()).toEqual(["progress"]);
	}, 30_000);
});

describe("retention: settled record and coalesced stall episodes (review r4 F2)", () => {
	/** Records one successful read directly (hub ms offset from HUB0; node clock and transcript time in node seconds). */
	const reader = (w: ReturnType<typeof world>, id: string, config = w.fleet.progressConfig) => {
		const task = w.store.task(id)!;
		return (hubMs: number, nodeNow: number, writtenAt: number) =>
			w.store.recordProgress(
				id,
				{ attemptId: task.attemptId!, sessionId: task.sessionId!, startedAt: HUB0 + hubMs, observedAt: HUB0 + hubMs + 10, config },
				{ ok: true, kind: "awaiting_model", idleSeconds: nodeNow - writtenAt, writtenAt, nodeNow },
			);
	};
	const observeAs = (w: ReturnType<typeof world>, t: { id: string; sessionId: string }, key: string, status: Observation["status"], terminal: boolean) => {
		const o: Omit<Observation, "digest" | "eventId"> = { sessionId: t.sessionId, turnId: `turn-${key}`, status, terminal, evidence: { source: `${key}-${status}` } };
		guard.exempt(() => w.store.observe(t.id, { ...o, eventId: `e-${key}-${status}`, digest: observationDigest(o as any) } as any));
	};

	test("the progress record is dropped when the task reaches a terminal phase, and kept through a non-terminal one", () => {
		const w = world();
		for (const status of ["failed", "cancelled", "succeeded"] as const) {
			const t = w.active(`drop-${status}`);
			reader(w, t.id)(0, NODE_NOW, NODE_NOW - 900);
			expect(w.progress(t.id)).toMatchObject({ verdict: "stalled_model" });
			observeAs(w, t, `drop-${status}`, status, true);
			expect(w.store.task(t.id)!.result?.executionTerminal).toBe(true);
			expect(w.progress(t.id)).toBeUndefined();
		}
		// approval_required waits on a human and can return to active: the record (and its episode) stays.
		const waiting = w.active("drop-approval");
		reader(w, waiting.id)(0, NODE_NOW, NODE_NOW - 900);
		observeAs(w, waiting, "drop-approval", "approval_required", false);
		expect(w.store.task(waiting.id)!.phase).toBe("approval_required");
		expect(w.progress(waiting.id)).toMatchObject({ verdict: "stalled_model", stall: { verdict: "stalled_model" } });
	});

	test("a slow but live model for a whole task-day is one coalesced episode, closed by one recovered row after an hour without a stall", () => {
		const w = world();
		const t = w.active("slow-day");
		const read = reader(w, t.id);
		// Defaults: a read every 60 s; the model writes right after each stalled read, then is idle again (the
		// r4 review's worst default case, 319 audit rows per task-day).
		let written = NODE_NOW;
		for (let s = 0; s <= 86_400; s += 60) if (read(s * 1000, NODE_NOW + s, written).progress!.verdict === "stalled_model") written = NODE_NOW + s + 1;
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		const coalesced = w.progress(t.id)!.stall!.coalesced!;
		expect(coalesced).toBeGreaterThan(150);
		// Healthy for more than an hour after the last recovery: the episode is closed and audited once.
		for (let s = 86_460; s <= 86_400 + 3_720; s += 60) read(s * 1000, NODE_NOW + s, NODE_NOW + s - 5);
		expect(w.kinds(t.id)).toEqual(["progress_stalled", "progress_recovered"]);
		expect(w.store.events(t.id).at(-1)!.data).toMatchObject({ verdict: "progressing", previousVerdict: "stalled_model", stalledSince: new Date(HUB0 + 540_010).toISOString(), recoveredAt: new Date(HUB0 + 86_460_010).toISOString(), coalesced, cause: "transcript_progressed" });
		expect(w.progress(t.id)!.stall).toBeUndefined();
	}, 30_000);

	test("the coalescing window boundary: a recovery is audited, and a stall starts a new episode, only strictly after it", () => {
		const w = world();
		const setup = (key: string) => {
			const t = w.active(key);
			const read = reader(w, t.id);
			read(0, NODE_NOW, NODE_NOW - 481);
			read(60_000, NODE_NOW + 60, NODE_NOW + 59);
			expect(w.progress(t.id)!.stall).toMatchObject({ recovered: { at: new Date(HUB0 + 60_010).toISOString(), verdict: "progressing" } });
			expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
			return { t, read };
		};
		const window = PROGRESS_EPISODE_COALESCE_SECONDS * 1000;
		// Healthy reads: at exactly the window still pending, one ms later audited.
		const healthy = setup("window-healthy");
		healthy.read(60_000 + window, NODE_NOW + 3700, NODE_NOW + 3699);
		expect(w.kinds(healthy.t.id)).toEqual(["progress_stalled"]);
		healthy.read(60_000 + window + 1, NODE_NOW + 3701, NODE_NOW + 3700);
		expect(w.kinds(healthy.t.id)).toEqual(["progress_stalled", "progress_recovered"]);
		expect(w.store.events(healthy.t.id).at(-1)!.data).toMatchObject({ recoveredAt: new Date(HUB0 + 60_010).toISOString(), coalesced: 0 });
		// A stall at exactly the window continues the episode; one ms later it is a new one.
		const within = setup("window-within");
		within.read(60_000 + window, NODE_NOW + 4000, NODE_NOW + 3000);
		expect(w.kinds(within.t.id)).toEqual(["progress_stalled"]);
		expect(w.progress(within.t.id)!.stall).toMatchObject({ since: new Date(HUB0 + 10).toISOString(), coalesced: 1 });
		const after = setup("window-after");
		after.read(60_000 + window + 1, NODE_NOW + 4000, NODE_NOW + 3000);
		expect(w.kinds(after.t.id)).toEqual(["progress_stalled", "progress_recovered", "progress_stalled"]);
		expect(w.progress(after.t.id)!.stall).toEqual({ verdict: "stalled_model", since: new Date(HUB0 + 60_000 + window + 11).toISOString(), nodeWrittenAt: new Date((NODE_NOW + 3000) * 1000).toISOString() });
	});

	test("a new write that is stalled again by the next read continues the episode without audit rows", () => {
		const w = world();
		const t = w.active("rewrite-stalled");
		const read = reader(w, t.id);
		read(0, NODE_NOW, NODE_NOW - 500);
		read(600_000, NODE_NOW + 600, NODE_NOW + 50);
		expect(w.kinds(t.id)).toEqual(["progress_stalled"]);
		expect(w.progress(t.id)!.stall).toEqual({ verdict: "stalled_model", since: new Date(HUB0 + 10).toISOString(), nodeWrittenAt: new Date((NODE_NOW + 50) * 1000).toISOString(), coalesced: 1 });
	});

	test("at --stall-model-seconds 1 no read pattern audits 48 or more rows per task-day", () => {
		const w = world();
		const config = progressConfig({ modelStallSeconds: 1 });
		const rows: number[] = [];
		// Each pattern: one stalled read, then `healthy` progressing reads, repeated over 24 h of 60 s reads.
		for (const healthy of [1, 2, 59, 60, 61, 62, 120]) {
			const t = w.active(`bound-${healthy}`);
			const read = reader(w, t.id, config);
			for (let i = 0, s = 0; s <= 86_400; i++, s += 60) read(s * 1000, NODE_NOW + s, i % (healthy + 1) === 0 ? NODE_NOW + s - 2 : NODE_NOW + s);
			rows.push(w.kinds(t.id).length);
		}
		for (const n of rows) expect(n).toBeLessThan(48);
		// Not vacuous: episodes that are an hour apart are still each audited.
		expect(Math.max(...rows)).toBeGreaterThan(40);
		// About 10 000 store transactions: past bun's default 5 s on a Windows hub (review r5 F1).
	}, 60_000);
});

describe("CLI help names every command that reads progress (review r5 F2)", () => {
	test("the Lane progress paragraph of --help names run --wait with poll, watch and queue reconsider", async () => {
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--help"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		const lanes = out.split("\n").filter((line) => line.trimStart().startsWith("Lane progress:"));
		expect(lanes).toHaveLength(1);
		expect(lanes[0]!.trim()).toStartWith("Lane progress: poll, watch, run --wait and queue reconsider also read");
	});
});

describe("CLI poll is detection only (review r5 F3)", () => {
	test("poll of an active finished_unobserved task: one coordinator read, one progress read, no settle request", async () => {
		// The coordinator route is the CONTROLLED protocol fixture (it answers the poll's read: the turn still runs);
		// the progress read takes the node's sdkTransport, the ssh stand-in.
		const state = join(root, `coordinator-${randomUUID()}.json`);
		const sessionId = randomUUID();
		writeFileSync(state, JSON.stringify({ calls: [], readTurn: { ok: true, turn: { session_id: sessionId, turn_id: "turn-cli-poll", status: "active" } } }));
		const coordinated = { ...node("n1"), transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "coordinator.ts"), state] }, sdkTransport: node("n1").transport } as unknown as NodeConfig;
		const w = world({ nodes: [coordinated] });
		const t = w.active("cli-poll", sessionId);
		transcript(sessionId, [user(), assistant("stop")], 30);
		w.store.close();
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", w.dbPath, "poll", t.id], { cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, err }).toEqual({ code: 0, err: "" });
		const names = (JSON.parse(readFileSync(state, "utf8")).calls as { name: string }[]).map((call) => call.name);
		expect(names.filter((name) => name === "gjc_coordinator_read_turn")).toHaveLength(1);
		expect(w.calls()).toEqual(["progress"]);
		expect(JSON.parse(out).task.progress).toMatchObject({ verdict: "finished_unobserved" });
		const reopened = new FleetStore(w.dbPath);
		stores.push(reopened);
		const after = reopened.task(t.id)!;
		expect(after.phase).toBe("active");
		expect(after.progress).toMatchObject({ verdict: "finished_unobserved", lastEntryKind: "assistant_final" });
		expect(after.progress!.settle).toBeUndefined();
	});
});

describe("session-limit probe of a route that fits no session (review r4 F3)", () => {
	test("progressSessionLimit swallows the probe failure (1) and the read reports progress_route_unavailable without contacting the node", async () => {
		const longDir = "C:\\" + "a".repeat(4000);
		const win = { ...node("long"), os: "win32", transport: { command: "ssh", args: ["fake-long", `env GJC_CODING_AGENT_DIR=${longDir} gjc`] } } as unknown as NodeConfig;
		expect(() => progressInvocation(win, [randomUUID()], progressConfig())).toThrow("progress_command_too_long");
		expect(progressSessionLimit(win, progressConfig())).toBe(1);
		const w = world({ nodes: [win] });
		const t = w.active("long-dir");
		await w.fleet.refreshProgress();
		expect(w.progress(t.id)).toMatchObject({ verdict: "unknown", diagnostic: { phase: "precondition", code: "condition:progress_route_unavailable" } });
		expect(w.calls()).toEqual([]);
	});
});

describe("threshold bounds in each key's unit (review r4 F4)", () => {
	test("*Seconds keys are bounded at 7 days in seconds, *Ms keys at 7 days in ms", () => {
		for (const key of ["modelStallSeconds", "toolStallSeconds", "minIntervalSeconds", "settleRetrySeconds"]) {
			expect(progressConfig({ [key]: 604_800 })[key as "modelStallSeconds"]).toBe(604_800);
			expect(() => progressConfig({ [key]: 604_801 })).toThrow(`invalid_progress_${key}`);
		}
		for (const key of ["posixTimeoutMs", "win32TimeoutMs"]) {
			expect(progressConfig({ [key]: 604_800_000 })[key as "posixTimeoutMs"]).toBe(604_800_000);
			expect(() => progressConfig({ [key]: 604_800_001 })).toThrow(`invalid_progress_${key}`);
		}
	});

	test("the CLI usage check refuses --stall-*-seconds above 7 days in seconds", async () => {
		const w = world();
		w.store.close();
		const cli = async (...args: string[]) => {
			const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", w.dbPath, "--read-only", ...args], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
			const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
			return { code, err };
		};
		for (const flag of ["--stall-model-seconds", "--stall-tool-seconds"]) {
			expect(await cli(flag, "604800", "tasks")).toMatchObject({ code: 0 });
			const refused = await cli(flag, "604801", "tasks");
			expect(refused.code).toBe(1);
			expect(JSON.parse(refused.err.trim())).toEqual({ ok: false, error: "stall_seconds_positive_integer_required" });
		}
	});
});

describe("port onto production with the daemon (review r4 F1, keep-both resolution)", () => {
	test("observability carries both the daemon lease view and the progress view", async () => {
		const w = world();
		const t = w.active("keep-both-observability");
		transcript(t.sessionId, [user()], 900);
		await w.fleet.refreshProgress();
		expect(guard.exempt(() => w.store.claimDaemonLease({ owner: "keep-both", pid: process.pid, host: "test-host", startedAt: new Date().toISOString() }, 60_000))).toBe(true);
		const obs = w.store.observability() as any;
		expect(obs.daemon).toMatchObject({ alive: true, owner: "keep-both" });
		expect(obs.progress).toMatchObject({ counts: { stalled_model: 1 }, flagged: [{ taskId: t.id, verdict: "stalled_model" }] });
	});

	test("the CLI's one Fleet (also the daemon's) is built with the --stall-model-seconds threshold", async () => {
		const w = world();
		const t = w.active("keep-both-cli");
		transcript(t.sessionId, [user()], 90);
		w.store.close();
		const child = Bun.spawn([process.execPath, "src/cli.ts", "--db", w.dbPath, "--stall-model-seconds", "60", "queue", "reconsider"], { cwd: join(import.meta.dir, ".."), env: { ...process.env }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
		const [, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		expect(code).toBe(0);
		expect(w.calls()).toContain("progress");
		const reopened = new FleetStore(w.dbPath);
		stores.push(reopened);
		// 90 s idle is progressing at the default 480 s; it is stalled only with the CLI threshold applied.
		expect(reopened.task(t.id)!.progress).toMatchObject({ verdict: "stalled_model", idleSeconds: 90, thresholds: { modelSeconds: 60 } });
	});
});

describe("runProgressCommand SIGKILL teardown", () => {
	test.skipIf(process.platform === "win32")("deadline SIGKILLs a SIGTERM-trapping helper", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-progress-sigkill-"));
		const pidFile = join(dir, "pid");
		try {
			const t0 = Date.now();
			await expect(
				runProgressCommand(
					[
						"/bin/sh",
						"-c",
						`trap '' TERM; echo $$ >${JSON.stringify(pidFile)}; while true; do sleep 1; done`,
					],
					200,
				),
			).rejects.toMatchObject({ code: "progress_timeout", certainty: "unknown" });
			expect(Date.now() - t0).toBeLessThan(2_000);
			const pid = (await readFile(pidFile, "utf8")).trim();
			expect(pid).toMatch(/^\d+$/);
			const goneUntil = Date.now() + 500;
			let gone = false;
			while (Date.now() < goneUntil) {
				try {
					process.kill(Number(pid), 0);
				} catch {
					gone = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(gone).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("deadline SIGKILLs a hung execPath helper on every platform", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-progress-hung-"));
		const pidFile = join(dir, "pid");
		const script = [
			`const fs=require("node:fs");`,
			`fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			`setInterval(()=>{}, 1000);`,
		].join("");
		try {
			const t0 = Date.now();
			await expect(runProgressCommand([process.execPath, "-e", script], 200)).rejects.toMatchObject({
				code: "progress_timeout",
				certainty: "unknown",
			});
			expect(Date.now() - t0).toBeLessThan(2_000);
			const pid = (await readFile(pidFile, "utf8")).trim();
			expect(pid).toMatch(/^\d+$/);
			const goneUntil = Date.now() + 1_500;
			let gone = false;
			while (Date.now() < goneUntil) {
				try {
					process.kill(Number(pid), 0);
				} catch {
					gone = true;
					break;
				}
				await Bun.sleep(20);
			}
			expect(gone).toBe(true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
