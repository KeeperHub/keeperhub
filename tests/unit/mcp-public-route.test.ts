import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCheckIpRateLimit,
  mockGetSession,
  mockCreateSessionToken,
  mockVerifyDetailed,
  mockHandleRequest,
} = vi.hoisted(() => ({
  mockCheckIpRateLimit: vi.fn(),
  mockGetSession: vi.fn(),
  mockCreateSessionToken: vi.fn(),
  mockVerifyDetailed: vi.fn(),
  mockHandleRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/mcp/logging", () => ({ logMcpEvent: vi.fn() }));
vi.mock("@/lib/mcp/internal-url", () => ({
  getInternalApiBaseUrl: vi.fn(() => "http://internal"),
}));
vi.mock("@/lib/mcp/event-store", () => ({ McpEventStore: vi.fn() }));
vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
  getClientIp: vi.fn(() => "1.2.3.4"),
}));
vi.mock("@/lib/mcp/server", () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@/lib/mcp/session-token", () => ({
  createSessionToken: mockCreateSessionToken,
  verifySessionTokenDetailed: mockVerifyDetailed,
}));
vi.mock("@/lib/mcp/sessions", () => ({
  deleteSession: vi.fn(),
  getSession: mockGetSession,
  setSession: vi.fn(),
  touchSession: vi.fn(),
}));
vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    // Regular (non-arrow) function so it can be invoked with `new`.
    WebStandardStreamableHTTPServerTransport: vi.fn(function (this: {
      handleRequest: typeof mockHandleRequest;
    }) {
      this.handleRequest = mockHandleRequest;
    }),
  })
);

import { POST } from "@/app/mcp/public/route";

function makeRequest(headers: Record<string, string>, body: string): Request {
  return new Request("http://localhost:3000/mcp/public", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe", version: "0" },
  },
});

const TOOLS_LIST_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list",
});

const TOOLS_CALL_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "search_workflows", arguments: {} },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckIpRateLimit.mockReturnValue({ allowed: true });
  mockHandleRequest.mockResolvedValue(new Response(null, { status: 200 }));
});

describe("/mcp/public — anonymous identity pinning (f)", () => {
  it("mints a session JWT with the anon sentinel org and mcp:public scope", async () => {
    mockCreateSessionToken.mockResolvedValue("anon-session-id");
    const response = await POST(makeRequest({}, INIT_BODY));

    expect(response.status).toBe(200);
    expect(mockCreateSessionToken).toHaveBeenCalledWith({
      org: "__anon_public__",
      key: "anon",
      scope: "mcp:public",
    });
  });
});

describe("/mcp/public — cross-surface session isolation (a)", () => {
  it("rejects a cached org session (non-anon org / non-public scope)", async () => {
    const handleRequest = vi.fn();
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      scope: "mcp:read",
      transport: { handleRequest },
    });

    const response = await POST(
      makeRequest({ "mcp-session-id": "org-session" }, TOOLS_LIST_BODY)
    );

    expect(response.status).toBe(404);
    const json = (await response.json()) as {
      error: { code: number; data: { reason: string } };
    };
    expect(json.error.code).toBe(-32_001);
    expect(json.error.data.reason).toBe("session_not_found");
    // The org session's transport must never be invoked from the public route.
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("rejects a JWT-reconstructed org session on the slow path", async () => {
    mockGetSession.mockReturnValue(undefined);
    mockVerifyDetailed.mockResolvedValue({
      payload: {
        org: "org-1",
        key: "k",
        scope: "mcp:read",
        iat: 1,
        exp: 9_999_999_999,
      },
      expired: false,
    });

    const response = await POST(
      makeRequest({ "mcp-session-id": "org-jwt" }, TOOLS_LIST_BODY)
    );

    expect(response.status).toBe(404);
    const json = (await response.json()) as {
      error: { data: { reason: string } };
    };
    expect(json.error.data.reason).toBe("session_not_found");
  });
});

describe("/mcp/public — per-IP rate limiting (c)", () => {
  it("returns 429 with Retry-After when the list bucket is exhausted", async () => {
    mockCheckIpRateLimit.mockReturnValue({ allowed: false, retryAfter: 30 });

    const response = await POST(makeRequest({}, INIT_BODY));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    const json = (await response.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32_029);
  });

  it("consults the stricter call bucket only for tools/call bodies", async () => {
    await POST(makeRequest({}, TOOLS_CALL_BODY));

    const keys = mockCheckIpRateLimit.mock.calls.map((call) => call[0]);
    const callBucket = mockCheckIpRateLimit.mock.calls.find((call) =>
      String(call[0]).startsWith("mcp-public-call:")
    );
    expect(keys.some((k) => String(k).startsWith("mcp-public:"))).toBe(true);
    expect(callBucket).toBeDefined();
    expect(callBucket?.[1]).toBe(10);
  });

  it("does NOT consult the call bucket for a tools/list body", async () => {
    // tools/list with no session falls through to session_not_initialized,
    // but the call bucket must not have been consulted.
    await POST(makeRequest({}, TOOLS_LIST_BODY));

    const callBucket = mockCheckIpRateLimit.mock.calls.find((call) =>
      String(call[0]).startsWith("mcp-public-call:")
    );
    expect(callBucket).toBeUndefined();
  });

  it("advertises the call-bucket limit (10) on a successful tools/call", async () => {
    // List bucket allows; call bucket is the binding limit at 10.
    mockCheckIpRateLimit.mockImplementation((_key: string, limit: number) => ({
      allowed: true,
      limit,
      remaining: limit - 1,
      reset: 1_700_000_000,
    }));
    mockGetSession.mockReturnValue({
      organizationId: "__anon_public__",
      scope: "mcp:public",
      transport: { handleRequest: mockHandleRequest },
    });

    const response = await POST(
      makeRequest({ "mcp-session-id": "anon-session" }, TOOLS_CALL_BODY)
    );

    expect(response.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("9");
  });

  it("advertises the list-bucket limit (60) on a non-call success", async () => {
    mockCheckIpRateLimit.mockImplementation((_key: string, limit: number) => ({
      allowed: true,
      limit,
      remaining: limit - 1,
      reset: 1_700_000_000,
    }));
    mockGetSession.mockReturnValue({
      organizationId: "__anon_public__",
      scope: "mcp:public",
      transport: { handleRequest: mockHandleRequest },
    });

    const response = await POST(
      makeRequest({ "mcp-session-id": "anon-session" }, TOOLS_LIST_BODY)
    );

    expect(response.headers.get("X-RateLimit-Limit")).toBe("60");
  });
});

describe("/mcp/public — tools/call argument normalization", () => {
  // Same reasoning as the /mcp route test: the helper is only a fix if the
  // route still routes the body through it on the way to the transport.
  it.each([
    ["explicitly null", true],
    ["omitted entirely", false],
  ])(
    "defaults tools/call arguments to {} when %s, before the transport sees it",
    async (_label, includeNullArguments) => {
      mockGetSession.mockReturnValue({
        organizationId: "__anon_public__",
        scope: "mcp:public",
        transport: { handleRequest: mockHandleRequest },
      });

      const params: Record<string, unknown> = { name: "search_workflows" };
      if (includeNullArguments) {
        params.arguments = null;
      }
      await POST(
        makeRequest(
          { "mcp-session-id": "anon-session" },
          JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params,
          })
        )
      );

      expect(mockHandleRequest).toHaveBeenCalledTimes(1);
      const [, options] = mockHandleRequest.mock.calls[0] as [
        Request,
        { parsedBody: { params: { arguments: unknown } } },
      ];
      expect(options.parsedBody.params.arguments).toEqual({});
    }
  );
});
