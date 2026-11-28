import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digest, observationDigest } from "../src/core";
import { validateResult } from "../src/fleet";
import type { ExternalManifest } from "../src/result-store";
// Namespace import so this file also loads (and fails per behavior) against the
// earlier implementation, which lacks some of these exports.
import * as results from "../src/result-store";
const { EXTERNAL_MIN_BYTES, ResultStore, syncDirectory } = results;
import { FleetStore } from "../src/store";
import { collectResult, prepareWorkspace, sha256 } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "result-store-"));
	dirs.push(dir);
	return dir;
}
const node = (id: string) => ({
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
});
const input = (key: string) => ({
	schemaVersion: 1,
	key,
	caller: "actor",
	repoId: "repo",
	baseCommit: "a".repeat(40),
	prompt: "p",
	required: {},
});
/** A reserved task with a session and turn, ready for saveResult. */
function running(store: FleetStore, key = "k"): string {
	store.putNode(node("node") as any);
	const task = store.reserve(store.submit(input(key) as any).id)!;
	store.recordSession(task.id, `session-${key}`);
	store.recordTurn(task.id, `turn-${key}`);
	return task.id;
}
/** Writes an inline (pre-externalisation) manifest into a task row, as an older build would have. */
function legacyRow(path: string, store: FleetStore, key: string, manifest: unknown): string {
	const task = store.submit(input(key) as any);
	const db = new Database(path);
	try {
		db.query("UPDATE tasks SET data=? WHERE id=?").run(
			canonicalJson({ ...task, resultManifest: manifest } as any),
			task.id,
		);
	} finally {
		db.close();
	}
	return task.id;
}
function rowOf(path: string, id: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("SELECT data FROM tasks WHERE id=?").get(id) as { data: string }).data;
	} finally {
		db.close();
	}
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** The deliberate, audited one-way switch. Externalisation is off without it. */
function enable<T extends FleetStore>(store: T): T {
	store.enableResultStore({ actor: "tester", reason: "result-store test" });
	return store;
}
/** A writable store with result externalisation turned on. */
const onStore = (path: string) => enable(new FleetStore(path));
function code(fn: () => unknown): string {
	try {
		fn();
		return "ok";
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}
function largeManifest() {
	return {
		files: [
			{
				path: "large.txt",
				bytes: 3 * 1024 * 1024,
				sha256: "fixture",
				contentBase64: Buffer.alloc(3 * 1024 * 1024, 65).toString("base64"),
			},
		],
		patch: "+A\n".repeat(1024 * 1024),
		tests: [{ argv: ["bun", "test"], stdout: "ok\n".repeat(100000), stderr: "" }],
		status: "verified",
	};
}

// ---------------------------------------------------------------------------
// F1: long strings inside arrays (verifier argv) survive persistence.

test("F1: verified manifest with a 4918-char --eval argv stays valid after save, reopen, re-save, backup and migration", async () => {
	const f = await repositoryFixture("result-argv-");
	dirs.push(f.dir);
	const identity = await prepareWorkspace({
		taskId: "task",
		attemptId: "attempt",
		nodeId: "node",
		inputDigest: sha256("input"),
		repo: f.repo,
		baseCommit: f.baseCommit,
		workspaceRoot: f.workspaceRoot,
	});
	writeFileSync(join(identity.path, "x.txt"), "x\n");
	writeFileSync(join(identity.path, "big.txt"), "large artifact line\n".repeat(20000));
	const script = `console.log('ok');${"/*pad*/".repeat(700)}`;
	expect(script.length).toBe(4918);
	const now = new Date().toISOString();
	const run = {
		cwd: identity.path,
		argv: [process.execPath, "--eval", script],
		exit: 0,
		stdout: "ok\n",
		stderr: "",
		stdoutDigest: sha256("ok\n"),
		stderrDigest: sha256(""),
		startedAt: now,
		endedAt: now,
	};
	const manifest = await collectResult(identity, [run as any]);
	validateResult(identity, manifest);
	expect((manifest as any).status).toBe("verified");
	const D0 = digest(manifest);

	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	let id: string;
	try {
		id = running(store);
		store.saveResult(id, manifest as any);
	} finally {
		store.close();
	}

	const reopened = new FleetStore(path);
	try {
		const got = reopened.task(id)!.resultManifest as any;
		expect(code(() => validateResult(identity, got))).toBe("ok");
		expect(typeof got.tests[0].argv[2]).toBe("string");
		expect(got.tests[0].argv[2]).toBe(script);
		expect(hash(canonicalJson(got))).toBe(D0);
		expect(digest(got)).toBe(D0);
		expect(code(() => reopened.saveResult(id, manifest as any))).toBe("ok");
		// The argv stays inline; large file content/patch moved out of the row.
		const stored = JSON.parse(rowOf(path, id)).resultExternal as ExternalManifest;
		expect(stored.skeleton).toMatchObject({ tests: [{ argv: run.argv }] });
		expect(stored.blobs.length).toBeGreaterThan(0);
		const backup = reopened.backup(join(dir, "backup.sqlite"));
		expect(backup.results.blobs).toBe(stored.blobs.length);
		const copy = new FleetStore(join(dir, "backup.sqlite"));
		try {
			expect(hash(canonicalJson(copy.task(id)!.resultManifest))).toBe(D0);
		} finally {
			copy.close();
		}
	} finally {
		reopened.close();
	}

	// The same manifest as a legacy inline row migrates and validates, and does not block later rows.
	const legacyPath = join(dir, "legacy.sqlite");
	const legacy = onStore(legacyPath);
	try {
		const ids = [
			legacyRow(legacyPath, legacy, "l0", { patch: "+1\n".repeat(3000) }),
			legacyRow(legacyPath, legacy, "l1", manifest),
			legacyRow(legacyPath, legacy, "l2", { patch: "+3\n".repeat(3000) }),
		];
		const report = legacy.migrateResults(true);
		expect(report).toMatchObject({ migrated: 3, failed: [] });
		for (const one of ids) expect(JSON.parse(rowOf(legacyPath, one)).resultExternal).toBeDefined();
		const got = legacy.task(ids[1]!)!.resultManifest as any;
		expect(() => validateResult(identity, got)).not.toThrow();
		expect(digest(got)).toBe(D0);
	} finally {
		legacy.close();
	}
});

test("real multi-MB collected workspace: validation and digest survive, row is bounded on fresh write and migration", async () => {
	const f = await repositoryFixture("result-large-");
	dirs.push(f.dir);
	const identity = await prepareWorkspace({
		taskId: "task",
		attemptId: "attempt",
		nodeId: "node",
		inputDigest: sha256("input"),
		repo: f.repo,
		baseCommit: f.baseCommit,
		workspaceRoot: f.workspaceRoot,
	});
	writeFileSync(join(identity.path, "large.txt"), "large artifact line\n".repeat(150000));
	const bin = Buffer.alloc(1_500_000);
	for (let i = 0; i < bin.length; i++) bin[i] = (i * 2654435761) >>> 24;
	writeFileSync(join(identity.path, "blob.bin"), bin);
	writeFileSync(join(identity.path, "small.txt"), "small\n");
	const m = await collectResult(identity, []);
	validateResult(identity, m);
	const D0 = digest(m);
	const dir = fixture();
	const fresh = join(dir, "fresh.sqlite");
	const store = onStore(fresh);
	const id = running(store);
	store.saveResult(id, m as any);
	const legacyPath = join(dir, "legacy.sqlite");
	const legacy = onStore(legacyPath);
	const legacyId = legacyRow(legacyPath, legacy, "legacy", m);
	const before = Buffer.byteLength(rowOf(legacyPath, legacyId));
	expect(legacy.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
	legacy.close();
	store.close();
	const sizes = {
		canonicalManifestBytes: Buffer.byteLength(canonicalJson(m)),
		legacyRowBytes: before,
		migratedRowBytes: Buffer.byteLength(rowOf(legacyPath, legacyId)),
		freshRowBytes: Buffer.byteLength(rowOf(fresh, id)),
	};
	console.log(JSON.stringify(sizes));
	expect(sizes.canonicalManifestBytes).toBeGreaterThan(6_000_000);
	expect(sizes.freshRowBytes).toBeLessThan(8000);
	expect(sizes.migratedRowBytes).toBeLessThan(8000);
	for (const [path, task] of [[fresh, id], [legacyPath, legacyId]] as const) {
		const reopened = new FleetStore(path);
		try {
			const got = reopened.task(task)!.resultManifest!;
			validateResult(identity, got);
			expect(hash(canonicalJson(got))).toBe(D0);
		} finally {
			reopened.close();
		}
	}
	const db = new Database(fresh, { readonly: true });
	try {
		const audit = db.query("SELECT data FROM audit WHERE task_id=? AND kind='result_saved'").get(id) as { data: string };
		expect(JSON.parse(audit.data).digest).toBe(D0);
	} finally {
		db.close();
	}
});

// ---------------------------------------------------------------------------
// Property: externalisation is a lossless, structure-preserving transform.

function prng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function generator(seed: number) {
	const random = prng(seed);
	const int = (n: number) => Math.floor(random() * n);
	const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
	const alphabet = ["a", "Z", "0", " ", "\n", "\t", '"', "\\", "/", "ñ", "ж", "é", "😀", "𝄞", "\u0000", "\u2028", "\ufeff"];
	const lone = ["\ud800", "\udfff", "\udc00x", "y\ud83d"];
	const short = () => Array.from({ length: int(12) }, () => pick(alphabet)).join("");
	const long = () => {
		const unit = short() || "x";
		const target = EXTERNAL_MIN_BYTES - 64 + int(6000);
		return unit.repeat(Math.ceil(target / unit.length)).slice(0, target);
	};
	const string = (): string => {
		switch (int(8)) {
			case 0:
				return "";
			case 1:
			case 2:
				return long();
			case 3:
				return pick(lone) + short();
			case 4:
				return Buffer.alloc(EXTERNAL_MIN_BYTES + int(4000), int(256)).toString("base64");
			default:
				return short();
		}
	};
	const trickyKeys = ["__proto__", "$resultBlob", "$resultManifest", "resultExternal", "blobs", "skeleton", "constructor", "", "ключ"];
	const trickyObjects = (): unknown =>
		pick([
			{ $resultBlob: { sha: "0".repeat(64), size: 1 } },
			{ path: ["patch"], sha256: "0".repeat(64), bytes: 1 },
			{ version: 1, digest: "0".repeat(64), skeleton: { patch: null }, blobs: [] },
			{ $resultManifest: 1, digest: "x", skeleton: { patch: "p" } },
		]);
	const value = (depth: number): unknown => {
		switch (depth > 3 ? int(4) : int(9)) {
			case 0:
				return string();
			case 1:
				return pick([null, true, false, 0, -1, 1.5, 2 ** 53 - 1, 1e-7]);
			case 2:
				return {};
			case 3:
				return [];
			case 4:
				return Array.from({ length: int(4) }, () => value(depth + 1));
			case 5:
				return trickyObjects();
			default: {
				const out: Record<string, unknown> = {};
				for (let i = int(4); i > 0; i--) {
					const key = int(3) === 0 ? pick(trickyKeys) : short();
					Object.defineProperty(out, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
				}
				return out;
			}
		}
	};
	const schemaString = () => (int(5) === 0 ? pick([null, 7, [], {}, ["x".repeat(EXTERNAL_MIN_BYTES)]]) : string());
	return () => {
		const manifest: Record<string, unknown> = {};
		if (int(6)) manifest.patch = schemaString();
		if (int(6))
			manifest.files = Array.from({ length: int(4) }, () =>
				int(6)
					? { path: short(), bytes: int(1000), sha256: hash(short()), contentBase64: schemaString(), extra: value(2) }
					: value(2),
			);
		if (int(6))
			manifest.tests = Array.from({ length: int(4) }, () =>
				int(6)
					? {
							cwd: string(),
							argv: [string(), "--eval", long(), ...Array.from({ length: int(3) }, string)],
							exit: int(3),
							stdout: schemaString(),
							stderr: schemaString(),
							receipt: value(2),
						}
					: value(2),
			);
		if (int(2)) manifest.status = pick(["verified", "not_run", "failed", ""]);
		for (let i = int(4); i > 0; i--) {
			const key = int(2) ? pick(trickyKeys) : short();
			Object.defineProperty(manifest, key, { value: value(1), enumerable: true, writable: true, configurable: true });
		}
		return int(20) === 0 ? value(0) : manifest;
	};
}

test("property: rehydrate(externalise(x)) deep-equals x and keeps digest(x) for arbitrary manifests", () => {
	const store = new ResultStore(join(fixture(), "results"));
	let externalised = 0;
	let insideArrays = 0;
	for (let seed = 1; seed <= 400; seed++) {
		const x = generator(seed)();
		const original = canonicalJson(x);
		const stored = store.externalise(x);
		// The stored form survives the SQLite row encoding (canonical JSON text).
		const row = JSON.parse(canonicalJson(stored));
		const back = store.rehydrate(row);
		expect(back).toStrictEqual(JSON.parse(original));
		expect(Bun.deepEquals(back, x, true)).toBe(true);
		expect(canonicalJson(back)).toBe(original);
		expect(stored.digest).toBe(digest(x));
		expect(digest(back)).toBe(digest(x));
		// Input is never mutated.
		expect(canonicalJson(x)).toBe(original);
		externalised += stored.blobs.length;
		insideArrays += stored.blobs.filter((ref) => ref.path.length === 3).length;
		// Only schema fields ever leave the row; argv, receipts and unknown fields stay inline.
		for (const ref of stored.blobs)
			expect(["patch", "files.contentBase64", "tests.stdout", "tests.stderr"]).toContain(
				ref.path.length === 1 ? ref.path[0] : `${ref.path[0]}.${ref.path[2]}`,
			);
		const skeleton = canonicalJson(stored.skeleton);
		const tests = (x as any)?.tests;
		if (Array.isArray(tests))
			for (const one of tests)
				if (Array.isArray(one?.argv)) expect(skeleton).toContain(canonicalJson(one.argv));
	}
	expect(externalised).toBeGreaterThan(100);
	expect(insideArrays).toBeGreaterThan(50);
}, 60_000);

test("property: the same manifests round-trip through FleetStore save, reopen and legacy migration", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const make = generator(9001);
	const expected = new Map<string, string>();
	try {
		for (let i = 0; i < 40; i++) {
			const x = make();
			if (!x || typeof x !== "object" || Array.isArray(x) || !Object.keys(x).length) continue;
			if (i % 2) {
				const id = running(store, `fresh-${i}`);
				store.saveResult(id, x as any);
				expected.set(id, canonicalJson(x));
			} else expected.set(legacyRow(path, store, `legacy-${i}`, x), canonicalJson(x));
		}
		expect(store.migrateResults(true).failed).toEqual([]);
	} finally {
		store.close();
	}
	const reopened = new FleetStore(path);
	try {
		expect(reopened.migrateResults().eligible).toBe(0);
		for (const [id, want] of expected) {
			expect(JSON.parse(rowOf(path, id)).resultManifest).toBeUndefined();
			expect(canonicalJson(reopened.task(id)!.resultManifest)).toBe(want);
		}
	} finally {
		reopened.close();
	}
});

// ---------------------------------------------------------------------------
// F2: blob references live outside the manifest value space.

test("F2: reference-shaped manifest values are data; they never alias other blobs or poison backups", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const victim = running(store, "victim");
		const secret = "SECRET OTHER TASK CONTENT ".repeat(100);
		store.saveResult(victim, { patch: secret } as any);
		const ref = (JSON.parse(rowOf(path, victim)).resultExternal as ExternalManifest).blobs[0]!;
		const crafted = {
			patch: "",
			extra: { $resultBlob: { sha: ref.sha256, size: ref.bytes } },
			lookalike: { path: ["patch"], sha256: ref.sha256, bytes: ref.bytes },
			nested: [{ version: 1, digest: ref.sha256, skeleton: { patch: null }, blobs: [ref] }],
			dangling: { $resultBlob: { sha: "0".repeat(64), size: 1 } },
		};
		const id = running(store, "crafted");
		store.saveResult(id, crafted as any);
		const got = store.task(id)!.resultManifest;
		expect<unknown>(got).toStrictEqual(crafted);
		expect(canonicalJson(got)).not.toContain("SECRET");
		const backup = store.backup(join(dir, "backup.sqlite"));
		expect(backup.results.blobs).toBe(1);
	} finally {
		store.close();
	}
});

