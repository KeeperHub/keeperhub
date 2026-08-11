import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { serializeSqlParams } from "@/lib/workflow/nodes/database-query/step";

describe("serializeSqlParams", () => {
  it("passes null through", () => {
    expect(serializeSqlParams([null])).toEqual([null]);
  });

  it("converts undefined to null", () => {
    expect(serializeSqlParams([undefined])).toEqual([null]);
  });

  it("passes strings through", () => {
    expect(serializeSqlParams(["hello"])).toEqual(["hello"]);
  });

  it("passes numbers through", () => {
    expect(serializeSqlParams([42, 3.14, 0])).toEqual([42, 3.14, 0]);
  });

  it("passes booleans through", () => {
    expect(serializeSqlParams([true, false])).toEqual([true, false]);
  });

  it("passes Date instances through natively", () => {
    const date = new Date("2026-01-15T12:00:00Z");
    const result = serializeSqlParams([date]);
    expect(result[0]).toBe(date);
    expect(result[0]).toBeInstanceOf(Date);
  });

  it("passes Uint8Array instances through natively", () => {
    const bytes = new Uint8Array([0x01, 0x02, 0x03]);
    const result = serializeSqlParams([bytes]);
    expect(result[0]).toBe(bytes);
    expect(result[0]).toBeInstanceOf(Uint8Array);
  });

  it("JSON-stringifies plain objects for JSONB columns", () => {
    const obj = { name: "Alice", age: 30 };
    const result = serializeSqlParams([obj]);
    expect(result[0]).toBe('{"name":"Alice","age":30}');
  });

  it("JSON-stringifies arrays for JSONB columns", () => {
    const arr = [1, 2, 3];
    const result = serializeSqlParams([arr]);
    expect(result[0]).toBe("[1,2,3]");
  });

  it("JSON-stringifies nested objects", () => {
    const nested = { users: [{ id: 1 }, { id: 2 }] };
    const result = serializeSqlParams([nested]);
    expect(result[0]).toBe('{"users":[{"id":1},{"id":2}]}');
  });

  it("handles mixed types in a single call", () => {
    const date = new Date("2026-01-01T00:00:00Z");
    const params = [null, "text", 42, true, date, { key: "val" }, [1, 2]];
    const result = serializeSqlParams(params);

    expect(result).toEqual([
      null,
      "text",
      42,
      true,
      date,
      '{"key":"val"}',
      "[1,2]",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(serializeSqlParams([])).toEqual([]);
  });
});
