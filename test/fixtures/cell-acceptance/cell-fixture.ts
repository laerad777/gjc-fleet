import { readFile, realpath, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Cell = "a" | "b";
type Metadata = { cell: Cell; id: string; dir: string; workspaceRoot: string; db: string; state: string; baseCommit: string; taskId?: string };
type Call = { name: string; args?: Record<string, unknown> };
type Controlled = { calls: Call[]; lose?: "send"; terminal?: boolean };
type CliReply = { id?: string; attemptId?: string; nodeId?: string; phase?: string; status?: string; tests?: { stdout?: string }[] };

function assert(check: unknown, label: string): asserts check {
	if (!check) throw new Error(label);
}
const [command, suppliedCell] = process.argv.slice(2);
assert(suppliedCell === "a" || suppliedCell === "b", "explicit cell a or b is required");
const cell = suppliedCell as Cell;
const base = process.env.FLEET_FIXTURE_REPO ?? "/fleet";
const root = await realpath(process.env.CELL_ROOT ?? "/state");
const tmp = join(root, "tmp");
const metaPath = join(root, "meta.json");
const id = "cell-" + cell;
const cli = join(base, "src/cli.ts");
const coordinator = join(base, "test/fixtures/coordinator.ts");

const moduleAt = (path: string) => import(pathToFileURL(join(base, path)).href);
const { FleetStore } = await moduleAt("src/store.ts");
const { repositoryFixture } = await moduleAt("test/fixtures/coordinator.ts");
const { headroom } = await moduleAt("test/admission-fixture.ts");

const stateOf = async (m: Metadata) => JSON.parse(await readFile(m.state, "utf8")) as Controlled;
const count = (s: Controlled, op: string) => s.calls.filter((c) => c.name === "gjc_coordinator_" + op).length;
const metadata = async () => {
	const m = JSON.parse(await readFile(metaPath, "utf8")) as Metadata;
	assert(m.cell === cell && m.id === id, "wrong cell volume");
	for (const p of [m.dir, m.db, m.state, m.workspaceRoot])
		assert(resolve(p).startsWith(root + "/"), "state path escapes cell volume");
	return m;
};
async function invoke(m: Metadata, exit: number, ...args: string[]): Promise<CliReply> {
	const child = Bun.spawn([process.execPath, cli, "--db", m.db, "--local-node-id", id, ...args],
		{ cwd: m.dir, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	assert(code === exit, "Fleet CLI " + args.join(" ") + " exit " + code + ": " + stdout + stderr);
	return JSON.parse(stdout);
}
async function submit(m: Metadata, key: string) {
	const input = { schemaVersion: 1, key, caller: id + "-fixture", repoId: "repo",
		baseCommit: m.baseCommit, prompt: "Controlled local fixture", required: { nodeId: id } };
	const taskPath = join(m.dir, "task.json"), resources = join(m.dir, "resources.json");
	const samples = headroom([id], 10).samples;
	samples.get(id)!.disks![0]!.path = m.workspaceRoot;
	await writeFile(taskPath, JSON.stringify(input));
	await writeFile(resources, JSON.stringify(Object.fromEntries(samples)));
	return invoke(m, 0, "--resources", resources, "submit", taskPath);
}

if (command === "init") {
	assert(!await Bun.file(metaPath).exists(), "refuse to reuse a fixture volume");
	assert(process.env.TMPDIR === tmp, "fixture requires volume-local TMPDIR");
	await mkdir(tmp, { recursive: true, mode: 0o700 });
	await mkdir(join(root, "home"), { recursive: true, mode: 0o700 });
	const repo = await repositoryFixture("fleet-compose-" + cell);
	assert(repo.dir.startsWith(tmp + "/"), "fixture did not stay in its volume");
	const m: Metadata = { cell, id, dir: repo.dir, workspaceRoot: repo.workspaceRoot, baseCommit: repo.baseCommit,
		db: join(repo.dir, "fleet.sqlite"), state: join(repo.dir, "coordinator.json") };
	await writeFile(m.state, JSON.stringify({ calls: [], ...(cell === "a" ? { lose: "send" } : {}) } satisfies Controlled));
	await writeFile(join(root, "cell-" + cell + ".sentinel"), cell, { flag: "wx" });
	const store = new FleetStore(m.db);
	try {
		store.putNode({
			id, os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: m.workspaceRoot,
			enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
			transport: { command: process.execPath, args: [coordinator, m.state] },
		});
	} finally { store.close(); }
	if (cell === "a") {
		const a = await submit(m, "a-uncertain-before-loss");
		assert(a.id && a.attemptId && a.nodeId === id, "A failed to reserve a bound attempt");
		assert((await invoke(m, 1, "start", a.id)).phase === "blocked_unknown", "A did not fail closed");
		assert(count(await stateOf(m), "send_prompt") === 1, "A requires exactly one pre-fault send");
		m.taskId = a.id;
	}
	await writeFile(metaPath, JSON.stringify(m), { flag: "wx" });
	await writeFile(join(root, "database-path"), m.db + "\n", { flag: "wx" });
} else if (command === "ready-a") {
	assert(cell === "a", "wrong readiness target");
	const m = await metadata();
	const s = new FleetStore(m.db, undefined, { readOnly: true });
	try {
		assert(m.taskId && s.task(m.taskId)?.phase === "blocked_unknown", "A uncertain effect was not retained");
		assert(s.daemonLease()?.holder.pid === 1, "A Fleet daemon is not holder/PID 1");
	} finally { s.close(); }
	console.log("READY-A-PID1");
} else if (command === "verify-b") {
	assert(cell === "b", "wrong survivor target");
	const m = await metadata();
	assert(!await Bun.file(join(root, "cell-a.sentinel")).exists(), "A volume visible to B");
	assert(await Bun.file(join(root, "cell-b.sentinel")).text() === "b", "missing B volume sentinel");
	const before = new FleetStore(m.db, undefined, { readOnly: true });
	try { assert(before.tasks().length === 0, "B already had work before the outage"); } finally { before.close(); }
	const first = await submit(m, "fresh-b-after-a-loss");
	assert(first.id && first.attemptId && first.nodeId === id, "B failed to admit a fresh, bound attempt");
	assert((await submit(m, "fresh-b-after-a-loss")).id === first.id, "same-cell retry changed identity");
	assert((await invoke(m, 0, "start", first.id)).phase === "active", "B task did not start");
	const controlled = await stateOf(m);
	assert(count(controlled, "start_session") === 1 && count(controlled, "send_prompt") === 1, "B send counts are not exact");
	controlled.terminal = true;
	await writeFile(m.state, JSON.stringify(controlled));
	await invoke(m, 0, "poll", first.id);
	const verifier = join(m.dir, "verifier.json");
	const proof = "fleet-survivor-durable-verification";
	// Real command in the task workspace. Exclusive creation fails even if a second execution emits the same result.
	await writeFile(verifier, JSON.stringify([process.execPath, "--eval", `
		import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
		const fd = openSync("survivor-proof", "wx", 0o600);
		try { writeSync(fd, "${proof}"); fsyncSync(fd); } finally { closeSync(fd); }
		console.log("${proof}");
	`]));
	const result = await invoke(m, 0, "result", first.id, verifier);
	assert(result.status === "verified" && result.tests?.[0]?.stdout === proof + "\n", "B result missing verified evidence");
	const reopened = new FleetStore(m.db, undefined, { readOnly: true });
	try {
		const row = reopened.task(first.id);
		assert(row?.phase === "succeeded" && row?.result?.verified === true && row?.held === false,
			"B terminal result is not durably verified and released");
		const events = reopened.events(first.id) as { kind: string }[];
		assert(events.filter((e) => e.kind === "reserved").length === 1 &&
			events.filter((e) => e.kind === "released").length === 1 &&
			events.filter((e) => e.kind === "result_verified").length === 1, "B reserve/release/verify counts are not exact");
		const path = row.workspace?.path;
		assert(typeof path === "string" && resolve(path).startsWith(root + "/"), "B effect workspace is not scoped");
		assert(await Bun.file(join(path, "survivor-proof")).text() === proof, "B independent filesystem effect absent");
	} finally { reopened.close(); }
	console.log("VERIFIED-B-ONE-EFFECT");
} else if (command === "retry-a") {
	assert(cell === "a", "wrong recovery target");
	const m = await metadata(), taskId = m.taskId;
	assert(taskId && count(await stateOf(m), "send_prompt") === 1, "A pre-fault effect is missing");
	assert((await invoke(m, 1, "start", taskId)).phase === "blocked_unknown", "A unexpectedly replayed/re-admitted");
	assert(count(await stateOf(m), "start_session") === 1 && count(await stateOf(m), "send_prompt") === 1,
		"A session/prompt repeated on restart");
	const s = new FleetStore(m.db, undefined, { readOnly: true });
	try {
		assert(s.task(taskId)?.held === true, "A uncertainty lost its held capacity");
		assert(!s.events(taskId).some((e: { kind: string }) => e.kind === "released"), "A uncertainty was silently released");
	} finally { s.close(); }
	console.log("RECOVERED-A-NO-REPLAY");
} else {
	throw new Error("unsupported fixture command");
}
