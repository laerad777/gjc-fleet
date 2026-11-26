import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import type { NodeConfig } from "../src/contracts";
import { dashboardSshEvidence, dashboardSshLinks, dashboardSshRoute, dashboardTaskAttention } from "../src/dashboard-map-view";
import { renderDashboardHtml, startDashboardServer, type DashboardState } from "../src/dashboard";
import { FleetStore } from "../src/store";

const evidence = { executionTerminal: false, exportReview: false, receiptConflict: false, resultSaved: false, unplaceable: false };
const checkedAt = "2026-01-01T00:00:00.000Z";
const node: NodeConfig = {
	id: "fixture-node", os: "linux", arch: "x64", roots: {}, workspaceRoot: "/fixture-workspaces",
	enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
	models: [], operations: [], maxConcurrency: 99,
	transport: { command: "ssh", args: ["fixture-endpoint.invalid", "fixture-coordinator"] },
};

test("unknown execution, approval, failure and collection are different operator states", () => {
	expect(dashboardTaskAttention("blocked_unknown", evidence)).toBe("needs_confirmation");
	expect(dashboardTaskAttention("cancel_unknown", evidence)).toBe("needs_confirmation");
	expect(dashboardTaskAttention("failed", evidence)).toBe("failed");
	expect(dashboardTaskAttention("failed", { ...evidence, receiptConflict: true })).toBe("needs_confirmation");
	expect(dashboardTaskAttention("approval_required", evidence)).toBe("approval_required");
	expect(dashboardTaskAttention("completed_unverified", { ...evidence, exportReview: true })).toBe("needs_confirmation");
	expect(dashboardTaskAttention("completed_unverified", { ...evidence, executionTerminal: true, exportReview: true })).toBe("approval_required");
	expect(dashboardTaskAttention("completed_unverified", { ...evidence, executionTerminal: true })).toBe("collect_result");
	expect(dashboardTaskAttention("completed_unverified", { ...evidence, executionTerminal: true, resultSaved: true })).toBe("verify_result");
	expect(dashboardTaskAttention("queued", { ...evidence, unplaceable: true })).toBe("unplaceable");
	expect(dashboardTaskAttention("queued", evidence)).toBe("queued");
	for (const phase of ["preparing", "dispatching", "active"] as const) expect(dashboardTaskAttention(phase, evidence)).toBe("running");
	for (const phase of ["succeeded", "archived", "cancelled"] as const) expect(dashboardTaskAttention(phase, evidence)).toBe("settled");
});

test("a recent observation only proves the exact configured hub-to-node direction", () => {
	const local = { ...node, id: "local", sdkTransport: { command: "gjc", args: [] } };
	const another = { ...node, id: "another" };
	const sample = { checkedAt, receivedAt: 50, route: dashboardSshRoute(node) };
	const lookup = (n: NodeConfig) => n.id === node.id ? dashboardSshEvidence(n, sample, true, 12050, 12000) : undefined;
	const links = dashboardSshLinks([node, local, another], lookup);
	expect(links).toEqual([
		{ nodeId: node.id, hubToNode: { status: "observed", checkedAt }, nodeToHub: { status: "not_checked", checkedAt: null } },
		{ nodeId: another.id, hubToNode: { status: "not_checked", checkedAt: null }, nodeToHub: { status: "not_checked", checkedAt: null } },
	]);
	expect(JSON.stringify(links)).not.toContain("fixture-endpoint");
	expect(dashboardSshEvidence(node, sample, true, 12051, 12000)?.fresh).toBe(false);
	expect(dashboardSshLinks([node], () => dashboardSshEvidence(node, sample, false, 60, 12000))[0]?.hubToNode).toEqual({ status: "stale", checkedAt });
	expect(dashboardSshEvidence(node, sample, true, 49, 12000)?.fresh).toBe(false);
	const replaced = { ...node, transport: { command: "ssh", args: ["other-endpoint.invalid", "fixture-coordinator"] } };
	expect(dashboardSshEvidence(replaced, sample, true, 60, 12000)).toBeUndefined();
});

