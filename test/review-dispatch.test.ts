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
async function fixture(policy?: any, paths=["answer.txt"]) {
 const authorized=true;
 const repo=await repositoryFixture("au-");
 cleanups.push(()=>rm(repo.dir,{recursive:true,force:true}));
 const db=join(repo.dir,"fleet.sqlite");
 const store=new FleetStore(db);
 let fleet=new Fleet(store);
 cleanups.push(async()=>{await fleet.close();store.close();});
 const request={schemaVersion:1,key:"auto",caller:"controlled",repoId:"repo",baseCommit:repo.baseCommit,prompt:"Write answer.txt",required:{},autoCustody:{paths},...(policy?{reviewDispatch:policy}:{})};
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
 return {repo,db,store,get fleet(){return fleet;},id,identity,request,daemon,mutate,n,coordinator,execution};
}


const policy={path:"answer.txt",required:{},promptTemplate:"Review {path} independently."};
const children=(f:any)=>f.store.tasks().filter((t:any)=>t.id!==f.id);
const sha=(text:string)=>new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("no reviewDispatch: custody saved, no child submitted (old behavior)",async()=>{
 const f=await fixture();
 await run(f.daemon(),700);
 expect(f.store.getOperation(f.id,"auto-custody")?.receipt).toBeDefined();
 expect(children(f)).toEqual([]);
},20000);

test("policy: one queued child whose subject comes from the saved manifest only",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const t=f.store.task(f.id)!;
 const entry=(t.resultManifest as any).files.find((x:any)=>x.path==="answer.txt");
 expect(entry.sha256).toBe(sha("selected answer\n"));
 const kids=children(f);
 expect(kids.length).toBe(1);
 const c=kids[0];
 expect(c.phase).toBe("queued");
 expect(c.input.subject).toEqual({taskId:f.id,path:"answer.txt",sha256:entry.sha256,otherNode:true});
 expect(c.input.prompt.startsWith("Review answer.txt independently.\n")).toBe(true);
 // the reviewer cannot read the subject workspace: the exact saved bytes are delivered in its prompt
 expect(c.input.prompt).toContain("```\nselected answer\n```\n"); // exact bytes: no added blank line
 expect(c.input.prompt).not.toContain("selected answer\n\n");
 expect(c.input.prompt).toContain(entry.sha256);
 for (const k of ["workUnit","autoCustody","reviewDispatch"]) expect(k in c.input).toBe(false);
 // the parent stays unverified: dispatching a review is not a verdict
 expect(t.phase).toBe("completed_unverified");
 expect(t.result?.verified).toBe(false);
},20000);

test("restart / repeated calls keep exactly one child; crash after save is filled by the next result call",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const first=children(f)[0].id;
 expect(f.fleet.ensureReviewDispatch(f.id)).toBe(first);
 await f.fleet.result(f.id,undefined,["answer.txt"]);
 await run(f.daemon(),300);
 expect(children(f).map((t:any)=>t.id)).toEqual([first]);
 // crash window: custody saved, child never submitted
 const sql=new Database(f.db);
 try { sql.query("DELETE FROM tasks WHERE id=?").run(first); } finally { sql.close(); }
 expect(children(f)).toEqual([]);
 await f.fleet.result(f.id,undefined,["answer.txt"]); // cached custody, no node contact, fills the child
 expect(children(f).length).toBe(1);
},20000);

test("selected path absent from saved manifest fails closed: no child",async()=>{
 const f=await fixture({...policy,path:"missing.txt"},["answer.txt","missing.txt"]);
 await run(f.daemon(),700);
 expect(children(f)).toEqual([]);
 expect(f.store.task(f.id)!.resultManifest).toBeUndefined(); // missing selected file holds custody
 expect(f.fleet.ensureReviewDispatch(f.id)).toBeUndefined();
});
test("saved manifest without the selected file refuses dispatch",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const sql=new Database(f.db);
 try { for (const c of children(f)) sql.query("DELETE FROM tasks WHERE id=?").run(c.id); } finally { sql.close(); }
 f.mutate((t:any)=>{t.resultManifest.files=t.resultManifest.files.filter((x:any)=>x.path!=="answer.txt");});
 expect(()=>f.fleet.ensureReviewDispatch(f.id)).toThrow("not uniquely present");
 expect(children(f)).toEqual([]);
},20000);

