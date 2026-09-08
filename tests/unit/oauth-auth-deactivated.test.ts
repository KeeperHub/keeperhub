import { beforeEach, describe, expect, it, vi } from "vitest";
import { rawConsole } from "@/lib/log/core";

// logSecurityEvent writes the structured line via lib/log/core's rawConsole.
const raw = rawConsole as unknown as Record<
  "debug" | "info" | "warn" | "error",
  (line: string) => void
>;

vi.mock("server-only", () => ({}));

const { mockUsersFindFirst, mockCaptureMessage } = vi.hoisted(() => ({
  mockUsersFindFirst: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));

// The auth path reads the scope epoch and records liveness; neither is what
// these tests exercise, so both are stubbed to their no-change answers.
vi.mock("@/lib/mcp/scope-policy", () => ({
  DEFAULT_EPOCH: 0,
  effectiveScope: (scope: string) => scope,
  getScopePolicy: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
  getScopePolicyForMint: vi.fn().mockResolvedValue({
    epoch: 0,
    memberMaxScope: null,
    orgMaxScope: null,
  }),
}));

vi.mock("@/lib/mcp/connections", () => ({
  touchConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db", () => ({
  db: { query: { users: { findFirst: mockUsersFindFirst } } },
}));

vi.mock("@/lib/db/schema", () => ({ users: { id: "id" } }));

// authenticateOAuthToken now also re-checks org membership; the active-user
// case must look like a current member so the deactivation behaviour under
// test is exercised in isolation.
vi.mock("@/lib/workflow/access", () => ({
  isUserMemberOfOrganization: vi.fn().mockResolvedValue(true),
}));

vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    mockCaptureMessage(message, context);
  },
}));

const TEST_SECRET = "test-secret-32-bytes-long-enough-for-hs256";
process.env.OAUTH_JWT_SECRET = TEST_SECRET;

import {
  authenticateOAuthToken,
  createAccessToken,
} from "@/lib/mcp/oauth-auth";

function buildRequestWithToken(token: string): Request {
  return new Request("http://localhost/api/anything", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateOAuthToken -- deactivated user handling", () => {
  it("authenticates a token whose subject is an active user", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({ deactivatedAt: null });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user-1");
    expect(result.organizationId).toBe("org-1");
  });

  it("rejects a token whose subject has been deactivated", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(result.error).toBe("User account is deactivated");
    // KEEP-612: the MCP OAuth path is the 4th deactivated-login surface and
    // must emit the detection signal, mirroring session/account/api-key.
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      { tags: Record<string, string>; user: { id: string } },
    ];
    expect(message).toBe("security.deactivated_login_attempt");
    expect(options).toMatchObject({
      tags: { security: "deactivated_login_attempt", surface: "mcp_oauth" },
      user: { id: "user-1" },
    });
  });

  it("emits the structured stdout signal alongside Sentry", async () => {
    const warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // assert against the spy, suppress noise
    });
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await authenticateOAuthToken(await buildRequestWithToken(token));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "security.deactivated_login_attempt",
      surface: "mcp_oauth",
      userId: "user-1",
    });
    warnSpy.mockRestore();
  });

  it("still rejects (and logs) when Sentry capture throws", async () => {
    const warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // suppress noise
    });
    mockCaptureMessage.mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "read",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    // Sentry throwing must not break the 401 deny, and the durable stdout
    // signal still lands.
    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("rejects a kh_-prefixed bearer token (handled by API-key auth instead)", async () => {
    const result = await authenticateOAuthToken(
      await buildRequestWithToken("kh_should_not_be_handled_here")
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a token with an invalid signature without touching the DB", async () => {
    const result = await authenticateOAuthToken(
      await buildRequestWithToken("not.a.valid.jwt")
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(401);
    expect(mockUsersFindFirst).not.toHaveBeenCalled();
  });
});
