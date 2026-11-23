import { renameSync, writeFileSync } from "node:fs";

/**
 * CONTROLLED stdio Coordinator stand-in for the A+B interaction tests (NOT GJC).
 * Same protocol as fixtures/coordinator.ts, but the session it starts is ephemeral
 * (so Fleet.start records the sdk-session-close-v1 retirement route and captures the
 * exact original session authority, which resource return needs), and read_turn
 * replays the verbatim reply stored in the state file. `readTurnGone` models a
 * coordinator that no longer knows the session after it was closed.
 */
export interface StackCoordinatorState {
	calls: { name: string; args: Record<string, any> }[];
	session?: { session_id: string; cwd: string; ephemeral: true };
	turnId?: string;
	readTurn?: Record<string, any>;
	readTurnGone?: boolean;
}

if (import.meta.main) {
	const statePath = process.argv[2];
	if (!statePath) throw new Error("controlled_state_path_required");
	const tools = ["start_session", "send_prompt", "read_turn", "list_questions", "submit_question_answer", "stop_session"].map((name) => ({
		name: "gjc_coordinator_" + name,
		inputSchema: { type: "object" },
	}));
	let buffer = "";
	const decoder = new TextDecoder();
	for await (const chunk of Bun.stdin.stream()) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			const request = JSON.parse(line);
			if (request.id === undefined) continue;
			let result: any;
			if (request.method === "initialize") {
				result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "CONTROLLED-not-real-GJC", version: "1" } };
			} else if (request.method === "tools/list") {
				result = { tools };
			} else if (request.method === "tools/call") {
				const state: StackCoordinatorState = await Bun.file(statePath).json();
				const { name, arguments: args } = request.params;
				state.calls.push({ name, args });
				let value: any;
				switch (name) {
					case "gjc_coordinator_start_session":
						state.session = { session_id: "controlled-session", cwd: args.cwd, ephemeral: true };
						value = { ok: true, session: state.session };
						break;
					case "gjc_coordinator_send_prompt":
						state.turnId = "controlled-turn";
						value = { ok: true, session_id: state.session?.session_id, turn_id: state.turnId, delivered: true };
						break;
					case "gjc_coordinator_read_turn":
						value = state.readTurnGone
							? { ok: false, error: { code: "session_not_found", message: "CONTROLLED: session closed" } }
							: state.readTurn;
						break;
					case "gjc_coordinator_list_questions":
						value = { ok: true, reconciliation: { complete: true }, questions: [] };
						break;
					default:
						throw new Error("unsupported_controlled_tool");
				}
				writeFileSync(statePath + ".tmp", JSON.stringify(state));
				renameSync(statePath + ".tmp", statePath);
				result = { structuredContent: value };
			} else {
				throw new Error("unsupported_controlled_method");
			}
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
		}
	}
}
