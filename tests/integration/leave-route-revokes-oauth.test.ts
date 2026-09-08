import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const ORG_ID = "org-1";

const { mockGetSession, mockGetActiveOrgId, selectState, txDeleteCalls } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockGetActiveOrgId: vi.fn(),
    selectState: {
      currentMember: [] as unknown[],
      ownerCount: [] as unknown[],
      newOwner: [] as unknown[],
      limitCalls: 0,
    },
    txDeleteCalls: [] as Array<{ table: unknown; whereArg: unknown }>,
  }));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("@/lib/auth-session-token-hash", () => ({
  hashSessionToken: (token: string): string => `hashed:${token}`,
}));

vi.mock("@/lib/middleware/org-context", () => ({
  getActiveOrgId: mockGetActiveOrgId,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

// Capture the structured filter objects so the test can assert exactly which
// rows the route targets.
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
}));

vi.mock("@/lib/db/schema", () => ({
  member: {
    id: "member.id",
    organizationId: "member.organizationId",
    userId: "member.userId",
    role: "member.role",
  },
  sessions: { token: "sessions.token" },
  mcpOauthRefreshTokens: {
    userId: "mcp.userId",
    organizationId: "mcp.organizationId",
  },
}));

const txStub = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() =>
        // The owner-count query awaits .where() directly; the member-role and
        // new-owner lookups chain .limit() off it. Serve all shapes from one
        // stub: the first .limit() is the current-member lookup, the second
        // (sole-owner path only) is the new-owner lookup.
        Object.assign(Promise.resolve(selectState.ownerCount), {
          limit: vi.fn(() => {
            const isFirstLimit = selectState.limitCalls === 0;
            selectState.limitCalls += 1;
            return Promise.resolve(
              isFirstLimit ? selectState.currentMember : selectState.newOwner
            );
          }),
        })
      ),
    })),
  })),
  delete: vi.fn((table: unknown) => ({
    where: vi.fn((whereArg: unknown) => {
      txDeleteCalls.push({ table, whereArg });
      return Promise.resolve(undefined);
    }),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  })),
};

vi.mock("@/lib/db", () => ({
  db: {
    transaction: vi.fn(async (cb: (tx: typeof txStub) => Promise<unknown>) => {
      return await cb(txStub);
    }),
  },
}));

import { POST } from "@/app/api/organizations/[organizationId]/leave/route";

function buildRequest(body: unknown): Request {
  return new Request(`http://localhost/api/organizations/${ORG_ID}/leave`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function buildContext(): { params: Promise<{ organizationId: string }> } {
  return { params: Promise.resolve({ organizationId: ORG_ID }) };
}

type EqCondition = { op: "eq"; column: string; value: unknown };
type AndCondition = { op: "and"; conditions: EqCondition[] };

beforeEach(() => {
  vi.clearAllMocks();
  txDeleteCalls.length = 0;
  selectState.currentMember = [];
  selectState.ownerCount = [];
  selectState.newOwner = [];
  selectState.limitCalls = 0;
  mockGetActiveOrgId.mockReturnValue(null);
});

describe("POST /api/organizations/[id]/leave -- OAuth refresh token revocation", () => {
  it("deletes the leaving user's MCP OAuth refresh tokens for the org", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { token: "raw-token" },
    });
    selectState.currentMember = [{ id: "member-1", role: "member" }];
    selectState.ownerCount = [{ id: "owner-other" }];

    const response = await POST(buildRequest({}), buildContext());

    expect(response.status).toBe(200);

    const oauthDelete = txDeleteCalls.find((call) => {
      const where = call.whereArg as AndCondition;
      return (
        where?.op === "and" &&
        where.conditions.some((c) => c.column === "mcp.userId")
      );
    });

    expect(oauthDelete).toBeDefined();
    const conditions = (
      (oauthDelete as { whereArg: unknown }).whereArg as AndCondition
    ).conditions;
    expect(conditions).toContainEqual({
      op: "eq",
      column: "mcp.userId",
      value: USER_ID,
    });
    expect(conditions).toContainEqual({
      op: "eq",
      column: "mcp.organizationId",
      value: ORG_ID,
    });
  });

  it("deletes the leaving user's MCP OAuth refresh tokens on the sole-owner path", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: USER_ID },
      session: { token: "raw-token" },
    });
    // Caller is the only owner, so the route requires a successor and takes the
    // ownership-transfer branch before removing the member.
    selectState.currentMember = [{ id: "member-1", role: "owner" }];
    selectState.ownerCount = [{ id: "member-1" }];
    selectState.newOwner = [{ id: "member-2" }];

    const response = await POST(
      buildRequest({ newOwnerMemberId: "member-2" }),
      buildContext()
    );

    expect(response.status).toBe(200);

    const oauthDelete = txDeleteCalls.find((call) => {
      const where = call.whereArg as AndCondition;
      return (
        where?.op === "and" &&
        where.conditions.some((c) => c.column === "mcp.userId")
      );
    });

    expect(oauthDelete).toBeDefined();
    const conditions = (
      (oauthDelete as { whereArg: unknown }).whereArg as AndCondition
    ).conditions;
    expect(conditions).toContainEqual({
      op: "eq",
      column: "mcp.userId",
      value: USER_ID,
    });
    expect(conditions).toContainEqual({
      op: "eq",
      column: "mcp.organizationId",
      value: ORG_ID,
    });
  });
});
