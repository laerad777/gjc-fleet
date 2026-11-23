// Child process for daemon crash/signal tests: bun daemon-child.ts DB DIR MODE WORKSPACE_ROOT
//  MODE = N > 0: print {"killedAt":N}, then SIGKILL this process right after the N-th committed store write transaction;
//  MODE = 0: run to completion (queued published admissible, settled returned or noted, active observed), exit 0;
//  MODE = sigterm: a 500 ms observation in flight; SIGTERM/SIGINT stop it gracefully as `fleet daemon run` does.
// Controlled in-process node transports only (fixtures/daemon.ts); the daemon and store are unmodified.
import { writeSync } from "node:fs";
import { FleetDaemon } from "../../src/daemon";
import { Fleet } from "../../src/fleet";
import { FleetStore } from "../../src/store";
import { headroom } from "../admission-fixture";
import { fakeBroker, fakeCoordinator } from "./daemon";

const [db, dir, mode, workspaceRoot] = process.argv.slice(2) as [string, string, string, string];
let commits = 0;
if (mode !== "sigterm") {
	const killAt = Number(mode);
	const proto = FleetStore.prototype as any;
	const transaction = proto.transaction;
	proto.transaction = function (this: unknown, ...args: unknown[]) {
		const result = transaction.apply(this, args);
		if (++commits === killAt) {
			// The marker proves where the process ended on every platform (win32 has no signalCode).
			writeSync(1, JSON.stringify({ killedAt: killAt }) + "\n");
			process.kill(process.pid, "SIGKILL");
		}
		return result;
	};
}
const store = new FleetStore(db);
const fleet = new Fleet(store, { localNodeId: "n1" });
const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
if (mode === "sigterm") {
	const coordinator = fakeCoordinator(fleet, () => 500);
	const connect = (fleet as any).connect;
	(fleet as any).connect = async (...args: unknown[]) => {
		const rpc = await connect(...args);
		return { ...rpc, async call(name: string, a: unknown) {
			if (name === "gjc_coordinator_read_turn") log({ event: "observing" });
			const out = await rpc.call(name, a);
			if (name === "gjc_coordinator_read_turn") log({ event: "observed", finished: true });
			return out;
		} };
	};
	void coordinator;
	const daemon = new FleetDaemon(fleet, { cycleMs: 20, leaseMs: 4000, observeEveryMs: 10_000, nodeGapMs: () => 0, log });
	daemon.acquire();
	const stop = () => daemon.stop();
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	await daemon.run();
	store.close();
	process.exit(0);
}
const coordinator = fakeCoordinator(fleet, () => 5);
const broker = fakeBroker(dir, store);
const daemon = new FleetDaemon(fleet, {
	cycleMs: 20, leaseMs: 4000, observeEveryMs: 50, observeMaxEveryMs: 50, nodeGapMs: () => 0, returnPaceMs: 0, returnEveryMs: 50, graceMs: 5000,
	localNodeId: "n1",
	connectReturn: broker.connect as any,
	sample: async () => {
		const sample = headroom(["n1"], 10).samples.get("n1")!;
		sample.disks![0]!.path = workspaceRoot;
		return { ...sample, at: Date.now() };
	},
});
const running = daemon.run();
const deadline = Date.now() + 30_000;
for (;;) {
	await Bun.sleep(10);
	const tasks = store.tasks();
	const queued = tasks.find((t) => t.input.key === "queued")!;
	const settled = tasks.find((t) => t.input.key === "settled")!;
	const active = tasks.find((t) => t.input.key === "active")!;
	const settledDone = store.getOperation(settled.id, "resource-return-confirmed") !== undefined || store.events(settled.id).some((e) => e.kind === "daemon_note");
	const admissible = ((daemon.status() as any).queue.admissible as { taskId: string }[]).some((e) => e.taskId === queued.id);
	if (admissible && settledDone && (coordinator.reads.get(active.sessionId!) ?? 0) >= 2) break;
	if (Date.now() > deadline) {
		console.error("error: daemon child did not finish", JSON.stringify(daemon.status()));
		process.exit(2);
	}
}
daemon.stop();
await running;
if (coordinator.other.length) {
	console.error("error: unexpected Coordinator calls", coordinator.other);
	process.exit(3);
}
store.close();
console.log(JSON.stringify({ commits }));
process.exit(0);
