import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type CompareToleranceCoreInput,
  type CompareToleranceInput,
  compareToleranceStep,
} from "@/plugins/math/steps/compare-tolerance";

type CompareSuccess = {
  success: true;
  withinTolerance: boolean;
  breached: boolean;
  direction: string;
  difference: string;
  absoluteDifference: string;
  percentDifference: string | null;
  actual: string;
  expected: string;
  tolerance: string;
  mode: string;
};

type CompareFailure = { success: false; error: string };

function makeInput(
  overrides: Partial<CompareToleranceCoreInput>
): CompareToleranceInput {
  return {
    actual: "100",
    expected: "100",
    tolerance: "1",
    ...overrides,
  } as CompareToleranceInput;
}

async function run(
  overrides: Partial<CompareToleranceCoreInput>
): Promise<CompareSuccess | CompareFailure> {
  return (await compareToleranceStep(makeInput(overrides))) as
    | CompareSuccess
    | CompareFailure;
}

describe("math/compare-tolerance", () => {
  it("passes an exact match", async () => {
    const result = (await run({})) as CompareSuccess;

    expect(result.withinTolerance).toBe(true);
    expect(result.breached).toBe(false);
    expect(result.direction).toBe("equal");
    expect(result.difference).toBe("0");
    expect(result.percentDifference).toBe("0");
  });

  it("treats a difference exactly at the tolerance as within", async () => {
    const result = (await run({
      actual: "101",
      expected: "100",
      tolerance: "1",
    })) as CompareSuccess;

    expect(result.withinTolerance).toBe(true);
    expect(result.direction).toBe("above");
  });

  it("breaches just past the tolerance", async () => {
    const result = (await run({
      actual: "101.01",
      expected: "100",
      tolerance: "1",
    })) as CompareSuccess;

    expect(result.breached).toBe(true);
    expect(result.percentDifference).toBe("1.01");
  });

  it("handles a fractional percentage tolerance", async () => {
    const within = (await run({
      actual: "100.4",
      expected: "100",
      tolerance: "0.5",
    })) as CompareSuccess;
    const outside = (await run({
      actual: "100.6",
      expected: "100",
      tolerance: "0.5",
    })) as CompareSuccess;

    expect(within.withinTolerance).toBe(true);
    expect(outside.withinTolerance).toBe(false);
  });

  it("reports a below-expected direction with a negative percentage", async () => {
    const result = (await run({
      actual: "95",
      expected: "100",
      tolerance: "1",
    })) as CompareSuccess;

    expect(result.direction).toBe("below");
    expect(result.difference).toBe("-5");
    expect(result.absoluteDifference).toBe("5");
    expect(result.percentDifference).toBe("-5");
  });

  it("compares RAD magnitude values without float precision loss", async () => {
    // 1e45 and 1e45 + 1: a Number round-trip cannot tell these apart.
    const base = "1".padEnd(46, "0");
    const offByOne = `${"1".padEnd(45, "0")}1`;

    const result = (await run({
      actual: offByOne,
      expected: base,
      tolerance: "0",
    })) as CompareSuccess;

    expect(result.difference).toBe("1");
    expect(result.withinTolerance).toBe(false);
  });

  it("supports an absolute tolerance in the values' own units", async () => {
    const within = (await run({
      actual: "1000000000000000005",
      expected: "1000000000000000000",
      tolerance: "10",
      mode: "absolute",
    })) as CompareSuccess;
    const outside = (await run({
      actual: "1000000000000000020",
      expected: "1000000000000000000",
      tolerance: "10",
      mode: "absolute",
    })) as CompareSuccess;

    expect(within.withinTolerance).toBe(true);
    expect(outside.withinTolerance).toBe(false);
    expect(outside.mode).toBe("absolute");
  });

  it("only passes a zero expected value when actual is zero too", async () => {
    const equal = (await run({
      actual: "0",
      expected: "0",
      tolerance: "5",
    })) as CompareSuccess;
    const different = (await run({
      actual: "1",
      expected: "0",
      tolerance: "5",
    })) as CompareSuccess;

    expect(equal.withinTolerance).toBe(true);
    expect(equal.percentDifference).toBeNull();
    expect(different.withinTolerance).toBe(false);
    expect(different.percentDifference).toBeNull();
  });

  it("honours the percent decimal places", async () => {
    const result = (await run({
      actual: "1",
      expected: "3",
      tolerance: "100",
      precision: 4,
    })) as CompareSuccess;

    expect(result.percentDifference).toBe("-66.6666");
  });

  it("rejects a non-numeric value", async () => {
    const result = await run({ actual: "not a number" });

    expect(result.success).toBe(false);
    expect((result as CompareFailure).error).toContain(
      "Actual must be a number"
    );
  });
});
