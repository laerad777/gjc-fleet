import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { getDashboardState, renderDashboardHtml, type DashboardState, type DashboardTask } from "../src/dashboard";
import { observationDigest } from "../src/core";
import { FleetStore } from "../src/store";
import { activeOn, node } from "./fixtures/daemon";

const awaiting = "Execution ended · awaiting supervisor verification";
const resultMissing = "Execution ended · result not collected";
const verified = "Verified · deployment separate";
const unknown = "State unknown · not a failure";

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
	style: any = { setProperty() {} };
	attrs = new Map<string, string>();
	setAttribute(name: string, value: string) { this.attrs.set(name, value); }
	getAttribute(name: string) { return this.attrs.get(name) ?? null; }
	removeAttribute(name: string) { this.attrs.delete(name); }
	querySelector() { return null; }
	querySelectorAll() { return []; }
	appendChild(child: unknown) { return child; }
	remove() {}
	closest() { return null; }
	getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
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
				// Map nodes and spokes are created by the script itself, so unknown ids are tolerated.
				let element = elements.get(id);
				if (!element) { element = new Element(); elements.set(id, element); }
				return element;
			},
			body: new Element(),
			documentElement: new Element(),
			addEventListener: () => {},
			createElement: () => new Element(),
			querySelector: (selector: string) => {
				if (selector === "main") return main;
				return new Element();
			},
			// Resource meter patching is outside these label tests; initial node HTML is captured.
			querySelectorAll: () => [],
		},
		fetch: async (url: string) => {
			requests.push(url);
			return { ok: true, json: async () => initial };
		},
		WebSocket: LocalSocket,
		location: { protocol: "http:", host: "dashboard.invalid" },
		setTimeout: () => 0,
		setInterval: () => 0,
		clearTimeout: () => {},
		innerWidth: 1280,
		innerHeight: 800,
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		requestAnimationFrame: () => 0,
		addEventListener: () => {},
		Date,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(requests).toEqual(["/api/state"]);
	expect(elements.get("p-count")!.textContent).toBe(`Tasks ${initial.summary.totalTasks}`);
	return {
		html,
		element: (id: string) => elements.get(id)!,
		update: (state: DashboardState) => socket!.onmessage!({ data: JSON.stringify({ type: "state", state }) }),
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
	const running = holding.filter((t) => ["preparing", "dispatching", "active"].includes(t.phase)).length;
	const exportIncomplete = tasks.filter((t) => t.phase === "completed_unverified" && t.exportReview === "required").length;
	return {
		generatedAt: "2026-01-01T00:00:00Z", live: false,
		summary: {
			totalNodes: 1, healthyNodes: 1, activeTasks: count("active", "preparing", "dispatching"), unsettledTasks: 0, provisionalTasks: 0, failureReportedTasks: 0,
			queuedTasks: count("queued"), succeededTasks: succeeded, exportIncompleteTasks: exportIncomplete, failedTasks: troubled,
			unplaceableTasks: 0,
			heldTasks: holding.length, openNodes: null, totalTasks: tasks.length,
			listedTasks: tasks.length, omittedTasks: 0, listedArchived: 0, omittedArchived: 0,
		},
		pipeline: { stages: [], outcome: { succeeded, unverified: count("completed_unverified") - exportIncomplete, resultMissing: 0, unsettled: 0, exportIncomplete, troubled, cancelled: count("cancelled"), approval: count("approval_required") } },
		gjcRuntime: { installed: false, lastCheckedAt: "2026-01-01T00:00:00Z" },
		nodes: [{
			id: "local", os: "linux", arch: "x64", enabled: true, draining: false, reachable: true,
			sdkReady: true, modelReady: true, currentLoad: running, heldNotRunning: holding.length - running, admission: null,
			modelProfiles: [], operations: [], possiblyRunning: [], holding, assignedTotal: tasks.length, succeeded, troubled,
			exclusions: {}, probe: null, resources: null,
		}],
		tasks,
		archivedTasks: [],
	};
}

