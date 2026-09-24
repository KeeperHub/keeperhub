import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

vi.mock("@/lib/metrics/instrumentation/plugin", async () =>
  (await import("../mocks/step-mocks")).pluginMetricsPassthrough()
);

import {
  type FormatNumberCoreInput,
  type FormatNumberInput,
  formatNumberStep,
} from "@/plugins/math/steps/format-number";

type FormatSuccess = {
  success: true;
  formatted: string;
  value: string;
  magnitude: string;
  notation: string;
};

type FormatFailure = { success: false; error: string };

function makeInput(
  overrides: Partial<FormatNumberCoreInput>
): FormatNumberInput {
  return { value: "0", ...overrides } as FormatNumberInput;
}

async function run(
  overrides: Partial<FormatNumberCoreInput>
): Promise<FormatSuccess | FormatFailure> {
  return (await formatNumberStep(makeInput(overrides))) as
    | FormatSuccess
    | FormatFailure;
}

describe("math/format-number", () => {
  it("renders a wei amount as the compact string the duplicated helper produced", async () => {
    const result = (await run({
      value: "1230000000000000000000000",
      decimals: 18,
      unit: "SKY",
    })) as FormatSuccess;

    expect(result.formatted).toBe("1.23M SKY");
    expect(result.magnitude).toBe("M");
    expect(result.value).toBe("1230000");
  });

  it("uses the K magnitude below a million", async () => {
    const result = (await run({
      value: "456780000000000000000000",
      decimals: 18,
      unit: "SKY",
    })) as FormatSuccess;

    expect(result.formatted).toBe("456.78K SKY");
  });

  it("uses no suffix below a thousand", async () => {
    const result = (await run({
      value: "999000000000000000000",
      decimals: 18,
    })) as FormatSuccess;

    expect(result.formatted).toBe("999.00");
    expect(result.magnitude).toBe("");
  });

  it("scales to billions and trillions", async () => {
    const billions = (await run({ value: "2500000000" })) as FormatSuccess;
    const trillions = (await run({ value: "3100000000000" })) as FormatSuccess;

    expect(billions.formatted).toBe("2.50B");
    expect(trillions.formatted).toBe("3.10T");
  });

  it("groups thousands in plain notation", async () => {
    const result = (await run({
      value: "1230000000000000000000000",
      decimals: 18,
      notation: "plain",
    })) as FormatSuccess;

    expect(result.formatted).toBe("1,230,000.00");
  });

  it("keeps the sign when grouping a negative value", async () => {
    const result = (await run({
      value: "-1234567",
      notation: "plain",
      precision: 0,
    })) as FormatSuccess;

    expect(result.formatted).toBe("-1,234,567");
  });

  it("honours the requested decimal places", async () => {
    const result = (await run({
      value: "1234567",
      precision: 4,
    })) as FormatSuccess;

    expect(result.formatted).toBe("1.2345M");
  });

  it("keeps full precision in the value output regardless of rounding", async () => {
    const result = (await run({
      value: "1234567890123456789012345",
      decimals: 18,
    })) as FormatSuccess;

    expect(result.value).toBe("1234567.890123456789012345");
    expect(result.formatted).toBe("1.23M");
  });

  it("accepts a decimal input directly", async () => {
    const result = (await run({
      value: "1500.5",
      notation: "plain",
      precision: 1,
    })) as FormatSuccess;

    expect(result.formatted).toBe("1,500.5");
  });

  it("rejects a non-numeric value", async () => {
    const result = await run({ value: "1.2.3" });

    expect(result.success).toBe(false);
    expect((result as FormatFailure).error).toContain("Value must be a number");
  });
});
