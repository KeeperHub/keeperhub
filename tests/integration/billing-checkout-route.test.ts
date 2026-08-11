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

const mockUpdateSet = vi.fn().mockReturnValue({ where: vi.fn() });
const mockReturning = vi
  .fn()
  .mockResolvedValue([{ providerCustomerId: "cus_123" }]);
const mockOnConflictDoUpdate = vi
  .fn()
  .mockReturnValue({ returning: mockReturning });
const mockInsertValues = vi
  .fn()
  .mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue([]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
    insert: vi.fn(() => ({
      values: mockInsertValues,
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationSubscriptions: { organizationId: "organizationId" },
}));

const mockCreateCheckoutSession = vi.fn();
const mockCreateCustomer = vi.fn();
const mockUpdateSubscription = vi.fn();
const mockGetSubscriptionDetails = vi.fn();

vi.mock("@/lib/billing/providers", () => ({
  getBillingProvider: () => ({
    createCheckoutSession: mockCreateCheckoutSession,
    createCustomer: mockCreateCustomer,
    updateSubscription: mockUpdateSubscription,
    getSubscriptionDetails: mockGetSubscriptionDetails,
  }),
}));

import { __resetBillingRateLimitForTests } from "@/app/api/billing/_lib/rate-limit";
import { POST } from "@/app/api/billing/checkout/route";

function makeRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost:3000/api/billing/checkout", {
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
  // Pin the trial tier so the trial-intent cases don't inherit a developer's
  // local TRIAL_TIER from .env (CI has no .env, so it defaults there).
  process.env.TRIAL_TIER = "25k";
});

describe("POST /api/billing/checkout", () => {
  it("returns checkout URL for new subscription", async () => {
    mockSession();
    mockCreateCustomer.mockResolvedValue({ customerId: "cus_123" });
    mockCreateCheckoutSession.mockResolvedValue({
      url: "https://checkout.stripe.com/session_1",
    });

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.url).toBe("https://checkout.stripe.com/session_1");
  });

  // These assert the arg passed to createCheckoutSession, not the response,
  // so the returned URL is an unused stub.
  it("starts a trial when the trial intent is explicit (first-time Pro)", async () => {
    mockSession();
    mockCreateCustomer.mockResolvedValue({ customerId: "cus_123" });
    mockCreateCheckoutSession.mockResolvedValue({ url: "stub-url" });

    await POST(
      makeRequest({
        plan: "pro",
        tier: "25k",
        interval: "monthly",
        trial: true,
      })
    );

    const arg = mockCreateCheckoutSession.mock.calls[0]?.[0];
    expect(arg.trialPeriodDays).toBe(14);
  });

  it("pays immediately (no trial) when the trial intent is absent", async () => {
    mockSession();
    mockCreateCustomer.mockResolvedValue({ customerId: "cus_123" });
    mockCreateCheckoutSession.mockResolvedValue({ url: "stub-url" });

    // Eligible first-time Pro org, but a plan-card checkout omits `trial`.
    await POST(makeRequest({ plan: "pro", tier: "25k", interval: "monthly" }));

    const arg = mockCreateCheckoutSession.mock.calls[0]?.[0];
    expect(arg.trialPeriodDays).toBeUndefined();
  });

  it("does not start a trial for a Business subscription", async () => {
    mockSession();
    mockCreateCustomer.mockResolvedValue({ customerId: "cus_123" });
    mockCreateCheckoutSession.mockResolvedValue({ url: "stub-url" });

    await POST(
      makeRequest({ plan: "business", tier: "250k", interval: "monthly" })
    );

    const arg = mockCreateCheckoutSession.mock.calls[0]?.[0];
    expect(arg.trialPeriodDays).toBeUndefined();
  });

  it("does not start a trial for Pro tiers above 25k", async () => {
    mockSession();
    mockCreateCustomer.mockResolvedValue({ customerId: "cus_123" });
    mockCreateCheckoutSession.mockResolvedValue({ url: "stub-url" });

    // Trial intent is explicit, but only Pro 25k is trial-eligible.
    await POST(
      makeRequest({
        plan: "pro",
        tier: "50k",
        interval: "monthly",
        trial: true,
      })
    );

    const arg = mockCreateCheckoutSession.mock.calls[0]?.[0];
    expect(arg.trialPeriodDays).toBeUndefined();
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

  it("returns 404 when billing is disabled", async () => {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = "false";

    const response = await POST(
      makeRequest({ plan: "pro", tier: "25k", interval: "monthly" })
    );

    expect(response.status).toBe(404);
  });
});
