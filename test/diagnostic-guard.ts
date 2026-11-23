// Completeness guard for failure diagnostics (review 9fbbbd8d F-1). Not a test file: it is installed by
// catch-site-behaviour.test.ts for its whole run and by the injected-failure matrix harness.
//
// It observes the store at run time and never reads source text: every call of a state-converting store
// method and every converting audit event the store writes (including the Store.transaction refusal
// writer) is checked while the guard is installed. A conversion that arrives without a valid
// deny-by-default diagnostic is recorded as a violation, so an unlisted or regressed site is found by
// executing it. Violations are collected, not thrown: a throw inside the refusal writer would be
// swallowed as telemetry, and throwing would change the behaviour under test.
import { normalizeDiagnostic } from "../src/diagnostic";

/** Audit events that record an error/refusal turned into unknown/blocked/refused/node-blocked. */
export const CONVERTING_EVENTS = [
	"unknown",
	"blocked",
	"stale_poll_failure",
	"abandoned_poll",
	"cancel_unknown",
	"refused",
	"node_operation_failure",
	"preparation_reevaluation",
	"result_validation_rejected",
	"resource_return_unknown",
	"resource_return_blocked_by_node",
	"resource_return_operator_override",
	"create_refused",
	"verification_conflict",
	"verification_owner_gone",
	"resource_return_refused",
] as const;
/** resource_return_unknown reasons that are observations (no error, no refusal) and carry no diagnostic by design. */
export const OBSERVATION_REASONS: ReadonlySet<string> = new Set([
	"listing_changed_between_observations",
	"host_liveness_unproven",
	"close_acknowledged_awaiting_terminal_listing",
]);
/** Operator release of a task without a recorded session/node: the listing is unavailable by precondition, not by a failure. */
const NO_SESSION_LISTING = "no_recorded_session_or_node";

type Args = unknown[];
/** State-converting store methods: position of the diagnostic argument and when one is required. */
const METHODS: Record<string, { index: number; required?: (args: Args) => boolean; each?: (value: unknown) => unknown[] }> = {
	markUnknown: { index: 3 },
	markObservationUnknown: { index: 4 },
	markBlocked: { index: 2 },
	abandonObservation: { index: 3 },
	cancellationUnknown: { index: 3 },
	recordResultValidationRejected: { index: 2 },
	recordPreparationReevaluation: { index: 4 },
	settleCreateRefusal: { index: 3 },
	recordVerificationConflict: { index: 2 },
	recordVerifierOwnerGone: { index: 3 },
	recordResourceReturnUnknown: { index: 2, required: (a) => !OBSERVATION_REASONS.has(a[1] as string) },
	recordResourceReturnOutcome: { index: 4, required: (a) => a[1] === "resource_return_unknown" && !OBSERVATION_REASONS.has(a[2] as string) },
	blockResourceReturnNode: { index: 4 },
	recordResourceReturnRefused: { index: 0, each: (value) => (Array.isArray(value) ? value.map((r: any) => r?.diagnostic) : [undefined]) },
	overrideResourceReturn: { index: 3, required: (a) => (a[2] as any)?.kind === "unavailable" && (a[2] as any)?.error !== NO_SESSION_LISTING },
	// A failed lane-progress read is recorded as verdict unknown; it must carry the read's diagnostic.
	recordProgress: { index: 3, required: (a) => (a[2] as any)?.ok === false },
};

export type GuardEvent = { event: string; source?: string; phase?: string; errorClass?: string; code?: string; operationKind?: string; operationId?: string };
export type DiagnosticGuard = {
	/** Converting events written and violations found since the last take(); resets both. */
	take(): { events: GuardEvent[]; violations: string[] };
	/** Every violation since install (never reset). */
	readonly allViolations: readonly string[];
	/** Number of converting events and method calls checked since install. */
	readonly checked: { events: number; calls: number };
	/** Runs `fn` with the guard paused: only for calls made directly by a test or harness, never by Fleet. */
	exempt<T>(fn: () => T): T;
	active: boolean;
	uninstall(): void;
};

function valid(value: unknown): boolean {
	try {
		if (value === undefined || value === null) return false;
		const normalized = normalizeDiagnostic(value);
		return normalized !== undefined && JSON.stringify(normalized) === JSON.stringify(value);
	} catch {
		return false;
	}
}
function requiresDiagnostic(kind: string, data: any): boolean {
	if (!(CONVERTING_EVENTS as readonly string[]).includes(kind)) return false;
	if (kind === "resource_return_unknown") return !OBSERVATION_REASONS.has(data?.reason);
	if (kind === "resource_return_operator_override") return data?.freshListing?.kind === "unavailable" && data.freshListing.error !== NO_SESSION_LISTING;
	return true;
}

/** Wraps the prototype of `Store` (FleetStore of the tree under test). */
export function installDiagnosticGuard(Store: { prototype: any }): DiagnosticGuard {
	const proto = Store.prototype;
	const originals = new Map<string, unknown>();
	let events: GuardEvent[] = [];
	let violations: string[] = [];
	const allViolations: string[] = [];
	const checked = { events: 0, calls: 0 };
	let paused = 0;
	const guard: DiagnosticGuard = {
		take() {
			const out = { events, violations };
			events = [];
			violations = [];
			return out;
		},
		allViolations,
		checked,
		exempt<T>(fn: () => T): T {
			paused++;
			try {
				return fn();
			} finally {
				paused--;
			}
		},
		active: true,
		uninstall() {
			for (const [name, fn] of originals) proto[name] = fn;
			originals.clear();
		},
	};
	const on = () => guard.active && paused === 0;
	const violate = (text: string) => {
		violations.push(text);
		allViolations.push(text);
	};
	for (const [name, rule] of Object.entries(METHODS)) {
		const original = proto[name];
		if (typeof original !== "function") throw new Error("diagnostic guard: store method missing: " + name);
		originals.set(name, original);
		proto[name] = function (this: unknown, ...args: Args) {
			if (on() && (rule.required?.(args) ?? true)) {
				checked.calls++;
				if (!(rule.each?.(args[rule.index]) ?? [args[rule.index]]).every(valid)) violate(`call ${name}(${JSON.stringify(args[1] ?? null)}) without a valid diagnostic`);
			}
			return original.apply(this, args);
		};
	}
	const audit = proto.audit;
	if (typeof audit !== "function") throw new Error("diagnostic guard: store audit writer missing");
	originals.set("audit", audit);
	proto.audit = function (this: unknown, kind: string, data: any, ...rest: Args) {
		if (on() && (CONVERTING_EVENTS as readonly string[]).includes(kind)) {
			const d = data?.failureDiagnostic;
			if (requiresDiagnostic(kind, data)) {
				checked.events++;
				if (!valid(d)) violate(`event ${kind} (${JSON.stringify(data?.reason ?? data?.code ?? data?.action ?? null)}) without a valid diagnostic`);
			}
			events.push({ event: kind, ...(d && typeof d === "object" ? { source: d.source, phase: d.phase, errorClass: d.errorClass, code: d.code, ...(d.operationId ? { operationKind: d.operationKind, operationId: d.operationId } : {}) } : {}) });
		}
		return audit.call(this, kind, data, ...rest);
	};
	return guard;
}
