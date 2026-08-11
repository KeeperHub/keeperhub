import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-123";
const ORG_ID = "org-123";

const {
  mockGetDualAuthContext,
  mockUsersFindFirst,
  mockAccountsFindFirst,
  mockGetOrganizationWallet,
} = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockUsersFindFirst: vi.fn(),
  mockAccountsFindFirst: vi.fn(),
  mockGetOrganizationWallet: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
  auditFromAuth: (ctx: unknown): Record<string, string> => {
    if (ctx && typeof ctx === "object" && "error" in ctx) {
      return { authMethod: "unknown" };
    }
    const c = ctx as { authMethod: string; apiKeyId?: string | null };
    return c.apiKeyId
      ? { authMethod: c.authMethod, apiKeyId: c.apiKeyId }
      : { authMethod: c.authMethod };
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      users: { findFirst: mockUsersFindFirst },
      accounts: { findFirst: mockAccountsFindFirst },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "id" },
  accounts: { userId: "user_id" },
}));

vi.mock("@/lib/web3/wallet-helpers", () => ({
  getOrganizationWallet: mockGetOrganizationWallet,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/user/route";

function buildRequest(): Request {
  return new Request("http://localhost/api/user");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/user", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await GET(buildRequest());
    expect(response.status).toBe(401);
  });

  it("returns 400 when API key has no recorded creator", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: ORG_ID,
      authMethod: "api-key",
    });

    const response = await GET(buildRequest());
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("recreate the API key");
  });

  it("returns 404 when user record not found", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockUsersFindFirst.mockResolvedValue(undefined);

    const response = await GET(buildRequest());
    expect(response.status).toBe(404);
  });

  it("returns user profile for session caller", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
    });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      name: "Jane",
      email: "jane@test.com",
      image: null,
      isAnonymous: false,
    });
    mockAccountsFindFirst.mockResolvedValue({ providerId: "credential" });
    mockGetOrganizationWallet.mockResolvedValue({ walletAddress: "0xabc" });

    const response = await GET(buildRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.id).toBe(USER_ID);
    expect(json.providerId).toBe("credential");
    expect(json.walletAddress).toBe("0xabc");
  });

  it("returns key-creator profile for API-key caller", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: USER_ID,
      organizationId: ORG_ID,
      authMethod: "api-key",
    });
    mockUsersFindFirst.mockResolvedValue({
      id: USER_ID,
      name: "Jane",
      email: "jane@test.com",
      image: null,
      isAnonymous: false,
    });
    mockAccountsFindFirst.mockResolvedValue({ providerId: "credential" });
    mockGetOrganizationWallet.mockRejectedValue(new Error("no wallet"));

    const response = await GET(buildRequest());
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.id).toBe(USER_ID);
    expect(json.walletAddress).toBeNull();
  });
});
