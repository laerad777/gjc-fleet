import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { repositoryFixture } from "./fixtures/coordinator";
import {
	oneShot,
	NodeReplyError,
	NODE_ERROR_LOG_MAX_BYTES,
	appendNodeErrorLog,
	nodeErrorLogTestHooks,
	nodeErrorLogSupportsNoFollow,
} from "../src/node";
import { prepareWorkspace, sha256 } from "../src/workspace";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";

const dirs: string[] = [];
// Windows cannot remove a directory a process still uses (cwd, open handle): a timed-out helper's
// tree is terminated by taskkill /T asynchronously, after oneShot already rejected. Bun ignores
// rm's maxRetries, so the bounded wait for that termination is explicit.
async function removeDir(dir: string) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await rm(dir, { recursive: true, force: true });
		} catch (error: any) {
			if (process.platform !== "win32" || error?.code !== "EBUSY" || attempt >= 30) throw error;
			await Bun.sleep(100);
		}
	}
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await removeDir(dir);
});
async function fixture() {
	const f = await repositoryFixture("node-refusal-");
	dirs.push(f.dir);
	const node = {
		id: "node",
		os: process.platform,
		arch: process.arch,
		roots: { repo: f.repo },
		workspaceRoot: f.workspaceRoot,
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: [],
		operations: [],
		transport: { command: process.execPath, args: [] },
	};
	const config = join(f.dir, "config.json");
	await writeFile(config, JSON.stringify(node));
	const input = {
		taskId: "task",
		attemptId: "attempt",
		nodeId: "node",
		inputDigest: sha256("input"),
		baseCommit: f.baseCommit,
		repoId: "repo",
	};
	const identity = await prepareWorkspace({
		...input,
		repo: f.repo,
		workspaceRoot: f.workspaceRoot,
	});
	const args = [resolve(import.meta.dir, "../src/node.ts"), config];
	return {
		...f,
		config,
		node,
		input,
		identity,
		args,
		call: (request: any) => oneShot(process.execPath, args, request),
	};
}
async function refusal(
	call: Promise<any>,
	category: NodeReplyError["reply"]["error"],
	certainty: "before_send" | "unknown" = "before_send",
) {
	try {
		await call;
		throw new Error("expected refusal");
	} catch (e) {
		expect(e).toBeInstanceOf(NodeReplyError);
		const error = e as NodeReplyError;
		expect(error.reply.error).toBe(category);
		expect(error.certainty).toBe(certainty);
		expect(JSON.stringify(error.reply)).not.toContain("node-refusal-");
		return error.reply;
	}
}
test("actual helper: invalid request, identity and root refusals survive nonzero exit", async () => {
	const f = await fixture();
	await refusal(f.call({ action: "bogus" }), "invalid_request");
	await refusal(
		f.call({ action: "collect", identity: { ...f.identity, nodeId: "other" } }),
		"identity_mismatch",
	);
	await refusal(
		f.call({ action: "prepare", input: { ...f.input, repoId: "denied" } }),
		"root_denied",
	);
});
test("actual helper: missing workspace proves no command ran", async () => {
	const f = await fixture();
	await rm(f.identity.path, { recursive: true });
	await refusal(
		f.call({
			action: "test",
			identity: f.identity,
			argv: [process.execPath, "-e", "process.exit(0)"],
		}),
		"workspace_missing",
	);
});
test("actual helper: a source-root refusal is decided by the committed tree and repository configuration, before any effect", async () => {
	const f = await fixture();
	const input = { ...f.input, attemptId: "refused" };
	const path = join(f.workspaceRoot, "task-refused");
	// Checkout filters would run during materialization: refused before the first effect.
	await f.git("config", "filter.fleet-refusal.clean", "cat");
	for (const action of ["preflight", "prepare"])
		await refusal(f.call({ action, input }), "root_denied");
	expect(await Bun.file(join(path, ".fleet-identity.json")).exists()).toBe(false);
	await f.git("config", "--remove-section", "filter.fleet-refusal");
	// A committed gitlink is a nested repository preparation cannot materialize.
	await f.git("update-index", "--add", "--cacheinfo", "160000," + f.baseCommit + ",vendor/sub");
	await f.git("commit", "-qm", "gitlink");
	const gitlink = await f.git("rev-parse", "HEAD");
	await refusal(
		f.call({ action: "prepare", input: { ...input, baseCommit: gitlink } }),
		"nested_repository",
	);
	expect(await Bun.file(join(path, ".fleet-identity.json")).exists()).toBe(false);
});
test("actual helper: collected unignored symlink is unsafe after collection began and emits no target", async () => {
	const f = await fixture();
	const target = join(f.dir, "DO_NOT_DISCLOSE_SECRET");
	await writeFile(target, "secret");
	await symlink(target, join(f.identity.path, "link"));
	const reply = await refusal(
		f.call({ action: "collect", identity: f.identity }),
		"unsafe_path",
		"unknown",
	);
	expect(JSON.stringify(reply)).not.toContain("DO_NOT_DISCLOSE_SECRET");
});
test("actual helper: command output limit is answered but execution outcome is unknown", async () => {
	const f = await fixture();
	await refusal(
		f.call({
			action: "test",
			identity: f.identity,
			argv: [
				process.execPath,
				"-e",
				"process.stdout.write('x'.repeat(5*1024*1024))",
			],
		}),
		"output_limit",
		"unknown",
	);
});
test("actual helper: git failure before any effect is a proven refusal; after preparation begins it is not", async () => {
	const f = await fixture();
	// The base commit is not in the source root: read-only rev-parse fails, nothing was created.
	for (const action of ["preflight", "prepare"])
		await refusal(
			f.call({
				action,
				input: { ...f.input, attemptId: "new", baseCommit: "f".repeat(40) },
			}),
			"git_failed",
		);
	// Worktree registration fails after the checkout directory was created: an effect happened.
	await rm(join(f.repo, ".git", "worktrees"), { recursive: true });
	await writeFile(join(f.repo, ".git", "worktrees"), "not a directory");
	expect(
		(
			await f.call({ action: "preflight", input: { ...f.input, attemptId: "new" } })
		),
	).toEqual({ preflight: "passed" });
	await refusal(
		f.call({ action: "prepare", input: { ...f.input, attemptId: "new" } }),
		"git_failed",
		"unknown",
	);
});
test("actual helper: unknown exception has bounded correlation and local log", async () => {
	const f = await fixture();
	const request = { action: "test", identity: f.identity, argv: [f.dir] };
	// Caller assertions stay on every platform: error type, certainty, fixture marker hidden.
	const reply = await refusal(f.call(request), "internal", "unknown");
	const correlationId = "correlationId" in reply ? reply.correlationId : undefined;
	expect(correlationId).toMatch(/^[a-f0-9-]{36}$/);
	expect(JSON.stringify(reply)).not.toContain("node-refusal-");
	// Without O_NOFOLLOW (Windows), file logging is fail-closed. stderr must carry the
	// correlation id and error code together, not the id alone.
	if (!nodeErrorLogSupportsNoFollow) {
		const child = Bun.spawn([process.execPath, ...f.args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit).toBe(1);
		const helperReply = JSON.parse(stdout.trim());
		expect(helperReply).toMatchObject({
			ok: false,
			error: "internal",
			certainty: "unknown",
		});
		expect(helperReply.correlationId).toMatch(/^[a-f0-9-]{36}$/);
		expect(JSON.stringify(helperReply)).not.toContain("node-refusal-");
		const logLine = JSON.stringify({ correlationId: helperReply.correlationId, error: "internal" });
		expect(stderr.split(/\r?\n/).filter((line) => line.length > 0)).toContain(logLine);
		expect(stderr).not.toContain(f.dir);
		expect(stderr).not.toContain("node-refusal-");
		return;
	}
	const log = await readFile(resolve(import.meta.dir, "../src/.node-errors.log"), "utf8");
	expect(log).toContain(correlationId!);
	expect(log).not.toContain(f.dir);
});
test.skipIf(process.platform === "win32")("transport: oneShot deadline SIGKILLs a SIGTERM-trapping helper", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-oneshot-sigkill-"));
	const pidFile = join(dir, "pid");
	try {
		const t0 = Date.now();
		await expect(
			oneShot(
				"/bin/sh",
				[
					"-c",
					`trap '' TERM; echo $$ >${JSON.stringify(pidFile)}; while true; do sleep 1; done`,
				],
				{},
				200,
			),
		).rejects.toMatchObject({ code: "node_timeout", certainty: "unknown" });
		expect(Date.now() - t0).toBeLessThan(2_000);
		const pid = (await readFile(pidFile, "utf8")).trim();
		expect(pid).toMatch(/^\d+$/);
		const goneUntil = Date.now() + 500;
		let gone = false;
		while (Date.now() < goneUntil) {
			try {
				process.kill(Number(pid), 0);
			} catch {
				gone = true;
				break;
			}
			await Bun.sleep(10);
		}
		expect(gone).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("transport: oneShot deadline kills a hung execPath helper (cross-platform killTree)", async () => {
	// Complements the POSIX /bin/sh TERM-trap case: Windows has no `trap '' TERM`, but killTree
	// must still reap a non-exiting helper after the deadline (review follow-up).
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-oneshot-hung-"));
	const pidFile = join(dir, "pid");
	try {
		const script = [
			`const { writeFileSync } = require("node:fs");`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
			`setInterval(() => {}, 60_000);`,
		].join("");
		const t0 = Date.now();
		await expect(oneShot(process.execPath, ["-e", script], {}, 200)).rejects.toMatchObject({
			code: "node_timeout",
			certainty: "unknown",
		});
		expect(Date.now() - t0).toBeLessThan(2_000);
		const pid = (await readFile(pidFile, "utf8")).trim();
		expect(pid).toMatch(/^\d+$/);
		const goneUntil = Date.now() + 2_000;
		let gone = false;
		while (Date.now() < goneUntil) {
			try {
				process.kill(Number(pid), 0);
			} catch {
				gone = true;
				break;
			}
			await Bun.sleep(20);
		}
		expect(gone).toBe(true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("transport: actual helper timeout is distinct from a reply; malformed or contradictory replies are unknown", async () => {
	const f = await fixture();
	await expect(
		oneShot(
			process.execPath,
			f.args,
			{
				action: "test",
				identity: f.identity,
				argv: [process.execPath, "-e", "setTimeout(()=>{},500)"],
			},
			100,
		),
	).rejects.toMatchObject({ code: "node_timeout", certainty: "unknown" });
	for (const script of [
		"console.log('bad')",
		"process.exit(1)",
		"console.log(JSON.stringify({ok:false,error:'nested_repository',detail:'git_entry',certainty:'before_send'}))",
	]) {
		await expect(
			oneShot(process.execPath, ["-e", script], {}),
		).rejects.toMatchObject({
			code: "node_transport_failed",
			certainty: "unknown",
		});
	}
	await expect(oneShot("/missing-node-helper", [], {})).rejects.toMatchObject({
		code: "node_transport_failed",
		certainty: "before_send",
	});
});
test("caller preserves real helper refusal in audit and across repeated starts without unknown or redispatch", async () => {
	const f = await fixture();
	const store = new FleetStore(join(f.dir, "fleet.sqlite"));
	try {
		store.putNode({
			...f.node,
			workspaceTransport: { command: process.execPath, args: f.args },
		});
		const fleet = new Fleet(store);
		const task = store.submit({
			schemaVersion: 1,
			key: "refusal",
			caller: "test",
			repoId: "repo",
			baseCommit: f.baseCommit,
			prompt: "test",
			required: {},
		});
		store.reserve(task.id, headroom(["node"], 1));
		await f.git("config", "filter.fleet-refusal.clean", "cat");
		for (let i = 0; i < 2; i++)
			await expect(fleet.start(task.id)).rejects.toMatchObject({
				code: "node_refused:root_denied:allowlist",
			});
		expect(store.task(task.id)?.phase).not.toBe("blocked_unknown");
		expect(
			store.events(task.id).filter((e) => e.kind === "unknown"),
		).toHaveLength(0);
		expect(
			store.events(task.id).filter((e) => e.kind === "node_operation_failure"),
		).toHaveLength(2);
		expect(
			JSON.stringify(
				store
					.events(task.id)
					.filter((e) => e.kind === "node_operation_failure"),
			),
		).toContain("node_refused:root_denied:allowlist");
		expect(store.getOperation(task.id, "prepare")?.receipt).toMatchObject({
			nodeRefusal: { error: "root_denied", certainty: "before_send" },
		});
	} finally {
		store.close();
	}
});
test("actual helper: preflight reads Git but changes nothing in the source root (including .git) and never creates the workspace root", async () => {
	const f = await fixture();
	const { lstat, readdir } = await import("node:fs/promises");
	const snapshot = async (root: string) => {
		const out: string[] = [];
		const walk = async (dir: string) => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				const s = await lstat(path);
				out.push(`${path} ${s.mode} ${s.size} ${s.mtimeMs} ${s.ctimeMs}`);
				if (entry.isDirectory()) await walk(path);
			}
		};
		await walk(root);
		return out.sort();
	};
	const root = join(f.dir, "never-created");
	await writeFile(f.config, JSON.stringify({ ...f.node, workspaceRoot: root }));
	await f.git("config", "filter.fleet-refusal.clean", "cat");
	const before = await snapshot(f.repo);
	const input = { ...f.input, attemptId: "fresh" };
	await refusal(f.call({ action: "preflight", input }), "root_denied");
	await f.git("config", "--remove-section", "filter.fleet-refusal");
	const fixed = await snapshot(f.repo);
	expect(await f.call({ action: "preflight", input })).toEqual({ preflight: "passed" });
	await refusal(
		f.call({ action: "preflight", input: { ...input, baseCommit: "f".repeat(40) } }),
		"git_failed",
	);
	expect(await snapshot(f.repo)).toEqual(fixed);
	// Only the operator's own config edit changed anything between the two snapshots.
	expect(before.filter((line) => !line.includes(join(".git", "config")) && !line.startsWith(join(f.repo, ".git") + " "))).toEqual(
		fixed.filter((line) => !line.includes(join(".git", "config")) && !line.startsWith(join(f.repo, ".git") + " ")),
	);
	expect(await Bun.file(join(root, "x")).exists()).toBe(false);
	await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
});
// Review e265ea63 LOW-A: collection and preparation refusals are typed, never `internal`.
test("actual helper: operator configuration, snapshot, scan and moved-source refusals are typed", async () => {
	const f = await fixture();
	const input = { ...f.input, attemptId: "typed" };
	// An excludes file that is a directory cannot be resolved: an operator configuration problem.
	await mkdir(join(f.dir, "rules-dir"));
	await f.git("config", "core.excludesFile", join(f.dir, "rules-dir"));
	for (const action of ["preflight", "prepare"]) {
		const reply = await refusal(f.call({ action, input }), "invalid_request");
		expect(reply).not.toHaveProperty("correlationId");
	}
	await f.git("config", "--unset", "core.excludesFile");
	// A collection-relevant setting outside the replayable vocabulary.
	await f.git("config", "core.ignorecase", "");
	await refusal(f.call({ action: "preflight", input }), "invalid_request");
	await f.git("config", "--unset", "core.ignorecase");
	// A tampered node snapshot.
	const snapshot = join(f.workspaceRoot, ".collection-snapshots", "task-attempt.json");
	const original = await readFile(snapshot);
	await writeFile(snapshot, original.toString().replace('"info_exclude":""', '"info_exclude":"*\\n"'));
	await refusal(f.call({ action: "collect", identity: f.identity }), "identity_mismatch", "unknown");
	await writeFile(snapshot, original);
	// An unreadable directory in the workspace.
	if (process.platform !== "win32" && process.getuid?.() !== 0) {
		const { chmod } = await import("node:fs/promises");
		await mkdir(join(f.identity.path, "locked"));
		await chmod(join(f.identity.path, "locked"), 0);
		try {
			const reply = await refusal(f.call({ action: "collect", identity: f.identity }), "unsafe_path", "unknown");
			expect(reply).not.toHaveProperty("correlationId");
		} finally {
			await chmod(join(f.identity.path, "locked"), 0o700);
		}
		await rm(join(f.identity.path, "locked"), { recursive: true });
	}
	// The source repository (the trusted object store) was moved away (G12).
	const { rename } = await import("node:fs/promises");
	await rename(f.repo, f.repo + "-moved");
	try {
		const reply = await refusal(f.call({ action: "collect", identity: f.identity }), "identity_mismatch", "unknown");
		expect(JSON.stringify(reply)).not.toContain("posix_spawn");
	} finally {
		await rename(f.repo + "-moved", f.repo);
	}
});

test("node error log refuses symlinks and stops growing past the size bound", async () => {
	const { rename, stat } = await import("node:fs/promises");
	const logPath = resolve(import.meta.dir, "../src/.node-errors.log");
	const backup = logPath + ".bak";
	const sink = await repositoryFixture("node-log-target-");
	dirs.push(sink.dir);
	const target = join(sink.dir, "sink.log");
	let moved = false;
	try {
		await rename(logPath, backup).then(() => { moved = true; }).catch(() => {});
		const f = await fixture();

		if (!nodeErrorLogSupportsNoFollow) {
			// Capability branch: file logging is fail-closed; sink stays untouched; refusal still correlates.
			await writeFile(target, "untouched\n");
			await expect(appendNodeErrorLog('{"correlationId":"no-nofollow"}\n')).rejects.toThrow(/unsafe_node_error_log/);
			expect(await readFile(target, "utf8")).toBe("untouched\n");
			const reply = await refusal(f.call({ action: "test", identity: f.identity, argv: [f.dir] }), "internal", "unknown");
			expect("correlationId" in reply ? reply.correlationId : undefined).toMatch(/^[a-f0-9-]{36}$/);
			expect(await readFile(target, "utf8")).toBe("untouched\n");
			return;
		}

		if (process.platform !== "win32") {
			await writeFile(target, "untouched\n");
			await symlink(target, logPath);
			const reply = await refusal(f.call({ action: "test", identity: f.identity, argv: [f.dir] }), "internal", "unknown");
			const correlationId = "correlationId" in reply ? reply.correlationId : undefined;
			expect(correlationId).toMatch(/^[a-f0-9-]{36}$/);
			expect(await readFile(target, "utf8")).toBe("untouched\n");
			await rm(logPath, { force: true });
		}

		await writeFile(logPath, "x".repeat(NODE_ERROR_LOG_MAX_BYTES));
		const before = (await stat(logPath)).size;
		const again = await refusal(f.call({ action: "test", identity: f.identity, argv: [f.dir] }), "internal", "unknown");
		expect("correlationId" in again ? again.correlationId : undefined).toMatch(/^[a-f0-9-]{36}$/);
		expect((await stat(logPath)).size).toBe(before);

		// Hardlink: nlink≠1 must refuse (pre-open and post-open fstat). Use the
		// log's filesystem because the OS temp directory can be on another mount.
		await rm(logPath, { force: true });
		const hardlinkDir = await mkdtemp(join(dirname(logPath), ".node-log-link-"));
		dirs.push(hardlinkDir);
		const hardlinkTarget = join(hardlinkDir, "sink.log");
		await writeFile(hardlinkTarget, "body\n");
		const { link } = await import("node:fs/promises");
		await link(hardlinkTarget, logPath);
		await expect(appendNodeErrorLog('{"correlationId":"hardlink"}\n')).rejects.toThrow(/unsafe_node_error_log/);
		expect(await readFile(hardlinkTarget, "utf8")).toBe("body\n");
		await rm(logPath, { force: true });

		// In-process soft cap: chain serializes so size stays ≤ MAX.
		const line = "y".repeat(64) + "\n";
		const room = Buffer.byteLength(line);
		await writeFile(logPath, "z".repeat(NODE_ERROR_LOG_MAX_BYTES - room));
		const results = await Promise.allSettled([appendNodeErrorLog(line), appendNodeErrorLog(line)]);
		const fulfilled = results.filter((r) => r.status === "fulfilled").length;
		const rejected = results.filter((r) => r.status === "rejected").length;
		expect(fulfilled).toBe(1);
		expect(rejected).toBe(1);
		expect((await stat(logPath)).size).toBeLessThanOrEqual(NODE_ERROR_LOG_MAX_BYTES);

		// Cross-process soft cap: no durable lock; at most ~one extra line past MAX.
		await rm(logPath, { force: true });
		await writeFile(logPath, "z".repeat(NODE_ERROR_LOG_MAX_BYTES - room));
		const helperPath = join(sink.dir, "append-boundary.ts");
		await writeFile(
			helperPath,
			`import { appendNodeErrorLog } from ${JSON.stringify(resolve(import.meta.dir, "../src/node.ts"))};\n` +
				`const line = ${JSON.stringify(line)};\n` +
				`try {\n` +
				`\tawait appendNodeErrorLog(line);\n` +
				`\tprocess.stdout.write("ok\\n");\n` +
				`} catch (error) {\n` +
				`\tprocess.stdout.write(String(error instanceof Error ? error.message : error) + "\\n");\n` +
				`\tprocess.exitCode = 1;\n` +
				`}\n`,
		);
		const procA = Bun.spawn([process.execPath, helperPath], { stdout: "pipe", stderr: "pipe" });
		const procB = Bun.spawn([process.execPath, helperPath], { stdout: "pipe", stderr: "pipe" });
		const [, , outA, outB] = await Promise.all([
			procA.exited,
			procB.exited,
			new Response(procA.stdout).text(),
			new Response(procB.stdout).text(),
		]);
		const oks = [outA, outB].filter((s) => s.trim() === "ok").length;
		const fulls = [outA, outB].filter((s) => /node_error_log_full/.test(s)).length;
		expect(oks + fulls).toBe(2);
		expect(oks).toBeGreaterThanOrEqual(1);
		expect((await stat(logPath)).size).toBeLessThanOrEqual(NODE_ERROR_LOG_MAX_BYTES + room);

		// Empty-path create race: creator holds beforeWrite via ready/release barrier (no sleep timing).
		await rm(logPath, { force: true });
		const readyPath = join(sink.dir, "create-ready");
		const releasePath = join(sink.dir, "create-release");
		await rm(readyPath, { force: true });
		await rm(releasePath, { force: true });
		const createRacePath = join(sink.dir, "create-race.ts");
		await writeFile(
			createRacePath,
			`import { access, writeFile } from "node:fs/promises";\n` +
				`import { appendNodeErrorLog, nodeErrorLogTestHooks } from ${JSON.stringify(resolve(import.meta.dir, "../src/node.ts"))};\n` +
				`const mode = process.argv[2] || "go";\n` +
				`const tag = process.argv[3] || "x";\n` +
				`const ready = ${JSON.stringify(readyPath)};\n` +
				`const release = ${JSON.stringify(releasePath)};\n` +
				`if (mode === "hold") {\n` +
				`\tnodeErrorLogTestHooks.beforeWrite = async () => {\n` +
				`\t\tawait writeFile(ready, "1");\n` +
				`\t\tfor (;;) {\n` +
				`\t\t\ttry { await access(release); break; } catch { await Bun.sleep(5); }\n` +
				`\t\t}\n` +
				`\t};\n` +
				`}\n` +
				`await appendNodeErrorLog(tag.repeat(32) + "\\n");\n` +
				`process.stdout.write("ok\\n");\n`,
		);
		const { existsSync } = await import("node:fs");
		let slow: ReturnType<typeof Bun.spawn> | undefined;
		let fast: ReturnType<typeof Bun.spawn> | undefined;
		try {
			slow = Bun.spawn([process.execPath, createRacePath, "hold", "A"], { stdout: "pipe", stderr: "pipe" });
			for (let i = 0; i < 400 && !existsSync(readyPath); i++) await Bun.sleep(5);
			expect(existsSync(readyPath)).toBe(true);
			expect(existsSync(logPath)).toBe(true);
			fast = Bun.spawn([process.execPath, createRacePath, "go", "B"], { stdout: "pipe", stderr: "pipe" });
			expect(await fast.exited).toBe(0);
			await writeFile(releasePath, "1");
			expect(await slow.exited).toBe(0);
			const created = await readFile(logPath, "utf8");
			expect(created).toContain("A".repeat(32));
			expect(created).toContain("B".repeat(32));
		} finally {
			await writeFile(releasePath, "1").catch(() => {});
			for (const child of [fast, slow]) {
				if (!child) continue;
				try { child.kill(); } catch { /* already exited */ }
				await child.exited.catch(() => {});
			}
		}

		// ENOENT then intervening symlink via afterLstat hook (never follow into the sink).
		if (process.platform !== "win32") {
			await rm(logPath, { force: true });
			await writeFile(target, "sink-body\n");
			nodeErrorLogTestHooks.afterLstat = async () => {
				await symlink(target, logPath);
			};
			try {
				await expect(appendNodeErrorLog('{"correlationId":"enoent-symlink"}\n')).rejects.toThrow(
					/unsafe_node_error_log|EEXIST|ELOOP|EPERM|EACCES/,
				);
			} finally {
				delete nodeErrorLogTestHooks.afterLstat;
			}
			expect(await readFile(target, "utf8")).toBe("sink-body\n");
			await rm(logPath, { force: true });
		}
	} finally {
		delete nodeErrorLogTestHooks.afterLstat;
		delete nodeErrorLogTestHooks.beforeWrite;
		await rm(logPath, { force: true });
		if (moved) await rename(backup, logPath).catch(() => {});
		else await rm(backup, { force: true }).catch(() => {});
	}
});
