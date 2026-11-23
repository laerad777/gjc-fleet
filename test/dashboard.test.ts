import { test, expect, spyOn } from "bun:test";
import { dashboardWsOriginAllowed, getDashboardState, getDashboardTask, parseResourceLine, probeNode, renderDashboardHtml, selectDashboardTasks, startDashboardServer, streamCommand, type DashboardState, type DashboardTask } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { refuseHostGjc } from "./host-gjc-guard";
import { observationDigest } from "../src/core";
import { activeOn, node } from "./fixtures/daemon";
import { stubPrograms } from "./support/stub-path";

/** A manually driven stand-in for the dashboard push timer: ticks fire only when the test says so. */
function manualPushTimer() {
	let fn: (() => void) | undefined;
	return {
		timer: {
			setInterval: (tick: () => void) => {
				fn = tick;
				return 0;
			},
			clearInterval: () => {
				fn = undefined;
			},
		},
		tick: () => fn?.(),
	};
}

/** Poll until the condition holds: waits for a real condition, never for a guessed duration. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await Bun.sleep(5);
	}
}

/** Bounded delivery drain: after a manual tick, give localhost WebSocket delivery one short window. */
const drainDelivery = () => Bun.sleep(150);

/**
 * The host-GJC probe settles after the first snapshot, and until it does every snapshot carries a
 * fresh placeholder gjcRuntime stamp that legitimately republishes once. Fire manual ticks until
 * one draws no broadcast, so later assertions cover only genuinely unchanged state.
 */
async function settleBroadcasts(tick: () => void, messages: any[]): Promise<void> {
	for (let i = 0; i < 20; i++) {
		const before = messages.length;
		tick();
		await drainDelivery();
		if (messages.length === before) return;
	}
	throw new Error("dashboard state never settled");
}

