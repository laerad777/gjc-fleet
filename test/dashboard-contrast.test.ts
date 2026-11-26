import { describe, expect, test } from "bun:test";
import { renderDashboardHtml } from "../src/dashboard";

// Inspect the public page output, not dashboard-page.ts or its implementation.
const html = renderDashboardHtml();
const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join("\n");

function rule(selector: string): Record<string, string> {
	const declarations: Record<string, string> = {};
	for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!match[1].split(",").some((part) => part.trim() === selector)) continue;
		for (const declaration of match[2].split(";")) {
			const colon = declaration.indexOf(":");
			if (colon !== -1) declarations[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
		}
	}
	expect(Object.keys(declarations).length, `Missing emitted CSS rule: ${selector}`).toBeGreaterThan(0);
	return declarations;
}

const tokens = rule(":root");
type RGB = [number, number, number];
function rgb(value: string): RGB {
	const resolved = value.replace(/var\((--[\w-]+)\)/g, (_, name) => tokens[name]);
	expect(resolved).toMatch(/^#[\da-f]{6}$/i);
	return [1, 3, 5].map((offset) => Number.parseInt(resolved.slice(offset, offset + 2), 16)) as RGB;
}
function composite(value: string, background: RGB): RGB {
	const match = /^rgba\((\d+),(\d+),(\d+),([.\d]+)\)$/.exec(value);
	expect(match, `Expected an emitted translucent surface: ${value}`).not.toBeNull();
	const alpha = Number(match![4]);
	return background.map((channel, index) => Number(match![index + 1]) * alpha + channel * (1 - alpha)) as RGB;
}
function luminance(color: RGB): number {
	return color.map((channel) => {
		const s = channel / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	}).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(a: RGB, b: RGB): number {
	const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (values[0] + 0.05) / (values[1] + 0.05);
}
const base = rgb(tokens["--bg"]);
const surfaces = [base, composite(tokens["--panel"], base), composite(tokens["--panel-hi"], base)];

describe("rendered light dashboard contrast", () => {
	test("small secondary text meets 4.5:1 on light surfaces and nested chips", () => {
		const nested = surfaces.map((surface) => composite(rule(".chip").background, composite(tokens["--panel-hi"], surface)));
		for (const token of ["--text", "--sub", "--dim"]) {
			for (const surface of [...surfaces, ...nested]) {
				expect(contrast(rgb(tokens[token]), surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
			}
		}
		expect(luminance(rgb(tokens["--sub"])) - luminance(rgb(tokens["--text"]))).toBeGreaterThan(0.03);
	});

	test("metadata, empty states and small labels use the readable dim tier", () => {
		for (const selector of [".rt-age", ".count", ".empty", "footer", ".note", ".st .r", ".steplabels", ".kv dt", ".tl time", ".stats small", ".meta", ".tabs button small", ".ss-age", ".ss-title.none", ".res-row label small", ".res-row span small"]) {
			expect(rule(selector).color, selector).toBe("var(--dim)");
		}
	});

	test("status text remains readable against tinted normal and hover cards", () => {
		const statusColors: RGB[] = [];
		for (const state of ["ok", "warn", "bad", "info"]) {
			const badge = rule(`.chip.${state}`);
			const foreground = rgb(badge.color);
			statusColors.push(foreground);
			for (const surface of surfaces) {
				expect(contrast(foreground, composite(badge.background, surface)), state).toBeGreaterThanOrEqual(4.5);
			}
		}
		expect(new Set(statusColors.map((color) => color.join(","))).size).toBe(4);
	});

	test("zero-count badges and stale data never fade text as a group", () => {
		const muted = rule(".chip.mute");
		expect(muted.opacity).toBe("1");
		expect(muted.color).toBe("var(--dim)");
		for (const surface of surfaces) expect(contrast(rgb(muted.color), composite(muted.background, surface))).toBeGreaterThanOrEqual(4.5);
		expect(rule(".stale main").opacity).toBe("1");
		expect(rule(".stale main").filter).toBe("saturate(.4)");
	});

	test("the emitted page is the English light theme and keeps layout and task expansion contracts", () => {
		expect(html).toContain('<html lang="en"');
		expect(html).toContain('<meta name="theme-color" content="#f7f8fe">');
		expect(rule(".wrap")["max-width"]).toBe("960px");
		expect(rule(".steps")["grid-template-columns"]).toBe("repeat(7,1fr)");
		expect(rule(".tk.open .more")["grid-template-rows"]).toBe("1fr");
		expect(rule(".rise").animation).toBe("rise .7s var(--ease) forwards");
		expect(css).toContain("@media(prefers-reduced-motion:reduce)");
		expect(css).toContain("@media(min-width:680px)");
		expect(css).toContain("@media(max-width:700px)");
		for (const hook of ["balloon", "node-badge", "sheet", "headline", "pill-"]) expect(html).toContain(`data-testid="${hook}`);
	});
});