test("execution-ended tasks await supervisor verification in cards, details, holds and totals", async () => {
	const view = await page(state([task("completed_unverified", { resultStatus: "completed", verified: false })]));
	const tasks = view.element("tasks").innerHTML;
	expect(await select(tasks, ".tk-head .chip")).toEqual([{ text: awaiting, className: "chip warn" }]);
	expect((await select(tasks, ".steps i")).map((item) => item.className)).toEqual([...Array(6).fill("done"), "wait"]);
	expect((await select(tasks, ".tk-sub"))[0].text).toContain("slot held");
	expect((await select(tasks, ".tk-sub"))[0].text).not.toContain("Running");
	expect((await select(view.element("nodes").innerHTML, ".hold .chip"))[0].text).toBe(`completion · ${awaiting}`);
	expect((await select(view.element("outcome").innerHTML, ".chip")).map((item) => item.text)).toContain(`${awaiting} 1`);
	expect(view.element("rt-cap").lastElementChild.textContent).toBe("Slots held 1");
});

test("execution-ended without result_saved is result-collection stuck, not supervisor verify-wait", async () => {
	const stuck = task("completed_unverified", {
		resultStatus: undefined,
		verified: false,
		stageIndex: 4,
		stages: Array.from({ length: 7 }, (_, i) => (i <= 4 ? "2026-01-01T00:00:00Z" : null)),
	});
	const snapshot = state([stuck]);
	snapshot.pipeline.outcome.unverified = 0;
	snapshot.pipeline.outcome.resultMissing = 1;
	const view = await page(snapshot);
	const tasks = view.element("tasks").innerHTML;
	expect(await select(tasks, ".tk-head .chip")).toEqual([{ text: resultMissing, className: "chip warn" }]);
	expect(tasks).not.toContain(awaiting);
	expect((await select(view.element("nodes").innerHTML, ".hold .chip"))[0].text).toBe(`completion · ${resultMissing}`);
	expect((await select(view.element("outcome").innerHTML, ".chip")).map((item) => item.text)).toContain(`${resultMissing} 1`);
	expect((await select(view.element("outcome").innerHTML, ".chip")).map((item) => item.text)).toContain(`${awaiting} 0`);
});

test("live snapshots replace pending execution with verified, never deployed, completion", async () => {
	const view = await page(state([task("active")]));
	expect((await select(view.element("tasks").innerHTML, ".tk-head .chip"))[0].text).toBe("Running");
	view.update(state([task("completed_unverified")]));
	expect((await select(view.element("tasks").innerHTML, ".tk-head .chip"))[0].text).toBe(awaiting);
	const completed = state([task("succeeded", { resultStatus: "completed", verified: true })]);
	view.update(completed);
	const rendered = view.element("tasks").innerHTML;
	// Verified success is settled: lazy fold keeps the count without mounting the card.
	expect((await select(rendered, ".fold"))[0].text).toBe("Result / state check tasks 1");
	expect(await select(rendered, ".tk-head .chip")).toEqual([]);
	expect((await select(view.element("nodes").innerHTML, ".stats div"))[1].text).toBe(`1${verified}`);
	expect(rendered).not.toContain(awaiting);
	expect((await select(view.html, ".note"))[0].text).toContain("Verified does not mean deployed");
	view.update(completed);
	expect(view.element("tasks").innerHTML).toBe(rendered);
});

test("false or missing settlement proof keeps completion metadata visible and never claims execution ended", async () => {
	for (const proof of [false, undefined]) {
		const provisional = task("completed_unverified", { executionTerminal: proof, resultStatus: "completed_unverified" });
		if (proof === undefined) delete (provisional as Partial<DashboardTask>).executionTerminal;
		const snapshot = state([provisional]);
		// Use the server's authoritative aggregate contract, not a page-side recount.
		snapshot.summary.unsettledTasks = 1;
		snapshot.pipeline.outcome.unverified = 0;
		snapshot.pipeline.outcome.unsettled = 1;
		const view = await page(snapshot);
		const rendered = view.element("tasks").innerHTML;
		const pending = "End not confirmed · execution slot kept";
		expect(await select(rendered, ".tk-head .chip")).toEqual([{ text: pending, className: "chip warn" }]);
		expect(await select(rendered, ".fold")).toEqual([]);
		expect(rendered).not.toContain("No tasks in progress");
		expect(rendered).not.toContain(awaiting);
		expect((await select(view.element("nodes").innerHTML, ".hold .chip"))[0].text).toBe(`completion · ${pending}`);
		expect((await select(view.element("outcome").innerHTML, ".chip")).map((item) => item.text)).toContain("Awaiting settlement 1");
		expect((await select(view.element("nodes").innerHTML, ".adm span"))[0].text).toBe("Resource sampling off · held 0 · unreturned 1");
	}
});

