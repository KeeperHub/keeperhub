import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type AggregateCoreInput,
  type AggregateInput,
  aggregateStep,
} from "@/plugins/math/steps/aggregate";

type SuccessResult = {
  success: true;
  result: string;
  resultType: string;
  operation: string;
  inputCount: number;
};

type FailureResult = {
  success: false;
  error: string;
};

type AggregateResult = SuccessResult | FailureResult;

function makeInput(overrides: Partial<AggregateCoreInput>): AggregateInput {
  return {
    operation: "sum",
    inputMode: "explicit",
    ...overrides,
  } as AggregateInput;
}

async function runAggregation(
  overrides: Partial<AggregateCoreInput>
): Promise<AggregateResult> {
  return (await aggregateStep(makeInput(overrides))) as AggregateResult;
}

async function expectSuccess(
  overrides: Partial<AggregateCoreInput>
): Promise<SuccessResult> {
  const result = await runAggregation(overrides);
  expect(result.success).toBe(true);
  return result as SuccessResult;
}

async function expectFailure(
  overrides: Partial<AggregateCoreInput>
): Promise<FailureResult> {
  const result = await runAggregation(overrides);
  expect(result.success).toBe(false);
  return result as FailureResult;
}

// ─── Aggregation Operations (Explicit Mode) ─────────────────────────────────

describe("math/aggregate - explicit mode", () => {
  describe("sum", () => {
    it("sums comma-separated values", async () => {
      const result = await expectSuccess({
        operation: "sum",
        explicitValues: "10, 20, 30",
      });
      expect(result.result).toBe("60");
      expect(result.inputCount).toBe(3);
    });

    it("sums newline-separated values", async () => {
      const result = await expectSuccess({
        operation: "sum",
        explicitValues: "100\n200\n300",
      });
      expect(result.result).toBe("600");
    });

    it("fails when explicitValues is empty string", async () => {
      const result = await expectFailure({
        operation: "sum",
        explicitValues: "",
      });
      expect(result.error).toContain("explicitValues is required");
    });

    it("returns 0 for input with only non-numeric values", async () => {
      const result = await expectSuccess({
        operation: "sum",
        explicitValues: "abc, def",
      });
      expect(result.result).toBe("0");
      expect(result.inputCount).toBe(0);
    });

    it("skips non-numeric values silently", async () => {
      const result = await expectSuccess({
        operation: "sum",
        explicitValues: "10, abc, 30, , 50",
      });
      expect(result.result).toBe("90");
      expect(result.inputCount).toBe(3);
    });

    it("handles decimal values", async () => {
      const result = await expectSuccess({
        operation: "sum",
        explicitValues: "1.5, 2.3, 0.2",
      });
      expect(result.result).toBe("4");
    });
  });

  describe("count", () => {
    it("counts numeric values", async () => {
      const result = await expectSuccess({
        operation: "count",
        explicitValues: "10, 20, 30",
      });
      expect(result.result).toBe("3");
      expect(result.inputCount).toBe(3);
    });

    it("returns 0 for input with only non-numeric values", async () => {
      const result = await expectSuccess({
        operation: "count",
        explicitValues: "abc",
      });
      expect(result.result).toBe("0");
    });

    it("excludes non-numeric values from count", async () => {
      const result = await expectSuccess({
        operation: "count",
        explicitValues: "10, abc, 30",
      });
      expect(result.result).toBe("2");
    });
  });

  describe("average", () => {
    it("computes arithmetic mean", async () => {
      const result = await expectSuccess({
        operation: "average",
        explicitValues: "10, 20, 30",
      });
      expect(result.result).toBe("20");
    });

    it("handles fractional averages", async () => {
      const result = await expectSuccess({
        operation: "average",
        explicitValues: "1, 2",
      });
      expect(result.result).toBe("1.5");
    });

    it("fails on input with only non-numeric values", async () => {
      const result = await expectFailure({
        operation: "average",
        explicitValues: "abc, def",
      });
      expect(result.error).toContain("empty set");
    });
  });

  describe("median", () => {
    it("returns middle value for odd count", async () => {
      const result = await expectSuccess({
        operation: "median",
        explicitValues: "3, 1, 2",
      });
      expect(result.result).toBe("2");
    });

    it("returns mean of two middle values for even count", async () => {
      const result = await expectSuccess({
        operation: "median",
        explicitValues: "1, 2, 3, 4",
      });
      expect(result.result).toBe("2.5");
    });

    it("handles single value", async () => {
      const result = await expectSuccess({
        operation: "median",
        explicitValues: "42",
      });
      expect(result.result).toBe("42");
    });

    it("fails on input with only non-numeric values", async () => {
      const result = await expectFailure({
        operation: "median",
        explicitValues: "abc",
      });
      expect(result.error).toContain("empty set");
    });
  });

  describe("min", () => {
    it("returns smallest value", async () => {
      const result = await expectSuccess({
        operation: "min",
        explicitValues: "30, 10, 20",
      });
      expect(result.result).toBe("10");
    });

    it("handles negative values", async () => {
      const result = await expectSuccess({
        operation: "min",
        explicitValues: "-5, 0, 5",
      });
      expect(result.result).toBe("-5");
    });

    it("fails on input with only non-numeric values", async () => {
      const result = await expectFailure({
        operation: "min",
        explicitValues: "abc",
      });
      expect(result.error).toContain("empty set");
    });
  });

  describe("max", () => {
    it("returns largest value", async () => {
      const result = await expectSuccess({
        operation: "max",
        explicitValues: "30, 10, 20",
      });
      expect(result.result).toBe("30");
    });

    it("handles negative values", async () => {
      const result = await expectSuccess({
        operation: "max",
        explicitValues: "-5, -10, -1",
      });
      expect(result.result).toBe("-1");
    });
  });

  describe("product", () => {
    it("multiplies all values", async () => {
      const result = await expectSuccess({
        operation: "product",
        explicitValues: "2, 3, 4",
      });
      expect(result.result).toBe("24");
    });

    it("returns 1 for input with only non-numeric values", async () => {
      const result = await expectSuccess({
        operation: "product",
        explicitValues: "abc",
      });
      expect(result.result).toBe("1");
    });

    it("returns 0 when any value is 0", async () => {
      const result = await expectSuccess({
        operation: "product",
        explicitValues: "5, 0, 3",
      });
      expect(result.result).toBe("0");
    });
  });
});

