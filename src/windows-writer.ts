import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash, randomBytes } from "node:crypto";
import { win32 } from "node:path";
import type { InputPackage } from "./inputs";
import {
	kernelApi,
	type WindowsFileApi,
	type WindowsFileInfo,
} from "./windows-reader";

const LIMIT = 16 * 1024 * 1024;
// A rename's IopOpenLinkOrRenameTarget opens the held target directory for
// FILE_WRITE_DATA | SYNCHRONIZE. Permit that write open, but never share DELETE:
// ancestors must remain pinned against deletion/rename. Leaves stay restrictive.
export function windowsWriterShareAccess(directory: boolean): number {
	return directory ? 0x1 | 0x2 : 0x1;
}
export interface WindowsWriteApi extends WindowsFileApi {
	// null means NAME/PATH_NOT_FOUND only. Creation is exclusive; no reparse traversal.
	relative(
		parent: bigint,
		name: string,
		kind: "directory" | "file" | "mkdir" | "create",
	): bigint | null;
	names(parent: bigint): string[];
	write(handle: bigint, bytes: Buffer): void;
	flush(handle: bigint): void;
	publish(handle: bigint, parent: bigint, name: string, replace: boolean): void;
	remove(handle: bigint): void;
}
function component(name: string): void {
	if (
		typeof name !== "string" ||
		!name ||
		name === "." ||
		name === ".." ||
		/[\\/\x00-\x1f\x7f:<>"|?*]/.test(name) ||
		/[. ]$/.test(name) ||
		/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name) ||
		name.length > 255 ||
		Buffer.from(name, "utf16le").toString("utf16le") !== name ||
		/[\uD800-\uDBFF](?:$|[^\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
			name,
		)
	)
		throw new Error("unsafe_windows_component");
}
function canonical(path: string): string {
	const value = path.startsWith("\\\\?\\") ? path.slice(4) : path;
	if (
		!/^[A-Za-z]:\\/.test(value) ||
		value.includes("\0") ||
		win32.normalize(value).replace(/\\+$/, "") !== value.replace(/\\+$/, "")
	)
		throw new Error("unsafe_windows_root");
	return value.replace(/\\+$/, "");
}
const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const key = (name: string) => name.normalize("NFC").toLowerCase();

// x64 and arm64 Windows use the same LLP64 layouts. Pointer values are supplied
// separately so these builders can be inspected without loading any Windows DLL.
export function windowsObjectAttributes(
	root: bigint,
	name: string,
	unicodePointer: bigint,
	textPointer: bigint,
): { attributes: Buffer; unicode: Buffer; text: Buffer } {
	component(name);
	const text = Buffer.from(name + "\0", "utf16le"),
		unicode = Buffer.alloc(16),
		attributes = Buffer.alloc(48);
	if (root <= 0n || root > 0x7fffffffffffffffn)
		throw new Error("invalid_windows_handle");
	unicode.writeUInt16LE(text.length - 2, 0);
	unicode.writeUInt16LE(text.length, 2);
	unicode.writeBigUInt64LE(textPointer, 8);
	attributes.writeUInt32LE(48, 0);
	attributes.writeBigInt64LE(root, 8);
	attributes.writeBigUInt64LE(unicodePointer, 16);
	// Attributes=0: exact-case component lookup, not OBJ_CASE_INSENSITIVE.
	return { attributes, unicode, text };
}
/**
 * Same layouts as windowsObjectAttributes, in ONE allocation: OBJECT_ATTRIBUTES (48) | UNICODE_STRING (16) | UTF-16 name.
 * The kernel sees the UNICODE_STRING and the name only through raw addresses written into the buffer, which the GC
 * cannot follow. With separate buffers the name and UNICODE_STRING can be collected before NtCreateFile reads them.
 * Here both live inside the one buffer that is passed to the call itself, so the call argument keeps all three alive.
 * `pointerOf` yields the buffer's native address; it is applied once, after allocation.
 */
export function windowsObjectAttributesInline(root: bigint, name: string, pointerOf: (buffer: Buffer) => bigint): Buffer {
	component(name);
	if (root <= 0n || root > 0x7fffffffffffffffn) throw new Error("invalid_windows_handle");
	const text = Buffer.from(name + "\0", "utf16le"),
		buffer = Buffer.alloc(64 + text.length);
	// Fill every non-pointer field BEFORE taking the address: on Bun 1.4.0 the first writeUInt16LE/writeUInt32LE on a
	// small Buffer relocates its storage, which would leave addresses taken earlier pointing at the old location.
	buffer.writeUInt32LE(48, 0);
	buffer.writeBigInt64LE(root, 8);
	buffer.writeUInt16LE(text.length - 2, 48);
	buffer.writeUInt16LE(text.length, 50);
	text.copy(buffer, 64);
	const base = pointerOf(buffer);
	buffer.writeBigUInt64LE(base + 48n, 16);
	buffer.writeBigUInt64LE(base + 64n, 56);
	// Fail closed if the storage still moved: the kernel would read a stale name.
	if (pointerOf(buffer) !== base) throw new Error("windows_attribute_buffer_moved");
	return buffer;
}
export function windowsRenameInformation(
	root: bigint,
	name: string,
	replace: boolean,
): Buffer {
	component(name);
	if (root <= 0n || root > 0x7fffffffffffffffn)
		throw new Error("invalid_windows_handle");
	const text = Buffer.from(name, "utf16le"),
		result = Buffer.alloc(Math.max(24, 20 + text.length));
	result[0] = replace ? 1 : 0;
	result.writeBigInt64LE(root, 8);
	result.writeUInt32LE(text.length, 16);
	text.copy(result, 20);
	return result;
}

/** Preparation-only writer for an exclusively owned workspace, before agents start.
 * No OS identity-conditional replacement is claimed: before handles are closed
 * immediately before replacement to satisfy Windows delete-sharing rules.
 * Git executable modes belong to the caller's index, never invented Windows ACLs.
 */
export function writeWindowsInput(
	root: string,
	changes: InputPackage["changes"],
	supplied?: WindowsWriteApi,
): void {
	const rootPath = canonical(root);
	if (!Array.isArray(changes) || changes.length > 1024)
		throw new Error("input_file_limit");
	let total = 0;
	const paths = new Map<string, string>(),
		leaves = new Set<string>();
	const prepared = changes.map((c) => {
		if (
			!c ||
			typeof c.path !== "string" ||
			rootPath.length + 1 + c.path.length > 32760 ||
			c.before === undefined ||
			c.after === undefined ||
			(!c.before && !c.after)
		)
			throw new Error("invalid_input_shape");
		const parts = c.path.split("/");
		if (parts.length > 256) throw new Error("input_depth_limit");
		parts.forEach(component);
		if (leaves.has(c.path)) throw new Error("duplicate_path");
		leaves.add(c.path);
		for (let i = 1; i <= parts.length; i++) {
			const prefix = parts.slice(0, i).join("/"),
				normalized = key(prefix);
			if (paths.has(normalized) && paths.get(normalized) !== prefix)
				throw new Error("case_normalization_collision");
			paths.set(normalized, prefix);
		}
		for (const entry of [c.before, c.after])
			if (
				entry &&
				(!/^[a-f0-9]{64}$/.test(entry.sha256) ||
					![100644, 100755].includes(entry.mode))
			)
				throw new Error("invalid_input_shape");
		let bytes: Buffer | null = null;
		if (c.after) {
			if (
				typeof c.after.contentBase64 !== "string" ||
				!Number.isSafeInteger(c.after.bytes) ||
				c.after.bytes < 0 ||
				c.after.bytes > LIMIT ||
				c.after.contentBase64.length > Math.ceil(LIMIT / 3) * 4
			)
				throw new Error("input_byte_limit");
			bytes = Buffer.from(c.after.contentBase64, "base64");
			total += bytes.length;
			if (total > LIMIT) throw new Error("input_byte_limit");
			if (
				bytes.length !== c.after.bytes ||
				bytes.toString("base64") !== c.after.contentBase64 ||
				digest(bytes) !== c.after.sha256
			)
				throw new Error("content_digest_mismatch");
		}
		return { c, parts, bytes };
	});
	for (const path of leaves) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++)
			if (leaves.has(parts.slice(0, i).join("/")))
				throw new Error("file_directory_collision");
	}
	const api = supplied ?? nativeWindowsWriteApi(),
		owned = new Set<bigint>();
	const own = (h: bigint) => {
		owned.add(h);
		return h;
	};
	const close = (h: bigint) => {
		owned.delete(h);
		api.close(h);
	};
	try {
		const anchor = own(api.open(root, true, 0x1000a1)),
			rootInfo = api.info(anchor);
		const check = (
			h: bigint,
			path: string,
			directory: boolean,
		): WindowsFileInfo => {
			const info = api.info(h);
			if (
				info.attributes & 0x400 ||
				!!(info.attributes & 0x10) !== directory ||
				info.volume !== rootInfo.volume ||
				(!directory &&
					(info.links !== 1 ||
						!Number.isSafeInteger(info.size) ||
						info.size < 0 ||
						info.size > LIMIT)) ||
				canonical(api.path(h)) !== path ||
				canonical(api.path(anchor)) !== rootPath
			)
				throw new Error("unsafe_windows_input");
			return info;
		};
		check(anchor, rootPath, true);
		for (const { c, parts, bytes } of prepared) {
			const parents: bigint[] = [];
			let parent = anchor,
				path = rootPath;
			let leaf: bigint | null = null,
				temp: bigint | null = null,
				published = false;
			try {
				for (let i = 0; i < parts.length; i++) {
					const name = parts[i]!;
					check(parent, path, true);
					const siblings = api.names(parent);
					if (siblings.length > 4096) throw new Error("directory_entry_limit");
					if (siblings.some((s) => s !== name && key(s) === key(name)))
						throw new Error("case_normalization_collision");
					if (i === parts.length - 1) break;
					let h = api.relative(parent, name, "directory");
					if (h === null && !c.before && c.after)
						h = api.relative(parent, name, "mkdir");
					if (h === null) throw new Error("current_before_mismatch");
					parent = own(h);
					parents.push(h);
					path += "\\" + name;
					check(h, path, true);
				}
				const name = parts.at(-1)!;
				leaf = api.relative(parent, name, "file");
				if (leaf !== null) own(leaf);
				if (!!c.before !== (leaf !== null))
					throw new Error("current_before_mismatch");
				if (leaf !== null) {
					const before = check(leaf, path + "\\" + name, false),
						data = api.read(leaf, before.size + 1);
					if (
						data.length !== before.size ||
						digest(data) !== c.before!.sha256 ||
						JSON.stringify(api.info(leaf)) !== JSON.stringify(before)
					)
						throw new Error("current_before_mismatch");
					check(leaf, path + "\\" + name, false);
				}
				if (!bytes) {
					api.remove(leaf!);
					continue;
				}
				const temporary = ".fleet-input-" + randomBytes(24).toString("hex");
				const created = api.relative(parent, temporary, "create");
				if (created === null) throw new Error("windows_temp_create_refused");
				temp = own(created);
				check(temp, path + "\\" + temporary, false);
				api.write(temp, bytes);
				api.flush(temp);
				check(temp, path + "\\" + temporary, false);
				check(parent, path, true);
				if (leaf !== null) {
					close(leaf);
					leaf = null;
				}
				api.publish(temp, parent, name, c.before !== null);
				published = true;
			} finally {
				try {
					if (temp !== null && !published) api.remove(temp);
				} finally {
					// Close every owned handle even if cleanup or another close fails.
					let error: unknown;
					for (const h of [temp, leaf, ...parents.reverse()])
						if (h !== null && owned.has(h)) {
							try {
								close(h);
							} catch (e) {
								error ??= e;
							}
						}
					if (error) throw error;
				}
			}
		}
	} finally {
		let error: unknown;
		for (const h of [...owned].reverse()) {
			try {
				close(h);
			} catch (e) {
				error ??= e;
			}
		}
		if (error) throw error;
	}
}