test("F2: legacy inline manifests shaped like stored forms are read verbatim and migrated", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const shapes = [
			{ $resultManifest: 1, digest: "x", skeleton: { patch: "p" } },
			{ version: 1, digest: "0".repeat(64), skeleton: { patch: null }, blobs: [] },
		];
		const ids = shapes.map((shape, i) => legacyRow(path, store, `shape-${i}`, shape));
		for (const [i, id] of ids.entries()) expect<unknown>(store.task(id)!.resultManifest).toStrictEqual(shapes[i]);
		expect(store.migrateResults()).toMatchObject({ eligible: 2 });
		expect(store.migrateResults(true)).toMatchObject({ migrated: 2, failed: [] });
		for (const [i, id] of ids.entries()) expect<unknown>(store.task(id)!.resultManifest).toStrictEqual(shapes[i]);
	} finally {
		store.close();
	}
});

test("F2: __proto__ and other special keys stay own data properties", () => {
	const store = new ResultStore(join(fixture(), "results"));
	const x = JSON.parse(
		`{"__proto__":{"polluted":true},"constructor":{"prototype":1},"files":[{"__proto__":[1],"contentBase64":"${"Q".repeat(EXTERNAL_MIN_BYTES)}"}],"patch":"${"p".repeat(EXTERNAL_MIN_BYTES)}"}`,
	);
	const back = store.rehydrate(JSON.parse(canonicalJson(store.externalise(x)))) as any;
	expect(Object.getPrototypeOf(back)).toBe(Object.prototype);
	expect(Object.hasOwn(back, "__proto__")).toBe(true);
	expect(back.polluted).toBeUndefined();
	expect(Object.hasOwn(back.files[0], "__proto__")).toBe(true);
	expect(canonicalJson(back)).toBe(canonicalJson(x));
	expect(({} as any).polluted).toBeUndefined();
});

test("F2: stored forms are strictly validated; references cannot be added, moved, duplicated or pointed outside", () => {
	const dir = fixture();
	writeFileSync(join(dir, "outside"), "SECRET");
	const store = new ResultStore(join(dir, "results"));
	const stored = store.externalise({ patch: "p".repeat(EXTERNAL_MIN_BYTES), extra: null, tests: [{ stdout: null }] });
	const ref = stored.blobs[0]!;
	const variants: unknown[] = [
		{ ...stored, blobs: [{ ...ref, path: ["extra"] }] },
		{ ...stored, blobs: [{ ...ref, path: ["tests", 0, "stdout"] }] },
		{ ...stored, blobs: [ref, ref] },
		{ ...stored, blobs: [{ ...ref, extra: 1 }] },
		{ ...stored, extra: 1 },
		{ ...stored, version: 2 },
		{ ...stored, blobs: [] },
		{ ...stored, skeleton: { ...(stored.skeleton as object), patch: "inline" } },
		...["../outside", "..\\outside", `${"a".repeat(63)}/`, "A".repeat(64), `${"a".repeat(64)}\n`].map((sha256) => ({
			...stored,
			blobs: [{ ...ref, sha256 }],
		})),
		{ ...stored, blobs: [{ ...ref, bytes: -1 }] },
		{ ...stored, blobs: [{ ...ref, bytes: ref.bytes + 1 }] },
	];
	for (const variant of variants) expect(code(() => store.rehydrate(variant))).toBe("RESULT_INTEGRITY");
	expect(store.rehydrate(stored)).toStrictEqual({ patch: "p".repeat(EXTERNAL_MIN_BYTES), extra: null, tests: [{ stdout: null }] });
});

// ---------------------------------------------------------------------------
// F4: no unverified digest or status claims; writes prove the round trip.

test("F4: missing or corrupt blobs fail every read with RESULT_INTEGRITY instead of reporting a retained status/digest", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const id = running(store);
	const m = { status: "verified", patch: "+x\n".repeat(3000), files: [{ path: "a", contentBase64: Buffer.alloc(3000, 1).toString("base64") }], tests: [] };
	store.saveResult(id, m as any);
	const results = `${path}.results`;
	const blobs = readdirSync(results);
	expect(blobs.length).toBe(2);
	const victim = join(results, blobs[0]!, "data");
	const good = readFileSync(victim);
	const damage: [string, () => void][] = [
		["truncated", () => writeFileSync(victim, good.subarray(0, 10))],
		["same size, wrong bytes", () => writeFileSync(victim, Buffer.alloc(good.length, 120))],
		["data is a directory", () => (rmSync(victim), mkdirSync(victim))],
		["missing", () => rmSync(join(results, blobs[0]!), { recursive: true, force: true })],
	];
	try {
		for (const [, apply] of damage) {
			rmSync(join(results, blobs[0]!), { recursive: true, force: true });
			mkdirSync(join(results, blobs[0]!));
			writeFileSync(victim, good);
			expect(store.task(id)!.resultManifest).toStrictEqual(m);
			apply();
			expect(code(() => store.task(id))).toBe("RESULT_INTEGRITY");
			expect(code(() => store.tasks())).toBe("RESULT_INTEGRITY");
			expect(code(() => store.backup(join(fixture(), "b.sqlite")))).toBe("RESULT_INTEGRITY");
			// Publishing the same content again never trusts the damaged entry.
			const damagedEntryExists = existsSync(join(results, blobs[0]!));
			const other = new ResultStore(results);
			expect(code(() => other.externalise({ patch: good.toString("utf8") }))).toBe(
				damagedEntryExists ? "RESULT_INTEGRITY" : "ok",
			);
		}
		rmSync(join(results, blobs[0]!), { recursive: true, force: true });
	} finally {
		store.close();
	}
	// show (which reads the result), including --read-only, fails instead of printing digest/status.
	// The tasks listing never reads results (M2): it still lists the task with the base listing
	// contract (L-A), filled from the recorded metadata only; it is not a verification (show,
	// result and results check verify).
	const { cli } = await import("../src/cli");
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => void logs.push(args.join(" "));
	try {
		for (const argv of [
			["--db", path, "show", id],
			["--read-only", "--db", path, "show", id],
		]) {
			let failure: unknown;
			await cli(argv).catch((error) => (failure = error));
			expect((failure as { code?: string })?.code).toBe("RESULT_INTEGRITY");
		}
		for (const argv of [
			["--db", path, "tasks"],
			["--read-only", "--db", path, "tasks"],
		]) {
			logs.length = 0;
			expect(await cli(argv)).toBe(0);
			const listed = JSON.parse(logs.join("\n"));
			expect(listed.map((task: { id: string }) => task.id)).toEqual([id]);
			expect(listed[0].resultManifest).toEqual({ digest: digest(m), status: "verified", files: 1, tests: 0 });
		}
		logs.length = 0;
		expect(await cli(["--read-only", "--db", path, "results", "check"])).toBe(1);
		expect(JSON.parse(logs.join("\n")).missing).toEqual([{ sha256: blobs[0], taskIds: [id] }]);
	} finally {
		console.log = originalLog;
	}
});

test("F4: lone surrogates are preserved exactly (kept inline) and the digest is the real one", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		const m = { patch: `+a\ud800b\n${"z".repeat(EXTERNAL_MIN_BYTES)}`, tests: [{ stdout: `${"y".repeat(5000)}\udc00`, stderr: "e".repeat(5000) }] };
		store.saveResult(id, m as any);
		const stored = JSON.parse(rowOf(path, id)).resultExternal as ExternalManifest;
		expect(stored.blobs.map((ref) => ref.path)).toEqual([["tests", 0, "stderr"]]);
		const got = store.task(id)!.resultManifest as any;
		expect(got.patch).toBe(m.patch);
		expect(got.tests[0].stdout).toBe(m.tests[0]!.stdout);
		expect(hash(canonicalJson(got))).toBe(digest(m));
		expect(stored.digest).toBe(digest(m));
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// F8 / F9: no cross-store aliasing; idempotent submit returns the decoded record.

test("F8: a manifest hydrated from one store is fully published into another", () => {
	const a = new ResultStore(join(fixture(), "A"));
	const b = new ResultStore(join(fixture(), "B"));
	const hydrated = a.rehydrate(a.externalise({ patch: "+cross\n".repeat(1000) }));
	const stored = b.externalise(hydrated);
	expect(existsSync(b.directory)).toBe(true);
	expect((b.rehydrate(stored) as any).patch.length).toBe(7000);
	rmSync(a.directory, { recursive: true, force: true });
	expect((b.rehydrate(stored) as any).patch.length).toBe(7000);
});

test("F9: idempotent submit reuse returns the same decoded record as task()", () => {
	const store = onStore(join(fixture(), "fleet.sqlite"));
	try {
		const id = running(store);
		const m = { patch: "+j\n".repeat(1000), status: "verified" };
		store.saveResult(id, m as any);
		const again = store.submit(input("k") as any);
		expect(again.id).toBe(id);
		expect(again.resultManifest).toStrictEqual(m);
		expect(again).toStrictEqual(store.task(id)!);
		expect(Object.hasOwn(again, "resultExternal")).toBe(false);
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// F5: directory durability.

test("F5: syncDirectory flushes existing directories on this platform and refuses missing ones", () => {
	const dir = fixture();
	const synced = syncDirectory(dir);
	if (process.platform === "win32") expect(synced).toBe(true);
	else expect(typeof synced).toBe("boolean");
	expect(() => syncDirectory(join(dir, "missing"))).toThrow();
	// First creation of the result directory is flushed into its parent before use.
	const store = new ResultStore(join(dir, "nested", "results"));
	store.externalise({ patch: "p".repeat(EXTERNAL_MIN_BYTES) });
	expect(readdirSync(join(dir, "nested", "results")).length).toBe(1);
});

// ---------------------------------------------------------------------------
// F6: backup copies exactly the referenced blobs and fails closed.

test("F6: backup copies referenced blobs byte-for-byte, binds an inventory and restores only together", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const m = { patch: "+q\n".repeat(4000), status: "s", files: [{ path: "f", contentBase64: "Q".repeat(5000) }] };
	const id = running(store);
	store.saveResult(id, m as any);
	// An unreferenced blob in the source is not copied.
	new ResultStore(`${path}.results`).externalise({ patch: "orphan".repeat(1000) });
	const bk = join(dir, "backup-2026.sqlite");
	const backup = store.backup(bk);
	store.close();
	const refs = (JSON.parse(rowOf(path, id)).resultExternal as ExternalManifest).blobs;
	const inventory = refs
		.map((ref) => [ref.sha256, ref.bytes] as const)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([sha, bytes]) => `${sha} ${bytes}\n`)
		.join("");
	expect(backup.results).toEqual({
		path: `${bk}.results`,
		blobs: 2,
		bytes: refs.reduce((sum, ref) => sum + ref.bytes, 0),
		inventorySha256: hash(inventory),
	});
	expect(readdirSync(`${bk}.results`).sort()).toEqual(refs.map((ref) => ref.sha256).sort());
	for (const ref of refs)
		expect(hash(readFileSync(join(`${bk}.results`, ref.sha256, "data")))).toBe(ref.sha256);
	// Restore under a new name without the result directory: explicit integrity error.
	const restoreDir = fixture();
	const restored = join(restoreDir, "fleet.sqlite");
	cpSync(bk, restored);
	const without = new FleetStore(restored);
	try {
		expect(code(() => without.task(id))).toBe("RESULT_INTEGRITY");
	} finally {
		without.close();
	}
	cpSync(`${bk}.results`, `${restored}.results`, { recursive: true });
	const together = new FleetStore(restored);
	try {
		expect(together.task(id)!.resultManifest).toStrictEqual(m);
	} finally {
		together.close();
	}
});

test("F6: failed backup leaves no destination artifacts, and an existing destination .results is refused, not merged", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		store.saveResult(id, { patch: "+r\n".repeat(4000) } as any);
		const existing = join(dir, "existing.sqlite");
		mkdirSync(`${existing}.results`);
		expect(code(() => store.backup(existing))).toBe("BACKUP_EXISTS");
		expect(existsSync(existing)).toBe(false);
		expect(readdirSync(`${existing}.results`)).toEqual([]);
		for (const blob of readdirSync(`${path}.results`)) rmSync(join(`${path}.results`, blob), { recursive: true });
		const failed = join(dir, "failed.sqlite");
		expect(code(() => store.backup(failed))).toBe("RESULT_INTEGRITY");
		for (const suffix of ["", ".results", "-wal", "-shm", "-journal"]) expect(existsSync(failed + suffix)).toBe(false);
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// F7: migration accounting, per-row isolation and full round-trip proof.

test("F7: a lost row update is reported as failed, never as migrated", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const db = new Database(path);
	try {
		const id = legacyRow(path, store, "cas", { patch: "+m\n".repeat(3000) });
		const before = rowOf(path, id);
		db.exec("CREATE TRIGGER lost BEFORE UPDATE ON tasks WHEN NEW.data LIKE '%resultExternal%' BEGIN SELECT RAISE(IGNORE); END;");
		const report = store.migrateResults(true);
		expect(report.migrated).toBe(0);
		expect(report.failed).toEqual([{ taskId: id, code: "MIGRATION_NOT_APPLIED", message: "Row update was not applied" }]);
		expect(rowOf(path, id)).toBe(before);
	} finally {
		db.close();
		store.close();
	}
});

test("F7: a failing row is reported and left byte-identical while later rows migrate; repair then resumes", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const patch = "+bad\n".repeat(3000);
		const ids = [
			legacyRow(path, store, "r0", { patch: "+0\n".repeat(3000) }),
			legacyRow(path, store, "r1", { patch }),
			legacyRow(path, store, "r2", { patch: "+2\n".repeat(3000) }),
		];
		const before = rowOf(path, ids[1]!);
		// A damaged pre-existing blob with the row's content address.
		mkdirSync(join(`${path}.results`, hash(patch)), { recursive: true });
		writeFileSync(join(`${path}.results`, hash(patch), "data"), "corrupt");
		const dry = store.migrateResults();
		expect(dry).toMatchObject({ dryRun: true, eligible: 3, migrated: 0, failed: [] });
		const first = store.migrateResults(true);
		expect(first).toMatchObject({ dryRun: false, eligible: 3, migrated: 2 });
		expect(first.failed.map((one) => [one.taskId, one.code])).toEqual([[ids[1], "RESULT_INTEGRITY"]]);
		expect(rowOf(path, ids[1]!)).toBe(before);
		expect(store.task(ids[1]!)!.resultManifest).toEqual({ patch });
		// Operator repair: the corrupt entry is found by the inventory and removed by gc.
		expect(store.resultInventory().unreferenced.map((one) => one.sha256)).toEqual([hash(patch)]);
		const dryOutcome = store.collectResults(true);
		expect("removed" in dryOutcome ? dryOutcome.removed : undefined).toEqual([hash(patch)]);
		expect(store.migrateResults(true)).toMatchObject({ eligible: 1, migrated: 1, failed: [] });
		expect(store.migrateResults(true)).toMatchObject({ eligible: 0, migrated: 0, failed: [] });
		for (const id of ids) expect(JSON.parse(rowOf(path, id)).resultManifest).toBeUndefined();
		expect(store.task(ids[1]!)!.resultManifest).toEqual({ patch });
	} finally {
		store.close();
	}
});

