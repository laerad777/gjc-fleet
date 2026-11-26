import { runInNewContext } from "node:vm";
import { renderDashboardHtml, type DashboardState } from "../src/dashboard";

// Only DOM construction, geometry and browser timing are stubbed. The dashboard's
// shipped script still receives the real fixture and produces the HTML under test.
class DashboardElement {
	innerHTML = "";
	textContent = "";
	className = "";
	lastElementChild = { textContent: "" };
	classList = {
		add: (name: string) => this.classList.toggle(name, true),
		remove: (name: string) => this.classList.toggle(name, false),
		toggle: (name: string, enabled: boolean) => {
			const classes = new Set(this.className.split(" ").filter(Boolean));
			if (enabled) classes.add(name);
			else classes.delete(name);
			this.className = [...classes].join(" ");
		},
	};
	attrs = new Map<string, string>();
	style = { setProperty() {} };
	setAttribute(key: string, value: string) { this.attrs.set(key, value); }
	getAttribute(key: string) { return this.attrs.get(key) ?? null; }
	removeAttribute(key: string) { this.attrs.delete(key); }
	addEventListener() {}
	querySelector() { return null; }
	querySelectorAll() { return []; }
	appendChild() {}
	remove() {}
}

export async function renderDashboardFixture(state: DashboardState) {
	const elements = new Map<string, DashboardElement>();
	const byId = (id: string) => {
		let e = elements.get(id);
		if (!e) { e = new DashboardElement(); elements.set(id, e); }
		return e;
	};
	let script = "";
	await new HTMLRewriter()
		.on("[id]", { element(e) { byId(e.getAttribute("id")!); } })
		.on("script", { text(chunk) { script += chunk.text; } })
		.transform(new Response(renderDashboardHtml())).text();
	runInNewContext(script, {
		document: {
			getElementById: byId,
			createElement: () => new DashboardElement(),
			querySelector: (selector: string) => selector === "header" ? { offsetHeight: 110 } : new DashboardElement(),
			querySelectorAll: () => [],
			body: new DashboardElement(),
			documentElement: new DashboardElement(),
			addEventListener() {},
		},
		innerWidth: 1280,
		innerHeight: 800,
		addEventListener() {},
		requestAnimationFrame: () => 0,
		matchMedia: () => ({ matches: true }),
		fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(state)) }),
		WebSocket: class {},
		location: { protocol: "http:", host: "dashboard.invalid" },
		setTimeout: () => 0,
		setInterval: () => 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	return elements;
}