test("dashboard state extracts summary, nodes and tasks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-test-"));
	const dbPath = join(dir, "fleet.sqlite");
	const store = new FleetStore(dbPath);

	try {
		const state = getDashboardState(store);
		expect(state.summary.totalNodes).toBe(0);
		expect(state.summary.activeTasks).toBe(0);
		expect(Array.isArray(state.nodes)).toBe(true);
		expect(Array.isArray(state.tasks)).toBe(true);
		expect(state.pipeline.stages.map((stage) => stage.key)).toEqual([
			"submitted",
			"assigned",
			"workspace",
			"session",
			"turn",
			"result",
			"verified",
		]);
		expect(state.pipeline.stages.every((stage) => stage.inFlight === 0 && stage.reached === 0)).toBe(true);
		expect(state.summary.openNodes).toBeNull();
		expect(state.summary).not.toHaveProperty("globalCap");

		const html = renderDashboardHtml();
		expect(html).toContain("GJC Fleet Dashboard");
		expect(html).toContain("/api/state");
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("only running phases count as active work and node load; unsettled and unreturned slots are reported apart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-truth-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const running = activeOn(store, "n", "running");
		const provisional = activeOn(store, "n", "provisional");
		const ended = { sessionId: `session-${provisional}`, turnId: `turn-${provisional}`, status: "completed_unverified" as const, terminal: false, evidence: {} };
		store.observe(provisional, { eventId: "provisional", digest: observationDigest(ended), ...ended });
		const done = activeOn(store, "n", "done");
		const succeeded = { sessionId: `session-${done}`, turnId: `turn-${done}`, status: "succeeded" as const, terminal: true, evidence: { native: "done" } };
		store.observe(done, { eventId: "done", digest: observationDigest(succeeded), ...succeeded });
		expect(store.taskStates().map((t) => [t.id, t.phase, t.held, t.result?.executionTerminal === true])).toEqual(
			expect.arrayContaining([[running, "preparing", true, false], [provisional, "completed_unverified", true, false], [done, "succeeded", false, true]]),
		);

		const state = getDashboardState(store);
		expect(state.summary.activeTasks).toBe(1);
		expect(state.summary.unsettledTasks).toBe(1);
		expect(state.summary.heldTasks).toBe(2);
		expect(state.pipeline.stages.reduce((n, stage) => n + stage.inFlight, 0)).toBe(1);
		expect(state.pipeline.outcome).toMatchObject({ succeeded: 1, unverified: 0, unsettled: 1 });
		const n = state.nodes[0]!;
		expect(n.currentLoad).toBe(1);
		expect(n.heldNotRunning).toBe(1);
		expect(n.holding.map((t) => t.id).sort()).toEqual([running, provisional].sort());
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("dashboard HTTP server serves index, /api/state and the live WebSocket", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-srv-"));
	const dbPath = join(dir, "fleet.sqlite");
	const store = new FleetStore(dbPath);

	const restoreGjc = refuseHostGjc();
	const server = startDashboardServer(store, 0, "127.0.0.1", { probeNodes: false });
	try {
		const resHtml = await fetch(`http://127.0.0.1:${server.port}/`);
		expect(resHtml.status).toBe(200);
		expect(await resHtml.text()).toContain("GJC Fleet Dashboard");

		const resJson = await fetch(`http://127.0.0.1:${server.port}/api/state`);
		expect(resJson.status).toBe(200);
		const json = (await resJson.json()) as DashboardState; // the server serialises getDashboardState()
		expect(json.summary.totalNodes).toBe(0);
		expect(json.live).toBe(false);

		const missing = await fetch(`http://127.0.0.1:${server.port}/api/task/00000000-0000-4000-8000-000000000000`);
		expect(missing.status).toBe(404);
		const badEncoding = await fetch(`http://127.0.0.1:${server.port}/api/task/%E0%A4%A`);
		expect([400, 404]).toContain(badEncoding.status);
		expect(renderDashboardHtml()).toContain("Failed to load history");
		expect(renderDashboardHtml()).toContain("loadDetail");
		// Live deferred omitted counts must not invalidate the detail cache stamp on every push.
		expect(renderDashboardHtml()).toContain("Do not key on timelineOmitted");
		expect(renderDashboardHtml()).toContain("keep the fail banner until the operator clicks to retry");

		const first = await new Promise<any>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
			ws.onmessage = (event) => {
				ws.close();
				resolve(JSON.parse(String(event.data)));
			};
			ws.onerror = () => reject(new Error("websocket failed"));
		});
		expect(first.type).toBe("state");
		expect(first.state.summary.totalNodes).toBe(0);

		// Browser-like same-origin Origin must still upgrade successfully.
		const withOrigin = await new Promise<any>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
				headers: { Origin: `http://127.0.0.1:${server.port}` },
			} as any);
			ws.onmessage = (event) => {
				ws.close();
				resolve(JSON.parse(String(event.data)));
			};
			ws.onerror = () => reject(new Error("websocket with Origin failed"));
		});
		expect(withOrigin.type).toBe("state");

		const foreign = await fetch(`http://127.0.0.1:${server.port}/ws`, {
			headers: {
				Origin: "https://evil.example",
				Host: `127.0.0.1:${server.port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
			},
		});
		expect(foreign.status).toBe(403);
		const sameOrigin = await fetch(`http://127.0.0.1:${server.port}/ws`, {
			headers: {
				Origin: `http://127.0.0.1:${server.port}`,
				Host: `127.0.0.1:${server.port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
			},
		});
		// Same-origin Origin passes the gate; 426 means upgrade was allowed but fetch is not a WS client.
		expect([426, 101]).toContain(sameOrigin.status);
	} finally {
		server.stop(true);
		restoreGjc();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("dashboardWsOriginAllowed requires Host+scheme match or loopback bind without Origin", () => {
	const loopback = new Request("http://127.0.0.1:8080/ws");
	expect(dashboardWsOriginAllowed(loopback, "127.0.0.1")).toBe(true);
	expect(dashboardWsOriginAllowed(loopback, "0.0.0.0")).toBe(false);
	const matched = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "http://10.0.0.5:8080", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(matched, "0.0.0.0")).toBe(true);
	const cross = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "https://evil.example", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(cross, "0.0.0.0")).toBe(false);
	const schemeMismatch = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "https://10.0.0.5:8080", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(schemeMismatch, "0.0.0.0")).toBe(false);
	const portMismatch = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "http://10.0.0.5:9090", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(portMismatch, "0.0.0.0")).toBe(false);
	const nullOriginNonLoopback = new Request("http://10.0.0.5:8080/ws");
	expect(dashboardWsOriginAllowed(nullOriginNonLoopback, "0.0.0.0")).toBe(false);
	expect(dashboardWsOriginAllowed(nullOriginNonLoopback, "10.0.0.5")).toBe(false);
	// Other loopback bind spellings also allow missing Origin (local tooling / IPv6).
	expect(dashboardWsOriginAllowed(loopback, "localhost")).toBe(true);
	expect(dashboardWsOriginAllowed(loopback, "::1")).toBe(true);
	const invalidOrigin = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "not a url", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(invalidOrigin, "0.0.0.0")).toBe(false);
	const fileOrigin = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "file://", Host: "10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(fileOrigin, "0.0.0.0")).toBe(false);
	const missingHost = new Request("http://10.0.0.5:8080/ws", {
		headers: { Origin: "http://10.0.0.5:8080" },
	});
	expect(dashboardWsOriginAllowed(missingHost, "0.0.0.0")).toBe(false);
});

test("live WebSocket does not republish an unchanged dashboard state every SAMPLE_MS", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-push-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	const restoreGjc = refuseHostGjc();
	const push = manualPushTimer();
	const server = startDashboardServer(store, 0, "127.0.0.1", { probeNodes: false, pushTimer: push.timer });
	try {
		const messages: any[] = [];
		const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
		ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error("websocket failed"));
		});
		await waitFor(() => messages.length === 1);
		expect(messages[0]!.type).toBe("state");
		await settleBroadcasts(push.tick, messages);
		const settled = messages.length;
		for (let i = 0; i < 3; i++) {
			push.tick();
			await drainDelivery();
		}
		expect(messages.length).toBe(settled);
		ws.close();
	} finally {
		server.stop(true);
		restoreGjc();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("a new WebSocket client joining after a state change does not suppress the broadcast to existing clients", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-join-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	const restoreGjc = refuseHostGjc();
	const push = manualPushTimer();
	const server = startDashboardServer(store, 0, "127.0.0.1", { probeNodes: false, pushTimer: push.timer });
	try {
		const open = async (messages: any[]) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
			ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error("websocket failed"));
			});
			return ws;
		};
		const a: any[] = [];
		const b: any[] = [];
		const wsA = await open(a);
		await waitFor(() => a.length === 1);
		expect(a[0].state.tasks.length).toBe(0);
		await settleBroadcasts(push.tick, a);
		// State changes, then client B joins before the next push tick: B's initial state must not
		// mark the change as already broadcast, or A never sees it.
		store.submit({ schemaVersion: 1, key: "join-race", caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any);
		const wsB = await open(b);
		await waitFor(() => b.length === 1);
		expect(b[0].state.tasks.length).toBe(1);
		// No push tick has run since the submit, so A cannot have heard about it yet.
		expect(a.every((m) => m.type === "state" && m.state.tasks.length === 0)).toBe(true);
		push.tick();
		await waitFor(() => a.some((m) => m.type === "state" && m.state.tasks.length === 1));
		await waitFor(() => b.some((m) => m.type === "state" && m.state.tasks.length === 1));
		wsA.close();
		wsB.close();
	} finally {
		server.stop(true);
		restoreGjc();
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("GJC-derived session states distinguish input, permission, work, idle and unknown", async () => {
	const { sessionState } = await import("../src/dashboard");
	const now = Date.now();
	const live = { live: true, activity: "idle", lastHeartbeatAt: now };
	expect(sessionState(live, { asks: 1, permissions: 0 }, now).state).toBe("waiting_answer");
	expect(sessionState(live, { asks: 0, permissions: 1 }, now).state).toBe("waiting_permission");
	expect(sessionState(live, { asks: 0, permissions: 0 }, now).state).toBe("idle");
	expect(sessionState(live, undefined, now).state).toBe("unknown");
	// A failed request read never turns into "working" just because the heartbeat says active.
	expect(sessionState({ ...live, activity: "active" }, undefined, now).state).toBe("unknown");
	expect(sessionState(live, { asks: 0, permissions: 0, gates: 1 }, now).state).toBe("waiting_workflow");
	expect(sessionState({ ...live, activity: "active" }, { asks: 0, permissions: 0 }, now).state).toBe("working");
	expect(sessionState({ ...live, lastHeartbeatAt: now - 180000 }, undefined, now).state).toBe("stale");
	expect(sessionState({ ...live, live: false }, { asks: 1, permissions: 0 }, now).state).toBe("ended");
});

test("request query failures preserve bounded diagnostics without failing the sessions list", async () => {
	const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
	const empty = JSON.stringify({ ok: true, page: { items: [] } });
	const permission = JSON.stringify({ ok: true, result: { requests: [] } });
	const cases = [
		{ response: JSON.stringify({ ok: false, error: { code: "quota_exceeded", message: "private quota details" } }), code: "command_failed" },
		{ response: "not json", code: "query_malformed" },
		{ response: JSON.stringify({ ok: true, page: {} }), code: "query_malformed" },
		{ response: JSON.stringify({ ok: false, error: { code: "x".repeat(500), message: "private" } }), code: "command_failed" },
		{ response: undefined, code: "query_threw" },
		{ response: empty, code: undefined },
	];
	const stubs = stubPrograms(["sh", "gjc"]);
	try {
	for (const scenario of cases) {
		const spawn = spyOn(Bun, "spawn").mockImplementation(((cmd: string[]) => {
			let stdout: string;
			if (cmd[0] === stubs.program("sh")) {
				if (scenario.response === undefined) throw new Error("private spawn error");
				stdout = [scenario.response, permission, empty].join("\n==FLEET-BATCH-SEP==\n");
			} else stdout = JSON.stringify({ ok: true, result: { sessions: [{ sessionId: id, live: true, activity: { state: "active" }, lastHeartbeatAt: Date.now() }] } });
			return { stdout: new Response(stdout).body, stderr: new Response("").body, exited: Promise.resolve(0), exitCode: 0 };
		}) as any);
		try {
			const probe = await probeNode({ id: "controlled", os: "linux", sdkTransport: { command: "gjc", args: [] } } as any, {
				version: "controlled", versionAt: Date.now(), titles: new Map([[id, null]]),
			});
			expect(probe.sessionsOk).toBe(true);
			expect(probe.totalSessions).toBe(1);
			expect(probe.liveSessions).toBe(1);
			const session = probe.sessions![0]!;
			expect(session.state).toBe(scenario.code ? "unknown" : "working");
			expect(session.pending).toBeUndefined();
			if (scenario.code) {
				expect(session.requestErrors?.[0]).toEqual({ source: "ask.requests.list", code: scenario.code });
				expect(session.requestErrors!.length).toBeLessThanOrEqual(3);
				expect(session.requestErrors!.every((error) => error.code.length <= 80)).toBe(true);
			} else expect(session.requestErrors).toBeUndefined();
			expect(JSON.stringify(probe)).not.toContain("private");
		} finally {
			spawn.mockRestore();
		}
	}
	} finally {
		stubs.restore();
	}
});

test("resource stream lines parse into measurements", () => {
	const first = parseResourceLine("L 4 0.50 900 1000 8000000 6000000|100000 60000 /|2000000 500000 /mnt/data disk", undefined);
	expect(first?.resources).toMatchObject({ ok: true, cores: 4, load1: 0.5, memTotal: 8000000 * 1024, memUsed: 2000000 * 1024 });
	expect(first?.resources.disks).toEqual([
		{ path: "/", total: 100000 * 1024, used: 40000 * 1024 },
		{ path: "/mnt/data disk", total: 2000000 * 1024, used: 1500000 * 1024 },
	]);
	// Without a previous sample CPU is unmeasured (no load-average stand-in); with one it is the real busy delta.
	expect(first?.resources.cpuPct).toBeUndefined();
	const second = parseResourceLine("L 4 0.50 950 1200 8000000 6000000|100000 60000 /", first?.counters);
	expect(second?.resources.cpuPct).toBeCloseTo(75);

	const mac = parseResourceLine("D 10 6.2 34359738368 10000000000 10 35|482797652 206217532 /|1953498180 1007129140 /Volumes/Data", undefined);
	expect(mac?.resources).toMatchObject({ ok: true, cores: 10, cpuPct: 65, memUsed: 34359738368 - 10000000000 });
	// A Mac line without the iostat idle column leaves CPU unmeasured instead of using load.
	expect(parseResourceLine("D 10 6.2 34359738368 10000000000 10|1 1 /", undefined)?.resources.cpuPct).toBeUndefined();
	expect(mac?.resources.disks?.map((disk) => disk.path)).toEqual(["/", "/Volumes/Data"]);

	const win = parseResourceLine("W 8 36 22989320 17838480|255352852480 108416958464 C:|1000 400 D:", undefined);
	expect(win?.resources).toMatchObject({ ok: true, cores: 8, cpuPct: 36, memTotal: 22989320 * 1024 });
	expect(win?.resources.disks).toEqual([
		{ path: "C:", total: 255352852480, used: 255352852480 - 108416958464 },
		{ path: "D:", total: 1000, used: 600 },
	]);

	expect(parseResourceLine("L 4 0.50 900 1000 8000000 6000000", undefined)?.resources.disks).toEqual([]);
	expect(parseResourceLine("E no-sshd-session", undefined)).toBeUndefined();
	expect(parseResourceLine("", undefined)).toBeUndefined();
});

test("darwin resource stream uses absolute sbin/bin paths", () => {
	const node = {
		id: "mac",
		os: "darwin" as const,
		arch: "arm64" as const,
		roots: {},
		workspaceRoot: "/tmp",
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		transport: { command: "ssh", args: ["host", "gjc"] },
		operations: [] as string[],
	};
	const script = streamCommand(node)?.script ?? "";
	expect(script).toContain("/usr/sbin/sysctl");
	expect(script).toContain("/usr/sbin/iostat");
	expect(script).not.toMatch(/(?<!\/usr\/sbin\/)sysctl /);
	expect(script).not.toMatch(/(?<!\/usr\/sbin\/)iostat /);
});

test("node remove drops an unused node and rejects unknown ids", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-node-rm-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode({
			id: "spare",
			os: "linux",
			arch: "x64",
			roots: { fleet: "/srv/fleet" },
			workspaceRoot: "/srv/fleet/workspaces",
			maxConcurrency: 1,
			enabled: true,
			draining: false,
			reachable: true,
			sdkReady: false,
			modelReady: false,
			models: [],
			modelProfiles: [],
			operations: [],
			transport: { command: "ssh", args: ["spare", "gjc"] },
		} as any);
		expect(store.nodes().map((node) => node.id)).toEqual(["spare"]);
		expect(() => store.removeNode("missing")).toThrow("node_not_found");
		store.removeNode("spare");
		expect(store.nodes()).toEqual([]);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("admission charges only tasks a sample cannot contain and rejects non-finite measurements", async () => {
	const { resourceReasons, unmeasuredTasks } = await import("../src/admission");
	const now = Date.now();
	const held = [
		{ reservedAt: now - 60_000, started: true },
		{ reservedAt: now - 60_000, started: false },
		{ reservedAt: now + 500, started: true },
	];
	expect(unmeasuredTasks(held, now)).toBe(2);
	expect(unmeasuredTasks(undefined, now)).toBe(0);
	const GiB = 1024 ** 3;
	const base = { ok: true, at: now, cpuPct: 10, memTotal: 16 * GiB, memUsed: 8 * GiB, disks: [{ path: "/", total: 100 * GiB, used: 10 * GiB }] };
	expect(resourceReasons("/srv/w", base, 0, now)).toEqual([]);
	expect(resourceReasons("/srv/w", { ...base, memUsed: Number.NaN }, 0, now)).toContain("resources_unknown");
	expect(resourceReasons("/srv/w", { ...base, disks: [{ path: "/", total: Number.NaN, used: 0 }] }, 0, now)).toContain("workspace_disk_unknown");
	expect(resourceReasons("/srv/w", { ...base, cpuPct: undefined }, 0, now)).toContain("resources_unknown");
	expect(resourceReasons("/srv/w", { ...base, at: now - 60_000 }, 0, now)).toEqual(["resources_stale"]);
	expect(resourceReasons("/srv/w", { ...base, at: Number.NaN }, 0, now)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 7, now)).toContain("memory_low");
	// Caller/policy NaN must fail closed (NaN inequalities would otherwise skip memory/stale gates).
	expect(resourceReasons("/srv/w", base, 0, Number.NaN)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, Number.NaN, now)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, -1, now)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 1.5, now)).toEqual(["resources_unknown"]);
	const { DEFAULT_ADMISSION_POLICY, admissionPolicyOk } = await import("../src/admission");
	expect(admissionPolicyOk(DEFAULT_ADMISSION_POLICY)).toBe(true);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, balloonTrust: Number.NaN })).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, balloonTrust: 1.5 })).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, minFreeMemBytes: Number.NaN })).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, maxSampleAgeMs: Number.NaN })).toEqual(["resources_unknown"]);
	// Review non-blocking: NaN maxCpuPct and Infinity callers/policy must also fail closed.
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, maxCpuPct: Number.NaN })).toEqual(["resources_unknown"]);
	expect(admissionPolicyOk({ ...DEFAULT_ADMISSION_POLICY, maxCpuPct: Number.NaN })).toBe(false);
	expect(resourceReasons("/srv/w", base, 0, Number.POSITIVE_INFINITY)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, Number.POSITIVE_INFINITY, now)).toEqual(["resources_unknown"]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, maxSampleAgeMs: Number.POSITIVE_INFINITY })).toEqual([
		"resources_unknown",
	]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, balloonTrust: Number.NEGATIVE_INFINITY })).toEqual([
		"resources_unknown",
	]);
	expect(resourceReasons("/srv/w", base, 0, now, { ...DEFAULT_ADMISSION_POLICY, balloonTrust: 0 })).toEqual([]);
});

test("drive-letter workspaces match only their own volume and never a POSIX root disk", async () => {
	const { resourceReasons, workspaceDisk } = await import("../src/admission");
	const { headroom } = await import("./admission-fixture");
	const now = Date.now();
	const base = { ...headroom(["local"], 1).samples.get("local")!, at: now };
	// The Windows probe reports Win32_LogicalDisk DeviceID, e.g. "C:".
	const disk = { path: "C:", total: 1024 ** 4, used: 0 };
	expect(workspaceDisk("c:\\owned\\work", [disk])).toEqual(disk);
	expect(workspaceDisk("C:\\owned", [{ ...disk, path: "C:\\" }])?.path).toBe("C:\\");
	expect(workspaceDisk("D:\\owned", [disk])).toBeUndefined();
	expect(resourceReasons("C:\\owned", { ...base, disks: [{ ...disk, path: "/" }] }, 0, now)).toContain("workspace_disk_unknown");
	expect(resourceReasons("C:\\owned", { ...base, disks: [disk] }, 0, now)).toEqual([]);
	expect(resourceReasons("C:\\owned", { ...base, disks: [{ ...disk, used: disk.total }] }, 0, now)).toContain("disk_low");
	// The shared fixture admits a local workspace on this host's cwd and temp volumes.
	expect(resourceReasons(process.cwd(), base, 0, now)).toEqual([]);
	expect(resourceReasons(tmpdir(), base, 0, now)).toEqual([]);
});

test("balloon-reclaimed Linux memory is reported apart from real use and half-trusted for admission", async () => {
	const { linuxMemory } = await import("../src/dashboard");
	const { resourceReasons } = await import("../src/admission");
	const GiB = 1024 ** 3;
	// A host with a large balloon: 7.75 GiB total, 0.3 GiB MemAvailable, kernel reports Balloon: 6443824 kB.
	const ballooned = linuxMemory(8_124_900, 318_276, 6_443_824);
	expect(ballooned.memReclaimed! / GiB).toBeGreaterThan(6);
	expect(ballooned.memUsed! / GiB).toBeLessThan(2);
	// A host without reclaimable memory reports Balloon: 0 kB; an old kernel without the line reports -1. Neither is split.
	expect(linuxMemory(24_548_032, 17_418_388, 0).memReclaimed).toBeUndefined();
	const plain = linuxMemory(16_000_000, 8_000_000, -1);
	expect(plain.memReclaimed).toBeUndefined();
	expect(plain.memUsed).toBe(8_000_000 * 1024);
	const now = Date.now();
	const base = { ok: true, at: now, cpuPct: 5, disks: [{ path: "/", total: 100 * GiB, used: 1 * GiB }] };
	expect(resourceReasons("/home/user/w", { ...base, ...ballooned }, 0, now)).toEqual([]);
	// Without the balloon split the same node looks out of memory.
	expect(resourceReasons("/home/user/w", { ...base, memTotal: ballooned.memTotal, memUsed: ballooned.memTotal - 318_276 * 1024 }, 0, now)).toContain("memory_low");
});

// Windows: Bun.spawn kill of `sh -c … sleep` often leaves the tree alive, so reconnect never launches.
test.skipIf(process.platform === "win32")(
	"a resource stream that goes silent is killed and reconnected",
	async () => {
		const { startResourceStreams } = await import("../src/dashboard");
		const node = { id: "FROZEN", os: "linux" } as any;
		let launches = 0;
		const samples: boolean[] = [];
		const streams = startResourceStreams(
			() => [node],
			(_id, resources) => samples.push(resources.ok),
			{
				stallMs: 400,
				// One valid sample, then the remote freezes without closing the session.
				command: () => {
					launches += 1;
					return {
						argv: ["sh", "-c", "echo 'L 4 0.50 900 1000 8000000 6000000|100000 60000 /'; exec sleep 600"],
						script: "\n",
					};
				},
			},
		);
		try {
			const deadline = Date.now() + 8_000;
			while (launches < 2 && Date.now() < deadline) await Bun.sleep(50);
			expect(launches).toBeGreaterThanOrEqual(2);
			expect(samples[0]).toBe(true);
			expect(samples).toContain(false); // the stall surfaced as a reconnecting, not-ok state
		} finally {
			streams.stop();
		}
	},
	15_000,
);

test("a resource stream that keeps sampling is not killed", async () => {
	const { startResourceStreams } = await import("../src/dashboard");
	const node = { id: "LIVE", os: "linux" } as any;
	let launches = 0;
	const streams = startResourceStreams(() => [node], () => {}, {
		// Loaded hosts: a live sampler can be starved past 400 ms without being dead; 2 s still catches a dead stream below.
		stallMs: 2_000,
		command: () => {
			launches += 1;
			return { argv: ["sh", "-c", "while read -r _; do echo 'L 4 0.50 900 1000 8000000 6000000|100000 60000 /'; done"], script: "\n" };
		},
	});
	try {
		// One full stall window: a stream that dies is still killed and relaunched inside it.
		await Bun.sleep(2_500);
		expect(launches).toBe(1);
	} finally {
		streams.stop();
	}
});

test.skipIf(process.platform === "win32")("stall SIGKILLs a SIGTERM-trapping silent stream so reconnect can proceed", async () => {
	const { startResourceStreams } = await import("../src/dashboard");
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-stream-stall-"));
	const pidFile = join(dir, "pid");
	const node = { id: "STALLTRAP", os: "linux" } as any;
	let launches = 0;
	const streams = startResourceStreams(() => [node], () => {}, {
		stallMs: 400,
		command: () => {
			launches += 1;
			return {
				argv: [
					"sh",
					"-c",
					`trap '' TERM; echo $$ >${JSON.stringify(pidFile)}; echo 'L 4 0.50 900 1000 8000000 6000000|100000 60000 /'; exec sleep 600`,
				],
				script: "\n",
			};
		},
	});
	try {
		const readyUntil = Date.now() + 5_000;
		let pid = "";
		while (Date.now() < readyUntil) {
			try {
				pid = (await readFile(pidFile, "utf8")).trim();
				if (/^\d+$/.test(pid)) break;
			} catch {
				/* not written yet */
			}
			await Bun.sleep(20);
		}
		expect(pid).toMatch(/^\d+$/);
		const deadline = Date.now() + 8_000;
		while (launches < 2 && Date.now() < deadline) await Bun.sleep(50);
		expect(launches).toBeGreaterThanOrEqual(2);
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
		streams.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "win32")("hub stop SIGKILLs a SIGTERM-trapping stream without waiting for grace", async () => {
	const { startResourceStreams } = await import("../src/dashboard");
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-stream-stop-"));
	const pidFile = join(dir, "pid");
	const node = { id: "TRAP", os: "linux" } as any;
	const streams = startResourceStreams(() => [node], () => {}, {
		stallMs: 60_000,
		command: () => ({
			// Ignore SIGTERM so a grace-only stop would leave this alive for STOP_KILL_GRACE_MS (1s).
			argv: [
				"sh",
				"-c",
				`trap '' TERM; echo $$ >${JSON.stringify(pidFile)}; echo 'L 4 0.50 900 1000 8000000 6000000|100000 60000 /'; while read -r _; do :; done`,
			],
			script: "\n",
		}),
	});
	try {
		const readyUntil = Date.now() + 5_000;
		let pid = "";
		while (Date.now() < readyUntil) {
			try {
				pid = (await readFile(pidFile, "utf8")).trim();
				if (/^\d+$/.test(pid)) break;
			} catch {
				/* not written yet */
			}
			await Bun.sleep(20);
		}
		expect(pid).toMatch(/^\d+$/);
		expect(() => process.kill(Number(pid), 0)).not.toThrow();
		const t0 = Date.now();
		streams.stop();
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
		expect(Date.now() - t0).toBeLessThan(800);
	} finally {
		streams.stop();
		await rm(dir, { recursive: true, force: true });
	}
});

test("eventsByTask returns for every task exactly what events(taskId) returns (one grouped read for the dashboard)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-events-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	const input = (key: string) => ({ schemaVersion: 1, key, caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} }) as any;
	const ids = ["one", "two", "three"].map((key) => store.submit(input(key)).id);
	const grouped = store.eventsByTask();
	for (const id of ids) {
		expect(store.events(id).length).toBeGreaterThan(0);
		expect(grouped.get(id)).toEqual(store.events(id));
	}
	expect([...grouped.keys()].sort()).toEqual([...ids].sort());
	store.close();
	await rm(dir, { recursive: true, force: true });
});

test("live dashboard lists every non-archived card with deferred timelines so nothing is sliced away", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-omit-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const held: string[] = [];
		for (let i = 0; i < 5; i++) held.push(activeOn(store, "n", `held-${i}`));
		const awaiting: string[] = [];
		for (let i = 0; i < 3; i++) {
			const id = activeOn(store, "n", `await-verify-${i}`);
			const body = { sessionId: `session-${id}`, turnId: `turn-${id}`, status: "completed_unverified" as const, terminal: true, evidence: { native: "await" } };
			store.observe(id, { eventId: `await-${id}`, digest: observationDigest(body), ...body });
			awaiting.push(id);
		}
		for (let i = 0; i < 45; i++) {
			const id = activeOn(store, "n", `done-${i}`);
			const body = { sessionId: `session-${id}`, turnId: `turn-${id}`, status: "succeeded" as const, terminal: true, evidence: { native: "done" } };
			store.observe(id, { eventId: `done-${id}`, digest: observationDigest(body), ...body });
		}
		const state = getDashboardState(store);
		expect(state.summary.heldTasks).toBe(5);
		expect(state.summary.omittedTasks).toBe(0);
		expect(state.summary.listedTasks).toBe(state.summary.totalTasks);
		for (const id of held) expect(state.tasks.some((task) => task.id === id)).toBe(true);
		for (const id of awaiting) {
			const row = state.tasks.find((task) => task.id === id)!;
			expect(row.phase).toBe("completed_unverified");
			expect(row.executionTerminal).toBe(true);
			expect(row.timeline).toEqual([]);
			expect((row.timelineOmitted ?? 0) > 0).toBe(true);
		}
		expect(state.tasks.length).toBe(53);
		expect(renderDashboardHtml()).toContain("Expand to load all");
		expect(renderDashboardHtml()).toContain("older finished tasks");
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("live dashboard slims selection/stages/title and page HTML omits closed fold cards", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-slim-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const held = activeOn(store, "n", "held-slim");
		for (let i = 0; i < 8; i++) {
			const id = activeOn(store, "n", `done-slim-${i}`);
			const body = { sessionId: `session-${id}`, turnId: `turn-${id}`, status: "succeeded" as const, terminal: true, evidence: { native: "done" } };
			store.observe(id, { eventId: `done-${id}`, digest: observationDigest(body), ...body });
		}
		const input = {
			schemaVersion: 1,
			key: "archived-slim",
			caller: "test",
			repoId: "repo",
			baseCommit: "a".repeat(40),
			prompt: "A".repeat(200),
			required: {},
		} as any;
		const archivedId = store.submit(input).id;
		store.withdrawQueued(archivedId, "slim archive", "operator");
		const live = getDashboardState(store);
		const heldRow = live.tasks.find((task) => task.id === held)!;
		expect(heldRow.selection?.exclusions ?? []).toEqual([]);
		expect(heldRow.stages.every((at) => at === null)).toBe(true);
		expect(heldRow.stageIndex).toBeGreaterThanOrEqual(0);
		expect(heldRow.title.length).toBeLessThanOrEqual(48);
		const archivedRow = live.archivedTasks.find((task) => task.id === archivedId)!;
		expect(archivedRow.title.length).toBeLessThanOrEqual(48);
		expect(archivedRow.selection?.exclusions ?? []).toEqual([]);
		const detail = getDashboardTask(store, held)!;
		expect((detail.selection?.exclusions.length ?? 0) >= 0).toBe(true);
		expect(detail.stages.some((at) => at !== null)).toBe(true);
		expect(detail.title.length).toBeGreaterThan(0);
		const html = renderDashboardHtml();
		expect(html).toContain("folds.tasks?done.map");
		expect(html).toContain("folds.archived?archived.map");
		expect(html).toContain("Lazy: do not mount folded cards");
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("live dashboard payload strips settled timelines while keeping attention timelines", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-light-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const held = activeOn(store, "n", "keep-timeline");
		for (let i = 0; i < 5; i++) {
			const sequence = store.beginObservation(held)!;
			store.abandonObservation(held, sequence, { source: "Fleet.inspect.read_turn", errorType: "transport_error", certainty: "unknown" });
		}
		const done = activeOn(store, "n", "strip-timeline");
		const body = { sessionId: `session-${done}`, turnId: `turn-${done}`, status: "succeeded" as const, terminal: true, evidence: { native: "done" } };
		store.observe(done, { eventId: `done-${done}`, digest: observationDigest(body), ...body });
		const input = { schemaVersion: 1, key: "archived-card", caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any;
		const archivedId = store.submit(input).id;
		store.withdrawQueued(archivedId, "dashboard light archive", "operator");
		const state = getDashboardState(store);
		const heldRow = state.tasks.find((task) => task.id === held)!;
		const doneRow = state.tasks.find((task) => task.id === done)!;
		const archivedRow = state.archivedTasks.find((task) => task.id === archivedId)!;
		// Poll/settlement noise stays deferred; attention kinds (if any) would remain.
		expect(heldRow.timeline).toEqual([]);
		expect((heldRow.timelineOmitted ?? 0) > 0).toBe(true);
		expect(doneRow.timeline).toEqual([]);
		expect((doneRow.timelineOmitted ?? 0) > 0).toBe(true);
		expect(archivedRow.phase).toBe("archived");
		expect(archivedRow.timeline).toEqual([]);
		expect((archivedRow.timelineOmitted ?? 0) > 0).toBe(true);
		expect(state.summary.listedArchived).toBe(1);
		expect(state.summary.omittedArchived).toBe(0);
		const heldDetail = getDashboardTask(store, held)!;
		expect(heldDetail.timeline.some((row) => row.kind === "abandoned_poll")).toBe(true);
		expect(heldDetail.timelineOmitted ?? 0).toBe(0);
		const detail = getDashboardTask(store, archivedId)!;
		expect(detail.timeline.length).toBeGreaterThan(0);
		expect(detail.timeline.some((row) => row.kind === "withdrawn" || row.kind === "submitted")).toBe(true);
		expect(renderDashboardHtml()).toContain("/api/task/");
		expect(renderDashboardHtml()).toContain("Expand to load all");
		expect(renderDashboardHtml()).toContain("Failed to load history");

		const raw = (store as unknown as { db: { query: (sql: string) => { get: (id: string) => { data: string }; run: (...args: unknown[]) => unknown } } }).db
			.query("SELECT data FROM tasks WHERE id=?")
			.get(archivedId) as { data: string };
		const data = JSON.parse(raw.data) as { archivedFrom?: { phase: string; reason?: string; result?: unknown } };
		data.archivedFrom = { phase: "failed", reason: "fat", result: { status: "failed", evidence: { blob: "x".repeat(50_000) } } };
		(store as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => unknown } } }).db
			.query("UPDATE tasks SET data=? WHERE id=?")
			.run(JSON.stringify(data), archivedId);
		const live = getDashboardState(store).archivedTasks.find((task) => task.id === archivedId)!;
		expect(live.archivedFrom).toEqual({ phase: "failed", reason: "fat" });
		expect(live.archivedFrom).not.toHaveProperty("result");
		const full = getDashboardTask(store, archivedId)!;
		expect(full.archivedFrom).toMatchObject({ phase: "failed", reason: "fat", result: expect.objectContaining({ status: "failed" }) });
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("selectDashboardTasks never drops priority rows even above the soft limit", () => {
	const mk = (id: string, phase: DashboardTask["phase"], held: boolean, at: string, executionTerminal = false): DashboardTask => ({
		id, key: id, title: id, caller: "t", phase, held, executionTerminal, required: {}, preferences: [],
		stages: Array(7).fill(null), stageIndex: -1, submittedAt: at, timeline: [], outcome: null,
	});
	const visible = [
		...Array.from({ length: 50 }, (_, i) => mk(`held-${i}`, "active", true, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`)),
		mk("await-verify", "completed_unverified", false, "2026-01-01T00:00:59Z", true),
		mk("old-done", "succeeded", false, "2026-01-01T00:00:00Z"),
	];
	const { tasks, omitted } = selectDashboardTasks(visible, 40);
	expect(tasks).toHaveLength(51);
	expect(omitted).toBe(1);
	expect(tasks.some((task) => task.id === "await-verify")).toBe(true);
	expect(tasks.some((task) => task.id === "old-done")).toBe(false);
});

