import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    WORKFLOW_ENGINE: "workflow_engine",
    DATABASE: "database",
  },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  getMetricsCollector: () => ({
    incrementCounter: vi.fn(),
  }),
}));

// Hoisted schema stubs so the vi.mock factory can reference them.
const {
  workflowExecutionsMock,
  workflowExecutionLogsMock,
  workflowsMock,
  organizationMock,
} = vi.hoisted(() => ({
  workflowExecutionsMock: {
    id: "id",
    workflowId: "workflow_id",
    status: "status",
    output: "output",
    error: "error",
    errorCategory: "error_category",
    errorType: "error_type",
    completedAt: "completed_at",
    duration: "duration",
    currentNodeId: "current_node_id",
    currentNodeName: "current_node_name",
    // KEEP-470: column referenced by terminal UPDATE SET clauses
    transactionHashes: "transaction_hashes",
  },
  workflowExecutionLogsMock: {
    id: "id",
    executionId: "execution_id",
    nodeId: "node_id",
    nodeName: "node_name",
    status: "status",
    error: "error",
    completedAt: "completed_at",
    // KEEP-470: columns referenced by loadHashesFromLogs SELECT
    iterationIndex: "iteration_index",
    outputRaw: "output_raw",
    startedAt: "started_at",
  },
  // KEEP-545: org_slug resolution joins workflows -> organization for the
  // per-execution-error counter
  workflowsMock: {
    id: "id",
    organizationId: "organization_id",
  },
  organizationMock: {
    id: "id",
    slug: "slug",
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: workflowExecutionsMock,
  workflowExecutionLogs: workflowExecutionLogsMock,
  workflows: workflowsMock,
  organization: organizationMock,
}));

// The terminal UPDATE self-joins workflow_executions via alias() so RETURNING
// can expose the pre-update status. Real alias() needs drizzle table internals
// the schema stubs don't have, so substitute a plain aliased-column object.
vi.mock("drizzle-orm/pg-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm/pg-core")>();
  return {
    ...actual,
    alias: (_table: unknown, name: string) => ({
      id: `${name}.id`,
      status: `${name}.status`,
    }),
  };
});

// KEEP-545: stub classifier + counter so the test doesn't load the
// server-only metric collector module.
vi.mock("@/lib/errors/classify", () => ({
  classifyExecutionError: (msg: string | null | undefined) => ({
    errorCategory: msg ? "workflow_engine" : "workflow_engine",
    errorType: "system",
  }),
  // The stub classifier always returns a confident system classification, so the
  // run persists as system_error (not the unknown/default fallback).
  isDefaultClassification: () => false,
  // No errorClass hint is passed by these cases, so the hint is a no-op that
  // returns the stubbed classification unchanged.
  applyErrorClassHint: (classification: unknown) => classification,
}));
vi.mock("@/lib/metrics/collectors/prometheus", () => ({
  recordWorkflowExecutionError: vi.fn(),
  recordWorkflowExecutionFinished: vi.fn(),
  recordWorkflowExecutionHealed: vi.fn(),
}));
vi.mock("@/lib/metrics/db-metrics", () => ({
  ANONYMOUS_ORG_SLUG: "_anonymous",
}));

// KEEP-966: logWorkflowCompleteDb / selfHealWorkflowAfterLateStepCommit now
// independently reconcile every claimed hash against the chain before
// writing "success". Default to "everything verifies" so the pre-existing
// KEEP-470 tests below (which assert hash/nodeId/network shape, not the new
// verification fields) don't need per-test setup; tests exercising the
// KEEP-966 gate itself override this per-call.
const { verifyExecutionReceiptsMock } = vi.hoisted(() => ({
  verifyExecutionReceiptsMock: vi.fn(),
}));
vi.mock("@/lib/web3/verify-receipt", () => ({
  verifyExecutionReceipts: verifyExecutionReceiptsMock,
  // A run only demotes to error when the chain was conclusive. An unreadable
  // receipt leaves it unconfirmed instead, so the real predicate is used here
  // rather than a stub that would hide that split.
  hasUnreadableReceipt: (
    results: Array<{ verified: boolean; status: string }>
  ) =>
    results.some(
      (r) =>
        !(
          r.verified ||
          ["success", "reverted", "safe_inner_failure"].includes(r.status)
        )
    ),
  describeVerificationFailure: (
    results: Array<{ hash: string; status: string }>
  ) =>
    `On-chain verification failed for ${results.length} transaction(s): ${results
      .map((r) => `${r.hash} (${r.status})`)
      .join(", ")}`,
}));

