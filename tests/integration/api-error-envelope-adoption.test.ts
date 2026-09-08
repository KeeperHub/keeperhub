/**
 * The documented contract for the routes an API-key integrator actually calls:
 * a stable code in `error`, the sentence in `detail`, a correlation id in the
 * body and on the response header.
 *
 * Run with: pnpm vitest tests/integration/api-error-envelope-adoption.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveOrganizationId } = vi.hoisted(() => ({
  mockResolveOrganizationId: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/middleware/auth-helpers")>();
  return { ...actual, resolveOrganizationId: mockResolveOrganizationId };
});

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({
  member: {},
  organizationApiKeys: {},
  users: {},
}));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  count: () => ({}),
  eq: () => ({}),
  inArray: () => ({}),
  isNull: () => ({}),
}));

import { GET } from "@/app/api/keys/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Envelope = {
  error?: string;
  detail?: string;
  request_id?: string;
};

function get(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request("http://localhost/api/keys", { headers }));
}

describe("GET /api/keys error envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveOrganizationId.mockResolvedValue({
      error: "Unauthorized",
      code: "unauthorized",
      status: 401,
    });
  });

  it("answers the documented envelope instead of a bare prose error", async () => {
    const response = await get();

    expect(response.status).toBe(401);
    const body = (await response.json()) as Envelope;
    // `error` is the stable code an integrator branches on, not a sentence.
    expect(body.error).toBe("unauthorized");
    expect(body.detail).toBe("Unauthorized");
    expect(body.request_id).toMatch(UUID);
  });

  it("echoes the correlation id on the response header", async () => {
    const response = await get();
    const body = (await response.json()) as Envelope;

    expect(response.headers.get("x-request-id")).toBe(body.request_id);
  });

  it("echoes an inbound request id rather than minting a new one", async () => {
    const inbound = "b3c1e2f0-2a4d-4a1e-9c3f-0f2b7c1d5e6a";
    const response = await get({ "x-request-id": inbound });
    const body = (await response.json()) as Envelope;

    expect(body.request_id).toBe(inbound);
    expect(response.headers.get("x-request-id")).toBe(inbound);
  });

  it("carries the code through for a non-auth rejection too", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      error: "No active organization",
      code: "invalid_input",
      status: 400,
    });

    const response = await get();
    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope;
    expect(body.error).toBe("invalid_input");
    expect(body.detail).toBe("No active organization");
  });
});
