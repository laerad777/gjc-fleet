import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cli } from "../src/cli";
import { digest, nodeObservationTimeoutMs, nodeRpcTimeoutMs, validateNode } from "../src/core";
import { failureDiagnostic } from "../src/diagnostic";
import { Fleet } from "../src/fleet";
import { StdioRpc, TransportError } from "../src/rpc";
import { FleetStore } from "../src/store";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

// CONTROLLED stdio peers and the CONTROLLED fixture Coordinator only (not GJC).
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const READ = "gjc_coordinator_read_turn";
const LIST = "gjc_coordinator_list_questions";
const SEND = "gjc_coordinator_send_prompt";

/** A peer that answers each tools/call after DELAY[name] ms (default 0) without serialising requests;
 * every reply carries `seen`, the number of requests the peer had received when it answered. */
function peer(delays: Record<string, number>, effectMs: number, observationMs: number) {
	const code = `const d=${JSON.stringify(delays)};let seen=0;let b='';for await(const p of Bun.stdin.stream()){b+=new TextDecoder().decode(p);let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(r.id===undefined)continue;seen++;const name=r.params?.name;setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{structuredContent:{name,seen}}})+'\\n'),d[name]??0);}}`;
	const rpc = new StdioRpc(process.execPath, ["--eval", code], effectMs, observationMs);
	cleanups.push(() => rpc.close());
	return rpc;
}
const node = (patch: Record<string, unknown> = {}) => ({
	id: "n1", os: "win32", arch: "x64", roots: {}, workspaceRoot: "C:\\work", enabled: true, draining: false, reachable: true,
	sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: "gjc", args: [] }, ...patch,
}) as any;

test("read_turn and list_questions are bounded by the observation limit, every other call by the transport limit", async () => {
	const rpc = peer({ [READ]: 400, [LIST]: 400, [SEND]: 400 }, 150, 2_000);
	expect(await rpc.call(READ, {})).toMatchObject({ name: READ });
	expect(await rpc.call(LIST, {})).toMatchObject({ name: LIST });
	const error = await rpc.call(SEND, {}).then(() => undefined, (e) => e);
	expect(error).toBeInstanceOf(TransportError);
	expect(error).toMatchObject({ code: "transport_timeout", certainty: "unknown", timeoutMs: 150 });
});

test("an observation read past its own limit is unknown and its diagnostic records that limit", async () => {
	const rpc = peer({ [READ]: 1_500 }, 5_000, 300);
	const started = performance.now();
	const error = await rpc.call(READ, {}).then(() => undefined, (e) => e);
	// Loaded hosts: peer spawn and timer scheduling add slack. The bound stays under the 5000 ms transport
	// limit, so a call bounded by the wrong limit still fails here.
	expect(performance.now() - started).toBeLessThan(4_000);
	expect(error).toMatchObject({ code: "transport_timeout", certainty: "unknown", timeoutMs: 300 });
	expect(failureDiagnostic(error, { source: "Fleet.inspect.read_turn", phase: "call" })).toMatchObject({
		errorClass: "TransportError", code: "transport:transport_timeout", timeoutMs: 300,
	});
});

// Review F-3: one expiry fails the whole connection, so mixed limits must never be pending together.
test("a request with another limit than a pending one is refused before send and cannot shorten the pending call", async () => {
	const rpc = peer({ [SEND]: 700 }, 5_000, 300);
	const effect = rpc.call(SEND, {});
	const read = await rpc.call(READ, {}).then(() => undefined, (e) => e);
	expect(read).toBeInstanceOf(TransportError);
	expect(read).toMatchObject({ code: "too_many_requests", certainty: "before_send" });
	// The effect is answered after 700 ms (> the 300 ms read limit) and the peer never received the read.
	expect(await effect).toEqual({ name: SEND, seen: 1 });
	const reverse = peer({ [READ]: 700 }, 300, 5_000);
	const pendingRead = reverse.call(READ, {});
	expect(await reverse.call(SEND, {}).then(() => undefined, (e) => e)).toMatchObject({ code: "too_many_requests", certainty: "before_send" });
	expect(await pendingRead).toEqual({ name: READ, seen: 1 });
});

test("requests with the same limit still overlap on one connection", async () => {
	const rpc = peer({ [READ]: 300 }, 5_000, 2_000);
	const both = await Promise.all([rpc.call(READ, {}), rpc.call(LIST, {})]);
	expect(both.map((reply) => reply.name)).toEqual([READ, LIST]);
});

