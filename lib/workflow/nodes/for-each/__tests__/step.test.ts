import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock step-handler to avoid database/logging dependencies
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

import { type ForEachInput, forEachStep } from "../step";

function makeInput(overrides: Partial<ForEachInput> = {}): ForEachInput {
  return {
    arrayLength: 5,
    maxIterations: 100,
    ...overrides,
  };
}

describe("forEachStep", () => {
  it("returns success with input values echoed back", async () => {
    const result = await forEachStep(makeInput());
    expect(result).toEqual({
      success: true,
      arrayLength: 5,
      maxIterations: 100,
    });
  });

  it("reflects custom maxIterations and arrayLength", async () => {
    const result = await forEachStep(
      makeInput({ arrayLength: 20, maxIterations: 50 })
    );
    expect(result.maxIterations).toBe(50);
    expect(result.arrayLength).toBe(20);
  });

  it("handles zero arrayLength", async () => {
    const result = await forEachStep(
      makeInput({ arrayLength: 0, maxIterations: 10 })
    );
    expect(result.arrayLength).toBe(0);
    expect(result.success).toBe(true);
  });

  it("handles zero maxIterations (process all)", async () => {
    const result = await forEachStep(
      makeInput({ arrayLength: 5, maxIterations: 0 })
    );
    expect(result.maxIterations).toBe(0);
    expect(result.success).toBe(true);
  });

  it("handles large array length", async () => {
    const result = await forEachStep(
      makeInput({ arrayLength: 10_000, maxIterations: 100 })
    );
    expect(result.arrayLength).toBe(10_000);
    expect(result.maxIterations).toBe(100);
  });

  it("returns consistent shape regardless of input values", async () => {
    const result = await forEachStep(
      makeInput({ arrayLength: 3, maxIterations: 1 })
    );
    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("arrayLength");
    expect(result).toHaveProperty("maxIterations");
    expect(Object.keys(result)).toHaveLength(3);
  });

  it("has maxRetries set to 0", () => {
    expect(forEachStep.maxRetries).toBe(0);
  });
});
