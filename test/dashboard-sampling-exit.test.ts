import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DASHBOARD = join(import.meta.dir, "..", "src", "dashboard.ts");

/**
 * A process that awaits sampleResourcesOnce must exit by itself. The node transport is a fake `ssh`
 * on PATH that runs the read-only stream script locally, but misbehaves the way a real ssh can.
 * Every misbehaving helper ends by itself after HELPER_SECONDS (longer than the 10 s window, so the
 * bug still shows), so the test never has to signal a process it does not hold a handle to.
 */
const HELPER_SECONDS = 20;

async function sampleInChild(fakeSsh: string): Promise<{ exited: boolean; code: number | null; ms: number; out: string }> {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-sampling-exit-"));
	try {
		await writeFile(join(dir, "ssh"), `#!/bin/bash\n${fakeSsh}`);
		await chmod(join(dir, "ssh"), 0o755);
		await writeFile(
			join(dir, "child.ts"),
			`const { sampleResourcesOnce } = await import(${JSON.stringify(DASHBOARD)});
const node = (id: string) => ({ id, os: process.platform === "darwin" ? "darwin" : "linux", arch: "x64", roots: {}, workspaceRoot: "/tmp", enabled: true, draining: false,
	reachable: true, sdkReady: true, modelReady: true, models: [], transport: { command: "ssh", args: ["fake-host", "gjc"] }, operations: [] });
const samples = await sampleResourcesOnce([node("a"), node("b")], 5_000);
console.log(JSON.stringify([...samples.values()].map((sample) => sample.ok)));
`,
		);
		const started = Date.now();
		const child = Bun.spawn([process.execPath, join(dir, "child.ts")], {
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = new Response(child.stdout).text();
		const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
		const ms = Date.now() - started;
		// Only the child this test spawned and still holds is ever signalled.
		if (!exited) {
			child.kill("SIGKILL");
			await child.exited;
		}
		const code = exited ? child.exitCode : null;
		return { exited, code, ms, out: exited ? await out : "" };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

// POSIX-only: the fake transport is a bash script found through a `:`-separated PATH.
test.skipIf(process.platform === "win32")("sampleResourcesOnce lets the process exit while a background helper keeps the transport's pipes open", async () => {
	// Like an ssh ControlPersist master: a detached helper inherits stdout/stderr and outlives the client.
	const result = await sampleInChild(`( trap '' TERM HUP; sleep ${HELPER_SECONDS} ) </dev/null &\nexec bash -s`);
	expect(result.exited).toBe(true);
	expect(result.code).toBe(0);
	expect(result.out.trim()).toBe("[true,true]");
	expect(result.ms).toBeLessThan(8_000);
}, 20_000);

test.skipIf(process.platform === "win32")("sampleResourcesOnce lets the process exit when the transport ignores SIGTERM and stdin EOF", async () => {
	const result = await sampleInChild(`trap '' TERM\nbash -s\nend=$((SECONDS + ${HELPER_SECONDS}))\nwhile [ $SECONDS -lt $end ]; do sleep 0.2; done`);
	expect(result.exited).toBe(true);
	expect(result.code).toBe(0);
	expect(result.out.trim()).toBe("[true,true]");
	expect(result.ms).toBeLessThan(8_000);
}, 20_000);
