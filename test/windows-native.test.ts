import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { win32 } from "node:path";
import { kernelApi, readWindowsAnchoredFile } from "../src/windows-reader";
import {
	nativeWindowsWriteApi,
	writeWindowsInput,
} from "../src/windows-writer";
import { isolatedGitEnvironment } from "../src/spawn";
import { prepareWorkspace, run as runCommand } from "../src/workspace";

// REAL native tests, not fake-provider contracts. Run only in a separately
// approved, exclusively owned preparation workspace, before any agent starts.
// No hostile-writer inode-CAS, Git-index mode, or Windows ACL equivalence claims.
const approvedRoot = process.env.FLEET_NATIVE_TEST_ROOT;
const enabled = process.platform === "win32" && !!approvedRoot;
const suite = enabled ? describe : describe.skip;
const suiteName =
	process.platform !== "win32"
		? "Windows native DLL acceptance (SKIPPED: requires actual Windows)"
		: !approvedRoot
			? "Windows native DLL acceptance (SKIPPED: FLEET_NATIVE_TEST_ROOT approval required)"
			: "Windows native DLL acceptance (real kernel32/ntdll, exclusive preparation only)";

const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
async function powershell(root: string, code: string) {
	const result = await runCommand(
		[
			"powershell.exe",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from("$ErrorActionPreference='Stop';" + code, "utf16le").toString(
				"base64",
			),
		],
		root,
		65536,
	);
	if (result.exit !== 0)
		throw Error("owned_acl_command_failed:" + result.stderr);
	return result.stdout.trim();
}
const before = (bytes: Buffer) => ({
	sha256: sha256(bytes),
	mode: 100644 as const,
});
const after = (bytes: Buffer) => ({
	...before(bytes),
	bytes: bytes.length,
	contentBase64: bytes.toString("base64"),
});
function unprefix(path: string): string {
	return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
async function owned(
	run: (root: string) => void | Promise<void>,
): Promise<void> {
	// Never mkdir the approved root or silently substitute cwd/tmp/profile.
	if (!enabled || !approvedRoot)
		throw new Error("native_test_explicit_windows_root_required");
	if (
		!/^[A-Za-z]:\\/.test(approvedRoot) ||
		approvedRoot.includes("\0") ||
		approvedRoot.includes("/") ||
		win32.normalize(approvedRoot) !== approvedRoot ||
		approvedRoot.endsWith("\\")
	) {
		throw new Error(
			"FLEET_NATIVE_TEST_ROOT must be an existing canonical local task directory, not a drive root",
		);
	}
	const info = lstatSync(approvedRoot);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		unprefix(realpathSync.native(approvedRoot)) !== approvedRoot
	) {
		throw new Error(
			"FLEET_NATIVE_TEST_ROOT must be a canonical non-reparse directory",
		);
	}
	const api = kernelApi(),
		anchor = api.open(approvedRoot, true);
	try {
		const native = api.info(anchor);
		expect(native.attributes & 0x10).toBe(0x10);
		expect(native.attributes & 0x400).toBe(0);
		expect(unprefix(api.path(anchor))).toBe(approvedRoot);
	} finally {
		api.close(anchor);
	}
	const root = mkdtempSync(win32.join(approvedRoot, "fleet-native-"));
	try {
		await run(root);
	} finally {
		// Only this test's exclusive mkdtemp-owned tree is removed. Successful
		// cleanup also detects native handles left open without delete sharing.
		rmSync(root, { recursive: true, force: false });
	}
}

