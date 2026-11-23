import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * CONTROLLED public SDK CLI stand-in for the A+B interaction tests (NOT GJC).
 * argv: [statePath, logPath, coordinatorStatePath, ...sdk argv]. Answers:
 * - `sdk session raw global --op session.list` (exact, unpaginated; resource return and
 *   original authority capture) from `state.session`;
 * - `sdk session raw global --op session.close --idempotency-key K` with the broker's
 *   generation/incarnation fence and the idle fence (`ifIdle`). On a real close the row
 *   becomes terminal and the index advances. Before answering it records whether the
 *   close claim with key K was already durable in the Fleet DB (`durableBeforeSend`);
 * - `sdk session list --scope all --json` (archive evidence) from `state.session`;
 * - `sdk ... query turn.result` (late-receipt check) from `state.execution`. Test barrier: while
 *   `<statePath>.gate` exists the query announces itself in `<statePath>.gate.waiting` and waits
 *   (bounded, no reply on timeout), then answers from the state file as it is at release.
 * Every invocation is logged as one JSON line.
 */
export interface StackSdkState {
	dbPath: string;
	indexSeq: number;
	session: { present: boolean; live: boolean; terminal: boolean; activity: string; endpointGeneration: number; endpointIncarnation: string };
	execution: Record<string, any>;
	listFails?: boolean;
	executionFails?: boolean;
}

const [statePath, logPath, coordinatorPath] = process.argv.slice(2);
if (!statePath || !logPath || !coordinatorPath) throw new Error("controlled_stack_sdk_paths_required");
const argv = process.argv.slice(5);
const state: StackSdkState = JSON.parse(readFileSync(statePath, "utf8"));
const coordinator = existsSync(coordinatorPath) ? JSON.parse(readFileSync(coordinatorPath, "utf8")) : {};
const cwd: string | undefined = coordinator.session?.cwd;
const save = () => { writeFileSync(statePath + ".tmp", JSON.stringify(state)); renameSync(statePath + ".tmp", statePath); };
const log = (entry: Record<string, unknown>) => appendFileSync(logPath, JSON.stringify(entry) + "\n");
const reply = (value: unknown, exit = 0): never => { console.log(JSON.stringify(value)); process.exit(exit); };
const sessionId = "controlled-session";

if (argv[0] === "sdk" && argv[1] === "session" && argv[2] === "list") {
	log({ op: "archive-list", argv });
	if (state.listFails) process.exit(1);
	const s = state.session;
	reply({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" },
		sessions: s.present ? [{ sessionId, live: s.live, cwd, locator: { cwd, worktreeRoot: cwd } }] : [], warnings: [] } });
}
const input = JSON.parse(await new Response(Bun.stdin.stream()).text());
const op = argv[argv.indexOf("--op") + 1];
if (argv[0] === "sdk" && argv[1] === "session" && argv[2] === "raw" && op === "session.list") {
	log({ op: "list", input });
	if (state.listFails) reply({ ok: false, error: { code: "broker_unavailable" } }, 1);
	const s = state.session;
	const row = { sessionId, locator: { cwd }, endpointGeneration: s.endpointGeneration, endpointIncarnation: s.endpointIncarnation,
		live: s.live, terminal: s.terminal, ambiguous: false, terminalUncertain: false, activity: { state: s.activity } };
	reply({ type: "broker_response", ok: true, result: { indexSeq: state.indexSeq, sessions: s.present && input.resolveSessionId === sessionId ? [row] : [] } });
}
if (argv[0] === "sdk" && argv[1] === "session" && argv[2] === "raw" && op === "session.close") {
	const key = argv[argv.indexOf("--idempotency-key") + 1];
	const db = new Database(state.dbPath, { readonly: true });
	const durable = (db.query("SELECT count(*) AS n FROM operations WHERE kind LIKE 'resource-return-close:%' AND instr(data, ?) > 0").get(key) as any).n === 1;
	db.close();
	const s = state.session;
	log({ op: "close", key, input, durableBeforeSend: durable, activity: s.activity });
	if (!s.present || input.sessionId !== sessionId || input.endpointGeneration !== s.endpointGeneration || input.endpointIncarnation !== s.endpointIncarnation)
		reply({ ok: false, error: { code: "endpoint_stale" } }, 1);
	if (input.ifIdle === true && s.activity !== "idle") reply({ ok: false, error: { code: "busy" } }, 1);
	s.live = false;
	s.terminal = true;
	state.indexSeq += 1;
	save();
	reply({ ok: true, operation: "session.close", result: { sessionId } });
}
log({ op: "query", argv, input });
if (argv[3] !== "query" || argv[argv.indexOf("--query") + 1] !== "turn.result" || state.executionFails)
	reply({ type: "error", ok: false, error: "controlled_route_refused" }, 1);
const gate = statePath + ".gate";
if (existsSync(gate)) {
	writeFileSync(gate + ".waiting", String(process.pid));
	const until = Date.now() + 8000;
	while (existsSync(gate) && Date.now() < until) await Bun.sleep(10);
	if (existsSync(gate)) reply({ type: "error", ok: false, error: "controlled_gate_timeout" }, 1);
	state.execution = JSON.parse(readFileSync(statePath, "utf8")).execution;
}
reply({ type: "query_response", ok: true, result: { kind: "prompt", commandId: input.commandId, turnId: input.turnId, ...state.execution } });
