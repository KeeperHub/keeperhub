import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rows: [] as { role: string }[],
  joined: false,
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: mocks.auth,
}));
vi.mock("@/lib/db", () => {
  const query = {
    from: () => query,
    innerJoin: () => {
      mocks.joined = true;
      return query;
    },
    where: () => query,
    limit: () => Promise.resolve(mocks.rows),
  };
  return { db: { select: () => query } };
});

import {
  ORG_MANAGERS,
  requireOrgRole,
} from "@/lib/middleware/require-org-role";

const request = new Request("http://localhost/api/organizations/org_a");

describe("requireOrgRole", () => {
  beforeEach(() => {
    mocks.rows = [{ role: "admin" }];
    mocks.joined = false;
  });

  it("refuses an OAuth token issued for another organization", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_1",
      organizationId: "org_b",
      authMethod: "oauth",
      apiKeyId: null,
    });

    const result = await requireOrgRole(request, "org_a", ORG_MANAGERS);

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("lets a session reach any organization the user manages", async () => {
    mocks.auth.mockResolvedValue({
      userId: "user_1",
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
    });

    const result = await requireOrgRole(request, "org_a", ORG_MANAGERS);

    expect(result).toMatchObject({ ok: true, role: "admin" });
    expect(mocks.joined).toBe(true);
  });

  it("refuses an organization with no live membership, as when deactivated", async () => {
    mocks.rows = [];
    mocks.auth.mockResolvedValue({
      userId: "user_1",
      organizationId: null,
      authMethod: "session",
      apiKeyId: null,
    });

    const result = await requireOrgRole(request, "org_a", ORG_MANAGERS);

    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});
