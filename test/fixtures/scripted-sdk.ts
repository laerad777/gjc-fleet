import { appendFileSync, readFileSync } from "node:fs";

/**
 * CONTROLLED public SDK CLI stand-in (NOT GJC) for catch-site-behaviour.test.ts. argv[2] is a plan
 * file `{ replies: { [op]: body }, faults: { [op]: callNumber } }`, argv[3] a call log. The op is the
 * `--op` value (session.list, session.close, turn.abort) or the `--query` value (turn.result). The
 * n-th call of an op named in `faults` answers with non-JSON output, which the Fleet SDK client turns
 * into a TransportError without a public response; every other call answers with the planned body
 * (turn.result is bound to the requested command/turn). An op without a planned body exits 2.
 */
const [planPath, logPath] = process.argv.slice(2);
if (!planPath || !logPath) throw new Error("scripted_sdk_paths_required");
const argv = process.argv.slice(4);
const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const op = at("--op") ?? at("--query") ?? argv.slice(0, 3).join(" ");
const raw = await new Response(Bun.stdin.stream()).text();
const input = raw ? JSON.parse(raw) : {};
const log = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const call = log.filter((entry) => entry.op === op).length + 1;
appendFileSync(logPath, JSON.stringify({ op, call }) + "\n");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (plan.faults?.[op] === call) {
	process.stdout.write("controlled fault: not json");
	process.exit(0);
}
const body = plan.replies?.[op];
if (body === undefined) process.exit(2);
console.log(JSON.stringify(op === "turn.result" ? { type: "query_response", ok: true, result: { kind: "prompt", commandId: input.commandId, turnId: input.turnId, ...body } } : body));