test("repeated abandoned_poll rows collapse in the dashboard timeline with the latest failure detail", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-poll-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	try {
		store.putNode(node("n", dir));
		const id = activeOn(store, "n", "poll-noise");
		for (let i = 0; i < 120; i++) {
			const sequence = store.beginObservation(id)!;
			store.abandonObservation(id, sequence, {
				source: "Fleet.inspect.read_turn",
				errorType: "transport_error",
				certainty: "unknown",
			});
		}
		expect(store.recordDaemonNote(id, "observation_repeated_failure_operator_recovery_required")).toBe(true);
		expect(store.events(id).filter((e) => e.kind === "abandoned_poll")).toHaveLength(120);

		const listed = getDashboardState(store).tasks.find((row) => row.id === id)!;
		expect(listed.timeline).toEqual([]);
		expect((listed.timelineOmitted ?? 0) > 0).toBe(true);
		const task = getDashboardTask(store, id)!;
		const abandoned = task.timeline.filter((row) => row.kind === "abandoned_poll");
		expect(abandoned).toHaveLength(1);
		expect(abandoned[0]).toMatchObject({
			count: 120,
			detail: "Fleet.inspect.read_turn · transport_error",
		});
		expect(task.timelineOmitted ?? 0).toBe(0);
		expect(task.timeline.filter((row) => row.kind === "daemon_note")).toEqual([
			expect.objectContaining({ detail: "observation_repeated_failure_operator_recovery_required" }),
		]);

		const html = renderDashboardHtml();
		expect(html).toContain("Query failed · observation not applied");
		expect(html).toContain("Recovery note");
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("bulk reads used by the dashboard equal the per-task reads: resourceReturnStatuses(states) and heldCharges(states)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-bulk-"));
	const store = new FleetStore(join(dir, "fleet.sqlite"));
	store.putNode(node("A", dir));
	const active = activeOn(store, "A", "bulk-held");
	const input = (key: string) => ({ schemaVersion: 1, key, caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} }) as any;
	store.submit(input("bulk-queued"));
	const states = store.taskStates();
	const bulk = store.resourceReturnStatuses(states);
	for (const task of states) expect(bulk.get(task.id)).toEqual(store.resourceReturnStatus(task.id));
	expect([...store.heldCharges(states)]).toEqual([...store.heldCharges()]);
	expect(store.heldCharges(states).get("A")?.length).toBe(1);
	expect(active).toBeDefined();
	store.close();
	await rm(dir, { recursive: true, force: true });
});
