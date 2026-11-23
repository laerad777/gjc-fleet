/**
 * Work-unit switch OFF identity against pristine production code (FLEET_PRISTINE: an extract of 6b95dde).
 * One database is seeded by the PRISTINE code (test/fixtures/cli-differential-seed.ts, every phase) and one
 * reserved task row gains a `workUnit` input by raw SQL (what a switch-on build would have stored). Each tree
 * then runs, on its own copy, the four validateTaskInput call sites with a role input (store.submit,
 * Fleet.submit, Fleet.start, preflightPlacement; the CLI `submit` and `start` reach two of them), role-less
 * work, and every read-only CLI view. Required: identical exit/stdout/stderr per command (byte for byte;
 * only clock fields normalised) and an identical per-table SHA-256 of the resulting databases (audit `at`
 * normalised; the refusal rows themselves must be identical).
 */
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "..");
const PRISTINE = process.env.FLEET_PRISTINE ? resolve(process.env.FLEET_PRISTINE) : undefined;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

const role = { schemaVersion: 1, key: "role-submit", caller: "differential", repoId: "repo", baseCommit: "a".repeat(40), prompt: "Write fleet-review/report.md", required: {}, workUnit: { role: "review" } };
const scenario = `
const [tree, db] = process.argv.slice(2);
const { FleetStore } = await import(tree + "/src/store.ts");
const { Fleet } = await import(tree + "/src/fleet.ts");
const { validateTaskInput } = await import(tree + "/src/core.ts");
const { preflightPlacement } = await import(tree + "/src/placement-preflight.ts");
const role = ${JSON.stringify(role)};
const out = {};
const caught = async (name, f) => { try { await f(); out[name] = "no error"; } catch (e) { out[name] = { name: e.name, code: e.code, message: e.message }; } };
const store = new FleetStore(db);
const fleet = new Fleet(store);
await caught("validateTaskInput", () => validateTaskInput(role));
await caught("store.submit", () => store.submit(role));
await caught("Fleet.submit", () => fleet.submit(role, { samples: new Map() }));
await caught("preflightPlacement", () => preflightPlacement(role, store.nodes(), store.taskStates(), { samples: new Map(), held: store.heldCharges(), now: 0 }));
await caught("Fleet.start", () => fleet.start(process.argv[4]));
// Role-less work through the same store: a normal submit (deterministic id is not needed: compared by key).
await caught("store.submit role-less", () => store.submit({ ...role, key: "plain", workUnit: undefined, prompt: "plain" }));
store.close();
console.log(JSON.stringify(out));
`;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** Per-table SHA-256 of every row; clock values and ids minted during the run (not in `known`) normalised. */
function tableHashes(path: string, known: Set<string>): Record<string, string> {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
		const out: Record<string, string> = {};
		for (const { name } of tables) {
			const rows = JSON.stringify(db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all());
			out[name] = createHash("sha256").update(rows.replace(ISO, "<NOW>").replace(UUID, (id) => (known.has(id) ? id : "<NEW>"))).digest("hex");
		}
		const schema = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
		out["<schema>"] = createHash("sha256").update(JSON.stringify(schema)).digest("hex");
		out["<user_version>"] = String((db.query("PRAGMA user_version").get() as any).user_version);
		return out;
	} finally { db.close(); }
}
function uuids(path: string): Set<string> {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
		return new Set(tables.flatMap(({ name }) => JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()).match(UUID) ?? []));
	} finally { db.close(); }
}

