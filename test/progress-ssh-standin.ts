// Windows stand-in for `ssh` in test/progress.test.ts, compiled there to `ssh.exe` (NOT a remote host): the same
// contract as that file's POSIX `#!/bin/sh` stand-in. It logs each invocation and runs only a progress command:
// a POSIX one (`sh -c '<script>'`) through Git for Windows `sh` with the controlled `date` first on PATH, a win32
// node's one (`powershell ... -EncodedCommand ...`) through `cmd.exe /d /c` with the command line exactly as given
// (cmd.exe is Windows OpenSSH's default remote shell, with its 8191-character limit). Anything else is refused,
// so a coordinator connection Fleet opens shows up as `other` and the real gjc is never started.
import { appendFileSync } from "node:fs";

const last = process.argv.at(-1) ?? "";
const log = process.env.FLEET_TEST_SSH_LOG!;
const win32 = last.startsWith("powershell ");
if (last.startsWith("sh -c ")) appendFileSync(log, "progress\n");
else if (win32) appendFileSync(log, `progress-win32 ${last.length}\n`);
else {
	appendFileSync(log, "other\n");
	process.exit(7);
}
const out = async (data: string) => void (await Bun.write(Bun.stdout, data));
const run = async (capture: boolean) => {
	const io = { stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" } as const;
	const child = win32
		? Bun.spawn(["cmd.exe", "/d", "/c", last], { ...io, windowsVerbatimArguments: true })
		: Bun.spawn([process.env.FLEET_TEST_SH!, "-c", last], { ...io, env: { ...process.env, PATH: `${process.env.FLEET_TEST_BIN};${process.env.PATH}` } });
	const text = capture ? await new Response(child.stdout as ReadableStream).text() : "";
	return { code: await child.exited, text };
};
switch (process.env.FLEET_TEST_MODE) {
	case "timeout":
		await Bun.sleep(30_000);
		break;
	case "flood":
		await out("x".repeat(200_000));
		process.exit(0);
	case "exit":
		process.exit(3);
	case "garbage":
		await out("not-a-progress-reply\n");
		process.exit(0);
	case "truncated":
		await out("FLEETPROGRESS 1\n");
		process.exit(0);
	case "pad": {
		// The real reply, then newlines up to exactly FLEET_TEST_BYTES bytes of stdout (the parser skips blank lines).
		const reply = (await run(true)).text.replace(/\n$/, "");
		await out(`${reply}\n${"\n".repeat(Number(process.env.FLEET_TEST_BYTES) - Buffer.byteLength(reply) - 1)}`);
		process.exit(0);
	}
}
process.exit((await run(false)).code);
