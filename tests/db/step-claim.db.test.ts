/**
 * The step claim against a real Postgres.
 *
 * The unit suite stubs the drizzle builder, so it asserts which branch runs,
 * never what the database does with the SQL. Every defect this file guards is
 * invisible there: `SET LOCAL statement_timeout = $1` is a syntax error that
 * only surfaces against a real server, and the whole module resolves a failed
 * claim to "run the step", so a broken statement would have degraded silently
 * to no deduplication at all while emitting a warning per step.
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
  workflowStepClaims,
  workflows,
} from "../../lib/db/schema";

vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");
// No Redis in the db suite; the module must fall through to Postgres, which is
// also the path that carries the guarantee.
vi.mock("@/lib/redis", () => ({ getRedis: () => null }));

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const queryClient = postgres(DATABASE_URL, { max: 2 });
const testDb = drizzle(queryClient);

const PREFIX = "test_claim_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
const EXECUTION = `${PREFIX}exec`;
const NODE = "node-1";
const SCOPE = { executionId: EXECUTION, nodeId: NODE };

/** No real waiting: a loser with nothing to wait for runs both rounds. */
const NO_WAIT = {
  timeoutMs: 0,
  totalWaitMs: 0,
  sleep: () => Promise.resolve(),
};

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

async function recordWinnerSuccess(output: unknown): Promise<void> {
  await testDb.insert(workflowExecutionLogs).values({
    executionId: EXECUTION,
    nodeId: NODE,
    nodeName: "n",
    nodeType: "evm-chain/chain-info",
    status: "success",
    outputRaw: output,
    completedAt: new Date(),
  });
}

beforeEach(async () => {
  await testDb
    .delete(workflowExecutionLogs)
    .where(eq(workflowExecutionLogs.executionId, EXECUTION));
  await testDb
    .delete(workflowExecutions)
    .where(eq(workflowExecutions.id, EXECUTION));
  await seed();
});

afterAll(async () => {
  await testDb
    .delete(workflowExecutionLogs)
    .where(eq(workflowExecutionLogs.executionId, EXECUTION));
  await testDb
    .delete(workflowExecutions)
    .where(eq(workflowExecutions.id, EXECUTION));
  await testDb.delete(workflows).where(eq(workflows.id, WORKFLOW));
  await testDb.delete(organization).where(eq(organization.id, ORG));
  await testDb.delete(users).where(eq(users.id, USER));
  await queryClient.end();
});

describe("step claim (real database)", () => {
  it("grants the claim to exactly one of two concurrent callers", async () => {
    const { acquireStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await recordWinnerSuccess({ latestBlock: 123 });

    const [a, b] = await Promise.all([
      acquireStepClaim(SCOPE, NO_WAIT),
      acquireStepClaim(SCOPE, NO_WAIT),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["reuse", "run"]);
  });

  it("hands the loser the winner's recorded output", async () => {
    const { acquireStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    expect((await acquireStepClaim(SCOPE, NO_WAIT)).outcome).toBe("run");
    await recordWinnerSuccess({ latestBlock: 25_977_159 });

    expect(await acquireStepClaim(SCOPE, NO_WAIT)).toEqual({
      outcome: "reuse",
      output: { latestBlock: 25_977_159 },
    });
  });

  it("ignores an orphaned error row and returns the success output", async () => {
    // releaseStepClaim on failure leaves exactly this shape behind. An
    // unordered read that accepted either status could hand back the failure.
    const { acquireStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await testDb.insert(workflowExecutionLogs).values({
      executionId: EXECUTION,
      nodeId: NODE,
      nodeName: "n",
      nodeType: "evm-chain/chain-info",
      status: "error",
      error: "boom",
      completedAt: new Date(Date.now() - 1000),
    });
    await recordWinnerSuccess({ latestBlock: 7 });
    await acquireStepClaim(SCOPE, NO_WAIT);

    expect(await acquireStepClaim(SCOPE, NO_WAIT)).toEqual({
      outcome: "reuse",
      output: { latestBlock: 7 },
    });
  });

  it("lets a later attempt run the step after the claim is released", async () => {
    const { acquireStepClaim, releaseStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    expect((await acquireStepClaim(SCOPE, NO_WAIT)).outcome).toBe("run");
    await releaseStepClaim(SCOPE);

    expect((await acquireStepClaim(SCOPE, NO_WAIT)).outcome).toBe("run");
  });

  it("drops an execution's claims when the run finishes", async () => {
    const { acquireStepClaim, clearStepClaims } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await acquireStepClaim(SCOPE, NO_WAIT);
    await clearStepClaims(EXECUTION);

    const rows = await testDb
      .select()
      .from(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, EXECUTION));
    expect(rows).toHaveLength(0);
  });

  it("ignores an iteration row when reading the node's own output", async () => {
    // A node reachable from both a For Each loop handle and its done handle
    // has iteration rows too, and one of those is not this step's output.
    const { acquireStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await testDb.insert(workflowExecutionLogs).values({
      executionId: EXECUTION,
      nodeId: NODE,
      nodeName: "n",
      nodeType: "evm-chain/chain-info",
      status: "success",
      outputRaw: { fromIteration: true },
      forEachNodeId: "loop-1",
      iterationIndex: 0,
      completedAt: new Date(),
    });
    await acquireStepClaim(SCOPE, NO_WAIT);

    // Only the iteration row exists, so there is no top-level output to reuse.
    expect(await acquireStepClaim(SCOPE, NO_WAIT)).toEqual({
      outcome: "run",
      owns: false,
    });

    await recordWinnerSuccess({ topLevel: true });
    expect(await acquireStepClaim(SCOPE, NO_WAIT)).toEqual({
      outcome: "reuse",
      output: { topLevel: true },
    });
  });

  it("keeps claims while any step of the run is still running", async () => {
    // A run is finalized while pending tasks may still be draining. Clearing
    // a live step's claim would let the next replay run beside its owner.
    const { acquireStepClaim, clearStepClaims } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await acquireStepClaim(SCOPE, NO_WAIT);
    await testDb.insert(workflowExecutionLogs).values({
      executionId: EXECUTION,
      nodeId: "node-2",
      nodeName: "still going",
      nodeType: "HTTP Request",
      status: "running",
    });

    await clearStepClaims(EXECUTION);

    const rows = await testDb
      .select()
      .from(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, EXECUTION));
    expect(rows).toHaveLength(1);
  });

  it("takes claims with the execution row, so retention needs no pass", async () => {
    const { acquireStepClaim } = await import(
      "../../lib/workflow/executor/step-claim"
    );
    await acquireStepClaim(SCOPE, NO_WAIT);
    await testDb
      .delete(workflowExecutionLogs)
      .where(eq(workflowExecutionLogs.executionId, EXECUTION));
    await testDb
      .delete(workflowExecutions)
      .where(eq(workflowExecutions.id, EXECUTION));

    const rows = await testDb
      .select()
      .from(workflowStepClaims)
      .where(eq(workflowStepClaims.executionId, EXECUTION));
    expect(rows).toHaveLength(0);
  });
});
