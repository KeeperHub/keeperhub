import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  let insertResult: unknown[] = [];

  const nextRows = (): Promise<unknown[]> =>
    Promise.resolve(selectQueue.shift() ?? []);

  // Two shapes of drizzle chain are used here. The owner lookup joins and is
  // awaited straight off where(); the org-name lookup does not join and ends in
  // limit(). Branching on innerJoin keeps both off one scripted queue.
  const joined = { where: nextRows };
  const chain = {
    from: () => chain,
    innerJoin: () => joined,
    where: () => ({ limit: nextRows }),
  };

  let priceRaw = BigInt(10_000);
  let treasury: string | null = "0x00000000000000000000000000000000000000t1";

  return {
    selectQueue,
    setInsertResult: (rows: unknown[]): void => {
      insertResult = rows;
    },
    paygPriceRaw: (): bigint => priceRaw,
    paygTreasury: (): string | null => treasury,
    setPaygConfigured: (configured: boolean): void => {
      priceRaw = configured ? BigInt(10_000) : BigInt(0);
      treasury = configured
        ? "0x00000000000000000000000000000000000000t1"
        : null;
    },
    sendExecutionQuotaEmail: vi.fn(async () => true),
    redisSet: vi.fn(async (): Promise<string | null> => "OK"),
    db: {
      select: () => chain,
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(insertResult),
          }),
        }),
      }),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: mocks.db }));
vi.mock("@/lib/db/schema", () => ({
  executionQuotaNotifications: {
    id: {},
    organizationId: {},
    periodStart: {},
    threshold: {},
  },
  member: {},
  organization: {},
  users: {},
}));
vi.mock("@/lib/email", () => ({
  sendExecutionQuotaEmail: mocks.sendExecutionQuotaEmail,
}));
vi.mock("@/lib/billing/payg/config-store", () => ({
  getPaygSettings: async () => ({
    dailyCapRaw: "5000000",
    periodCapRaw: "50000000",
    chainId: 8453,
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    customized: false,
  }),
}));
vi.mock("@/lib/billing/payg/pricing", () => ({
  getPaygExecutionPriceRaw: () => mocks.paygPriceRaw(),
}));
vi.mock("@/lib/billing/payg/treasury", () => ({
  getPaygTreasuryOrNull: () => mocks.paygTreasury(),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () => ({ set: mocks.redisSet }),
}));

import type { QuotaStatus } from "@/lib/billing/quota-threshold";
import {
  maybeNotifyQuotaThreshold,
  notifyOrgQuotaThreshold,
} from "@/lib/notifications/quota-threshold";

const APP_URL = "https://app.example.com";

function quotaStatus(overrides: Partial<QuotaStatus> = {}): QuotaStatus {
  return {
    organizationId: "org_1",
    plan: "free",
    planLabel: "Free",
    used: 4000,
    limit: 5000,
    includedLimit: 5000,
    debtExecutions: 0,
    usagePercent: 80,
    threshold: 80,
    periodStart: new Date("2026-06-01T00:00:00.000Z"),
    periodEnd: new Date("2026-07-01T00:00:00.000Z"),
    paygEligible: true,
    overageRatePerThousand: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.selectQueue.length = 0;
  mocks.sendExecutionQuotaEmail.mockClear();
  mocks.setInsertResult([]);
  mocks.setPaygConfigured(true);
  mocks.redisSet.mockClear();
  mocks.redisSet.mockResolvedValue("OK");
});

