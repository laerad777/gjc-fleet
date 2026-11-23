import { dlopen, FFIType } from "bun:ffi";
import { win32 } from "node:path";

export interface WindowsFileInfo {
	attributes: number;
	volume: number;
	fileId: string;
	size: number;
	links: number;
	writeTime: string;
	mode: number;
}
export interface WindowsFileApi {
	open(path: string, directory: boolean, access?: number): bigint;
	info(handle: bigint): WindowsFileInfo;
	path(handle: bigint): string;
	read(handle: bigint, limit: number): Buffer;
	close(handle: bigint): void;
}
function canonicalPath(path: string): string {
	const value = path.startsWith("\\\\?\\") ? path.slice(4) : path;
	if (!/^[A-Za-z]:\\/.test(value) || value.includes("\0"))
		throw new Error("windows_local_drive_required");
	return win32.normalize(value).replace(/\\+$/, "");
}
export function readWindowsAnchoredFile(
	root: string,
	parts: string[],
	limit: number,
	api: WindowsFileApi = kernelApi(),
): { bytes: Buffer; mode: number } {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 0 ||
		limit > 16 * 1024 * 1024 ||
		!parts.length ||
		parts.length > 256 ||
		parts.some(
			(p) =>
				!p ||
				p === "." ||
				p === ".." ||
				/[\\/\x00-\x1f\x7f:<>"|?*]/.test(p) ||
				/[. ]$/.test(p) ||
				/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p),
		)
	)
		throw new Error("unsafe_artifact_path");
	canonicalPath(root);
	const handles: bigint[] = [];
	try {
		const rootHandle = api.open(root, true);
		handles.push(rootHandle);
		const rootInfo = api.info(rootHandle);
		if (!(rootInfo.attributes & 0x10) || rootInfo.attributes & 0x400)
			throw new Error("unsafe_windows_root");
		const rootPath = canonicalPath(api.path(rootHandle));
		if (rootPath !== canonicalPath(root))
			throw new Error("unsafe_windows_root");
		const fileHandle = api.open(win32.join(root, ...parts), false);
		handles.push(fileHandle);
		const before = api.info(fileHandle);
		const filePath = canonicalPath(api.path(fileHandle));
		if (
			filePath !== canonicalPath(win32.join(rootPath, ...parts)) ||
			before.volume !== rootInfo.volume ||
			before.attributes & (0x10 | 0x400) ||
			before.links !== 1 ||
			!Number.isSafeInteger(before.size) ||
			before.size < 0 ||
			before.size > limit
		)
			throw new Error("unsafe_windows_artifact");
		const bytes = api.read(fileHandle, before.size + 1);
		const after = api.info(fileHandle);
		if (
			bytes.length !== before.size ||
			JSON.stringify(before) !== JSON.stringify(after) ||
			canonicalPath(api.path(fileHandle)) !== filePath ||
			canonicalPath(api.path(rootHandle)) !== rootPath
		)
			throw new Error("windows_artifact_changed");
		return { bytes, mode: before.mode };
	} finally {
		for (const handle of handles.reverse()) api.close(handle);
	}
}
let implementation: WindowsFileApi | undefined;
export function kernelApi(): WindowsFileApi {
	if (
		process.platform !== "win32" ||
		(process.arch !== "x64" && process.arch !== "arm64")
	)
		throw new Error("windows_native_reader_unavailable");
	if (implementation) return implementation;
	const { symbols } = dlopen("kernel32.dll", {
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
		GetFileInformationByHandle: {
			args: [FFIType.i64, FFIType.ptr],
			returns: FFIType.i32,
		},
		GetFinalPathNameByHandleW: {
			args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.u32],
			returns: FFIType.u32,
		},
		GetFileType: { args: [FFIType.i64], returns: FFIType.u32 },
		ReadFile: {
			args: [FFIType.i64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
			returns: FFIType.i32,
		},
		CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
	});
	implementation = {
		open(path, directory, access) {
			const utf16 = Buffer.from(path + "\0", "utf16le");
			// No write/delete sharing: existing or new writers/renamers conflict.
			// OPEN_REPARSE_POINT refuses to follow a leaf reparse point; final
			// handle paths below also detect any intermediate junction redirect.
			const handle = BigInt(
				symbols.CreateFileW(
					utf16,
					access ?? (directory ? 0x80 : 0x80000000),
					1,
					null,
					3,
					0x00200000 | (directory ? 0x02000000 : 0x08000000),
					0n,
				),
			);
			if (handle === -1n || handle === 0n)
				throw new Error("windows_open_refused");
			return handle;
		},
		info(handle) {
			const info = Buffer.alloc(52);
			if (
				symbols.GetFileType(handle) !== 1 ||
				!symbols.GetFileInformationByHandle(handle, info)
			)
				throw new Error("windows_file_info_refused");
			return {
				attributes: info.readUInt32LE(0),
				volume: info.readUInt32LE(28),
				fileId: info.subarray(44, 52).toString("hex"),
				size: info.readUInt32LE(32) * 2 ** 32 + info.readUInt32LE(36),
				links: info.readUInt32LE(40),
				writeTime: info.subarray(20, 28).toString("hex"),
				mode: info.readUInt32LE(0) & 1 ? 0o444 : 0o644,
			};
		},
		path(handle) {
			const output = Buffer.alloc(32768 * 2);
			const count = symbols.GetFinalPathNameByHandleW(
				handle,
				output,
				32768,
				0,
			) as number;
			if (!count || count >= 32768)
				throw new Error("windows_final_path_refused");
			return output.subarray(0, count * 2).toString("utf16le");
		},
		read(handle, limit) {
			const buffer = Buffer.alloc(limit);
			let total = 0;
			while (total < limit) {
				const count = Buffer.alloc(4);
				if (
					!symbols.ReadFile(
						handle,
						buffer.subarray(total),
						limit - total,
						count,
						null,
					)
				)
					throw new Error("windows_read_refused");
				const n = count.readUInt32LE(0);
				if (!n) break;
				total += n;
			}
			return buffer.subarray(0, total);
		},
		close(handle) {
			if (!symbols.CloseHandle(handle)) throw new Error("windows_close_failed");
		},
	};
	return implementation;
}
