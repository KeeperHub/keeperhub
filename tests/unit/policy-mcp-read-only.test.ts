import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const auth = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: () => Promise.resolve(auth.current),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([{ role: "owner" }]) }),
      }),
    }),
  },
}));

import { requireOrgPolicyAccess } from "@/app/api/organizations/[organizationId]/policies/_lib/access";

const ORG = "org_1";

function request(): Request {
  return new Request("https://app.test/api/organizations/org_1/policies", {
    method: "POST",
  });
}

/**
 * An agent may read policy and may never write it.
 *
 * The credential an agent carries is the one with no human behind it, so a
 * step-up cannot be asked for and a confused or hijacked agent would otherwise
 * be able to widen the rules that bound it: add its own payee, raise its own
 * ceiling, or bury a real rule under a pile of its own. Reading is useful and
 * harmless, so it stays.
 */
describe("what an agent credential may do with policy", () => {
  beforeEach(() => {
    auth.current = {
      userId: "u_1",
      organizationId: ORG,
      authMethod: "oauth",
      scope: "mcp:write",
    };
  });

  it("refuses a write from an MCP token, owner or not", async () => {
    const access = await requireOrgPolicyAccess(request(), ORG, "write");

    expect(access.ok).toBe(false);
    if (!access.ok) {
      const body = (await access.response.json()) as { code?: string };
      expect(access.response.status).toBe(403);
      expect(body.code).toBe("session_required");
    }
  });

  it("refuses a write from an API key too", async () => {
    auth.current = { ...auth.current, authMethod: "api-key" };

    const access = await requireOrgPolicyAccess(request(), ORG, "write");
    expect(access.ok).toBe(false);
  });

  it("still lets an MCP token read policy", async () => {
    const access = await requireOrgPolicyAccess(request(), ORG, "read");
    expect(access.ok).toBe(true);
  });
});