suite(suiteName, () => {
	test(
		"real fixture ACL denial refuses native replacement/deletion and restores exact file and parent DACLs",
		() =>
			owned(async (root) => {
				const file = win32.join(root, "acl-leaf.bin"),
					bytes = Buffer.from([0, 9, 255, 0]);
				writeFileSync(file, bytes, { flag: "wx" });
				const quoted = "'" + file.replaceAll("'", "''") + "'";
				const parentQuoted = "'" + root.replaceAll("'", "''") + "'";
				// Set-Acl itself adds the OS-managed AutoInherited control flag. Prepare
				// these newly owned fixture ACLs through that API before saving a baseline;
				// no rights are changed and no existing user/shared path is touched.
				await powershell(
					root,
					`foreach($p in @(${parentQuoted},${quoted})){$acl=Get-Acl -LiteralPath $p;$sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);$acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath $p -AclObject $acl}`,
				);
				const saved = await powershell(
					root,
					`$acl=Get-Acl -LiteralPath ${quoted};[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`,
				);
				const parentSaved = await powershell(
					root,
					`$acl=Get-Acl -LiteralPath ${parentQuoted};[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`,
				);
				try {
					// Windows may otherwise permit replacement using DELETE_CHILD on the
					// parent even when the leaf's DELETE right is denied. Deny both routes,
					// only on this fixture; neither rule is inherited by temporary files.
					await powershell(
						root,
						`$acl=Get-Acl -LiteralPath ${parentQuoted};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,[Security.AccessControl.AccessControlType]::Deny);$acl.AddAccessRule($rule);Set-Acl -LiteralPath ${parentQuoted} -AclObject $acl`,
					);
					await powershell(
						root,
						`$acl=Get-Acl -LiteralPath ${quoted};$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$rights=[Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::AppendData -bor [Security.AccessControl.FileSystemRights]::Delete;$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,$rights,[Security.AccessControl.AccessControlType]::Deny);$acl.AddAccessRule($rule);Set-Acl -LiteralPath ${quoted} -AclObject $acl`,
					);
					expect(
						readWindowsAnchoredFile(root, ["acl-leaf.bin"], 1024).bytes,
					).toEqual(bytes);
					expect(() =>
						writeWindowsInput(root, [
							{
								path: "acl-leaf.bin",
								before: before(bytes),
								after: after(Buffer.from("refused")),
							},
						]),
					).toThrow();
					expect(() =>
						writeWindowsInput(root, [
							{ path: "acl-leaf.bin", before: before(bytes), after: null },
						]),
					).toThrow();
					expect(readFileSync(file)).toEqual(bytes);
				} finally {
					try {
						await powershell(
							root,
							`$acl=Get-Acl -LiteralPath ${quoted};$sddl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${saved}'));$acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath ${quoted} -AclObject $acl`,
						);
					} finally {
						await powershell(
							root,
							`$acl=Get-Acl -LiteralPath ${parentQuoted};$sddl=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${parentSaved}'));$acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);Set-Acl -LiteralPath ${parentQuoted} -AclObject $acl`,
						);
					}
				}
				expect(
					await powershell(
						root,
						`$acl=Get-Acl -LiteralPath ${quoted};[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`,
					),
				).toBe(saved);
				expect(
					await powershell(
						root,
						`$acl=Get-Acl -LiteralPath ${parentQuoted};[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)))`,
					),
				).toBe(parentSaved);
				writeWindowsInput(root, [
					{
						path: "acl-leaf.bin",
						before: before(bytes),
						after: after(Buffer.from("restored")),
					},
				]);
				expect(readFileSync(file, "utf8")).toBe("restored");
			}),
		30_000,
	);
	test("actual writer directory handle denies ancestor rename until its exact handle closes", () =>
		owned((root) => {
			const api = nativeWindowsWriteApi(),
				handle = api.open(root, true, 0x1000a1),
				moved = root + "-moved";
			try {
				expect(() => renameSync(root, moved)).toThrow();
				expect(existsSync(root)).toBe(true);
				expect(existsSync(moved)).toBe(false);
			} finally {
				api.close(handle);
			}
			renameSync(root, moved);
			renameSync(moved, root);
			expect(existsSync(root)).toBe(true);
		}));
	test("actual Windows Git prepares full task identifiers with a short owned administrative directory", () =>
		owned(async (root) => {
			const taskId = randomUUID(),
				attemptId = randomUUID(),
				repo = win32.join(root, "imports", taskId + "-" + attemptId),
				workspaceRoot = win32.join(root, "workspaces");
			mkdirSync(repo, { recursive: true });
			async function git(args: string[]) {
				const result = await runCommand(
					[
						"git",
						"-c",
						"core.longpaths=true",
						"-c",
						"core.hooksPath=NUL",
						"-c",
						"user.name=Fleet Native Fixture",
						"-c",
						"user.email=fixture@example.invalid",
						"-C",
						repo,
						...args,
					],
					repo,
					1024 * 1024,
					isolatedGitEnvironment(repo),
				);
				if (result.exit !== 0) throw Error(result.stderr);
				return result.stdout.trim();
			}
			await git(["init", "--initial-branch=native"]);
			writeFileSync(win32.join(repo, "fixture.txt"), "native Git bytes\n", {
				flag: "wx",
			});
			await git(["add", "--", "fixture.txt"]);
			await git(["commit", "-m", "owned native fixture"]);
			const baseCommit = await git(["rev-parse", "HEAD"]);
			const identity = await prepareWorkspace({
				taskId,
				attemptId,
				nodeId: "native",
				inputDigest: sha256(Buffer.from("native-input")),
				repo,
				baseCommit,
				workspaceRoot,
			});
			expect(identity.path).toBe(
				win32.join(workspaceRoot, taskId + "-" + attemptId),
			);
			expect(
				readFileSync(win32.join(identity.path, "fixture.txt"), "utf8"),
			).toBe("native Git bytes\n");
			const administrative = readdirSync(win32.join(repo, ".git", "worktrees"));
			expect(administrative).toHaveLength(1);
			expect(administrative[0]!.length).toBeLessThanOrEqual(40);
			expect(
				administrative[0]!.endsWith(
					sha256(Buffer.from(taskId + "\0" + attemptId)).slice(0, 24),
				),
			).toBe(true);
			expect(readFileSync(win32.join(identity.path, ".git"), "utf8")).toContain(
				"/worktrees/" + administrative[0],
			);
		}));
	test("default native writer creates exact binary bytes and default reader/kernelApi read held file", () =>
		owned((root) => {
			const bytes = Buffer.from([0, 255, 128, 13, 10, 1, 0, 254]);
			writeWindowsInput(root, [
				{ path: "binary.dat", before: null, after: after(bytes) },
			]);
			expect(readFileSync(win32.join(root, "binary.dat"))).toEqual(bytes);
			expect(readWindowsAnchoredFile(root, ["binary.dat"], 1024).bytes).toEqual(
				bytes,
			);
			const api = kernelApi(),
				handle = api.open(win32.join(root, "binary.dat"), false);
			try {
				expect(typeof handle).toBe("bigint");
				expect(api.info(handle).size).toBe(bytes.length);
				expect(api.info(handle).links).toBe(1);
				expect(api.read(handle, bytes.length + 1)).toEqual(bytes);
			} finally {
				api.close(handle);
			}
			expect(readdirSync(root)).toEqual(["binary.dat"]);
		}));

	test("default native writer replaces expected before bytes, deletes and handles empty content", () =>
		owned((root) => {
			const initial = Buffer.from("before\0bytes", "utf8"),
				replacement = Buffer.from([255, 0, 127]);
			writeWindowsInput(root, [
				{ path: "leaf", before: null, after: after(initial) },
			]);
			writeWindowsInput(root, [
				{ path: "leaf", before: before(initial), after: after(replacement) },
			]);
			expect(readWindowsAnchoredFile(root, ["leaf"], 1024).bytes).toEqual(
				replacement,
			);
			expect(readdirSync(root)).toEqual(["leaf"]);
			writeWindowsInput(root, [
				{
					path: "leaf",
					before: before(replacement),
					after: after(Buffer.alloc(0)),
				},
			]);
			expect(readWindowsAnchoredFile(root, ["leaf"], 1024).bytes).toEqual(
				Buffer.alloc(0),
			);
			writeWindowsInput(root, [
				{ path: "leaf", before: before(Buffer.alloc(0)), after: null },
			]);
			expect(existsSync(win32.join(root, "leaf"))).toBe(false);
			expect(readdirSync(root)).toEqual([]);
		}));

	test("native relative parent creation and UTF-16 non-ASCII components round-trip bytes", () =>
		owned((root) => {
			const parts = ["données", "é😀", "résultat.bin"],
				bytes = Buffer.from("native UTF-16 path\0payload", "utf8");
			writeWindowsInput(root, [
				{ path: parts.join("/"), before: null, after: after(bytes) },
			]);
			expect(readWindowsAnchoredFile(root, parts, 1024).bytes).toEqual(bytes);
			expect(readFileSync(win32.join(root, ...parts))).toEqual(bytes);
			expect(readdirSync(win32.join(root, ...parts.slice(0, -1)))).toEqual([
				parts.at(-1)!,
			]);
		}));

	test("native existing-byte, absent-before and unexpected-existing conflicts preserve destination", () =>
		owned((root) => {
			const bytes = Buffer.from("actual"),
				wrong = Buffer.from("wrong"),
				file = win32.join(root, "leaf");
			writeWindowsInput(root, [
				{ path: "leaf", before: null, after: after(bytes) },
			]);
			for (const afterValue of [after(Buffer.from("replacement")), null]) {
				expect(() =>
					writeWindowsInput(root, [
						{ path: "leaf", before: before(wrong), after: afterValue },
					]),
				).toThrow("current_before_mismatch");
				expect(readFileSync(file)).toEqual(bytes);
			}
			expect(() =>
				writeWindowsInput(root, [
					{ path: "leaf", before: null, after: after(wrong) },
				]),
			).toThrow("current_before_mismatch");
			expect(() =>
				writeWindowsInput(root, [
					{ path: "missing", before: before(bytes), after: after(wrong) },
				]),
			).toThrow("current_before_mismatch");
			expect(readFileSync(file)).toEqual(bytes);
			expect(readdirSync(root)).toEqual(["leaf"]);
		}));

	test("real hardlinks are detected and neither linked name is modified or deleted", () =>
		owned((root) => {
			const bytes = Buffer.from("linked original"),
				target = win32.join(root, "target"),
				alias = win32.join(root, "alias");
			writeFileSync(target, bytes, { flag: "wx" });
			// Hardlink creation is a real filesystem prerequisite, not a mock. Failure
			// fails this case and must not be reported as hardlink rejection evidence.
			linkSync(target, alias);
			expect(statSync(target).nlink).toBe(2);
			for (const afterValue of [after(Buffer.from("replacement")), null]) {
				expect(() =>
					writeWindowsInput(root, [
						{ path: "alias", before: before(bytes), after: afterValue },
					]),
				).toThrow("unsafe_windows_input");
			}
			expect(() => readWindowsAnchoredFile(root, ["alias"], 1024)).toThrow(
				"unsafe_windows_artifact",
			);
			expect(readFileSync(target)).toEqual(bytes);
			expect(readFileSync(alias)).toEqual(bytes);
			expect(readdirSync(root).sort()).toEqual(["alias", "target"]);
		}));

	test("real directory leaf and regular-file ancestor cannot be overwritten or traversed", () =>
		owned((root) => {
			mkdirSync(win32.join(root, "directory"));
			const bytes = Buffer.from("ancestor file");
			writeFileSync(win32.join(root, "file"), bytes, { flag: "wx" });
			// Native FILE_NON_DIRECTORY_FILE / FILE_DIRECTORY_FILE may refuse the open
			// before the post-open checks; either path must refuse without mutation.
			expect(() =>
				writeWindowsInput(root, [
					{
						path: "directory",
						before: before(Buffer.alloc(0)),
						after: after(bytes),
					},
				]),
			).toThrow();
			expect(() =>
				readWindowsAnchoredFile(root, ["directory"], 1024),
			).toThrow();
			expect(() =>
				writeWindowsInput(root, [
					{ path: "file/child", before: null, after: after(bytes) },
				]),
			).toThrow();
			expect(statSync(win32.join(root, "directory")).isDirectory()).toBe(true);
			expect(readFileSync(win32.join(root, "file"))).toEqual(bytes);
			expect(readdirSync(win32.join(root, "directory"))).toEqual([]);
		}));

	test("real same-root junction cannot redirect an artifact read into an owned excluded-looking directory", () =>
		owned((root) => {
			const target = win32.join(root, ".gjc"),
				junction = win32.join(root, "report"),
				sentinel = win32.join(target, "sentinel.txt"),
				bytes = Buffer.from("owned excluded-looking fixture bytes\0", "utf8");
			mkdirSync(target);
			writeFileSync(sentinel, bytes, { flag: "wx" });
			symlinkSync(target, junction, "junction");
			try {
				const api = kernelApi();
				let reads = 0;
				expect(() =>
					readWindowsAnchoredFile(root, ["report", "sentinel.txt"], 1024, {
						...api,
						read(handle, limit) {
							reads++;
							return api.read(handle, limit);
						},
					}),
				).toThrow("unsafe_windows_artifact");
				expect(reads).toBe(0);
				expect(readFileSync(sentinel)).toEqual(bytes);
				expect(readdirSync(target)).toEqual(["sentinel.txt"]);
			} finally {
				// Remove only this fixture's junction before owned() removes its tree.
				unlinkSync(junction);
			}
		}));

	test("real unprivileged directory junction is refused as ancestor, leaf and root", () =>
		owned((root) => {
			const target = win32.join(root, "target"),
				junction = win32.join(root, "junction"),
				bytes = Buffer.from("untouched junction target");
			mkdirSync(target);
			writeFileSync(win32.join(target, "guard"), bytes, { flag: "wx" });
			// Directory junctions do not require symbolic-link privilege on supported
			// Windows filesystems. No file-symlink privilege is requested or implied.
			// Unsupported junction creation is a failed capability prerequisite, NOT
			// successful reparse proof. Do not suppress its error into a passing test.
			symlinkSync(target, junction, "junction");
			try {
				const api = kernelApi(),
					handle = api.open(junction, true);
				try {
					expect(api.info(handle).attributes & 0x400).toBe(0x400);
				} finally {
					api.close(handle);
				}
				expect(() =>
					writeWindowsInput(root, [
						{ path: "junction/new", before: null, after: after(bytes) },
					]),
				).toThrow("unsafe_windows_input");
				expect(() =>
					writeWindowsInput(root, [
						{
							path: "junction",
							before: before(Buffer.alloc(0)),
							after: after(bytes),
						},
					]),
				).toThrow();
				expect(() =>
					writeWindowsInput(junction, [
						{ path: "new", before: null, after: after(bytes) },
					]),
				).toThrow("unsafe_windows_input");
				expect(readFileSync(win32.join(target, "guard"))).toEqual(bytes);
				expect(readdirSync(target)).toEqual(["guard"]);
			} finally {
				// Remove the reparse entry explicitly before recursively cleaning its
				// owned enclosing directory; never traverse it during cleanup.
				unlinkSync(junction);
			}
		}));
});
