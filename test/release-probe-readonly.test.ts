import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	classifyCodeLoadPath,
	classifySpawnFailure,
	isExactSha40,
	isSafeGitRefPath,
	parseGitHeadText,
	parseLsofFnNames,
	readTreeHeadFromGitDir,
	resolveProbeBinsTimed,
	runProbe,
	timedReadTextFile,
	timedSpawn,
	timedTestFlag,
	type ProbeBins,
	type SpawnFn,
} from "../scripts/release-probe-readonly";

const SHA = "e9bdb3b01d902895cb6359a7cd2867a9f5a6cfb1";

const FAKE_BINS: ProbeBins = {
	test: "/bin/test",
	head: "/usr/bin/head",
	launchctl: "/bin/launchctl",
	ps: "/bin/ps",
	lsof: "/usr/sbin/lsof",
};

function cmdName(command: string): string {
	return basename(command);
}

function okSpawn(stdout: string, status = 0): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, stdout, ""],
		stdout,
		stderr: "",
		status,
		signal: null,
		error: undefined,
	};
}

function timeoutSpawn(): SpawnSyncReturns<string> {
	const err = Object.assign(new Error("spawnSync ETIMEDOUT"), {
		code: "ETIMEDOUT",
		errno: "ETIMEDOUT",
		syscall: "spawnSync",
	});
	return {
		pid: 1,
		output: [null, "", ""],
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGTERM",
		error: err,
	};
}

/** Signal kill without ETIMEDOUT — must NOT be classified as timeout. */
function signalOnlySpawn(): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, "", ""],
		stdout: "",
		stderr: "",
		status: null,
		signal: "SIGTERM",
		error: undefined,
	};
}

function failSpawn(status = 1): SpawnSyncReturns<string> {
	return {
		pid: 1,
		output: [null, "", "err"],
		stdout: "",
		stderr: "err",
		status,
		signal: null,
		error: undefined,
	};
}

function treeFsSpawn(
	headResult: "timeout" | "read_failed" | "ok",
): SpawnFn {
	const label = "com.example.dashboard";
	const pidLine = `43944\t0\t${label}\n`;
	return (cmd, args) => {
		const name = cmdName(cmd);
		if (name === "launchctl") return okSpawn(pidLine);
		if (name === "ps") return okSpawn("Fri Nov 20 10:58:24 2026\n");
		if (name === "lsof" && args.includes("cwd")) {
			return okSpawn("p43944\nfcwd\nn/tmp/gjc-fleet with spaces\n");
		}
		if (name === "lsof") {
			return okSpawn(
				"p43944\nftxt\nn/usr/bin/bun\nfn1\nn/tmp/gjc-fleet with spaces/src/dashboard.ts\n",
			);
		}
		if (name === "test" && args[0] === "-e") return okSpawn("", 0);
		if (name === "test" && args[0] === "-f") {
			// join() uses `\` on Windows; compare on a normalized form.
			const p = (args[1] ?? "").replaceAll("\\", "/");
			if (p.endsWith("/.git")) return okSpawn("", 1);
			if (p.endsWith("/HEAD") || p.includes("/refs/")) return okSpawn("", 0);
			return okSpawn("", 1);
		}
		if (name === "head") {
			if (headResult === "timeout") return timeoutSpawn();
			if (headResult === "read_failed") return failSpawn(1);
			const p = (args[args.length - 1] ?? "").replaceAll("\\", "/");
			if (p.endsWith("/HEAD")) return okSpawn(`ref: refs/heads/main\n`);
			if (p.includes("/refs/heads/main")) return okSpawn(`${SHA}\n`);
			return failSpawn(1);
		}
		return failSpawn(1);
	};
}

