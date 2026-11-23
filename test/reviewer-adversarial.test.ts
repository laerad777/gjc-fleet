import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetStore } from "../src/store";
import { observationDigest } from "../src/core";
import { sha256 } from "../src/workspace";
import { returnResources } from "../src/resource-return";
import { TransportError } from "../src/rpc";
import type { NodeConfig, SessionAuthority } from "../src/contracts";

const dirs: string[] = [];
const stores: FleetStore[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(count = 1, custody = true) {
	const dir = mkdtempSync(join(tmpdir(), "fleet-return-")); dirs.push(dir);
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path, 100, { deferTerminalRelease: true }); stores.push(store);
	const node: NodeConfig = { id: "node", os: process.platform, arch: process.arch, roots: { repo: dir }, workspaceRoot: join(dir, "work"), enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true, models: ["model"], operations: ["write"], transport: { command: process.execPath, args: [] }, sdkTransport: { command: process.execPath, args: [] } };
	store.putNode(node);
	const ids: string[] = [];
	for (let i = 0; i < count; i++) {
		const task = store.reserve(store.submit({ schemaVersion: 1, key: `task-${i}`, caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40), prompt: "fixture", required: {} }).id);
		const identity = { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId!, nodeId: node.id, inputDigest: task.inputDigest, path: join(node.workspaceRoot, task.id + "-" + task.attemptId), repo: dir, baseCommit: "a".repeat(40) };
		store.setWorkspace(task.id, identity);
		const create = store.claimOperation(task.id, "create", { cwd: identity.path })!;
		const sessionId = `session-${i}`;
		store.recordSession(task.id, sessionId, true, { operationId: create.id, ephemeral: true, cwd: identity.path });
		store.recordSessionAuthority(task.id, { sessionId, cwd: identity.path, endpointGeneration: 1, endpointIncarnation: "b".repeat(64) });
		store.recordTurn(task.id, "turn");
		const body = { sessionId, turnId: "turn", status: "completed_unverified" as const, terminal: true, evidence: { native: "settled" } };
		store.observe(task.id, { eventId: `terminal-${i}`, digest: observationDigest(body), ...body });
		if (custody) store.saveResult(task.id, { schemaVersion: 1, identity, patch: "", patchDigest: sha256(""), outputHead: "a".repeat(40), producer: { platform: process.platform, arch: process.arch, bun: Bun.version }, files: [], tests: [], status: "not_run" });
		expect(store.task(task.id)!.held).toBe(true);
		ids.push(task.id);
	}
	return { store, path, dir, ids, node };
}
function transport(store: FleetStore, options: { error?: boolean; staysLive?: boolean; failList?: boolean } = {}) {
	const live = new Set(store.tasks().map(task => task.sessionId!));
	const stops: string[] = [];
	let connects = 0, active = 0, maxActive = 0, listings = 0;
	const port = {
		async list(sessionId: string) {
			listings++;
			if (options.failList) throw new Error("unavailable");
			const task = store.tasks().find(task => task.sessionId === sessionId)!;
			return { type: "broker_response", ok: true, result: { indexSeq: listings, sessions: live.has(sessionId) ? [{ sessionId, locator: { cwd: (task.workspace as any).path }, endpointGeneration: 1, endpointIncarnation: "b".repeat(64), live: true, terminal: false, ambiguous: false, terminalUncertain: false }] : [] } };
		},
		async stop(sessionId: string) {
			active++; maxActive = Math.max(active, maxActive); stops.push(sessionId);
			await Bun.sleep(2);
			if (!options.staysLive) live.delete(sessionId);
			active--;
			if (options.error) throw new Error("transport_exited");
			return { stopped: true };
		},
		// ReturnConnection requires fencedClose. Every test here expects no close to be reached: record any call in `stops` (so the no-close assertions are real) and fail.
		async fencedClose(authority: SessionAuthority, _key: string): Promise<unknown> {
			stops.push(authority.sessionId);
			throw new Error("unexpected fencedClose");
		},
		close() {},
	};
	return { connect: async () => { connects++; return port; }, stops, live, stats: () => ({ connects, maxActive, listings }) };
}
function releaseCount(path: string) {
	const db = new Database(path, { readonly: true });
	try { return (db.query("SELECT count(*) AS n FROM audit WHERE kind='released' AND json_extract(data,'$.reason')='resource_return_confirmed'").get() as any).n; }
	finally { db.close(); }
}


