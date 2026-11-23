import { demand } from "../src/core";

const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Resolved packages of bun.lock: key -> { name, version, integrity, deps }. */
function parseLock(lockText: string): { roots: Record<string, string>; packages: Map<string, { name: string; version: string; integrity: string; deps: string[] }> } {
	const packages = new Map<string, { name: string; version: string; integrity: string; deps: string[] }>();
	const line = /^\s*"([^"]+)": \["(@?[^"@]+)@([^"]+)", "", (\{.*\}), "(sha512-[^"]+)"\],?\s*$/;
	for (const raw of lockText.split(/\r?\n/)) {
		const m = line.exec(raw);
		if (!m) continue;
		demand(!packages.has(m[1]!), "LOCKFILE_DUPLICATE", "bun.lock lists a package key twice");
		const meta = JSON.parse(m[4]!);
		packages.set(m[1]!, { name: m[2]!, version: m[3]!, integrity: m[5]!, deps: Object.keys({ ...meta.dependencies, ...meta.optionalDependencies }) });
	}
	const root = /"devDependencies": \{([^}]*)\}/.exec(lockText);
	demand(root !== null, "LOCKFILE_FORMAT", "bun.lock workspace devDependencies not found");
	const roots: Record<string, string> = {};
	for (const m of root![1]!.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) roots[m[1]!] = m[2]!;
	return { roots, packages };
}

export function validateInventory(inventory: any, pkg: any, lockText: string): void {
	demand(
		inventory?.schemaVersion === 1 &&
			inventory.originalCodeLicense === "MIT" &&
			pkg.license === "MIT",
		"LICENSE_SCHEMA",
		"Original code license and inventory schema must match",
	);
	demand(
		Array.isArray(inventory.npmDependencies) &&
			inventory.npmDependencies.length === 0 &&
			Object.keys(pkg.dependencies ?? {}).length === 0,
		"DEPENDENCY_REVIEW_REQUIRED",
		"New dependencies need explicit resolved license and supply-chain review",
	);
	// Dev dependencies (typecheck only): the whole resolved bun.lock closure must equal the reviewed inventory.
	const lock = parseLock(lockText);
	const devs = pkg.devDependencies ?? {};
	demand(
		JSON.stringify(Object.entries(lock.roots).sort()) === JSON.stringify(Object.entries(devs).sort()),
		"LOCKFILE_MISMATCH",
		"bun.lock workspace devDependencies must equal package.json exactly",
	);
	const closure = new Map<string, { name: string; version: string; integrity: string }>();
	const walk = (name: string) => {
		const entry = lock.packages.get(name);
		demand(entry !== undefined, "LOCKFILE_MISMATCH", "bun.lock is missing a resolved dev dependency");
		demand(entry!.name === name || name.endsWith("/" + entry!.name), "LOCKFILE_MISMATCH", "bun.lock package key must resolve to the same package name");
		if (closure.has(name)) return;
		closure.set(name, entry!);
		for (const dep of entry!.deps) walk(dep);
	};
	for (const name of Object.keys(devs)) {
		demand(/^\d+\.\d+\.\d+$/.test(String(devs[name])), "DEPENDENCY_REVIEW_REQUIRED", "Dev dependencies need an exact pin");
		walk(name);
		demand(lock.packages.get(name)?.version === devs[name], "LOCKFILE_MISMATCH", "bun.lock resolved version must equal the exact package.json pin");
	}
	const reviewed: any[] = inventory.npmDevDependencies ?? [];
	demand(Array.isArray(inventory.npmDevDependencies) || Object.keys(devs).length === 0, "DEPENDENCY_REVIEW_REQUIRED", "npmDevDependencies inventory required");
	demand(new Set(reviewed.map((d) => d.name)).size === reviewed.length, "DEPENDENCY_REVIEW_REQUIRED", "Duplicate inventory entry");
	demand(reviewed.length === closure.size, "DEPENDENCY_REVIEW_REQUIRED", "Inventory must list exactly the resolved dev dependency closure");
	for (const d of reviewed) {
		const entry = closure.get(d.name);
		demand(
			entry !== undefined &&
				entry.name === d.name &&
				entry.version === d.version &&
				entry.integrity === d.integrity &&
				INTEGRITY.test(d.integrity) &&
				typeof d.terms === "string" &&
				/[A-Za-z]{2}/.test(d.terms.trim()),
			"DEPENDENCY_REVIEW_REQUIRED",
			"Dev dependency inventory entry must match bun.lock name, version and integrity, with a non-empty license terms",
		);
	}
	demand(
		Array.isArray(inventory.incorporatedFiles) &&
			inventory.incorporatedFiles.length === 0,
		"INCORPORATION_REVIEW_REQUIRED",
		"Actual incorporation requires per-file terms, original notices, modification markings and distribution license/NOTICE copies before acceptance",
	);
	demand(
		Array.isArray(inventory.references) && inventory.references.length === 6,
		"REFERENCE_INVENTORY",
		"Six fixed research references must be retained",
	);
	for (const ref of inventory.references)
		demand(
			/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(
				ref.repository,
			) &&
				/^[a-f0-9]{40}$/.test(ref.commit) &&
				ref.use === "reference-only" &&
				ref.incorporated === false &&
				typeof ref.terms === "string",
			"REFERENCE_PROVENANCE",
			"Reference full pins/use/terms must remain explicit; no Apache-to-MIT relabeling",
		);
	demand(
		!("preinstall" in (pkg.scripts ?? {})) &&
			!("postinstall" in (pkg.scripts ?? {})) &&
			!("install" in (pkg.scripts ?? {})),
		"SUPPLY_CHAIN_REVIEW",
		"Install lifecycle scripts require review",
	);
}
if (import.meta.main) {
	const pkg = await Bun.file("package.json").json();
	const inventory = await Bun.file("license-inventory.json").json();
	validateInventory(inventory, pkg, await Bun.file("bun.lock").text());
	const license = await Bun.file("LICENSE").text();
	const notice = await Bun.file("NOTICE.md").text();
	demand(
		license.includes("Permission is hereby granted") &&
			license.includes('THE SOFTWARE IS PROVIDED "AS IS"'),
		"LICENSE_COPY",
		"Original MIT license text required",
	);
	for (const ref of inventory.references)
		demand(
			notice.includes(ref.commit),
			"NOTICE_PIN",
			"Readable NOTICE must preserve each exact source pin",
		);
	console.log(
		JSON.stringify({
			ok: true,
			npmDependencies: 0,
			incorporatedFiles: 0,
			references: 6,
			apacheCodeIncorporated: false,
			legalAudit: false,
		}),
	);
}
