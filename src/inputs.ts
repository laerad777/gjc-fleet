import { createHash, randomBytes } from "node:crypto";
import {
	constants,
	closeSync,
	fstatSync,
	openSync,
	readSync,
	writeSync,
	fchmodSync,
	fsyncSync,
} from "node:fs";
import { lstat, mkdir, opendir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { dlopen, FFIType } from "bun:ffi";
import { canonicalJson } from "./core";
import { writeWindowsInput } from "./windows-writer";
import { spawnGit } from "./spawn";
import {
	excluded,
	gitFailedMessage,
	workspaceTrees,
	readOwnedFile,
	safeRelative,
	sha256,
	type WorkspaceIdentity,
} from "./workspace";

const LIMIT = 16 * 1024 * 1024;
const FILES = 1024;
type Mode = 100644 | 100755;
interface Before {
	sha256: string;
	mode: Mode;
}
interface After extends Before {
	bytes: number;
	contentBase64: string;
}
interface GitObject {
	oid: string;
	type: "commit" | "tree" | "blob";
	size: number;
	sha256: string;
	contentBase64: string;
}
/** Exact wire shape. Modes are Git's decimal spelling (100644/100755), not POSIX permissions.
 * before=null means absent at base; after=null means deletion. SHA256 covers raw bytes.
 * objects, when present, contain only the exact commit and its complete current tree/blob closure.
 * Limits: 1024 changed files and 1024 base files; 16MiB aggregate decoded after/object bytes.
 * Tree traversal also caps depth at 256 and tree entries at 3072; sibling scans cap at 4096.
 * digest is SHA256(canonicalJson({schemaVersion,repoId,baseCommit,changes,...objects}));
 * digest and authorization are excluded from that payload. Preview never authorizes anything.
 */
export interface InputPackage {
	schemaVersion: 1;
	repoId: string;
	baseCommit: string;
	digest: string;
	changes: { path: string; before: Before | null; after: After | null }[];
	objects?: GitObject[];
	authorization?: { digest: string; reference: string };
}
function fail(message: string): never {
	throw new Error(message);
}
function exact(value: unknown, keys: string[]): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some((k) => !keys.includes(k))
	)
		fail("invalid_input_shape");
}
const PATH_BYTES = 4096;
const PATH_COMPONENTS = 256;
const PATH_SET_BYTES = 256 * 1024;
function pathName(path: string): string {
	if (typeof path !== "string") fail("invalid_path");
	// Bound prefix construction before namesCheck allocates normalized prefixes.
	if (path.length > PATH_BYTES || Buffer.byteLength(path, "utf8") > PATH_BYTES ||
		path.split("/").length > PATH_COMPONENTS) fail("input_path_limit");
	safeRelative(path);
	if (
		excluded(path) ||
		path
			.split("/")
			.some((p) =>
				/^(\.fleet-identity\.json|\.?keys|caches?|__pycache__|\.aws|\.azure|\.gnupg|\.kube|credentials?(\..*)?|secrets?(\..*)?|tokens?(\..*)?)$/i.test(
					p,
				),
			)
	)
		fail("excluded_input:" + path);
	return path;
}
function namesCheck(paths: string[]): void {
	let pathBytes = 0;
	for (const path of paths) {
		pathName(path);
		pathBytes += Buffer.byteLength(path, "utf8");
		if (pathBytes > PATH_SET_BYTES) fail("input_path_set_limit");
	}
	const names = new Map<string, string>();
	const leaves = new Set<string>();
	for (const path of paths) {
		if (leaves.has(path)) fail("duplicate_path");
		leaves.add(path);
		const parts = path.split("/");
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/");
			const key = prefix.normalize("NFC").toLowerCase();
			if (names.has(key) && names.get(key) !== prefix)
				fail("case_normalization_collision");
			names.set(key, prefix);
			if (i < parts.length && leaves.has(prefix))
				fail("file_directory_collision");
		}
	}
	for (const path of paths)
		for (const other of paths)
			if (other.startsWith(path + "/")) fail("file_directory_collision");
}

/** Inclusive path budgets for tests: 4096B / 256 components / 256 KiB set. */
export const INPUT_PATH_BUDGETS = {
	bytes: PATH_BYTES,
	components: PATH_COMPONENTS,
	setBytes: PATH_SET_BYTES,
} as const;

