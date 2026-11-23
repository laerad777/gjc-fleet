import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Differential smoke test of the production CLI (switch off): every read-only command and every safe mutating
// command, run by the real CLI process of this tree and of pristine production code (FLEET_OLD_TREE: an extract
// of the production base this change applies to, cb1b744) against copies of the same database, seeded by the
// pristine code with 0, 1, 2 and 5 tasks in every phase. Exit code and stdout must be identical except for the
// differences listed (and justified) in `allowed` below. Not run: commands that contact a node (start, poll,
// answer, ordinary, result, cancel, stop, return*, run, submit, input, ui) and commands with a one-way or
// effectful remote step; queue reconsider runs with recorded stale samples, so it admits and starts nothing.
// The H-1 regression (queue reconsider with 0..3 queued tasks) also runs without FLEET_OLD_TREE.
const root = resolve(import.meta.dir, "..");
const oldTree = process.env.FLEET_OLD_TREE ? resolve(process.env.FLEET_OLD_TREE) : undefined;
const seedScript = join(import.meta.dir, "fixtures", "cli-differential-seed.ts");
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const PHASES = ["queued", "preparing", "dispatching", "active", "approval_required", "blocked_unknown", "cancel_unknown",
	"completed_unverified", "succeeded", "failed", "archived", "cancelled"] as const;
const SETTLED = ["succeeded", "failed", "cancelled", "blocked_unknown", "cancel_unknown", "archived"] as const;

function seed(tree: string, perPhase: number): { dir: string; db: string; ids: Record<string, string> } {
	const dir = mkdtempSync(join(tmpdir(), "fleet-cli-diff-"));
	dirs.push(dir);
	const db = join(dir, "seed.sqlite");
	const run = Bun.spawnSync([process.execPath, seedScript, tree, db, String(perPhase), dir], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
	if (run.exitCode !== 0) throw new Error(`seed failed: ${run.stderr.toString()}`);
	writeFileSync(join(dir, "stale.json"), JSON.stringify(Object.fromEntries(["n1", "n2"].map((id) => [id, {
		ok: true, at: "2020-01-01T00:00:00.000Z", cpuPct: 1, memTotal: 64 * 1024 ** 3, memUsed: 1024 ** 3, disks: [{ path: "/", total: 1024 ** 4, used: 0 }],
	}]))));
	writeFileSync(join(dir, "node.json"), JSON.stringify({ id: "n3", os: process.platform, arch: process.arch, roots: { repo: "/repos/repo" }, workspaceRoot: "/work",
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], transport: { command: "/usr/bin/false", args: [] }, operations: ["read"] }));
	return { dir, db, ids: JSON.parse(run.stdout.toString()).ids };
}

