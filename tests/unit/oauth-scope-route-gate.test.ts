import { beforeEach, describe, expect, it, vi } from "vitest";

// Leg 2 of the A-03 test plan: drive the REAL route handlers with REAL minted
// OAuth tokens and assert only the scope-gate outcome (403 insufficient_scope
// or not). Downstream DB/RPC work is irrelevant to the gate, so the heavy deps
// are stubbed -- a thrown error or a 500 past the gate both count as "passed
// the gate". This exercises authenticateOAuthToken -> the three dual-auth
// helper families -> requireScope -> each route's chosen scope constant.

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockIsMember } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockIsMember: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: new Proxy(
    { query: { users: { findFirst: mockUsersFindFirst } } } as Record<
      string,
      unknown
    >,
    {
      get(target, prop: string) {
        if (prop in target) {
          return target[prop];
        }
        // Any select/insert/update/delete reached past the gate just throws;
        // the handler's try/catch turns it into a non-403 response.
        return () => {
          throw new Error("db unavailable in scope-gate test");
        };
      },
    }
  ),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  captureEvent: vi.fn(),
  withScope: vi.fn(),
}));
vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: mockIsMember,
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
      getActiveMember: vi.fn().mockResolvedValue(null),
      getFullOrganization: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: vi.fn().mockResolvedValue({ authenticated: false }),
}));

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

const { createAccessToken } = await import("@/lib/mcp/oauth-auth");
const { POST: gasEstimatePost } = await import("@/app/api/gas/estimate/route");
const { POST: fetchAbiPost } = await import("@/app/api/web3/fetch-abi/route");
const { POST: tagsPost } = await import("@/app/api/tags/route");
const { PATCH: tagPatch } = await import("@/app/api/tags/[tagId]/route");
const { POST: integrationsPost } = await import("@/app/api/integrations/route");

type Handler = (request: Request, context?: unknown) => Promise<Response>;

async function tokenFor(scope: string): Promise<string> {
  return await createAccessToken({ sub: "user-1", org: "org-1", scope });
}

async function gate(
  handler: Handler,
  scope: string
): Promise<"blocked" | "passed"> {
  const token = await tokenFor(scope);
  const request = new Request("http://localhost/api/x", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  let response: Response;
  try {
    response = await handler(request, {
      params: Promise.resolve({ tagId: "t1" }),
    });
  } catch {
    // Threw in downstream code => execution got past the scope gate.
    return "passed";
  }
  let body: { error?: string } = {};
  try {
    body = (await response.json()) as { error?: string };
  } catch {
    // non-JSON body => not the insufficient_scope envelope
  }
  if (response.status === 403 && body.error === "insufficient_scope") {
    return "blocked";
  }
  return "passed";
}

beforeEach(() => {
  vi.clearAllMocks();
  // Active member so authentication resolves; the scope claim is the only gate.
  mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });
  mockIsMember.mockResolvedValue(true);
});

describe("A-03 leg 2: OAuth scope gate at the REST sinks", () => {
  describe("read-gated routes (require mcp:read after 656f6dea)", () => {
    it("gas/estimate POST admits an mcp:read token", async () => {
      expect(await gate(gasEstimatePost, "mcp:read")).toBe("passed");
    });

    it("web3/fetch-abi POST admits an mcp:read token", async () => {
      expect(await gate(fetchAbiPost, "mcp:read")).toBe("passed");
    });

    it("gas/estimate POST still blocks an invalid-scope token", async () => {
      expect(await gate(gasEstimatePost, "garbage")).toBe("blocked");
    });
  });

  describe("write-gated routes (require mcp:write), per helper family", () => {
    it("resolveCreatorContext: tags POST blocks mcp:read, admits mcp:write", async () => {
      expect(await gate(tagsPost, "mcp:read")).toBe("blocked");
      expect(await gate(tagsPost, "mcp:write")).toBe("passed");
    });

    it("getDualAuthContext: integrations POST blocks mcp:read, admits mcp:write", async () => {
      expect(await gate(integrationsPost, "mcp:read")).toBe("blocked");
      expect(await gate(integrationsPost, "mcp:write")).toBe("passed");
    });

    it("resolveOrganizationId: tags/[tagId] PATCH blocks mcp:read, admits mcp:write", async () => {
      expect(await gate(tagPatch as Handler, "mcp:read")).toBe("blocked");
      expect(await gate(tagPatch as Handler, "mcp:write")).toBe("passed");
    });

    it("admits an mcp:admin token (rank covers write)", async () => {
      expect(await gate(tagsPost, "mcp:admin")).toBe("passed");
    });
  });
});
