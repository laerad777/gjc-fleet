import { expect, spyOn, test } from "bun:test";
import { FleetDaemon } from "../src/daemon";

function probe() {
 let reads = 0;
 let refusal: string | undefined = "original_session_authority_missing";
 const store = { getOperation: () => undefined, autoCustodyRefusal: () => { reads++; return refusal; }, recordDaemonNote: () => false };
 const d = new FleetDaemon({ store } as any) as any;
 const custody = { id: "fresh", nodeId: "node", attemptId: "a", autoCustody: true, phase: "completed_unverified", executionTerminal: true };
 return { d, custody, reads: () => reads, allow: () => { refusal = undefined; } };
}

test("100 sustained fresh custody slots eventually service an overdue observation", async () => {
 const p = probe(); p.allow();
 const active = { id: "active", nodeId: "node", attemptId: "active-attempt", sessionId: "session", turnId: "turn", phase: "active" };
 p.d.visits.set("active", { lastAt: 1, dueAt: 0, interval: 1, errors: new Set() });
 p.d.fleet.automaticCustody = async () => {};
 p.d.finishCall = () => {};
 let observations = 0;
 let now = 1000;
 const clock = spyOn(Date, "now").mockImplementation(() => now);
 try { for (let slot = 0; slot < 100; slot++, now++) {
  p.d.index = [active, { ...p.custody, id: `fresh-${slot}` }];
  const work = p.d.next("node", Date.now());
  if (work.kind === "observe") {
   observations++;
   p.d.visits.get("active").lastAt = Date.now();
  } else await p.d.collectCustody({ id: "node" }, work.row);
 } } finally { clock.mockRestore(); }
 expect(observations).toBe(50);
});

test("unchanged refused scans bound reads, expiry and projection changes recheck", () => {
 const p = probe();
 p.d.index = [p.custody];
 for (let i = 0; i < 100; i++) p.d.next("node", 1000);
 expect(p.reads()).toBe(1);
 p.allow();
 expect(p.d.next("node", 1000)).toBeUndefined();
 expect(p.d.next("node", 1000 + 60_000)?.kind).toBe("custody");
 p.d.index = [{ ...p.custody, turnId: "changed-receipt" }];
 expect(p.d.next("node", 1001)?.kind).toBe("custody");
 expect(p.reads()).toBe(3);
});

test("change feed invalidates unchanged projection for receipt and cross-task ownership changes", () => {
 for (const changedId of ["fresh", "another-task-owning-the-session"]) {
  const p = probe();
  let changed: string[] = [];
  Object.assign(p.d.store, {
   schedulingCursor: () => ({ audit: 1, rowid: 1 }),
   schedulingIndex: () => [p.custody],
   schedulingChanges: () => changed,
  });
  p.d.refreshIndex(1000);
  expect(p.d.next("node",1000)).toBeUndefined();
  p.allow();
  p.d.refreshIndex(1001);
  expect(p.d.next("node",1001)).toBeUndefined();
  changed = [changedId];
  p.d.refreshIndex(1002);
  expect(p.d.next("node",1002)?.kind).toBe("custody");
  expect(p.reads()).toBe(2);
 }
});
