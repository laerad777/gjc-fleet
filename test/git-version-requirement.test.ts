import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
	assessGitVersion,
	MIN_GIT_VERSION,
	MIN_GIT_VERSION_REASON,
	parseGitVersion,
} from "../scripts/candidate-package";
import {
	buildFailedVerificationManifest,
	probeVerificationGit,
} from "../scripts/verification-git-prerequisite";

const win = process.platform === "win32";

function stub(script: string): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-git-req-"));
	const path = join(dir, win ? "git.cmd" : "git");
	if (win) {
		writeFileSync(path, `@echo off\r\n${script}\r\n`);
	} else {
		writeFileSync(path, `#!/bin/sh\n${script}\n`);
		chmodSync(path, 0o755);
	}
	return path;
}

describe("Git version requirement announcement (shared with verify)", () => {
	test("exports the same floor packageCandidate already enforces", () => {
		expect(MIN_GIT_VERSION).toBe("2.44.0");
		expect(MIN_GIT_VERSION_REASON).toBe("GIT_NO_LAZY_FETCH");
	});

	test("assessGitVersion puts the requirement before the detected result", () => {
		const tooOld = assessGitVersion("git version 2.43.0\n");
		expect(tooOld.status).toBe("too_old");
		expect(tooOld.rule).toBe("git-too-old");
		expect(tooOld.required).toBe(MIN_GIT_VERSION);
		expect(tooOld.reason).toBe(MIN_GIT_VERSION_REASON);
		expect(tooOld.parsed).toEqual([2, 43, 0]);
		expect(tooOld.message.startsWith(`Git ${MIN_GIT_VERSION} or newer is required`)).toBe(true);
		expect(tooOld.message).toContain(MIN_GIT_VERSION_REASON);
		expect(tooOld.message).toContain("git version 2.43.0");
		expect(tooOld.message.indexOf(MIN_GIT_VERSION)).toBeLessThan(tooOld.message.indexOf("2.43.0"));

		const ok = assessGitVersion("git version 2.44.0\n");
		expect(ok.status).toBe("ok");
		expect(ok.rule).toBeNull();
		expect(ok.message).toContain("(ok)");
		expect(ok.message.indexOf(MIN_GIT_VERSION)).toBeLessThan(ok.message.indexOf("(ok)"));

		const unknown = assessGitVersion("not git\n");
		expect(unknown.status).toBe("unknown");
		expect(unknown.rule).toBe("git-version-unknown");
		expect(unknown.parsed).toBeNull();
		expect(unknown.message.startsWith(`Git ${MIN_GIT_VERSION} or newer is required`)).toBe(true);
	});

	test("assessGitVersion agrees with parseGitVersion on accepted and refused samples", () => {
		for (const text of ["git version 2.44.0\n", "git version 2.45.1\n", "git version 3.0.0\n"]) {
			expect(parseGitVersion(text)).not.toBeNull();
			expect(assessGitVersion(text).status).toBe("ok");
		}
		for (const text of ["git version 2.43.0\n", "git version 2.43.0.windows.1\n", "git version 1.99.99\n"]) {
			expect(assessGitVersion(text).status).toBe("too_old");
		}
		for (const text of ["", "git version", "git version 2.44", "hub version 2.44.0"]) {
			expect(assessGitVersion(text).status).toBe("unknown");
		}
	});
});

