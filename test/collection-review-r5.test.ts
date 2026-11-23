import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cp, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationDigest } from "../src/core";
import { Fleet, validateResult } from "../src/fleet";
import { FleetStore } from "../src/store";
import { checkScanLimits, collectResult, deepBoundaries, legacyManifest, prepareWorkspace, run, scanWorkspace, verifyScan, WORKSPACE_SCAN_LIMITS } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

// Review fx-397df5a5 findings (round r5).

const pass = [process.execPath, "--eval", "console.log('pass')"];
const directories: string[] = [];
afterEach(async () => {
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
}, 120_000);
const sh = async (argv: string[], cwd: string, timeoutMs = 30_000) => {
	// When cwd is `/` (fixture helpers), do not default untrusted to `[/]` or PATH resolves nothing.
	const untrusted = cwd === "/" ? [] : [cwd];
	const r = await run(argv, cwd, 4 * 1024 * 1024, undefined, timeoutMs, undefined, undefined, untrusted);
	if (r.exit !== 0) {
		const stderr = r.stderr.trim();
		throw new Error(`fixture failed: exit=${r.exit}` + (stderr ? ` stderr=${stderr}` : " stderr=<empty>"));
	}
};

/** Prefer a working interpreter: macOS `/usr/bin/python3` can hang (Xcode stub). */
async function fixturePython(): Promise<string> {
	const forced = process.env.FLEET_TEST_PYTHON3?.trim();
	const candidates = [
		...(forced ? [forced] : []),
		"python3.14",
		"python3.13",
		"python3.12",
		"python3.11",
		"python3",
	];
	const seen = new Set<string>();
	for (const name of candidates) {
		const resolved = name.includes("/") || name.includes("\\") ? name : Bun.which(name);
		if (!resolved || seen.has(resolved)) continue;
		seen.add(resolved);
		try {
			await sh([resolved, "-c", "print(1)"], "/", 3_000);
			return resolved;
		} catch {
			// Try the next candidate (stub/hang/missing).
		}
	}
	throw new Error("fixture failed: no working python3 (set FLEET_TEST_PYTHON3)");
}

// ---- F1: acceptance never rewrites task.resultManifest ----------------------

/** A hub store with one local node, and settled tasks whose workspaces Fleet prepared. */
async function hub(prefix: string) {
	const f = await repositoryFixture(prefix);
	directories.push(f.dir);
	const db = join(f.dir, "fleet.sqlite");
	const store = new FleetStore(db, 8);
	const transport = { command: process.execPath, args: [] };
	store.putNode({ id: "local", os: process.platform, arch: process.arch, roots: { repo: f.repo }, workspaceRoot: f.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport, sdkTransport: transport });
	const fleet = new Fleet(store, { localNodeId: "local" });
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
	/** Passing commands at first collection over a nested repository: the result is held for review. */
	const pending = async (key: string) => {
		const task = await settled(key);
		await mkdir(join(task.path, "fx"));
		await sh(["git", "init", "-q", join(task.path, "fx")], f.dir);
		await writeFile(join(task.path, "d.txt"), "d");
		const manifest: any = await fleet.result(task.id, pass);
		expect({ status: manifest.status, exportComplete: manifest.exportComplete, phase: store.task(task.id)!.phase }).toEqual({ status: "verified", exportComplete: false, phase: "completed_unverified" });
		return task.id;
	};
	/** The row's stored result form, exactly as in the database (inline manifest or external reference). */
	const storedForm = (id: string) => {
		const raw = new Database(db, { readonly: true });
		try {
			const data = JSON.parse((raw.query("SELECT data FROM tasks WHERE id=?").get(id) as any).data);
			return { resultManifest: data.resultManifest ?? null, resultExternal: data.resultExternal ?? null };
		} finally {
			raw.close();
		}
	};
	const userVersion = () => {
		const raw = new Database(db, { readonly: true });
		try {
			return (raw.query("PRAGMA user_version").get() as any).user_version as number;
		} finally {
			raw.close();
		}
	};
	/** Every file in the result blob store (absent directory: none). */
	const blobs = async () => {
		try {
			return ((await readdir(db + ".results", { recursive: true, withFileTypes: true })) as any[])
				.filter((entry) => entry.isFile())
				.map((entry) => join(entry.parentPath ?? entry.path, entry.name))
				.sort();
		} catch (error: any) {
			if (error?.code === "ENOENT") return [];
			throw error;
		}
	};
	/** Accept the pending review and prove nothing about the stored result changed. */
	const acceptUnchanged = async (id: string) => {
		const form = storedForm(id);
		const inventory = await blobs();
		const version = userVersion();
		const reviewDigest = fleet.exportReview(id).reviewDigest!;
		fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest });
		expect(store.task(id)).toMatchObject({ phase: "succeeded", result: { verified: true } });
		expect(storedForm(id)).toEqual(form);
		expect(await blobs()).toEqual(inventory);
		expect(userVersion()).toBe(version);
		// The accepted result still reads back verified, with its passing command, and accepting again is idempotent.
		const read: any = await fleet.result(id);
		expect({ status: read.status, tests: read.tests.length }).toEqual({ status: "verified", tests: 1 });
		fleet.acceptIncompleteExport(id, { operator: "ops", reviewDigest });
		expect(storedForm(id)).toEqual(form);
		return form;
	};
	return { f, db, store, fleet, settled, pending, storedForm, userVersion, blobs, acceptUnchanged };
}

