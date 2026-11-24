import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const CONNECTION =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/keeperhub_test";

vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub_test";
  return { db: realDrizzle(pg(connection, { max: 2, idle_timeout: 1 })) };
});

// Only the session is faked. The membership row is real, so the access check
// under test is the one that ships; searching, paging and scoping run against
// real SQL because that is the part that can silently return the wrong rows.
const auth = vi.hoisted(() => ({
  userId: "",
  organizationId: "",
  authMethod: "session",
}));
vi.mock("@/lib/middleware/auth-helpers", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDualAuthContext: () => Promise.resolve(auth),
}));

import { GET as listPolicies } from "@/app/api/organizations/[organizationId]/policies/route";
import { GET as listDecisions } from "@/app/api/organizations/[organizationId]/policy-decisions/route";
import {
  member,
  organization,
  organizationPolicies,
  policyDecisions,
  users,
} from "@/lib/db/schema";
import {
  type Capability,
  POLICY_SCHEMA_VERSION,
  PolicyDecisionReason,
  type PolicyDocument,
  PolicyEnforcementMode,
  PolicyOutcome,
} from "@/lib/policy";

const id = (): string => crypto.randomUUID();

type Client = ReturnType<typeof postgres>;

describe("policy list paging and search", () => {
  let client: Client;
  let testDb: ReturnType<typeof drizzle>;
  let orgId: string;
  let userId: string;
  const policyIds: string[] = [];

  const call = async (
    handler: (
      r: Request,
      c: { params: Promise<{ organizationId: string }> }
    ) => Promise<Response>,
    path: string,
    query: string
  ): Promise<{
    items: unknown[];
    meta: { total: number; totalPages: number };
  }> => {
    const res = await handler(
      new Request(
        `https://test.local/api/organizations/${orgId}/${path}?${query}`
      ),
      { params: Promise.resolve({ organizationId: orgId }) }
    );
    expect(res.status).toBe(200);
    return (await res.json()) as never;
  };

  beforeAll(async () => {
    client = postgres(CONNECTION, { max: 5 });
    testDb = drizzle(client);

    userId = id();
    orgId = id();
    auth.userId = userId;
    auth.organizationId = orgId;
    const now = new Date();

    await testDb.insert(users).values({
      id: userId,
      name: "Policy paging",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(organization).values({
      id: orgId,
      name: "Policy paging org",
      slug: `paging-${orgId.slice(0, 8)}`,
      createdAt: now,
    });
    await testDb.insert(member).values({
      id: id(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: now,
    });

    // Written oldest first, one per minute, so ordering is unambiguous.
    for (let i = 0; i < 25; i++) {
      const policyId = id();
      policyIds.push(policyId);
      await testDb.insert(organizationPolicies).values({
        id: policyId,
        organizationId: orgId,
        name: `Policy ${String(i).padStart(2, "0")}`,
        description: i === 7 ? "the treasury one" : null,
        enabled: true,
        enforcement: PolicyEnforcementMode.MONITOR,
        version: 1,
        document: {
          schemaVersion: POLICY_SCHEMA_VERSION,
          name: `Policy ${i}`,
          enforcement: PolicyEnforcementMode.MONITOR,
          manages: i === 3 ? ["cap:asset.transfer.**"] : ["cap:workflow.**"],
          statements: [],
        } satisfies PolicyDocument,
        createdAt: new Date(now.getTime() + i * 60_000),
        updatedAt: new Date(now.getTime() + i * 60_000),
      });
    }

    // Three decisions under the first policy, one under a policy id that does
    // not exist, one unmanaged.
    const decision = (governing: string[], capability: Capability) => ({
      id: id(),
      organizationId: orgId,
      checkpoint: "node",
      capability,
      resource: "kh:workflow/wf_paging",
      outcome: PolicyOutcome.DENY,
      reason: PolicyDecisionReason.EXPLICIT_DENY,
      matchedSids: ["s1"],
      governingPolicyIds: governing,
      observedOnly: false,
      createdAt: new Date(),
    });
    await testDb
      .insert(policyDecisions)
      .values([
        decision([policyIds[0] as string], "contract.read"),
        decision([policyIds[0] as string], "contract.read"),
        decision([policyIds[0] as string], "asset.transfer.token"),
        decision(["policy-that-was-deleted"], "contract.read"),
        decision([], "contract.read"),
      ] as never);
  });

  afterAll(async () => {
    await testDb
      .delete(policyDecisions)
      .where(eq(policyDecisions.organizationId, orgId));
    await testDb
      .delete(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, orgId));
    await testDb.delete(member).where(eq(member.organizationId, orgId));
    await testDb.delete(organization).where(eq(organization.id, orgId));
    await testDb.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it("pages policies on the server rather than sending them all", async () => {
    const first = await call(listPolicies, "policies", "page=1&limit=10");
    expect(first.items).toHaveLength(10);
    expect(first.meta.total).toBe(25);
    expect(first.meta.totalPages).toBe(3);

    const last = await call(listPolicies, "policies", "page=3&limit=10");
    expect(last.items).toHaveLength(5);
  });

  it("orders by creation, so editing a policy does not move it", async () => {
    const before = await call(listPolicies, "policies", "page=1&limit=25");
    const namesBefore = (before.items as { name: string }[]).map((p) => p.name);

    // Touch the first policy the way an edit would.
    await testDb
      .update(organizationPolicies)
      .set({ updatedAt: new Date(Date.now() + 3_600_000) })
      .where(eq(organizationPolicies.id, policyIds[0] as string));

    const after = await call(listPolicies, "policies", "page=1&limit=25");
    expect((after.items as { name: string }[]).map((p) => p.name)).toEqual(
      namesBefore
    );
    expect(namesBefore[0]).toBe("Policy 00");
  });

  it("searches name, description and the document", async () => {
    const byName = await call(listPolicies, "policies", "q=Policy 07");
    expect(byName.meta.total).toBe(1);

    const byDescription = await call(listPolicies, "policies", "q=treasury");
    expect((byDescription.items as { name: string }[])[0]?.name).toBe(
      "Policy 07"
    );

    // The capability lives inside the document, not in a column of its own.
    const byCapability = await call(
      listPolicies,
      "policies",
      "q=asset.transfer"
    );
    expect(byCapability.meta.total).toBe(1);
    expect((byCapability.items as { name: string }[])[0]?.name).toBe(
      "Policy 03"
    );
  });

  it("scopes decisions to the policy that governed them", async () => {
    const scoped = await call(
      listDecisions,
      "policy-decisions",
      `policyId=${policyIds[0]}`
    );
    expect(scoped.meta.total).toBe(3);

    const other = await call(
      listDecisions,
      "policy-decisions",
      `policyId=${policyIds[1]}`
    );
    expect(other.meta.total).toBe(0);
  });

  it("collects decisions whose policy is gone, and only those", async () => {
    const orphaned = await call(
      listDecisions,
      "policy-decisions",
      "orphaned=true"
    );
    // The dangling reference and the unmanaged one. The three that still have
    // a living policy stay out of it.
    expect(orphaned.meta.total).toBe(2);
  });

  it("searches decisions on the server", async () => {
    const hits = await call(
      listDecisions,
      "policy-decisions",
      `policyId=${policyIds[0]}&q=asset.transfer`
    );
    expect(hits.meta.total).toBe(1);
  });
});