test("submission validation: template, custody membership, no mixing with workUnit/subject",async()=>{
 const f=await fixture();
 const base={...f.request,key:"v"};
 expect(()=>f.store.submit({...base,reviewDispatch:{...policy,promptTemplate:"no placeholder"}} as any)).toThrow("{path}");
 expect(()=>f.store.submit({...base,reviewDispatch:{...policy,path:"other.txt"}} as any)).toThrow("autoCustody.paths");
 expect(()=>f.store.submit({...base,autoCustody:undefined,reviewDispatch:policy} as any)).toThrow();
 expect(()=>f.store.submit({...base,reviewDispatch:{...policy,extra:1}} as any)).toThrow();
 expect(()=>f.store.submit({...base,reviewDispatch:policy,subject:{taskId:f.id,path:"answer.txt",sha256:"a".repeat(64)}} as any)).toThrow("reviewDispatch cannot");
},20000);

test("dispatch failure after save keeps custody successful, is audited, and a later result() retries",async()=>{
 const f=await fixture(policy);
 const submit=spyOn(f.store,"submit").mockImplementation(()=>{throw Object.assign(new Error("dispatch off"),{code:"DISPATCH_DISABLED"});});
 try {
  const manifest=await f.fleet.automaticCustody(f.id);
  expect(manifest.files.map((x:any)=>x.path)).toEqual(["answer.txt"]);
 } finally { submit.mockRestore(); }
 expect(f.store.getOperation(f.id,"auto-custody")?.receipt).toBeDefined();
 expect(children(f)).toEqual([]);
 const sql=new Database(f.db);
 try { expect((sql.query("SELECT count(*) n FROM audit WHERE kind='review_dispatch_failed'").get() as any).n).toBe(1); } finally { sql.close(); }
 await f.fleet.result(f.id,undefined,["answer.txt"]);
 expect(children(f).length).toBe(1);
},20000);

test("subject bytes that do not match the saved hash, or are not deliverable text, are refused",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const sql=new Database(f.db);
 try { for (const c of children(f)) sql.query("DELETE FROM tasks WHERE id=?").run(c.id); } finally { sql.close(); }
 f.mutate((t:any)=>{t.resultManifest.files[0].contentBase64=Buffer.from("tampered\n").toString("base64");});
 expect(()=>f.fleet.ensureReviewDispatch(f.id)).toThrow("does not match");
 const bin=Buffer.from([0xff,0xfe,0x00]);
 f.mutate((t:any)=>{t.resultManifest.files[0].contentBase64=bin.toString("base64");t.resultManifest.files[0].sha256=sha256hex(bin);});
 expect(()=>f.fleet.ensureReviewDispatch(f.id)).toThrow("not UTF-8");
 f.mutate((t:any)=>{delete t.resultManifest.files[0].contentBase64;});
 expect(()=>f.fleet.ensureReviewDispatch(f.id)).toThrow("stored in the manifest");
 expect(children(f)).toEqual([]);
},20000);
const sha256hex=(b:Buffer)=>new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("prompt size: rendered template bounded at submission; a maximal subject still yields a valid child",async()=>{
 const f=await fixture();
 const base={...f.request,key:"size"};
 expect(()=>f.store.submit({...base,reviewDispatch:{...policy,promptTemplate:"{path}"+"x".repeat(32*1024)}} as any)).toThrow("at most");
 expect(()=>f.store.submit({...base,key:"amp",reviewDispatch:{...policy,promptTemplate:"{path}".repeat(4000)}} as any)).toThrow("at most");
 const g=await fixture({...policy,promptTemplate:"{path} "+"t".repeat(32*1024-20)});
 await run(g.daemon(),700);
 const sql=new Database(g.db);
 try { for (const c of children(g)) sql.query("DELETE FROM tasks WHERE id=?").run(c.id); } finally { sql.close(); }
 const big=Buffer.from("a".repeat(192*1024-1)+"\n");
 g.mutate((t:any)=>{t.resultManifest.files[0].contentBase64=big.toString("base64");t.resultManifest.files[0].sha256=sha256hex(big);t.resultManifest.files[0].bytes=big.length;});
 const id=g.fleet.ensureReviewDispatch(g.id)!;
 expect(Buffer.byteLength(g.store.task(id)!.input.prompt)).toBeLessThanOrEqual(256*1024);
 const ticks=Buffer.from("`".repeat(100*1024)+"\n");
 g.mutate((t:any)=>{t.resultManifest.files[0].contentBase64=ticks.toString("base64");t.resultManifest.files[0].sha256=sha256hex(ticks);});
 expect(()=>g.fleet.ensureReviewDispatch(g.id)).toThrow("exceeds the 256 KiB");
},30000);

