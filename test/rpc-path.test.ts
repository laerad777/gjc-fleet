import { describe, expect, test } from "bun:test";
import { StdioRpc } from "../src/rpc.ts";

describe("stdio transport", () => {
	test("forwards the caller PATH to the child process", async () => {
		const marker = "fleet-path-marker";
		const previous = process.env.PATH;
		process.env.PATH = marker;
		const rpc = new StdioRpc(
			process.execPath,
			[
				"-e",
				'let buf="";process.stdin.on("data",(chunk)=>{buf+=chunk;if(!buf.includes("\\n"))return;const msg=JSON.parse(buf);process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:msg.id,result:process.env.PATH??""})+"\\n")})',
			],
			2000,
		);
		try {
			expect(await rpc.request("probe", {})).toBe(marker);
		} finally {
			rpc.close();
			if (previous === undefined) delete process.env.PATH;
			else process.env.PATH = previous;
		}
	});
});
