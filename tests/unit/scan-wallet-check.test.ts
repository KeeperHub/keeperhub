/**
 * Unit tests for GET /api/scan/wallet-check — FUNNEL-05 wallet gate.
 *
 * RED scaffold (Wave 0, Plan 54-01). All tests fail against the throw-stub;
 * they turn GREEN when the real implementation lands in Plan 54-04.
 *
 * FUNNEL-05 is forward-compat only: all v1.13 suggestions are read-only.
 * This endpoint is exercised in tests via SYNTHETIC_WRITE_DESCRIPTOR.
 *
 * Coverage:
 *   - Unauthenticated / anonymous caller → 401
 *   - Authenticated, no org wallet → response indicates provision needed
 *   - Authenticated, org wallet exists → response indicates no provision needed
 *   - getDualAuthContext 401 error propagated correctly
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Mock getDualAuthContext
// ---------------------------------------------------------------------------

type AuthSuccess = {
  userId: string;
  organizationId: string;
  authMethod: string;
  apiKeyId: null;
  isAnonymous: boolean;
  scope: string;
};
type AuthError = { error: string; status: number };
type DualAuthContext = AuthSuccess | AuthError;

const mockGetDualAuthContext =
  vi.fn<(request: Request) => Promise<DualAuthContext>>();

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

// ---------------------------------------------------------------------------
// Mock organizationHasWallet
// ---------------------------------------------------------------------------

const mockOrganizationHasWallet = vi.fn<(orgId: string) => Promise<boolean>>();

vi.mock("@/lib/web3/wallet-helpers", () => ({
  organizationHasWallet: mockOrganizationHasWallet,
}));

// Import AFTER mocks are hoisted.
const { GET } = await import("@/app/api/scan/wallet-check/route");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTHED_CONTEXT: AuthSuccess = {
  userId: "user_abc",
  organizationId: "org_xyz",
  authMethod: "session",
  apiKeyId: null,
  isAnonymous: false,
  scope: "write",
};

const UNAUTHED_ERROR: AuthError = { error: "Unauthorized", status: 401 };
const NO_ORG_ERROR: AuthError = {
  error: "No active organization",
  status: 409,
};

function makeRequest(): Request {
  return new Request("http://localhost/api/scan/wallet-check", {
    method: "GET",
    credentials: "include",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const RE_UNAUTHORIZED = /unauthorized/i;

describe("GET /api/scan/wallet-check", () => {
  beforeEach(() => {
    mockGetDualAuthContext.mockClear();
    mockOrganizationHasWallet.mockClear();
  });

  it("returns 401 when the caller is not authenticated", async () => {
    mockGetDualAuthContext.mockResolvedValueOnce(UNAUTHED_ERROR);

    const res = await GET(makeRequest());
    expect(res.status).toBe(401);

    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(RE_UNAUTHORIZED);
    expect(mockOrganizationHasWallet).not.toHaveBeenCalled();
  });

  it("returns an error when the user has no active organisation", async () => {
    mockGetDualAuthContext.mockResolvedValueOnce(NO_ORG_ERROR);

    const res = await GET(makeRequest());
    expect(res.status).toBe(409);
    expect(mockOrganizationHasWallet).not.toHaveBeenCalled();
  });

  it("returns hasWallet:false and indicates provision is needed when org has no wallet", async () => {
    mockGetDualAuthContext.mockResolvedValueOnce(AUTHED_CONTEXT);
    mockOrganizationHasWallet.mockResolvedValueOnce(false);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = (await res.json()) as { hasWallet: boolean };
    expect(data.hasWallet).toBe(false);

    expect(mockOrganizationHasWallet).toHaveBeenCalledWith("org_xyz");
  });

  it("returns hasWallet:true and indicates no provision needed when org wallet exists", async () => {
    mockGetDualAuthContext.mockResolvedValueOnce(AUTHED_CONTEXT);
    mockOrganizationHasWallet.mockResolvedValueOnce(true);

    const res = await GET(makeRequest());
    expect(res.status).toBe(200);

    const data = (await res.json()) as { hasWallet: boolean };
    expect(data.hasWallet).toBe(true);

    expect(mockOrganizationHasWallet).toHaveBeenCalledWith("org_xyz");
  });
});
