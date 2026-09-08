import { describe, expect, it } from "vitest";
import { toJsonSafe } from "../../keeperhub-executor/lib/serialize";

describe("toJsonSafe", () => {
  it("passes through JSON-native primitives", () => {
    expect(toJsonSafe("hello")).toBe("hello");
    expect(toJsonSafe(42)).toBe(42);
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe(false)).toBe(false);
  });

  it("converts null and undefined to null", () => {
    expect(toJsonSafe(null)).toBe(null);
    expect(toJsonSafe(undefined)).toBe(null);
  });

  it("converts BigInt to string", () => {
    expect(toJsonSafe(BigInt("1000000000000000000"))).toBe(
      "1000000000000000000"
    );
    expect(toJsonSafe(BigInt(0))).toBe("0");
  });

  it("converts Date to ISO string", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    expect(toJsonSafe(date)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("converts Uint8Array to hex string", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(toJsonSafe(bytes)).toBe("0xdeadbeef");
  });

  it("converts Buffer to hex string", () => {
    const buf = Buffer.from([0xca, 0xfe]);
    expect(toJsonSafe(buf)).toBe("0xcafe");
  });

  it("converts Map to plain object", () => {
    const map = new Map<string, unknown>([
      ["key1", "value1"],
      ["key2", BigInt(42)],
    ]);
    expect(toJsonSafe(map)).toEqual({ key1: "value1", key2: "42" });
  });

  it("converts Set to array", () => {
    const set = new Set([1, BigInt(2), "three"]);
    expect(toJsonSafe(set)).toEqual([1, "2", "three"]);
  });

  it("omits functions", () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: testing empty function serialization
    expect(toJsonSafe(() => {})).toBe(undefined);
  });

  it("omits function values in objects", () => {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: testing empty function in object
    const obj = { a: 1, fn: () => {}, b: "two" };
    expect(toJsonSafe(obj)).toEqual({ a: 1, b: "two" });
  });

  it("handles nested objects with mixed types", () => {
    const input = {
      blockNumber: BigInt(12_345_678),
      args: {
        from: "0xabc",
        value: BigInt("1000000000000000000"),
      },
      timestamp: new Date("2026-01-01T00:00:00Z"),
      raw: new Uint8Array([0xff]),
    };

    expect(toJsonSafe(input)).toEqual({
      blockNumber: "12345678",
      args: {
        from: "0xabc",
        value: "1000000000000000000",
      },
      timestamp: "2026-01-01T00:00:00.000Z",
      raw: "0xff",
    });
  });

  it("handles arrays with mixed types", () => {
    const input = [BigInt(1), "two", 3, null, undefined];
    expect(toJsonSafe(input)).toEqual(["1", "two", 3, null, null]);
  });

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(toJsonSafe(obj)).toEqual({ a: 1, self: "[Circular]" });
  });

  it("converts unknown types to string", () => {
    expect(toJsonSafe(Symbol("test"))).toBe("Symbol(test)");
  });
});
