/** CLI surface of work-unit Step 1/1b (src/cli.ts dispatches `workunits` and `deliverable` here). */
import type { FleetStore } from "./store";
import { DeliverableUnavailable, disableWorkUnits, enableWorkUnits, recordDeliverable, workUnitStatus, type Operator } from "./work-unit";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

export function workUnitsCommand(store: FleetStore, args: string[]): number {
	const [, sub] = args;
	if (sub === "status" && args.length === 2) {
		print({ ok: true, ...workUnitStatus(store) });
		return 0;
	}
	if ((sub === "enable" || sub === "disable") && args.length === 4 && args[2] === "--reason" && args[3]) {
		const request = { actor: "operator", reason: args[3] };
		print({ ok: true, ...(sub === "enable" ? enableWorkUnits(store, request) : disableWorkUnits(store, request)) });
		return 0;
	}
	throw new Error("usage_workunits_status_enable_disable_--reason_TEXT");
}

const LEGACY_FLAGS = ["--legacy-report", "--sha256", "--role", "--actor", "--reason"] as const;
/** `deliverable TASK_ID` (path c) or Step 1b with every flag given exactly once (no bulk mode). */
function parseOperator(rest: string[]): Operator | undefined {
	if (!rest.length) return undefined;
	const usage = "usage_deliverable_TASK_ID_--legacy-report_PATH_--sha256_HEX_--role_review|report_--actor_NAME_--reason_TEXT";
	if (rest.length !== LEGACY_FLAGS.length * 2) throw new Error(usage);
	const value = new Map<string, string>();
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i]!;
		if (!(LEGACY_FLAGS as readonly string[]).includes(flag) || value.has(flag) || !rest[i + 1] || rest[i + 1]!.startsWith("--")) throw new Error(usage);
		value.set(flag, rest[i + 1]!);
	}
	const role = value.get("--role");
	if (role !== "review" && role !== "report") throw new Error("deliverable_role_review_or_report_required");
	const sha = value.get("--sha256")!;
	if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("deliverable_sha256_hex_required");
	for (const [flag, max] of [["--actor", 200], ["--reason", 1000]] as const) {
		const text = value.get(flag)!;
		if (!text.trim() || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error(`deliverable_${flag.slice(2)}_1_to_${max}_printable_characters`);
	}
	return { reportPath: value.get("--legacy-report")!, reportSha256: sha, role, actor: value.get("--actor")!, reason: value.get("--reason")! };
}

export async function deliverableCommand(store: FleetStore, args: string[]): Promise<number> {
	const [, id, ...rest] = args;
	if (!id || id.startsWith("--")) throw new Error("usage_deliverable_TASK_ID");
	const operator = parseOperator(rest);
	const { validateResult } = await import("./fleet");
	try {
		const outcome = recordDeliverable(store, id, { validate: validateResult, ...(operator ? { operator } : {}) });
		if (outcome.outcome === "not_ready") {
			print({ ok: false, taskId: id, outcome: "not_ready", reason: outcome.reason, verified: false });
			return 1;
		}
		print({ ok: true, taskId: id, outcome: "recorded", changed: outcome.changed, verified: false, record: outcome.record });
		return 0;
	} catch (error) {
		// A store or I/O failure is unknown: never printed as a rejection or a success.
		if (!(error instanceof DeliverableUnavailable)) throw error;
		print({ ok: false, taskId: id, outcome: "unavailable", verified: false });
		return 1;
	}
}
