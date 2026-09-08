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

// Active, current-member user so the anonymity behaviour under test is the
// only thing that can flip the result.
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

describe("authenticateOAuthToken -- anonymous principal handling", () => {
  it("rejects a token whose subject is flagged isAnonymous", async () => {
    const token = await createAccessToken({
      sub: "anon-1",
      org: "org-1",
      scope: "mcp:write",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: null,
      isAnonymous: true,
      name: "Anonymous",
      email: "temp-abc@example.com",
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(403);
    expect(result.error).toBe(
      "Anonymous accounts cannot use API access tokens"
    );
  });

  it("rejects a token whose subject only matches the anonymous name/email shape", async () => {
    const token = await createAccessToken({
      sub: "anon-2",
      org: "org-1",
      scope: "mcp:write",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: null,
      isAnonymous: false,
      name: "Anonymous",
      email: "temp-xyz@example.com",
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(false);
    expect(result.statusCode).toBe(403);
  });

  it("emits the anonymous-block detection signal", async () => {
    const warnSpy = vi.spyOn(raw, "warn").mockImplementation(() => {
      // assert against the spy, suppress noise
    });
    const token = await createAccessToken({
      sub: "anon-1",
      org: "org-1",
      scope: "mcp:write",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: null,
      isAnonymous: true,
      name: "Anonymous",
      email: "temp-abc@example.com",
    });

    await authenticateOAuthToken(await buildRequestWithToken(token));

    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    const [message, options] = mockCaptureMessage.mock.calls[0] as [
      string,
      { tags: Record<string, string>; user: { id: string } },
    ];
    expect(message).toBe("security.anonymous_execution_blocked");
    expect(options).toMatchObject({
      tags: { security: "anonymous_execution_blocked", surface: "mcp_oauth" },
      user: { id: "anon-1" },
    });
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      event: "security.anonymous_execution_blocked",
      surface: "mcp_oauth",
      userId: "anon-1",
    });
    warnSpy.mockRestore();
  });

  it("authenticates a token whose subject is a real (non-anonymous) user", async () => {
    const token = await createAccessToken({
      sub: "user-1",
      org: "org-1",
      scope: "mcp:write",
    });
    mockUsersFindFirst.mockResolvedValue({
      deactivatedAt: null,
      isAnonymous: false,
      name: "Real User",
      email: "real@example.com",
    });

    const result = await authenticateOAuthToken(
      await buildRequestWithToken(token)
    );

    expect(result.authenticated).toBe(true);
    expect(result.userId).toBe("user-1");
  });
});
