import { beforeEach, describe, expect, it, vi } from "vitest";

// Leg 2 of the A-03 test plan: drive the REAL route handlers with REAL minted
// OAuth tokens and assert only the scope-gate outcome (403 insufficient_scope
// or not). Downstream DB/RPC work is irrelevant to the gate, so the heavy deps
// are stubbed -- a thrown error or a 500 past the gate both count as "passed
// the gate". This exercises authenticateOAuthToken -> the three dual-auth
// helper families -> requireScope -> each route's chosen scope constant.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/middleware/policy-gate", () => ({
  policyRefusalFor: async () => null,
}));

const {
  mockUsersFindFirst,
  mockIsMember,
  mockAuthenticateApiKey,
  mockLogSecurityEvent,
  gateCalls,
} = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockIsMember: vi.fn(),
  mockAuthenticateApiKey: vi.fn(),
  mockLogSecurityEvent: vi.fn(),
  gateCalls: [] as {
    granted: string | undefined;
    required: string;
    denied: boolean;
  }[],
}));

// The auth path reads the scope epoch and records liveness; neither is what
// these tests exercise, so both are stubbed to their no-change answers.
vi.mock("@/lib/mcp/scope-policy", () => ({
  DEFAULT_EPOCH: 0,
  effectiveScope: (scope: string) => scope,
  getScopePolicy: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
  getScopePolicyForMint: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
}));

vi.mock("@/lib/mcp/connections", () => ({
  touchConnection: vi.fn().mockResolvedValue(undefined),
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
  authenticateApiKey: mockAuthenticateApiKey,
}));
vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, logSecurityEvent: mockLogSecurityEvent };
});
// The protocol dispatcher checks the action against the generated registry
// before the gate. Stub it so the test does not depend on discover-plugins
// having been run, matching the other execute-protocol unit suites.
vi.mock("@/lib/step-registry", () => ({
  PLUGIN_STEP_IMPORTERS: {
    "test-protocol/swap": () => Promise.resolve({}),
  },
}));
// Record what each route asks for and what the real guard decided, so an
// "admitted" assertion proves the gate ran and allowed rather than proving
// only that no 403 came back.
vi.mock("@/lib/middleware/require-scope", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/middleware/require-scope")>();
  return {
    ...actual,
    requireScope: (
      granted: string | undefined,
      required: Parameters<typeof actual.requireScope>[1],
      context?: Parameters<typeof actual.requireScope>[2]
    ) => {
      const denial = actual.requireScope(granted, required, context);
      gateCalls.push({ granted, required, denied: denial !== null });
      return denial;
    },
  };
});

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

const { createAccessToken } = await import("@/lib/mcp/oauth-auth");
const { POST: gasEstimatePost } = await import("@/app/api/gas/estimate/route");
const { POST: fetchAbiPost } = await import("@/app/api/web3/fetch-abi/route");
const { POST: tagsPost } = await import("@/app/api/tags/route");
const { PATCH: tagPatch } = await import("@/app/api/tags/[tagId]/route");
const { POST: integrationsPost } = await import("@/app/api/integrations/route");
const { POST: executeSwapPost } = await import("@/app/api/execute/swap/route");
const { GET: executeStatusGet } = await import(
  "@/app/api/execute/[executionId]/status/route"
);
const { POST: executeTransferPost } = await import(
  "@/app/api/execute/transfer/route"
);
const { POST: executeContractCallPost } = await import(
  "@/app/api/execute/contract-call/route"
);
const { POST: executeCheckAndExecutePost } = await import(
  "@/app/api/execute/check-and-execute/route"
);
const { POST: executeNodePost } = await import("@/app/api/execute/node/route");
const { POST: executeProtocolPost } = await import(
  "@/app/api/execute/[...slug]/route"
);

type Handler = (request: Request, context?: unknown) => Promise<Response>;
type GateOutcome = "blocked" | "passed";

async function tokenFor(scope: string): Promise<string> {
  return await createAccessToken({ sub: "user-1", org: "org-1", scope });
}

