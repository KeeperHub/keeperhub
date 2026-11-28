import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockLogSystemWarn } = vi.hoisted(() => ({
  mockLogSystemWarn: vi.fn(),
}));
vi.mock("@/lib/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/logging")>()),
  logSystemWarn: mockLogSystemWarn,
}));

import { maxFeeCapFailure } from "@/lib/web3/max-fee-cap-failure";
import { maxFeeBelowBaseFeeError } from "@/lib/web3/max-fee-check";

type Manager = Parameters<typeof maxFeeBelowBaseFeeError>[0];

// eth_feeHistory with blockCount 1 returns [latest, next] base fees.
function managerWithFeeHistory(history: unknown): {
  manager: Manager;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue(history);
  const manager = {
    executeWithFailover: vi.fn(
      (operation: (provider: { send: typeof send }) => Promise<unknown>) =>
        operation({ send })
    ),
  } as unknown as Manager;
  return { manager, send };
}

describe("maxFeeBelowBaseFeeError", () => {
  it("asks the node for the next block's base fee", async () => {
    const { manager, send } = managerWithFeeHistory({
      baseFeePerGas: ["0x2540be400", "0x2540be400"],
    });
    await maxFeeBelowBaseFeeError(manager, BigInt(10e9));
    expect(send).toHaveBeenCalledWith("eth_feeHistory", ["0x1", "latest", []]);
  });

  it("passes a cap at or above the next base fee", async () => {
    const { manager } = managerWithFeeHistory({
      baseFeePerGas: ["0x1", "0x2540be400"],
    });
    expect(
      await maxFeeBelowBaseFeeError(manager, BigInt(10e9))
    ).toBeUndefined();
  });

  it("refuses a cap below the next base fee even when the latest one is lower", async () => {
    const { manager } = managerWithFeeHistory({
      baseFeePerGas: ["0x2540be400", "0x2cb417800"],
    });
    expect(await maxFeeBelowBaseFeeError(manager, BigInt(11e9))).toMatch(
      /Max fee 11\.0 gwei is below the next block's base fee of 12\.0 gwei/
    );
  });

  it("passes on a chain that reports no base fee", async () => {
    const { manager } = managerWithFeeHistory({ baseFeePerGas: [] });
    expect(await maxFeeBelowBaseFeeError(manager, BigInt(1))).toBeUndefined();
  });

  it("does not block the send when the base fee cannot be read", async () => {
    const manager = {
      executeWithFailover: vi.fn().mockRejectedValue(new Error("rpc down")),
    } as unknown as Manager;
    expect(await maxFeeBelowBaseFeeError(manager, BigInt(1))).toBeUndefined();
    expect(mockLogSystemWarn).toHaveBeenCalled();
  });
});

describe("maxFeeCapFailure", () => {
  it("fails a cap below the next base fee as a network failure, and passes one above", async () => {
    const { manager } = managerWithFeeHistory({
      baseFeePerGas: ["0x2540be400", "0x2cb417800"],
    });
    expect(await maxFeeCapFailure(manager, BigInt(11e9))).toEqual({
      success: false,
      error: expect.stringContaining("Max fee 11.0 gwei is below"),
      errorClass: "external",
    });
    expect(await maxFeeCapFailure(manager, BigInt(12e9))).toBeUndefined();
  });
});
