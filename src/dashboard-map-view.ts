import type { NodeConfig, Phase } from "./contracts";

export type DashboardTaskAttention =
	| "running" | "queued" | "failed" | "needs_confirmation" | "approval_required"
	| "unplaceable" | "collect_result" | "verify_result" | "settled";

export function dashboardTaskAttention(
	phase: Phase,
	evidence: { executionTerminal: boolean; exportReview: boolean; receiptConflict: boolean; resultSaved: boolean; unplaceable: boolean },
): DashboardTaskAttention {
	if (phase === "archived" || phase === "cancelled") return "settled";
	if (phase === "blocked_unknown" || phase === "cancel_unknown" || evidence.receiptConflict) return "needs_confirmation";
	switch (phase) {
		case "failed": return "failed";
		case "approval_required": return "approval_required";
		case "queued": return evidence.unplaceable ? "unplaceable" : "queued";
		case "completed_unverified":
			if (!evidence.executionTerminal) return "needs_confirmation";
			if (evidence.exportReview) return "approval_required";
			return evidence.resultSaved ? "verify_result" : "collect_result";
		case "succeeded": return "settled";
		case "preparing":
		case "dispatching":
		case "active": return "running";
	}
}

export interface DashboardSshEvidence { checkedAt: string; fresh: boolean }
export type DashboardSshDirection =
	| { status: "not_checked"; checkedAt: null }
	| { status: "observed" | "stale"; checkedAt: string };

export interface DashboardSshLink {
	nodeId: string;
	hubToNode: DashboardSshDirection;
	nodeToHub: DashboardSshDirection;
}

/** In-memory stream identity, never returned by the API or logged. */
export function dashboardSshRoute(node: NodeConfig): string {
	const transport = node.sdkTransport ?? node.transport;
	return JSON.stringify([node.os, transport.command, transport.args]);
}

/** No peer inference. No CLI, credentials, endpoint, argv, or error text in the projection. */
export function dashboardSshLinks(
	nodes: readonly NodeConfig[],
	evidence?: (node: NodeConfig) => DashboardSshEvidence | undefined,
): DashboardSshLink[] {
	return nodes.flatMap((node): DashboardSshLink[] => {
		if ((node.sdkTransport ?? node.transport).command !== "ssh") return [];
		const sample = evidence?.(node);
		return [{
			nodeId: node.id,
			hubToNode: sample
				? { status: sample.fresh ? "observed" : "stale", checkedAt: sample.checkedAt }
				: { status: "not_checked", checkedAt: null },
			nodeToHub: { status: "not_checked", checkedAt: null },
		}];
	});
}

export function dashboardSshEvidence(
	node: NodeConfig,
	sample: { checkedAt: string; receivedAt: number; route: string } | undefined,
	samplerHealthy: boolean,
	now: number,
	ttlMs: number,
): DashboardSshEvidence | undefined {
	if (!sample || sample.route !== dashboardSshRoute(node)) return undefined;
	const age = now - sample.receivedAt;
	return { checkedAt: sample.checkedAt, fresh: samplerHealthy && age >= 0 && age <= ttlMs };
}
