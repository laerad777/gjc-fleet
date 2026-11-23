// Subject linkage (DESIGN step 2): a task names one file of another task's STORED result in its input.
// Every subject task here is a real task started on the controlled local node (test/fixtures/coordinator.ts),
// settled and collected through the real CLI; refusals go through FleetStore.submit (and the CLI submit),
// placement through FleetStore.reserve and the CLI preflight, views through the CLI on temporary databases.
import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeConfig, TaskInput } from "../src/contracts";
import { digest, FleetError, observationDigest, selectNode, SUBJECT_PATH_MAX_BYTES } from "../src/core";
import { Fleet } from "../src/fleet";
import { FleetStore } from "../src/store";
import { SUBJECT_REVIEWS_SHOWN } from "../src/subject";
import { enableWorkUnits } from "../src/work-unit";
import { preflightPlacement, reservePlacement } from "../src/placement-preflight";
import { headroom } from "./admission-fixture";
import { repositoryFixture } from "./fixtures/coordinator";
import { access, approval, cleanup, clocked, fleetFixture, makeStable, selectionAudit } from "./fixtures/node-health";

const root = join(import.meta.dir, "..");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
	await cleanup();
});

const FINAL = "# Result\nfinal text\n";
const PATCH = "diff --git a/x b/x\n";

function node(id: string, repo: { repo: string; workspaceRoot: string }, state: string): NodeConfig {
	return { id, os: process.platform, arch: process.arch, roots: { repo: repo.repo }, workspaceRoot: repo.workspaceRoot,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: [], operations: [],
		transport: { command: process.execPath, args: [join(import.meta.dir, "fixtures/coordinator.ts"), state] } };
}

async function cli(db: string, args: string[], localNode = "local") {
	const child = Bun.spawn([process.execPath, join(root, "src", "cli.ts"), "--db", db, "--local-node-id", localNode, ...args],
		{ cwd: root, stdout: "pipe", stderr: "pipe", env: { ...process.env, GJC_SDK_BROKER_AUTOSTART: "0" } });
	const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	let json: any;
	try {
		json = JSON.parse(stdout);
	} catch {
		json = undefined;
	}
	return { exit, stdout, stderr, json };
}

