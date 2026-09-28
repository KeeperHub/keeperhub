/**
 * The transaction-hash backfill against a real Postgres.
 *
 * An array the backfill writes is never rewritten, because every later run
 * skips a non-empty one. A run written with part of its steps, or a failed run
 * given a success-steps-only record, would stay that way, so the shape has to
 * be right the first time.
 *
 * The database must be exclusively this file's: the backfill pages over every
 * run in it, so the counts below only hold on a scratch database.
 */

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
import {
  organization,
  users,
  workflowExecutions,
  workflows,
} from "../../lib/db/schema";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));
// tests/setup.ts globally stubs @/lib/db. The whole point here is the SQL.
vi.unmock("@/lib/db");

const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_txbackfill_";
const USER = `${PREFIX}user`;
const ORG = `${PREFIX}org`;
const WORKFLOW = `${PREFIX}wf`;
// Candidates page in execution-id order, so these names fix the batch order.
const RUN_MULTI = `${PREFIX}run_a_multi`;
const RUN_LOOSE_TYPES = `${PREFIX}run_b_loose_types`;
const RUN_UNRECORDABLE = `${PREFIX}run_c_unrecordable`;
const RUN_FAILED = `${PREFIX}run_d_failed`;
const RUN_FILLED = `${PREFIX}run_e_filled`;

const NOW = new Date("2026-09-09T12:00:00.000Z");
const at = (seconds: number): string =>
  new Date(NOW.getTime() + seconds * 1000).toISOString();
const hash = (n: number): string => `0x${n.toString(16).padStart(64, "0")}`;

type StepFields = {
  status?: "success" | "error";
  output: Record<string, unknown>;
  seconds: number;
  iterationIndex?: number;
  gasUsedWei?: string | null;
};

type Backfill = typeof import("@/lib/workflow/transaction-hash-backfill");

