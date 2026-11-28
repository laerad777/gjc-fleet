import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPreflight, type PreflightEvidence } from "./fixtures/cell-acceptance/preflight-real-node";

const script = join(import.meta.dir, "fixtures/cell-acceptance/preflight-real-node.ts");

function evidence(patch: Partial<PreflightEvidence> = {}): PreflightEvidence {
	return {
		runId: "run-1",
		hosts: [
			{ role: "a", machineId: "machine-a", canonicalPath: "/pilot/a/fleet.sqlite", identity: { device: "da", inode: "1" } },
			{ role: "b", machineId: "machine-b", canonicalPath: "/pilot/b/fleet.sqlite", identity: { device: "db", inode: "2" } },
		],
		productionChecks: [
			{ machineId: "machine-a", checked: true, dbs: [{ canonicalPath: "/var/lib/gjc/fleet.sqlite", identity: { device: "da", inode: "9" } }] },
			{ machineId: "machine-b", checked: true, dbs: [{ canonicalPath: "/var/lib/gjc/fleet.sqlite", identity: { device: "db", inode: "9" } }] },
		],
		peerOpen: [
			{ from: "b", target: "a", runId: "run-1", canonicalPath: "/pilot/a/fleet.sqlite",
				identity: { device: "da", inode: "1" }, opened: false },
			{ from: "a", target: "b", runId: "run-1", canonicalPath: "/pilot/b/fleet.sqlite",
				identity: { device: "db", inode: "2" }, opened: false },
		],
		restart: {
			role: "a", machineId: "machine-a", canonicalPath: "/pilot/a/fleet.sqlite",
			identity: { device: "da", inode: "1" }, runId: "run-1", exited: true, restartedAfterExit: true,
		},
		...patch,
	};
}

test("a complete local evidence file passes", () => {
	expect(checkPreflight(evidence())).toBeNull();
});

test("the same machine id aborts", () => {
	const same = evidence();
	same.hosts[1]!.machineId = same.hosts[0]!.machineId;
	expect(checkPreflight(same)).toBe("machine ids are the same");
});

test("the same file identity as production aborts even when the path text differs", () => {
	const live = evidence();
	live.hosts[0]!.canonicalPath = "/tmp/alias/fleet.sqlite";
	live.hosts[0]!.identity = { device: "da", inode: "9" };
	expect(checkPreflight(live)).toBe("test DB is a production DB");
});

test("a canonical production path aborts", () => {
	const live = evidence();
	live.hosts[0]!.canonicalPath = "/var/lib/gjc/fleet.sqlite/";
	expect(checkPreflight(live)).toBe("test DB is a production DB");
});

test("a host without a production check aborts", () => {
	const unchecked = evidence();
	unchecked.productionChecks = [unchecked.productionChecks[1]!];
	expect(checkPreflight(unchecked)).toBe("production DB check is missing");
});

test("a host that checked and found no production DB passes", () => {
	const none = evidence();
	none.productionChecks = [
		{ machineId: "machine-a", checked: true, dbs: [] },
		{ machineId: "machine-b", checked: true, dbs: [] },
	];
	expect(checkPreflight(none)).toBeNull();
});

test("a peer observation from another run aborts", () => {
	const other = evidence();
	other.peerOpen[0]!.runId = "run-2";
	expect(checkPreflight(other)).toBe("peer observation is not the same run");
});

test("a peer that opens the other DB aborts", () => {
	const opened = evidence();
	opened.peerOpen[0]!.opened = true;
	expect(checkPreflight(opened)).toBe("peer opened the other host DB");
});

test("a missing direction aborts", () => {
	const missing = evidence();
	missing.peerOpen = [missing.peerOpen[1]!];
	expect(checkPreflight(missing)).toBe("peer open evidence is missing");
});

test("two observations for one direction abort", () => {
	const extra = evidence();
	extra.peerOpen.push({ ...extra.peerOpen[0]!, opened: false });
	expect(checkPreflight(extra)).toBe("peer observations contradict");
});

test("an observation of a different file aborts", () => {
	const other = evidence();
	other.peerOpen[0]!.identity = { device: "da", inode: "8" };
	expect(checkPreflight(other)).toBe("peer observation is not the target DB");
});

test("a missing restart record aborts", () => {
	expect(checkPreflight(evidence({ restart: null }))).toBe("A restart record is missing");
});

test("a restart on another host, file, or run aborts", () => {
	const otherHost = evidence();
	otherHost.restart = { ...otherHost.restart!, machineId: "machine-b" };
	expect(checkPreflight(otherHost)).toBe("A restart host is not the original host");
	const otherFile = evidence();
	otherFile.restart = { ...otherFile.restart!, identity: { device: "da", inode: "7" } };
	expect(checkPreflight(otherFile)).toBe("A restart file is not the original DB");
	const otherRun = evidence();
	otherRun.restart = { ...otherRun.restart!, runId: "run-2" };
	expect(checkPreflight(otherRun)).toBe("A restart is not the same run");
});

test("a restart that did not follow an exit aborts", () => {
	const stillUp = evidence();
	stillUp.restart = { ...stillUp.restart!, exited: false };
	expect(checkPreflight(stillUp)).toBe("A restart did not follow an exit");
});

test("the CLI passes and aborts on local files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "fleet-preflight-"));
	try {
		const pass = join(dir, "pass.json");
		const stop = join(dir, "stop.json");
		await writeFile(pass, JSON.stringify(evidence()));
		const bad = evidence();
		bad.hosts[0]!.machineId = bad.hosts[1]!.machineId;
		await writeFile(stop, JSON.stringify(bad));
		const ok = Bun.spawn([process.execPath, script, pass], { stdout: "pipe", stderr: "pipe" });
		const [okOut, okErr, okCode] = await Promise.all([
			new Response(ok.stdout).text(), new Response(ok.stderr).text(), ok.exited,
		]);
		expect(okCode).toBe(0);
		expect(okOut).toContain("Fleet real-node preflight PASS");
		expect(okErr).toBe("");
		const failed = Bun.spawn([process.execPath, script, stop], { stdout: "pipe", stderr: "pipe" });
		const [failOut, failErr, failCode] = await Promise.all([
			new Response(failed.stdout).text(), new Response(failed.stderr).text(), failed.exited,
		]);
		expect(failCode).toBe(1);
		expect(failOut).toBe("");
		expect(failErr).toContain("machine ids are the same");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
