import { beforeEach, describe, expect, it, vi } from "vitest";

// A dry run is read-only, so mcp:read must satisfy the execute routes when
// `simulate: true` is set. Drives the real handlers with real minted tokens;
// only the chain and DB boundaries are stubbed.

vi.mock("server-only", () => ({}));

const {
  mockUsersFindFirst,
  mockIsMember,
  mockAuthenticateApiKey,
  mockSimulateToken,
} = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockIsMember: vi.fn(),
  mockAuthenticateApiKey: vi.fn(),
  mockSimulateToken: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));
vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));
vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  captureEvent: vi.fn(),
  withScope: vi.fn(),
}));
vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));
vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticateApiKey,
}));
vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn().mockResolvedValue({ blocked: false }),
}));
vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/web3/wallet-helpers", () => ({
  organizationHasWallet: vi.fn().mockResolvedValue(true),
  getOrganizationWalletAddress: vi
    .fn()
    .mockResolvedValue("0xaa0000000000000000000000000000000000aa00"),
}));
vi.mock("@/lib/execute/simulate", () => ({
  simulateTokenTransfer: mockSimulateToken,
  simulateNativeTransfer: vi.fn(),
}));

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

const { createAccessToken } = await import("@/lib/mcp/oauth-auth");
const { POST: transferPost } = await import("@/app/api/execute/transfer/route");

const ORG = "org-under-test";
const USER = "user-under-test";

const SIMULATE_BODY = {
  chainId: "84532",
  recipientAddress: "0xcc0000000000000000000000000000000000cc00",
  tokenAddress: "0xdd0000000000000000000000000000000000dd00",
  amount: "1.0",
  simulate: true,
};

async function post(
  authorization: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request("http://localhost/api/execute/transfer", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const response = await transferPost(request);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    // non-JSON body
  }
  return { status: response.status, body: parsed };
}

async function bearerFor(scope: string): Promise<string> {
  return `Bearer ${await createAccessToken({ sub: USER, org: ORG, scope })}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
  mockIsMember.mockResolvedValue(true);
  mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
  mockSimulateToken.mockResolvedValue({
    success: true,
    status: "simulated",
    from: "0xaa0000000000000000000000000000000000aa00",
    to: "0xdd0000000000000000000000000000000000dd00",
    value: "0",
    gasEstimate: "51000",
    simulatedReturnValue: true,
    wouldRevert: false,
  });
});

describe("execute/transfer scope gate", () => {
  it("admits an mcp:read token for a dry run", async () => {
    const r = await post(await bearerFor("mcp:read"), SIMULATE_BODY);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("simulated");
    expect(mockSimulateToken).toHaveBeenCalledOnce();
  });

  it("still blocks an mcp:read token when simulate is omitted", async () => {
    const { simulate, ...broadcast } = SIMULATE_BODY;
    const r = await post(await bearerFor("mcp:read"), broadcast);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("insufficient_scope");
    expect(r.body.required_scope).toBe("mcp:write");
  });

  it("still blocks an mcp:read token when simulate is false", async () => {
    const r = await post(await bearerFor("mcp:read"), {
      ...SIMULATE_BODY,
      simulate: false,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("insufficient_scope");
  });

  // The strict-boolean parse is what stops a truthy non-boolean from
  // selecting the read requirement and then falling through to broadcast.
  it("rejects a non-boolean simulate before the scope decision", async () => {
    const r = await post(await bearerFor("mcp:read"), {
      ...SIMULATE_BODY,
      simulate: "true",
    });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe("simulate");
    expect(mockSimulateToken).not.toHaveBeenCalled();
  });

  it("admits an mcp:write token for a dry run", async () => {
    const r = await post(await bearerFor("mcp:write"), SIMULATE_BODY);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("simulated");
  });

  it("admits a kh_ API key, which carries no scope", async () => {
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: ORG,
      apiKeyId: "key-1",
    });
    const r = await post("Bearer kh_live_example", SIMULATE_BODY);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("simulated");
  });
});
