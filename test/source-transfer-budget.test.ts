import { test, expect } from "bun:test";
import { posixOnly } from "./source-transfer-platform";
import { boundedLocal, receiveSource, deliverSource } from "../src/source-transfer";
import { parseWire, wireText, WIRE_LIMIT } from "../src/transfer-wire";
const counter = ["-e", "let n=0;for await(const c of Bun.stdin.stream())n+=c.length;console.log(JSON.stringify({ok:true,value:n}));"];
posixOnly("sparse-array reviewer reproduction is impossible on untrusted byte-only path", async () => {
 const graph = {padding:new Array(7000000)};
 await expect(boundedLocal("/must-not-spawn", [], graph as any)).rejects.toThrow("invalid_wire_data");
 await expect(receiveSource({} as any, graph as any)).rejects.toThrow("invalid_wire_data");
 await expect(deliverSource({command:"ssh",args:[]}, graph as any)).rejects.toThrow("invalid_wire_data");
});
posixOnly("non-wire objects refuse without invoking user code", async () => {
 let invoked = 0;
 const getter = Object.defineProperty({}, "x", {get(){invoked++; return 1;}});
 const proxy = new Proxy({}, {ownKeys(){invoked++; return [];}});
 for (const v of [getter, proxy, [], {}, null, 1, true, new Date(), {toJSON(){invoked++;}}]) {
  await expect(boundedLocal("/must-not-spawn", [], v as any)).rejects.toThrow("invalid_wire_data");
 }
 expect(invoked).toBe(0);
});
posixOnly("exact serialized wire accounting, UTF-8 and inclusive boundary", async () => {
 for (const value of [null,true,false,-0,1e100,[],{}, {a:"\b\t\n\f\r\u0000\"\\éж😀\ud800\udfff"}]) {
  const wire = JSON.stringify(value);
  expect(await boundedLocal(process.execPath,counter,wire)).toBe(Buffer.byteLength(wire));
  expect(await boundedLocal(process.execPath,counter,new TextEncoder().encode(wire))).toBe(Buffer.byteLength(wire));
 }
 const exact = '"' + "x".repeat(WIRE_LIMIT - 2) + '"';
 expect(await boundedLocal(process.execPath,counter,exact)).toBe(WIRE_LIMIT);
 for (const wire of [exact + " ", new Uint8Array(WIRE_LIMIT + 1)]) expect(() => wireText(wire)).toThrow("delivery_limit");
 expect(() => wireText('"' + "é".repeat(WIRE_LIMIT / 2) + '"')).toThrow("delivery_limit");
});
test("bounded parser rejects duplicate escaped keys, invalid UTF-8, trailing data and depth", () => {
 for (const wire of ['{"a":1,"\\u0061":2}', '{"a":1,}', '[1,]', 'null true', '"unterminated', '[0'.repeat(20), '['.repeat(10)+'0'+']'.repeat(10), new Uint8Array([0xff])]) expect(() => parseWire(wire)).toThrow();
 expect(() => parseWire('[' + '0,'.repeat(50000) + '0]')).toThrow("delivery_limit");
});