test("F7: migration refuses to shrink a row whose full decoded record would differ", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	try {
		// A legacy row carrying both forms can never be decoded back to itself. It can only
		// exist from before the switch: once on, the row-form triggers refuse such a write.
		const task = store.submit(input("both") as any);
		const db = new Database(path);
		const original = canonicalJson({ ...task, resultManifest: { patch: "+x\n".repeat(3000) }, resultExternal: { version: 1 } } as any);
		db.query("UPDATE tasks SET data=? WHERE id=?").run(original, task.id);
		db.close();
		enable(store);
		const report = store.migrateResults(true);
		expect(report.migrated).toBe(0);
		expect(report.failed.map((one) => one.code)).toEqual(["RESULT_INTEGRITY"]);
		expect(rowOf(path, task.id)).toBe(original);
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// F10: inventory and collection of orphans.

test("F10: results check reports missing/corrupt/unreferenced/temporary entries; gc removes only garbage", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const a = running(store, "a");
		const b = running(store, "b");
		store.saveResult(a, { patch: "+a\n".repeat(1000) } as any);
		store.saveResult(b, { patch: "+b\n".repeat(1000), files: [{ path: "f", contentBase64: "B".repeat(2000) }] } as any);
		const results = `${path}.results`;
		const orphan = hash("orphan".repeat(1000));
		new ResultStore(results).externalise({ patch: "orphan".repeat(1000) });
		const temp = `${"c".repeat(64)}.tmp-AbC123`;
		mkdirSync(join(results, temp));
		mkdirSync(join(results, "operator-notes"));
		const clean = store.resultInventory();
		expect(clean).toMatchObject({ referenced: { blobs: 3 }, missing: [], corrupt: [], temporary: [temp], unknown: ["operator-notes"] });
		expect(clean.unreferenced).toEqual([{ sha256: orphan, bytes: 6000 }]);
		const bBlob = hash("B".repeat(2000));
		writeFileSync(join(results, bBlob, "data"), "B");
		rmSync(join(results, hash("+a\n".repeat(1000))), { recursive: true });
		const damaged = store.resultInventory();
		expect(damaged.missing).toEqual([{ sha256: hash("+a\n".repeat(1000)), taskIds: [a] }]);
		expect(damaged.corrupt).toEqual([{ sha256: bBlob, taskIds: [b] }]);
		const garbage = [orphan, temp].sort();
		const dry = store.collectResults();
		expect(dry.dryRun).toBe(true);
		expect([...(dry as { removable: string[] }).removable].sort()).toEqual(garbage);
		expect(readdirSync(results)).toContain(orphan);
		expect(code(() => store.collectResults(true))).toBe("RESULT_INTEGRITY");
		expect(readdirSync(results)).toContain(orphan);
		// Repair the referenced contents before allowing destructive collection.
		mkdirSync(join(results, hash("+a\n".repeat(1000))));
		writeFileSync(join(results, hash("+a\n".repeat(1000)), "data"), "+a\n".repeat(1000));
		writeFileSync(join(results, bBlob, "data"), "B".repeat(2000));
		const applied = store.collectResults(true) as { dryRun: boolean; removed: string[] };
		expect(applied.dryRun).toBe(false);
		expect([...applied.removed].sort()).toEqual(garbage);
		expect(readdirSync(results).sort()).toEqual([hash("+a\n".repeat(1000)), bBlob, hash("+b\n".repeat(1000)), "operator-notes"].sort());
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// Crash safety at the five injected points, and concurrent writers.

function seedLegacy(path: string, rows: number, scale: number, on = true): Map<string, { row: string; manifest: string }> {
	const store = new FleetStore(path);
	if (on) enable(store);
	const originals = new Map<string, { row: string; manifest: string }>();
	try {
		for (let i = 0; i < rows; i++) {
			const manifest = {
				status: "verified",
				patch: `+row${i}\n`.repeat(scale),
				files: [{ path: `f${i}`, contentBase64: Buffer.alloc(scale * 4, 65 + i).toString("base64") }],
				tests: [{ argv: ["bun", "--eval", "x".repeat(5000)], stdout: `out${i}\n`.repeat(scale), stderr: "" }],
			};
			const id = legacyRow(path, store, `k${i}`, manifest);
			originals.set(id, { row: rowOf(path, id), manifest: canonicalJson(manifest) });
		}
	} finally {
		store.close();
	}
	return originals;
}
/** Every row is either its byte-identical inline original or an externalised form that rehydrates to it. */
function custody(path: string, originals: Map<string, { row: string; manifest: string }>) {
	const db = new Database(path, { readonly: true });
	const results = new ResultStore(`${path}.results`, { readOnly: true });
	let inline = 0;
	let external = 0;
	try {
		for (const { id, data } of db.query("SELECT id, data FROM tasks").all() as { id: string; data: string }[]) {
			const original = originals.get(id)!;
			const row = JSON.parse(data);
			if (Object.hasOwn(row, "resultManifest")) {
				inline++;
				expect(data).toBe(original.row);
			} else {
				external++;
				expect(canonicalJson(results.rehydrate(row.resultExternal))).toBe(original.manifest);
			}
		}
	} finally {
		db.close();
	}
	return { inline, external };
}

test("crash: a process killed at write-half/before-fsync/before-rename/after-rename/after-readback never loses custody and resumes", () => {
	const dir = fixture();
	const seed = join(dir, "seed.sqlite");
	const originals = seedLegacy(seed, 3, 2000);
	const child = join(import.meta.dir, "fixtures", "result-crash-child.ts");
	let killed = 0;
	for (const point of ["write-half", "before-fsync", "before-rename", "after-rename", "after-readback"]) {
		for (const at of [1, 2, 5]) {
			const path = join(dir, `${point}-${at}.sqlite`);
			cpSync(seed, path);
			const run = Bun.spawnSync([process.execPath, child, path], {
				env: { ...process.env, RESULT_POINT: point, RESULT_AT: String(at) },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 60_000,
			});
			expect(run.exitCode).toBe(137);
			expect(run.stdout.toString()).not.toContain("RESULT ");
			killed++;
			const after = custody(path, originals);
			expect(after.inline + after.external).toBe(3);
			expect(after.inline).toBeGreaterThan(0);
			const store = new FleetStore(path);
			try {
				expect(store.migrateResults(true)).toMatchObject({ eligible: after.inline, migrated: after.inline, failed: [] });
				expect(store.migrateResults(true)).toMatchObject({ eligible: 0, failed: [] });
				expect(custody(path, originals)).toEqual({ inline: 0, external: 3 });
				const inventory = store.resultInventory();
				expect(inventory).toMatchObject({ missing: [], corrupt: [], unknown: [] });
				store.collectResults(true);
				for (const [id, original] of originals) expect(canonicalJson(store.task(id)!.resultManifest)).toBe(original.manifest);
				expect(store.resultInventory()).toMatchObject({ unreferenced: [], temporary: [] });
			} finally {
				store.close();
			}
		}
	}
	expect(killed).toBe(15);
}, 240_000);

test("concurrency: three migrators on one database and eight same-content publishers", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const originals = seedLegacy(path, 12, 20000);
	const storeModule = new URL("../src/store.ts", import.meta.url).href;
	const migrate = `const { FleetStore } = await import(${JSON.stringify(storeModule)}); const s = new FleetStore(process.argv[1]); console.log(JSON.stringify(s.migrateResults(true))); s.close();`;
	const migrators = Array.from({ length: 3 }, () =>
		Bun.spawn([process.execPath, "-e", migrate, path], { stdout: "pipe", stderr: "pipe" }),
	);
	let migrated = 0;
	for (const child of migrators) {
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(stderr).toBe("");
		expect(exit).toBe(0);
		const report = JSON.parse(stdout);
		expect(report.failed).toEqual([]);
		migrated += report.migrated;
	}
	// Each row is counted exactly once across all migrators.
	expect(migrated).toBe(12);
	expect(custody(path, originals)).toEqual({ inline: 0, external: 12 });

	const publishDir = join(dir, "publish");
	const resultModule = new URL("../src/result-store.ts", import.meta.url).href;
	const publish = `const { ResultStore } = await import(${JSON.stringify(resultModule)}); new ResultStore(process.argv[1]).externalise({ patch: "Q".repeat(3000000), files: [{ contentBase64: "R".repeat(2000000) }] });`;
	const publishers = Array.from({ length: 8 }, () =>
		Bun.spawn([process.execPath, "-e", publish, publishDir], { stdout: "pipe", stderr: "pipe" }),
	);
	for (const child of publishers) {
		const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		expect(stderr).toBe("");
		expect(exit).toBe(0);
	}
	expect(readdirSync(publishDir).sort()).toEqual([hash("Q".repeat(3000000)), hash("R".repeat(2000000))].sort());
}, 120_000);

test("CLI: migrate results dry-run/apply, results check and gc report JSON with failure exit codes", async () => {
	const { cli } = await import("../src/cli");
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const legacy = legacyRow(path, store, "legacy", { patch: "+l\n".repeat(2000) });
	store.close();
	const before = rowOf(path, legacy);
	const logs: string[] = [];
	const originalLog = console.log;
	const run = async (...argv: string[]) => {
		logs.length = 0;
		console.log = (...args: unknown[]) => void logs.push(args.join(" "));
		try {
			const exit = await cli(["--db", path, ...argv]);
			return { exit, json: JSON.parse(logs.join("\n")) };
		} finally {
			console.log = originalLog;
		}
	};
	const dry = await run("migrate", "results");
	expect(dry).toMatchObject({ exit: 0, json: { ok: true, dryRun: true, externalisation: "off", eligible: 1, migrated: 0 } });
	expect(rowOf(path, legacy)).toBe(before);
	// Off by default: --apply is refused until the audited switch, and nothing changes.
	let off: unknown;
	await cli(["--db", path, "migrate", "results", "--apply"]).catch((error) => (off = error));
	expect((off as { code?: string })?.code).toBe("RESULT_STORE_OFF");
	expect(rowOf(path, legacy)).toBe(before);
	expect(fenceOf(path)).toEqual(unfenced);
	expect(await run("results", "status")).toMatchObject({ exit: 0, json: { ok: true, externalisation: "off", userVersion: 2, features: [], inlineResults: 1, externalResults: 0 } });
	for (const argv of [
		["results", "enable"],
		["results", "enable", "--reason", "x"],
		["results", "enable", "--confirm-one-way"],
		["results", "enable", "--confirm-one-way", "--reason"],
		["results", "enable", "--confirm-one-way", "--reason", ""],
		["results", "enable", "--confirm-one-way", "--reason", "x", "extra"],
	]) {
		let failure: unknown;
		await cli(["--db", path, ...argv]).catch((error) => (failure = error));
		expect(String((failure as Error)?.message)).toBe("usage_results_enable_--confirm-one-way_--reason_TEXT");
	}
	let readOnlyEnable: unknown;
	await cli(["--read-only", "--db", path, "results", "enable", "--confirm-one-way", "--reason", "x"]).catch((error) => (readOnlyEnable = error));
	expect(String((readOnlyEnable as Error)?.message)).toBe("READ_ONLY");
	expect(fenceOf(path)).toEqual(unfenced);
	expect(await run("results", "enable", "--confirm-one-way", "--reason", "CHG-1: shrink the hub database")).toMatchObject({
		exit: 0,
		json: { ok: true, enabled: true, changed: true, userVersion: 2, oneWayStepTaken: false },
	});
	expect(fenceOf(path)).toEqual(armed);
	expect(rowOf(path, legacy)).toBe(before);
	expect(await run("results", "enable", "--confirm-one-way", "--reason", "again")).toMatchObject({ exit: 0, json: { changed: false } });
	// disable: --reason TEXT only; then on again.
	for (const argv of [["results", "disable"], ["results", "disable", "--reason"], ["results", "disable", "--reason", ""], ["results", "disable", "x"], ["results", "disable", "--reason", "x", "extra"]]) {
		let failure: unknown;
		await cli(["--db", path, ...argv]).catch((error) => (failure = error));
		expect(String((failure as Error)?.message)).toBe("usage_results_disable_--reason_TEXT");
	}
	let readOnlyDisable: unknown;
	await cli(["--read-only", "--db", path, "results", "disable", "--reason", "x"]).catch((error) => (readOnlyDisable = error));
	expect(String((readOnlyDisable as Error)?.message)).toBe("READ_ONLY");
	expect(fenceOf(path)).toEqual(armed);
	expect(await run("results", "disable", "--reason", "CHG-1 postponed")).toMatchObject({ exit: 0, json: { ok: true, enabled: false, changed: true, userVersion: 2, oneWayStepTaken: false } });
	expect(fenceOf(path)).toEqual(unfenced);
	expect(await run("results", "status")).toMatchObject({ exit: 0, json: { externalisation: "off", userVersion: 2, oneWayStepTaken: false } });
	expect(await run("results", "enable", "--confirm-one-way", "--reason", "CHG-1: shrink the hub database")).toMatchObject({ exit: 0, json: { changed: true } });
	const status = await run("results", "status");
	expect(status).toMatchObject({ exit: 0, json: { externalisation: "on", userVersion: 2, features: [], oneWayStepTaken: false, inlineResults: 1, enabledBy: "operator", reason: "CHG-1: shrink the hub database" } });
	const ro = await (async () => {
		logs.length = 0;
		console.log = (...args: unknown[]) => void logs.push(args.join(" "));
		try {
			return { exit: await cli(["--read-only", "--db", path, "results", "status"]), json: JSON.parse(logs.join("\n")) };
		} finally {
			console.log = originalLog;
		}
	})();
	expect(ro).toEqual(status);
	expect(await run("migrate", "results", "--apply")).toMatchObject({ exit: 0, json: { ok: true, externalisation: "on", migrated: 1 } });
	// The first migrated row took the one-way step in its own transaction.
	expect(fenceOf(path)).toEqual(fencedWith(1));
	expect(await run("results", "status")).toMatchObject({ exit: 0, json: { externalisation: "on", userVersion: 3, features: [FEATURE], oneWayStepTaken: true, externalResults: 1 } });
	expect(await run("migrate", "results", "--apply")).toMatchObject({ exit: 0, json: { eligible: 0 } });
	expect(await run("results", "check")).toMatchObject({ exit: 0, json: { ok: true, missing: [], corrupt: [] } });
	for (const blob of readdirSync(`${path}.results`)) rmSync(join(`${path}.results`, blob), { recursive: true });
	const broken = await run("results", "check");
	expect(broken.exit).toBe(1);
	expect(broken.json.ok).toBe(false);
	expect(broken.json.missing[0].taskIds).toEqual([legacy]);
	for (const argv of [["migrate", "results", "--bogus"], ["migrate", "other"], ["results", "gc", "--force"], ["results"]]) {
		let failure: unknown;
		await cli(["--db", path, ...argv]).catch((error) => (failure = error));
		expect(String((failure as Error)?.message)).toMatch(/^usage_/);
	}
});

// ---------------------------------------------------------------------------
// Read-only mode never writes.

test("read-only: reads and checks work; migrate --apply, gc --apply, backup and writes are refused without touching .results", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const id = running(store);
	const m = { patch: "p".repeat(5000), status: "x" };
	store.saveResult(id, m as any);
	legacyRow(path, store, "legacy", { patch: "l".repeat(5000) });
	store.close();
	const listing = () => readdirSync(`${path}.results`).sort().join();
	const before = listing();
	const ro = new FleetStore(path, 2, { readOnly: true });
	try {
		expect(ro.task(id)!.resultManifest).toStrictEqual(m);
		expect(ro.migrateResults()).toMatchObject({ dryRun: true, eligible: 1 });
		expect(ro.resultInventory().missing).toEqual([]);
		expect(ro.collectResults()).toMatchObject({ dryRun: true });
		for (const fn of [() => ro.migrateResults(true), () => ro.collectResults(true), () => ro.backup(join(dir, "x.sqlite"))])
			expect(code(fn)).toBe("READ_ONLY");
		expect(listing()).toBe(before);
	} finally {
		ro.close();
	}
	// A read-only store with no result directory reports integrity errors and never creates it.
	// M1: the copy must be a self-contained database. A main file alone is not one on every
	// platform: with Apple's system SQLite (bun on macOS) the closed WAL database keeps its
	// -wal/-shm and a read-only open of a main-only copy is SQLITE_CANTOPEN; bun's bundled
	// SQLite on Windows/Linux deletes them on close and opens the copy. So the closed (fully
	// checkpointed: empty or absent WAL) main file is copied and switched to DELETE mode first.
	expect(existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0).toBe(0);
	cpSync(path, join(dir, "moved.sqlite"));
	const normalise = new Database(join(dir, "moved.sqlite"));
	try {
		expect((normalise.query("PRAGMA journal_mode=DELETE").get() as { journal_mode: string }).journal_mode).toBe("delete");
	} finally {
		normalise.close();
	}
	const moved = new FleetStore(join(dir, "moved.sqlite"), 2, { readOnly: true });
	try {
		expect(code(() => moved.task(id))).toBe("RESULT_INTEGRITY");
		expect(moved.resultInventory().missing.length).toBe(1);
		expect(existsSync(join(dir, "moved.sqlite.results"))).toBe(false);
	} finally {
		moved.close();
	}
	const { cli } = await import("../src/cli");
	for (const argv of [
		["--read-only", "--db", path, "migrate", "results", "--apply"],
		["--read-only", "--db", path, "results", "gc", "--apply"],
	]) {
		let failure: unknown;
		await cli(argv).catch((error) => (failure = error));
		expect(String((failure as Error)?.message)).toBe("READ_ONLY");
	}
	expect(listing()).toBe(before);
});

// ---------------------------------------------------------------------------
// Migration ladder and format fence (production main 52374c9 is ladder v2).
// user_version is owned by the ladder; fleet_meta.schema_version equals it.
// v2 -> v3 (fleet_features, must-understand rows) is applied only in the
// write transaction that commits the first externalised result row, and only
// while the operator switch (table result_externalisation, ignored by v2 code)
// is on. Code that knows only v1/v2 (52374c9, 0289d27, 34d0622) refuses v3 at
// open, read-only included, and opens an armed v2 database unchanged.

const FEATURE = "result-store-v1";
function fenceOf(path: string) {
	const db = new Database(path, { readonly: true });
	try {
		const userVersion = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
		const meta = (db.query("SELECT schema_version FROM fleet_meta WHERE id=1").get() as { schema_version: number } | null)?.schema_version ?? null;
		const table = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_features'").get());
		const features = table
			? (db.query("SELECT name FROM fleet_features ORDER BY name").all() as { name: string }[]).map((row) => row.name)
			: [];
		const trigger = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='archived_phase_fence'").get());
		const rows = db.query("SELECT data FROM tasks").all() as { data: string }[];
		const external = rows.filter((row) => Object.hasOwn(JSON.parse(row.data), "resultExternal")).length;
		const switchOn = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='result_externalisation'").get()) &&
			Boolean(db.query("SELECT 1 FROM result_externalisation WHERE id=1").get());
		return { userVersion, meta, table, features, trigger, external, switchOn };
	} finally {
		db.close();
	}
}
/** Production ladder v2, switch off: what 34d0622 writes. */
const unfenced = { userVersion: 2, meta: 2, table: false, features: [], trigger: true, external: 0, switchOn: false };
/** Switch on, no externalised row yet: still production ladder v2 (plus the ignored switch table). */
const armed = { ...unfenced, switchOn: true };
/** After the one-way step; switchOn true unless disabled again. */
const fencedWith = (external: number, switchOn = true) => ({ userVersion: 3, meta: 3, table: true, features: [FEATURE], trigger: true, external, switchOn });
function journalMode(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		return (db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
	} finally {
		db.close();
	}
}
/**
 * Main file bytes plus the WAL content: every byte a refused open could have
 * changed. An empty WAL is no content (a read-only SQLite connection to a
 * WAL-mode database may leave a zero-length -wal sidecar it cannot remove).
 */
const imageOf = (path: string) => {
	const wal = existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`) : Buffer.alloc(0);
	return hash(readFileSync(path)) + (wal.length ? hash(wal) : "");
};
function refusal(fn: () => unknown): { code?: string; message: string } | "ok" {
	try {
		fn();
		return "ok";
	} catch (error) {
		return { code: (error as { code?: string }).code, message: String((error as Error).message) };
	}
}

test("ladder: a fresh database is production v2 without features; opening never raises the version", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	new FleetStore(path).close();
	expect(fenceOf(path)).toEqual(unfenced);
	for (const readOnly of [true, false, true]) {
		new FleetStore(path, 2, { readOnly }).close();
		expect(fenceOf(path)).toEqual(unfenced);
	}
});

test("off by default: deploy and normal use never move the ladder; results are saved inline exactly as before", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const legacy = { patch: "l".repeat(5000), status: "verified" };
	const large = largeManifest();
	let id: string;
	let legacyId: string;
	try {
		id = running(store);
		legacyId = legacyRow(path, store, "legacy", legacy);
		store.submit(input("queued") as any);
		// The first (and every) result saved by this build stays inline while the switch is off.
		store.saveResult(id, large as any);
		// Exactly the row code without this feature writes: canonicalJson(task), nothing else.
		expect(rowOf(path, id)).toBe(canonicalJson(store.task(id) as any));
		expect(JSON.parse(rowOf(path, id)).resultManifest).toStrictEqual(large);
		expect(store.migrateResults()).toMatchObject({ dryRun: true, externalisation: "off", eligible: 2 });
		expect(code(() => store.migrateResults(true))).toBe("RESULT_STORE_OFF");
		expect(store.collectResults(true)).toMatchObject({ dryRun: false, removed: [] });
		expect(store.resultStoreStatus()).toMatchObject({ externalisation: "off", userVersion: 2, inlineResults: 2, externalResults: 0 });
	} finally {
		store.close();
	}
	expect(fenceOf(path)).toEqual(unfenced);
	expect(existsSync(`${path}.results`)).toBe(false);
	for (const readOnly of [true, false]) {
		const reopened = new FleetStore(path, 2, { readOnly });
		try {
			expect(reopened.task(legacyId)!.resultManifest).toStrictEqual(legacy);
			expect(reopened.task(id)!.resultManifest).toStrictEqual(large);
			expect(reopened.tasks().length).toBe(3);
			expect(reopened.taskStates().length).toBe(3);
			expect(reopened.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
			expect(reopened.collectResults()).toMatchObject({ dryRun: true, removable: [] });
		} finally {
			reopened.close();
		}
		expect(fenceOf(path)).toEqual(unfenced);
	}
	const writer = new FleetStore(path);
	try {
		expect(writer.reserve(legacyId).phase).toBe("preparing");
		expect(JSON.parse(rowOf(path, legacyId)).resultManifest).toStrictEqual(legacy);
		const queued = writer.taskStates().find((task) => task.input.key === "queued")!;
		expect(writer.reserve(queued.id).phase).toBe("preparing");
		writer.recordSession(queued.id, "session-queued");
		writer.backup(join(dir, "pre-switch-backup.sqlite"));
		expect(fenceOf(path)).toEqual(unfenced);
		expect(fenceOf(join(dir, "pre-switch-backup.sqlite"))).toEqual(unfenced);
		// I-B: no externalised result in the snapshot, so no result directory either.
		expect(existsSync(join(dir, "pre-switch-backup.sqlite.results"))).toBe(false);
	} finally {
		writer.close();
	}
});

test("switch: enable arms, the first externalised row's transaction takes the one-way step; audited, atomic, idempotent; inline rows stay until migrate --apply", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const legacy = { patch: "l".repeat(5000), status: "verified" };
	try {
		const id = running(store);
		const legacyId = legacyRow(path, store, "legacy", legacy);
		const inlineRow = rowOf(path, legacyId);
		for (const bad of [{}, { actor: "a" }, { actor: "a", reason: " " }, { actor: "", reason: "r" }, { actor: "a", reason: "r".repeat(1001) }]) {
			expect(code(() => store.enableResultStore(bad as any))).toBe("INVALID_INPUT");
			expect(code(() => store.disableResultStore(bad as any))).toBe("INVALID_INPUT");
		}
		expect(fenceOf(path)).toEqual(unfenced);
		const enabled = store.enableResultStore({ actor: "operator-a", reason: "CHG-7 shrink" });
		expect(enabled).toEqual({ enabled: true, changed: true, userVersion: 2, oneWayStepTaken: false });
		// Enabling alone changes no ladder version: still production v2, nothing externalised.
		expect(fenceOf(path)).toEqual(armed);
		expect(rowOf(path, legacyId)).toBe(inlineRow);
		const audit = new Database(path, { readonly: true });
		try {
			const events = audit.query("SELECT task_id, data FROM audit WHERE kind='result_store_enabled'").all() as { task_id: string | null; data: string }[];
			expect(events.length).toBe(1);
			expect(events[0]!.task_id).toBeNull();
			expect(JSON.parse(events[0]!.data)).toMatchObject({ actor: "operator-a", reason: "CHG-7 shrink", userVersion: 2, feature: FEATURE, inlineResults: 1, externalResults: 0, oneWayStepTaken: false, oneWayAt: "first externalised row" });
		} finally {
			audit.close();
		}
		expect(store.enableResultStore({ actor: "operator-b", reason: "again" })).toEqual({ enabled: true, changed: false, userVersion: 2, oneWayStepTaken: false });
		expect(store.resultStoreStatus()).toMatchObject({ externalisation: "on", userVersion: 2, features: [], oneWayStepTaken: false, inlineResults: 1, externalResults: 0, enabledBy: "operator-a", reason: "CHG-7 shrink" });
		// An inline result stays inline and never steps the ladder, switch on or not.
		expect(store.reserve(legacyId).phase).toBe("preparing");
		expect(rowOf(path, legacyId)).not.toBe(inlineRow);
		expect(JSON.parse(rowOf(path, legacyId)).resultManifest).toStrictEqual(legacy);
		expect(fenceOf(path)).toEqual(armed);
		// The first externalised row: the step and the row commit in one transaction.
		store.saveResult(id, { patch: "n".repeat(5000), status: "verified" });
		expect(fenceOf(path)).toEqual(fencedWith(1));
		const steps = new Database(path, { readonly: true });
		try {
			const events = steps.query("SELECT task_id, data FROM audit WHERE kind='result_store_format_step'").all() as { task_id: string | null; data: string }[];
			expect(events.length).toBe(1);
			expect(events[0]!.task_id).toBeNull();
			expect(JSON.parse(events[0]!.data)).toMatchObject({ fromVersion: 2, toVersion: 3, feature: FEATURE, firstTaskId: id, by: "save", enabledBy: "operator-a", reason: "CHG-7 shrink", oneWay: true });
		} finally {
			steps.close();
		}
		expect(store.resultStoreStatus()).toMatchObject({ externalisation: "on", userVersion: 3, features: [FEATURE], oneWayStepTaken: true, inlineResults: 1, externalResults: 1 });
		// fleet_meta's CHECK moved with the step: the row can no longer be set back to 2.
		const raw = new Database(path);
		try {
			expect(() => raw.exec("UPDATE fleet_meta SET schema_version=2")).toThrow();
		} finally {
			raw.close();
		}
		expect(JSON.parse(rowOf(path, legacyId)).resultManifest).toStrictEqual(legacy);
		expect(store.migrateResults(true)).toMatchObject({ externalisation: "on", eligible: 1, migrated: 1, failed: [] });
		expect(fenceOf(path)).toEqual(fencedWith(2));
		expect(store.task(legacyId)!.resultManifest).toStrictEqual(legacy);
		expect(store.enableResultStore({ actor: "operator-b", reason: "again" })).toEqual({ enabled: true, changed: false, userVersion: 3, oneWayStepTaken: true });
	} finally {
		store.close();
	}
	const ro = new FleetStore(path, 2, { readOnly: true });
	try {
		expect(code(() => ro.enableResultStore({ actor: "a", reason: "r" }))).toBe("READ_ONLY");
		expect(code(() => ro.disableResultStore({ actor: "a", reason: "r" }))).toBe("READ_ONLY");
		expect(ro.resultStoreStatus().externalisation).toBe("on");
	} finally {
		ro.close();
	}
	expect(fenceOf(path)).toEqual(fencedWith(2));
	// A rolled-back switch leaves v2 with nothing changed.
	const other = join(dir, "other.sqlite");
	const second = new FleetStore(other);
	try {
		const raw = new Database(other);
		raw.exec("CREATE TRIGGER refuse BEFORE INSERT ON audit WHEN NEW.kind='result_store_enabled' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
		raw.close();
		expect(code(() => second.enableResultStore({ actor: "a", reason: "r" }))).not.toBe("ok");
		expect(fenceOf(other)).toEqual(unfenced);
		expect(second.resultStoreStatus().externalisation).toBe("off");
	} finally {
		second.close();
	}
	// A rolled-back first externalised save leaves the armed v2 database unchanged.
	const third = join(dir, "third.sqlite");
	const armedStore = onStore(third);
	try {
		const tid = running(armedStore);
		const raw = new Database(third);
		raw.exec("CREATE TRIGGER refuse BEFORE INSERT ON audit WHEN NEW.kind='result_store_format_step' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
		raw.close();
		const before = rowOf(third, tid);
		expect(code(() => armedStore.saveResult(tid, { patch: "z".repeat(5000) }))).not.toBe("ok");
		expect(fenceOf(third)).toEqual(armed);
		expect(rowOf(third, tid)).toBe(before);
	} finally {
		armedStore.close();
	}
});

test("switch off: disable before the step leaves plain production v2; after the step new results are inline, externalised rows stay readable, v3 stays", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	try {
		const a = running(store, "a");
		const b = running(store, "b");
		const c = running(store, "c");
		const schema = () => {
			const db = new Database(path, { readonly: true });
			try {
				return db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
			} finally {
				db.close();
			}
		};
		const pristine = schema();
		expect(store.disableResultStore({ actor: "op", reason: "noop" })).toEqual({ enabled: false, changed: false, userVersion: 2, oneWayStepTaken: false });
		enable(store);
		expect(fenceOf(path)).toEqual(armed);
		expect(store.disableResultStore({ actor: "op", reason: "back out" })).toEqual({ enabled: false, changed: true, userVersion: 2, oneWayStepTaken: false });
		// Every trace but the audit events is gone: the schema is the production v2 schema again.
		expect(fenceOf(path)).toEqual(unfenced);
		expect(schema()).toEqual(pristine);
		store.saveResult(a, { patch: "a".repeat(5000) });
		expect(fenceOf(path)).toEqual(unfenced);
		expect(rowOf(path, a)).toBe(canonicalJson(store.task(a) as any));
		expect(code(() => store.migrateResults(true))).toBe("RESULT_STORE_OFF");
		// On again, the next externalised row steps; off again keeps v3 and that row readable.
		enable(store);
		store.saveResult(b, { patch: "b".repeat(5000) });
		expect(fenceOf(path)).toEqual(fencedWith(1));
		expect(store.disableResultStore({ actor: "op", reason: "inline again" })).toEqual({ enabled: false, changed: true, userVersion: 3, oneWayStepTaken: true });
		expect(fenceOf(path)).toEqual(fencedWith(1, false));
		store.saveResult(c, { patch: "c".repeat(5000) });
		expect(JSON.parse(rowOf(path, c)).resultManifest).toStrictEqual({ patch: "c".repeat(5000) });
		expect(JSON.parse(rowOf(path, b)).resultExternal).toBeDefined();
		// State writes on the externalised task keep its stored form (no re-inlining, no conflict).
		const stored = JSON.parse(rowOf(path, b)).resultExternal;
		expect(store.beginObservation(b)).toBe(1);
		const other = new FleetStore(path);
		try {
			// Another instance keeps it too.
			expect(other.beginObservation(b)).toBe(2);
		} finally {
			other.close();
		}
		expect(JSON.parse(rowOf(path, b))).toMatchObject({ pollIssued: 2, resultExternal: stored });
		expect(Object.hasOwn(JSON.parse(rowOf(path, b)), "resultManifest")).toBe(false);
		expect(fenceOf(path)).toEqual(fencedWith(1, false));
		expect(store.migrateResults()).toMatchObject({ dryRun: true, externalisation: "off", eligible: 2, alreadyExternal: 0 });
		expect(code(() => store.migrateResults(true))).toBe("RESULT_STORE_OFF");
		expect(store.resultStoreStatus()).toMatchObject({ externalisation: "off", userVersion: 3, oneWayStepTaken: true, inlineResults: 2, externalResults: 1 });
		expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
		const events = store.events(a).length;
		expect(events).toBeGreaterThan(0);
	} finally {
		store.close();
	}
	for (const readOnly of [true, false]) {
		const reopened = new FleetStore(path, 2, { readOnly });
		try {
			expect(reopened.tasks().map((task) => task.resultManifest)).toEqual([{ patch: "a".repeat(5000) }, { patch: "b".repeat(5000) }, { patch: "c".repeat(5000) }]);
		} finally {
			reopened.close();
		}
	}
	const audit = new Database(path, { readonly: true });
	try {
		expect((audit.query("SELECT kind FROM audit WHERE task_id IS NULL AND kind LIKE 'result_store_%' ORDER BY sequence").all() as { kind: string }[]).map((row) => row.kind)).toEqual([
			"result_store_enabled",
			"result_store_disabled",
			"result_store_enabled",
			"result_store_format_step",
			"result_store_disabled",
		]);
	} finally {
		audit.close();
	}
});

test("ladder: a legacy v1 database is upgraded to v2 by a writable open, read as v1 read-only, and moved to v3 only by the first externalised row after the switch", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const id = running(store);
	store.close();
	const raw = new Database(path);
	raw.exec(`DROP TRIGGER archived_phase_fence;
		ALTER TABLE fleet_meta RENAME TO fleet_meta_v2;
		CREATE TABLE fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1), global_cap INTEGER NOT NULL CHECK(global_cap>0));
		INSERT INTO fleet_meta SELECT id,1,global_cap FROM fleet_meta_v2; DROP TABLE fleet_meta_v2; PRAGMA user_version=1;`);
	raw.close();
	const ro = new FleetStore(path, 2, { readOnly: true });
	try {
		expect(ro.task(id)!.phase).toBe("preparing");
		expect(code(() => ro.enableResultStore({ actor: "a", reason: "r" }))).toBe("READ_ONLY");
	} finally {
		ro.close();
	}
	expect(fenceOf(path)).toMatchObject({ userVersion: 1, meta: 1, table: false, trigger: false });
	const rw = new FleetStore(path);
	try {
		expect(fenceOf(path)).toEqual(unfenced);
		rw.saveResult(id, { patch: "v".repeat(5000) });
		expect(fenceOf(path)).toEqual(unfenced);
		enable(rw);
		expect(fenceOf(path)).toEqual(armed);
		expect(rw.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
		expect(fenceOf(path)).toEqual(fencedWith(1));
	} finally {
		rw.close();
	}
});

test("fence: a refused save or a lost migration update after the switch leaves no externalised row, no ladder step and the row byte-identical", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		const legacyId = legacyRow(path, store, "legacy", { patch: "l".repeat(5000) });
		const legacyBefore = rowOf(path, legacyId);
		const raw = new Database(path);
		raw.exec("CREATE TRIGGER refuse BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'refused'); END;");
		raw.close();
		const before = rowOf(path, id);
		expect(code(() => store.saveResult(id, { patch: "x".repeat(5000) }))).not.toBe("ok");
		expect(rowOf(path, id)).toBe(before);
		expect(fenceOf(path)).toEqual(armed);
		const ignore = new Database(path);
		ignore.exec("DROP TRIGGER refuse; CREATE TRIGGER skip BEFORE UPDATE ON tasks BEGIN SELECT RAISE(IGNORE); END;");
		ignore.close();
		expect(store.migrateResults(true)).toMatchObject({ migrated: 0, failed: [{ taskId: legacyId, code: "MIGRATION_NOT_APPLIED" }] });
		expect(rowOf(path, legacyId)).toBe(legacyBefore);
		expect(fenceOf(path)).toEqual(armed);
		const drop = new Database(path);
		drop.exec("DROP TRIGGER skip");
		drop.close();
		expect(store.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
		store.saveResult(id, { patch: "x".repeat(5000) });
		expect(fenceOf(path)).toEqual(fencedWith(2));
		// Garbage published by the refused attempts is only unreferenced, never a row.
		expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
	} finally {
		store.close();
	}
});

test("fence: unknown features, foreign versions and inconsistent ladder states are refused before any file change, read-only included", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const id = running(store);
	store.saveResult(id, { patch: "f".repeat(5000) });
	store.close();
	const recreateMeta = (version: number) =>
		`ALTER TABLE fleet_meta RENAME TO m_old; CREATE TABLE fleet_meta (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL, global_cap INTEGER NOT NULL CHECK(global_cap>0)); INSERT INTO fleet_meta SELECT id,${version},global_cap FROM m_old; DROP TABLE m_old;`;
	const variant = (name: string, sql: string) => {
		const copy = join(dir, `${name}.sqlite`);
		cpSync(path, copy);
		for (const side of ["-wal", "-shm"]) if (existsSync(`${path}${side}`)) cpSync(`${path}${side}`, `${copy}${side}`);
		cpSync(`${path}.results`, `${copy}.results`, { recursive: true });
		const db = new Database(copy);
		db.exec(sql);
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		db.close();
		return copy;
	};
	const refuse = (copy: string, message: string) => {
		for (const readOnly of [true, false]) {
			const before = imageOf(copy);
			const failure = refusal(() => new FleetStore(copy, 2, { readOnly }).close());
			expect(failure).toMatchObject({ code: "SCHEMA_VERSION" });
			expect((failure as { message: string }).message).toContain(message);
			expect(imageOf(copy)).toBe(before);
		}
	};
	refuse(variant("future", "INSERT INTO fleet_features(name) VALUES ('future-feature')"), "future-feature");
	refuse(variant("case", "INSERT INTO fleet_features(name) VALUES ('RESULT-STORE-V1')"), "RESULT-STORE-V1");
	refuse(variant("v4", "PRAGMA user_version=4"), "Unsupported database schemaVersion");
	refuse(variant("vmax", "PRAGMA user_version=2147483647"), "Unsupported database schemaVersion");
	refuse(variant("vneg", "PRAGMA user_version=-1"), "Unsupported database schemaVersion");
	refuse(variant("meta2", recreateMeta(2)), "schemaVersion or global cap");
	refuse(variant("lowered", "PRAGMA user_version=2"), "format");
	refuse(variant("notable", "DROP TABLE fleet_features"), "format");
	refuse(variant("v1features", `${recreateMeta(1)} PRAGMA user_version=1`), "format");
	// The row-form triggers are part of result-store-v1 (L2): without them the format is incomplete.
	refuse(variant("notrigger", "DROP TRIGGER result_form_fence_update"), "row-form triggers");
	refuse(variant("noinserttrigger", "DROP TRIGGER result_form_fence_insert"), "row-form triggers");
	// A fully stripped fence (table dropped, ladder reset to 2) opens as v2, but an externalised
	// row in it is an integrity failure, never "no result" (needs write access to forge).
	const stripped = variant("stripped", `DROP TABLE fleet_features; ${recreateMeta(2)} PRAGMA user_version=2;`);
	for (const readOnly of [true, false]) {
		const reopened = new FleetStore(stripped, 2, { readOnly });
		try {
			expect(code(() => reopened.task(id))).toBe("RESULT_INTEGRITY");
			expect(() => reopened.task(id)).toThrow("format fence");
			expect(reopened.taskStates().length).toBe(1);
		} finally {
			reopened.close();
		}
	}
});

test("L2: a refused writable open never chmods or converts a DELETE-mode database to WAL", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const id = running(store);
	store.saveResult(id, { patch: "d".repeat(5000) });
	const backup = join(dir, "backup.sqlite");
	store.backup(backup);
	store.close();
	expect(journalMode(backup)).toBe("delete");
	const raw = new Database(backup);
	raw.exec("INSERT INTO fleet_features(name) VALUES ('archive-v9')");
	raw.close();
	expect(journalMode(backup)).toBe("delete");
	const before = readFileSync(backup);
	for (const readOnly of [false, true]) {
		const failure = refusal(() => new FleetStore(backup, 2, { readOnly }).close());
		expect(failure).toMatchObject({ code: "SCHEMA_VERSION" });
		expect((failure as { message: string }).message).toContain("archive-v9");
		expect(Buffer.compare(readFileSync(backup), before)).toBe(0);
		expect(existsSync(`${backup}-wal`)).toBe(false);
		expect(journalMode(backup)).toBe("delete");
	}
	// The same backup without the unknown feature opens normally (and only then becomes WAL).
	const good = join(dir, "good.sqlite");
	const store2 = new FleetStore(path);
	store2.backup(good);
	store2.close();
	const opened = new FleetStore(good);
	try {
		expect(opened.task(id)!.resultManifest).toStrictEqual({ patch: "d".repeat(5000) });
	} finally {
		opened.close();
	}
	expect(journalMode(good)).toBe("wal");
});

test("L1: an open validates the fence from one snapshot while another process commits the switch and the first externalisation", () => {
	for (const readOnly of [true, false]) {
		const dir = fixture();
		const path = join(dir, "fleet.sqlite");
		const writer = new FleetStore(path);
		const id = running(writer);
		const original = Database.prototype.query;
		let armed = true;
		let committed = false;
		// Right after the opening store's first fence read (PRAGMA user_version),
		// the writer commits the ladder step and the first externalised row.
		Database.prototype.query = function (this: Database, sql: string) {
			const statement = (original as any).call(this, sql);
			if (armed && sql === "PRAGMA user_version") {
				armed = false;
				const get = statement.get.bind(statement);
				// bun caches the statement: only its first execution triggers the writer.
				statement.get = (...args: unknown[]) => {
					const value = get(...args);
					if (!committed) {
						enable(writer);
						writer.saveResult(id, { patch: "r".repeat(5000) });
						committed = true;
					}
					return value;
				};
			}
			return statement;
		} as typeof original;
		let opened: FleetStore | undefined;
		try {
			const outcome = refusal(() => (opened = new FleetStore(path, 2, { readOnly })));
			expect(outcome).toBe("ok");
		} finally {
			Database.prototype.query = original;
		}
		expect(committed).toBe(true);
		try {
			expect(opened!.task(id)!.resultManifest).toStrictEqual({ patch: "r".repeat(5000) });
		} finally {
			opened?.close();
			writer.close();
		}
		expect(fenceOf(path)).toEqual(fencedWith(1));
	}
});

test("switch and first externalisation: a kill before or after every fs/SQLite step leaves v2 (off or armed) unchanged or, only once a row is externalised, a consistent v3; never a partial state", () => {
	const dir = fixture();
	const child = join(import.meta.dir, "fixtures", "result-crash-child.ts");
	// enable: a production-shaped v2 database (inline results, a running task), switch off.
	const enableSeed = join(dir, "enable-seed.sqlite");
	const inlineOriginals = seedLegacy(enableSeed, 2, 2000, false);
	// save / migrate: the switch is on but nothing is externalised yet (armed, still v2): the first
	// externalising save, and migration, each take the one-way step in their own transaction.
	const migrateSeed = join(dir, "migrate-seed.sqlite");
	const originals = seedLegacy(migrateSeed, 2, 2000);
	const saveSeed = join(dir, "save-seed.sqlite");
	const seeded = onStore(saveSeed);
	const taskId = running(seeded);
	seeded.close();
	expect(fenceOf(enableSeed)).toEqual(unfenced);
	expect(fenceOf(migrateSeed)).toEqual(armed);
	expect(fenceOf(saveSeed)).toEqual(armed);
	const eventsOf = (path: string, kind: string) => {
		const db = new Database(path, { readonly: true });
		try {
			return (db.query("SELECT COUNT(*) AS n FROM audit WHERE kind=?").get(kind) as { n: number }).n;
		} finally {
			db.close();
		}
	};
	const enabledEvents = (path: string) => eventsOf(path, "result_store_enabled");
	const stepEvents = (path: string) => eventsOf(path, "result_store_format_step");
	const summary: Record<string, { steps: number; before: number; after: number; firstAfter: number }> = {};
	for (const mode of ["enable", "save", "migrate"]) {
		const seed = mode === "enable" ? enableSeed : mode === "save" ? saveSeed : migrateSeed;
		const task = taskId;
		const dry = join(dir, `${mode}-count.sqlite`);
		cpSync(seed, dry);
		const counted = Bun.spawnSync([process.execPath, child, dry, task], {
			env: { ...process.env, RESULT_MODE: mode, RESULT_POINT: "none", RESULT_STEP: "0" },
			stdout: "pipe",
			stderr: "pipe",
			timeout: 60_000,
		});
		expect(counted.exitCode).toBe(0);
		const steps = Number(/STEPS (\d+)/.exec(counted.stdout.toString())?.[1]);
		expect(steps).toBeGreaterThan(mode === "enable" ? 4 : 20);
		const entry = { steps, before: 0, after: 0, firstAfter: 0 };
		for (let k = 1; k <= steps; k++) {
			const path = join(dir, `${mode}-${k}.sqlite`);
			cpSync(seed, path);
			const run = Bun.spawnSync([process.execPath, child, path, task], {
				env: { ...process.env, RESULT_MODE: mode, RESULT_POINT: "none", RESULT_STEP: String(k) },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 60_000,
			});
			expect(`${mode}/${k}:${run.exitCode}`).toBe(`${mode}/${k}:137`);
			const after = fenceOf(path);
			let done: boolean;
			if (mode === "enable") {
				done = after.switchOn;
				// Either nothing happened or the whole switch; enabling never steps the ladder.
				expect(after).toEqual(done ? armed : unfenced);
				expect(enabledEvents(path)).toBe(done ? 1 : 0);
				expect(stepEvents(path)).toBe(0);
				expect(custody(path, inlineOriginals)).toEqual({ inline: 2, external: 0 });
			} else if (mode === "save") {
				done = after.external === 1;
				// The step commits with the first externalised row, or neither happened.
				expect(after).toEqual(done ? fencedWith(1) : armed);
				expect(stepEvents(path)).toBe(done ? 1 : 0);
				expect(JSON.parse(rowOf(path, taskId)).resultManifest).toBeUndefined();
			} else {
				const kept = custody(path, originals);
				done = kept.external > 0;
				expect(after).toEqual(done ? fencedWith(kept.external) : armed);
				expect(stepEvents(path)).toBe(done ? 1 : 0);
			}
			if (done) {
				entry.after++;
				entry.firstAfter ||= k;
			} else {
				// Once a kill point leaves the step committed, every later point does too.
				expect(entry.firstAfter).toBe(0);
				entry.before++;
			}
			const store = new FleetStore(path);
			try {
				if (mode === "enable") expect(enable(store).resultStoreStatus().externalisation).toBe("on");
				else if (mode === "migrate") expect(store.migrateResults(true)).toMatchObject({ failed: [] });
				else if (!done) store.saveResult(taskId, { patch: "r".repeat(5000) });
				else expect(store.task(taskId)!.resultManifest).toBeDefined();
				store.collectResults(true);
				expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [], unreferenced: [], temporary: [], unknown: [] });
			} finally {
				store.close();
			}
			if (mode === "enable") {
				expect(fenceOf(path)).toEqual(armed);
				expect(enabledEvents(path)).toBe(1);
			} else {
				expect(fenceOf(path)).toMatchObject({ userVersion: 3, meta: 3, features: [FEATURE], switchOn: true });
				expect(stepEvents(path)).toBe(1);
			}
			if (mode === "migrate") expect(custody(path, originals)).toEqual({ inline: 0, external: 2 });
		}
		expect(entry.before).toBeGreaterThan(0);
		expect(entry.after).toBeGreaterThan(0);
		summary[mode] = entry;
	}
	console.log(`KILL-SUMMARY ${JSON.stringify(summary)}`);
}, 600_000);

test("concurrency: four concurrent switches record it exactly once without a step; then four externalisers and two migrators step the ladder exactly once", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const originals = seedLegacy(path, 2, 2000, false);
	const store = new FleetStore(path);
	const ids = ["c0", "c1", "c2", "c3"].map((key) => running(store, key));
	store.close();
	expect(fenceOf(path)).toEqual(unfenced);
	const storeModule = new URL("../src/store.ts", import.meta.url).href;
	const spawnAll = async (scripts: string[]) => {
		const prelude = `const { FleetStore } = await import(${JSON.stringify(storeModule)});
			await new Promise(resolve => {
				process.once("message", resolve);
				process.send("ready");
			});
			process.disconnect();
			const s = new FleetStore(process.argv[1]);`;
		const children: {
			child: Bun.Subprocess<"ignore", "pipe", "pipe">;
			ready: Promise<void>;
			output: Promise<[string, string, number]>;
		}[] = [];
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			for (const script of scripts) {
				const ready = Promise.withResolvers<void>();
				const child = Bun.spawn([process.execPath, "-e", `${prelude} ${script}`, path], {
					stdout: "pipe", stderr: "pipe",
					ipc(message) { if (message === "ready") ready.resolve(); },
				});
				children.push({
					child,
					ready: Promise.race([ready.promise, child.exited.then(() => { throw new Error("store_child_exited_before_ready"); })]),
					output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]),
				});
			}
			await Promise.race([
				Promise.all(children.map(({ ready }) => ready)),
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("store_children_ready_timeout")), 10_000);
				}),
			]);
			for (const { child } of children) child.send("go");
			return (await Promise.all(children.map(({ output }) => output))).map(([stdout, stderr, exit]) => {
				expect(stderr).toBe("");
				expect(exit).toBe(0);
				return stdout;
			});
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			for (const { child } of children) if (child.exitCode === null) child.kill();
			await Promise.allSettled(children.flatMap(({ ready, output }) => [ready, output]));
		}
	};
	const switches = await spawnAll([0, 1, 2, 3].map((i) => `console.log(JSON.stringify(s.enableResultStore({ actor: "op${i}", reason: "race" }))); s.close();`));
	expect(switches.map((line) => JSON.parse(line).changed).filter(Boolean).length).toBe(1);
	expect(fenceOf(path)).toEqual(armed);
	const audit = new Database(path, { readonly: true });
	try {
		expect((audit.query("SELECT COUNT(*) AS n FROM audit WHERE kind='result_store_enabled'").get() as { n: number }).n).toBe(1);
	} finally {
		audit.close();
	}
	const work = await spawnAll([
		...ids.map((id, i) => `s.saveResult(${JSON.stringify(id)}, { patch: ${JSON.stringify(`+${i}\n`.repeat(3000))} }); s.close(); console.log("ok");`),
		...[0, 1].map(() => `console.log(JSON.stringify(s.migrateResults(true))); s.close();`),
	]);
	const migrated = work.filter((line) => line.startsWith("{")).reduce((sum, line) => sum + JSON.parse(line).migrated, 0);
	expect(migrated).toBe(2);
	expect(fenceOf(path)).toEqual(fencedWith(6));
	const steps = new Database(path, { readonly: true });
	try {
		expect((steps.query("SELECT COUNT(*) AS n FROM audit WHERE kind='result_store_format_step'").get() as { n: number }).n).toBe(1);
	} finally {
		steps.close();
	}
	expect(custody(path, new Map([...originals, ...ids.map((id, i) => [id, { row: "", manifest: canonicalJson({ patch: `+${i}\n`.repeat(3000) }) }] as const)]))).toEqual({ inline: 0, external: 6 });
}, 120_000);

// ---------------------------------------------------------------------------
// Archive interactions (52374c9 archive: phase "archived" + archived_phase_fence trigger).

function archivable(dir: string, manifest?: unknown, inline = true) {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 2);
	const response = join(dir, "response.json");
	const script = join(dir, "sdk.ts");
	writeFileSync(script, `console.log(await Bun.file(${JSON.stringify(response)}).text());`);
	writeFileSync(response, JSON.stringify({ ok: true, result: { version: 2, source: "broker", scope: "all", selection: { scope: "all" }, warnings: [], sessions: [] } }));
	const sdkNode = { id: "node", sdkTransport: { command: process.execPath, args: [script] } };
	const task: any = {
		id: "task-archive", input: input("archive"), inputDigest: "digest", nodeId: "node", nodeSnapshot: sdkNode,
		attemptId: "attempt-archive", sessionId: "session-archive", phase: "failed", held: false, reason: "failed",
		workspace: { path: "/owned/task-archive" }, result: { status: "failed", evidence: {}, executionTerminal: true, verified: false },
		...(manifest !== undefined && inline ? { resultManifest: manifest } : {}),
	};
	const db = new Database(path);
	db.query("INSERT INTO nodes VALUES (?,?)").run(sdkNode.id, JSON.stringify(sdkNode));
	db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(task.id, "actor", "archive", "digest", JSON.stringify(task));
	db.close();
	enable(store);
	if (manifest !== undefined && !inline) store.saveResult(task.id, manifest as any);
	return { path, store, id: task.id as string };
}

test("archive: with externalisation on, an archived task's inline result is never externalised (archive, state writes, migration)", async () => {
	const { Fleet } = await import("../src/fleet");
	const dir = fixture();
	const manifest = { patch: "a".repeat(5000), status: "failed" };
	const { path, store, id } = archivable(dir, manifest);
	try {
		const archived = await new Fleet(store).archive(id, {}, "tester");
		expect(archived.phase).toBe("archived");
		const row = JSON.parse(rowOf(path, id));
		expect(row.resultManifest).toStrictEqual(manifest);
		expect(Object.hasOwn(row, "resultExternal")).toBe(false);
		expect(fenceOf(path)).toEqual(armed);
		const before = rowOf(path, id);
		expect(store.migrateResults()).toMatchObject({ eligible: 0, archived: 1 });
		expect(store.migrateResults(true)).toMatchObject({ eligible: 0, archived: 1, migrated: 0, failed: [] });
		expect(rowOf(path, id)).toBe(before);
		expect(fenceOf(path)).toEqual(armed);
		// Idempotent re-archive (a state-write path) keeps it inline as well.
		expect((await new Fleet(store).archive(id, {}, "tester")).phase).toBe("archived");
		expect(rowOf(path, id)).toBe(before);
		expect(store.task(id)!.resultManifest).toStrictEqual(manifest);
	} finally {
		store.close();
	}
});

test("archive: a result saved after archiving stays inline; archiving an externalised task keeps it externalised and the trigger still holds", async () => {
	const { Fleet } = await import("../src/fleet");
	// (a) saveResult on an archived task without a result: inline even with externalisation on.
	const a = archivable(fixture());
	try {
		await new Fleet(a.store).archive(a.id, {}, "tester");
		a.store.saveResult(a.id, { patch: "s".repeat(5000) });
		expect(JSON.parse(rowOf(a.path, a.id)).resultManifest).toStrictEqual({ patch: "s".repeat(5000) });
		expect(fenceOf(a.path)).toEqual(armed);
	} finally {
		a.store.close();
	}
	// (b) externalised first, archived afterwards.
	const dir = fixture();
	const manifest = { patch: "e".repeat(5000), files: [{ path: "x", contentBase64: Buffer.alloc(4000, 7).toString("base64") }] };
	const b = archivable(dir, manifest, false);
	try {
		expect(fenceOf(b.path)).toEqual(fencedWith(1));
		const stored = JSON.parse(rowOf(b.path, b.id)).resultExternal;
		const archived = await new Fleet(b.store).archive(b.id, {}, "tester");
		expect(archived.phase).toBe("archived");
		expect(archived.resultManifest).toStrictEqual(manifest);
		const row = JSON.parse(rowOf(b.path, b.id));
		expect(row.phase).toBe("archived");
		expect(row.resultExternal).toStrictEqual(stored);
		expect(Object.hasOwn(row, "resultManifest")).toBe(false);
		expect(b.store.migrateResults(true)).toMatchObject({ eligible: 0, migrated: 0, failed: [] });
		// gc keeps blobs referenced only by archived rows; backups carry them.
		expect(b.store.collectResults()).toMatchObject({ removable: [] });
		expect(b.store.collectResults(true)).toMatchObject({ removed: [] });
		expect(b.store.resultInventory()).toMatchObject({ referenced: { blobs: 2 }, missing: [], corrupt: [] });
		const backup = join(dir, "archived-backup.sqlite");
		expect(b.store.backup(backup).results.blobs).toBe(2);
		const restored = new FleetStore(backup, 2, { readOnly: true });
		try {
			expect(restored.task(b.id)).toMatchObject({ phase: "archived", resultManifest: manifest });
		} finally {
			restored.close();
		}
		// The archived-phase trigger survives the ladder step and still refuses un-archiving.
		const raw = new Database(b.path);
		try {
			expect(() => raw.query("UPDATE tasks SET data=json_set(data,'$.phase','failed') WHERE id=?").run(b.id)).toThrow("Archived phase is immutable");
		} finally {
			raw.close();
		}
		expect(b.store.task(b.id)!.phase).toBe("archived");
	} finally {
		b.store.close();
	}
	expect(fenceOf(b.path)).toEqual(fencedWith(1));
});

test("backup/restore: backups before the switch are production v2 (rollback path) even with saved results; after it they are v3 with blobs", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const id = running(store);
	const other = running(store, "other");
	const pre = join(dir, "pre.sqlite");
	store.backup(pre);
	// Saved while off: inline, and a backup taken now still restores onto ladder-v2 code.
	store.saveResult(id, { patch: "b".repeat(5000) });
	const saved = join(dir, "saved.sqlite");
	expect(store.backup(saved).results.blobs).toBe(0);
	enable(store);
	store.saveResult(other, { patch: "o".repeat(5000) });
	const post = join(dir, "post.sqlite");
	expect(store.backup(post).results.blobs).toBe(1);
	store.close();
	expect(fenceOf(pre)).toEqual(unfenced);
	expect(fenceOf(saved)).toEqual(unfenced);
	expect(fenceOf(post)).toEqual(fencedWith(1));
	const restoredSaved = new FleetStore(saved, 2, { readOnly: true });
	try {
		expect(restoredSaved.task(id)!.resultManifest).toStrictEqual({ patch: "b".repeat(5000) });
	} finally {
		restoredSaved.close();
	}
	// Restore the pre-switch backup over the live database; newer blobs are left behind.
	for (const side of ["", "-wal", "-shm"]) rmSync(`${path}${side}`, { force: true });
	cpSync(saved, path);
	expect(fenceOf(path)).toEqual(unfenced);
	const restored = new FleetStore(path);
	try {
		expect(restored.task(id)!.resultManifest).toStrictEqual({ patch: "b".repeat(5000) });
		expect(restored.task(other)!.resultManifest).toBeUndefined();
		expect(restored.collectResults()).toMatchObject({ removable: [hash("o".repeat(5000))] });
		expect(restored.collectResults(true)).toMatchObject({ removed: [hash("o".repeat(5000))] });
	} finally {
		restored.close();
	}
	expect(fenceOf(path)).toEqual(unfenced);
});

// Older code: FLEET_OLD_TREE names an extract of a ladder-v2 production build
// (0289d27, the base of this change, or 52374c9). Skipped when it is not provided.
const oldTree = process.env.FLEET_OLD_TREE;
function inOldTree(script: string, ...args: string[]) {
	const dir = fixture();
	const file = join(dir, "old.ts");
	const module = `file:///${join(oldTree!, "src", "store.ts").replaceAll("\\", "/").replace(/^\/+/, "")}`;
	writeFileSync(
		file,
		`const { FleetStore } = await import(${JSON.stringify(module)});\n` +
			`const [path, mode, extra] = process.argv.slice(2);\n` +
			`try { const out = await (async () => { ${script} })(); console.log("OUT " + JSON.stringify({ ok: true, out })); }\n` +
			`catch (error) { console.log("OUT " + JSON.stringify({ ok: false, code: error?.code, message: String(error?.message) })); }\n`,
	);
	const run = Bun.spawnSync([process.execPath, file, ...args], { cwd: oldTree, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	const line = run.stdout.toString().split("\n").find((entry) => entry.startsWith("OUT "));
	if (!line) throw new Error(`old tree produced no result: ${run.stderr.toString()}`);
	return JSON.parse(line.slice(4));
}
function checkpoint(path: string) {
	const db = new Database(path);
	try {
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
}

test.skipIf(!oldTree)("ladder-v2 production code opens every database this build leaves at v2 (switch off, or on without an externalised row), refuses it after the first externalised row, and a live old writer cannot mix forms", async () => {
	const { Fleet } = await import("../src/fleet");
	const dir = fixture();
	const open = `const s = new FleetStore(path, 2, { readOnly: mode === "ro" }); try { return s.tasks().map((t) => t.resultManifest === undefined ? null : JSON.stringify(t.resultManifest)); } finally { s.close(); }`;
	// 1. New code with the switch off: results saved by new code (multi-MB included), an inline
	//    legacy row, queued work and an archived inline row. Production code opens it and reads
	//    the same results; rollback is a plain code rollback.
	const plain = join(dir, "plain.sqlite");
	const store = new FleetStore(plain);
	const id = running(store);
	const savedOff = running(store, "saved-off");
	store.saveResult(savedOff, largeManifest() as any);
	legacyRow(plain, store, "legacy", { patch: "l".repeat(5000) });
	store.submit(input("queued") as any);
	store.backup(join(dir, "plain-backup.sqlite"));
	const expected = store.tasks().map((t) => (t.resultManifest === undefined ? null : JSON.stringify(t.resultManifest)));
	store.close();
	const arch = archivable(join(dir, "arch-dir"), { patch: "a".repeat(5000) });
	await new Fleet(arch.store).archive(arch.id, {}, "tester");
	arch.store.close();
	const archOff = join(dir, "arch-off.sqlite");
	{
		// archivable() switches on; rebuild the same archived row in a switched-off database.
		const off = new FleetStore(archOff);
		const row = JSON.parse(rowOf(arch.path, arch.id));
		off.close();
		const db = new Database(archOff);
		db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(row.id, "actor", "archive", "digest", canonicalJson(row));
		db.close();
	}
	for (const path of [plain, join(dir, "plain-backup.sqlite"), archOff]) {
		expect(fenceOf(path)).toMatchObject({ userVersion: 2, meta: 2, table: false, external: 0 });
		for (const mode of ["ro", "rw"]) expect(inOldTree(open, path, mode)).toMatchObject({ ok: true });
	}
	expect(inOldTree(open, plain, "ro")).toEqual({ ok: true, out: expected });
	// L-A: the CLI tasks listing of production code and of this build are byte-identical.
	const listing = (cli: string) => {
		const run = Bun.spawnSync([process.execPath, cli, "--read-only", "--db", plain, "--cap", "2", "tasks"], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
		expect(run.exitCode).toBe(0);
		return run.stdout.toString();
	};
	expect(listing(join(import.meta.dir, "..", "src", "cli.ts"))).toBe(listing(join(oldTree!, "src", "cli.ts")));
	// 2a. After the switch alone (no externalised row yet) the database is still ladder v2:
	//     production code opens and writes it (inline), its backup is armed v2 as well, and the
	//     next externalised row of this build takes the one-way step.
	const switched = join(dir, "switched.sqlite");
	cpSync(plain, switched);
	enable(new FleetStore(switched)).close();
	expect(fenceOf(switched)).toEqual({ ...armed, external: 0 });
	for (const mode of ["ro", "rw"]) expect(inOldTree(open, switched, mode)).toEqual({ ok: true, out: expected });
	const oldSave = `const s = new FleetStore(path); try { const t = s.reserve(s.submit(${JSON.stringify(input("old-armed"))}).id); s.recordSession(t.id, "session-oa"); s.recordTurn(t.id, "turn-oa"); s.saveResult(t.id, { patch: "w".repeat(5000) }); s.backup(extra); return t.id; } finally { s.close(); }`;
	const oldArmed = inOldTree(oldSave, switched, "rw", join(dir, "switched-old-backup.sqlite"));
	expect(oldArmed.ok).toBe(true);
	expect(fenceOf(switched)).toEqual(armed);
	expect(fenceOf(join(dir, "switched-old-backup.sqlite"))).toEqual(armed);
	const stepper = new FleetStore(switched);
	try {
		expect(stepper.task(oldArmed.out)!.resultManifest).toStrictEqual({ patch: "w".repeat(5000) });
		expect(stepper.resultStoreStatus()).toMatchObject({ externalisation: "on", userVersion: 2, oneWayStepTaken: false });
		stepper.saveResult(id, { patch: "t".repeat(5000) });
	} finally {
		stepper.close();
	}
	expect(fenceOf(switched)).toEqual(fencedWith(1));
	// 2b. After the first externalised row (save, migration, or a backup of either):
	//     refused, read-only and writable, DB untouched.
	const saved = join(dir, "saved.sqlite");
	cpSync(plain, saved);
	const writer = onStore(saved);
	writer.saveResult(id, { patch: "s".repeat(5000), status: "verified" });
	writer.backup(join(dir, "saved-backup.sqlite"));
	writer.close();
	const migrated = join(dir, "migrated.sqlite");
	cpSync(plain, migrated);
	const migrator = onStore(migrated);
	expect(migrator.migrateResults(true)).toMatchObject({ migrated: 2, failed: [] });
	migrator.close();
	for (const path of [switched, saved, migrated, join(dir, "saved-backup.sqlite")]) {
		expect(fenceOf(path).userVersion).toBe(3);
		if (existsSync(`${path}-wal`)) checkpoint(path);
		const journal = journalMode(path);
		const before = imageOf(path);
		for (const mode of ["ro", "rw"])
			expect(inOldTree(open, path, mode)).toEqual({ ok: false, code: "SCHEMA_VERSION", message: "Unsupported database schemaVersion" });
		const save = `const s = new FleetStore(path); try { return s.saveResult(extra, { status: "forged" }); } finally { s.close(); }`;
		expect(inOldTree(save, path, "rw", id)).toMatchObject({ ok: false, code: "SCHEMA_VERSION" });
		const backup = `const s = new FleetStore(path); try { return s.backup(extra); } finally { s.close(); }`;
		expect(inOldTree(backup, path, "rw", join(dir, "old-backup.sqlite"))).toMatchObject({ ok: false, code: "SCHEMA_VERSION" });
		expect(existsSync(join(dir, "old-backup.sqlite"))).toBe(false);
		expect(imageOf(path)).toBe(before);
		expect(journalMode(path)).toBe(journal);
	}
	// 3. A database written by production code (inline result) works in new code without migration and stays openable by it.
	const old = join(dir, "old.sqlite");
	const make = `const s = new FleetStore(path); try {
		s.putNode(${JSON.stringify(node("node"))});
		const t = s.reserve(s.submit(${JSON.stringify(input("o"))}).id);
		s.recordSession(t.id, "session-o"); s.recordTurn(t.id, "turn-o");
		s.saveResult(t.id, { patch: "o".repeat(5000), status: "verified" });
		s.submit(${JSON.stringify(input("q"))});
		return t.id; } finally { s.close(); }`;
	const made = inOldTree(make, old, "rw");
	expect(made.ok).toBe(true);
	expect(fenceOf(old)).toMatchObject({ userVersion: 2, meta: 2, table: false, external: 0 });
	const oldRow = rowOf(old, made.out);
	for (const readOnly of [true, false]) {
		const reopened = new FleetStore(old, 2, { readOnly });
		try {
			expect(reopened.task(made.out)!.resultManifest).toStrictEqual({ patch: "o".repeat(5000), status: "verified" });
			if (!readOnly) expect(reopened.reserve(reopened.taskStates().find((t) => t.input.key === "q")!.id).phase).toBe("preparing");
		} finally {
			reopened.close();
		}
	}
	expect(rowOf(old, made.out)).toBe(oldRow);
	expect(fenceOf(old)).toMatchObject({ userVersion: 2, meta: 2, table: false, external: 0 });
	expect(inOldTree(open, old, "ro")).toMatchObject({ ok: true });
	// 4. L2: a production process that opened the database before the switch keeps running
	//    (it checks the version only at open). After the switch and an externalised save, its
	//    inline save onto that row is refused by the row-form trigger; the row is unchanged.
	const live = join(dir, "live.sqlite");
	const liveStore = new FleetStore(live);
	const liveId = running(liveStore, "live");
	liveStore.close();
	const go = join(dir, "live-go");
	const script = join(dir, "live-old.ts");
	const module = `file:///${join(oldTree!, "src", "store.ts").replaceAll("\\", "/").replace(/^\/+/, "")}`;
	writeFileSync(
		script,
		`const { FleetStore } = await import(${JSON.stringify(module)});\n` +
			`const { existsSync } = await import("node:fs");\n` +
			`const s = new FleetStore(${JSON.stringify(live)});\nconsole.log("OPEN");\n` +
			`while (!existsSync(${JSON.stringify(go)})) await Bun.sleep(5);\n` +
			`let out; try { s.saveResult(${JSON.stringify(liveId)}, { patch: "old".repeat(2000) }); out = "saved"; } catch (error) { out = String(error?.message); }\n` +
			`s.close(); console.log("OUT " + out);\n`,
	);
	const child = Bun.spawn([process.execPath, script], { cwd: oldTree, stdout: "pipe", stderr: "pipe" });
	const reader = child.stdout.getReader();
	let seen = "";
	while (!seen.includes("OPEN")) {
		const chunk = await reader.read();
		if (chunk.done) break;
		seen += new TextDecoder().decode(chunk.value);
	}
	const fresh = onStore(live);
	fresh.saveResult(liveId, { patch: "new".repeat(2000) });
	const before = rowOf(live, liveId);
	writeFileSync(go, "");
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		seen += new TextDecoder().decode(chunk.value);
	}
	expect(await child.exited).toBe(0);
	expect(seen).toContain("OUT Result stored both inline and externalised");
	expect(rowOf(live, liveId)).toBe(before);
	expect(fresh.task(liveId)!.resultManifest).toStrictEqual({ patch: "new".repeat(2000) });
	expect(fresh.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
	fresh.close();
}, 180_000);

// ---------------------------------------------------------------------------
// N2: scheduling does not rehydrate settled results.

test("N2: one corrupt blob fails only that task's result reads; reserve, held charges and the dashboard keep working", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		store.saveResult(id, { patch: "c".repeat(5000) });
		writeFileSync(join(`${path}.results`, hash("c".repeat(5000)), "data"), "d".repeat(5000));
		const queued = store.submit(input("queued") as any);
		expect(code(() => store.task(id))).toBe("RESULT_INTEGRITY");
		expect(code(() => store.tasks())).toBe("RESULT_INTEGRITY");
		const states = store.taskStates();
		expect(states.length).toBe(2);
		expect(states.every((state) => !Object.hasOwn(state, "resultManifest") && !Object.hasOwn(state, "resultExternal"))).toBe(true);
		expect(store.reserve(queued.id).phase).toBe("preparing");
		expect(store.heldCharges().get("node")?.length).toBe(2);
		const { getDashboardState } = await import("../src/dashboard");
		expect(getDashboardState(store).tasks.length).toBe(2);
		expect(store.resultInventory().corrupt).toEqual([{ sha256: hash("c".repeat(5000)), taskIds: [id] }]);
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// N3: non-object manifests.

test("N3: text, null and number manifests save, read, schedule and migrate", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		store.saveResult(id, "plain text result" as any);
		expect(store.task(id)!.resultManifest).toBe("plain text result");
		expect(store.tasks().length).toBe(1);
		expect(store.reserve(store.submit(input("q") as any).id).phase).toBe("preparing");
		expect(code(() => store.saveResult(id, "plain text result" as any))).toBe("ok");
		expect(code(() => store.saveResult(id, "other" as any))).toBe("RESULT_CONFLICT");
		const legacy = [null, "s".repeat(5000), 7].map((manifest, i) => [legacyRow(path, store, `l${i}`, manifest), manifest] as const);
		expect(store.migrateResults(true)).toMatchObject({ eligible: 3, migrated: 3, failed: [] });
		for (const [legacyId, manifest] of legacy) expect(store.task(legacyId)!.resultManifest).toStrictEqual(manifest);
	} finally {
		store.close();
	}
	const reopened = new FleetStore(path, 2, { readOnly: true });
	try {
		expect(reopened.tasks().length).toBe(5);
	} finally {
		reopened.close();
	}
});

// ---------------------------------------------------------------------------
// N4: results check and gc dry-run never list an in-flight writer's blobs.

test("N4: results check and gc dry-run wait for the write lock; a read-only inventory says it is not exact", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const taskId = running(store);
	store.close();
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "result-crash-child.ts"), path, taskId], {
		env: { ...process.env, RESULT_MODE: "save", RESULT_POINT: "none", RESULT_PAUSE_MS: "2500" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = child.stderr.getReader();
	let seen = "";
	while (!seen.includes("PAUSED")) {
		const chunk = await reader.read();
		if (chunk.done) break;
		seen += new TextDecoder().decode(chunk.value);
	}
	expect(seen).toContain("PAUSED");
	expect(readdirSync(`${path}.results`).filter((name) => /^[a-f0-9]{64}$/.test(name)).length).toBe(3);
	const ro = new FleetStore(path, 2, { readOnly: true });
	try {
		expect(ro.resultInventory().exact).toBe(false);
		expect(ro.collectResults()).toMatchObject({ dryRun: true, exact: false });
	} finally {
		ro.close();
	}
	const checker = new FleetStore(path);
	try {
		const inventory = checker.resultInventory();
		expect(inventory).toMatchObject({ exact: true, unreferenced: [], temporary: [], missing: [], corrupt: [] });
		expect(inventory.referenced.blobs).toBe(3);
		expect(checker.collectResults()).toEqual({ dryRun: true, exact: true, removable: [] });
	} finally {
		checker.close();
	}
	expect(await child.exited).toBe(0);
});

// ---------------------------------------------------------------------------
// M2: metadata consumers (queue, dashboard, listings, counts, audit) never read result bodies.

/** One damaged externalised result, one row holding both forms (written before the switch), one queued task. */
function damagedFleet(path: string) {
	const store = new FleetStore(path);
	const both = running(store, "both");
	const inline = running(store, "inline");
	const raw = new Database(path);
	const rowWith = (id: string, extra: Record<string, unknown>) =>
		raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...JSON.parse(rowOf(path, id)), ...extra } as any), id);
	rowWith(both, { resultManifest: { patch: "i" }, resultExternal: { version: 1, digest: "0".repeat(64), skeleton: {}, blobs: [] } });
	rowWith(inline, { resultManifest: { patch: "x".repeat(5000) } });
	raw.close();
	enable(store);
	const damaged = running(store, "damaged");
	store.saveResult(damaged, { patch: "c".repeat(5000), status: "verified" });
	rmSync(join(`${path}.results`, hash("c".repeat(5000))), { recursive: true });
	const queued = store.submit(input("queued") as any);
	return { store, both, damaged, inline, queued: queued.id };
}

