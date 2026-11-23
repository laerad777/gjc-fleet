import { expect, test } from "bun:test";

// openat is variadic in C; on macOS arm64 a fixed four-argument FFI binding loses `mode`. Run on a Mac this proves the
// creation-time mode; on Linux it checks the unchanged four-argument path. The umask-changing body runs in a child
// process so the test runner's own umask is never touched.
test("openatCreate creates files with exactly the requested mode (child process, umask 0)", () => {
	if (process.platform !== "linux" && process.platform !== "darwin") return;
	const child = Bun.spawnSync([process.execPath, new URL("./fixtures/openat-create-child.ts", import.meta.url).pathname], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(child.stderr.toString()).toBe("");
	expect(child.stdout.toString().trim()).toBe("OK");
	expect(child.exitCode).toBe(0);
});