test("running work shows no unsettled or unreturned counts", async () => {
	const view = await page(state([task("active")]));
	expect((await select(view.element("outcome").innerHTML, ".chip")).map((item) => item.text).join(" ")).not.toContain("Awaiting settlement");
	expect((await select(view.element("nodes").innerHTML, ".adm span"))[0].text).toBe("Resource sampling off · held 1");
});

test("unknown states use warning and waiting markers, while confirmed failure stays failed", async () => {
	const view = await page(state([task("blocked_unknown", {
		timeline: [{ at: "2026-01-01T00:00:00Z", kind: "unknown" }],
	})]));
	const tasks = view.element("tasks").innerHTML;
	expect(await select(tasks, ".tk-head .chip")).toEqual([{ text: unknown, className: "chip warn" }]);
	expect((await select(tasks, ".steps i")).map((item) => item.className)).toEqual([...Array(5).fill("done"), "wait", ""]);
	expect((await select(tasks, ".tl li"))[0].className).not.toBe("bad");
	// Unknown / attention stays in the immediate list; plain settled failures use the lazy fold.
	expect(await select(tasks, ".fold")).toEqual([]);
	expect((await select(view.element("nodes").innerHTML, ".hold .chip"))[0].text).toBe(`completion · ${unknown}`);
	view.update(state([task("failed")]));
	// Default fixture keeps held=true for failed, so the card stays immediate.
	expect(await select(view.element("tasks").innerHTML, ".tk-head .chip")).toEqual([{ text: "Failed", className: "chip bad" }]);
	expect((await select(view.element("tasks").innerHTML, ".steps i"))[5].className).toBe("fail");
	view.update(state([task("cancel_unknown")]));
	expect((await select(view.element("tasks").innerHTML, ".tk-head .chip"))[0]).toEqual({ text: "Cancel state unknown", className: "chip warn" });
	expect((await select(view.element("tasks").innerHTML, ".steps i"))[5].className).toBe("wait");
});

test("receipt-less settlements render as failure with their cause, never as unconfirmed or verified", async () => {
	for (const [kind, label] of [
		["failed_without_receipt", "Failed · no execution receipt"],
		["ended_without_receipt", "Ended · no execution receipt · not a success"],
	] as const) {
		const cause = "model stream stalled <b>x</b>; prompt_failed/agent_failed; turn: unavailable";
		const settled = task("failed", {
			executionTerminal: true, held: false, verified: false, resultStatus: "failed",
			settlement: { kind, receiptState: "missing", cause, settledAt: "2026-11-12T10:01:00.000Z", lateObservationUntil: "2026-11-13T10:01:00.000Z" },
		});
		const view = await page(state([settled]));
		const rendered = view.element("tasks").innerHTML;
		expect(await select(rendered, ".tk-head .chip")).toEqual([{ text: label, className: "chip bad" }]);
		// Collapsed cards keep the failure chip only; kv cause rows mount after expand + detail fetch.
		expect(rendered).not.toContain("not confirmed");
		expect(rendered).not.toContain(verified);
		expect(rendered).not.toContain(awaiting);
		// Settlement attention stays immediate (not in the lazy settled fold).
		expect(await select(rendered, ".fold")).toEqual([]);
		const outcomes = await select(view.element("outcome").innerHTML, ".chip");
		expect(outcomes).toContainEqual({ text: `${verified} 0`, className: "chip mute" });
	}
});

const settlement = {
	kind: "ended_without_receipt" as const, receiptState: "absent", cause: "turn reported completed but runtime no runtime receipt",
	settledAt: "2026-11-12T10:01:00.000Z", lateObservationUntil: "2026-11-13T10:01:00.000Z",
};
const lateReceipt = {
	status: "terminal_ok", digest: "ab".repeat(32), terminalAt: 1, outcome: { kind: "stopped" },
	sessionId: "s", turnId: "t", runtimeCommandId: "c", runtimeTurnId: "r",
	observedAt: "2026-11-12T10:05:00.000Z", settlementKind: "ended_without_receipt" as const,
};

