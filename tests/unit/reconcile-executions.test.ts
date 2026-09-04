/**
 * reconcileUnconfirmedExecutions runs from the execution-reconciler CronJob
 * and is the only path that settles `unconfirmed` rows. These tests drive it
 * against a recording stand-in for the drizzle builder and a mocked receipt
 * lookup, and render the captured fragments through PgDialect so the ordering
 * and the status guard are asserted on the SQL that would run.
 */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { directExecutions, workflowExecutions } from "@/lib/db/schema";
import type { ReceiptVerificationResult } from "@/lib/web3/verify-receipt";

vi.mock("server-only", () => ({}));

const {
  mockVerify,
  mockRecordFinished,
  mockLogInfo,
  mockLogWarn,
  mockLogSystemWarn,
} = vi.hoisted(() => ({
  mockVerify: vi.fn(),
  mockRecordFinished: vi.fn(),
  mockLogInfo: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogSystemWarn: vi.fn(),
}));

type Row = Record<string, unknown>;
type UpdateCall = { table: unknown; values: Row; where?: SQL };
type SelectCall = { orderBy?: SQL; limit?: number };

// Result sets handed out in call order: direct executions first, then
// workflow runs, matching the order the reconciler queries them.
let selectResults: Row[][] = [];
let selectCalls: SelectCall[] = [];
let updateCalls: UpdateCall[] = [];
// Rows the guarded workflow UPDATE reports back; empty means another writer
// settled the row first.
let returningRows: { id: string }[] = [];

vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const call: SelectCall = {};
      selectCalls.push(call);
      return {
        from: () => ({
          where: () => ({
            orderBy: (order: SQL) => {
              call.orderBy = order;
              return {
                limit: (n: number) => {
                  call.limit = n;
                  return Promise.resolve(selectResults.shift() ?? []);
                },
              };
            },
          }),
        }),
      };
    },
    update: (table: unknown) => ({
      set: (values: Row) => {
        const call: UpdateCall = { table, values };
        updateCalls.push(call);
        return {
          where: (condition: SQL) => {
            call.where = condition;
            return {
              returning: () => Promise.resolve(returningRows),
              // biome-ignore lint/suspicious/noThenProperty: drizzle's builder is itself a thenable and the direct-execution path awaits it without returning(), so the stub has to be one too.
              then: (resolve: (value: unknown) => unknown) =>
                resolve(undefined),
            };
          },
        };
      },
    }),
  },
}));

vi.mock("@/lib/web3/verify-receipt", () => ({
  verifyExecutionReceipts: mockVerify,
  // Same predicate as the real module: a receipt is unreadable when it neither
  // verified nor came back with a conclusive status.
  hasUnreadableReceipt: (results: ReceiptVerificationResult[]) =>
    results.some(
      (result) =>
        !(
          result.verified ||
          ["success", "reverted", "safe_inner_failure"].includes(result.status)
        )
    ),
  describeVerificationFailure: (results: ReceiptVerificationResult[]) =>
    `On-chain verification failed for ${results.filter((r) => !r.verified).length} transaction`,
}));

vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordWorkflowExecutionFinished: mockRecordFinished,
}));

vi.mock("@/lib/metrics/org-slug.server", () => ({
  resolveOrgSlugForCounter: vi.fn(async () => "org-a"),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logInfo: mockLogInfo,
  logWarn: mockLogWarn,
  logSystemWarn: mockLogSystemWarn,
}));

import { reconcileUnconfirmedExecutions } from "@/lib/execute/reconcile-executions";

const dialect = new PgDialect();
const render = (fragment: SQL | undefined) => {
  if (!fragment) {
    throw new Error("expected a SQL fragment");
  }
  return dialect.sqlToQuery(fragment);
};

