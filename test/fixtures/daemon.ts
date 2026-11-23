// Controlled in-process node transports for `fleet daemon` tests. NOT GJC and no remote/OS proof: the
// daemon, Fleet.inspect, returnResources and the store run unmodified; only the node side is faked.
import { join } from "node:path";
import { existsSync, appendFileSync, writeFileSync } from "node:fs";
import type { NodeConfig } from "../../src/contracts";
import { observationDigest } from "../../src/core";
import type { Fleet } from "../../src/fleet";
import type { FleetStore } from "../../src/store";
import { sha256 } from "../../src/workspace";

export function node(id: string, dir: string, os: string = process.platform): NodeConfig {
	return {
		id, os, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false,
		reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"],
		transport: { command: process.execPath, args: [] }, sdkTransport: { command: process.execPath, args: [] },
	} as NodeConfig;
}
export const input = (key: string, prompt = "daemon test") => ({ schemaVersion: 1, key, caller: "daemon-test", repoId: "repo", baseCommit: "a".repeat(40), prompt, required: {} });

/** Reserves a new task on exactly `nodeId` (other nodes are disabled for the reservation only). */
export function reserveOn(store: FleetStore, nodeId: string, key: string, prompt?: string) {
	const nodes = store.nodes();
	for (const n of nodes) if (n.id !== nodeId && n.enabled) store.putNode({ ...n, enabled: false });
	try {
		return store.reserve(store.submit(input(key, prompt) as any).id)!;
	} finally {
		for (const n of nodes) if (n.id !== nodeId && n.enabled) store.putNode(n);
	}
}
/** An active task with an exact session and turn on `nodeId`. */
export function activeOn(store: FleetStore, nodeId: string, key: string, prompt?: string): string {
	const t = reserveOn(store, nodeId, key, prompt);
	store.recordSession(t.id, `session-${t.id}`, true);
	store.recordTurn(t.id, `turn-${t.id}`);
	return t.id;
}
/** A settled task (terminal, result collected, original session authority): eligible for resource return. */
export function settledOn(store: FleetStore, dir: string, nodeId: string, key: string): string {
	const t = reserveOn(store, nodeId, key);
	const identity = { schemaVersion: 1, taskId: t.id, attemptId: t.attemptId!, nodeId, inputDigest: t.inputDigest, path: join(dir, "work", `${t.id}-${t.attemptId}`), repo: dir, baseCommit: "a".repeat(40) };
	store.setWorkspace(t.id, identity as any);
	const create = store.claimOperation(t.id, "create", { cwd: identity.path })!;
	const session = `session-${t.id}`;
	store.recordSession(t.id, session, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
	store.recordSessionAuthority(t.id, { sessionId: session, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
	store.recordTurn(t.id, `turn-${t.id}`);
	const body = { sessionId: session, turnId: `turn-${t.id}`, status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
	store.observe(t.id, { eventId: `terminal-${t.id}`, digest: observationDigest(body), ...body });
	store.saveResult(t.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" } as any);
	return t.id;
}

export interface CoordinatorStats {
	reads: Map<string, number>;
	maxNodeConcurrency: Map<string, number>;
	maxTaskConcurrency: number;
	/** Any Coordinator tool other than the two observation reads (a send would land here). */
	other: string[];
	nodeCalls: Map<string, { start: number; end: number }[]>;
}
/**
 * Fake Coordinator behind Fleet.connect: read_turn (exact turn, status from `status`) and list_questions.
 * `latency(nodeId)` is the duration of one read; concurrency is counted per node (connect..close) and per
 * session (read_turn).
 */
export function fakeCoordinator(fleet: Fleet, latency: (nodeId: string) => number, status: (sessionId: string) => string = () => "active"): CoordinatorStats {
	const stats: CoordinatorStats = { reads: new Map(), maxNodeConcurrency: new Map(), maxTaskConcurrency: 0, other: [], nodeCalls: new Map() };
	const nodeNow = new Map<string, number>();
	const taskNow = new Map<string, number>();
	(fleet as any).connect = async (n: NodeConfig) => {
		nodeNow.set(n.id, (nodeNow.get(n.id) ?? 0) + 1);
		stats.maxNodeConcurrency.set(n.id, Math.max(stats.maxNodeConcurrency.get(n.id) ?? 0, nodeNow.get(n.id)!));
		const start = Date.now();
		let closed = false;
		return {
			close() {
				if (closed) return;
				closed = true;
				nodeNow.set(n.id, nodeNow.get(n.id)! - 1);
				const calls = stats.nodeCalls.get(n.id) ?? [];
				calls.push({ start, end: Date.now() });
				stats.nodeCalls.set(n.id, calls);
			},
			async call(name: string, args: any) {
				if (name === "gjc_coordinator_read_turn") {
					const session = args.session_id as string;
					taskNow.set(session, (taskNow.get(session) ?? 0) + 1);
					stats.maxTaskConcurrency = Math.max(stats.maxTaskConcurrency, taskNow.get(session)!);
					try {
						await Bun.sleep(latency(n.id));
						stats.reads.set(session, (stats.reads.get(session) ?? 0) + 1);
						return { ok: true, turn: { session_id: session, turn_id: args.turn_id, status: status(session) } };
					} finally {
						taskNow.set(session, taskNow.get(session)! - 1);
					}
				}
				if (name === "gjc_coordinator_list_questions") return { ok: true, reconciliation: { complete: true }, questions: [] };
				stats.other.push(name);
				throw new Error(`unexpected Coordinator tool ${name}`);
			},
		};
	};
	return stats;
}

/**
 * Fake SDK broker for resource return. Session liveness is persisted in `dir` (so it survives a killed
 * process): live until a fenced close is answered. Every close attempt is appended to closes.log BEFORE it
 * is answered, so a resend is visible across processes. `hold` keeps a close unanswered until released.
 */
export function fakeBroker(dir: string, store: FleetStore, options: { hold?: Promise<void> } = {}) {
	// The exact recorded incarnation (session-<taskId>, see settledOn) is what the node lists.
	const cwdOf = (sessionId: string) => (store.getOperation(sessionId.slice("session-".length), "session-authority")?.payload as any)?.cwd;
	const closedFile = join(dir, "closed");
	const log = join(dir, "closes.log");
	const stats = { lists: 0, closes: 0 };
	const connect = async () => ({
		list: async (sessionId: string) => {
			stats.lists++;
			const live = !existsSync(join(closedFile + "-" + sessionId));
			return { type: "broker_response", ok: true, result: { indexSeq: Date.now() * 1000 + stats.lists, sessions: live ? [{ sessionId, locator: { cwd: cwdOf(sessionId) }, endpointGeneration: 1, endpointIncarnation: "b".repeat(64), live: true, terminal: false, ambiguous: false, terminalUncertain: false }] : [] } };
		},
		stop: async () => { throw new Error("ID-only stop must never be used"); },
		fencedClose: async (authority: any, key: string) => {
			stats.closes++;
			appendFileSync(log, `${authority.sessionId} ${key}\n`);
			if (options.hold) await options.hold;
			writeFileSync(closedFile + "-" + authority.sessionId, "");
			return { ok: true, operation: "session.close", result: { sessionId: authority.sessionId } };
		},
		close() {},
	});
	return { connect, stats, log };
}
