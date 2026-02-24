/**
 * Seed script for analytics dashboard test data
 *
 * Seeds realistic workflow executions, execution logs, and direct executions
 * for the test user's organization so the analytics dashboard has data to display.
 *
 * Idempotent: checks for existing seed data (workflows prefixed with "[Analytics Seed]")
 * and skips insertion if found.
 *
 * Test credentials:
 *   Email:    test-analytics@techops.services
 *   Password: TestAnalytics123!
 *
 * Run with: pnpm tsx scripts/seed/seed-analytics-data.ts
 */

import dotenv from "dotenv";
import { expand } from "dotenv-expand";

expand(dotenv.config());

import postgres from "postgres";
import { getDatabaseUrl } from "../../lib/db/connection-utils";

const TEST_USER_EMAIL = "test-analytics@techops.services";
const SEED_PREFIX = "[Analytics Seed]";
const FORCE_MODE = process.argv.includes("--force");

const NETWORKS = ["ethereum", "base", "polygon", "sepolia"] as const;
const DIRECT_TYPES = [
  "transfer",
  "contract-call",
  "check-and-execute",
] as const;
const NODE_TYPES = [
  "trigger",
  "web3:read-contract",
  "web3:write-contract",
  "condition",
  "http-request",
] as const;

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 21; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomHex(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function randomDateBetween(start: Date, end: Date): Date {
  const startMs = start.getTime();
  const endMs = end.getTime();
  return new Date(startMs + Math.random() * (endMs - startMs));
}

type Db = ReturnType<typeof postgres>;

async function lookupTestUser(sql: Db): Promise<{ userId: string; orgId: string }> {
  const userResult = await sql`
    SELECT id FROM users WHERE email = ${TEST_USER_EMAIL}
  `;
  if (userResult.length === 0) {
    throw new Error(
      `Test user "${TEST_USER_EMAIL}" not found. ` +
        "Create it first (sign up via the UI or seed-test-wallet.ts pattern)."
    );
  }
  const userId = userResult[0].id as string;

  const orgResult = await sql`
    SELECT organization_id FROM member WHERE user_id = ${userId} LIMIT 1
  `;
  if (orgResult.length === 0) {
    throw new Error(
      `Test user "${TEST_USER_EMAIL}" has no organization membership.`
    );
  }
  const orgId = orgResult[0].organization_id as string;

  return { userId, orgId };
}

async function hasSeedData(sql: Db, orgId: string): Promise<boolean> {
  const result = await sql`
    SELECT id FROM workflows
    WHERE organization_id = ${orgId}
      AND name LIKE ${`${SEED_PREFIX}%`}
    LIMIT 1
  `;
  return result.length > 0;
}

async function deleteSeedData(sql: Db, orgId: string): Promise<void> {
  const workflows = await sql`
    SELECT id FROM workflows
    WHERE organization_id = ${orgId}
      AND name LIKE ${`${SEED_PREFIX}%`}
  `;
  const workflowIds = workflows.map((r) => r.id as string);

  if (workflowIds.length > 0) {
    for (const wfId of workflowIds) {
      await sql`
        DELETE FROM workflow_execution_logs
        WHERE execution_id IN (
          SELECT id FROM workflow_executions WHERE workflow_id = ${wfId}
        )
      `;
      await sql`DELETE FROM workflow_executions WHERE workflow_id = ${wfId}`;
      await sql`DELETE FROM workflows WHERE id = ${wfId}`;
    }
    console.log(`  Deleted ${workflowIds.length} seed workflows + executions`);
  }

  const directResult = await sql`
    DELETE FROM direct_executions
    WHERE organization_id = ${orgId}
      AND created_at > ${hoursAgo(7 * 24 + 1)}
    RETURNING id
  `;
  console.log(`  Deleted ${directResult.length} direct executions`);
}

async function createSeedWorkflows(
  sql: Db,
  userId: string,
  orgId: string
): Promise<string[]> {
  const workflowNames = [
    `${SEED_PREFIX} USDC Monitor`,
    `${SEED_PREFIX} ETH Price Alert`,
    `${SEED_PREFIX} LP Rebalancer`,
  ];

  const workflowIds: string[] = [];
  const now = new Date();

  for (const name of workflowNames) {
    const id = generateId();
    const nodes = JSON.stringify([
      { id: "trigger-1", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      {
        id: "action-1",
        type: "web3:read-contract",
        position: { x: 0, y: 100 },
        data: {},
      },
    ]);
    const edges = JSON.stringify([
      { id: "e1", source: "trigger-1", target: "action-1" },
    ]);

    await sql.unsafe(
      `INSERT INTO workflows (
        id, name, description, user_id, organization_id, is_anonymous,
        nodes, edges, visibility, enabled, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, false, $6::jsonb, $7::jsonb, 'private', true, $8, $9
      )`,
      [id, name, "Seeded for analytics testing", userId, orgId, nodes, edges, now, now]
    );

    workflowIds.push(id);
    console.log(`  Created workflow: ${name} (${id})`);
  }

  return workflowIds;
}

async function createWorkflowExecutions(
  sql: Db,
  userId: string,
  workflowIds: string[]
): Promise<void> {
  const sevenDaysAgo = hoursAgo(7 * 24);
  const now = new Date();
  let successCount = 0;
  let errorCount = 0;
  let otherCount = 0;

  for (let i = 0; i < 30; i++) {
    const execId = generateId();
    const workflowId = randomChoice(workflowIds);
    const startedAt = randomDateBetween(sevenDaysAgo, now);

    const roll = Math.random();
    let status: string;
    let completedAt: Date | null = null;
    let duration: string | null = null;

    if (roll < 0.7) {
      status = "success";
      const durationMs = randomInt(500, 5000);
      duration = String(durationMs);
      completedAt = new Date(startedAt.getTime() + durationMs);
      successCount++;
    } else if (roll < 0.9) {
      status = "error";
      const durationMs = randomInt(200, 3000);
      duration = String(durationMs);
      completedAt = new Date(startedAt.getTime() + durationMs);
      errorCount++;
    } else {
      status = Math.random() < 0.5 ? "running" : "pending";
      otherCount++;
    }

    const totalSteps = String(randomInt(3, 5));
    const completedSteps =
      status === "success"
        ? totalSteps
        : status === "error"
          ? String(randomInt(1, Number(totalSteps) - 1))
          : String(randomInt(0, 2));

    const errorMsg = status === "error" ? "Step execution failed: timeout exceeded" : null;

    await sql.unsafe(
      `INSERT INTO workflow_executions (
        id, workflow_id, user_id, status, error, started_at, completed_at,
        duration, total_steps, completed_steps
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        execId,
        workflowId,
        userId,
        status,
        errorMsg,
        startedAt,
        completedAt,
        duration,
        totalSteps,
        completedSteps,
      ]
    );

    const stepCount = randomInt(3, 5);
    await createStepLogs(sql, execId, startedAt, stepCount, status);
  }

  console.log(
    `  Created 30 workflow executions (${successCount} success, ${errorCount} error, ${otherCount} running/pending)`
  );
}

async function createStepLogs(
  sql: Db,
  executionId: string,
  executionStart: Date,
  stepCount: number,
  executionStatus: string
): Promise<void> {
  let currentTime = executionStart.getTime();

  for (let i = 0; i < stepCount; i++) {
    const logId = generateId();
    const nodeId = `node-${i + 1}`;
    const nodeName = `Step ${i + 1}`;
    const nodeType = i === 0 ? "trigger" : randomChoice(NODE_TYPES.slice(1));
    const stepDuration = randomInt(50, 1500);
    const startedAt = new Date(currentTime);

    let stepStatus: string;
    if (executionStatus === "error" && i === stepCount - 1) {
      stepStatus = "error";
    } else if (executionStatus === "pending" && i > 1) {
      stepStatus = "pending";
    } else if (executionStatus === "running" && i === stepCount - 1) {
      stepStatus = "running";
    } else {
      stepStatus = "success";
    }

    const completedAt =
      stepStatus === "pending" || stepStatus === "running"
        ? null
        : new Date(currentTime + stepDuration);
    const durationStr =
      stepStatus === "pending" || stepStatus === "running"
        ? null
        : String(stepDuration);
    const errorMsg =
      stepStatus === "error" ? "Contract call reverted" : null;

    await sql.unsafe(
      `INSERT INTO workflow_execution_logs (
        id, execution_id, node_id, node_name, node_type, status,
        started_at, completed_at, duration, error
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        logId,
        executionId,
        nodeId,
        nodeName,
        nodeType,
        stepStatus,
        startedAt,
        completedAt,
        durationStr,
        errorMsg,
      ]
    );

    currentTime += stepDuration + randomInt(10, 100);
  }
}

/**
 * Generate a realistic gas cost in wei for a given network.
 * gasUsedWei = gasUnits * gasPriceWei
 */
function realisticGasWei(network: string): string {
  const gasUnits = randomInt(21000, 350000);
  const gasPriceGwei: Record<string, [number, number]> = {
    ethereum: [15, 80],
    base: [0.01, 0.1],
    polygon: [30, 200],
    sepolia: [1, 10],
  };
  const [lo, hi] = gasPriceGwei[network] ?? [10, 50];
  const priceGwei = lo + Math.random() * (hi - lo);
  const priceWei = BigInt(Math.round(priceGwei * 1e9));
  return (BigInt(gasUnits) * priceWei).toString();
}

async function createDirectExecutions(
  sql: Db,
  orgId: string
): Promise<void> {
  const sevenDaysAgo = hoursAgo(7 * 24);
  const now = new Date();
  const fakeApiKeyId = generateId();
  let completedCount = 0;
  let failedCount = 0;
  let pendingCount = 0;

  const TOTAL = 40;
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  for (let i = 0; i < TOTAL; i++) {
    const execId = generateId();
    const network = randomChoice(NETWORKS);
    const type = randomChoice(DIRECT_TYPES);

    const createdAt =
      i < 8
        ? randomDateBetween(todayStart, now)
        : randomDateBetween(sevenDaysAgo, now);

    const txHash = `0x${randomHex(64)}`;

    const roll = Math.random();
    let status: string;
    let completedAt: Date | null = null;
    let gasUsedWei: string | null = null;
    let errorMsg: string | null = null;

    if (roll < 0.75) {
      status = "completed";
      const durationMs = randomInt(1000, 8000);
      completedAt = new Date(createdAt.getTime() + durationMs);
      gasUsedWei = realisticGasWei(network);
      completedCount++;
    } else if (roll < 0.95) {
      status = "failed";
      const durationMs = randomInt(500, 3000);
      completedAt = new Date(createdAt.getTime() + durationMs);
      errorMsg = "Transaction reverted: insufficient funds";
      failedCount++;
    } else {
      status = "pending";
      pendingCount++;
    }

    await sql.unsafe(
      `INSERT INTO direct_executions (
        id, organization_id, api_key_id, type, status,
        transaction_hash, network, error, gas_used_wei,
        created_at, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        execId,
        orgId,
        fakeApiKeyId,
        type,
        status,
        status === "pending" ? null : txHash,
        network,
        errorMsg,
        gasUsedWei,
        createdAt,
        completedAt,
      ]
    );
  }

  console.log(
    `  Created ${TOTAL} direct executions (${completedCount} completed, ${failedCount} failed, ${pendingCount} pending)`
  );
}

async function createSpendCap(
  sql: Db,
  orgId: string
): Promise<void> {
  const existing = await sql`
    SELECT id FROM organization_spend_caps
    WHERE organization_id = ${orgId}
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log("  Spend cap already exists, skipping.");
    return;
  }

  const capId = generateId();
  const dailyCapWei = (BigInt(5) * BigInt(1e16)).toString();
  const now = new Date();

  await sql.unsafe(
    `INSERT INTO organization_spend_caps (
      id, organization_id, daily_cap_wei, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5)`,
    [capId, orgId, dailyCapWei, now, now]
  );

  console.log(`  Created spend cap: 0.05 ETH/day (${dailyCapWei} wei)`);
}

async function seedAnalyticsData(): Promise<void> {
  const connectionString = getDatabaseUrl();
  console.log("Connecting to database...");

  const sql = postgres(connectionString, { max: 1 });

  try {
    const { userId, orgId } = await lookupTestUser(sql);
    console.log(`Found test user (id: ${userId}, org: ${orgId})`);

    if (await hasSeedData(sql, orgId)) {
      if (FORCE_MODE) {
        console.log("Force mode: deleting existing seed data...");
        await deleteSeedData(sql, orgId);
      } else {
        console.log("Seed data already exists, skipping. Use --force to re-seed.");
        return;
      }
    }

    console.log("Seeding analytics data...");

    const workflowIds = await createSeedWorkflows(sql, userId, orgId);
    await createWorkflowExecutions(sql, userId, workflowIds);
    await createDirectExecutions(sql, orgId);
    await createSpendCap(sql, orgId);

    console.log("\nAnalytics seed data ready.");
    console.log(`  User:  ${TEST_USER_EMAIL}`);
    console.log(`  Org:   ${orgId}`);
    console.log(`  Visit: http://localhost:3000/analytics`);
  } finally {
    await sql.end();
  }
}

seedAnalyticsData()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error seeding analytics data:", err);
    process.exit(1);
  });