describe("F1: acceptance keeps the held result's stored form in every result-store state", () => {
	test("switch off and never stepped (user_version 2): the inline row is unchanged", async () => {
		const h = await hub("fleet-r5-f1-v2-");
		const id = await h.pending("v2-off");
		expect(h.userVersion()).toBe(2);
		const form = await h.acceptUnchanged(id);
		expect({ inline: form.resultManifest !== null, external: form.resultExternal !== null }).toEqual({ inline: true, external: false });
		expect(h.userVersion()).toBe(2);
		h.store.close();
	}, 180_000);

	test("switch on (user_version 3): the externalised row keeps its reference and no blob is written", async () => {
		const h = await hub("fleet-r5-f1-v3-on-");
		h.store.enableResultStore({ actor: "test", reason: "F1 switch on" });
		const id = await h.pending("v3-on");
		expect(h.userVersion()).toBe(3);
		const form = await h.acceptUnchanged(id);
		expect({ inline: form.resultManifest !== null, external: form.resultExternal !== null }).toEqual({ inline: false, external: true });
		h.store.close();
	}, 180_000);

	test("production shape (user_version 3, switch off, one externalised row): inline and externalised pending rows are accepted unchanged", async () => {
		const h = await hub("fleet-r5-f1-v3-off-");
		h.store.enableResultStore({ actor: "test", reason: "F1 production shape" });
		// Collected while the switch was on: externalised, held for review.
		const external = await h.pending("v3-off-external");
		h.store.disableResultStore({ actor: "test", reason: "F1 production shape" });
		expect(h.store.resultStoreStatus()).toMatchObject({ externalisation: "off", userVersion: 3, oneWayStepTaken: true, externalResults: 1 });
		// Collected after the switch went off: inline on the fenced store.
		const inline = await h.pending("v3-off-inline");
		const inlineForm = await h.acceptUnchanged(inline);
		expect({ inline: inlineForm.resultManifest !== null, external: inlineForm.resultExternal !== null }).toEqual({ inline: true, external: false });
		const externalForm = await h.acceptUnchanged(external);
		expect({ inline: externalForm.resultManifest !== null, external: externalForm.resultExternal !== null }).toEqual({ inline: false, external: true });
		expect(h.store.resultStoreStatus()).toMatchObject({ externalisation: "off", userVersion: 3, externalResults: 1 });
		// Reopened: both still read back verified.
		h.store.close();
		const store = new FleetStore(h.db, 8);
		const fleet = new Fleet(store, { localNodeId: "local" });
		for (const id of [inline, external]) expect(((await fleet.result(id)) as any).status).toBe("verified");
		store.close();
	}, 240_000);
});

