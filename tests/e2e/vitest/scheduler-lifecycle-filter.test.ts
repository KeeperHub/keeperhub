import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  member,
  organization,
  users,
  workflowSchedules,
  workflows,
} from "../../../lib/db/schema";
import { signInternalServiceHeaders } from "../../utils/internal-service-auth";

// tests/setup.ts globally mocks @/lib/db with a stub query builder. This suite
// drives the real route against a real database, so restore the genuine module.
vi.unmock("@/lib/db");

// The route authenticates via HMAC, verified against the internal_service_hmac
// secret store. Mock the store so the suite stays self-contained (no seeded DB
// row), and sign requests with the same fixed secret.
const { HMAC_SECRET } = vi.hoisted(() => ({
  HMAC_SECRET: "test-scheduler-lifecycle-hmac-secret",
}));
vi.mock("@/lib/internal-service-hmac-store", () => ({
  listActiveHmacSecrets: vi.fn(() =>
    Promise.resolve([{ secret: HMAC_SECRET, keyVersion: 1 }])
  ),
  lookupHmacSecret: vi.fn(() =>
    Promise.resolve({ secret: HMAC_SECRET, keyVersion: 1 })
  ),
  insertHmacSecret: vi.fn(),
}));

// Proves the scheduler select only returns due workflows that are actually
// runnable: enabled, not soft-deleted, not deactivated, and owned by an ACTIVE
// ORGANIZATION. The org owns the workflow - a deactivated creator alone does
// NOT stop it (that is the org-ownership contract); the owner-deactivation
// cascade stops it by deactivating the org when no active owner remains. The
// query filtering lives in SQL, so this exercises it against a real database
// rather than a mock (a mock returns rows regardless of the WHERE clause).

// Mirror the full-pipeline e2e gate: skip when no database is available. Note
// tests/setup.ts defaults DATABASE_URL, so CI without infra signals via
// SKIP_INFRA_TESTS rather than an unset URL.
const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_keep611_lifecycle_";

type GetHandler = (request: Request) => Promise<Response>;

