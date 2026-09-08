import "dotenv/config";
import { eq } from "drizzle-orm";
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
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => ({ authenticated: true })),
}));
// The reaper increments a per-org counter per reaped row; stub it so the test
// stays focused on the SQL (codes + predicates) without the metrics pipeline.
vi.mock("@/lib/errors/finalize-error", () => ({
  recordExecutionErrorFinalized: vi.fn(async () => {
    /* no-op */
  }),
}));
// tests/setup.ts globally mocks @/lib/db. Drive the real reaper query against a
// real database instead.
vi.unmock("@/lib/db");

import { GET } from "@/app/api/internal/reaper/route";

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = "test_keep693_reaper_";
const MIN = 60 * 1000;

// The reaper's error_code is a CASE on the pre-update status AND step-log
// presence, applied across the OR'd stuck-state predicates. A running row that
// produced a step log then stalled is workflow_engine/E-0001; a running row that
// never logged a step is infrastructure/P-0001, like pending/phantom. The CASE
// and the WHERE live in SQL, so this exercises them against a real database.
describe.skipIf(SKIP)("reaper error codes", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  const ownerId = `${PREFIX}user`;
  const orgId = `${PREFIX}org`;
  const workflowId = `${PREFIX}wf`;

  async function cleanupRows(): Promise<void> {
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function seed(
    id: string,
    status: "running" | "pending" | "phantom",
    ageMs: number
  ): Promise<void> {
    await db.insert(workflowExecutions).values({
      id,
      workflowId,
      userId: ownerId,
      status,
      startedAt: new Date(Date.now() - ageMs),
    });
  }

  async function read(id: string) {
    const [row] = await db
      .select()
      .from(workflowExecutions)
      .where(eq(workflowExecutions.id, id));
    return row;
  }

  function reaperRequest(): Request {
    return new Request("http://localhost:3000/api/internal/reaper", {
      headers: { "X-Service-Key": "test-key" },
    });
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;

    await db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@keep693.test`,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(organization).values({
      id: orgId,
      name: orgId,
      slug: orgId,
      createdAt: new Date(),
    });
    await db.insert(workflows).values({
      id: workflowId,
      name: workflowId,
      userId: ownerId,
      organizationId: orgId,
      nodes: [],
      edges: [],
      visibility: "private",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await cleanupRows();
  });

  afterAll(async () => {
    await cleanupRows();
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient.end();
  });

  it("codes each reaped row by its pre-update status", async () => {
    await seed(`${PREFIX}running`, "running", 31 * MIN);
    // Give the running row a step log (never completed) so it counts as
    // progressed-then-stalled -> workflow_engine/E-0001, not never-started.
    await db.insert(workflowExecutionLogs).values({
      executionId: `${PREFIX}running`,
      nodeId: "trigger",
      nodeName: "Trigger",
      nodeType: "trigger",
      status: "running",
      startedAt: new Date(Date.now() - 31 * MIN),
    });
    await seed(`${PREFIX}pending`, "pending", 10 * MIN);
    await seed(`${PREFIX}phantom`, "phantom", 10 * MIN);

    const response = await GET(reaperRequest());
    expect(response.status).toBe(200);

    const running = await read(`${PREFIX}running`);
    expect(running.status).toBe("system_error");
    expect(running.errorCode).toBe("E-0001");
    expect(running.errorCategory).toBe("workflow_engine");

    const pending = await read(`${PREFIX}pending`);
    expect(pending.status).toBe("system_error");
    expect(pending.errorCode).toBe("P-0001");
    expect(pending.errorCategory).toBe("infrastructure");

    const phantom = await read(`${PREFIX}phantom`);
    expect(phantom.status).toBe("system_error");
    expect(phantom.errorCode).toBe("P-0005");
    expect(phantom.errorCategory).toBe("infrastructure");
  });

  it("leaves a fresh phantom untouched (not yet aged out)", async () => {
    await seed(`${PREFIX}fresh`, "phantom", 0);

    const response = await GET(reaperRequest());
    expect(response.status).toBe(200);

    const fresh = await read(`${PREFIX}fresh`);
    expect(fresh.status).toBe("phantom");
    expect(fresh.errorCode).toBeNull();
  });
});
