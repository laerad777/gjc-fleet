import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig, Observation, TaskInput } from "../src/contracts";
import {
	canonicalJson,
	digest,
	observationDigest,
	validateTaskInput,
} from "../src/core";
import { headroom } from "./admission-fixture";
import { FleetStore } from "../src/store";

const directories: string[] = [];
const stores: FleetStore[] = [];
function dbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-test-"));
	directories.push(dir);
	return join(dir, "fleet.sqlite");
}
function open(path = dbPath(), cap = 2): FleetStore {
	const store = new FleetStore(path, cap);
	stores.push(store);
	return store;
}
function node(id: string, patch: Partial<NodeConfig> = {}): NodeConfig {
	return {
		id,
		os: "linux",
		arch: "arm64",
		roots: { repo: "/repos/repo" },
		workspaceRoot: "/work",
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: ["model"],
		transport: { command: "gjc", args: ["acp"] },
		operations: ["read", "write"],
		...patch,
	};
}
function input(key: string, patch: Partial<TaskInput> = {}): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "actor",
		repoId: "repo",
		baseCommit: "a".repeat(40),
		prompt: "Implement the requested change",
		required: {},
		...patch,
	};
}
function receipt(
	eventId: string,
	patch: Partial<Omit<Observation, "eventId" | "digest">> = {},
): Observation {
	const body: Omit<Observation, "eventId" | "digest"> = {
		sessionId: "session",
		turnId: "turn",
		status: "active",
		terminal: false,
		evidence: { source: "runtime" },
		...patch,
	};
	return { eventId, digest: observationDigest(body), ...body };
}
function running(store: FleetStore, key = "task"): string {
	store.putNode(node("node"));
	const task = store.reserve(store.submit(input(key)).id);
	store.recordSession(task.id, "session");
	store.recordTurn(task.id, "turn");
	return task.id;
}
afterEach(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {}
	}
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("canonical contracts", () => {
	test("refuses an unrelated database without changing its data or permissions", () => {
		const path = dbPath();
		const unrelated = new Database(path);
		unrelated.exec(
			"CREATE TABLE user_data(value TEXT); INSERT INTO user_data VALUES ('sentinel');",
		);
		unrelated.close();
		chmodSync(path, 0o644);
		const before = statSync(path);
		expect(() => new FleetStore(path)).toThrow(
			"Refusing an unrelated database",
		);
		const after = statSync(path);
		expect({ mode: after.mode, uid: after.uid, gid: after.gid }).toEqual({
			mode: before.mode,
			uid: before.uid,
			gid: before.gid,
		});
		const reopened = new Database(path);
		expect(reopened.query("SELECT value FROM user_data").get()).toEqual({
			value: "sentinel",
		});
		expect(
			reopened.query("SELECT name FROM sqlite_master WHERE name='tasks'").get(),
		).toBeNull();
		reopened.close();
	});
	test("canonical digests ignore object key order but preserve data", () => {
		expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
			'{"a":{"x":3,"y":2},"z":1}',
		);
		expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
		expect(digest({ a: 1 })).not.toBe(digest({ a: "1" }));
		for (const value of [
			undefined,
			NaN,
			Infinity,
			{ a: undefined },
			new Date(),
			[undefined],
		])
			expect(() => canonicalJson(value)).toThrow();
		const cycle: unknown[] = [];
		cycle.push(cycle);
		expect(() => canonicalJson(cycle)).toThrow();
	});
	test("validates runtime schema, exact commits and positive caps", () => {
		for (const baseCommit of [
			"main",
			"a".repeat(39),
			"a".repeat(41),
			"g".repeat(40),
			"a".repeat(63),
		])
			expect(() => validateTaskInput(input("key", { baseCommit }))).toThrow();
		expect(() =>
			validateTaskInput(input("key", { baseCommit: "a".repeat(64) })),
		).not.toThrow();
		expect(() =>
			validateTaskInput(input("key", { baseCommit: "A".repeat(64) })),
		).toThrow();
		for (const value of [
			null,
			{},
			{ ...input("key"), schemaVersion: 2 },
			{ ...input("key"), required: { os: 3 } },
			{ ...input("key"), extra: true },
		])
			expect(() => validateTaskInput(value)).toThrow();
		for (const cap of [0, -1, 1.5, NaN])
			expect(() => new FleetStore(dbPath(), cap)).toThrow();
		const store = open();
		expect(() => store.putNode(node("bad", { maxConcurrency: 0 }))).toThrow();
		expect(() =>
			store.putNode(node("bad", { roots: { repo: "relative" } })),
		).toThrow();
	});
});

