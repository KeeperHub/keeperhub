import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "org-123";
const USER_ID = "user-123";

const {
  mockResolveOrganizationId,
  mockGetSession,
  mockGetOrgContext,
  mockOrgKeysFindMany,
  mockCountWhere,
  mockCreatorsWhere,
  mockInsertReturning,
  mockUpdateReturning,
  mockAuthorizeAction,
} = vi.hoisted(() => ({
  mockResolveOrganizationId: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetOrgContext: vi.fn(),
  mockOrgKeysFindMany: vi.fn(),
  mockCountWhere: vi.fn(),
  mockCreatorsWhere: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockUpdateReturning: vi.fn(),
  mockAuthorizeAction: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/middleware/auth-helpers")>();
  return { ...actual, resolveOrganizationId: mockResolveOrganizationId };
});

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction: mockAuthorizeAction,
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getOrgContext: mockGetOrgContext,
}));

vi.mock("@/lib/security/api-key-notification", () => ({
  notifyApiKeyChange: vi.fn(),
}));

vi.mock("@/lib/security/audit-log", () => ({
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
  buildAuditMetadata: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizationApiKeys: { findMany: mockOrgKeysFindMany },
    },
    // GET runs a COUNT (select().from().where()) then a creator lookup
    // (select().from().leftJoin().where()); both branch off the same select.
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockCountWhere,
        leftJoin: vi.fn(() => ({
          where: mockCreatorsWhere,
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: mockInsertReturning,
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: mockUpdateReturning,
        })),
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organizationApiKeys: {
    id: "id",
    organizationId: "organization_id",
    name: "name",
    keyHash: "key_hash",
    keyPrefix: "key_prefix",
    createdBy: "created_by",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
    expiresAt: "expires_at",
    revokedAt: "revoked_at",
  },
  users: {
    id: "id",
    name: "name",
    email: "email",
  },
  member: {
    userId: "user_id",
    organizationId: "organization_id",
    role: "role",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { DELETE } from "@/app/api/keys/[keyId]/route";
import { GET, POST } from "@/app/api/keys/route";

function createRequest(
  method: string,
  body?: Record<string, unknown>
): Request {
  const url = "http://localhost:3000/api/keys";
  const init: RequestInit = { method, headers: {} };
  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function createDeleteContext(keyId: string): {
  params: Promise<{ keyId: string }>;
} {
  return { params: Promise.resolve({ keyId }) };
}

describe("GET /api/keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 when not authenticated", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      error: "Unauthorized",
      code: "unauthorized",
      status: 401,
    });

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("unauthorized");
    expect(data.detail).toBe("Unauthorized");
    expect(response.headers.get("x-request-id")).toBe(data.request_id);
  });

  it("should return 400 when no active organization", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      error: "No active organization",
      code: "invalid_input",
      status: 400,
    });

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("invalid_input");
    expect(data.detail).toBe("No active organization");
  });

  it("should return org keys with creator names", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockOrgKeysFindMany.mockResolvedValue([
      {
        id: "key-1",
        name: "Production Key",
        keyPrefix: "kh_abc12",
        createdBy: USER_ID,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-03-01T00:00:00.000Z",
        expiresAt: null,
      },
      {
        id: "key-2",
        name: "MCP Key",
        keyPrefix: "kh_xyz98",
        createdBy: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        lastUsedAt: null,
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    ]);
    mockCountWhere.mockResolvedValue([{ total: 2 }]);
    mockCreatorsWhere.mockResolvedValue([
      { id: USER_ID, name: "Test User", email: "test@test.com", role: "owner" },
    ]);

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items).toHaveLength(2);
    expect(data.items[0].createdByName).toBe("Test User");
    expect(data.items[0].createdBy).toBeUndefined();
    expect(data.items[1].createdByName).toBeNull();
  });

  it("should return empty items when org has no keys", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockCountWhere.mockResolvedValue([{ total: 0 }]);
    mockOrgKeysFindMany.mockResolvedValue([]);

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items).toEqual([]);
  });

  it("should return 500 on database error", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockCountWhere.mockResolvedValue([{ total: 0 }]);
    mockOrgKeysFindMany.mockRejectedValue(new Error("DB connection failed"));

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(500);
  });
});

