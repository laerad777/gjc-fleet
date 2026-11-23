// Review caba7bbd H1: with the stored switch off, every scheduling decision (submit-time selection,
// reserve, queue reconsider, pinned dispatch, operator run) is identical for ANY node history.
// Randomized workloads (seeded) are replayed through the patched tree with no node-health tables at
// all and with each history kind (empty, stable, mixed, recovering, random with clock anomalies and
// restarts, a corrupt state row, the switch toggled on and off, and a concurrent hub producer), and the
// normalized decisions, exclusions and audit events are compared. With FLEET_BASE_ROOT pointing at a
// pristine main extract, every seed is also replayed through main and must be identical.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ENFORCED, HISTORIES, runWorkload } from "./fixtures/node-health-workload";

const patched = fileURLToPath(new URL("..", import.meta.url));
const seeds = Number(process.env.FLEET_DIFF_SEEDS ?? 3);
const base = process.env.FLEET_BASE_ROOT;

for (let seed = 1; seed <= seeds; seed++) {
	test(`differential seed ${seed}: switch-off decisions are identical for every history${base ? " and to main" : ""}`, async () => {
		const reference = await runWorkload(patched, { seed, history: "none" });
		expect(reference.misuse).toEqual([]);
		if (base) expect((await runWorkload(base, { seed, history: "none" })).decisions).toEqual(reference.decisions);
		for (const history of HISTORIES.filter(kind => kind !== "none")) {
			const run = await runWorkload(patched, { seed, history });
			// The switch-off path never opens the supplied access (history or health sampling).
			expect({ history, misuse: run.misuse }).toEqual({ history, misuse: [] });
			expect({ history, decisions: run.decisions }).toEqual({ history, decisions: reference.decisions });
		}
	}, 300_000);
}

test("negative control: the same harness reports a difference when the switch is on", async () => {
	// Stops at the first differing seed; the harness must not report "identical" when the gate acts.
	let differs = false;
	for (let seed = 1; seed <= 5 && !differs; seed++) {
		const reference = await runWorkload(patched, { seed, history: "none" });
		const run = await runWorkload(patched, { seed, history: ENFORCED });
		differs = JSON.stringify(run.decisions) !== JSON.stringify(reference.decisions);
	}
	expect(differs).toBe(true);
}, 300_000);
