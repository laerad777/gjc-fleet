import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkPreflight,
	type PreflightEvidence,
} from "./fixtures/cell-acceptance/preflight-real-node";

const script = join(import.meta.dir, "fixtures/cell-acceptance/preflight-real-node.ts");

function evidence(patch: Partial<PreflightEvidence> = {}): PreflightEvidence {
	return {
		hosts: [
			{ role: "a", machineId: "machine-a", dbPath: "/pilot/a/fleet.sqlite" },
			{ role: "b", machineId: "machine-b", dbPath: "/pilot/b/fleet.sqlite" },
		],
		productionDbPaths: ["/var/lib/gjc/fleet.sqlite"],
		peerOpen: [
			{ from: "b", target: "a", opened: false },
			{ from: "a", target: "b", opened: false },
		],
		restart: { role: "a", machineId: "machine-a", dbPath: "/pilot/a/fleet.sqlite" },
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

test("a production DB path aborts", () => {
	const live = evidence();
	live.hosts[0]!.dbPath = live.productionDbPaths[0] + "/";
	expect(checkPreflight(live)).toBe("test DB path is a production DB");
});

test("a peer that opens the other DB aborts", () => {
	const opened = evidence();
	opened.peerOpen[0]!.opened = true;
	expect(checkPreflight(opened)).toBe("peer opened the other host DB");
});

test("a missing peer observation aborts", () => {
	const missing = evidence();
	missing.peerOpen = [missing.peerOpen[1]!];
	expect(checkPreflight(missing)).toBe("peer open evidence is missing");
});

test("a missing restart record aborts", () => {
	expect(checkPreflight(evidence({ restart: null }))).toBe("A restart record is missing");
});

test("a restart on another host or DB aborts", () => {
	const otherHost = evidence();
	otherHost.restart = { role: "a", machineId: "machine-b", dbPath: "/pilot/a/fleet.sqlite" };
	expect(checkPreflight(otherHost)).toBe("A restart host is not the original host");
	const otherDb = evidence();
	otherDb.restart = { role: "a", machineId: "machine-a", dbPath: "/pilot/other/fleet.sqlite" };
	expect(checkPreflight(otherDb)).toBe("A restart DB is not the original DB");
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
