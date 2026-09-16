import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetRedis, mockInsert, mockSelect, mockDelete } = vi.hoisted(() => ({
  mockGetRedis: vi.fn(),
  mockInsert: vi.fn(),
  mockSelect: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/redis", () => ({ getRedis: mockGetRedis }));
vi.mock("@/lib/db", () => ({
  db: {
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  },
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { WORKFLOW_ENGINE: "WORKFLOW_ENGINE" },
  logInfo: vi.fn(),
  logSystemWarn: vi.fn(),
  logWarn: vi.fn(),
}));

import { stepClaimKey } from "@/lib/redis-keys";
import {
  acquireStepClaim,
  type StepClaimScope,
  stepClaimScope,
} from "@/lib/workflow/executor/step-claim";

const SCOPE: StepClaimScope = { executionId: "exec-1", nodeId: "node-1" };

/** db.insert(...).values(...).onConflictDoUpdate(...).returning() */
function dbClaimReturns(rows: unknown[]): void {
  mockInsert.mockReturnValue({
    values: () => ({
      onConflictDoUpdate: () => ({ returning: () => Promise.resolve(rows) }),
    }),
  });
}

/** db.select(...).from(...).where(...).orderBy(...).limit(1) */
function dbWinnerRowReturns(rows: unknown[]): void {
  mockSelect.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  });
}

beforeEach(() => {
  mockGetRedis.mockReset();
  mockInsert.mockReset();
  mockSelect.mockReset();
  mockDelete.mockReset();
  dbWinnerRowReturns([]);
});

describe("stepClaimKey", () => {
  it("namespaces the key under the deployment prefix", () => {
    expect(stepClaimKey("exec-1", "node-1")).toBe(
      "local:step-claim:exec-1:node-1"
    );
  });

  it("separates two nodes of the same execution", () => {
    expect(stepClaimKey("e", "n1")).not.toBe(stepClaimKey("e", "n2"));
  });
});

describe("stepClaimScope", () => {
  it("scopes a workflow step to its execution and node", () => {
    expect(
      stepClaimScope({
        executionId: "exec-1",
        nodeId: "node-1",
        workflowId: "wf-1",
      })
    ).toEqual<StepClaimScope>({ executionId: "exec-1", nodeId: "node-1" });
  });

  it("refuses to claim a direct execution", () => {
    // /api/execute/node dispatches the same wrappers with an executionId from
    // direct_executions, which the claim's foreign key would reject. Only the
    // workflow executor sets workflowId.
    expect(
      stepClaimScope({ executionId: "direct-1", nodeId: "direct-1" })
    ).toBeUndefined();
  });

  it("refuses to claim a step inside a For Each body", () => {
    // The executor names only the innermost loop, so a nested body node has
    // the same coordinates under every outer iteration. Claiming on that key
    // would make the second outer iteration reuse the first one's output.
    expect(
      stepClaimScope({
        executionId: "exec-1",
        nodeId: "node-1",
        workflowId: "wf-1",
        forEachNodeId: "loop-1",
        iterationIndex: 0,
      })
    ).toBeUndefined();
  });

  it("refuses to claim when there is no execution to scope to", () => {
    expect(
      stepClaimScope({ nodeId: "node-1", workflowId: "wf-1" })
    ).toBeUndefined();
  });
});

/** No real waiting: the loser path runs two rounds of the poll. */
const NO_WAIT = {
  timeoutMs: 0,
  totalWaitMs: 0,
  sleep: () => Promise.resolve(),
};

describe("acquireStepClaim", () => {
  it("runs the step when it wins the claim in the database", async () => {
    mockGetRedis.mockReturnValue({
      exists: () => Promise.resolve(0),
      set: () => Promise.resolve("OK"),
    });
    dbClaimReturns([{ nodeId: "node-1" }]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: true,
    });
  });

  it("skips the database write when Redis already knows the claim is held", async () => {
    mockGetRedis.mockReturnValue({
      exists: () => Promise.resolve(1),
      set: () => Promise.resolve("OK"),
    });
    dbWinnerRowReturns([{ outputRaw: { latestBlock: 25_977_159 } }]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "reuse",
      output: { latestBlock: 25_977_159 },
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("claims in the database even when Redis is not configured", async () => {
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([{ nodeId: "node-1" }]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: true,
    });
    expect(mockInsert).toHaveBeenCalled();
  });

  it("falls through to the database when the Redis read throws", async () => {
    mockGetRedis.mockReturnValue({
      exists: () => Promise.reject(new Error("connection refused")),
      set: () => Promise.resolve("OK"),
    });
    dbClaimReturns([{ nodeId: "node-1" }]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: true,
    });
    expect(mockInsert).toHaveBeenCalled();
  });

  it("reuses the winner's output after losing the database claim", async () => {
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([]);
    dbWinnerRowReturns([{ outputRaw: { ok: true } }]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "reuse",
      output: { ok: true },
    });
  });

  it("runs without ownership once the wait is exhausted", async () => {
    // The owner never recorded a result. Proceeding duplicates the step, but
    // the caller must not then release a claim it never held.
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([]);
    dbWinnerRowReturns([]);

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: false,
    });
  });

  it("takes the claim over on a later round when it comes free", async () => {
    mockGetRedis.mockReturnValue(null);
    dbWinnerRowReturns([]);
    mockInsert
      .mockReturnValueOnce({
        values: () => ({
          onConflictDoUpdate: () => ({ returning: () => Promise.resolve([]) }),
        }),
      })
      .mockReturnValueOnce({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ nodeId: "node-1" }]),
          }),
        }),
      });

    await expect(
      acquireStepClaim(SCOPE, { ...NO_WAIT, totalWaitMs: 50 })
    ).resolves.toEqual({ outcome: "run", owns: true });
    expect(mockInsert).toHaveBeenCalledTimes(2);
  });

  it("runs the step rather than failing when the database is down", async () => {
    mockGetRedis.mockReturnValue(null);
    mockInsert.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: false,
    });
  });

  it("runs the step rather than failing when the winner's row cannot be read", async () => {
    mockGetRedis.mockReturnValue(null);
    dbClaimReturns([]);
    mockSelect.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(acquireStepClaim(SCOPE, NO_WAIT)).resolves.toEqual({
      outcome: "run",
      owns: false,
    });
  });
});
