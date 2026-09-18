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
  divisionByZero?: true;
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

  it("keeps bigint precision through a post-operation", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${largeValue1}, 1`,
      postOperation: "multiply",
      postOperand: "1",
    });
    expect(result.result).toBe("9007199254740994");
    expect(result.resultType).toBe("bigint");
  });
});

// ─── Mixed magnitudes ───────────────────────────────────────────────────────
//
// A wei amount next to a fractional rate used to put the set on the bigint
// path, where every fraction was truncated to an integer and the step still
// reported success. These pin the fixed-point path that replaced it.

describe("math/aggregate - mixed magnitudes", () => {
  const wei = "1000000000000000000"; // 1e18, past MAX_SAFE_INTEGER

  it("sums a wei amount and a fractional rate without dropping the fraction", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 0.05`,
    });
    expect(result.result).toBe("1000000000000000000.05");
    expect(result.resultType).toBe("number");
    expect(result.inputCount).toBe(2);
  });

  it("does not turn a fractional rate into zero in a product", async () => {
    const result = await expectSuccess({
      operation: "product",
      explicitValues: `${wei}, 0.05`,
    });
    expect(result.result).toBe("50000000000000000");
    expect(result.resultType).toBe("bigint");
  });

  it("averages a wei amount and a fraction exactly", async () => {
    const result = await expectSuccess({
      operation: "average",
      explicitValues: `${wei}, 0.5`,
    });
    expect(result.result).toBe("500000000000000000.25");
  });

  it("keeps the original digits of a decimal string rather than the nearest float", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 0.1, 0.2`,
    });
    expect(result.result).toBe("1000000000000000000.3");
  });

  it("accepts exponent-form numbers from a JSON array on the fixed-point path", async () => {
    const result = await expectSuccess({
      operation: "sum",
      inputMode: "array",
      arrayInput: JSON.stringify([1e21, 2.5e-3, "9007199254740993"]),
    });
    expect(result.result).toBe("1000009007199254740993.0025");
  });

  it("expands exponent-form text exactly rather than through the float", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 1.5e-3, 1e-7, 2E+1`,
    });
    expect(result.result).toBe("1000000000000000020.0015001");
  });

  it("keeps min and max exact across magnitudes", async () => {
    const min = await expectSuccess({
      operation: "min",
      explicitValues: `${wei}, 0.000001`,
    });
    expect(min.result).toBe("0.000001");
    const max = await expectSuccess({
      operation: "max",
      explicitValues: `${wei}, 0.000001`,
    });
    expect(max.result).toBe(wei);
    expect(max.resultType).toBe("bigint");
  });

  it("halves an even-count median exactly", async () => {
    const result = await expectSuccess({
      operation: "median",
      explicitValues: `${wei}, 1000000000000000001`,
    });
    expect(result.result).toBe("1000000000000000000.5");
  });

  it("truncates a non-terminating average at 18 places", async () => {
    const result = await expectSuccess({
      operation: "average",
      explicitValues: `${wei}, ${wei}, 1`,
    });
    expect(result.result).toBe("666666666666666667");
    const tenThirds = await expectSuccess({
      operation: "average",
      explicitValues: "9007199254740993, 1, 0",
    });
    expect(tenThirds.result).toBe("3002399751580331.333333333333333333");
  });
});

describe("math/aggregate - fixed-point inputs that only Number() understands", () => {
  const big = "9007199254740993";

  it("carries hex, binary, octal and trailing-dot forms as the float's digits", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "0xde0b6b3a7640000, 1000000000000000000",
    });
    expect(result.result).toBe("2000000000000000000");
    const mixed = await expectSuccess({
      operation: "sum",
      explicitValues: `0x10, 0b1010, 0o17, 5., 1., ${big}`,
    });
    expect(mixed.result).toBe("9007199254741040");
    expect(mixed.inputCount).toBe(6);
  });

  it("gives the same answer for a token whether or not a large sibling is present", async () => {
    const alone = await expectSuccess({
      operation: "sum",
      explicitValues: "0x10, 5",
    });
    const withBig = await expectSuccess({
      operation: "sum",
      explicitValues: `0x10, 5, ${big}`,
    });
    expect(alone.result).toBe("21");
    expect(withBig.result).toBe("9007199254741014");
  });
});