// State the tests mutate between runs.
type UpdateCall = {
  target: unknown;
  set: Record<string, unknown>;
};
type LogRow = { id?: string; nodeId: string; status: string };
type ExecutionRow = {
  status: string;
  error?: string | null;
  completedAt?: Date | null;
  startedAt?: Date | null;
};
let allLogs: LogRow[] = [];
let updateCalls: UpdateCall[] = [];
let updateShouldThrow = false;
let mockExecution: ExecutionRow | null = null;
// pickOrphanCloseErrorMessage issues a separate findMany scoped to columns:{id:true}
// (status='error' siblings carrying a non-orphan error). Default empty so existing
// tests keep observing the legacy "Step did not record completion" message.
let siblingErrorRows: Array<{ id: string }> = [];
// resolveGasTotal issues `db.select(...).from(...).where(...)` and reads
// rows[0].gasUsedWei. Default to a no-gas run; tests that exercise the gas
// denormalisation set this to a summed value.
let mockGasRows: Array<{ gasUsedWei: string | null }> = [{ gasUsedWei: null }];
// Rows returned by the terminal UPDATE's .returning(). Tests exercising the
// counter-emission gate seed workflowId + previousStatus here; the default
// empty array means "no row flipped" so the counter path is skipped.
let mockReturningRows: Array<{
  workflowId?: string;
  previousStatus?: string;
}> = [];
// resolveOrgSlugForCounter issues
// `db.select(...).from(workflows).leftJoin(...).where(...).limit(1)`.
let mockOrgRows: Array<{ slug: string | null }> = [{ slug: "acme" }];

// KEEP-545: the workflow_executions UPDATE in logWorkflowCompleteDb now chains
// `.returning({workflowId})` on the where() result so the per-execution error
// counter knows which org to scope the increment to. The where() return value
// must be BOTH awaitable (for callers that don't care about returning rows)
// AND expose a `.returning()` method. We model it as a custom thenable
// (NOT a native Promise -- V8 disallows assigning extra properties on those)
// so awaiting it resolves and the new code-path can call .returning(), which
// resolves to []. The counter-increment path treats empty returning() as
// "no rows actually flipped" and skips, which is the right behavior for tests
// that don't seed mockExecution.
type WhereChain = {
  then: <T>(
    onFulfilled?: ((value: undefined) => T | PromiseLike<T>) | null,
    onRejected?: ((reason: unknown) => T | PromiseLike<T>) | null
  ) => Promise<T>;
  catch: <T>(
    onRejected: (reason: unknown) => T | PromiseLike<T>
  ) => Promise<T | undefined>;
  returning: (
    ..._args: unknown[]
  ) => Promise<Array<{ workflowId?: string; previousStatus?: string }>>;
};
type SetChain = {
  where: () => WhereChain;
  from: (aliasTable: unknown) => { where: () => WhereChain };
};
type UpdateChain = { set: (values: Record<string, unknown>) => SetChain };

function makeWhereChain(failure: Error | null): WhereChain {
  const promise: Promise<undefined> = failure
    ? Promise.reject(failure)
    : Promise.resolve(undefined);
  return {
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable mocking Drizzle's query builder
    then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
    catch: (onRejected) => promise.catch(onRejected),
    returning: () => Promise.resolve(mockReturningRows),
  };
}

function buildUpdate(target: unknown): UpdateChain {
  return {
    set: (values: Record<string, unknown>): SetChain => {
      updateCalls.push({ target, set: values });
      const failure = updateShouldThrow ? new Error("db down") : null;
      return {
        where: (): WhereChain => makeWhereChain(failure),
        // The workflow_executions terminal UPDATE chains
        // .from(prevExecution).where(...) for the pre-update status self-join.
        from: (): { where: () => WhereChain } => ({
          where: (): WhereChain => makeWhereChain(failure),
        }),
      };
    },
  };
}

type FindManyOpts = {
  columns?: Record<string, boolean>;
};

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        // Discriminate by `columns` shape so the new
        // pickOrphanCloseErrorMessage SELECT (which only requests `id`) can be
        // controlled independently of the listTrulyFailedNodes SELECT (which
        // requests `nodeId` + `status`) -- they share this single mock entry
        // but answer different questions.
        findMany: vi.fn((opts: FindManyOpts) => {
          const cols = opts?.columns ?? {};
          const isOrphanSiblingProbe =
            cols.id === true && cols.nodeId !== true && cols.status !== true;
          return Promise.resolve(
            isOrphanSiblingProbe ? siblingErrorRows : allLogs
          );
        }),
      },
      workflowExecutions: {
        findFirst: vi.fn(() => Promise.resolve(mockExecution)),
      },
    },
    update: vi.fn((target: unknown) => buildUpdate(target)),
    // resolveGasTotal: db.select({...}).from(logs).where(...) -> rows[]
    // resolveOrgSlugForCounter: db.select({...}).from(workflows)
    //   .leftJoin(organization).where(...).limit(1) -> rows[]
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(mockGasRows),
        leftJoin: () => ({
          where: () => ({
            limit: () => Promise.resolve(mockOrgRows),
          }),
        }),
      }),
    })),
  },
}));