let implementation: WindowsWriteApi | undefined;
export function nativeWindowsWriteApi(): WindowsWriteApi {
	if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch))
		throw new Error(
			"windows_native_writer_unavailable_requires_win32_x64_or_arm64",
		);
	if (implementation) return implementation;
	const base = kernelApi();
	const { symbols: nt } = dlopen("ntdll.dll", {
		NtCreateFile: {
			args: [
				FFIType.ptr,
				FFIType.u32,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.u32,
				FFIType.u32,
				FFIType.ptr,
				FFIType.u32,
			],
			returns: FFIType.i32,
		},
		NtSetInformationFile: {
			args: [FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32],
			returns: FFIType.i32,
		},
		NtQueryDirectoryFile: {
			args: [
				FFIType.i64,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.ptr,
				FFIType.u32,
				FFIType.u32,
				FFIType.u8,
				FFIType.ptr,
				FFIType.u8,
			],
			returns: FFIType.i32,
		},
	});
	const { symbols: kernel } = dlopen("kernel32.dll", {
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
		WriteFile: {
			args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		FlushFileBuffers: { args: [FFIType.i64], returns: FFIType.i32 },
	});
	const status = (value: number) => {
		if (value !== 0)
			throw new Error("windows_nt_refused:0x" + (value >>> 0).toString(16));
	};
	const set = (h: bigint, data: Buffer, klass: number) =>
		status(
			nt.NtSetInformationFile(h, Buffer.alloc(16), data, data.length, klass),
		);
	implementation = {
		...base,
		open(path, directory, access) {
			if (!directory) return base.open(path, false, access);
			// Writer-only root policy. The reader retains its original share mask;
			// all metadata/path/read/close operations still use the shared base API.
			const handle = BigInt(
				kernel.CreateFileW(
					Buffer.from(path + "\0", "utf16le"),
					access ?? 0x1000a1,
					windowsWriterShareAccess(true),
					null,
					3,
					0x00200000 | 0x02000000,
					0n,
				),
			);
			if (handle === 0n || handle === -1n)
				throw new Error("windows_open_refused");
			return handle;
		},
		relative(parent, name, kind) {
			const attributes = windowsObjectAttributesInline(parent, name, (buffer) => BigInt(ptr(buffer)));
			const output = Buffer.alloc(8),
				iosb = Buffer.alloc(16),
				directory = kind === "directory" || kind === "mkdir",
				create = kind === "create" || kind === "mkdir";
			// SYNCHRONIZE + synchronous non-alert IO, OPEN_REPARSE_POINT;
			// Directories permit the rename target's write open but deny delete
			// sharing for their entire scope. Before/temp leaves deny both.
			const access = 0x100080 | (directory ? 0x21 : 0x10001 | (create ? 2 : 0));
			const result = nt.NtCreateFile(
				output,
				access,
				attributes,
				iosb,
				null,
				0,
				windowsWriterShareAccess(directory),
				create ? 2 : 1,
				0x200000 | 0x20 | (directory ? 1 : 0x40),
				null,
				0,
			);
			if (!create && [0xc0000034 | 0, 0xc000003a | 0].includes(result))
				return null;
			status(result);
			const handle = output.readBigInt64LE(0);
			if (handle === 0n || handle === -1n)
				throw new Error("windows_invalid_native_handle");
			return handle;
		},
		names(parent) {
			const names: string[] = [],
				buffer = Buffer.alloc(65536),
				iosb = Buffer.alloc(16);
			let restart = true;
			for (;;) {
				const result = nt.NtQueryDirectoryFile(
					parent,
					null,
					null,
					null,
					iosb,
					buffer,
					buffer.length,
					12,
					0,
					null,
					restart ? 1 : 0,
				);
				restart = false;
				if (result === (0x80000006 | 0)) return names;
				status(result);
				const length = Number(iosb.readBigUInt64LE(8));
				if (length < 12 || length > buffer.length)
					throw new Error("windows_directory_layout_refused");
				let offset = 0;
				for (;;) {
					if (offset + 12 > length)
						throw new Error("windows_directory_layout_refused");
					const next = buffer.readUInt32LE(offset),
						count = buffer.readUInt32LE(offset + 8);
					if (
						count % 2 ||
						count > length - offset - 12 ||
						(next && (next < 12 + count || next % 4 || offset + next >= length))
					)
						throw new Error("windows_directory_layout_refused");
					const name = buffer
						.subarray(offset + 12, offset + 12 + count)
						.toString("utf16le");
					if (name !== "." && name !== "..") names.push(name);
					if (names.length > 4096) throw new Error("directory_entry_limit");
					if (!next) break;
					offset += next;
				}
			}
		},
		write(h, bytes) {
			let offset = 0;
			while (offset < bytes.length) {
				const count = Buffer.alloc(4);
				if (
					!kernel.WriteFile(
						h,
						bytes.subarray(offset),
						bytes.length - offset,
						count,
						null,
					)
				)
					throw new Error("windows_write_refused");
				const n = count.readUInt32LE(0);
				if (!n || n > bytes.length - offset)
					throw new Error("windows_short_write");
				offset += n;
			}
		},
		flush(h) {
			if (!kernel.FlushFileBuffers(h)) throw new Error("windows_flush_refused");
		},
		publish(h, parent, name, replace) {
			set(h, windowsRenameInformation(parent, name, replace), 10);
		},
		remove(h) {
			set(h, Buffer.from([1]), 13);
		},
	};
	return implementation;
}
