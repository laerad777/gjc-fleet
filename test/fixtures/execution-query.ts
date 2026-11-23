import { appendFileSync, existsSync, readFileSync } from "node:fs";

/**
 * CONTROLLED public SDK CLI stand-in (NOT GJC). Answers only the read-only
 * `turn.result` query with the execution record stored in argv[2], bound to the
 * exact requested command/turn unless the stored record overrides `commandId` /
 * `turnId` (a reply for another command). Every invocation is logged to argv[3] so
 * tests can prove no prompt, abort or close was ever sent through this route. For
 * the archive path it also answers the read-only `sdk session list --scope all
 * --json` from `<statePath>.list.json` when that file exists.
 */
const [statePath, logPath] = process.argv.slice(2);
if (!statePath || !logPath) throw new Error("controlled_execution_paths_required");
const argv = process.argv.slice(4);
if (argv[0] === "sdk" && argv[1] === "session" && argv[2] === "list") {
	appendFileSync(logPath, JSON.stringify({ argv }) + "\n");
	const listPath = statePath + ".list.json";
	if (!existsSync(listPath)) process.exit(1);
	console.log(readFileSync(listPath, "utf8"));
	process.exit(0);
}
const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
appendFileSync(logPath, JSON.stringify({ argv, input }) + "\n");
const query = argv.indexOf("--query");
if (argv[3] !== "query" || argv[query + 1] !== "turn.result") {
	console.log(JSON.stringify({ type: "error", ok: false, error: "controlled_route_refused" }));
	process.exit(1);
}
const execution = JSON.parse(readFileSync(statePath, "utf8"));
console.log(
	JSON.stringify({
		type: "query_response",
		ok: true,
		result: { kind: "prompt", commandId: input.commandId, turnId: input.turnId, ...execution },
	}),
);