test("inline subject framing is reversible: exact bytes reconstruct from the child prompt",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const cases=["","a","a\n","a\n\n","```","x```","```\n","a\r\n","\n","line1\nline2"];
 for (const text of cases) {
  const sql=new Database(f.db);
  try { for (const c of children(f)) sql.query("DELETE FROM tasks WHERE id=?").run(c.id); } finally { sql.close(); }
  const b=Buffer.from(text);
  f.mutate((t:any)=>{t.resultManifest.files[0].contentBase64=b.toString("base64");t.resultManifest.files[0].sha256=sha256hex(b);t.resultManifest.files[0].bytes=b.length;});
  const prompt=f.store.task(f.fleet.ensureReviewDispatch(f.id)!)!.input.prompt;
  const m=/exactly (\d+) bytes, (ending with a newline|no final newline)[^\n]*\):\n(`{3,})\n/.exec(prompt)!;
  expect(m).not.toBeNull();
  const start=m.index+m[0].length, fence=m[3];
  const end=prompt.lastIndexOf("\n"+fence+"\n")+1; // closing fence line starts here
  let body=prompt.slice(start,end);
  if (m[2]==="no final newline") body=body.slice(0,-1);
  expect(Buffer.from(body)).toEqual(b);
  expect(Number(m[1])).toBe(b.length);
 }
},30000);

test("a template containing fence lines cannot collide with the subject fence",async()=>{
 const f=await fixture({...policy,promptTemplate:"Review {path}.\n```\nfake\n```\n````\n"});
 await run(f.daemon(),700);
 const prompt=children(f)[0].input.prompt;
 const m=/\):\n(`{3,})\n/.exec(prompt)!;
 expect(m[1].length).toBeGreaterThan(4);
 const head=prompt.slice(0,m.index);
 expect(head.split("\n").some((l:string)=>l===m[1])).toBe(false);
 expect(prompt.split("\n").filter((l:string)=>l===m[1]).length).toBe(2);
},20000);

test("childCustody: the review child collects its own report and never dispatches again",async()=>{
 const f=await fixture({...policy,childCustody:["REVIEW.md"]});
 await run(f.daemon(),700);
 const c=children(f)[0];
 expect(c.input.autoCustody).toEqual({paths:["REVIEW.md"]});
 expect("reviewDispatch" in c.input).toBe(false);
 const base={...f.request,key:"cc"};
 expect(()=>f.store.submit({...base,reviewDispatch:{...policy,childCustody:["b.md","a.md"]}} as any)).toThrow("sorted");
 expect(()=>f.store.submit({...base,key:"cc2",reviewDispatch:{...policy,childCustody:[]}} as any)).toThrow();
 expect(()=>f.store.submit({...base,key:"cc3",reviewDispatch:{...policy,childCustody:["../x"]}} as any)).toThrow();
},20000);
test("no childCustody: child input unchanged (no autoCustody)",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 expect("autoCustody" in children(f)[0].input).toBe(false);
},20000);