test("a late receipt after a receipt-less settlement is a visible contradiction; finality label stays failed", async () => {
	const open = task("failed", { executionTerminal: true, held: false, verified: false, resultStatus: "failed", settlement });
	let view = await page(state([open]));
	expect(await select(view.element("tasks").innerHTML, ".tk-head .chip")).toEqual([{
		text: "Ended · no execution receipt · not a success", className: "chip bad",
	}]);
	const late = task("failed", { executionTerminal: true, held: false, verified: false, resultStatus: "failed", settlement, lateReceipt,
		timeline: [{ at: "2026-11-12T10:05:00.000Z", kind: "late_receipt_contradiction", detail: "terminal_ok" }] });
	view = await page(state([late]));
	const rendered = view.element("tasks").innerHTML;
	const label = "Ended · no execution receipt · not a success · late receipt terminal_ok";
	expect(await select(rendered, ".tk-head .chip")).toEqual([{ text: label, className: "chip bad" }]);
	// Contradiction attention stays on the collapsed card before expand.
	expect(rendered).toContain("Late execution receipt · contradicts final result");
	expect(rendered).not.toContain(verified);
	expect(rendered).not.toContain(awaiting);
});

test("archived wins over the settlement label; an accepted late receipt awaits the normal verifier", async () => {
	const archived = task("archived", { executionTerminal: true, held: false, verified: false, resultStatus: "failed", settlement, lateReceipt,
		archivedFrom: { phase: "failed" } as any });
	const snapshot = state([]);
	snapshot.archivedTasks = [archived];
	const view = await page(snapshot);
	const rendered = view.element("tasks").innerHTML;
	// Archived cards mount only after the fold opens; closed section keeps the label only.
	expect((await select(rendered, ".fold"))[0].text).toBe("Archived tasks 1");
	expect(await select(rendered, ".tk-head .chip")).toEqual([]);
	expect(rendered).not.toContain("2026-11-13T10:01:00.000Z (deadline)");
	const accepted = task("completed_unverified", { executionTerminal: true, held: false, verified: false, resultStatus: "completed_unverified", settlement,
		lateReceipt: { ...lateReceipt, acceptance: { at: "2026-11-12T11:00:00.000Z", actor: "operator", reason: "late receipt checked", evidenceDigest: "cd".repeat(32) } } });
	const next = await page(state([accepted]));
	const html = next.element("tasks").innerHTML;
	expect(await select(html, ".tk-head .chip")).toEqual([{ text: awaiting, className: "chip warn" }]);
	expect(html).not.toContain(verified);
});

test("aggregate labels preserve server totals even when task history is truncated", async () => {
	const snapshot = state([]);
	snapshot.pipeline.outcome = { succeeded: 18, unverified: 4, resultMissing: 2, unsettled: 0, exportIncomplete: 5, troubled: 7, cancelled: 2, approval: 3 };
	snapshot.nodes[0].succeeded = 12;
	snapshot.nodes[0].troubled = 6;
	const view = await page(snapshot);
	const outcomes = await select(view.element("outcome").innerHTML, ".chip");
	expect(outcomes).toContainEqual({ text: `${verified} 18`, className: "chip ok" });
	expect(outcomes).toContainEqual({ text: `${awaiting} 4`, className: "chip warn" });
	expect(outcomes).toContainEqual({ text: `${resultMissing} 2`, className: "chip warn" });
	expect(outcomes).toContainEqual({ text: "Failed / state unknown 7", className: "chip warn" });
	// Review 5cf4c1e0 LOW-5: tasks waiting for export acceptance stay visible in the totals.
	expect(outcomes).toContainEqual({ text: "Export incomplete · operator acceptance needed 5", className: "chip warn" });
	expect((await select(view.element("nodes").innerHTML, ".stats div")).map((item) => item.text)).toEqual([
		"0Total assigned", `12${verified}`, "6Failed / state unknown",
	]);
	view.update(state([]));
	const empty = await select(view.element("outcome").innerHTML, ".chip");
	expect(empty.every((item) => item.className === "chip mute")).toBe(true);
	expect(empty.map((item) => item.text)).toContain(`${verified} 0`);
	expect(empty.map((item) => item.text)).toContain(`${awaiting} 0`);
});

