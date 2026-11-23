import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { prepareWorkspace } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 60_000);

async function settledFixture(key: string) {
	const f = await repositoryFixture("fleet-selected-cache-");
	cleanups.push(async () => { await rm(f.dir, { recursive: true, force: true }); });
	const db = join(f.dir, "fleet.sqlite");
	let store = new FleetStore(db);
	let fleet = new Fleet(store, { localNodeId: "local" });
	cleanups.push(async () => { try { await fleet.close(); } finally { store.close(); } });
	const transport = { command: process.execPath, args: [] };
	store.putNode({
		id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: ["model"], operations: ["write"], transport, sdkTransport: transport,
	});
	const task = store.reserve(store.submit({
		schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: f.baseCommit, prompt: key, required: {},
	}).id);
	const identity = await prepareWorkspace({
		taskId: task.id, attemptId: task.attemptId!, nodeId: "local", inputDigest: task.inputDigest,
		repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot,
	});
	store.setWorkspace(task.id, identity as any);
	const sessionId = "session-" + key;
	const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
	store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
	store.recordSessionAuthority(task.id, {
		sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64),
	});
	const turnId = "turn-" + key;
	store.recordTurn(task.id, turnId);
	const body = { sessionId, turnId, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(task.id, { ...body, eventId: "settled-" + key, digest: observationDigest(body) });
	await writeFile(join(identity.path, "answer.txt"), "selected result\n");
	await writeFile(join(identity.path, "notes.txt"), "ordinary unselected note\n");

	return {
		task,
		get fleet() { return fleet; },
		get store() { return store; },
		async reopen() {
			await fleet.close();
			store.close();
			store = new FleetStore(db);
			fleet = new Fleet(store, { localNodeId: "local" });
		},
	};
}

test("selected custody persists its exact request and immutable manifest across reopen", async () => {
	const f = await settledFixture("selected");
	const paths = ["answer.txt"];
	const manifest = await f.fleet.result(f.task.id, undefined, paths);
	const manifestDigest = digest(manifest);
	const custody = { kind: "selected" as const, paths, selectionDigest: digest(paths) };
	expect(manifest.custody).toEqual(custody);
	expect(manifest.files.map((file) => file.path)).toEqual(paths);
	await f.reopen();
	expect(f.store.task(f.task.id)?.resultCustodyRequest).toEqual({ attemptId: f.task.attemptId!, paths });
	expect(digest(await f.fleet.result(f.task.id, undefined, paths))).toBe(manifestDigest);
	await expect(f.fleet.result(f.task.id)).rejects.toMatchObject({ code: "RESULT_CONFLICT" });
	await expect(f.fleet.result(f.task.id, undefined, ["notes.txt"])).rejects.toMatchObject({ code: "RESULT_CONFLICT" });
	expect(digest(await f.fleet.result(f.task.id, undefined, paths))).toBe(manifestDigest);
}, 120_000);

test("legacy collection remains full and a selected request never replaces its stored manifest", async () => {
	const f = await settledFixture("full");
	const full = await f.fleet.result(f.task.id);
	expect(full.custody).toBeUndefined();
	expect(full.files.map((file) => file.path)).toEqual(["answer.txt", "notes.txt"]);
	await f.reopen();
	await expect(f.fleet.result(f.task.id, undefined, ["answer.txt"])).rejects.toMatchObject({ code: "RESULT_CONFLICT" });
	expect(await f.fleet.result(f.task.id)).toEqual(full);
	expect(f.store.task(f.task.id)?.resultCustodyRequest).toBeUndefined();
}, 120_000);
