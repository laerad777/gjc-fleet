import { expect, test } from "bun:test";
import { renderDashboardHtml } from "../src/dashboard";

test("dashboard stays flat: no drop shadows, glows, halos or ripple animations", () => {
	const html = renderDashboardHtml();
	expect(html).not.toMatch(/box-shadow:\s*-?\d+(px)?\s+-?\d+px\s+-?\d+px/);
	for (const name of ["@keyframes rip", "@keyframes ping", "@keyframes halo", "@keyframes glow", "@keyframes breathe"]) {
		expect(html).not.toContain(name);
	}
	expect(html).not.toContain('class="halo"');
});
