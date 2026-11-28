// Controlled stand-in for `gjc sdk session list`: refuses unless autostart is disabled and the
// call is attach-only, so a health probe that could start a Broker fails the test.
// MODE is `ok` or `fail`, optionally followed by `,slow=MS` (answer after MS) and `,log=PATH`
// (append one line per call, so a test can prove that nothing probed the Broker).
// Optional hold=PATH acknowledges a validated request at PATH.ready and awaits PATH.release.
// PATH.answer marks that the held response has been released for output.
import { appendFileSync } from "node:fs";
const [mode = "ok", ...args] = process.argv.slice(2);
const [kind, ...options] = mode.split(",");
const option = (name: string) => options.find(entry => entry.startsWith(name + "="))?.slice(name.length + 1);
const log = option("log");
if (log) appendFileSync(log, "called\n");
const expected = ["sdk", "session", "list", "--scope", "all", "--attach-only", "--json"];
if (process.env.GJC_SDK_BROKER_AUTOSTART !== "0" || JSON.stringify(args) !== JSON.stringify(expected)) {
	console.log(JSON.stringify({ ok: false, error: { code: "unguarded_call" } }));
	process.exit(2);
}
const hold = option("hold");
if (hold) {
	await Bun.write(hold + ".ready", "");
	const released = Bun.file(hold + ".release");
	const deadline = performance.now() + 8_000;
	while (!(await released.exists())) {
		if (performance.now() >= deadline) {
			console.error("broker fixture release timed out");
			process.exit(3);
		}
		await Bun.sleep(5);
	}
}
const slow = Number(option("slow") ?? 0);
if (slow > 0) await Bun.sleep(slow);
if (kind === "fail") {
	console.log(JSON.stringify({ ok: false, error: { code: "broker_unavailable" } }));
	process.exit(1);
}
if (hold) await Bun.write(hold + ".answer", "");
console.log(JSON.stringify({ ok: true, result: { version: 2, source: "broker", sessions: [] } }));