/** Exported so boundary tests can hit namesCheck without a full package digest. */
export function checkInputPathSet(paths: string[]): void {
	namesCheck(paths);
}

function content(value: After | GitObject): Buffer {
	if (
		typeof value.contentBase64 !== "string" ||
		!Number.isSafeInteger("bytes" in value ? value.bytes : value.size)
	)
		fail("invalid_content");
	const size = "bytes" in value ? value.bytes : value.size;
	if (
		size < 0 ||
		size > LIMIT ||
		value.contentBase64.length > Math.ceil(LIMIT / 3) * 4
	)
		fail("input_byte_limit");
	const bytes = Buffer.from(value.contentBase64, "base64");
	if (
		bytes.toString("base64") !== value.contentBase64 ||
		bytes.length !== size ||
		sha256(bytes) !== value.sha256
	)
		fail("content_digest_mismatch");
	return bytes;
}
function payload(pkg: InputPackage): object {
	return {
		schemaVersion: pkg.schemaVersion,
		repoId: pkg.repoId,
		baseCommit: pkg.baseCommit,
		changes: pkg.changes,
		...(pkg.objects === undefined ? {} : { objects: pkg.objects }),
	};
}
function packageDigest(pkg: InputPackage): string {
	return sha256(canonicalJson(payload(pkg)));
}
function oid(type: string, bytes: Buffer, width: number): string {
	return createHash(width === 40 ? "sha1" : "sha256")
		.update(`${type} ${bytes.length}\0`)
		.update(bytes)
		.digest("hex");
}
interface Entry {
	path: string;
	oid: string;
	mode: Mode;
}
function treeEntries(
	bytes: Buffer,
	width: number,
): { name: string; oid: string; mode: string }[] {
	const entries: { name: string; oid: string; mode: string }[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const space = bytes.indexOf(32, offset),
			end = bytes.indexOf(0, space + 1);
		if (space < offset || end < space || end + 1 + width / 2 > bytes.length)
			fail("invalid_tree");
		const raw = bytes.subarray(space + 1, end),
			name = raw.toString("utf8");
		if (!Buffer.from(name).equals(raw) || name.includes("/"))
			fail("invalid_tree_name");
		pathName(name);
		const mode = bytes.subarray(offset, space).toString(),
			previous = entries.at(-1);
		if (
			previous &&
			Buffer.compare(
				Buffer.from(previous.name + (previous.mode === "40000" ? "/" : "")),
				Buffer.from(name + (mode === "40000" ? "/" : "")),
			) >= 0
		)
			fail("noncanonical_tree_order");
		entries.push({
			name,
			mode,
			oid: bytes.subarray(end + 1, end + 1 + width / 2).toString("hex"),
		});
		if (entries.length > FILES * 3) fail("input_tree_entry_limit");
		offset = end + 1 + width / 2;
	}
	return entries;
}
function commitTree(bytes: Buffer, width: number): string {
	const text = bytes.toString("utf8"),
		lines = text.split("\n");
	if (
		!new RegExp(`^tree [a-f0-9]{${width}}$`).test(lines[0] ?? "") ||
		!text.includes("\n\n")
	)
		fail("invalid_commit");
	return lines[0]!.slice(5);
}
function closure(pkg: InputPackage): Entry[] {
	const objects = new Map((pkg.objects ?? []).map((o) => [o.oid, o]));
	if (objects.size !== pkg.objects?.length) fail("duplicate_object");
	const used = new Set<string>(),
		entries: Entry[] = [],
		active = new Set<string>(),
		treePaths: string[] = [];
	const get = (id: string, type: GitObject["type"]) => {
		const object = objects.get(id);
		if (!object || object.type !== type) fail("missing_or_wrong_object");
		used.add(id);
		return content(object);
	};
	const visit = (id: string, prefix: string) => {
		if (active.has(id) || prefix.split("/").length > 256)
			fail("tree_cycle_or_depth_limit");
		active.add(id);
		const children = treeEntries(get(id, "tree"), pkg.baseCommit.length);
		namesCheck(children.map((e) => e.name));
		for (const e of children) {
			const path = prefix + e.name;
			pathName(path);
			treePaths.push(path);
			if (treePaths.length > FILES * 3) fail("input_tree_entry_limit");
			if (e.mode === "40000") visit(e.oid, path + "/");
			else if (e.mode === "100644" || e.mode === "100755") {
				get(e.oid, "blob");
				entries.push({ path, oid: e.oid, mode: Number(e.mode) as Mode });
				if (entries.length > FILES) fail("input_file_limit");
			} else fail("unsupported_tree_entry:" + path);
		}
		active.delete(id);
	};
	visit(commitTree(get(pkg.baseCommit, "commit"), pkg.baseCommit.length), "");
	if (used.size !== objects.size) fail("extraneous_object");
	const normalized = new Map<string, string>();
	for (const path of treePaths) {
		const key = path.normalize("NFC").toLowerCase();
		if (normalized.has(key)) fail("case_normalization_collision");
		normalized.set(key, path);
	}
	namesCheck(entries.map((e) => e.path));
	return entries;
}
export function validateInputPackage(pkg: InputPackage): void {
	exact(pkg, [
		"schemaVersion",
		"repoId",
		"baseCommit",
		"digest",
		"changes",
		"objects",
		"authorization",
	]);
	if (
		pkg.schemaVersion !== 1 ||
		typeof pkg.repoId !== "string" ||
		!pkg.repoId.trim() ||
		pkg.repoId.length > 512 ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pkg.baseCommit) ||
		!/^[a-f0-9]{64}$/.test(pkg.digest)
	)
		fail("invalid_input_package");
	if (!Array.isArray(pkg.changes) || pkg.changes.length > FILES)
		fail("input_file_limit");
	namesCheck(pkg.changes.map((c) => c.path));
	let total = 0;
	for (const c of pkg.changes) {
		exact(c, ["path", "before", "after"]);
		if (c.before === null && c.after === null) fail("empty_change");
		for (const [value, after] of [
			[c.before, false],
			[c.after, true],
		] as const) {
			if (value === null) continue;
			exact(
				value,
				after
					? ["sha256", "mode", "bytes", "contentBase64"]
					: ["sha256", "mode"],
			);
			if (
				!/^[a-f0-9]{64}$/.test(value.sha256) ||
				![100644, 100755].includes(value.mode)
			)
				fail("invalid_file_metadata");
			if (after) total += content(value as After).length;
			if (total > LIMIT) fail("input_byte_limit");
		}
		if (
			c.before &&
			c.after &&
			c.before.sha256 === c.after.sha256 &&
			c.before.mode === c.after.mode
		)
			fail("unchanged_input");
	}
	if (pkg.objects !== undefined) {
		if (!Array.isArray(pkg.objects) || pkg.objects.length > FILES * 3 + 2)
			fail("input_object_limit");
		for (const o of pkg.objects) {
			exact(o, ["oid", "type", "size", "sha256", "contentBase64"]);
			if (
				typeof o.oid !== "string" ||
				!new RegExp(`^[a-f0-9]{${pkg.baseCommit.length}}$`).test(o.oid) ||
				!["commit", "tree", "blob"].includes(o.type)
			)
				fail("invalid_object");
			const bytes = content(o);
			total += bytes.length;
			if (total > LIMIT) fail("input_byte_limit");
			if (oid(o.type, bytes, pkg.baseCommit.length) !== o.oid)
				fail("git_object_digest_mismatch");
		}
		const entries = closure(pkg),
			byPath = new Map(entries.map((e) => [e.path, e]));
		const objectsById = new Map(pkg.objects.map((o) => [o.oid, o]));
		let materializedBytes = 0;
		for (const entry of entries) {
			materializedBytes += objectsById.get(entry.oid)!.size;
			if (materializedBytes > LIMIT) fail("input_materialization_byte_limit");
		}
		const changesByPath = new Map(pkg.changes.map((c) => [c.path, c]));
		let finalBytes = 0;
		for (const entry of entries)
			finalBytes += changesByPath.has(entry.path)
				? (changesByPath.get(entry.path)!.after?.bytes ?? 0)
				: objectsById.get(entry.oid)!.size;
		for (const change of pkg.changes)
			if (change.before === null) finalBytes += change.after?.bytes ?? 0;
		if (finalBytes > LIMIT) fail("input_materialization_byte_limit");
		namesCheck([
			...new Set([
				...entries.map((e) => e.path),
				...pkg.changes.map((c) => c.path),
			]),
		]);
		for (const c of pkg.changes) {
			const e = byPath.get(c.path);
			if (
				!e
					? c.before !== null
					: !c.before ||
						c.before.mode !== e.mode ||
						c.before.sha256 !== pkg.objects.find((o) => o.oid === e.oid)!.sha256
			)
				fail("before_base_mismatch");
		}
	}
	if (total > LIMIT) fail("input_byte_limit");
	if (packageDigest(pkg) !== pkg.digest) fail("input_digest_mismatch");
	if (pkg.authorization !== undefined) {
		exact(pkg.authorization, ["digest", "reference"]);
		if (
			pkg.authorization.digest !== pkg.digest ||
			typeof pkg.authorization.reference !== "string" ||
			!pkg.authorization.reference.trim() ||
			pkg.authorization.reference.length > 4096
		)
			fail("invalid_authorization");
	}
}
export function authorizeInput(
	pkg: InputPackage,
	expectedDigest: string,
	reference: string,
): InputPackage {
	validateInputPackage(pkg);
	if (
		expectedDigest !== pkg.digest ||
		typeof reference !== "string" ||
		!reference.trim()
	)
		fail("explicit_authorization_required");
	const approved = structuredClone({
		...pkg,
		authorization: { digest: expectedDigest, reference },
	});
	validateInputPackage(approved);
	return approved;
}

