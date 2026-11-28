import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationDigest } from "../src/core";
import { FleetStore } from "../src/store";

function withStore(body: (store: FleetStore) => void) {
	const dir = mkdtempSync(join(tmpdir(), "store-custody-binding-"));
	try {
		const store = new FleetStore(join(dir, "fleet.sqlite"));
		try {
			body(store);
		} finally {
			store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function taskFixture(store: FleetStore, auto = false) {
	const root = tmpdir();
	store.putNode({
		id: "fixture", os: process.platform, arch: process.arch, roots: { repo: root }, workspaceRoot: root,
		enabled: true, draining: false, reachable: true, sdkReady: true, modelReady: true,
		models: ["model"], operations: ["write"], transport: { command: process.execPath, args: [] },
	});
	const selected = ["answer.txt"];
	const task = store.reserve(store.submit({
		schemaVersion: 1, key: "custody", caller: "fixture", repoId: "repo", baseCommit: "a".repeat(40),
		prompt: "Synthetic custody fixture", required: {}, ...(auto ? { autoCustody: { paths: selected } } : {}),
	}).id);
	const sessionId = "session-fixture";
	const turnId = "turn-fixture";
	store.recordSession(task.id, sessionId);
	store.recordTurn(task.id, turnId);
	const settle = () => {
		const body = {
			sessionId, turnId, status: "completed_unverified" as const, terminal: true, evidence: { native: "fixture" },
		};
		store.observe(task.id, { ...body, eventId: "settled-fixture", digest: observationDigest(body) });
	};
	return { id: task.id, attemptId: task.attemptId!, selected, settle };
}

test("direct custody binds only a settled attempt and is immutable before any result is saved", () => withStore((store) => {
	const { id, attemptId, selected, settle } = taskFixture(store);
	const request = { attemptId, paths: selected };
	expect(() => store.bindResultCustody(id, selected)).toThrow(expect.objectContaining({ code: "RESULT_NOT_READY" }));
	expect(store.task(id)?.resultCustodyRequest).toBeUndefined();
	settle();
	store.bindResultCustody(id, selected);
	store.bindResultCustody(id, [...selected]);
	expect(() => store.bindResultCustody(id, null)).toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(() => store.bindResultCustody(id, ["other.txt"])).toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(() => store.saveResult(id, { custody: { paths: ["other.txt"] } }))
		.toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(store.task(id)?.resultManifest).toBeUndefined();
	const manifest = { custody: { paths: selected }, fixture: "answer" };
	expect(store.saveResult(id, manifest).resultManifest).toEqual(manifest);
	expect(store.task(id)?.resultCustodyRequest).toEqual(request);
	const bindingEvents = store.events(id).filter((event) => event.kind === "result_custody_bound");
	expect(bindingEvents).toHaveLength(1);
	expect(bindingEvents[0]?.data).toMatchObject(request);
}));

test("direct custody cannot replace a cached full result or its selection", () => withStore((store) => {
	const { id, selected, settle } = taskFixture(store);
	const manifest = { fixture: "full result" };
	settle();
	store.saveResult(id, manifest);
	expect(() => store.bindResultCustody(id, selected)).toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(store.task(id)?.resultCustodyRequest).toBeUndefined();
	store.bindResultCustody(id, null);
	expect(store.task(id)?.resultCustodyRequest?.paths).toBeNull();
	expect(store.task(id)?.resultManifest).toEqual(manifest);
}));

test("direct custody cannot displace the automatic submission selector", () => withStore((store) => {
	const { id, attemptId, selected, settle } = taskFixture(store, true);
	settle();
	expect(() => store.bindResultCustody(id, null)).toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(() => store.bindResultCustody(id, ["other.txt"])).toThrow(expect.objectContaining({ code: "RESULT_CONFLICT" }));
	expect(store.task(id)?.resultCustodyRequest).toBeUndefined();
	store.bindResultCustody(id, selected);
	expect(store.task(id)?.resultCustodyRequest).toEqual({ attemptId, paths: selected });
	expect(store.task(id)?.input.autoCustody).toEqual({ paths: selected });
	expect(store.task(id)?.resultManifest).toBeUndefined();
	expect(store.getOperation(id, "auto-custody")).toBeUndefined();
}));
