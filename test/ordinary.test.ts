import { describe, expect, test } from "bun:test";
import {
	answerOrdinary,
	discoverOrdinary,
	type OrdinaryBinding,
} from "../src/ordinary";

// CONTROLLED subprocess contract fixtures, NOT live GJC integration or authority proof.
const binding: OrdinaryBinding = {
	sessionId: "session-owned",
	coordinatorTurnId: "coordinator-turn",
	runtimeTurnId: "runtime-turn",
};
function envelope() {
	return {
		ok: true,
		result: {
			version: 2,
			source: "session",
			session: {
				sessionId: binding.sessionId,
				locator: {
					cwd: "/controlled",
					worktreeRoot: null,
					stateRoot: "/controlled/state",
				},
				endpointGeneration: 7,
				hostIncarnation: "host-incarnation",
				pid: 100,
				live: true,
				deleted: false,
				indexSeq: 1,
			},
			checkpoint: { revision: 9, generation: 1, seq: 0, idle: false },
			cursor: "opaque-signed-checkpoint",
			items: [
				{
					kind: "action_needed",
					id: "opaque-action",
					revision: 9,
					generation: 1,
					seq: 1,
					payload: {
						type: "action_needed",
						id: "opaque-action",
						kind: "ask",
						sessionId: binding.sessionId,
						question: "Choose target",
						options: ["A", "B"],
						recommendedIndex: 1,
					},
				},
			],
			terminal: false,
		},
	};
}
function controlled(value: unknown, exit = 0) {
	const code = `const expected=['sdk','session','tail',${JSON.stringify(binding.sessionId)},'--all-events','--strict','--timeout-ms','1000','--attach-only','--json'];const args=process.argv.slice(-expected.length);if(JSON.stringify(args)!==JSON.stringify(expected)||process.env.GJC_SDK_BROKER_AUTOSTART!=='0')process.exit(87);let input='';for await(const chunk of Bun.stdin.stream())input+=new TextDecoder().decode(chunk);if(input!=='')process.exit(88);console.log(${JSON.stringify(JSON.stringify(value))});process.exit(${exit});`;
	return { command: process.execPath, args: ["--eval", code, "--"] };
}
describe("controlled public CLI ordinary discovery (not live GJC)", () => {
	test("untrusted execution identifiers cannot become SSH shell command fragments", async () => {
		for (const id of [
			"session;touch injected",
			"$(id)",
			"-option",
			"with space",
			"line\nbreak",
		])
			expect(
				await discoverOrdinary(
					{ command: "must-not-execute", args: [] },
					{ ...binding, sessionId: id },
				),
			).toMatchObject({ status: "refused", reason: "invalid_binding" });
	});
	test("retained v2 action is display-only, never current-turn or workflow authority", async () => {
		const found = await discoverOrdinary(controlled(envelope()), binding);
		expect(found.status).toBe("discovery_only");
		expect(found.candidates).toEqual([
			{
				id: "opaque-action",
				question: "Choose target",
				options: ["A", "B"],
				recommendedIndex: 1,
				revision: 9,
				generation: 1,
				seq: 1,
			},
		]);
		expect(found).toMatchObject({
			answerSupported: false,
			bindingVerified: false,
			workflowApproval: false,
			reason: "ordinary_runtime_turn_binding_unsupported",
		});
	});
	test("wrong session is refused and arbitrary turn claims cannot become verified", async () => {
		const wrong = envelope();
		wrong.result.session.sessionId = "someone-else";
		expect(await discoverOrdinary(controlled(wrong), binding)).toMatchObject({
			status: "refused",
			reason: "session_mismatch",
		});
		for (const claim of [
			binding,
			{ ...binding, runtimeTurnId: "wrong-runtime" },
			{ ...binding, runtimeTurnId: binding.coordinatorTurnId },
		]) {
			const found = await discoverOrdinary(controlled(envelope()), claim);
			expect(found.bindingVerified).toBe(false);
			expect(found.answerSupported).toBe(false);
		}
	});
	test("retention gap, stale revision/generation, terminal and missing host identity fail closed", async () => {
		const cases: [unknown, string][] = [];
		const gap = envelope();
		Object.assign(gap.result, {
			gap: { code: "retention_gap", missing: { from: 1, to: 3 } },
		});
		cases.push([gap, "retention_gap"]);
		const stale = envelope();
		stale.result.items[0]!.revision = 8;
		cases.push([stale, "stale_revision_or_generation"]);
		const generation = envelope();
		generation.result.items[0]!.generation = 0;
		cases.push([generation, "stale_revision_or_generation"]);
		const terminal = envelope();
		terminal.result.terminal = true;
		cases.push([terminal, "session_not_current"]);
		const missingHost = envelope();
		missingHost.result.session.hostIncarnation = "";
		cases.push([missingHost, "host_identity_unavailable"]);
		for (const [value, reason] of cases)
			expect(await discoverOrdinary(controlled(value), binding)).toMatchObject({
				status: "refused",
				reason,
				candidates: [],
			});
	});
	test("workflow correlation even null, multiquestion and multiple ordinary actions are ambiguous", async () => {
		for (const extra of [
			{ workflowGateId: "durable-gate" },
			{ workflowGateId: null },
			{ questions: [] },
			{ multi: true },
		]) {
			const value = envelope();
			Object.assign(value.result.items[0]!.payload, extra);
			expect(await discoverOrdinary(controlled(value), binding)).toMatchObject({
				status: "refused",
				reason: "workflow_or_question_kind_ambiguous",
			});
		}
		const multiple = envelope();
		multiple.result.items.push({
			...multiple.result.items[0]!,
			id: "other",
			seq: 2,
			payload: { ...multiple.result.items[0]!.payload, id: "other" },
		});
		expect(await discoverOrdinary(controlled(multiple), binding)).toMatchObject(
			{ status: "refused", reason: "multiple_actions_ambiguous" },
		);
	});
	test("resolved actions and transcript projections are never answer candidates", async () => {
		const value = envelope();
		value.result.items.push({
			kind: "action_resolved",
			id: "opaque-action",
			revision: 9,
			generation: 1,
			seq: 2,
			payload: {
				type: "action_resolved",
				id: "opaque-action",
				resolvedBy: "local",
			},
		} as any);
		expect(
			(await discoverOrdinary(controlled(value), binding)).candidates,
		).toEqual([]);
		const transcript = envelope();
		transcript.result.items[0]!.kind = "transcript";
		expect(
			(await discoverOrdinary(controlled(transcript), binding)).candidates,
		).toEqual([]);
	});
	test("answer re-discovers with tail only and refuses even an exact retained candidate", async () => {
		const transport = controlled(envelope());
		const found = await discoverOrdinary(transport, binding);
		const current = {
			candidate: found.candidates[0]!,
			observation: found.observation!,
		};
		const answer = await answerOrdinary(transport, binding, current, {
			selected: ["A"],
			secret: "must-not-be-in-argv-or-stdin",
		});
		expect(answer).toMatchObject({
			status: "refused",
			reason: "ordinary_runtime_turn_binding_unsupported",
			answerSupported: false,
			workflowApproval: false,
		});
		for (const observation of [
			{ ...current.observation, hostIncarnation: "old-host" },
			{ ...current.observation, endpointGeneration: 6 },
			{
				...current.observation,
				checkpoint: { ...current.observation.checkpoint, revision: 8 },
			},
		]) {
			expect(
				await answerOrdinary(
					transport,
					binding,
					{ ...current, observation },
					"A",
				),
			).toMatchObject({ status: "refused", reason: "stale_action_or_host" });
		}
	});
	test("public retention error retained, malformed/lost observation is unknown without retry", async () => {
		expect(
			await discoverOrdinary(
				controlled(
					{
						schema: "gjc.command-error",
						version: 1,
						error: { code: "retention_gap" },
					},
					1,
				),
				binding,
			),
		).toMatchObject({ status: "refused", reason: "retention_gap" });
		const lost = {
			command: process.execPath,
			args: [
				"--eval",
				"process.stdout.write('{incomplete');process.exit(1)",
				"--",
			],
		};
		expect(await discoverOrdinary(lost, binding)).toMatchObject({
			status: "unknown",
			reason: "observation_failed",
			answerSupported: false,
		});
	});
	test("unsupported envelopes and malformed canonical positions do not fabricate actions", async () => {
		for (const value of [
			{ result: envelope().result },
			{ ok: true, result: { ...envelope().result, version: 1 } },
			{
				ok: true,
				result: {
					...envelope().result,
					items: [{ ...envelope().result.items[0], seq: null }],
				},
			},
		]) {
			expect((await discoverOrdinary(controlled(value), binding)).status).toBe(
				"refused",
			);
		}
	});
});
