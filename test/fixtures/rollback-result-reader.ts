// Rollback result reader: run with ANOTHER release's source tree (argv[2]) against a database
// the current release wrote (argv[3] JSON). Reads the result of each task this release verified
// through that release's own API and CLI (`result ID`, with and without argv).
import { join } from "node:path";

const tree = process.argv[2]!;
const input = JSON.parse(process.argv[3]!) as { db: string; cap: number; argv: string[]; tasks: { id: string }[] };
const { FleetStore } = await import(join(tree, "src/store.ts"));
const { Fleet } = await import(join(tree, "src/fleet.ts"));
const { digest } = await import(join(tree, "src/core.ts"));

const outcome = async (body: () => Promise<any>) => {
	try {
		const value = await body();
		return { ok: true, status: value.status, digest: digest(value) };
	} catch (error: any) {
		return { ok: false, code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 200) };
	}
};
const cli = (...args: string[]) => {
	const r = Bun.spawnSync([process.execPath, join(tree, "src/cli.ts"), "--db", input.db, "--cap", String(input.cap), ...args], { stdout: "pipe", stderr: "pipe" });
	return { exit: r.exitCode, stderr: r.stderr.toString().trim().slice(0, 200), digest: r.exitCode === 0 ? digest(JSON.parse(r.stdout.toString())) : null };
};
const store = new FleetStore(input.db, input.cap);
const report: any[] = [];
for (const { id } of input.tasks) {
	const task = store.task(id);
	const fleet = new Fleet(store, { localNodeId: task.nodeId });
	report.push({
		id,
		result: await outcome(() => fleet.result(id)),
		resultWithArgv: await outcome(() => fleet.result(id, input.argv)),
		cliResult: cli("result", id),
		after: { phase: store.task(id).phase, verified: store.task(id).result?.verified, evidence: store.task(id).result?.verificationEvidence },
	});
}
store.close();
console.log(JSON.stringify(report));
