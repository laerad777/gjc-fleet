import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetError } from "../src/core";
import { FleetStore } from "../src/store";
import { activeOn, node } from "./fixtures/daemon";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0).reverse()) c();
});

function storeWithActive(): { store: FleetStore; id: string } {
	const dir = mkdtempSync(join(tmpdir(), "fleet-daemon-note-"));
	const path = join(dir, "fleet.sqlite");
	const store = new FleetStore(path);
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => store.close());
	store.putNode(node("node", dir));
	const id = activeOn(store, "node", "note-case");
	return { store, id };
}

test("recordDaemonNote accepts Fleet error codes with uppercase letters", () => {
	const { store, id } = storeWithActive();
	const note = "custody_failed_RESULT_BINDING_operator_recovery_required";
	expect(store.recordDaemonNote(id, note)).toBe(true);
	expect(store.events(id).filter((e) => e.kind === "daemon_note").map((e) => (e.data as any).note)).toEqual([note]);
	expect(store.recordDaemonNote(id, note)).toBe(false);
	expect(store.events(id).filter((e) => e.kind === "daemon_note")).toHaveLength(1);
});

test("recordDaemonNote still rejects unbounded or unsafe note shapes", () => {
	const { store, id } = storeWithActive();
	expect(() => store.recordDaemonNote(id, "has space")).toThrow(FleetError);
	expect(() => store.recordDaemonNote(id, "slash/forbidden")).toThrow(FleetError);
	try {
		store.recordDaemonNote(id, "has space");
	} catch (error) {
		expect(error).toMatchObject({ code: "INVALID_INPUT" });
	}
});

test("an uppercase recovery note does not clear an unreceipted effect claim (no-replay fence stays)", () => {
	const { store, id } = storeWithActive();
	const claim = store.claimOperation(id, "create", { cwd: "/tmp/note-case" })!;
	expect(claim.receipt).toBeUndefined();
	expect(store.recordDaemonNote(id, "custody_failed_RESULT_BINDING_operator_recovery_required")).toBe(true);
	const after = store.getOperation(id, "create")!;
	expect(after.id).toBe(claim.id);
	expect(after.receipt).toBeUndefined();
	expect(store.events(id).filter((e) => e.kind === "daemon_note")).toHaveLength(1);
});