import { db } from "@/lib/db";
import { logSystemError, logSystemWarn } from "@/lib/logging";
import {
  logStepCompleteDb,
  logWorkflowCompleteDb,
} from "@/lib/workflow/executor/logging";
import type { StepContext } from "@/lib/workflow/executor/step-handler";
import {
  clearExecution,
  recordTransactionHashIfPresent,
} from "@/lib/workflow/executor/step-success-tracker";

function getExecUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionsMock);
}

function getLogUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionLogsMock);
}

// Runs before every inner describe's own beforeEach (outer-to-inner hook
// order), so the default survives the inner vi.clearAllMocks() calls below
// (clearAllMocks resets call history, not a configured mockImplementation).
// Tests exercising the KEEP-966 gate itself override with
// mockResolvedValueOnce / mockImplementationOnce.
beforeEach(() => {
  verifyExecutionReceiptsMock.mockImplementation(
    (hashes: Array<{ hash: string; chainId: number }>) =>
      Promise.resolve({
        allVerified: true,
        results: hashes.map((h) => ({
          hash: h.hash,
          chainId: h.chainId,
          verified: true,
          status: "success" as const,
          blockNumber: 100,
          gasUsed: "21000",
          verifiedAt: "2026-01-01T00:00:00.000Z",
        })),
      })
  );
});

