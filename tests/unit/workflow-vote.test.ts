/**
 * Unit tests for workflow vote API route
 *
 * Tests auth, validation, toggle behavior, and anonymous user rejection.
 * Happy-path DB interactions are covered by integration tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

// Mock database - return empty arrays by default (no duplication found)
vi.mock("@/lib/db", () => {
  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    groupBy: vi.fn().mockResolvedValue([{ score: "0" }]),
  };
  return {
    db: {
      select: vi.fn().mockReturnValue(chainable),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue(undefined),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    },
  };
});

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((_error: unknown, context: string) => {
    const { NextResponse: NR } = require("next/server");
    return NR.json({ error: context }, { status: 500 });
  }),
}));

import { POST } from "@/app/api/workflows/[workflowId]/rate/route";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

const mockGetSession = auth.api.getSession as unknown as ReturnType<
  typeof vi.fn
>;

// Access the chainable mock returned by db.select()
function getMockChainable(): { limit: ReturnType<typeof vi.fn> } {
  return (db.select as unknown as () => { limit: ReturnType<typeof vi.fn> })();
}

function makeRequest(body?: Record<string, unknown>): Request {
  return new Request("http://localhost/api/workflows/wf_123/rate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function makeParams(workflowId = "wf_123"): {
  params: Promise<{ workflowId: string }>;
} {
  return { params: Promise.resolve({ workflowId }) };
}

const mockUser = {
  id: "user_123",
  email: "test@example.com",
  name: "Test User",
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockSession = {
  id: "session_123",
  createdAt: new Date(),
  updatedAt: new Date(),
  userId: "user_123",
  expiresAt: new Date(Date.now() + 86_400_000),
  token: "test-token",
  user: mockUser,
};

describe("POST /api/workflows/[workflowId]/rate (vote)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mockGetSession.mockResolvedValue(null);

    const response = await POST(makeRequest({ vote: "upvote" }), makeParams());
    expect(response.status).toBe(401);
  });

  it("returns 403 for anonymous users", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    // First db.select().limit() returns the user record with isAnonymous: true
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: true }]);

    const response = await POST(makeRequest({ vote: "upvote" }), makeParams());
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain("Sign in with a real account");
  });

  it("returns 400 for missing vote", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);

    const response = await POST(makeRequest({}), makeParams());
    expect(response.status).toBe(400);
  });

  it("returns 400 for numeric vote value", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);

    const response = await POST(makeRequest({ vote: 1 }), makeParams());
    expect(response.status).toBe(400);
  });

  it("returns 400 for arbitrary number", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);

    const response = await POST(makeRequest({ vote: 88 }), makeParams());
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid string direction", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);

    const response = await POST(
      makeRequest({ vote: "sideways" }),
      makeParams()
    );
    expect(response.status).toBe(400);
  });

  it("returns 403 when user has not duplicated the workflow", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    // First limit() = user record (not anonymous), second limit() = no duplication (default [])
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);

    const response = await POST(makeRequest({ vote: "upvote" }), makeParams());
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toContain("must use this template");
  });

  it("accepts upvote and passes validation gate", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    // First limit() = user record, second limit() = duplication found
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);
    getMockChainable().limit.mockResolvedValueOnce([{ id: "dup_1" }]);

    const response = await POST(makeRequest({ vote: "upvote" }), makeParams());
    expect(response.status).not.toBe(400);
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("accepts downvote and passes validation gate", async () => {
    mockGetSession.mockResolvedValue(mockSession);
    getMockChainable().limit.mockResolvedValueOnce([{ isAnonymous: false }]);
    getMockChainable().limit.mockResolvedValueOnce([{ id: "dup_1" }]);

    const response = await POST(
      makeRequest({ vote: "downvote" }),
      makeParams()
    );
    expect(response.status).not.toBe(400);
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});
