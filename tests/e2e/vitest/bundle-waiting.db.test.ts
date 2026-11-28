/**
 * Runs whose Send as Bundle step waited for Not before: finalize ends them
 * Skipped with the waiting reason, billed like any other run, and the runs list reads
 * each one's reason key and waiting outputs back. Needs Postgres (DATABASE_URL, migrated).
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// tests/setup.ts stubs @/lib/db; these tests must read Postgres.
vi.unmock("@/lib/db");
// Every hash a run reports reads back as mined and successful (no RPC here), unless a test says otherwise.
const receipts = vi.hoisted(() => ({
  status: {} as Record<string, "success" | "reverted" | "not_found">,
}));
vi.mock("@/lib/web3/verify-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/verify-receipt")>()),
  verifyExecutionReceipts: async (
    hashes: { hash: string; chainId: number }[]
  ) => {
    const results = hashes.map((entry) => {
      const status = receipts.status[entry.hash] ?? "success";
      return {
        ...entry,
        verified: status === "success",
        status,
        ...(status !== "not_found" && {
          blockNumber: 21_400_500,
          gasUsed: "50000",
        }),
        verifiedAt: new Date().toISOString(),
      };
    });
    return {
      allVerified: results.every((result) => result.verified),
      results,
    };
  },
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
type Waiting = typeof import("@/lib/workflow/executor/waiting-runs");
let db: Db;
let schema: Schema;
let logging: Logging;
let keys: Keys;
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

const PUBLIC_WALLET = `0x${"5e".repeat(20)}`;

async function cleanup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1 });
  try {
    await client`DELETE FROM pending_transactions WHERE wallet_address = ${PUBLIC_WALLET}`;
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

  it("finalizes a waiting run as Skipped with its own reason, billed like any other run", async () => {
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
    expect(row.billable).toBe(true);
    expect(keys.skipReasonOf(row)).toBe("bundle-waiting");
  });

  it("a waiting step beside an HTTP step ends Skipped, billed, with the one waiting code, grouped", async () => {
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
    expect(row.errorCode).toBe("bundle-waiting");
    expect(row.error).toBe(keys.RUN_OUTCOME_REASON.waiting);
    // The reason names the waiting step only.
    expect(row.error).toContain("so that step sent no transaction");
    expect(row.errorCategory).toBeNull();
    // Grouped with the other waiting runs.
    expect(keys.skipReasonOf(row)).toBe("bundle-waiting");
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
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it("a waiting step beside only read steps, a protocol read included, is billed too", async () => {
    const run = await newRun();
    await logStep(
      run,
      "read-1",
      { success: true, result: "7" },
      "web3/read-contract"
    );
    await logStep(
      run,
      "aave-1",
      { success: true, healthFactor: "2" },
      "aave-v3/get-user-account-data"
    );
    await logStep(run, "write-1", WAITING_OUTPUT);
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.billable).toBe(true);
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it("a waiting step inside a For Each is billed, with the one waiting code", async () => {
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
    expect(row.errorCode).toBe("bundle-waiting");
  });

  it("the SQL bundleSent signal agrees with signalsOfStep, every bundle route included", async () => {
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
    await logStep(
      run,
      "http",
      { route: keys.BUNDLE_ROUTES[0] },
      "HTTP Request"
    );
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
      const ts = keys.signalsOfStep(row.nodeType, row.outputRaw);
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

  it("the reconciler settles an unconfirmed waiting run as a finalize would: Skipped, billed, billable left as it was", async () => {
    const started = new Date(Date.now() - 60 * 60 * 1000);
    const pure = await newRun({ status: "unconfirmed", startedAt: started });
    await logStep(pure, "write-1", WAITING_OUTPUT);
    const mixed = await newRun({ status: "unconfirmed", startedAt: started });
    await logStep(mixed, "write-1", WAITING_OUTPUT);
    await logStep(mixed, "http-1", { status: 200 }, "HTTP Request");
    // A marketplace-exempt run keeps its false: no settle writes billable.
    const exempt = await newRun({
      status: "unconfirmed",
      startedAt: started,
      billable: false,
    });
    await logStep(exempt, "write-1", WAITING_OUTPUT);
    const { reconcileUnconfirmedExecutions } = await import(
      "@/lib/execute/reconcile-executions"
    );
    await reconcileUnconfirmedExecutions(new Date(), 500, 30_000);
    for (const run of [pure, mixed]) {
      expect(await rowOf(run)).toMatchObject({
        status: "skipped",
        error: keys.RUN_OUTCOME_REASON.waiting,
        errorCode: "bundle-waiting",
        errorCategory: null,
        billable: true,
      });
    }
    expect(await rowOf(exempt)).toMatchObject({
      status: "skipped",
      errorCode: "bundle-waiting",
      billable: false,
    });
  });

  it("a finalize leaves billable as it was: no flip either way", async () => {
    const exempt = await newRun({ billable: false });
    await logStep(exempt, "write-1", WAITING_OUTPUT);
    expect((await finalize(exempt)).billable).toBe(false);
    const landed = await newRun({ billable: false });
    await logStep(landed, "write-1", {
      success: true,
      route: "bundle",
      included: true,
      transactionHash: HASH,
      chainId: 1,
      gasUsed: "50000",
    });
    const row = await finalize(landed);
    expect(row.status).toBe("success");
    expect(row.billable).toBe(false);
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

  it("a skip behind an earlier run's public copy finalizes with its own reason, grouped and billed as a bundle skip", async () => {
    const run = await newRun();
    await logStep(run, "write-1", {
      success: true,
      route: "skipped-in-flight",
      included: false,
      inFlightHash: HASH,
    });
    await logStep(run, "http", { status: 200 }, "HTTP Request");
    const row = await finalize(run);
    expect(row.status).toBe("skipped");
    expect(row.error).toBe(keys.RUN_OUTCOME_REASON.skippedPublicCopy);
    expect(row.errorCode).toBeNull();
    expect(row.billable).toBe(true);
    expect(keys.skipReasonOf(row)).toBe("bundle-in-flight");
  });

  it("the SQL skippedPublicCopy signal agrees with signalsOfStep", async () => {
    const { runOutcomeSignalSql } = await import(
      "@/lib/workflow/executor/run-outcome"
    );
    const outputs = [
      { route: "skipped-in-flight", inFlightHash: HASH },
      { route: "skipped-in-flight", inFlightHash: 7 },
      { route: "skipped-in-flight", inFlightUntilBlock: 9 },
      { route: "bundle", inFlightHash: HASH },
    ];
    const run = await newRun();
    for (const [index, output] of outputs.entries()) {
      await logStep(run, `s${index}`, output);
    }
    await logStep(run, "http", outputs[0], "HTTP Request");
    const rows = await db
      .select({
        nodeType: schema.workflowExecutionLogs.nodeType,
        outputRaw: schema.workflowExecutionLogs.outputRaw,
        sql: runOutcomeSignalSql(
          schema.workflowExecutionLogs
        ).skippedPublicCopy.mapWith(Boolean),
      })
      .from(schema.workflowExecutionLogs)
      .where(eq(schema.workflowExecutionLogs.executionId, run));
    expect(rows).toHaveLength(outputs.length + 1);
    for (const row of rows) {
      const ts = keys.signalsOfStep(row.nodeType, row.outputRaw);
      expect({ output: row.outputRaw, behind: row.sql }).toEqual({
        output: row.outputRaw,
        behind: ts.skippedPublicCopy === true,
      });
    }
    expect(rows.filter((row) => row.sql)).toHaveLength(1);
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

  it("a mixed waiting run groups with a pure one into one row", async () => {
    const { groupWaitingRuns } = await import(
      "@/lib/workflow/waiting-run-groups"
    );
    const pure = await newRun();
    await logStep(pure, "write-1", WAITING_OUTPUT);
    await finalize(pure);
    const mixed = await newRun();
    await logStep(mixed, "write-1", WAITING_OUTPUT);
    await logStep(mixed, "http-1", { status: 200 }, "HTTP Request");
    await finalize(mixed);
    const rows = await Promise.all([mixed, pure].map(rowOf));
    const page = rows.map((row) => ({
      id: row.id,
      startedAt: row.startedAt,
      workflowId: row.workflowId,
      status: row.status,
      skipReason: keys.skipReasonOf(row),
    }));
    expect(page.map((run) => run.skipReason)).toEqual([
      "bundle-waiting",
      "bundle-waiting",
    ]);
    const info = await waiting.loadWaitingRunInfo(page);
    const entries = groupWaitingRuns(
      page.map((run) => ({ ...run, waiting: info.get(run.id) ?? null })),
      2
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "waiting" });
    expect(
      entries[0].kind === "waiting" && entries[0].runs.map((run) => run.id)
    ).toEqual([mixed, pure]);
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

  describe("a public copy not mined by the window's end", () => {
    const PUBLIC_HASH = `0x${"c1".repeat(32)}`;
    const PENDING_OUTPUT = {
      success: true,
      route: "bundle-and-public",
      included: false,
      pending: true,
      transactionHash: PUBLIC_HASH,
      chainId: 1,
    };
    const reconcile = async (): Promise<void> => {
      const { reconcileUnconfirmedExecutions } = await import(
        "@/lib/execute/reconcile-executions"
      );
      await reconcileUnconfirmedExecutions(new Date(), 500, 30_000);
    };
    // The finalizer reads the copy's receipt as missing: the run stays open.
    const pendingRun = async (): Promise<string> => {
      receipts.status[PUBLIC_HASH] = "not_found";
      const run = await newRun({
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
      });
      await logStep(run, "write-1", PENDING_OUTPUT);
      expect((await finalize(run)).status).toBe("unconfirmed");
      return run;
    };

    it("ends unconfirmed, then Success once the reconciler finds it mined", async () => {
      const run = await pendingRun();
      receipts.status[PUBLIC_HASH] = "success";
      await reconcile();
      expect(await rowOf(run)).toMatchObject({
        status: "success",
        error: null,
      });
    });

    it("ends unconfirmed, then Error when the copy was mined and reverted", async () => {
      const run = await pendingRun();
      receipts.status[PUBLIC_HASH] = "reverted";
      await reconcile();
      const row = await rowOf(run);
      expect(row.status).toBe("error");
      expect(row.error).toContain("reverted on-chain");
    });

    it("verifies the hash the run's bundle row was confirmed with when its own is not found", async () => {
      const run = await pendingRun();
      const minedHash = `0x${"c2".repeat(32)}`;
      const ext = await import("@/lib/db/schema-extensions");
      await db.insert(ext.pendingTransactions).values({
        walletAddress: PUBLIC_WALLET,
        chainId: 1,
        nonce: 3,
        txHash: minedHash,
        executionId: run,
        status: "confirmed",
        lastTargetBlock: 100,
        bundleRuns: [
          {
            executionId: run,
            hashes: [PUBLIC_HASH, minedHash],
            signedAt: Date.now(),
          },
        ],
      });
      receipts.status[minedHash] = "success";
      await reconcile();
      const row = await rowOf(run);
      expect(row.status).toBe("success");
      expect(row.transactionHashes?.map((entry) => entry.hash)).toEqual([
        minedHash,
      ]);
    });

    it("does not swap to a confirmed row of another run, or a hash the run never signed", async () => {
      const { minedBundleHashFor } = await import(
        "@/lib/web3/bundles/bundle-history"
      );
      const other = await newRun();
      const ext = await import("@/lib/db/schema-extensions");
      const elsewhere = `0x${"c3".repeat(32)}`;
      await db.insert(ext.pendingTransactions).values({
        walletAddress: PUBLIC_WALLET,
        chainId: 1,
        nonce: 4,
        txHash: elsewhere,
        executionId: other,
        status: "confirmed",
        lastTargetBlock: 100,
        bundleRuns: [
          { executionId: other, hashes: [PUBLIC_HASH], signedAt: Date.now() },
        ],
      });
      expect(await minedBundleHashFor("no-such-run", 1, PUBLIC_HASH)).toBe(
        undefined
      );
      // The row's hash is not among that run's signed hashes.
      expect(await minedBundleHashFor(other, 1, PUBLIC_HASH)).toBe(undefined);
    });
  });
});
