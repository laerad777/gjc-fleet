import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson } from "./core";
import { validateInputPackage, type InputPackage } from "./inputs";
import { nodeOperation } from "./node";
import type { NodeConfig } from "./contracts";
import { sha256, type WorkspaceIdentity } from "./workspace";
import { parseWire, serializeWire, wireText, WIRE_LIMIT, type Wire } from "./transfer-wire";
import { spawnTrustedNode } from "./spawn";
const DEADLINE = 30_000;
export interface SourceDelivery {
 schemaVersion: 2;
 taskId: string;
 attemptId: string;
 inputDigest: string;
 inputPackage: InputPackage;
}
function supported() {
 if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("source_transfer_platform_unsupported");
}
function check(value: SourceDelivery) {
 if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).some(k => !["schemaVersion", "taskId", "attemptId", "inputDigest", "inputPackage"].includes(k))) throw new Error("history_or_pack_transfer_refused");
 for (const id of [value.taskId, value.attemptId])
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("invalid_identity");
 if (value.schemaVersion !== 2 || typeof value.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.inputDigest)) throw new Error("invalid_delivery");
 const pkg = value.inputPackage;
 if (!pkg || !Array.isArray(pkg.objects) || !Array.isArray(pkg.changes)) throw new Error("authorized_objects_required");
 const shape = (v: any, fields: Record<string, string>) => {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== Object.keys(fields).length || Object.keys(v).some(k => !(k in fields))) throw new Error("invalid_input_shape");
  for (const [key, type] of Object.entries(fields)) if (typeof v[key] !== type || (type === "object" && v[key] === null)) throw new Error("invalid_input_shape");
 };
 shape(pkg, {schemaVersion:"number",repoId:"string",baseCommit:"string",digest:"string",changes:"object",objects:"object",authorization:"object"});
 shape(pkg.authorization, {digest:"string",reference:"string"});
 for (const o of pkg.objects) shape(o, {oid:"string",type:"string",size:"number",sha256:"string",contentBase64:"string"});
 for (const c of pkg.changes) {
  if (!c || c.before === undefined || c.after === undefined) throw new Error("invalid_input_shape");
  if (typeof c.path !== "string" || Object.keys(c).length !== 3 || Object.keys(c).some(k => !["path","before","after"].includes(k))) throw new Error("invalid_input_shape");
  if (c.before !== null) shape(c.before, {sha256:"string",mode:"number"});
  if (c.after !== null) shape(c.after, {sha256:"string",mode:"number",bytes:"number",contentBase64:"string"});
 }
 let total = 0;
 for (const o of [...pkg.objects, ...pkg.changes.map(c => c?.after).filter(c => c !== null)]) {
  if (!o || typeof o !== "object") throw new Error("invalid_input_shape");
  const size = "size" in o ? o.size : o.bytes;
  if (!Number.isSafeInteger(size) || size < 0 || typeof o.contentBase64 !== "string" || o.contentBase64.length !== Math.ceil(size / 3) * 4) throw new Error("input_byte_limit");
  total += size;
  if (total > 16 * 1024 * 1024) throw new Error("input_byte_limit");
 }
 validateInputPackage(pkg);
 if (pkg.authorization?.digest !== pkg.digest) throw new Error("authorized_objects_required");
}
/** Local POSIX process group; absolute deadline includes retained descendant pipes.
 * Always kill the group, destroy pipes and await the direct child. */
