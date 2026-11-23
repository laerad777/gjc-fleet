import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, observationDigest } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { prepareWorkspace, run } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

// Fleet.result → node collect → store, with the result-store switch OFF and ON: a
// workspace holding nested repositories (a `.git` directory, a `.git` file naming a
// Git directory outside whose HEAD is a FIFO, a bare repository) is collected without
// following any of them, stored and read back identically in both forms, and stays an
// unverified completion (never success by itself) until its incomplete export is accepted.

const pass = [process.execPath, "--eval", "console.log('pass')"];
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const bounded = <T>(promise: Promise<T>, ms = 60_000) =>
	Promise.race([promise, Bun.sleep(ms).then(() => { throw new Error("collection_blocked"); })]);
const sh = async (argv: string[], cwd: string) => {
	const r = await run(argv, cwd);
	if (r.exit !== 0) throw new Error("fixture failed: " + r.stderr);
};

for (const mode of ["off", "on"] as const)
	describe(`collection with the result store ${mode}`, () => {
		test("plain and nested-repository workspaces store, reload and gate identically", async () => {
			const f = await repositoryFixture("fleet-collection-store-");
			directories.push(f.dir);
			const db = join(f.dir, "fleet.sqlite");
			let store = new FleetStore(db, 4);
			if (mode === "on") store.enableResultStore({ actor: "test", reason: "collection with the result store on" });
			const transport = { command: process.execPath, args: [] };
			store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport, sdkTransport: transport });
			let fleet = new Fleet(store, { localNodeId: "local" });
			const settled = async (key: string) => {
				const task = store.reserve(store.submit({ schemaVersion: 1 as const, key, caller: "controlled", repoId: "repo", baseCommit: f.baseCommit, prompt: key, required: {} }).id);
				const identity = await prepareWorkspace({ taskId: task.id, attemptId: task.attemptId!, nodeId: "local", inputDigest: task.inputDigest, repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
				store.setWorkspace(task.id, identity as any);
				const sessionId = "session-" + key;
				const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
				store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
				store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
				store.recordTurn(task.id, "turn-" + key);
				const body = { sessionId, turnId: "turn-" + key, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
				store.observe(task.id, { ...body, eventId: "settle-" + key, digest: observationDigest(body) });
				return { id: task.id, path: identity.path };
			};

			const plain = await settled("plain");
			await writeFile(join(plain.path, "tracked.txt"), "changed\n");
			await writeFile(join(plain.path, "d.txt"), "d");
			const plainManifest: any = await bounded(fleet.result(plain.id, pass));
			expect({ status: plainManifest.status, exportComplete: plainManifest.exportComplete, phase: store.task(plain.id)!.phase }).toEqual({ status: "verified", exportComplete: true, phase: "succeeded" });
			expect(plainManifest.files.map((file: any) => file.path)).toEqual(["d.txt", "tracked.txt"]);

			const nested = await settled("nested");
			await mkdir(join(nested.path, "fx"));
			await sh(["git", "init", "-q", join(nested.path, "fx")], f.dir);
			await writeFile(join(nested.path, "fx", "inner.txt"), "INNER_SECRET");
			const outside = join(f.dir, "outside-gitdir");
			await mkdir(join(outside, "objects"), { recursive: true });
			await mkdir(join(outside, "refs"), { recursive: true });
			if (process.platform !== "win32") await sh(["mkfifo", join(outside, "HEAD")], f.dir);
			await mkdir(join(nested.path, "linked"));
			await writeFile(join(nested.path, "linked", ".git"), "gitdir: " + outside + "\n");
			await writeFile(join(nested.path, "linked", "l.txt"), "LINKED_SECRET");
			await sh(["git", "init", "-q", "--bare", join(nested.path, "mirror.git")], f.dir);
			await writeFile(join(nested.path, "d.txt"), "d");
			const manifest: any = await bounded(fleet.result(nested.id, pass));
			// Collected and tested is not success: the incomplete export awaits review.
			expect({ status: manifest.status, exportComplete: manifest.exportComplete, phase: store.task(nested.id)!.phase }).toEqual({ status: "verified", exportComplete: false, phase: "completed_unverified" });
			expect(manifest.exclusions.map((entry: any) => [entry.path, entry.reason])).toEqual([
				["fx", "nested_repository"],
				["linked", "nested_repository"],
				["mirror.git", "nested_repository"],
			]);
			expect(manifest.files.map((file: any) => file.path)).toEqual(["d.txt"]);
			expect(JSON.stringify(manifest)).not.toContain("_SECRET");
			const reviewDigest = fleet.exportReview(nested.id).reviewDigest!;
			expect(reviewDigest).toMatch(/^[0-9a-f]{64}$/);
			const before = { plain: digest(await fleet.result(plain.id)), nested: digest(await fleet.result(nested.id)) };

			// The stored form follows the switch; the result read back does not.
			store.close();
			const raw = new Database(db, { readonly: true });
			for (const id of [plain.id, nested.id]) {
				const data = JSON.parse((raw.query("SELECT data FROM tasks WHERE id=?").get(id) as any).data);
				expect({ inline: Object.hasOwn(data, "resultManifest"), external: Object.hasOwn(data, "resultExternal") }).toEqual(mode === "on" ? { inline: false, external: true } : { inline: true, external: false });
			}
			raw.close();
			store = new FleetStore(db, 4);
			fleet = new Fleet(store, { localNodeId: "local" });
			expect({ plain: digest(await fleet.result(plain.id)), nested: digest(await fleet.result(nested.id)) }).toEqual(before);
			expect(store.task(nested.id)!.phase).toBe("completed_unverified");

			fleet.acceptIncompleteExport(nested.id, { operator: "ops", reviewDigest });
			expect(store.task(nested.id)!.phase).toBe("succeeded");
			expect(digest(await fleet.result(nested.id))).toBe(before.nested);
			store.close();
		}, 180_000);
	});