// ─── Array Mode ──────────────────────────────────────────────────────────────

describe("math/aggregate - array mode", () => {
  it("sums plain numeric array", async () => {
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: "[10, 20, 30]",
    });
    expect(result.result).toBe("60");
    expect(result.inputCount).toBe(3);
  });

  it("extracts values using fieldPath", async () => {
    const data = [
      { balance: { amount: "100" } },
      { balance: { amount: "200" } },
      { balance: { amount: "300" } },
    ];
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
      fieldPath: "balance.amount",
    });
    expect(result.result).toBe("600");
    expect(result.inputCount).toBe(3);
  });

  it("extracts values from top-level field", async () => {
    const data = [{ value: "5" }, { value: "15" }, { value: "25" }];
    const result = await expectSuccess({
      operation: "average",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
      fieldPath: "value",
    });
    expect(result.result).toBe("15");
  });

  it("rejects object input and suggests referencing array field directly", async () => {
    const data = { rows: [{ cost: 10 }, { cost: 20 }] };
    const result = await expectFailure({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
      fieldPath: "cost",
    });
    expect(result.error).toContain("must be a JSON array");
    expect(result.error).toContain("reference the array field directly");
  });

  it("skips elements with missing fieldPath", async () => {
    const data = [
      { balance: "100" },
      { other: "not-a-balance" },
      { balance: "200" },
    ];
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
      fieldPath: "balance",
    });
    expect(result.result).toBe("300");
    expect(result.inputCount).toBe(2);
  });

  it("fails on invalid JSON", async () => {
    const result = await expectFailure({
      operation: "sum",
      inputMode: "array",
      arrayInput: "not json",
    });
    expect(result.error).toContain("not valid JSON");
  });

  it("fails on non-array JSON", async () => {
    const result = await expectFailure({
      operation: "sum",
      inputMode: "array",
      arrayInput: '"just a string"',
    });
    expect(result.error).toContain("must be a JSON array");
  });

  it("fails when arrayInput is missing", async () => {
    const result = await expectFailure({
      operation: "sum",
      inputMode: "array",
    });
    expect(result.error).toContain("arrayInput is required");
  });
});

