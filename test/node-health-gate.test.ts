import { describe, expect, test } from "bun:test";
import { resourceObservation } from "../src/node-health-gate";
import type { NodeHealthHistory } from "../src/node-health";
import { DEFAULT_ADMISSION_POLICY, type ResourceSample } from "../src/admission";

// resourceObservation only calls history.monotonicNow().
const historyAt = (mono: number) => ({ monotonicNow: () => mono }) as unknown as NodeHealthHistory;
const ok: ResourceSample = { ok: true, at: 0, cpuPct: 99 };
const bad: ResourceSample = { ok: false, error: "x", at: 0 };
const maxAge = DEFAULT_ADMISSION_POLICY.maxSampleAgeMs;

describe("resourceObservation", () => {
	test("failed wall sample is a failure even without evidence", () => {
		expect(resourceObservation(historyAt(0), undefined, bad)).toBe(false);
	});
	test("failed evidence sample is a failure even if the wall sample is ok", () => {
		expect(resourceObservation(historyAt(5), { sample: bad, mono: 5 }, ok)).toBe(false);
	});
	test("no evidence means unobserved, never success", () => {
		expect(resourceObservation(historyAt(0), undefined, ok)).toBeNull();
		expect(resourceObservation(historyAt(0), undefined, undefined)).toBeNull();
	});
	test("fresh stamped evidence is success, and busy CPU is still success", () => {
		expect(resourceObservation(historyAt(1000), { sample: ok, mono: 1000 - maxAge }, undefined)).toBe(true);
	});
	test("stale evidence is unobserved", () => {
		expect(resourceObservation(historyAt(1000 + maxAge + 1), { sample: ok, mono: 1000 }, undefined)).toBeNull();
	});
	test("evidence stamped in the future or a NaN clock is unobserved", () => {
		expect(resourceObservation(historyAt(10), { sample: ok, mono: 11 }, undefined)).toBeNull();
		expect(resourceObservation(historyAt(Number.NaN), { sample: ok, mono: 1 }, undefined)).toBeNull();
	});
	test("a custom policy changes the age limit", () => {
		const policy = { ...DEFAULT_ADMISSION_POLICY, maxSampleAgeMs: 100 };
		expect(resourceObservation(historyAt(200), { sample: ok, mono: 50 }, undefined, policy)).toBeNull();
		expect(resourceObservation(historyAt(200), { sample: ok, mono: 100 }, undefined, policy)).toBe(true);
	});
});
