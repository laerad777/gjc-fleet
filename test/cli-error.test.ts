import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetError } from "../src/core";
import { publicCliError } from "../src/cli";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("public CLI errors accept exact codes, not arbitrary diagnostics or token-shaped secrets", () => {
	for (const error of [
		new Error("synthetic_private_token_123456"),
		new Error("authorization=synthetic-private-value /private/local/path"),
		new SyntaxError("synthetic-private-value\n\u001b[31m"),
		new Error("git_failed:rev-parse:synthetic-private-value"),
		{ message: "READ_ONLY" },
		null,
	]) expect(publicCliError(error)).toBe("operation_failed");
	for (const code of ["READ_ONLY", "usage_run_TASK_JSON_wait", "invalid_input_shape", "git_failed:exit=128"])
		expect(publicCliError(new Error(code))).toBe(code);
	expect(publicCliError(new FleetError("INVALID_INPUT", "synthetic-private-value"))).toBe("INVALID_INPUT");
	expect(publicCliError(new FleetError("synthetic_private_token_123456", "READ_ONLY"))).toBe("operation_failed");
	expect(publicCliError(new FleetError("node_refused:root_denied:allowlist", "synthetic-private-value"))).toBe("node_refused:root_denied:allowlist");
	expect(publicCliError(new FleetError("node_transport_failed", "synthetic-private-value"))).toBe("node_transport_failed");
	expect(publicCliError(new FleetError("BACKUP_EXISTS", "backup_destination_exists"))).toBe("BACKUP_EXISTS");
	// Bare / unregistered node_* strings must not leak through the public surface.
	expect(publicCliError(new Error("node_secret_local_path"))).toBe("operation_failed");
	expect(publicCliError(new FleetError("node_refused:not_a_pair:x", "synthetic-private-value"))).toBe("operation_failed");
	expect(publicCliError(new Error("node_has_tasks"))).toBe("node_has_tasks");
});

test("unknown file errors stay private on stderr and the operator's final stdout line", async () => {
	const root = await mkdtemp(join(tmpdir(), "fleet-cli-error-"));
	roots.push(root);
	const marker = "synthetic_private_token_123456";
	const missing = join(root, marker + ".json");
	for (const command of [["input", "preview", missing, join(root, "out.json")], ["run", missing]]) {
		const child = Bun.spawn([
			process.execPath, "run", fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
			"--db", join(root, "fleet.sqlite"), ...command,
		], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		expect(exit).toBe(1);
		expect(stdout + stderr).not.toContain(marker);
		expect(JSON.parse(stderr.trim())).toEqual({ ok: false, error: "operation_failed" });
		if (command[0] === "run")
			expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
				ok: false, error: "operation_failed", exit: 1, outcome: "error",
			});
		else expect(stdout).toBe("");
	}
});