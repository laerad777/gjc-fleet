import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FleetStore } from "../src/store";
import { digest, FleetError } from "../src/core";
import type { NodeConfig, TaskInput, TaskRecord } from "../src/contracts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function directory() {
	const root = mkdtempSync(join(tmpdir(), "fleet-read-only-"));
	roots.push(root);
	return root;
}
const cliPath = resolve(import.meta.dir, "../src/cli.ts");
async function run(db: string, args: string[], preload?: string) {
	return runRaw(["--db", db, "--read-only", ...args], undefined, preload);
}
async function runRaw(args: readonly string[], cwd?: string, preload?: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			...(preload ? ["--preload", preload] : []),
			cliPath,
			...args,
		],
		{ cwd, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exit };
}
function image(path: string) {
	return { bytes: readFileSync(path), mode: statSync(path).mode };
}
function unchanged(path: string, before: ReturnType<typeof image>) {
	expect(readFileSync(path).equals(before.bytes)).toBe(true);
	// Compare the host's actual pre/post mode, including on Windows.
	expect(statSync(path).mode).toBe(before.mode);
}
function input(key: string): TaskInput {
	return {
		schemaVersion: 1,
		key,
		caller: "local-read-only-test",
		repoId: "repo",
		baseCommit: "a".repeat(40),
		prompt: "PRIVATE_PROMPT_CONTENT",
		required: {},
	};
}
function fixture(root: string) {
	const path = join(root, "source.sqlite");
	const marker = join(root, "transport-called");
	const spy = join(root, "transport-spy.ts");
	writeFileSync(
		spy,
		`await Bun.write(${JSON.stringify(marker)}, "called"); process.exit(91);`,
	);
	const transport = { command: process.execPath, args: [spy] };
	const node: NodeConfig = {
		id: "local",
		os: process.platform,
		arch: process.arch,
		roots: { repo: root },
		workspaceRoot: join(root, "workspaces"),
		maxConcurrency: 2,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport,
		workspaceTransport: transport,
		sdkTransport: transport,
	};
	const store = new FleetStore(path);
	store.putNode(node);
	const prepared = store.reserve(store.submit(input("prepared")).id);
	store.setWorkspace(prepared.id, { path: join(root, "prepared-workspace") });
	const held = store.reserve(store.submit(input("held")).id);
	store.setWorkspace(held.id, { path: join(root, "held-workspace") });
	const operation = store.beginOperation(held.id, "create", {
		cwd: join(root, "held-workspace"),
	});
	store.recordSession(held.id, "exact-session", true);
	store.recordTurn(held.id, "exact-turn");
	store.markUnknown(held.id, "original_close_unknown_held");
	return {
		path,
		store,
		prepared,
		held: store.task(held.id)!,
		operation,
		marker,
		node,
	};
}
function snapshot(root: string) {
	const source = fixture(root);
	const path = join(root, "snapshot.sqlite");
	try {
		// Synthetic settled record exercises projection only, not remote authority.
		const completed: TaskRecord = {
			...source.held,
			id: "verified-task",
			attemptId: "verified-attempt",
			sessionId: "verified-session",
			turnId: "verified-turn",
			input: {
				...input("verified"),
				inputPackage: {
					schemaVersion: 1,
					repoId: "repo",
					baseCommit: "a".repeat(40),
					digest: "b".repeat(64),
					changes: [
						{ path: "safe.txt", after: { content: "PRIVATE_PACKAGE_CONTENT" } },
					],
					objects: [{ content: "PRIVATE_OBJECT_CONTENT" }],
					authorization: { reference: "PRIVATE_AUTHORIZATION_CONTENT" },
				} as any,
			},
			phase: "succeeded",
			held: false,
			reason: undefined,
			result: {
				status: "completed_unverified",
				executionTerminal: true,
				verified: true,
				evidence: { content: "PRIVATE_EVIDENCE_CONTENT" },
				verificationEvidence: { content: "PRIVATE_VERIFICATION_CONTENT" },
			},
			resultManifest: {
				status: "ok",
				files: [{ content: "PRIVATE_MANIFEST_CONTENT" }],
				tests: [],
			},
			testReceipt: { exit: 0, output: "PRIVATE_TEST_OUTPUT" },
		};
		const db = new Database(source.path, { strict: true });
		try {
			db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(
				completed.id,
				completed.input.caller,
				completed.input.key,
				digest(completed.input),
				JSON.stringify(completed),
			);
		} finally {
			db.close();
		}
		source.store.backup(path);
		return { ...source, path, completed };
	} finally {
		source.store.close();
	}
}
function readOnlyError(action: () => unknown) {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(FleetError);
	expect((error as FleetError).code).toBe("READ_ONLY");
}

