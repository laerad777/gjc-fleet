import { expect, test } from "bun:test";
import { serializeWire, WIRE_LIMIT } from "../src/transfer-wire";

test("wire serializer accepts an exact byte limit and rejects one extra UTF-8 byte", () => {
	const value = "é".repeat((WIRE_LIMIT - 2) / 2);
	expect(Buffer.byteLength(serializeWire(value), "utf8")).toBe(WIRE_LIMIT);
	expect(() => serializeWire(value + "x")).toThrow("delivery_limit");
});
