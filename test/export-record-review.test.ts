import { expect, test } from "bun:test";
import type { OperationIntent } from "../src/contracts";
import { exportRecordCompleteness, exportRecordReview } from "../src/result-export";
import type { ResultManifest } from "../src/workspace";

const exclusionsV1 = (exportComplete: boolean): ResultManifest =>
	({
		exportComplete,
		exclusions: exportComplete ? [] : [{ path: "nested", reason: "nested_repository", outerTrackedEntries: 0 }],
		ignored: [],
		junk: [],
	}) as unknown as ResultManifest;

const legacy = (): ResultManifest =>
	({
		// No exportComplete / exclusions: legacy-v1.
	}) as unknown as ResultManifest;

const receipt = (observedExclusions: unknown): OperationIntent =>
	({
		receipt: { observedExclusions },
	}) as unknown as OperationIntent;

test("exportRecordCompleteness reuses exclusions-v1 manifest fields", () => {
	expect(exportRecordCompleteness(exclusionsV1(true))).toBe("complete");
	expect(exportRecordCompleteness(exclusionsV1(false))).toBe("incomplete");
});

test("legacy completeness is unknown without observation evidence", () => {
	expect(exportRecordCompleteness(legacy())).toBe("unknown");
	expect(exportRecordCompleteness(legacy(), {} as unknown as OperationIntent)).toBe("unknown");
	expect(exportRecordCompleteness(legacy(), { receipt: {} } as unknown as OperationIntent)).toBe("unknown");
});

test("legacy completeness follows observedExclusions on the result-test receipt", () => {
	// Export review judges complete/incomplete from observation evidence even when
	// the stored manifest omits exportComplete; fleet-export.json must match that judgment.
	expect(exportRecordCompleteness(legacy(), receipt([]))).toBe("complete");
	expect(
		exportRecordCompleteness(
			legacy(),
			receipt([{ path: "nested", reason: "nested_repository", outerTrackedEntries: 0 }]),
		),
	).toBe("incomplete");
});

test("exportRecordReview distinguishes required, accepted, and no-review", () => {
	expect(exportRecordReview(undefined)).toBeNull();
	expect(exportRecordReview({})).toBeNull();
	expect(exportRecordReview({ exportIncomplete: {} })).toBe("required");
	expect(
		exportRecordReview({
			exportIncomplete: {
				acceptance: { operator: "ops", reviewDigest: "x", acceptedAt: "t" },
			},
		}),
	).toBe("accepted");
});

test("accepted incomplete exports stay incomplete in the export-record pair", () => {
	const completeness = exportRecordCompleteness(exclusionsV1(false));
	const review = exportRecordReview({
		exportIncomplete: {
			acceptance: { operator: "ops", reviewDigest: "x", acceptedAt: "t" },
		},
	});
	expect(completeness).toBe("incomplete");
	expect(review).toBe("accepted");
});