/** One store per call: the CLI and the test never hold the database open at the same time. */
function withStore<T>(db: string, use: (store: FleetStore) => T): T {
	const store = new FleetStore(db);
	try {
		return use(store);
	} finally {
		store.close();
	}
}
function refusal(run: () => unknown): { code: string; message: string } {
	try {
		run();
	} catch (error) {
		if (error instanceof FleetError) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error("expected a refusal");
}

/** A real task ("impl", pinned to node local) on the controlled node; `other` is a second registered node. */
async function implementation(options: { collect: boolean }) {
	const repo = await repositoryFixture("fleet-subject-link-");
	dirs.push(repo.dir);
	const db = join(repo.dir, "fleet.sqlite");
	const state = join(repo.dir, "coordinator.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const store = new FleetStore(db);
	store.putNode(node("local", repo, state));
	store.putNode(node("other", repo, state));
	const fleet = new Fleet(store, { localNodeId: "local" });
	const impl = await fleet.start(fleet.submit({ schemaVersion: 1, key: "impl", caller: "controlled", repoId: "repo",
		baseCommit: repo.baseCommit, prompt: "Deliver RESULT.md and a patch", required: { nodeId: "local" } }).id);
	await fleet.close();
	store.close();
	const workspace = (impl.workspace as unknown as { path: string }).path;
	const write = async (path: string, text: string) => {
		await mkdir(join(workspace, ...path.split("/").slice(0, -1)), { recursive: true });
		await writeFile(join(workspace, ...path.split("/")), text);
	};
	const settle = (id = impl.id) =>
		withStore(db, (s) => {
			const task = s.task(id)!;
			const body = { sessionId: task.sessionId!, turnId: task.turnId!, status: "completed_unverified" as const,
				terminal: true, evidence: { injected: "controlled settlement" } };
			s.observe(id, { ...body, eventId: `controlled-settlement-${id}`, digest: observationDigest(body) });
		});
	const collect = async (id = impl.id, localNode = "local") => {
		const collected = await cli(db, ["result", id], localNode);
		expect(collected.exit).toBe(0);
	};
	const review = (key: string, subject: Record<string, unknown>, extra: Partial<TaskInput> = {}) =>
		({ schemaVersion: 1, key, caller: "controlled", repoId: "repo", baseCommit: repo.baseCommit,
			prompt: "Review the subject file", required: {}, ...extra, subject }) as unknown as TaskInput; // tests pass malformed subjects on purpose
	const f = { ...repo, db, state, impl, workspace, write, settle, collect, review };
	if (options.collect) {
		await write("RESULT.md", FINAL);
		await write("fix.patch", PATCH);
		await rm(join(workspace, "deleted.txt"));
		settle();
		await collect();
	}
	return f;
}

let shared: Promise<Awaited<ReturnType<typeof implementation>>> | undefined;
const collected = () => (shared ??= implementation({ collect: true }));

test("each refusal is decided in submit against the subject's stored manifest; refusals create no task", async () => {
	const f = await implementation({ collect: false });
	const good = { taskId: f.impl.id, path: "RESULT.md", sha256: sha256(FINAL) };
	const count = () => withStore(f.db, (s) => s.taskStates().length);
	const before = count();
	withStore(f.db, (s) => {
		expect(refusal(() => s.submit(f.review("r-unknown", { ...good, taskId: "no-such-task" }))).code).toBe("SUBJECT_NOT_FOUND");
		// Started and running, nothing stored yet.
		expect(refusal(() => s.submit(f.review("r-running", good))).code).toBe("SUBJECT_NOT_COLLECTED");
		// Queued, never started.
		const { subject: _none, ...plain } = f.review("plain", good);
		const queued = s.submit(plain as TaskInput);
		expect(refusal(() => s.submit(f.review("r-queued", { ...good, taskId: queued.id }))).code).toBe("SUBJECT_NOT_COLLECTED");
	});
	await f.write("RESULT.md", FINAL);
	await rm(join(f.workspace, "deleted.txt"));
	f.settle();
	// Settled but not collected: still refused, and the refusal never collects.
	withStore(f.db, (s) => expect(refusal(() => s.submit(f.review("r-settled", good))).code).toBe("SUBJECT_NOT_COLLECTED"));
	expect(withStore(f.db, (s) => s.task(f.impl.id)!.resultManifest)).toBeUndefined();
	await f.collect();
	const files = withStore(f.db, (s) => (s.task(f.impl.id)!.resultManifest as any).files as { path: string; sha256: string; deleted: boolean }[]);
	expect(files.find((file) => file.path === "deleted.txt")).toMatchObject({ deleted: true, sha256: sha256("") });
	// The workspace is rewritten after collection: only the stored manifest counts.
	await f.write("RESULT.md", "rewritten after collection\n");
	withStore(f.db, (s) => {
		const missing = refusal(() => s.submit(f.review("r-missing", { ...good, path: "NOPE.md" })));
		expect(missing).toMatchObject({ code: "SUBJECT_FILE_MISMATCH" });
		expect(missing.message).toContain("not in the stored result");
		// A deleted entry is refused even with the SHA-256 the manifest records for it.
		const deleted = refusal(() => s.submit(f.review("r-deleted", { ...good, path: "deleted.txt", sha256: sha256("") })));
		expect(deleted).toMatchObject({ code: "SUBJECT_FILE_MISMATCH" });
		expect(deleted.message).toContain("deleted");
		const other = refusal(() => s.submit(f.review("r-other", { ...good, sha256: sha256("rewritten after collection\n") })));
		expect(other).toMatchObject({ code: "SUBJECT_FILE_MISMATCH" });
		expect(other.message).toContain(sha256(FINAL));
		// The only way an input can name itself: its caller/key already identifies the subject task.
		expect(refusal(() => s.submit({ ...f.review("impl", good) }))).toMatchObject({ code: "SUBJECT_SELF" });
		// otherNode with a pin on the subject's node could never be placed.
		expect(refusal(() => s.submit(f.review("r-pinned", { ...good, otherNode: true }, { required: { nodeId: "local" } })))).toMatchObject({ code: "SUBJECT_NODE_PINNED" });
	});
	expect(count()).toBe(before + 1);
	const refused = (() => {
		const raw = new Database(f.db, { readonly: true });
		try {
			return raw.query<{ code: string }, []>("SELECT json_extract(data,'$.code') AS code FROM audit WHERE kind='refused' AND json_extract(data,'$.action')='submit' ORDER BY sequence").all().map((row) => row.code);
		} finally {
			raw.close();
		}
	})();
	expect(refused).toEqual(["SUBJECT_NOT_FOUND", "SUBJECT_NOT_COLLECTED", "SUBJECT_NOT_COLLECTED", "SUBJECT_NOT_COLLECTED",
		"SUBJECT_FILE_MISMATCH", "SUBJECT_FILE_MISMATCH", "SUBJECT_FILE_MISMATCH", "SUBJECT_SELF", "SUBJECT_NODE_PINNED"]);
	// The CLI submit refuses the same way (after its read-only preflight) and creates nothing.
	const task = join(f.dir, "bad.json");
	await writeFile(task, JSON.stringify(f.review("r-cli", { ...good, sha256: "0".repeat(64) })));
	const resources = join(f.dir, "resources.json");
	await writeFile(resources, JSON.stringify(Object.fromEntries(headroom(["local", "other"], 4).samples)));
	const cliRefusal = await cli(f.db, ["--resources", resources, "submit", task]);
	expect(cliRefusal.exit).toBe(1);
	expect(JSON.parse(cliRefusal.stderr).error).toBe("SUBJECT_FILE_MISMATCH");
	expect(count()).toBe(before + 1);
	// The valid subject is accepted.
	expect(withStore(f.db, (s) => s.submit(f.review("r-good", good)).phase)).toBe("queued");
}, 120_000);

test("the subject is bound into the input digest and deduplicated by caller/key; no other state is written", async () => {
	const f = await collected();
	const subject = { taskId: f.impl.id, path: "RESULT.md", sha256: sha256(FINAL), otherNode: true };
	const input = f.review("dedupe", subject);
	withStore(f.db, (s) => {
		const first = s.submit(input);
		const again = s.submit(structuredClone(input));
		expect(again.id).toBe(first.id);
		expect(first.inputDigest).toBe(digest(input));
		const { subject: _dropped, ...without } = input;
		expect(first.inputDigest).not.toBe(digest(without));
		expect(s.task(first.id)!.input.subject).toEqual(subject);
		expect(s.events(first.id).filter((event) => event.kind === "submitted")).toHaveLength(1);
		// The same caller/key with any other subject is a different input.
		for (const changed of [{ ...subject, path: "fix.patch", sha256: sha256(PATCH) }, { ...subject, otherNode: false }, { taskId: subject.taskId, path: subject.path, sha256: subject.sha256 }])
			expect(refusal(() => s.submit(f.review("dedupe", changed))).code).toBe("KEY_CONFLICT");
		expect(refusal(() => s.submit(without as TaskInput)).code).toBe("KEY_CONFLICT");
	});
	// A repeat through the CLI resolves the same task as well.
	const file = join(f.dir, "dedupe.json");
	await writeFile(file, JSON.stringify(input));
	const resources = join(f.dir, "resources.json");
	await writeFile(resources, JSON.stringify(Object.fromEntries(headroom(["local", "other"], 4).samples)));
	const repeat = await cli(f.db, ["--resources", resources, "submit", file]);
	expect(repeat.json.id).toBe(withStore(f.db, (s) => s.taskStates().find((t) => t.input.key === "dedupe")!.id));
}, 120_000);

test("otherNode: selectNode excludes the subject's node with reason subject_node, audited in selection", async () => {
	const f = await collected();
	const subject = { taskId: f.impl.id, path: "fix.patch", sha256: sha256(PATCH) };
	const selection = (s: FleetStore, id: string) => s.events(id).filter((event) => event.kind === "selection").at(-1)!.data as any;
	withStore(f.db, (s) => {
		// Even preferring the subject's node, an otherNode review lands elsewhere.
		const away = s.reserve(s.submit(f.review("place-away", { ...subject, otherNode: true }, { preferences: ["local"] })).id);
		expect(away.nodeId).toBe("other");
		expect(selection(s, away.id)).toMatchObject({ outcome: "selected", nodeId: "other", exclusions: [{ nodeId: "local", reasons: ["subject_node"] }] });
		// Without otherNode (or with false) the subject's node stays eligible.
		for (const [key, link] of [["place-same", subject], ["place-false", { ...subject, otherNode: false }]] as const) {
			const same = s.reserve(s.submit(f.review(key, link, { preferences: ["local"] })).id);
			expect(same.nodeId).toBe("local");
			expect(selection(s, same.id).exclusions).toEqual([]);
		}
		// A pin on another node is fine.
		const pinned = s.reserve(s.submit(f.review("place-pinned", { ...subject, otherNode: true }, { required: { nodeId: "other" } })).id);
		expect(pinned.nodeId).toBe("other");
		expect(selection(s, pinned.id).exclusions).toEqual([{ nodeId: "local", reasons: ["manual_node_mismatch", "subject_node"] }]);
		// No other node: unplaceable, with the reason in the audit.
		s.setNodeState("other", { enabled: false });
		try {
			const stuck = s.reserve(s.submit(f.review("place-stuck", { ...subject, otherNode: true })).id);
			expect(stuck).toMatchObject({ phase: "queued", reason: "no_eligible_node" });
			expect(stuck.nodeId).toBeUndefined();
			expect(selection(s, stuck.id)).toMatchObject({ outcome: "rejected", reason: "no_eligible_node",
				exclusions: [{ nodeId: "local", reasons: ["subject_node"] }, { nodeId: "other", reasons: ["disabled"] }] });
		} finally {
			s.setNodeState("other", { enabled: true });
		}
	});
	// The CLI submit's preflight treats the subject's node as hard-ineligible and never probes it.
	const file = join(f.dir, "away.json");
	await writeFile(file, JSON.stringify(f.review("place-cli", { ...subject, otherNode: true })));
	const resources = join(f.dir, "resources.json");
	await writeFile(resources, JSON.stringify(Object.fromEntries(headroom(["local", "other"], 4).samples)));
	const submitted = await cli(f.db, ["--resources", resources, "submit", file]);
	const local = submitted.json.placement.nodes.find((row: any) => row.nodeId === "local");
	expect(local.checks.eligibility).toMatchObject({ ok: false, code: "subject_node" });
	expect(local.checks.coordinator.code).toBe("hard_ineligible_probe_skipped");
	const id = submitted.json.id;
	withStore(f.db, (s) => {
		const audit = selection(s, id);
		expect(audit.exclusions.find((row: any) => row.nodeId === "local").reasons).toContain("subject_node");
		// `other` has no workspace transport: the preflight cannot ready it, so nothing is admitted.
		expect(s.task(id)!.nodeId).toBeUndefined();
	});
	expect(submitted.exit).toBe(1);
}, 120_000);

test("views: show REVIEW carries subject and its phase, show IMPL --reviews carries reviews, tasks --subject filters", async () => {
	const f = await collected();
	const subject = { taskId: f.impl.id, path: "RESULT.md", sha256: sha256(FINAL) };
	// A review run to a stored result, to show its result digest. The controlled node has one fixed session id per
	// node, so the review runs on a third node with its own controlled state (registered only here).
	const state = join(f.dir, "coordinator-rev.json");
	await writeFile(state, JSON.stringify({ calls: [] }));
	const done = await (async () => {
		const store = new FleetStore(f.db);
		store.putNode(node("rev", f, state));
		const fleet = new Fleet(store, { localNodeId: "rev" });
		try {
			return await fleet.start(fleet.submit(f.review("view-done", { ...subject, otherNode: true }, { required: { nodeId: "rev" } })).id);
		} finally {
			await fleet.close();
			store.close();
		}
	})();
	await writeFile(join((done.workspace as unknown as { path: string }).path, "REVIEW.md"), "VERDICT: operator text only\n");
	f.settle(done.id);
	await f.collect(done.id, "rev");
	const queued = withStore(f.db, (s) => s.submit(f.review("view-queued", { ...subject, otherNode: true })));

	const review = await cli(f.db, ["show", queued.id]);
	expect(review.exit).toBe(0);
	expect(review.json.subject).toEqual({ ...subject, otherNode: true, phase: "completed_unverified", nodeId: "local" });
	expect(review.json.input.subject).toEqual({ ...subject, otherNode: true });
	expect(review.json.reviews).toBeUndefined();

	const listing = await cli(f.db, ["tasks", "--subject", f.impl.id]);
	expect(listing.exit).toBe(0);
	const linked = withStore(f.db, (s) => s.taskStates().filter((t) => t.input.subject?.taskId === f.impl.id).map((t) => t.id));
	expect(linked).toContain(done.id);
	expect(listing.json.map((t: any) => t.id)).toEqual(linked);
	const doneDigest = listing.json.find((t: any) => t.id === done.id).resultManifest.digest;
	expect(doneDigest).toMatch(/^[a-f0-9]{64}$/);

	// Plain show never looks for reviews (that scans every task row); --reviews does.
	const plain = await cli(f.db, ["show", f.impl.id]);
	expect(plain.exit).toBe(0);
	for (const key of ["subject", "reviews", "reviewsOmitted"]) expect(Object.hasOwn(plain.json, key)).toBe(false);
	const impl = await cli(f.db, ["show", f.impl.id, "--reviews"]);
	expect(impl.exit).toBe(0);
	expect(impl.json.subject).toBeUndefined();
	expect(impl.json.reviewsOmitted).toBeUndefined();
	// Newest first.
	expect(impl.json.reviews.map((r: any) => r.taskId)).toEqual([...linked].reverse());
	expect(impl.json.reviews[0]).toEqual({ taskId: queued.id, phase: "queued", nodeId: null, path: "RESULT.md", sha256: sha256(FINAL), resultDigest: null });
	expect(impl.json.reviews.find((r: any) => r.taskId === done.id)).toEqual({ taskId: done.id, phase: "completed_unverified", nodeId: "rev",
		path: "RESULT.md", sha256: sha256(FINAL), resultDigest: doneDigest });

	// --compact and --read-only filter the same rows; an unknown subject matches nothing.
	const compact = await cli(f.db, ["tasks", "--subject", f.impl.id, "--compact"]);
	expect(compact.stdout.trim().split("\n").map((line) => line.split("\t")[0])).toEqual(linked.map((id) => id.slice(0, 12)));
	const readOnly = await cli(f.db, ["--read-only", "tasks", "--compact", "--subject", f.impl.id]);
	// Age (compactTask 5th column) advances across the two CLI processes; blank it before compare.
	const blankAge = (stdout: string) =>
		stdout.split("\n").map((line) => { const c = line.split("\t"); if (c.length > 4) c[4] = ""; return c.join("\t"); }).join("\n");
	expect(blankAge(readOnly.stdout)).toBe(blankAge(compact.stdout));
	const readOnlyJson = await cli(f.db, ["--read-only", "tasks", "--subject", f.impl.id]);
	expect(readOnlyJson.json).toEqual(listing.json);
	expect((await cli(f.db, ["--read-only", "show", f.impl.id, "--reviews"])).json.reviews).toEqual(impl.json.reviews);
	expect((await cli(f.db, ["tasks", "--subject", "no-such-task"])).json).toEqual([]);
	expect(JSON.parse((await cli(f.db, ["tasks", "--subject"])).stderr).error).toBe("tasks_filter_value_required");
	expect(JSON.parse((await cli(f.db, ["tasks", "--subject", "a", "--subject", "b"])).stderr).error).toBe("duplicate_tasks_filter");
	// Combined with another filter.
	const queuedOnly = await cli(f.db, ["tasks", "--subject", f.impl.id, "--phase", "completed_unverified"]);
	expect(queuedOnly.json.map((t: any) => t.id)).toEqual([done.id]);
}, 180_000);

test(`bounds: show --reviews lists the newest ${SUBJECT_REVIEWS_SHOWN} reviews and counts the rest; path and SHA-256 shape`, async () => {
	const f = await collected();
	const subject = { taskId: f.impl.id, path: "RESULT.md", sha256: sha256(FINAL) };
	const ids = withStore(f.db, (s) => Array.from({ length: SUBJECT_REVIEWS_SHOWN + 1 }, (_, i) => s.submit(f.review(`bulk-${i}`, subject)).id));
	const total = withStore(f.db, (s) => s.taskStates().filter((t) => t.input.subject?.taskId === f.impl.id).length);
	const shown = await cli(f.db, ["show", f.impl.id, "--reviews"]);
	expect(shown.json.reviews).toHaveLength(SUBJECT_REVIEWS_SHOWN);
	expect(shown.json.reviewsOmitted).toBe(total - SUBJECT_REVIEWS_SHOWN);
	expect(shown.json.reviews[0].taskId).toBe(ids.at(-1));
	expect(shown.json.reviews[SUBJECT_REVIEWS_SHOWN - 1].taskId).toBe(ids[1]);
	// The filter is not capped.
	expect((await cli(f.db, ["tasks", "--subject", f.impl.id, "--compact"])).stdout.trim().split("\n")).toHaveLength(total);

	withStore(f.db, (s) => {
		const shape = (key: string, link: unknown) => refusal(() => s.submit(f.review(key, link as Record<string, unknown>)));
		const longest = "a/".repeat(SUBJECT_PATH_MAX_BYTES / 2 - 1) + "bc";
		expect(Buffer.byteLength(longest)).toBe(SUBJECT_PATH_MAX_BYTES);
		// Shape-valid at the bound: refused only because the stored result has no such file.
		expect(shape("shape-max", { ...subject, path: longest }).code).toBe("SUBJECT_FILE_MISMATCH");
		for (const path of [longest + "c", "", "/RESULT.md", "C:/RESULT.md", "../RESULT.md", "a/../RESULT.md", "./RESULT.md", "a/./b",
			"a//b", "dir/", "a\\b", "a\nb", "a\u0000b", "\ud800"])
			expect(shape("shape-path", { ...subject, path }).code).toBe("INVALID_INPUT");
		for (const sha of [sha256(FINAL).toUpperCase(), sha256(FINAL).slice(1), `${sha256(FINAL)}0`, 1])
			expect(shape("shape-sha", { ...subject, sha256: sha }).code).toBe("INVALID_INPUT");
		for (const link of [{ ...subject, extra: true }, { ...subject, otherNode: "yes" }, { ...subject, otherNode: 1 }, { ...subject, taskId: "bad id" },
			{ path: subject.path, sha256: subject.sha256 }, { ...subject, path: 5 }, [subject], null, "id"])
			expect(shape("shape-other", link).code).toBe("INVALID_INPUT");
	});
}, 120_000);

test("workUnit combined with subject is INVALID_INPUT, with the work-unit switch off and on", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-subject-unit-"));
	try {
		const store = new FleetStore(join(dir, "fleet.sqlite"));
		try {
			const base = { schemaVersion: 1, key: "unit", caller: "controlled", repoId: "repo", baseCommit: "a".repeat(40),
				prompt: "Write fleet-review/report.md starting with VERDICT: CLEAN or VERDICT: NOT CLEAN", required: {} };
			const unit = { role: "review", subject: { taskId: "impl-task", branch: "review/x" } };
			const link = { taskId: "impl-task", path: "RESULT.md", sha256: "a".repeat(64) };
			const both = { ...base, workUnit: unit, subject: link } as unknown as TaskInput;
			expect(refusal(() => store.submit(both)).code).toBe("INVALID_INPUT");
			enableWorkUnits(store, { actor: "test", reason: "subject combination" });
			const on = refusal(() => store.submit(both));
			expect(on.code).toBe("INVALID_INPUT");
			expect(on.message).toContain("subject");
			expect(refusal(() => store.submit({ ...base, workUnit: { role: "report" }, subject: link } as unknown as TaskInput)).code).toBe("INVALID_INPUT");
			// Without the subject the same review passes validation and reaches the work-unit store check.
			expect(refusal(() => store.submit({ ...base, workUnit: unit } as unknown as TaskInput)).code).toBe("NON_FLEET_COMMIT");
			expect(store.taskStates()).toEqual([]);
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database without subjects is unchanged: same schema, selection, views; a subject adds no schema", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-subject-legacy-"));
	dirs.push(dir);
	const db = join(dir, "fleet.sqlite");
	const schema = () => {
		const raw = new Database(db, { readonly: true });
		try {
			return JSON.stringify({ version: raw.query("PRAGMA user_version").get(), objects: raw.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all() });
		} finally {
			raw.close();
		}
	};
	const repo = { repo: join(dir, "repo"), workspaceRoot: join(dir, "workspaces") };
	const input: TaskInput = { schemaVersion: 1, key: "legacy", caller: "controlled", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} };
	const id = withStore(db, (s) => {
		s.putNode(node("local", repo, join(dir, "state.json")));
		s.putNode(node("other", repo, join(dir, "state.json")));
		const task = s.reserve(s.submit(input).id);
		// The selection a subject-less input gets is exactly selectNode's without a subject node.
		const audit = s.events(task.id).find((event) => event.kind === "selection")!.data as any;
		expect(audit.exclusions).toEqual(selectNode(input, s.nodes(), []).exclusions);
		expect(audit.nodeId).toBe(selectNode(input, s.nodes(), []).nodeId);
		return task.id;
	});
	const before = schema();
	const show = await cli(db, ["show", id]);
	for (const key of ["subject", "reviews", "reviewsOmitted"]) expect(Object.hasOwn(show.json, key)).toBe(false);
	expect(show.json.input).toEqual({ ...input, prompt: "[omitted; retained in private database]" });
	expect((await cli(db, ["tasks", "--subject", id])).json).toEqual([]);
	const all = await cli(db, ["tasks"]);
	expect(all.json.map((t: any) => t.id)).toEqual([id]);
	expect(Object.hasOwn(all.json[0], "subject")).toBe(false);
	expect(schema()).toBe(before);
	// Linking a subject (here: refused, then a plain stored result accepted) writes rows, never schema.
	withStore(db, (s) => {
		s.saveResult(id, { status: "not_run", patch: "", files: [{ path: "R.md", sha256: sha256("r"), deleted: false, type: "regular" }], tests: [] });
		s.submit({ ...input, key: "linked", subject: { taskId: id, path: "R.md", sha256: sha256("r") } });
	});
	expect(schema()).toBe(before);
}, 60_000);

