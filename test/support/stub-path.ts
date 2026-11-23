import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * For tests that replace Bun.spawn: programs now resolve to an absolute path from
 * PATH before Bun.spawn is called, so the named programs must exist on PATH.
 * Puts never-executed stub files for `names` first on PATH; `program(name)` is
 * the absolute path the mocked Bun.spawn will receive.
 */
export function stubPrograms(names: string[]) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-stub-path-")));
	const win = process.platform === "win32";
	const program = (name: string) => join(dir, win ? name + ".cmd" : name);
	for (const name of names) {
		writeFileSync(program(name), win ? "@exit /b 99\r\n" : "#!/bin/sh\nexit 99\n");
		if (!win) chmodSync(program(name), 0o755);
	}
	const saved = process.env.PATH;
	process.env.PATH = dir + (win ? ";" : ":") + (saved ?? "");
	return {
		program,
		restore() {
			process.env.PATH = saved;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
