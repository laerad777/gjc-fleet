import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TaskInput } from "../src/contracts";
import { observationDigest } from "../src/core";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";

const directories: string[] = [];
const stores: FleetStore[] = [];
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function open(path: string) {
	const store = new FleetStore(path, 2);
	stores.push(store);
	return store;
}
function input(key: string): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "backup-operator",
		repoId: "repo",
		baseCommit: "a".repeat(40),
		prompt: "private prompt",
		required: {},
	};
}
function fixture() {
	const dir = mkdtempSync(
		join(process.env.FLEET_BACKUP_TEST_ROOT ?? tmpdir(), "fleet-backup-"),
	);
	directories.push(dir);
	const path = join(dir, "source.sqlite");
	const store = open(path);
	store.putNode({
		id: "node",
		os: "linux",
		arch: "arm64",
		roots: { repo: "/repos/repo" },
		workspaceRoot: "/work",
		maxConcurrency: 2,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: ["model"],
		// Any accidental remote dispatch in the CLI test must fail, not succeed.
		transport: { command: "fleet-backup-must-not-dispatch", args: [] },
		operations: ["read", "write"],
	});
	const checkpoint = new Database(path);
	try {
		checkpoint.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		checkpoint.close();
	}
	const unknown = store.reserve(store.submit(input("unknown")).id);
	store.recordSession(unknown.id, "original-session", true);
	store.recordTurn(unknown.id, "original-turn");
	store.beginOperation(unknown.id, "send", { prompt: "private prompt" });
	store.saveResult(unknown.id, {
		status: "unknown",
		taskId: unknown.id,
		attemptId: unknown.attemptId!,
		files: [],
	});
	store.markUnknown(unknown.id, "send_response_lost");
	const held = store.reserve(store.submit(input("held")).id);
	store.recordSession(held.id, "held-session", true);
	store.recordTurn(held.id, "held-turn");
	const pendingPayload = {
		questionId: "original-question",
		answer: "operator decision",
	};
	store.beginOperation(held.id, "answer", pendingPayload);
	const observation = {
		sessionId: "held-session",
		turnId: "held-turn",
		status: "approval_required" as const,
		terminal: false,
		evidence: { source: "controlled-backup-fixture" },
	};
	store.observe(held.id, {
		eventId: "approval-receipt",
		digest: observationDigest(observation),
		...observation,
	});
	return { dir, path, store, unknown, held, pendingPayload };
}
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

