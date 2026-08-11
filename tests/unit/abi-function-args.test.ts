import { describe, expect, it } from "vitest";

import { parseAbiFunctionArgs } from "@/lib/abi/parse-args";

describe("parseAbiFunctionArgs", () => {
  it("returns empty array for empty string", () => {
    expect(parseAbiFunctionArgs("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseAbiFunctionArgs("   ")).toEqual([]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseAbiFunctionArgs("not json")).toEqual([]);
  });

  it("returns empty array when parsed value is not an array", () => {
    expect(parseAbiFunctionArgs('{"a": 1}')).toEqual([]);
    expect(parseAbiFunctionArgs("42")).toEqual([]);
    expect(parseAbiFunctionArgs('"hello"')).toEqual([]);
  });

  // The KEEP-367 regression tests: stored numeric args must surface as strings
  // so TemplateBadgeInput's internalValue.match() does not throw.
  it("coerces raw numbers to strings", () => {
    const result = parseAbiFunctionArgs("[1]");
    expect(result).toEqual(["1"]);
    expect(typeof result[0]).toBe("string");
  });

  it("coerces multiple raw numbers to strings", () => {
    const result = parseAbiFunctionArgs("[1, 42, 0]");
    expect(result).toEqual(["1", "42", "0"]);
  });

  it("coerces booleans to strings", () => {
    expect(parseAbiFunctionArgs("[true, false]")).toEqual(["true", "false"]);
  });

  it("converts null and undefined entries to empty strings", () => {
    expect(parseAbiFunctionArgs("[null]")).toEqual([""]);
  });

  it("preserves string entries unchanged", () => {
    expect(parseAbiFunctionArgs('["0xabc", "1"]')).toEqual(["0xabc", "1"]);
  });

  it("preserves arrays as arrays (for ArrayInputField)", () => {
    const result = parseAbiFunctionArgs("[[1, 2, 3]]");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([1, 2, 3]);
    expect(Array.isArray(result[0])).toBe(true);
  });

  it("preserves objects as objects (for TupleInputField)", () => {
    const result = parseAbiFunctionArgs('[{"x": 1, "y": "a"}]');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ x: 1, y: "a" });
  });

  it("handles a mix of primitives, arrays, and objects in one call", () => {
    const result = parseAbiFunctionArgs('[1, "0xabc", [1, 2], {"x": 3}]');
    expect(result).toEqual(["1", "0xabc", [1, 2], { x: 3 }]);
  });
});
