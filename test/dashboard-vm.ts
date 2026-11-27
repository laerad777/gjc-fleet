import { runInNewContext } from "node:vm";
import { renderDashboardHtml, type DashboardState } from "../src/dashboard";

// Only DOM construction, geometry and browser timing are stubbed. The dashboard's
// shipped script still receives the real fixture and produces the HTML under test.
class DashboardElement {
	private html = "";
	parentNode: DashboardElement | null = null;
	get innerHTML() { return this.html; }
	set innerHTML(value: string) { this.html = value; if (value === "") this.children = []; }
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
	listeners = new Map<string, (event: unknown) => void>();
	hidden = false;
	disabled = false;
	static focused: DashboardElement | null = null;
	addEventListener(type: string, handler: (event: unknown) => void) { this.listeners.set(type, handler); }
	closest() { return this; }
	focus() { DashboardElement.focused = this; }
	querySelector() { return null; }
	querySelectorAll() { return []; }
	children: unknown[] = [];
	appendChild(child: unknown) { (child as DashboardElement).parentNode = this; this.children.push(child); return child; }
	get lastChild() { return this.children[this.children.length - 1]; }
	remove() {}
}

export const focusedElement = (): unknown => DashboardElement.focused;

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
			createTextNode: (text: string) => { const e = new DashboardElement(); e.textContent = String(text); return e; },
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
		clearTimeout: () => {},
		setInterval: () => 0,
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	return elements;
}
