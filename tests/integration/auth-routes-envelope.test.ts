/**
 * Integration tests for auth route error envelopes (KEEP-489 / FRICTION-08).
 *
 * Run with: pnpm vitest tests/integration/auth-routes-envelope.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockCheckIpRateLimit, mockDbSelectLimit, mockVerifyPassword } =
  vi.hoisted(() => ({
    mockCheckIpRateLimit: vi.fn(),
    mockDbSelectLimit: vi.fn(),
    mockVerifyPassword: vi.fn(),
  }));

vi.mock("@/lib/mcp/rate-limit", () => ({
  checkIpRateLimit: mockCheckIpRateLimit,
  getClientIp: () => "127.0.0.1",
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mockDbSelectLimit,
          orderBy: () => ({
            limit: mockDbSelectLimit,
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  accounts: {
    userId: "userId",
    providerId: "providerId",
    password: "password",
  },
  users: {
    id: "id",
    email: "email",
    emailVerified: "emailVerified",
    twoFactorEnabled: "twoFactorEnabled",
    deactivatedAt: "deactivatedAt",
  },
  twoFactor: { userId: "userId", secret: "secret" },
  verifications: {
    identifier: "identifier",
    value: "value",
    expiresAt: "expiresAt",
  },
  sessions: { token: "token" },
  // oauth-store transitively imports these; present so cases that reach
  // getOAuthClient fail on assertions rather than missing exports.
  mcpOauthAuthCodes: {
    code: "code",
    expiresAt: "expiresAt",
    clientId: "clientId",
  },
  mcpOauthClients: {
    clientId: "clientId",
    clientSecretHash: "clientSecretHash",
  },
  mcpOauthRefreshTokens: {
    tokenHash: "tokenHash",
    userId: "userId",
    organizationId: "organizationId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  gt: () => ({}),
  lt: () => ({}),
  desc: () => ({}),
}));

vi.mock("@/lib/password", () => ({
  verifyPassword: mockVerifyPassword,
}));

vi.mock("@/lib/mfa/dual-factor-rate-limit", () => ({
  checkDualFactorRateLimit: () => ({ allowed: true }),
  resetDualFactor: vi.fn(),
}));

vi.mock("@/lib/security/totp-verify", () => ({
  verifyUserTotp: vi.fn(),
}));

vi.mock("@/lib/security/login-risk", () => ({
  assessCountryTrust: vi.fn(() => Promise.resolve({ trusted: true })),
  resolveClientIpFromHeaders: () => "127.0.0.1",
}));

vi.mock("@/lib/security/device-trust", () => ({
  resolveSigninDevice: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { signInEmail: vi.fn(), verifyTOTP: vi.fn() } },
}));

vi.mock("@/lib/auth-cookie-chain", () => ({
  readAllSetCookies: () => [],
  setCookiesToCookieHeader: () => "",
}));

vi.mock("@/lib/auth-session-token-hash", () => ({
  hashSessionToken: (token: string) => token,
}));

vi.mock("@/lib/pending-ip-cookie", () => ({
  buildPendingIpSetCookie: () => "",
  encodePendingIpCookie: () => "",
}));

vi.mock("@/app/api/auth/_lib/credential-attempt-rate-limit", () => ({
  checkCredentialAttemptRateLimit: () => ({ allowed: true }),
}));

vi.mock("@/lib/admin-auth", () => ({
  testEndpointsEnabled: () => false,
}));

vi.mock("better-auth/crypto", () => ({
  symmetricDecrypt: vi.fn(() => Promise.resolve("123456")),
}));

vi.mock("@/lib/rate-limit-headers", () => ({
  applyRateLimitHeaders: <T extends Response>(
    response: T,
    info: { retryAfter?: number }
  ): T => {
    if (info.retryAfter !== undefined) {
      response.headers.set("Retry-After", String(info.retryAfter));
    }
    return response;
  },
}));

vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordScanIntent: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      set: vi.fn(),
      get: vi.fn(),
    })
  ),
}));

import { POST as scanIntentPost } from "@/app/api/auth/scan-intent/route";
import { POST as strictSigninPost } from "@/app/api/auth/strict-signin/route";
import { POST as strictSigninStartPost } from "@/app/api/auth/strict-signin/start/route";
import { POST as oauthTokenPost } from "@/app/api/oauth/token/route";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EnvelopeBody = {
  error: string;
  detail: string;
  request_id: string;
  error_description?: string;
  hint?: string;
  docs?: string;
  code?: unknown;
  message?: unknown;
};

function buildRequest(
  url: string,
  init?: RequestInit,
  requestId?: string
): Request {
  const headers = new Headers(init?.headers);
  if (requestId) {
    headers.set("x-request-id", requestId);
  }
  return new Request(url, { ...init, headers });
}

describe("auth route error envelopes (FRICTION-08)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckIpRateLimit.mockReturnValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      reset: Math.floor(Date.now() / 1000) + 60,
    });
    mockDbSelectLimit.mockResolvedValue([]);
    mockVerifyPassword.mockResolvedValue(false);
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long!!";
  });

  it("POST /api/auth/scan-intent returns invalid_input envelope for empty body", async () => {
    const response = await scanIntentPost(
      buildRequest("http://localhost/api/auth/scan-intent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_input");
    expect(body.detail).toBe("intent is required");
    expect(typeof body.request_id).toBe("string");
    expect(UUID_REGEX.test(body.request_id)).toBe(true);
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  it("POST /api/auth/strict-signin/start returns envelope for missing credentials", async () => {
    const response = await strictSigninStartPost(
      buildRequest("http://localhost/api/auth/strict-signin/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "a@b.com" }),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("missing_credentials");
    expect(body.detail).toBe("Email and password are required");
    expect(typeof body.request_id).toBe("string");
    expect(body.code).toBeUndefined();
  });

  it("POST /api/oauth/token returns rate_limited envelope when IP limit exceeded", async () => {
    mockCheckIpRateLimit.mockReturnValue({
      allowed: false,
      retryAfter: 45,
      limit: 30,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 45,
    });

    const response = await oauthTokenPost(
      buildRequest("http://localhost/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token" }),
      })
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("rate_limited");
    expect(body.detail).toBe("Too many requests");
    expect(body.error_description).toBe(body.detail);
    expect(typeof body.request_id).toBe("string");
  });

  it("POST /api/auth/strict-signin/start returns invalid_signin envelope for unknown user", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    const response = await strictSigninStartPost(
      buildRequest("http://localhost/api/auth/strict-signin/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "nobody@example.com",
          password: "secret",
        }),
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_signin");
    expect(body.detail).toBe("Invalid sign-in");
    expect(typeof body.request_id).toBe("string");
  });

  it("POST /api/auth/strict-signin returns invalid_signin envelope for unknown user", async () => {
    mockDbSelectLimit.mockResolvedValueOnce([]);

    const response = await strictSigninPost(
      buildRequest("http://localhost/api/auth/strict-signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "nobody@example.com",
          password: "secret",
          emailOtp: "123456",
          totpCode: "654321",
        }),
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_signin");
    expect(body.detail).toBe("Invalid sign-in");
  });

  it("POST /api/auth/strict-signin returns invalid_email_otp envelope when OTP fails", async () => {
    mockDbSelectLimit
      .mockResolvedValueOnce([{ id: "user-1", email: "user@example.com" }])
      .mockResolvedValueOnce([{ password: "hashed" }])
      .mockResolvedValueOnce([]);
    mockVerifyPassword.mockResolvedValueOnce(true);

    const response = await strictSigninPost(
      buildRequest("http://localhost/api/auth/strict-signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "secret",
          emailOtp: "123456",
          totpCode: "654321",
        }),
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_email_otp");
    expect(body.detail).toBe("Invalid email code");
  });

  it("POST /api/auth/strict-signin returns invalid_totp envelope when TOTP fails", async () => {
    const { verifyUserTotp } = await import("@/lib/security/totp-verify");
    vi.mocked(verifyUserTotp).mockResolvedValueOnce(false);

    mockDbSelectLimit
      .mockResolvedValueOnce([{ id: "user-1", email: "user@example.com" }])
      .mockResolvedValueOnce([{ password: "hashed" }])
      .mockResolvedValueOnce([
        {
          id: "otp-row",
          value: "encrypted-otp",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ])
      .mockResolvedValueOnce([{ secret: "totp-secret" }]);
    mockVerifyPassword.mockResolvedValueOnce(true);

    const response = await strictSigninPost(
      buildRequest("http://localhost/api/auth/strict-signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "secret",
          emailOtp: "123456",
          totpCode: "654321",
        }),
      })
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_totp");
    expect(body.detail).toBe("Invalid authenticator code");
  });

  it("POST /api/oauth/token returns invalid_request envelope for missing code_verifier", async () => {
    const response = await oauthTokenPost(
      buildRequest("http://localhost/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "auth-code",
          client_id: "client-1",
          redirect_uri: "https://example.com/callback",
        }).toString(),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("invalid_request");
    expect(body.detail).toContain("code_verifier");
    expect(body.error_description).toBe(body.detail);
    expect(typeof body.request_id).toBe("string");
  });

  it("POST /api/oauth/token returns unsupported_grant_type for client_credentials", async () => {
    const response = await oauthTokenPost(
      buildRequest("http://localhost/api/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "client-1",
        }).toString(),
      })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as EnvelopeBody;
    expect(body.error).toBe("unsupported_grant_type");
    expect(body.error_description).toBe(body.detail);
  });
});
