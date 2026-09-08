import { describe, expect, it } from "vitest";

import { toJsonSafe } from "@/lib/utils/json-safe";

describe("toJsonSafe", () => {
  it("converts BigInt to string", () => {
    expect(toJsonSafe(BigInt(123))).toBe("123");
    expect(
      toJsonSafe({ gas: BigInt(21_000), value: BigInt(10) ** BigInt(18) })
    ).toEqual({
      gas: "21000",
      value: "1000000000000000000",
    });
  });

  it("survives JSON.stringify after conversion (the JSONB write path)", () => {
    const stepOutput = {
      blockNumber: BigInt(19_000_000),
      balances: [BigInt(1), BigInt(2), BigInt(3)],
      nested: { fee: BigInt(500) },
    };
    // Drizzle's PgJsonb.mapToDriverValue calls JSON.stringify, which throws on
    // a raw BigInt. After toJsonSafe it must not throw.
    expect(() => JSON.stringify(toJsonSafe(stepOutput))).not.toThrow();
    expect(JSON.parse(JSON.stringify(toJsonSafe(stepOutput)))).toEqual({
      blockNumber: "19000000",
      balances: ["1", "2", "3"],
      nested: { fee: "500" },
    });
  });

  it("preserves plain JSON-safe primitives and structures", () => {
    expect(toJsonSafe("hello")).toBe("hello");
    expect(toJsonSafe(42)).toBe(42);
    expect(toJsonSafe(true)).toBe(true);
    expect(toJsonSafe([1, "a", false])).toEqual([1, "a", false]);
  });

  it("normalizes Date to ISO string", () => {
    const date = new Date("2026-06-05T12:00:00.000Z");
    expect(toJsonSafe(date)).toBe("2026-06-05T12:00:00.000Z");
  });

  it("converts Uint8Array/Buffer to 0x-prefixed hex", () => {
    expect(toJsonSafe(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
    expect(toJsonSafe(Buffer.from([0xbe, 0xef]))).toBe("0xbeef");
  });

  it("converts Map to object and Set to array", () => {
    expect(toJsonSafe(new Map([["k", BigInt(1)]]))).toEqual({ k: "1" });
    expect(toJsonSafe(new Set([BigInt(1), BigInt(2)]))).toEqual(["1", "2"]);
  });

  it("returns null for null and undefined", () => {
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeNull();
  });

  it("drops functions and normalizes undefined properties to null", () => {
    const value = {
      keep: 1,
      fn: () => "nope",
      gone: undefined,
    };
    expect(toJsonSafe(value)).toEqual({ keep: 1, gone: null });
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(toJsonSafe(a)).toEqual({ name: "a", self: "[Circular]" });
  });

  it("serializes shared (non-circular) references in full", () => {
    const shared = { token: "USDC", decimals: 6 };
    expect(toJsonSafe({ a: shared, b: shared })).toEqual({
      a: { token: "USDC", decimals: 6 },
      b: { token: "USDC", decimals: 6 },
    });
    expect(toJsonSafe([shared, shared])).toEqual([
      { token: "USDC", decimals: 6 },
      { token: "USDC", decimals: 6 },
    ]);
  });

  it("serializes a reference shared across Set and Map entries in full", () => {
    const shared = { fee: BigInt(500) };
    expect(toJsonSafe(new Set([{ shared }, { shared }]))).toEqual([
      { shared: { fee: "500" } },
      { shared: { fee: "500" } },
    ]);
    expect(
      toJsonSafe(
        new Map<string, unknown>([
          ["x", shared],
          ["y", shared],
        ])
      )
    ).toEqual({ x: { fee: "500" }, y: { fee: "500" } });
  });

  it("still flags a true cycle even when the node also appears as a sibling", () => {
    const node: Record<string, unknown> = { name: "n" };
    node.self = node;
    expect(toJsonSafe({ first: node, second: node })).toEqual({
      first: { name: "n", self: "[Circular]" },
      second: { name: "n", self: "[Circular]" },
    });
  });
});
