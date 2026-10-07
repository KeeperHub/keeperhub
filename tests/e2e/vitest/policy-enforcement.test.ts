import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The guard and store are server modules; `import "server-only"` throws under
// vitest without this stub.
vi.mock("server-only", () => ({}));

// The global setup stubs `@/lib/db` for unit tests. This suite is the one that
// has to reach a real database, otherwise it proves nothing about whether the
// store, the compiler and the engine agree on a stored document.
vi.mock("@/lib/db", async () => {
  const { drizzle: realDrizzle } = await import("drizzle-orm/postgres-js");
  const pg = (await import("postgres")).default;
  const connection =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5433/keeperhub";
  // Short idle timeout so the pool does not hold the test process open.
  return { db: realDrizzle(pg(connection, { max: 2, idle_timeout: 1 })) };
});

import {
  organization,
  organizationPolicies,
  policyDecisions,
  resourceGrants,
  users,
} from "@/lib/db/schema";
import {
  Capability,
  FactProvenance,
  FactState,
  POLICY_SCHEMA_VERSION,
  PolicyCheckpoint,
  PolicyDecisionReason,
  type PolicyFacts,
  PolicyOutcome,
  PolicyRole,
  PrincipalKind,
} from "@/lib/policy";
import { enforcePolicy } from "@/lib/policy/guard";
import { invalidateAllPolicies } from "@/lib/policy/store";

/**
 * End to end: a policy stored in Postgres, loaded, compiled, evaluated, and
 * recorded, through the same guard the executor calls.
 *
 * This is the test that proves the pieces are actually connected. The unit
 * suites prove each part in isolation; only this one fails if the store, the
 * compiler and the engine disagree about what a stored document means.
 */

const shouldSkip =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";

function id(): string {
  return crypto.randomBytes(11).toString("base64url");
}

const AAVE_POOL = "0xa238dd80c259a72e81d7e4664a9801593f98d1c5";
const SUPPLY_SELECTOR = "0x617ba037";
const POOL_ARN = `kh:chain/8453/contract/${AAVE_POOL}/fn/${SUPPLY_SELECTOR}`;

const UNKNOWN = { state: FactState.UNKNOWN } as const;

function facts(
  capability: Capability,
  overrides: Partial<PolicyFacts> = {}
): PolicyFacts {
  return {
    capability,
    resource: UNKNOWN,
    chainId: UNKNOWN,
    contractAddress: UNKNOWN,
    selector: UNKNOWN,
    protocolSlug: UNKNOWN,
    assets: UNKNOWN,
    counterparties: UNKNOWN,
    nativeValueWei: UNKNOWN,
    usdValue: UNKNOWN,
    unbounded: UNKNOWN,
    gasPriceGwei: UNKNOWN,
    gasLimit: UNKNOWN,
    signerMode: UNKNOWN,
    triggerType: UNKNOWN,
    workflowId: UNKNOWN,
    workflowTags: UNKNOWN,
    projectId: UNKNOWN,
    sourceIp: UNKNOWN,
    httpHost: UNKNOWN,
    httpUrl: UNKNOWN,
    httpMethod: UNKNOWN,
    resourceId: UNKNOWN,
    ...overrides,
  };
}

