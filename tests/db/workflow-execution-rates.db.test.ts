/**
 * The per-workflow execution rate collector against a real Postgres.
 *
 * It runs on every metrics scrape, on the metrics pool and under its statement
 * timeout, so two things matter beyond the numbers: the one-hour window must be
 * answerable from idx_workflow_executions_started_at rather than a scan of the
 * whole run table, and the FILTER on the errored statuses must count what the
 * alert thinks it counts.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";

// vitest runs in Node, not an SSR context; the metrics module is server-only.
vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_rates_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WF_BUSY = `${PREFIX}wf_busy`;
const WF_BAD = `${PREFIX}wf_bad`;
const WF_OLD = `${PREFIX}wf_old`;
const MINUTE_MS = 60 * 1000;

type Metrics = typeof import("@/lib/metrics/db-metrics");

describe("per-workflow execution rates (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let metrics: Metrics;

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${like}`;
  }

  beforeAll(async () => {
    // Seeds organizations into a database the retention suite counts in full.
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    metrics = await import("@/lib/metrics/db-metrics");

    await cleanup();
    // The window is now() - 1 hour inside the query, so the seed is relative to
    // the wall clock rather than to a fixed instant.
    const now = Date.now();
    const minutesAgo = (minutes: number): Date =>
      new Date(now - minutes * MINUTE_MS);

    await db.insert(users).values({
      id: USER,
      name: "rates probe",
      email: `${PREFIX}probe@keeperhub.test`,
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await db
      .insert(organization)
      .values({ id: ORG, name: ORG, slug: ORG, createdAt: new Date(now) });
    await db.insert(workflows).values(
      [WF_BUSY, WF_BAD, WF_OLD].map((id) => ({
        id,
        name: id,
        userId: USER,
        organizationId: ORG,
        nodes: [],
        edges: [],
      }))
    );

    const run = (
      workflowId: string,
      n: number,
      status: "success" | "error" | "system_error",
      startedAt: Date
    ) => ({
      id: `${workflowId}_run_${status}_${n}`,
      workflowId,
      userId: USER,
      status,
      startedAt,
    });
    await db.insert(workflowExecutions).values([
      ...[1, 2, 3, 4, 5].map((n) => run(WF_BUSY, n, "success", minutesAgo(10))),
      run(WF_BAD, 1, "error", minutesAgo(20)),
      run(WF_BAD, 2, "system_error", minutesAgo(30)),
      run(WF_BAD, 3, "success", minutesAgo(40)),
      // Outside the window: two hours old, however many there are.
      ...[1, 2, 3, 4, 5, 6, 7].map((n) =>
        run(WF_OLD, n, "error", minutesAgo(120))
      ),
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("counts runs and errored runs per workflow inside the last hour only", async () => {
    const rates = await metrics.getWorkflowExecutionRatesFromDb();
    const mine = rates
      .filter((rate) => rate.workflowId.startsWith(PREFIX))
      .sort((a, b) => a.workflowId.localeCompare(b.workflowId));

    expect(mine).toEqual([
      { workflowId: WF_BAD, orgSlug: ORG, runs: 3, errored: 2 },
      { workflowId: WF_BUSY, orgSlug: ORG, runs: 5, errored: 0 },
    ]);
  });

  it("answers the window from idx_workflow_executions_started_at", async () => {
    const query = metrics.workflowExecutionRatesQuery().toSQL();
    const plan = await queryClient.begin(async (tx) => {
      // A handful of seeded rows makes a sequential scan the cheapest plan,
      // so it is turned off to ask whether the index can answer at all.
      await tx`SET LOCAL enable_seqscan = off`;
      return await tx.unsafe(
        `EXPLAIN (FORMAT JSON) ${query.sql}`,
        query.params as never[]
      );
    });
    expect(JSON.stringify(plan)).toContain(
      '"Index Name":"idx_workflow_executions_started_at"'
    );
  });
});
