import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", async () =>
  (await import("../mocks/step-mocks")).stepHandlerPassthrough()
);

import {
  type TreasuryRunwayInput,
  type TreasuryRunwayResult,
  treasuryRunwayStep,
} from "@/plugins/math/steps/treasury-runway";
import type {
  TreasuryRunwayCoreInput,
  TreasuryRunwaySuccess,
} from "@/plugins/math/steps/treasury-runway-core";

type TreasuryRunwayFailure = {
  success: false;
  error: string;
};

function makeInput(
  overrides: Partial<TreasuryRunwayCoreInput> = {}
): TreasuryRunwayInput {
  return {
    treasuryBalance: "100",
    incomingRate: "0",
    outgoingRate: "10",
    protectedReserve: "0",
    minimumRunwayDays: "10",
    ratePeriod: "day",
    ...overrides,
  } as TreasuryRunwayInput;
}

async function run(
  overrides: Partial<TreasuryRunwayCoreInput> = {}
): Promise<TreasuryRunwayResult> {
  return treasuryRunwayStep(makeInput(overrides));
}

describe("math/treasury-runway", () => {
  it("reports safe when the minimum runway is met exactly", async () => {
    const result = (await run()) as TreasuryRunwaySuccess;

    expect(result.status).toBe("safe");
    expect(result.runwayDays).toBe("10");
    expect(result.requiredRecoveryAmount).toBe("0");
    expect(result.reserveBreached).toBe(false);
    expect(result.ratePeriod).toBe("day");
  });

  it("reports warning and the required recovery below the target", async () => {
    const result = (await run({
      treasuryBalance: "50",
    })) as TreasuryRunwaySuccess;

    expect(result.status).toBe("warning");
    expect(result.runwayDays).toBe("5");
    expect(result.requiredRecoveryAmount).toBe("50");
  });

  it("reports critical when no reserve-adjusted runway remains", async () => {
    const result = (await run({
      treasuryBalance: "0",
    })) as TreasuryRunwaySuccess;

    expect(result.status).toBe("critical");
    expect(result.runwayDays).toBe("0");
    expect(result.requiredRecoveryAmount).toBe("100");
  });

  it("preserves a signed balance when the reserve is breached", async () => {
    const result = (await run({
      treasuryBalance: "80",
      protectedReserve: "100",
    })) as TreasuryRunwaySuccess;

    expect(result.reserveAdjustedBalance).toBe("-20");
    expect(result.reserveBreached).toBe(true);
    expect(result.requiredRecoveryAmount).toBe("120");
    expect(result.status).toBe("critical");
  });

  it("returns no finite runway when the treasury is not depleting", async () => {
    const zeroBurn = (await run({
      incomingRate: "10",
      outgoingRate: "10",
    })) as TreasuryRunwaySuccess;
    const growing = (await run({
      incomingRate: "20",
      outgoingRate: "10",
    })) as TreasuryRunwaySuccess;

    expect(zeroBurn.netBurnRate).toBe("0");
    expect(zeroBurn.runwayDays).toBeNull();
    expect(zeroBurn.requiredRecoveryAmount).toBe("0");
    expect(zeroBurn.status).toBe("safe");

    expect(growing.netBurnRate).toBe("-10");
    expect(growing.runwayDays).toBeNull();
    expect(growing.status).toBe("safe");
  });

  it("converts a monthly rate into runway days", async () => {
    const result = (await run({
      treasuryBalance: "530",
      incomingRate: "100",
      outgoingRate: "920",
      minimumRunwayDays: "30",
      ratePeriod: "month",
    })) as TreasuryRunwaySuccess;

    expect(result.netBurnRate).toBe("820");
    expect(result.runwayDays).toBe("19.390243");
    expect(result.requiredRecoveryAmount).toBe("290");
    expect(result.status).toBe("warning");
    expect(result.ratePeriod).toBe("month");
  });

  it("converts per-second rates using a fixed-duration period", async () => {
    const result = (await run({
      treasuryBalance: "86400",
      outgoingRate: "1",
      minimumRunwayDays: "2",
      ratePeriod: "second",
    })) as TreasuryRunwaySuccess;

    expect(result.runwayDays).toBe("1");
    expect(result.requiredRecoveryAmount).toBe("86400");
    expect(result.ratePeriod).toBe("second");
  });

  it("rounds only the final recovery amount upward", async () => {
    const integerPrecision = (await run({
      treasuryBalance: "0",
      outgoingRate: "100",
      minimumRunwayDays: "1",
      ratePeriod: "month",
    })) as TreasuryRunwaySuccess;

    const twoDecimalPrecision = (await run({
      treasuryBalance: "0.00",
      incomingRate: "0.00",
      outgoingRate: "100.00",
      protectedReserve: "0.00",
      minimumRunwayDays: "1",
      ratePeriod: "month",
    })) as TreasuryRunwaySuccess;

    expect(integerPrecision.requiredRecoveryAmount).toBe("4");
    expect(twoDecimalPrecision.requiredRecoveryAmount).toBe("3.34");
  });

  it("rejects an unsupported rate period", async () => {
    const result = (await run({
      ratePeriod: "quarter",
    })) as TreasuryRunwayFailure;

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate period must be one of");
  });

  it("rejects negative inputs and a zero minimum runway", async () => {
    const negative = (await run({
      treasuryBalance: "-1",
    })) as TreasuryRunwayFailure;
    const zeroMinimum = (await run({
      minimumRunwayDays: "0",
    })) as TreasuryRunwayFailure;

    expect(negative.success).toBe(false);
    expect(negative.error).toContain("Treasury balance must not be negative");
    expect(zeroMinimum.success).toBe(false);
    expect(zeroMinimum.error).toContain(
      "Minimum runway days must be greater than zero"
    );
  });
});