export async function boundedLocal(command: string, args: string[], request: Wire, timeoutMs = DEADLINE, tempRoot?: string): Promise<any> {
 supported(); const text = wireText(request); parseWire(text);
 if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEADLINE) throw new Error("invalid_deadline");
 const child = spawnTrustedNode(command, args, {
  detached: true, stdio: ["pipe", "pipe", "pipe"],
  ...(tempRoot === undefined ? {} : {env:{...process.env, TMPDIR:tempRoot, TMP:tempRoot, TEMP:tempRoot}}),
 });
 const kill = () => {
  if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch (e: any) { if (e.code !== "ESRCH") throw e; }
 };
 let timer: ReturnType<typeof setTimeout> | undefined;
 const exited = new Promise<number | null>((res, rej) => { child.once("error", rej); child.once("exit", res); });
 const output = new Promise<string>((res, rej) => {
  let size = 0; const chunks: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => { size += b.length; if (size > WIRE_LIMIT) rej(new Error("response_limit")); else chunks.push(b); });
  child.stderr.on("data", (b: Buffer) => { size += b.length; if (size > WIRE_LIMIT) rej(new Error("response_limit")); });
  child.stdout.once("end", () => res(Buffer.concat(chunks).toString("utf8")));
  child.stdout.once("error", rej); child.stderr.once("error", rej); child.stdin.once("error", rej);
 });
 const done = Promise.all([exited, output]);
 const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("source_deadline")), timeoutMs); });
 try {
  child.stdin.end(text);
  const [code, response] = await Promise.race([done, deadline]);
  if (code !== 0) throw new Error("source_child_failed");
  const reply = parseWire(response);
  if (reply.ok !== true) throw new Error("source_child_refused");
  return reply.value;
 } finally {
  if (timer) clearTimeout(timer);
  kill();
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  await exited.catch(() => {});
 }
}
/** Trusted producer only: serialize once, then enforce the actual wire byte size. */
export async function stageSource(repo: string, binding: Pick<SourceDelivery, "taskId" | "attemptId" | "inputDigest">, inputPackage: InputPackage): Promise<string> {
 supported();
 if (await realpath(repo) !== resolve(repo)) throw new Error("canonical_source_required");
 const wire = serializeWire({schemaVersion:2, ...binding, inputPackage});
 check(parseWire(wire));
 return wire;
}
/** Untrusted delivery accepts bytes only. The workspace root is exclusive/single-use. */
export async function receiveSource(node: NodeConfig, wire: Wire, options: {timeoutMs?: number} = {}) {
 supported(); const delivery = parseWire(wire) as SourceDelivery; check(delivery);
 // Node configuration is trusted local configuration, not part of the delivery contract.
 const request = serializeWire({node, delivery});
 if (node.workspaceRoot !== resolve(node.workspaceRoot)) throw new Error("canonical_workspace_root_required");
 await mkdir(node.workspaceRoot, {mode:0o700});
 try {
  if (await realpath(node.workspaceRoot) !== node.workspaceRoot) throw new Error("canonical_workspace_root_required");
  // The parent owns helper scratch space, including when SIGKILL skips helper finally blocks.
  const tempRoot = await mkdtemp(join(node.workspaceRoot, ".source-transfer-tmp-"));
  try {
   const identity = await boundedLocal(process.execPath, [import.meta.path, "--prepare"], request, options.timeoutMs, tempRoot) as WorkspaceIdentity;
   const receipt = {schemaVersion:2, taskId:delivery.taskId, attemptId:delivery.attemptId, inputDigest:delivery.inputDigest, inputPackageDigest:delivery.inputPackage.digest, identity};
   return {...receipt, receiptDigest:sha256(canonicalJson(receipt))};
  } finally {
   // boundedLocal has stopped and awaited the helper before this removal.
   await rm(tempRoot, {recursive:true, force:true});
  }
 } catch (error) {
  await rm(node.workspaceRoot, {recursive:true, force:true}); throw error;
 }
}
/** Remote cleanup cannot be established by killing SSH. Only the local helper is supported. */
export async function returnResult(transport: {command:string; args:string[]}, identity: WorkspaceIdentity) {
 const helper = resolve(import.meta.dir, import.meta.path.endsWith(".js") ? "node.js" : "node.ts");
 if (transport.command !== process.execPath || transport.args.length !== 2 || resolve(transport.args[0]!) !== helper) throw new Error("remote_transport_unsupported");
 return boundedLocal(transport.command, transport.args, serializeWire({action:"collect", identity}));
}
export async function deliverSource(_transport: {command:string; args:string[]}, wire: Wire): Promise<never> {
 supported(); check(parseWire(wire));
 throw new Error("remote_transport_unsupported_use_receiveSource_locally");
}
if (import.meta.main) {
 try {
  supported();
  if (process.argv[2] !== "--prepare") throw new Error("local_prepare_only");
  let size = 0; const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
   size += chunk.length; if (size > WIRE_LIMIT) throw new Error("delivery_limit"); chunks.push(chunk);
  }
  const request = parseWire(Buffer.concat(chunks));
  if (!request || Object.keys(request).some(k => !["node", "delivery"].includes(k))) throw new Error("invalid_wire_data");
  const {node, delivery} = request; check(delivery);
  const pkg = delivery.inputPackage;
  const value = await nodeOperation(node, {action:"prepare", input:{taskId:delivery.taskId, attemptId:delivery.attemptId, nodeId:node.id, inputDigest:delivery.inputDigest, repoId:pkg.repoId, baseCommit:pkg.baseCommit, inputPackage:pkg}});
  console.log(JSON.stringify({ok:true, value}));
 } catch { console.log(JSON.stringify({ok:false, error:"source_delivery_refused"})); process.exitCode = 1; }
}
