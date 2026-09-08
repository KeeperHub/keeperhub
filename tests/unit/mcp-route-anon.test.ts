import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports that use them.
// ---------------------------------------------------------------------------

const { mockAuthenticate, mockGetSession, mockTouchSession } = vi.hoisted(
  () => ({
    mockAuthenticate: vi.fn(),
    mockGetSession: vi.fn(),
    mockTouchSession: vi.fn(),
  })
);

// Stub server-only so the route module can be imported in a test environment.
vi.mock("server-only", () => ({}));

// Mock authenticate path: the local `authenticate()` function in the route
// calls both authenticateApiKey and authenticateOAuthToken.
vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: mockAuthenticate,
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: vi.fn().mockResolvedValue({ authenticated: false }),
}));

vi.mock("@/lib/mcp/logging", () => ({
  logMcpEvent: vi.fn(),
}));

// Resolves rather than returns: the limiter is async, and a plain object
// would read the same whether or not the route awaited it. With a Promise, a
// missing await leaves `allowed` undefined and every request 429s, so the
// happy-path assertions below fail loudly instead of silently passing.
vi.mock("@/lib/mcp/rate-limit", () => ({
  checkMcpRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 120,
    remaining: 119,
    reset: 0,
  }),
  startCleanupInterval: vi.fn(),
}));

vi.mock("@/lib/mcp/server", () => ({
  createMcpServer: vi.fn(),
}));

vi.mock("@/lib/mcp/session-token", () => ({
  createSessionToken: vi.fn(),
  verifySessionToken: vi.fn(),
  verifySessionTokenDetailed: vi.fn(),
}));

vi.mock("@/lib/mcp/sessions", () => ({
  deleteSession: vi.fn(),
  getSession: mockGetSession,
  setSession: vi.fn(),
  startCleanupInterval: vi.fn(),
  touchSession: mockTouchSession,
}));

vi.mock("@/lib/mcp/event-store", () => ({
  McpEventStore: vi.fn(),
}));

// The SDK transport is only reached for authed requests, but we mock it to
// prevent module-load errors in the test environment.
vi.mock(
  "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js",
  () => ({
    WebStandardStreamableHTTPServerTransport: vi.fn(),
  })
);

// ---------------------------------------------------------------------------
// Import route handlers after all mocks are registered.
// ---------------------------------------------------------------------------

import { DELETE, GET, POST } from "@/app/mcp/route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UNAUTHENTICATED: {
  authenticated: false;
  error: string;
  statusCode: number;
} = { authenticated: false, error: "Unauthorized", statusCode: 401 };

const RESOURCE_METADATA_PATH = /\/\.well-known\/oauth-protected-resource$/;

function makeRequest(
  method: string,
  headers: Record<string, string> = {},
  body?: string
): Request {
  return new Request("http://localhost:3000/mcp", {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

async function expectOAuthChallenge(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  const challenge = response.headers.get("WWW-Authenticate") ?? "";
  expect(challenge).toContain('Bearer realm="OAuth"');
  expect(challenge).toContain("resource_metadata=");
  expect(challenge).toContain('error="invalid_token"');
  const json = (await response.json()) as Record<string, unknown>;
  expect(json).toEqual({
    error: "invalid_token",
    error_description: "Missing or invalid access token",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /mcp — anonymous health probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns 200 with server info when no mcp-session-id header is present", async () => {
    const request = makeRequest("GET");
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const json = await response.json();
    expect(json.name).toBe("keeperhub");
    expect(json.version).toBe("1.2.0");
    expect(json.protocol).toBe("mcp");
    expect(json.status).toBe("ok");
    expect(json.authentication.required).toBe(true);
    expect(json.authentication.resource_metadata).toMatch(
      RESOURCE_METADATA_PATH
    );
  });

  it("returns the OAuth challenge when mcp-session-id is present but no auth", async () => {
    const request = makeRequest("GET", { "mcp-session-id": "some-session-id" });
    const response = await GET(request);

    await expectOAuthChallenge(response);
  });
});

describe("POST /mcp — anonymous initialize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns 200 JSON-RPC envelope for initialize with no auth, echoing the request id", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const json = await response.json();
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(7);
    expect(json.result.protocolVersion).toBe("2025-06-18");
    expect(json.result.capabilities).toEqual({});
    expect(json.result.serverInfo.name).toBe("keeperhub");
    expect(json.result.serverInfo.version).toBe("1.2.0");
    expect(json.result.authentication.required).toBe(true);
    expect(json.result.authentication.resource_metadata).toMatch(
      RESOURCE_METADATA_PATH
    );
  });

  it("returns the OAuth challenge for tools/list with no auth", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    await expectOAuthChallenge(response);
  });

  it("returns the OAuth challenge for malformed JSON, with no parser leak", async () => {
    const request = makeRequest("POST", {}, "{ not valid json");
    const response = await POST(request);

    await expectOAuthChallenge(response);
  });

  it("coerces non-scalar JSON-RPC ids to null", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: { evil: "object" },
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.id).toBeNull();
  });

  it("rejects a batch with mixed methods (only all-initialize batches are anon-allowed)", async () => {
    const body = JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/call" },
    ]);
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    await expectOAuthChallenge(response);
  });

  it("rejects an empty array body with the OAuth challenge", async () => {
    const request = makeRequest("POST", {}, JSON.stringify([]));
    const response = await POST(request);

    await expectOAuthChallenge(response);
  });

  it("accepts a single-element initialize batch and returns the anon envelope", async () => {
    const body = JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 9,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.1" },
        },
      },
    ]);
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.result.serverInfo.name).toBe("keeperhub");
    // Array bodies have no top-level id, so the response id is null.
    expect(json.id).toBeNull();
  });

  it("coerces an over-length string id to null (response amplification guard)", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "x".repeat(257),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "0.0.1" },
      },
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.id).toBeNull();
  });
});

