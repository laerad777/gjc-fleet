// Transport stand-in: `call-log.ts LOG COMMAND...` appends COMMAND (one JSON line) to LOG, then runs
// COMMAND with the same stdio and exit code, so a test can count every node call a process made.
import { appendFileSync } from "node:fs";
const [log, ...command] = process.argv.slice(2);
if (!log || !command.length) process.exit(64);
appendFileSync(log, JSON.stringify(command) + "\n");
const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(await child.exited);
