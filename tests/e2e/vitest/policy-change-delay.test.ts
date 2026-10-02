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

import { organization, organizationPolicies, users } from "@/lib/db/schema";
import { POLICY_SCHEMA_VERSION, PolicyEnforcementMode } from "@/lib/policy";
import {
  getCompiledPolicySet,
  invalidateAllPolicies,
} from "@/lib/policy/store";
import type { PolicyDocument } from "@/lib/policy/types";

const id = (): string => crypto.randomUUID();

/** Refuses borrowing. The rule that must survive a delayed edit. */
const STRICT = {
  schemaVersion: POLICY_SCHEMA_VERSION,
  name: "Lending bounds",
  enforcement: PolicyEnforcementMode.ENFORCE,
  manages: ["protocol.lending.**"],
  statements: [
    {
      sid: "no-borrowing",
      effect: "deny",
      capability: ["protocol.lending.borrow"],
    },
  ],
} as unknown as PolicyDocument;

/** The same policy with the deny taken out. */
const RELAXED = {
  ...STRICT,
  statements: [],
} as unknown as PolicyDocument;

describe("a policy edit that was asked to wait", () => {
  let client: ReturnType<typeof postgres>;
  let testDb: ReturnType<typeof drizzle>;
  const orgId = `org-${id()}`;
  const userId = `user-${id()}`;
  const policyId = `pol-${id()}`;

  const sidsInForce = async (): Promise<string[]> => {
    invalidateAllPolicies();
    const set = await getCompiledPolicySet(orgId);
    return (set?.policies ?? []).flatMap((p) => p.statements.map((s) => s.sid));
  };

  beforeAll(async () => {
    client = postgres(CONNECTION, { max: 4 });
    testDb = drizzle(client);
    const now = new Date();

    await testDb.insert(users).values({
      id: userId,
      name: "Delay test",
      email: `${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(organization).values({
      id: orgId,
      name: "Delay test org",
      slug: `delay-${orgId.slice(0, 8)}`,
      createdAt: now,
    });
    await testDb.insert(organizationPolicies).values({
      id: policyId,
      organizationId: orgId,
      name: "Lending bounds",
      enabled: true,
      enforcement: PolicyEnforcementMode.ENFORCE,
      document: STRICT,
      version: 1,
      createdBy: userId,
    });
  });

  afterAll(async () => {
    await testDb
      .delete(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, orgId));
    await testDb.delete(organization).where(eq(organization.id, orgId));
    await testDb.delete(users).where(eq(users.id, userId));
    await client.end();
  });

  it("keeps the old rules in force while the edit waits", async () => {
    expect(await sidsInForce()).toContain("no-borrowing");

    // The weakening is parked, exactly as a delayed PATCH records it.
    await testDb
      .update(organizationPolicies)
      .set({
        pendingDocument: RELAXED,
        pendingEffectiveAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(organizationPolicies.id, policyId));

    // The whole point of asking for a delay: borrowing is still refused.
    // Before this the policy stopped being enforced the moment the delay was
    // set, so a delay removed the guardrail instead of holding it up.
    expect(await sidsInForce()).toContain("no-borrowing");
  });

  it("takes the edit once its hour arrives", async () => {
    await testDb
      .update(organizationPolicies)
      .set({
        pendingDocument: RELAXED,
        pendingEffectiveAt: new Date(Date.now() - 1000),
      })
      .where(eq(organizationPolicies.id, policyId));

    expect(await sidsInForce()).not.toContain("no-borrowing");
  });

  it("enforces the live document when nothing is waiting", async () => {
    await testDb
      .update(organizationPolicies)
      .set({ pendingDocument: null, pendingEffectiveAt: null })
      .where(eq(organizationPolicies.id, policyId));

    expect(await sidsInForce()).toContain("no-borrowing");
  });
});
