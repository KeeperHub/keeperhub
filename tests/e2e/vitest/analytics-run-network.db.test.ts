import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StepLog, UnifiedRun } from "../../../lib/analytics/types";
import {
  organization,
  users,
  workflowExecutionLogs,
  workflowExecutions,
  workflows,
} from "../../../lib/db/schema";
import { gasCreditUsage } from "../../../lib/db/schema-extensions";

// vitest runs in Node, not an SSR context.
vi.mock("server-only", () => ({}));

// tests/setup.ts globally stubs @/lib/db; this suite needs getUnifiedRuns to
// hit Postgres, because the behaviour under test is which rows survive the
// log-summary subquery's WHERE clause - not the shape of the generated SQL.
vi.unmock("@/lib/db");

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const PREFIX = "test_run_network_";
const ORG_ID = `${PREFIX}org`;
const USER_ID = `${PREFIX}user`;
const WORKFLOW_ID = `${PREFIX}wf`;

/** A run that failed before broadcast: its step named a chain, spent no gas. */
const PREFLIGHT_ID = `${PREFIX}exec_preflight`;
/** A run whose gas-bearing step and read-only step sit on different chains. */
const MIXED_ID = `${PREFIX}exec_mixed`;
/** Pre-migration-0117 pre-flight failure: chain in the JSONB, columns null. */
const LEGACY_ID = `${PREFIX}exec_legacy`;
/** Pre-migration-0117 gas-bearing run: gas in the JSONB, columns null. */
const LEGACY_GAS_ID = `${PREFIX}exec_legacy_gas`;
/** Same shape as LEGACY_ID, reserved for the backfill to repair in place. */
const BACKFILL_ID = `${PREFIX}exec_backfill`;
/** A run whose only record of spend is the sponsorship ledger, not a step. */
const SPONSORED_ID = `${PREFIX}exec_sponsored`;
/** An event-triggered run: trigger, a write that pays its own gas, a read. */
const STEPS_ID = `${PREFIX}exec_steps`;

// Log ids are the backfill's keyset cursor, so they are chosen, not incidental:
// the backfill case runs one batch from the cursor below, and every other
// unbackfilled fixture row sorts before it and is therefore out of that batch's
// reach. Without that the batch would repair the legacy rows too and the cases
// above it would stop testing the unbackfilled path.
const LEGACY_LOG_ID = `${PREFIX}log_za_legacy`;
const LEGACY_GAS_LOG_ID = `${PREFIX}log_zb_legacy_gas`;
const BACKFILL_CURSOR = `${PREFIX}log_zy`;
const BACKFILL_LOG_ID = `${BACKFILL_CURSOR}_backfill`;