test("M2: queue reconsider, the dashboard, the tasks listing, counts and audit attribution work beside a damaged result and a mixed-form row", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const f = damagedFleet(path);
	const { Fleet } = await import("../src/fleet");
	const { reconsiderQueue } = await import("../src/index");
	const { getDashboardState } = await import("../src/dashboard");
	try {
		expect(code(() => f.store.task(f.damaged))).toBe("RESULT_INTEGRITY");
		expect(code(() => f.store.task(f.both))).toBe("RESULT_INTEGRITY");
		expect(code(() => f.store.tasks())).toBe("RESULT_INTEGRITY");
		// Queue: before this fix store.tasks() made every pass fail with RESULT_INTEGRITY.
		let sampled = 0;
		const reconsidered = await reconsiderQueue(new Fleet(f.store), async () => (sampled++, new Map()));
		// Exactly one candidate (the queued task); nothing is admitted without samples.
		expect(sampled).toBe(1);
		expect(reconsidered.every((task) => task.id === f.queued && task.phase === "queued")).toBe(true);
		expect(f.store.taskState(f.queued)!.phase).toBe("queued");
		expect(getDashboardState(f.store).tasks.length).toBe(4);
		const listing = f.store.taskListing();
		expect(listing.map((entry) => entry.result?.stored ?? null)).toEqual(["external", "inline", "external", null]);
		expect(f.store.observability()).toBeDefined();
		// Audit attribution reads row metadata only: a refused write on the damaged task is
		// still recorded with its identity (before, task() threw inside the refusal audit).
		expect(code(() => f.store.saveResult(f.damaged, { patch: "other" }))).toBe("RESULT_INTEGRITY");
		const refused = f.store.events(f.damaged).filter((event) => event.kind === "refused").at(-1)!;
		expect(refused.data).toMatchObject({ action: "saveResult", code: "RESULT_INTEGRITY", observability: { attributes: { taskId: f.damaged, sessionId: "session-damaged" } } });
	} finally {
		f.store.close();
	}
	// The same through the CLI, writable and read-only.
	const { cli } = await import("../src/cli");
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => void logs.push(args.join(" "));
	try {
		logs.length = 0;
		expect(await cli(["--db", path, "--resources", writeJson(dir, "samples.json", {}), "queue", "reconsider"])).toBe(0);
		expect(JSON.parse(logs.join("\n")).every((task: any) => task.id === f.queued && task.phase === "queued")).toBe(true);
		for (const argv of [["--db", path, "tasks"], ["--read-only", "--db", path, "tasks"]]) {
			logs.length = 0;
			expect(await cli(argv)).toBe(0);
			// L-A: the base listing contract (digest, status, files, tests), read without any result body.
			expect(JSON.parse(logs.join("\n")).map((task: any) => task.resultManifest ?? null)).toEqual([
				{ digest: "0".repeat(64) },
				{ digest: digest({ patch: "x".repeat(5000) }) },
				{ digest: digest({ patch: "c".repeat(5000), status: "verified" }), status: "verified" },
				null,
			]);
		}
		logs.length = 0;
		expect(await cli(["--read-only", "--db", path, "observability"])).toBe(0);
	} finally {
		console.log = originalLog;
	}
});
function writeJson(dir: string, name: string, value: unknown): string {
	const file = join(dir, name);
	writeFileSync(file, JSON.stringify(value));
	return file;
}

