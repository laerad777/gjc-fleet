import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "../src/contracts";
import { getDashboardState, renderDashboardHtml } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { focusedElement, renderDashboardFixture } from "./dashboard-vm";

type Chip = { disabled: boolean; hidden: boolean; getAttribute(key: string): string | null };

const node: NodeConfig = {
	id: "fixture-node", os: "linux", arch: "x64", roots: {}, workspaceRoot: "/fixture-workspaces",
	enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
	models: [], operations: [], maxConcurrency: 99,
	transport: { command: "ssh", args: ["fixture-endpoint.invalid", "fixture-coordinator"] },
};

test("Clear moves focus to an enabled filter when the Down filter has no nodes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-clear-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		store.putNode(node);
		const els = await renderDashboardFixture(getDashboardState(store));
		const bar = els.get("fbar")!;
		const chips = bar.children as Chip[];
		const click = (chip: unknown) => bar.listeners.get("click")!({ target: chip });
		const byTest = (id: string) => chips.find((c) => c.getAttribute("data-testid") === id)!;
		const down = byTest("filter-down");
		const linux = byTest("filter-linux");
		expect(down.disabled).toBe(true);
		expect(linux.disabled).toBe(false);
		click(linux);
		expect(byTest("filter-clear").hidden).toBe(false);
		click(byTest("filter-clear"));
		expect(byTest("filter-clear").hidden).toBe(true);
		expect(focusedElement()).toBe(linux);
		expect(focusedElement()).not.toBe(down);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("filter status keeps its own height on desktop so it cannot overlap the lease card", () => {
	const html = renderDashboardHtml();
	expect(html).not.toMatch(/#fstat\{[^}]*position:absolute/);
	expect(html).toMatch(/min-width:701px\)\{#fstat\{[^}]*min-height:var\(--fstat-h\)/);
});

test("Clear moves focus to the map when no filters match any nodes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-clear-empty-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		const els = await renderDashboardFixture(getDashboardState(store), { hash: "#flt=down" });
		const bar = els.get("fbar")!;
		const clear = (bar.children as Chip[]).find((c) => c.getAttribute("data-testid") === "filter-clear")!;
		expect(clear.hidden).toBe(false);
		bar.listeners.get("click")!({ target: clear });
		expect(clear.hidden).toBe(true);
		expect((bar.children as Chip[]).filter((chip) => !chip.hidden).every((chip) => chip.disabled)).toBe(true);
		expect(focusedElement()).toBe(els.get("stage"));
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("phone grid keeps the touch-target minimum on coarse pointers and pans instead of shrinking", () => {
	const html = renderDashboardHtml();
	const grid = html.slice(html.indexOf("function gridMobile"), html.indexOf("/* ---- zoom and pan"));
	expect(grid).toContain("if(COARSE&&NS0*kf<HIT_MIN)");
	expect(grid).toContain("kf=HIT_MIN/NS0");
});

test("phone drags stop with the ends of an oversized grid in the visible map band", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-pan-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		store.putNode(node);
		const windowListeners = new Map<string, (event: unknown) => void>();
		const els = await renderDashboardFixture(getDashboardState(store), { width: 390, height: 270, windowListeners });
		const viewport = els.get("stage")!;
		const world = els.get("world")!;
		const hub = els.get("hubnode")!;
		const orb = (world.children as (typeof world)[]).find((el) => el.getAttribute("data-id") === node.id)!;
		const screenY = (el: typeof world) => {
			const [, y, scale] = /^translate\([^,]+,([\d.-]+)px\) scale\(([\d.]+)\)$/.exec(world.style.transform)!;
			return Number(y) + parseFloat(el.style.top) * Number(scale);
		};
		const start = { pointerId: 1, pointerType: "touch", clientX: 190, clientY: 150, target: viewport };
		viewport.listeners.get("pointerdown")!(start);
		// The fixture reserves the top 114px and bottom 76px for chrome.
		windowListeners.get("pointermove")!({ ...start, clientY: 1150 });
		expect(screenY(hub)).toBeGreaterThan(114);
		expect(screenY(hub)).toBeLessThan(194);
		windowListeners.get("pointermove")!({ ...start, clientY: -850 });
		expect(screenY(orb)).toBeGreaterThan(114);
		expect(screenY(orb)).toBeLessThan(194);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const hasEnabledAlternative of [false, true]) {
	test("Live poll hands off focus when its filter loses its last node; alternative=" + hasEnabledAlternative, async () => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-poll-focus-"));
		const store = new FleetStore(join(dir, "fleet.db"));
		try {
			store.putNode(node);
			const initial = getDashboardState(store);
			let payload = initial;
			const timers: Array<() => void> = [];
			const els = await renderDashboardFixture(initial, { stateNow: () => payload, pollTimers: timers });
			const chips = els.get("fbar")!.children as Array<Chip & { focus(): void }>;
			const linux = chips.find(c => c.getAttribute("data-testid") === "filter-linux")!;
			const mac = chips.find(c => c.getAttribute("data-testid") === "filter-darwin")!;
			expect(linux.disabled).toBe(false);
			linux.focus();
			payload = { ...initial, nodes: hasEnabledAlternative ? initial.nodes.map(n => ({ ...n, os: "darwin" as const })) : [] };
			timers[0]!();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(linux.disabled).toBe(true);
			if (hasEnabledAlternative) expect(mac.disabled).toBe(false);
			expect(focusedElement() === (hasEnabledAlternative ? mac : els.get("stage"))).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}

for (const route of ["fallback", "alternative", "outside", "selected"]) {
	test("WebSocket focus: " + route, async () => {
		const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-ws-focus-"));
		const store = new FleetStore(join(dir, "fleet.db"));
		try {
			store.putNode(node);
			const initial = getDashboardState(store);
			let push: ((state: typeof initial) => void) | undefined;
			const els = await renderDashboardFixture(initial, { deliverState: cb => { push = cb; } });
			expect(push).toBeDefined();
			const bar = els.get("fbar")!;
			const stage = els.get("stage")!;
			const chips = bar.children as Array<Chip & { focus(): void }>;
			const byTest = (id: string) => chips.find(c => c.getAttribute("data-testid") === id)!;
			const linux = byTest("filter-linux");
			const next = byTest("filter-darwin");
			if (route === "selected") bar.listeners.get("click")!({ target: linux });
			(route === "outside" ? stage : linux).focus();
			push!({ ...initial, nodes: route === "fallback" ? [] : initial.nodes.map(n => ({ ...n, os: "darwin" as const })) });
			expect(linux.disabled).toBe(route !== "selected");
			const expected = route === "alternative" ? next : route === "selected" ? linux : stage;
			expect(focusedElement() === expected).toBe(true);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
