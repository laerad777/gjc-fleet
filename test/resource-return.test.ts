import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { observationDigest } from "../src/core";
import { sha256 } from "../src/workspace";
import { returnResources } from "../src/resource-return";
const dirs: string[] = [], stores: FleetStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true}); });
function fixture(deferTerminalRelease = true, custody = true) {
 const dir=mkdtempSync(join(tmpdir(),'return-fixed-'));dirs.push(dir);
 const path=join(dir,'db.sqlite'); const s=new FleetStore(path,100,{deferTerminalRelease}); stores.push(s);
 s.putNode({id:'node',os:process.platform,arch:process.arch,roots:{repo:dir},workspaceRoot:join(dir,'work'),enabled:true,draining:false,reachable:true,sdkReady:true,modelReady:true,models:['model'],operations:['write'],transport:{command:process.execPath,args:[]},sdkTransport:{command:process.execPath,args:[]}});
 const t=s.reserve(s.submit({schemaVersion:1,key:'task',caller:'test',repoId:'repo',baseCommit:'a'.repeat(40),prompt:'test',required:{}}).id);
 const identity={schemaVersion:1,taskId:t.id,attemptId:t.attemptId!,nodeId:'node',inputDigest:t.inputDigest,path:join(dir,'work',t.id+'-'+t.attemptId),repo:dir,baseCommit:'a'.repeat(40)};
 s.setWorkspace(t.id,identity);const create=s.claimOperation(t.id,'create',{cwd:identity.path})!;
 s.recordSession(t.id,'session',true,{operationId:create.id,ephemeral:true,cwd:identity.path});
 s.recordSessionAuthority(t.id,{sessionId:'session',cwd:identity.path,endpointGeneration:1,endpointIncarnation:'b'.repeat(64)});s.recordTurn(t.id,'turn');
 const body={sessionId:'session',turnId:'turn',status:'completed_unverified' as const,terminal:true,evidence:{native:'settled'}};
 s.observe(t.id,{eventId:'terminal',digest:observationDigest(body),...body});
 const heldBeforeCustody=s.task(t.id)!.held;
 if(custody)s.saveResult(t.id,{schemaVersion:1,identity,patch:'',patchDigest:sha256(''),outputHead:'a'.repeat(40),producer:{platform:process.platform,arch:process.arch,bun:Bun.version},files:[],tests:[],status:'not_run'});
 let reads=0,stops=0,closes=0;let live=false;const fenced:any[]=[];
 const connect=async()=>({list:async()=>({type:'broker_response',ok:true,result:{indexSeq:++reads,sessions:live?[{sessionId:'session',locator:{cwd:identity.path},endpointGeneration:1,endpointIncarnation:'b'.repeat(64),live:true,terminal:false,ambiguous:false,terminalUncertain:false}]:[]}}),stop:async()=>{stops++},fencedClose:async(a:any,key:string)=>{closes++;fenced.push({...a,key});live=false;return {ok:true,operation:'session.close',result:{sessionId:a.sessionId}}},close(){}});
 return {s,path,id:t.id,heldBeforeCustody,connect,fenced,stats:()=>({reads,stops,closes}),setLive:(v:boolean)=>{live=v}};
}
test.each([false,true])('terminal release mode defer=%s',async mode=>{
 const f=fixture(mode);expect(f.heldBeforeCustody).toBe(mode);expect(f.s.task(f.id)!.held).toBe(mode);
 expect((await returnResources(f.s,[f.id],{connect:f.connect,paceMs:0}))[0]!.state).toBe('returned');expect(f.s.task(f.id)!.held).toBe(false);
 await returnResources(f.s,[f.id],{connect:f.connect,paceMs:0});expect(f.stats()).toEqual({reads:2,stops:0,closes:0});
 const db=new Database(f.path,{readonly:true});expect((db.query("SELECT count(*) n FROM audit WHERE kind='released'").get() as any).n).toBe(1);db.close();
});
test('custody missing cannot connect or release',async()=>{const f=fixture(true,false);expect((await returnResources(f.s,[f.id],{connect:f.connect}))[0]!.state).toBe('refused');expect(f.stats().reads).toBe(0);expect(f.s.task(f.id)!.held).toBe(true)});
test('live session is never ID-only stopped; it is closed once through the exact-incarnation idle fence',async()=>{const f=fixture();f.setLive(true);expect((await returnResources(f.s,[f.id],{connect:f.connect,paceMs:0}))[0]!.state).toBe('returned');expect(f.stats()).toEqual({reads:2,stops:0,closes:1});expect(f.fenced[0]).toMatchObject({sessionId:'session',endpointGeneration:1,endpointIncarnation:'b'.repeat(64)});expect(f.s.task(f.id)!.held).toBe(false)});
test('inherited stop claim reconciles on fresh exact absence without replay',async()=>{const f=fixture();const stop=f.s.claimOperation(f.id,'stop',{session_id:'session',allow_mutation:true,reason:'Fleet task execution settled'})!;expect((await returnResources(f.s,[f.id],{connect:f.connect,paceMs:0}))[0]!.state).toBe('returned');expect(f.stats()).toEqual({reads:2,stops:0,closes:0});expect((f.s.getOperation(f.id,'resource-return-confirmed')!.payload as any).stopOperationId).toBe(stop.id);expect(f.s.task(f.id)!.held).toBe(false)});
test('active lease blocks reads; an expired lease is taken over by token CAS without any reconciliation gate',async()=>{const f=fixture();expect(f.s.claimResourceReturnNode('node','owner')).toBe(true);expect((await returnResources(f.s,[f.id],{connect:f.connect}))[0]!.state).toBe('node_busy');expect(f.stats().reads).toBe(0);const expire=()=>{const db=new Database(f.path);db.query('UPDATE resource_return_leases SET expires=0').run();db.close()};expire();expect(f.s.claimResourceReturnNode('node','successor')).toBe(true);expect(f.s.claimResourceReturnNode('node','third')).toBe(false);expect(f.s.renewResourceReturnNode('node','owner')).toBe(false);expire();expect((await returnResources(f.s,[f.id],{connect:f.connect,paceMs:0}))[0]!.state).toBe('returned');expect(f.s.resourceReturnNode('node')).toBeNull()});
test('failed listing after expired-lease takeover stays unknown and never replays',async()=>{const f=fixture();f.s.claimOperation(f.id,'stop',{session_id:'session',allow_mutation:true,reason:'Fleet task execution settled'});f.s.claimResourceReturnNode('node','owner');const db=new Database(f.path);db.query('UPDATE resource_return_leases SET expires=0').run();db.close();const port=await f.connect();expect((await returnResources(f.s,[f.id],{connect:async()=>({...port,list:async()=>{throw Error('offline')}}),paceMs:0}))[0]).toEqual({taskId:f.id,state:'return_unknown',reason:'fresh_authoritative_observation_unavailable_no_replay'});expect(f.s.resourceReturnNode('node')).toBeNull();expect(f.stats()).toEqual({reads:0,stops:0,closes:0});expect(f.s.task(f.id)!.held).toBe(true)});
test('invalid bounds and duplicate tasks refuse',async()=>{const f=fixture();await expect(returnResources(f.s,[f.id,f.id])).rejects.toThrow();await expect(returnResources(f.s,[f.id],{paceMs:5001})).rejects.toThrow()});
test('verification claim can run while safe-mode reservation remains held',()=>{const f=fixture();expect(f.s.claimResultTest(f.id,['bun','test'])).toBeDefined();expect(f.s.task(f.id)!.held).toBe(true)});
test.each(['paginated','regressing','foreign','offline'])('invalid authority observation %s retains reservation',async kind=>{
 const f=fixture();let seq=3;const base=await f.connect();
 const connect=async()=>({...base,list:async()=>{
  if(kind==='offline')throw Error('offline');
  return {type:'broker_response',ok:true,result:{indexSeq:kind==='regressing'?seq--:1,sessions:kind==='foreign'?[{sessionId:'foreign',live:true}]:[],...(kind==='paginated'?{continuationCursor:'more'}:{})}};
 }});
 expect((await returnResources(f.s,[f.id],{connect,paceMs:0}))[0]!.state).toBe('return_unknown');expect(f.s.task(f.id)!.held).toBe(true);expect(f.stats().stops).toBe(0);
});
test('corrupted custody refuses before transport',async()=>{const f=fixture();const db=new Database(f.path);db.query("UPDATE tasks SET data=json_set(data,'$.resultManifest.patch','corrupt') WHERE id=?").run(f.id);db.close();expect((await returnResources(f.s,[f.id],{connect:f.connect}))[0]!.state).toBe('refused');expect(f.stats().reads).toBe(0);expect(f.s.task(f.id)!.held).toBe(true)});
