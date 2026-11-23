// Node-health dashboard labels (review 36ebedc2 L2, port 34d0622, review caba7bbd M1). Kept apart
// from dashboard-completion-labels.test.ts, which runs unmodified; the page harness below is the
// same local DOM/network adapter, copied so the existing file stays untouched.
import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { renderDashboardHtml, type DashboardState, type DashboardTask } from "../src/dashboard";

// Execute the public page's unmodified script with local DOM/network adapters.
// This exercises rendering and snapshot updates, not browser layout or real transport.
class Element {
	innerHTML = "";
	textContent = "";
	className = "";
	lastElementChild = { textContent: "" };
	listeners = new Map<string, (event: any) => void>();
	classList = {
		add: (name: string) => this.classList.toggle(name, true),
		remove: (name: string) => this.classList.toggle(name, false),
		toggle: (name: string, enabled: boolean) => {
			const classes = new Set(this.className.split(" ").filter(Boolean));
			if (enabled) classes.add(name);
			else classes.delete(name);
			this.className = [...classes].join(" ");
		},
	};
	addEventListener(name: string, handler: (event: any) => void) {
		this.listeners.set(name, handler);
	}
}

async function select(html: string, selector: string) {
	const matches: Array<{ text: string; className: string }> = [];
	await new HTMLRewriter().on(selector, {
		element(element) {
			matches.push({ text: "", className: element.getAttribute("class") ?? "" });
		},
		text(chunk) {
			matches[matches.length - 1].text += chunk.text;
		},
	}).transform(new Response(html)).text();
	return matches;
}

