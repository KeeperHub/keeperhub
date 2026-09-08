import { describe, expect, it } from "vitest";
import {
  countTemplateTokens,
  TEMPLATE_TOKEN_PATTERN,
  toStringValue,
} from "@/components/ui/template-badge-utils";

describe("toStringValue", () => {
  it("returns the value unchanged when it is a string", () => {
    expect(toStringValue("hello")).toBe("hello");
  });

  it("returns an empty string for undefined", () => {
    expect(toStringValue(undefined)).toBe("");
  });

  it("returns an empty string for null", () => {
    expect(toStringValue(null)).toBe("");
  });

  it("coerces numbers to strings", () => {
    expect(toStringValue(42)).toBe("42");
  });

  it("coerces booleans to strings", () => {
    expect(toStringValue(true)).toBe("true");
  });
});

describe("countTemplateTokens", () => {
  it("returns 0 when value is undefined (KEEP-366 regression)", () => {
    expect(countTemplateTokens(undefined)).toBe(0);
  });

  it("returns 0 when value is null", () => {
    expect(countTemplateTokens(null)).toBe(0);
  });

  it("returns 0 for an empty string", () => {
    expect(countTemplateTokens("")).toBe(0);
  });

  it("returns 0 when no tokens are present", () => {
    expect(countTemplateTokens("just plain text")).toBe(0);
  });

  it("counts a single token", () => {
    expect(countTemplateTokens("hello {{@node1:field}}")).toBe(1);
  });

  it("counts multiple tokens", () => {
    expect(countTemplateTokens("{{@a:x}} and {{@b:y}} plus {{@c:z}}")).toBe(3);
  });

  it("does not throw when value is a non-string (numeric leaks)", () => {
    expect(() => countTemplateTokens(123)).not.toThrow();
    expect(countTemplateTokens(123)).toBe(0);
  });

  it("does not match malformed tokens", () => {
    expect(countTemplateTokens("{{@node1}}")).toBe(0);
    expect(countTemplateTokens("{@node1:field}")).toBe(0);
  });
});

describe("TEMPLATE_TOKEN_PATTERN", () => {
  it("is a global regex so match() returns all occurrences", () => {
    expect(TEMPLATE_TOKEN_PATTERN.global).toBe(true);
  });
});
