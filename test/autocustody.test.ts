import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { FleetDaemon } from "../src/daemon";
import { digest } from "../src/core";
import { prepareWorkspace } from "../src/workspace";
import { repositoryFixture } from "./fixtures/coordinator";
import { fakeBroker } from "./fixtures/daemon";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const CLI = join(import.meta.dir,"../src/cli.ts");
const fast = {cycleMs:20,leaseMs:4000,nodeGapMs:()=>0,returnPaceMs:0,returnEveryMs:20,graceMs:5000};
async function run(d: FleetDaemon, ms=180) {
 const done=d.run();
 try {await Bun.sleep(ms);} finally {d.stop();await done;}
}
async function fixture(authorized=true) {
 const repo=await repositoryFixture("au-");
 cleanups.push(()=>rm(repo.dir,{recursive:true,force:true}));
 const db=join(repo.dir,"fleet.sqlite");
 const store=new FleetStore(db);
 let fleet=new Fleet(store);
 cleanups.push(async()=>{await fleet.close();store.close();});
 const request={schemaVersion:1,key:"auto",caller:"controlled",repoId:"repo",baseCommit:repo.baseCommit,prompt:"Write answer.txt",required:{},...(authorized?{autoCustody:{paths:["answer.txt"]}}:{})};
 const input=join(repo.dir,"task.json");
 await writeFile(input,JSON.stringify(request));
 const resources=join(repo.dir,"resources.json");await writeFile(resources,"{}");
 // Real CLI submission, private database, no node registered: submission cannot dispatch.
 const child=Bun.spawn([process.execPath,CLI,"--db",db,"--resources",resources,"submit",input],{stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({stderr,exit}).toEqual({stderr:"",exit:1}); // queued, no admissible node
 const id=JSON.parse(stdout).id;
 const config=join(repo.dir,"node.json");
 const coordinator=join(repo.dir,"coordinator.json"),execution=join(repo.dir,"execution.json");
 const n={id:"local",os:process.platform,arch:process.arch,roots:{repo:repo.repo},workspaceRoot:repo.workspaceRoot,enabled:true,draining:false,reachable:true,sdkReady:true,modelReady:true,models:[],operations:[],transport:{command:process.execPath,args:[join(import.meta.dir,"fixtures/coordinator.ts"),coordinator]},sdkTransport:{command:process.execPath,args:[join(import.meta.dir,"fixtures/execution-query.ts"),execution,join(repo.dir,"execution.log")]},workspaceTransport:{command:process.execPath,args:[join(import.meta.dir,"../src/node.ts"),config]}};
 await writeFile(config,JSON.stringify(n));
 store.putNode(n);
 const task=store.reserve(id)!;
 const identity=await prepareWorkspace({taskId:id,attemptId:task.attemptId!,nodeId:n.id,inputDigest:task.inputDigest,repo:repo.repo,baseCommit:repo.baseCommit,workspaceRoot:repo.workspaceRoot});
 store.setWorkspace(id,identity as any);
 const create=store.claimOperation(id,"create",{cwd:identity.path})!;
 const sessionId="controlled-session",turnId="controlled-turn";
 store.recordSession(id,sessionId,true,{operationId:create.id,ephemeral:true,cwd:identity.path});
 store.recordSessionAuthority(id,{sessionId,cwd:identity.path,endpointGeneration:1,endpointIncarnation:"b".repeat(64)});
 store.recordTurn(id,turnId);
 // Real inspect/settlement using controlled public transport evidence, not an external agent run.
 await writeFile(coordinator,JSON.stringify({calls:[],readTurn:{ok:true,turn:{session_id:sessionId,turn_id:turnId,status:"completed",final_response:{source:"agent_end"},delivery:{runtime_command_id:"command",runtime_turn_id:"runtime-turn",prompt_acknowledged:true,queued:false}},advisory_status:{authority:"sdk",live:true,is_streaming:false},session_state:{session_id:sessionId,state:"completed",current_turn_id:turnId}}}));
 await writeFile(execution,JSON.stringify({status:"terminal_ok",receiptState:"present",terminalAt:1,outcome:{kind:"stopped",reason:"end_turn",provenance:"agent"}}));
 await fleet.inspect(id);
 expect(store.task(id)!.result?.executionTerminal).toBe(true);
 await writeFile(join(identity.path,"answer.txt"),"selected answer\n");
 await writeFile(join(identity.path,"scratch.txt"),"must not collect\n");
 await fleet.close();
 fleet=new Fleet(store,{localNodeId:n.id});
 const broker=fakeBroker(repo.dir,store);
 // Already-absent session: existing listing-only return, no close or broker command.
 const connectReturn=async()=>{
  const c=await broker.connect();
  return {...c,list:async()=>({type:"broker_response",ok:true,result:{indexSeq:Date.now()*1000,sessions:[]}})};
 };
 const daemon=()=>new FleetDaemon(fleet,{...fast,connectReturn:connectReturn as any,sample:async()=>({ok:false,at:Date.now(),error:"unused"})});
 const mutate=(f:(t:any)=>void)=>{const sql=new Database(db);try{const row=sql.query("SELECT data FROM tasks WHERE id=?").get(id) as any;const t=JSON.parse(row.data);f(t);sql.query("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(t),id);}finally{sql.close();}};
 return {repo,db,store,fleet,id,identity,request,daemon,mutate};
}

test("CLI submission -> store -> daemon -> real node selected custody -> existing resource return",async()=>{
 const f=await fixture();
 expect(f.store.task(f.id)!.input.autoCustody).toEqual({paths:["answer.txt"]});
 expect(()=>f.store.submit({...f.request,autoCustody:{paths:["other.txt"]}} as any)).toThrow("Caller/key");
 await run(f.daemon(),700);
 const t=f.store.task(f.id)!;
 expect((t.resultManifest as any).files.map((x:any)=>x.path)).toEqual(["answer.txt"]);
 expect((t.resultManifest as any).custody).toEqual({kind:"selected",paths:["answer.txt"],selectionDigest:digest(["answer.txt"])});
 expect(t.phase).toBe("completed_unverified");
 expect(t.result?.verified).toBe(false);
 expect(f.store.getOperation(f.id,"auto-custody")?.receipt).toBeDefined();
 expect(f.store.getOperation(f.id,"resource-return-confirmed")).toBeDefined();
 expect(f.store.getOperation(f.id,"verify-test")).toBeUndefined();
 // Crash window: manifest saved, but the operation receipt was not retained. Custody is still cached.
 const sql=new Database(f.db);
 try {
  const row=sql.query("SELECT data FROM operations WHERE task_id=? AND kind='auto-custody'").get(f.id) as any;
  const op=JSON.parse(row.data);delete op.receipt;
  sql.query("UPDATE operations SET data=? WHERE task_id=? AND kind='auto-custody'").run(JSON.stringify(op),f.id);
 } finally {sql.close();}
 const node=spyOn(f.fleet as any,"node").mockImplementation(()=>{throw new Error("cached custody must not contact node");});
 try {
  const saved=digest(t.resultManifest);
  expect(digest(await f.fleet.result(f.id,undefined,["answer.txt"]))).toBe(saved);
  expect(digest(await f.fleet.result(f.id))).toBe(saved); // existing export/watch callers adopt the bound input
  await run(f.daemon());
  expect(node).not.toHaveBeenCalled();
 } finally {node.mockRestore();}
},20000);

test("no field preserves old behavior: daemon waits for operator collection",async()=>{
 const f=await fixture(false);
 await run(f.daemon());
 expect(f.store.task(f.id)!.resultManifest).toBeUndefined();
 expect(f.store.getOperation(f.id,"auto-custody")).toBeUndefined();
 expect(f.store.getOperation(f.id,"resource-return-confirmed")).toBeUndefined();
},20000);

for(const state of ["failed","cancelled","cancel_unknown","archived","active","blocked_unknown","unowned","missing_receipt","wrong_receipt","client_cancel","approval"]){
 test(`automatic custody refuses ${state}`,async()=>{
  const f=await fixture();
  if(state==="unowned"){
   const sql=new Database(f.db);try{sql.query("DELETE FROM operations WHERE task_id=? AND kind='session-authority'").run(f.id);}finally{sql.close();}
  }else f.mutate(t=>{
   if(state==="missing_receipt") t.result.evidence.execution.receiptState="missing";
   else if(state==="wrong_receipt") t.result.evidence.execution.commandId="foreign";
   else if(state==="client_cancel") t.result.evidence.execution.outcome={kind:"stopped",reason:"cancelled",provenance:"client_cancel"};
   else if(state==="approval") t.input.approvalContract="sdk-ui";
   else {t.phase=state;if(state==="active")t.result.executionTerminal=false;}
  });
  const node=spyOn(f.fleet as any,"node").mockImplementation(()=>{throw new Error("must not collect");});
  try{
   await expect(f.fleet.automaticCustody(f.id)).rejects.toMatchObject({code:"AUTO_CUSTODY_REFUSED"});
   // Live tasks are observed separately; do not use a fabricated transport for that unrelated path.
   if(state!=="active") await run(f.daemon());
   expect(node).not.toHaveBeenCalled();
   expect(f.store.task(f.id)!.resultManifest).toBeUndefined();
   expect(f.store.getOperation(f.id,"auto-custody")).toBeUndefined();
  }finally{node.mockRestore();}
 },20000);
}

test("missing selected file holds custody and return; restart cannot repeat uncertain collection",async()=>{
 const f=await fixture();
 await rm(join(f.identity.path,"answer.txt"));
 await run(f.daemon(),500);
 expect(f.store.getOperation(f.id,"auto-custody")).toBeDefined();
 expect(f.store.task(f.id)!.resultManifest).toBeUndefined();
 expect(f.store.getOperation(f.id,"resource-return-confirmed")).toBeUndefined();
 await writeFile(join(f.identity.path,"answer.txt"),"now present, not replay authority");
 const other=new FleetStore(f.db);const fleet=new Fleet(other,{localNodeId:"local"});
 try{
  await expect(fleet.automaticCustody(f.id)).rejects.toMatchObject({code:"CUSTODY_UNKNOWN"});
  await run(new FleetDaemon(fleet,fast));
  expect(other.task(f.id)!.resultManifest).toBeUndefined();
  expect(other.events(f.id).filter(e=>e.kind==="daemon_note").some(e=>JSON.stringify(e.data).includes("no_replay"))).toBe(true);
 }finally{await fleet.close();other.close();}
},20000);

test("concurrent foreground and daemon share one non-replayable collection claim",async()=>{
 const f=await fixture();
 const original=(f.fleet as any).node.bind(f.fleet);
 let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const node=spyOn(f.fleet as any,"node").mockImplementation(async(...args:any[])=>{entered();await barrier;return original(...args);});
 const first=f.fleet.automaticCustody(f.id);
 try{
  await started;
  await expect(f.fleet.result(f.id,undefined,["answer.txt"])).rejects.toMatchObject({code:"CUSTODY_UNKNOWN"});
  await expect(f.fleet.result(f.id,[process.execPath,"-e","throw new Error('must not run')"],["answer.txt"])).rejects.toMatchObject({code:"CUSTODY_FIRST"});
  expect(f.store.getOperation(f.id,"verify-test")).toBeUndefined();
  await run(f.daemon());
  expect(node).toHaveBeenCalledTimes(1);
 }finally{release();await first;node.mockRestore();}
},20000);

test("eligibility lost while collecting cannot publish custody or return capacity",async()=>{
 const f=await fixture();
 const original=(f.fleet as any).node.bind(f.fleet);
 const node=spyOn(f.fleet as any,"node").mockImplementation(async(...args:any[])=>{
  const result=await original(...args);
  f.mutate(t=>{t.phase="archived";});
  return result;
 });
 try{
  await expect(f.fleet.automaticCustody(f.id)).rejects.toMatchObject({code:"AUTO_CUSTODY_REFUSED"});
  expect(f.store.task(f.id)!.resultManifest).toBeUndefined();
  expect(f.store.getOperation(f.id,"resource-return-confirmed")).toBeUndefined();
 }finally{node.mockRestore();}
},20000);

test("rollback blocks a new collection claim without contacting the node",async()=>{
 const f=await fixture();
 f.store.enterRollback();
 const node=spyOn(f.fleet as any,"node").mockImplementation(()=>{throw new Error("must not collect");});
 try{
  await run(f.daemon());
  await expect(f.fleet.automaticCustody(f.id)).rejects.toMatchObject({code:"DISPATCH_DISABLED"});
  expect(node).not.toHaveBeenCalled();
  expect(f.store.getOperation(f.id,"auto-custody")).toBeUndefined();
 }finally{node.mockRestore();}
},20000);

test("submission validates canonical exact paths, with no extra authority fields",async()=>{
 const f=await fixture(false);
 for(const autoCustody of [{paths:[]},{paths:["*.txt"]},{paths:["../x"]},{paths:[".env"]},{paths:["a","A"]},{paths:["z","a"]},{paths:["answer.txt"],argv:["evil"]}]){
  expect(()=>f.store.submit({...f.request,key:JSON.stringify(autoCustody),autoCustody} as any)).toThrow();
 }
 expect(()=>f.store.submit({...f.request,key:"valid",autoCustody:{paths:["a","z"]}} as any)).not.toThrow();
},20000);

test("refused custody caches full hydration and rechecks changed authority promptly",async()=>{
 const f=await fixture();
 const sql=new Database(f.db);
 const authority=sql.query("SELECT * FROM operations WHERE task_id=? AND kind='session-authority'").get(f.id) as any;
 try {sql.query("DELETE FROM operations WHERE id=?").run(authority.id);} finally {sql.close();}
 const d=f.daemon() as any;
 const now=Date.now();
 d.refreshIndex(now);
 const hydration=spyOn(f.store,"task");
 try {
  for(let i=0;i<100;i++) expect(d.next("local",now)).toBeUndefined();
  expect(hydration.mock.calls.length).toBe(1);
  // The refusal note itself can invalidate once; it must not cause endless reads.
  d.refreshIndex(now+1);
  d.next("local",now+1);
  const afterNote=hydration.mock.calls.length;
  for(let i=0;i<100;i++){d.refreshIndex(now+2);d.next("local",now+2);}
  expect(hydration.mock.calls.length).toBe(afterNote);
  // Terminal authority cannot be rewritten via the public API. Restore the private
  // fixture and publish a change-feed event, as a receipt/ownership writer does.
  const restore=new Database(f.db);
  try {restore.query("INSERT INTO operations(id,task_id,attempt_id,kind,data) VALUES (?,?,?,?,?)").run(authority.id,authority.task_id,authority.attempt_id,authority.kind,authority.data);} finally {restore.close();}
  f.store.recordDaemonNote(f.id,"fixture_authority_restored");
  d.refreshIndex(now+3);
  expect(d.next("local",now+3)?.kind).toBe("custody");
  expect(hydration.mock.calls.length).toBeGreaterThan(afterNote);
 } finally {hydration.mockRestore();}
},20000);