// ---- F2-F8: collection ---------------------------------------------------------

const posix = process.platform !== "win32";
async function preparedWorkspace(prefix: string) {
	const f = await repositoryFixture(prefix);
	directories.push(f.dir);
	const identity = await prepareWorkspace({ taskId: "task-" + prefix, attemptId: "attempt", nodeId: "node", inputDigest: "a".repeat(64), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: f.workspaceRoot });
	return { f, identity };
}
const exported = (manifest: any) => manifest.files.map((file: any) => file.path).sort();
async function scratch(prefix: string) {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	directories.push(root);
	return root;
}

describe.if(posix)("F2: a FIFO rule file Git never opens does not refuse the collection", () => {
	test("FIFO .gitignore/.gitattributes below an in-tree-ignored directory collect; one Git opens still refuses", async () => {
		const { identity } = await preparedWorkspace("fleet-r5-f2-");
		await writeFile(join(identity.path, ".gitignore"), "build/\n");
		await writeFile(join(identity.path, "ok.txt"), "ok");
		await mkdir(join(identity.path, "build", "x"), { recursive: true });
		await sh(["mkfifo", join(identity.path, "build", "x", ".gitignore")], "/");
		await sh(["mkfifo", join(identity.path, "build", ".gitattributes")], "/");
		const manifest = await collectResult(identity, []);
		expect({ files: exported(manifest), exportComplete: manifest.exportComplete }).toEqual({ files: [".gitignore", "ok.txt"], exportComplete: true });
		// The same FIFO in a directory Git enters is refused before any traversing Git command.
		await mkdir(join(identity.path, "src"));
		await sh(["mkfifo", join(identity.path, "src", ".gitignore")], "/");
		await expect(collectResult(identity, [])).rejects.toThrow(/^unsafe_result_entry:special_file$/);
	}, 120_000);
});

describe("F3: a path the walk cannot list below an ignored directory is withheld, not refused", () => {
	test("deepBoundaries withholds the outermost ignored directory holding no base-tree entry; elsewhere it refuses", () => {
		const none = () => 0;
		const tracked = (path: string) => (path === "build" ? 1 : 0);
		const scan = (unreadable: string[], unwalked: string[] = []) => ({ unreadable, unwalked });
		expect(deepBoundaries(scan(["deps/a/b/c", "deps/z"]), ["deps/"], none)).toEqual(["deps"]);
		// `build/` holds a base-tree entry: Git enters it, so the boundary is the ignored directory below it.
		expect(deepBoundaries(scan(["build/x/y"]), ["build/"], tracked)).toEqual(["build/x"]);
		expect(() => deepBoundaries(scan(["src/deep"]), ["deps/"], none)).toThrow(/^workspace_scan_unreadable$/);
		// A file root is not a directory Git skips.
		expect(() => deepBoundaries(scan(["deps/a"]), ["deps"], none)).toThrow(/^workspace_scan_unreadable$/);
		expect(() => deepBoundaries(scan([], ["src/deep"]), ["deps/"], none)).toThrow(/^workspace_scan_limit$/);
	});
	test.if(posix)("an ignored chain longer than PATH_MAX collects with that directory as one boundary (export incomplete)", async () => {
		const { identity } = await preparedWorkspace("fleet-r5-f3-");
		await writeFile(join(identity.path, ".gitignore"), "deps/\n");
		await writeFile(join(identity.path, "d.txt"), "deliverable");
		// Past PATH_MAX with the fewest mkdir levels for this host (on macOS `/usr/bin/python3`
		// can hang as an Xcode stub; fixturePython() picks a working interpreter first).
		// Bun/Node `chdir` and POSIX `sh` call getcwd and fail with ERANGE; Python's os.chdir does not.
		const nameLen = 200;
		const pathMax = process.platform === "darwin" ? 1024 : 4096;
		const levels = Math.ceil(pathMax / nameLen) + 2;
		const names = Array.from({ length: levels }, (_, level) => String(level).padStart(3, "0") + "d".repeat(nameLen - 3));
		const python = await fixturePython();
		const script =
			"import os\n" +
			`os.chdir(${JSON.stringify(identity.path)})\n` +
			"os.mkdir('deps'); os.chdir('deps')\n" +
			names.map((name) => `os.mkdir(${JSON.stringify(name)}); os.chdir(${JSON.stringify(name)})`).join("\n") +
			"\n";
		try {
			// Create stays inside try/finally so a mid-tree timeout still runs deep-path cleanup.
			await sh([python, "-c", script], "/", 60_000);
			const manifest = await collectResult(identity, []);
			expect({ files: exported(manifest), exportComplete: manifest.exportComplete, exclusions: manifest.exclusions }).toEqual({
				files: [".gitignore", "d.txt"],
				exportComplete: false,
				exclusions: [{ path: "deps", reason: "nested_repository", outerTrackedEntries: 0 }],
			});
		} finally {
			// Node's recursive removal uses absolute paths; descend relatively from the workspace.
			// ignore_errors: partial trees (create timeout) and missing deps both clean up here.
			await sh(
				[
					python,
					"-c",
					"import os, shutil\n" +
						`os.chdir(${JSON.stringify(identity.path)})\n` +
						"shutil.rmtree('deps', ignore_errors=True)\n",
				],
				"/",
			);
		}
	}, 120_000);
});

