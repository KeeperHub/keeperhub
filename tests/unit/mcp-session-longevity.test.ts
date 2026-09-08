import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSessionToken,
  MAX_RENEWAL_GRACE_SECONDS,
  MAX_SESSION_LIFETIME_SECONDS,
  SESSION_TTL_SECONDS,
  verifySessionToken,
  verifySessionTokenDetailed,
} from "@/lib/mcp/session-token";
import { SESSION_TTL_MS } from "@/lib/mcp/sessions";

const TEST_SECRET = "test-session-secret-for-unit-tests";

beforeEach(() => {
  process.env.MCP_SESSION_SECRET = TEST_SECRET;
});

afterEach(() => {
  delete process.env.MCP_SESSION_SECRET;
});

describe("TTL constants", () => {
  it("SESSION_TTL_SECONDS is 86400 (24 hours)", () => {
    expect(SESSION_TTL_SECONDS).toBe(86_400);
  });

  it("SESSION_TTL_MS is 86400000 (24 hours)", () => {
    expect(SESSION_TTL_MS).toBe(86_400_000);
  });
});

describe("createSessionToken produces 24-hour expiry", () => {
  it("sets exp = iat + 86400", async () => {
    const token = await createSessionToken({
      org: "org-1",
      key: "key-1",
      scope: "read",
    });

    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).not.toBeNull();
    if (!result.payload) {
      return;
    }

    expect(result.expired).toBe(false);
    expect(result.payload.exp - result.payload.iat).toBe(86_400);
  });
});

/**
 * Creates a token then re-signs it with modified claims.
 * `overrides` is merged into the decoded JWT body before re-signing.
 */
