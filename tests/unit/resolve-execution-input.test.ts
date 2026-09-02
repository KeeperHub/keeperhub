import { describe, expect, it } from "vitest";
import { resolveExecutionInput } from "@/lib/workflow/resolve-execution-input";

describe("resolveExecutionInput (KEEP-1931)", () => {
  it("uses the nested input object when input is sent (unchanged shape)", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" } })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecationWarning).toBeUndefined();
    }
  });

  it("binds a bare top-level field as input, with a deprecation warning (kh CLI compat)", () => {
    const result = resolveExecutionInput(JSON.stringify({ amount: "1" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecationWarning).toBeDefined();
      expect(result.deprecationWarning).toContain("input");
    }
  });

  it("binds multiple bare top-level fields as input, with a deprecation warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ amount: "1", token: "USDC" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1", token: "USDC" });
      expect(result.deprecationWarning).toBeDefined();
    }
  });

  it("rejects a body mixing a nested input object with stray top-level fields", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, amount: "2" })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("input");
    }
  });

  it("accepts executionId alongside input without treating it as unrecognized", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecationWarning).toBeUndefined();
    }
  });

  it("accepts executionId alone with no input, no warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecationWarning).toBeUndefined();
    }
  });

  it("treats a null input the same as input being absent (matches staging's `?? {}` today)", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: null }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecationWarning).toBeUndefined();
    }
  });

  it("treats null input plus a bare top-level field as the bare-field case, with a warning", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: null, amount: "1" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.deprecationWarning).toBeDefined();
    }
  });

  it("rejects a non-null, non-object input value rather than silently coercing it", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: "oops" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("input");
    }
  });

  it("rejects a non-object input even when no other top-level fields are present", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: [1, 2] }));

    expect(result.ok).toBe(false);
  });

  it("defaults to empty input when neither input nor top-level fields are present", () => {
    const result = resolveExecutionInput(JSON.stringify({}));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.deprecationWarning).toBeUndefined();
    }
  });

  it("defaults to empty input for an empty raw body", () => {
    const result = resolveExecutionInput("");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input for invalid JSON, matching the pre-fix contract", () => {
    const result = resolveExecutionInput("{not valid json");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is not an object (array)", () => {
    const result = resolveExecutionInput(JSON.stringify([1, 2, 3]));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is a bare null", () => {
    const result = resolveExecutionInput("null");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("defaults to empty input when the JSON body is a bare primitive", () => {
    const result = resolveExecutionInput('"just a string"');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
    }
  });

  it("preserves the raw parsed body for callers that need it unmodified (idempotency hashing)", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawParsed).toEqual({
        input: { amount: "1" },
        executionId: "exec_123",
      });
    }
  });
});