test("archiving or disposing the subject keeps every link readable; the stored manifest still admits new reviews", async () => {
	const f = await implementation({ collect: true });
	const subject = { taskId: f.impl.id, path: "RESULT.md", sha256: sha256(FINAL), otherNode: true };
	const first = withStore(f.db, (s) => s.submit(f.review("before-dispose", subject)));
	withStore(f.db, (s) => {
		expect(s.task(f.impl.id)!.held).toBe(false);
		s.setNodeState("local", { enabled: false });
		s.unregisterNode("local");
	});
	const disposed = await cli(f.db, ["task", "dispose", f.impl.id, "--as", "discarded", "--reason", "rehearsal", "--node-retired", "node gone"]);
	expect(disposed.stderr).toBe("");
	expect(disposed.exit).toBe(0);
	const review = await cli(f.db, ["show", first.id]);
	expect(review.json.subject).toEqual({ ...subject, phase: "archived", nodeId: "local" });
	withStore(f.db, (s) => {
		// A repeat is deduplicated without re-checking; a new review still checks the immutable stored manifest.
		expect(s.submit(f.review("before-dispose", subject)).id).toBe(first.id);
		const after = s.submit(f.review("after-dispose", subject));
		expect(refusal(() => s.submit(f.review("after-dispose-bad", { ...subject, sha256: "f".repeat(64) }))).code).toBe("SUBJECT_FILE_MISMATCH");
		// The subject's (now unregistered) node is still the one excluded; `other` takes the review.
		const placed = s.reserve(after.id);
		expect(placed.nodeId).toBe("other");
	});
	const impl = await cli(f.db, ["show", f.impl.id, "--reviews"]);
	expect(impl.json.phase).toBe("archived");
	expect(impl.json.reviews.map((r: any) => r.taskId)).toEqual([withStore(f.db, (s) => s.taskStates().find((t) => t.input.key === "after-dispose")!.id), first.id]);
	expect((await cli(f.db, ["tasks", "--subject", f.impl.id, "--compact"])).stdout.trim().split("\n")).toHaveLength(2);
}, 120_000);