const NOW = new Date("2026-09-02T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const CHAIN_ID = 11_155_111;
const HASH = "0xabc";

const minutesAgo = (minutes: number) =>
  new Date(NOW.getTime() - minutes * 60_000);

function directRow(overrides: Row = {}): Row {
  return {
    id: "de_1",
    transactionHash: HASH,
    network: String(CHAIN_ID),
    receipts: [],
    createdAt: minutesAgo(5),
    ...overrides,
  };
}

function workflowRow(overrides: Row = {}): Row {
  return {
    id: "we_1",
    workflowId: "wf_1",
    transactionHashes: [
      { hash: HASH, nodeId: "n1", nodeName: "Transfer", chainId: CHAIN_ID },
    ],
    startedAt: minutesAgo(5),
    ...overrides,
  };
}

function receipt(
  status: ReceiptVerificationResult["status"]
): ReceiptVerificationResult {
  return {
    hash: HASH,
    chainId: CHAIN_ID,
    verified: status === "success",
    status,
    verifiedAt: NOW.toISOString(),
  };
}

function verifyResolves(status: ReceiptVerificationResult["status"]): void {
  mockVerify.mockResolvedValue({
    allVerified: status === "success",
    results: [receipt(status)],
  });
}

// Each table is read twice per run (newest-first, then the oldest-first slice)
// and the stub hands out result sets in call order, so one run consumes four.
function run(
  direct: Row[],
  workflows: Row[],
  options: {
    maxRows?: number;
    budgetMs?: number;
    oldestDirect?: Row[];
    oldestWorkflows?: Row[];
  } = {}
) {
  selectResults = [
    direct,
    options.oldestDirect ?? [],
    workflows,
    options.oldestWorkflows ?? [],
  ];
  return reconcileUnconfirmedExecutions(
    NOW,
    options.maxRows ?? 2000,
    options.budgetMs ?? 60_000
  );
}

const directUpdates = () =>
  updateCalls.filter((call) => call.table === directExecutions);
const workflowUpdates = () =>
  updateCalls.filter((call) => call.table === workflowExecutions);

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  selectCalls = [];
  updateCalls = [];
  returningRows = [{ id: "we_1" }];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("direct executions", () => {
  it("settles as completed once the receipt verifies", async () => {
    verifyResolves("success");

    const report = await run([directRow()], []);

    expect(report.direct).toEqual({
      examined: 1,
      completed: 1,
      failed: 0,
      stillUnconfirmed: 0,
      deferred: 0,
    });
    expect(mockVerify).toHaveBeenCalledWith([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    const [update] = directUpdates();
    expect(update.values).toEqual({
      status: "completed",
      error: null,
      receipts: [
        expect.objectContaining({
          hash: HASH,
          chainId: CHAIN_ID,
          verified: true,
          receiptStatus: "success",
        }),
      ],
      completedAt: expect.any(Date),
    });
  });

  it("fails a row whose chain cannot be resolved and stamps completedAt", async () => {
    const report = await run([directRow({ network: "sepolia" })], []);

    expect(report.direct.failed).toBe(1);
    expect(mockVerify).not.toHaveBeenCalled();
    const [update] = directUpdates();
    expect(update.values).toEqual({
      status: "failed",
      error: "Unable to verify transaction: chain could not be resolved",
      receipts: [],
      completedAt: expect.any(Date),
    });
  });

  it("fails a conclusively reverted transaction", async () => {
    verifyResolves("reverted");

    const report = await run([directRow()], []);

    expect(report.direct.failed).toBe(1);
    expect(directUpdates()[0].values).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("On-chain verification failed"),
        completedAt: expect.any(Date),
      })
    );
  });

  it("keeps a young unreadable row open and only refreshes its receipts", async () => {
    verifyResolves("not_found");

    const report = await run([directRow()], []);

    expect(report.direct.stillUnconfirmed).toBe(1);
    const [update] = directUpdates();
    expect(Object.keys(update.values)).toEqual(["receipts"]);
    expect(update.values.receipts).toEqual([
      expect.objectContaining({ receiptStatus: "not_found", verified: false }),
    ]);
  });

  it("treats a transaction unseen for 24h as dropped", async () => {
    verifyResolves("not_found");

    const report = await run(
      [directRow({ createdAt: new Date(NOW.getTime() - 25 * HOUR_MS) })],
      []
    );

    expect(report.direct.failed).toBe(1);
    expect(directUpdates()[0].values).toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("dropped after 24h"),
        completedAt: expect.any(Date),
      })
    );
  });

  it("guards every write on the row still being unconfirmed", async () => {
    verifyResolves("success");

    await run([directRow()], []);

    const { sql, params } = render(directUpdates()[0].where);
    expect(sql).toMatch(/"id" = \$1 and .*"status" = \$2/);
    expect(params).toEqual(["de_1", "unconfirmed"]);
  });

  it("does not tally a settle another writer won the race for", async () => {
    verifyResolves("success");
    returningRows = [];

    const report = await run([directRow()], []);

    expect(directUpdates()).toHaveLength(1);
    expect(report.direct).toEqual({
      examined: 1,
      completed: 0,
      failed: 0,
      stillUnconfirmed: 1,
      deferred: 0,
    });
  });
});

