import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { run, sha256 } from "../src/workspace";

const probeNames = [
	"version",
	"diagnostic",
	"session-list",
	"catalog",
] as const;
type ProbeName = (typeof probeNames)[number];
type Observation = { probe: ProbeName; exit: number; stdout: string };
type Options = {
	agentDir?: string;
	sshShell?: "posix" | "cmd";
	aliases: string[];
};

export function parseLiveCheckArgs(args: string[]): Options {
	const options: Options = { aliases: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--agent-dir") {
			const value = args[++i];
			if (
				options.agentDir ||
				!value ||
				!isAbsolute(value) ||
				/[\0\r\n]/.test(value)
			)
				throw new Error("--agent-dir requires one absolute local path");
			options.agentDir = value;
		} else if (arg === "--ssh-shell") {
			const value = args[++i];
			if (options.sshShell || (value !== "posix" && value !== "cmd"))
				throw new Error("--ssh-shell requires posix or cmd");
			options.sshShell = value;
		} else {
			if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(arg))
				throw new Error("Only existing SSH host aliases are accepted");
			options.aliases.push(arg);
		}
	}
	if (options.aliases.length && !options.sshShell)
		throw new Error("SSH aliases require explicit --ssh-shell posix|cmd");
	return options;
}

export function discoveryCommands(options: Options, alias?: string) {
	const commands = [
		["gjc", "--version"],
		["gjc", "sdk", "diagnostics", "broker", "--json", "--timeout-ms", "3000"],
		[
			"gjc",
			"sdk",
			"session",
			"list",
			"--scope",
			"all",
			"--attach-only",
			"--json",
		],
		["gjc", "mcp-serve", "coordinator", "--check", "--json", "--attach-only"],
	];
	if (alias && (!options.aliases.includes(alias) || !options.sshShell))
		throw new Error("SSH alias and shell must be explicitly configured");
	return commands.map((command, index) => ({
		probe: probeNames[index]!,
		argv: alias
			? [
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
					alias,
					(options.sshShell === "cmd"
						? 'set "GJC_SDK_BROKER_AUTOSTART=0" && '
						: "env GJC_SDK_BROKER_AUTOSTART=0 ") + command.join(" "),
				]
			: [
					"env",
					"GJC_SDK_BROKER_AUTOSTART=0",
					...(options.agentDir
						? ["GJC_CODING_AGENT_DIR=" + options.agentDir]
						: []),
					...command,
					...(probeNames[index] === "diagnostic" && options.agentDir
						? ["--agent-dir", options.agentDir]
						: []),
				],
	}));
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		return undefined;
	}
}

// Classifies only this invocation's selection. No observation grants execution authority.
export function classifyDiscovery(observations: Observation[]) {
	const list = observations.find((r) => r.probe === "session-list");
	const envelope = list && json(list.stdout);
	const result =
		object(envelope) && envelope.ok === true ? envelope.result : undefined;
	const valid =
		list?.exit === 0 &&
		object(result) &&
		result.version === 2 &&
		result.source === "broker" &&
		Array.isArray(result.sessions) &&
		result.sessions.every(
			(session: unknown) =>
				object(session) &&
				typeof session.sessionId === "string" &&
				session.sessionId.length > 0 &&
				typeof session.live === "boolean",
		);
	const status = (probe: ProbeName) => {
		const observation = observations.find((r) => r.probe === probe);
		if (!observation) return "not-observed";
		const value = json(observation.stdout);
		return observation.exit === 0 && object(value) && value.ok === true
			? "reported-success"
			: "inconclusive";
	};
	return {
		brokerReachability: valid
			? "reachable-for-selection"
			: "unproven-for-selection",
		brokerEvidence: valid ? "public-sdk-session-list" : null,
		liveSessionObserved:
			valid && object(result) && Array.isArray(result.sessions)
				? result.sessions.some(
						(session) => session.live === true && session.deleted !== true,
					)
				: false,
		diagnostic: status("diagnostic"),
		catalog: status("catalog"),
		modelCapabilityProven: false,
		executionProven: false,
		approvalProven: false,
	};
}

async function main() {
	const options = parseLiveCheckArgs(process.argv.slice(2));
	const directory = join(
		process.cwd(),
		".local",
		"evidence",
		"live",
		randomUUID(),
	);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const results = [];
	const selections = [];
	for (const [index, alias] of [undefined, ...options.aliases].entries()) {
		const observations: Observation[] = [];
		for (const [step, { probe, argv }] of discoveryCommands(
			options,
			alias,
		).entries()) {
			const startedAt = new Date().toISOString();
			let result;
			try {
				// Operator-chosen cwd, not a worker tree: argv[0] still never resolves from it.
				result = await run(argv, process.cwd(), 1024 * 1024);
			} catch {
				result = {
					argv,
					exit: -1,
					stdout: "",
					stderr: "process_spawn_or_output_failure",
				};
			}
			const file = `node-${index}-step-${step}`;
			await writeFile(join(directory, file + ".stdout"), result.stdout, {
				mode: 0o600,
			});
			await writeFile(join(directory, file + ".stderr"), result.stderr, {
				mode: 0o600,
			});
			observations.push({ probe, exit: result.exit, stdout: result.stdout });
			results.push({
				nodeIndex: index,
				probe,
				transport: alias ? "existing-ssh" : "local",
				argv,
				startedAt,
				endedAt: new Date().toISOString(),
				exit: result.exit,
				stdoutDigest: sha256(result.stdout),
				stderrDigest: sha256(result.stderr),
				stdoutPath: file + ".stdout",
				stderrPath: file + ".stderr",
			});
			console.log(
				JSON.stringify({
					nodeIndex: index,
					step,
					probe,
					exit: result.exit,
					stdoutDigest: sha256(result.stdout),
					stderrDigest: sha256(result.stderr),
				}),
			);
		}
		selections.push({
			nodeIndex: index,
			transport: alias ? "existing-ssh" : "local",
			selection: alias
				? "remote-default-agent-directory"
				: "local-invocation-agent-directory",
			...classifyDiscovery(observations),
		});
	}
	const evidence = {
		schemaVersion: 2,
		kind: "actual-installed-GJC-public-discovery",
		commands: results,
		selections,
		discoveryOnly: true,
		executedTasks: 0,
		modelCapabilityProven: false,
		workflowConsumptionProven: false,
		serviceOrCredentialChanges: false,
		limitation:
			"All classifications are selection-scoped observations, not readiness or approval. Broker-sourced list success proves only Broker reachability. Diagnostic, shell, transport, catalog, or list failures do not prove universal Broker absence. No services, credentials, or host trust are repaired or bypassed.",
	};
	const payload = JSON.stringify(evidence, null, 2);
	await writeFile(join(directory, "manifest.json"), payload, { mode: 0o600 });
	console.log(
		JSON.stringify({
			manifest: join(directory, "manifest.json"),
			digest: sha256(payload),
			executedTasks: 0,
		}),
	);
	process.exitCode = results.some((r) => r.exit !== 0) ? 1 : 0;
}

if (import.meta.main) await main();