/** A store with nodes `local` and `other` and a reserved subject task pinned to `local` holding `manifest`. */
function storedSubject(manifest: Record<string, unknown>, options: { externalise: boolean }) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-subject-stored-"));
	dirs.push(dir);
	const db = join(dir, "fleet.sqlite");
	const repo = { repo: join(dir, "repo"), workspaceRoot: join(dir, "workspaces") };
	const base: TaskInput = { schemaVersion: 1, key: "impl", caller: "controlled", repoId: "repo", baseCommit: "a".repeat(40), prompt: "p", required: {} };
	const impl = withStore(db, (s) => {
		s.putNode(node("local", repo, join(dir, "state.json")));
		s.putNode(node("other", repo, join(dir, "state.json")));
		if (options.externalise) s.enableResultStore({ actor: "test", reason: "externalised subject" });
		const task = s.reserve(s.submit({ ...base, required: { nodeId: "local" } }).id);
		s.saveResult(task.id, manifest as never);
		return task.id;
	});
	const row = (id: string) => {
		const raw = new Database(db, { readonly: true });
		try {
			return raw.query<{ external: string | null; inline: string | null }, [string]>(
				"SELECT json_type(data,'$.resultExternal') AS external, json_type(data,'$.resultManifest') AS inline FROM tasks WHERE id=?").get(id)!;
		} finally {
			raw.close();
		}
	};
	return { db, base, impl, row };
}

