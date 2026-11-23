// Seeds a database with the code of the tree it is given (this tree, or an older production tree for legacy rows):
// bun dispose-seed.ts TREE DB DIR COMPLETED
// Tasks are made through that tree's public store operations exactly as the hub makes them (see
// cli-differential-seed.ts): one task in every phase, COMPLETED settled completed_unverified tasks with a 64 KiB
// result manifest (released at settlement), one settled completed_unverified task whose reservation is still held
// (deferTerminalRelease, awaiting resource return) and one provisional completed_unverified task whose execution end
// is not confirmed (terminal=false). The nodes' SDK transport is DIR/sdk-list.ts: it appends one line to
// DIR/calls.log per call and prints DIR/listing.json, so a test controls the session listing and counts node contacts.
// Prints {ids:{key:id}}.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [tree, db, dir, completedText] = process.argv.slice(2);
const completed = Number(completedText);
const { FleetStore } = await import(join(tree!, "src", "store.ts"));
const { Fleet } = await import(join(tree!, "src", "fleet.ts"));
const { observationDigest } = await import(join(tree!, "src", "core.ts"));

const sdk = join(dir!, "sdk-list.ts");
writeFileSync(sdk, `import { appendFileSync } from "node:fs";
if (process.env.GJC_SDK_BROKER_AUTOSTART !== "0" || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["sdk","session","list","--scope","all","--json"])) process.exit(9);
appendFileSync(${JSON.stringify(join(dir!, "calls.log"))}, "list\\n");
console.log(await Bun.file(${JSON.stringify(join(dir!, "listing.json"))}).text());`);
writeFileSync(join(dir!, "listing.json"), JSON.stringify({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" }, sessions: [], warnings: [] } }));
const node = (id: string) => ({
	id, os: process.platform, arch: process.arch, roots: { repo: "/repos/repo" }, workspaceRoot: "/work", enabled: true, draining: false,
	reachable: true, sdkReady: true, modelReady: true, models: ["model"], transport: { command: "/usr/bin/false", args: [] },
	sdkTransport: { command: process.execPath, args: [sdk] }, operations: ["read", "write"],
});
const input = (key: string) => ({ schemaVersion: 1, key, caller: "dispose", repoId: "repo", baseCommit: "a".repeat(40), prompt: `private ${key}`, required: {} });
const manifest = (key: string) => ({ status: "verified", patch: `${key}:${"+line\n".repeat(64 * 1024 / 6)}`, files: [{ path: `${key}.txt` }], tests: [{ argv: ["true"] }] });
const ids: Record<string, string> = {};

let store = new FleetStore(db!);
const attempt = (key: string) => {
	const task = store.reserve(store.submit(input(key)).id);
	store.recordSession(task.id, `session-${key}`);
	store.recordTurn(task.id, `turn-${key}`);
	return task.id as string;
};
const observe = (id: string, key: string, status: string, terminal: boolean) => {
	const o = { sessionId: `session-${key}`, turnId: `turn-${key}`, status, terminal, evidence: { source: `seed-${key}` } };
	store.observe(id, { ...o, eventId: `event-${key}`, digest: observationDigest(o) });
};
store.putNode(node("n1"));
const fleet = new Fleet(store);
ids.queued = store.submit(input("queued")).id;
ids.preparing = store.reserve(store.submit(input("preparing")).id).id;
for (const phase of ["dispatching", "active", "approval_required", "cancel_unknown"]) {
	ids[phase] = attempt(phase);
	observe(ids[phase]!, phase, phase, false);
}
for (const phase of ["succeeded", "failed", "cancelled"]) {
	ids[phase] = attempt(phase);
	observe(ids[phase]!, phase, phase, true);
	if (phase !== "cancelled") store.saveResult(ids[phase]!, manifest(phase));
}
for (let i = 0; i < completed; i++) {
	const key = `completed-${i}`;
	ids[key] = attempt(key);
	observe(ids[key]!, key, "completed_unverified", true);
	store.saveResult(ids[key]!, manifest(key));
}
ids.provisional = attempt("provisional");
observe(ids.provisional!, "provisional", "completed_unverified", false);
ids.blocked_unknown = attempt("blocked_unknown");
store.markUnknown(ids.blocked_unknown!, "seed_unknown");
ids.archived = attempt("archived");
store.markUnknown(ids.archived!, "seed_unknown");
await fleet.archive(ids.archived!, { notes: { seed: true } });
store.close();
// A settled attempt that keeps its reservation until resource return (deferTerminalRelease hub).
store = new FleetStore(db!, 2, { deferTerminalRelease: true });
ids.held = attempt("held");
observe(ids.held!, "held", "completed_unverified", true);
store.saveResult(ids.held!, manifest("held"));
for (const [key, id] of Object.entries(ids)) {
	const task = store.task(id);
	const expected = key.startsWith("completed-") || key === "provisional" || key === "held" ? "completed_unverified" : key;
	if (task?.phase !== expected) throw new Error(`seed ${key}: phase ${task?.phase}`);
}
if (store.task(ids.held!)!.held !== true || store.task(ids.provisional!)!.held !== true || store.task(ids.provisional!)!.result.executionTerminal !== false)
	throw new Error("seed: held/provisional shape");
store.close();
writeFileSync(join(dir!, "calls.log"), "");
console.log(JSON.stringify({ ids }));
