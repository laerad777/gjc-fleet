import { expect, test } from "bun:test";
import { dashboardPushKey, renderDashboardHtml, type DashboardState } from "../src/dashboard";

test("the page keys node cards without probe latency so jitter never rebuilds them", () => {
	const html = renderDashboardHtml();
	expect(html).toContain('data-testid="node-badge"');
	expect(html).toContain("data-ms");
	// The put('nodes') cache key must not carry elapsedMs.
	const m = /put\('nodes'[\s\S]{0,600}/.exec(html);
	if (m) expect(m[0]).not.toContain("elapsedMs");
});

test("the live push key publishes silence aging out once while another node still streams", () => {
	const first = {
		generatedAt: "2026-01-01T00:00:00Z",
		nodes: [
			{ id: "silent-local", resources: { ok: true, cpuPct: 9, sampledAt: 1000 } },
			{ id: "other", resources: { ok: true, cpuPct: 7, sampledAt: 1000 } },
		],
	} as DashboardState;
	const baseline = dashboardPushKey(first);
	first.generatedAt = "2026-01-01T00:00:12Z";
	first.nodes[1]!.resources = { ok: true, cpuPct: 42, sampledAt: 12000 };
	expect(dashboardPushKey(first)).toBe(baseline);
	first.nodes[0]!.resources = { ok: false, error: "Stream delayed · last value 13s ago" };
	const delayed = dashboardPushKey(first);
	expect(delayed).not.toBe(baseline);
	first.nodes[0]!.resources = { ok: false, error: "Stream delayed · last value 15s ago" };
	expect(dashboardPushKey(first)).toBe(delayed);
	first.nodes[0]!.resources = { ok: true, cpuPct: 8, sampledAt: 16000 };
	expect(dashboardPushKey(first)).toBe(baseline);
});
