import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../src/workspace";

/**
 * Files that exist in the private repository but are left out of the public export
 * (see scripts/export-exclude.json), plus an optional ignore file. They are hashed when present.
 * They may be absent only in a public export tree (no `.git` entry at the root), where each absence
 * is recorded in `skipped`. In the repository itself a missing one still throws, as before.
 * Every other file is always required: a missing required file throws in either tree.
 */
export const OPTIONAL_HASH_FILES = ["ACCEPTANCE.md", "provenance.json", ".gitignore"] as const;

export interface TopLevelHashes {
	/** sha256 of each present top-level manifest file, in the order the manifest has always used. */
	files: Record<string, string>;
	/** Optional files absent from a public export tree, in that same order. Empty in the repository. */
	skipped: string[];
}

export interface HashTopLevelOptions {
	read?: (path: string) => Promise<{ exists: boolean; bytes: () => Promise<Uint8Array> }>;
	/** True when root is the repository, so the optional files are required. Default: a `.git` entry exists at the root. */
	isRepository?: (root: string) => boolean;
}

/** Hashes the manifest's top-level files under root, in the order the manifest has always used. */
export async function hashTopLevelFiles(root: string, options: HashTopLevelOptions = {}): Promise<TopLevelHashes> {
	const read = options.read ?? defaultRead;
	const isRepository = options.isRepository ?? defaultIsRepository;
	const publicTree = !isRepository(root);
	const order = ["package.json", "LICENSE", "NOTICE.md", "README.md", "UPSTREAM.md", "ACCEPTANCE.md", "license-inventory.json", "provenance.json", ".gitignore"];
	const files: Record<string, string> = {};
	const skipped: string[] = [];
	for (const name of order) {
		const optional = (OPTIONAL_HASH_FILES as readonly string[]).includes(name);
		const file = await read(`${root}/${name}`);
		if (!file.exists) {
			if (optional && publicTree) {
				skipped.push(name);
				continue;
			}
			throw new Error(`verify: required top-level file is missing: ${name}`);
		}
		files[name] = sha256(await file.bytes());
	}
	return { files, skipped };
}

function defaultIsRepository(root: string): boolean {
	// `.git` may be a directory or a gitfile (worktree, submodule); the public export has neither.
	return existsSync(join(root, ".git"));
}

async function defaultRead(path: string) {
	const file = Bun.file(path);
	return { exists: await file.exists(), bytes: () => file.bytes() };
}
