// Child process for result-store crash tests: runs `migrateResults(true)`
// (RESULT_MODE=migrate, default), one `saveResult` of a multi-blob manifest
// for the task id in argv[3] (RESULT_MODE=save), or the audited switch
// `enableResultStore` (RESULT_MODE=enable), or one `backup` to the destination in
// argv[3] (RESULT_MODE=backup), with node:fs and SQLite
// writes wrapped so the process dies abruptly at one injected point.
// RESULT_POINT: write-half | before-fsync | before-rename | after-rename |
//   after-readback | before-commit | after-commit | none
// RESULT_AT: 1-based occurrence of that point.
// RESULT_STEP: once the store is open, every node:fs call, Database.exec and
//   Statement.run counts two steps (before and after it); the process dies at
//   step RESULT_STEP. 0 runs to completion and prints "STEPS <n>".
// RESULT_PAUSE_MS: instead of dying, hold the write lock this long before the
// first COMMIT (printing PAUSED to stderr) to model an in-flight writer.
import { mock } from "bun:test";
import { Database, Statement } from "bun:sqlite";
import * as live from "node:fs";

const real: any = { ...live };
const point = process.env.RESULT_POINT ?? "none";
const at = Number(process.env.RESULT_AT ?? "1");
const stepAt = process.env.RESULT_STEP === undefined ? undefined : Number(process.env.RESULT_STEP);
let seen = 0;
let steps = 0;
let counting = false;
const trace: string[] = [];
const blobReads = new Set<number>();
const hit = (name: string) => point === name && ++seen === at;
const die = (): never => {
	(process as any).reallyExit(137);
	throw new Error("unreachable: process exited");
};
function step(label: string): void {
	if (!counting || stepAt === undefined) return;
	steps++;
	trace.push(label);
	if (stepAt > 0 && steps === stepAt) die();
}
/** Wraps a node:fs function so it counts as two steps (before and after). */
function counted<T extends (...args: any[]) => any>(name: string, fn: T): T {
	return ((...args: any[]) => {
		step(`before ${name}`);
		const value = fn(...args);
		step(`after ${name}`);
		return value;
	}) as T;
}
mock.module("node:fs", () => ({
	...real,
	writeSync: counted("writeSync", real.writeSync),
	mkdirSync: counted("mkdirSync", real.mkdirSync),
	mkdtempSync: counted("mkdtempSync", real.mkdtempSync),
	rmSync: counted("rmSync", real.rmSync),
	rmdirSync: counted("rmdirSync", real.rmdirSync),
	linkSync: counted("linkSync", real.linkSync),
	writeFileSync: counted("writeFileSync", (file: any, data: any, ...rest: any[]) => {
		if (typeof file === "number" && Buffer.isBuffer(data) && hit("write-half")) {
			real.writeSync(file, data, 0, data.length >> 1);
			die();
		}
		return real.writeFileSync(file, data, ...rest);
	}),
	fsyncSync: counted("fsyncSync", (fd: any) => {
		if (hit("before-fsync")) die();
		return real.fsyncSync(fd);
	}),
	renameSync: counted("renameSync", (from: any, to: any) => {
		if (hit("before-rename")) die();
		real.renameSync(from, to);
		if (hit("after-rename")) die();
	}),
	// Blob read-back opens <sha>/data read-only and reads it through the descriptor.
	openSync: counted("openSync", (file: any, flags: any, ...rest: any[]) => {
		const fd = real.openSync(file, flags, ...rest);
		if (typeof file === "string" && file.endsWith("data") && typeof flags === "number" && (flags & 3) === 0) blobReads.add(fd);
		return fd;
	}),
	readSync(fd: any, ...rest: any[]) {
		const n = real.readSync(fd, ...rest);
		if (blobReads.has(fd) && n > 0 && hit("after-readback")) die();
		return n;
	},
	closeSync: counted("closeSync", (fd: any) => {
		blobReads.delete(fd);
		return real.closeSync(fd);
	}),
}));
const exec = Database.prototype.exec;
let paused = false;
Database.prototype.exec = function (this: Database, sql: string, ...rest: any[]) {
	if (sql === "COMMIT" && process.env.RESULT_PAUSE_MS && !paused) {
		paused = true;
		console.error("PAUSED");
		Bun.sleepSync(Number(process.env.RESULT_PAUSE_MS));
	}
	if (sql === "COMMIT" && hit("before-commit")) die();
	const label = `exec ${sql.replace(/\s+/g, " ").trim().slice(0, 60)}`;
	step(`before ${label}`);
	const value = (exec as any).call(this, sql, ...rest);
	step(`after ${label}`);
	if (sql === "COMMIT" && hit("after-commit")) die();
	return value;
} as typeof exec;
const run = Statement.prototype.run;
Statement.prototype.run = function (this: Statement, ...args: any[]) {
	const label = `run ${String((this as any).toString?.() ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}`;
	step(`before ${label}`);
	const value = (run as any).apply(this, args);
	step(`after ${label}`);
	return value;
} as typeof run;
const { FleetStore } = await import("../../src/store");
const store = new FleetStore(process.argv[2]!);
counting = true;
if (process.env.RESULT_MODE === "save") {
	const manifest = {
		status: "verified",
		patch: "+save\n".repeat(4000),
		files: [{ path: "f", contentBase64: Buffer.alloc(16000, 66).toString("base64") }],
		tests: [{ argv: ["bun", "test"], stdout: "save-out\n".repeat(4000), stderr: "" }],
	};
	store.saveResult(process.argv[3]!, manifest);
	console.log("RESULT saved");
} else if (process.env.RESULT_MODE === "backup") {
	console.log("RESULT " + JSON.stringify(store.backup(process.argv[3]!)));
} else if (process.env.RESULT_MODE === "enable") {
	console.log("RESULT " + JSON.stringify(store.enableResultStore({ actor: "crash-child", reason: "kill test" })));
} else console.log("RESULT " + JSON.stringify(store.migrateResults(true)));
counting = false;
store.close();
if (stepAt === 0) {
	console.log(`STEPS ${steps}`);
	if (process.env.RESULT_TRACE) console.error(trace.map((label, i) => `${i + 1} ${label}`).join("\n"));
}