describe("notifyOrgQuotaThreshold", () => {
  it("emails the org owner and reports the send", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result).toEqual({
      organizationId: "org_1",
      threshold: 80,
      usagePercent: 80,
      recipients: 1,
    });
    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "owner@example.com",
        orgName: "Acme",
        threshold: 80,
        used: 4000,
        limit: 5000,
        usagePercent: 80,
      })
    );
  });

  it("deep-links to the org's own settings pages", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        plansUrl: "https://app.example.com/settings/org_1/plans",
        billingUrl: "https://app.example.com/settings/org_1/billing",
      })
    );
  });

  it("quotes the real pay-as-you-go price and caps for a free org", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        payg: {
          priceUsdc: "0.010000",
          dailyCapUsdc: "5.000000",
          periodCapUsdc: "50.000000",
          chainName: "Base",
          assetUrl:
            "https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
      })
    );
  });

  it("omits top-up guidance when pay-as-you-go cannot charge", async () => {
    // No price or no treasury means nothing would ever be debited, so telling
    // the owner to fund a wallet would be wrong.
    mocks.setPaygConfigured(false);
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({ payg: null })
    );
  });

  it("sends no top-up block to an overage plan, and passes its rate", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(
      quotaStatus({
        plan: "pro",
        planLabel: "Pro",
        paygEligible: false,
        overageRatePerThousand: 2,
        used: 25_000,
        limit: 25_000,
        includedLimit: 25_000,
        usagePercent: 100,
        threshold: 100,
      }),
      APP_URL
    );

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({ payg: null, overageRatePerThousand: 2 })
    );
  });

  it("sends nothing when the threshold row already exists", async () => {
    mocks.selectQueue.push([
      {
        email: "owner@example.com",
        emailVerified: true,
        stepUpEmail: null,
        name: "Owner",
      },
    ]);
    // No row returned by the insert: another run already claimed this threshold.
    mocks.setInsertResult([]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result).toBeNull();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("does not claim when the org has no reachable owner", async () => {
    // A wallet owner with no enrolled step-up email is unreachable.
    mocks.selectQueue.push([
      {
        email: "0xabc@wallet.keeperhub.com",
        emailVerified: true,
        stepUpEmail: null,
        name: "0xabc",
      },
    ]);
    mocks.setInsertResult([{ id: "notif_1" }]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result).toBeNull();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("mails a wallet owner at their enrolled step-up email", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "0xabc@wallet.keeperhub.com",
          emailVerified: true,
          stepUpEmail: "real@example.com",
          name: "0xabc",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "real@example.com" })
    );
  });

  it("is a no-op below every threshold", async () => {
    const result = await notifyOrgQuotaThreshold(
      quotaStatus({ threshold: null, usagePercent: 42, used: 2100 }),
      APP_URL
    );

    expect(result).toBeNull();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("deduplicates repeated owner addresses into one send", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result?.recipients).toBe(1);
    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledTimes(1);
  });
});

describe("maybeNotifyQuotaThreshold", () => {
  it("does nothing below every threshold", async () => {
    maybeNotifyQuotaThreshold({
      organizationId: "org_1",
      plan: "free",
      tier: null,
      planOverrides: null,
      used: 100,
      debtExecutions: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.redisSet).not.toHaveBeenCalled();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("claims a cooldown that expires with the quota month", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "owner@example.com",
          emailVerified: true,
          stepUpEmail: null,
          name: "Owner",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    maybeNotifyQuotaThreshold({
      organizationId: "org_1",
      plan: "free",
      tier: null,
      planOverrides: null,
      used: 4000,
      debtExecutions: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.redisSet).toHaveBeenCalledWith(
      expect.stringContaining("quota-notify:org_1:"),
      "1",
      "EX",
      expect.any(Number),
      "NX"
    );
    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledTimes(1);
  });

  it("stays silent when another caller holds the cooldown", async () => {
    // This is the case that runs on every execution for the rest of the month:
    // no DB claim attempt and no send.
    mocks.redisSet.mockResolvedValueOnce(null);

    maybeNotifyQuotaThreshold({
      organizationId: "org_1",
      plan: "free",
      tier: null,
      planOverrides: null,
      used: 4000,
      debtExecutions: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });
});

describe("only reachable, user supplied addresses are mailed", () => {
  it("skips an unverified login email", async () => {
    mocks.selectQueue.push([
      {
        email: "unverified@example.com",
        emailVerified: false,
        stepUpEmail: null,
        name: "Someone",
      },
    ]);
    mocks.setInsertResult([{ id: "notif_1" }]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result).toBeNull();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("skips an anonymous account's placeholder address", async () => {
    mocks.selectQueue.push([
      {
        email: "temp-123@http://localhost",
        emailVerified: true,
        stepUpEmail: null,
        name: "Anonymous",
      },
    ]);
    mocks.setInsertResult([{ id: "notif_1" }]);

    const result = await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(result).toBeNull();
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalled();
  });

  it("never mails the synthetic wallet address itself", async () => {
    mocks.selectQueue.push(
      [
        {
          email: "0xabc@wallet.keeperhub.com",
          emailVerified: true,
          stepUpEmail: "enrolled@example.com",
          name: "0xabc",
        },
      ],
      [{ name: "Acme" }]
    );
    mocks.setInsertResult([{ id: "notif_1" }]);

    await notifyOrgQuotaThreshold(quotaStatus(), APP_URL);

    expect(mocks.sendExecutionQuotaEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "enrolled@example.com" })
    );
    expect(mocks.sendExecutionQuotaEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.stringContaining("wallet.keeperhub.com"),
      })
    );
  });
});
