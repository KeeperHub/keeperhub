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
    }
  });

  it("rejects a top-level field with a hint to nest it under input", () => {
    const result = resolveExecutionInput(JSON.stringify({ amount: "1" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("amount");
      expect(result.error).toContain("amount");
      expect(result.error).toContain("input");
    }
  });

  it("rejects multiple unrecognized top-level fields, naming all of them", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ amount: "1", token: "USDC" })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("amount");
      expect(result.error).toContain("token");
    }
  });

  it("rejects a top-level field even when input is also present", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, amount: "2" })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("amount");
    }
  });

  it("accepts executionId alongside input without treating it as unrecognized", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ input: { amount: "1" }, executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({ amount: "1" });
      expect(result.executionId).toBe("exec_123");
    }
  });

  it("accepts executionId alone with no input", () => {
    const result = resolveExecutionInput(
      JSON.stringify({ executionId: "exec_123" })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
      expect(result.executionId).toBe("exec_123");
    }
  });

  it("rejects a non-object input value rather than silently coercing it", () => {
    const result = resolveExecutionInput(JSON.stringify({ input: "oops" }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.field).toBe("input");
    }
  });

  it("defaults to empty input when neither input nor top-level fields are present", () => {
    const result = resolveExecutionInput(JSON.stringify({}));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input).toEqual({});
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