import { expect, test } from "bun:test";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { observationDigest } from "../src/core";
import { FleetStore } from "../src/store";
import { headroom } from "./admission-fixture";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

const cli = join(import.meta.dir, "../src/cli.ts");
async function cell(label: "a" | "b") {
	const repo = await repositoryFixture("fleet-test-cell-" + label);
	const db = join(repo.dir, "fleet.sqlite");
	const state = join(repo.dir, "coordinator.json");
	const id = "cell-" + label;
	try {
		await writeFile(state, JSON.stringify({ calls: [] }));
		const node: NodeConfig = {
			id, os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
			enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
			transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] },
		};
		const store = new FleetStore(db);
		try { store.putNode(node); } finally { store.close(); }
		return { ...repo, db, state, id };
	} catch (error) {
		await rm(repo.dir, { recursive: true, force: true });
		throw error;
	}
}
async function invokeWithExit(c: Awaited<ReturnType<typeof cell>>, expected: number, ...args: string[]) {
	const child = Bun.spawn([process.execPath, cli, "--db", c.db, "--local-node-id", c.id, ...args],
		{ cwd: c.dir, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== expected) throw new Error("Fleet CLI " + args[0] + " exit " + code + ": " + stdout + stderr);
	return JSON.parse(stdout);
}
function invoke(c: Awaited<ReturnType<typeof cell>>, ...args: string[]) {
	return invokeWithExit(c, 0, ...args);
}
async function submitFixture(c: Awaited<ReturnType<typeof cell>>, key: string) {
	const input: TaskInput = {
		schemaVersion: 1, key, caller: c.id + "-tests", repoId: "repo", baseCommit: c.baseCommit,
		prompt: "Controlled cell exercise", required: { nodeId: c.id },
	};
	const taskPath = join(c.dir, "task.json"), resources = join(c.dir, "resources.json");
	const samples = headroom([c.id], 10).samples;
	samples.get(c.id)!.disks![0]!.path = c.workspaceRoot;
	await writeFile(taskPath, JSON.stringify(input));
	await writeFile(resources, JSON.stringify(Object.fromEntries(samples)));
	return invoke(c, "--resources", resources, "submit", taskPath);
}
async function sends(c: Awaited<ReturnType<typeof cell>>) {
	const calls = (JSON.parse(await readFile(c.state, "utf8")) as ControlledState).calls;
	return calls.filter(call => call.name === "gjc_coordinator_send_prompt").length;
}

test("independent cell B verifies a new task while cell A process and store are unavailable", async () => {
	const a = await cell("a");
	const offline = a.dir + "-offline";
	let b: Awaited<ReturnType<typeof cell>> | undefined;
	let stopped = false;
	let daemon: ReturnType<typeof Bun.spawn> | undefined;
	try {
		b = await cell("b");
		await writeFile(a.state, JSON.stringify({ calls: [], lose: "send" } satisfies ControlledState));
		const uncertain = await submitFixture(a, "uncertain-before-loss");
		expect((await invokeWithExit(a, 1, "start", uncertain.id)).phase).toBe("blocked_unknown");
		expect(await sends(a)).toBe(1);
		daemon = Bun.spawn([process.execPath, cli, "--db", a.db, "--local-node-id", a.id, "daemon", "run"],
			{ cwd: a.dir, stdout: "ignore", stderr: "ignore" });
		const deadline = Date.now() + 5_000;
		let sawActiveA = false;
		while (Date.now() < deadline && daemon.exitCode === null) {
			const reader = new FleetStore(a.db, undefined, { readOnly: true });
			try { sawActiveA = reader.daemonLease()?.holder.pid === daemon.pid; } finally { reader.close(); }
			if (sawActiveA) break;
			await Bun.sleep(25);
		}
		expect(sawActiveA).toBe(true);
		daemon.kill("SIGKILL");
		expect(await daemon.exited).not.toBe(0);
		await rename(a.dir, offline);
		stopped = true;
		expect(await Bun.file(a.db).exists()).toBe(false);

		// No B work exists before loss. Use the real external CLI for reserve/start/verify on B.
		const submit = () => submitFixture(b!, "first-after-a-loss");
		const first = await submit();
		expect(first.nodeId).toBe(b.id);
		expect(first.attemptId).toBeTruthy();
		expect((await submit()).id).toBe(first.id);
		expect((await invoke(b, "start", first.id)).phase).toBe("active");
		const store = new FleetStore(b.db);
		try {
			const current = store.task(first.id)!;
			const observation = {sessionId: current.sessionId!, turnId: current.turnId!,
				status: "completed_unverified" as const, terminal: true, evidence: { controlled: true }};
			store.observe(first.id, { ...observation, eventId: "test-terminal-b", digest: observationDigest(observation) });
		} finally { store.close(); }
		const verifier = join(b.dir, "verifier.json");
		await writeFile(verifier, JSON.stringify([process.execPath, "--eval", "console.log('verified on B')"]));
		const result = await invoke(b, "result", first.id, verifier);
		expect(result.status).toBe("verified");
		expect(result.tests[0].stdout).toBe("verified on B\n");
		const reopened = new FleetStore(b.db, undefined, { readOnly: true });
		try {
			expect(reopened.task(first.id)?.result).toBeDefined();
			expect(reopened.events(first.id).filter(event => event.kind === "reserved")).toHaveLength(1);
		} finally { reopened.close(); }
		const calls = (JSON.parse(await readFile(b.state, "utf8")) as ControlledState).calls;
		expect(calls.filter(call => call.name === "gjc_coordinator_start_session")).toHaveLength(1);
		expect(calls.filter(call => call.name === "gjc_coordinator_send_prompt")).toHaveLength(1);
		expect(await Bun.file(a.db).exists()).toBe(false);
		await rename(offline, a.dir);
		stopped = false;
		const retry = await invokeWithExit(a, 1, "start", uncertain.id);
		expect(retry.phase).toBe("blocked_unknown");
		expect(await sends(a)).toBe(1);
	} finally {
		if (daemon?.exitCode === null) { daemon.kill("SIGKILL"); await daemon.exited; }
		await rm(stopped ? offline : a.dir, { recursive: true, force: true });
		if (b) await rm(b.dir, { recursive: true, force: true });
	}
}, 30_000);