describe("identity and durable reservations", () => {
	test("same actor/key is immutable while separate actors remain independent", () => {
		const store = open();
		const first = store.submit(input("same"));
		expect(store.submit(input("same"))).toEqual(first);
		expect(() => store.submit(input("same", { prompt: "different" }))).toThrow(
			"different task input",
		);
		expect(store.submit(input("same", { caller: "other" })).id).not.toBe(
			first.id,
		);
		expect(store.tasks()).toHaveLength(2);
	});
	test("concurrent independent processes submit and reserve the same identity once", async () => {
		const path = dbPath();
		const store = open(path);
		store.putNode(node("node"));
		const modulePath = new URL("../src/store.ts", import.meta.url).href;
		const code = `import {FleetStore} from ${JSON.stringify(modulePath)}; const s=new FleetStore(process.argv[1]);const t=s.reserve(s.submit(JSON.parse(process.argv[2])).id);console.log(JSON.stringify(t));s.close();`;
		const children = Array.from({ length: 6 }, () =>
			Bun.spawn(
				[
					process.execPath,
					"--eval",
					code,
					path,
					JSON.stringify(input("concurrent")),
				],
				{ stdout: "pipe", stderr: "pipe" },
			),
		);
		const outputs = await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(stderr).toBe("");
				expect(exit).toBe(0);
				return JSON.parse(stdout);
			}),
		);
		expect(new Set(outputs.map((task) => task.id)).size).toBe(1);
		expect(new Set(outputs.map((task) => task.attemptId)).size).toBe(1);
		expect(store.tasks()).toHaveLength(1);
		expect(
			store.events(outputs[0].id).filter((event) => event.kind === "reserved"),
		).toHaveLength(1);
	});
	test("concurrent distinct reservations cannot oversubscribe measured headroom", async () => {
		const path = dbPath();
		const store = open(path);
		store.putNode(node("a"));
		store.putNode(node("b"));
		const modulePath = new URL("../src/store.ts", import.meta.url).href;
		const fixturePath = new URL("./admission-fixture.ts", import.meta.url).href;
		// Each node's sample has headroom for exactly one new task; warmup charging must stop the rest.
		const code = `import {FleetStore} from ${JSON.stringify(modulePath)};import {headroom} from ${JSON.stringify(fixturePath)};const s=new FleetStore(process.argv[1]);const task=s.reserve(s.submit(JSON.parse(process.argv[2])).id,headroom(["a","b"],1));console.log(JSON.stringify(task));s.close();`;
		const children = Array.from({ length: 8 }, (_, index) =>
			Bun.spawn(
				[
					process.execPath,
					"--eval",
					code,
					path,
					JSON.stringify(input(`parallel-${index}`)),
				],
				{ stdout: "pipe", stderr: "pipe" },
			),
		);
		await Promise.all(
			children.map(async (child) => {
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(stderr).toBe("");
				expect(exit).toBe(0);
				expect(JSON.parse(stdout).id).toBeTruthy();
			}),
		);
		const held = store.tasks().filter((task) => task.held);
		expect(held).toHaveLength(2);
		expect(new Set(held.map((task) => task.nodeId)).size).toBe(2);
	});
	test("headroom admission is atomic across database connections", () => {
		const path = dbPath();
		const a = open(path);
		const b = open(path);
		a.putNode(node("a"));
		a.putNode(node("b"));
		const room = headroom(["a", "b"], 1);
		const first = a.reserve(
			a.submit(input("first", { required: { nodeId: "a" } })).id,
			room,
		);
		const onA = b.reserve(
			b.submit(input("on-a", { required: { nodeId: "a" } })).id,
			room,
		);
		expect(first.held).toBe(true);
		expect(onA.held).toBe(false);
		expect(onA.reason).toBe("no_eligible_node");
		const second = b.reserve(b.submit(input("second")).id, room);
		expect(second.nodeId).toBe("b");
		const third = a.reserve(a.submit(input("third")).id, room);
		expect(third.held).toBe(false);
		expect(a.tasks().filter((task) => task.held)).toHaveLength(2);
		expect(b.reserve(first.id).attemptId).toBe(first.attemptId);
		// More measured headroom admits more work on the same node: there is no slot limit.
		const more = b.reserve(b.submit(input("more", { required: { nodeId: "a" } })).id, headroom(["a"], 3));
		expect(more.held).toBe(true);
	});
	test("missing, failed or stale samples exclude a node (fail-closed)", () => {
		const store = open(dbPath());
		store.putNode(node("a"));
		const now = Date.now();
		const cases: Array<[string, ReturnType<typeof headroom>]> = [
			["missing", { samples: new Map() }],
			["failed", { samples: new Map([["a", { ok: false, at: now, error: "ssh" }]]) }],
			["stale", { samples: new Map([["a", { ...headroom(["a"], 1).samples.get("a")!, at: now - 60_000 }]]) }],
			["busy", { samples: new Map([["a", { ...headroom(["a"], 1).samples.get("a")!, cpuPct: 99 }]]) }],
		];
		for (const [key, resources] of cases) {
			const task = store.reserve(store.submit(input(`sample-${key}`)).id, resources);
			expect(task.held).toBe(false);
			const selection = store.events(task.id).find((event) => event.kind === "selection");
			expect(JSON.stringify(selection?.data)).toContain(
				{ missing: "resources_unknown", failed: "resources_unknown", stale: "resources_stale", busy: "cpu_busy" }[key]!,
			);
		}
	});
	test("restart retains task, attempt, operation, session, turn, unknown and audits", () => {
		const path = dbPath();
		const first = open(path);
		const id = running(first);
		const op = first.beginOperation(id, "send", { prompt: "hello" });
		const persisted = first.markUnknown(id, "transport disconnected");
		first.close();
		const second = open(path);
		expect(second.submit(input("task")).id).toBe(id);
		expect(second.reserve(id)).toEqual(persisted);
		expect(second.task(id)?.held).toBe(true);
		expect(second.task(id)?.sessionId).toBe("session");
		expect(second.task(id)?.turnId).toBe("turn");
		expect(
			second
				.events(id)
				.some(
					(event) =>
						event.kind === "operation_intent" &&
						(event.data as { id: string }).id === op.id,
				),
		).toBe(true);
		expect(() =>
			second.beginOperation(id, "send", { prompt: "hello" }),
		).toThrow("Unknown execution");
	});
});