describe("release-probe-readonly helpers", () => {
	test("isExactSha40 accepts only 40 lowercase hex", () => {
		expect(isExactSha40(SHA)).toBe(true);
		expect(isExactSha40("deadbeef")).toBe(false);
	});

	test("isSafeGitRefPath stays under refs/ and rejects traversal", () => {
		expect(isSafeGitRefPath("refs/heads/main")).toBe(true);
		expect(isSafeGitRefPath("refs/../etc/passwd")).toBe(false);
	});

	test("classifyCodeLoadPath allows spaces in directory segments", () => {
		expect(
			classifyCodeLoadPath(
				"/Volumes/Data/dev/gjc-fleet with spaces/src/dashboard.ts",
			),
		).toBe("/Volumes/Data/dev/gjc-fleet with spaces/src/dashboard.ts");
		expect(
			classifyCodeLoadPath("/srv/fleet/src/cli.ts"),
		).toBe("/srv/fleet/src/cli.ts");
		expect(
			classifyCodeLoadPath("/Volumes/Data/dev/gjc-fleet/logs/dashboard.log"),
		).toBeUndefined();
	});

	test("classifySpawnFailure: ETIMEDOUT only is timeout; bare SIGTERM is read_failed", () => {
		expect(classifySpawnFailure(timeoutSpawn())).toBe("timeout");
		expect(classifySpawnFailure(signalOnlySpawn())).toBe("read_failed");
		expect(
			classifySpawnFailure({
				error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
				signal: null,
				status: null,
			}),
		).toBe("read_failed");
	});

	test("timedSpawn / timedReadTextFile report timeout vs read_failed", () => {
		expect(timedSpawn(() => timeoutSpawn(), FAKE_BINS.launchctl, ["list"], 10)).toEqual({
			ok: false,
			reason: "timeout",
		});
		expect(
			timedSpawn(() => signalOnlySpawn(), FAKE_BINS.launchctl, ["list"], 10),
		).toEqual({ ok: false, reason: "read_failed" });
		expect(
			timedReadTextFile(() => failSpawn(1), FAKE_BINS.head, "/x", 10),
		).toEqual({ ok: false, reason: "read_failed" });
	});

	test("timedTestFlag: exit 0/1 are answers; exit 2 is read_failed", () => {
		expect(
			timedTestFlag(() => okSpawn("", 0), FAKE_BINS.test, "-f", "/x", 10),
		).toEqual({ ok: true, value: true });
		expect(
			timedTestFlag(() => okSpawn("", 1), FAKE_BINS.test, "-f", "/x", 10),
		).toEqual({ ok: true, value: false });
		expect(
			timedTestFlag(() => okSpawn("", 2), FAKE_BINS.test, "-f", "/x", 10),
		).toEqual({ ok: false, reason: "read_failed" });
	});

	test("parseLsofFnNames keeps spaces in paths", () => {
		expect(
			parseLsofFnNames("p43944\nfcwd\nn/tmp/tree with spaces\n"),
		).toEqual(["/tmp/tree with spaces"]);
		expect(
			parseLsofFnNames(
				"p1\nftxt\nn/usr/bin/bun\nfn3\nn/srv/fleet/src/cli.ts\n",
			),
		).toEqual(["/usr/bin/bun", "/srv/fleet/src/cli.ts"]);
	});

	test("parseGitHeadText propagates timeout/read_failed", () => {
		expect(
			parseGitHeadText("ref: refs/heads/main\n", () => ({ kind: "timeout" })),
		).toEqual({ kind: "timeout" });
		expect(
			parseGitHeadText("ref: refs/heads/main\n", () => ({
				kind: "read_failed",
			})),
		).toEqual({ kind: "read_failed" });
	});

	test("readTreeHeadFromGitDir does not follow a gitfile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "release-probe-"));
		const gitfile = join(dir, ".git");
		const gitfileBody = "gitdir: /elsewhere\n";
		await writeFile(gitfile, gitfileBody);
		const reads: string[] = [];
		const calls: { name: string; args: string[] }[] = [];
		let record = false;
		const samePath = (path: string) => path.replaceAll("\\", "/") === gitfile.replaceAll("\\", "/");
		const noteCall = (cmd: string, args: readonly string[], stdout: string) => {
			if (!record) return;
			calls.push({ name: cmdName(cmd), args: [...args] });
			if (cmdName(cmd) === "head" && args.some(samePath)) reads.push(gitfile);
			if (stdout.includes("gitdir:") || stdout.includes("/elsewhere")) reads.push(gitfile);
		};
		const expectOnlyStatFlags = () => {
			expect(calls).toEqual([
				{ name: "test", args: ["-e", gitfile] },
				{ name: "test", args: ["-f", gitfile] },
			]);
			expect(reads).toEqual([]);
		};

		if (process.platform === "win32") {
			// Do not probe /bin/test or /usr/bin/head. Those paths are not the Windows check.
			record = true;
			const spawn: SpawnFn = (cmd, args) => {
				const name = cmdName(cmd);
				if (name === "test") {
					const flag = args[0];
					const path = args[1] ?? "";
					noteCall(cmd, args, "");
					if (flag === "-e") return okSpawn("", existsSync(path) ? 0 : 1);
					if (flag === "-f") {
						try {
							return okSpawn("", statSync(path).isFile() ? 0 : 1);
						} catch {
							return okSpawn("", 1);
						}
					}
					return failSpawn(2);
				}
				if (name === "head") {
					const path = args[args.length - 1] ?? "";
					noteCall(cmd, args, samePath(path) ? gitfileBody : "");
					return failSpawn(1);
				}
				noteCall(cmd, args, "");
				return failSpawn(1);
			};
			expect(
				readTreeHeadFromGitDir(gitfile, {
					spawn,
					bins: FAKE_BINS,
					fileTimeoutMs: 3_000,
				}),
			).toEqual({ kind: "unreadable" });
			expectOnlyStatFlags();
			return;
		}

		const realSpawn: SpawnFn = (cmd, args, opts) => {
			const result = spawnSync(cmd, args, opts);
			const stdout = typeof result.stdout === "string" ? result.stdout : "";
			noteCall(cmd, args, stdout);
			return result;
		};
		const binsRes = resolveProbeBinsTimed(realSpawn, 3_000);
		const bins = binsRes.ok
			? binsRes.value
			: existsSync("/bin/test") && existsSync("/usr/bin/head")
				? { ...FAKE_BINS, test: "/bin/test", head: "/usr/bin/head" }
				: undefined;
		if (!bins) {
			throw new Error("Unix gitfile check requires /bin/test and /usr/bin/head; refusing a silent mock");
		}
		record = true;
		expect(
			readTreeHeadFromGitDir(gitfile, {
				spawn: realSpawn,
				bins,
				fileTimeoutMs: 3_000,
			}),
		).toEqual({ kind: "unreadable" });
		expectOnlyStatFlags();
	});
});

