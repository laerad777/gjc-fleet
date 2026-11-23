import { test, expect } from "bun:test";
import { posixOnly } from "./source-transfer-platform";
import { boundedLocal, receiveSource, deliverSource } from "../src/source-transfer";

posixOnly("reviewer wide-object reproduction bounds explicit key-array allocation", async () => {
 const wide: Record<string, number> = {};
 for (let i = 0; i < 100_000; i++) wide[`k${i}`] = 0;
 const ownKeys = Reflect.ownKeys;
 let allocatedKeys = 0;
 Reflect.ownKeys = (value: object) => {
  const keys = ownKeys(value);
  allocatedKeys = Math.max(allocatedKeys, keys.length);
  return keys;
 };
 try {
  await expect(boundedLocal("/must-not-spawn", [], wide as any)).rejects.toThrow("invalid_wire_data");
  await expect(receiveSource({} as any, wide as any)).rejects.toThrow("invalid_wire_data");
  await expect(deliverSource({command:"ssh",args:[]}, wide as any)).rejects.toThrow("invalid_wire_data");
  expect(allocatedKeys).toBe(0);
 } finally {
  Reflect.ownKeys = ownKeys;
 }
});

// A for-in-only repair must not silently accept keys JSON would omit.
posixOnly("hidden and symbol properties remain refused without invoking accessors", async () => {
 let invoked = 0;
 const hidden = Object.defineProperty({}, "hidden", { value: 1 });
 const symbol = { [Symbol("hidden")]: 1 };
 const getter = Object.defineProperty({}, "hidden", { get() { invoked++; return 1; } });
 for (const value of [hidden, symbol, getter]) {
  await expect(boundedLocal("/must-not-spawn", [], value as any)).rejects.toThrow("invalid_wire_data");
 }
 expect(invoked).toBe(0);
});
