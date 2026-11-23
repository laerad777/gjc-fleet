import { afterAll } from "bun:test";
import childProcess from "node:child_process";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Suite-wide behavioural guard (bunfig.toml preload), active for every test file:
 * every process start is observed; a start triggered from production code
 * (`src/` or `scripts/` on the stack) with a non-absolute program is recorded.
 * That covers bare names spawned with an explicit worker-controlled cwd.
 *
 * Inherited process-cwd planting is checked in a dedicated child process in
 * `planted-program.test.ts` (same approach as its inherited-sites harness). This
 * preload must not `chdir` the parent suite: relative fixture paths such as
 * `resolve("src/node.ts")` would otherwise break under a remapped cwd.
 */
const repoRoot = resolve(import.meta.dir, "..", "..");
const production = [join(repoRoot, "src") + sep, join(repoRoot, "scripts") + sep].map((p) => p.toLowerCase());

const violations: string[] = [];
function observe(api: string, program: unknown) {
	if (typeof program === "string" && isAbsolute(program) && (process.platform !== "win32" || /^[A-Za-z]:[\\/]/.test(program))) return;
	const stack = (new Error().stack ?? "").toLowerCase();
	if (production.some((p) => stack.includes(p)))
		violations.push(`${api}(${JSON.stringify(program)}) from production code:\n${new Error().stack}`);
}
const bun = Bun as any;
for (const api of ["spawn", "spawnSync"]) {
	const original = bun[api].bind(Bun);
	bun[api] = (cmd: any, options?: any) => {
		observe("Bun." + api, Array.isArray(cmd) ? cmd[0] : cmd?.cmd?.[0]);
		return original(cmd, options);
	};
}
const cp = childProcess as any;
for (const api of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
	const original = cp[api];
	cp[api] = function (this: unknown, command: unknown, ...rest: unknown[]) {
		observe("child_process." + api, api.startsWith("exec") && !api.startsWith("execFile") ? "<shell>" : command);
		return original.call(this, command, ...rest);
	};
}

afterAll(() => {
	if (violations.length)
		throw new Error(
			"spawn guard: production code started a program by bare/relative name\n" + violations.join("\n"),
		);
});