// Ignore ambient Git configuration and executable helpers. cat-file never invokes filters.
async function git(
	repo: string,
	args: string[],
	untrusted: string[],
	input?: Buffer,
	limit = LIMIT,
): Promise<Buffer> {
	const child = spawnGit(repo, args, {
		untrusted,
		flags: ["--literal-pathspecs"],
		stdin: input === undefined ? "ignore" : input,
	});
	const drain = async (stream: ReadableStream<Uint8Array>) => {
		const reader = stream.getReader(),
			chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const r = await reader.read();
			if (r.done) break;
			size += r.value.length;
			if (size > limit) {
				// Match workspace collect()/gitRecords: overflow teardown is final.
				child.kill("SIGKILL");
				fail("git_output_limit");
			}
			chunks.push(r.value);
		}
		return Buffer.concat(chunks);
	};
	const [out, , exit] = await Promise.all([
		drain(child.stdout!),
		drain(child.stderr!),
		child.exited,
	]);
	if (exit !== 0) fail(gitFailedMessage(exit));
	return out;
}
async function exactRepo(
	repo: string,
	base: string,
	untrusted: string[],
): Promise<string> {
	const root = await realpath(repo);
	if (
		root !== resolve(repo) ||
		(await realpath(
			(await git(root, ["rev-parse", "--show-toplevel"], untrusted))
				.toString()
				.trim(),
		)) !== root
	)
		fail("repository_root_required");
	if (
		(await git(root, ["rev-parse", "--verify", base + "^{commit}"], untrusted))
			.toString()
			.trim() !== base
	)
		fail("base_commit_mismatch");
	return root;
}
async function exportObjects(
	repo: string,
	base: string,
	budget: number,
	untrusted: string[],
): Promise<GitObject[]> {
	const objects = new Map<string, GitObject>();
	let total = 0,
		paths = 0,
		files = 0;
	const get = async (id: string, type: GitObject["type"]): Promise<Buffer> => {
		if (objects.has(id)) {
			const o = objects.get(id)!;
			if (o.type !== type) fail("wrong_object_type");
			return content(o);
		}
		if (objects.size >= FILES * 3 + 2) fail("input_object_limit");
		if (
			(await git(repo, ["cat-file", "-t", id], untrusted, undefined, 128))
				.toString()
				.trim() !== type
		)
			fail("wrong_object_type");
		const size = Number(
			(await git(repo, ["cat-file", "-s", id], untrusted, undefined, 128))
				.toString()
				.trim(),
		);
		if (!Number.isSafeInteger(size) || size < 0 || size > budget - total)
			fail("input_byte_limit");
		const bytes = await git(
			repo,
			["cat-file", type, id],
			untrusted,
			undefined,
			Math.max(size, 1),
		);
		total += bytes.length;
		if (bytes.length !== size || oid(type, bytes, base.length) !== id)
			fail("git_object_digest_mismatch");
		objects.set(id, {
			oid: id,
			type,
			size,
			sha256: sha256(bytes),
			contentBase64: bytes.toString("base64"),
		});
		return bytes;
	};
	const walk = async (
		id: string,
		prefix: string,
		depth: number,
	): Promise<void> => {
		if (depth > 256) fail("tree_depth_limit");
		for (const e of treeEntries(await get(id, "tree"), base.length)) {
			if (++paths > FILES * 3) fail("input_tree_entry_limit");
			pathName(prefix + e.name);
			if (e.mode === "40000")
				await walk(e.oid, prefix + e.name + "/", depth + 1);
			else if (e.mode === "100644" || e.mode === "100755") {
				if (++files > FILES) fail("input_file_limit");
				await get(e.oid, "blob");
			} else fail("unsupported_tree_entry");
		}
	};
	await walk(commitTree(await get(base, "commit"), base.length), "", 0);
	return [...objects.values()].sort((a, b) => a.oid.localeCompare(b.oid));
}
export async function previewInput(input: {
	repo: string;
	repoId: string;
	baseCommit: string;
	paths: string[];
	includeObjects: boolean;
	maxBytes?: number;
}): Promise<InputPackage> {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.baseCommit))
		fail("exact_commit_required");
	const budget = input.maxBytes ?? LIMIT;
	if (
		!Number.isSafeInteger(budget) ||
		budget < 1 ||
		budget > LIMIT ||
		typeof input.includeObjects !== "boolean" ||
		!Array.isArray(input.paths) ||
		input.paths.length > FILES
	)
		fail("invalid_input_limits");
	namesCheck(input.paths);
	const repo = await exactRepo(input.repo, input.baseCommit, []);
	const objects = await exportObjects(repo, input.baseCommit, budget, []);
	const pkg: InputPackage = {
		schemaVersion: 1,
		repoId: input.repoId,
		baseCommit: input.baseCommit,
		digest: "",
		changes: [],
		objects,
	};
	const entries = closure(pkg),
		byPath = new Map(entries.map((e) => [e.path, e]));
	namesCheck([...new Set([...entries.map((e) => e.path), ...input.paths])]);
	let total = input.includeObjects
		? objects.reduce((n, o) => n + o.size, 0)
		: 0;
	for (const path of [...input.paths].sort()) {
		await safeParents(repo, path);
		const entry = byPath.get(path),
			before = entry
				? {
						sha256: objects.find((o) => o.oid === entry.oid)!.sha256,
						mode: entry.mode,
					}
				: null;
		let after: After | null = null;
		try {
			const stat = await lstat(join(repo, path));
			if (!stat.isFile() || stat.nlink !== 1) fail("unsupported_source_entry");
			const bytes = await readOwnedFile(repo, path, budget);
			const end = await lstat(join(repo, path));
			if (
				stat.ino !== end.ino ||
				stat.mode !== end.mode ||
				stat.mtimeMs !== end.mtimeMs ||
				stat.ctimeMs !== end.ctimeMs ||
				end.nlink !== 1
			)
				fail("source_changed");
			let mode: Mode = stat.mode & 0o111 ? 100755 : 100644;
			if (process.platform === "win32") {
				const index = (
					await git(repo, ["ls-files", "--stage", "-z", "--", path], [])
				)
					.toString("utf8")
					.split("\0")
					.filter(Boolean);
				if (
					index.length > 1 ||
					index.some(
						(row) =>
							!/^(100644|100755) [a-f0-9]+ 0\t/.test(row) ||
							row.slice(row.indexOf("\t") + 1) !== path,
					)
				)
					fail("source_index_conflict");
				mode = index.length
					? (Number(index[0]!.split(" ")[0]) as Mode)
					: 100644;
			}
			after = {
				bytes: bytes.length,
				sha256: sha256(bytes),
				contentBase64: bytes.toString("base64"),
				mode,
			};
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
		}
		if (!before && !after) fail("selected_path_missing");
		if (
			before &&
			after &&
			before.sha256 === after.sha256 &&
			before.mode === after.mode
		)
			continue;
		total += after?.bytes ?? 0;
		if (total > budget) fail("input_byte_limit");
		pkg.changes.push({ path, before, after });
	}
	if (!input.includeObjects) delete pkg.objects;
	pkg.digest = packageDigest(pkg);
	validateInputPackage(pkg);
	return pkg;
}

