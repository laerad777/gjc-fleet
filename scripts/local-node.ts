import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, posix } from "node:path";
import { validateNode } from "../src/core";

export function parseLocalNodeArgs(args: string[]) {
	const [repoId, repoArg, workspaceArg, nodeId, ...flags] = args;
	if (!repoId || !repoArg || !workspaceArg || !nodeId)
		throw new Error(
			"usage: bun scripts/local-node.ts REPO_ID REPO_PATH WORKSPACE_ROOT NODE_ID [--agent-dir ABSOLUTE] [--model-profile NAME] [--attest-ready]",
		);
	let agentDir: string | undefined;
	let ready = false;
	const modelProfiles: string[] = [];
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (flag === "--attest-ready" && !ready) ready = true;
		else if (flag === "--agent-dir" && !agentDir) {
			const value = flags[++i];
			if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value))
				throw new Error("--agent-dir requires one absolute local path");
			agentDir = value;
		} else if (flag === "--model-profile") {
			const value = flags[++i];
			if (
				!value ||
				value.startsWith("--") ||
				/[\0\r\n]/.test(value) ||
				modelProfiles.includes(value)
			)
				throw new Error("--model-profile requires a unique name");
			modelProfiles.push(value);
		} else throw new Error("invalid_local_node_flag");
	}
	return {
		repoId,
		repoArg,
		workspaceArg,
		nodeId,
		agentDir,
		ready,
		modelProfiles,
	};
}

export function buildLocalNode(
	options: ReturnType<typeof parseLocalNodeArgs>,
	repo: string,
	workspaceRoot: string,
	cwd: string,
	platform: string,
	arch: string,
) {
	if (platform !== "darwin" && platform !== "linux")
		throw new Error("local_execution_platform_not_validated");
	const { repoId, nodeId, ready, agentDir, modelProfiles } = options;
	const agentEnv = agentDir ? ["GJC_CODING_AGENT_DIR=" + agentDir] : [];
	return {
		id: nodeId,
		os: platform,
		arch,
		roots: { [repoId]: repo },
		workspaceRoot,
		maxConcurrency: 1,
		enabled: ready,
		draining: false,
		reachable: ready,
		sdkReady: ready,
		modelReady: ready,
		models: [],
		modelProfiles,
		sdkTransport: {
			command: "env",
			args: ["GJC_SDK_BROKER_AUTOSTART=0", ...agentEnv, "gjc"],
		},
		operations: [
			"coordinator.create",
			"coordinator.prompt",
			"coordinator.read_turn",
			"coordinator.workflow_question",
		],
		transport: {
			command: "env",
			args: [
				"GJC_SDK_BROKER_AUTOSTART=0",
				...agentEnv,
				"GJC_COORDINATOR_MCP_WORKDIR_ROOTS=" + workspaceRoot,
				"GJC_COORDINATOR_MCP_STATE_ROOT=" +
					// The generated node is darwin/linux only; its paths are POSIX regardless of the generating host.
					posix.join(cwd, ".local", "coordinator", nodeId),
				"GJC_COORDINATOR_MCP_PROFILE=fleet",
				"GJC_COORDINATOR_MCP_REPO=" + repoId,
				"GJC_COORDINATOR_MCP_MUTATIONS=sessions,questions",
				"GJC_COORDINATOR_MCP_SESSION_COMMAND=gjc",
				"GJC_COORDINATOR_MCP_REQUIRE_WORKTREE=false",
				"gjc",
				"mcp-serve",
				"coordinator",
				"--attach-only",
			],
		},
	};
}

if (import.meta.main) {
	const options = parseLocalNodeArgs(process.argv.slice(2));
	const node = buildLocalNode(
		options,
		await realpath(resolve(options.repoArg)),
		resolve(options.workspaceArg),
		process.cwd(),
		process.platform,
		process.arch,
	);
	validateNode(node);
	console.log(JSON.stringify(node, null, 2));
}