describe("F4: the walk below directories Git never enters is bounded separately and keeps no listings", () => {
	async function tree() {
		const root = await scratch("fleet-r5-f4-");
		for (const pkg of ["a", "b", "c"]) {
			await mkdir(join(root, "node_modules", pkg, "lib"), { recursive: true });
			await writeFile(join(root, "node_modules", pkg, "lib", "i.js"), "x");
		}
		await mkdir(join(root, "src", "deep"), { recursive: true });
		await writeFile(join(root, "src", "deep", "s.ts"), "s");
		return root;
	}
	const ignoring = (prefix: string, asked: string[][] = []) => ({
		ignored: async (paths: string[]) => {
			asked.push([...paths]);
			return paths.map((path) => path === prefix || path.startsWith(prefix + "/"));
		},
		tracked: () => 0,
	});
	test("beyond the ignored-entry cap an ignored directory is not walked; Git is never asked below an ignored one", async () => {
		const root = await tree();
		const asked: string[][] = [];
		const scan = await scanWorkspace(root, WORKSPACE_SCAN_LIMITS, new Set(), ignoring("node_modules", asked), { classifyInterval: 1, maxEntries: 2 });
		expect(scan.unwalked).toEqual(["node_modules/a", "node_modules/b", "node_modules/c"]);
		expect([...scan.listings.keys()].sort()).toEqual(["", "src", "src/deep"]);
		expect(asked.flat().filter((path) => path.startsWith("node_modules/"))).toEqual([]);
		expect(deepBoundaries(scan, ["node_modules/"], () => 0)).toEqual(["node_modules"]);
		// Within the cap everything is walked and nothing is unwalked.
		const full = await scanWorkspace(root, WORKSPACE_SCAN_LIMITS, new Set(), ignoring("node_modules"), { classifyInterval: 1, maxEntries: 100 });
		expect({ unwalked: full.unwalked, nested: full.counts.some((entry) => entry.path === "node_modules/a/lib") }).toEqual({ unwalked: [], nested: true });
	});
	test("entries in directories Git enters stay bounded inline at the walk limit; ignored entries do not count", async () => {
		const root = await tree();
		// Entered: 2 at the root, `deep` in `src`, `s.ts` in `src/deep`: 4 entries.
		await expect(scanWorkspace(root, { maxEntries: 3 }, new Set(), ignoring("node_modules"), { classifyInterval: 1, maxEntries: 100 })).rejects.toThrow(/^workspace_scan_limit$/);
		await expect(scanWorkspace(root, { maxEntries: 4 }, new Set(), ignoring("node_modules"), { classifyInterval: 1, maxEntries: 100 })).resolves.toBeDefined();
	});
});

