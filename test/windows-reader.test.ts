import { expect, test } from "bun:test";
import {
	readWindowsAnchoredFile,
	type WindowsFileApi,
	type WindowsFileInfo,
} from "../src/windows-reader";

// Kernel contracts with controlled handles; NOT a real Windows/native-ABI test.
function fixture(
	patch: Partial<WindowsFileInfo> = {},
	path = "\\\\?\\C:\\tasks\\owned\\result.txt",
) {
	const bytes = Buffer.from("controlled Windows contract bytes");
	const closed: bigint[] = [];
	const readHandles: bigint[] = [];
	const normal: WindowsFileInfo = {
		attributes: 0,
		volume: 1,
		fileId: "file",
		size: bytes.length,
		links: 1,
		writeTime: "before",
		mode: 0o644,
	};
	const api: WindowsFileApi = {
		open(_path, directory) {
			return directory ? 1n : 2n;
		},
		info(handle) {
			return handle === 1n
				? { ...normal, attributes: 0x10, fileId: "root", size: 0 }
				: { ...normal, ...patch };
		},
		path(handle) {
			return handle === 1n ? "\\\\?\\C:\\tasks\\owned" : path;
		},
		read(handle) {
			readHandles.push(handle);
			return bytes;
		},
		close(handle) {
			closed.push(handle);
		},
	};
	return { api, bytes, closed, readHandles };
}
test("controlled Windows handle reader binds final path, volume and file identity and closes every handle", () => {
	const f = fixture();
	expect(
		readWindowsAnchoredFile("C:\\tasks\\owned", ["result.txt"], 4096, f.api),
	).toEqual({ bytes: f.bytes, mode: 0o644 });
	expect(f.closed).toEqual([2n, 1n]);
});
test("controlled Windows junction escape, sibling case alias, reparse, hardlink and oversized file are refused", () => {
	for (const [patch, path] of [
		[{}, "\\\\?\\C:\\outside\\secret"],
		[{}, "\\\\?\\C:\\tasks\\OWNED\\secret"],
		[{ volume: 2 }, undefined],
		[{ attributes: 0x400 }, undefined],
		[{ links: 2 }, undefined],
		[{ attributes: 0x10 }, undefined],
		[{ size: 5000 }, undefined],
	] as [Partial<WindowsFileInfo>, string | undefined][]) {
		const f = fixture(patch, path);
		expect(() =>
			readWindowsAnchoredFile("C:\\tasks\\owned", ["result.txt"], 4096, f.api),
		).toThrow("unsafe_windows_artifact");
		expect(f.closed).toEqual([2n, 1n]);
	}
});
test("controlled Windows same-root redirects, including excluded-looking targets, are refused before reading", () => {
	for (const path of [
		"\\\\?\\C:\\tasks\\owned\\.gjc\\sentinel.txt",
		"\\\\?\\C:\\tasks\\owned\\other\\sentinel.txt",
	]) {
		const f = fixture({}, path);
		expect(() =>
			readWindowsAnchoredFile(
				"C:\\tasks\\owned",
				["report", "sentinel.txt"],
				4096,
				f.api,
			),
		).toThrow("unsafe_windows_artifact");
		expect(f.readHandles).toEqual([]);
		expect(f.closed).toEqual([2n, 1n]);
	}
});
test("controlled Windows metadata changes, truncation and reserved paths cannot yield complete bytes", () => {
	const f = fixture();
	let reads = 0;
	const original = f.api.info;
	f.api.info = (h) =>
		h === 2n
			? { ...original(h), writeTime: ++reads === 1 ? "before" : "after" }
			: original(h);
	expect(() =>
		readWindowsAnchoredFile("C:\\tasks\\owned", ["result.txt"], 4096, f.api),
	).toThrow("windows_artifact_changed");
	for (const part of ["..", "CON.txt", "name:stream", "trailing.", "a\\b"]) {
		const p = fixture();
		expect(() =>
			readWindowsAnchoredFile("C:\\tasks\\owned", [part], 4096, p.api),
		).toThrow("unsafe_artifact_path");
		expect(p.closed).toEqual([]);
	}
	const p = fixture();
	p.api.read = () => Buffer.alloc(0);
	expect(() =>
		readWindowsAnchoredFile("C:\\tasks\\owned", ["result.txt"], 4096, p.api),
	).toThrow("windows_artifact_changed");
});
