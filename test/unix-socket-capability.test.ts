import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unixSocketSkipReason } from "./support/unix-socket-capability";

const denial = new Error("mock Unix listen denial");
const denied = async () => { throw denial; };

test("local EPERM skips with a reason; CI executes the socket case and fails", () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-unix-policy-"));
	try {
		const fixture = join(dir, "socket-policy.test.ts");
		const helper = fileURLToPath(new URL("./support/unix-socket-capability.ts", import.meta.url));
		writeFileSync(fixture, `
import { test } from "bun:test";
import { isStrictUnixSocketCi, unixSocketSkipReason } from ${JSON.stringify(helper)};
const denied = async () => { throw new Error("mock Unix listen denial"); };
const reason = await unixSocketSkipReason(isStrictUnixSocketCi(process.env.PROBE_CI, process.env.PROBE_GITHUB_ACTIONS), denied, () => "EPERM");
if (reason) console.warn(reason);
test.skipIf(Boolean(reason))("socket fixture", denied);
`);
		const run = (ci: string, githubActions = "") => {
			const child = Bun.spawnSync([process.execPath, "test", fixture], {
				cwd: dir, env: { ...process.env, PROBE_CI: ci, PROBE_GITHUB_ACTIONS: githubActions }, timeout: 3000,
			});
			return { status: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
		};
		const local = run("  FaLsE  ", "0");
		expect(local.status).toBe(0);
		expect(local.output).toContain("skipping three local Unix socket cases (EPERM)");
		expect(local.output).toContain("(skip) socket fixture");
		const ci = run("  TrUe  ");
		expect(ci.status).toBe(1);
		expect(ci.output).not.toContain("skipping three local Unix socket cases");
		expect(ci.output).toContain("mock Unix listen denial");
		expect(ci.output).toContain("(fail) socket fixture");
		expect(run("false", "  TrUe  ").status).toBe(1);
		expect(run("1").status).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unexpected local listen failure remains a failure", async () => {
	await expect(unixSocketSkipReason(false, denied, () => "ENOENT")).rejects.toBe(denial);
});