describe.skipIf(SKIP)("scheduler lifecycle filtering", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let GET: GetHandler;

  const activeOwnerId = `${PREFIX}user_active`;
  const deactivatedCreatorId = `${PREFIX}user_deactivated`;
  const soloOwnerId = `${PREFIX}user_solo_owner`;
  const orgId = `${PREFIX}org`;
  const cascadeOrgId = `${PREFIX}org_cascade`;

  const healthyWorkflowId = `${PREFIX}wf_healthy`;
  const deactivatedCreatorWorkflowId = `${PREFIX}wf_deactivated_creator`;
  const deactivatedOrgWorkflowId = `${PREFIX}wf_deactivated_org`;
  const softDeletedWorkflowId = `${PREFIX}wf_soft_deleted`;
  const disabledWorkflowId = `${PREFIX}wf_disabled`;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM workflow_schedules WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function seedUser(
    id: string,
    deactivatedAt: Date | null
  ): Promise<void> {
    await db.insert(users).values({
      id,
      email: `${id}@keep611.test`,
      emailVerified: false,
      deactivatedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedOrg(id: string): Promise<void> {
    await db.insert(organization).values({
      id,
      name: id,
      slug: id,
      createdAt: new Date(),
    });
  }

  async function seedWorkflow(
    id: string,
    userId: string,
    options: {
      enabled: boolean;
      deletedAt: Date | null;
      organizationId?: string;
    }
  ): Promise<void> {
    await db.insert(workflows).values({
      id,
      name: id,
      userId,
      organizationId: options.organizationId ?? orgId,
      nodes: [],
      edges: [],
      visibility: "private",
      enabled: options.enabled,
      deletedAt: options.deletedAt,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedSchedule(workflowId: string): Promise<void> {
    await db.insert(workflowSchedules).values({
      id: `${PREFIX}sched_${workflowId}`,
      workflowId,
      cronExpression: "0 9 * * *",
      timezone: "UTC",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function fetchScheduledWorkflowIds(): Promise<Set<string>> {
    const url = "http://localhost/api/internal/schedules";
    const response = await GET(
      new Request(url, {
        headers: signInternalServiceHeaders({
          method: "GET",
          url,
          caller: "scheduler",
          secret: HMAC_SECRET,
        }),
      })
    );
    expect(response.status).toBe(200);
    const { schedules } = (await response.json()) as {
      schedules: { workflowId: string }[];
    };
    return new Set(schedules.map((s) => s.workflowId));
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    await seedUser(activeOwnerId, null);
    // Seeded already-deactivated (INSERT, not UPDATE) so the owner cascade
    // does not fire: their org stays active, isolating the creator-only case.
    await seedUser(deactivatedCreatorId, new Date());
    await seedUser(soloOwnerId, null);

    await seedOrg(orgId);
    await seedOrg(cascadeOrgId);
    // soloOwner is the only owner of cascadeOrg, so deactivating them below
    // must cascade to the org (no active owner remains).
    await db.insert(member).values({
      id: `${PREFIX}member_solo`,
      organizationId: cascadeOrgId,
      userId: soloOwnerId,
      role: "owner",
      createdAt: new Date(),
    });

    await seedWorkflow(healthyWorkflowId, activeOwnerId, {
      enabled: true,
      deletedAt: null,
    });
    await seedWorkflow(deactivatedCreatorWorkflowId, deactivatedCreatorId, {
      enabled: true,
      deletedAt: null,
    });
    await seedWorkflow(deactivatedOrgWorkflowId, soloOwnerId, {
      enabled: true,
      deletedAt: null,
      organizationId: cascadeOrgId,
    });
    await seedWorkflow(softDeletedWorkflowId, activeOwnerId, {
      enabled: true,
      deletedAt: new Date(),
    });
    await seedWorkflow(disabledWorkflowId, activeOwnerId, {
      enabled: false,
      deletedAt: null,
    });

    await seedSchedule(healthyWorkflowId);
    await seedSchedule(deactivatedCreatorWorkflowId);
    await seedSchedule(deactivatedOrgWorkflowId);
    await seedSchedule(softDeletedWorkflowId);
    await seedSchedule(disabledWorkflowId);

    // Deactivate the solo owner via UPDATE so the cascade trigger fires and
    // deactivates cascadeOrg - the same path production deactivation takes.
    await db
      .update(users)
      .set({ deactivatedAt: new Date() })
      .where(eq(users.id, soloOwnerId));

    ({ GET } = (await import("../../../app/api/internal/schedules/route")) as {
      GET: GetHandler;
    });
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("excludes deleted, disabled, and deactivated-org workflows but keeps a deactivated creator's workflow in an active org", async () => {
    const returnedWorkflowIds = await fetchScheduledWorkflowIds();

    expect(returnedWorkflowIds.has(healthyWorkflowId)).toBe(true);
    // The org owns the workflow: the creator's own deactivation does not stop
    // it while the org remains active.
    expect(returnedWorkflowIds.has(deactivatedCreatorWorkflowId)).toBe(true);
    // The owner cascade deactivated cascadeOrg, so its workflow is excluded.
    expect(returnedWorkflowIds.has(deactivatedOrgWorkflowId)).toBe(false);
    expect(returnedWorkflowIds.has(softDeletedWorkflowId)).toBe(false);
    expect(returnedWorkflowIds.has(disabledWorkflowId)).toBe(false);
  });

  it("starts returning the schedule once the org is reactivated (manual ops action)", async () => {
    await db
      .update(organization)
      .set({ deactivatedAt: null })
      .where(eq(organization.id, cascadeOrgId));

    const returnedWorkflowIds = await fetchScheduledWorkflowIds();

    expect(returnedWorkflowIds.has(deactivatedOrgWorkflowId)).toBe(true);
  });
});
