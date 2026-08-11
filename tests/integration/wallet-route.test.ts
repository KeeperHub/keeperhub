import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: (...args: unknown[]) => mockGetSession(...args),
    },
  },
}));

const mockGetActiveOrgId = vi.fn();
const mockGetDualAuthContext = vi.fn();

vi.mock("@/lib/middleware/org-context", () => ({
  getActiveOrgId: (...args: unknown[]) => mockGetActiveOrgId(...args),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
  auditFromAuth: (ctx: unknown): Record<string, string> => {
    if (ctx && typeof ctx === "object" && "error" in ctx) {
      return { authMethod: "unknown" };
    }
    const c = ctx as { authMethod: string; apiKeyId?: string | null };
    return c.apiKeyId
      ? { authMethod: c.authMethod, apiKeyId: c.apiKeyId }
      : { authMethod: c.authMethod };
  },
  UNAUTHENTICATED_AUDIT: { authMethod: "unknown" },
}));

const mockWalletSelectWhere = vi.fn();

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: (...args: unknown[]) => ({
          limit: () => mockWalletSelectWhere(...args),
        }),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationWallets: {
    id: "id",
    userId: "user_id",
    email: "email",
    organizationId: "organization_id",
    turnkeySubOrgId: "turnkey_sub_org_id",
    turnkeyWalletId: "turnkey_wallet_id",
    walletAddress: "wallet_address",
    createdAt: "created_at",
    isActive: "is_active",
  },
  integrations: {},
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { EXTERNAL_SERVICE: "EXTERNAL_SERVICE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/turnkey/turnkey-client", () => ({
  createTurnkeyWallet: vi.fn(),
}));

vi.mock("@/lib/db/integrations", () => ({
  createIntegration: vi.fn(),
}));

import { GET } from "@/app/api/user/wallet/route";

const CREATOR_ID = "user-creator";
const OTHER_USER_ID = "user-other";
const ORG_ID = "org-1";

function buildWalletRow(userId: string): Record<string, unknown> {
  return {
    id: "wallet-1",
    userId,
    organizationId: ORG_ID,
    email: "vault@example.com",
    walletAddress: "0x0000000000000000000000000000000000000001",
    turnkeySubOrgId: "tk-sub-org-id",
    turnkeyWalletId: "tk-wallet-id",
    createdAt: new Date("2026-01-01"),
    isActive: true,
  };
}

function createGetRequest(): Request {
  return new Request("http://localhost/api/user/wallet", { method: "GET" });
}

describe("GET /api/user/wallet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWalletSelectWhere.mockReset();
  });

  it("returns 401 when there is no auth context", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });
    const res = await GET(createGetRequest());
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("returns isOwner: true for the wallet creator", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: CREATOR_ID,
      organizationId: ORG_ID,
      authMethod: "session",
      apiKeyId: null,
    });
    mockWalletSelectWhere.mockResolvedValueOnce([buildWalletRow(CREATOR_ID)]);

    const res = await GET(createGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hasWallet).toBe(true);
    expect(data.isOwner).toBe(true);
  });

  it("returns isOwner: false for members who did not create the wallet", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: OTHER_USER_ID,
      organizationId: ORG_ID,
      authMethod: "session",
      apiKeyId: null,
    });
    mockWalletSelectWhere.mockResolvedValueOnce([buildWalletRow(CREATOR_ID)]);

    const res = await GET(createGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hasWallet).toBe(true);
    expect(data.isOwner).toBe(false);
  });

  it("returns isOwner: false for an API-key caller (key export remains session-only)", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: null,
      organizationId: ORG_ID,
      authMethod: "api-key",
      apiKeyId: "key-1",
    });
    mockWalletSelectWhere.mockResolvedValueOnce([buildWalletRow(CREATOR_ID)]);

    const res = await GET(createGetRequest());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.hasWallet).toBe(true);
    expect(data.isOwner).toBe(false);
  });
});