describe("logWorkflowCompleteDb", () => {
  beforeEach(() => {
    allLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    siblingErrorRows = [];
    mockGasRows = [{ gasUsedWei: null }];
    mockReturningRows = [];
    mockOrgRows = [{ slug: "acme" }];
    vi.clearAllMocks();
  });

  it("writes success status unchanged when workflow succeeded", async () => {
    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      output: { ok: true },
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        output: { ok: true },
      })
    );
  });

  // KEEP-683: the run-total gas is denormalised onto the same terminal UPDATE
  // so the /analytics reads can aggregate a column instead of the logs JSONB.
  it("denormalises run-total gas onto the terminal UPDATE on success", async () => {
    mockGasRows = [{ gasUsedWei: "12345" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      output: { ok: true },
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({ status: "success", gasUsedWei: "12345" })
    );
  });

  // KEEP-683: a gas-bearing step (e.g. an approve) can commit its gas before a
  // later step fails the run. Today's gas total counts it regardless of status,
  // so the column must be populated on error finalizes too.
  it("denormalises gas on error finalizes, not only success", async () => {
    mockGasRows = [{ gasUsedWei: "777" }];
    allLogs = [{ id: "log_1", nodeId: "node_a", status: "error" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "Step failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({ status: "system_error", gasUsedWei: "777" })
    );
  });

  it("writes null gas when the run produced no gas-bearing step", async () => {
    // mockGasRows defaults to [{ gasUsedWei: null }]
    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      output: { ok: true },
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set.gasUsedWei).toBeNull();
  });

  it("keeps error status when a node log recorded an error and never succeeded", async () => {
    allLogs = [{ id: "log_1", nodeId: "node_a", status: "error" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "Step failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "system_error",
        error: "Step failed",
      })
    );
  });

  it("overrides spurious SDK error to success when no logs are error or running", async () => {
    allLogs = [
      { id: "log_a", nodeId: "node_a", status: "success" },
      { id: "log_b", nodeId: "node_b", status: "success" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "exceeded max retries",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );

    // KEEP-532 regression guard: both the pre-reconciliation log and the
    // spurious-recovery log must route through logSystemWarn (no metric),
    // not logSystemError (which would re-trip errors.system.workflow_engine.total).
    expect(logSystemWarn).toHaveBeenCalledTimes(2);
    expect(logSystemWarn).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("checking node logs for reconciliation"),
      expect.anything(),
      expect.objectContaining({ execution_id: "exec_1" })
    );
    expect(logSystemWarn).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("overriding spurious SDK error to success"),
      expect.anything(),
      expect.objectContaining({ execution_id: "exec_1" })
    );
    expect(logSystemError).not.toHaveBeenCalled();
  });

  // KEEP-333: If a step started but never recorded completion, the workflow
  // really is incomplete. Don't lie to the user by overriding to success.
  it("keeps error status when a node has only a running log (no success row)", async () => {
    allLogs = [{ id: "log_running", nodeId: "node_a", status: "running" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "worker killed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "system_error",
        error: "worker killed",
      })
    );
  });

  // KEEP-431: cross-pod SDK checkpoint resume. The original step body
  // succeeded on pod A and recorded a success row. The framework re-fired
  // the step on pod B; that retry's logStepStartDb inserted a 'running'
  // row, but the SDK threw "exceeded max retries" before logStepCompleteDb
  // ran for the retry. The success row from pod A is the truth.
  it("overrides spurious error when node has both success and running rows (cross-pod retry)", async () => {
    allLogs = [
      // First read row succeeded normally on pod A
      { id: "log_read1", nodeId: "read1", status: "success" },
      // Combine succeeded on pod A then framework re-fired on pod B
      { id: "log_combine_success", nodeId: "combine", status: "success" },
      { id: "log_combine_orphan", nodeId: "combine", status: "running" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_x402_cross_pod",
      status: "error",
      error: 'Step "runCodeStep" exceeded max retries (1 retry)',
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );
  });

  it("overrides spurious error when node has both success and error rows from retry", async () => {
    allLogs = [
      { id: "log_combine_success", nodeId: "combine", status: "success" },
      // Retry attempt rejected by SDK and logStepComplete recorded error.
      { id: "log_combine_retry", nodeId: "combine", status: "error" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_retry_error",
      status: "error",
      error: "Step did not record completion",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "success",
        error: undefined,
      })
    );
  });

  it("keeps error status when one node truly failed even if others have retries", async () => {
    allLogs = [
      // node_a: cross-pod retry pattern, would otherwise succeed.
      { id: "log_a_success", nodeId: "node_a", status: "success" },
      { id: "log_a_orphan", nodeId: "node_a", status: "running" },
      // node_b: real failure, no success row anywhere.
      { id: "log_b_error", nodeId: "node_b", status: "error" },
    ];

    await logWorkflowCompleteDb({
      executionId: "exec_mixed",
      status: "error",
      error: "node_b failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "system_error",
        error: "node_b failed",
      })
    );
  });

  it("closes orphaned running logs on completion (error path)", async () => {
    allLogs = [{ id: "log_running", nodeId: "node_a", status: "running" }];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "error",
      error: "worker killed",
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate).toBeDefined();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("did not record completion"),
        completedAt: expect.any(Date),
      })
    );
  });

  it("attributes orphaned running rows to a peer's real error instead of the misleading generic message", async () => {
    // Scenario: the Condition step threw with a configuration error and the
    // executor finalized the workflow as error before the trigger step's
    // "use step" boundary committed -- the same shape that surfaced as the
    // confusing "Step did not record completion" on the Event/trigger row.
    //
    // listTrulyFailedNodes runs first and needs at least one truly-failed
    // node so the workflow stays in error status (no spurious-error override).
    // pickOrphanCloseErrorMessage runs next and must observe the sibling
    // error row through the columns:{id:true} probe.
    allLogs = [
      { id: "log_trigger_running", nodeId: "trigger", status: "running" },
      { id: "log_condition_error", nodeId: "condition", status: "error" },
    ];
    siblingErrorRows = [{ id: "log_condition_error" }];

    await logWorkflowCompleteDb({
      executionId: "exec_with_peer_error",
      status: "error",
      error:
        'Condition references field "args.value" but "args" does not exist',
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Cancelled: workflow stopped because another step errored",
        completedAt: expect.any(Date),
      })
    );
  });

  it("keeps the legacy 'Step did not record completion' message when no peer carries a real error (worker-killed shape)", async () => {
    // No sibling error row exists -- the orphan IS the only failure signal,
    // matching the worker-died-mid-step case. The original message is the
    // most informative thing we can say.
    allLogs = [{ id: "log_running", nodeId: "node_a", status: "running" }];
    siblingErrorRows = [];

    await logWorkflowCompleteDb({
      executionId: "exec_worker_killed",
      status: "error",
      error: "worker killed",
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "error",
        error: "Step did not record completion",
        completedAt: expect.any(Date),
      })
    );
  });

  it("closes orphaned running logs as success when workflow succeeded", async () => {
    // Spurious SDK error reconciled to success; any running rows should
    // match the reconciled status so the UI is consistent.
    allLogs = [];

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    const logUpdate = getLogUpdate();
    expect(logUpdate).toBeDefined();
    expect(logUpdate?.set).toEqual(
      expect.objectContaining({
        status: "success",
      })
    );
    // On success we don't attach a "did not record completion" error.
    expect(logUpdate?.set.error).toBeUndefined();
  });

  it("still updates execution status when log cleanup throws", async () => {
    // Simulate a transient DB failure during the log cleanup UPDATE;
    // the execution status update must still run.
    allLogs = [];
    let callIndex = 0;
    updateShouldThrow = false;

    // Patch buildUpdate behavior per-call: first UPDATE (logs) throws,
    // second UPDATE (executions) succeeds. The where() return value must
    // expose `.returning()` so the workflow_executions UPDATE chain works
    // (KEEP-545 added a per-execution-error counter that reads it).
    const { db } = await import("@/lib/db");
    (
      db.update as unknown as {
        mockImplementation: (fn: (t: unknown) => UpdateChain) => void;
      }
    ).mockImplementation((target: unknown) => ({
      set: (values: Record<string, unknown>): SetChain => {
        updateCalls.push({ target, set: values });
        const shouldThrow =
          callIndex === 0 && target === workflowExecutionLogsMock;
        callIndex += 1;
        const whereChain = (): WhereChain =>
          makeWhereChain(
            shouldThrow ? new Error("transient db failure") : null
          );
        return {
          where: whereChain,
          from: (): { where: () => WhereChain } => ({ where: whereChain }),
        };
      },
    }));

    // Restore the base mock after this test so subsequent tests in the
    // file (which rely on the base buildUpdate returning a chain with
    // `.returning()`) aren't polluted by this inline override --
    // vi.clearAllMocks() preserves implementations set via mockImplementation.
    onTestFinished(() => {
      (
        db.update as unknown as {
          mockImplementation: (fn: (t: unknown) => UpdateChain) => void;
        }
      ).mockImplementation((target: unknown) => buildUpdate(target));
    });

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    // Execution update still ran despite the log cleanup throwing.
    expect(getExecUpdate()).toBeDefined();
  });

  it("emits the finished counter when the row transitions from a non-terminal status", async () => {
    mockReturningRows = [{ workflowId: "wf_1", previousStatus: "running" }];
    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    expect(prometheusMod.recordWorkflowExecutionFinished).toHaveBeenCalledWith({
      status: "success",
      orgSlug: "acme",
      errorType: "na",
    });
  });

  it("skips counter emission when re-finalizing an already-terminal row", async () => {
    // Reaper race: the row was already flipped to system_error (and counted)
    // before the slow pod finished. The UPDATE still overwrites the row with
    // the fresher result, but no second finished/error sample may be emitted.
    mockReturningRows = [
      { workflowId: "wf_1", previousStatus: "system_error" },
    ];
    const prometheusMod = await import("@/lib/metrics/collectors/prometheus");

    await logWorkflowCompleteDb({
      executionId: "exec_1",
      status: "success",
      startTime: Date.now() - 1000,
    });

    // The row overwrite itself still happened.
    expect(getExecUpdate()).toBeDefined();
    expect(
      prometheusMod.recordWorkflowExecutionFinished
    ).not.toHaveBeenCalled();
    expect(prometheusMod.recordWorkflowExecutionError).not.toHaveBeenCalled();
  });
});

