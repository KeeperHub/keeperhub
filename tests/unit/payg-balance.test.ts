import { beforeEach, describe, expect, it, vi } from "vitest";

const balanceOf = vi.fn();
vi.mock("ethers", () => ({
  Contract: class {
    balanceOf = (...a: unknown[]) => balanceOf(...a);
  },
}));

const rpcEvm = vi.fn();
vi.mock("@/lib/rpc/engine", async () => ({
  ...(await vi.importActual("@/lib/rpc/engine/types")),
  ...(await vi.importActual("@/lib/rpc/engine/scope")),
  rpc: { evm: (...a: unknown[]) => rpcEvm(...a) },
}));
vi.mock("@/lib/agentic-wallet/constants", () => ({
  USDC_BASE_ADDRESS: "0xusdc",
}));

import { hasSufficientUsdc } from "@/lib/billing/payg/balance";
import { platformScope } from "@/lib/rpc/engine/scope";
import { PlatformRpcPurpose } from "@/lib/rpc/engine/types";

const PRICE = BigInt(10_000);
const BASE = { payerAddress: "0xabc", amountRaw: PRICE, chainId: 8453 };

beforeEach(() => {
  vi.clearAllMocks();
  rpcEvm.mockResolvedValue({
    manager: {
      executeWithFailover: (op: (provider: unknown) => unknown) => op({}),
    },
  });
});

describe("hasSufficientUsdc", () => {
  it("is true when the balance covers the price", async () => {
    balanceOf.mockResolvedValue(PRICE);

    expect(await hasSufficientUsdc(BASE)).toBe(true);
  });

  it("reads the balance on KeeperHub's billing route for the chain", async () => {
    balanceOf.mockResolvedValue(PRICE);

    await hasSufficientUsdc(BASE);

    expect(rpcEvm).toHaveBeenCalledWith(
      platformScope(PlatformRpcPurpose.BILLING),
      BASE.chainId
    );
  });

  it("is unknown when no route can be resolved", async () => {
    rpcEvm.mockRejectedValue(new Error("chain disabled"));

    expect(await hasSufficientUsdc(BASE)).toBeNull();
  });

  it("is false on an empty wallet", async () => {
    balanceOf.mockResolvedValue(BigInt(0));

    expect(await hasSufficientUsdc(BASE)).toBe(false);
  });

  it("is false one unit short of the price", async () => {
    balanceOf.mockResolvedValue(PRICE - BigInt(1));

    expect(await hasSufficientUsdc(BASE)).toBe(false);
  });

  it("is unknown when the read throws, so the caller still settles", async () => {
    balanceOf.mockRejectedValue(new Error("rpc down"));

    expect(await hasSufficientUsdc(BASE)).toBeNull();
  });

  it("is unknown on a chain with no configured USDC address", async () => {
    expect(await hasSufficientUsdc({ ...BASE, chainId: 1 })).toBeNull();
    expect(balanceOf).not.toHaveBeenCalled();
  });
});