// ─── String-Encoded Numbers ──────────────────────────────────────────────────

describe("math/aggregate - string-encoded numbers", () => {
  it("parses plain string numbers", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1234.56",
    });
    expect(result.result).toBe("1234.56");
  });

  it("strips commas from formatted numbers", async () => {
    const data = ["1,234", "5,678"];
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
    });
    expect(result.result).toBe("6912");
  });

  it("handles mixed string and number types in array", async () => {
    const data = [100, "200", 300];
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify(data),
    });
    expect(result.result).toBe("600");
  });
});

// ─── BigInt Arithmetic ───────────────────────────────────────────────────────

describe("math/aggregate - BigInt arithmetic", () => {
  const largeValue1 = "9007199254740993"; // > Number.MAX_SAFE_INTEGER
  const largeValue2 = "9007199254740994";

  it("uses bigint for values exceeding MAX_SAFE_INTEGER", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${largeValue1}, ${largeValue2}`,
    });
    expect(result.result).toBe("18014398509481987");
    expect(result.resultType).toBe("bigint");
  });

  it("uses bigint for product of large values", async () => {
    const result = await expectSuccess({
      operation: "product",
      explicitValues: `${largeValue1}, 2`,
    });
    expect(result.result).toBe("18014398509481986");
    expect(result.resultType).toBe("bigint");
  });

  it("computes min with BigInt values", async () => {
    const result = await expectSuccess({
      operation: "min",
      explicitValues: `${largeValue2}, ${largeValue1}`,
    });
    expect(result.result).toBe(largeValue1);
    expect(result.resultType).toBe("bigint");
  });

  it("computes max with BigInt values", async () => {
    const result = await expectSuccess({
      operation: "max",
      explicitValues: `${largeValue1}, ${largeValue2}`,
    });
    expect(result.result).toBe(largeValue2);
    expect(result.resultType).toBe("bigint");
  });

  it("computes count with BigInt values as number", async () => {
    const result = await expectSuccess({
      operation: "count",
      explicitValues: `${largeValue1}, ${largeValue2}`,
    });
    expect(result.result).toBe("2");
  });

  it("computes median with BigInt values", async () => {
    const result = await expectSuccess({
      operation: "median",
      explicitValues: `${largeValue1}, ${largeValue2}, 9007199254740995`,
    });
    expect(result.result).toBe(largeValue2);
    expect(result.resultType).toBe("bigint");
  });

  it("aggregates with bigint precision then converts for post-operation", async () => {
    // 9007199254740993 + 1 = 9007199254740994 (BigInt aggregation preserves this)
    // Then multiply by 1 to verify post-op applies to the correct aggregated value
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${largeValue1}, 1`,
      postOperation: "multiply",
      postOperand: "1",
    });
    expect(result.resultType).toBe("number");
    // The aggregation used BigInt (9007199254740993 + 1 = 9007199254740994)
    // then converted to Number for the post-op
    expect(result.result).toBe("9007199254740994");
  });
});

// ─── Post-Aggregation Operations ─────────────────────────────────────────────

