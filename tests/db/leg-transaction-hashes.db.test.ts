/**
 * The cross-pod hash harvest against a real Postgres.
 *
 * loadHashesFromLogs filters in SQL before it reads a row, so a multi-leg step
 * whose output carries only `legTransactions` must pass that filter or every
 * leg is silently dropped from the run's record and its receipt verification.
 * The unit suite stubs the query builder and cannot see the filter.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_leghash_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
const EXECUTION = `${PREFIX}exec`;

async function seed(): Promise<void> {
  await testDb
    .insert(users)
    .values({
      id: USER,
      name: "t",
      email: `${USER}@test.local`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await testDb
    .insert(organization)
    .values({ id: ORG, name: "t", slug: ORG, createdAt: new Date() })
    .onConflictDoNothing();
  await testDb
    .insert(workflows)
    .values({
      id: WORKFLOW,
      name: "t",
      userId: USER,
      organizationId: ORG,
      nodes: [],
      edges: [],
    })
    .onConflictDoNothing();
  await testDb.insert(workflowExecutions).values({
    id: EXECUTION,
    workflowId: WORKFLOW,
    userId: USER,
    organizationId: ORG,
    status: "running",
  });
}

async function log(
  nodeId: string,
  outputRaw: unknown,
  startedAt: Date
): Promise<void> {
  await testDb.insert(workflowExecutionLogs).values({
    executionId: EXECUTION,
    nodeId,
    nodeName: nodeId,
    nodeType: "web3/disburse",
    status: "success",
    outputRaw,
    startedAt,
    completedAt: startedAt,
  });
}

async function clear(): Promise<void> {
  await testDb
    .delete(workflowExecutionLogs)
    .where(eq(workflowExecutionLogs.executionId, EXECUTION));
  await testDb
    .delete(workflowExecutions)
    .where(eq(workflowExecutions.id, EXECUTION));
}

beforeEach(async () => {
  await clear();
  await seed();
});

afterAll(async () => {
  await clear();
  await testDb.delete(workflows).where(eq(workflows.id, WORKFLOW));
  await testDb.delete(organization).where(eq(organization.id, ORG));
  await testDb.delete(users).where(eq(users.id, USER));
  await queryClient.end();
});

describe("loadHashesFromLogs (real database)", () => {
  it("reads a step that reports its hashes only as legTransactions", async () => {
    const { loadHashesFromLogs } = await import(
      "../../lib/workflow/executor/logging"
    );
    await log(
      "write-1",
      { transactionHash: "0xsingle", chainId: 1 },
      new Date("2026-09-17T10:00:00Z")
    );
    await log(
      "disburse-1",
      {
        chainId: 84_532,
        legTransactions: [
          { hash: "0xleg0", legIndex: 0 },
          { hash: "0xleg1", legIndex: 1 },
        ],
      },
      new Date("2026-09-17T10:00:01Z")
    );
    await log("http-1", { status: 200 }, new Date("2026-09-17T10:00:02Z"));

    const entries = await loadHashesFromLogs(EXECUTION);

    expect(entries).toEqual([
      expect.objectContaining({ hash: "0xsingle", nodeId: "write-1" }),
      expect.objectContaining({
        hash: "0xleg0",
        nodeId: "disburse-1",
        chainId: 84_532,
        legIndex: 0,
      }),
      expect.objectContaining({ hash: "0xleg1", legIndex: 1 }),
    ]);
  });
});
