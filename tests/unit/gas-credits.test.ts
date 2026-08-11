import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockReadContract = vi.fn();

vi.mock("viem", () => ({
  createPublicClient: () => ({ readContract: mockReadContract }),
  http: () => ({}),
}));

vi.mock("@/lib/web3/chainlink-feeds", () => ({
  AGGREGATOR_V3_ABI: [],
  getGasTokenUsdFeedAddress: (chainId: number) => {
    const feeds: Record<number, string> = {
      1: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
      8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    };
    return feeds[chainId];
  },
}));

const mockOnConflictDoNothing = vi.fn().mockResolvedValue(undefined);
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const mockSelectLimit = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: (...args: unknown[]) => mockSelectLimit(...args),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoNothing: (...args: unknown[]) =>
          mockOnConflictDoNothing(...args),
        onConflictDoUpdate: (...args: unknown[]) =>
          mockOnConflictDoUpdate(...args),
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
  getGasCreditBalance,
  getGasCreditCapCents,
  getGasCreditCaps,
  getGasTokenPriceUsd,
  recordGasUsage,
} from "@/lib/billing/gas-credits";
import type { PlanLimits } from "@/lib/billing/plans";
import { getOrgSubscription } from "@/lib/billing/plans-server";

beforeEach(() => {
  vi.clearAllMocks();
  mockOnConflictDoNothing.mockResolvedValue(undefined);
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockSelectLimit.mockResolvedValue([]);
  mockReadContract.mockReset();
  // Clear ALL per-plan gas-credit env overrides (not just free/pro) so caps
  // fall through to the mocked plan defaults. A developer .env that sets
  // GAS_CREDITS_BUSINESS_CENTS / GAS_CREDITS_ENTERPRISE_CENTS otherwise leaks
  // real values into getGasCreditCaps and breaks the assertions below.
  process.env.GAS_CREDITS_FREE_CENTS = undefined;
  process.env.GAS_CREDITS_PRO_CENTS = undefined;
  process.env.GAS_CREDITS_BUSINESS_CENTS = undefined;
  process.env.GAS_CREDITS_ENTERPRISE_CENTS = undefined;
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

    expect(mockOnConflictDoNothing).toHaveBeenCalledOnce();
  });
});

describe("getGasTokenPriceUsd", () => {
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  it("reads price from Chainlink oracle", async () => {
    mockReadContract.mockResolvedValue([
      BigInt(1),
      BigInt(250_000_000_000),
      nowSeconds,
      nowSeconds,
      BigInt(1),
    ]);

    const price = await getGasTokenPriceUsd("https://rpc.example.com", 1);

    expect(price).toBe(2500);
    expect(mockReadContract).toHaveBeenCalledOnce();
  });

  it("returns fallback when chain has no feed address", async () => {
    const price = await getGasTokenPriceUsd("https://rpc.example.com", 999);

    expect(price).toBe(3000);
    expect(mockReadContract).not.toHaveBeenCalled();
  });

  it("returns fallback when oracle call fails", async () => {
    mockReadContract.mockRejectedValue(new Error("RPC timeout"));

    const price = await getGasTokenPriceUsd("https://rpc.example.com", 8453);

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

    const price = await getGasTokenPriceUsd("https://rpc.example.com", 8453);

    expect(price).toBe(3000);
  });
});

describe("getGasCreditCapCents per-org overrides", () => {
  it("uses the per-org override when set (enterprise custom cap)", () => {
    expect(
      getGasCreditCapCents("enterprise", { gasCreditsCents: 25_000 })
    ).toBe(25_000);
  });

  it("override wins over both env var and plan default", () => {
    process.env.GAS_CREDITS_PRO_CENTS = "2000";
    expect(getGasCreditCapCents("pro", { gasCreditsCents: 1234 })).toBe(1234);
  });

  it("ignores a negative override and falls back to the plan default", () => {
    expect(getGasCreditCapCents("pro", { gasCreditsCents: -5 })).toBe(500);
  });

  it("accepts a zero override", () => {
    expect(getGasCreditCapCents("pro", { gasCreditsCents: 0 })).toBe(0);
  });

  it("falls back to env/default when no override is provided", () => {
    expect(getGasCreditCapCents("pro", null)).toBe(500);
  });
});

describe("getGasCreditCaps", () => {
  it("returns a cap for every plan from the shared cap function", () => {
    expect(getGasCreditCaps()).toEqual({
      free: 500,
      pro: 500,
      business: 500,
      enterprise: 500,
    });
  });

  it("reflects per-plan env overrides", () => {
    process.env.GAS_CREDITS_PRO_CENTS = "2000";
    expect(getGasCreditCaps().pro).toBe(2000);
  });
});

describe("getGasCreditBalance", () => {
  it("threads the org's plan_overrides into the allocation cap", async () => {
    vi.mocked(getOrgSubscription).mockResolvedValue({
      plan: "enterprise",
      planOverrides: { gasCreditsCents: 7777 },
      currentPeriodStart: new Date(),
    } as unknown as Awaited<ReturnType<typeof getOrgSubscription>>);

    const balance = await getGasCreditBalance("org_override");

    expect(balance.totalCents).toBe(7777);
    expect(balance.remainingCents).toBe(7777);
  });
});

describe("gas credit allocation self-heal", () => {
  const mockSubscription = (
    plan: string,
    overrides: Partial<PlanLimits> | null
  ): void => {
    vi.mocked(getOrgSubscription).mockResolvedValue({
      plan,
      planOverrides: overrides,
      currentPeriodStart: new Date(),
    } as unknown as Awaited<ReturnType<typeof getOrgSubscription>>);
  };

  it("upserts the period allocation with a raise-only guard at the derived cap", async () => {
    mockSubscription("enterprise", { gasCreditsCents: 7777 });

    await getGasCreditBalance("org_heal");

    expect(mockOnConflictDoUpdate).toHaveBeenCalledOnce();
    const [arg] = mockOnConflictDoUpdate.mock.calls[0] as [
      {
        target: unknown[];
        set: { allocatedCents: number };
        setWhere: unknown;
      },
    ];
    expect(arg.set.allocatedCents).toBe(7777);
    expect(arg.target).toHaveLength(2);
    // The raise-only predicate (allocated_cents < cap) is enforced in SQL via
    // setWhere; this asserts the guard is wired, not the DB-side comparison.
    expect(arg.setWhere).toBeDefined();
  });

  it("returns the persisted allocation rather than a lower derived cap (no mid-period clawback)", async () => {
    // A higher allocation is already snapshotted for this period...
    mockSelectLimit.mockResolvedValue([{ allocatedCents: 10_000 }]);
    // ...while the org now resolves to a lower plan cap (free default = 500).
    mockSubscription("free", null);

    const balance = await getGasCreditBalance("org_downgrade");

    expect(balance.totalCents).toBe(10_000);
  });
});
