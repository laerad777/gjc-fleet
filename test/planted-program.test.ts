import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { previewInput } from "../src/inputs";
import { probePlacementSource } from "../src/placement-preflight";
import { collectResult, prepareWorkspace, run, sha256, testWorkspace } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";
import { planter, type Planter } from "./support/planted";

// N1 regressions: a program planted in a worker-controlled tree (workspace,
// source repository, process cwd) must never run. Real planted programs:
// on Windows a compiled marker .exe, a .cmd and a .bat; on POSIX an
// executable script (POSIX never searches cwd, so these pin unchanged behaviour).
// All fixtures live in fresh temp directories.
let T: string;
let P: Planter;
const roots: string[] = [];
beforeAll(() => {
	T = realpathSync(mkdtempSync(join(tmpdir(), "fleet-planted-")));
	P = planter(T);
});
afterAll(() => {
	for (const dir of [...roots, T]) rmSync(dir, { recursive: true, force: true });
});
async function repo() {
	const f = await repositoryFixture("fleet-planted-repo-");
	roots.push(f.dir);
	return f;
}
function sourceNode(f: Awaited<ReturnType<typeof repo>>): any {
	return { id: "PLANTED", os: process.platform, arch: process.arch, roots: { fixture: f.repo }, workspaceRoot: join(f.dir, "workspaces"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: [], transport: { command: process.execPath, args: [] } };
}

/** Runs one scenario per planted kind (fresh Git fixtures each, hence 60 s per test) and compares every kind at once, so a failure shows each hijack. */
async function perKind(body: (kind: string) => Promise<string>) {
	const seen: Record<string, { ran: string[]; outcome: string }> = {};
	for (const kind of P.kinds) {
		P.reset();
		let outcome: string;
		try {
			outcome = await body(kind);
		} catch (error) {
			outcome = "threw " + (error as Error).message.slice(0, 200);
		}
		seen[kind || "posix"] = { ran: P.ran(), outcome };
	}
	expect(seen).toEqual(Object.fromEntries(P.kinds.map((k) => [k || "posix", { ran: [], outcome: "ok" }])));
}

describe("planted git in a worker-controlled working directory never runs", () => {
	test("workspace.run() resolves argv[0] from PATH, not the cwd (verify.ts, live-check.ts, testWorkspace)", () =>
		perKind(async (kind) => {
			const dir = join(T, "run" + kind);
			mkdirSync(dir);
			P.plant(dir, "git", kind);
			P.reset();
			const r = await run(["git", "--version"], dir);
			return r.exit === 0 && r.stdout.startsWith("git version") ? "ok" : "exit " + r.exit;
		}), 60_000);

	test("prepareWorkspace: planted git in the source repository root", () =>
		perKind(async (kind) => {
			const f = await repo();
			P.plant(f.repo, "git", kind);
			P.reset();
			const identity = await prepareWorkspace({ taskId: "planted", attemptId: "a" + kind.slice(1), nodeId: "n", inputDigest: sha256("planted"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: join(f.dir, "workspaces") });
			return identity.baseCommit === f.baseCommit ? "ok" : "wrong identity";
		}), 60_000);

	test("testWorkspace and collectResult: planted git in the prepared workspace", () =>
		perKind(async (kind) => {
			const f = await repo();
			const identity = await prepareWorkspace({ taskId: "planted", attemptId: "a" + kind.slice(1), nodeId: "n", inputDigest: sha256("planted"), repo: f.repo, baseCommit: f.baseCommit, workspaceRoot: join(f.dir, "workspaces") });
			const file = P.plant(identity.path, "git", kind);
			P.reset();
			const evidence = await testWorkspace(identity, ["git", "--version"]);
			if (evidence.exit !== 0 || !evidence.stdout.startsWith("git version")) return "testWorkspace exit " + evidence.exit;
			// A compiled .exe exceeds the 4 MiB artifact bound; collection with it present is exercised by the script kinds.
			if (kind === ".exe") rmSync(file);
			const manifest = await collectResult(identity, []);
			const files = manifest.files.map((x) => x.path);
			return kind === ".exe" || files.includes("git" + kind) ? "ok" : "planted file not collected: " + files.join(",");
		}), 60_000);

	// Regression: workspaceTrees must be passed as run()'s trailing `untrusted` argument (not
	// shifted into stdin/timeout/children). If omitted, untrusted defaults to [cwd] only and a git
	// planted in a sibling workspace on PATH still runs.
	test("testWorkspace treats sibling workspace PATH entries as untrusted (run untrusted trailing arg)", () =>
		perKind(async (kind) => {
			const f = await repo();
			const identity = await prepareWorkspace({
				taskId: "planted",
				attemptId: "sib" + kind.slice(1),
				nodeId: "n",
				inputDigest: sha256("planted-sib"),
				repo: f.repo,
				baseCommit: f.baseCommit,
				workspaceRoot: join(f.dir, "workspaces"),
			});
			const sibling = join(dirname(identity.path), "sibling-tools");
			mkdirSync(sibling, { recursive: true });
			P.plant(sibling, "git", kind);
			P.reset();
			const saved = process.env.PATH;
			process.env.PATH = sibling + (process.platform === "win32" ? ";" : ":") + (saved ?? "");
			try {
				const evidence = await testWorkspace(identity, ["git", "--version"]);
				if (P.ran().length) return "planted sibling ran: " + P.ran().join(",");
				return evidence.exit === 0 && evidence.stdout.startsWith("git version") ? "ok" : "exit " + evidence.exit;
			} finally {
				process.env.PATH = saved;
			}
		}), 60_000);

	test("previewInput (src/inputs.ts git): planted git in the source repository root", () =>
		perKind(async (kind) => {
			const f = await repo();
			P.plant(f.repo, "git", kind);
			P.reset();
			const pkg = await previewInput({ repo: f.repo, repoId: "fixture", baseCommit: f.baseCommit, paths: ["tracked.txt"], includeObjects: true });
			return pkg.baseCommit === f.baseCommit ? "ok" : "wrong package";
		}), 60_000);

	test("probePlacementSource: planted git in the source repository root", () =>
		perKind(async (kind) => {
			const f = await repo();
			P.plant(f.repo, "git", kind);
			P.reset();
			const checks = await probePlacementSource(sourceNode(f), { repoId: "fixture", baseCommit: f.baseCommit });
			return checks.source.ok ? "ok" : checks.source.code;
		}), 60_000);
});

// Sites that start a configured or fixed program without a cwd inherit the
// process cwd. One child runs every such site with its cwd in a hostile
// directory and a PATH that holds none of the planted names except git's own
// directory, so a correct resolver finds nothing (ENOENT) and runs nothing.
describe("planted programs in the inherited process cwd never run", () => {
	const sites = ["node.oneShot", "rpc.StdioRpc", "dashboard.probeGjcRuntime", "dashboard.probeNode", "dashboard.startResourceStreams", "execution.readExecution", "ordinary.discoverOrdinary", "placement.preflightPlacement", "fleet.archive"] as const;
	let results: Record<string, string[]> = {};
	beforeAll(async () => {
		const hostile = join(T, "hostile-cwd");
		mkdirSync(hostile);
		for (const name of ["fleetprobe", "gjc", "sh", "ssh", "git"]) for (const kind of P.kinds) if (name === "fleetprobe") P.plant(hostile, kind ? "fleetprobe" + kind.slice(1) : name, kind);
			else if (kind !== ".bat") P.plant(hostile, name, kind);
		const src = join(import.meta.dir, "..", "src");
		const script = join(T, "inherited-sites.ts");
		writeFileSync(script, `
import { existsSync, readFileSync, rmSync } from "node:fs";
const mark = ${JSON.stringify(P.mark)};
const kinds = ${JSON.stringify(P.kinds.map((k) => (k ? "fleetprobe" + k.slice(1) : "fleetprobe")))};
const out: Record<string, string[]> = {};
const lines = () => existsSync(mark) ? readFileSync(mark, "utf8").split(/\\r?\\n/).filter(Boolean) : [];
async function site(name: string, body: (command: string) => Promise<unknown>) {
	out[name] = [];
	for (const command of kinds) {
		rmSync(mark, { force: true });
		try { await body(command); } catch {}
		await Bun.sleep(150);
		out[name].push(...lines());
	}
}
const node = (command: string): any => ({ id: "PLANTED", os: "linux", arch: process.arch, roots: {}, workspaceRoot: process.cwd(), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], modelProfiles: ["controlled"], operations: [], transport: { command, args: [] }, sdkTransport: { command, args: [] }, workspaceTransport: { command, args: [] } });
const { oneShot } = await import(${JSON.stringify(join(src, "node.ts"))});
await site("node.oneShot", (c) => oneShot(c, [], { action: "noop" }));
const { StdioRpc } = await import(${JSON.stringify(join(src, "rpc.ts"))});
await site("rpc.StdioRpc", async (c) => { const rpc = new StdioRpc(c, [], 1000); try { await rpc.initialize(); } finally { rpc.close(); } });
const dashboard = await import(${JSON.stringify(join(src, "dashboard.ts"))});
await site("dashboard.probeGjcRuntime", () => dashboard.probeGjcRuntime());
await site("dashboard.probeNode", (c) => dashboard.probeNode(node(c)));
await site("dashboard.startResourceStreams", async (c) => { const s = dashboard.startResourceStreams(() => [node(c)], () => {}); await Bun.sleep(500); s.stop(); });
const { readExecution } = await import(${JSON.stringify(join(src, "execution.ts"))});
await site("execution.readExecution", (c) => readExecution(node(c), "s", "c", "t"));
const { discoverOrdinary } = await import(${JSON.stringify(join(src, "ordinary.ts"))});
await site("ordinary.discoverOrdinary", (c) => discoverOrdinary({ command: c, args: [] }, { sessionId: "session", coordinatorTurnId: "turn", runtimeTurnId: "runtime" }));
const { preflightPlacement } = await import(${JSON.stringify(join(src, "placement-preflight.ts"))});
const { headroom } = await import(${JSON.stringify(join(import.meta.dir, "admission-fixture.ts"))});
await site("placement.preflightPlacement", (c) => preflightPlacement({ schemaVersion: 1, key: "automatic", caller: "planted", repoId: "fixture", baseCommit: "a".repeat(40), prompt: "x", required: { modelProfile: "controlled" } } as any, [{ ...node(c), os: process.platform, roots: { fixture: process.cwd() }, operations: ["coordinator.create", "coordinator.prompt", "coordinator.read_turn", "coordinator.workflow_question"], transport: { command: process.execPath, args: ["-e", "0"] } }], [], { ...headroom(["PLANTED"], 10), held: new Map(), now: Date.now() }));
const { FleetStore } = await import(${JSON.stringify(join(src, "store.ts"))});
const { Fleet } = await import(${JSON.stringify(join(src, "fleet.ts"))});
const { Database } = await import("bun:sqlite");
await site("fleet.archive", async (c) => {
	const dir = ${JSON.stringify(join(T, "fleet-db"))} + "-" + Math.random().toString(36).slice(2);
	require("node:fs").mkdirSync(dir, { recursive: true });
	const path = dir + "/fleet.sqlite";
	const store = new FleetStore(path, 2), db = new Database(path);
	try {
		const n: any = { id: "node", sdkTransport: { command: c, args: [] } };
		const task: any = { id: "task", input: { schemaVersion: 1, key: "key", caller: "planted", repoId: "repo", baseCommit: "a".repeat(40), prompt: "planted", required: {} }, inputDigest: "digest", nodeId: "node", nodeSnapshot: n, attemptId: "attempt", sessionId: "session", phase: "blocked_unknown", held: true, reason: "retained" };
		db.query("INSERT INTO nodes VALUES (?,?)").run(n.id, JSON.stringify(n));
		db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(task.id, "planted", "key", "digest", JSON.stringify(task));
		await new Fleet(store).archive(task.id, {});
	} finally { db.close(); store.close(); }
});
console.log(JSON.stringify(out));
`);
		const gitDir = dirname(Bun.which("git")!);
		const PATH = [gitDir, process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin"].join(process.platform === "win32" ? ";" : ":");
		const child = Bun.spawnSync([process.execPath, script], { cwd: hostile, env: { ...process.env, PATH }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
		const text = child.stdout.toString().trim().split("\n").at(-1) ?? "";
		try {
			results = JSON.parse(text);
		} catch {
			throw new Error("inherited-sites child failed: " + child.stderr.toString().slice(-4000));
		}
	}, 180_000);
	for (const name of sites)
		test(name, () => {
			expect(results[name]).toBeDefined();
			expect(results[name]).toEqual([]);
		});
});