async function page(initial: DashboardState) {
	const elements = new Map<string, Element>();
	let script = "";
	const html = renderDashboardHtml();
	await new HTMLRewriter()
		.on("[id]", { element(element) { elements.set(element.getAttribute("id")!, new Element()); } })
		.on("script", { text(chunk) { script += chunk.text; } })
		.transform(new Response(html)).text();
	const main = new Element();
	let socket: LocalSocket;
	class LocalSocket {
		onmessage?: (event: { data: string }) => void;
		constructor() { socket = this; }
	}
	const requests: string[] = [];
	runInNewContext(script, {
		document: {
			getElementById: (id: string) => {
				const element = elements.get(id);
				if (!element) throw new Error(`Missing page element ${id}`);
				return element;
			},
			body: new Element(),
			querySelector: (selector: string) => {
				if (selector !== "main") throw new Error(`Unexpected selector ${selector}`);
				return main;
			},
			// Resource meter patching is outside these label tests; initial node HTML is captured.
			querySelectorAll: () => [],
		},
		fetch: async (url: string) => {
			requests.push(url);
			const path = String(url);
			if (path.startsWith("/api/task/")) {
				const id = decodeURIComponent(path.slice("/api/task/".length));
				const task = [...initial.tasks, ...initial.archivedTasks].find((row) => row.id === id);
				if (!task) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
				return { ok: true, status: 200, json: async () => task };
			}
			return { ok: true, status: 200, json: async () => initial };
		},
		WebSocket: LocalSocket,
		location: { protocol: "http:", host: "dashboard.invalid" },
		setTimeout: () => 0,
		setInterval: () => 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(requests).toEqual(["/api/state"]);
	expect(elements.get("p-count")!.textContent).toBe(`Tasks ${initial.summary.totalTasks}`);
	return {
		html,
		element: (id: string) => elements.get(id)!,
		update: (state: DashboardState) => socket!.onmessage!({ data: JSON.stringify({ type: "state", state }) }),
		/** Expand a live card so `.kv` / full selection labels mount (detail fetch included). */
		expand: async (taskId: string) => {
			const tasks = elements.get("tasks")!;
			const click = tasks.listeners.get("click");
			if (!click) throw new Error("tasks click listener missing");
			click({
				target: {
					closest: (selector: string) => {
						if (selector !== ".tk") return null;
						return { getAttribute: (name: string) => (name === "data-id" ? taskId : null) };
					},
				},
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
		},
		requests,
	};
}

function task(phase: DashboardTask["phase"], overrides: Partial<DashboardTask> = {}): DashboardTask {
	const stageIndex = phase === "succeeded" ? 6 : phase === "completed_unverified" ? 5 : 4;
	return {
		id: "task-1", key: "completion", title: "Completion labels", caller: "test", phase,
		nodeId: "local", held: phase !== "succeeded", required: {}, preferences: [],
		executionTerminal: phase === "completed_unverified" || phase === "succeeded",
		stageIndex, stages: Array.from({ length: 7 }, (_, i) => i <= stageIndex ? "2026-01-01T00:00:00Z" : null),
		timeline: [], outcome: null, ...overrides,
	};
}

function state(tasks: DashboardTask[]): DashboardState {
	const count = (...phases: DashboardTask["phase"][]) => tasks.filter((t) => phases.includes(t.phase)).length;
	const succeeded = count("succeeded");
	const troubled = count("failed", "blocked_unknown", "cancel_unknown");
	const holding = tasks.filter((t) => t.held);
	return {
		generatedAt: "2026-01-01T00:00:00Z", live: false,
		summary: {
			totalNodes: 1, healthyNodes: 1, activeTasks: count("active", "preparing", "dispatching"),
			unsettledTasks: 0, provisionalTasks: 0, failureReportedTasks: 0, unplaceableTasks: 0,
			queuedTasks: count("queued"), succeededTasks: succeeded, exportIncompleteTasks: 0, failedTasks: troubled,
			heldTasks: holding.length, openNodes: null, totalTasks: tasks.length,
			listedTasks: tasks.length, omittedTasks: 0, listedArchived: 0, omittedArchived: 0,
		},
		pipeline: { stages: [], outcome: { succeeded, unverified: count("completed_unverified"), resultMissing: 0, unsettled: 0, troubled, cancelled: count("cancelled"), approval: count("approval_required") } },
		gjcRuntime: { installed: false, lastCheckedAt: "2026-01-01T00:00:00Z" },
		nodes: [{
			id: "local", os: "linux", arch: "x64", enabled: true, draining: false, reachable: true,
			sdkReady: true, modelReady: true, currentLoad: holding.length, heldNotRunning: 0, admission: null,
			modelProfiles: [], operations: [], possiblyRunning: [], holding, assignedTotal: tasks.length, succeeded, troubled,
			exclusions: {}, probe: null, resources: null,
		}],
		tasks,
		archivedTasks: [],
	};
}
test("node-health exclusion codes and the pinned warning event are labelled, never shown raw (review 36ebedc2 L2)", async () => {
	const reasons = ["node_unstable", "reachable", "consecutive_observations", "unobserved:resourceSampleOk", "decision_probe_required", "no_history"];
	const snapshot = state([task("queued", {
		nodeId: undefined, held: false,
		selection: { outcome: "rejected", exclusions: [{ nodeId: "local", reasons }] },
		timeline: [{ at: "2026-01-01T00:00:00Z", kind: "node_health_warning" }],
	})]);
	snapshot.nodes[0].exclusions = { node_unstable: 2, "unobserved:brokerSessionListOk": 1, brokerSessionListOk: 1 };
	const view = await page(snapshot);
	// Collapsed live cards keep the attention timeline only; exclusion labels mount after expand + detail.
	expect((await select(view.element("tasks").innerHTML, ".tl li span")).map(item => item.text)).toContain("Warning: pinned assignment to unstable node");
	await view.expand("task-1");
	expect(view.requests.some((url) => String(url).includes("/api/task/task-1"))).toBe(true);
	const tasks = view.element("tasks").innerHTML;
	const excluded = (await select(tasks, ".kv dd")).map(item => item.text).find(text => text.startsWith("local ("));
	expect(excluded).toBe("local (Node unstable, Coordinator reachability failed, recovering, Too few stable observations, Resource sampling unobserved, No measurement for this decision, No node health record)");
	const nodes = view.element("nodes").innerHTML;
	expect(nodes).toContain("Node unstable ×2");
	expect(nodes).toContain("Broker session list unobserved ×1");
	expect(nodes).toContain("Broker session list failed, recovering ×1");
	for (const code of [...reasons, "node_health_warning", "brokerSessionListOk"]) {
		expect(tasks).not.toContain(code);
		expect(nodes).not.toContain(code);
	}
});

test("node stability is displayed per node with the gating mode, labelled, never raw (port 34d0622)", async () => {
	const snapshot = state([]);
	snapshot.nodes[0].health = { gating: "observe", stable: false, failingDimensions: ["reachable", "consecutive_observations"], consecutiveGood: 1, required: 5, neverObservable: [], lastFailure: { at: Date.now() - 120_000, dimensions: ["reachable"] } };
	snapshot.nodeHealth = { gating: "observe" };
	let nodes = (await page(snapshot)).element("nodes").innerHTML;
	expect(nodes).toContain("<b>Node unstable</b> · Coordinator reachability failed, recovering, Too few stable observations · stable observations <b>1/5</b> · last failure 2m ago · observe only · not applied to auto-assignment");
	for (const code of ["reachable", "consecutive_observations", "observe"]) expect(nodes).not.toContain(code);
	snapshot.nodes[0].health = { gating: "enforce", stable: true, failingDimensions: [], consecutiveGood: 3, required: 3, neverObservable: [] };
	snapshot.nodeHealth = { gating: "enforce", operator: "ops", reason: "rollout", at: Date.now() };
	nodes = (await page(snapshot)).element("nodes").innerHTML;
	expect(nodes).toContain("<b>Node stable</b> · stable observations <b>3/3</b> · applied to auto-assignment");
	// Without a health history the node card has no stability row at all.
	delete snapshot.nodes[0].health;
	nodes = (await page(snapshot)).element("nodes").innerHTML;
	expect(nodes).not.toContain("stable observations");
});

test("a node that can never observe a dimension says so, and that gating would exclude it permanently (review caba7bbd M1)", async () => {
	const snapshot = state([]);
	snapshot.nodes[0].health = { gating: "observe", stable: false, failingDimensions: ["unobserved:brokerSessionListOk"], consecutiveGood: 6, required: 3, neverObservable: ["brokerSessionListOk"] };
	snapshot.nodeHealth = { gating: "observe" };
	const nodes = (await page(snapshot)).element("nodes").innerHTML;
	expect(nodes).toContain("<b>Node unstable</b> · Broker session list unobserved · stable observations <b>6/3</b> · observe only · not applied to auto-assignment · <b>Broker session list unobservable</b> · permanently excluded from auto-assignment once applied");
	expect(nodes).not.toContain("brokerSessionListOk");
	snapshot.nodes[0].health.neverObservable = [];
	expect((await page(snapshot)).element("nodes").innerHTML).not.toContain("unobservable");
});