async function createTokenWithOverrides(
  overrides: Record<string, unknown>
): Promise<string> {
  const token = await createSessionToken({
    org: "org-1",
    key: "key-1",
    scope: "read",
  });

  const parts = token.split(".");
  const header = parts[0];
  const body = JSON.parse(
    Buffer.from(
      parts[1].replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8")
  );

  for (const [k, v] of Object.entries(overrides)) {
    if (v === null) {
      delete body[k];
    } else {
      body[k] = v;
    }
  }

  const newBody = Buffer.from(JSON.stringify(body))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const signingInput = `${header}.${newBody}`;
  const signature = createHmac("sha256", TEST_SECRET)
    .update(signingInput)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${signingInput}.${signature}`;
}

async function createTokenExpiredAgo(hoursAgo: number): Promise<string> {
  return await createTokenWithOverrides({
    exp: Math.floor(Date.now() / 1000) - hoursAgo * 60 * 60,
  });
}

describe("verifySessionToken with expired but valid signature", () => {
  it("returns null by default for expired tokens", async () => {
    const token = await createTokenExpiredAgo(25);
    const result = await verifySessionToken(token);
    expect(result).toBeNull();
  });

  it("returns payload with allowExpired for expired but valid signature", async () => {
    const token = await createTokenExpiredAgo(25);
    const result = await verifySessionToken(token, { allowExpired: true });
    expect(result).not.toBeNull();
    expect(result?.org).toBe("org-1");
    expect(result?.key).toBe("key-1");
  });

  it("verifySessionTokenDetailed marks token as expired", async () => {
    const token = await createTokenExpiredAgo(25);
    const result = await verifySessionTokenDetailed(token);
    expect(result.expired).toBe(true);
    expect(result.payload).not.toBeNull();
    expect(result.payload?.org).toBe("org-1");
  });
});

describe("renewal grace window", () => {
  it("MAX_RENEWAL_GRACE_SECONDS is 172800 (48 hours)", () => {
    expect(MAX_RENEWAL_GRACE_SECONDS).toBe(172_800);
  });

  it("accepts expired token within grace window", async () => {
    const token = await createTokenExpiredAgo(47);
    const result = await verifySessionTokenDetailed(token);
    expect(result.expired).toBe(true);
    expect(result.payload).not.toBeNull();
  });

  it("rejects expired token beyond grace window as too_old", async () => {
    const token = await createTokenExpiredAgo(49);
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("too_old");
    }
  });

  it("verifySessionToken returns null for too_old tokens even with allowExpired", async () => {
    const token = await createTokenExpiredAgo(49);
    const result = await verifySessionToken(token, { allowExpired: true });
    expect(result).toBeNull();
  });
});

describe("verifySessionToken rejects invalid signature", () => {
  it("returns null for tampered tokens", async () => {
    const token = await createSessionToken({
      org: "org-1",
      key: "key-1",
    });

    // Tamper with the signature
    const tampered = `${token.slice(0, -4)}XXXX`;
    const result = await verifySessionToken(tampered, { allowExpired: true });
    expect(result).toBeNull();
  });

  it("verifySessionTokenDetailed returns invalid_signature reason", async () => {
    const token = await createSessionToken({
      org: "org-1",
      key: "key-1",
    });

    const tampered = `${token.slice(0, -4)}XXXX`;
    const result = await verifySessionTokenDetailed(tampered);
    expect(result.payload).toBeNull();
    expect(result.expired).toBe(false);
    if (!result.payload) {
      expect(result.reason).toBe("invalid_signature");
    }
  });

  it("returns malformed for garbage input", async () => {
    const result = await verifySessionTokenDetailed("not-a-jwt");
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("malformed");
    }
  });
});

describe("verifySessionTokenDetailed wire compatibility", () => {
  /**
   * Builds a token exactly the way the pre-jose implementation did:
   * hand-rolled base64url + HMAC-SHA256, header literal `{"alg":"HS256","typ":"JWT"}`
   * with that key order. If this ever fails, it means in-flight tokens
   * minted by a previous deploy would stop verifying after this one, and
   * a rollback would stop verifying tokens minted under the current one.
   */
  function oldStyleToken(
    payload: Record<string, unknown>,
    secret: string
  ): string {
    const b64url = (s: string): string =>
      Buffer.from(s)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const signingInput = `${header}.${body}`;
    const signature = createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    return `${signingInput}.${signature}`;
  }

  it("verifies tokens produced by the pre-jose hand-rolled signer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = oldStyleToken(
      {
        org: "org-legacy",
        key: "key-legacy",
        scope: "read",
        iat: now,
        exp: now + 3600,
        original_iat: now,
      },
      TEST_SECRET
    );

    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).not.toBeNull();
    if (result.payload) {
      expect(result.payload.org).toBe("org-legacy");
      expect(result.payload.key).toBe("key-legacy");
      expect(result.expired).toBe(false);
    }
  });
});

describe("verifySessionTokenDetailed rejects alg:none attack", () => {
  it('treats a token with alg:"none" as malformed or invalid_signature', async () => {
    const b64url = (s: string): string =>
      Buffer.from(s)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = b64url(
      JSON.stringify({
        org: "org-attack",
        key: "key-attack",
        iat: now,
        exp: now + 3600,
      })
    );
    const unsignedToken = `${header}.${body}.`;

    const result = await verifySessionTokenDetailed(unsignedToken);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      // jose rejects wrong-alg tokens with JOSEAlgNotAllowed, which maps to
      // malformed in our catch. invalid_signature is acceptable too if the
      // mapping ever changes -- what matters is the token is rejected.
      expect(["malformed", "invalid_signature"]).toContain(result.reason);
    }
  });
});

describe("verifySessionTokenDetailed rejects malformed payloads", () => {
  it("returns malformed when org claim is the wrong type", async () => {
    const token = await createTokenWithOverrides({ org: 42 });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("malformed");
    }
  });

  it("returns malformed when a required claim is missing", async () => {
    const token = await createTokenWithOverrides({ key: null });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("malformed");
    }
  });
});

describe("verifySessionTokenDetailed handles config errors", () => {
  it("returns malformed when no session secret is configured", async () => {
    delete process.env.MCP_SESSION_SECRET;
    delete process.env.OAUTH_JWT_SECRET;
    delete process.env.BETTER_AUTH_SECRET;

    const result = await verifySessionTokenDetailed("any.token.here");
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("malformed");
    }
  });
});

describe("absolute max session lifetime", () => {
  it("MAX_SESSION_LIFETIME_SECONDS is 2592000 (30 days)", () => {
    expect(MAX_SESSION_LIFETIME_SECONDS).toBe(2_592_000);
  });

  it("accepts token with original_iat within 30 days", async () => {
    const twentyNineDaysAgo = Math.floor(Date.now() / 1000) - 29 * 24 * 60 * 60;
    const token = await createTokenWithOverrides({
      original_iat: twentyNineDaysAgo,
    });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).not.toBeNull();
    expect(result.expired).toBe(false);
  });

  it("rejects token with original_iat beyond 30 days", async () => {
    const thirtyOneDaysAgo = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
    const token = await createTokenWithOverrides({
      original_iat: thirtyOneDaysAgo,
    });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("max_lifetime_exceeded");
    }
  });

  it("falls back to iat when original_iat is absent", async () => {
    const thirtyOneDaysAgo = Math.floor(Date.now() / 1000) - 31 * 24 * 60 * 60;
    const token = await createTokenWithOverrides({
      iat: thirtyOneDaysAgo,
      exp: Math.floor(Date.now() / 1000) + 3600,
      original_iat: null,
    });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).toBeNull();
    if (!result.payload) {
      expect(result.reason).toBe("max_lifetime_exceeded");
    }
  });

  it("propagates original_iat through createSessionToken", async () => {
    const originalIat = Math.floor(Date.now() / 1000) - 86_400;
    const token = await createSessionToken({
      org: "org-1",
      key: "key-1",
      original_iat: originalIat,
    });
    const result = await verifySessionTokenDetailed(token);
    expect(result.payload).not.toBeNull();
    if (result.payload) {
      expect(result.payload.original_iat).toBe(originalIat);
    }
  });
});
