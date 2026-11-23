import { mkdtemp, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/workspace";

/** CONTROLLED protocol fixture. This is NOT GJC and provides no live SDK/OS proof. */
export interface ControlledState {
	calls: { name: string; args: Record<string, any> }[];
	session?: { session_id: string; cwd: string };
	turnId?: string;
	lose?: "start" | "send" | "read";
	terminal?: boolean;
	sessionCwdMismatch?: boolean;
	terminalFault?:
		| "queued"
		| "unacknowledged"
		| "no_runtime"
		| "empty_runtime"
		| "metadata"
		| "not_live"
		| "streaming"
		| "wrong_session"
		| "wrong_turn";
	questions?: "bound" | "absent" | "stale";
	questionsComplete?: boolean;
	sidecarTurnOmitted?: boolean;
	/** Verbatim read_turn reply, for replaying recorded production evidence shapes. */
	readTurn?: Record<string, any>;
	/** Persist the effect, then delay its acknowledgement by hangMs (a genuinely in-flight call); "read" delays read_turn. */
	hang?: "start" | "send" | "read";
	hangMs?: number;
	/** Delay every read_turn / list_questions reply by this many ms (a Coordinator reconciling a running turn). */
	readDelayMs?: number;
	/** Verbatim `isError` tool reply for start_session (a create refusal); no session is recorded. */
	refuseStart?: Record<string, any>;
}

// Every commit and cleanup belongs to this canonical temporary directory, never upstream.
export async function repositoryFixture(prefix: string) {
	// Git for Windows bounds $GIT_DIR even with core.longpaths. Keep private fixture
	// basenames short under deeply nested workspace-local TEMP roots; mkdtemp owns uniqueness.
	const dir = await realpath(await mkdtemp(join(tmpdir(), process.platform === "win32" ? prefix.slice(0, 2) : prefix)));
	const repo = join(dir, "repo");
	await mkdir(repo);
	async function git(...args: string[]) {
		const result = await run(
			[
				"git",
				"-c",
				"core.hooksPath=" + join(dir, "disabled-hooks"),
				"-c",
				"commit.gpgsign=false",
				"-c",
				"core.fsmonitor=false",
				"-C",
				repo,
				...args,
			],
			repo,
		);
		if (result.exit !== 0)
			throw new Error(`fixture git ${args[0]}: ${result.stderr}`);
		return result.stdout.trimEnd();
	}
	await git("init");
	await git("config", "user.name", "Fleet controlled fixture");
	await git("config", "user.email", "fixture@example.invalid");
	await writeFile(join(repo, "tracked.txt"), "base bytes\n");
	await writeFile(join(repo, "deleted.txt"), "delete me\n");
	await git("add", "--", "tracked.txt", "deleted.txt");
	await git("commit", "-m", "task-owned fixture base");
	const baseCommit = await git("rev-parse", "HEAD");
	return { dir, repo, baseCommit, workspaceRoot: join(dir, "workspaces"), git };
}

/** Printed once on stderr when a concurrent reader defers the state replace (a test barrier). */
const STATE_REPLACE_DEFERRED = "controlled fixture: state replace deferred by a concurrent reader";

// Windows refuses to rename over a file that another process holds open (EPERM/EACCES/EBUSY); here that
// is a sibling fixture process reading the state. POSIX never refuses. Retry until that read closes the
// file, bounded (~10 s) so a stuck reader still fails visibly instead of hanging the test.
async function replaceState(temporary: string, statePath: string) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await rename(temporary, statePath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!(code === "EPERM" || code === "EACCES" || code === "EBUSY") || attempt >= 1000) throw error;
			if (attempt === 0) process.stderr.write(STATE_REPLACE_DEFERRED + "\n");
			await Bun.sleep(Math.min(attempt + 1, 10));
		}
	}
}

