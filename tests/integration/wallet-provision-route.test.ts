import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockGetOrgContext = vi.fn();
vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: (...args: unknown[]) => mockGetOrgContext(...args),
  getActiveOrgId: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockProvision = vi.fn();
vi.mock("@/lib/turnkey/provision-org-wallet", () => ({
  provisionOrganizationWallet: (...args: unknown[]) => mockProvision(...args),
}));

const mockLogSystemError = vi.fn();
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: (...args: unknown[]) => mockLogSystemError(...args),
}));

import { GET } from "@/app/api/user/wallet/provision/route";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const EMAIL = "new@example.com";

function request(): Parameters<typeof GET>[0] {
  return new Request("http://localhost/api/user/wallet/provision", {
    method: "GET",
  }) as Parameters<typeof GET>[0];
}

function authedContext(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    user: { id: USER_ID, email: EMAIL, name: "New User", image: null },
    organization: { id: ORG_ID, name: "Org", createdAt: new Date() },
    member: {
      id: "m-1",
      organizationId: ORG_ID,
      userId: USER_ID,
      role: "owner",
      createdAt: new Date(),
    },
    isAnonymous: false,
    needsOrganization: false,
    ...overrides,
  };
}

describe("GET /api/user/wallet/provision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 for an anonymous session", async () => {
    mockGetOrgContext.mockResolvedValue({
      user: null,
      organization: null,
      member: null,
      isAnonymous: true,
      needsOrganization: false,
    });

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("returns 403 when the user has no organization", async () => {
    mockGetOrgContext.mockResolvedValue({
      user: { id: USER_ID, email: EMAIL, name: "x" },
      organization: null,
      member: null,
      isAnonymous: false,
      needsOrganization: true,
    });

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("returns 400 when the org context carries no organization id", async () => {
    mockGetOrgContext.mockResolvedValue(authedContext({ organization: null }));

    const res = await GET(request());

    expect(res.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("returns 400 for a placeholder / anonymous email", async () => {
    mockGetOrgContext.mockResolvedValue(
      authedContext({
        user: { id: USER_ID, email: "temp-abc@example.com", name: "Anonymous" },
      })
    );

    const res = await GET(request());

    expect(res.status).toBe(400);
    expect(mockProvision).not.toHaveBeenCalled();
  });

  it("streams provisioning then ready and calls the provisioner with org + email", async () => {
    mockGetOrgContext.mockResolvedValue(authedContext());
    mockProvision.mockResolvedValue({
      created: true,
      walletAddress: "0xabc",
      walletId: "w-1",
      subOrgId: "s-1",
    });

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = await res.text();
    expect(body).toContain('"type":"provisioning"');
    expect(body).toContain('"type":"ready"');
    expect(body).toContain('"walletAddress":"0xabc"');

    expect(mockProvision).toHaveBeenCalledWith({
      userId: USER_ID,
      organizationId: ORG_ID,
      email: EMAIL,
    });
  });

  it("streams an error frame and logs when provisioning fails", async () => {
    mockGetOrgContext.mockResolvedValue(authedContext());
    mockProvision.mockRejectedValue(new Error("turnkey down"));

    const res = await GET(request());

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"type":"error"');
    expect(mockLogSystemError).toHaveBeenCalledTimes(1);
  });
});