// Writes use directory descriptors and *at syscalls, never string-path traversal after opening root.
let native: ReturnType<typeof dlopen> | undefined;
type LibcSymbols = Record<string, (...args: unknown[]) => number>;
function libcSymbols(): LibcSymbols {
	return libc().symbols as unknown as LibcSymbols;
}
function libc() {
	if (process.platform !== "linux" && process.platform !== "darwin")
		fail("safe_writer_platform_unsupported");
	return (native ??= dlopen(
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{
			openat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
				returns: FFIType.i32,
			},
			mkdirat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
			renameat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
				returns: FFIType.i32,
			},
			linkat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
			unlinkat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		},
	));
}
const cstr = (s: string) => Buffer.from(s + "\0");
/**
 * openat(2) with O_CREAT. C declares it variadic: int openat(int, const char *, int, ...). Apple arm64 passes variadic
 * arguments on the stack, so a fixed four-argument FFI binding delivers `mode` in a register the callee never reads
 * (reported on macOS arm64 as mode 0100 for a requested 0600). On that platform bind nine int arguments instead:
 * x0-x7 hold the first eight, so the ninth lands in the first stack slot, where the callee reads its first variadic
 * argument. Other platforms keep the four-argument call. The nine-argument form follows a published Bun/macOS-arm64
 * workaround (Signet-AI/signetai#2033); it is not verified on a Mac by this repository's tests (see inputs.test.ts).
 */
