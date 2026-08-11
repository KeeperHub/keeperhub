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

const mockGetOrgSubscription = vi.fn();

vi.mock("@/lib/billing/plans-server", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/billing/plans-server")
  >("@/lib/billing/plans-server");
  return {
    ...actual,
    getOrgSubscription: (...args: unknown[]) => mockGetOrgSubscription(...args),
  };
});

const mockPreviewProration = vi.fn();

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: () => ({
    previewProration: mockPreviewProration,
  }),
}));

import { __resetBillingRateLimitForTests } from "@/app/api/billing/_lib/rate-limit";
import { POST } from "@/app/api/billing/preview-proration/route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/billing/preview-proration", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockSession(overrides: Record<string, unknown> = {}): void {
  mockGetSession.mockResolvedValue({
    user: { id: "usr_1", email: "user@test.com" },
    session: { activeOrganizationId: "org_1" },
    ...overrides,
  });
  mockGetActiveMember.mockResolvedValue({ role: "owner" });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetBillingRateLimitForTests();
  process.env.NEXT_PUBLIC_BILLING_ENABLED = "true";
});

describe("POST /api/billing/preview-proration", () => {
  it("returns proration preview for valid request", async () => {
    mockSession();
    mockGetOrgSubscription.mockResolvedValue({
      providerSubscriptionId: "sub_1",
      status: "active",
      plan: "pro",
    });
    mockPreviewProration.mockResolvedValue({
      amountDue: 500,
      currency: "usd",
      periodEnd: new Date("2025-02-01"),
      lineItems: [],
    });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "50k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.amountDue).toBe(500);
  });

  it("returns 401 without auth", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 without active org", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "usr_1", email: "user@test.com" },
      session: { activeOrganizationId: null },
    });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(400);
  });

  it("returns 403 for non-owner role", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "usr_1", email: "user@test.com" },
      session: { activeOrganizationId: "org_1" },
    });
    mockGetActiveMember.mockResolvedValue({ role: "member" });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json.error).toBe("Only organization owners can manage billing");
  });

  it("returns 403 when activeMember is null", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "usr_1", email: "user@test.com" },
      session: { activeOrganizationId: "org_1" },
    });
    mockGetActiveMember.mockResolvedValue(null);

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(403);
  });

  it("returns 400 for invalid plan", async () => {
    mockSession();

    const response = await POST(
      makeRequest({ plan: "invalid", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid interval", async () => {
    mockSession();

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "weekly" })
    );

    expect(response.status).toBe(400);
  });

  it("returns empty preview for free plan subscription", async () => {
    mockSession();
    mockGetOrgSubscription.mockResolvedValue({
      providerSubscriptionId: "sub_1",
      status: "active",
      plan: "free",
    });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.amountDue).toBe(0);
    expect(json.lineItems).toEqual([]);
    expect(mockPreviewProration).not.toHaveBeenCalled();
  });

  it("returns empty preview for canceled subscription", async () => {
    mockSession();
    mockGetOrgSubscription.mockResolvedValue({
      providerSubscriptionId: "sub_1",
      status: "canceled",
      plan: "pro",
    });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "50k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.amountDue).toBe(0);
    expect(json.lineItems).toEqual([]);
    expect(mockPreviewProration).not.toHaveBeenCalled();
  });

  it("returns empty preview when no subscription exists", async () => {
    mockSession();
    mockGetOrgSubscription.mockResolvedValue(null);

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.amountDue).toBe(0);
    expect(json.lineItems).toEqual([]);
    expect(mockPreviewProration).not.toHaveBeenCalled();
  });

  it("returns 500 when provider throws", async () => {
    mockSession();
    mockGetOrgSubscription.mockResolvedValue({
      providerSubscriptionId: "sub_1",
      status: "active",
      plan: "pro",
    });
    mockPreviewProration.mockRejectedValue(new Error("Stripe API unavailable"));

    const response = await POST(
      makeRequest({ plan: "pro", tier: "50k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to preview proration");
  });

  it("returns 404 when billing is disabled", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(404);
  });
});
