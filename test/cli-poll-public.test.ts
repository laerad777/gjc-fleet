import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { repositoryFixture, type ControlledState } from "./fixtures/coordinator";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const coordinatorPath = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const SECRET = "synthetic_private_turn_prompt_987654";
const directories: string[] = [];
const stores = new Set<FleetStore>();

afterEach(async () => {
	for (const store of stores) store.close();
	stores.clear();
	for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cli(db: string, ...args: string[]) {
	const child = Bun.spawn([process.execPath, cliPath, "--db", db, ...args], {
		cwd: join(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { exit, stdout, stderr };
}

test("CLI poll stdout is allowlisted and redacts coordinator payloads", async () => {
	const repo = await repositoryFixture("fleet-cli-poll-public-");
	directories.push(repo.dir);
	const statePath = join(repo.dir, "controlled-state.json");
	await writeFile(statePath, JSON.stringify({ calls: [], questionsComplete: true } satisfies ControlledState));
	const db = join(repo.dir, "fleet.sqlite");
	const node: NodeConfig = {
		id: "alpha",
		os: process.platform,
		arch: process.arch,
		roots: { repo: repo.repo },
		workspaceRoot: repo.workspaceRoot,
		maxConcurrency: 1,
		enabled: true,
		draining: false,
		reachable: true,
		sdkReady: true,
		modelReady: true,
		models: ["controlled-model"],
		transport: { command: process.execPath, args: [coordinatorPath, statePath] },
		operations: ["read", "write"],
	};
	const helperConfig = join(repo.dir, "workspace-node.json");
	node.workspaceTransport = { command: process.execPath, args: [fileURLToPath(new URL("../src/placement-preflight.ts", import.meta.url)), helperConfig] };
	await writeFile(helperConfig, JSON.stringify(node));
	const input: TaskInput = {
		schemaVersion: 1,
		key: "request",
		caller: "controlled-cli-poll",
		repoId: "repo",
		baseCommit: repo.baseCommit,
		prompt: SECRET,
		required: { os: process.platform, arch: process.arch, model: "controlled-model", operations: ["write"] },
	};
	const store = new FleetStore(db);
	stores.add(store);
	const { workspaceTransport, ...localNode } = node;
	store.putNode(localNode);
	const fleet = new Fleet(store, { localNodeId: node.id });
	const started = await fleet.start(fleet.submit(input).id);
	store.close();
	stores.delete(store);
	const polled = await cli(db, "poll", started.id);
	expect({ exit: polled.exit, stderr: polled.stderr }).toEqual({ exit: 0, stderr: "" });
	const body = JSON.parse(polled.stdout);
	expect(Object.keys(body).sort()).toEqual(["poll", "questionCount", "task"]);
	expect(body.poll).toEqual({ turnStatus: "unknown", sessionState: "active" });
	expect(typeof body.questionCount).toBe("number");
	expect(body.task.id).toBe(started.id);
	expect(polled.stdout).not.toContain(SECRET);
	const state = JSON.parse(await readFile(statePath, "utf8")) as ControlledState;
	expect(JSON.stringify(state)).toContain(SECRET);
});