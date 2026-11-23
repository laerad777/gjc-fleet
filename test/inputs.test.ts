import { afterEach, describe, expect, test } from "bun:test";
import {
	chmod,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/core";
import {
	applyInput,
	authorizeInput,
	importRepository,
	previewInput,
	validateInputPackage,
	type InputPackage,
} from "../src/inputs";
import { prepareWorkspace, run, sha256 } from "../src/workspace";

const roots: string[] = [];
afterEach(async () => {
	for (const path of roots.splice(0))
		await rm(path, { recursive: true, force: true });
});
async function git(repo: string, ...args: string[]): Promise<string> {
	const result = await run(
		[
			"git",
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"user.name=Input Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-C",
			repo,
			...args,
		],
		repo,
	);
	if (result.exit !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
async function fixture(format: "sha1" | "sha256" = "sha1") {
	const dir = await realpath(
		await mkdtemp(join(tmpdir(), "fleet-input-owned-")),
	);
	roots.push(dir);
	const repo = join(dir, "source");
	await mkdir(repo);
	await git(
		repo,
		"init",
		"--quiet",
		"--template=",
		"--object-format=" + format,
	);
	await writeFile(join(repo, "old-history.txt"), "unrelated historic object\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-qm", "task-owned parent fixture");
	const parent = await git(repo, "rev-parse", "HEAD");
	const oldBlob = await git(repo, "rev-parse", "HEAD:old-history.txt");
	await unlink(join(repo, "old-history.txt"));
	await writeFile(join(repo, "tracked.bin"), Buffer.from([0, 1, 255, 0, 128]));
	await writeFile(join(repo, "delete.txt"), "base deletion\n");
	await writeFile(join(repo, "unrelated.txt"), "base unrelated\n");
	await writeFile(join(repo, "executable"), "#!/bin/sh\nexit 0\n");
	await chmod(join(repo, "executable"), 0o755);
	await git(repo, "add", "-A");
	// Windows chmod cannot represent Git's executable bit; stage it explicitly.
	if (process.platform === "win32")
		await git(repo, "update-index", "--chmod=+x", "--", "executable");
	await git(repo, "commit", "-qm", "task-owned exact base fixture");
	const base = await git(repo, "rev-parse", "HEAD");
	const preview = (
		paths: string[],
		includeObjects = false,
		maxBytes?: number,
	) =>
		previewInput({
			repo,
			repoId: "fixture-repo",
			baseCommit: base,
			paths,
			includeObjects,
			maxBytes,
		});
	return { dir, repo, base, parent, oldBlob, preview };
}
function resign(pkg: InputPackage): InputPackage {
	const { digest: _digest, authorization: _authorization, ...payload } = pkg;
	return { ...payload, digest: sha256(canonicalJson(payload)) };
}
async function owned(
	f: Awaited<ReturnType<typeof fixture>>,
	pkg: InputPackage,
	attemptId = "attempt",
) {
	const input = {
		taskId: "task",
		attemptId,
		nodeId: "node",
		inputDigest: sha256("whole-task-input"),
		inputPackageDigest: pkg.digest,
		repo: f.repo,
		baseCommit: f.base,
		workspaceRoot: join(f.dir, "workspaces"),
	};
	return prepareWorkspace(input);
}

describe("bounded explicit input snapshots using task-owned Git fixtures", () => {
	test.skipIf(process.platform === "win32")("git() SIGKILLs a SIGTERM-trapping git on cat-file output limit", async () => {
		const f = await fixture();
		const pidFile = join(f.dir, "inputs-git-pid");
		const bin = join(f.dir, "shim-bin");
		await mkdir(bin);
		const real = Bun.which("git")!;
		await writeFile(
			join(bin, "git"),
			[
				"#!/bin/sh",
				`case " $* " in`,
				`*" cat-file "*)`,
				`  trap '' TERM`,
				`  echo $$ >${JSON.stringify(pidFile)}`,
				`  dd if=/dev/zero bs=1 count=200`,
				`  while true; do sleep 1; done`,
				`  ;;`,
				`esac`,
				`exec '${real}' "$@"`,
				"",
			].join("\n"),
		);
		await chmod(join(bin, "git"), 0o700);
		const saved = process.env.PATH;
		process.env.PATH = bin + ":" + saved;
		try {
			const error = await f
				.preview(["tracked.bin"], true)
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("git_output_limit");
			const pid = (await readFile(pidFile, "utf8")).trim();
			expect(pid).toMatch(/^\d+$/);
			const goneUntil = Date.now() + 500;
			let gone = false;
			while (Date.now() < goneUntil) {
				try {
					process.kill(Number(pid), 0);
				} catch {
					gone = true;
					break;
				}
				await Bun.sleep(10);
			}
			expect(gone).toBe(true);
		} finally {
			process.env.PATH = saved;
		}
	});
	test("failed Git input preview never includes stderr or a private config path", async () => {
		const f = await fixture();
		const marker = "synthetic_private_token_123456";
		const privateConfig = join(f.dir, marker + ".config");
		await writeFile(privateConfig, "[unterminated\n");
		await writeFile(join(f.repo, ".git", "config"), `[include]\n\tpath = ${JSON.stringify(privateConfig.replaceAll("\\", "/"))}\n`);
		const diagnostic = await run(["git", "-C", f.repo, "rev-parse", "--show-toplevel"], f.repo);
		expect(diagnostic.exit).toBe(128);
		expect(diagnostic.stderr).toContain(marker);
		try {
			await f.preview([]);
			throw new Error("expected_git_failure");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toBe("git_failed:exit=128");
			expect((error as Error).message).not.toContain(marker);
		}
	});
	test("shared Git blobs cannot expand a small package beyond the materialized byte limit", async () => {
		const f = await fixture();
		const bytes = Buffer.alloc(9 * 1024 * 1024, 97);
		await writeFile(join(f.repo, "large-a.bin"), bytes);
		await writeFile(join(f.repo, "large-b.bin"), bytes);
		await git(f.repo, "add", "large-a.bin", "large-b.bin");
		await git(f.repo, "commit", "-qm", "task-owned shared blob fixture");
		const baseCommit = await git(f.repo, "rev-parse", "HEAD");
		await expect(
			previewInput({
				repo: f.repo,
				repoId: "fixture-repo",
				baseCommit,
				paths: [],
				includeObjects: true,
			}),
		).rejects.toThrow("input_materialization_byte_limit");
	});
	test("selected binary, untracked, deletion and mode snapshots roundtrip without touching dirty sentinels", async () => {
		const f = await fixture();
		const binary = Buffer.from([0, 255, 17, 0, 254]);
		await writeFile(join(f.repo, "tracked.bin"), binary);
		await writeFile(join(f.repo, "new.bin"), Buffer.from([255, 0, 13]));
		await unlink(join(f.repo, "delete.txt"));
		await chmod(join(f.repo, "executable"), 0o644);
		if (process.platform === "win32")
			await git(f.repo, "update-index", "--chmod=-x", "--", "executable");
		await writeFile(join(f.repo, "unrelated.txt"), "DIRTY SOURCE SENTINEL\n");
		await writeFile(
			join(f.repo, "unselected.txt"),
			"UNTRACKED SOURCE SENTINEL\n",
		);
		const before = await git(f.repo, "status", "--porcelain=v1");
		const pkg = await f.preview([
			"tracked.bin",
			"new.bin",
			"delete.txt",
			"executable",
		]);
		expect(pkg.authorization).toBeUndefined();
		expect(pkg.objects).toBeUndefined();
		expect(pkg.changes).toHaveLength(4);
		const modeChange = pkg.changes.find((c) => c.path === "executable")!;
		expect(modeChange.before?.mode).toBe(100755);
		expect(modeChange.after?.mode).toBe(100644);
		expect(
			pkg.changes.find((c) => c.path === "tracked.bin")?.before?.sha256,
		).toBe(sha256(Buffer.from([0, 1, 255, 0, 128])));
		const identity = await owned(f, pkg);
		await writeFile(
			join(identity.path, "unrelated.txt"),
			"DIRTY TASK SENTINEL\n",
		);
		await writeFile(
			join(identity.path, "unselected.txt"),
			"UNTRACKED TASK SENTINEL\n",
		);
		await applyInput(
			identity,
			authorizeInput(pkg, pkg.digest, "operator:fixture"),
		);
		if (process.platform !== "win32") {
			const final = (await lstat(join(identity.path, "new.bin"))).mode & 0o777;
			expect(final).toBe(0o644);
		}
		expect(await readFile(join(identity.path, "tracked.bin"))).toEqual(binary);
		expect(await readFile(join(identity.path, "new.bin"))).toEqual(
			Buffer.from([255, 0, 13]),
		);
		await expect(lstat(join(identity.path, "delete.txt"))).rejects.toThrow();
		if (process.platform === "win32")
			expect(
				await git(identity.path, "ls-files", "--stage", "--", "executable"),
			).toMatch(/^100644 [a-f0-9]+ 0\texecutable$/);
		else
			expect(
				(await lstat(join(identity.path, "executable"))).mode & 0o111,
			).toBe(0);
		expect(await readFile(join(identity.path, "unrelated.txt"), "utf8")).toBe(
			"DIRTY TASK SENTINEL\n",
		);
		expect(await readFile(join(identity.path, "unselected.txt"), "utf8")).toBe(
			"UNTRACKED TASK SENTINEL\n",
		);
		expect(await git(f.repo, "status", "--porcelain=v1")).toBe(before);
		expect(await readFile(join(f.repo, "unrelated.txt"), "utf8")).toBe(
			"DIRTY SOURCE SENTINEL\n",
		);
		expect(await readFile(join(f.repo, "unselected.txt"), "utf8")).toBe(
			"UNTRACKED SOURCE SENTINEL\n",
		);
	});

	test("authorization is explicit, copied and cryptographically bound; forged before bytes reject", async () => {
		const f = await fixture();
		await writeFile(join(f.repo, "tracked.bin"), "changed");
		const pkg = await f.preview(["tracked.bin"]),
			identity = await owned(f, pkg);
		await expect(applyInput(identity, pkg)).rejects.toThrow();
		expect(() => authorizeInput(pkg, "0".repeat(64), "operator")).toThrow();
		expect(() => authorizeInput(pkg, pkg.digest, " \n")).toThrow();
		const approved = authorizeInput(pkg, pkg.digest, "operator");
		pkg.changes[0]!.after!.contentBase64 =
			Buffer.from("tampered").toString("base64");
		expect(() => validateInputPackage(pkg)).toThrow();
		expect(approved.changes[0]!.after!.contentBase64).toBe(
			Buffer.from("changed").toString("base64"),
		);
		const changed = structuredClone(approved);
		changed.changes[0]!.before!.sha256 = sha256("forged");
		const forged = authorizeInput(
			resign(changed),
			resign(changed).digest,
			"operator",
		);
		await expect(
			applyInput(
				{ ...identity, inputPackageDigest: forged.digest } as typeof identity,
				forged,
			),
		).rejects.toThrow();
		const forgedIdentity = await owned(f, forged, "forged");
		await expect(applyInput(forgedIdentity, forged)).rejects.toThrow(
			"before_base_mismatch",
		);
		await expect(
			applyInput({ ...identity, baseCommit: f.parent }, approved),
		).rejects.toThrow();
		await expect(
			applyInput({ ...identity, path: f.repo }, approved),
		).rejects.toThrow();
		await writeFile(join(identity.path, "tracked.bin"), "local conflict");
		await expect(applyInput(identity, approved)).rejects.toThrow(
			"current_before_mismatch",
		);
		// Real Git fixture, two workspaces and repeated closure checks took 4783ms on Windows.
	}, 15_000);

	test("exact commit closure imports with absent parents and unrelated history, and supports exact checkout", async () => {
		const f = await fixture();
		const pkg = await f.preview([], true);
		const ids = pkg.objects!.map((o) => o.oid);
		expect(ids).toContain(f.base);
		expect(ids).not.toContain(f.parent);
		expect(ids).not.toContain(f.oldBlob);
		expect(pkg.objects!.filter((o) => o.type === "commit")).toHaveLength(1);
		const approved = authorizeInput(pkg, pkg.digest, "fixture-transfer");
		const destination = join(f.dir, "imported");
		expect(await importRepository(destination, approved)).toBe(destination);
		expect(await git(destination, "rev-parse", "HEAD")).toBe(f.base);
		expect(await git(destination, "rev-parse", "--is-shallow-repository")).toBe(
			"true",
		);
		expect(
			(
				await run(
					["git", "-C", destination, "symbolic-ref", "-q", "HEAD"],
					destination,
				)
			).exit,
		).toBe(1);
		expect(
			(await run(["git", "-C", destination, "show-ref"], destination)).exit,
		).toBe(1);
		expect(await git(destination, "log", "--format=%H")).toBe(f.base);
		const fsck = await run(
			["git", "-C", destination, "fsck", "--full", "--no-reflogs"],
			destination,
		);
		const incompleteGit256Fsck =
			fsck.exit !== 0 &&
			fsck.stderr.includes("git: 'refs' is not a git command");
		if (incompleteGit256Fsck) {
			// Incomplete Git 2.56 builds abort fsck before honoring the shallow boundary;
			// the imported commit closure is still verifiable via object presence.
			for (const object of pkg.objects!) {
				expect(
					(
						await run(
							["git", "-C", destination, "cat-file", "-e", object.oid],
							destination,
						)
					).exit,
				).toBe(0);
			}
			expect(
				await git(
					destination,
					"rev-list",
					"--objects",
					"--missing=error",
					"HEAD",
				),
			).toContain(f.base);
		} else {
			expect(fsck.exit).toBe(0);
		}
		for (const id of [f.parent, f.oldBlob]) {
			const result = await run(
				["git", "-C", destination, "cat-file", "-e", id],
				destination,
			);
			expect(result.exit).not.toBe(0);
		}
		await git(destination, "checkout", "--detach", "--force", f.base);
		expect(await git(destination, "rev-parse", "HEAD")).toBe(f.base);
		expect(await git(destination, "status", "--porcelain=v1")).toBe("");
		expect(await readFile(join(destination, "tracked.bin"))).toEqual(
			Buffer.from([0, 1, 255, 0, 128]),
		);
		if (process.platform === "win32")
			expect(
				await git(destination, "ls-files", "--stage", "--", "executable"),
			).toMatch(/^100755 [a-f0-9]+ 0\texecutable$/);
		else
			expect(
				(await lstat(join(destination, "executable"))).mode & 0o111,
			).not.toBe(0);
		const prepared = await prepareWorkspace({
			taskId: "importtask",
			attemptId: "attempt",
			nodeId: "node",
			inputDigest: sha256("import task input"),
			inputPackageDigest: pkg.digest,
			repo: destination,
			baseCommit: f.base,
			workspaceRoot: join(f.dir, "import-workspaces"),
		});
		expect(await git(prepared.path, "rev-parse", "HEAD")).toBe(f.base);
		expect(await readFile(join(prepared.path, "tracked.bin"))).toEqual(
			Buffer.from([0, 1, 255, 0, 128]),
		);
		await expect(importRepository(destination, approved)).rejects.toThrow();
		expect(await git(destination, "rev-parse", "HEAD")).toBe(f.base);
		await expect(
			importRepository(join(f.dir, "unapproved"), pkg),
		).rejects.toThrow();
	});

	test("SHA256 repositories transfer full exact IDs without silently using SHA1", async () => {
		const f = await fixture("sha256"),
			pkg = await f.preview([], true);
		expect(pkg.baseCommit).toHaveLength(64);
		const destination = await importRepository(
			join(f.dir, "sha256-import"),
			authorizeInput(pkg, pkg.digest, "fixture-sha256"),
		);
		expect(await git(destination, "rev-parse", "--show-object-format")).toBe(
			"sha256",
		);
		await git(destination, "checkout", "--detach", "--force", f.base);
		expect(await git(destination, "rev-parse", "HEAD")).toBe(f.base);
	});

	test("corrupt, missing, extraneous, duplicate and wrong-base object sets reject even when payload digest is recomputed", async () => {
		const f = await fixture(),
			pkg = await f.preview([], true);
		const corrupt = structuredClone(pkg);
		corrupt.objects![0]!.contentBase64 =
			Buffer.from("corrupt").toString("base64");
		expect(() => validateInputPackage(resign(corrupt))).toThrow();
		const missing = structuredClone(pkg);
		missing.objects = missing.objects!.filter((o) => o.type !== "blob");
		expect(() => validateInputPackage(resign(missing))).toThrow();
		const duplicate = structuredClone(pkg);
		duplicate.objects!.push(duplicate.objects![0]!);
		expect(() => validateInputPackage(resign(duplicate))).toThrow();
		const extra = structuredClone(pkg),
			raw = Buffer.from("unrelated historic object\n");
		extra.objects!.push({
			oid: f.oldBlob,
			type: "blob",
			size: raw.length,
			sha256: sha256(raw),
			contentBase64: raw.toString("base64"),
		});
		expect(() => validateInputPackage(resign(extra))).toThrow(
			"extraneous_object",
		);
		const wrong = structuredClone(pkg);
		wrong.baseCommit = f.parent;
		expect(() => validateInputPackage(resign(wrong))).toThrow();
		const omitted = structuredClone(pkg);
		omitted.objects!.find((o) => o.type === "blob")!.sha256 = "0".repeat(64);
		expect(() =>
			authorizeInput(resign(omitted), resign(omitted).digest, "operator"),
		).toThrow();
	});

	test("selected unsafe, excluded, duplicate, normalized and case-colliding paths are rejected", async () => {
		const f = await fixture();
		for (const path of [
			"../escape",
			"./tracked.bin",
			"/absolute",
			"a\\b",
			".env",
			".env.local",
			"node_modules/x",
			".cache/x",
			"cache/x",
			"keys/signing",
			"credentials.txt",
			"id_rsa",
			"secret.key",
			".git/config",
			".fleet-identity.json",
			"AUX.txt",
		])
			await expect(f.preview([path])).rejects.toThrow();
		for (const paths of [
			["new", "new"],
			["A", "a"],
			["é", "é"],
			["p", "p/child"],
			["DIR/a", "dir/b"],
		])
			await expect(f.preview(paths)).rejects.toThrow();
		await writeFile(join(f.repo, "collision"), "unselected");
		await expect(f.preview(["COLLISION"])).rejects.toThrow();
		await expect(f.preview(["missing"])).rejects.toThrow(
			"selected_path_missing",
		);
	});

	test("source symlinks, hardlinks, directories, parent symlinks and destination link attacks reject", async () => {
		const f = await fixture();
		await symlink("tracked.bin", join(f.repo, "leaf-link"));
		await link(join(f.repo, "tracked.bin"), join(f.repo, "hard"));
		await mkdir(join(f.repo, "folder"));
		await symlink("folder", join(f.repo, "parent-link"));
		for (const path of ["leaf-link", "hard", "folder", "parent-link/new"])
			await expect(f.preview([path])).rejects.toThrow();
		await unlink(join(f.repo, "hard"));
		await writeFile(join(f.repo, "tracked.bin"), "new tracked bytes");
		await writeFile(join(f.repo, "folder/new"), "new nested bytes");
		const pkg = await f.preview(["tracked.bin", "folder/new"]),
			approved = authorizeInput(pkg, pkg.digest, "operator");
		const identity = await owned(f, pkg);
		await unlink(join(identity.path, "tracked.bin"));
		await symlink(
			join(f.repo, "tracked.bin"),
			join(identity.path, "tracked.bin"),
		);
		await expect(applyInput(identity, approved)).rejects.toThrow();
		await unlink(join(identity.path, "tracked.bin"));
		await link(join(f.repo, "tracked.bin"), join(identity.path, "tracked.bin"));
		await expect(applyInput(identity, approved)).rejects.toThrow();
		await unlink(join(identity.path, "tracked.bin"));
		await writeFile(
			join(identity.path, "tracked.bin"),
			Buffer.from([0, 1, 255, 0, 128]),
		);
		await symlink(join(f.repo, "folder"), join(identity.path, "folder"));
		await expect(applyInput(identity, approved)).rejects.toThrow();
		expect(await readFile(join(f.repo, "tracked.bin"), "utf8")).toBe(
			"new tracked bytes",
		);
		// Five previews and three apply attempts revalidate real six-object closures
		// (over 160 Git processes with fixture/workspace setup); 5000ms timed out on Windows.
	}, 15_000);

	test("unsupported committed entries, excluded base paths and bounded byte/file budgets fail closed", async () => {
		const f = await fixture();
		await expect(f.preview([], true, 1)).rejects.toThrow("input_byte_limit");
		await expect(f.preview([], false, 16 * 1024 * 1024 + 1)).rejects.toThrow();
		await expect(
			f.preview(Array.from({ length: 1025 }, (_, i) => "x" + i)),
		).rejects.toThrow();
		await symlink("tracked.bin", join(f.repo, "committed-link"));
		await git(f.repo, "add", "committed-link");
		await git(f.repo, "commit", "-qm", "task-owned unsupported fixture");
		const linkedBase = await git(f.repo, "rev-parse", "HEAD");
		await expect(
			previewInput({
				repo: f.repo,
				repoId: "fixture",
				baseCommit: linkedBase,
				paths: [],
				includeObjects: true,
			}),
		).rejects.toThrow("unsupported_tree_entry");
		await git(f.repo, "rm", "committed-link");
		await git(
			f.repo,
			"update-index",
			"--add",
			"--cacheinfo",
			"160000," + f.base + ",submodule",
		);
		await git(f.repo, "commit", "-qm", "task-owned gitlink fixture");
		await expect(
			previewInput({
				repo: f.repo,
				repoId: "fixture",
				baseCommit: await git(f.repo, "rev-parse", "HEAD"),
				paths: [],
				includeObjects: true,
			}),
		).rejects.toThrow("unsupported_tree_entry");
		await git(f.repo, "rm", "--cached", "submodule");
		await writeFile(join(f.repo, ".env"), "not exportable");
		await git(f.repo, "add", ".env");
		await git(f.repo, "commit", "-qm", "task-owned excluded fixture");
		await expect(
			previewInput({
				repo: f.repo,
				repoId: "fixture",
				baseCommit: await git(f.repo, "rev-parse", "HEAD"),
				paths: [],
				includeObjects: false,
			}),
		).rejects.toThrow("excluded_input");
	});

	test("inputs git failures surface git_failed:exit=N only — never stderr snippets", async () => {
		const f = await fixture();
		const secret = "ghp_inputsSecretShouldNeverLeak9999";
		// Inject the token into a broken include path so real git stderr carries it;
		// the public message must stay exit-only (reviewer non-blocking nit).
		const privateConfig = join(f.dir, secret + ".config");
		await writeFile(privateConfig, "[unterminated\n");
		await writeFile(
			join(f.repo, ".git", "config"),
			`[include]\n\tpath = ${JSON.stringify(privateConfig.replaceAll("\\", "/"))}\n`,
		);
		const diagnostic = await run(["git", "-C", f.repo, "rev-parse", "--show-toplevel"], f.repo);
		expect(diagnostic.exit).toBe(128);
		expect(diagnostic.stderr).toContain(secret);
		try {
			await f.preview([]);
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			const message = (error as Error).message;
			expect(message).toMatch(/^git_failed:exit=\d+$/);
			expect(message).not.toContain("fatal");
			expect(message).not.toContain(secret);
			expect(message).not.toContain(f.repo);
			expect(message).not.toContain("rev-parse");
		}
		const src = await Bun.file(new URL("../src/inputs.ts", import.meta.url)).text();
		expect(src).toContain("fail(gitFailedMessage(exit))");
		expect(src).not.toContain("err.toString().slice");
	});
});
