import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "../src/contracts";
import { getDashboardState } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { renderDashboardFixture } from "./dashboard-vm";

function node(id: string): NodeConfig {
	return {
		id, os: "linux", arch: "x64", roots: {}, workspaceRoot: "/fixture-workspaces/" + id,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: [], operations: [], maxConcurrency: 99,
		transport: { command: "ssh", args: ["fixture-endpoint.invalid", "fixture-coordinator"] },
	};
}

type El = { getAttribute(key: string): string | null; style: { top: string; left: string }; children: El[] };

function linkPath(els: Map<string, El>, index: number): string {
	return els.get("lk" + index)?.getAttribute("d") ?? "";
}

test("phone grid links run on a trunk, bus and gutter and do not cross a node", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-links-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		for (let i = 0; i < 7; i++) store.putNode(node("n" + i));
		const els = await renderDashboardFixture(getDashboardState(store), { width: 390, height: 800 });
		const world = els.get("world") as El;
		const placed = [...Array(7)].map((_, i) => {
			const orb = world.children.find((el) => el.getAttribute("data-id") === "n" + i)!;
			return { i, x: parseFloat(orb.style.left), y: parseFloat(orb.style.top), d: linkPath(els as Map<string, El>, i) };
		});
		const firstRow = Math.min(...placed.map((item) => item.y));
		const lower = placed.filter((item) => item.y > firstRow);
		expect(lower.length).toBeGreaterThan(0);
		for (const item of placed) {
			expect(item.d.includes("Q")).toBe(false);
			expect(item.d).toMatch(/^M[\d.-]+ [\d.-]+ V[\d.-]+ H/);
		}
		for (const item of lower) {
			const lane = /H([\d.-]+) V[\d.-]+ H([\d.-]+)$/.exec(item.d);
			expect(lane).not.toBeNull();
			expect(Number(lane![1])).toBeLessThan(item.x);
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("desktop links stay on the hub curve", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-links-desk-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		store.putNode(node("solo"));
		const els = await renderDashboardFixture(getDashboardState(store), { width: 1280, height: 800 });
		expect(linkPath(els as Map<string, El>, 0)).toMatch(/ Q[\d.-]+ [\d.-]+ /);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
