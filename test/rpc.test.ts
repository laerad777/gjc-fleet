import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StdioRpc, TransportError } from "../src/rpc";

function processRpc(code: string, timeout = 2000) {
	return new StdioRpc(process.execPath, ["--eval", code], timeout);
}
const readLine = `let b='';for await(const p of Bun.stdin.stream()){b+=new TextDecoder().decode(p);let n;while((n=b.indexOf('\\n'))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(r.id===undefined)continue;`;
const end = `}}`;
test("rejects a shell banner, incomplete JSON and oversized frame without mistaking them for receipts", async () => {
	for (const expression of [
		JSON.stringify("banner\n"),
		JSON.stringify("{broken}\n"),
		"'x'.repeat(4*1024*1024+1)",
	]) {
		const rpc = processRpc(
			`process.stdout.write(${expression});setInterval(()=>{},1000)`,
		);
		try {
			await expect(rpc.request("initialize", {})).rejects.toBeInstanceOf(
				TransportError,
			);
		} finally {
			rpc.close();
		}
	}
});
test("timeout after send stays unknown; it is not a pre-effect refusal", async () => {
	const rpc = processRpc("for await(const p of Bun.stdin.stream()){}", 50);
	try {
		await rpc.request("tools/call", { name: "effect", arguments: {} });
		throw new Error("must not resolve");
	} catch (error) {
		expect(error).toBeInstanceOf(TransportError);
		expect((error as TransportError).certainty).toBe("unknown");
	} finally {
		rpc.close();
	}
});
test("UTF-8 split across subprocess chunks is reconstructed and public refusal code is retained", async () => {
	const code =
		readLine +
		`const value=r.method==='initialize'?{greeting:'h€llo'}:{isError:true,content:[{type:'text',text:JSON.stringify({ok:false,error:{code:'authorization_denied'}})}]};const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:r.id,result:value})+'\\n');if(r.method==='initialize'){const codepoint=Buffer.from('€');const start=bytes.indexOf(codepoint);if(start<0||codepoint.length!==3)throw new Error('missing_multibyte_split_target');const split=start+1;process.stdout.write(bytes.subarray(0,split));await Bun.sleep(30);process.stdout.write(bytes.subarray(split));}else{process.stdout.write(bytes);}` +
		end;
	const rpc = processRpc(code, 5000);
	try {
		expect((await rpc.request("initialize", {})).greeting).toBe("h€llo");
		let refusal: unknown;
		try {
			await rpc.call("effect", {});
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(TransportError);
		expect(refusal).toMatchObject({
			code: "tool_refused:authorization_denied",
			certainty: "unknown",
			publicResponse: {
				ok: false,
				error: { code: "authorization_denied" },
			},
		});
	} finally {
		rpc.close();
	}
});
test("structured content and text JSON are consumed without exposing stderr in errors", async () => {
	const code =
		readLine +
		`process.stderr.write('CONTROLLED_SECRET_CANARY');console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result:{content:[{type:'text',text:'{"ok":true,"result":7}'}]}}));` +
		end;
	const rpc = processRpc(code);
	try {
		expect(await rpc.call("read", {})).toEqual({ ok: true, result: 7 });
		expect(JSON.stringify(rpc.diagnostics())).not.toContain(
			"CONTROLLED_SECRET_CANARY",
		);
	} finally {
		rpc.close();
	}
});

test.skipIf(process.platform === "win32")("close SIGKILLs a SIGTERM-trapping child without waiting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gjc-fleet-rpc-sigkill-"));
	const pidFile = join(dir, "pid");
	const rpc = new StdioRpc(
		"sh",
		[
			"-c",
			`trap '' TERM; echo $$ >${JSON.stringify(pidFile)}; while true; do sleep 1; done`,
		],
		5_000,
	);
	try {
		const readyUntil = Date.now() + 5_000;
		let pid = "";
		while (Date.now() < readyUntil) {
			try {
				pid = (await readFile(pidFile, "utf8")).trim();
				if (/^\d+$/.test(pid)) break;
			} catch {
				/* not written yet */
			}
			await Bun.sleep(20);
		}
		expect(pid).toMatch(/^\d+$/);
		expect(() => process.kill(Number(pid), 0)).not.toThrow();
		const t0 = Date.now();
		rpc.close();
		const goneUntil = Date.now() + 500;
		let gone = false;
		while (Date.now() < goneUntil) {
			try {
				process.kill(Number(pid), 0);
			} catch {
				gone = true;
				break;
			}
			await Bun.sleep(10);
		}
		expect(gone).toBe(true);
		expect(Date.now() - t0).toBeLessThan(800);
	} finally {
		rpc.close();
		await rm(dir, { recursive: true, force: true });
	}
});
