import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, digest } from "../src/core";
import { Fleet } from "../src/fleet";
import { StoreResults } from "../src/store/results";

/** True when the pid is gone or a Linux zombie (state Z); kill(0) alone is not enough. */
function processGone(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error: unknown) {
		const code = typeof error === "object" && error !== null && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
		return code === "ESRCH";
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			return close >= 0 && stat[close + 2] === "Z";
		} catch {
			return true;
		}
	}
	return false;
}

// Use the real saveResult and transaction bodies with a small, isolated SQLite fixture.
function custodyStore() {
	const db = new Database(":memory:");
	db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, data TEXT); CREATE TABLE operations (task_id TEXT, attempt_id TEXT, kind TEXT, id TEXT, data TEXT)");
	const task = { id: "task", attemptId: "attempt", inputDigest: "input", input: { autoCustody: { paths: ["report.txt"] } } };
	const payload = { inputDigest: task.inputDigest, paths: task.input.autoCustody.paths };
	const claim = { id: "claim", key: "claim", taskId: task.id, attemptId: task.attemptId, kind: "auto-custody", payload, digest: digest(payload) };
	db.query("INSERT INTO tasks VALUES (?,?)").run(task.id, canonicalJson(task));
	db.query("INSERT INTO operations VALUES (?,?,?,?,?)").run(task.id, task.attemptId, claim.kind, claim.id, canonicalJson(claim));
	const store = Object.create(StoreResults.prototype) as any;
	Object.assign(store, {
		db, readOnly: false, telemetryFailures: 0,
		requireTask: () => JSON.parse((db.query("SELECT data FROM tasks WHERE id='task'").get() as { data: string }).data),
		autoCustodyRefusal: () => undefined,
		audit: () => {}, diagnosticData: () => ({}), refusalDiagnostic: () => ({}),
		save(value: unknown) { db.query("UPDATE tasks SET data=? WHERE id='task'").run(canonicalJson(value as any)); return value; },
	});
	const operation = () => JSON.parse((db.query("SELECT data FROM operations WHERE id='claim'").get() as { data: string }).data);
	return { db, store, operation };
}

for (const failedTable of ["operations", "tasks"]) {
	test(`custody manifest and receipt roll back together on ${failedTable} write failure`, () => {
		const { db, store, operation } = custodyStore();
		const manifest = { custody: { paths: ["report.txt"] }, outputHead: "a".repeat(40) };
		try {
			db.exec(`CREATE TRIGGER fail_write BEFORE UPDATE ON ${failedTable} BEGIN SELECT RAISE(ABORT,'injected'); END`);
			expect(() => store.saveResult("task", manifest, undefined, "claim")).toThrow();
			expect(store.requireTask().resultManifest).toBeUndefined();
			expect(operation().receipt).toBeUndefined();
			db.exec("DROP TRIGGER fail_write");
			store.saveResult("task", manifest, undefined, "claim");
			expect(store.requireTask().resultManifest).toEqual(manifest);
			expect(operation().receipt).toEqual({ manifestDigest: digest(manifest) });
			store.saveResult("task", manifest, undefined, "claim");
			expect(operation().receipt).toEqual({ manifestDigest: digest(manifest) });
		} finally { db.close(); }
	});
}

test("archive deadline rejects even when the query helper ignores SIGTERM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-archive-deadline-"));
	const pidFile = join(dir, "pid");
	const helper = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
	const fleet = Object.create(Fleet.prototype) as any;
	fleet.store = { nodes: () => [{ id: "node" }] };
	const task = { nodeId: "node", nodeSnapshot: { id: "node", os: process.platform, sdkTransport: { command: process.execPath, args: ["-e", helper] } } };
	let outcome: unknown;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	try {
		outcome = await Promise.race([
			fleet.archiveObservation(task, {}).then(() => "unexpected success", (error: unknown) => error),
			new Promise(resolve => { fallback = setTimeout(() => resolve("deadline missed"), 17_000); }),
		]);
		expect(outcome).toMatchObject({ code: "ARCHIVE_TIMEOUT" });
		const helperPid = Number(readFileSync(pidFile, "utf8"));
		const deadline = Date.now() + 2_000;
		let gone = false;
		while (Date.now() < deadline) {
			gone = processGone(helperPid);
			if (gone) break;
			await Bun.sleep(50);
		}
		expect(gone).toBe(true);
	} finally {
		clearTimeout(fallback);
		try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already dead or never started. */ }
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("archive deadline SIGKILL ends a grandchild (POSIX group / win32 taskkill tree)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-archive-grandchild-"));
	const parentPidFile = join(dir, "parent.pid");
	const childPidFile = join(dir, "child.pid");
	const helper = [
		`const { writeFileSync } = require('node:fs');`,
		`const { spawn } = require('node:child_process');`,
		`writeFileSync(${JSON.stringify(parentPidFile)}, String(process.pid));`,
		`process.on('SIGTERM', () => {});`,
		`const child = spawn(process.execPath, ['-e', ${JSON.stringify(
			"process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(" +
				JSON.stringify(childPidFile) +
				", String(process.pid)); setInterval(() => {}, 1000);",
		)}], { detached: false, stdio: 'ignore' });`,
		`child.unref();`,
		`setInterval(() => {}, 1000);`,
	].join(" ");
	const fleet = Object.create(Fleet.prototype) as any;
	fleet.store = { nodes: () => [{ id: "node" }] };
	const task = {
		nodeId: "node",
		nodeSnapshot: { id: "node", os: process.platform, sdkTransport: { command: process.execPath, args: ["-e", helper] } },
	};
	let outcome: unknown;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	try {
		outcome = await Promise.race([
			fleet.archiveObservation(task, {}).then(() => "unexpected success", (error: unknown) => error),
			new Promise(resolve => { fallback = setTimeout(() => resolve("deadline missed"), 17_000); }),
		]);
		expect(outcome).toMatchObject({ code: "ARCHIVE_TIMEOUT" });
		const parentPid = Number(readFileSync(parentPidFile, "utf8"));
		const childPid = Number(readFileSync(childPidFile, "utf8"));
		const deadline = Date.now() + 2_000;
		let parentGone = false;
		let childGone = false;
		while (Date.now() < deadline) {
			parentGone = processGone(parentPid);
			childGone = processGone(childPid);
			if (parentGone && childGone) break;
			await Bun.sleep(50);
		}
		expect(parentGone).toBe(true);
		expect(childGone).toBe(true);
	} finally {
		clearTimeout(fallback);
		for (const file of [parentPidFile, childPidFile]) {
			try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch { /* already gone */ }
		}
		rmSync(dir, { recursive: true, force: true });
	}
}, 20_000);

test("processGone does not claim a live pid is dead", async () => {
	const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
	try {
		expect(processGone(child.pid!)).toBe(false);
	} finally {
		try { child.kill("SIGKILL"); } catch { /* already gone */ }
		await child.exited;
	}
});