test("capacity: plain show never scans other tasks' 8 MB inline results; show --reviews is the opt-in scan", async () => {
	const file = { path: "R.md", sha256: sha256("r"), deleted: false, type: "regular" };
	const f = storedSubject({ status: "not_run", patch: "", files: [file], tests: [] }, { externalise: false });
	const subject = { taskId: f.impl, path: "R.md", sha256: sha256("r") };
	const big = "x".repeat(8 * 1024 * 1024);
	const review = withStore(f.db, (s) => {
		const review = s.submit({ ...f.base, key: "review", subject }).id;
		const raw = new Database(f.db);
		try {
			// 40 other tasks each carrying an 8 MB inline result (~320 MiB of rows), written as their final shape.
			for (let i = 0; i < 40; i++)
				raw.query("UPDATE tasks SET data=json_set(data,'$.resultManifest',json_object('patch',?)) WHERE id=?").run(big, s.submit({ ...f.base, key: `big-${i}` }).id);
		} finally {
			raw.close();
		}
		return review;
	});
	const median = (run: () => unknown) => {
		const times: number[] = [];
		for (let i = 0; i < 3; i++) {
			const t0 = performance.now();
			run();
			times.push(performance.now() - t0);
		}
		return times.sort((a, b) => a - b)[1]!;
	};
	const measured = withStore(f.db, (s) => {
		const impl = s.task(f.impl)!;
		expect(s.subjectLinks(impl, { reviews: false })).toEqual({});
		expect(s.subjectLinks(impl, { reviews: true }).reviews).toEqual([{ taskId: review, phase: "queued", nodeId: null, path: "R.md", sha256: sha256("r"), resultDigest: null }]);
		return { plainMs: median(() => s.subjectLinks(impl, { reviews: false })), reviewsMs: median(() => s.subjectLinks(impl, { reviews: true })) };
	});
	console.log("SUBJECT_SHOW_MEASUREMENT " + JSON.stringify(measured));
	// A plain show is one primary-key read: it does not grow with other rows, unlike the scan.
	expect(measured.plainMs * 10).toBeLessThan(measured.reviewsMs);
	const plain = await cli(f.db, ["--read-only", "show", f.impl]);
	expect(plain.exit).toBe(0);
	for (const key of ["subject", "reviews", "reviewsOmitted"]) expect(Object.hasOwn(plain.json, key)).toBe(false);
	const withReviews = await cli(f.db, ["--read-only", "show", f.impl, "--reviews"]);
	expect(withReviews.json.reviews.map((r: any) => r.taskId)).toEqual([review]);
}, 120_000);