describe("F5: stored legacy-v1 manifests keep the duplicate rule they were stored under", () => {
	test("names equal only under pathKey stay valid in a stored legacy manifest; exclusions-v1 still refuses them", async () => {
		const h = await hub("fleet-r5-f5-");
		const task = await h.settled("legacy");
		await writeFile(join(task.path, "caf\u00e9.txt"), "nfc");
		await writeFile(join(task.path, "stra\u00dfe.txt"), "sharp s");
		const identity = h.store.task(task.id)!.workspace as any;
		const fresh: any = await collectResult(identity, []);
		const entry = (from: string, path: string) => ({ ...fresh.files.find((file: any) => file.path === from), path });
		// As a Linux node running the base collector stored them: distinct names on disk.
		const files = [...fresh.files, entry("caf\u00e9.txt", "cafe\u0301.txt"), entry("stra\u00dfe.txt", "strasse.txt")];
		const legacy = { ...legacyManifest(fresh), files };
		expect(() => validateResult(identity, legacy)).not.toThrow();
		h.store.saveResult(task.id, legacy as any);
		expect(((await h.fleet.result(task.id)) as any).files.map((file: any) => file.path).sort()).toEqual(files.map((file: any) => file.path).sort());
		// Lower-case duplicates stay invalid, as in the base; exclusions-v1 keeps `pathKey`.
		expect(() => validateResult(identity, { ...legacy, files: [...files, entry("caf\u00e9.txt", "CAF\u00c9.txt")] })).toThrow(/Excluded or duplicate result path/);
		expect(() => validateResult(identity, { ...fresh, files })).toThrow(/Excluded or duplicate result path/);
		h.store.close();
	}, 120_000);
});

describe("F6: a deliverable deeper than 128 directories is not refused", () => {
	test("the walk and its limits bound no depth", async () => {
		const root = await scratch("fleet-r5-f6-");
		const deep = join(root, ...Array(140).fill("d"));
		await mkdir(deep, { recursive: true });
		await writeFile(join(deep, "f.txt"), "deep");
		const scan = await scanWorkspace(root);
		expect(Math.max(...scan.counts.map((entry) => entry.depth))).toBe(140);
		expect(() => checkScanLimits(scan, [])).not.toThrow();
	});
});

describe("F8: the recheck and the workspace root identity are behavioural", () => {
	test("a `.git` or any new entry created after the walk fails the recheck", async () => {
		const root = await scratch("fleet-r5-f8-scan-");
		await mkdir(join(root, "sub", "inner"), { recursive: true });
		await writeFile(join(root, "sub", "inner", "f.txt"), "f");
		const scan = await scanWorkspace(root, null);
		await expect(verifyScan(scan)).resolves.toBeUndefined();
		await mkdir(join(root, "sub", "inner", ".git"));
		await expect(verifyScan(scan)).rejects.toThrow(/^result_changed_during_collection$/);
		const again = await scanWorkspace(root, null);
		await writeFile(join(root, "new.txt"), "n");
		await expect(verifyScan(again)).rejects.toThrow(/^result_changed_during_collection$/);
	});
	test("a workspace directory replaced at the same path (identity marker copied) is refused", async () => {
		const { f, identity } = await preparedWorkspace("fleet-r5-f8-root-");
		await writeFile(join(identity.path, "d.txt"), "d");
		await expect(collectResult(identity, [])).resolves.toBeDefined();
		const moved = join(f.dir, "moved-workspace");
		await rename(identity.path, moved);
		await cp(moved, identity.path, { recursive: true });
		await expect(collectResult(identity, [])).rejects.toThrow(/^workspace_identity_mismatch$/);
	}, 120_000);
});
