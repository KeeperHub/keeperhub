import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSession = {
  user: {
    id: "user-123",
    name: "Test User",
    email: "test@techops.services",
  },
  session: { requiresMfa: false },
};

const {
  mockGetSession,
  mockFindMany,
  mockCountWhere,
  mockInsertReturning,
  mockDeleteReturning,
  mockAuthorizeAction,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockFindMany: vi.fn(),
  mockCountWhere: vi.fn(),
  mockInsertReturning: vi.fn(),
  mockDeleteReturning: vi.fn(),
  mockAuthorizeAction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

// The unified guard's internals are covered by tests/unit/authorize-action.test.ts;
// here we mock it so these tests focus on the route's CRUD + propagation.
vi.mock("@/lib/middleware/authorize-action", () => ({
  authorizeAction: mockAuthorizeAction,
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      apiKeys: {
        findMany: mockFindMany,
      },
    },
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: mockCountWhere,
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: mockInsertReturning,
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: mockDeleteReturning,
      })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  apiKeys: {
    id: "id",
    userId: "user_id",
    name: "name",
    keyHash: "key_hash",
    keyPrefix: "key_prefix",
    createdAt: "created_at",
    lastUsedAt: "last_used_at",
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { DELETE } from "@/app/api/api-keys/[keyId]/route";
import { GET, POST } from "@/app/api/api-keys/route";

function createRequest(
  method: string,
  body?: Record<string, unknown>
): Request {
  const url = "http://localhost:3000/api/api-keys";
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

describe("GET /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should return user's API keys", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    const mockKeys = [
      {
        id: "key-1",
        name: "My Key",
        keyPrefix: "wfb_abc1234",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: null,
      },
      {
        id: "key-2",
        name: null,
        keyPrefix: "wfb_xyz9876",
        createdAt: "2026-01-02T00:00:00.000Z",
        lastUsedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    mockCountWhere.mockResolvedValue([{ total: 2 }]);
    mockFindMany.mockResolvedValue(mockKeys);

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items).toEqual(mockKeys);
    expect(data.items).toHaveLength(2);
    expect(data.meta.total).toBe(2);
  });

  it("should return empty items when user has no keys", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockCountWhere.mockResolvedValue([{ total: 0 }]);
    mockFindMany.mockResolvedValue([]);

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.items).toEqual([]);
  });

  it("should return 500 on database error", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockCountWhere.mockResolvedValue([{ total: 0 }]);
    mockFindMany.mockRejectedValue(new Error("DB connection failed"));

    const response = await GET(createRequest("GET"));
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("DB connection failed");
  });
});

describe("POST /api/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(401);
  });

  it("propagates the guard's anonymous denial", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "anon-1", name: "Anonymous", email: "real@test.com" },
    });
    mockAuthorizeAction.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        {
          error: "Anonymous users cannot perform this action",
          code: "anonymous_forbidden",
        },
        { status: 403 }
      ),
    });
    const response = await POST(createRequest("POST", { name: "Test" }));
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.code).toBe("anonymous_forbidden");
  });

  it("should create API key with name", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-key-id",
        name: "My Key",
        keyPrefix: "wfb_abc1234",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const response = await POST(
      createRequest("POST", { name: "My Key", code: "123456" })
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.id).toBe("new-key-id");
    expect(data.name).toBe("My Key");
    expect(data.key).toBeDefined();
    expect(data.key.startsWith("wfb_")).toBe(true);
  });

  it("should create API key without name", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockInsertReturning.mockResolvedValue([
      {
        id: "new-key-id",
        name: null,
        keyPrefix: "wfb_abc1234",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const response = await POST(createRequest("POST", { code: "123456" }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.name).toBeNull();
    expect(data.key.startsWith("wfb_")).toBe(true);
  });

  it("should return 500 on database error", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
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

describe("DELETE /api/api-keys/:keyId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 401 when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await DELETE(
      createRequest("DELETE"),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(401);
  });

  it("should delete own key", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockDeleteReturning.mockResolvedValue([{ id: "key-1" }]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
  });

  it("should return 404 when key not found", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockDeleteReturning.mockResolvedValue([]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("nonexistent")
    );
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("API key not found");
  });

  it("should return 404 when key belongs to another user", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockDeleteReturning.mockResolvedValue([]);

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("other-user-key")
    );
    expect(response.status).toBe(404);
  });

  it("should return 500 on database error", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    mockAuthorizeAction.mockResolvedValue({
      ok: true,
      session: mockSession,
      accountKind: "email",
    });
    mockDeleteReturning.mockRejectedValue(new Error("Delete failed"));

    const response = await DELETE(
      createRequest("DELETE", { code: "123456" }),
      createDeleteContext("key-1")
    );
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe("Delete failed");
  });
});
