import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockReadContract = vi.fn();

vi.mock("viem", () => ({
  createPublicClient: () => ({ readContract: mockReadContract }),
  http: () => ({}),
}));

vi.mock("@/lib/web3/chainlink-feeds", () => ({
  AGGREGATOR_V3_ABI: [],
  getEthUsdFeedAddress: (chainId: number) => {
    const feeds: Record<number, string> = {
      1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    };
    return feeds[chainId];
  },
}));

const mockInsertValues = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: (...args: unknown[]) => mockInsertValues(...args),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  gasCreditAllocations: {
    organizationId: "organizationId",
    periodStart: "periodStart",
    allocatedCents: "allocatedCents",
  },
  gasCreditUsage: {
    organizationId: "organizationId",
    gasCostMicroUsd: "gasCostMicroUsd",
    createdAt: "createdAt",
    chainId: "chainId",
    txHash: "txHash",
    executionId: "executionId",
    gasUsed: "gasUsed",
    gasPriceWei: "gasPriceWei",
    gasCostWei: "gasCostWei",
    ethPriceUsd: "ethPriceUsd",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  gte: () => ({}),
  sql: () => ({}),
}));

vi.mock("@/lib/billing/plans-server", () => ({
  getOrgSubscription: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/billing/plans", () => ({
  getPlanLimits: vi.fn().mockReturnValue({
    gasCreditsCents: 500,
    maxExecutionsPerMonth: 5000,
  }),
  parsePlanName: vi.fn().mockReturnValue("free"),
}));

vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: vi.fn().mockReturnValue(true),
}));

import { isBillingEnabled } from "@/lib/billing/feature-flag";
import {
  checkGasCredits,
  getEthPriceUsd,
  getGasCreditCapCents,
  recordGasUsage,
} from "@/lib/billing/gas-credits";

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertValues.mockResolvedValue(undefined);
  mockReadContract.mockReset();
  process.env.GAS_CREDITS_FREE_CENTS = undefined;
  process.env.GAS_CREDITS_PRO_CENTS = undefined;
});

describe("getGasCreditCapCents", () => {
  it("returns plan default when env var is not set", () => {
    expect(getGasCreditCapCents("free")).toBe(500);
  });

  it("uses env var override when set", () => {
    process.env.GAS_CREDITS_FREE_CENTS = "1000";
    expect(getGasCreditCapCents("free")).toBe(1000);
  });

  it("ignores invalid env var values", () => {
    process.env.GAS_CREDITS_FREE_CENTS = "not-a-number";
    expect(getGasCreditCapCents("free")).toBe(500);
  });

  it("ignores negative env var values", () => {
    process.env.GAS_CREDITS_FREE_CENTS = "-100";
    expect(getGasCreditCapCents("free")).toBe(500);
  });

  it("accepts zero as a valid override", () => {
    process.env.GAS_CREDITS_FREE_CENTS = "0";
    expect(getGasCreditCapCents("free")).toBe(0);
  });
});

describe("checkGasCredits", () => {
  it("allows unlimited when billing is disabled", async () => {
    vi.mocked(isBillingEnabled).mockReturnValue(false);

    const result = await checkGasCredits("org_1");

    expect(result.allowed).toBe(true);
    if (result.allowed) {
      expect(result.remainingCents).toBe(Number.MAX_SAFE_INTEGER);
    }
  });
});

describe("recordGasUsage", () => {
  it("computes gas cost and inserts record", async () => {
    await recordGasUsage({
      organizationId: "org_1",
      chainId: 11_155_111,
      txHash: "0xabc",
      executionId: "exec_1",
      gasUsed: BigInt(21_000),
      gasPrice: BigInt(1_000_000_000),
      ethPriceUsd: 2000,
    });

    expect(mockInsertValues).toHaveBeenCalledOnce();
  });
});

describe("getEthPriceUsd", () => {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  it("reads price from Chainlink oracle", async () => {
    mockReadContract.mockResolvedValue([
      BigInt(1),
      BigInt(250_000_000_000),
      nowSeconds,
      nowSeconds,
      BigInt(1),
    ]);

    const price = await getEthPriceUsd("https://rpc.example.com", 1);

    expect(price).toBe(2500);
    expect(mockReadContract).toHaveBeenCalledOnce();
  });

  it("returns fallback when chain has no feed address", async () => {
    const price = await getEthPriceUsd("https://rpc.example.com", 999);

    expect(price).toBe(3000);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns fallback when oracle call fails", async () => {
    mockReadContract.mockRejectedValue(new Error("RPC timeout"));

    const price = await getEthPriceUsd("https://rpc.example.com", 8453);

    expect(price).toBe(3000);
  });

  it("rejects stale oracle prices", async () => {
    const twoHoursAgo = BigInt(Math.floor(Date.now() / 1000) - 7200);

    mockReadContract.mockResolvedValue([
      BigInt(1),
      BigInt(250_000_000_000),
      twoHoursAgo,
      twoHoursAgo,
      BigInt(1),
    ]);

    const price = await getEthPriceUsd("https://rpc.example.com", 8453);

    expect(price).toBe(3000);
  });
});