test("externalised results: the subject check reads the skeleton; reviews[].resultDigest equals the tasks listing digest (external and non-object)", async () => {
	const file = { path: "R.md", sha256: sha256("r"), deleted: false, type: "regular" };
	const big = "x".repeat(4096);
	const f = storedSubject({ status: "not_run", patch: big, files: [file], tests: [] }, { externalise: true });
	expect(f.row(f.impl)).toEqual({ external: "object", inline: null });
	const subject = { taskId: f.impl, path: "R.md", sha256: sha256("r"), otherNode: true };
	const ids = withStore(f.db, (s) => {
		expect(refusal(() => s.submit({ ...f.base, key: "bad-sha", subject: { ...subject, sha256: sha256("other") } })).code).toBe("SUBJECT_FILE_MISMATCH");
		expect(refusal(() => s.submit({ ...f.base, key: "bad-path", subject: { ...subject, path: "NOPE.md" } })).code).toBe("SUBJECT_FILE_MISMATCH");
		const external = s.reserve(s.submit({ ...f.base, key: "external", subject }).id);
		expect(external.nodeId).toBe("other");
		s.saveResult(external.id, { status: "not_run", patch: `${big}review`, files: [], tests: [] });
		// Externalisation off again: a non-object result stays inline (the listing hashes the inline manifest).
		s.disableResultStore({ actor: "test", reason: "inline non-object result" });
		const array = s.reserve(s.submit({ ...f.base, key: "array", subject }).id);
		s.saveResult(array.id, ["a non-object stored result"]);
		return { external: external.id, array: array.id };
	});
	expect(f.row(ids.external)).toEqual({ external: "object", inline: null });
	expect(f.row(ids.array)).toEqual({ external: null, inline: "array" });
	const listing = (await cli(f.db, ["tasks"])).json;
	const listed = (id: string) => listing.find((t: any) => t.id === id).resultManifest.digest;
	for (const id of [ids.external, ids.array]) expect(listed(id)).toMatch(/^[a-f0-9]{64}$/);
	const shown = await cli(f.db, ["show", f.impl, "--reviews"]);
	expect(shown.exit).toBe(0);
	expect(shown.json.reviews.map((r: any) => [r.taskId, r.resultDigest])).toEqual([[ids.array, listed(ids.array)], [ids.external, listed(ids.external)]]);
}, 60_000);

