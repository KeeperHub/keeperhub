// Better Auth's device plugin answers /device/token with a session token, which
// the CLI cannot use: it sends Authorization: Bearer, api-key-auth demands a
// kh_ prefix, and session tokens only authenticate as cookies. Widening bearer
// auth is closed off on purpose (the bearer() plugin was removed to keep the MFA
// and IP step-up gates intact), so the grant returns an org API key instead.
// These tests pin that swap, and pin that it never leaks a session token.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockHandlerPost,
  mockHandlerGet,
  mockIssueCliDeviceApiKey,
  mockHashSessionToken,
  sessionRows,
  userRows,
  selectCalls,
} = vi.hoisted(() => ({
  mockHandlerPost: vi.fn(),
  mockHandlerGet: vi.fn(),
  mockIssueCliDeviceApiKey: vi.fn(),
  mockHashSessionToken: vi.fn((token: string) => `hashed:${token}`),
  sessionRows: [] as Array<{
    userId: string;
    activeOrganizationId: string | null;
  }>,
  userRows: [] as Array<{ email: string | null }>,
  selectCalls: [] as unknown[],
}));

vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
}));

vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));

vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({ GET: mockHandlerGet, POST: mockHandlerPost }),
}));

vi.mock("@/lib/auth-session-token-hash", () => ({
  hashSessionToken: mockHashSessionToken,
}));

vi.mock("@/lib/organization-api-key", () => ({
  issueCliDeviceApiKey: mockIssueCliDeviceApiKey,
}));

// Two sequential selects run: the session row, then the user row.
let selectIndex = 0;
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((where: unknown) => ({
          limit: vi.fn(() => {
            selectCalls.push(where);
            const rows = selectIndex === 0 ? sessionRows : userRows;
            selectIndex += 1;
            return Promise.resolve(rows);
          }),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve(undefined)) })),
    })),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  sessions: {
    token: "sessions.token",
    userId: "sessions.userId",
    activeOrganizationId: "sessions.activeOrganizationId",
  },
  users: { id: "users.id", email: "users.email" },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { AUTH: "AUTH" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));

vi.mock("@/lib/security/audit-log", () => ({
  buildAuditMetadata: vi.fn(() => ({ ip: "203.0.113.1" })),
  recordAuditEvent: vi.fn(),
}));

vi.mock("@/lib/oauth-mfa-cookie", () => ({
  buildPendingOauthMfaSetCookie: vi.fn(),
  encodePendingOauthMfaCookie: vi.fn(),
}));

vi.mock("@/lib/pending-signup-cookie", () => ({
  buildPendingSignupSetCookie: vi.fn(),
  encodePendingSignupCookie: vi.fn(),
}));

vi.mock("@/lib/sanitize-next-path", () => ({ sanitizeNextPath: vi.fn() }));

const { POST } = await import("@/app/api/auth/[...all]/route");

const TOKEN_URL = "https://app.example.com/api/auth/device/token";

function postRequest(url: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "device_code" }),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  selectIndex = 0;
  selectCalls.length = 0;
  sessionRows.length = 0;
  userRows.length = 0;
  mockHandlerPost.mockReset();
  mockIssueCliDeviceApiKey.mockReset();
  mockIssueCliDeviceApiKey.mockResolvedValue("kh_generated_key");
  mockHandlerPost.mockResolvedValue(jsonResponse({ success: true }));
});

describe("device token - API key issuance", () => {
  it("returns an org API key instead of the session token", async () => {
    sessionRows.push({ userId: "user-1", activeOrganizationId: "org-1" });
    userRows.push({ email: "dev@example.com" });
    mockHandlerPost.mockResolvedValue(
      jsonResponse({
        access_token: "raw-session-token",
        token_type: "Bearer",
        scope: "",
      })
    );

    const res = await POST(postRequest(TOKEN_URL));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.access_token).toBe("kh_generated_key");
    // The session token must never reach the CLI - it is the credential the
    // whole defect is about.
    expect(JSON.stringify(body)).not.toContain("raw-session-token");
    // Unrelated fields from the grant response survive the swap.
    expect(body.scope).toBe("");
    expect(body.token_type).toBe("Bearer");
  });

  it("mints the key against the approving user and their active org", async () => {
    sessionRows.push({ userId: "user-1", activeOrganizationId: "org-1" });
    userRows.push({ email: "dev@example.com" });
    mockHandlerPost.mockResolvedValue(
      jsonResponse({ access_token: "raw-session-token" })
    );

    await POST(postRequest(TOKEN_URL));

    expect(mockIssueCliDeviceApiKey).toHaveBeenCalledWith({
      userId: "user-1",
      userEmail: "dev@example.com",
      organizationId: "org-1",
      auditMetadata: { ip: "203.0.113.1" },
    });
    // The session is found by hashed token, since that is how sessions are stored.
    expect(mockHashSessionToken).toHaveBeenCalledWith("raw-session-token");
  });

  it("fails the grant when the account has no active organization", async () => {
    sessionRows.push({ userId: "user-1", activeOrganizationId: null });
    mockHandlerPost.mockResolvedValue(
      jsonResponse({ access_token: "raw-session-token" })
    );

    const res = await POST(postRequest(TOKEN_URL));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(500);
    expect(mockIssueCliDeviceApiKey).not.toHaveBeenCalled();
    // Better to fail loudly than hand back a token that authenticates nothing.
    expect(JSON.stringify(body)).not.toContain("raw-session-token");
  });

  it("fails the grant when key issuance throws, leaking no session token", async () => {
    sessionRows.push({ userId: "user-1", activeOrganizationId: "org-1" });
    userRows.push({ email: "dev@example.com" });
    mockIssueCliDeviceApiKey.mockRejectedValue(new Error("insert failed"));
    mockHandlerPost.mockResolvedValue(
      jsonResponse({ access_token: "raw-session-token" })
    );

    const res = await POST(postRequest(TOKEN_URL));

    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("raw-session-token");
  });

  it("passes a pending poll through untouched", async () => {
    mockHandlerPost.mockResolvedValue(
      jsonResponse({ error: "authorization_pending" }, 400)
    );

    const res = await POST(postRequest(TOKEN_URL));

    expect(res.status).toBe(400);
    expect(mockIssueCliDeviceApiKey).not.toHaveBeenCalled();
    expect((await res.json()).error).toBe("authorization_pending");
  });

  it("leaves other auth endpoints untouched", async () => {
    mockHandlerPost.mockResolvedValue(
      jsonResponse({ access_token: "some-other-token" })
    );

    const res = await POST(
      postRequest("https://app.example.com/api/auth/sign-in/email")
    );

    expect(mockIssueCliDeviceApiKey).not.toHaveBeenCalled();
    expect((await res.json()).access_token).toBe("some-other-token");
  });
});