test("read-only dashboard JSON with node probes disabled never claims configured SSH is connected", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-map-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		store.putNode(node);
		const server = startDashboardServer(store, 0, "127.0.0.1", { probeNodes: false });
		try {
			const response = await fetch(new URL("/api/state", server.url));
			expect(response.ok).toBe(true);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const state = await response.json() as DashboardState;
			expect(state.sshLinks).toEqual(dashboardSshLinks([node]));
			expect(state.nodes.map((n: { currentLoad: number; heldNotRunning: number }) => [n.currentLoad, n.heldNotRunning])).toEqual([[0, 0]]);
			expect(JSON.stringify(state)).not.toContain("fixture-endpoint");
			expect(state.nodes[0]?.admission).toBeNull();
			expect(state.nodes[0]).not.toHaveProperty("laneCapacity");
		} finally { server.stop(true); }
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

class MapElement {
	innerHTML = "";
	textContent = "";
	className = "";
	lastElementChild = { textContent: "" };
	listeners = new Map<string, (event: { target: { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null } }) => void>();
	classList = { add() {}, remove() {}, toggle() {} };
	addEventListener(name: string, handler: (event: { target: { closest: (selector: string) => { getAttribute: (name: string) => string | null } | null } }) => void) {
		this.listeners.set(name, handler);
	}
}

async function renderMap(initial: Record<string, unknown>) {
	const elements = new Map<string, MapElement>();
	let script = "";
	const html = renderDashboardHtml();
	await new HTMLRewriter()
		.on("[id]", { element(element) { elements.set(element.getAttribute("id")!, new MapElement()); } })
		.on("script", { text(chunk) { script += chunk.text; } })
		.transform(new Response(html)).text();
	let socket: { onmessage?: (event: { data: string }) => void };
	class LocalSocket { constructor() { socket = this; } onmessage?: (event: { data: string }) => void }
	const requests: string[] = [];
	runInNewContext(script, {
		document: {
			getElementById: (id: string) => {
				const element = elements.get(id);
				if (!element) throw new Error(`Missing page element ${id}`);
				return element;
			},
			body: new MapElement(),
			querySelector: (selector: string) => {
				if (selector !== "main") throw new Error(`Unexpected selector ${selector}`);
				return new MapElement();
			},
			querySelectorAll: () => [],
		},
		fetch: async (url: string) => {
			requests.push(String(url));
			const path = String(url);
			if (path.startsWith("/api/task/")) {
				const id = decodeURIComponent(path.slice("/api/task/".length));
				const tasks = (initial.tasks as Array<{ id: string }> | undefined) ?? [];
				const task = tasks.find((row) => row.id === id);
				if (!task) return { ok: false, status: 404, json: async () => ({}) };
				return { ok: true, json: async () => task };
			}
			return { ok: true, json: async () => initial };
		},
		WebSocket: LocalSocket,
		location: { protocol: "http:", host: "dashboard.invalid" },
		setTimeout: () => 0,
		setInterval: () => 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	const open = async (nodeId: string) => {
		const click = elements.get("fm-nodes")!.listeners.get("click");
		if (!click) throw new Error("fleet node click listener missing");
		click({
			target: {
				closest: (selector: string) => selector === "[data-node]"
					? { getAttribute: (name: string) => name === "data-node" ? nodeId : null }
					: null,
			},
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
	};
	return {
		html,
		requests,
		element: (id: string) => elements.get(id)!,
		open,
		push(next: Record<string, unknown>) {
			socket!.onmessage?.({ data: JSON.stringify({ type: "state", state: next }) });
		},
	};
}

function mapNode(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id, os: "linux", arch: "x64", enabled: true, draining: false, reachable: true,
		sdkReady: true, modelReady: true, currentLoad: 0, heldNotRunning: 0, admission: null,
		modelProfiles: [], operations: [], holding: [], possiblyRunning: [], assignedTotal: 0,
		succeeded: 0, troubled: 0, exclusions: {}, probe: null, resources: null,
		endpoint: "fixture-endpoint.invalid",
		transport: { command: "ssh", args: ["fixture-endpoint.invalid"] },
		...overrides,
	};
}

test("the fleet map does not mark unchecked SSH as connected and keeps other nodes in flight", async () => {
	const source = readFileSync(join(import.meta.dir, "../src/dashboard-page.ts"), "utf8");
	expect(source).toContain("if(status==='observed')return 'fm-ssh-connected'");
	expect(source).not.toContain("maxConcurrency");
	expect(source).not.toContain("transport.args");
	expect(source).not.toContain("fixture-endpoint");
	expect(source.match(/new WebSocket/g)).toHaveLength(1);
	expect(source).toContain("Hover to peek. Click to go deeper.");
	expect(source).toContain("Tap to peek. Tap again to go deeper.");
	expect(source).toContain(".fm-stage:hover .fm-drift,.fm-stage.is-paused .fm-drift{animation-play-state:paused}");
	expect(source).toContain("@media (prefers-reduced-motion:reduce){.fm-drift{animation:none!important}}");
	expect(renderDashboardHtml()).toContain("GJC Fleet Dashboard");

	const checkedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
	const oracleId = "task-oracle-1";
	const state: Record<string, unknown> = {
		generatedAt: "2026-01-01T00:00:00.000Z",
		live: false,
		summary: {
			totalNodes: 4, healthyNodes: 3, activeTasks: 3, unsettledTasks: 0, provisionalTasks: 0,
			failureReportedTasks: 0, queuedTasks: 2, unplaceableTasks: 0, succeededTasks: 1,
			exportIncompleteTasks: 0, failedTasks: 0, heldTasks: 2, openNodes: null, totalTasks: 5,
			listedTasks: 5, omittedTasks: 0, listedArchived: 0, omittedArchived: 0,
		},
		pipeline: { stages: [{ key: "submitted", label: "Received", inFlight: 0, reached: 1 }], outcome: { succeeded: 1, unverified: 0, resultMissing: 0, unsettled: 0, troubled: 0, cancelled: 0, approval: 0 } },
		gjcRuntime: { installed: false, lastCheckedAt: "2026-01-01T00:00:00.000Z" },
		daemon: { alive: true, leaseExpiresAt: "2099-01-01T00:00:35.000Z", owner: "hub", pid: 1, host: "hub", startedAt: "2026-01-01T00:00:00.000Z", status: null },
		nodes: [
			mapNode("mac-studio", { os: "darwin", arch: "arm64", currentLoad: 2, heldNotRunning: 0, admission: { open: true, reasons: [] }, assignedTotal: 4, succeeded: 1, sdkReady: true, modelReady: true }),
			mapNode("home-pc", { os: "win32", arch: "x64", currentLoad: 1, heldNotRunning: 0, assignedTotal: 1 }),
			mapNode("linux-box", { currentLoad: 0, heldNotRunning: 0 }),
			mapNode("oracle-arm", {
				arch: "arm64", reachable: false, sdkReady: false, modelReady: false, currentLoad: 0, heldNotRunning: 1,
				admission: { open: false, reasons: ["unreachable"] }, assignedTotal: 5, succeeded: 3, troubled: 2,
				holding: [{ id: oracleId, key: "cancel-flow", phase: "blocked_unknown", executionTerminal: false }],
				probe: { nodeId: "oracle-arm", checkedAt, probed: true, ok: false },
				health: { gating: "observe", stable: false, failingDimensions: [], consecutiveGood: 0, required: 3, neverObservable: [], latestAt: Date.now() - 74_000 },
			}),
		],
		sshLinks: [
			{ nodeId: "mac-studio", hubToNode: { status: "observed", checkedAt }, nodeToHub: { status: "not_checked", checkedAt: null }, endpoint: "fixture-endpoint.invalid" },
			{ nodeId: "home-pc", hubToNode: { status: "stale", checkedAt }, nodeToHub: { status: "not_checked", checkedAt: null }, endpoint: "fixture-endpoint.invalid" },
			{ nodeId: "linux-box", hubToNode: { status: "not_checked", checkedAt: null }, nodeToHub: { status: "not_checked", checkedAt: null }, endpoint: "fixture-endpoint.invalid" },
			{ nodeId: "oracle-arm", hubToNode: { status: "not_checked", checkedAt: null }, nodeToHub: { status: "not_checked", checkedAt: null }, endpoint: "fixture-endpoint.invalid" },
		],
		tasks: [
			{ id: "t-mac-1", key: "build-a", title: "Build A", caller: "t", phase: "active", attention: "running", nodeId: "mac-studio", held: true, executionTerminal: false, required: {}, preferences: [], stages: [null, null, null, null, null, null, null], stageIndex: 4, timeline: [], outcome: null },
			{ id: "t-mac-2", key: "build-b", title: "Build B", caller: "t", phase: "preparing", attention: "running", nodeId: "mac-studio", held: true, executionTerminal: false, required: {}, preferences: [], stages: [null, null, null, null, null, null, null], stageIndex: 2, timeline: [], outcome: null },
			{ id: "t-home", key: "home-job", title: "Home job", caller: "t", phase: "dispatching", attention: "running", nodeId: "home-pc", held: true, executionTerminal: false, required: {}, preferences: [], stages: [null, null, null, null, null, null, null], stageIndex: 1, timeline: [], outcome: null },
			{ id: oracleId, key: "cancel-flow", title: "Linux E2E cancel flow", caller: "t", phase: "blocked_unknown", attention: "needs_confirmation", nodeId: "oracle-arm", held: true, executionTerminal: false, required: { nodeId: "oracle-arm" }, preferences: [], selection: { nodeId: "oracle-arm", exclusions: [] }, stages: [null, null, null, null, null, null, null], stageIndex: 4, timeline: [], outcome: null },
		],
		archivedTasks: [],
	};
	const view = await renderMap(state);
	expect(view.requests).toEqual(["/api/state"]);
	const nodes = view.element("fm-nodes").innerHTML;
	const lines = view.element("fm-lines").innerHTML;
	const paths = lines.match(/<path\b[^>]*>/g) ?? [];
	expect(paths.length).toBeGreaterThan(0);
	for (const path of paths) {
		if (path.includes('data-status="not_checked"') || path.includes('data-status="stale"') || path.includes('data-dir="node-to-hub"')) {
			expect(path).not.toContain("fm-ssh-connected");
		}
	}
	expect(paths.some((path) => path.includes('data-dir="hub-to-node"') && path.includes('data-status="observed"') && path.includes("fm-ssh-connected"))).toBe(true);
	expect(lines).toContain('data-link="home-pc" data-status="stale"');
	expect(lines).toContain('data-link="linux-box" data-status="not_checked"');
	expect(lines).toContain('data-link="oracle-arm" data-status="not_checked"');
	expect(lines).not.toContain('data-dir="peer"');
	expect(lines).toContain('data-kind="dispatch" data-link="mac-studio"');
	expect(lines).toContain('data-kind="dispatch" data-link="home-pc"');
	expect(lines).toContain('data-kind="gone" data-link="oracle-arm"');
	expect(nodes).toContain('data-node="mac-studio" data-down="0" data-inflight="2"');
	expect(nodes).toContain('data-node="home-pc" data-down="0" data-inflight="1"');
	expect(nodes).toContain('data-node="linux-box" data-down="0" data-inflight="0"');
	expect(nodes).toContain('data-node="oracle-arm" data-down="1"');
	expect(nodes).toContain('class="fm-count is-risk">1</span>');
	expect(view.element("fm-title").innerHTML).toContain("still running");
	expect(view.element("fm-title").innerHTML.toLowerCase()).not.toContain("stopped");
	expect(view.element("fm-sub").innerHTML).toContain("3 tasks in flight");
	expect(view.element("fm-sub").innerHTML).toContain("1 node down");
	expect(view.element("fm-banners").innerHTML).toBe("");
	expect(view.element("fm-metrics").innerHTML).not.toContain("Health data stale");
	expect(view.element("fm-banners").innerHTML).not.toContain("Hub lease");
	for (const part of [nodes, lines, view.element("fm-title").innerHTML, view.element("fm-sheet").innerHTML, view.element("fm-banners").innerHTML]) {
		expect(part).not.toContain("fixture-endpoint");
	}

	await view.open("oracle-arm");
	const downSheet = view.element("fm-sheet").innerHTML;
	expect(downSheet).toContain('data-ssh-out="not_checked"');
	expect(downSheet).toContain('data-ssh-in="not_checked"');
	expect(downSheet).not.toContain("Connected");
	expect(downSheet).not.toContain("fm-ssh-connected");
	expect(downSheet).toContain("cancel-flow stays held. Its outcome is unknown, so it stays held for you. Nothing is re-sent or re-placed.");
	expect(downSheet).toContain("Linux E2E cancel flow");
	expect(downSheet).toContain("Input names oracle-arm");
	expect(downSheet).toContain("The rest of the fleet keeps working and new tasks avoid this node.");
	expect(downSheet).toContain("Unreachable for");
	expect(downSheet).not.toContain(oracleId);
	expect(downSheet).not.toContain("fleet-0398");
	expect(downSheet).not.toContain("fixture-endpoint");
	expect(downSheet).not.toContain("maxConcurrency");
	expect(downSheet).toContain("<dt>Running</dt><dd>0</dd>");
	expect(downSheet).toContain("<dt>Held</dt><dd>1</dd>");
	expect(view.element("fm-nodes").innerHTML).toContain('data-node="mac-studio" data-down="0" data-inflight="2"');

	await view.open("home-pc");
	const staleSheet = view.element("fm-sheet").innerHTML;
	expect(staleSheet).toContain('data-ssh-out="stale"');
	expect(staleSheet).toContain("Not a live connection");
	expect(staleSheet).toContain('data-ssh-in="not_checked"');
	expect(staleSheet).not.toContain(">Connected<");
	expect(staleSheet).not.toContain("fixture-endpoint");

	await view.open("mac-studio");
	const liveSheet = view.element("fm-sheet").innerHTML;
	expect(liveSheet).toContain('data-ssh-out="observed"');
	expect(liveSheet).toContain(">Connected<");
	expect(liveSheet).toContain('data-ssh-in="not_checked"');
	expect(liveSheet).toContain("No reverse SSH is claimed");
	expect(liveSheet).toContain("<dt>Running</dt><dd>2</dd>");
	expect(liveSheet).toContain("<dt>Held</dt><dd>0</dd>");
	expect(liveSheet).not.toMatch(/<dt>Running<\/dt><dd>[^<]*\//);
	expect(liveSheet).not.toContain("fixture-endpoint");
	expect(view.element("fm-nodes").innerHTML).toContain('data-node="oracle-arm" data-down="1"');

	view.push({ ...state, hubLease: { remainingSeconds: 35, renewedSecondsAgo: 19 }, healthDataAgeSeconds: 74 });
	expect(view.element("fm-banners").innerHTML).toContain("Hub lease expiring");
	expect(view.element("fm-banners").innerHTML).toContain("0:35");
	expect(view.element("fm-banners").innerHTML).toContain("Renewed 19s ago");
	expect(view.element("fm-metrics").innerHTML).toContain("74s old");
	expect(view.element("fm-lines").innerHTML).not.toContain("fixture-endpoint");
});