test("daemon placement call: with only the subject's node measured nothing is selected, the node is not called, and its action names subject.otherNode", async () => {
	const f = await fleetFixture("fleet-subject-daemon-");
	f.store.putNode(await f.node("subj"));
	f.store.putNode(await f.node("rev"));
	const impl = f.store.reserve(f.store.submit({ ...f.input, key: "impl", required: { ...f.input.required, nodeId: "subj" } }).id, headroom(["subj"], 10));
	expect(impl.nodeId).toBe("subj");
	f.store.saveResult(impl.id, { status: "not_run", patch: "", files: [{ path: "R.md", sha256: sha256("r"), deleted: false, type: "regular" }], tests: [] });
	const subject = { taskId: impl.id, path: "R.md", sha256: sha256("r"), otherNode: true };
	const review = f.store.submit({ ...f.input, key: "review", subject });
	// Exactly the daemon's call (src/daemon.ts queue pass): the measured nodes only, every call through nodeCall.
	const calls: string[] = [];
	const measured = f.store.nodes().filter((n) => n.id === "subj");
	const report = await preflightPlacement(review.input, measured, f.store.taskStates(), { ...headroom(["subj"], 10), held: f.store.heldCharges(), now: Date.now() },
		{ nodeCall: async (nodeId, probe) => { calls.push(nodeId); return probe(); } });
	expect(report.selection.nodeId).toBeUndefined();
	expect(calls).toEqual([]);
	const row = report.nodes.find((n) => n.nodeId === "subj")!;
	expect(row.checks.eligibility).toEqual({ ok: false, code: "subject_node", action: "The subject's node is excluded by subject.otherNode; register or enable another node." });
	expect(row.checks.coordinator.code).toBe("hard_ineligible_probe_skipped");
	// Pinned to the subject's node as well: both actions, the node-configuration one first.
	const pinned = await preflightPlacement({ ...review.input, required: { ...review.input.required, nodeId: "rev" } }, measured, f.store.taskStates(),
		{ ...headroom(["subj"], 10), held: f.store.heldCharges(), now: Date.now() }, { nodeCall: async (nodeId, probe) => { calls.push(nodeId); return probe(); } });
	expect(pinned.nodes[0]!.checks.eligibility).toEqual({ ok: false, code: "manual_node_mismatch+subject_node",
		action: "Resolve node enablement, platform, repository allowlist and required operations. The subject's node is excluded by subject.otherNode; register or enable another node." });
	expect(calls).toEqual([]);
}, 60_000);

