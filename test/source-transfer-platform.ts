import { test } from "bun:test";

/**
 * Source transfer is darwin/linux only by design (`supported()` in src/source-transfer.ts): on win32
 * every entry point refuses with `source_transfer_platform_unsupported` before parsing or spawning.
 * Tests of POSIX behaviour are therefore an explicit, named skip on Windows instead of a failure;
 * the refusal itself is asserted by "platform gate ..." in source-transfer.test.ts.
 */
export const posixOnly = (name: string, fn: () => Promise<void> | void, timeout?: number) =>
	process.platform === "win32"
		? test.skip(`${name} (SKIPPED on win32: source transfer is POSIX-only by design)`, fn, timeout)
		: test(name, fn, timeout);
