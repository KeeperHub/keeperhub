import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock step-handler to avoid database/logging dependencies
vi.mock("@/lib/workflow/executor/step-handler", () => ({
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

import { type CollectInput, collectStep } from "../step";

function makeInput(overrides: Partial<CollectInput> = {}): CollectInput {
  return {
    results: [{ data: "a" }, { data: "b" }],
    count: 2,
    ...overrides,
  };
}

describe("collectStep", () => {
  it("returns results and count unchanged", async () => {
    const input = makeInput();
    const result = await collectStep(input);
    expect(result).toEqual({
      results: [{ data: "a" }, { data: "b" }],
      count: 2,
    });
  });

  it("handles empty results array", async () => {
    const result = await collectStep(makeInput({ results: [], count: 0 }));
    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
  });

  it("preserves mixed success/error results", async () => {
    const mixedResults = [
      { success: true, data: 42 },
      { success: false, error: "timeout" },
      { success: true, data: 99 },
    ];
    const result = await collectStep(
      makeInput({ results: mixedResults, count: 3 })
    );
    expect(result.results).toHaveLength(3);
    expect(result.results[1]).toEqual({ success: false, error: "timeout" });
  });

  it("handles single result", async () => {
    const result = await collectStep(
      makeInput({ results: [{ value: "only" }], count: 1 })
    );
    expect(result.results).toHaveLength(1);
    expect(result.count).toBe(1);
  });

  it("handles large result sets", async () => {
    const results = Array.from({ length: 100 }, (_, i) => ({ index: i }));
    const result = await collectStep(makeInput({ results, count: 100 }));
    expect(result.results).toHaveLength(100);
    expect(result.count).toBe(100);
  });

  it("preserves nested object structure in results", async () => {
    const nestedResults = [
      { data: { nested: { deep: "value" } } },
      { data: { nested: { deep: "other" } } },
    ];
    const result = await collectStep(
      makeInput({ results: nestedResults, count: 2 })
    );
    expect(result.results[0]).toEqual({
      data: { nested: { deep: "value" } },
    });
  });

  it("handles results with null and undefined values", async () => {
    const results = [null, undefined, { data: "valid" }];
    const result = await collectStep(makeInput({ results, count: 3 }));
    expect(result.results).toEqual([null, undefined, { data: "valid" }]);
    expect(result.count).toBe(3);
  });

  it("preserves primitive results", async () => {
    const results = [1, "two", true, null];
    const result = await collectStep(makeInput({ results, count: 4 }));
    expect(result.results).toEqual([1, "two", true, null]);
  });

  it("count is independent of results array length", async () => {
    const result = await collectStep(
      makeInput({ results: [1, 2, 3], count: 10 })
    );
    expect(result.results).toHaveLength(3);
    expect(result.count).toBe(10);
  });

  it("has maxRetries set to 0", () => {
    expect(collectStep.maxRetries).toBe(0);
  });
});
