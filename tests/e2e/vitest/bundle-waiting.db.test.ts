/**
 * Runs whose Send as Bundle step waited for Not before: finalize ends them
 * Skipped with the waiting reason and not billed, and the runs list reads
 * each one's reason key and waiting outputs back. Needs Postgres (DATABASE_URL, migrated).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must read Postgres.
vi.unmock("@/lib/db");
// Every hash a run reports reads back as mined and successful (no RPC here).
vi.mock("@/lib/web3/verify-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/verify-receipt")>()),
  verifyExecutionReceipts: async (
    hashes: { hash: string; chainId: number }[]
  ) => ({
    allVerified: true,
    results: hashes.map((entry) => ({
      ...entry,
      verified: true,
      status: "success",
      blockNumber: 21_400_500,
      gasUsed: "50000",
      verifiedAt: new Date().toISOString(),
    })),
  }),
}));

// The executions list route reads Postgres; only its auth and access checks are stubbed.
vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: async () => ({
    userId: USER_ID,
    organizationId: ORG_ID,
    authMethod: "session",
  }),
  authFailureResponse: () => new Response(null, { status: 401 }),
}));
vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: async () => ({ hasFullAccess: true, isDeleted: false }),
}));

const SKIP =
  !process.env.DATABASE_URL || process.env.SKIP_INFRA_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const PREFIX = `bwt_${Date.now().toString(36)}_`;
const USER_ID = `${PREFIX}user`;
const ORG_ID = `${PREFIX}org`;
const WORKFLOW_ID = `${PREFIX}wf`;

type Db = typeof import("@/lib/db").db;
type Schema = typeof import("@/lib/db/schema");
type Logging = typeof import("@/lib/workflow/executor/logging");
type Keys = typeof import("@/lib/workflow/executor/run-outcome-keys");
type Signals = typeof import("@/lib/workflow/executor/step-signals");
type Waiting = typeof import("@/lib/workflow/executor/waiting-runs");
let db: Db;
let schema: Schema;
let logging: Logging;
let keys: Keys;
let signals: Signals;
let waiting: Waiting;
let seq = 0;

const WAITING_OUTPUT = {
  success: true,
  route: "waiting",
  included: false,
  notBefore: 1_796_126_400,
  firstAllowedBlock: 21_400_421,
  latestBlock: 21_400_159,
  sendAheadBlocks: 2,
};

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    await client`DELETE FROM workflow_execution_logs WHERE execution_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflow_executions WHERE workflow_id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM workflows WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM organization WHERE id LIKE ${`${PREFIX}%`}`;
    await client`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`;
  } finally {
    await client.end();
  }
}

async function newRun(
  values: Partial<
    typeof import("@/lib/db/schema").workflowExecutions.$inferInsert
  > = {}
): Promise<string> {
  seq += 1;
  const id = `${PREFIX}run${seq}`;
  await db.insert(schema.workflowExecutions).values({
    id,
    workflowId: WORKFLOW_ID,
    userId: USER_ID,
    status: "running",
    ...values,
  });
  return id;
}

async function logStep(
  executionId: string,
  nodeId: string,
  outputRaw: object,
  nodeType = "web3/write-contract",
  extra: { status?: "success" | "error"; iterationIndex?: number } = {}
): Promise<void> {
  await db.insert(schema.workflowExecutionLogs).values({
    executionId,
    nodeId,
    nodeName: nodeId,
    nodeType,
    status: extra.status ?? "success",
    output: outputRaw,
    outputRaw,
    ...(extra.iterationIndex !== undefined && {
      iterationIndex: extra.iterationIndex,
      forEachNodeId: "loop-1",
    }),
  });
}

async function rowOf(executionId: string) {
  const [row] = await db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.id, executionId));
  return row;
}

const HASH = `0x${"ab".repeat(32)}`;

async function finalize(executionId: string) {
  await logging.logWorkflowCompleteDb({
    executionId,
    status: "success",
    startTime: Date.now() - 1000,
  });
  const [row] = await db
    .select()
    .from(schema.workflowExecutions)
    .where(eq(schema.workflowExecutions.id, executionId));
  return row;
}

describe.skipIf(SKIP)("runs that waited for Not before", () => {
  beforeAll(async () => {
    await cleanup();
    vi.resetModules();
    ({ db } = await import("@/lib/db"));
    schema = await import("@/lib/db/schema");
    logging = await import("@/lib/workflow/executor/logging");
    keys = await import("@/lib/workflow/executor/run-outcome-keys");
    signals = await import("@/lib/workflow/executor/step-signals");
    waiting = await import("@/lib/workflow/executor/waiting-runs");
    await db.insert(schema.users).values({
      id: USER_ID,
      name: "waiting owner",
      email: `${PREFIX}@waiting.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(schema.organization).values({
      id: ORG_ID,
      name: "Waiting",
      slug: ORG_ID.replaceAll("_", "-"),
      createdAt: new Date(),
    });
    await db.insert(schema.workflows).values({
      id: WORKFLOW_ID,
      name: WORKFLOW_ID,
      userId: USER_ID,
      organizationId: ORG_ID,
      nodes: [],
      edges: [],
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
  });

  it("finalizes a waiting run as Skipped with its own reason, not billed", async () => {
    const run = await newRun();
    await logStep(
      run,
      "read-1",
      { success: true, result: "1796126400" },
      "web3/read-contract"
    );
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(run, "cond-1", { result: true }, "Condition");
    await logStep(run, "trigger", { triggerGasUsed: "21000" }, "trigger");
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe(keys.RUN_OUTCOME_REASON.waiting);
    expect(row.errorCode).toBe("bundle-waiting");
    expect(row.errorCategory).toBeNull();
    expect(row.errorType).toBeNull();
    expect(row.billable).toBe(false);
    expect(keys.skipReasonOf(row)).toBe("bundle-waiting");
  });

  it("a waiting step beside an HTTP step ends Skipped but billed, its reason naming the waiting step only", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(
      run,
      "http-1",
      { success: true, status: 200 },
      "HTTP Request"
    );
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
    expect(row.error).toBe(keys.RUN_OUTCOME_REASON.waitingWithOtherSteps);
    expect(row.error).not.toContain("no gas was paid");
    expect(row.errorCategory).toBeNull();
    // Not grouped with waiting runs.
    expect(keys.skipReasonOf(row)).toBeNull();
  });

  it("a waiting step beside a normal Write Contract that sent is billed", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(run, "write-2", {
      success: true,
      route: "public",
      transactionHash: HASH,
      chainId: 1,
      gasUsed: "50000",
    });
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
  });

  it("any other Write Contract route, or a hash or gas on an allowed step, makes it billed", async () => {
    // A relay send not yet confirmed carries no hash, but it did send.
    const relay = await newRun();
    await logStep(relay, "write-1", WAITING_OUTPUT);
    await logStep(relay, "write-2", { success: true, route: "private-relay" });
    expect((await finalize(relay)).billable).toBe(true);
    const paid = await newRun();
    await logStep(paid, "write-1", WAITING_OUTPUT);
    await logStep(
      paid,
      "read-1",
      { success: true, gasUsed: "21000" },
      "web3/read-contract"
    );
    expect((await finalize(paid)).billable).toBe(true);
  });

  it("a waiting step beside a failed HTTP step the run went on past is billed", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(
      run,
      "http-1",
      { success: false, error: "502" },
      "HTTP Request",
      { status: "error" }
    );
    const row = await finalize(run);
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
  });

  it("a waiting step beside only read steps is not billed", async () => {
    const run = await newRun();
    await logStep(
      run,
      "read-1",
      { success: true, result: "7" },
      "web3/read-contract"
    );
    await logStep(
      run,
      "bal-1",
      { success: true, balance: "1" },
      "web3/check-balance"
    );
    await logStep(run, "write-1", WAITING_OUTPUT);
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(false);
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it("a waiting step beside a protocol read is not billed", async () => {
    const run = await newRun();
    await logStep(
      run,
      "aave-1",
      { success: true, healthFactor: "2" },
      "aave-v3/get-user-account-data"
    );
    await logStep(run, "write-1", WAITING_OUTPUT);
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(false);
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it.each([
    ["web3/query-events", { success: true, events: [] }],
    ["web3/query-transactions", { success: true, transactions: [] }],
    ["web3/query-solana-program-events", { success: true, events: [] }],
    ["web3/decode-calldata", { success: true, functionName: "transfer" }],
    ["web3/batch-read-contract", { success: true, results: [] }],
  ])(
    "a waiting step beside %s (platform services or many reads) is billed",
    async (nodeType, output) => {
      const run = await newRun();
      await logStep(run, "query-1", output, nodeType);
      await logStep(run, "write-1", WAITING_OUTPUT);
      const row = await finalize(run);
      expect(row.status).toBe("skipped");
      expect(row.billable).toBe(true);
      expect(row.errorCode).toBe("bundle-waiting-other-steps");
    }
  );

  it("a waiting step after a For Each over a Read Contract is billed: the For Each counts, its body reads do not", async () => {
    const run = await newRun();
    await logStep(
      run,
      "loop-1",
      { success: true, arrayLength: 2, maxIterations: 2 },
      "For Each"
    );
    for (const iterationIndex of [0, 1]) {
      await logStep(
        run,
        "read-1",
        { success: true, result: "7" },
        "web3/read-contract",
        { iterationIndex }
      );
    }
    await logStep(run, "write-1", WAITING_OUTPUT);
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
  });

  it("a waiting step inside a For Each is billed: the For Each row counts", async () => {
    const run = await newRun();
    await logStep(
      run,
      "loop-1",
      { success: true, arrayLength: 2, maxIterations: 2 },
      "For Each"
    );
    for (const iterationIndex of [0, 1]) {
      await logStep(run, "write-1", WAITING_OUTPUT, "web3/write-contract", {
        iterationIndex,
      });
    }
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
  });

  it("a waiting step beside a single Read Contract is not billed", async () => {
    const run = await newRun();
    await logStep(
      run,
      "read-1",
      { success: true, result: "7" },
      "web3/read-contract"
    );
    await logStep(run, "write-1", WAITING_OUTPUT);
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(false);
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it("the SQL other-work rule agrees with isOtherWorkStep, row by row", async () => {
    const { otherWorkSql } = await import(
      "@/lib/workflow/executor/run-outcome"
    );
    const cases: [string, object][] = [
      ["trigger", { triggerGasUsed: "21000" }],
      ["trigger", { transactionHash: HASH }],
      ["web3/query-events", { events: [] }],
      ["web3/query-solana-program-events", { transactionHash: "" }],
      ["aave-v3/get-user-account-data", { healthFactor: "2" }],
      ["aave-v3/get-user-account-data", { gasUsed: "1" }],
      ["aave-v3/supply", { success: true }],
      ["For Each", { arrayLength: 2 }],
      ["Collect", { count: 2 }],
      ["web3/batch-read-contract", { results: [] }],
      ["web3/decode-calldata", { functionName: "transfer" }],
      ["web3/read-contract", { result: "7" }],
      ["Condition", { condition: true }],
      ["web3/write-contract", WAITING_OUTPUT],
      ["web3/write-contract", { ...WAITING_OUTPUT, transactionHash: HASH }],
      ["Write Contract", { route: "bundle" }],
      ["HTTP Request", {}],
      ["data/filter-array", { result: [] }],
    ];
    const run = await newRun();
    for (const [index, [nodeType, output]] of cases.entries()) {
      await logStep(run, `n${index}`, output, nodeType);
    }
    const rows = await db
      .select({
        nodeId: schema.workflowExecutionLogs.nodeId,
        nodeType: schema.workflowExecutionLogs.nodeType,
        outputRaw: schema.workflowExecutionLogs.outputRaw,
        sql: otherWorkSql(schema.workflowExecutionLogs).mapWith(Boolean),
      })
      .from(schema.workflowExecutionLogs)
      .where(eq(schema.workflowExecutionLogs.executionId, run));
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      expect({ node: row.nodeId, work: row.sql }).toEqual({
        node: row.nodeId,
        work: signals.isOtherWorkStep(row.nodeType, row.outputRaw),
      });
    }
  });

  it("the SQL bundleSent signal agrees with bundleSignalsOfStep, every bundle route included", async () => {
    const { runOutcomeSignalSql } = await import(
      "@/lib/workflow/executor/run-outcome"
    );
    const routes = [
      ...keys.BUNDLE_ROUTES,
      "public",
      "private-relay",
      "waiting",
      "skipped-in-flight",
      "Bundle",
    ];
    const run = await newRun();
    for (const [index, route] of routes.entries()) {
      await logStep(run, `r${index}`, { route });
    }
    // Another step type never carries the signal.
    await logStep(run, "http", { route: keys.BUNDLE_ROUTE }, "HTTP Request");
    const rows = await db
      .select({
        nodeType: schema.workflowExecutionLogs.nodeType,
        outputRaw: schema.workflowExecutionLogs.outputRaw,
        sql: runOutcomeSignalSql(
          schema.workflowExecutionLogs
        ).bundleSent.mapWith(Boolean),
      })
      .from(schema.workflowExecutionLogs)
      .where(eq(schema.workflowExecutionLogs.executionId, run));
    expect(rows).toHaveLength(routes.length + 1);
    for (const row of rows) {
      const ts = keys.bundleSignalsOfStep(row.nodeType, row.outputRaw);
      expect({ output: row.outputRaw, sent: row.sql }).toEqual({
        output: row.outputRaw,
        sent: ts.bundleSent,
      });
    }
    const sent = rows.filter((row) => row.sql).map((row) => row.outputRaw);
    expect(sent).toHaveLength(keys.BUNDLE_ROUTES.length);
    expect(sent).toEqual(
      expect.arrayContaining(keys.BUNDLE_ROUTES.map((route) => ({ route })))
    );
  });

  it("a waiting step beside a protocol write is billed, even one that sent nothing yet", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(run, "supply-1", { success: true }, "aave-v3/supply");
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting-other-steps");
  });

  it("For Each: a first item that waits and a later item whose bundle landed ends success, billed", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT, "web3/write-contract", {
      iterationIndex: 0,
    });
    await logStep(
      run,
      "write-1",
      {
        success: true,
        route: "bundle",
        included: true,
        transactionHash: HASH,
        chainId: 1,
        gasUsed: "50000",
      },
      "web3/write-contract",
      { iterationIndex: 1 }
    );
    const row = await finalize(run);
    expect(row.status).toBe("success");
    expect(row.error).toBeNull();
    expect(row.errorCode).toBeNull();
    expect(row.billable).toBe(true);
    expect(row.transactionHashes.map((entry) => entry.hash)).toEqual([HASH]);
  });

  it("the reconciler settles an unconfirmed waiting run as a finalize would: Skipped, not billed", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000);
    const pure = await newRun({ status: "unconfirmed", startedAt: started });
    await logStep(pure, "write-1", WAITING_OUTPUT);
    const mixed = await newRun({ status: "unconfirmed", startedAt: started });
    await logStep(mixed, "write-1", WAITING_OUTPUT);
    await logStep(mixed, "http-1", { status: 200 }, "HTTP Request");
    const { reconcileUnconfirmedExecutions } = await import(
      "@/lib/execute/reconcile-executions"
    );
    await reconcileUnconfirmedExecutions(new Date(), 500, 30_000);
    expect(await rowOf(pure)).toMatchObject({
      status: "skipped",
      error: keys.RUN_OUTCOME_REASON.waiting,
      errorCode: "bundle-waiting",
      errorCategory: null,
      billable: false,
    });
    expect(await rowOf(mixed)).toMatchObject({
      status: "skipped",
      error: keys.RUN_OUTCOME_REASON.waitingWithOtherSteps,
      errorCode: "bundle-waiting-other-steps",
      billable: true,
    });
  });

  it("a settle away from a pure waiting run sets billable back to true, and only from one", async () => {
    const { billableAfterSettle } = await import(
      "@/lib/workflow/executor/run-outcome"
    );
    const waitingRun = await newRun({
      status: "skipped",
      error: keys.RUN_OUTCOME_REASON.waiting,
      errorCode: "bundle-waiting",
      billable: false,
    });
    // A row stored before the code: the exact reason text counts.
    const legacyWaiting = await newRun({
      status: "skipped",
      error: keys.RUN_OUTCOME_REASON.waiting,
      billable: false,
    });
    // Marketplace (paid elsewhere) and a refused run keep false.
    const marketplace = await newRun({ status: "success", billable: false });
    const refused = await newRun({
      status: "skipped",
      error: "Execution skipped: refused",
      billable: false,
    });
    const settle = async (id: string, to: "success" | "skipped") => {
      const next = {
        status: to,
        errorCode: to === "skipped" ? "bundle-waiting" : null,
        error: to === "skipped" ? keys.RUN_OUTCOME_REASON.waiting : null,
      };
      await db
        .update(schema.workflowExecutions)
        .set({
          status: next.status,
          billable: billableAfterSettle(schema.workflowExecutions, next),
        })
        .where(eq(schema.workflowExecutions.id, id));
      return (await rowOf(id)).billable;
    };
    expect(await settle(waitingRun, "success")).toBe(true);
    expect(await settle(legacyWaiting, "success")).toBe(true);
    expect(await settle(marketplace, "success")).toBe(false);
    expect(await settle(refused, "success")).toBe(false);
    // To a pure waiting run: false whatever it was.
    expect(await settle(marketplace, "skipped")).toBe(false);
  });

  it("a skip in flight beside a waiting step keeps the in-flight reason and is billed", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(run, "write-2", {
      success: true,
      route: "skipped-in-flight",
      included: false,
    });
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe(keys.RUN_OUTCOME_REASON.skipped);
    expect(row.billable).toBe(true);
    expect(keys.skipReasonOf(row)).toBe("bundle-in-flight");
  });

  it("a bundle that missed beside a waiting step ends Not landed, billed", async () => {
    const run = await newRun();
    await logStep(run, "write-1", WAITING_OUTPUT);
    await logStep(run, "write-2", {
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-picked",
    });
    const row = await finalize(run);
    expect(row.status).toBe("not_landed");
    expect(row.billable).toBe(true);
  });

  it("reads each waiting run's outputs back for the runs list, one query for the page", async () => {
    const first = await newRun();
    await logStep(first, "write-1", WAITING_OUTPUT);
    await finalize(first);
    const second = await newRun();
    await logStep(second, "write-1", {
      ...WAITING_OUTPUT,
      latestBlock: 21_400_160,
    });
    await finalize(second);
    const sent = await newRun();
    await logStep(sent, "write-1", {
      success: true,
      route: "bundle",
      included: false,
      notIncludedReason: "not-checked",
    });
    await finalize(sent);

    const rows = await db
      .select()
      .from(schema.workflowExecutions)
      .where(eq(schema.workflowExecutions.workflowId, WORKFLOW_ID));
    const page = rows.map((row) => ({
      id: row.id,
      skipReason: keys.skipReasonOf(row),
    }));
    const info = await waiting.loadWaitingRunInfo(page);
    expect(info.get(first)).toEqual({
      notBefore: 1_796_126_400,
      firstAllowedBlock: 21_400_421,
      latestBlock: 21_400_159,
      sendAheadBlocks: 2,
    });
    expect(info.get(second)?.latestBlock).toBe(21_400_160);
    expect(info.has(sent)).toBe(false);
    // Only waiting runs are looked up.
    expect(
      await waiting.loadWaitingRunInfo([{ id: sent, skipReason: null }])
    ).toEqual(new Map());
  });

  it("both run lists load when a skipped run's output holds a refusals that is not a whole number", async () => {
    const odd = await Promise.all(
      ["many", 1.5, -2, "12", { n: 1 }, 12_345_678_901].map((refusals) =>
        newRun({ status: "skipped", output: { refusals } })
      )
    );
    const counted = await newRun({
      status: "skipped",
      output: { refusals: 7 },
    });
    // Not skipped: its output is never read for refusals.
    const done = await newRun({ status: "success", output: { refusals: "x" } });

    const { getUnifiedRuns } = await import("@/lib/analytics/queries");
    const { runs } = await getUnifiedRuns(ORG_ID, "7d", { limit: 100 });
    const analytics = new Map(runs.map((run) => [run.id, run.refusals]));
    for (const id of [...odd, done]) {
      expect(analytics.get(id)).toBeNull();
    }
    expect(analytics.get(counted)).toBe(7);

    const { GET } = await import(
      "@/app/api/workflows/[workflowId]/executions/route"
    );
    const response = await GET(
      new Request(
        `http://localhost/api/workflows/${WORKFLOW_ID}/executions?view=summary&limit=100`
      ),
      { params: Promise.resolve({ workflowId: WORKFLOW_ID }) }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      executions: { id: string; refusals: number | null }[];
    };
    const listed = new Map(
      body.executions.map((run) => [run.id, run.refusals])
    );
    for (const id of [...odd, done]) {
      expect(listed.get(id)).toBeNull();
    }
    expect(listed.get(counted)).toBe(7);
  });
});
