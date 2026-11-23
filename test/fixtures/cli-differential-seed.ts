// Seeds a production-shaped database with the code of the tree it is given (pristine production code for the
// differential CLI test): bun cli-differential-seed.ts TREE DB PER_PHASE DIR
// Every phase gets PER_PHASE tasks, made through the store's public operations exactly as the hub makes them:
// queued (submit), preparing (reserve), dispatching/active/approval_required/cancel_unknown (session + turn +
// a non-terminal observation), blocked_unknown (markUnknown), completed_unverified/succeeded/failed/cancelled
// (a terminal observation; the first three also save a 64 KiB result manifest), archived (markUnknown, then
// Fleet.archive against a recorded SDK transport that lists no live session). Prints {ids:{key:id}}.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [tree, db, perPhaseText, dir] = process.argv.slice(2);
const perPhase = Number(perPhaseText);
const { FleetStore } = await import(join(tree!, "src", "store.ts"));
const { Fleet } = await import(join(tree!, "src", "fleet.ts"));
const { observationDigest } = await import(join(tree!, "src", "core.ts"));

const sdk = join(dir!, "sdk-list.ts");
writeFileSync(sdk, `console.log(JSON.stringify({ok:true,result:{version:2,source:"broker",scope:"all",selection:{scope:"all"},sessions:[],warnings:[]}}))`);
const node = (id: string, patch: Record<string, unknown> = {}) => ({
	id, os: process.platform, arch: process.arch, roots: { repo: "/repos/repo" }, workspaceRoot: "/work", enabled: true, draining: false,
	reachable: true, sdkReady: true, modelReady: true, models: ["model"], transport: { command: "/usr/bin/false", args: [] },
	sdkTransport: { command: process.execPath, args: [sdk] }, operations: ["read", "write"], ...patch,
});
const input = (key: string) => ({ schemaVersion: 1, key, caller: "differential", repoId: "repo", baseCommit: "a".repeat(40), prompt: `private ${key}`, required: {} });
const manifest = (key: string) => ({ status: "verified", patch: `${key}:${"+line\n".repeat(64 * 1024 / 6)}`, files: [{ path: `${key}.txt` }], tests: [{ argv: ["true"] }] });

const store = new FleetStore(db!);
store.putNode(node("n1"));
store.putNode(node("n2", { draining: true }));
const fleet = new Fleet(store);
const ids: Record<string, string> = {};
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
for (let i = 0; i < perPhase; i++) {
	ids[`queued-${i}`] = store.submit(input(`queued-${i}`)).id;
	ids[`preparing-${i}`] = store.reserve(store.submit(input(`preparing-${i}`)).id).id;
	for (const phase of ["dispatching", "active", "approval_required", "cancel_unknown"]) {
		const key = `${phase}-${i}`;
		ids[key] = attempt(key);
		observe(ids[key]!, key, phase, false);
	}
	for (const phase of ["completed_unverified", "succeeded", "failed", "cancelled"]) {
		const key = `${phase}-${i}`;
		ids[key] = attempt(key);
		observe(ids[key]!, key, phase, true);
		if (phase !== "cancelled") store.saveResult(ids[key]!, manifest(key));
	}
	ids[`blocked_unknown-${i}`] = attempt(`blocked_unknown-${i}`);
	store.markUnknown(ids[`blocked_unknown-${i}`]!, "seed_unknown");
	ids[`archived-${i}`] = attempt(`archived-${i}`);
	store.markUnknown(ids[`archived-${i}`]!, "seed_unknown");
	await fleet.archive(ids[`archived-${i}`]!, { notes: { seed: i } });
}
for (const [key, id] of Object.entries(ids)) {
	const phase = store.task(id)?.phase;
	if (phase !== key.replace(/-\d+$/, "")) throw new Error(`seed ${key}: phase ${phase}`);
}
store.close();
console.log(JSON.stringify({ ids }));
