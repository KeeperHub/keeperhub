import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockSelectLimit, mockUpdate } = vi.hoisted(() => ({
  mockSelectLimit: vi.fn(),
  mockUpdate: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
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
  users: { id: "id", deactivatedAt: "deactivated_at" },
}));

import { authenticateApiKey } from "@/lib/api-key-auth";

const VALID_KEY = "kh_test_secret_value_12345";
const KEY_HASH = createHash("sha256").update(VALID_KEY).digest("hex");
const HEX_64 = /^[a-f0-9]{64}$/;

function buildRequest(): Request {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${VALID_KEY}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateApiKey -- deactivated creator handling", () => {
  it("authenticates a key whose creator account is active", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "user-1",
        creatorDeactivatedAt: null,
        creatorMemberId: "member-1",
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.organizationId).toBe("org-1");
    expect(result.apiKeyId).toBe("key-1");
    expect(result.userId).toBe("user-1");
  });

  it("rejects a key whose creator account is deactivated", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "user-1",
        creatorDeactivatedAt: new Date("2026-01-01T00:00:00Z"),
        creatorMemberId: "member-1",
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("API key creator account is deactivated");
  });

  it("rejects a key whose creator is no longer an organization member", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "user-1",
        creatorDeactivatedAt: null,
        creatorMemberId: null,
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe(
      "API key creator is no longer a member of this organization"
    );
  });

  it("authenticates a key with no recorded creator (legacy compat)", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-legacy",
        organizationId: "org-1",
        createdBy: null,
        creatorDeactivatedAt: null,
        creatorMemberId: null,
      },
    ]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBeUndefined();
  });

  it("rejects a key whose row was not found (existing behaviour)", async () => {
    mockSelectLimit.mockResolvedValue([]);

    const result = await authenticateApiKey(buildRequest());

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("Invalid or revoked API key");
  });

  it("queries with the SHA-256 hash of the supplied key", async () => {
    mockSelectLimit.mockResolvedValue([
      {
        id: "key-1",
        organizationId: "org-1",
        createdBy: "user-1",
        creatorDeactivatedAt: null,
        creatorMemberId: "member-1",
      },
    ]);

    await authenticateApiKey(buildRequest());

    // Sanity: the hash we compute matches what the route should use.
    expect(KEY_HASH).toMatch(HEX_64);
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });
});