describe("selection", () => {
	test("records every exclusion before applying preferences", () => {
		const store = open();
		const configs = [
			node("disabled", { enabled: false }),
			node("drain", { draining: true }),
			node("offline", { reachable: false }),
			node("sdk", { sdkReady: false }),
			node("model-ready", { modelReady: false }),
			node("os", { os: "darwin" }),
			node("arch", { arch: "x64" }),
			node("model", { models: [] }),
			node("operation", { operations: [] }),
			node("repo", { roots: {} }),
			node("eligible"),
		];
		configs.forEach((config) => store.putNode(config));
		const task = store.reserve(
			store.submit(
				input("filters", {
					required: {
						os: "linux",
						arch: "arm64",
						model: "model",
						operations: ["write"],
					},
					preferences: configs.map((config) => config.id),
				}),
			).id,
		);
		expect(task.nodeId).toBe("eligible");
		const selection = store
			.events(task.id)
			.find((event) => event.kind === "selection")!.data as {
			exclusions: { nodeId: string; reasons: string[] }[];
		};
		for (const [id, reason] of [
			["disabled", "disabled"],
			["drain", "draining"],
			["offline", "unreachable"],
			["sdk", "sdk_not_ready"],
			["model-ready", "model_not_ready"],
			["os", "os_mismatch"],
			["arch", "arch_mismatch"],
			["model", "model_unavailable"],
			["operation", "operation_unavailable:write"],
			["repo", "repo_unavailable"],
		])
			expect(
				selection.exclusions.find((item) => item.nodeId === id)?.reasons,
			).toContain(reason);
		const manual = store.reserve(
			store.submit(input("manual", { required: { nodeId: "offline" } })).id,
		);
		expect(manual.held).toBe(false);
		const manualSelection = store
			.events(manual.id)
			.find((event) => event.kind === "selection")!.data as {
			exclusions: { nodeId: string; reasons: string[] }[];
		};
		expect(
			manualSelection.exclusions.find((item) => item.nodeId === "eligible")
				?.reasons,
		).toContain("manual_node_mismatch");
	});
	test("preferences precede load, then load precedes stable node id", () => {
		const store = open(dbPath(), 5);
		store.putNode(node("b", { maxConcurrency: 5 }));
		store.putNode(node("a", { maxConcurrency: 5 }));
		expect(store.reserve(store.submit(input("one")).id).nodeId).toBe("a");
		expect(store.reserve(store.submit(input("two")).id).nodeId).toBe("b");
		expect(
			store.reserve(
				store.submit(input("three", { preferences: ["b", "a"] })).id,
			).nodeId,
		).toBe("b");
		store.setNodeState("a", { draining: true });
		expect(
			store.reserve(store.submit(input("four", { preferences: ["a"] })).id)
				.nodeId,
		).toBe("b");
		store.setNodeState("b", { enabled: false });
		expect(store.reserve(store.submit(input("five")).id).held).toBe(false);
	});
});