test("M2: taskStates/taskListing never open blobs and never materialise an inline result; they equal the row without both result fields", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const make = generator(4242);
	try {
		const ids: string[] = [];
		for (let i = 0; i < 60; i++) {
			const x = make();
			const id = i % 3 === 0 ? running(store, `run-${i}`) : store.submit(input(`q-${i}`) as any).id;
			if (i % 3 === 0 && x !== undefined) store.saveResult(id, x as any);
			// Arbitrary JSON (unicode, lone surrogates, tricky keys, numbers) in a kept field.
			const raw = new Database(path);
			const row = JSON.parse(rowOf(path, id));
			raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...row, probe: make(), ...(i % 3 === 1 ? { resultManifest: make() ?? null } : {}) } as any), id);
			raw.close();
			ids.push(id);
		}
		// Blobs are not needed: remove the whole result directory.
		rmSync(`${path}.results`, { recursive: true, force: true });
		const expected = ids.map((id) => {
			const { resultManifest: _m, resultExternal: _e, ...state } = JSON.parse(rowOf(path, id));
			return state;
		});
		const states = store.taskStates();
		expect(states.length).toBe(ids.length);
		for (const [i, state] of states.entries()) {
			expect(canonicalJson(state as any)).toBe(canonicalJson(expected[i]));
			expect(state).toStrictEqual(expected[i]);
			expect(store.taskState(ids[i]!)).toStrictEqual(expected[i]);
		}
		expect(store.taskListing().map((entry) => entry.state)).toStrictEqual(expected);
		// M-D: operation and resource-return lookups (dashboard, reconsider, return paths) read the row
		// without its result: they work although every externalised result is now unreadable.
		const unreadable = ids.filter((id) => JSON.parse(rowOf(path, id)).resultExternal?.blobs.length > 0);
		expect(unreadable.length).toBeGreaterThan(0);
		const decode = spyOn(store as any, "decodeTask");
		for (const id of ids) {
			expect(store.getOperation(id, "create")).toBeUndefined();
			expect(store.resourceReturnStatus(id)).toBeUndefined();
		}
		expect(code(() => store.getOperation("missing-task", "create"))).toBe("NOT_FOUND");
		expect(decode).not.toHaveBeenCalled();
		decode.mockRestore();
		// The same lookups on an uncached instance; there the full read fails as it must.
		const fresh = new FleetStore(path, 2, { readOnly: true });
		try {
			for (const id of unreadable) {
				expect(fresh.getOperation(id, "create")).toBeUndefined();
				expect(fresh.resourceReturnStatus(id)).toBeUndefined();
				expect(code(() => fresh.task(id))).toBe("RESULT_INTEGRITY");
			}
		} finally {
			fresh.close();
		}
		expect(existsSync(`${path}.results`)).toBe(false);
	} finally {
		store.close();
	}
});

