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

test("phone grid keeps the touch-target minimum on coarse pointers and pans instead of shrinking", () => {
	const html = renderDashboardHtml();
	const grid = html.slice(html.indexOf("function gridMobile"), html.indexOf("/* ---- zoom and pan"));
	expect(grid).toContain("if(COARSE&&NS0*kf<HIT_MIN)");
	expect(grid).toContain("kf=HIT_MIN/NS0");
});
