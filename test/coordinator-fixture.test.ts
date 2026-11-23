import { afterEach, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The CONTROLLED coordinator fixture runs as one process per RPC connection, so concurrent Fleet
// inspectors mean concurrent fixture processes sharing one state file. Explicit interleaving, no
// timing: this test holds the state file open exactly as a sibling fixture's in-flight read does
// and only releases it once the fixture reports the replace as deferred (or, where the OS does not
// block a rename over an open file, once the reply arrived).
const coordinatorPath = fileURLToPath(new URL("./fixtures/coordinator.ts", import.meta.url));
const DEFERRED = "controlled fixture: state replace deferred by a concurrent reader";
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function collect(stream: ReadableStream<Uint8Array>) {
	let text = "";
	let waiters: { match: (text: string) => boolean; resolve: () => void }[] = [];
	const done = (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			text += decoder.decode(chunk, { stream: true });
			const pending = waiters;
			waiters = [];
			for (const waiter of pending) (waiter.match(text) ? waiter.resolve() : waiters.push(waiter));
		}
	})();
	return {
		done,
		text: () => text,
		until: (match: (text: string) => boolean) =>
			match(text) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ match, resolve })),
	};
}

test("controlled coordinator: a call never crashes while a concurrent reader holds the state file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-coordinator-fixture-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const statePath = join(dir, "coordinator.json");
	writeFileSync(statePath, JSON.stringify({ calls: [] }));
	let reader: number | undefined = openSync(statePath, "r");
	const release = () => {
		if (reader !== undefined) closeSync(reader);
		reader = undefined;
	};
	cleanups.push(release);
	const child = Bun.spawn([process.execPath, coordinatorPath, statePath], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	cleanups.push(() => child.kill());
	const out = collect(child.stdout);
	const err = collect(child.stderr);
	const request = (id: number, method: string, params: object = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
	child.stdin.write(request(1, "initialize") + request(2, "tools/call", { name: "gjc_coordinator_read_turn", arguments: {} }));
	child.stdin.flush();
	const first = await Promise.race([
		out.until((text) => text.includes('"id":2')).then(() => "reply" as const),
		err.until((text) => text.includes(DEFERRED)).then(() => "deferred" as const),
		child.exited.then(() => "exited" as const),
	]);
	// Windows never lets the replace through while the reader is open: the fixture must wait, not exit.
	expect({ first, stderr: first === "exited" ? err.text() : "" }).toEqual({ first: process.platform === "win32" ? "deferred" : "reply", stderr: "" });
	release();
	await out.until((text) => text.includes('"id":2'));
	child.stdin.end();
	expect(await child.exited).toBe(0);
	await Promise.all([out.done, err.done]);
	const replies = out.text().trim().split("\n").map((line) => JSON.parse(line));
	expect(replies.map((reply) => [reply.id, reply.error])).toEqual([[1, undefined], [2, undefined]]);
	expect(JSON.parse(readFileSync(statePath, "utf8")).calls).toEqual([{ name: "gjc_coordinator_read_turn", args: {} }]);
	expect(readdirSync(dir)).toEqual(["coordinator.json"]);
});
