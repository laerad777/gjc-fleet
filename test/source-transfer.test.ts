import { test, expect } from "bun:test";
import { posixOnly } from "./source-transfer-platform";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, chmod, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageSource, receiveSource as receiveWire, returnResult, boundedLocal as sendWire, deliverSource as deliverWire } from "../src/source-transfer";
import { previewInput, authorizeInput, checkInputPathSet, INPUT_PATH_BUDGETS } from "../src/inputs";
import { run, sha256 } from "../src/workspace";
import type { NodeConfig } from "../src/contracts";
const receiveSource = (node: NodeConfig, value: unknown, options = {}) => receiveWire(node, JSON.stringify(value), options);
const boundedLocal = (command: string, args: string[], value: unknown, timeout?: number) => sendWire(command, args, JSON.stringify(value), timeout);
const deliverSource = (transport: {command:string; args:string[]}, value: unknown) => deliverWire(transport, JSON.stringify(value));

posixOnly("authorized narrow tree roundtrip, explicit snapshot, refusal preserves target and index", async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-transfer-test-")));
 try {
  const repo = join(root,"repo"); await mkdir(repo);
  const git = async (...args:string[]) => {
   const r = await run(["git","-c","core.hooksPath=" + join(root,"disabled-hooks"),"-c","user.name=Fixture","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","-C",repo,...args],repo);
   if(r.exit) throw new Error(r.stderr); return r.stdout.trim();
  };
  await git("init","--template=");
  await writeFile(join(repo,"deleted"),"DELETED_HISTORY_MUST_NOT_TRANSFER");
  await git("add","."); await git("commit","-qm","history");
  const deletedOid = await git("rev-parse","HEAD:deleted");
  await git("rm","deleted");
  await writeFile(join(repo,"binary"),Buffer.from([0,255,1]));
  await git("add","."); await git("commit","-qm","base");
  const base = await git("rev-parse","HEAD");
  await writeFile(join(repo,"extra"),"explicit untracked snapshot");
  await writeFile(join(repo,"binary"),Buffer.from([255,0,128]));
  const index = await readFile(join(repo,".git/index"));
  const preview = await previewInput({repo,repoId:"repo",baseCommit:base,paths:["binary","extra"],includeObjects:true});
  const pkg = authorizeInput(preview,preview.digest,"test approval");
  const staged = await stageSource(repo,{taskId:"task",attemptId:"attempt",inputDigest:sha256("input")},pkg);
  const delivery = JSON.parse(staged);
  expect(typeof staged).toBe("string");
  for (const mutate of [
   (d:any) => { d.inputPackage.authorization.reference = {}; },
   (d:any) => { d.inputPackage.unexpected = true; },
   (d:any) => { d.inputPackage.objects[0].size = "1"; },
   (d:any) => { d.inputPackage.changes[0].after.extra = 1; },
   (d:any) => { d.inputDigest = []; },
  ]) {
   const invalid = structuredClone(delivery); mutate(invalid);
   await expect(receiveSource({} as any, invalid)).rejects.toThrow();
  }
  await expect(deliverSource({command:"ssh",args:[]},delivery)).rejects.toThrow("remote_transport_unsupported");
  const node:NodeConfig = {id:"local",os:process.platform,arch:process.arch,roots:{repo},workspaceRoot:join(root,"work"),enabled:true,draining:false,reachable:true,sdkReady:true,modelReady:true,models:[],transport:{command:"bun",args:[]},operations:[]};
  expect(JSON.stringify(delivery)).not.toContain("DELETED_HISTORY_MUST_NOT_TRANSFER");
  expect(delivery.inputPackage.objects!.some((o: { oid: string }) => o.oid === deletedOid)).toBe(false);
  const history = structuredClone(delivery);
  const secret = Buffer.from("DELETED_HISTORY_MUST_NOT_TRANSFER");
  history.inputPackage.objects!.push({oid:deletedOid,type:"blob",size:secret.length,sha256:sha256(secret),contentBase64:secret.toString("base64")});
  await expect(receiveSource(node,history)).rejects.toThrow("extraneous_object");
  const oversized = structuredClone(delivery);
  oversized.inputPackage.objects![0]!.size = 16 * 1024 * 1024 + 1;
  await expect(receiveSource(node,oversized)).rejects.toThrow("input_byte_limit");
  await expect(receiveSource(node,{...delivery,inputDigest:"x".repeat(33*1024*1024)})).rejects.toThrow("delivery_limit");
  await expect(receiveSource(node,{...delivery,inputPackage:{...pkg,digest:"0".repeat(64)}})).rejects.toThrow();
  const corrupt = Buffer.from("not a bundle");
  await expect(receiveSource(node,{...delivery,bundleBase64:corrupt.toString("base64"),bundleDigest:sha256(corrupt)} as any)).rejects.toThrow("history_or_pack_transfer_refused");
  const corruptedObject = structuredClone(delivery);
  corruptedObject.inputPackage.objects![0]!.contentBase64 = Buffer.from("corrupt").toString("base64");
  await expect(receiveSource(node,corruptedObject)).rejects.toThrow();
  const other = structuredClone(delivery);
  other.inputPackage.baseCommit = "0".repeat(40);
  await expect(receiveSource(node,other)).rejects.toThrow();
  await expect(receiveSource(node,{...delivery,taskId:"../escape"})).rejects.toThrow();
  // These deliberately keep the old digest: path budgets must refuse before hashing.
  for (const path of ["x".repeat(4097), "a/".repeat(256) + "x", "€".repeat(1366)]) {
   const invalid = structuredClone(delivery);
   invalid.inputPackage.changes[0].path = path;
   await expect(receiveSource(node,invalid)).rejects.toThrow("input_path_limit");
   await expect(lstat(node.workspaceRoot)).rejects.toThrow();
  }
  const manyPaths = structuredClone(delivery);
  manyPaths.inputPackage.changes = Array.from({length:100}, (_, i) => ({
   ...structuredClone(delivery.inputPackage.changes[0]), path:String(i) + "x".repeat(3000),
  }));
  await expect(receiveSource(node,manyPaths)).rejects.toThrow("input_path_set_limit");
  await expect(lstat(node.workspaceRoot)).rejects.toThrow();
  const receipt = await receiveSource(node,delivery);
  expect((await readdir(node.workspaceRoot)).some(n => n.startsWith(".source-transfer-tmp-"))).toBe(false);
  const absent = await run(["git","-C",receipt.identity.path,"cat-file","-e",deletedOid],repo);
  expect(absent.exit).not.toBe(0);
  expect(await readFile(join(repo,".git/index"))).toEqual(index);
  await git("add","binary"); await git("commit","-qm","different base");
  await expect(receiveSource(node,{...delivery,taskId:"another-task"})).rejects.toThrow();
  expect(await readFile(join(receipt.identity.path,"binary"))).toEqual(Buffer.from([255,0,128]));
  expect(await readFile(join(receipt.identity.path,"extra"),"utf8")).toBe("explicit untracked snapshot");
  await expect(receiveSource(node,delivery)).rejects.toThrow();
  expect(await readFile(join(receipt.identity.path,"extra"),"utf8")).toBe("explicit untracked snapshot");
  // Staging/delivery did not touch the source index; the explicit fixture commit above did.
  const config = join(root,"node.json"); await writeFile(config,JSON.stringify(node));
  const result = await returnResult({command:process.execPath,args:[join(import.meta.dir,"../src/node.ts"),config]},receipt.identity);
  expect(result.identity).toEqual(receipt.identity);
  expect(result.files.some((f:any)=>f.path === "extra")).toBe(true);
  await expect(stageSource(repo,{taskId:"missing",attemptId:"a",inputDigest:sha256("i")},{...pkg,baseCommit:"1".repeat(40)})).rejects.toThrow();
  const realGit = Bun.which("git")!;
  const bin = join(root,"bin"); await mkdir(bin);
  await writeFile(join(bin,"git"),`#!${process.execPath}\nsetInterval(()=>{},1000);\n`);
  await chmod(join(bin,"git"),0o700);
  const oldPath = process.env.PATH;
  const timedRoot = join(root,"timed-work");
  try {
   process.env.PATH = bin + ":" + oldPath;
   await expect(receiveSource({...node,workspaceRoot:timedRoot},delivery,{timeoutMs:500})).rejects.toThrow("source_deadline");
   await expect(lstat(timedRoot)).rejects.toThrow();
  } finally { process.env.PATH = oldPath; }
  // Pause only after neutralRepository has allocated scratch outside its worktree.
  const scratchMarker = join(root,"scratch-marker");
  await writeFile(join(bin,"git"), `#!${process.execPath}
if (process.env.GIT_DIR && process.argv.includes('read-tree')) {
 await Bun.write(${JSON.stringify(scratchMarker)}, process.env.GIT_DIR);
 setInterval(() => {},1000);
} else {
 const c = Bun.spawnSync([${JSON.stringify(realGit)}, ...process.argv.slice(2)], {stdin:'inherit',stdout:'inherit',stderr:'inherit'});
 process.exit(c.exitCode);
}
`);
  const scratchRoot = join(root,"scratch-work");
  try {
   process.env.PATH = bin + ":" + oldPath;
   await expect(receiveSource({...node,workspaceRoot:scratchRoot},delivery,{timeoutMs:5000})).rejects.toThrow("source_deadline");
  } finally { process.env.PATH = oldPath; }
  const gitDir = await readFile(scratchMarker,"utf8");
  const tempBase = join(gitDir,"../..");
  expect(tempBase.startsWith(join(scratchRoot,".source-transfer-tmp-"))).toBe(true);
  expect(gitDir.startsWith(tempBase + "/")).toBe(true);
  await expect(lstat(tempBase)).rejects.toThrow();
  await expect(lstat(scratchRoot)).rejects.toThrow();
  const failedRoot = join(root,"failed-work");
  await expect(receiveSource({...node,workspaceRoot:failedRoot,id:"bad/id"},delivery)).rejects.toThrow();
  await expect(lstat(failedRoot)).rejects.toThrow();
 } finally { await rm(root,{recursive:true,force:true}); }
}, 20_000);