describe("math/aggregate - quotients far below the working scale", () => {
  it("keeps significant digits when the numerator is much smaller than the divisor", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1, 9007199254740993, -9007199254740993",
      postOperation: "divide",
      postOperand: "10000000000000000000",
    });
    expect(result.result).toBe("0.0000000000000000001");
    expect(result.resultType).toBe("number");
    const third = await expectSuccess({
      operation: "sum",
      explicitValues: "1, 9007199254740993, -9007199254740993",
      postOperation: "divide",
      postOperand: "3000000000000000000",
    });
    expect(third.result).toBe("0.000000000000000000333333333333333333");
  });

  it("keeps a dust amount over a raw supply from collapsing to zero in an average", async () => {
    const result = await expectSuccess({
      operation: "average",
      explicitValues:
        "0.000000000000000000001, 9007199254740993, -9007199254740993",
    });
    expect(result.result).toBe("0.000000000000000000000333333333333333333");
  });
});

describe("math/aggregate - bounds on fixed-point work", () => {
  it("treats a shift far below the scale bound as zero and returns quickly", async () => {
    const start = performance.now();
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1e-100000, 9007199254740993",
    });
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.result).toBe("9007199254740993");
  });

  it("bounds the operand the same way", async () => {
    const start = performance.now();
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "add",
      postOperand: "1e-60000",
    });
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.result).toBe("9007199254740993");
  });

  it("caps the accumulated scale of a product", async () => {
    const tiny = `0.${"0".repeat(99)}1`;
    const values = Array.from({ length: 10 }, () => tiny).join(", ");
    const start = performance.now();
    const result = await expectSuccess({
      operation: "product",
      explicitValues: `${values}, 9007199254740993`,
    });
    expect(performance.now() - start).toBeLessThan(200);
    // 1e-1000 times a safe-range integer is below 1e-256 and rounds to zero.
    expect(result.result).toBe("0");
  });

  it("sends a power whose result would be too long through float", async () => {
    const base = "1".repeat(1000);
    const start = performance.now();
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: base,
      postOperation: "power",
      postOperand: "256",
    });
    expect(performance.now() - start).toBeLessThan(200);
    expect(result.result).toBe("Infinity");
  });
});

