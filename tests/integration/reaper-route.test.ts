import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockAuthResult = {
  authenticated: true,
  caller: "scheduler" as const,
  scheme: "hmac" as const,
  // Failure-path fields populated up front so tests that flip
  // `authenticated` to false still produce a well-formed 401 response.
  error: "Unauthorized",
  status: 401,
};
vi.mock("@/lib/internal-service-auth", () => ({
  authenticateInternalService: vi.fn(async () => mockAuthResult),
}));

type UpdateCall = {
  target: unknown;
  set: Record<string, unknown>;
};

let mockActiveExecutionIds: { executionId: string }[] = [];
let mockReapedRows: { id: string }[] = [];
let updateCalls: UpdateCall[] = [];

// The reaper chains db.update(target).set(values).where(cond) and for the
// workflowExecutions update adds .returning(). We record every (target,
// values) pair so tests can assert on either UPDATE independently.
type WhereChain = { returning: () => { id: string }[] };
type SetChain = { where: () => WhereChain };
type UpdateChain = { set: (values: Record<string, unknown>) => SetChain };

function buildUpdate(target: unknown): UpdateChain {
  return {
    set: (values: Record<string, unknown>): SetChain => {
      updateCalls.push({ target, set: values });
      return {
        where: (): WhereChain => ({
          returning: (): { id: string }[] => mockReapedRows,
        }),
      };
    },
  };
}

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          groupBy: vi.fn(() => mockActiveExecutionIds),
        })),
      })),
    })),
    update: vi.fn((target: unknown) => buildUpdate(target)),
  },
}));

// vi.mock factories are hoisted; use vi.hoisted for shared identity with
// assertions so `target === workflowExecutionsMock` works in tests.
const { workflowExecutionsMock, workflowExecutionLogsMock, walletLocksMock } =
  vi.hoisted(() => ({
    workflowExecutionsMock: {
      id: "id",
      workflowId: "workflow_id",
      startedAt: "started_at",
      status: "status",
      completedAt: "completed_at",
      error: "error",
      duration: "duration",
    },
    workflowExecutionLogsMock: {
      id: "id",
      executionId: "execution_id",
      status: "status",
      error: "error",
      completedAt: "completed_at",
    },
    walletLocksMock: {
      walletAddress: "wallet_address",
      chainId: "chain_id",
      lockedBy: "locked_by",
      lockedAt: "locked_at",
      expiresAt: "expires_at",
    },
  }));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: workflowExecutionsMock,
  workflowExecutionLogs: workflowExecutionLogsMock,
}));

vi.mock("@/lib/db/schema-extensions", () => ({
  walletLocks: walletLocksMock,
}));

import { GET } from "@/app/api/internal/reaper/route";
import { authenticateInternalService } from "@/lib/internal-service-auth";

function createRequest(): Request {
  return new Request("http://localhost:3000/api/internal/reaper", {
    headers: { "X-KH-Caller": "scheduler" },
  });
}

function getExecUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionsMock);
}

function getLogUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === workflowExecutionLogsMock);
}

function getWalletLocksUpdate(): UpdateCall | undefined {
  return updateCalls.find((c) => c.target === walletLocksMock);
}

describe("/api/internal/reaper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveExecutionIds = [];
    mockReapedRows = [];
    updateCalls = [];
    mockAuthResult.authenticated = true;
  });

  afterEach(() => {
    process.env.STALE_EXECUTION_THRESHOLD_MINUTES = undefined;
  });

  it("returns 401 when not authenticated", async () => {
    mockAuthResult.authenticated = false;

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBeDefined();
  });

  it("returns empty result when no stale executions exist", async () => {
    mockReapedRows = [];

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.reapedCount).toBe(0);
    expect(data.reapedIds).toEqual([]);
  });

  it("reaps stale executions and returns their IDs", async () => {
    mockReapedRows = [{ id: "exec_1" }];

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.reapedCount).toBe(1);
    expect(data.reapedIds).toEqual(["exec_1"]);
  });

  it("sets error status and timeout message on reaped executions", async () => {
    mockReapedRows = [{ id: "exec_1" }];

    await GET(createRequest());

    expect(getExecUpdate()?.set).toEqual(
      expect.objectContaining({
        status: "system_error",
        error: expect.stringContaining("timed out"),
        completedAt: expect.any(Date),
      })
    );
  });

  it("sets duration on reaped executions", async () => {
    mockReapedRows = [{ id: "exec_1" }];

    await GET(createRequest());

    expect(getExecUpdate()?.set.duration).toBeDefined();
  });

  it("excludes executions with recent step activity", async () => {
    mockActiveExecutionIds = [{ executionId: "exec_active" }];
    mockReapedRows = [];

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.reapedCount).toBe(0);
  });

  it("reaps multiple stale executions in a single query", async () => {
    mockReapedRows = [{ id: "exec_1" }, { id: "exec_2" }, { id: "exec_3" }];

    const response = await GET(createRequest());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.reapedCount).toBe(3);
    expect(data.reapedIds).toEqual(["exec_1", "exec_2", "exec_3"]);
    // Exactly one UPDATE against workflow_executions, one against logs.
    expect(
      updateCalls.filter((c) => c.target === workflowExecutionsMock)
    ).toHaveLength(1);
  });

  it("uses configurable threshold from env var", async () => {
    process.env.STALE_EXECUTION_THRESHOLD_MINUTES = "60";
    mockReapedRows = [{ id: "exec_1" }];

    await GET(createRequest());

    expect(getExecUpdate()?.set.error).toEqual(
      expect.stringContaining("60 minutes")
    );
  });

  // The reaper now covers both 'running' rows (stale activity) and 'pending'
  // rows (runtime never started, no step logs at all). The unified error
  // message describes both states accurately.
  it("uses 'no progress' wording in the timeout error message", async () => {
    mockReapedRows = [{ id: "exec_1" }];

    await GET(createRequest());

    expect(getExecUpdate()?.set.error).toEqual(
      expect.stringContaining("no progress")
    );
  });

  it("calls authenticateInternalService with the request", async () => {
    const request = createRequest();
    await GET(request);

    expect(authenticateInternalService).toHaveBeenCalledWith(request);
  });

  // KEEP-333: orphaned running step logs must be closed alongside the
  // workflow execution so the Runs tab doesn't render stuck spinners.
  it("closes orphaned 'running' step logs for reaped executions", async () => {
    mockReapedRows = [{ id: "exec_1" }, { id: "exec_2" }];

    await GET(createRequest());

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

  it("does not run the log cleanup update when nothing was reaped", async () => {
    mockReapedRows = [];

    await GET(createRequest());

    expect(getLogUpdate()).toBeUndefined();
  });

  // KEEP-344: any nonce lock held by a reaped execution is released eagerly
  // so the affected wallet+chain unblocks at reaper time instead of waiting
  // for the wallet_locks TTL to expire.
  it("releases nonce locks held by reaped executions", async () => {
    mockReapedRows = [{ id: "exec_1" }, { id: "exec_2" }];

    await GET(createRequest());

    const lockUpdate = getWalletLocksUpdate();
    expect(lockUpdate).toBeDefined();
    expect(lockUpdate?.set).toEqual(
      expect.objectContaining({
        lockedBy: null,
        lockedAt: null,
      })
    );
  });

  it("does not touch wallet_locks when nothing was reaped", async () => {
    mockReapedRows = [];

    await GET(createRequest());

    expect(getWalletLocksUpdate()).toBeUndefined();
  });
});