describe("verify Git probe failure classification (same failed manifest)", () => {
	test("missing executable leaves a failed prerequisite suitable for the stop manifest", async () => {
		const prerequisite = await probeVerificationGit({
			argv: [join(tmpdir(), "fleet-no-such-git-" + Date.now()), "--version"],
		});
		expect(prerequisite.status).toBe("failed");
		expect(prerequisite.probeError).toBe("missing");
		expect(prerequisite.rule).toBe("git-probe-failed");
		expect(prerequisite.exit).toBeNull();
		expect(prerequisite.message).toContain(MIN_GIT_VERSION);
		const manifest = buildFailedVerificationManifest(prerequisite);
		expect(manifest.passed).toBe(false);
		expect(manifest.prerequisite).toEqual(prerequisite);
		expect(manifest.commands).toEqual([]);
	});

	test("nonzero exit with a modern version on stderr is failed, never ok", async () => {
		if (win) return;
		const git = stub('printf "git version 2.44.0\\n" >&2\nexit 1');
		const prerequisite = await probeVerificationGit({ argv: [git, "--version"], timeoutMs: 5_000 });
		expect(prerequisite.status).toBe("failed");
		expect(prerequisite.probeError).toBe("nonzero_exit");
		expect(prerequisite.rule).toBe("git-probe-failed");
		expect(prerequisite.exit).toBe(1);
		expect(prerequisite.detectedText).toContain("git version 2.44.0");
		expect(buildFailedVerificationManifest(prerequisite).passed).toBe(false);
	});

	test("timeout is classified before any suite command and keeps the stop manifest shape", async () => {
		if (win) return;
		// Replace the shell so SIGKILL ends the probe process itself.
		const git = stub("exec sleep 30");
		const started = Date.now();
		const prerequisite = await probeVerificationGit({ argv: [git, "--version"], timeoutMs: 200 });
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(prerequisite.status).toBe("failed");
		expect(prerequisite.probeError).toBe("timeout");
		expect(prerequisite.rule).toBe("git-probe-timeout");
		expect(prerequisite.message).toContain("timed out");
		expect(buildFailedVerificationManifest(prerequisite).prerequisite.probeError).toBe("timeout");
	}, 10_000);

	test("output overflow is classified as failure with the same stop manifest", async () => {
		if (win) return;
		// Finite burst larger than maxBytes: overflow must win before exit/timeout, and the child must be killed.
		const git = stub('dd if=/dev/zero bs=1024 count=64 2>/dev/null');
		const started = Date.now();
		const prerequisite = await probeVerificationGit({
			argv: [git, "--version"],
			timeoutMs: 5_000,
			maxBytes: 256,
		});
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(prerequisite.status).toBe("failed");
		expect(prerequisite.probeError).toBe("output_limit");
		expect(prerequisite.rule).toBe("git-probe-output-limit");
		expect(prerequisite.exit).toBeNull();
		expect(buildFailedVerificationManifest(prerequisite).passed).toBe(false);
	}, 10_000);

	test("exit 0 with git 2.43.0 is too_old (not a probeError)", async () => {
		if (win) return;
		const git = stub('printf "git version 2.43.0\\n"\nexit 0');
		const prerequisite = await probeVerificationGit({ argv: [git, "--version"], timeoutMs: 5_000 });
		expect(prerequisite.status).toBe("too_old");
		expect(prerequisite.probeError).toBeNull();
		expect(prerequisite.rule).toBe("git-too-old");
		expect(prerequisite.exit).toBe(0);
		expect(buildFailedVerificationManifest(prerequisite).passed).toBe(false);
	});

	test("deadline still applies when the probed process exits but a grandchild holds stdout open", async () => {
		if (win) return;
		// Parent prints a modern version and exits 0 while a double-forked sleeper keeps the pipe open.
		const git = stub(
			'printf "git version 2.44.0\\n"\n' +
				"perl -e 'exit if fork; exit if fork; sleep 5' &\n" +
				"exit 0",
		);
		const started = Date.now();
		const prerequisite = await probeVerificationGit({ argv: [git, "--version"], timeoutMs: 100 });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(prerequisite.status).toBe("failed");
		expect(prerequisite.probeError).toBe("timeout");
		expect(prerequisite.rule).toBe("git-probe-timeout");
		expect(prerequisite.status).not.toBe("ok");
		expect(buildFailedVerificationManifest(prerequisite).passed).toBe(false);
	}, 10_000);
});
