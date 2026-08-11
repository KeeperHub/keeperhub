import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Auth + gating: authenticated org owner on the free plan, PAYG available.
vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: () => true,
}));
vi.mock("@/lib/billing/require-org-owner", () => ({
  requireOrgOwner: vi.fn(async () => ({
    orgId: "org_1",
    userId: "user_1",
    email: "owner@example.com",
  })),
}));
vi.mock("@/lib/billing/plans-server", () => ({
  getOrgPlan: vi.fn(async () => "free"),
}));
vi.mock("@/lib/billing/payg/treasury", () => ({
  getPaygTreasuryOrNull: () => "0x000000000000000000000000000000000000dEaD",
}));
vi.mock("@/lib/billing/payg/pricing", () => ({
  getPaygExecutionPriceRaw: () => BigInt(10_000),
}));

// Capture what the route persists so we can assert the parsed raw amounts.
const upsertPaygConfig = vi.fn(async (..._a: unknown[]) => undefined);
vi.mock("@/lib/billing/payg/config-store", () => ({
  upsertPaygConfig: (...a: unknown[]) => upsertPaygConfig(...a),
  getPaygSettings: vi.fn(async () => ({
    chainId: 8453,
    dailyCapRaw: "0",
    periodCapRaw: "0",
    startedAt: new Date("2026-01-01T00:00:00Z"),
    customized: true,
  })),
}));
vi.mock("@/lib/billing/payg/usage", () => ({
  getCurrentPaygUsage: vi.fn(async () => ({
    startedAt: new Date("2026-01-01T00:00:00Z"),
    periodStart: new Date("2026-01-01T00:00:00Z"),
    periodEnd: new Date("2026-02-01T00:00:00Z"),
    periodExecutions: 0,
    periodSpentRaw: BigInt(0),
    dailySpentRaw: BigInt(0),
    dailyCapRaw: BigInt(0),
    periodCapRaw: BigInt(0),
    chainId: 8453,
  })),
}));
vi.mock("@/lib/middleware/auth-helpers", () => ({
  resolveOrganizationId: vi.fn(async () => ({ organizationId: "org_1" })),
}));
vi.mock("@/lib/security/audit-log", () => ({
  buildAuditMetadata: () => ({}),
  recordAuditEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { BILLING: "billing" },
  logSystemError: vi.fn(),
}));

import { POST } from "@/app/api/billing/payg/route";

function postCaps(body: unknown): Request {
  return new Request("http://localhost:3000/api/billing/payg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/billing/payg (spend caps)", () => {
  it("accepts caps typed with a leading dot (.5) and persists the raw amounts", async () => {
    const res = await POST(
      postCaps({ dailyCapUsdc: ".5", periodCapUsdc: "1" })
    );

    expect(res.status).toBe(200);
    expect(upsertPaygConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org_1",
        dailyCapRaw: "500000",
        periodCapRaw: "1000000",
      })
    );
  });

  it("persists an explicit 0 cap as 0 rather than dropping it", async () => {
    const res = await POST(postCaps({ dailyCapUsdc: "0", periodCapUsdc: "0" }));

    expect(res.status).toBe(200);
    expect(upsertPaygConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dailyCapRaw: "0", periodCapRaw: "0" })
    );
  });

  it("treats a cap left blank as 0", async () => {
    const res = await POST(postCaps({ dailyCapUsdc: "", periodCapUsdc: "" }));

    expect(res.status).toBe(200);
    expect(upsertPaygConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dailyCapRaw: "0", periodCapRaw: "0" })
    );
  });

  it("rejects a genuinely malformed cap with 400 and does not persist", async () => {
    const res = await POST(
      postCaps({ dailyCapUsdc: "abc", periodCapUsdc: "1" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Spending caps must be valid USDC amounts");
    expect(upsertPaygConfig).not.toHaveBeenCalled();
  });
});
