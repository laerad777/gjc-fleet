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

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = performance.now() + timeoutMs;
	do {
		if (await predicate()) return true;
		await Bun.sleep(20);
	} while (performance.now() < deadline);
	return false;
}

for (const mode of ["stall", "planned exit"] as const) {
	test(`resource streams reconnect after ${mode} while a pipe holder stays alive`, async () => {
		const { startResourceStreams } = await import("../src/dashboard");
		const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-sampling-reconnect-"));
		const ready = join(dir, "holder-ready");
		const release = join(dir, "holder-release");
		const ack = join(dir, "holder-ack");
		const holder = join(dir, "holder.ts");
		const first = join(dir, "first.ts");
		const recovered = join(dir, "recovered.ts");
		// The first sample comes from the holder, proving it really inherited stdout. Only
		// that synthetic child detaches, so it can outlive the client on Windows as well.
		await writeFile(holder, `
process.stdout.write("L 4 0.50 900 1000 8000000 6000000\\n");
process.stderr.write("synthetic pipe holder\\n");
await Bun.write(${JSON.stringify(ready)}, "ready");
const release = Bun.file(${JSON.stringify(release)});
const until = Date.now() + 18_000;
while (!(await release.exists()) && Date.now() < until) await Bun.sleep(20);
if (await release.exists()) await Bun.write(${JSON.stringify(ack)}, "ack");
`);
		await writeFile(first, `
const child = Bun.spawn([process.execPath, ${JSON.stringify(holder)}],
	{ stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true });
child.unref();
const ready = Bun.file(${JSON.stringify(ready)});
const until = Date.now() + 3_000;
while (!(await ready.exists()) && Date.now() < until) await Bun.sleep(20);
if (!(await ready.exists())) process.exit(2);
${mode === "stall" ? "await Bun.sleep(14_000);" : ""}
`);
		await writeFile(recovered, 'process.stdout.write("L 8 0.50 900 1000 8000000 6000000\\n"); await Bun.sleep(14_000);');
		const node = { id: "fixture", os: "linux" } as import("../src/contracts").NodeConfig;
		const samples: (number | string | undefined)[] = [];
		let launches = 0;
		const streams = startResourceStreams(() => [node], (_id, sample) => {
			samples.push(sample.ok ? sample.cores : sample.error);
		}, {
			stallMs: mode === "stall" ? 2_500 : 12_000,
			command: () => ({ argv: [process.execPath, launches++ === 0 ? first : recovered] }),
		});
		let holderAcknowledged = false;
		try {
			expect(await until(() => samples.includes(8), 8_500)).toBe(true);
			expect(launches).toBe(2);
			expect(samples).toEqual(mode === "stall" ? [4, "resource_stream_disconnected", 8] : [4, 8]);
			expect(streams.latest(node.id)).toMatchObject({ ok: true, cores: 8 });
		} finally {
			streams.stop();
			await Bun.write(release, "release");
			holderAcknowledged = await until(async () => (await Bun.file(ack).text().catch(() => "")) === "ack", 2_000);
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
		// Reconnect did not kill the simulated ControlPersist process.
		expect(holderAcknowledged).toBe(true);
	}, 13_000);
}
