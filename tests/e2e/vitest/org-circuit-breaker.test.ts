import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The modules under test are server-only; stub the guard for vitest.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally mocks @/lib/db. This suite drives the real circuit
// breaker and value-ledger code against a real database, so restore the module.
vi.unmock("@/lib/db");

import { db } from "@/lib/db";
import { member, organization, users } from "@/lib/db/schema";
import {
  isOrgHalted,
  ORG_HALTED_REASON,
  resetOrgCircuitBreaker,
  tripOrgCircuitBreaker,
} from "@/lib/execute/org-circuit-breaker";
import { reserveOrgValue } from "@/lib/execute/value-ledger";

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = "test_keep1328_cb_";

describe.skipIf(SKIP)("org circuit breaker (db-backed)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let seedDb: ReturnType<typeof drizzle>;

  const userAdmin = `${PREFIX}admin`;
  const userMember = `${PREFIX}member`;
  const orgA = `${PREFIX}orgA`;
  const orgB = `${PREFIX}orgB`;

  async function haltedAtOf(orgId: string): Promise<Date | null> {
    const rows = await queryClient`
      SELECT halted_at FROM organization WHERE id = ${orgId} LIMIT 1
    `;
    return (rows[0]?.halted_at as Date | null) ?? null;
  }

  async function haltMetaOf(
    orgId: string
  ): Promise<{ reason: string | null; by: string | null }> {
    const rows = await queryClient`
      SELECT halted_reason, halted_by FROM organization WHERE id = ${orgId} LIMIT 1
    `;
    return {
      reason: (rows[0]?.halted_reason as string | null) ?? null,
      by: (rows[0]?.halted_by as string | null) ?? null,
    };
  }

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM org_value_reservations WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization_spend_caps WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    seedDb = drizzle(queryClient);
    await cleanup();

    await seedDb.insert(users).values([
      {
        id: userAdmin,
        email: `${userAdmin}@keep1328.test`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: userMember,
        email: `${userMember}@keep1328.test`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    await seedDb.insert(organization).values([
      { id: orgA, name: orgA, slug: orgA, createdAt: new Date() },
      { id: orgB, name: orgB, slug: orgB, createdAt: new Date() },
    ]);
    await seedDb.insert(member).values([
      {
        id: `${PREFIX}m_admin`,
        organizationId: orgA,
        userId: userAdmin,
        role: "admin",
        createdAt: new Date(),
      },
      {
        id: `${PREFIX}m_member`,
        organizationId: orgA,
        userId: userMember,
        role: "member",
        createdAt: new Date(),
      },
    ]);
  });

  beforeEach(async () => {
    await queryClient`
      UPDATE organization
      SET halted_at = NULL, halted_reason = NULL, halted_by = NULL
      WHERE id LIKE ${`${PREFIX}%`}
    `;
    await queryClient`DELETE FROM org_value_reservations WHERE organization_id LIKE ${`${PREFIX}%`}`;
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("trips only the target org (cross-org isolation) and records reason/actor", async () => {
    const result = await tripOrgCircuitBreaker({
      organizationId: orgA,
      reason: "spend anomaly",
      byWorkflowId: "wf_monitor",
    });

    expect(result.tripped).toBe(true);
    expect(await haltedAtOf(orgA)).not.toBeNull();
    expect(await haltedAtOf(orgB)).toBeNull();
    expect(await haltMetaOf(orgA)).toEqual({
      reason: "spend anomaly",
      by: "wf_monitor",
    });

    expect(await isOrgHalted(db, orgA)).toBe(true);
    expect(await isOrgHalted(db, orgB)).toBe(false);
  });

  it("is idempotent: a second trip does not move the timestamp or overwrite reason/actor", async () => {
    const first = await tripOrgCircuitBreaker({
      organizationId: orgA,
      reason: "first",
      byWorkflowId: "wf_1",
    });
    const second = await tripOrgCircuitBreaker({
      organizationId: orgA,
      reason: "second",
      byWorkflowId: "wf_2",
    });

    expect(first.tripped).toBe(true);
    expect(second.tripped).toBe(false);
    expect(second.haltedAt.getTime()).toBe(first.haltedAt.getTime());
    expect(await haltMetaOf(orgA)).toEqual({ reason: "first", by: "wf_1" });
  });

  it("re-engages without throwing after a reset (org exists, currently not halted)", async () => {
    await tripOrgCircuitBreaker({ organizationId: orgA });
    await resetOrgCircuitBreaker({
      organizationId: orgA,
      requestedByUserId: userAdmin,
    });

    const again = await tripOrgCircuitBreaker({
      organizationId: orgA,
      reason: "second incident",
    });

    expect(again.tripped).toBe(true);
    expect(await isOrgHalted(db, orgA)).toBe(true);
    expect(await haltMetaOf(orgA)).toEqual({
      reason: "second incident",
      by: null,
    });
  });

  it("serializes concurrent trips under a row lock: no throw, halted exactly once", async () => {
    const [a, b] = await Promise.all([
      tripOrgCircuitBreaker({
        organizationId: orgA,
        reason: "a",
        byWorkflowId: "wf_a",
      }),
      tripOrgCircuitBreaker({
        organizationId: orgA,
        reason: "b",
        byWorkflowId: "wf_b",
      }),
    ]);

    // Exactly one call engaged the breaker; the other saw it already halted.
    expect([a.tripped, b.tripped].sort()).toEqual([false, true]);
    expect(a.haltedAt.getTime()).toBe(b.haltedAt.getTime());
    expect(await isOrgHalted(db, orgA)).toBe(true);
  });

  it("throws only for a genuinely missing organization", async () => {
    await expect(
      tripOrgCircuitBreaker({ organizationId: `${PREFIX}nonexistent` })
    ).rejects.toThrow("Organization not found");
  });

  it("refuses a reset from a non-admin member and leaves the breaker engaged", async () => {
    await tripOrgCircuitBreaker({ organizationId: orgA });

    const result = await resetOrgCircuitBreaker({
      organizationId: orgA,
      requestedByUserId: userMember,
    });

    expect(result).toEqual({ reset: false, reason: "not_authorized" });
    expect(await isOrgHalted(db, orgA)).toBe(true);
  });

  it("refuses a reset from a non-member and from a missing principal", async () => {
    await tripOrgCircuitBreaker({ organizationId: orgA });

    expect(
      await resetOrgCircuitBreaker({
        organizationId: orgA,
        requestedByUserId: `${PREFIX}stranger`,
      })
    ).toEqual({ reset: false, reason: "not_authorized" });
    expect(
      await resetOrgCircuitBreaker({
        organizationId: orgA,
        requestedByUserId: undefined,
      })
    ).toEqual({ reset: false, reason: "not_authorized" });
    expect(await isOrgHalted(db, orgA)).toBe(true);
  });

  it("clears the breaker on an admin reset and is idempotent when already clear", async () => {
    await tripOrgCircuitBreaker({ organizationId: orgA });

    const cleared = await resetOrgCircuitBreaker({
      organizationId: orgA,
      requestedByUserId: userAdmin,
    });
    expect(cleared).toEqual({ reset: true, wasHalted: true });
    expect(await isOrgHalted(db, orgA)).toBe(false);
    expect(await haltMetaOf(orgA)).toEqual({ reason: null, by: null });

    const again = await resetOrgCircuitBreaker({
      organizationId: orgA,
      requestedByUserId: userAdmin,
    });
    expect(again).toEqual({ reset: true, wasHalted: false });
  });

  it("fails a value-moving reservation closed once the org is halted mid-run, per write", async () => {
    // First step of a run: the org is live, so a small value move is allowed.
    const before = await reserveOrgValue({
      organizationId: orgA,
      valueWei: "100",
    });
    expect(before.allowed).toBe(true);

    // The breaker trips between steps (e.g. a sibling monitor workflow fires).
    await tripOrgCircuitBreaker({ organizationId: orgA });

    // The next value-moving step of the same run fails closed, before any cap
    // math, regardless of remaining headroom.
    const after = await reserveOrgValue({
      organizationId: orgA,
      valueWei: "100",
    });
    expect(after).toEqual({ allowed: false, reason: ORG_HALTED_REASON });

    // A different, un-halted org is unaffected.
    const other = await reserveOrgValue({
      organizationId: orgB,
      valueWei: "100",
    });
    expect(other.allowed).toBe(true);
  });
});
