/**
 * MCP OAuth authorization codes are stored as sha256(code), matching the
 * refresh-token handling in the same module. A DB read alone must not yield a
 * replayable authorization code. storeAuthCode persists the hash; getAuthCode
 * looks up by hash and restores the raw code on the returned object so callers
 * keep their round-trip value.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Captured = {
  inserted: Record<string, unknown> | null;
  selectRow: Record<string, unknown> | null;
};

const captured: Captured = { inserted: null, selectRow: null };

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        captured.inserted = value;
        return Promise.resolve();
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(captured.selectRow ? [captured.selectRow] : []),
        }),
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  },
}));

import { getAuthCode, storeAuthCode } from "@/lib/mcp/oauth-store";

const RAW_CODE = "raw-authorization-code-value";
const CODE_HASH = createHash("sha256").update(RAW_CODE).digest("hex");

beforeEach(() => {
  captured.inserted = null;
  captured.selectRow = null;
});

describe("oauth-store authorization code hashing", () => {
  it("stores the sha256 hash, never the raw code", async () => {
    await storeAuthCode({
      code: RAW_CODE,
      clientId: "client-1",
      redirectUri: "https://example.com/cb",
      scope: "mcp:read",
      userId: "user-1",
      organizationId: "org-1",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + 100_000,
    });

    expect(captured.inserted?.code).toBe(CODE_HASH);
    expect(captured.inserted?.code).not.toBe(RAW_CODE);
  });

  it("restores the raw code on the object returned by getAuthCode", async () => {
    captured.selectRow = {
      code: CODE_HASH,
      clientId: "client-1",
      redirectUri: "https://example.com/cb",
      scope: "mcp:read",
      userId: "user-1",
      organizationId: "org-1",
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      expiresAt: new Date(Date.now() + 100_000),
    };

    const result = await getAuthCode(RAW_CODE);
    expect(result?.code).toBe(RAW_CODE);
  });
});