// ---------------------------------------------------------------------------
// L1: the blob reader applies the store's file policy: no symlinks, no FIFOs, single-link regular files.

test.skipIf(process.platform === "win32")("L1: symlinked data, blob directory or result directory, hard links and FIFOs are refused without blocking, read-only included", () => {
	const { symlinkSync, linkSync, renameSync } = require("node:fs") as typeof import("node:fs");
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	const id = running(store);
	const patch = "s".repeat(5000);
	store.saveResult(id, { patch });
	store.close();
	const results = `${path}.results`;
	const sha = hash(patch);
	const data = join(results, sha, "data");
	const outside = join(dir, "outside");
	mkdirSync(join(outside, sha), { recursive: true });
	writeFileSync(join(outside, sha, "data"), patch);
	writeFileSync(join(outside, "data"), patch);
	const reset = () => {
		rmSync(results, { recursive: true, force: true });
		mkdirSync(join(results, sha), { recursive: true });
		writeFileSync(data, patch);
	};
	const cases: [string, () => void][] = [
		["data symlink to identical bytes", () => (rmSync(data), symlinkSync(join(outside, "data"), data))],
		["blob directory symlink", () => (rmSync(join(results, sha), { recursive: true }), symlinkSync(join(outside, sha), join(results, sha)))],
		["result directory symlink", () => (rmSync(results, { recursive: true }), symlinkSync(outside, results))],
		["data hard link", () => linkSync(data, join(dir, "second-link"))],
		["data FIFO", () => {
			rmSync(data);
			expect(Bun.spawnSync(["mkfifo", data]).exitCode).toBe(0);
		}],
	];
	for (const [name, damage] of cases) {
		reset();
		rmSync(join(dir, "second-link"), { force: true });
		const good = new FleetStore(path, 2, { readOnly: true });
		try {
			expect(good.task(id)!.resultManifest).toStrictEqual({ patch });
		} finally {
			good.close();
		}
		damage();
		for (const readOnly of [true, false]) {
			const started = Date.now();
			const s = new FleetStore(path, 2, { readOnly });
			try {
				expect(`${name}:${code(() => s.task(id))}`).toBe(`${name}:RESULT_INTEGRITY`);
				if (name === "result directory symlink") expect(code(() => s.resultInventory())).toBe("RESULT_INTEGRITY");
				else expect({ name, corrupt: s.resultInventory().corrupt }).toEqual({ name, corrupt: [{ sha256: sha, taskIds: [id] }] });
				expect(s.taskStates().length).toBe(1);
				if (!readOnly) {
					expect(code(() => s.collectResults(true))).toBe("RESULT_INTEGRITY");
					expect(code(() => s.backup(join(fixture(), "b.sqlite")))).toBe("RESULT_INTEGRITY");
				}
			} finally {
				s.close();
			}
			expect(Date.now() - started).toBeLessThan(5000);
		}
		// The bytes outside were never removed or changed through a link.
		expect(readFileSync(join(outside, "data"), "utf8")).toBe(patch);
		expect(readFileSync(join(outside, sha, "data"), "utf8")).toBe(patch);
	}
	// An unreferenced FIFO entry is listed (size unknown) and collected without being opened.
	reset();
	const orphan = "f".repeat(64);
	mkdirSync(join(results, orphan));
	expect(Bun.spawnSync(["mkfifo", join(results, orphan, "data")]).exitCode).toBe(0);
	const s = new FleetStore(path);
	try {
		expect(s.resultInventory().unreferenced).toEqual([{ sha256: orphan, bytes: null }]);
		expect(s.collectResults(true)).toMatchObject({ removed: [orphan] });
		// Publishing never trusts a non-directory squatting on a content address.
		renameSync(join(results, sha), join(dir, "moved-away"));
		writeFileSync(join(results, sha), "squatter");
		const fresh = running(s, "fresh");
		expect(code(() => s.saveResult(fresh, { patch }))).toBe("RESULT_INTEGRITY");
	} finally {
		s.close();
	}
});