describe("POST /mcp — authed session-resume forwards parsedBody", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      authenticated: true,
      organizationId: "org-1",
      apiKeyId: "key-1",
      scope: undefined,
    });
  });

  it("passes the parsed body through to transport.handleRequest, not the consumed stream", async () => {
    const handleRequest = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      apiKeyId: "key-1",
      transport: { handleRequest },
    });

    const parsed = {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    };
    const request = makeRequest(
      "POST",
      { "mcp-session-id": "session-abc" },
      JSON.stringify(parsed)
    );
    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(handleRequest).toHaveBeenCalledTimes(1);
    const [, options] = handleRequest.mock.calls[0] as [
      Request,
      { parsedBody: unknown },
    ];
    expect(options).toEqual({ parsedBody: parsed });
  });

  // The -32603 fix lives at the dispatch layer, not in the SDK. Asserting it
  // on the helper alone would stay green if the route went back to handing
  // `await request.json()` straight to the transport, so pin it here: what
  // the transport receives is what actually decides the wire response.
  it.each([
    ["explicitly null", null],
    ["omitted entirely", undefined],
  ])(
    "defaults tools/call arguments to {} when %s, before the transport sees it",
    async (_label, argumentsValue) => {
      const handleRequest = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      mockGetSession.mockReturnValue({
        organizationId: "org-1",
        apiKeyId: "key-1",
        transport: { handleRequest },
      });

      const params: Record<string, unknown> = {
        name: "get_wallet_integration",
      };
      if (argumentsValue === null) {
        params.arguments = null;
      }
      const request = makeRequest(
        "POST",
        { "mcp-session-id": "session-abc" },
        JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params })
      );
      await POST(request);

      expect(handleRequest).toHaveBeenCalledTimes(1);
      const [, options] = handleRequest.mock.calls[0] as [
        Request,
        { parsedBody: { params: { arguments: unknown } } },
      ];
      expect(options.parsedBody.params.arguments).toEqual({});
    }
  );

  it("rejects a cached session whose apiKeyId differs from the caller (cross-principal binding)", async () => {
    const handleRequest = vi.fn();
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      apiKeyId: "other-key",
      transport: { handleRequest },
    });

    const parsed = { jsonrpc: "2.0", id: 12, method: "tools/list", params: {} };
    const request = makeRequest(
      "POST",
      { "mcp-session-id": "session-abc" },
      JSON.stringify(parsed)
    );
    const response = await POST(request);

    expect(response.status).not.toBe(200);
    expect(handleRequest).not.toHaveBeenCalled();
  });

  it("returns 400 when an authed POST has a malformed body (cannot reach transport)", async () => {
    const handleRequest = vi.fn();
    mockGetSession.mockReturnValue({
      organizationId: "org-1",
      apiKeyId: "key-1",
      transport: { handleRequest },
    });

    const request = makeRequest(
      "POST",
      { "mcp-session-id": "session-abc" },
      "{ not json"
    );
    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(handleRequest).not.toHaveBeenCalled();
  });
});

describe("POST /mcp — session bootstrap errors (KEEP-474 wire shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      authenticated: true,
      organizationId: "org-1",
      apiKeyId: "key-1",
      scope: undefined,
    });
  });

  it("returns -32003 session_not_initialized when authed POST omits session id on a non-initialize body", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/list",
    });
    const request = makeRequest("POST", {}, body);
    const response = await POST(request);

    // -32003 maps to HTTP 400 per SESSION_ERROR_DESCRIPTORS.
    expect(response.status).toBe(400);
    const json = (await response.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { reason: string } };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBeNull();
    expect(json.error.code).toBe(-32_003);
    expect(json.error.data.reason).toBe("session_not_initialized");
    expect(json.error.data).toHaveProperty("hint");
  });
});

describe("DELETE /mcp — session bootstrap errors (KEEP-474 wire shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue({
      authenticated: true,
      organizationId: "org-1",
      apiKeyId: "key-1",
      scope: undefined,
    });
  });

  it("returns -32004 missing_session_id when authed DELETE omits the mcp-session-id header", async () => {
    const request = makeRequest("DELETE");
    const response = await DELETE(request);

    // -32004 maps to HTTP 400 per SESSION_ERROR_DESCRIPTORS.
    expect(response.status).toBe(400);
    const json = (await response.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; data: { reason: string; hint: string } };
    };
    expect(json.jsonrpc).toBe("2.0");
    expect(json.error.code).toBe(-32_004);
    expect(json.error.data.reason).toBe("missing_session_id");
  });
});

describe("DELETE /mcp — always requires auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticate.mockResolvedValue(UNAUTHENTICATED);
  });

  it("returns the OAuth challenge when no auth token is provided", async () => {
    const request = makeRequest("DELETE", {
      "mcp-session-id": "some-session-id",
    });
    const response = await DELETE(request);

    await expectOAuthChallenge(response);
  });
});
