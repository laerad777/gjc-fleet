import { chmodSync, linkSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Real planted programs for hijack tests: each run appends "<program> <args> | <cwd>" to `mark`. */
export interface Planter {
	mark: string;
	kinds: string[];
	plant(dir: string, name: string, kind: string): string;
	ran(): string[];
	reset(): void;
}

export function planter(root: string): Planter {
	const win = process.platform === "win32";
	const mark = join(root, "PLANTED-RAN.txt");
	let exe: string | undefined;
	if (win) {
		const source = join(root, "planted-marker.ts");
		writeFileSync(
			source,
			`require("node:fs").appendFileSync(${JSON.stringify(mark)}, [process.execPath, ...process.argv.slice(2)].join(" ") + " | " + process.cwd() + "\\n");\nprocess.exit(3);\n`,
		);
		exe = join(root, "planted-marker.exe");
		const built = Bun.spawnSync(
			[process.execPath, "build", "--compile", source, "--outfile", exe],
			{ cwd: root, stdout: "pipe", stderr: "pipe" },
		);
		if (built.exitCode !== 0 || !existsSync(exe))
			throw new Error("planted marker build failed: " + built.stderr.toString());
	}
	return {
		mark,
		kinds: win ? [".exe", ".cmd", ".bat"] : [""],
		plant(dir, name, kind) {
			const file = join(dir, name + kind);
			if (kind === ".exe") {
				try {
					linkSync(exe!, file);
				} catch {
					copyFileSync(exe!, file);
				}
			} else if (kind === ".cmd" || kind === ".bat") {
				writeFileSync(file, `@echo %~f0 %* ^| %CD%>>"${mark}"\r\n@exit /b 3\r\n`);
			} else {
				writeFileSync(file, `#!/bin/sh\necho "$0 $* | $(pwd)" >> '${mark}'\nexit 3\n`);
				chmodSync(file, 0o755);
			}
			return file;
		},
		ran() {
			return existsSync(mark) ? readFileSync(mark, "utf8").split(/\r?\n/).filter(Boolean) : [];
		},
		reset() {
			rmSync(mark, { force: true });
		},
	};
}
