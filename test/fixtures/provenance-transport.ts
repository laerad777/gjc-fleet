// Workspace transport relay for test/work-unit.test.ts (review fx-8fae504e F1/F4/F5). Not a test file.
// argv: <src/node.ts> <node config> <control.json>. Every request is logged (its action) in control.json and
// forwarded to the real node helper, except `provenance`, which `mode` controls:
//   real      forward unchanged
//   false     answer {created: false}
//   invalid   answer {created: "true"} (any reply other than exactly {created: true})
//   old       forward as an action this node does not know (the before_send refusal an older node gives)
//   transport exit 3 with no output (a transport failure)
//   move      the agent commits once more in the workspace (HEAD moves after collect), then forward
const [helper, config, control] = process.argv.slice(2) as [string, string, string];
const body = await Bun.stdin.text();
const request = JSON.parse(body);
const state = JSON.parse(await Bun.file(control).text());
state.actions.push(request.action);
await Bun.write(control, JSON.stringify(state));
async function forward(text: string): Promise<void> {
	const child = Bun.spawn([process.execPath, helper, config], { stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" });
	const [out, , exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	process.stdout.write(out);
	process.exitCode = exit;
}
if (request.action !== "provenance" || state.mode === "real") await forward(body);
else if (state.mode === "false") console.log(JSON.stringify({ ok: true, value: { created: false } }));
else if (state.mode === "invalid") console.log(JSON.stringify({ ok: true, value: { created: "true" } }));
else if (state.mode === "old") await forward(JSON.stringify({ ...request, action: "provenance_unknown" }));
else if (state.mode === "transport") process.exitCode = 3;
else if (state.mode === "move") {
	const path = request.identity.path;
	const git = Bun.spawnSync(["git", "-c", "core.hooksPath=" + path + "/../no-hooks", "-c", "commit.gpgsign=false", "-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "-C", path, "commit", "-q", "--allow-empty", "-m", "moved after collect"]);
	if (git.exitCode !== 0) throw new Error("move commit failed");
	await forward(body);
} else throw new Error("unknown relay mode");