describe("workflow runs", () => {
  it("fails a run with no verifiable hashes and stamps completedAt", async () => {
    const report = await run(
      [],
      [
        workflowRow({
          transactionHashes: [
            { hash: HASH, nodeId: "n1", nodeName: "Transfer" },
          ],
        }),
      ]
    );

    expect(report.workflows.failed).toBe(1);
    expect(mockVerify).not.toHaveBeenCalled();
    const [update] = workflowUpdates();
    expect(update.values).toEqual({
      status: "error",
      error: "On-chain verification failed: no verifiable transaction hashes",
      completedAt: expect.any(Date),
    });
    expect(mockRecordFinished).toHaveBeenCalledTimes(1);
    expect(mockRecordFinished).toHaveBeenCalledWith({
      status: "error",
      orgSlug: "org-a",
      errorType: "na",
    });
  });

  it("settles a verified run as success and emits one finished sample", async () => {
    verifyResolves("success");

    const report = await run([], [workflowRow()]);

    expect(report.workflows.completed).toBe(1);
    expect(workflowUpdates()[0].values).toEqual({
      status: "success",
      error: null,
      completedAt: expect.any(Date),
    });
    expect(mockRecordFinished).toHaveBeenCalledTimes(1);
    expect(mockRecordFinished).toHaveBeenCalledWith({
      status: "success",
      orgSlug: "org-a",
      errorType: "na",
    });
  });

  it("emits no finished sample when another writer settled the row first", async () => {
    verifyResolves("success");
    returningRows = [];

    await run([], [workflowRow()]);

    expect(workflowUpdates()).toHaveLength(1);
    expect(mockRecordFinished).not.toHaveBeenCalled();
  });

  it("guards the settle on the row still being unconfirmed", async () => {
    verifyResolves("success");

    await run([], [workflowRow()]);

    const { sql, params } = render(workflowUpdates()[0].where);
    expect(sql).toMatch(/"id" = \$1 and .*"status" = \$2/);
    expect(params).toEqual(["we_1", "unconfirmed"]);
  });

  it("keeps a young run with an unreadable receipt open without writing", async () => {
    verifyResolves("timeout");

    const report = await run([], [workflowRow()]);

    expect(report.workflows.stillUnconfirmed).toBe(1);
    expect(workflowUpdates()).toHaveLength(0);
    expect(mockRecordFinished).not.toHaveBeenCalled();
  });

  it("leaves a run open and warns when the lookup throws", async () => {
    mockVerify.mockRejectedValue(new Error("rpc unreachable"));

    const report = await run([], [workflowRow()]);

    expect(report.workflows.stillUnconfirmed).toBe(1);
    expect(workflowUpdates()).toHaveLength(0);
    expect(mockLogSystemWarn).toHaveBeenCalledWith(
      "network_rpc",
      expect.stringContaining("leaving it open"),
      expect.any(Error),
      { execution_id: "we_1" }
    );
  });
});

