import { beforeEach, describe, expect, it, vi } from "vitest";

// cache() from React relies on AsyncLocalStorage context that doesn't exist
// in Vitest. Replace with a plain identity wrapper so the cached functions
// behave as regular async functions here.
vi.mock("react", () => ({
  cache: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));

let mockSelectRows: unknown[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mockSelectRows),
        }),
      }),
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  organization: {
    id: "organization.id",
    slug: "organization.slug",
    name: "organization.name",
    deactivatedAt: "organization.deactivatedAt",
  },
  organizationSubscriptions: {
    organizationId: "organizationSubscriptions.organizationId",
    plan: "organizationSubscriptions.plan",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
}));

vi.mock("@/lib/errors/workflow-error-context", () => ({
  enterWorkflowErrorContext: vi.fn(),
}));

import { resolveExecutionOrgMetadata } from "@/lib/db/org-helpers";

beforeEach(() => {
  mockSelectRows = [];
  vi.clearAllMocks();
});

describe("resolveExecutionOrgMetadata", () => {
  it("returns empty object when orgId is null", async () => {
    const result = await resolveExecutionOrgMetadata(null);
    expect(result).toEqual({});
  });

  it("returns empty object when orgId is undefined", async () => {
    const result = await resolveExecutionOrgMetadata(undefined);
    expect(result).toEqual({});
  });

  it("returns slug, name, and plan when all fields are present", async () => {
    mockSelectRows = [{ slug: "my-org", name: "My Organization", plan: "pro" }];
    const result = await resolveExecutionOrgMetadata("org-1");
    expect(result.slug).toBe("my-org");
    expect(result.name).toBe("My Organization");
    expect(result.plan).toBe("pro");
  });

  it("returns undefined slug/name and 'free' plan when db returns no row", async () => {
    mockSelectRows = [];
    const result = await resolveExecutionOrgMetadata("org-1");
    // getOrgIdentity yields {} (no row), getOrgPlanLabel yields "free" (no subscription defaults to free)
    expect(result).toEqual({ slug: undefined, name: undefined, plan: "free" });
  });

  it("returns partial result when only some fields are populated", async () => {
    mockSelectRows = [{ slug: "partial-org", name: null, plan: null }];
    const result = await resolveExecutionOrgMetadata("org-1");
    expect(result.slug).toBe("partial-org");
  });

  it("does not throw when the underlying db query rejects", async () => {
    const { db } = await import("@/lib/db");
    vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("db error");
    });
    const result = await resolveExecutionOrgMetadata("org-1");
    expect(result).toMatchObject({});
  });
});