test("the observation limit follows the node's transport limit and the OS floor", () => {
	expect(nodeObservationTimeoutMs(node())).toBe(180_000);
	expect(nodeRpcTimeoutMs(node())).toBe(120_000);
	expect(nodeObservationTimeoutMs(node({ os: "linux" }))).toBe(30_000);
	expect(nodeObservationTimeoutMs(node({ os: "darwin", transport: { command: "gjc", args: [], timeoutMs: 5_000 } }))).toBe(30_000);
	expect(nodeObservationTimeoutMs(node({ transport: { command: "gjc", args: [], timeoutMs: 60_000 } }))).toBe(180_000);
	expect(nodeObservationTimeoutMs(node({ transport: { command: "gjc", args: [], timeoutMs: 300_000 } }))).toBe(300_000);
	expect(nodeObservationTimeoutMs(node({ os: "linux", transport: { command: "gjc", args: [], timeoutMs: 600_000 } }))).toBe(600_000);
});

// Review F-1 / O-2: the limit is derived, so the node identity the placement probe compares is unchanged.
test("the observation limit needs no node-config key: a separate deadline key is refused and the stored row is unchanged", async () => {
	expect(() => validateNode(node({ callDeadlines: { observationMs: 180_000 } }))).toThrow("Unexpected field");
	const repo = await repositoryFixture("fleet-observation-identity-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	const plain = node({ workspaceRoot: repo.workspaceRoot });
	store.putNode(plain);
	const [stored] = store.nodes();
	expect(stored).toEqual(plain);
	expect(digest(stored!)).toBe(digest(plain));
	expect(nodeObservationTimeoutMs(stored!)).toBe(180_000);
});

// Review F-2: no limit of any call kind can be configured below 5000 ms.
test("neither limit can be configured below 5000 ms", () => {
	expect(() => validateNode(node({ callDeadlines: { effectMs: 1 } }))).toThrow("Unexpected field");
	for (const value of [1, 4_999]) expect(() => validateNode(node({ transport: { command: "gjc", args: [], timeoutMs: value } }))).toThrow("transport.timeoutMs");
	const lowest = node({ os: "linux", transport: { command: "gjc", args: [], timeoutMs: 5_000 } });
	validateNode(lowest);
	expect(nodeRpcTimeoutMs(lowest)).toBe(5_000);
	expect(nodeObservationTimeoutMs(lowest)).toBeGreaterThanOrEqual(5_000);
});

// Review F-4: a stored row carrying a foreign deadline value (e.g. written by the previous round) still lists.
test("node list keeps listing a stored row that carries a foreign out-of-range deadline field", async () => {
	const repo = await repositoryFixture("fleet-observation-foreign-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const path = join(repo.dir, "fleet.sqlite");
	const store = new FleetStore(path);
	store.putNode(node({ workspaceRoot: repo.workspaceRoot }));
	store.close();
	const db = new Database(path);
	const row = db.query<{ data: string }, []>("SELECT data FROM nodes").get()!;
	db.query("UPDATE nodes SET data=?").run(JSON.stringify({ ...JSON.parse(row.data), callDeadlines: { observationMs: 0, effectMs: 300_001 } }));
	db.close();
	const printed: string[] = [];
	const log = spyOn(console, "log").mockImplementation((text: string) => { printed.push(text); });
	try {
		for (const mode of [[], ["--read-only", "--cap", "2"]]) {
			printed.length = 0;
			expect(await cli(["--db", path, ...mode, "node", "list"])).toBe(0);
			const listed = JSON.parse(printed.join("\n"));
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ id: "n1", callDeadlines: { observationMs: 0, effectMs: 300_001 }, effectiveRpcTimeoutMs: 120_000 });
		}
	} finally {
		log.mockRestore();
	}
});

test("a Fleet strict poll whose reads outlast the node's transport limit is applied, not held unknown", async () => {
	const repo = await repositoryFixture("fleet-observation-deadline-");
	cleanups.push(() => rm(repo.dir, { recursive: true, force: true }));
	const store = new FleetStore(join(repo.dir, "fleet.sqlite"));
	cleanups.push(() => store.close());
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	store.putNode({
		id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state], timeoutMs: 5_000 },
	});
	const fleet = new Fleet(store, { localNodeId: "local" });
	const started = await fleet.start(fleet.submit({ schemaVersion: 1, key: "slow-observation", caller: "controlled",
		repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled running turn", required: {} }).id);
	expect(started).toMatchObject({ phase: "active", held: true });
	const reads = async () => (JSON.parse(await readFile(state, "utf8")) as ControlledState).calls.filter((call) => /read_turn|list_questions/.test(call.name)).length;
	const issued = await reads();
	const current: ControlledState = JSON.parse(await readFile(state, "utf8"));
	await writeFile(state, JSON.stringify({ ...current, readDelayMs: 5_600 }));
	const before = performance.now();
	const { task } = await fleet.inspect(started.id);
	// read_turn and list_questions each answered after 5.6 s, past the 5 s transport limit, and were applied.
	expect(performance.now() - before).toBeGreaterThanOrEqual(11_000);
	expect(task).toMatchObject({ phase: "active", held: true });
	expect(task.pollApplied).toBe(task.pollIssued);
	expect(store.events(started.id).some((event) => event.kind === "unknown")).toBe(false);
	expect(await reads()).toBe(issued + 2);
}, 60_000);
