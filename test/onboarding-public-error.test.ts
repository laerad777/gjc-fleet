import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicOnboardingFailure } from "../src/onboarding";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("publicOnboardingFailure allows only the fixed code list", () => {
	expect(
		publicOnboardingFailure(
			new Error(
				"probe failed password=hunter2-secret https://deploy:S3cr3tPw@git.example/x",
			),
		),
	).toBe("onboarding_failed");
	expect(publicOnboardingFailure("not-an-error")).toBe("onboarding_failed");
	expect(publicOnboardingFailure(new Error("discovery_output_limit"))).toBe(
		"discovery_output_limit",
	);
	expect(publicOnboardingFailure(new Error("request_limit"))).toBe("request_limit");
	expect(publicOnboardingFailure(new Error("Usage: bun src/onboarding.ts …"))).toBe(
		"usage_onboarding",
	);
	// snake_case alone is not enough — must be on the allowlist
	expect(publicOnboardingFailure(new Error("node_config_required"))).toBe(
		"onboarding_failed",
	);
	expect(
		publicOnboardingFailure(
			new Error("ENOENT: no such file or directory, open '/tmp/password=hunter2-secret.json'"),
		),
	).toBe("onboarding_failed");
});

test("onboarding CLI stderr is a fixed code with no path or secret leaf", async () => {
	const root = join(import.meta.dir, "..");
	const base = await mkdtemp(join(tmpdir(), "onboard-cred-"));
	cleanups.push(() => rm(base, { recursive: true, force: true }));
	const missing = join(base, "password=hunter2-secret.json");
	const child = Bun.spawn(
		[process.execPath, join(root, "src", "onboarding.ts"), "validate", missing],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exit).toBe(1);
	expect(stdout).toBe("");
	expect(stderr.trimEnd().split("\n")).toHaveLength(1);
	expect(stderr.trim()).toBe("onboarding_failed");
	expect(stderr).not.toContain("hunter2");
	expect(stderr).not.toContain(base);
	expect(stderr).not.toContain("/");
});