describe("explicit compatible local read-only observation", () => {
	test("normalized DELETE snapshot preserves bytes, modes, neighbors and exact identity while omitting private bodies", async () => {
		const root = directory();
		const f = snapshot(root);
		const neighbor = join(root, "unrelated");
		writeFileSync(neighbor, "unrelated bytes");
		chmodSync(f.path, 0o640);
		const before = image(f.path);
		const neighborBefore = image(neighbor);
		const names = readdirSync(root).sort();
		const db = new Database(f.path, { readonly: true, create: false });
		try {
			expect(db.query("PRAGMA journal_mode").get()).toEqual({
				journal_mode: "delete",
			});
		} finally {
			db.close();
		}
		const tasks = await run(f.path, ["tasks"]);
		expect(tasks.exit).toBe(0);
		const rows = JSON.parse(tasks.stdout);
		const held = rows.find((task: TaskRecord) => task.id === f.held.id);
		expect(held).toMatchObject({
			id: f.held.id,
			attemptId: f.held.attemptId,
			nodeId: "local",
			sessionId: "exact-session",
			turnId: "exact-turn",
			held: true,
			phase: "blocked_unknown",
			reason: "original_close_unknown_held",
		});
		const shown = await run(f.path, ["show", f.completed.id]);
		expect(shown.exit).toBe(0);
		expect(JSON.parse(shown.stdout)).toMatchObject({
			id: f.completed.id,
			held: false,
			result: {
				verified: true,
				executionTerminal: true,
				evidence: { digest: digest(f.completed.result!.evidence) },
				verificationEvidence: {
					digest: digest(f.completed.result!.verificationEvidence),
				},
			},
			input: {
				inputPackage: {
					digest: "b".repeat(64),
					paths: ["safe.txt"],
					objects: 1,
				},
			},
			resultManifest: { status: "ok", files: 1, tests: 0 },
			testReceipt: { exit: 0 },
		});
		for (const output of [tasks.stdout, shown.stdout]) {
			expect(output).not.toContain("PRIVATE_");
			expect(output).toContain("[omitted; retained in private database]");
		}
		const events = await run(f.path, ["events", f.held.id]);
		expect(events.exit).toBe(0);
		expect(events.stdout).not.toContain("PRIVATE_");
		expect(JSON.parse(events.stdout)).toContainEqual(
			expect.objectContaining({
				kind: "operation_intent",
				taskId: f.held.id,
				data: {
					id: f.operation.id,
					key: f.operation.key,
					digest: f.operation.digest,
					kind: "create",
					observability: {
						version: 1,
						attributes: {
							taskId: f.held.id,
							attemptId: f.held.attemptId,
							nodeId: "local",
							inputDigest: f.held.inputDigest,
							operationId: f.operation.id,
							operationKey: f.operation.key,
							payloadDigest: f.operation.digest,
						},
					},
				},
			}),
		);
		expect(JSON.parse(events.stdout)).toContainEqual(
			expect.objectContaining({
				kind: "reserved",
				data: {
					nodeId: "local",
					attemptId: f.held.attemptId,
					observability: {
						version: 1,
						attributes: {
							taskId: f.held.id,
							attemptId: f.held.attemptId,
							nodeId: "local",
							inputDigest: f.held.inputDigest,
						},
					},
				},
			}),
		);
		const nodes = await run(f.path, ["node", "list"]);
		expect(nodes.exit).toBe(0);
		// The stored node, plus the per-call Coordinator timeout in effect for it (no transport.timeoutMs: the OS default).
		expect(JSON.parse(nodes.stdout)).toEqual([{ ...f.node, effectiveRpcTimeoutMs: f.node.os === "win32" ? 120_000 : 30_000 }]);
		const observation = await run(f.path, ["observability"]);
		expect(observation.exit).toBe(0);
		expect(JSON.parse(observation.stdout)).toMatchObject({
			scope: "persisted_local_snapshot",
			gauges: {
				reserved_slots: 2,
				active_tasks: 0,
				unknown_tasks: 1,
				approval_tasks: 0,
			},
		});
		expect(observation.stdout).not.toContain("PRIVATE_");
		unchanged(f.path, before);
		unchanged(neighbor, neighborBefore);
		expect(readdirSync(root).sort()).toEqual(names);
		expect(existsSync(f.marker)).toBe(false);
	});

	test("actual live WAL committed rows remain visible without initialization or migration", async () => {
		const root = directory();
		const f = fixture(root);
		try {
			expect(existsSync(`${f.path}-wal`)).toBe(true);
			const before = image(f.path);
			const wal = image(`${f.path}-wal`);
			const result = await run(f.path, ["show", f.held.id]);
			expect(result.exit).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				id: f.held.id,
				sessionId: "exact-session",
				turnId: "exact-turn",
				held: true,
				phase: "blocked_unknown",
			});
			const reader = new FleetStore(f.path, 2, { readOnly: true });
			try {
				expect(reader.events(f.held.id)).toEqual(f.store.events(f.held.id));
			} finally {
				reader.close();
			}
			unchanged(f.path, before);
			unchanged(`${f.path}-wal`, wal);
			// SQLite may use existing SHM/read locks. No SHM byte-immutability claim.
		} finally {
			f.store.close();
		}
	});

	test("missing database does not create a file or parent, including CLI help", async () => {
		const root = directory();
		const path = join(root, "absent-parent", "missing.sqlite");
		expect(() => new FleetStore(path, 2, { readOnly: true })).toThrow();
		const result = await run(path, ["tasks"]);
		expect(result.exit).toBe(1);
		expect(existsSync(join(root, "absent-parent"))).toBe(false);
		const help = await run(path, ["--help"]);
		expect(help.exit).toBe(0);
		expect(help.stdout).toContain("NOT live remote settlement");
		expect(existsSync(join(root, "absent-parent"))).toBe(false);
	});

	test.each([
		{ args: ["--db", "--read-only", "tasks"], error: "db_path_required" },
		{ args: ["--read-only", "--db"], error: "db_path_required" },
		{ args: ["--db"], error: "db_path_required" },
		{
			args: ["--db", "--cap", "2", "--read-only", "tasks"],
			error: "db_path_required",
		},
		{ args: ["--cap", "--read-only", "tasks"], error: "cap_value_required" },
		{ args: ["--read-only", "--cap"], error: "cap_value_required" },
		{ args: ["--cap"], error: "cap_value_required" },
		{
			args: ["--cap", "--db", "absent/db.sqlite", "--read-only", "tasks"],
			error: "cap_value_required",
		},
		{
			args: ["--db", "absent/db.sqlite", "--cap", "--read-only", "tasks"],
			error: "cap_value_required",
		},
	])("malformed option values reject without any files: $args", async ({
		args,
		error,
	}) => {
		const root = directory();
		expect(readdirSync(root)).toEqual([]);
		const result = await runRaw(args, root);
		expect(result.exit).not.toBe(0);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toEqual({ ok: false, error });
		expect(readdirSync(root)).toEqual([]);
		expect(existsSync(join(root, ".local"))).toBe(false);
		expect(existsSync(join(root, "absent"))).toBe(false);
		expect(existsSync(join(root, "--read-only"))).toBe(false);
	});

	test("explicit relative option-like database filename remains supported", async () => {
		const root = directory();
		const source = fixture(root);
		const path = join(root, "--read-only");
		try {
			source.store.backup(path);
		} finally {
			source.store.close();
		}
		const before = image(path);
		const names = readdirSync(root).sort();
		const result = await runRaw(
			["--db", "./--read-only", "--cap", "2", "--read-only", "tasks"],
			root,
		);
		expect(result.exit).toBe(0);
		expect(JSON.parse(result.stdout)).toContainEqual(
			expect.objectContaining({ id: source.held.id }),
		);
		unchanged(path, before);
		expect(readdirSync(root).sort()).toEqual(names);
		expect(existsSync(join(root, ".local"))).toBe(false);
	});

	test("invalid readOnly options fail before opening or creating a database", () => {
		const root = directory();
		const path = join(root, "absent-parent", "invalid-options.sqlite");
		for (const options of [null, { readOnly: "true" }, { readOnly: 1 }])
			expect(() => new FleetStore(path, 2, options as any)).toThrow();
		expect(existsSync(join(root, "absent-parent"))).toBe(false);
	});

	test("unrelated, unsupported, uninitialized and cap-mismatched databases fail without repair", async () => {
		for (const kind of [
			"unrelated",
			"schema3",
			"version2-meta1",
			"version1-meta2",
			"uninitialized",
			"cap",
			"appid",
			"missing-meta",
			"empty-meta",
		]) {
			const root = directory();
			const path = join(root, "invalid.sqlite");
			const db = new Database(path);
			try {
				db.exec("PRAGMA journal_mode=DELETE");
				if (kind !== "uninitialized") {
					db.exec(
						`PRAGMA application_id=${kind === "appid" || kind === "unrelated" ? 42 : 0x47464c54}; PRAGMA user_version=${kind === "schema3" ? 3 : kind === "version2-meta1" ? 2 : 1};`,
					);
					if (kind !== "missing-meta") {
						db.exec(
							"CREATE TABLE fleet_meta(id INTEGER PRIMARY KEY, schema_version INTEGER, global_cap INTEGER)",
						);
						if (kind !== "empty-meta")
							db.exec(
								`INSERT INTO fleet_meta VALUES(1,${kind === "version1-meta2" ? 2 : 1},${kind === "cap" ? 3 : 2})`,
							);
					}
				}
			} finally {
				db.close();
			}
			chmodSync(path, 0o640);
			const before = image(path);
			const names = readdirSync(root).sort();
			expect(() => new FleetStore(path, 2, { readOnly: true })).toThrow();
			const result = await run(path, ["tasks"]);
			expect(result.exit).toBe(1);
			unchanged(path, before);
			expect(readdirSync(root).sort()).toEqual(names);
		}
	});

	test("nonregular and shared main files are refused", () => {
		const root = directory();
		const f = snapshot(root);
		expect(() => new FleetStore(root, 2, { readOnly: true })).toThrow();
		const alias = join(root, "hardlink.sqlite");
		linkSync(f.path, alias);
		const before = image(f.path);
		expect(() => new FleetStore(f.path, 2, { readOnly: true })).toThrow();
		expect(() => new FleetStore(alias, 2, { readOnly: true })).toThrow();
		unchanged(f.path, before);
	});

	test("all transactional mutation families and destination backup refuse before audit or intent writes", () => {
		const root = directory();
		const f = snapshot(root);
		const before = image(f.path);
		const store = new FleetStore(f.path, 2, { readOnly: true });
		try {
			const tasks = store.tasks();
			const events = store.events(f.held.id);
			const op = store.getOperation(f.held.id, "create");
			const actions = [
				() => store.putNode(f.node),
				() => store.setNodeState("local", { enabled: false }),
				() => store.submit(input("new")),
				() => store.reserve(f.prepared.id),
				() => store.beginOperation(f.held.id, "prompt", {}),
				() => store.claimOperation(f.held.id, "prompt", {}),
				() => store.recordSession(f.held.id, "new-session"),
				() => store.recordTurn(f.held.id, "new-turn"),
				() => store.setWorkspace(f.held.id, { path: "private" }),
				() => store.markUnknown(f.held.id, "reason"),
				() => store.markBlocked(f.held.id, "reason"),
				() => store.markObservationUnknown(f.held.id, 1, "reason"),
				() => store.beginObservation(f.held.id),
				() => store.observe(f.held.id, {} as any),
				() => store.recordSessionAuthority(f.held.id, {} as any),
				() => store.admitCancellation(f.held.id, f.held, {} as any),
				() => store.claimCancellationClose(f.held.id, {}),
				() => store.retainCancellationReply(f.held.id, "abort", {}),
				() => store.finishCancellation(f.held.id, {}),
				() => store.cancellationUnknown(f.held.id, "reason"),
				() => store.saveResult(f.held.id, {}),
				() => store.recordVerification(f.held.id, {}),
				() => store.verifyResult(f.held.id, {}),
				() => store.recordResultValidationRejected(f.held.id, "RESULT_BINDING"),
				() => store.backup(join(root, "forbidden-export.sqlite")),
			];
			for (const action of actions) readOnlyError(action);
			expect(store.tasks()).toEqual(tasks);
			expect(store.events(f.held.id)).toEqual(events);
			expect(store.getOperation(f.held.id, "create")).toEqual(op);
			expect(store.getOperation(f.held.id, "prompt")).toBeUndefined();
			expect(existsSync(join(root, "forbidden-export.sqlite"))).toBe(false);
		} finally {
			store.close();
		}
		unchanged(f.path, before);
	});

	test.each([
		"node add",
		"node drain",
		"node enable",
		"node disable",
		"submit",
		"start",
		"poll",
		"answer",
		"ordinary",
		"result",
		"cancel",
		"stop",
		"backup",
		"export",
		"input preview",
		"input authorize",
		"input import",
		"unknown",
	])("actual CLI entrypoint rejects %s before file input, store initialization or transport", async (route) => {
		// This proves the local entrypoint gate only, not SDK retirement, old-binary
		// compatibility or a remote epoch fence. No real SDK/GJC/network is used.
		const root = directory();
		const f = snapshot(root);
		const privateInput = join(root, "private.json");
		writeFileSync(
			privateInput,
			JSON.stringify({ payload: "PRIVATE_COMMAND_PAYLOAD" }),
		);
		const inputMarker = join(root, "input-read");
		const preload = join(root, "input-spy.ts");
		writeFileSync(
			preload,
			`const original = Bun.file; Bun.file = function(path, ...args) {
			if (String(path) === ${JSON.stringify(privateInput)}) {
				Bun.write(${JSON.stringify(inputMarker)}, "read"); throw new Error("PRIVATE_INPUT_WAS_READ");
			} return original(path, ...args); };`,
		);
		const destination = join(root, "forbidden-output");
		const commands = [
			["node", "add", privateInput],
			["node", "drain", "local"],
			["node", "enable", "local"],
			["node", "disable", "local"],
			["submit", privateInput],
			["start", f.prepared.id],
			["poll", f.held.id],
			["answer", f.held.id, privateInput],
			["ordinary", f.held.id],
			["result", f.held.id, privateInput],
			["cancel", f.held.id],
			["stop", f.held.id],
			["backup", destination],
			["export", destination],
			["input", "preview", privateInput, destination],
			[
				"input",
				"authorize",
				privateInput,
				"b".repeat(64),
				"PRIVATE_REFERENCE",
				destination,
			],
			["input", "import", privateInput, destination],
			["unknown", privateInput],
		];
		const before = image(f.path);
		const privateBefore = image(privateInput);
		const names = readdirSync(root).sort();
		const command = commands.find(
			(args) =>
				(args[0] === "node" || args[0] === "input"
					? args.slice(0, 2).join(" ")
					: args[0]) === route,
		)!;
		expect(command).toBeDefined();
		const result = await run(f.path, command, preload);
		expect(result.exit).toBe(1);
		expect(result.stdout).toBe("");
		expect(JSON.parse(result.stderr)).toEqual({
			ok: false,
			error: "READ_ONLY",
		});
		expect(existsSync(destination)).toBe(false);
		expect(existsSync(inputMarker)).toBe(false);
		expect(existsSync(f.marker)).toBe(false);
		// A missing parent proves refusal precedes even writable store creation.
		const absent = join(root, "absent", "db.sqlite");
		const rejected = await run(absent, ["start", f.prepared.id], preload);
		expect(JSON.parse(rejected.stderr)).toEqual({
			ok: false,
			error: "READ_ONLY",
		});
		expect(existsSync(join(root, "absent"))).toBe(false);
		unchanged(f.path, before);
		unchanged(privateInput, privateBefore);
		expect(readdirSync(root).sort()).toEqual(names);
		const reader = new FleetStore(f.path, 2, { readOnly: true });
		try {
			expect(reader.task(f.prepared.id)).toMatchObject({
				attemptId: f.prepared.attemptId,
				phase: "preparing",
				held: true,
			});
			expect(reader.getOperation(f.prepared.id, "create")).toBeUndefined();
			expect(reader.getOperation(f.prepared.id, "prompt")).toBeUndefined();
			expect(reader.task(f.held.id)).toEqual(f.held);
		} finally {
			reader.close();
		}
	});
});