posixOnly("silent child and descendant holding pipes have bounded lifetime and are terminated", async () => {
 const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-deadline-")));
 try {
  const pidfile = join(root,"pid");
  const started = Date.now();
  await expect(boundedLocal(process.execPath,["-e","setInterval(() => {}, 1000)"],{},150)).rejects.toThrow("source_deadline");
  expect(Date.now() - started).toBeLessThan(3000);
  const code = `const c = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {stdout:'inherit',stderr:'inherit'}); await Bun.write(${JSON.stringify(pidfile)},String(c.pid)); console.log(JSON.stringify({ok:true,value:1})); process.exit(0);`;
  const before = Date.now();
  await expect(boundedLocal(process.execPath,["-e",code],{},500)).rejects.toThrow("source_deadline");
  expect(Date.now() - before).toBeLessThan(3000);
  const pid = Number(await readFile(pidfile,"utf8"));
  // Descendants cannot be waitpid-reaped by this process. Allow init to reap them.
  let alive = true;
  for (let i=0;i<100;i++) {
   try { process.kill(pid,0); } catch (e:any) { if(e.code !== "ESRCH") throw e; alive=false; break; }
   await Bun.sleep(10);
  }
  expect(alive).toBe(false);
 } finally { await rm(root,{recursive:true,force:true}); }
});