test("node-health gate on: the subject's node is never decision-probed or recorded; the review is placed on the other node", async () => {
	const f = await fleetFixture("fleet-subject-gate-");
	f.store.putNode(await f.node("subj"));
	f.store.putNode(await f.node("rev"));
	const impl = f.store.reserve(f.store.submit({ ...f.input, key: "impl", required: { ...f.input.required, nodeId: "subj" } }).id, headroom(["subj"], 10));
	expect(impl.nodeId).toBe("subj");
	f.store.saveResult(impl.id, { status: "not_run", patch: "", files: [{ path: "R.md", sha256: sha256("r"), deleted: false, type: "regular" }], tests: [] });
	const { h, clock } = clocked(f.path);
	makeStable(h, clock, ["subj", "rev"]);
	h.setSelectionGating(true, approval);
	const review = f.store.submit({ ...f.input, key: "review", subject: { taskId: impl.id, path: "R.md", sha256: sha256("r"), otherNode: true } });
	clock.now += 30_000;
	const placed = await reservePlacement(f.store, review.id, headroom(["subj", "rev"], 10), { nodeHealth: access(h) });
	if (!("health" in placed)) throw new Error("expected a gated placement carrying a health outcome");
	expect(placed.health?.mode).toBe("enforce");
	// Only `rev` was probed for the decision and recorded; the subject's history is untouched.
	expect(h.observations("subj")).toHaveLength(3);
	expect(h.observations("rev")).toHaveLength(4);
	expect(placed.health?.decisions.map((d) => d.nodeId)).toEqual(["rev"]);
	expect(placed.task.nodeId).toBe("rev");
	expect(selectionAudit(f.store, review.id).exclusions.find((row: any) => row.nodeId === "subj").reasons).toContain("eligibility:subject_node");
}, 60_000);
