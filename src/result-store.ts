import { dlopen, FFIType } from "bun:ffi";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Json } from "./contracts";
import { canonicalJson, demand, FleetError } from "./core";

/**
 * Content-addressed storage for the large string fields of collected result
 * manifests. Externalisation is schema-driven: only these manifest fields may
 * move out of the SQLite row, and only when they are UTF-8 well-formed strings
 * of at least EXTERNAL_MIN_BYTES. Everything else (identity, test argv, cwd,
 * digests, unknown extra fields, receipts) stays inline, so validators always
 * read exactly what was stored.
 *
 *   patch
 *   files[i].contentBase64
 *   tests[i].stdout
 *   tests[i].stderr
 *
 * The persisted form keeps every blob reference in a separate `blobs` list,
 * never inside manifest data; the skeleton holds `null` at each externalised
 * location. Manifest values can therefore never be read as references.
 */
export const EXTERNAL_MIN_BYTES = 1024;
export type BlobPath =
	| ["patch"]
	| ["files", number, "contentBase64"]
	| ["tests", number, "stdout" | "stderr"];
export interface BlobRef {
	path: BlobPath;
	sha256: string;
	bytes: number;
}
export interface ExternalManifest {
	version: 1;
	/** SHA-256 of canonicalJson(original manifest); identical to digest(manifest). */
	digest: string;
	skeleton: Json;
	blobs: BlobRef[];
}
export interface ResultInventory {
	directory: string;
	referenced: { blobs: number; bytes: number };
	missing: { sha256: string; taskIds: string[] }[];
	corrupt: { sha256: string; taskIds: string[] }[];
	unreferenced: { sha256: string; bytes: number | null }[];
	temporary: string[];
	unknown: string[];
}

export const SHA = /^[a-f0-9]{64}$/;
export const TEMP = /^[a-f0-9]{64}\.tmp-[A-Za-z0-9]{6}$/;
const sha256 = (bytes: Buffer | string) =>
	createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Plain = Record<string, unknown>;
function plain(value: unknown): value is Plain {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}
function exactKeys(value: Plain, keys: string[]): boolean {
	const own = Object.keys(value).sort();
	return own.length === keys.length && own.every((key, i) => key === keys[i]);
}
function validPath(path: unknown): path is BlobPath {
	if (!Array.isArray(path)) return false;
	if (path.length === 1) return path[0] === "patch";
	return (
		path.length === 3 &&
		Number.isSafeInteger(path[1]) &&
		(path[1] as number) >= 0 &&
		((path[0] === "files" && path[2] === "contentBase64") ||
			(path[0] === "tests" && (path[2] === "stdout" || path[2] === "stderr")))
	);
}
/** Every location externalisation may use, in a fixed order. */
function* schemaPaths(manifest: unknown): Generator<BlobPath> {
	if (!plain(manifest)) return;
	yield ["patch"];
	const own = (key: string) =>
		Object.hasOwn(manifest, key) ? manifest[key] : undefined;
	const files = own("files");
	if (Array.isArray(files))
		for (let i = 0; i < files.length; i++) yield ["files", i, "contentBase64"];
	const tests = own("tests");
	if (Array.isArray(tests))
		for (let i = 0; i < tests.length; i++) {
			yield ["tests", i, "stdout"];
			yield ["tests", i, "stderr"];
		}
}
/** The owning plain object and key of a schema path, using own properties only. */
function slot(root: unknown, path: BlobPath): { parent: Plain; key: string } | undefined {
	if (!plain(root)) return undefined;
	if (path.length === 1)
		return Object.hasOwn(root, path[0]) ? { parent: root, key: path[0] } : undefined;
	const list = Object.hasOwn(root, path[0]) ? root[path[0]] : undefined;
	if (!Array.isArray(list) || path[1] >= list.length) return undefined;
	const parent = list[path[1]];
	return plain(parent) && Object.hasOwn(parent, path[2])
		? { parent, key: path[2] }
		: undefined;
}
function integrity(message: string): FleetError {
	return new FleetError("RESULT_INTEGRITY", message);
}
/** lstat that never follows a link; undefined when the path (or a parent) does not exist. */
function entry(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
		throw error;
	}
}
/**
 * L1: the store's own file policy, as for the database files. Every path
 * component from the result directory down must be a real directory or a
 * regular single-link file, never a symbolic link (Windows junctions included),
 * FIFO, socket or device. Symlink-free paths are not followed elsewhere.
 */