async function outcomeOf(run: () => Promise<Response>): Promise<GateOutcome> {
  let response: Response;
  try {
    response = await run();
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

/**
 * The concrete HTTP status, or "threw" when the handler blew up in the stubbed
 * downstream. Both mean the gate let the request through, but the number lets
 * a test pin which branch it reached.
 */
async function statusOf(
  run: () => Promise<Response>
): Promise<number | "threw"> {
  try {
    return (await run()).status;
  } catch {
    return "threw";
  }
}

async function gate(handler: Handler, scope: string): Promise<GateOutcome> {
  const token = await tokenFor(scope);
  const request = new Request("http://localhost/api/x", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  return await outcomeOf(() =>
    handler(request, { params: Promise.resolve({ tagId: "t1" }) })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  gateCalls.length = 0;
  mockAuthenticateApiKey.mockResolvedValue({ authenticated: false });
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

describe("A-03 leg 3: kh_ API key scope gate at the direct-execution sinks", () => {
  // /api/execute/* resolves auth through app/api/execute/_lib/auth, which used
  // to drop the key's scope so every kh_ key ran as full access regardless of
  // what it was minted with. These drive the real routes through the real
  // validateApiKey and the real requireScope, with only the DB row stubbed.
  function withKeyScope(scope: string | undefined): void {
    mockAuthenticateApiKey.mockResolvedValue({
      authenticated: true,
      organizationId: "org-1",
      apiKeyId: "key-1",
      userId: "user-1",
      scope,
    });
  }

  function post(path: string, body: Record<string, unknown> = {}): Request {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer kh_testkey",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  function statusRequest(): Request {
    return new Request("http://localhost/api/execute/exec-1/status", {
      method: "GET",
      headers: { Authorization: "Bearer kh_testkey" },
    });
  }

  function protocolPost(body: Record<string, unknown> = {}): Promise<Response> {
    return executeProtocolPost(post("/api/execute/test-protocol/swap", body), {
      params: Promise.resolve({ slug: ["test-protocol", "swap"] }),
    });
  }

  describe("broadcast sinks refuse a read-only key", () => {
    // These five are the routes that actually sign and broadcast. /swap is a
    // 501 stub, so it cannot stand in for them.
    it("transfer blocks mcp:read when no simulate flag is set", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeTransferPost(post("/api/execute/transfer"))
      );

      expect(outcome).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });

    it("contract-call blocks mcp:read when no simulate flag is set", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeContractCallPost(post("/api/execute/contract-call"))
      );

      expect(outcome).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });

    it("check-and-execute blocks mcp:read when no simulate flag is set", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeCheckAndExecutePost(post("/api/execute/check-and-execute"))
      );

      expect(outcome).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });

    it("node blocks mcp:read", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeNodePost(post("/api/execute/node"))
      );

      expect(outcome).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });

    it("the protocol dispatcher blocks mcp:read", async () => {
      withKeyScope("mcp:read");

      expect(await outcomeOf(protocolPost)).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });
  });

  describe("the dry-run downgrade keeps its polarity", () => {
    // transfer/contract-call/check-and-execute pick the required scope from
    // the parsed `simulate` flag. Inverting that ternary would silently
    // reopen the hole, so pin both directions explicitly.
    it("transfer admits mcp:read for simulate: true", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeTransferPost(post("/api/execute/transfer", { simulate: true }))
      );

      expect(outcome).toBe("passed");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:read", denied: false },
      ]);
    });

    it("transfer blocks mcp:read for an explicit simulate: false", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeTransferPost(post("/api/execute/transfer", { simulate: false }))
      );

      expect(outcome).toBe("blocked");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:write", denied: true },
      ]);
    });

    it("contract-call admits mcp:read for simulate: true", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeContractCallPost(
          post("/api/execute/contract-call", { simulate: true })
        )
      );

      expect(outcome).toBe("passed");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:read", denied: false },
      ]);
    });

    it("a non-boolean simulate is rejected before the gate rather than downgrading it", async () => {
      withKeyScope("mcp:read");

      const status = await statusOf(() =>
        executeTransferPost(post("/api/execute/transfer", { simulate: "true" }))
      );

      expect(status).toBe(400);
      expect(gateCalls).toEqual([]);
    });
  });

  describe("credentials that should still be admitted", () => {
    it("swap admits mcp:write and reaches its 501 stub", async () => {
      withKeyScope("mcp:write");

      const status = await statusOf(() =>
        executeSwapPost(post("/api/execute/swap"))
      );

      expect(status).toBe(501);
      expect(gateCalls).toEqual([
        { granted: "mcp:write", required: "mcp:write", denied: false },
      ]);
    });

    it("the status read sink admits mcp:read", async () => {
      withKeyScope("mcp:read");

      const outcome = await outcomeOf(() =>
        executeStatusGet(statusRequest(), {
          params: Promise.resolve({ executionId: "exec-1" }),
        })
      );

      expect(outcome).toBe("passed");
      expect(gateCalls).toEqual([
        { granted: "mcp:read", required: "mcp:read", denied: false },
      ]);
    });

    it("a key whose scope column is NULL keeps full access at a broadcast sink", async () => {
      // The column is nullable; authenticateApiKey coerces NULL to undefined
      // and undefined stays unrestricted, so keys issued without a scope are
      // not affected by this gate.
      withKeyScope(undefined);

      const outcome = await outcomeOf(() =>
        executeTransferPost(post("/api/execute/transfer"))
      );

      expect(outcome).toBe("passed");
      expect(gateCalls).toEqual([
        { granted: undefined, required: "mcp:write", denied: false },
      ]);
    });

    it("mcp:admin outranks write at a broadcast sink", async () => {
      withKeyScope("mcp:admin");

      const outcome = await outcomeOf(() =>
        executeTransferPost(post("/api/execute/transfer"))
      );

      expect(outcome).toBe("passed");
      expect(gateCalls).toEqual([
        { granted: "mcp:admin", required: "mcp:write", denied: false },
      ]);
    });
  });

  it("blocks a key with an unrecognised scope string at a broadcast sink", async () => {
    withKeyScope("bogus:scope");

    expect(
      await outcomeOf(() => executeTransferPost(post("/api/execute/transfer")))
    ).toBe("blocked");
  });

  it("emits an attributable security signal on denial", async () => {
    withKeyScope("mcp:read");

    await outcomeOf(() => executeTransferPost(post("/api/execute/transfer")));

    expect(mockLogSecurityEvent).toHaveBeenCalledWith(
      "insufficient_scope_denied",
      expect.objectContaining({
        required_scope: "mcp:write",
        granted_scope: "mcp:read",
        organizationId: "org-1",
        credentialId: "key-1",
        // Proves the route threads the family through, not just that
        // requireScope forwards whatever it is handed.
        credential_type: "api-key",
        endpoint: "/api/execute/transfer",
      })
    );
  });

  it("stays silent when the gate admits", async () => {
    withKeyScope("mcp:write");

    await outcomeOf(() => executeTransferPost(post("/api/execute/transfer")));

    expect(mockLogSecurityEvent).not.toHaveBeenCalled();
  });
});