test.skipIf(!PRISTINE)("switch off: four call sites, CLI views and the stored database are identical to 6b95dde", async () => {
	const base = mkdtempSync(join(tmpdir(), "fleet-wu-diff-"));
	dirs.push(base);
	const seedDb = join(base, "seed.sqlite");
	const seed = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "cli-differential-seed.ts"), PRISTINE!, seedDb, "2", base], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	expect(seed.exitCode).toBe(0);
	const ids: Record<string, string> = JSON.parse(seed.stdout.toString()).ids;
	// A reserved, not-started role row (what a switch-on build stores), written once before the copies.
	const raw = new Database(seedDb);
	const preparing = ids["preparing-0"]!;
	const data = JSON.parse((raw.query("SELECT data FROM tasks WHERE id=?").get(preparing) as any).data);
	data.input.workUnit = { role: "review" };
	raw.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(data), preparing);
	raw.close();
	const known = uuids(seedDb);
	writeFileSync(join(base, "stale.json"), JSON.stringify(Object.fromEntries(["n1", "n2"].map((id) => [id, { ok: true, at: "2020-01-01T00:00:00.000Z", cpuPct: 1, memTotal: 64 * 1024 ** 3, memUsed: 1024 ** 3, disks: [{ path: "/", total: 1024 ** 4, used: 0 }] }]))));
	writeFileSync(join(base, "role.json"), JSON.stringify(role));
	writeFileSync(join(base, "scenario.ts"), scenario);

	const runTree = async (tree: string, label: string, mode: { scenario: boolean; enable?: boolean } = { scenario: true }) => {
		const work = join(base, label);
		mkdirSync(work);
		const db = join(work, "fleet.sqlite");
		copyFileSync(seedDb, db);
		const spawn = async (argv: string[]) => {
			const child = Bun.spawn(argv, { cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
			const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			const json = (p: string) => JSON.stringify(p).slice(1, -1);
			const clean = (s: string) => s.replaceAll(json(work), "<WORK>").replaceAll(work, "<WORK>").replaceAll(json(base), "<SEED>").replaceAll(base, "<SEED>");
			return { exit, stdout: clean(stdout), stderr: clean(stderr) };
		};
		const cli = (...args: string[]) => spawn([process.execPath, join(tree, "src", "cli.ts"), "--db", db, ...args]);
		const results: Record<string, unknown> = {};
		if (mode.enable) expect((await cli("workunits", "enable", "--reason", "switch-on role-less differential")).exit).toBe(0);
		if (mode.scenario) {
			results.scenario = await spawn([process.execPath, join(base, "scenario.ts"), tree, db, preparing]);
			results.cliSubmit = await cli("--resources", join(base, "stale.json"), "submit", join(base, "role.json"));
			results.cliStart = await cli("start", preparing);
		}
		const views: string[][] = [["tasks"], ["tasks", "--compact"], ["node", "list"], ["results", "status"], ["results", "check"], ["observability"], ["show", preparing], ["events", preparing]];
		for (const id of Object.values(ids)) views.push(["show", id], ["events", id]);
		for (const args of views)
			for (const ro of [false, true]) {
				// --read-only opens a WAL database only while another connection holds it (as a running hub does).
				const hub = ro ? new Database(db) : undefined;
				hub?.query("SELECT count(*) FROM tasks").get();
				let r: Awaited<ReturnType<typeof cli>>;
				try { r = await cli(...(ro ? ["--read-only", ...args] : args)); } finally { hub?.close(); }
				const normalise = (s: string) => s.replace(/"collectedAt": "[^"]+"/, '"collectedAt": "<NOW>"').replace(/\b\d+[smhd]\b/g, "<AGE>").replace(ISO, "<NOW>");
				results[(ro ? "ro " : "") + args.join(" ")] = { ...r, stdout: normalise(r.stdout) };
			}
		return { results, tables: tableHashes(db, known) };
	};
	const [old, now] = [await runTree(PRISTINE!, "pristine"), await runTree(root, "patched")];
	expect(Object.keys(now.results)).toEqual(Object.keys(old.results));
	for (const key of Object.keys(old.results)) expect([key, now.results[key]]).toEqual([key, old.results[key]]);
	const scenarioOut = JSON.parse((old.results.scenario as any).stdout);
	for (const site of ["validateTaskInput", "store.submit", "Fleet.submit", "preflightPlacement", "Fleet.start"])
		expect([site, scenarioOut[site]]).toEqual([site, { name: "FleetError", code: "INVALID_INPUT", message: "Unexpected field" }]);
	expect((old.results.cliSubmit as any).stderr).toContain("Unexpected field");
	expect(now.tables).toEqual(old.tables);
	expect(Object.keys(now.tables)).not.toContain("task_deliverables");
	// The read-only views really ran (a hub connection was held), not two identical refusals.
	expect((old.results["ro tasks"] as any).exit).toBe(0);

	// Switch ON, role-less work (C1): every view of every seeded task is byte-identical to 6b95dde.
	const [offViews, onViews] = [await runTree(PRISTINE!, "pristine-views", { scenario: false }), await runTree(root, "patched-on", { scenario: false, enable: true })];
	// Justified difference: `observability` lists the latest global audit events, which now include the audited
	// `work_unit_switch_enabled` row (it pushes the oldest listed event out); every other view is compared.
	for (const key of Object.keys(offViews.results).filter((k) => !k.endsWith("observability")))
		expect([key, onViews.results[key]]).toEqual([key, offViews.results[key]]);
	// The audit table (and its AUTOINCREMENT counter) gains exactly the audited enable row.
	const { tables: offTables } = offViews;
	const { tables: onTables } = onViews;
	expect(Object.keys(onTables).filter((t) => !(t in offTables)).sort()).toEqual(["task_deliverables", "work_unit_switch"]);
	for (const table of Object.keys(offTables).filter((t) => !["audit", "sqlite_sequence", "<schema>"].includes(t))) expect([table, onTables[table]]).toEqual([table, offTables[table]]);
}, 600_000);

