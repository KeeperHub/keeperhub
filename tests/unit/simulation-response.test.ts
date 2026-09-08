import { describe, expect, it } from "vitest";
import { simulationHttpStatus } from "@/app/api/execute/_lib/simulation-response";
import type { SimulateResult } from "@/lib/execute/simulate";

const BASE_RESULT = {
  status: "simulated",
  from: "0xaa0000000000000000000000000000000000aa00",
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
} as const;

describe("simulationHttpStatus", () => {
  it("returns 200 for a successful simulation", () => {
    const result: SimulateResult = {
      ...BASE_RESULT,
      success: true,
      gasEstimate: "21000",
      simulatedReturnValue: null,
      wouldRevert: false,
    };

    expect(simulationHttpStatus(result)).toBe(200);
  });

  it("returns 400 for a deterministic revert", () => {
    const result: SimulateResult = {
      ...BASE_RESULT,
      success: false,
      failureKind: "revert",
      wouldRevert: true,
      revertReason: "Unauthorized()",
      error: "Unauthorized()",
    };

    expect(simulationHttpStatus(result)).toBe(400);
  });

  it("returns 503 when simulation infrastructure is unavailable", () => {
    const result: SimulateResult = {
      ...BASE_RESULT,
      success: false,
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    };

    expect(simulationHttpStatus(result)).toBe(503);
  });
});