if (import.meta.main) {
	const statePath = process.argv[2];
	if (!statePath) throw new Error("controlled_state_path_required");
	const tools = [
		"start_session",
		"send_prompt",
		"read_turn",
		"list_questions",
		"submit_question_answer",
		"stop_session",
	].map((name) => ({
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
				result = {
					protocolVersion: "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: "CONTROLLED-not-real-GJC", version: "1" },
				};
			} else if (request.method === "tools/list") {
				result = { tools };
			} else if (request.method === "tools/call") {
				const state: ControlledState = await Bun.file(statePath).json();
				const { name, arguments: args } = request.params;
				state.calls.push({ name, args });
				let value: any;
				switch (name) {
					case "gjc_coordinator_start_session":
						if (state.refuseStart) {
							value = state.refuseStart;
							break;
						}
						state.session = {
							session_id: "controlled-session",
							cwd: state.sessionCwdMismatch ? args.cwd + "-wrong" : args.cwd,
						};
						value = { ok: true, session: state.session };
						break;
					case "gjc_coordinator_send_prompt":
						state.turnId = "controlled-turn";
						value = {
							ok: true,
							session_id: state.session?.session_id,
							turn_id: state.turnId,
							delivered: true,
						};
						break;
					case "gjc_coordinator_read_turn": {
						const sessionId = state.session?.session_id;
						const fault = state.terminalFault;
						if (state.readTurn) {
							value = state.readTurn;
							break;
						}
						value = {
							ok: true,
							turn: {
								session_id: sessionId,
								turn_id: state.turnId,
								prompt: {
									text:
										state.calls.find(
											(call) => call.name === "gjc_coordinator_send_prompt",
										)?.args.prompt ?? "",
									source: "mcp",
									created_at: "2026-01-01T00:00:00.000Z",
								},
								status: state.terminal ? "completed" : "active",
								final_response: {
									source: fault === "metadata" ? "report_status" : "agent_end",
								},
								delivery: {
									runtime_command_id: "controlled-runtime-command",
									prompt_acknowledged: fault !== "unacknowledged",
									queued: fault === "queued",
									...(fault === "no_runtime"
										? {}
										: {
												runtime_turn_id:
													fault === "empty_runtime"
														? ""
														: "controlled-runtime-turn",
											}),
								},
							},
							advisory_status: {
								authority: "sdk",
								live: fault !== "not_live",
								is_streaming: fault === "streaming",
							},
							session_state: {
								session_id:
									fault === "wrong_session" ? "alien-session" : sessionId,
								current_turn_id: state.sidecarTurnOmitted
									? null
									: fault === "wrong_turn"
										? "alien-turn"
										: state.turnId,
								state: state.terminal ? "completed" : "active",
							},
						};
						break;
					}
					case "gjc_coordinator_list_questions":
						value = {
							ok: true,
							reconciliation: { complete: state.questionsComplete !== false },
							questions:
								state.questions === "absent" || !state.questions
									? []
									: [
											{
												question_id: "controlled-question",
												answer_binding:
													state.questions === "stale"
														? "stale-binding"
														: "current-binding",
												session_id: state.session?.session_id,
												turn_id: state.turnId,
												answer_schema: {
													type: "object",
													properties: { choice: { type: "string" } },
													required: ["choice"],
												},
											},
										],
						};
						break;
					case "gjc_coordinator_submit_question_answer":
						value = {
							ok: true,
							session_id: args.session_id,
							turn_id: args.turn_id,
							question_id: args.question_id,
							answer_binding: args.answer_binding,
							accepted: true,
						};
						break;
					case "gjc_coordinator_stop_session":
						value = { ok: true, session_id: args.session_id, stopped: true };
						break;
					default:
						throw new Error("unsupported_controlled_tool");
				}
				// Atomic replace: concurrent fixture processes (one per RPC connection) read this file while
				// another writes it. An in-place write lets a reader see a truncated file and fail the call
				// with a spurious transport error; a per-process temporary file renamed over it never does,
				// provided the rename waits out a concurrent reader on Windows (replaceState).
				const temporary = `${statePath}.${process.pid}.${request.id}.tmp`;
				await writeFile(temporary, JSON.stringify(state));
				await replaceState(temporary, statePath);
				if (
					state.hangMs &&
					((state.hang === "start" && name.endsWith("start_session")) ||
						(state.hang === "send" && name.endsWith("send_prompt")) ||
						(state.hang === "read" && name.endsWith("read_turn")))
				)
					await Bun.sleep(state.hangMs);
				if (state.readDelayMs && (name.endsWith("read_turn") || name.endsWith("list_questions")))
					await Bun.sleep(state.readDelayMs);
				const lost =
					(state.lose === "start" && name.endsWith("start_session")) ||
					(state.lose === "send" && name.endsWith("send_prompt")) ||
					(state.lose === "read" && name.endsWith("read_turn"));
				// Persist the effect, then deliberately lose its response. No production retry is implied.
				if (lost) process.exit(0);
				result = { structuredContent: value, ...(state.refuseStart && name.endsWith("start_session") ? { isError: true } : {}) };
			} else {
				throw new Error("unsupported_controlled_method");
			}
			process.stdout.write(
				JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
			);
		}
	}
}
