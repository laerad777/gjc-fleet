// Behavior tests for independent review 5a4b253e (MED-1, MED-3, LOW-1, LF-1, INFO-3). Each started
// as the reviewer's probe that reproduced the defect; here it asserts the required behavior. Real
// FleetStore (SQLite) and real src/node.ts behind a recording shim. Git fixtures live under the OS
// temp directory.
import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import { headroom } from "./admission-fixture";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { reconsiderQueue } from "../src/index";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const nodeTs = resolve(import.meta.dir, "../src/node.ts");
const refusal = "node_refused:root_denied:allowlist";

async function fixture(key: string, maxConcurrency = 1, helper = nodeTs) {
	const f = await repositoryFixture("refusal-release-");
	dirs.push(f.dir);
	const state = join(f.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const sessions = join(f.dir, "sessions.ts");
	await writeFile(sessions, `console.log(JSON.stringify({ok:true,result:{version:2,source:"broker",scope:"all",selection:{scope:"all"},sessions:[],warnings:[]}}))`);
	const node: any = {
		id: "node", os: process.platform, arch: process.arch, roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot, maxConcurrency, enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [resolve(import.meta.dir, "fixtures/coordinator.ts"), state] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const counter = join(f.dir, "dispatches");
	const mode = join(f.dir, "mode.json");
	const shim = join(f.dir, "helper.ts");
	// mode.json: { reply?: {action, stdout, exit}, delay?: {action: ms}, plan?: {action: [{delay?, reply?}]} }
	await writeFile(shim, `import {appendFileSync,existsSync,readFileSync} from 'node:fs';
const input=await Bun.stdin.text();let action='?';let attempt='?';try{const r=JSON.parse(input);action=String(r.action);attempt=String(r.input?.attemptId??r.identity?.attemptId)}catch{}
const prior=existsSync(${JSON.stringify(counter)})?readFileSync(${JSON.stringify(counter)},'utf8').split('\\n').filter(l=>l.startsWith(action+' ')).length:0;
appendFileSync(${JSON.stringify(counter)},action+' '+attempt+'\\n');
const mode=existsSync(${JSON.stringify(mode)})?JSON.parse(readFileSync(${JSON.stringify(mode)},'utf8')):{};
const step=mode.plan?.[action]?.[prior];
if(step?.delay)await Bun.sleep(step.delay);
if(mode.delay?.[action])await Bun.sleep(mode.delay[action]);
const r=step?.reply?{action,...step.reply}:mode.reply;
if(r&&r.action===action){process.stdout.write(r.stdout);process.exitCode=r.exit;}
else{const child=Bun.spawn([process.execPath,${JSON.stringify(helper)},${JSON.stringify(config)}],{stdin:new Blob([input]),stdout:'inherit',stderr:'inherit'});process.exitCode=await child.exited;}`);
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db);
	const full = { ...node, workspaceTransport: { command: process.execPath, args: [shim] }, sdkTransport: { command: process.execPath, args: [sessions] } };
	if (helper !== nodeTs) await writeFile(config, JSON.stringify(full));
	store.putNode(full);
	const t = store.submit({ schemaVersion: 1, key, caller: "refusal-release", repoId: "repo", baseCommit: f.baseCommit, prompt: "release", required: {} });
	const resources = headroom(["node"], maxConcurrency);
	resources.samples.get("node")!.disks![0]!.path = f.workspaceRoot;
	store.reserve(t.id, resources);
	const dispatches = async () => (await Bun.file(counter).exists()) ? (await readFile(counter, "utf8")).trim().split("\n") : [];
	return {
		...f, db, store, config, resources, task: store.task(t.id)!,
		setMode: (value: unknown) => writeFile(mode, JSON.stringify(value)),
		dispatches,
		actions: async () => (await dispatches()).map(l => l.split(" ")[0]),
		events: (kind: string) => store.events(t.id).filter(e => e.kind === kind),
		breakSource: () => f.git("config", "filter.fleet-refusal.clean", "cat"),
		fixSource: () => f.git("config", "--remove-section", "filter.fleet-refusal"),
	};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function caught(p: Promise<unknown>): Promise<any> {
	try { await p; } catch (error) { return error; }
	throw new Error("expected rejection");
}
async function refuseOnce(f: Fixture) {
	await f.breakSource();
	const first = await caught(new Fleet(f.store).start(f.task.id));
	expect(first.code).toBe(refusal);
	await f.fixSource();
	return f.store.getOperation(f.task.id, "prepare")!;
}
/** Concurrent first starts: the loser marks blocked_unknown (base no-replay rule) while the winner's prepare is refused before send. */
async function raceToBlockedUnknownWithRefusal(f: Fixture) {
	await f.breakSource();
	await f.setMode({ delay: { prepare: 1500 } });
	const a = caught(new Fleet(f.store).start(f.task.id));
	while (!(await f.actions()).includes("prepare")) await Bun.sleep(25);
	expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("blocked_unknown");
	expect((await a).code).toBe(refusal);
	expect(f.store.task(f.task.id)!.phase).toBe("blocked_unknown");
	expect((f.store.getOperation(f.task.id, "prepare")!.receipt as any).nodeRefusal.certainty).toBe("before_send");
	await f.fixSource();
	await f.setMode({});
}

test("MED-1: an archived task carrying a before_send prepare receipt is never re-evaluated; no preflight reaches the node", async () => {
	const f = await fixture("med1");
	try {
		await raceToBlockedUnknownWithRefusal(f);
		expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("blocked_unknown");
		const archived = await new Fleet(f.store).archive(f.task.id, { noSessionConfirmation: { kind: "never_started", reason: "prepare refused before send" } });
		expect(archived.phase).toBe("archived");
		const before = await f.dispatches();
		const attemptId = archived.attemptId;
		await new Fleet(f.store).start(f.task.id).catch(() => undefined);
		expect((await f.dispatches()).slice(before.length)).toEqual([]);
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "archived", held: false, attemptId });
		expect(f.events("preparation_reevaluation")).toHaveLength(0);
		expect(f.events("preparation_refusal_cleared")).toHaveLength(0);
	} finally { f.store.close(); }
}, 60000);
test("MED-1: a task archived as node_retired after its node was unregistered sends nothing to the snapshot transport", async () => {
	const f = await fixture("med1-retired");
	try {
		await raceToBlockedUnknownWithRefusal(f);
		f.store.setNodeState("node", { enabled: false });
		f.store.unregisterNode("node");
		const archived = await new Fleet(f.store).archive(f.task.id, { operatorOverride: { kind: "node_retired", reason: "host retired" }, noSessionConfirmation: { kind: "never_started", reason: "never started" } });
		expect(archived.phase).toBe("archived");
		const before = (await f.dispatches()).length;
		await new Fleet(f.store).start(f.task.id).catch(() => undefined);
		expect((await f.dispatches()).slice(before)).toEqual([]);
		expect(f.events("preparation_reevaluation")).toHaveLength(0);
	} finally { f.store.close(); }
}, 60000);
test("MED-3: a retained before_send refusal can be archived (released, never replayed) and its node then unregistered", async () => {
	const f = await fixture("med3");
	try {
		await f.breakSource();
		await caught(new Fleet(f.store).start(f.task.id));
		await caught(new Fleet(f.store).start(f.task.id)); // cause persists: still_refused, held
		const held = f.store.task(f.task.id)!;
		expect(held).toMatchObject({ phase: "dispatching", held: true, reason: "preparation_refusal_retained:still_refused" });
		const refused = f.store.getOperation(f.task.id, "prepare")!;
		// The archive evidence rules are unchanged: a no-session classification is still required.
		expect((await caught(new Fleet(f.store).archive(f.task.id))).code).toBe("ARCHIVE_CREATE_UNKNOWN");
		const archived = await new Fleet(f.store).archive(f.task.id, { noSessionConfirmation: { kind: "never_started", reason: "prepare refused before send" } });
		expect(archived).toMatchObject({ phase: "archived", held: false, attemptId: held.attemptId });
		expect(archived.archivedFrom).toMatchObject({ phase: "dispatching", reason: "preparation_refusal_retained:still_refused" });
		expect(f.events("released").map(e => e.data)).toMatchObject([{ attemptId: held.attemptId!, cause: "archived" }]);
		expect([...f.store.heldCharges().values()].flat()).toHaveLength(0);
		// Released: the refused claim is retained unchanged and never re-evaluated or replayed.
		await f.fixSource();
		const before = (await f.dispatches()).length;
		await new Fleet(f.store).start(f.task.id).catch(() => undefined);
		expect((await f.dispatches()).slice(before)).toEqual([]);
		expect(f.store.getOperation(f.task.id, "prepare")).toEqual(refused);
		expect(() => f.store.renewRefusedPreparation(f.task.id, refused.id)).toThrow();
		f.store.setNodeState("node", { enabled: false });
		f.store.unregisterNode("node");
		expect(f.store.nodes().map(n => n.id)).not.toContain("node");
	} finally { f.store.close(); }
}, 60000);
test("MED-3: archive still refuses a held dispatching task whose prepare outcome is not a proven refusal", async () => {
	const f = await fixture("med3-claim");
	try {
		const op = f.store.claimOperation(f.task.id, "prepare", { attempt: f.task.attemptId! })!;
		expect(f.store.task(f.task.id)).toMatchObject({ phase: "dispatching", held: true });
		expect((await caught(new Fleet(f.store).archive(f.task.id, { noSessionConfirmation: { kind: "never_started", reason: "x" } }))).code).toBe("ARCHIVE_PHASE");
		f.store.recordOperationReceipt(f.task.id, "prepare", op.id, { nodeRefusal: { ok: false, error: "root_denied", detail: "allowlist", certainty: "unknown" } } as any);
		expect(f.store.retainedPreparationRefusal(f.task.id)).toBeUndefined();
		expect((await caught(new Fleet(f.store).archive(f.task.id, { noSessionConfirmation: { kind: "never_started", reason: "x" } }))).code).toBe("ARCHIVE_PHASE");
	} finally { f.store.close(); }
}, 60000);
test("INFO-3: a refusal receipt that is not before_send is never re-evaluated; the base no-replay path holds it unknown", async () => {
	const f = await fixture("info3");
	try {
		const op = f.store.claimOperation(f.task.id, "prepare", { attempt: f.task.attemptId! })!;
		f.store.recordOperationReceipt(f.task.id, "prepare", op.id, { nodeRefusal: { ok: false, error: "root_denied", detail: "allowlist", certainty: "unknown" } } as any);
		expect((await new Fleet(f.store).start(f.task.id)).phase).toBe("blocked_unknown");
		expect(await f.dispatches()).toEqual([]);
		expect(f.events("preparation_reevaluation")).toHaveLength(0);
	} finally { f.store.close(); }
}, 60000);
test("LF-1: a re-evaluation recorded after a concurrent renewal never stamps the fresh attempt (store level)", async () => {
	const f = await fixture("lf1-store");
	try {
		const refused = await refuseOnce(f);
		const renewed = f.store.renewRefusedPreparation(f.task.id, refused.id);
		expect(renewed.reason).toBeUndefined();
		f.store.recordPreparationReevaluation(f.task.id, refused.id, "unavailable", "node_transport_failed");
		const t = f.store.task(f.task.id)!;
		expect(t).toMatchObject({ attemptId: renewed.attemptId, phase: "preparing" });
		expect(t.reason).toBeUndefined();
		// The audit row is still written: the re-evaluation happened.
		expect(f.events("preparation_reevaluation")).toHaveLength(1);
	} finally { f.store.close(); }
}, 60000);
test("LF-1: concurrent starts where one preflight passes and the other fails late leave no stale retained reason (Fleet level)", async () => {
	const f = await fixture("lf1-fleet");
	try {
		await refuseOnce(f);
		await f.setMode({ plan: { preflight: [{}, { delay: 600, reply: { stdout: "", exit: 3 } }] }, delay: { prepare: 1500 } });
		const a = new Fleet(f.store).start(f.task.id).then(t => t, e => e);
		while ((await f.actions()).filter(x => x === "preflight").length < 1) await Bun.sleep(10);
		const other = new FleetStore(f.db);
		try {
			await new Fleet(other).start(f.task.id).then(t => t, e => e);
		} finally { other.close(); }
		await a;
		const t = f.store.task(f.task.id)!;
		expect(t.attemptId).not.toBe(f.task.attemptId);
		expect(t.reason ?? "").not.toMatch(/^preparation_refusal_retained:/);
		expect(f.events("preparation_refusal_cleared")).toHaveLength(1);
		expect((await f.actions()).filter(x => x === "prepare")).toHaveLength(2); // refused original + one fresh attempt
	} finally { f.store.close(); }
}, 60000);
test("LOW-1: queue reconsider reports tasks started before a before_send refusal and stops; the refused task is not re-reserved", async () => {
	const f = await fixture("low1-queue", 4, resolve(import.meta.dir, "../src/placement-preflight.ts"));
	try {
		const ids = ["i-ok", "i-refused"].map(key => f.store.submit({ ...f.task.input, key }).id);
		for (const id of ids) f.store.reserve(id, { samples: new Map() });
		expect(ids.map(id => f.store.task(id)!.phase)).toEqual(["queued", "queued"]);
		let n = 0;
		const out = await reconsiderQueue(new Fleet(f.store), async () => {
			if (n++ === 1) await f.setMode({ reply: { action: "prepare", stdout: JSON.stringify({ ok: false, error: "root_denied", detail: "allowlist", certainty: "before_send" }), exit: 1 } });
			return f.resources.samples;
		}, { limit: 10 });
		expect(out.map(t => [t.input.key, t.phase, t.held])).toEqual([["i-ok", "active", true], ["i-refused", "dispatching", true]]);
		await f.setMode({});
		const attemptBefore = f.store.task(ids[1]!)!.attemptId;
		expect(await reconsiderQueue(new Fleet(f.store), async () => f.resources.samples, { limit: 10 })).toHaveLength(0);
		expect(f.store.task(ids[1]!)!.attemptId).toBe(attemptBefore);
		const heldBefore = [...f.store.heldCharges().values()].flat().length;
		expect((await new Fleet(f.store).start(ids[1]!)).workspace).toBeDefined();
		expect([...f.store.heldCharges().values()].flat()).toHaveLength(heldBefore);
		expect(f.store.events(ids[1]!).filter(e => e.kind === "reserved")).toHaveLength(1);
	} finally { f.store.close(); }
}, 60000);
