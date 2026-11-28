import { expect, test } from "bun:test";
import { resourceReasons, type ResourceSample } from "../src/admission";

const GiB = 1024 ** 3;
const now = 50_000;
const valid: ResourceSample = {
	ok: true,
	at: now,
	cpuPct: 10,
	memTotal: 16 * GiB,
	memUsed: 4 * GiB,
	disks: [{ path: "/srv", total: 100 * GiB, used: 10 * GiB }],
};

test("invalid resource samples do not admit work even when the remaining measurements show headroom", () => {
	const reasons = (sample: ResourceSample) => resourceReasons("/srv/workspaces", sample, 0, now);
	expect(reasons(valid)).toEqual([]);
	const invalid: Array<[string, Partial<ResourceSample>, string]> = [
		["non-finite CPU", { cpuPct: -Infinity }, "resources_unknown"],
		["future receipt", { at: now + 1001 }, "resources_unknown"],
		["memory used exceeds total", { memUsed: 17 * GiB }, "resources_unknown"],
		["non-finite reclaimed memory", { memReclaimed: Infinity }, "resources_unknown"],
		["non-finite disk used", { disks: [{ path: "/srv", total: 100 * GiB, used: -Infinity }] }, "workspace_disk_unknown"],
		["disk used exceeds total", { disks: [{ path: "/srv", total: 100 * GiB, used: 101 * GiB }] }, "workspace_disk_unknown"],
	];
	for (const [label, changes, expected] of invalid) {
		expect([label, reasons({ ...valid, ...changes })]).toEqual([label, [expected]]);
	}
});
