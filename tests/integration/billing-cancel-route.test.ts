import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
const mockGetActiveMember = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
      getActiveMember: (...args: unknown[]) => mockGetActiveMember(...args),
    },
  },
}));

const mockSelectLimit = vi.fn().mockResolvedValue([]);
const mockUpdateSet = vi.fn().mockReturnValue({ where: vi.fn() });

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: mockSelectLimit,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationSubscriptions: { organizationId: "organizationId" },
}));

const mockCancelSubscription = vi.fn();

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: () => ({
    cancelSubscription: mockCancelSubscription,
  }),
}));

import { POST } from "@/app/api/billing/cancel/route";

function mockSession(): void {
  mockGetSession.mockResolvedValue({
    user: { id: "usr_1", email: "user@test.com" },
    session: { activeOrganizationId: "org_1" },
  });
  mockGetActiveMember.mockResolvedValue({ role: "owner" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
});

describe("POST /api/billing/cancel", () => {
  it("cancels subscription", async () => {
    mockSession();
    const periodEnd = new Date("2025-02-01");
    mockSelectLimit.mockResolvedValue([
      {
        plan: "pro",
        providerSubscriptionId: "sub_1",
        status: "active",
      },
    ]);
    mockCancelSubscription.mockResolvedValue({
      cancelAtPeriodEnd: true,
      periodEnd,
    });

    const response = await POST(
      new Request("http://localhost/api/billing/cancel", { method: "POST" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.canceled).toBe(true);
    expect(json.periodEnd).toBe(periodEnd.toISOString());
    expect(mockCancelSubscription).toHaveBeenCalledWith("sub_1");
  });

  it("returns 401 without auth", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/billing/cancel", { method: "POST" })
    );

    expect(response.status).toBe(401);
  });

  it("returns 403 for non-owner", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "usr_1", email: "user@test.com" },
      session: { activeOrganizationId: "org_1" },
    });
    mockGetActiveMember.mockResolvedValue({ role: "member" });

    const response = await POST(
      new Request("http://localhost/api/billing/cancel", { method: "POST" })
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 with no active subscription", async () => {
    mockSession();
    mockSelectLimit.mockResolvedValue([
      { plan: "free", providerSubscriptionId: null },
    ]);

    const response = await POST(
      new Request("http://localhost/api/billing/cancel", { method: "POST" })
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when billing is disabled", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const response = await POST(
      new Request("http://localhost/api/billing/cancel", { method: "POST" })
    );

    expect(response.status).toBe(404);
  });
});
