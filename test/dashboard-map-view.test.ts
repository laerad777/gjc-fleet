import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "../src/contracts";
import { dashboardSshEvidence, dashboardSshLinks, dashboardSshRoute, dashboardTaskAttention } from "../src/dashboard-map-view";
import { getDashboardState, startDashboardServer, type DashboardState } from "../src/dashboard";
import { FleetStore } from "../src/store";
import { renderDashboardFixture } from "./dashboard-vm";

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

test("link tip opens for a node without SSH evidence instead of throwing", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-dashboard-link-"));
	const store = new FleetStore(join(dir, "fleet.db"));
	try {
		store.putNode(node);
		store.putNode({ ...node, id: "local", sdkTransport: { command: "gjc", args: [] }, transport: { command: "gjc", args: [] } });
		const state = getDashboardState(store);
		expect(state.sshLinks?.map((l) => l.nodeId)).toEqual([node.id]);
		const els = await renderDashboardFixture(state);
		const tip = els.get("tip")!;
		for (const id of ["lkh0", "lkh1"]) {
			tip.innerHTML = "";
			expect(() => (els.get(id) as any).onmouseenter({ clientX: 1, clientY: 1 })).not.toThrow();
			expect(tip.innerHTML).toContain("never checked from this side");
		}
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
