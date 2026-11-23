import { describe, expect, test } from "bun:test";
import {
	classifyDiscovery,
	discoveryCommands,
	parseLiveCheckArgs,
} from "../scripts/live-check";
import { buildLocalNode, parseLocalNodeArgs } from "../scripts/local-node";

const brokerList = (sessions: unknown[] = []) => ({
	probe: "session-list" as const,
	exit: 0,
	stdout: JSON.stringify({
		ok: true,
		result: { version: 2, source: "broker", sessions },
	}),
});
const diagnostic = (stdout: string, exit = 1) => ({
	probe: "diagnostic" as const,
	exit,
	stdout,
});

// Pure synthetic contracts only: no installed GJC, SSH, network, or live readiness proof.
describe("controlled discovery classification, not operational proof", () => {
	test("absent diagnostic and empty broker list prove selection reachability only", () => {
		const result = classifyDiscovery([brokerList()]);
		expect(result.brokerReachability).toBe("reachable-for-selection");
		expect(result.brokerEvidence).toBe("public-sdk-session-list");
		expect(result.diagnostic).toBe("not-observed");
		expect(result.liveSessionObserved).toBe(false);
		expect(result.modelCapabilityProven).toBe(false);
		expect(result.executionProven).toBe(false);
		expect(result.approvalProven).toBe(false);
	});

	test("unsupported diagnostic cannot override independent broker list success", () => {
		const result = classifyDiscovery([
			diagnostic(JSON.stringify({ ok: false, error: "unsupported" })),
			brokerList([
				{ sessionId: "controlled-session", live: true, deleted: false },
			]),
		]);
		expect(result.diagnostic).toBe("inconclusive");
		expect(result.brokerReachability).toBe("reachable-for-selection");
		expect(result.liveSessionObserved).toBe(true);
		expect(result.executionProven).toBe(false);
	});

	test("all failures are scoped unproven, never universal unavailable", () => {
		const result = classifyDiscovery([
			diagnostic("unsupported"),
			{ ...brokerList(), exit: 1, stdout: "broker_unavailable" },
			{ probe: "catalog", exit: 1, stdout: "shell or transport failure" },
		]);
		expect(result.brokerReachability).toBe("unproven-for-selection");
		expect(result.brokerEvidence).toBeNull();
		expect(result.catalog).toBe("inconclusive");
	});

	test("diagnostic/catalog success alone is not broker-list or model proof", () => {
		const result = classifyDiscovery([
			diagnostic('{"ok":true}', 0),
			{ probe: "catalog", exit: 0, stdout: '{"ok":true,"tools":[]}' },
		]);
		expect(result.diagnostic).toBe("reported-success");
		expect(result.catalog).toBe("reported-success");
		expect(result.brokerReachability).toBe("unproven-for-selection");
		expect(result.modelCapabilityProven).toBe(false);
	});

	test("malformed, non-broker, wrong-version, and failed lists grant no reachability", () => {
		for (const value of [
			null,
			[],
			{ ok: true },
			{ ok: false, result: { version: 2, source: "broker", sessions: [] } },
			{ ok: true, result: { version: 1, source: "broker", sessions: [] } },
			{ ok: true, result: { version: 2, source: "catalog", sessions: [] } },
			{ ok: true, result: { version: 2, source: "broker", sessions: {} } },
			{ ok: true, result: { version: 2, source: "broker", sessions: [{}] } },
			{ ok: true, result: { version: 2, source: "broker", sessions: [null] } },
		]) {
			expect(
				classifyDiscovery([{ ...brokerList(), stdout: JSON.stringify(value) }])
					.brokerReachability,
			).toBe("unproven-for-selection");
		}
		for (const observation of [
			{ ...brokerList(), stdout: "not JSON" },
			{ ...brokerList(), stdout: '{"ok":true}\nextra output' },
			{ ...brokerList(), exit: 1 },
		])
			expect(classifyDiscovery([observation]).brokerReachability).toBe(
				"unproven-for-selection",
			);
	});

	test("deleted or nonlive sessions do not assert current live sessions", () => {
		for (const session of [
			{ sessionId: "controlled-session", live: false, deleted: false },
			{ sessionId: "controlled-session", live: true, deleted: true },
		]) {
			const result = classifyDiscovery([brokerList([session])]);
			expect(result.brokerReachability).toBe("reachable-for-selection");
			expect(result.liveSessionObserved).toBe(false);
		}
	});
});

