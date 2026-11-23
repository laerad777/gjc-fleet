import { mkdir, readdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { digest } from "../src/core";
import { run, sha256 } from "../src/workspace";
import { hashTopLevelFiles } from "./verify-hash-files";
import {
	buildFailedVerificationManifest,
	probeVerificationGit,
	verificationStopSummary,
} from "./verification-git-prerequisite";

const root = process.cwd();
// Host shells sometimes export GJC_SDK_BROKER_AUTOSTART=0 for list/archive probes.
// That inheritance breaks real `gjc sdk session.create` under bun test (throwaway
// --agent-dir brokers must autostart). Clear it for the whole verify process;
// individual list/archive spawns still force "0" on their own env.
delete process.env.GJC_SDK_BROKER_AUTOSTART;
const directory = join(
	root,
	".local",
	"evidence",
	"verification",
	randomUUID(),
);
await mkdir(directory, { recursive: true, mode: 0o700 });

/** Announce the packaging Git floor before any suite command. Reuses assessGitVersion via probeVerificationGit; does not lower MIN_GIT or skip tests. Probe failures (missing, timeout, overflow, nonzero exit) are classified before version text and always leave the same failed manifest. */
const prerequisite = await probeVerificationGit({ cwd: root });
await writeFile(
	join(directory, "00.git-version.json"),
	JSON.stringify(prerequisite, null, 2) + "\n",
	{ mode: 0o600 },
);
console.log(JSON.stringify(prerequisite));
if (prerequisite.status !== "ok") {
	const manifest = buildFailedVerificationManifest(prerequisite);
	const text = JSON.stringify(manifest, null, 2);
	await writeFile(join(directory, "manifest.json"), text, { mode: 0o600 });
	console.log(
		JSON.stringify(
			verificationStopSummary(
				relative(root, join(directory, "manifest.json")),
				text,
				manifest,
			),
		),
	);
	process.exitCode = 1;
	process.exit(1);
}

const commands = [
	["bunx", "tsc", "--noEmit"],
	["bunx", "tsc", "--noEmit", "-p", "tsconfig.test.json"],
	["bun", "test", "test"],
	["bun", "run", "build"],
	["bun", "src/cli.ts", "--help"],
	["bun", "scripts/license-check.ts"],
];
const records: any[] = [];
for (const [index, argv] of commands.entries()) {
	const startedAt = new Date().toISOString();
	const result = await run(argv, root, 8 * 1024 * 1024);
	const prefix = String(index + 1).padStart(2, "0");
	await writeFile(join(directory, prefix + ".stdout"), result.stdout, {
		mode: 0o600,
	});
	await writeFile(join(directory, prefix + ".stderr"), result.stderr, {
		mode: 0o600,
	});
	records.push({
		argv,
		exit: result.exit,
		startedAt,
		endedAt: new Date().toISOString(),
		stdoutPath: prefix + ".stdout",
		stderrPath: prefix + ".stderr",
		stdoutDigest: sha256(result.stdout),
		stderrDigest: sha256(result.stderr),
	});
	console.log(
		JSON.stringify({
			argv,
			exit: result.exit,
			stdoutDigest: sha256(result.stdout),
			stderrDigest: sha256(result.stderr),
		}),
	);
	process.stdout.write(result.stdout);
	process.stderr.write(result.stderr);
}
const files: Record<string, string> = {};
async function scan(path: string) {
	for (const entry of (await readdir(path, { withFileTypes: true })).sort(
		(a, b) => a.name.localeCompare(b.name),
	)) {
		const full = join(path, entry.name);
		if (entry.isDirectory()) await scan(full);
		else if (entry.isFile())
			files[relative(root, full)] = sha256(await Bun.file(full).bytes());
	}
}
for (const dir of ["src", "test", "scripts"]) await scan(join(root, dir));
const topLevel = await hashTopLevelFiles(root);
Object.assign(files, topLevel.files);
const manifest = {
	schemaVersion: 1,
	kind: "local-independent-module-verification",
	runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
	prerequisite,
	commands: records,
	sourceFiles: files,
	skippedSourceFiles: topLevel.skipped,
	sourceDigest: digest(files),
	liveExecutionClaim: false,
	passed: records.every((r) => r.exit === 0),
};
const text = JSON.stringify(manifest, null, 2);
await writeFile(join(directory, "manifest.json"), text, { mode: 0o600 });
console.log(
	JSON.stringify({
		manifest: relative(root, join(directory, "manifest.json")),
		sha256: sha256(text),
		sourceDigest: manifest.sourceDigest,
		passed: manifest.passed,
	}),
);
process.exitCode = manifest.passed ? 0 : 1;
