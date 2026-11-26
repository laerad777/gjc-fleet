import { expect, test } from "bun:test";
import { renderDashboardHtml } from "../src/dashboard";

test("the page keys node cards without probe latency so jitter never rebuilds them", () => {
	const html = renderDashboardHtml();
	expect(html).toContain('data-testid="node-badge"');
	expect(html).toContain("data-ms");
	// The put('nodes') cache key must not carry elapsedMs.
	const m = /put\('nodes'[\s\S]{0,600}/.exec(html);
	if (m) expect(m[0]).not.toContain("elapsedMs");
});
