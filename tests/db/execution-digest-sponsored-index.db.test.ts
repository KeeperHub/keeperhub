/**
 * The digest's sponsored-step count against a real Postgres.
 *
 * idx_exec_logs_sponsored_execution is partial, and the planner uses a partial
 * index only when it can match the query clause to the index predicate. When
 * the two drift apart nothing fails: the count still comes back right, it just
 * goes back to de-TOASTing every log row in the window. This file is what
 * notices. It also runs the migration that moved the predicate against both
 * states the index can be found in.
 */

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, count, eq, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";

// vitest runs in Node, not an SSR context; the digest module is server-only.
vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_sponsored_idx_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
const EXECUTION = `${PREFIX}run`;
const INDEX = "idx_exec_logs_sponsored_execution";
const OUTPUT_PREDICATE = "((output ->> 'sponsored'::text) = 'true'::text)";
const NOW = new Date("2026-09-09T12:00:00.000Z");

type Digest = typeof import("@/lib/notifications/execution-digest");

/** The statements of the migration that moved the predicate, found by name. */
function rekeyMigration(): string[] {
  const dir = path.resolve(process.cwd(), "drizzle");
  const file = readdirSync(dir).find((name) =>
    name.endsWith("_sponsored_index_on_output.sql")
  );
  if (!file) {
    throw new Error("the migration that re-keys the sponsored index is gone");
  }
  return readFileSync(path.join(dir, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("digest sponsored-step index (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let sponsoredStepFilter: Digest["sponsoredStepFilter"];

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${like}`;
  }

  async function indexState(): Promise<{
    oid: string;
    predicate: string;
  } | null> {
    const rows = await queryClient`
      SELECT indexrelid::text AS oid, pg_get_expr(indpred, indrelid) AS predicate
        FROM pg_index
       WHERE indexrelid = to_regclass(${`public.${INDEX}`})`;
    const row = rows[0];
    return row ? { oid: row.oid, predicate: row.predicate } : null;
  }

  /** Whether the planner reaches for the index to answer this filter. */
  async function planUsesIndex(filter: SQL): Promise<boolean> {
    const query = db
      .select({ value: count() })
      .from(workflowExecutionLogs)
      .where(and(eq(workflowExecutionLogs.executionId, EXECUTION), filter))
      .toSQL();
    const plan = await queryClient.begin(async (tx) => {
      // Take the cheap way out of the comparison: with a sequential or bitmap
      // scan on the table the question of which index matches never comes up.
      await tx`SET LOCAL enable_seqscan = off`;
      await tx`SET LOCAL enable_bitmapscan = off`;
      return await tx.unsafe(
        `EXPLAIN (FORMAT JSON) ${query.sql}`,
        query.params as never[]
      );
    });
    return JSON.stringify(plan).includes(`"Index Name":"${INDEX}"`);
  }

  beforeAll(async () => {
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    ({ sponsoredStepFilter } = await import(
      "@/lib/notifications/execution-digest"
    ));

    await cleanup();
    await db.insert(users).values({
      id: USER,
      name: "sponsored index probe",
      email: `${PREFIX}probe@keeperhub.test`,
      emailVerified: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db
      .insert(organization)
      .values({ id: ORG, name: ORG, slug: ORG, createdAt: NOW });
    await db.insert(workflows).values({
      id: WORKFLOW,
      name: "sponsored index workflow",
      userId: USER,
      organizationId: ORG,
      nodes: [],
      edges: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(workflowExecutions).values({
      id: EXECUTION,
      workflowId: WORKFLOW,
      organizationId: ORG,
      userId: USER,
      status: "success",
      startedAt: NOW,
    });
    // Mostly unsponsored, the way real runs are, so the partial index is the
    // cheaper of the two indexes on execution_id and the plan is deterministic.
    await db.insert(workflowExecutionLogs).values(
      Array.from({ length: 300 }, (_, i) => ({
        id: `${PREFIX}log_${i}`,
        executionId: EXECUTION,
        nodeId: `n${i}`,
        nodeName: `n${i}`,
        nodeType: "action",
        status: "success" as const,
        output: i < 3 ? { sponsored: true } : { ok: true },
        outputRaw: i < 3 ? { sponsored: true } : { ok: true },
        startedAt: NOW,
        timestamp: NOW,
      }))
    );
    await queryClient`ANALYZE workflow_execution_logs`;
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("keys the index on output once every migration has run", async () => {
    expect((await indexState())?.predicate).toBe(OUTPUT_PREDICATE);
  });

  it("answers the digest's sponsored filter from that index", async () => {
    expect(await planUsesIndex(sponsoredStepFilter())).toBe(true);
  });

  it("cannot use it for a filter on output_raw, which is the drift this guards", async () => {
    const onOutputRaw = sql`${workflowExecutionLogs.outputRaw}->>'sponsored' = 'true'`;
    expect(await planUsesIndex(onOutputRaw)).toBe(false);
  });

  it("the re-key migration leaves an index that already has the output predicate", async () => {
    const before = await indexState();
    for (const statement of rekeyMigration()) {
      await queryClient.unsafe(statement);
    }
    expect(await indexState()).toEqual(before);
  });

  it("the re-key migration replaces an index still keyed on output_raw", async () => {
    await queryClient.unsafe(`DROP INDEX IF EXISTS ${INDEX}`);
    await queryClient.unsafe(
      `CREATE INDEX ${INDEX} ON workflow_execution_logs USING btree (execution_id) WHERE output_raw ->> 'sponsored' = 'true'`
    );
    const before = await indexState();
    expect(before?.predicate).toContain("output_raw");

    for (const statement of rekeyMigration()) {
      await queryClient.unsafe(statement);
    }

    const after = await indexState();
    expect(after?.predicate).toBe(OUTPUT_PREDICATE);
    expect(after?.oid).not.toBe(before?.oid);
  });
});
