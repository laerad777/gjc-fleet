import { dlopen, FFIType } from "bun:ffi";
import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { parse, resolve, sep } from "node:path";
import { readWindowsAnchoredFile } from "./windows-reader";

// openat anchors every path component to an already-open directory. A lstat/realpath
// precheck alone is NOT a race-safe replacement for this boundary.
let native: ReturnType<typeof dlopen> | undefined;
function openAt(dir: number, name: string, flags: number): number {
	if (process.platform !== "darwin" && process.platform !== "linux")
		throw new Error("safe_reader_platform_unsupported");
	native ??= dlopen(
		process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
		{
			openat: {
				args: [FFIType.i32, FFIType.ptr, FFIType.i32],
				returns: FFIType.i32,
			},
		},
	);
	return (native.symbols as unknown as { openat: (...args: unknown[]) => number }).openat(dir, Buffer.from(name + "\0"), flags) as number;
}
export function readAnchoredFile(
	root: string,
	parts: string[],
	limit: number,
): { bytes: Buffer; mode: number } {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 0 ||
		limit > 16 * 1024 * 1024 ||
		!parts.length ||
		parts.length > 256 ||
		parts.some((p) => !p || p === "." || p === ".." || /[\\/\x00]/.test(p))
	)
		throw new Error("unsafe_artifact_path");
	if (process.platform === "win32")
		return readWindowsAnchoredFile(root, parts, limit);
	if (!constants.O_DIRECTORY || !constants.O_NOFOLLOW)
		throw new Error("safe_reader_platform_unsupported");
	if (realpathSync(root) !== resolve(root)) throw new Error("root_symlink");
	const flags =
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
	const fds: number[] = [];
	try {
		let dir = openSync(parse(root).root, flags | constants.O_DIRECTORY);
		fds.push(dir);
		for (const component of resolve(root)
			.slice(parse(root).root.length)
			.split(sep)
			.filter(Boolean)) {
			dir = openAt(dir, component, flags | constants.O_DIRECTORY);
			if (dir < 0) throw new Error("unsafe_artifact_root");
			fds.push(dir);
		}
		for (const name of parts.slice(0, -1)) {
			dir = openAt(dir, name, flags | constants.O_DIRECTORY);
			if (dir < 0) throw new Error("unsafe_artifact_parent");
			fds.push(dir);
		}
		const fd = openAt(dir, parts[parts.length - 1]!, flags);
		if (fd < 0) throw new Error("artifact_unavailable_or_unsafe");
		fds.push(fd);
		const before = fstatSync(fd);
		if (!before.isFile() || before.nlink !== 1 || before.size > limit)
			throw new Error("unsafe_artifact");
		const output = Buffer.alloc(before.size + 1);
		let total = 0;
		while (total < output.length) {
			const n = readSync(fd, output, total, output.length - total, null);
			if (!n) break;
			total += n;
		}
		const after = fstatSync(fd);
		if (
			total !== before.size ||
			after.size !== before.size ||
			after.mode !== before.mode ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			after.nlink !== 1
		)
			throw new Error("artifact_changed");
		return { bytes: output.subarray(0, total), mode: before.mode & 0o777 };
	} finally {
		for (const fd of fds.reverse()) closeSync(fd);
	}
}
export function readAnchored(
	root: string,
	parts: string[],
	limit: number,
): Buffer {
	return readAnchoredFile(root, parts, limit).bytes;
}