test("review fx-093cc54b F6: the server counts unsettled, export-review and plain unverified completions apart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-dash-f6-"));
	const db = join(dir, "fleet.sqlite");
	const store = new FleetStore(db);
	try {
		store.putNode(node("n", dir));
		const settle = (id: string, terminal: boolean) => {
			const evidence: { [key: string]: string } = terminal ? { native: "settled" } : {};
			const body = { sessionId: `session-${id}`, turnId: `turn-${id}`, status: "completed_unverified" as const, terminal, evidence };
			store.observe(id, { eventId: `settle-${id}`, digest: observationDigest(body), ...body });
		};
		const provisional = activeOn(store, "n", "provisional");
		settle(provisional, false);
		const review = activeOn(store, "n", "review");
		settle(review, true);
		const plain = activeOn(store, "n", "plain");
		settle(plain, true);
		// Verify-wait (unverified) since the split requires result_saved; without it plain is result-missing.
		store.saveResult(plain, { status: "ok", taskId: plain, attemptId: store.task(plain)!.attemptId!, files: [] });
		// A pending export review as Fleet records it on a settled completion (`result.exportIncomplete`).
		const raw = new Database(db);
		raw.query("UPDATE tasks SET data=json_set(data,'$.result.exportIncomplete',json(?)) WHERE id=?").run(JSON.stringify({ subject: {}, reviewDigest: "0".repeat(64), requiredAt: "2026-01-01T00:00:00Z" }), review);
		raw.close();
		const state = getDashboardState(store);
		expect({ unsettled: state.summary.unsettledTasks, exportIncomplete: state.summary.exportIncompleteTasks }).toEqual({ unsettled: 1, exportIncomplete: 1 });
		expect(state.pipeline.outcome).toMatchObject({ succeeded: 0, unverified: 1, unsettled: 1, exportIncomplete: 1 });
		expect(state.tasks.find((t) => t.id === review)).toMatchObject({ exportReview: "required" });
		// Every task is in exactly one outcome bucket.
		const { succeeded, unverified, unsettled, exportIncomplete, troubled, cancelled, approval } = state.pipeline.outcome;
		expect(succeeded + unverified + unsettled + (exportIncomplete ?? 0) + troubled + cancelled + approval).toBe(state.summary.totalTasks);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("review fx-093cc54b F6: the page shows the unsettled and the export-review chips together, beside plain unverified", async () => {
	const snapshot = state([
		task("completed_unverified", { executionTerminal: false, resultStatus: "completed_unverified" }),
		task("completed_unverified", { exportReview: "required" }),
		task("completed_unverified"),
	]);
	snapshot.summary.unsettledTasks = 1;
	snapshot.pipeline.outcome.unsettled = 1;
	snapshot.pipeline.outcome.unverified = 1;
	const view = await page(snapshot);
	const outcomes = await select(view.element("outcome").innerHTML, ".chip");
	expect(outcomes).toContainEqual({ text: `${awaiting} 1`, className: "chip warn" });
	expect(outcomes).toContainEqual({ text: "Awaiting settlement 1", className: "chip warn" });
	expect(outcomes).toContainEqual({ text: "Export incomplete · operator acceptance needed 1", className: "chip warn" });
});

test("unknown future phases remain escaped rather than acquiring completion semantics", async () => {
	const view = await page(state([task("<new-state>" as DashboardTask["phase"], { title: "<script>unsafe</script>" })]));
	const tasks = view.element("tasks").innerHTML;
	expect(tasks).toContain("&lt;new-state&gt;");
	expect(tasks).toContain("&lt;script&gt;unsafe&lt;/script&gt;");
	expect(await select(tasks, "script")).toEqual([]);
	expect((await select(tasks, ".tk-head .chip"))[0].className).toBe("chip info");
});

test("completed_unverified result detail escapes deliverable labels from phaseLabel", async () => {
	const { readFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	const source = await readFile(join(import.meta.dir, "../src/dashboard-page.ts"), "utf8");
	// Review finding: deliverable.label (and other phaseLabel text) used to land in the Result <dd> unescaped.
	expect(source).toContain("completed_unverified'?esc(p[1])");
	expect(source).not.toContain("completed_unverified'?p[1]:");

	const evil = '<img src=x onerror=alert(1)>';
	const view = await page(state([task("completed_unverified", {
		resultStatus: "completed",
		verified: false,
		deliverable: { label: evil } as NonNullable<DashboardTask["deliverable"]>,
	})]));
	const chip = view.element("tasks").innerHTML;
	expect(chip).toContain("&lt;img src=x onerror=alert(1)&gt;");
	expect(chip).not.toContain(evil);
	expect(await select(chip, "img")).toEqual([]);
	// Review finding: assert the expanded Result <dd>, not only the chip path.
	await view.expand("task-1");
	const expanded = view.element("tasks").innerHTML;
	expect(expanded).toContain("<dt>Result</dt>");
	expect(expanded).toContain("<dd>&lt;img src=x onerror=alert(1)&gt;</dd>");
	expect(expanded).not.toContain(`<dd>${evil}</dd>`);
	expect(await select(expanded, "img")).toEqual([]);
});