// ---------------------------------------------------------------------------
// L2: rows holding both forms are reported by results check; triggers refuse new ones.

test("L2: after the switch no writer can store both forms; results check reports such a row (exit 1) instead of ok", async () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	// A connection opened before the switch (like a still-running older process).
	const store = new FleetStore(path);
	const id = running(store);
	const early = new Database(path);
	early.query("SELECT 1").get();
	enable(store);
	store.saveResult(id, { patch: "n".repeat(5000) });
	const before = rowOf(path, id);
	const row = JSON.parse(before);
	expect(() => early.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson({ ...row, resultManifest: { patch: "old" } }), id)).toThrow("Result stored both inline and externalised");
	const other = store.submit(input("insert") as any);
	expect(() => early.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run("forged", "c", "k", "d", canonicalJson({ ...other, id: "forged", resultManifest: 1, resultExternal: {} } as any))).toThrow("Result stored both inline and externalised");
	early.close();
	expect(rowOf(path, id)).toBe(before);
	store.close();
	// A mixed row from before the switch is reported, with exit 1, while listings keep working.
	const mixed = join(dir, "mixed.sqlite");
	const f = damagedFleet(mixed);
	const report = f.store.resultInventory();
	f.store.close();
	expect(report.rows).toEqual([{ taskId: f.both, problem: "Inline and externalised manifests both present" }]);
	expect(report.missing).toEqual([{ sha256: hash("c".repeat(5000)), taskIds: [f.damaged] }]);
	const { cli } = await import("../src/cli");
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => void logs.push(args.join(" "));
	try {
		for (const argv of [["--db", mixed, "results", "check"], ["--read-only", "--db", mixed, "results", "check"]]) {
			logs.length = 0;
			expect(await cli(argv)).toBe(1);
			expect(JSON.parse(logs.join("\n"))).toMatchObject({ ok: false, rows: [{ taskId: f.both }] });
		}
	} finally {
		console.log = originalLog;
	}
	// A row whose blobs are intact but whose skeleton was edited is a row problem too.
	const edited = join(dir, "edited.sqlite");
	const e = onStore(edited);
	const eid = running(e);
	e.saveResult(eid, { patch: "p".repeat(5000), status: "verified" });
	const stored = JSON.parse(rowOf(edited, eid));
	stored.resultExternal.skeleton.status = "forged";
	const raw = new Database(edited);
	raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson(stored), eid);
	raw.close();
	expect(e.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [{ taskId: eid, problem: expect.stringContaining("digest mismatch") }] });
	e.close();
});