test("WAL snapshot reopens with exact identities, held slots, unknown effects and pending operations without replay", () => {
	const { dir, path, store, unknown, held, pendingPayload } = fixture();
	const before = store.tasks();
	const events = before.map((task) => store.events(task.id));
	const unknownIntent = store.getOperation(unknown.id, "send");
	const heldIntent = store.getOperation(held.id, "answer");
	// Prove the committed records are still in WAL, not just the main file.
	expect(statSync(`${path}-wal`).size).toBeGreaterThan(32);
	expect(readFileSync(path).includes(Buffer.from(unknown.id))).toBe(false);
	expect(readFileSync(`${path}-wal`).includes(Buffer.from(unknown.id))).toBe(
		true,
	);
	const receipt = store.backup(join(dir, "snapshot.sqlite"));
	const bytes = readFileSync(receipt.path);
	expect(receipt.bytes).toBe(bytes.byteLength);
	expect(receipt.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
	if (process.platform !== "win32")
		expect(statSync(receipt.path).mode & 0o777).toBe(0o600);
	expect(store.tasks()).toEqual(before);
	expect(before.map((task) => store.events(task.id))).toEqual(events);
	const integrity = new Database(receipt.path, { readonly: true });
	try {
		expect(integrity.query("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
	} finally {
		integrity.close();
	}
	// SQLite may leave an unused SHM after its journal transition. Prove that
	// the returned main file actually stands alone, rather than assuming cleanup.
	const portablePath = join(dir, "portable.sqlite");
	writeFileSync(portablePath, bytes, { flag: "wx", mode: 0o600 });
	const standalone = new Database(portablePath, { readonly: true });
	try {
		expect(standalone.query("PRAGMA integrity_check").get()).toEqual({
			integrity_check: "ok",
		});
		expect(standalone.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "delete",
		});
	} finally {
		standalone.close();
	}
	for (const suffix of ["-wal", "-shm", "-journal"])
		expect(existsSync(`${portablePath}${suffix}`)).toBe(false);
	const sourceMode = new Database(path, { readonly: true });
	try {
		expect(sourceMode.query("PRAGMA journal_mode").get()).toEqual({
			journal_mode: "wal",
		});
	} finally {
		sourceMode.close();
	}
	const clone = open(receipt.path);
	expect(clone.tasks()).toEqual(before);
	expect(clone.nodes()).toEqual(store.nodes());
	expect(before.map((task) => clone.events(task.id))).toEqual(events);
	expect(clone.getOperation(unknown.id, "send")).toEqual(unknownIntent);
	expect(clone.getOperation(held.id, "answer")).toEqual(heldIntent);
	expect(clone.task(unknown.id)?.reason).toBe("send_response_lost");
	expect(clone.task(unknown.id)?.resultManifest).toEqual(
		store.task(unknown.id)?.resultManifest,
	);
	expect(clone.submit(input("unknown")).id).toBe(unknown.id);
	expect(clone.reserve(unknown.id)).toEqual(store.task(unknown.id)!);
	expect(() =>
		clone.claimOperation(unknown.id, "send", { prompt: "private prompt" }),
	).toThrow("Unknown execution");
	expect(clone.claimOperation(held.id, "answer", pendingPayload)).toBeNull();
	expect(clone.getOperation(held.id, "answer")).toEqual(heldIntent);
	// Both held attempts survive the snapshot and still consume the node's measured headroom.
	const queued = clone.reserve(clone.submit(input("clone-only")).id, headroom(["node"], 2));
	expect(queued.held).toBe(false);
	expect(queued.reason).toBe("no_eligible_node");
	clone.setNodeState("node", { draining: true });
	expect(store.nodes()[0]?.draining).toBe(false);
	expect(store.tasks()).toEqual(before);
	const later = store.submit(input("source-after-snapshot"));
	expect(store.task(later.id)).toEqual(later);
	expect(clone.task(later.id)).toBeUndefined();
	expect(store.tasks().filter((task) => task.held)).toHaveLength(2);
});

test("existing destination and stale companions are refused unchanged; failure never releases reservations", () => {
	const { dir, path, store } = fixture();
	const before = store.tasks();
	const audits = before.map((task) => store.events(task.id));
	const destination = join(dir, "existing.sqlite");
	const sentinel = Buffer.from("operator-owned bytes\0do not overwrite");
	writeFileSync(destination, sentinel, { mode: 0o640 });
	const mode = statSync(destination).mode;
	expect(() => store.backup(destination)).toThrow("backup_destination_exists");
	expect(readFileSync(destination)).toEqual(sentinel);
	expect(statSync(destination).mode).toBe(mode);
	const sourceBytes = readFileSync(path);
	expect(() => store.backup(path)).toThrow("backup_destination_exists");
	expect(readFileSync(path)).toEqual(sourceBytes);
	const stale = join(dir, "stale.sqlite");
	writeFileSync(`${stale}-wal`, sentinel);
	expect(() => store.backup(stale)).toThrow("backup_destination_exists");
	expect(readFileSync(`${stale}-wal`)).toEqual(sentinel);
	if (process.platform !== "win32") {
		const link = join(dir, "link.sqlite");
		symlinkSync(destination, link);
		expect(() => store.backup(link)).toThrow("backup_destination_exists");
		expect(readFileSync(destination)).toEqual(sentinel);
	}
	expect(() =>
		store.backup(join(dir, "missing-parent", "snapshot.sqlite")),
	).toThrow("backup_failed");
	expect(store.tasks()).toEqual(before);
	expect(before.map((task) => store.events(task.id))).toEqual(audits);
	const queued = store.reserve(
		store.submit(input("still-full-after-failure")).id,
		headroom(["node"], 2),
	);
	expect(queued.reason).toBe("no_eligible_node");
	expect(queued.held).toBe(false);
});

test("operator backup argv returns path, byte count and digest only; refuses overwrite and never dispatches", async () => {
	const { dir, path, store } = fixture();
	const before = store.tasks();
	const destination = join(dir, "cli snapshot.sqlite");
	async function run(...args: string[]) {
		const child = Bun.spawn(
			[
				process.execPath,
				cliPath,
				"--db",
				path,
				"--cap",
				"2",
				"backup",
				...args,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exit };
	}
	const first = await run(destination);
	expect(first.exit).toBe(0);
	expect(first.stderr).toBe("");
	const receipt = JSON.parse(first.stdout);
	expect(receipt.ok).toBe(true);
	expect(receipt.path).toBe(destination);
	expect(receipt.bytes).toBe(statSync(destination).size);
	expect(receipt.sha256).toBe(
		createHash("sha256").update(readFileSync(destination)).digest("hex"),
	);
	expect(first.stdout).not.toContain("private prompt");
	expect(receipt.restored).toBeUndefined();
	const saved = readFileSync(destination);
	const second = await run(destination);
	expect(second.exit).toBe(1);
	expect(JSON.parse(second.stderr)).toEqual({
		ok: false,
		error: "BACKUP_EXISTS",
	});
	expect(readFileSync(destination)).toEqual(saved);
	expect((await run()).exit).toBe(1);
	expect((await run(join(dir, "unused.sqlite"), "unexpected")).exit).toBe(1);
	expect(store.tasks()).toEqual(before);
	const clone = open(destination);
	expect(clone.tasks()).toEqual(before);
});