describe("effect journal and authoritative observations", () => {
	test("only one database handle claims each external effect", () => {
		const path = dbPath();
		const first = open(path);
		const id = running(first);
		const second = open(path);
		const claimed = first.claimOperation(id, "session/create", {
			prompt: "request",
		});
		expect(claimed).not.toBeNull();
		expect(
			second.claimOperation(id, "session/create", { prompt: "request" }),
		).toBeNull();
		expect(second.getOperation(id, "session/create")).toEqual(claimed!);
		expect(() =>
			second.claimOperation(id, "session/create", { prompt: "changed" }),
		).toThrow("different payload");
		first.markBlocked(id, "awaiting authoritative reconciliation");
		expect(second.reserve(id).held).toBe(true);
		expect(() => second.claimOperation(id, "turn/create", {})).toThrow(
			"Unknown execution",
		);
		expect(second.getOperation(id, "session/create")).toEqual(claimed!);
	});
	test("workspace and result manifests survive restart without implying terminality", () => {
		const path = dbPath();
		const store = open(path);
		const id = running(store);
		const workspace = { path: "/work/task", baseCommit: "a".repeat(40) };
		expect(store.setWorkspace(id, workspace).workspace).toEqual(workspace);
		expect(store.setWorkspace(id, workspace).workspace).toEqual(workspace);
		expect(() => store.setWorkspace(id, { path: "/other" })).toThrow(
			"immutable",
		);
		const manifest = {
			tests: [{ command: "bun test", exitCode: 0 }],
			files: ["src/file.ts"],
		};
		expect(store.saveResult(id, manifest).held).toBe(true);
		expect(store.task(id)?.result?.verified).not.toBe(true);
		const restarted = open(path);
		expect(restarted.task(id)?.workspace).toEqual(workspace);
		expect(restarted.task(id)?.resultManifest).toEqual(manifest);
		expect(() => restarted.saveResult(id, { files: [] })).toThrow("immutable");
		expect(() => restarted.verifyResult(id, { checks: "passed" })).toThrow(
			"terminal receipt",
		);
	});
	test("operation intent is stable and conflicts are audited before effects", () => {
		const store = open();
		const id = running(store);
		const first = store.beginOperation(id, "send", { b: 2, a: 1 });
		expect(store.beginOperation(id, "send", { a: 1, b: 2 })).toEqual(first);
		expect(() => store.beginOperation(id, "send", { a: 3 })).toThrow(
			"different payload",
		);
		expect(
			store.events(id).filter((event) => event.kind === "operation_intent"),
		).toHaveLength(1);
		expect(store.events(id).some((event) => event.kind === "refused")).toBe(
			true,
		);
	});
	test("event dedup, event conflict, bad digest and exact session/turn ownership", () => {
		const store = open();
		const id = running(store);
		const event = receipt("event");
		const first = store.observe(id, event);
		expect(store.observe(id, event)).toEqual(first);
		expect(
			store.events(id).filter((item) => item.kind === "observation"),
		).toHaveLength(1);
		expect(
			store.observe(id, receipt("late-preparing", { status: "preparing" })),
		).toEqual(first);
		expect(() =>
			store.observe(id, receipt("event", { evidence: { changed: true } })),
		).toThrow("Event identity");
		expect(() =>
			store.observe(id, { ...receipt("bad-digest"), digest: "0".repeat(64) }),
		).toThrow("digest");
		expect(() =>
			store.observe(
				id,
				receipt("foreign-session", { sessionId: "someone-else" }),
			),
		).toThrow("session");
		expect(() =>
			store.observe(id, receipt("foreign-turn", { turnId: "someone-else" })),
		).toThrow("turn");
		const missingTurn = {
			sessionId: "session",
			status: "active" as const,
			terminal: false,
			evidence: null,
		};
		expect(() =>
			store.observe(id, {
				eventId: "missing-turn",
				digest: observationDigest(missingTurn),
				...missingTurn,
			}),
		).toThrow("turn");
		expect(store.task(id)?.held).toBe(true);
	});
	test("unknown, approval and unverified completion remain held without terminal authority", () => {
		const store = open(dbPath(), 1);
		const id = running(store);
		store.observe(id, receipt("approval", { status: "approval_required" }));
		expect(store.task(id)?.held).toBe(true);
		store.observe(
			id,
			receipt("unverified", { status: "completed_unverified" }),
		);
		expect(store.task(id)?.held).toBe(true);
		const attemptId = store.markUnknown(
			id,
			"timeout is not terminal",
		).attemptId;
		expect(store.reserve(id).attemptId).toBe(attemptId);
		store.observe(id, receipt("late-active"));
		expect(store.task(id)?.phase).toBe("blocked_unknown");
		expect(store.task(id)?.held).toBe(true);
		// The held unknown attempt still counts against the node's measured headroom.
		expect(store.reserve(store.submit(input("another")).id, headroom(["node"], 1)).held).toBe(false);
		expect(() => store.verifyResult(id, {})).toThrow("terminal receipt");
	});
	test("local poll ordering rejects stale terminal/failure and fresh reads can resume question cycles", () => {
		const store = open(dbPath(), 1);
		const id = running(store);
		const first = store.beginObservation(id)!,
			second = store.beginObservation(id)!;
		store.observe(
			id,
			receipt("new-question", { status: "approval_required" }),
			second,
		);
		store.observe(
			id,
			receipt("stale-terminal", {
				status: "succeeded",
				terminal: true,
				evidence: { exit: 0 },
			}),
			first,
		);
		store.markObservationUnknown(id, first, "old observation failed");
		expect(store.task(id)?.phase).toBe("approval_required");
		expect(store.task(id)?.held).toBe(true);
		const third = store.beginObservation(id)!;
		store.observe(id, receipt("after-consumption"), third);
		expect(store.task(id)?.phase).toBe("active");
		expect(store.task(id)?.held).toBe(true);
		const fourth = store.beginObservation(id)!;
		store.markObservationUnknown(
			id,
			fourth,
			"observation_unavailable_original_attempt_held",
		);
		expect(store.task(id)?.phase).toBe("blocked_unknown");
		const fifth = store.beginObservation(id)!;
		store.observe(id, receipt("fresh-same-active-body"), fifth);
		expect(store.task(id)?.phase).toBe("active");
		expect(store.task(id)?.held).toBe(true);
		expect(store.task(id)?.reason).toBeUndefined();
		expect(store.task(id)?.pollApplied).toBe(fifth);
		expect(store.events(id).some((event) => event.kind === "released")).toBe(
			false,
		);
	});
	test("terminal releases once; late nonterminal cannot regress or erase verification", () => {
		const store = open();
		const id = running(store);
		for (const evidence of [null, {}, [], "", false, 0])
			expect(() =>
				store.observe(
					id,
					receipt(`empty-${JSON.stringify(evidence)}`, {
						status: "succeeded",
						terminal: true,
						evidence,
					}),
				),
			).toThrow("nonempty");
		const final = store.observe(
			id,
			receipt("terminal", {
				status: "completed_unverified",
				terminal: true,
				evidence: { exit: 0 },
			}),
		);
		expect(final.held).toBe(false);
		expect(final.result?.verified).toBe(false);
		const verified = store.verifyResult(id, { commit: "b".repeat(40) });
		expect(verified.result?.verified).toBe(true);
		expect(store.observe(id, receipt("late"))).toEqual(verified);
		expect(
			store.observe(
				id,
				receipt("terminal", {
					status: "completed_unverified",
					terminal: true,
					evidence: { exit: 0 },
				}),
			),
		).toEqual(verified);
		expect(() =>
			store.observe(
				id,
				receipt("contradiction", { status: "failed", terminal: true }),
			),
		).toThrow("immutable");
		expect(store.markUnknown(id, "late timeout")).toEqual(verified);
		expect(store.reserve(id)).toEqual(verified);
		expect(
			store.events(id).filter((event) => event.kind === "released"),
		).toHaveLength(1);
		expect(store.reserve(store.submit(input("after")).id).held).toBe(true);
	});
	test("session ownership and original turn cannot be reassigned", () => {
		const store = open();
		const id = running(store);
		expect(() => store.recordSession(id, "other")).toThrow("immutable");
		expect(() => store.recordTurn(id, "other")).toThrow("immutable");
		expect(store.recordSession(id, "session").sessionId).toBe("session");
		expect(store.recordTurn(id, "turn").turnId).toBe("turn");
	});
});

test("durable database uses WAL, schema checks and POSIX private file modes", () => {
	const path = dbPath();
	open(path);
	const db = new Database(path);
	expect(
		(db.query("PRAGMA journal_mode").get() as { journal_mode: string })
			.journal_mode,
	).toBe("wal");
	expect(
		(db.query("PRAGMA user_version").get() as { user_version: number })
			.user_version,
	).toBe(2);
	db.close();
	// Windows inherited-DACL privacy is outside this POSIX mode-bit assertion's scope.
	if (process.platform !== "win32")
		expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(() => open(path, 3)).toThrow("global cap");
	const badPath = dbPath();
	const bad = new Database(badPath, { create: true });
	bad.exec("PRAGMA user_version=3");
	bad.close();
	expect(() => open(badPath)).toThrow("schemaVersion");
	const linkPath = join(directories[0], "link.sqlite");
	symlinkSync(path, linkPath);
	expect(() => open(linkPath)).toThrow("regular unshared local files");
});
