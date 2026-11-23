import { types } from "node:util";
export type Wire = string | Uint8Array;
export const WIRE_LIMIT = 32 * 1024 * 1024;
/** Check the original bytes before decoding, copying, or parsing. */
export function wireText(wire: Wire): string {
 if (typeof wire !== "string" && (!types.isUint8Array(wire) || types.isProxy(wire))) throw new Error("invalid_wire_data");
 const size = typeof wire === "string" ? Buffer.byteLength(wire, "utf8") : Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), "byteLength")!.get!.call(wire);
 if (size > WIRE_LIMIT) throw new Error("delivery_limit");
 return typeof wire === "string" ? wire : new TextDecoder("utf-8", {fatal:true}).decode(wire);
}
/** Incremental JSON construction: duplicate keys, excessive depth and node count
 * are refused before constructing the corresponding container/member. */
export function parseWire(wire: Wire): any {
 const text = wireText(wire); let i = 0, nodes = 0;
 const fail = (): never => { throw new Error("invalid_wire_data"); };
 function ws() { while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++; }
 function string(): string {
  const start = i++;
  while (i < text.length) {
   const c = text[i++];
   if (c === '"') return JSON.parse(text.slice(start, i));
   if (c === "\\") i++;
  }
  return fail();
 }
 function value(depth: number): any {
  ws(); if (depth > 8 || ++nodes > 50_000) throw new Error("delivery_limit");
  const c = text[i];
  if (c === '"') return string();
  if (c === "{" || c === "[") {
   i++; ws(); const array = c === "[", end = array ? "]" : "}";
   const result: any = array ? [] : Object.create(null);
   if (text[i] === end) { i++; return result; }
   for (;;) {
    ws();
    if (array) result.push(value(depth + 1));
    else {
     if (text[i] !== '"') fail();
     const key = string(); ws();
     if (Object.hasOwn(result, key) || text[i++] !== ":") fail();
     result[key] = value(depth + 1);
    }
    ws(); if (text[i] === end) { i++; return result; }
    if (text[i++] !== ",") fail();
   }
  }
  const match = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
  if (!match) return fail();
  i += match[0].length; const result = JSON.parse(match[0]);
  if (typeof result === "number" && !Number.isFinite(result)) fail();
  return result;
 }
 const result = value(0); ws(); if (i !== text.length) fail(); return result;
}
export function serializeWire(value: unknown): string {
 const text = JSON.stringify(value); wireText(text); return text;
}
