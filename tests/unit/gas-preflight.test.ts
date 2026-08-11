import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetRedis } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(() => null),
}));

vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));

vi.mock("@/lib/execute/native-balance", () => ({
  getNativeSymbol: () => Promise.resolve("ETH"),
  describeNativeShortfall: (input: { balance: bigint; required: bigint }) => ({
    message: `Insufficient ETH balance. Have: ${input.balance}, Need: ${input.required}`,
  }),
}));

import { SIGNER_MODE } from "@/lib/safe/signer-resolver";
import {
  preflightGasBalance,
  resolveFundingHolder,
} from "@/lib/web3/gas-preflight";

const HOLDER = "0x7a459d6b50823f4a6f870a90504d12d082b9b28b";
const GAS_PRICE = BigInt(1_000_000_000);
// MIN_TX_GAS_UNITS (21000) * GAS_PRICE
const MIN_COST = BigInt(21_000) * GAS_PRICE;

function rpcManagerReturning(balance: bigint) {
  return {
    executeWithFailover: (fn: (p: unknown) => unknown) =>
      Promise.resolve(
        fn({
          getBalance: () => Promise.resolve(balance),
          getFeeData: () => Promise.resolve({ maxFeePerGas: GAS_PRICE }),
        })
      ),
  } as never;
}

describe("preflightGasBalance", () => {
  beforeEach(() => {
    mockGetRedis.mockReturnValue(null);
  });

  it("rejects an empty wallet before it can reach the nonce lock", async () => {
    const result = await preflightGasBalance({
      rpcManager: rpcManagerReturning(BigInt(0)),
      chainId: 16_602,
      holderAddress: HOLDER,
    });

    expect(result.affordable).toBe(false);
  });

  it("rejects dust that cannot cover the cheapest possible transaction", async () => {
    const result = await preflightGasBalance({
      rpcManager: rpcManagerReturning(MIN_COST - BigInt(1)),
      chainId: 16_602,
      holderAddress: HOLDER,
    });

    expect(result.affordable).toBe(false);
  });

  it("allows a holder that covers the gas floor", async () => {
    const result = await preflightGasBalance({
      rpcManager: rpcManagerReturning(MIN_COST),
      chainId: 16_602,
      holderAddress: HOLDER,
    });

    expect(result.affordable).toBe(true);
  });

  it("counts the payable value on top of gas", async () => {
    const result = await preflightGasBalance({
      rpcManager: rpcManagerReturning(MIN_COST),
      chainId: 16_602,
      holderAddress: HOLDER,
      valueWei: BigInt(1),
    });

    expect(result.affordable).toBe(false);
  });

  it("fails open when the chain read throws, so a provider blip is not a rejection", async () => {
    const rpcManager = {
      executeWithFailover: () => Promise.reject(new Error("rpc down")),
    } as never;

    const result = await preflightGasBalance({
      rpcManager,
      chainId: 16_602,
      holderAddress: HOLDER,
    });

    expect(result.affordable).toBe(true);
  });
});

describe("resolveFundingHolder", () => {
  it("uses the EOA in eoa mode", () => {
    expect(
      resolveFundingHolder(
        { kind: SIGNER_MODE.EOA, ownerAddress: "0xowner" },
        HOLDER
      )
    ).toBe(HOLDER);
  });

  it("uses the Safe address in safe mode, since gas comes from the Safe", () => {
    expect(
      resolveFundingHolder(
        {
          kind: SIGNER_MODE.SAFE,
          ownerAddress: "0xowner",
          safeAddress: "0xsafe",
          safeWalletId: "sw_1",
        },
        HOLDER
      )
    ).toBe("0xsafe");
  });
});