test('review: spoofed task session id and another task sharing cwd prefix are never stopped', async () => {
 const f=fixture(2); const t=transport(f.store); const db=new Database(f.path);
 db.query("UPDATE tasks SET data=json_set(data,'$.sessionId',?) WHERE id=?").run('session-1',f.ids[0]!); db.close();
 expect((await returnResources(f.store,[f.ids[0]!],{connect:t.connect,paceMs:0}))[0]!.state).toBe('refused');
 expect(t.stops).toHaveLength(0);
 const g=fixture(); const u=transport(g.store); const port=await u.connect();
 const task=g.store.task(g.ids[0]!)!;
 const connect=async()=>({...port,list:async()=>({type:'broker_response',ok:true,result:{indexSeq:1,sessions:[{sessionId:task.sessionId,locator:{cwd:(task.workspace as any).path+'-foreign-task'},endpointGeneration:1,endpointIncarnation:'b'.repeat(64),live:true,terminal:false,ambiguous:false,terminalUncertain:false}]}})});
 expect((await returnResources(g.store,g.ids,{connect,paceMs:0}))[0]!.state).toBe('return_unknown'); expect(u.stops).toHaveLength(0);
});
test('review: reuse between listing and close is refused by the incarnation fence and never returned',async()=>{
 const f=fixture(); let incarnation='b'.repeat(64); const stopped:string[]=[]; const fenced:string[]=[];
 const task=f.store.task(f.ids[0]!)!; let reads=0;
 const connect=async()=>({list:async()=>{if(++reads===1){const row={type:'broker_response',ok:true,result:{indexSeq:1,sessions:[{sessionId:task.sessionId,locator:{cwd:(task.workspace as any).path},endpointGeneration:1,endpointIncarnation:incarnation,live:true,terminal:false,ambiguous:false,terminalUncertain:false}]}};incarnation='c'.repeat(64);return row;}return {type:'broker_response',ok:true,result:{indexSeq:1+reads,sessions:[{sessionId:task.sessionId,locator:{cwd:(task.workspace as any).path},endpointGeneration:1,endpointIncarnation:incarnation,live:true,terminal:false,ambiguous:false,terminalUncertain:false}]}};},stop:async()=>{stopped.push(incarnation);},
  fencedClose:async(a:any)=>{fenced.push(a.endpointIncarnation);if(a.endpointIncarnation!==incarnation)throw new TransportError('EXECUTION_QUERY_FAILED','unknown','refused',{schema:'gjc.command-error',ok:false,error:{code:'endpoint_stale'}});return {ok:true,operation:'session.close',result:{sessionId:a.sessionId}};},close(){}});
 expect((await returnResources(f.store,f.ids,{connect,paceMs:0}))[0]).toEqual({taskId:f.ids[0]!,state:'not_ours',reason:'endpoint_stale_incarnation_not_owned'});
 expect(stopped).toEqual([]); expect(fenced).toEqual(['b'.repeat(64)]); expect(releaseCount(f.path)).toBe(0); expect(f.store.task(f.ids[0]!)!.held).toBe(true);
});
test('review: real concurrent processes share node claim and cannot double stop',async()=>{
 const f=fixture(); const log=join(f.dir,'effects.log'); const worker=join(f.dir,'worker.ts');
 writeFileSync(worker,`import {FleetStore} from ${JSON.stringify(join(import.meta.dir,'../src/store.ts'))};import {returnResources} from ${JSON.stringify(join(import.meta.dir,'../src/resource-return.ts'))};import {appendFileSync} from 'node:fs';const s=new FleetStore(${JSON.stringify(f.path)},100);const task=s.task(${JSON.stringify(f.ids[0])});let reads=0;const connect=async()=>({list:async()=>{await Bun.sleep(80);return {type:'broker_response',ok:true,result:{indexSeq:++reads,sessions:reads===1?[{sessionId:task.sessionId,locator:{cwd:task.workspace.path},endpointGeneration:1,endpointIncarnation:'b'.repeat(64),live:true,terminal:false,ambiguous:false,terminalUncertain:false}]:[]}}},stop:async()=>{appendFileSync(${JSON.stringify(log)},'stop\\n');await Bun.sleep(200)},fencedClose:async(a,k)=>{appendFileSync(${JSON.stringify(log)},'close\\n');await Bun.sleep(200);return {ok:true,operation:'session.close',result:{sessionId:a.sessionId}}},close(){}});console.log(JSON.stringify(await returnResources(s,[task.id],{connect,paceMs:0})));s.close();`);
 const children=[Bun.spawn([process.execPath,worker],{stdout:'pipe',stderr:'pipe'}),Bun.spawn([process.execPath,worker],{stdout:'pipe',stderr:'pipe'})];
 const results=await Promise.all(children.map(async c=>({exit:await c.exited,out:await new Response(c.stdout).text(),err:await new Response(c.stderr).text()})));
 expect(results.map(r=>r.exit)).toEqual([0,0]); const states=results.flatMap(r=>JSON.parse(r.out)).map((r:any)=>r.state); expect(states).toContain('returned'); expect(states.every((x:string)=>['node_busy','returned'].includes(x))).toBe(true); expect((await Bun.file(log).text()).trim()).toBe('close'); expect(releaseCount(f.path)).toBe(1);
});
test('review: actual process death after stop permits expired lease takeover and reconciles the stop claim without replay',async()=>{
 const f=fixture(); const worker=join(f.dir,'crash.ts'); const log=join(f.dir,'crash-effects');
 // Crash represents the previously shipped ID-only stop, not permission to replay it.
 writeFileSync(worker,`import {FleetStore} from ${JSON.stringify(join(import.meta.dir,'../src/store.ts'))};import {writeFileSync} from 'node:fs';const s=new FleetStore(${JSON.stringify(f.path)},100);s.claimResourceReturnNode('node','dead-process');s.claimOperation(${JSON.stringify(f.ids[0])},'stop',{session_id:'session-0',allow_mutation:true,reason:'Fleet task execution settled'});writeFileSync(${JSON.stringify(log)},'stopped original fixture incarnation');process.exit(77);`);
 const c=Bun.spawn([process.execPath,worker],{stdout:'pipe',stderr:'pipe'});expect(await c.exited).toBe(77);
 expect(await Bun.file(log).text()).toBe('stopped original fixture incarnation');
 const db=new Database(f.path);db.query('UPDATE resource_return_leases SET expires=0').run();db.close();
 const t=transport(f.store);t.live.clear();expect((await returnResources(f.store,f.ids,{connect:t.connect,paceMs:0}))[0]!.state).toBe('returned');expect(t.stats().listings).toBe(2);expect(t.stops).toHaveLength(0);expect(releaseCount(f.path)).toBe(1);
 expect(f.store.resourceReturnNode('node')).toBeNull();
});
