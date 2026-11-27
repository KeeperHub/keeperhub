// GET /api/features tells the editor whether the caller's organization may
// send bundles, as a boolean; the rollout setting itself never leaves the server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  billing: false,
  resolveOrganizationId: vi.fn(),
}));

vi.mock("@/lib/billing/feature-flag", () => ({
  isBillingEnabled: () => mocks.billing,
}));

vi.mock("@/lib/billing/plans-server", () => ({
  getOrgPlan: vi.fn().mockResolvedValue("free"),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  auditFromAuth: vi.fn().mockReturnValue({}),
  resolveOrganizationId: mocks.resolveOrganizationId,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET } from "@/app/api/features/route";

async function flag(): Promise<unknown> {
  const response = await GET(new Request("http://localhost/api/features"));
  const body = (await response.json()) as Record<string, unknown>;
  expect(JSON.stringify(body)).not.toContain("orgs:");
  return body.bundleSendEnabled;
}

describe.each([
  ["billing off", false],
  ["billing on", true],
])("GET /api/features bundleSendEnabled (%s)", (_name, billing) => {
  beforeEach(() => {
    mocks.billing = billing;
    mocks.resolveOrganizationId.mockResolvedValue({ organizationId: "org-in" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is true for an organization in the rollout", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "orgs:org-in");
    expect(await flag()).toBe(true);
  });

  it("is false for an organization outside it, and with the rollout off", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "orgs:someone-else");
    expect(await flag()).toBe(false);
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "off");
    expect(await flag()).toBe(false);
  });

  it("is false when no organization can be resolved", async () => {
    vi.stubEnv("BUNDLE_SEND_ROLLOUT", "all");
    mocks.resolveOrganizationId.mockResolvedValue({
      error: "No organization",
      status: 401,
    });
    if (billing) {
      // With billing on, an unresolved caller gets the auth error instead.
      const response = await GET(new Request("http://localhost/api/features"));
      expect(response.status).toBe(401);
      return;
    }
    expect(await flag()).toBe(false);
  });
});