describe("math/aggregate - post-operations (binary)", () => {
  it("adds a constant to the result", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "10, 20",
      postOperation: "add",
      postOperand: "5",
    });
    expect(result.result).toBe("35");
    expect(result.operation).toBe("sum then add");
  });

  it("subtracts a constant from the result", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "100",
      postOperation: "subtract",
      postOperand: "30",
    });
    expect(result.result).toBe("70");
  });

  it("multiplies the result by a constant", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "10, 20",
      postOperation: "multiply",
      postOperand: "3",
    });
    expect(result.result).toBe("90");
  });

  it("divides the result by a constant", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "10, 20",
      postOperation: "divide",
      postOperand: "2",
    });
    expect(result.result).toBe("15");
  });

  it("fails on division by zero", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "divide",
      postOperand: "0",
    });
    expect(result.error).toContain("Division by zero");
  });

  it("computes modulo", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "17",
      postOperation: "modulo",
      postOperand: "5",
    });
    expect(result.result).toBe("2");
  });

  it("fails on modulo by zero", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "modulo",
      postOperand: "0",
    });
    expect(result.error).toContain("Modulo by zero");
  });

  it("raises to a power", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3",
      postOperation: "power",
      postOperand: "4",
    });
    expect(result.result).toBe("81");
  });

  it("fails when operand is missing for binary post-op", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "multiply",
    });
    expect(result.error).toContain("postOperand is required");
  });
});

describe("math/aggregate - post-operations (unary)", () => {
  it("computes absolute value", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "-42",
      postOperation: "abs",
    });
    expect(result.result).toBe("42");
  });

  it("abs of positive value is unchanged", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "42",
      postOperation: "abs",
    });
    expect(result.result).toBe("42");
  });

  it("rounds to nearest integer", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.7",
      postOperation: "round",
    });
    expect(result.result).toBe("4");
  });

  it("rounds down with floor", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.9",
      postOperation: "floor",
    });
    expect(result.result).toBe("3");
  });

  it("rounds up with ceil", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.1",
      postOperation: "ceil",
    });
    expect(result.result).toBe("4");
  });
});

describe("math/aggregate - round-decimals", () => {
  it("rounds to 2 decimal places", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.14159",
      postOperation: "round-decimals",
      postDecimalPlaces: "2",
    });
    expect(result.result).toBe("3.14");
  });

  it("rounds to 5 decimal places", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.141592653",
      postOperation: "round-decimals",
      postDecimalPlaces: "5",
    });
    expect(result.result).toBe("3.14159");
  });

  it("rounds to 0 decimal places (integer)", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "3.7",
      postOperation: "round-decimals",
      postDecimalPlaces: "0",
    });
    expect(result.result).toBe("4");
  });

  it("fails when decimal places is missing", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "3.14",
      postOperation: "round-decimals",
    });
    expect(result.error).toContain("postDecimalPlaces is required");
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("math/aggregate - validation", () => {
  it("fails on invalid operation", async () => {
    const result = await expectFailure({
      operation: "invalid" as AggregateCoreInput["operation"],
    });
    expect(result.error).toContain("Invalid operation");
  });

  it("fails on invalid inputMode", async () => {
    const result = await expectFailure({
      operation: "sum",
      inputMode: "invalid" as AggregateCoreInput["inputMode"],
    });
    expect(result.error).toContain("Invalid inputMode");
  });

  it("fails when explicitValues is missing in explicit mode", async () => {
    const result = await expectFailure({
      operation: "sum",
      inputMode: "explicit",
    });
    expect(result.error).toContain("explicitValues is required");
  });

  it("fails on invalid postOperation", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "invalid" as AggregateCoreInput["postOperation"],
    });
    expect(result.error).toContain("Invalid postOperation");
  });

  it("postOperation none is treated as no post-op", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "10, 20",
      postOperation: "none",
    });
    expect(result.result).toBe("30");
    expect(result.operation).toBe("sum");
  });
});

// ─── Operation Label ─────────────────────────────────────────────────────────

describe("math/aggregate - operation label", () => {
  it("shows simple operation name without post-op", async () => {
    const result = await expectSuccess({
      operation: "average",
      explicitValues: "10, 20",
    });
    expect(result.operation).toBe("average");
  });

  it("shows chained operation label with post-op", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "10",
      postOperation: "divide",
      postOperand: "2",
    });
    expect(result.operation).toBe("sum then divide");
  });

  it("shows chained label for unary post-op", async () => {
    const result = await expectSuccess({
      operation: "min",
      explicitValues: "-5, 3",
      postOperation: "abs",
    });
    expect(result.operation).toBe("min then abs");
  });
});