test.skipIf(!PRISTINE)("switch off: a `fleet result` collection sends the same node requests and writes the same rows as production (review fx-8fae504e F4)", async () => {
	const { repositoryFixture } = await import("./fixtures/coordinator");
	const relay = join(import.meta.dir, "fixtures", "provenance-transport.ts");
	/** One author task started and collected twice by `tree`, its node requests logged by the relay (mode real). */
	const collect = async (tree: string) => {
		const { FleetStore } = await import(join(tree, "src", "store.ts"));
		const { Fleet } = await import(join(tree, "src", "fleet.ts"));
		const { observationDigest } = await import(join(tree, "src", "core.ts"));
		const repo = await repositoryFixture("fleet-wu-diff-result-");
		dirs.push(repo.dir);
		const state = join(repo.dir, "coordinator.json");
		writeFileSync(state, JSON.stringify({ calls: [] }));
		const node = { id: "local", os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot, enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [], transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "coordinator.ts"), state] } };
		const config = join(repo.dir, "node.json");
		writeFileSync(config, JSON.stringify(node));
		const control = join(repo.dir, "relay.json");
		writeFileSync(control, JSON.stringify({ mode: "real", actions: [] }));
		const path = join(repo.dir, "fleet.sqlite");
		const store = new FleetStore(path);
		try {
			store.putNode({ ...node, workspaceTransport: { command: process.execPath, args: [relay, join(tree, "src", "node.ts"), config, control] } });
			const fleet = new Fleet(store, { localNodeId: "local" });
			const task = await fleet.start(fleet.submit({ schemaVersion: 1, key: "author", caller: "differential", repoId: "repo", baseCommit: repo.baseCommit, prompt: "Controlled author", required: {} }).id);
			const body = { sessionId: task.sessionId, turnId: task.turnId, status: "completed_unverified", terminal: true, evidence: { injected: "not provider settlement proof" } };
			store.observe(task.id, { ...body, eventId: "controlled-settlement", digest: observationDigest(body) });
			const ws = task.workspace.path;
			writeFileSync(join(ws, "tracked.txt"), "agent work\n");
			const git = Bun.spawnSync(["git", "-c", "core.hooksPath=" + join(ws, "..", "no-hooks"), "-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "-C", ws, "commit", "-q", "-a", "-m", "agent"]);
			expect(git.exitCode).toBe(0);
			const first = await fleet.result(task.id);
			const cached = await fleet.result(task.id);
			expect(cached).toEqual(first);
		} finally {
			store.close();
		}
		const db = new Database(path, { readonly: true });
		try {
			const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
			return {
				actions: JSON.parse(await Bun.file(control).text()).actions,
				audit: db.query("SELECT kind, task_id IS NULL AS global FROM audit ORDER BY sequence").all(),
				rows: Object.fromEntries(tables.map(({ name }) => [name, (db.query(`SELECT count(*) AS n FROM "${name}"`).get() as any).n])),
				schema: db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
				userVersion: (db.query("PRAGMA user_version").get() as any).user_version,
			};
		} finally {
			db.close();
		}
	};
	const [production, patched] = [await collect(PRISTINE!), await collect(root)];
	expect(patched).toEqual(production);
	expect(patched.actions).toEqual(["prepare", "collect"]);
}, 120_000);