describe.skipIf(shouldSkip)("policy enforcement, end to end", () => {
  let testDb: ReturnType<typeof drizzle>;
  let client: ReturnType<typeof postgres>;
  let orgId: string;
  let userId: string;
  let policyId: string;
  const workflowId = id();

  const principal = () =>
    ({
      kind: PrincipalKind.MEMBER,
      userId,
      organizationId: orgId,
      role: PolicyRole.MEMBER,
    }) as const;

  beforeAll(async () => {
    const connectionString =
      process.env.DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5433/keeperhub";
    client = postgres(connectionString, { max: 5 });
    testDb = drizzle(client, {
      schema: { organization, organizationPolicies, resourceGrants, users },
    });

    userId = id();
    orgId = id();
    const now = new Date();

    await testDb.insert(users).values({
      id: userId,
      name: "Policy E2E User",
      email: `policy-e2e-${userId}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insert(organization).values({
      id: orgId,
      name: "Policy E2E Org",
      slug: `policy-e2e-${orgId}`.toLowerCase(),
      createdAt: now,
    });

    const [row] = await testDb
      .insert(organizationPolicies)
      .values({
        organizationId: orgId,
        name: "Lending bounds",
        enforcement: "enforce",
        document: {
          schemaVersion: POLICY_SCHEMA_VERSION,
          name: "Lending bounds",
          enforcement: "enforce",
          manages: ["protocol.lending.**", "asset.approve"],
          statements: [
            {
              sid: "allow-supply",
              effect: "allow",
              capability: ["protocol.lending.supply"],
              resource: [POOL_ARN],
            },
            {
              sid: "no-borrowing",
              effect: "deny",
              capability: ["protocol.lending.borrow"],
            },
            {
              sid: "no-unbounded-approvals",
              effect: "deny",
              capability: ["asset.approve"],
              condition: { unbounded: { eq: true } },
            },
          ],
        },
        createdBy: userId,
      })
      .returning();
    policyId = row?.id ?? "";
    invalidateAllPolicies();
  });

  afterAll(async () => {
    await testDb
      .delete(policyDecisions)
      .where(eq(policyDecisions.organizationId, orgId));
    await testDb
      .delete(resourceGrants)
      .where(eq(resourceGrants.organizationId, orgId));
    await testDb
      .delete(organizationPolicies)
      .where(eq(organizationPolicies.organizationId, orgId));
    await testDb.delete(organization).where(eq(organization.id, orgId));
    await testDb.delete(users).where(eq(users.id, userId));
    await client.end();
    invalidateAllPolicies();
  });

  it("stores a policy that compiles and loads", () => {
    expect(policyId).not.toBe("");
  });

  it("leaves an unmanaged capability alone", async () => {
    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.OFFCHAIN_NOTIFY,
      facts: facts(Capability.OFFCHAIN_NOTIFY),
      checkpoint: PolicyCheckpoint.NODE,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.decision.outcome).toBe(PolicyOutcome.UNMANAGED);
  });

  it("blocks a denied capability", async () => {
    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.PROTOCOL_LENDING_BORROW,
      facts: facts(Capability.PROTOCOL_LENDING_BORROW),
      checkpoint: PolicyCheckpoint.NODE,
      workflowId,
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.EXPLICIT_DENY);
    expect(verdict.decision.matched[0]?.sid).toBe("no-borrowing");
  });

  it("allows a permitted action on the named resource", async () => {
    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.PROTOCOL_LENDING_SUPPLY,
      facts: facts(Capability.PROTOCOL_LENDING_SUPPLY, {
        resource: {
          state: FactState.KNOWN,
          value: POOL_ARN,
          provenance: FactProvenance.AUTHORITATIVE,
        },
      }),
      checkpoint: PolicyCheckpoint.NODE,
      workflowId,
    });
    expect(verdict.blocked).toBe(false);
    expect(verdict.decision.outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses to allow the same action on a workflow-derived resource", async () => {
    // The provenance rule: an attacker who steers an upstream response must not
    // be able to talk the engine into permitting something.
    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.PROTOCOL_LENDING_SUPPLY,
      facts: facts(Capability.PROTOCOL_LENDING_SUPPLY, {
        resource: {
          state: FactState.KNOWN,
          value: POOL_ARN,
          provenance: FactProvenance.WORKFLOW_DERIVED,
        },
      }),
      checkpoint: PolicyCheckpoint.NODE,
      workflowId,
    });
    expect(verdict.blocked).toBe(true);
  });

  it("promotes a workflow-derived resource once a grant covers it", async () => {
    await testDb.insert(resourceGrants).values({
      organizationId: orgId,
      subjectKind: "workflow",
      subjectId: workflowId,
      resource: POOL_ARN,
      capabilities: [Capability.PROTOCOL_LENDING_SUPPLY],
      grantedBy: userId,
    });

    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.PROTOCOL_LENDING_SUPPLY,
      facts: facts(Capability.PROTOCOL_LENDING_SUPPLY, {
        resource: {
          state: FactState.KNOWN,
          value: POOL_ARN,
          provenance: FactProvenance.WORKFLOW_DERIVED,
        },
      }),
      checkpoint: PolicyCheckpoint.NODE,
      grantSubject: { kind: "workflow", id: workflowId },
      workflowId,
    });
    // The grant vouches for the resolved value, so the same templated target
    // that was refused above is now permitted.
    expect(verdict.blocked).toBe(false);
    expect(verdict.decision.outcome).toBe(PolicyOutcome.ALLOW);
  });

  it("refuses a resource the grant does not cover", async () => {
    const other = `kh:chain/8453/contract/${"0x".padEnd(42, "b")}/fn/${SUPPLY_SELECTOR}`;
    const verdict = await enforcePolicy({
      principal: principal(),
      organizationId: orgId,
      capability: Capability.PROTOCOL_LENDING_SUPPLY,
      facts: facts(Capability.PROTOCOL_LENDING_SUPPLY, {
        resource: {
          state: FactState.KNOWN,
          value: other,
          provenance: FactProvenance.WORKFLOW_DERIVED,
        },
      }),
      checkpoint: PolicyCheckpoint.NODE,
      grantSubject: { kind: "workflow", id: workflowId },
      workflowId,
    });
    expect(verdict.blocked).toBe(true);
    expect(verdict.decision.reason).toBe(PolicyDecisionReason.NOT_GRANTED);
  });

  it("records governed decisions and skips unmanaged ones", async () => {
    const rows = await testDb
      .select()
      .from(policyDecisions)
      .where(eq(policyDecisions.organizationId, orgId));

    expect(rows.length).toBeGreaterThan(0);
    // An unmanaged decision writes no row: an org with no policy would
    // otherwise write one per node per run forever.
    expect(rows.every((r) => r.outcome !== PolicyOutcome.UNMANAGED)).toBe(true);
    expect(
      rows.some((r) => r.reason === PolicyDecisionReason.EXPLICIT_DENY)
    ).toBe(true);
  });
});
