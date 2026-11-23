// Rollback reader: run with ANOTHER release's source tree (argv[2]) against a database the
// current release wrote (argv[3] JSON). Imports only that tree's own modules, so it exercises
// exactly what the older release does with tasks whose export review is pending.
import { join } from "node:path";

const tree = process.argv[2]!;
const input = JSON.parse(process.argv[3]!) as {
	db: string;
	cap: number;
	deferTerminalRelease: boolean;
	pending: { id: string; input: unknown }[];
	fresh: { input: unknown; argv: string[]; node: unknown; drain: unknown[] };
};
const { FleetStore } = await import(join(tree, "src/store.ts"));
const { Fleet, validateResult } = await import(join(tree, "src/fleet.ts"));
const { getDashboardState } = await import(join(tree, "src/dashboard.ts"));
const { observationDigest } = await import(join(tree, "src/core.ts"));
const { returnResources } = await import(join(tree, "src/resource-return.ts"));
const { runTask, taskExit } = await import(join(tree, "src/operator-commands.ts"));

const outcome = async (body: () => unknown) => {
	try {
		const value: any = await body();
		return { ok: true, phase: value?.phase ?? value?.task?.phase ?? null, status: value?.status ?? null };
	} catch (error: any) {
		return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) };
	}
};
const view = (task: any) => ({
	phase: task.phase,
	held: task.held,
	verified: task.result?.verified ?? null,
	exportIncomplete: task.result?.exportIncomplete ?? null,
});
const cli = (...args: string[]) => {
	const r = Bun.spawnSync([process.execPath, join(tree, "src/cli.ts"), "--db", input.db, "--cap", String(input.cap), ...args], { stdout: "pipe", stderr: "pipe" });
	return { exit: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
};
const report: Record<string, unknown> = {};

// Open and list: the store, the operator CLI (phase filter, compact listing, show) and the dashboard.
const store = new FleetStore(input.db, input.cap, { deferTerminalRelease: input.deferTerminalRelease });
report.opened = true;
report.listed = store.tasks().map((task: any) => ({ id: task.id, ...view(task) }));
const listing = cli("tasks", "--phase", "completed_unverified", "--compact");
report.cliTasks = { exit: listing.exit, lines: listing.stdout.trim().split("\n").filter(Boolean).length };
const show = cli("show", input.pending[0]!.id);
report.cliShow = { exit: show.exit, phase: show.exit === 0 ? JSON.parse(show.stdout).phase : null };
const dashboard = getDashboardState(store);
report.dashboard = { summary: dashboard.summary, outcome: dashboard.pipeline.outcome };

// Operate on the pending tasks: retrieval/verification, operator run/exit code, resource return.
report.pending = [];
for (const pending of input.pending) {
	const task = store.task(pending.id);
	// Workspace collection for the task's node runs in this process.
	const fleet = new Fleet(store, { localNodeId: task.nodeId });
	const entry: Record<string, unknown> = { before: view(task) };
	entry.validateResult = await outcome(() => validateResult(task.workspace, task.resultManifest));
	entry.taskExit = taskExit(task);
	entry.run = await outcome(async () => {
		const run = await runTask(fleet, pending.input, { sample: async () => new Map(), localNodeId: task.nodeId });
		return { phase: run.task.phase, status: run.code };
	});
	entry.result = await outcome(() => fleet.result(pending.id));
	entry.resultWithArgv = await outcome(() => fleet.result(pending.id, input.fresh.argv));
	entry.cliResult = (({ exit, stderr }) => ({ exit, stderr: stderr.trim().slice(0, 200) }))(cli("result", pending.id));
	entry.after = view(store.task(pending.id));
	if (store.task(pending.id).held) {
		let indexSeq = 0;
		const connect = async () => ({
			list: async () => ({ type: "broker_response", ok: true, result: { indexSeq: ++indexSeq, sessions: [] } }),
			fencedClose: async () => { throw new Error("no close expected"); },
			close() {},
		});
		const [returned] = await returnResources(store, [pending.id], { connect, paceMs: 0 });
		entry.resourceReturn = returned?.state ?? null;
		entry.resourceReturnReason = returned?.reason ?? null;
		entry.afterReturn = view(store.task(pending.id));
	}
	entry.events = store.events(pending.id).map((event: any) => event.kind).slice(-6);
	(report.pending as unknown[]).push(entry);
}

// Operate normally on a new task in the same database: submit, start, settle, verify.
report.fresh = await outcome(async () => {
	for (const node of input.fresh.drain) store.putNode(node);
	store.putNode(input.fresh.node);
	const local = new Fleet(store, { localNodeId: (input.fresh.node as { id: string }).id });
	const submitted = local.submit(input.fresh.input);
	const started = await local.start(submitted.id);
	const body = { sessionId: started.sessionId, turnId: started.turnId, status: "completed_unverified", terminal: true, evidence: { rollback: true } };
	store.observe(started.id, { ...body, eventId: "rollback-settlement", digest: observationDigest(body) });
	await local.result(started.id, input.fresh.argv);
	return store.task(started.id);
});
store.close();
console.log(JSON.stringify(report));