// ---------------------------------------------------------------------------
// Receipt-less settlement (production 0289d27): settlement and lateReceipt live in task.result,
// which always stays inline; only the four named manifest fields may leave the row.

test("receipt-less settlement: failed_without_receipt and lateReceipt round-trip inline (off and on, save, migrate, backup); only the four manifest fields move", async () => {
	const settledTask = (store: FleetStore, key: string) => {
		const id = running(store, key);
		const sequence = store.beginObservation(id)!;
		const execution = { kind: "prompt", commandId: "runtime-command-1", turnId: "runtime-turn-1", status: "failed", receiptState: "missing" };
		const body = {
			sessionId: `session-${key}`,
			turnId: `turn-${key}`,
			status: "failed" as const,
			terminal: true,
			evidence: { publicTurn: { ok: true, turn: { status: "failed" } }, execution },
			settlement: {
				kind: "failed_without_receipt" as const,
				receiptState: "missing",
				cause: "model stream stalled: no tokens for 180s; run aborted (prompt_failed, unavailable) — ünï 😀",
				settledAt: "2026-11-12T10:01:00.000Z",
				lateObservationUntil: "2026-11-13T10:01:00.000Z",
			},
		};
		store.observe(id, { ...body, eventId: `${key}:poll:${sequence}`, digest: observationDigest(body) } as any, sequence);
		store.recordLateReceipt(id, {
			status: "terminal_ok",
			digest: "a".repeat(64),
			terminalAt: 1_763_000_999_000,
			outcome: { kind: "stopped", reason: "end_turn", provenance: "agent" },
			sessionId: `session-${key}`,
			turnId: `turn-${key}`,
			runtimeCommandId: "runtime-command-1",
			runtimeTurnId: "runtime-turn-1",
			observedAt: "2026-11-12T10:30:00.000Z",
		});
		return id;
	};
	const manifest = {
		status: "not_run",
		patch: "+late\n".repeat(2000),
		files: [{ path: "f", bytes: 3, sha256: "x", contentBase64: Buffer.alloc(6000, 9).toString("base64") }],
		tests: [{ argv: ["bun", "--eval", "y".repeat(3000)], stdout: "o".repeat(3000), stderr: "small" }],
		settlementEcho: "s".repeat(3000),
	};
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	const { getDashboardState } = await import("../src/dashboard");
	const { publicLateReceipt, publicSettlement } = await import("../src/dashboard-poll-view");
	try {
		const off = settledTask(store, "off");
		const accepted = settledTask(store, "accepted");
		store.acceptLateReceipt(accepted, { actor: "operator", reason: "genuine", digest: "a".repeat(64), evidence: { reread: true } });
		const results = new Map([off, accepted].map((id) => [id, canonicalJson(store.task(id)!.result as any)]));
		expect(JSON.parse(results.get(off)!)).toMatchObject({ status: "failed", settlement: { kind: "failed_without_receipt" }, lateReceipt: { status: "terminal_ok", settlementKind: "failed_without_receipt" } });
		expect(JSON.parse(results.get(accepted)!)).toMatchObject({ status: "completed_unverified", lateReceipt: { acceptance: { actor: "operator", reason: "genuine" } } });
		// Off: collected evidence stays inline, the row is exactly canonicalJson(task).
		store.saveResult(off, manifest as any);
		expect(rowOf(path, off)).toBe(canonicalJson(store.task(off) as any));
		// On: a new save externalises only the four named fields; result (settlement,
		// lateReceipt, acceptance) and every other manifest field stay in the row.
		enable(store);
		store.saveResult(accepted, manifest as any);
		const stored = JSON.parse(rowOf(path, accepted));
		expect<string | undefined>(canonicalJson(stored.result)).toBe(results.get(accepted));
		expect((stored.resultExternal as ExternalManifest).blobs.map((ref) => ref.path)).toEqual([["patch"], ["files", 0, "contentBase64"], ["tests", 0, "stdout"]]);
		expect(stored.resultExternal.skeleton).toMatchObject({ settlementEcho: manifest.settlementEcho, tests: [{ argv: manifest.tests[0]!.argv, stderr: "small" }] });
		expect(store.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
		for (const id of [off, accepted]) {
			const row = JSON.parse(rowOf(path, id));
			expect<string | undefined>(canonicalJson(row.result)).toBe(results.get(id));
			expect(store.task(id)!.resultManifest).toStrictEqual(manifest);
			expect<string | undefined>(canonicalJson(store.taskState(id)!.result as any)).toBe(results.get(id));
		}
		const dashboard = getDashboardState(store).tasks;
		for (const id of [off, accepted]) {
			const projected = dashboard.find((task) => task.id === id)!;
			const storedResult = JSON.parse(results.get(id)!);
			// Store round-trip keeps the private cause/outcome; dashboard projection only publishes public codes.
			expect(canonicalJson(projected.settlement as any)).toBe(canonicalJson(publicSettlement(storedResult.settlement)));
			expect(canonicalJson(projected.lateReceipt as any)).toBe(canonicalJson(publicLateReceipt(storedResult.lateReceipt)));
			expect(projected.settlement).toMatchObject({ kind: "failed_without_receipt", cause: "failed_without_receipt" });
			expect(projected.lateReceipt).toMatchObject({ status: "terminal_ok", outcome: {} });
			expect(JSON.stringify(projected)).not.toContain("model stream stalled");
			expect(JSON.stringify(projected)).not.toContain("end_turn");
			expect(storedResult.settlement.cause).toContain("model stream stalled");
			expect(storedResult.lateReceipt.outcome).toMatchObject({ kind: "stopped", reason: "end_turn", provenance: "agent" });
		}
		const backup = join(dir, "backup.sqlite");
		store.backup(backup);
		const restored = new FleetStore(backup, 2, { readOnly: true });
		try {
			for (const id of [off, accepted]) {
				expect<string | undefined>(canonicalJson(restored.task(id)!.result as any)).toBe(results.get(id));
				expect(restored.task(id)!.resultManifest).toStrictEqual(manifest);
			}
		} finally {
			restored.close();
		}
	} finally {
		store.close();
	}
});

test("M-C: backup has no size limit and streams: a database above 256 MiB backs up (free pages dropped) and the copy restores", () => {
	const dir = fixture();
	const path = join(dir, "fleet.sqlite");
	const store = onStore(path);
	try {
		const id = running(store);
		store.saveResult(id, { patch: "m".repeat(5000), status: "verified" });
		const raw = new Database(path);
		try {
			// 300 MiB of live pages plus 64 MiB of free pages (a dropped table), as after migrate without VACUUM.
			raw.exec("CREATE TABLE filler (b BLOB); INSERT INTO filler VALUES (zeroblob(300 * 1024 * 1024)); CREATE TABLE freed (b BLOB); INSERT INTO freed VALUES (zeroblob(64 * 1024 * 1024)); DROP TABLE freed;");
			const size = raw.query("SELECT (SELECT page_count FROM pragma_page_count) * (SELECT page_size FROM pragma_page_size) AS bytes, (SELECT freelist_count FROM pragma_freelist_count) * (SELECT page_size FROM pragma_page_size) AS free").get() as { bytes: number; free: number };
			expect(size.bytes).toBeGreaterThan(256 * 1024 * 1024 + 64 * 1024 * 1024);
			expect(size.free).toBeGreaterThanOrEqual(64 * 1024 * 1024);
		} finally {
			raw.close();
		}
		const receipt = store.backup(join(dir, "large-backup.sqlite"));
		expect(receipt.bytes).toBeGreaterThan(300 * 1024 * 1024);
		expect(receipt.bytes).toBeLessThan(330 * 1024 * 1024);
		expect(receipt.bytes).toBe(statSync(receipt.path).size);
		expect(receipt.results).toMatchObject({ blobs: 1, path: `${receipt.path}.results` });
		expect(readdirSync(dir).filter((name) => name.includes(".backup-"))).toEqual([]);
		expect(fenceOf(receipt.path)).toEqual(fencedWith(1));
		const restored = new FleetStore(receipt.path, 2, { readOnly: true });
		try {
			expect(restored.task(id)!.resultManifest).toStrictEqual({ patch: "m".repeat(5000), status: "verified" });
		} finally {
			restored.close();
		}
	} finally {
		store.close();
	}
}, 120_000);

test("rollback: a retried manifest never reuses GC-deleted uncommitted blobs", () => {
	const path = join(fixture(), "fleet.sqlite");
	const store = onStore(path);
	const raw = new Database(path);
	try {
		// Warm the v3 fence first, so the failed save does not roll it back.
		legacyRow(path, store, "seed", { patch: "seed".repeat(500) });
		expect(store.migrateResults(true)).toMatchObject({ migrated: 1, failed: [] });
		const id = running(store, "retry");
		const manifest = { patch: "retry".repeat(1000) };
		const before = rowOf(path, id);
		raw.exec("CREATE TRIGGER refuse_retry BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'injected_retry_failure'); END;");
		expect(code(() => store.saveResult(id, manifest))).not.toBe("ok");
		expect(rowOf(path, id)).toBe(before);
		raw.exec("DROP TRIGGER refuse_retry");
		expect(store.collectResults(true)).toMatchObject({ removed: [hash(manifest.patch)] });
		expect(existsSync(join(`${path}.results`, hash(manifest.patch)))).toBe(false);
		// Deliberately reuse object identity, not a clone.
		store.saveResult(id, manifest);
		expect(store.task(id)!.resultManifest).toEqual(manifest);
		expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
	} finally {
		raw.close();
		store.close();
	}
});

test("rollback: first externalisation failure clears cache so GC then retry can take the one-way step", () => {
	const path = join(fixture(), "fleet.sqlite");
	const store = onStore(path);
	const raw = new Database(path);
	try {
		expect(store.resultStoreStatus()).toMatchObject({
			externalisation: "on",
			userVersion: 2,
			oneWayStepTaken: false,
		});
		expect(fenceOf(path)).toEqual(armed);
		const id = running(store, "first-ext");
		const manifest = { patch: "first-ext".repeat(800) };
		const before = rowOf(path, id);
		raw.exec(
			"CREATE TRIGGER refuse_first BEFORE INSERT ON audit WHEN NEW.kind='result_store_format_step' BEGIN SELECT RAISE(ABORT, 'injected_first_externalisation'); END;",
		);
		expect(code(() => store.saveResult(id, manifest))).not.toBe("ok");
		expect(fenceOf(path)).toEqual(armed);
		expect(rowOf(path, id)).toBe(before);
		raw.exec("DROP TRIGGER refuse_first");
		expect(store.collectResults(true)).toMatchObject({ removed: [hash(manifest.patch)] });
		expect(existsSync(join(`${path}.results`, hash(manifest.patch)))).toBe(false);
		// Same object identity after GC: WeakMap must not keep the rolled-back encoding.
		store.saveResult(id, manifest);
		expect(store.resultStoreStatus()).toMatchObject({
			externalisation: "on",
			userVersion: 3,
			oneWayStepTaken: true,
		});
		expect(store.task(id)!.resultManifest).toEqual(manifest);
		expect(store.resultInventory()).toMatchObject({ missing: [], corrupt: [], rows: [] });
	} finally {
		raw.close();
		store.close();
	}
});

test("gc: an emptied blob list cannot authorize deletion of recoverable contents", () => {
	const path = join(fixture(), "fleet.sqlite");
	const store = onStore(path);
	const raw = new Database(path);
	try {
		const id = running(store);
		const manifest = { patch: "recoverable".repeat(1000) };
		store.saveResult(id, manifest);
		const before = rowOf(path, id);
		const damaged = JSON.parse(before);
		damaged.resultExternal.blobs = [];
		raw.query("UPDATE tasks SET data=? WHERE id=?").run(canonicalJson(damaged), id);
		const blob = join(`${path}.results`, hash(manifest.patch), "data");
		expect(code(() => store.collectResults(true))).toBe("RESULT_INTEGRITY");
		expect(readFileSync(blob, "utf8")).toBe(manifest.patch);
		// Restoring the reference list can still recover the original result.
		raw.query("UPDATE tasks SET data=? WHERE id=?").run(before, id);
		expect(store.task(id)!.resultManifest).toEqual(manifest);
		expect(store.collectResults(true)).toMatchObject({ removed: [] });
	} finally {
		raw.close();
		store.close();
	}
});