describe("controlled discovery argv contracts, no commands executed", () => {
	test("local explicit authority is one argv value and every probe disables autostart", () => {
		const options = parseLiveCheckArgs([
			"--agent-dir",
			"/controlled/agent directory",
		]);
		const commands = discoveryCommands(options);
		for (const { argv } of commands) {
			expect(argv.slice(0, 3)).toEqual([
				"env",
				"GJC_SDK_BROKER_AUTOSTART=0",
				"GJC_CODING_AGENT_DIR=/controlled/agent directory",
			]);
		}
		expect(
			commands.find((c) => c.probe === "session-list")!.argv.slice(3),
		).toEqual([
			"gjc",
			"sdk",
			"session",
			"list",
			"--scope",
			"all",
			"--attach-only",
			"--json",
		]);
		expect(commands.find((c) => c.probe === "catalog")!.argv).toContain(
			"--attach-only",
		);
		expect(commands.find((c) => c.probe === "diagnostic")!.argv).not.toContain(
			"--attach-only",
		);
		expect(commands.find((c) => c.probe === "diagnostic")!.argv).toEqual([
			"env",
			"GJC_SDK_BROKER_AUTOSTART=0",
			"GJC_CODING_AGENT_DIR=/controlled/agent directory",
			"gjc",
			"sdk",
			"diagnostics",
			"broker",
			"--json",
			"--timeout-ms",
			"3000",
			"--agent-dir",
			"/controlled/agent directory",
		]);
		for (const { probe, argv } of commands) {
			expect(argv.filter((arg) => arg === "--agent-dir")).toHaveLength(
				probe === "diagnostic" ? 1 : 0,
			);
		}
	});

	test("without an explicit local directory diagnostic selection is not invented", () => {
		for (const { argv } of discoveryCommands(parseLiveCheckArgs([]))) {
			expect(argv).not.toContain("--agent-dir");
			expect(argv.some((arg) => arg.startsWith("GJC_CODING_AGENT_DIR="))).toBe(
				false,
			);
		}
	});

	test("remote shells are explicit, retain strict trust and never receive the local agent path", () => {
		for (const shell of ["posix", "cmd"] as const) {
			const options = parseLiveCheckArgs([
				"--agent-dir",
				"/controlled/local-agent",
				"--ssh-shell",
				shell,
				"controlled-alias",
			]);
			for (const { argv } of discoveryCommands(options, "controlled-alias")) {
				expect(argv.slice(0, -1)).toEqual([
					"ssh",
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=yes",
					"-o",
					"UpdateHostKeys=no",
					"-o",
					"ConnectTimeout=5",
					"-o",
					"ControlMaster=no",
					"controlled-alias",
				]);
				expect(
					argv
						.at(-1)!
						.startsWith(
							shell === "cmd"
								? 'set "GJC_SDK_BROKER_AUTOSTART=0" && '
								: "env GJC_SDK_BROKER_AUTOSTART=0 ",
						),
				).toBe(true);
				expect(argv.join(" ")).not.toContain("/controlled/local-agent");
				expect(argv.at(-1)!).not.toContain("--agent-dir");
				expect(argv.at(-1)!).not.toContain("GJC_CODING_AGENT_DIR=");
			}
		}
	});

	test("invalid or ambiguous flags and SSH options fail closed", () => {
		for (const args of [
			["--agent-dir"],
			["--agent-dir", "relative"],
			["--agent-dir", "/controlled/a", "--agent-dir", "/controlled/b"],
			["--agent-dir", "/controlled/a\nextra"],
			["controlled-alias"],
			["--ssh-shell", "auto", "controlled-alias"],
			["--ssh-shell", "posix", "-unsafe"],
			["--unknown"],
		])
			expect(() => parseLiveCheckArgs(args)).toThrow();
		expect(() =>
			discoveryCommands({ aliases: [] }, "unconfigured-alias"),
		).toThrow();
	});
});

describe("controlled local-node generator argv contracts", () => {
	const positional = [
		"controlled-repo",
		"/controlled/repo",
		"/controlled/workspaces",
		"controlled-node",
	];
	const build = (flags: string[]) =>
		buildLocalNode(
			parseLocalNodeArgs([...positional, ...flags]),
			"/controlled/repo",
			"/controlled/workspaces",
			"/controlled/fleet",
			"linux",
			"arm64",
		);

	test("explicit agent directory reaches both transports without automatic readiness", () => {
		const node = build([
			"--agent-dir",
			"/controlled/agent directory",
			"--model-profile",
			"controlled-profile",
		]);
		for (const transport of [node.sdkTransport, node.transport]) {
			expect(transport.command).toBe("env");
			expect(transport.args).toContain("GJC_SDK_BROKER_AUTOSTART=0");
			expect(transport.args).toContain(
				"GJC_CODING_AGENT_DIR=/controlled/agent directory",
			);
		}
		expect(node.transport.args).toContain("--attach-only");
		expect(node.modelProfiles).toEqual(["controlled-profile"]);
		expect(node.enabled).toBe(false);
		expect(node.reachable).toBe(false);
		expect(node.sdkReady).toBe(false);
		expect(node.modelReady).toBe(false);
	});

	test("existing explicit attestation remains optional; profiles are repeatable declarations", () => {
		const node = build([
			"--attest-ready",
			"--model-profile",
			"controlled-one",
			"--model-profile",
			"controlled-two",
		]);
		expect(node.enabled).toBe(true);
		expect(node.modelProfiles).toEqual(["controlled-one", "controlled-two"]);
		expect(
			node.sdkTransport.args.some((a) => a.startsWith("GJC_CODING_AGENT_DIR=")),
		).toBe(false);
		expect(
			node.transport.args.some((a) => a.startsWith("GJC_CODING_AGENT_DIR=")),
		).toBe(false);
		expect(node.sdkTransport.args).toEqual(["GJC_SDK_BROKER_AUTOSTART=0", "gjc"]);
		expect(node.transport.command).toBe("env");
		expect(node.transport.args).toContain("--attach-only");
		expect(node.transport.args).toContain("GJC_SDK_BROKER_AUTOSTART=0");
		expect(node.transport.args).toContain(
			"GJC_COORDINATOR_MCP_STATE_ROOT=/controlled/fleet/.local/coordinator/controlled-node",
		);
		expect(node.transport.args.includes("broker")).toBe(false);
	});

	test("malformed flags and unsupported platforms reject", () => {
		for (const flags of [
			["--agent-dir"],
			["--agent-dir", "relative"],
			["--unknown"],
			["--model-profile"],
			["--model-profile", "--attest-ready"],
			["--model-profile", "same", "--model-profile", "same"],
		])
			expect(() => build(flags)).toThrow();
		expect(() =>
			buildLocalNode(
				parseLocalNodeArgs(positional),
				"/controlled/repo",
				"/controlled/workspaces",
				"/controlled/fleet",
				"win32",
				"arm64",
			),
		).toThrow();
	});
});
