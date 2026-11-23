import { expect, test } from "bun:test";
import { ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import type { InputPackage } from "../src/inputs";
import type { WindowsFileInfo } from "../src/windows-reader";
import {
	writeWindowsInput,
	windowsObjectAttributes,
	windowsObjectAttributesInline,
	windowsRenameInformation,
	windowsWriterShareAccess,
	type WindowsWriteApi,
} from "../src/windows-writer";

// Controlled handle contract tests ONLY. No actual Windows or native ABI proof.
test("writer native share policy permits directory target write opens without sharing ancestor deletion", () => {
	// This is a pure policy assertion, NOT proof of Windows rename success.
	expect(windowsWriterShareAccess(true)).toBe(0x3);
	expect(windowsWriterShareAccess(true) & 0x2).toBe(0x2);
	expect(windowsWriterShareAccess(true) & 0x4).toBe(0);
	expect(windowsWriterShareAccess(false)).toBe(0x1);
	expect(windowsWriterShareAccess(false) & (0x2 | 0x4)).toBe(0);
});
const root = "C:\\tasks\\owned";
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const before = (data: Buffer) => ({ sha256: sha(data), mode: 100644 as const });
const after = (data: Buffer) => ({
	...before(data),
	bytes: data.length,
	contentBase64: data.toString("base64"),
});
type Node = {
	path: string;
	bytes: Buffer;
	info: WindowsFileInfo;
	deleted?: boolean;
};
function fixture() {
	let next = 0n;
	const handles = new Map<bigint, Node>(),
		nodes = new Map<string, Node>(),
		closed: bigint[] = [],
		removed: string[] = [],
		published: string[] = [];
	const add = (path: string, bytes = Buffer.alloc(0), directory = false) => {
		const node: Node = {
			path,
			bytes,
			info: {
				attributes: directory ? 0x10 : 0,
				volume: 1,
				fileId: path,
				size: bytes.length,
				links: 1,
				writeTime: "stable",
				mode: 0o644,
			},
		};
		nodes.set(path, node);
		return node;
	};
	add(root, Buffer.alloc(0), true);
	const hold = (node: Node) => {
		const h = ++next;
		handles.set(h, node);
		return h;
	};
	const get = (h: bigint) => {
		const n = handles.get(h);
		if (!n) throw new Error("invalid_fake_handle");
		return n;
	};
	const api: WindowsWriteApi = {
		open(path) {
			const n = nodes.get(path);
			if (!n) throw new Error("missing_fake_root");
			return hold(n);
		},
		info(h) {
			return { ...get(h).info };
		},
		path(h) {
			return get(h).path;
		},
		read(h) {
			return Buffer.from(get(h).bytes);
		},
		close(h) {
			get(h);
			handles.delete(h);
			closed.push(h);
		},
		relative(parent, name, kind) {
			const path = get(parent).path + "\\" + name,
				n = nodes.get(path);
			if (kind === "create" || kind === "mkdir") {
				if (n) throw new Error("exclusive_create");
				return hold(add(path, Buffer.alloc(0), kind === "mkdir"));
			}
			return n ? hold(n) : null;
		},
		names(parent) {
			const prefix = get(parent).path + "\\";
			return [...nodes.keys()]
				.filter(
					(p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("\\"),
				)
				.map((p) => p.slice(prefix.length));
		},
		write(h, bytes) {
			const n = get(h);
			n.bytes = Buffer.from(bytes);
			n.info.size = bytes.length;
		},
		flush() {},
		publish(h, parent, name, replace) {
			const n = get(h),
				path = get(parent).path + "\\" + name;
			if (!replace && nodes.has(path)) throw new Error("no_clobber");
			nodes.delete(n.path);
			n.path = path;
			nodes.set(path, n);
			published.push(path);
		},
		remove(h) {
			const n = get(h);
			nodes.delete(n.path);
			removed.push(n.path);
			n.deleted = true;
		},
	};
	return { api, add, nodes, handles, closed, removed, published };
}
test("controlled writer modifies, creates nested binary and deletes using scoped handles", () => {
	const f = fixture(),
		old = Buffer.from("old"),
		binary = Buffer.from([0, 255, 1, 128]);
	f.add(root + "\\old", old);
	f.add(root + "\\gone", old);
	writeWindowsInput(
		root,
		[
			{ path: "old", before: before(old), after: after(binary) },
			{ path: "dir/new", before: null, after: after(binary) },
			{ path: "gone", before: before(old), after: null },
		],
		f.api,
	);
	expect(f.nodes.get(root + "\\old")!.bytes).toEqual(binary);
	expect(f.nodes.get(root + "\\dir\\new")!.bytes).toEqual(binary);
	expect(f.nodes.has(root + "\\gone")).toBe(false);
	expect(f.handles.size).toBe(0);
	expect(f.removed).toEqual([root + "\\gone"]);
	expect(f.published.length).toBe(2);
});
test("controlled writer rejects reparse, hardlink, nonregular, cross-volume and escaped handles", () => {
	for (const patch of [
		{ attributes: 0x400 },
		{ links: 2 },
		{ attributes: 0x10 },
		{ volume: 2 },
		{ size: 16 * 1024 * 1024 + 1 },
	]) {
		const f = fixture(),
			bytes = Buffer.from("old"),
			n = f.add(root + "\\file", bytes);
		Object.assign(n.info, patch);
		expect(() =>
			writeWindowsInput(
				root,
				[{ path: "file", before: before(bytes), after: null }],
				f.api,
			),
		).toThrow("unsafe_windows_input");
		expect(f.handles.size).toBe(0);
	}
	for (const escape of ["C:\\outside\\dir", "C:\\tasks\\OWNED\\dir"]) {
		const f = fixture();
		const n = f.add(root + "\\dir", Buffer.alloc(0), true);
		n.path = escape;
		expect(() =>
			writeWindowsInput(
				root,
				[{ path: "dir/new", before: null, after: after(Buffer.from("x")) }],
				f.api,
			),
		).toThrow("unsafe_windows_input");
		expect(f.handles.size).toBe(0);
	}
});
test("controlled parent reparse, root reparse and case/normalization siblings are refused", () => {
	for (const bad of ["root", "parent", "case", "normalization"]) {
		const f = fixture();
		if (bad === "root") f.nodes.get(root)!.info.attributes |= 0x400;
		if (bad === "parent")
			f.add(root + "\\dir", Buffer.alloc(0), true).info.attributes |= 0x400;
		if (bad === "case") f.add(root + "\\DIR", Buffer.alloc(0), true);
		if (bad === "normalization") f.add(root + "\\é");
		expect(() =>
			writeWindowsInput(
				root,
				[
					{
						path: bad === "normalization" ? "é" : "dir/new",
						before: null,
						after: after(Buffer.alloc(0)),
					},
				],
				f.api,
			),
		).toThrow();
		expect(f.handles.size).toBe(0);
	}
});
test("controlled before hash, metadata and unexpected existence conflicts fail closed", () => {
	for (const scenario of ["bytes", "missing", "present", "metadata"]) {
		const f = fixture(),
			old = Buffer.from("old");
		if (scenario !== "missing")
			f.add(
				root + "\\file",
				scenario === "bytes" ? Buffer.from("different") : old,
			);
		if (scenario === "metadata") {
			const read = f.api.read;
			f.api.read = (h, limit) => {
				const bytes = read(h, limit);
				f.nodes.get(root + "\\file")!.info.writeTime = "changed";
				return bytes;
			};
		}
		expect(() =>
			writeWindowsInput(
				root,
				[
					{
						path: "file",
						before: scenario === "present" ? null : before(old),
						after: after(Buffer.from("new")),
					},
				],
				f.api,
			),
		).toThrow("current_before_mismatch");
		expect(f.handles.size).toBe(0);
		expect(f.published).toEqual([]);
	}
});
test("controlled exclusive publication refuses a new destination appearing after validation", () => {
	const f = fixture(),
		flush = f.api.flush;
	f.api.flush = (h) => {
		flush(h);
		f.add(root + "\\file", Buffer.from("competitor"));
	};
	expect(() =>
		writeWindowsInput(
			root,
			[{ path: "file", before: null, after: after(Buffer.from("new")) }],
			f.api,
		),
	).toThrow("no_clobber");
	expect(f.nodes.get(root + "\\file")!.bytes.toString()).toBe("competitor");
	expect(f.handles.size).toBe(0);
	expect(f.removed.length).toBe(1);
	expect(f.removed[0]).toContain(".fleet-input-");
});
test("controlled failures clean only owned temporary leaves and always close handles", () => {
	for (const phase of ["write", "flush", "publish", "cleanup", "close"]) {
		const f = fixture();
		if (phase === "cleanup") {
			f.api.write = () => {
				throw new Error("write_failure");
			};
			f.api.remove = () => {
				throw new Error("cleanup_failure");
			};
		} else if (phase === "close") {
			const close = f.api.close;
			f.api.close = (h) => {
				close(h);
				throw new Error("close_failure");
			};
		} else
			f.api[phase as "write" | "flush" | "publish"] = () => {
				throw new Error(phase + "_failure");
			};
		expect(() =>
			writeWindowsInput(
				root,
				[{ path: "dir/file", before: null, after: after(Buffer.from("new")) }],
				f.api,
			),
		).toThrow();
		expect(f.handles.size).toBe(0);
		if (phase === "close") {
			expect(f.nodes.has(root + "\\dir\\file")).toBe(true);
			expect(f.removed).toEqual([]);
		} else if (phase !== "cleanup")
			expect(f.removed[0]).toContain(".fleet-input-");
	}
});
test("controlled malformed paths, structures, depth/count/byte limits are rejected before open", () => {
	const valid = { path: "file", before: null, after: after(Buffer.from("x")) };
	const cases: unknown[] = [
		null,
		[null],
		[{ ...valid, before: undefined }],
		[{ ...valid, before: null, after: null }],
		[valid, valid],
		[valid, { ...valid, path: "file/child" }],
		[valid, { ...valid, path: "FILE" }],
		Array.from({ length: 1025 }, (_, i) => ({ ...valid, path: String(i) })),
	];
	for (const path of [
		"../file",
		"/file",
		"a\\b",
		"C:file",
		"NUL.txt",
		"a.",
		"a ",
		"a//b",
		"x/".repeat(256) + "x",
		"a".repeat(256),
		"\uD800",
	])
		cases.push([{ ...valid, path }]);
	cases.push(
		[{ ...valid, after: { ...valid.after, bytes: 16 * 1024 * 1024 + 1 } }],
		[{ ...valid, after: { ...valid.after, contentBase64: "***" } }],
		[{ ...valid, before: { sha256: "invalid", mode: 100644 } }],
	);
	for (const changes of cases) {
		const f = fixture();
		expect(() =>
			writeWindowsInput(root, changes as InputPackage["changes"], f.api),
		).toThrow();
		expect(f.closed).toEqual([]);
	}
	const f = fixture();
	f.api.names = () => Array.from({ length: 4097 }, (_, i) => String(i));
	expect(() => writeWindowsInput(root, [valid], f.api)).toThrow(
		"directory_entry_limit",
	);
	expect(f.handles.size).toBe(0);
});
test("pure x64/arm64 layout builders encode Unicode byte lengths, pointers and rooted rename layout", () => {
	const object = windowsObjectAttributes(
		0x123456789n,
		"é😀",
		0x111122223333n,
		0x444455556666n,
	);
	expect(object.attributes.length).toBe(48);
	expect(object.attributes.readUInt32LE(0)).toBe(48);
	expect(object.attributes.readBigInt64LE(8)).toBe(0x123456789n);
	expect(object.attributes.readBigUInt64LE(16)).toBe(0x111122223333n);
	expect(object.attributes.readUInt32LE(24)).toBe(0);
	expect(object.unicode.length).toBe(16);
	expect(object.unicode.readUInt16LE(0)).toBe(6);
	expect(object.unicode.readUInt16LE(2)).toBe(8);
	expect(object.unicode.readBigUInt64LE(8)).toBe(0x444455556666n);
	expect(object.text.toString("utf16le")).toBe("é😀\0");
	for (const replace of [false, true]) {
		const rename = windowsRenameInformation(0x123456789n, "é😀", replace);
		expect(rename.length).toBe(26);
		expect(rename[0]).toBe(replace ? 1 : 0);
		expect(rename.subarray(1, 8).equals(Buffer.alloc(7))).toBe(true);
		expect(rename.readBigInt64LE(8)).toBe(0x123456789n);
		expect(rename.readUInt32LE(16)).toBe(6);
		expect(rename.subarray(20).toString("utf16le")).toBe("é😀");
	}
	for (const name of ["..", "a/b", "a\\b", "C:x", "CON", "name.", "\0"]) {
		expect(() => windowsObjectAttributes(1n, name, 2n, 3n)).toThrow();
		expect(() => windowsRenameInformation(1n, name, false)).toThrow();
	}
	expect(() => windowsRenameInformation(-1n, "safe", false)).toThrow();
});

test("single-allocation object attributes keep UNICODE_STRING and name inside the one buffer the call receives", () => {
	const base = 0x7ff600001000n;
	let seen: Buffer | undefined;
	const buffer = windowsObjectAttributesInline(0x123456789n, "é😀", (b) => ((seen = b), base));
	expect(seen).toBe(buffer);
	expect(buffer.length).toBe(64 + 8);
	expect(buffer.readUInt32LE(0)).toBe(48);
	expect(buffer.readBigInt64LE(8)).toBe(0x123456789n);
	expect(buffer.readUInt32LE(24)).toBe(0);
	// ObjectName points at the UNICODE_STRING at +48, whose Buffer points at the name at +64, both inside this buffer.
	expect(buffer.readBigUInt64LE(16)).toBe(base + 48n);
	expect(buffer.readUInt16LE(48)).toBe(6);
	expect(buffer.readUInt16LE(50)).toBe(8);
	expect(buffer.readBigUInt64LE(56)).toBe(base + 64n);
	expect(buffer.subarray(64).toString("utf16le")).toBe("é😀\0");
	// Same content as the two-pointer builder for the same pointers.
	const separate = windowsObjectAttributes(0x123456789n, "é😀", base + 48n, base + 64n);
	expect(buffer.subarray(0, 48).equals(separate.attributes)).toBe(true);
	expect(buffer.subarray(48, 64).equals(separate.unicode)).toBe(true);
	expect(buffer.subarray(64).equals(separate.text)).toBe(true);
	for (const name of ["..", "a/b", "a\\b", "C:x", "CON", "name.", "\0"])
		expect(() => windowsObjectAttributesInline(1n, name, () => 0n)).toThrow();
	expect(() => windowsObjectAttributesInline(0n, "safe", () => 0n)).toThrow();
});

test("single-allocation object attributes embed the addresses the FFI call will actually pass, with the real ptr()", () => {
	// Regression: on Bun 1.4.0 a write on a small Buffer after ptr() relocated it, leaving ObjectName/UNICODE_STRING.Buffer
	// pointing at the old storage (Windows NtCreateFile then saw a stale name). Uses bun:ffi ptr() on every OS.
	for (const name of ["probe.bin", "a", ".fleet-input-" + "ab".repeat(24), "\ud55c\uae00\ud83d\ude00.bin"])
		for (let i = 0; i < 200; i++) {
			const buffer = windowsObjectAttributesInline(7n, name, (b) => BigInt(ptr(b)));
			const callTime = BigInt(ptr(buffer));
			expect(buffer.readBigUInt64LE(16)).toBe(callTime + 48n);
			expect(buffer.readBigUInt64LE(56)).toBe(callTime + 64n);
		}
});