test("child input is deterministic; without childCustody it is exactly the previous child input shape",async()=>{
 const f=await fixture(policy);
 await run(f.daemon(),700);
 const t=f.store.task(f.id)!;
 const c=children(f)[0];
 const entry=(t.resultManifest as any).files.find((x:any)=>x.path==="answer.txt");
 const subject={taskId:f.id,path:"answer.txt",sha256:entry.sha256,otherNode:true};
 // exact field set of the d52f845 child: no autoCustody, no extra keys
 expect(Object.keys(c.input).sort()).toEqual(["baseCommit","caller","key","prompt","repoId","required","schemaVersion","subject"]);
 expect(c.input.key).toBe(`review-${digest({parent:f.id,attempt:t.attemptId??null,policy,subject}).slice(0,48)}`);
 expect(c.inputDigest).toBe(digest(c.input));
 // repeat: same id and digest
 const again=f.fleet.ensureReviewDispatch(f.id)!;
 expect(again).toBe(c.id);
 expect(f.store.task(again)!.inputDigest).toBe(c.inputDigest);
 // with childCustody: different key (policy is in the key), same otherwise plus autoCustody
 const g=await fixture({...policy,childCustody:["REVIEW.md"]});
 await run(g.daemon(),700);
 const d=children(g)[0];
 expect(Object.keys(d.input).sort()).toEqual(["autoCustody","baseCommit","caller","key","prompt","repoId","required","schemaVersion","subject"]);
 expect(g.fleet.ensureReviewDispatch(g.id)).toBe(d.id);
},30000);

test("childCustody end to end: daemon collects the review child's REVIEW.md on another node and returns it; no grandchild",async()=>{
 const f=await fixture({...policy,childCustody:["REVIEW.md"]});
 await run(f.daemon(),700);
 const kid=children(f)[0];
 expect(kid.phase).toBe("queued");
 // a second node so the otherNode subject rule can place the child
 const config2=join(f.repo.dir,"node-other.json");
 const other={...f.n,id:"other",workspaceTransport:{command:process.execPath,args:[join(import.meta.dir,"../src/node.ts"),config2]}};
 await writeFile(config2,JSON.stringify(other));
 f.store.putNode(other);
 const t=f.store.reserve(kid.id)!;
 expect(t.nodeId).toBe("other");
 const identity=await prepareWorkspace({taskId:kid.id,attemptId:t.attemptId!,nodeId:"other",inputDigest:t.inputDigest,repo:f.repo.repo,baseCommit:f.repo.baseCommit,workspaceRoot:f.repo.workspaceRoot});
 f.store.setWorkspace(kid.id,identity as any);
 const create=f.store.claimOperation(kid.id,"create",{cwd:identity.path})!;
 const sessionId="review-session",turnId="review-turn";
 f.store.recordSession(kid.id,sessionId,true,{operationId:create.id,ephemeral:true,cwd:identity.path});
 f.store.recordSessionAuthority(kid.id,{sessionId,cwd:identity.path,endpointGeneration:1,endpointIncarnation:"c".repeat(64)});
 f.store.recordTurn(kid.id,turnId);
 await writeFile(f.coordinator,JSON.stringify({calls:[],readTurn:{ok:true,turn:{session_id:sessionId,turn_id:turnId,status:"completed",final_response:{source:"agent_end"},delivery:{runtime_command_id:"command2",runtime_turn_id:"runtime-turn2",prompt_acknowledged:true,queued:false}},advisory_status:{authority:"sdk",live:true,is_streaming:false},session_state:{session_id:sessionId,state:"completed",current_turn_id:turnId}}}));
 const inspector=new Fleet(f.store);
 try { await inspector.inspect(kid.id); } finally { await inspector.close(); }
 expect(f.store.task(kid.id)!.result?.executionTerminal).toBe(true);
 await writeFile(join(identity.path,"REVIEW.md"),"VERDICT: CLEAN\n");
 await writeFile(join(identity.path,"scratch.txt"),"not collected\n");
 await run(f.daemon(),1500);
 const done=f.store.task(kid.id)!;
 expect((done.resultManifest as any)?.files?.map((x:any)=>x.path)).toEqual(["REVIEW.md"]);
 expect(f.store.getOperation(kid.id,"auto-custody")?.receipt).toBeDefined();
 expect(f.store.getOperation(kid.id,"resource-return-confirmed")).toBeDefined();
 expect(f.store.tasks().filter((x:any)=>x.input.subject?.taskId===kid.id)).toEqual([]);
 expect(f.store.tasks().length).toBe(2);
},30000);
