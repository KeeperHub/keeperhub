import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockLogSystemWarn } = vi.hoisted(() => ({
  mockLogSystemWarn: vi.fn(),
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemWarn: mockLogSystemWarn,
}));

import { maxFeeBelowBaseFeeError } from "@/lib/web3/max-fee-check";

type Manager = Parameters<typeof maxFeeBelowBaseFeeError>[0];

function managerWithBaseFee(baseFee: bigint | null): Manager {
  return {
    executeWithFailover: vi.fn().mockResolvedValue({ baseFeePerGas: baseFee }),
  } as unknown as Manager;
}

describe("maxFeeBelowBaseFeeError", () => {
  it("passes a cap at or above the base fee", async () => {
    expect(
      await maxFeeBelowBaseFeeError(
        managerWithBaseFee(BigInt(10e9)),
        BigInt(10e9)
      )
    ).toBeUndefined();
  });

  it("refuses a cap below the base fee", async () => {
    const error = await maxFeeBelowBaseFeeError(
      managerWithBaseFee(BigInt(12e9)),
      BigInt(10e9)
    );
    expect(error).toMatch(
      /Max fee 10\.0 gwei is below the current base fee of 12\.0 gwei/
    );
  });

  it("passes on a chain without a base fee", async () => {
    expect(
      await maxFeeBelowBaseFeeError(managerWithBaseFee(null), BigInt(1))
    ).toBeUndefined();
  });

  it("does not block the send when the base fee cannot be read", async () => {
    const manager = {
      executeWithFailover: vi.fn().mockRejectedValue(new Error("rpc down")),
    } as unknown as Manager;
    expect(await maxFeeBelowBaseFeeError(manager, BigInt(1))).toBeUndefined();
    expect(mockLogSystemWarn).toHaveBeenCalled();
  });
});
