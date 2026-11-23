import type { LateReceipt, ReceiptlessSettlement } from "./contracts";

/** Shared views carry fixed codes, never node error text. Raw evidence stays private. */
export function publicCommandError(value: unknown): string {
	return value === "broker_unavailable" ? "broker_unavailable" : "command_failed";
}
export function publicExitError(code: number | null): string {
	return code === null ? "query_timeout" : "command_failed";
}
export function publicSettlement(value: ReceiptlessSettlement): ReceiptlessSettlement {
	return { ...value, cause: value.kind === "failed_without_receipt" ? "failed_without_receipt" : "ended_without_receipt" };
}
export function publicLateReceipt(value: LateReceipt): LateReceipt {
	return { ...value, outcome: {} };
}
const TURN_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled", "superseded"]);
const SESSION_STATES = new Set(["active", "idle", "completed", "errored", "ended"]);
/** Deliberately no spread of publicTurn/questions: new SDK fields are private by default. */
export function publicPollDetails(value: unknown) {
	const result = value as { publicTurn?: { turn?: { status?: unknown }; session_state?: { state?: unknown } }; questions?: { questions?: unknown } } | undefined;
	const status = result?.publicTurn?.turn?.status;
	const state = result?.publicTurn?.session_state?.state;
	const questions = result?.questions?.questions;
	return {
		poll: {
			turnStatus: typeof status === "string" && TURN_STATUSES.has(status) ? status : "unknown",
			sessionState: typeof state === "string" && SESSION_STATES.has(state) ? state : "unknown",
		},
		...(Array.isArray(questions) ? { questionCount: questions.length } : {}),
	};
}

type InspectSnapshot = { publicTurn?: unknown; questions?: unknown; lateReceipt?: unknown };

/** Allowlisted CLI poll body: task summary, bounded poll fields, optional lateReceipt only. */
export function publicPollCliBody(inspect: InspectSnapshot, taskSummary: unknown): Record<string, unknown> {
	const body: Record<string, unknown> = { task: taskSummary, ...publicPollDetails(inspect) };
	if (inspect.lateReceipt) body.lateReceipt = publicLateReceipt(inspect.lateReceipt as LateReceipt);
	return body;
}