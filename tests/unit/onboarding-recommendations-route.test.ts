import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WhereCall = { table: unknown; where: SQL };
type WorkflowRow = { id: string; listedSlug: string | null };

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: mocks.getSession } },
}));

vi.mock("@/lib/db", () => ({
  db: { select: mocks.select, insert: mocks.insert },
}));

import { GET } from "@/app/api/onboarding/recommendations/route";
import { member } from "@/lib/db/schema";
import { VIEWER_ROLE } from "@/lib/organization/role-label";

const USER_ID = "user-1";
const ORG_ID = "org-1";

let whereCalls: WhereCall[] = [];
let insertedValues: Record<string, unknown>[] = [];

function stubDb(memberRows: Array<{ organizationId: string }>): void {
  whereCalls = [];
  insertedValues = [];
  const workflowRows: WorkflowRow[] = [];
  mocks.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: (where: SQL) => {
        whereCalls.push({ table, where });
        if (table === member) {
          return { limit: () => Promise.resolve(memberRows) };
        }
        return Promise.resolve(workflowRows);
      },
    }),
  }));
  mocks.insert.mockImplementation(() => ({
    values: (values: Record<string, unknown>) => {
      insertedValues.push(values);
      return { onConflictDoNothing: () => Promise.resolve() };
    },
  }));
}

function memberLookup(): { sql: string; params: unknown[] } {
  const call = whereCalls.find((c) => c.table === member);
  if (!call) {
    throw new Error("member lookup did not run");
  }
  return new PgDialect().sqlToQuery(call.where);
}

function request(): Request {
  return new Request("http://localhost/api/onboarding/recommendations");
}

describe("GET /api/onboarding/recommendations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ user: { id: USER_ID } });
  });

  it("excludes viewer memberships when picking the org to seed into", async () => {
    stubDb([{ organizationId: ORG_ID }]);

    await GET(request());

    const { sql, params } = memberLookup();
    expect(sql).toContain('"member"."user_id" = $1');
    expect(sql).toContain('"member"."role" <> $2');
    expect(params).toEqual([USER_ID, VIEWER_ROLE]);
  });

  it("seeds nothing when the user only has viewer memberships", async () => {
    stubDb([]);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("seeds missing fixtures into a non-viewer membership's org", async () => {
    stubDb([{ organizationId: ORG_ID }]);

    await GET(request());

    expect(insertedValues.length).toBeGreaterThan(0);
    for (const values of insertedValues) {
      expect(values.organizationId).toBe(ORG_ID);
      expect(values.userId).toBe(USER_ID);
    }
  });
});
