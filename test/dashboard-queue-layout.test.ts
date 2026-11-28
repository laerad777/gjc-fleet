import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "../src/contracts";
import { getDashboardState, type DashboardState } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { focusedElement, renderDashboardFixture } from "./dashboard-vm";

test("a live mobile queue transition relayouts the first row with unchanged header height", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-mobile-queue-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		const config: NodeConfig = {
			id: "mobile-0", os: "linux", arch: "x64", roots: {}, workspaceRoot: "/fixture",
			enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
			models: [], operations: [], maxConcurrency: 8,
			transport: { command: "ssh", args: ["fixture.invalid", "fixture"] },
		};
		for (let i = 0; i < 7; i++) store.putNode({ ...config, id: "mobile-" + i });
		const empty = getDashboardState(store);
		store.submit({
			schemaVersion: 1, key: "mobile-queue", caller: "fixture", repoId: "fixture",
			baseCommit: "a".repeat(40), prompt: "fixture", required: {},
		} as Parameters<FleetStore["submit"]>[0]);
		const queued = getDashboardState(store);
		expect(queued.tasks.filter(t => t.phase === "queued")).toHaveLength(1);
		let deliver: (state: DashboardState) => void = () => { throw new Error("socket not bound"); };
		const elements = await renderDashboardFixture(empty, {
			width: 390, height: 667, deliverState: callback => { deliver = callback; },
		});
		const world = elements.get("world")!;
		const first = (world.children as (typeof world)[]).find(el => el.getAttribute("data-id") === "mobile-0")!;
		const y = () => Number.parseFloat(first.style.top);
		const initial = y();
		expect(Number.isFinite(initial)).toBe(true);
		deliver(queued);
		expect(y()).toBeGreaterThan(initial);
		deliver(empty);
		expect(y()).toBe(initial);
		for (const key of ["Escape", "Enter", " "]) {
			const phone = await renderDashboardFixture(queued, { width: 390, height: 667 });
			const stage = phone.get("world")!;
			const pill = (stage.children as (typeof stage)[]).find(el => el.className === "ql pill")!;
			const sheet = phone.get("sheet")!;
			expect(pill.getAttribute("role")).toBe("button");
			expect(pill.getAttribute("tabindex")).toBe("0");
			pill.focus();
			let stopped = false;
			pill.onkeydown?.({ key, preventDefault: () => { stopped = true; } });
			expect(stopped).toBe(key !== "Escape");
			expect(sheet.getAttribute("data-mode")).toBe(key === "Escape" ? null : "hub");
			if (key !== "Escape") expect(focusedElement()).toBe(phone.get("cl"));
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
