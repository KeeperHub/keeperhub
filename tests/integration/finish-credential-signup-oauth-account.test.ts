/**
 * Covers the OAuth-only backstop on POST /api/auth/finish-credential-signup.
 *
 * Run with: pnpm vitest tests/integration/finish-credential-signup-oauth-account.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { queue, mockVerifyPassword } = vi.hoisted(() => ({
  queue: [] as unknown[][],
  mockVerifyPassword: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: {
    id: "id",
    email: "email",
    emailVerified: "emailVerified",
    twoFactorEnabled: "twoFactorEnabled",
  },
  accounts: {
    userId: "userId",
    providerId: "providerId",
    password: "password",
  },
}));

vi.mock("drizzle-orm", () => ({ eq: () => ({}), and: () => ({}) }));

vi.mock("@/lib/password", () => ({ verifyPassword: mockVerifyPassword }));

vi.mock("@/lib/security/login-risk", () => ({
  resolveClientIpFromHeaders: () => "127.0.0.1",
}));

vi.mock("@/app/api/auth/_lib/credential-attempt-rate-limit", () => ({
  checkCredentialAttemptRateLimit: () => ({ allowed: true }),
}));

vi.mock("@/lib/pending-signup-cookie", () => ({
  buildPendingSignupSetCookie: () => "pending=1",
  encodePendingSignupCookie: () => "encoded",
}));

import { POST } from "@/app/api/auth/finish-credential-signup/route";

type Body = { error?: string; code?: string; redirect?: string };

function post(): Promise<Response> {
  return POST(
    new Request("http://localhost/api/auth/finish-credential-signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "oauth@example.com",
        password: "SomePassword123!",
      }),
    })
  );
}

const VERIFIED_USER = {
  id: "user-1",
  email: "oauth@example.com",
  emailVerified: true,
  twoFactorEnabled: false,
};

describe("POST /api/auth/finish-credential-signup", () => {
  beforeEach(() => {
    queue.length = 0;
    vi.clearAllMocks();
    process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-chars-long!!";
  });

  it("tells an OAuth-only caller to use their social login instead of failing generically", async () => {
    queue.push([VERIFIED_USER], []);

    const response = await post();
    expect(response.status).toBe(401);
    const body = (await response.json()) as Body;
    expect(body.code).toBe("oauth_account");
    expect(body.error).toContain("social login");
  });

  it("still returns the generic invalid_state when the password is wrong", async () => {
    queue.push([VERIFIED_USER], [{ password: "hashed" }]);
    mockVerifyPassword.mockResolvedValueOnce(false);

    const response = await post();
    expect(response.status).toBe(401);
    const body = (await response.json()) as Body;
    expect(body.code).toBe("invalid_state");
  });

  it("issues the pending-signup cookie when the credential password matches", async () => {
    queue.push([VERIFIED_USER], [{ password: "hashed" }]);
    mockVerifyPassword.mockResolvedValueOnce(true);

    const response = await post();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Body;
    expect(body.redirect).toBe("/enroll-mfa");
    expect(response.headers.get("Set-Cookie")).toContain("pending=1");
  });
});