// KEEP-470: top-level transactionHashes persistence at workflow completion.
describe("logWorkflowCompleteDb transactionHashes (KEEP-470)", () => {
  function ctx(overrides: Partial<StepContext>): StepContext {
    return {
      executionId: overrides.executionId ?? "exec_keep_470",
      nodeId: "write-contract-1",
      nodeName: "Write Contract",
      nodeType: "web3/write-contract",
      ...overrides,
    };
  }

  beforeEach(() => {
    allLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    siblingErrorRows = [];
    mockGasRows = [{ gasUsedWei: null }];
    mockReturningRows = [];
    mockOrgRows = [{ slug: "acme" }];
    vi.clearAllMocks();
  });

  it("writes the in-memory tracker entries, enriched with the on-chain verification result, on success", async () => {
    const executionId = "exec_tracker_path";
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "approve-1", nodeName: "Approve" }),
      { transactionHash: "0xaaa", chainId: 1, network: "mainnet" }
    );
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "swap-1", nodeName: "Swap" }),
      { transactionHash: "0xbbb", chainId: 1, network: "mainnet" }
    );

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    // KEEP-966: verifyExecutionReceipts is called with exactly the tracked
    // hashes -- the on-chain gate ran, not a no-op.
    expect(verifyExecutionReceiptsMock).toHaveBeenCalledWith([
      { hash: "0xaaa", chainId: 1 },
      { hash: "0xbbb", chainId: 1 },
    ]);

    const update = getExecUpdate();
    expect(update?.set.status).toBe("success");
    expect(update?.set.transactionHashes).toEqual([
      {
        hash: "0xaaa",
        nodeId: "approve-1",
        nodeName: "Approve",
        chainId: 1,
        network: "mainnet",
        verified: true,
        receiptStatus: "success",
        blockNumber: 100,
        gasUsed: "21000",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hash: "0xbbb",
        nodeId: "swap-1",
        nodeName: "Swap",
        chainId: 1,
        network: "mainnet",
        verified: true,
        receiptStatus: "success",
        blockNumber: 100,
        gasUsed: "21000",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    clearExecution(executionId);
  });

  it("demotes success to error and persists enriched (non-empty) receipts when a hash fails on-chain reconciliation", async () => {
    const executionId = "exec_reconciliation_failure";
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "swap-1", nodeName: "Swap" }),
      { transactionHash: "0xreverted", chainId: 1, network: "mainnet" }
    );

    verifyExecutionReceiptsMock.mockResolvedValueOnce({
      allVerified: false,
      results: [
        {
          hash: "0xreverted",
          chainId: 1,
          verified: false,
          status: "reverted" as const,
          blockNumber: 100,
          gasUsed: "21000",
          verifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const update = getExecUpdate();
    // Demoted from the caller's "success" -- the chain, not the self-report,
    // is authoritative. This file's classifyExecutionError stub always
    // returns errorType "system" regardless of message, which
    // statusForErrorType maps to "system_error" -- the real classify.ts rule
    // added for this ticket (lib/errors/classify.ts) routes a "reverted"
    // message to TRANSACTION/user instead, but that real classifier isn't
    // loaded in this unit-style test.
    expect(update?.set.status).toBe("system_error");
    expect(update?.set.error).toContain("0xreverted");
    expect(update?.set.error).toContain("reverted");
    // The receipt is still persisted (not []) so an operator can see which
    // hash failed and why -- the "per-execution receipts" deliverable.
    expect(update?.set.transactionHashes).toEqual([
      expect.objectContaining({
        hash: "0xreverted",
        verified: false,
        receiptStatus: "reverted",
      }),
    ]);

    clearExecution(executionId);
  });

  it("holds a run unconfirmed, rather than demoting it to error, when a receipt cannot be read", async () => {
    const executionId = "exec_reconciliation_unreadable";
    recordTransactionHashIfPresent(
      ctx({ executionId, nodeId: "swap-1", nodeName: "Swap" }),
      { transactionHash: "0xunseen", chainId: 1, network: "mainnet" }
    );

    verifyExecutionReceiptsMock.mockResolvedValueOnce({
      allVerified: false,
      results: [
        {
          hash: "0xunseen",
          chainId: 1,
          verified: false,
          status: "not_found" as const,
          verifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const update = getExecUpdate();
    // Not an outcome. The transaction may still land, and calling the run
    // errored would invite a re-run of transactions that already broadcast.
    expect(update?.set.status).toBe("unconfirmed");
    // No error classification on a run that has not failed.
    expect(update?.set.errorCategory).toBeNull();
    expect(update?.set.errorType).toBeNull();
    expect(update?.set.transactionHashes).toEqual([
      expect.objectContaining({ hash: "0xunseen", receiptStatus: "not_found" }),
    ]);

    clearExecution(executionId);
  });

  it("does not call verifyExecutionReceipts when the run produced no hashes", async () => {
    const executionId = "exec_no_hashes";

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    expect(verifyExecutionReceiptsMock).not.toHaveBeenCalled();
    expect(getExecUpdate()?.set.status).toBe("success");

    clearExecution(executionId);
  });

  it("writes an empty array on error terminations", async () => {
    const executionId = "exec_error_no_hashes";
    // Even if the tracker has data (e.g. partial run before error), an
    // error termination must not pollute transactionHashes -- we have no
    // signal that an error run's hashes should surface at the top level.
    recordTransactionHashIfPresent(ctx({ executionId }), {
      transactionHash: "0xshouldnotappear",
      chainId: 1,
      network: "mainnet",
    });
    allLogs = [{ id: "log_a", nodeId: "node_a", status: "error" }];

    await logWorkflowCompleteDb({
      executionId,
      status: "error",
      error: "Step failed",
      startTime: Date.now() - 1000,
    });

    expect(getExecUpdate()?.set.transactionHashes).toEqual([]);

    clearExecution(executionId);
  });

  it("falls back to workflow_execution_logs.output_raw when tracker is empty (cross-pod resume)", async () => {
    const executionId = "exec_fallback_path";
    // Tracker is empty (simulating finalize on a different pod).
    allLogs = [
      {
        id: "log_a",
        nodeId: "approve-1",
        nodeName: "Approve",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xccc",
          chainId: 1,
          network: "mainnet",
        },
      },
      {
        id: "log_b",
        nodeId: "swap-1",
        nodeName: "Swap",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xddd",
          chainId: 1,
          network: "mainnet",
        },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.hash)).toEqual(["0xccc", "0xddd"]);
  });

  it("fallback dedupes by hash string (SDK retry that re-broadcasts)", async () => {
    const executionId = "exec_dedupe";
    allLogs = [
      {
        id: "log_first",
        nodeId: "transfer-1",
        nodeName: "Send",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xshared", chainId: 1 },
      },
      {
        id: "log_retry",
        nodeId: "transfer-1",
        nodeName: "Send",
        status: "success",
        iterationIndex: null,
        // Same hash echoed by a retry that re-fired - must dedupe.
        outputRaw: { transactionHash: "0xshared", chainId: 1 },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("0xshared");
  });

  it("fallback omits optional fields when outputRaw / iterationIndex lack them", async () => {
    const executionId = "exec_omit_optionals";
    allLogs = [
      {
        id: "log_no_chain",
        nodeId: "custom-step-1",
        nodeName: "Custom",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xnochain" },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Record<
      string,
      unknown
    >[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      hash: "0xnochain",
      nodeId: "custom-step-1",
      nodeName: "Custom",
    });
    expect("chainId" in entries[0]).toBe(false);
    expect("network" in entries[0]).toBe(false);
    expect("iterationIndex" in entries[0]).toBe(false);
  });

  it("fallback emits iterationIndex when log row was a For-Each iteration", async () => {
    const executionId = "exec_foreach_fallback";
    allLogs = [
      {
        id: "log_iter_0",
        nodeId: "transfer-funds-1",
        nodeName: "Send airdrop",
        status: "success",
        iterationIndex: 0,
        outputRaw: { transactionHash: "0xiter0", chainId: 1 },
      },
      {
        id: "log_iter_1",
        nodeId: "transfer-funds-1",
        nodeName: "Send airdrop",
        status: "success",
        iterationIndex: 1,
        outputRaw: { transactionHash: "0xiter1", chainId: 1 },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
      iterationIndex?: number;
      nodeId: string;
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.iterationIndex)).toEqual([0, 1]);
    // Same nodeId across iterations is preserved (dedupe is by hash, not nodeId).
    expect(new Set(entries.map((e) => e.nodeId))).toEqual(
      new Set(["transfer-funds-1"])
    );
  });

  it("fallback skips rows whose outputRaw lacks a 0x-prefixed transactionHash", async () => {
    const executionId = "exec_skip_non_tx";
    allLogs = [
      {
        id: "log_with_hash",
        nodeId: "tx-step",
        nodeName: "Tx",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "0xreal", chainId: 1 },
      },
      {
        id: "log_no_output",
        nodeId: "math-step",
        nodeName: "Math",
        status: "success",
        iterationIndex: null,
        outputRaw: { result: 42 },
      },
      {
        id: "log_null_output",
        nodeId: "noop-step",
        nodeName: "Noop",
        status: "success",
        iterationIndex: null,
        outputRaw: null,
      },
      {
        id: "log_non_string",
        nodeId: "bad-step",
        nodeName: "Bad",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: 12_345 },
      },
      {
        id: "log_no_prefix",
        nodeId: "weird-step",
        nodeName: "Weird",
        status: "success",
        iterationIndex: null,
        outputRaw: { transactionHash: "not-a-hash" },
      },
    ] as unknown as LogRow[];

    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    const entries = getExecUpdate()?.set.transactionHashes as Array<{
      hash: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].hash).toBe("0xreal");
  });

  // KEEP-470: regression guard for the SQL pushdown of the transactionHash
  // prune. The functional tests above filter in JS even when the SQL filter
  // is removed (the mock returns all rows ignoring WHERE), so a typo in the
  // column name, the wrong operator, or accidental removal of the filter
  // would silently pass those tests while regressing performance back to
  // streaming every successful log row through Node.
  it("pushes the transactionHash IS NOT NULL prune into the SQL WHERE clause", async () => {
    const executionId = "exec_sql_filter_shape";
    const findManyMock = vi.mocked(db.query.workflowExecutionLogs.findMany);

    // Trigger the cross-pod fallback path with an empty tracker.
    allLogs = [];
    await logWorkflowCompleteDb({
      executionId,
      status: "success",
      startTime: Date.now() - 1000,
    });

    // listTrulyFailedNodes also hits findMany; discriminate by the
    // outputRaw column selector unique to loadHashesFromLogs.
    const loadHashesCall = findManyMock.mock.calls.find(
      ([opts]) =>
        (opts as { columns?: { outputRaw?: boolean } } | undefined)?.columns
          ?.outputRaw === true
    );
    expect(loadHashesCall).toBeDefined();
    const whereJson = JSON.stringify(
      (loadHashesCall?.[0] as { where?: unknown } | undefined)?.where
    );
    // Right column (output_raw, not the double-encoded output) and right
    // operator (IS NOT NULL, not IS NULL). Catches typos and removals.
    expect(whereJson).toContain("output_raw");
    expect(whereJson).toContain("->>'transactionHash' IS NOT NULL");
  });
});

// KEEP-470: the self-heal path (logStepCompleteDb -> late commit flips a
// spurious-error workflow to success) must populate transaction_hashes on the
// same UPDATE. Without this, a cross-pod late commit would leave the row at
// status=success with transaction_hashes=[] even though the run produced hashes.
describe("selfHealWorkflowAfterLateStepCommit transactionHashes (KEEP-470)", () => {
  beforeEach(() => {
    allLogs = [];
    updateCalls = [];
    updateShouldThrow = false;
    mockExecution = null;
    vi.clearAllMocks();
  });

  it("writes transactionHashes when a late step commit flips spurious error to success", async () => {
    const executionId = "exec_self_heal_with_hashes";

    // Workflow was finalized to a spurious error before this step's commit landed.
    mockExecution = {
      status: "error",
      error: "exceeded max retries",
      completedAt: new Date(Date.now() - 5000),
      startedAt: new Date(Date.now() - 30_000),
    };

    // The durable log rows are the cross-pod source of truth for the hash list.
    // (Tracker is empty here because logStepCompleteDb is firing on a different
    // pod than the one that originally ran the step body.)
    allLogs = [
      {
        id: "log_approve",
        nodeId: "approve-1",
        nodeName: "Approve",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xapprove",
          chainId: 1,
          network: "mainnet",
        },
      },
      {
        id: "log_swap",
        nodeId: "swap-1",
        nodeName: "Swap",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xswap",
          chainId: 1,
          network: "mainnet",
        },
      },
    ] as unknown as LogRow[];

    await logStepCompleteDb({
      logId: "log_swap",
      startTime: Date.now() - 1000,
      status: "success",
      outputRaw: {
        transactionHash: "0xswap",
        chainId: 1,
        network: "mainnet",
      },
      executionId,
    });

    // The self-heal UPDATE is the one that flips status to success.
    const healUpdate = updateCalls.find(
      (c) => c.target === workflowExecutionsMock && c.set.status === "success"
    );
    expect(healUpdate).toBeDefined();
    expect(healUpdate?.set.transactionHashes).toEqual([
      {
        hash: "0xapprove",
        nodeId: "approve-1",
        nodeName: "Approve",
        chainId: 1,
        network: "mainnet",
        verified: true,
        receiptStatus: "success",
        blockNumber: 100,
        gasUsed: "21000",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hash: "0xswap",
        nodeId: "swap-1",
        nodeName: "Swap",
        chainId: 1,
        network: "mainnet",
        verified: true,
        receiptStatus: "success",
        blockNumber: 100,
        gasUsed: "21000",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(healUpdate?.set.error).toBeNull();
  });

  it("does not flip to success when a hash fails on-chain reconciliation, leaving the row in its already-finalized error state", async () => {
    const executionId = "exec_self_heal_reconciliation_failure";

    mockExecution = {
      status: "error",
      error: "exceeded max retries",
      completedAt: new Date(Date.now() - 5000),
      startedAt: new Date(Date.now() - 30_000),
    };
    allLogs = [
      {
        id: "log_swap",
        nodeId: "swap-1",
        nodeName: "Swap",
        status: "success",
        iterationIndex: null,
        outputRaw: {
          transactionHash: "0xswap",
          chainId: 1,
          network: "mainnet",
        },
      },
    ] as unknown as LogRow[];

    verifyExecutionReceiptsMock.mockResolvedValueOnce({
      allVerified: false,
      results: [
        {
          hash: "0xswap",
          chainId: 1,
          verified: false,
          status: "reverted" as const,
          verifiedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    await logStepCompleteDb({
      logId: "log_swap",
      startTime: Date.now() - 1000,
      status: "success",
      outputRaw: { transactionHash: "0xswap", chainId: 1, network: "mainnet" },
      executionId,
    });

    // No UPDATE flips this row to success -- it stays whatever it already
    // was finalized to.
    const healUpdate = updateCalls.find(
      (c) => c.target === workflowExecutionsMock && c.set.status === "success"
    );
    expect(healUpdate).toBeUndefined();
  });
});
