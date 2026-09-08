import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSelectLimit, mockUpdate, mockCaptureMessage } = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockUpdate: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
  mockCaptureMessage: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(function leftJoin() {
          return {
            leftJoin,
            where: vi.fn(() => ({
              limit: mockSelectLimit,
            })),
          };
        }),
      })),
    })),
    update: mockUpdate,
  },
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "id",
    organizationId: "organization_id",
    userId: "user_id",
  },
  organizationApiKeys: {
    id: "id",
    organizationId: "organization_id",
    keyHash: "key_hash",
    revokedAt: "revoked_at",
    expiresAt: "expires_at",
    createdBy: "created_by",
  },
  users: {
    id: "id",
    deactivatedAt: "deactivated_at",
    isAnonymous: "is_anonymous",
    name: "name",
    email: "email",
  },
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

import { authenticateApiKey } from "@/lib/api-key-auth";

const VALID_KEY = "kh_test_secret_value_12345";

function buildRequest(): Request {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateApiKey -- anonymous creator handling", () => {
  it("rejects a key whose creator is flagged isAnonymous", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "anon-1",
        creatorDeactivatedAt: null,
        creatorIsAnonymous: true,
        creatorName: "Anonymous",
        creatorEmail: "temp-abc@example.com",
        creatorMemberId: "member-1",
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toBe("Anonymous accounts cannot use API keys");
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      "security.anonymous_execution_blocked",
      expect.objectContaining({
        tags: { security: "anonymous_execution_blocked", surface: "api_key" },
      })
    );
  });

  it("rejects a key whose creator only matches the anonymous shape", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "anon-2",
        creatorDeactivatedAt: null,
        creatorIsAnonymous: false,
        creatorName: "Anonymous",
        creatorEmail: "temp-xyz@example.com",
        creatorMemberId: "member-1",
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("authenticates a key whose creator is a real (non-anonymous) user", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "user-1",
        creatorDeactivatedAt: null,
        creatorIsAnonymous: false,
        creatorName: "Real User",
        creatorEmail: "real@example.com",
        creatorMemberId: "member-1",
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.organizationId).toBe("org-1");
    expect(result.userId).toBe("user-1");
  });

  it("authenticates a legacy key with no recorded creator", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-legacy",
        organizationId: "org-1",
        createdBy: null,
        creatorDeactivatedAt: null,
        creatorIsAnonymous: null,
        creatorName: null,
        creatorEmail: null,
        creatorMemberId: null,
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBeUndefined();
  });

  it("sanity: VALID_KEY hashes to a 64-char hex digest", () => {
    expect(createHash("sha256").update(VALID_KEY).digest("hex")).toMatch(
      /^[a-f0-9]{64}$/
    );
  });
});
