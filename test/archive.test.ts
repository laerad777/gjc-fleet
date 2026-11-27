import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Phase, TaskRecord } from "../src/contracts";
import { FleetStore } from "../src/store";
import { Fleet } from "../src/fleet";
import { getDashboardState, startDashboardServer } from "../src/dashboard";
import { renderDashboardFixture } from "./dashboard-vm";
import { refuseHostGjc } from "./host-gjc-guard";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
export function fixture(phase: Phase = "blocked_unknown", held = true) {
 const dir = mkdtempSync(join(tmpdir(), "fleet-archive-")), path = join(dir,"fleet.sqlite");
 const store = new FleetStore(path,2), db = new Database(path);
 cleanup.push(() => { db.close(); store.close(); rmSync(dir,{recursive:true,force:true}); });
 const response = join(dir,"response.json"), script = join(dir,"sdk.ts");
 writeFileSync(script,`if(process.env.GJC_SDK_BROKER_AUTOSTART!=="0"||JSON.stringify(process.argv.slice(2))!==JSON.stringify(["sdk","session","list","--scope","all","--json"]))process.exit(9);console.log(await Bun.file(${JSON.stringify(response)}).text());`);
 const node:any = {id:"node",sdkTransport:{command:process.execPath,args:[script]}};
 const task:TaskRecord = {id:"task-original",input:{schemaVersion:1,key:"key",caller:"test",repoId:"repo",baseCommit:"a".repeat(40),prompt:"archive test",required:{}},inputDigest:"digest",nodeId:"node",nodeSnapshot:node,attemptId:"attempt-original",sessionId:"session-original",phase,held,reason:"original unknown",workspace:{path:"/owned/task-original-attempt-original"},result:{status:"failed",evidence:{original:true},executionTerminal:false,verified:false}};
 db.query("INSERT INTO nodes VALUES (?,?)").run(node.id,JSON.stringify(node));
 db.query("INSERT INTO tasks VALUES (?,?,?,?,?)").run(task.id,"test","key","digest",JSON.stringify(task));
 db.query("INSERT INTO operations VALUES (?,?,?,?,?)").run("op",task.id,task.attemptId!,"create",JSON.stringify({id:"op",kind:"create",payload:{original:true}}));
 db.query("INSERT INTO audit(task_id,kind,at,data) VALUES (?,?,?,?)").run(task.id,"submitted",new Date().toISOString(),JSON.stringify({original:true}));
 const list:any={ok:true,result:{version:2,source:"broker",scope:"all",selection:{scope:"all"},warnings:[],sessions:[]}};
 function save(){writeFileSync(response,JSON.stringify(list));}
 save();
 const fleet=new Fleet(store);
 return {store,db,task,list,save,fleet,dir,path,archive:()=>{save();return fleet.archive(task.id,{},"tester");}};
}
for(const phase of ["blocked_unknown","cancel_unknown","failed"] as const)test(`archives ${phase}, preserves history and idempotency`,async()=>{
 const f=fixture(phase), events=f.store.events(f.task.id),operations=f.db.query("SELECT * FROM operations").all();
 const before=getDashboardState(f.store);expect(before.summary.failedTasks).toBe(1);expect(before.summary.heldTasks).toBe(1);
 const archived=await f.archive();expect(archived.phase).toBe("archived");expect(archived.held).toBe(false);expect(archived.archivedFrom).toEqual({phase,reason:f.task.reason,result:f.task.result});expect(archived.result).toEqual(f.task.result);expect(archived.archiveActor).toBe("tester");expect(archived.archiveEvidenceDigest).toHaveLength(64);
 expect(f.store.events(f.task.id).slice(0,events.length)).toEqual(events);expect(f.db.query("SELECT * FROM operations").all()).toEqual(operations);expect(f.db.query("SELECT * FROM tasks").all()).toHaveLength(1);
 const after=f.store.events(f.task.id);expect(after.filter(e=>e.kind==="archived")).toHaveLength(1);expect(after.filter(e=>e.kind==="released")).toHaveLength(1);expect(await f.archive()).toEqual(archived);expect(f.store.events(f.task.id)).toEqual(after);
 await expect(f.fleet.archive(f.task.id,{notes:"different"},"tester")).rejects.toThrow("Archive identity");
 const state=getDashboardState(f.store);expect(state.tasks).toHaveLength(0);expect(state.archivedTasks).toHaveLength(1);expect(state.summary.failedTasks).toBe(0);expect(state.summary.heldTasks).toBe(0);expect(state.summary.totalTasks).toBe(1);expect(state.pipeline.stages.every(s=>s.reached===0)).toBe(true);
});
for(const phase of ["queued","preparing","dispatching","active","approval_required","completed_unverified","succeeded","cancelled"] as const)test(`rejects archive from ${phase}`,async()=>{const f=fixture(phase);await expect(f.archive()).rejects.toThrow("Only unknown or failed");expect(f.store.task(f.task.id)?.phase).toBe(phase);});
test("unheld archive does not release twice",async()=>{const f=fixture("failed",false);await f.archive();expect(f.store.events(f.task.id).filter(e=>e.kind==="released")).toHaveLength(0);});
for(const identity of ["session","cwd","attempt","stateRoot","topCwd"])test(`rejects live original matched by ${identity}`,async()=>{
 const f=fixture();const session:any={sessionId:identity==="session"?f.task.sessionId:"other",live:true,locator:{cwd:identity==="cwd"?(f.task.workspace as any).path:"/other",worktreeRoot:identity==="attempt"?`/owned/${f.task.attemptId}`:"/other"}};
 if(identity==="stateRoot")session.locator.stateRoot=`/owned/${f.task.id}/state`;if(identity==="topCwd")session.cwd=`/owned/${f.task.attemptId}`;f.list.result.sessions=[session];await expect(f.archive()).rejects.toThrow("still live");expect(f.store.task(f.task.id)?.held).toBe(true);
});
test("dead session with stale active activity is not live",async()=>{const f=fixture();f.list.result.sessions=[{sessionId:f.task.sessionId,live:false,locator:{cwd:"/other",worktreeRoot:"/other"},activity:{state:"active"}}];expect((await f.archive()).phase).toBe("archived");});
for(const mutation of ["warnings","scope","missingLive","pagination","partial","failed"])test(`rejects incomplete queried evidence ${mutation}`,async()=>{const f=fixture(),list=f.list.result;if(mutation==="warnings")list.warnings=["partial"];if(mutation==="scope")list.scope="cwd";if(mutation==="pagination")list.nextCursor="more";if(mutation==="partial")list.complete=false;if(mutation==="failed")f.list.ok=false;if(mutation==="missingLive")list.sessions=[{sessionId:f.task.sessionId,locator:{cwd:"/owned",worktreeRoot:"/owned"}}];await expect(f.archive()).rejects.toThrow();expect(f.store.task(f.task.id)?.held).toBe(true);});
test("dashboard API and page render archived history collapsed with original reason",async()=>{
 const f=fixture();await f.archive();cleanup.push(refuseHostGjc());const server=startDashboardServer(f.store,0,"127.0.0.1",{probeNodes:false});
 try{const response=await fetch(`http://127.0.0.1:${server.port}/api/state`);expect(response.status).toBe(200);const state:any=await response.json();expect(state.tasks).toEqual([]);expect(state.archivedTasks[0].archivedFrom.reason).toBe(f.task.reason);
 const elements = await renderDashboardFixture(state);
 const element = (id: string) => elements.get(id)!;
 expect(element("tasks").innerHTML).toContain('class="fold" data-fold="archived"');expect(element("tasks").innerHTML).not.toContain('class="fold open" data-fold="archived"');expect(element("tasks").innerHTML).toContain("Archived tasks");expect(element("tasks").innerHTML).not.toContain("original unknown");}finally{server.stop(true);}
});
test("CLI queries trusted transport; read-only refuses",async()=>{const f=fixture("failed");const argv=[process.execPath,join(import.meta.dir,"../src/cli.ts"),"--db",f.path];const ro=Bun.spawn([...argv,"--read-only","task","archive",f.task.id],{stdout:"pipe",stderr:"pipe"});expect(await ro.exited).toBe(1);expect(f.store.task(f.task.id)?.phase).toBe("failed");const child=Bun.spawn([...argv,"task","archive",f.task.id],{stdout:"pipe",stderr:"pipe"});const output=await new Response(child.stdout).text();expect(await child.exited).toBe(0);expect(JSON.parse(output).phase).toBe("archived");});
test("archive refusal keeps its code and records a bounded store diagnostic without changing the task",async()=>{const f=fixture("active");const before=f.store.task(f.task.id);await expect(f.archive()).rejects.toThrow("Only unknown or failed");expect(f.store.task(f.task.id)).toEqual(before);const refused=f.store.events(f.task.id).findLast(e=>e.kind==="refused")!;expect(refused.data).toMatchObject({action:"archive",code:"ARCHIVE_PHASE",certainty:"local_transaction_rolled_back"});expect((refused.data as any).failureDiagnostic).toEqual({version:1,use:"diagnostic_only_not_evidence",source:"Store.transaction",phase:"record",errorClass:"FleetError",code:"fleet:archive_phase",message:"Fleet check refused the step"});expect(JSON.stringify(refused.data)).not.toContain("Only unknown");});