function plainDirectory(path: string, what: string): boolean {
	const stat = entry(path);
	if (!stat) return false;
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${what} is not a plain directory`);
	return true;
}
// O_NOFOLLOW/O_NONBLOCK do not exist on Windows (0 there); the lstat checks above apply everywhere.
const OPEN_BLOB = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

let kernel:
	| {
			CreateFileW: (...args: any[]) => bigint | number;
			FlushFileBuffers: (handle: bigint) => number;
			CloseHandle: (handle: bigint) => number;
	  }
	| undefined;
/**
 * Make a directory's entries durable. POSIX fsyncs the directory; Windows
 * opens it with GENERIC_WRITE and FILE_FLAG_BACKUP_SEMANTICS and calls
 * FlushFileBuffers, which node:fs cannot do. Filesystems that refuse
 * directory fsync (EINVAL/ENOTSUP) report false; every other failure throws.
 */
export function syncDirectory(path: string): boolean {
	if (process.platform === "win32") {
		kernel ??= dlopen("kernel32.dll", {
			CreateFileW: {
				args: [
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.ptr,
					FFIType.u32,
					FFIType.u32,
					FFIType.i64,
				],
				returns: FFIType.i64,
			},
			FlushFileBuffers: { args: [FFIType.i64], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
		}).symbols as any;
		// GENERIC_WRITE, share read|write|delete, OPEN_EXISTING, BACKUP_SEMANTICS.
		const handle = BigInt(
			kernel!.CreateFileW(
				Buffer.from(`${path}\0`, "utf16le"),
				0x40000000,
				7,
				null,
				3,
				0x02000000,
				0n,
			),
		);
		if (handle === -1n || handle === 0n)
			throw new Error("directory_flush_open_refused");
		try {
			if (!kernel!.FlushFileBuffers(handle))
				throw new Error("directory_flush_refused");
		} finally {
			kernel!.CloseHandle(handle);
		}
		return true;
	}
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
		return true;
	} catch (error) {
		if (
			["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			return false;
		throw error;
	} finally {
		closeSync(fd);
	}
}

export class ResultStore {
	private created = false;
	constructor(
		readonly directory: string,
		private readonly options: { readOnly?: boolean } = {},
	) {}

	/**
	 * Lossless, structure-preserving externalisation. Blobs are durable and
	 * the full rehydration is proven equal to the canonical original before the
	 * stored form is returned, so a row can never reference unreadable data.
	 */
	externalise(manifest: unknown): ExternalManifest {
		const canonical = canonicalJson(manifest);
		const skeleton = JSON.parse(canonical);
		const blobs: BlobRef[] = [];
		for (const path of schemaPaths(skeleton)) {
			const at = slot(skeleton, path);
			if (!at) continue;
			const value = at.parent[at.key];
			// Lone surrogates have no UTF-8 encoding; such strings stay inline,
			// where canonical JSON escapes them losslessly.
			if (
				typeof value !== "string" ||
				!value.isWellFormed() ||
				Buffer.byteLength(value) < EXTERNAL_MIN_BYTES
			)
				continue;
			blobs.push({ path, ...this.put(Buffer.from(value, "utf8")) });
			at.parent[at.key] = null;
		}
		const stored: ExternalManifest = {
			version: 1,
			digest: sha256(canonical),
			skeleton,
			blobs,
		};
		const encoded = canonicalJson(stored);
		if (canonicalJson(this.rehydrate(JSON.parse(encoded))) !== canonical)
			throw integrity("Result externalisation round trip mismatch");
		return JSON.parse(encoded);
	}

	/** Strictly validates the stored form, reads and verifies every blob, then the whole-manifest digest. */
	rehydrate(stored: unknown): Json {
		if (
			!plain(stored) ||
			!exactKeys(stored, ["blobs", "digest", "skeleton", "version"]) ||
			stored.version !== 1 ||
			typeof stored.digest !== "string" ||
			!SHA.test(stored.digest) ||
			!Array.isArray(stored.blobs)
		)
			throw integrity("Invalid externalised result manifest");
		const value = JSON.parse(canonicalJson(stored.skeleton));
		const seen = new Set<string>();
		for (const ref of stored.blobs) {
			if (
				!plain(ref) ||
				!exactKeys(ref, ["bytes", "path", "sha256"]) ||
				!validPath(ref.path) ||
				typeof ref.sha256 !== "string" ||
				!SHA.test(ref.sha256) ||
				!Number.isSafeInteger(ref.bytes) ||
				(ref.bytes as number) < 0 ||
				seen.has(JSON.stringify(ref.path))
			)
				throw integrity("Invalid result blob reference");
			seen.add(JSON.stringify(ref.path));
			const at = slot(value, ref.path);
			if (!at || at.parent[at.key] !== null)
				throw integrity("Result blob reference does not match the manifest skeleton");
			at.parent[at.key] = this.read(ref.sha256, ref.bytes as number);
		}
		if (sha256(canonicalJson(value)) !== stored.digest)
			throw integrity("Result manifest digest mismatch");
		return value;
	}

	/** Copy exactly the referenced blobs (verified at the source) and prove the target rehydrates. */
	copyTo(target: ResultStore, stored: unknown): BlobRef[] {
		const value = this.rehydrate(stored);
		const refs = (stored as ExternalManifest).blobs;
		for (const ref of refs) {
			const at = slot(value, ref.path)!;
			const copied = target.put(Buffer.from(at.parent[at.key] as string, "utf8"));
			if (copied.sha256 !== ref.sha256 || copied.bytes !== ref.bytes)
				throw integrity(`Result blob ${ref.sha256}: copy mismatch`);
		}
		target.rehydrate(stored);
		return refs;
	}

	/** Read-only: fully reads and verifies every referenced blob. */
	verifyReferenced(
		referenced: ReadonlyMap<string, { bytes: number; taskIds: string[] }>,
	): Pick<ResultInventory, "directory" | "referenced" | "missing" | "corrupt"> {
		const report: Pick<ResultInventory, "directory" | "referenced" | "missing" | "corrupt"> = {
			directory: this.directory,
			referenced: { blobs: referenced.size, bytes: 0 },
			missing: [],
			corrupt: [],
		};
		for (const [sha, { bytes, taskIds }] of referenced) {
			report.referenced.bytes += bytes;
			// Missing means absent without following links; anything present but not
			// plain (symlink, FIFO, directory) is reported as corrupt by read().
			if (
				!entry(this.directory) ||
				!entry(join(this.directory, sha)) ||
				!entry(join(this.directory, sha, "data"))
			) {
				report.missing.push({ sha256: sha, taskIds });
				continue;
			}
			try {
				this.read(sha, bytes);
			} catch {
				report.corrupt.push({ sha256: sha, taskIds });
			}
		}
		return report;
	}

	/**
	 * Lists entries that no reference names. Exact only while the caller holds
	 * the database write lock (an in-flight writer publishes blobs before its
	 * row commits).
	 */
	listEntries(
		referenced: ReadonlyMap<string, unknown>,
	): Pick<ResultInventory, "unreferenced" | "temporary" | "unknown"> {
		const report: Pick<ResultInventory, "unreferenced" | "temporary" | "unknown"> = {
			unreferenced: [],
			temporary: [],
			unknown: [],
		};
		for (const name of this.entries()) {
			if (SHA.test(name)) {
				if (referenced.has(name)) continue;
				// Size from lstat only: listing never opens (or blocks on) an entry.
				let size: number | null = null;
				try {
					const dir = entry(join(this.directory, name));
					const data = dir?.isDirectory() ? entry(join(this.directory, name, "data")) : undefined;
					if (data?.isFile()) size = data.size;
				} catch {}
				report.unreferenced.push({ sha256: name, bytes: size });
			} else if (TEMP.test(name)) report.temporary.push(name);
			else report.unknown.push(name);
		}
		return report;
	}

	/**
	 * Remove unreferenced blobs and abandoned temporary directories. The caller
	 * MUST hold the database write lock: every publication happens inside a
	 * write transaction, so no live writer can own a temporary directory or an
	 * uncommitted reference while the lock is held. Unknown entries are kept.
	 */
	collect(referenced: ReadonlyMap<string, unknown>): { removed: string[] } {
		demand(!this.options.readOnly, "READ_ONLY", "Store is read-only");
		const removed: string[] = [];
		for (const name of this.entries()) {
			if ((SHA.test(name) && !referenced.has(name)) || TEMP.test(name)) {
				rmSync(join(this.directory, name), { recursive: true, force: true });
				removed.push(name);
			}
		}
		if (removed.length) syncDirectory(this.directory);
		return { removed };
	}

	private entries(): string[] {
		// Never list (or let gc remove) through a symlinked result directory.
		try {
			if (!plainDirectory(this.directory, "Result directory")) return [];
		} catch (error) {
			throw integrity((error as Error).message);
		}
		return readdirSync(this.directory).sort();
	}

	private read(sha: string, size: number): string {
		try {
			if (!SHA.test(sha)) throw new Error("invalid digest");
			const bytes = this.readBlob(sha, size);
			if (sha256(bytes) !== sha) throw new Error("size or digest mismatch");
			return utf8.decode(bytes);
		} catch (error) {
			throw integrity(`Result blob ${sha}: ${(error as Error).message ?? String(error)}`);
		}
	}

	/**
	 * L1: lstat every component, open without following a final link and
	 * without blocking (a FIFO can never hang a reader), then fstat the open
	 * descriptor: a regular single-link file of exactly the referenced size.
	 */
	private readBlob(sha: string, size: number): Buffer {
		const dir = join(this.directory, sha);
		const file = join(dir, "data");
		if (!plainDirectory(this.directory, "Result directory") || !plainDirectory(dir, "Blob directory"))
			throw new Error("missing");
		const stat = entry(file);
		if (!stat) throw new Error("missing");
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("blob data is not a regular file");
		const fd = openSync(file, OPEN_BLOB);
		try {
			const opened = fstatSync(fd);
			if (!opened.isFile() || opened.nlink !== 1)
				throw new Error("blob data is not a regular single-link file");
			if (opened.size !== size) throw new Error("size or digest mismatch");
			// One spare byte detects growth after fstat.
			const buffer = Buffer.allocUnsafe(size + 1);
			let length = 0;
			for (;;) {
				const n = readSync(fd, buffer, length, buffer.length - length, null);
				if (n === 0) break;
				length += n;
				if (length === buffer.length) break;
			}
			if (length !== size) throw new Error("size or digest mismatch");
			return buffer.subarray(0, size);
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Publish immutable bytes as <sha256>/data. The data file is written and
	 * fsynced in a private temporary directory that is flushed, then the
	 * nonempty directory is renamed to its digest name; a directory rename
	 * cannot replace an existing publication, and an existing one is verified,
	 * never rewritten. The parent is flushed before the reference is returned.
	 */
	private put(bytes: Buffer): { sha256: string; bytes: number } {
		demand(!this.options.readOnly, "READ_ONLY", "Store is read-only");
		const sha = sha256(bytes);
		this.ensureDirectory();
		const target = join(this.directory, sha);
		const existing = entry(target);
		if (existing && (existing.isSymbolicLink() || !existing.isDirectory()))
			throw integrity(`Result blob ${sha}: Blob directory is not a plain directory`);
		if (!existing) {
			const temp = mkdtempSync(join(this.directory, `${sha}.tmp-`));
			try {
				const fd = openSync(join(temp, "data"), "wx", 0o600);
				try {
					writeFileSync(fd, bytes);
					fsyncSync(fd);
				} finally {
					closeSync(fd);
				}
				syncDirectory(temp);
				try {
					renameSync(temp, target);
				} catch (error) {
					// A concurrent publisher won; its entry is verified below like any other.
					if (!entry(target)) throw error;
				}
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
		}
		syncDirectory(this.directory);
		this.read(sha, bytes.length);
		return { sha256: sha, bytes: bytes.length };
	}

	private ensureDirectory(): void {
		if (this.created) return;
		let exists: boolean;
		try {
			exists = plainDirectory(this.directory, "Result directory");
		} catch (error) {
			throw integrity((error as Error).message);
		}
		if (!exists) {
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			syncDirectory(dirname(this.directory));
		}
		this.created = true;
	}
}
