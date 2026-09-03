import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/mcp/listing", () => ({
  getWorkflowListing: vi.fn(),
}));

vi.mock("@/lib/api-key-auth", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("@/lib/mcp/oauth-auth", () => ({
  authenticateOAuthToken: vi.fn(),
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
}));

vi.mock("@/lib/mcp/session-token", () => ({
  createSessionToken: vi.fn(async () => "session-jwt-token"),
  verifySessionToken: vi.fn(),
  verifySessionTokenDetailed: vi.fn(),
}));

vi.mock("@/lib/mcp/sessions", () => ({
  getSession: vi.fn(() => undefined),
  setSession: vi.fn(),
  deleteSession: vi.fn(),
  touchSession: vi.fn(),
  startCleanupInterval: vi.fn(),
}));

vi.mock("@/lib/mcp/event-store", () => {
  return {
    // biome-ignore lint/style/useConsistentObjectDefinitions: explicit function expression needed so `new McpEventStore()` works; method shorthand is not newable
    McpEventStore: function McpEventStore() {
      return;
    },
  };
});

vi.mock("@/lib/mcp/logging", () => ({
  logMcpEvent: vi.fn(),
}));

vi.mock("@/lib/mcp/workflow-server", () => ({
  createWorkflowMcpServer: vi.fn(() => ({
    connect: vi.fn((): Promise<void> => Promise.resolve()),
    close: vi.fn((): Promise<void> => Promise.resolve()),
  })),
}));

const mockTransportHandleRequest = vi.fn(
  async () => new Response("{}", { status: 200 })
);

vi.mock("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js", () => {
  return {
    // biome-ignore lint/style/useConsistentObjectDefinitions: explicit function expression needed so `new WebStandardStreamableHTTPServerTransport()` works; method shorthand is not newable
    WebStandardStreamableHTTPServerTransport:
      function WebStandardStreamableHTTPServerTransport(this: {
        handleRequest: typeof mockTransportHandleRequest;
        close: () => Promise<void>;
      }) {
        this.handleRequest = mockTransportHandleRequest;
        this.close = vi.fn((): Promise<void> => Promise.resolve());
      },
  };
});

vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  isInitializeRequest: vi.fn((body: unknown) => {
    if (body && typeof body === "object" && "method" in body) {
      return (body as { method: string }).method === "initialize";
    }
    return false;
  }),
}));

import { authenticateApiKey } from "@/lib/api-key-auth";
import { getWorkflowListing } from "@/lib/mcp/listing";
import { authenticateOAuthToken } from "@/lib/mcp/oauth-auth";
import { getSession } from "@/lib/mcp/sessions";
import type { WorkflowListing } from "@/lib/mcp/workflow-server";

const { POST, GET, DELETE, OPTIONS } = await import("@/app/mcp/w/[slug]/route");

const makeListing = (
  overrides: Partial<WorkflowListing> = {}
): WorkflowListing => ({
  id: "wf-abc",
  name: "My Workflow",
  description: "Does useful things.",
  listedSlug: "my-workflow",
  inputSchema: { type: "object", properties: { x: { type: "string" } } },
  outputMapping: { result: "$.result" },
  priceUsdcPerCall: null,
  workflowType: "read",
  listingVersion: 1,
  nodes: [],
  ...overrides,
});

const makeParams = (slug = "my-workflow") => ({
  params: Promise.resolve({ slug }),
});

function makeInitializeRequest(authHeader = "Bearer kh_test"): Request {
  return new Request("http://localhost/mcp/w/my-workflow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
      // Both accept types, so ensureMcpAcceptHeader short-circuits and the
      // request reaches the transport unmodified.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ method: "initialize", id: 1, jsonrpc: "2.0" }),
  });
}

function mockAuthSuccess(orgId = "org-x", apiKeyId = "key-1"): void {
  vi.mocked(authenticateApiKey).mockResolvedValue({
    authenticated: true,
    organizationId: orgId,
    userId: "user-1",
    apiKeyId,
    scope: undefined,
  });
  vi.mocked(authenticateOAuthToken).mockResolvedValue({
    authenticated: false,
    organizationId: undefined,
    userId: undefined,
    scope: undefined,
    error: "not oauth",
    statusCode: 401,
  });
}

function mockAuthFail(): void {
  vi.mocked(authenticateApiKey).mockResolvedValue({
    authenticated: false,
    organizationId: undefined,
    userId: undefined,
    apiKeyId: undefined,
    scope: undefined,
    error: "invalid_token",
    statusCode: 401,
  });
  vi.mocked(authenticateOAuthToken).mockResolvedValue({
    authenticated: false,
    organizationId: undefined,
    userId: undefined,
    scope: undefined,
    error: "not oauth",
    statusCode: 401,
  });
}

