/**
 * Integration tests for /api/integrations error envelope (KEEP-489).
 *
 * Verifies the seed adoption of `apiError()`:
 * - Unauthenticated GET returns 401 with the {error, detail, hint,
 *   request_id} envelope shape.
 * - `request_id` is present and either UUIDv4 or the x-request-id header
 *   the client sent.
 * - No legacy `message` field appears.
 * - x-request-id round-trips on the response header.
 *
 * Run with: pnpm vitest tests/integration/integrations-route-envelope.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockGetDualAuthContext, mockGetIntegrations } = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
  mockGetIntegrations: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mockGetDualAuthContext,
}));

vi.mock("@/lib/db/integrations", () => ({
  createIntegration: vi.fn(),
  ensureWalletIntegration: vi.fn(),
  getIntegrations: mockGetIntegrations,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET, POST } from "@/app/api/integrations/route";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EnvelopeBody = {
  error: string;
  detail: string;
  hint?: string;
  docs?: string;
  request_id: string;
  message?: unknown;
};

function createRequest(init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Request {
  return new Request("http://localhost:3000/api/integrations", {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
}

describe("GET /api/integrations envelope (KEEP-489)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 with envelope shape when unauthenticated", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await GET(createRequest());
    const body = (await response.json()) as EnvelopeBody;

    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(typeof body.detail).toBe("string");
    expect(body.detail.length).toBeGreaterThan(0);
    expect(typeof body.hint).toBe("string");
    expect(typeof body.request_id).toBe("string");
    expect(body.request_id.length).toBeGreaterThan(0);
    // Legacy shape must NOT appear.
    expect(body.message).toBeUndefined();
    expect((body as Record<string, unknown>).code).toBeUndefined();
  });

  it("emits a UUID request_id when no x-request-id header is sent", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const response = await GET(createRequest());
    const body = (await response.json()) as EnvelopeBody;

    expect(UUID_REGEX.test(body.request_id)).toBe(true);
    // Echoed on response header for client correlation.
    expect(response.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("round-trips x-request-id from request header to response body + header", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const traceId = `test-${crypto.randomUUID()}`;
    const response = await GET(
      createRequest({
        headers: { "x-request-id": traceId },
      })
    );
    const body = (await response.json()) as EnvelopeBody;

    expect(body.request_id).toBe(traceId);
    expect(response.headers.get("x-request-id")).toBe(traceId);
  });

  it("returns 401 envelope when auth context has neither user nor org", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: undefined,
      organizationId: undefined,
    });

    const response = await GET(createRequest());
    const body = (await response.json()) as EnvelopeBody;

    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(typeof body.request_id).toBe("string");
    expect(body.message).toBeUndefined();
  });
});

describe("POST /api/integrations envelope (KEEP-489)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 envelope when unauthenticated, with request_id round-trip", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });

    const traceId = "client-trace-99";
    const response = await POST(
      createRequest({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-request-id": traceId,
        },
        body: { type: "web3", config: {} },
      })
    );
    const body = (await response.json()) as EnvelopeBody;

    expect(response.status).toBe(401);
    expect(body.error).toBe("unauthorized");
    expect(body.request_id).toBe(traceId);
    expect(response.headers.get("x-request-id")).toBe(traceId);
    expect(body.message).toBeUndefined();
  });

  it("returns 400 envelope for missing type/config", async () => {
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user-1",
      organizationId: "org-1",
    });

    const response = await POST(
      createRequest({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {},
      })
    );
    const body = (await response.json()) as EnvelopeBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_input");
    expect(typeof body.request_id).toBe("string");
    expect(UUID_REGEX.test(body.request_id)).toBe(true);
  });
});