let nativeCreate: ReturnType<typeof dlopen> | undefined;
export function openatCreate(dir: number, name: Buffer, flags: number, mode: number): number {
	if (process.platform === "darwin" && process.arch === "arm64") {
		nativeCreate ??= dlopen("/usr/lib/libSystem.B.dylib", {
			openat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i32],
				returns: FFIType.i32,
			},
		});
		return (nativeCreate.symbols as unknown as LibcSymbols).openat(dir, name, flags, 0, 0, 0, 0, 0, mode) as number;
	}
	return libcSymbols().openat(dir, name, flags, mode) as number;
}
function anchoredRoot(root: string): number {
	const flags =
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	let fd = openSync(parse(root).root, flags);
	try {
		for (const part of resolve(root)
			.slice(parse(root).root.length)
			.split(sep)
			.filter(Boolean)) {
			const next = libcSymbols().openat(fd, cstr(part), flags, 0) as number;
			if (next < 0) fail("unsafe_workspace_root");
			closeSync(fd);
			fd = next;
		}
		return fd;
	} catch (e) {
		closeSync(fd);
		throw e;
	}
}
function writeAnchored(
	root: number,
	path: string,
	after: After | null,
	before: Before | null,
): void {
	const fds: number[] = [],
		parts = path.split("/");
	let dir = root;
	try {
		for (const part of parts.slice(0, -1)) {
			let next = libcSymbols().openat(
				dir,
				cstr(part),
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				0,
			) as number;
			if (next < 0 && after) {
				if (libcSymbols().mkdirat(dir, cstr(part), 0o700) !== 0)
					fail("unsafe_write_parent");
				next = libcSymbols().openat(
					dir,
					cstr(part),
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
					0,
				) as number;
			}
			if (next < 0) fail("unsafe_write_parent");
			fds.push(next);
			dir = next;
		}
		const name = cstr(parts.at(-1)!);
		if (before) {
			const fd = libcSymbols().openat(
				dir,
				name,
				constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				0,
			) as number;
			if (fd < 0) fail("unsafe_write_leaf");
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMIT)
					fail("unsafe_write_leaf");
				const bytes = Buffer.alloc(stat.size);
				let offset = 0;
				while (offset < bytes.length) {
					const n = readSync(fd, bytes, offset, bytes.length - offset, null);
					if (!n) fail("short_read");
					offset += n;
				}
				if (
					sha256(bytes) !== before.sha256 ||
					(stat.mode & 0o111 ? 100755 : 100644) !== before.mode ||
					fstatSync(fd).nlink !== 1
				)
					fail("current_before_mismatch");
			} finally {
				closeSync(fd);
			}
		}
		if (!after) {
			if (libcSymbols().unlinkat(dir, name, 0) !== 0) fail("delete_failed");
			return;
		}
		const tmp = cstr(".fleet-input-" + randomBytes(16).toString("hex"));
		const fd = openatCreate(
			dir,
			tmp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		if (fd < 0) fail("atomic_write_failed");
		try {
			// Belt and braces: never write content into a file whose mode was not set by us.
			fchmodSync(fd, 0o600);
			const bytes = content(after);
			let offset = 0;
			while (offset < bytes.length) {
				const n = writeSync(fd, bytes, offset);
				if (!n) fail("short_write");
				offset += n;
			}
			fchmodSync(fd, after.mode === 100755 ? 0o755 : 0o644);
			fsyncSync(fd);
			if (
				before
					? libcSymbols().renameat(dir, tmp, dir, name) !== 0
					: libcSymbols().linkat(dir, tmp, dir, name, 0) !== 0
			)
				fail("atomic_publish_failed");
		} finally {
			closeSync(fd);
			libcSymbols().unlinkat(dir, tmp, 0);
		}
	} finally {
		for (const fd of fds.reverse()) closeSync(fd);
	}
}
async function safeParents(root: string, path: string): Promise<void> {
	let current = root;
	const parts = path.split("/");
	for (const [index, part] of parts.entries()) {
		let count = 0;
		try {
			for await (const entry of await opendir(current)) {
				if (++count > 4096) fail("directory_entry_limit");
				if (
					entry.name !== part &&
					entry.name.normalize("NFC").toLowerCase() ===
						part.normalize("NFC").toLowerCase()
				)
					fail("case_normalization_collision");
			}
		} catch (e: any) {
			if (e.code === "ENOENT") return;
			throw e;
		}
		if (index === parts.length - 1) return;
		current = join(current, part);
		try {
			const stat = await lstat(current);
			if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe_parent");
		} catch (e: any) {
			if (e.code === "ENOENT") return;
			throw e;
		}
	}
}
async function verifyCurrent(
	root: string,
	c: InputPackage["changes"][number],
): Promise<void> {
	await safeParents(root, c.path);
	if (!c.before) {
		// Check every existing parent, including when the leaf is absent.
		let current = root;
		for (const [i, part] of c.path.split("/").entries()) {
			current = join(current, part);
			try {
				const stat = await lstat(current);
				if (
					i === c.path.split("/").length - 1 ||
					!stat.isDirectory() ||
					stat.isSymbolicLink()
				)
					fail("current_file_conflict");
			} catch (e: any) {
				if (e.code === "ENOENT") return;
				throw e;
			}
		}
		return;
	}
	const bytes = await readOwnedFile(root, c.path, LIMIT),
		stat = await lstat(join(root, c.path));
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		sha256(bytes) !== c.before.sha256 ||
		(process.platform !== "win32" &&
			(stat.mode & 0o111 ? 100755 : 100644) !== c.before.mode)
	)
		fail("current_before_mismatch");
}
export async function applyInput(
	identity: WorkspaceIdentity,
	pkg: InputPackage,
): Promise<void> {
	validateInputPackage(pkg);
	if (
		!pkg.authorization ||
		(identity as WorkspaceIdentity & { inputPackageDigest?: string })
			.inputPackageDigest !== pkg.digest
	)
		fail("authorized_input_required");
	if (
		identity.schemaVersion !== 1 ||
		identity.baseCommit !== pkg.baseCommit ||
		identity.path === identity.repo ||
		resolve(identity.path) === resolve(identity.repo)
	)
		fail("workspace_base_or_root_mismatch");
	for (const id of [identity.taskId, identity.attemptId, identity.nodeId])
		if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) fail("invalid_identity");
	if (
		identity.path !== resolve(identity.path) ||
		identity.path !==
			join(
				dirname(identity.path),
				identity.taskId + "-" + identity.attemptId,
			) ||
		(await realpath(identity.path)) !== identity.path
	)
		fail("task_owned_root_required");
	const marker = JSON.parse(
		(
			await readOwnedFile(identity.path, ".fleet-identity.json", 16384)
		).toString(),
	);
	if (canonicalJson(marker) !== canonicalJson(identity))
		fail("workspace_identity_mismatch");
	const trees = workspaceTrees(identity);
	await exactRepo(identity.path, pkg.baseCommit, trees);
	if (
		(await git(identity.path, ["rev-parse", "HEAD"], trees))
			.toString()
			.trim() !== pkg.baseCommit
	)
		fail("workspace_head_mismatch");
	const objects = await exportObjects(
		identity.path,
		pkg.baseCommit,
		LIMIT,
		trees,
	);
	const entries = closure({ ...pkg, objects }),
		byPath = new Map(entries.map((e) => [e.path, e]));
	namesCheck([
		...new Set([
			...entries.map((e) => e.path),
			...pkg.changes.map((c) => c.path),
		]),
	]);
	for (const c of pkg.changes) {
		const e = byPath.get(c.path);
		if (
			!e
				? c.before !== null
				: !c.before ||
					c.before.mode !== e.mode ||
					c.before.sha256 !== objects.find((o) => o.oid === e.oid)!.sha256
		)
			fail("before_base_mismatch");
		await verifyCurrent(identity.path, c);
	}
	if (process.platform === "win32") {
		writeWindowsInput(identity.path, pkg.changes);
		for (const change of pkg.changes) {
			if (change.after === null)
				await git(
					identity.path,
					["update-index", "--force-remove", "--", change.path],
					trees,
				);
			else {
				const hash = (
					await git(
						identity.path,
						["hash-object", "-w", "--stdin"],
						trees,
						content(change.after),
						128,
					)
				)
					.toString()
					.trim();
				await git(
					identity.path,
					[
						"update-index",
						"--add",
						"--cacheinfo",
						String(change.after.mode),
						hash,
						change.path,
					],
					trees,
				);
			}
		}
		return;
	}
	const root = anchoredRoot(identity.path);
	try {
		for (const c of pkg.changes) {
			await verifyCurrent(identity.path, c);
			writeAnchored(root, c.path, c.after, c.before);
		}
	} finally {
		closeSync(root);
	}
}
/** `untrusted`: the trees, besides the new repository, that must not hold the Git program (a node passes its workspace root). */
export async function importRepository(
	destination: string,
	pkg: InputPackage,
	untrusted: string[] = [],
): Promise<string> {
	validateInputPackage(pkg);
	if (!pkg.authorization || !pkg.objects) fail("authorized_objects_required");
	const entries = closure(pkg),
		path = resolve(destination),
		parent = dirname(path);
	if (path !== destination || (await realpath(parent)) !== parent)
		fail("import_parent_required");
	// Non-recursive mkdir is the exclusive ownership boundary; never touch an existing destination.
	await mkdir(path, { mode: 0o700 });
	await git(
		path,
		[
			"init",
			"--quiet",
			"--template=",
			"--object-format=" + (pkg.baseCommit.length === 40 ? "sha1" : "sha256"),
		],
		untrusted,
	);
	for (const o of pkg.objects) {
		if (
			(
				await git(
					path,
					["hash-object", "-w", "-t", o.type, "--stdin"],
					untrusted,
					content(o),
					128,
				)
			)
				.toString()
				.trim() !== o.oid
		)
			fail("import_object_mismatch");
	}
	// Git's documented shallow boundary keeps the exact original commit while
	// declaring intentionally omitted ancestry, rather than leaving corrupt history.
	const shallow = (
		await git(path, ["rev-parse", "--git-path", "shallow"], untrusted)
	)
		.toString()
		.trim();
	if (resolve(path, shallow) !== join(path, ".git", "shallow"))
		fail("import_git_metadata_mismatch");
	await writeFile(resolve(path, shallow), pkg.baseCommit + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	await git(
		path,
		["update-ref", "--no-deref", "HEAD", pkg.baseCommit],
		untrusted,
	);
	await git(path, ["read-tree", pkg.baseCommit], untrusted);
	// Materialize only verified regular blobs: no checkout, filters, hooks, submodules or LFS.
	if (process.platform === "win32") {
		writeWindowsInput(
			path,
			entries.map((entry) => {
				const object = pkg.objects!.find((o) => o.oid === entry.oid)!;
				return {
					path: entry.path,
					before: null,
					after: {
						bytes: object.size,
						sha256: object.sha256,
						contentBase64: object.contentBase64,
						mode: entry.mode,
					},
				};
			}),
		);
		if (
			(await git(path, ["rev-parse", "HEAD"], untrusted)).toString().trim() !==
			pkg.baseCommit
		)
			fail("import_head_mismatch");
		return path;
	}
	const root = anchoredRoot(path);
	try {
		for (const e of entries) {
			const object = pkg.objects.find((o) => o.oid === e.oid)!;
			writeAnchored(
				root,
				e.path,
				{
					bytes: object.size,
					sha256: object.sha256,
					contentBase64: object.contentBase64,
					mode: e.mode,
				},
				null,
			);
		}
	} finally {
		closeSync(root);
	}
	if (
		(await git(path, ["rev-parse", "HEAD"], untrusted)).toString().trim() !==
		pkg.baseCommit
	)
		fail("import_head_mismatch");
	return path;
}