describe("OPTIONS /mcp/w/[slug]", () => {
  it("returns 204 with CORS headers", () => {
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("POST /mcp/w/[slug] — listing resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransportHandleRequest.mockResolvedValue(
      new Response("{}", { status: 200 })
    );
  });

  it("returns 404 when slug is unknown", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const req = makeInitializeRequest();
    const res = await POST(req, makeParams("unknown-slug"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Workflow not found");
  });

  it("returns 404 when workflow exists but isListed is false", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: false } as never,
    });

    const req = makeInitializeRequest();
    const res = await POST(req, makeParams("my-workflow"));
    expect(res.status).toBe(404);
  });

  it("returns 401 with WWW-Authenticate when bearer is missing/invalid", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthFail();

    const req = makeInitializeRequest("Bearer bad_token");
    const res = await POST(req, makeParams());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("returns 200 for valid bearer + listed workflow initialize request", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthSuccess();

    const req = makeInitializeRequest();
    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);
  });

  it("cross-org bearer + listed workflow returns 200 (cross-org allowed when listed)", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthSuccess("org-different");

    const req = makeInitializeRequest("Bearer kh_other_org_key");
    const res = await POST(req, makeParams());
    expect(res.status).toBe(200);
  });

  it("cross-org bearer + unlisted workflow returns 404 (defensive)", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });
    mockAuthSuccess("org-different");

    const req = makeInitializeRequest("Bearer kh_other_org_key");
    const res = await POST(req, makeParams("unlisted-slug"));
    expect(res.status).toBe(404);
  });

  it("returns JSON-RPC -32003 (session_not_initialized) for non-initialize POST without session ID", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthSuccess();

    const req = new Request("http://localhost/mcp/w/my-workflow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer kh_test",
      },
      body: JSON.stringify({ method: "tools/list", id: 2, jsonrpc: "2.0" }),
    });

    const res = await POST(req, makeParams());
    // -32003 maps to HTTP 400 per SESSION_ERROR_DESCRIPTORS.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { reason: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32_003);
    expect(body.error.data.reason).toBe("session_not_initialized");
  });
});

describe("GET /mcp/w/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for unknown slug", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const req = new Request("http://localhost/mcp/w/unknown", {
      method: "GET",
      headers: { Authorization: "Bearer kh_test" },
    });
    const res = await GET(req, makeParams("unknown"));
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated GET on listed workflow", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthFail();

    const req = new Request("http://localhost/mcp/w/my-workflow", {
      method: "GET",
      headers: { Authorization: "Bearer invalid" },
    });
    const res = await GET(req, makeParams());
    expect(res.status).toBe(401);
  });

  it("returns JSON-RPC -32004 (missing_session_id) when mcp-session-id header is missing", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthSuccess();

    const req = new Request("http://localhost/mcp/w/my-workflow", {
      method: "GET",
      headers: { Authorization: "Bearer kh_test" },
    });
    const res = await GET(req, makeParams());
    // -32004 maps to HTTP 400 per SESSION_ERROR_DESCRIPTORS.
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string; data: { reason: string } };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32_004);
    expect(body.error.data.reason).toBe("missing_session_id");
  });
});

describe("DELETE /mcp/w/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for unknown slug", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: false,
      error: "NOT_FOUND",
    });

    const req = new Request("http://localhost/mcp/w/unknown", {
      method: "DELETE",
      headers: { Authorization: "Bearer kh_test" },
    });
    const res = await DELETE(req, makeParams("unknown"));
    expect(res.status).toBe(404);
  });

  it("returns 401 for unauthenticated DELETE", async () => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthFail();

    const req = new Request("http://localhost/mcp/w/my-workflow", {
      method: "DELETE",
      headers: { Authorization: "Bearer invalid" },
    });
    const res = await DELETE(req, makeParams());
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp/w/[slug] — tools/call argument normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransportHandleRequest.mockResolvedValue(
      new Response("{}", { status: 200 })
    );
  });

  // Every tools/call on this route arrives with a session header, so the
  // session branch is the only path that matters here - and it used to hand
  // the live Request to the SDK, where `arguments: null` became an opaque
  // -32603.
  it.each([
    ["explicitly null", true],
    ["omitted entirely", false],
  ])("defaults tools/call arguments to {} when %s, before the transport sees it", async (_label, includeNullArguments) => {
    vi.mocked(getWorkflowListing).mockResolvedValue({
      ok: true,
      listing: { ...makeListing(), isListed: true } as never,
    });
    mockAuthSuccess();
    vi.mocked(getSession).mockReturnValue({
      organizationId: "org-x",
      transport: { handleRequest: mockTransportHandleRequest },
    } as never);

    const params: Record<string, unknown> = { name: "call_workflow" };
    if (includeNullArguments) {
      params.arguments = null;
    }
    const req = new Request("http://localhost/mcp/w/my-workflow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer kh_test",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "session-abc",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params,
      }),
    });
    await POST(req, makeParams());

    expect(mockTransportHandleRequest).toHaveBeenCalledTimes(1);
    const [, options] = mockTransportHandleRequest.mock.calls[0] as unknown as [
      Request,
      { parsedBody: { params: { arguments: unknown } } },
    ];
    expect(options.parsedBody.params.arguments).toEqual({});
  });
});
