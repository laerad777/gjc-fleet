// Controlled stand-in for `gjc sdk session list`: refuses unless autostart is disabled and the
// call is attach-only, so a health probe that could start a Broker fails the test.
// MODE is `ok` or `fail`, optionally followed by `,slow=MS` (answer after MS) and `,log=PATH`
// (append one line per call, so a test can prove that nothing probed the Broker).
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
const slow = Number(option("slow") ?? 0);
if (slow > 0) await Bun.sleep(slow);
if (kind === "fail") {
	console.log(JSON.stringify({ ok: false, error: { code: "broker_unavailable" } }));
	process.exit(1);
}
console.log(JSON.stringify({ ok: true, result: { version: 2, source: "broker", sessions: [] } }));