describe("transaction hash backfill (real database)", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let backfillTransactionHashes: Backfill["backfillTransactionHashes"];

  async function cleanup(): Promise<void> {
    const like = `${PREFIX}%`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${like}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${like}`;
  }

  async function step(
    executionId: string,
    nodeId: string,
    fields: StepFields
  ): Promise<void> {
    const gasUsedWei =
      fields.gasUsedWei === undefined ? "21000" : fields.gasUsedWei;
    await queryClient`
      INSERT INTO workflow_execution_logs
        (id, execution_id, node_id, node_name, node_type, status, output,
         started_at, timestamp, gas_used_wei, iteration_index)
      VALUES
        (${`${executionId}_${nodeId}`}, ${executionId}, ${nodeId},
         ${`Step ${nodeId}`}, 'action', ${fields.status ?? "success"},
         ${JSON.stringify(fields.output)}::jsonb, ${at(fields.seconds)},
         ${at(fields.seconds)}, ${gasUsedWei}, ${fields.iterationIndex ?? null})`;
  }

  async function seed(): Promise<void> {
    await cleanup();
    await db.insert(users).values({
      id: USER,
      name: "backfill probe",
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
      name: "backfill workflow",
      userId: USER,
      organizationId: ORG,
      nodes: [],
      edges: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db.insert(workflowExecutions).values(
      [
        [RUN_MULTI, "success"],
        [RUN_LOOSE_TYPES, "success"],
        [RUN_UNRECORDABLE, "success"],
        [RUN_FAILED, "error"],
        [RUN_FILLED, "success"],
      ].map(([id, status]) => ({
        id,
        workflowId: WORKFLOW,
        organizationId: ORG,
        userId: USER,
        status: status as "success",
        startedAt: NOW,
      }))
    );
    await queryClient`UPDATE workflow_executions
                         SET transaction_hashes = ${JSON.stringify([
                           {
                             hash: hash(90),
                             nodeId: "earlier",
                             nodeName: "Earlier",
                           },
                         ])}::jsonb
                       WHERE id = ${RUN_FILLED}`;

    // Two recordable hashes, one repeated, one on a failed step, one step
    // without a hash, and one hash step that spent no gas.
    await step(RUN_MULTI, "s1", {
      output: { transactionHash: hash(1), chainId: 1, network: "ethereum" },
      seconds: 1,
    });
    await step(RUN_MULTI, "s2", {
      output: { transactionHash: hash(2), chainId: 1 },
      seconds: 2,
      iterationIndex: 0,
      gasUsedWei: null,
    });
    await step(RUN_MULTI, "s3", {
      output: { transactionHash: hash(1), chainId: 1 },
      seconds: 3,
    });
    await step(RUN_MULTI, "s4", {
      status: "error",
      output: { transactionHash: hash(3), chainId: 1 },
      seconds: 4,
    });
    await step(RUN_MULTI, "s5", { output: { ok: true }, seconds: 5 });

    // chainId as a string and network as a number: the writer keeps neither.
    await step(RUN_LOOSE_TYPES, "s1", {
      output: { transactionHash: hash(4), chainId: "1", network: 7 },
      seconds: 1,
    });
    // isRecordableTransactionHash only asks an EVM hash for its 0x prefix.
    await step(RUN_UNRECORDABLE, "s1", {
      output: { transactionHash: "not-a-hash", chainId: 1 },
      seconds: 1,
    });
    await step(RUN_FAILED, "s1", {
      output: { transactionHash: hash(5), chainId: 1 },
      seconds: 1,
    });
    await step(RUN_FILLED, "s1", {
      output: { transactionHash: hash(6), chainId: 1 },
      seconds: 1,
    });
  }

  async function hashesOf(id: string): Promise<unknown> {
    const rows =
      await queryClient`SELECT transaction_hashes FROM workflow_executions WHERE id = ${id}`;
    return rows[0]?.transaction_hashes;
  }

  beforeAll(async () => {
    // This suite writes to every run in the database. Refuse to run anywhere
    // but a local scratch database.
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1", "postgres", "db"].includes(host)) {
      throw new Error(`refusing to run against a non-local database: ${host}`);
    }
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    ({ backfillTransactionHashes } = await import(
      "@/lib/workflow/transaction-hash-backfill"
    ));
  });

  beforeEach(seed);

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  it("writes every hash step of a run, in order and deduplicated, even one run per batch", async () => {
    await backfillTransactionHashes({ dryRun: false, batchSize: 1 });

    expect(await hashesOf(RUN_MULTI)).toEqual([
      {
        hash: hash(1),
        nodeId: "s1",
        nodeName: "Step s1",
        chainId: 1,
        network: "ethereum",
      },
      {
        hash: hash(2),
        nodeId: "s2",
        nodeName: "Step s2",
        chainId: 1,
        iterationIndex: 0,
      },
    ]);
  });

  it("keeps chainId and network only when they have the types the writer keeps", async () => {
    await backfillTransactionHashes({ dryRun: false, batchSize: 500 });

    expect(await hashesOf(RUN_LOOSE_TYPES)).toEqual([
      { hash: hash(4), nodeId: "s1", nodeName: "Step s1" },
    ]);
  });

  it("leaves failed runs, filled arrays and unrecordable hashes alone", async () => {
    await backfillTransactionHashes({ dryRun: false, batchSize: 500 });

    expect(await hashesOf(RUN_FAILED)).toEqual([]);
    expect(await hashesOf(RUN_UNRECORDABLE)).toEqual([]);
    expect(await hashesOf(RUN_FILLED)).toEqual([
      { hash: hash(90), nodeId: "earlier", nodeName: "Earlier" },
    ]);
  });

  it("counts in a dry run and writes nothing", async () => {
    const result = await backfillTransactionHashes({
      dryRun: true,
      batchSize: 500,
    });

    expect(result).toEqual({ batches: 1, runs: 2, hashes: 3 });
    expect(await hashesOf(RUN_MULTI)).toEqual([]);
    expect(await hashesOf(RUN_LOOSE_TYPES)).toEqual([]);
  });

  it("stops at maxBatches and picks up where it stopped on the next run", async () => {
    const first = await backfillTransactionHashes({
      dryRun: false,
      batchSize: 1,
      maxBatches: 1,
    });
    expect(first).toEqual({ batches: 1, runs: 1, hashes: 2 });
    expect(await hashesOf(RUN_LOOSE_TYPES)).toEqual([]);

    const second = await backfillTransactionHashes({
      dryRun: false,
      batchSize: 1,
    });
    // RUN_LOOSE_TYPES, then RUN_UNRECORDABLE, which yields nothing to write.
    expect(second).toEqual({ batches: 2, runs: 1, hashes: 1 });
    expect(await hashesOf(RUN_LOOSE_TYPES)).toHaveLength(1);
  });

  it("changes nothing on a second full run", async () => {
    await backfillTransactionHashes({ dryRun: false, batchSize: 500 });
    const again = await backfillTransactionHashes({
      dryRun: false,
      batchSize: 500,
    });

    expect(again.runs).toBe(0);
    expect(again.hashes).toBe(0);
  });
});
