import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { NodeHealthHistory } from "../src/node-health";
import { getDashboardState } from "../src/dashboard";
import { approval, cleanup, cliPath, runCli, track } from "./fixtures/node-health";

// Review 27a86bca F1 (r7): node health re-cut on production main 00b10a9, which has the `fleet daemon`.
// Both sides of every merged hunk are kept: help text, the --read-only allowlist, the read-only store
// for status/show commands, and the dashboard state carrying both `daemon` and `nodeHealth`.
afterEach(cleanup);

/** One DB with a live daemon owner lease and the node-health switch on. */
function both() {
	const dir = mkdtempSync(join(tmpdir(), "fleet-nh-daemon-"));
	const path = join(dir, "fleet.sqlite");
	const store = track(new FleetStore(path));
	expect(store.claimDaemonLease({ owner: "r7-owner", pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }, 60_000)).toBe(true);
	const h = track(new NodeHealthHistory(path));
	h.setSelectionGating(true, approval);
	return { dir, path, store, h };
}

test("r7 merge: help, --read-only and plain daemon status / node-health show all work on one DB holding both", async () => {
	const { path, store, h } = both();
	const help = Bun.spawnSync([process.execPath, cliPath, "help"], { stdout: "pipe", stderr: "pipe" });
	expect(help.exitCode).toBe(0);
	const text = help.stdout.toString().replace(/\s+/g, " ");
	expect(text).toContain("--read-only permits only tasks, show, events, observability, node list, results status, results check, daemon status and node-health show on an existing compatible DB.");
	store.close();
	h.close();
	// A DB file nobody may write: only a read-only store opens it, so a status/show command that opened
	// a writable store fails here.
	chmodSync(path, 0o444);
	try {
		for (const flags of [["--read-only"], []]) {
			const status = await runCli(path, ...flags, "daemon", "status");
			expect({ exit: status.exit, flags }).toEqual({ exit: 0, flags });
			expect(JSON.parse(status.stdout)).toMatchObject({ ok: true, running: true, daemon: { alive: true, owner: "r7-owner" } });
			const shown = await runCli(path, ...flags, "node-health", "show");
			expect({ exit: shown.exit, flags }).toEqual({ exit: 0, flags });
			expect(JSON.parse(shown.stdout).gating).toMatchObject({ enabled: true, operator: approval.operator });
		}
	} finally {
		chmodSync(path, 0o644);
	}
}, 60_000);

test("r7 merge: the dashboard state carries both the daemon view and node health when both are present", () => {
	const { store, h } = both();
	const state = getDashboardState(store, undefined, new Map(), undefined, h);
	expect(state.daemon).toMatchObject({ alive: true, owner: "r7-owner" });
	expect(state.nodeHealth).toMatchObject({ gating: "enforce", operator: approval.operator });
	// Switch off again: the daemon view stays, node health disappears.
	h.setSelectionGating(false, approval);
	const off = getDashboardState(store, undefined, new Map(), undefined, h);
	expect(off.daemon).toMatchObject({ alive: true, owner: "r7-owner" });
	expect(off).not.toHaveProperty("nodeHealth");
});
