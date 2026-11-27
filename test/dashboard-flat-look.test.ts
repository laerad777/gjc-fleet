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

test("dashboard stays light and calm: no blur, gradients, spinners, entrance motion or large numerals", () => {
	const html = renderDashboardHtml();
	expect(html).not.toMatch(/backdrop-filter\s*:\s*blur\(\s*[1-9]/);
	expect(html).not.toContain("background-clip:text");
	expect(html).not.toMatch(/(?:^|[;{\s])background:[^;}]*linear-gradient/);
	for (const name of ["rise", "spin", "shimmer", "pop", "pop2", "hubin", "blink", "dash", "reco", "dropin", "lkpulse"]) {
		expect(html).not.toContain(`@keyframes ${name}`);
	}
	expect(html).not.toMatch(/font-size:\s*(?:2[5-9]|[3-9]\d)px/);
});

test("dashboard copy hides internal names and keeps the reduced-motion rule", () => {
	const html = renderDashboardHtml();
	expect(html).not.toContain("Gajae Code Runtime");
	expect(html).not.toContain("Wins / Trouble");
	expect(html).toContain("prefers-reduced-motion:reduce");
});