describe("scheduling safety", () => {
  it("reads each table newest first up to the row cap, plus an oldest-first slice", async () => {
    verifyResolves("success");

    await run([], [], { maxRows: 2000 });

    expect(selectCalls).toHaveLength(4);
    expect(selectCalls.map((call) => render(call.orderBy).sql)).toEqual([
      '"direct_executions"."created_at" desc',
      '"direct_executions"."created_at" asc',
      '"workflow_executions"."started_at" desc',
      '"workflow_executions"."started_at" asc',
    ]);
    expect(selectCalls.map((call) => call.limit)).toEqual([
      2000, 100, 2000, 100,
    ]);
  });

  it("never asks for a slice wider than the row cap", async () => {
    verifyResolves("success");

    await run([], [], { maxRows: 10 });

    expect(selectCalls.map((call) => call.limit)).toEqual([10, 10, 10, 10]);
  });

  it("examines the oldest slice before the newest-first sweep", async () => {
    verifyResolves("success");

    await run([directRow({ id: "de_new" })], [], {
      oldestDirect: [directRow({ id: "de_old" })],
    });

    const settled = directUpdates().map((call) => render(call.where).params[0]);
    expect(settled).toEqual(["de_old", "de_new"]);
  });

  it("examines a row returned by both reads only once", async () => {
    verifyResolves("success");
    const row = directRow({ id: "de_1" });

    const report = await run([row], [], { oldestDirect: [row] });

    expect(report.direct.examined).toBe(1);
    expect(directUpdates()).toHaveLength(1);
  });

  it("reaches the tail of a backlog larger than the row cap", async () => {
    verifyResolves("success");
    // The newest-first read is capped at 2 rows and can never see de_tail; the
    // oldest-first slice is the only thing that settles it.
    const newest = [directRow({ id: "de_a" }), directRow({ id: "de_b" })];

    await run(newest, [], {
      maxRows: 2,
      oldestDirect: [directRow({ id: "de_tail" })],
    });

    const settled = directUpdates().map((call) => render(call.where).params[0]);
    expect(settled).toEqual(["de_tail", "de_a", "de_b"]);
  });

  it("examines every row it read rather than the first 200", async () => {
    verifyResolves("success");
    const rows = Array.from({ length: 450 }, (_, i) =>
      directRow({ id: `de_${i}` })
    );

    const report = await run(rows, []);

    expect(report.direct.examined).toBe(450);
    expect(report.direct.deferred).toBe(0);
    expect(mockVerify).toHaveBeenCalledTimes(450);
  });

  it("stops at the time budget, splitting it so direct rows cannot starve workflows", async () => {
    // Each lookup costs 20s of wall clock. With a 60s budget direct rows get
    // the first 30s (two lookups) and workflows the remainder (one lookup).
    mockVerify.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return { allVerified: true, results: [receipt("success")] };
    });
    const direct = Array.from({ length: 10 }, (_, i) =>
      directRow({ id: `de_${i}` })
    );
    const workflows = Array.from({ length: 10 }, (_, i) =>
      workflowRow({ id: `we_${i}` })
    );

    const report = await run(direct, workflows, { budgetMs: 60_000 });

    expect(report.direct.examined).toBe(2);
    expect(report.direct.deferred).toBe(8);
    expect(report.workflows.examined).toBe(1);
    expect(report.workflows.deferred).toBe(9);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining("Time budget exhausted"),
      { direct_deferred: "8", workflow_deferred: "9", budget_ms: "60000" }
    );
  });

  it("rolls unused direct budget over to workflow rows", async () => {
    mockVerify.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return { allVerified: true, results: [receipt("success")] };
    });
    const workflows = Array.from({ length: 10 }, (_, i) =>
      workflowRow({ id: `we_${i}` })
    );

    const report = await run([], workflows, { budgetMs: 60_000 });

    expect(report.workflows.examined).toBe(3);
    expect(report.workflows.deferred).toBe(7);
  });

  it("does not warn when everything was examined", async () => {
    verifyResolves("success");

    await run([directRow()], [workflowRow()]);

    expect(mockLogWarn).not.toHaveBeenCalled();
    expect(mockLogInfo).toHaveBeenCalledWith(
      "[Reconciler] Settled unconfirmed executions",
      expect.objectContaining({ direct_examined: "1", workflow_examined: "1" })
    );
  });
});