posixOnly("output cap, invalid deadline, spawn failure and unsupported transport refuse", async () => {
 await expect(boundedLocal(process.execPath,["-e","process.stdout.write('x'.repeat(33*1024*1024)); setInterval(()=>{},1000)"],{},2000)).rejects.toThrow("response_limit");
 await expect(boundedLocal(process.execPath,[],{},0)).rejects.toThrow("invalid_deadline");
 await expect(boundedLocal("/nonexistent-fleet-executable",[],{},100)).rejects.toThrow();
 await expect(returnResult({command:"ssh",args:[]},{} as any)).rejects.toThrow("remote_transport_unsupported");
});

test("platform gate: win32 refuses every entry point before parsing or spawning; POSIX passes the gate", async () => {
 const win32 = process.platform === "win32";
 const gate = "source_transfer_platform_unsupported";
 await expect(sendWire("/must-not-spawn", [], "{}", 0)).rejects.toThrow(win32 ? gate : "invalid_deadline");
 await expect(deliverWire({command:"ssh",args:[]}, "{}")).rejects.toThrow(win32 ? gate : "invalid_identity");
 await expect(receiveWire({} as any, "{}")).rejects.toThrow(win32 ? gate : "invalid_identity");
 const staged = await stageSource(win32 ? "C:\\must-not-read" : "/must-not-read", {taskId:"t",attemptId:"a",inputDigest:sha256("i")}, {} as any).then(() => "resolved", (e: Error) => e.message);
 if (win32) expect(staged).toBe(gate);
 else { expect(staged).not.toBe("resolved"); expect(staged).not.toContain(gate); }
 await expect(returnResult({command:"ssh",args:[]},{} as any)).rejects.toThrow("remote_transport_unsupported");
});

test("path budgets: inclusive 4096B / 256 components / 256KiB pass; one over each fails", () => {
	expect(INPUT_PATH_BUDGETS).toEqual({ bytes: 4096, components: 256, setBytes: 256 * 1024 });
	expect(() => checkInputPathSet(["x".repeat(INPUT_PATH_BUDGETS.bytes)])).not.toThrow();
	expect(() => checkInputPathSet(["x".repeat(INPUT_PATH_BUDGETS.bytes + 1)])).toThrow(/input_path_limit/);
	expect(() => checkInputPathSet(["a/".repeat(INPUT_PATH_BUDGETS.components - 1) + "z"])).not.toThrow();
	expect(() => checkInputPathSet(["a/".repeat(INPUT_PATH_BUDGETS.components) + "z"])).toThrow(/input_path_limit/);
	const atSet: string[] = [];
	let used = 0;
	for (let i = 0; used < INPUT_PATH_BUDGETS.setBytes; i++) {
		const prefix = `f${i}/`;
		const room = Math.min(1024, INPUT_PATH_BUDGETS.setBytes - used - Buffer.byteLength(prefix, "utf8"));
		if (room <= 0) break;
		const path = prefix + "x".repeat(room);
		atSet.push(path);
		used += Buffer.byteLength(path, "utf8");
	}
	expect(used).toBe(INPUT_PATH_BUDGETS.setBytes);
	expect(() => checkInputPathSet(atSet)).not.toThrow();
	expect(() => checkInputPathSet([...atSet, "x"])).toThrow(/input_path_set_limit/);
});