describe("release-probe-readonly CLI regression (injectable spawn)", () => {
	test("[1] bare SIGTERM abort is read_failed, not timeout", () => {
		const { lines, exit } = runProbe(
			{ label: "com.example.dashboard" },
			{
				spawn: () => signalOnlySpawn(),
				bins: FAKE_BINS,
				fileTimeoutMs: 50,
				cmdTimeoutMs: 50,
			},
		);
		expect(exit).toBe(3);
		expect(lines).toContain("ABORT=read_failed");
		expect(lines).not.toContain("ABORT=timeout");
	});

	test("[1] ETIMEDOUT abort is timeout", () => {
		const { lines } = runProbe(
			{ label: "com.example.dashboard" },
			{
				spawn: () => timeoutSpawn(),
				bins: FAKE_BINS,
				fileTimeoutMs: 50,
				cmdTimeoutMs: 50,
			},
		);
		expect(lines).toContain("ABORT=timeout");
	});

	test("[2] ps/lsof non-zero exit is read_failed, not unknown", () => {
		const label = "com.example.dashboard";
		const spawn: SpawnFn = (cmd, args) => {
			const name = cmdName(cmd);
			if (name === "launchctl") return okSpawn(`43944\t0\t${label}\n`);
			if (name === "ps") return failSpawn(1);
			if (name === "lsof") return failSpawn(2);
			return failSpawn(1);
		};
		const { lines } = runProbe(
			{ label },
			{ spawn, bins: FAKE_BINS, fileTimeoutMs: 50, cmdTimeoutMs: 50 },
		);
		expect(lines).toContain("START=read_failed");
		expect(lines).toContain("CWD=read_failed");
		expect(lines).toContain("LOAD_PATH=read_failed");
		expect(lines).not.toContain("START=unknown");
		expect(lines).not.toContain("CWD=unknown");
	});

	test("[2] test exit 2 during TREE_HEAD is read_failed", () => {
		const label = "com.example.dashboard";
		const spawn: SpawnFn = (cmd, args) => {
			const name = cmdName(cmd);
			if (name === "launchctl") return okSpawn(`43944\t0\t${label}\n`);
			if (name === "ps") return okSpawn("Fri Nov 20 10:58:24 2026\n");
			if (name === "lsof") return okSpawn("p43944\nfcwd\nn/tmp/tree\n");
			if (name === "test") return okSpawn("", 2);
			return failSpawn(1);
		};
		const { lines } = runProbe(
			{ label, tree: "/tmp/tree" },
			{ spawn, bins: FAKE_BINS, fileTimeoutMs: 50, cmdTimeoutMs: 50 },
		);
		expect(lines).toContain("TREE_HEAD=read_failed");
	});

	test("[3] CWD and LOAD_PATH preserve spaces via lsof -Fn", () => {
		const { lines } = runProbe(
			{ label: "com.example.dashboard", tree: "/tmp/gjc-fleet with spaces" },
			{
				spawn: treeFsSpawn("ok"),
				bins: FAKE_BINS,
				fileTimeoutMs: 50,
				cmdTimeoutMs: 50,
			},
		);
		expect(lines).toContain("CWD=/tmp/gjc-fleet with spaces");
		expect(lines).toContain(
			"LOAD_PATH=/tmp/gjc-fleet with spaces/src/dashboard.ts",
		);
		expect(lines).toContain(`TREE_HEAD=${SHA}`);
	});

	test("[4] resolveProbeBinsTimed uses timed candidates, not Bun.which", () => {
		const seen: string[] = [];
		const spawn: SpawnFn = (cmd, args) => {
			seen.push(`${cmd} ${args.join(" ")}`);
			// First candidate for test: /bin/test -x /bin/test → ok
			if (cmd === "/bin/test" && args[0] === "-x") return okSpawn("", 0);
			if (args[0] === "-x") return okSpawn("", 0);
			return failSpawn(1);
		};
		const r = resolveProbeBinsTimed(spawn, 50);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toEqual({
				test: "/bin/test",
				head: "/usr/bin/head",
				launchctl: "/bin/launchctl",
				ps: "/bin/ps",
				lsof: "/usr/sbin/lsof",
			});
		}
		expect(seen.some((s) => s.includes("which"))).toBe(false);
		expect(seen[0]?.startsWith("/bin/test")).toBe(true);
	});

	test("[4] resolveProbeBinsTimed propagates deadline timeout", () => {
		const r = resolveProbeBinsTimed(() => timeoutSpawn(), 50);
		expect(r).toEqual({ ok: false, reason: "timeout" });
	});

	test("[4] resolveProbeBinsTimed propagates read_failed when test -x exits ≥2", () => {
		const r = resolveProbeBinsTimed(() => failSpawn(2), 50);
		expect(r).toEqual({ ok: false, reason: "read_failed" });
	});

	test("[4] TREE_HEAD end-to-end is timeout when HEAD read hits ETIMEDOUT", () => {
		const { lines, exit } = runProbe(
			{ label: "com.example.dashboard", tree: "/tmp/gjc-fleet with spaces" },
			{
				spawn: treeFsSpawn("timeout"),
				bins: FAKE_BINS,
				fileTimeoutMs: 50,
				cmdTimeoutMs: 50,
			},
		);
		expect(exit).toBe(0);
		expect(lines).toContain("TREE_HEAD=timeout");
		expect(lines).not.toContain("TREE_HEAD=read_failed");
		expect(lines).not.toContain(`TREE_HEAD=${SHA}`);
	});

	test("[4] TREE_HEAD end-to-end is read_failed when HEAD read fails without timeout", () => {
		const { lines, exit } = runProbe(
			{ label: "com.example.dashboard", tree: "/tmp/gjc-fleet with spaces" },
			{
				spawn: treeFsSpawn("read_failed"),
				bins: FAKE_BINS,
				fileTimeoutMs: 50,
				cmdTimeoutMs: 50,
			},
		);
		expect(exit).toBe(0);
		expect(lines).toContain("TREE_HEAD=read_failed");
		expect(lines).not.toContain("TREE_HEAD=timeout");
		expect(lines).not.toContain(`TREE_HEAD=${SHA}`);
	});
});