describe("POST /api/keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeAction.mockResolvedValue({ ok: true });
  });

  it("should return 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(401);
  });

  it("should return 400 when no active organization", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID, name: "Test User", email: "test@test.com" },
    });
    mockGetOrgContext.mockResolvedValue({ organization: null });

    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("No active organization");
  });

  it("should return 403 for anonymous user by name", async () => {
    mockAuthorizeAction.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Anonymous users cannot perform this action" }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      ),
    });
    mockGetSession.mockResolvedValue({
      user: { id: "anon-1", name: "Anonymous", email: "real@test.com" },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: ORG_ID },
    });

    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toBe("Anonymous users cannot perform this action");
  });

  it("should return 403 for anonymous user by temp email", async () => {
    mockAuthorizeAction.mockResolvedValue({
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Anonymous users cannot perform this action" }),
        { status: 403 }
      ),
    });
    mockGetSession.mockResolvedValue({
      user: { id: "anon-2", name: "Some User", email: "temp-abc@test.com" },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: ORG_ID },
    });

    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(403);
  });

  it("should create kh_ key with name", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID, name: "Test User", email: "test@test.com" },
      session: { requiresMfa: false },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: ORG_ID },
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-key-id",
        name: "Production Key",
        keyPrefix: "kh_abc12",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
      },
    ]);

    const response = await POST(
      createRequest("POST", { name: "Production Key", code: "123456" })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe("new-key-id");
    expect(data.name).toBe("Production Key");
    expect(data.key).toBeDefined();
    expect(data.key.startsWith("kh_")).toBe(true);
  });

  it("should create kh_ key with expiration", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID, name: "Test User", email: "test@test.com" },
      session: { requiresMfa: false },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: ORG_ID },
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-key-id",
        name: "Expiring Key",
        keyPrefix: "kh_xyz98",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
      },
    ]);

    const response = await POST(
      createRequest("POST", {
        name: "Expiring Key",
        expiresAt: "2027-01-01T00:00:00.000Z",
        code: "123456",
      })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.key.startsWith("kh_")).toBe(true);
    expect(data.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  it("should return 500 on database error", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID, name: "Test User", email: "test@test.com" },
      session: { requiresMfa: false },
    });
    mockGetOrgContext.mockResolvedValue({
      organization: { id: ORG_ID },
    });
    mockInsertReturning.mockRejectedValue(new Error("Insert failed"));

    const response = await POST(
      createRequest("POST", { name: "Test", code: "123456" })
    );
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Insert failed");
  });
});

describe("DELETE /api/keys/:keyId (revoke)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthorizeAction.mockResolvedValue({ ok: true });
  });

  it("should return 401 when not authenticated", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      error: "Unauthorized",
      code: "unauthorized",
      status: 401,
    });

    const response = await DELETE(
      createRequest("DELETE"),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(401);
  });

  it("should revoke key belonging to org", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { requiresMfa: false },
    });
    mockUpdateReturning.mockResolvedValue([{ id: "key-1" }]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it("should return 404 when key not found", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { requiresMfa: false },
    });
    mockUpdateReturning.mockResolvedValue([]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("nonexistent")
    );
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("API key not found");
  });

  it("should return 404 when key belongs to different org", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { requiresMfa: false },
    });
    mockUpdateReturning.mockResolvedValue([]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("other-org-key")
    );
    expect(response.status).toBe(404);
  });

  it("should return 500 on database error", async () => {
    mockResolveOrganizationId.mockResolvedValue({
      organizationId: ORG_ID,
    });
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { requiresMfa: false },
    });
    mockUpdateReturning.mockRejectedValue(new Error("Update failed"));

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Update failed");
  });
});
