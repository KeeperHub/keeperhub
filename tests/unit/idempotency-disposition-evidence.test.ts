import { describe, expect, it } from "vitest";
import { dispositionForExecutionOutcome } from "@/lib/idempotency-disposition";

describe("idempotency execution evidence", () => {
  it("holds a hashless failure when there is no evidence either way", () => {
    expect(dispositionForExecutionOutcome("failed", {})).toBe("failed");
  });

  it("releases a definite hashless pre-broadcast failure", () => {
    expect(
      dispositionForExecutionOutcome("failed", { broadcastAttempted: false })
    ).toBe("release");
  });

  it("releases a classified EVM preflight/staticCall rejection", () => {
    expect(
      dispositionForExecutionOutcome("failed", {
        rejection: { kind: "string-revert", reason: "LK: not yet due" },
      })
    ).toBe("release");
  });

  it("holds when broadcast evidence conflicts with a decoded rejection", () => {
    expect(
      dispositionForExecutionOutcome("failed", {
        broadcastAttempted: true,
        rejection: { kind: "string-revert", reason: "late provider error" },
      })
    ).toBe("failed");
  });

  it("holds a hashless failure once broadcast was attempted", () => {
    expect(
      dispositionForExecutionOutcome("failed", { broadcastAttempted: true })
    ).toBe("failed");
  });

  it("holds a sponsored submission whose hash is not available yet", () => {
    expect(dispositionForExecutionOutcome("failed", { sponsored: true })).toBe(
      "failed"
    );
  });

  it("releases a sponsored failure explicitly known to be pre-broadcast", () => {
    expect(
      dispositionForExecutionOutcome("failed", {
        sponsored: true,
        broadcastAttempted: false,
      })
    ).toBe("release");
  });

  it("releases a conclusive sponsored failure once its hash is known", () => {
    expect(
      dispositionForExecutionOutcome("failed", {
        sponsored: true,
        transactionHash: "0xdeadbeef",
      })
    ).toBe("release");
  });

  it("holds every unconfirmed outcome regardless of evidence", () => {
    expect(
      dispositionForExecutionOutcome("unconfirmed", {
        transactionHash: "0xmaybe",
        broadcastAttempted: false,
      })
    ).toBe("failed");
  });
});
