import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskRecord } from "../src/contracts";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";

// Real FleetStore + real Fleet query through a recorded SDK transport script.
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const WORKSPACE = "/owned/task-original-attempt-original";
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-archive-shapes-")), path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 2), db = new Database(path);
	cleanup.push(() => { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
	const response = join(dir, "response.json"), script = join(dir, "sdk.ts");
	writeFileSync(script, `if(process.env.GJC_SDK_BROKER_AUTOSTART!=="0"||JSON.stringify(process.argv.slice(2))!==JSON.stringify(["sdk","session","list","--scope","all","--json"]))process.exit(9);console.log(await Bun.file(${JSON.stringify(response)}).text());`);
	const node: any = { id: "node", sdkTransport: { command: process.execPath, args: [script] } };
	const task: TaskRecord = { id: "task-original", input: { schemaVersion: 1, key: "key", caller: "test", repoId: "repo", baseCommit: "a".repeat(40), prompt: "archive shapes", required: {} }, inputDigest: "digest", nodeId: "node", nodeSnapshot: node, attemptId: "attempt-original", sessionId: "session-original", phase: "blocked_unknown", held: true, reason: "original unknown", workspace: { path: WORKSPACE } } as TaskRecord;
	db.query("INSERT INTO nodes VALUES (?,?)").run(node.id, JSON.stringify(node));
	db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(task.id, "test", "key", "digest", JSON.stringify(task));
	db.query("INSERT INTO operations VALUES (?,?,?,?,?)").run("op", task.id, task.attemptId!, "create", JSON.stringify({ id: "op", kind: "create", payload: {} }));
	const list: any = { ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" }, warnings: [], sessions: [] } };
	const fleet = new Fleet(store);
	return { store, task, list, archive: (sessions: unknown[]) => { list.result.sessions = sessions; writeFileSync(response, JSON.stringify(list)); return fleet.archive(task.id, {}, "tester"); } };
}
// Shape observed in production for sessions started outside a git worktree.
const outsideWorktree = (i: number, live: boolean) => ({ sessionId: `foreign-${i}`, live, locator: { cwd: "/Users/x/.someapp/workspace", worktreeRoot: null, stateRoot: `/Users/x/.someapp/state/${i}` }, cwd: null });
const worktreeSession = (i: number, live: boolean) => ({ sessionId: `wt-${i}`, live, locator: { cwd: `/Users/x/repos/r${i}`, worktreeRoot: `/Users/x/repos/r${i}`, stateRoot: `/Users/x/.gjc/state/${i}` }, cwd: `/Users/x/repos/r${i}` });

test("production listing with null worktreeRoot/top-level cwd archives when no live session matches", async () => {
	const f = fixture();
	const sessions = [
		...Array.from({ length: 107 }, (_, i) => outsideWorktree(i, false)),
		...Array.from({ length: 3 }, (_, i) => outsideWorktree(1000 + i, true)),
		...Array.from({ length: 197 }, (_, i) => worktreeSession(i, i % 50 === 0)),
	];
	expect(sessions).toHaveLength(307);
	const archived = await f.archive(sessions);
	expect(archived.phase).toBe("archived");
	expect(archived.held).toBe(false);
});
test("absent worktreeRoot/stateRoot/top-level cwd is treated as not provided", async () => {
	const f = fixture();
	expect((await f.archive([{ sessionId: "foreign", live: true, locator: { cwd: "/Users/x/.someapp/workspace" } }])).phase).toBe("archived");
});
test("non-live entry without any path can never be a live owner", async () => {
	const f = fixture();
	expect((await f.archive([
		{ sessionId: "dead-a", live: false, locator: { cwd: null, worktreeRoot: null, stateRoot: null }, cwd: null },
		{ sessionId: "dead-b", live: false, locator: {} },
		{ sessionId: "dead-c", live: false },
		{ sessionId: "session-original", live: false, locator: { cwd: null, worktreeRoot: null } },
	])).phase).toBe("archived");
});
const blocking: Record<string, any> = {
	"locator.cwd inside workspace, worktreeRoot null": { sessionId: "other", live: true, locator: { cwd: `${WORKSPACE}/sub/dir`, worktreeRoot: null, stateRoot: "/Users/x/.someapp/state" }, cwd: null },
	"locator.cwd equal workspace, worktreeRoot null": { sessionId: "other", live: true, locator: { cwd: WORKSPACE, worktreeRoot: null }, cwd: null },
	"locator.cwd only (other fields absent)": { sessionId: "other", live: true, locator: { cwd: `${WORKSPACE}/x` } },
	"stateRoot only": { sessionId: "other", live: true, locator: { cwd: null, worktreeRoot: null, stateRoot: "/state/task-original/s" }, cwd: null },
	"top-level cwd only": { sessionId: "other", live: true, locator: { cwd: null, worktreeRoot: null }, cwd: "/elsewhere/attempt-original" },
	"session id with null paths": { sessionId: "session-original", live: true, locator: { cwd: null, worktreeRoot: null }, cwd: null },
	"task id with null paths": { sessionId: "other", taskId: "task-original", live: true, locator: { cwd: "/Users/x", worktreeRoot: null } },
	"attempt id with null paths": { sessionId: "other", attemptId: "attempt-original", live: true, locator: { cwd: "/Users/x", worktreeRoot: null } },
};
for (const [name, session] of Object.entries(blocking)) test(`live session matched by ${name} still blocks`, async () => {
	const f = fixture();
	await expect(f.archive([outsideWorktree(1, true), session])).rejects.toThrow("Original task or attempt session is still live");
	expect(f.store.task(f.task.id)?.phase).toBe("blocked_unknown");
	expect(f.store.task(f.task.id)?.held).toBe(true);
});
const pathless: Record<string, any> = {
	"all paths null": { sessionId: "other", live: true, locator: { cwd: null, worktreeRoot: null, stateRoot: null }, cwd: null },
	"empty locator": { sessionId: "other", live: true, locator: {} },
	"locator absent": { sessionId: "other", live: true },
	"locator null": { sessionId: "other", live: true, locator: null },
	"only unrecognised locator keys": { sessionId: "other", live: true, locator: { endpoint: 4 } },
};
for (const [name, session] of Object.entries(pathless)) test(`live session without any locating path refuses (${name})`, async () => {
	const f = fixture();
	await expect(f.archive([outsideWorktree(1, false), session])).rejects.toThrow("Live session without any locating path cannot be proven unrelated");
	expect(f.store.task(f.task.id)?.held).toBe(true);
});
const malformed: Record<string, any> = {
	"null entry": null,
	"string entry": "session",
	"array entry": [],
	"missing sessionId": { live: false, locator: { cwd: "/a", worktreeRoot: null } },
	"empty sessionId": { sessionId: "", live: false, locator: { cwd: "/a" } },
	"numeric sessionId": { sessionId: 7, live: false, locator: { cwd: "/a" } },
	"missing live": { sessionId: "s", locator: { cwd: "/a", worktreeRoot: null } },
	"string live": { sessionId: "s", live: "false", locator: { cwd: "/a" } },
	"null live": { sessionId: "s", live: null, locator: { cwd: "/a" } },
	"string locator": { sessionId: "s", live: false, locator: "/a" },
	"array locator": { sessionId: "s", live: false, locator: ["/a"] },
	"numeric worktreeRoot": { sessionId: "s", live: false, locator: { cwd: "/a", worktreeRoot: 0 } },
	"boolean worktreeRoot": { sessionId: "s", live: false, locator: { cwd: "/a", worktreeRoot: false } },
	"object locator.cwd": { sessionId: "s", live: false, locator: { cwd: { path: "/a" }, worktreeRoot: null } },
	"numeric stateRoot": { sessionId: "s", live: false, locator: { cwd: "/a", stateRoot: 1 } },
	"array top-level cwd": { sessionId: "s", live: false, locator: { cwd: "/a" }, cwd: ["/a"] },
	"empty-string locator.cwd": { sessionId: "s", live: false, locator: { cwd: "", worktreeRoot: null } },
	"empty-string top-level cwd": { sessionId: "s", live: false, locator: { cwd: "/a" }, cwd: "" },
};
for (const [name, session] of Object.entries(malformed)) test(`malformed session entry refuses (${name})`, async () => {
	const f = fixture();
	await expect(f.archive([outsideWorktree(1, false), session])).rejects.toThrow("Incomplete session identity or liveness");
	expect(f.store.task(f.task.id)?.held).toBe(true);
});
