import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER_ID = "user-1";
const ORG_ID = "org-1";

const { deleteCalls } = vi.hoisted(() => ({
  deleteCalls: [] as Array<{ table: unknown; whereArg: unknown }>,
}));

// Capture the structured filter objects so the test can assert exactly which
// rows the helper targets.
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ op: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ op: "eq", column, value }),
  lt: (column: unknown, value: unknown) => ({ op: "lt", column, value }),
}));

vi.mock("@/lib/db/schema", () => ({
  mcpOauthAuthCodes: {},
  mcpOauthClients: {},
  mcpOauthRefreshTokens: {
    userId: "mcp.userId",
    organizationId: "mcp.organizationId",
    tokenHash: "mcp.tokenHash",
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    delete: vi.fn((table: unknown) => ({
      where: vi.fn((whereArg: unknown) => {
        deleteCalls.push({ table, whereArg });
        return Promise.resolve(undefined);
      }),
    })),
  },
}));

import { revokeRefreshTokensForUserOrg } from "@/lib/mcp/oauth-store";

type EqCondition = { op: "eq"; column: string; value: unknown };
type AndCondition = { op: "and"; conditions: EqCondition[] };

beforeEach(() => {
  vi.clearAllMocks();
  deleteCalls.length = 0;
});

describe("revokeRefreshTokensForUserOrg", () => {
  it("deletes the refresh tokens scoped to the given user and org", async () => {
    await revokeRefreshTokensForUserOrg(USER_ID, ORG_ID);

    expect(deleteCalls).toHaveLength(1);
    const where = deleteCalls[0]?.whereArg as AndCondition;
    expect(where.op).toBe("and");
    expect(where.conditions).toContainEqual({
      op: "eq",
      column: "mcp.userId",
      value: USER_ID,
    });
    expect(where.conditions).toContainEqual({
      op: "eq",
      column: "mcp.organizationId",
      value: ORG_ID,
    });
  });
});