describe.skipIf(SKIP)("run network on a pre-broadcast failure", () => {
  let queryClient: ReturnType<typeof postgres>;
  let db: ReturnType<typeof drizzle>;
  let getUnifiedRuns: (
    organizationId: string,
    range: "7d",
    options?: { limit?: number }
  ) => Promise<{ runs: UnifiedRun[] }>;
  let applyBatch: (afterId: string, batchSize: number) => Promise<number>;
  let getStepLogs: (
    executionId: string,
    organizationId: string
  ) => Promise<StepLog[]>;

  async function cleanup(): Promise<void> {
    await queryClient`DELETE FROM gas_credit_usage WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflow_executions WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM member WHERE organization_id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
    await queryClient`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
  }

  async function logNetworkColumn(logId: string): Promise<string | null> {
    const rows =
      await queryClient`SELECT network FROM workflow_execution_logs WHERE id = ${logId}`;
    return (rows[0]?.network as string | null) ?? null;
  }

  beforeAll(async () => {
    queryClient = postgres(DATABASE_URL);
    db = drizzle(queryClient);
    await cleanup();

    const now = new Date();

    await db.insert(organization).values({
      id: ORG_ID,
      name: "run network org",
      slug: ORG_ID,
      createdAt: now,
    });
    await db.insert(users).values({
      id: USER_ID,
      email: `${USER_ID}@keeperhub.test`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(workflows).values({
      id: WORKFLOW_ID,
      name: "run network workflow",
      userId: USER_ID,
      organizationId: ORG_ID,
      enabled: true,
      nodes: [],
      edges: [],
    });

    const execution = (id: string, error?: string) => ({
      id,
      workflowId: WORKFLOW_ID,
      userId: USER_ID,
      status: (error ? "error" : "success") as "error" | "success",
      error,
      startedAt: now,
      completedAt: now,
      totalSteps: "1",
      completedSteps: error ? "0" : "1",
    });

    await db
      .insert(workflowExecutions)
      .values([
        execution(PREFLIGHT_ID, "Insufficient BASE balance"),
        { ...execution(MIXED_ID), totalSteps: "2", completedSteps: "2" },
        execution(LEGACY_ID, "Insufficient BASE balance"),
        execution(LEGACY_GAS_ID),
        execution(BACKFILL_ID, "Insufficient BASE balance"),
        execution(SPONSORED_ID),
        { ...execution(STEPS_ID), totalSteps: "3", completedSteps: "3" },
      ]);

    // Two row shapes matter here, and they are seeded separately on purpose.
    //
    // Post-0117 rows carry the value in both the JSONB and the denormalised
    // column, because logging.ts writes both; the first three rows are those.
    //
    // Pre-0117 rows carry it only in the JSONB - migration 0117 added the
    // columns null and no writer ever went back over the history. Those are the
    // za/zb/zy rows, and they are what makes a column-only read regress: they
    // are seeded with the column NULL so a read that ignores the JSONB returns
    // nothing for them.
    await db.insert(workflowExecutionLogs).values([
      {
        id: `${PREFIX}log_preflight`,
        executionId: PREFLIGHT_ID,
        nodeId: "send-1",
        nodeName: "Send",
        nodeType: "web3",
        status: "error",
        input: { network: "base" },
        error: "Insufficient BASE balance",
        startedAt: now,
        network: "base",
        gasUsedWei: null,
      },
      {
        id: `${PREFIX}log_mixed_write`,
        executionId: MIXED_ID,
        nodeId: "swap-1",
        nodeName: "Swap",
        nodeType: "web3",
        status: "success",
        input: { network: "base" },
        output: { gasUsed: "21000" },
        startedAt: now,
        network: "base",
        gasUsedWei: "21000",
      },
      {
        id: `${PREFIX}log_mixed_read`,
        executionId: MIXED_ID,
        nodeId: "read-1",
        nodeName: "Read balance",
        nodeType: "web3",
        status: "success",
        input: { network: "optimism" },
        startedAt: now,
        network: "optimism",
        gasUsedWei: null,
      },
      {
        id: LEGACY_LOG_ID,
        executionId: LEGACY_ID,
        nodeId: "send-1",
        nodeName: "Send",
        nodeType: "web3",
        status: "error",
        input: { network: "base" },
        error: "Insufficient BASE balance",
        startedAt: now,
        network: null,
        gasUsedWei: null,
      },
      {
        id: LEGACY_GAS_LOG_ID,
        executionId: LEGACY_GAS_ID,
        nodeId: "swap-1",
        nodeName: "Swap",
        nodeType: "web3",
        status: "success",
        input: { network: "base" },
        output: { gasUsed: "31000" },
        startedAt: now,
        network: null,
        gasUsedWei: null,
      },
      {
        id: BACKFILL_LOG_ID,
        executionId: BACKFILL_ID,
        nodeId: "send-1",
        nodeName: "Send",
        nodeType: "web3",
        status: "error",
        input: { network: "base" },
        error: "Insufficient BASE balance",
        startedAt: now,
        network: null,
        gasUsedWei: null,
      },
      {
        id: `${PREFIX}log_steps_a_trigger`,
        executionId: STEPS_ID,
        nodeId: "trigger-1",
        nodeName: "Event",
        nodeType: "trigger",
        status: "success",
        input: { network: "8453" },
        output: { triggerGasUsed: "77000" },
        startedAt: now,
        network: "8453",
        gasUsedWei: null,
      },
      {
        id: `${PREFIX}log_steps_b_write`,
        executionId: STEPS_ID,
        nodeId: "write-1",
        nodeName: "Write contract",
        nodeType: "web3/write-contract",
        status: "success",
        input: { network: "8453" },
        output: { gasUsed: "41000" },
        startedAt: now,
        network: "8453",
        gasUsedWei: "41000",
      },
      {
        id: `${PREFIX}log_steps_c_read`,
        executionId: STEPS_ID,
        nodeId: "read-1",
        nodeName: "Read contract",
        nodeType: "web3/read-contract",
        status: "success",
        input: { network: "8453" },
        startedAt: now,
        network: "8453",
        gasUsedWei: null,
      },
      {
        id: `${PREFIX}log_sponsored`,
        executionId: SPONSORED_ID,
        nodeId: "call-1",
        nodeName: "Contract call",
        nodeType: "web3",
        status: "success",
        input: {},
        startedAt: now,
        network: null,
        gasUsedWei: null,
      },
    ]);

    // The sponsored leg: KeeperHub paid, so the chain and the cost are in the
    // ledger and nowhere else on this run.
    await db.insert(gasCreditUsage).values({
      id: `${PREFIX}ledger_sponsored`,
      organizationId: ORG_ID,
      chainId: 8453,
      txHash: `0x${"a".repeat(64)}`,
      executionId: SPONSORED_ID,
      gasUsed: "21000",
      gasPriceWei: "1000000000",
      gasCostWei: "50000",
      gasCostMicroUsd: "1",
      ethPriceUsd: "3000",
      createdAt: now,
    });

    ({ getUnifiedRuns, getStepLogs } = await import("@/lib/analytics/queries"));
    ({ applyBatch } = await import(
      "@/scripts/lib/exec-log-network-gas-backfill"
    ));
  });

  afterAll(async () => {
    await cleanup();
    await queryClient.end();
  });

  async function runById(id: string): Promise<UnifiedRun> {
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", { limit: 50 });
    const run = runs.find((r) => r.id === id);
    if (!run) {
      throw new Error(`seeded run ${id} missing from getUnifiedRuns`);
    }
    return run;
  }

  it("keeps the chain on a run that spent no gas", async () => {
    const run = await runById(PREFLIGHT_ID);
    expect(run.network).toBe("base");
    expect(run.networks).toEqual(["base"]);
    // No gas was spent, and that must stay distinguishable from "no chain".
    expect(run.gasUsedWei).toBeNull();
    expect(run.gasNetworks).toEqual([]);
  });

  it("still prefers the gas-bearing step's chain as the run's network", async () => {
    const run = await runById(MIXED_ID);
    expect(run.network).toBe("base");
    expect(run.gasUsedWei).toBe("21000");
  });

  it("lists every chain the run's steps targeted, gas-bearing or not", async () => {
    const run = await runById(MIXED_ID);
    expect([...run.networks].sort()).toEqual(["base", "optimism"]);
    // ...while the gas cell reads gasNetworks, which stays the one chain the
    // run actually spent on, so its total is still summable into one token.
    expect(run.gasNetworks).toEqual(["base"]);
  });

  it("reads the chain from the JSONB when the column was never backfilled", async () => {
    expect(await logNetworkColumn(LEGACY_LOG_ID)).toBeNull();
    const run = await runById(LEGACY_ID);
    expect(run.network).toBe("base");
    expect(run.networks).toEqual(["base"]);
  });

  it("reads historical gas from the JSONB when the column was never backfilled", async () => {
    const run = await runById(LEGACY_GAS_ID);
    expect(run.gasUsedWei).toBe("31000");
    expect(run.network).toBe("base");
    // The COALESCE arm feeds gasNetworks too, not just the scalar network.
    expect(run.gasNetworks).toEqual(["base"]);
  });

  it("names the chain a ledger-only sponsored run spent on", async () => {
    const run = await runById(SPONSORED_ID);
    // No step logged a chain or any gas, so before the ledger was read this run
    // had a cost to show and no chain to denominate it in.
    expect(run.gasUsedWei).toBeNull();
    expect(run.gasCostWei).toBe("50000");
    expect(run.gasNetworks).toEqual(["8453"]);
    expect(run.networks).toEqual(["8453"]);
    expect(run.network).toBe("8453");
  });

  it("shows per-node gas the organization's own wallet paid for", async () => {
    const steps = await getStepLogs(STEPS_ID, ORG_ID);
    const byNode = new Map(steps.map((step) => [step.nodeId, step]));

    // The write spent gas and nothing sponsored it, so the ledger holds no row
    // for it. Its own receipt is the only record, and reading the ledger alone
    // left this cell empty.
    expect(byNode.get("write-1")?.gasCostWei).toBe("41000");
    expect(byNode.get("write-1")?.sponsored).toBe(false);

    // A read makes no transaction, so no gas is the right answer, not a gap.
    expect(byNode.get("read-1")?.gasCostWei).toBeNull();
    // The event's own transaction: shown on the trigger row, and not sponsored,
    // because whoever emitted the event paid for it.
    expect(byNode.get("trigger-1")?.network).toBe("8453");
    expect(byNode.get("trigger-1")?.gasCostWei).toBe("77000");
    expect(byNode.get("trigger-1")?.sponsored).toBe(false);
  });

  it("keeps the triggering transaction's gas out of the run's own total", async () => {
    const run = await runById(STEPS_ID);
    // Only the write's 41000. Counting the trigger's 77000 here would report a
    // third party's spend as the organization's own, and the Gas Spent KPI
    // derives the wallet share from this figure.
    expect(run.gasUsedWei).toBe("41000");
    expect(run.gasNetworks).toEqual(["8453"]);
  });

  it("backfills a gas-free legacy row, so the read moves onto the column", async () => {
    expect(await logNetworkColumn(BACKFILL_LOG_ID)).toBeNull();

    // One batch, scoped by cursor to this row alone: the gas-only predicate the
    // backfill used to carry never selects it, since it has no gasUsed.
    expect(await applyBatch(BACKFILL_CURSOR, 1)).toBe(1);
    expect(await logNetworkColumn(BACKFILL_LOG_ID)).toBe("base");

    const run = await runById(BACKFILL_ID);
    expect(run.network).toBe("base");
    expect(run.networks).toEqual(["base"]);

    // Idempotent: the row no longer matches, so a re-run writes nothing.
    expect(await applyBatch(BACKFILL_CURSOR, 1)).toBe(0);
  });
});
