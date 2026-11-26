import { expect, test } from "bun:test";
import { validateInventory } from "../scripts/license-check";
const inventory = await Bun.file(
	new URL("../license-inventory.json", import.meta.url),
).json();
const lockText = await Bun.file(new URL("../bun.lock", import.meta.url)).text();
const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
test("license gate rejects unreviewed incorporation, dependency, short pin, misleading use and install hooks", () => {
	expect(() => validateInventory(inventory, pkg, lockText)).not.toThrow();
	for (const mutation of [
		(i: any) =>
			i.incorporatedFiles.push({
				source: "Apache file without preserved terms/NOTICE",
			}),
		(i: any) => i.npmDependencies.push("unreviewed"),
		(i: any) => (i.references[0].commit = "short-sha"),
		(i: any) => (i.references[0].incorporated = true),
		(i: any) => (i.references[0].terms = null),
		(i: any) => i.references.pop(),
	]) {
		const copy = structuredClone(inventory);
		mutation(copy);
		expect(() => validateInventory(copy, pkg, lockText)).toThrow();
	}
	expect(() =>
		validateInventory(inventory, {
			...pkg,
			dependencies: { unreviewed: "latest" },
		}, lockText),
	).toThrow();
	expect(() =>
		validateInventory(inventory, {
			...pkg,
			devDependencies: { ...pkg.devDependencies, unreviewed: "1.0.0" },
		}, lockText),
	).toThrow();
	expect(() =>
		validateInventory(inventory, {
			...pkg,
			devDependencies: { ...pkg.devDependencies, typescript: "^5.9.3" },
		}, lockText),
	).toThrow();
	expect(() =>
		validateInventory(inventory, {
			...pkg,
			scripts: { ...pkg.scripts, postinstall: "unreviewed command" },
		}, lockText),
	).toThrow();
	// Resolved lockfile closure must match the reviewed inventory exactly.
	const mutate = (f: (i: any) => void) => {
		const copy = structuredClone(inventory);
		f(copy);
		return copy;
	};
	const transitive = inventory.npmDevDependencies.findIndex((d: any) => !d.direct);
	expect(transitive).toBeGreaterThanOrEqual(0);
	expect(() => validateInventory(mutate((i) => i.npmDevDependencies.splice(transitive, 1)), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => i.npmDevDependencies.push({ ...i.npmDevDependencies[0] })), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => i.npmDevDependencies.push({ name: "extra", version: "1.0.0", terms: "MIT", integrity: i.npmDevDependencies[0].integrity })), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => (i.npmDevDependencies[0].integrity = "sha512-")), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => (i.npmDevDependencies[0].integrity = "sha512-" + "A".repeat(86) + "==")), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => (i.npmDevDependencies[0].terms = "  ")), pkg, lockText)).toThrow();
	expect(() => validateInventory(mutate((i) => (i.npmDevDependencies[0].version = "9.9.9")), pkg, lockText)).toThrow();
	// package.json and bun.lock must agree (frozen install would fail otherwise).
	expect(() => validateInventory(inventory, pkg, lockText.replace('"typescript": "5.9.3"', '"typescript": "^5.9.3"'))).toThrow();
	// Accept CRLF lockfiles (Windows checkout) when stripping a package line.
	expect(() => validateInventory(inventory, pkg, lockText.replace(/"undici-types": \["undici-types@8\.9\.0".*\r?\n/, ""))).toThrow();
	// Lockfile package name and the resolved version of direct deps must match the manifest/inventory.
	expect(() => validateInventory(inventory, pkg, lockText.replace('"typescript": ["typescript@5.9.3"', '"typescript": ["evil@5.9.3"'))).toThrow();
	const bumped = lockText.replace('"typescript": ["typescript@5.9.3"', '"typescript": ["typescript@5.9.4"');
	expect(() => validateInventory(inventory, pkg, bumped)).toThrow();
	expect(() =>
		validateInventory(
			mutate((i) => (i.npmDevDependencies.find((d: any) => d.name === "typescript").version = "5.9.4")),
			pkg,
			bumped,
		),
	).toThrow();
});