describe("math/aggregate - divisor precision and negative rounding", () => {
  it("reports a divisor that rounds to zero at the scale bound as underflow, not a zero divisor", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "divide",
      postOperand: "1e-257",
    });
    expect(result.error).toContain("256-decimal-place precision");
    expect(result.divisionByZero).toBeUndefined();
  });

  it("divides by a divisor at the scale bound exactly", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "divide",
      postOperand: "1e-256",
    });
    expect(result.result).toBe(`9007199254740993${"0".repeat(256)}`);
    expect(result.resultType).toBe("bigint");
  });

  it("bounds the scale of a multiply like every other intermediate", async () => {
    const tiny = `0.${"0".repeat(255)}1`;
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${tiny}, 9007199254740993, -9007199254740993`,
      postOperation: "multiply",
      postOperand: tiny,
    });
    // 1e-256 times 1e-256 is below the 256-place bound and rounds to zero.
    expect(result.result).toBe("0");
  });

  it("rounds to tens for negative decimal places on both paths", async () => {
    const fixed = await expectSuccess({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "round-decimals",
      postDecimalPlaces: "-2",
    });
    expect(fixed.result).toBe("9007199254741000");
    const float = await expectSuccess({
      operation: "sum",
      explicitValues: "1234",
      postOperation: "round-decimals",
      postDecimalPlaces: "-2",
    });
    expect(float.result).toBe("1200");
  });
});

// ─── Post-operations in fixed point ─────────────────────────────────────────

describe("math/aggregate - post-operations on the fixed-point path", () => {
  const wei = "1500000000000000000";

  it("divides a wei sum by 1e18 without dropping to float", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, ${wei}`,
      postOperation: "divide",
      postOperand: "1000000000000000000",
    });
    expect(result.result).toBe("3");
    expect(result.resultType).toBe("bigint");
  });

  it("returns a fractional quotient exactly", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 1`,
      postOperation: "divide",
      postOperand: "1000000000000000000",
    });
    expect(result.result).toBe("1.500000000000000001");
    expect(result.resultType).toBe("number");
  });

  it("parses the operand from its text, so a large operand is not rounded", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1000000000000000001",
      postOperation: "subtract",
      postOperand: "1000000000000000001",
    });
    expect(result.result).toBe("0");
  });

  it("falls back to float for a fractional exponent", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "power",
      postOperand: "0.5",
    });
    expect(Number(result.result)).toBeCloseTo(94_906_265.62, 1);
    expect(result.resultType).toBe("number");
  });

  it("reports Infinity, not a failure, when a float-fallback power overflows", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1000000000000000000",
      postOperation: "power",
      postOperand: "300",
    });
    expect(result.result).toBe("Infinity");
    expect(result.resultType).toBe("number");
  });

  it("computes a large integer power exactly", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "1000000000000000000",
      postOperation: "power",
      postOperand: "65",
    });
    expect(result.result).toBe(`1${"0".repeat(18 * 65)}`);
    expect(result.resultType).toBe("bigint");
  });

  it("multiplies by a fractional operand exactly", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: wei,
      postOperation: "multiply",
      postOperand: "0.5",
    });
    expect(result.result).toBe("750000000000000000");
  });

  it("adds and subtracts across scales", async () => {
    const added = await expectSuccess({
      operation: "sum",
      explicitValues: wei,
      postOperation: "add",
      postOperand: "0.25",
    });
    expect(added.result).toBe("1500000000000000000.25");
    const subtracted = await expectSuccess({
      operation: "sum",
      explicitValues: wei,
      postOperation: "subtract",
      postOperand: "0.25",
    });
    expect(subtracted.result).toBe("1499999999999999999.75");
  });

  it("computes modulo on the aligned scale", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 0.5`,
      postOperation: "modulo",
      postOperand: "1000000000000000000",
    });
    expect(result.result).toBe("500000000000000000.5");
  });

  it("raises to an integer power exactly", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: "9007199254740993",
      postOperation: "power",
      postOperand: "2",
    });
    expect(result.result).toBe("81129638414606699710187514626049");
    expect(result.resultType).toBe("bigint");
  });

  it("rounds to N decimal places half up", async () => {
    const result = await expectSuccess({
      operation: "sum",
      explicitValues: `${wei}, 0.125`,
      postOperation: "round-decimals",
      postDecimalPlaces: "2",
    });
    expect(result.result).toBe("1500000000000000000.13");
  });

  it("rounds, floors and ceils to an integer", async () => {
    const base = { operation: "sum" as const, explicitValues: `${wei}, 0.5` };
    expect(
      (await expectSuccess({ ...base, postOperation: "round" })).result
    ).toBe("1500000000000000001");
    expect(
      (await expectSuccess({ ...base, postOperation: "floor" })).result
    ).toBe("1500000000000000000");
    expect(
      (await expectSuccess({ ...base, postOperation: "ceil" })).result
    ).toBe("1500000000000000001");
  });

  it("floors and ceils negatives toward the right side", async () => {
    const base = { operation: "sum" as const, explicitValues: `-${wei}, -0.5` };
    expect(
      (await expectSuccess({ ...base, postOperation: "floor" })).result
    ).toBe("-1500000000000000001");
    expect(
      (await expectSuccess({ ...base, postOperation: "ceil" })).result
    ).toBe("-1500000000000000000");
    expect(
      (await expectSuccess({ ...base, postOperation: "abs" })).result
    ).toBe("1500000000000000000.5");
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

  it("fails on division by zero and names the cause", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "divide",
      postOperand: "0",
    });
    expect(result.error).toContain("Division by zero");
    expect(result.divisionByZero).toBe(true);
  });

  it("fails on division by zero on the fixed-point path the same way", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "-9007199254740993",
      postOperation: "divide",
      postOperand: "0",
    });
    expect(result.error).toContain("Division by zero");
    expect(result.divisionByZero).toBe(true);
  });

  it("does not set divisionByZero on an ordinary failure", async () => {
    const result = await expectFailure({
      operation: "average",
      explicitValues: "abc",
    });
    expect(result.divisionByZero).toBeUndefined();
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

  it("fails on modulo by zero and names the cause", async () => {
    const result = await expectFailure({
      operation: "sum",
      explicitValues: "10",
      postOperation: "modulo",
      postOperand: "0",
    });
    expect(result.error).toContain("Modulo by zero");
    expect(result.divisionByZero).toBe(true);
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