type Run = { exit: number | null; stdout: string; stderr: string };
/** One real CLI process of `tree` on its own copy of the seeded database, in its own directory. */
async function cli(tree: string, base: { dir: string; db: string }, label: string, args: string[], after?: string[]): Promise<Run & { after?: Run }> {
	const work = join(base.dir, `${label}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(work);
	const db = join(work, "fleet.sqlite");
	copyFileSync(base.db, db);
	const spawn = async (argv: string[]): Promise<Run> => {
		const child = Bun.spawn([process.execPath, join(tree, "src", "cli.ts"), "--db", db, ...argv.map((a) => a.replaceAll("<WORK>", work).replaceAll("<SEED>", base.dir))],
			{ cwd: work, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
		const timer = setTimeout(() => child.kill(), 60_000);
		const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		clearTimeout(timer);
		const clean = (s: string) => s.replaceAll(work, "<WORK>").replaceAll(base.dir, "<SEED>").replaceAll(`/private${work}`, "<WORK>");
		return { exit, stdout: clean(stdout), stderr: clean(stderr) };
	};
	// --read-only opens a WAL database only while another connection holds it (as the running hub does in
	// production); without one, both trees refuse a cold copy alike ("unable to open database file").
	const hub = args.includes("--read-only") ? new Database(db) : undefined;
	hub?.query("SELECT count(*) FROM tasks").get();
	let result: Run & { after?: Run; db?: string };
	try {
		result = await spawn(args);
		if (after) result.after = await spawn(after);
	} finally {
		hub?.close();
	}
	(result as any).db = db;
	return result;
}

/** Every table's rows in primary-key order: the logical content of a database file. */
function logical(path: string): string {
	const db = new Database(path, { readonly: true });
	try {
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
		return JSON.stringify(tables.map(({ name }) => [name, db.query(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
	} finally {
		db.close();
	}
}

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
type Case = { args: string[]; after?: string[]; normalise?: (s: string) => string; allowed?: (old: Run, now: Run) => void };

function cases(ids: Record<string, string>, perPhase: number): Case[] {
	const out: Case[] = [];
	const pick = (phase: string) => {
		const keys = Array.from({ length: perPhase }, (_, i) => `${phase}-${i}`);
		return perPhase > 2 ? [keys[0]!, keys.at(-1)!] : keys;
	};
	// --compact renders the age of each task relative to now: the age column is clock dependent.
	const age = (s: string) => s.replace(/\b\d+[smhd]\b/g, "<AGE>");
	// Justified difference: node list adds each node's derived effectiveRpcTimeoutMs (asserted in
	// rpc-timeout.test.ts); the stored node fields must stay identical.
	const nodeList = (s: string) => {
		try {
			const value = JSON.parse(s);
			if (Array.isArray(value)) return JSON.stringify(value.map(({ effectiveRpcTimeoutMs: _, ...node }) => node), null, 2) + "\n";
		} catch {}
		return s;
	};
	const readOnly: Case[] = [
		{ args: ["tasks"] },
		{ args: ["tasks", "--compact"], normalise: age },
		...PHASES.flatMap((phase) => [{ args: ["tasks", "--phase", phase] }, { args: ["tasks", "--phase", phase, "--compact"], normalise: age }]),
		{ args: ["tasks", "--phase", "failed,archived,succeeded"] },
		{ args: ["tasks", "--phase", "no_such_phase"] },
		{ args: ["tasks", "--node", "n1"] },
		{ args: ["tasks", "--node", "n2", "--compact"], normalise: age },
		{ args: ["tasks", "--key-prefix", "succeeded-"] },
		{ args: ["tasks", "--key-prefix", "completed_unverified-", "--phase", "completed_unverified", "--compact"], normalise: age },
		{ args: ["tasks", "--since", "2000-01-01T00:00:00.000Z"] },
		{ args: ["tasks", "--since", "2999-01-01T00:00:00.000Z", "--compact"] },
		{ args: ["tasks", "--bogus"] },
		...PHASES.flatMap((phase) => pick(phase).flatMap((key) => [{ args: ["show", ids[key]!] }, { args: ["events", ids[key]!] }])),
		{ args: ["show", "00000000-0000-4000-8000-000000000000"] },
		{ args: ["events", "00000000-0000-4000-8000-000000000000"] },
		// collectedAt is the time of the call.
		{ args: ["observability"], normalise: (s) => s.replace(/"collectedAt": "[^"]+"/, '"collectedAt": "<NOW>"') },
		{ args: ["node", "list"], normalise: nodeList },
	];
	out.push(...readOnly, ...readOnly.map((c) => ({ ...c, args: ["--read-only", ...c.args] })));
	out.push(
		{ args: ["--read-only", "queue", "reconsider"] },
		{ args: ["--read-only", "backup", "<WORK>/ro-backup.sqlite"] },
		{ args: ["unknown-command"] },
		// Justified difference: results/migrate are new commands (production code: unknown, or READ_ONLY under
		// --read-only, exit 1);
		// switch off they report the plain v2 database and change nothing (the follow-up listing is equal).
		...[["results", "status"], ["results", "check"], ["--read-only", "results", "status"], ["--read-only", "results", "check"], ["migrate", "results"]].map((args) => ({
			args,
			after: ["tasks"],
			allowed: (old: Run & { after?: Run }, now: Run & { after?: Run }) => {
				expect({ exit: old.exit, stdout: old.stdout, stderr: old.stderr }).toEqual({ exit: 1, stdout: "", stderr: `{"ok":false,"error":"${args[0] === "--read-only" ? "READ_ONLY" : "unknown_command_use_help"}"}\n` });
				expect({ args, exit: now.exit, stderr: now.stderr, ok: now.stdout.startsWith("{") && JSON.parse(now.stdout).ok }).toEqual({ args, exit: 0, stderr: "", ok: true });
				if (args.includes("status")) expect(JSON.parse(now.stdout)).toMatchObject({ externalisation: "off", oneWayStepTaken: false, userVersion: 2, externalResults: 0 });
				expect(now.after).toEqual(old.after!);
			},
		})),
		// Mutating commands on a private copy; the follow-up full listing shows the state they left.
		...[[], ["1"], ["2"], ["100"]].map((limit) => ({ args: ["--resources", "<SEED>/stale.json", "queue", "reconsider", ...limit], after: ["tasks"] })),
		...SETTLED.flatMap((phase) => pick(phase).map((key) => ({ args: ["watch", ids[key]!, "--interval", "10"], normalise: (s: string) => s.replace(ISO, "<NOW>") }))),
		{ args: ["watch", "--all-active", "--interval", "10", "--max-polls", "2"], after: ["tasks"] },
		{ args: ["node", "drain", "n1"], after: ["node", "list"], normalise: nodeList },
		{ args: ["node", "enable", "n2"], after: ["node", "list"], normalise: nodeList },
		{ args: ["node", "disable", "n1"], after: ["node", "list"], normalise: nodeList },
		{ args: ["node", "remove", "n2"], after: ["node", "list"], normalise: nodeList },
		{ args: ["node", "remove", "n1"], after: ["node", "list"], normalise: nodeList },
		{ args: ["node", "add", "<SEED>/node.json"], after: ["node", "list"], normalise: nodeList },
		{ args: ["rollback"], after: ["observability"], normalise: (s) => s.replace(ISO, "<NOW>") },
		...(perPhase ? [{ args: ["task", "accept-late-receipt", ids["failed-0"]!, "--reason", "differential"], after: ["show", ids["failed-0"]!] }] : []),
		{
			args: ["backup", "<WORK>/backup.sqlite"],
			// Justified differences: the patched backup is a streamed copy without free pages, so the file
			// bytes, size (never larger) and digest differ while its logical content is identical (asserted below); and it reports
			// the DEST.results it backs up beside the file (empty while the switch is off).
			allowed: (old, now) => {
				const o = JSON.parse(old.stdout);
				const n = JSON.parse(now.stdout);
				expect(n.results).toEqual({ path: null, blobs: 0, bytes: 0, inventorySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });
				expect(n.bytes).toBeLessThanOrEqual(o.bytes);
				for (const key of ["sha256", "bytes", "results"]) {
					delete o[key];
					delete n[key];
				}
				// Windows host (rebase lane bc98149): production code never syncs the directory on win32
				// (directorySynced false); the patched backup flushes it (FlushFileBuffers, syncDirectory) and reports
				// true. stdout is JSON, which escapes a Windows path's backslashes, so cli()'s clean() cannot map the
				// path to <WORK>: each path must be exactly that run's own backup.sqlite.
				if (process.platform === "win32") {
					expect({ old: o.directorySynced, now: n.directorySynced }).toEqual({ old: false, now: true });
					expect({ old: o.path, now: n.path }).toEqual({ old: (old as any).db.replace(/fleet\.sqlite$/, "backup.sqlite"), now: (now as any).db.replace(/fleet\.sqlite$/, "backup.sqlite") });
					for (const key of ["directorySynced", "path"]) {
						delete o[key];
						delete n[key];
					}
				}
				expect(n).toEqual(o);
				expect({ exit: now.exit, stderr: now.stderr }).toEqual({ exit: old.exit, stderr: old.stderr });
			},
		},
	);
	return out;
}

/** Runs at most `width` tasks at a time. */
async function pool<T>(items: (() => Promise<T>)[], width = 8): Promise<T[]> {
	const results: T[] = new Array(items.length);
	let next = 0;
	await Promise.all(Array.from({ length: width }, async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await items[i]!();
		}
	}));
	return results;
}

test("H-1 queue reconsider prints every reconsidered task with 0, 1, 2 and 3 queued tasks (exit 0; one summary per task)", async () => {
	for (const queued of [0, 1, 2, 3]) {
		const base = seed(oldTree ?? root, 0);
		// Queued tasks only (plus the seed's nodes): submit through this tree's store.
		const { FleetStore } = await import("../src/store");
		const store = new FleetStore(base.db);
		const ids = Array.from({ length: queued }, (_, i) => store.submit({ schemaVersion: 1, key: `q${i}`, caller: "h1", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} } as any).id);
		store.close();
		const now = await cli(root, base, "patched", ["--resources", "<SEED>/stale.json", "queue", "reconsider"]);
		expect({ queued, exit: now.exit, stderr: now.stderr }).toEqual({ queued, exit: 0, stderr: "" });
		const listed = JSON.parse(now.stdout) as { id: string; phase: string; input: { prompt: string } }[];
		expect(listed.map((t) => t.id).sort()).toEqual([...ids].sort());
		for (const t of listed) expect({ phase: t.phase, prompt: t.input.prompt }).toEqual({ phase: "queued", prompt: "[omitted; retained in private database]" });
		if (oldTree) {
			const old = await cli(oldTree, base, "pristine", ["--resources", "<SEED>/stale.json", "queue", "reconsider"]);
			// Review d9783af8 F1: the one allowed difference is `placement` on never-admitted queued summaries (the same
			// narrow rule as dispose-differential's allowPlacement): removed from this tree's output only, the output
			// re-encoded exactly as printed (it must round-trip), and never present on the pristine side.
			const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
			const summaries = JSON.parse(now.stdout) as Record<string, unknown>[];
			expect(pretty(summaries)).toBe(now.stdout);
			for (const task of summaries) if (task.phase === "queued" && !task.attemptId) delete task.placement;
			expect(summaries.filter((task) => Object.hasOwn(task, "placement"))).toEqual([]);
			expect((JSON.parse(old.stdout) as Record<string, unknown>[]).filter((task) => Object.hasOwn(task, "placement"))).toEqual([]);
			expect({ queued, exit: now.exit, stdout: pretty(summaries), stderr: now.stderr }).toEqual({ queued, exit: old.exit, stdout: old.stdout, stderr: old.stderr });
		}
	}
}, 120_000);

for (const perPhase of [0, 1, 2, 5]) {
	test.skipIf(!oldTree)(`differential CLI smoke, switch off: ${perPhase} task(s) in every phase — exit and stdout equal pristine production code except the listed differences`, async () => {
		const base = seed(oldTree!, perPhase);
		const list = cases(base.ids, perPhase);
		const runs = await pool(list.flatMap((c) => [
			() => cli(oldTree!, base, "pristine", c.args, c.after),
			() => cli(root, base, "patched", c.args, c.after),
		]));
		let compared = 0;
		list.forEach((c, i) => {
			const old = runs[2 * i]!;
			const now = runs[2 * i + 1]!;
			const norm = c.normalise ?? ((s: string) => s);
			const view = (r: Run & { after?: Run }) => ({ args: c.args, exit: r.exit, stdout: norm(r.stdout), stderr: r.stderr,
				after: r.after && { exit: r.after.exit, stdout: norm(r.after.stdout), stderr: r.after.stderr } });
			if (c.allowed) {
				c.allowed(old, now);
				if (c.args[0] === "backup") expect(logical((now as any).db.replace(/fleet\.sqlite$/, "backup.sqlite"))).toBe(logical((old as any).db.replace(/fleet\.sqlite$/, "backup.sqlite")));
			} else expect(view(now)).toEqual(view(old));
			compared++;
		});
		expect(compared).toBe(list.length);
		// Justified difference: the help text (no arguments, --help, help) documents the new results/migrate
		// commands and the changed tasks/show/backup/--read-only behaviour, and the node-health commands and
		// note (node stability history, switch off by default); every other line is unchanged, in order.
		for (const args of [[], ["--help"], ["help"]]) {
			const [old, now] = await pool([() => cli(oldTree!, base, "pristine", args), () => cli(root, base, "patched", args)]);
			expect({ exit: now!.exit, stderr: now!.stderr }).toEqual({ exit: old!.exit, stderr: old!.stderr });
			const o = old!.stdout.split("\n");
			const n = now!.stdout.split("\n");
			const removed = o.filter((line) => !n.includes(line));
			const added = n.filter((line) => !o.includes(line));
			expect(removed).toEqual([
				"  node add CONFIG.json          enroll explicit nonsecret node configuration",
				"  node list                     inventory (not a live readiness assertion)",
				"                                durable local state, no remote mutation; JSON unless --compact",
				"  show TASK_ID                  durable local state, no remote mutation",
				"  backup NEW_DESTINATION        consistent local DB snapshot, never dispatch/restore",
				"--read-only permits only tasks, show, events, observability and node list on an existing compatible DB.",
			]);
			expect(added).toEqual([
				"  node add CONFIG.json          enroll explicit nonsecret node configuration; optional transport.timeoutMs",
				"                                (5000-600000) bounds each Coordinator call (default 30000, win32 120000)",
				"  node list                     inventory (not a live readiness assertion) + effectiveRpcTimeoutMs",
				"                                durable local state, no remote mutation; JSON unless --compact; lists",
				"                                only where a result is stored",
				"  show TASK_ID                  durable local state, no remote mutation; reads and verifies the result",
				"  backup NEW_DESTINATION        consistent DB + NEW_DESTINATION.results; restore both together",
				"  results status                result externalisation on/off, ladder version, inline/external counts",
				"  results enable --confirm-one-way --reason TEXT",
				"                                audited switch ON: new results' >=1 KiB fields leave the row. The DB stays",
				"                                ladder v2 until the first externalised row, whose transaction takes the",
				"                                ONE-WAY step to v3 (older builds then refuse the DB). Off by default",
				"  results disable --reason TEXT audited switch OFF: new results inline again; externalised rows stay",
				"                                readable; before the first externalised row the DB is plain ladder v2 again",
				"  migrate results [--apply]     dry-run inline result migration; --apply (only when enabled) verifies each",
				"                                row round trip then shrinks it; run VACUUM afterwards to shrink the file",
				"  results check                 verify every referenced result blob and externalised row; list missing/corrupt/",
				"                                rows/unreferenced/temporary",
				"  results gc [--apply]          dry-run; --apply removes unreferenced blobs and abandoned temporaries",
				"  node-health show [NODE_ID]    read-only: node stability, the selection gating switch, its audited",
				"                                changes and what switching on would exclude (also under --read-only)",
				"  node-health gating on [--force] JSON | gating off JSON",
				"                                audited operator switch ({\"operator\",\"reason\"}), stored in this DB,",
				"                                default off. Off: submit, run, queue reconsider and reserve decide exactly",
				"                                as without node health and never probe or record. on is refused while any",
				"                                enabled node is not stable unless --force; it prints that preview",
				"  node-health bootstrap NODE_ID --reason TEXT",
				"                                explicit audited bootstrap: bounded real probes of one node",
				"                                (fresh resource sample per probe); exit 0 only when stable",
				"                                refused (node_health_gating_off) while gating is off",
				"Node health shares this DB (node_health_* tables only; schema version and fleet_meta unchanged). Only ui (not",
				"--read-only) started with gating on records probes in the background (it stops once gating reads off), plus",
				"node-health bootstrap (refused while gating is off); with gating on, submit, run and queue reconsider also",
				"probe and record each decision.",
				"A sample is health evidence only when this process measured it.",
				"--read-only permits only tasks, show, events, observability, node list, results status, results check,",
				"daemon status and node-health show on an existing compatible DB.",
			]);
			expect(n.filter((line) => !added.includes(line))).toEqual(o.filter((line) => !removed.includes(line)));
		}
		console.log(`differential perPhase=${perPhase}: ${list.length} commands compared, ${Object.keys(base.ids).length} tasks`);
	}, 600_000);
}
