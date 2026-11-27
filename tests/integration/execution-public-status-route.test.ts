/**
 * Integration tests for public execution status access (FRICTION-09).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveExecutionViewAccess, mockFindMany } = vi.hoisted(() => ({
  mockResolveExecutionViewAccess: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/workflow/execution-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/workflow/execution-access")>();
  return {
    ...actual,
    resolveExecutionViewAccess: mockResolveExecutionViewAccess,
  };
});

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: {
        findMany: mockFindMany,
      },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

vi.mock("@/lib/metrics", () => ({
  createTimer: () => () => 1,
}));

vi.mock("@/lib/metrics/instrumentation/api", () => ({
  recordStatusPollMetrics: vi.fn(),
}));

const { mockGetDualAuthContext } = vi.hoisted(() => ({
  mockGetDualAuthContext: vi.fn(),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: (...args: unknown[]) => mockGetDualAuthContext(...args),
}));

import { GET } from "@/app/api/workflows/executions/[executionId]/status/route";
import {
  EXEC_STATUS_ANON_IP_LIMIT,
  EXEC_STATUS_WINDOW_MS,
} from "@/lib/workflow/execution-status-rate-limit";

const EXECUTION_ID = "exec_public_1";

function makeExecution(visibility: "public" | "private") {
  return {
    id: EXECUTION_ID,
    status: "error",
    totalSteps: "1",
    completedSteps: "0",
    currentNodeId: "n1",
    currentNodeName: "Step",
    lastSuccessfulNodeId: null,
    lastSuccessfulNodeName: null,
    executionTrace: ["trace-line"],
    error: "internal failure",
    transactionHashes: [
      {
        hash: "0xabc",
        nodeId: "n1",
        nodeName: "Transfer",
        chainId: 8453,
      },
    ],
    workflow: {
      id: "wf_1",
      visibility,
    },
  };
}

function createRequest(headers?: HeadersInit): Request {
  return new Request(
    `http://localhost:3000/api/workflows/executions/${EXECUTION_ID}/status`,
    { headers }
  );
}

describe("GET /api/workflows/executions/[executionId]/status public access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([{ nodeId: "n1", status: "error" }]);
    mockGetDualAuthContext.mockResolvedValue({
      error: "Unauthorized",
      status: 401,
    });
  });

  it("returns 200 for publicReadOnly execution without auth", async () => {
    const execution = makeExecution("public");
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe("error");
    expect(body.transactionHashes).toEqual([
      expect.objectContaining({ hash: "0xabc", nodeName: "" }),
    ]);
  });

  it("redacts node-identifying fields from publicReadOnly payloads", async () => {
    const execution = makeExecution("public");
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as {
      errorContext: {
        failedNodeId: string | null;
        executionTrace?: string[];
        error?: string;
      } | null;
      progress: { currentNodeName: string | null };
    };

    expect(response.status).toBe(200);
    expect(body.errorContext?.failedNodeId).toBeNull();
    expect(body.errorContext?.executionTrace).toBeUndefined();
    expect(body.errorContext?.error).toBeUndefined();
    expect(body.progress.currentNodeName).toBeNull();
  });

  it("returns 401 for invalidAuth", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "invalidAuth",
      error: "Invalid API key format. Expected key starting with kh_",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(401);
    expect(body.error).toContain("Invalid API key");
  });

  it("returns 403 for accessDenied without leaking execution payload", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "accessDenied",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(403);
    expect(body.error).toBe("Access denied");
  });

  it("returns 404 for notFound", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "notFound",
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });

    expect(response.status).toBe(404);
  });

  it("returns full payload including errorContext for org members", async () => {
    const execution = {
      ...makeExecution("private"),
      status: "error",
      error: "step failed",
      executionTrace: ["trace"],
    };
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "full",
      execution,
    });

    const response = await GET(createRequest(), {
      params: Promise.resolve({ executionId: EXECUTION_ID }),
    });
    const body = (await response.json()) as {
      errorContext: { error: string; executionTrace: string[] } | null;
    };

    expect(response.status).toBe(200);
    expect(body.errorContext?.error).toBe("step failed");
    expect(body.errorContext?.executionTrace).toEqual(["trace"]);
  });

  describe("bundle step outcomes", () => {
    const WRITE = "web3/write-contract";
    const missed = {
      status: "success",
      nodeType: WRITE,
      iterationIndex: null,
      route: "bundle",
      notIncludedReason: "not-picked",
    };

    async function statuses(
      execution: Record<string, unknown>,
      logs: Record<string, unknown>[],
      mode: "full" | "publicReadOnly" = "full"
    ) {
      mockResolveExecutionViewAccess.mockResolvedValue({
        mode,
        execution: { ...makeExecution("public"), ...execution },
      });
      mockFindMany.mockResolvedValue(logs);
      const response = await GET(
        createRequest({ "x-forwarded-for": "203.0.113.60" }),
        { params: Promise.resolve({ executionId: EXECUTION_ID }) }
      );
      return (
        (await response.json()) as {
          nodeStatuses: { nodeId: string; status: string; outcome?: string }[];
        }
      ).nodeStatuses;
    }

    it("marks Write Contract steps that missed or sent nothing, as the finalizer reads them", async () => {
      const nodeStatuses = await statuses(
        { status: "not_landed", transactionHashes: [] },
        [
          { ...missed, nodeId: "missed" },
          {
            ...missed,
            nodeId: "skip",
            route: "skipped-in-flight",
            notIncludedReason: null,
          },
          { ...missed, nodeId: "landed", notIncludedReason: null },
          { ...missed, nodeId: "failed", status: "error" },
        ]
      );
      expect(nodeStatuses).toEqual([
        { nodeId: "missed", status: "success", outcome: "not-included" },
        { nodeId: "skip", status: "success", outcome: "skipped-in-flight" },
        { nodeId: "landed", status: "success" },
        { nodeId: "failed", status: "error" },
      ]);
      // Only the outcome's output keys are read, never the step bodies.
      const query = mockFindMany.mock.calls[0][0] as {
        columns: Record<string, boolean>;
        extras: Record<string, unknown>;
      };
      expect(query.columns).toEqual({
        nodeId: true,
        nodeType: true,
        status: true,
        iterationIndex: true,
      });
      expect(Object.keys(query.extras)).toEqual(["route", "notIncludedReason"]);
    });

    it("gives no outcome to a step that is not Write Contract, such as a webhook trigger", async () => {
      const nodeStatuses = await statuses(
        { status: "success", transactionHashes: [] },
        [
          {
            ...missed,
            nodeId: "trigger",
            nodeType: "Webhook",
            route: "skipped-in-flight",
          },
          { ...missed, nodeId: "code", nodeType: "Code" },
        ],
        "publicReadOnly"
      );
      expect(nodeStatuses.every((entry) => entry.outcome === undefined)).toBe(
        true
      );
    });

    it("shows a missed step as landed late once its run re-settled", async () => {
      const nodeStatuses = await statuses(
        {
          status: "success",
          transactionHashes: [
            { hash: "0xlate", nodeId: "missed", nodeName: "W" },
          ],
        },
        [{ ...missed, nodeId: "missed", notIncludedReason: "not-checked" }]
      );
      expect(nodeStatuses).toEqual([
        { nodeId: "missed", status: "success", outcome: "landed-late" },
      ]);
    });

    it("shows a late landing that reverted as landed-late-reverted, also in the public view", async () => {
      for (const mode of ["full", "publicReadOnly"] as const) {
        const nodeStatuses = await statuses(
          {
            status: "error",
            transactionHashes: [
              {
                hash: "0xlate",
                nodeId: "missed",
                nodeName: "W",
                receiptStatus: "reverted",
              },
            ],
          },
          [{ ...missed, nodeId: "missed", notIncludedReason: "not-checked" }],
          mode
        );
        expect(nodeStatuses[0]?.outcome, mode).toBe("landed-late-reverted");
      }
    });
  });

  it("rate-limits garbage Authorization on the anonymous bucket", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution: makeExecution("public"),
    });

    const headers = {
      Authorization: "Bearer x",
      "x-forwarded-for": "203.0.113.50",
    };
    let last: Response | undefined;
    for (let i = 0; i < EXEC_STATUS_ANON_IP_LIMIT + 1; i += 1) {
      last = await GET(createRequest(headers), {
        params: Promise.resolve({ executionId: EXECUTION_ID }),
      });
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toBeTruthy();
    // Window constant kept in sync with the helper used by the route.
    expect(EXEC_STATUS_WINDOW_MS).toBe(60_000);
  });

  it("advertises the remaining budget and a poll hint on 200s", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution: { ...makeExecution("public"), status: "running" },
    });

    const response = await GET(
      createRequest({ "x-forwarded-for": "203.0.113.51" }),
      { params: Promise.resolve({ executionId: EXECUTION_ID }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe(
      String(EXEC_STATUS_ANON_IP_LIMIT)
    );
    expect(Number(response.headers.get("X-RateLimit-Remaining"))).toBe(
      EXEC_STATUS_ANON_IP_LIMIT - 1
    );
    expect(response.headers.get("X-Poll-Interval-Hint")).toBe("2");
    const data = await response.json();
    expect(data.pollIntervalHint).toBe(2);
    expect(data.pollIntervalHint).toBe(
      Number(response.headers.get("X-Poll-Interval-Hint"))
    );
  });

  it("returns pollIntervalHint: 0 in body and header for terminal status", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution: { ...makeExecution("public"), status: "success" },
    });

    const response = await GET(
      createRequest({ "x-forwarded-for": "203.0.113.59" }),
      { params: Promise.resolve({ executionId: EXECUTION_ID }) }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Poll-Interval-Hint")).toBe("0");
    const data = await response.json();
    expect(data.pollIntervalHint).toBe(0);
    expect(data.pollIntervalHint).toBe(
      Number(response.headers.get("X-Poll-Interval-Hint"))
    );
  });

  it("treats a not landed run as terminal", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "publicReadOnly",
      execution: { ...makeExecution("public"), status: "not_landed" },
    });

    const response = await GET(
      createRequest({ "x-forwarded-for": "203.0.113.60" }),
      { params: Promise.resolve({ executionId: EXECUTION_ID }) }
    );

    expect(response.headers.get("X-Poll-Interval-Hint")).toBe("0");
  });

  it("keys authenticated callers per principal, not per IP", async () => {
    mockResolveExecutionViewAccess.mockResolvedValue({
      mode: "full",
      execution: makeExecution("private"),
    });
    mockGetDualAuthContext.mockResolvedValue({
      userId: "user_rl_1",
      organizationId: "org_rl_1",
      authMethod: "session",
      apiKeyId: null,
      isAnonymous: false,
    });

    // Same source IP, well past the anonymous budget: teammates behind one NAT
    // (or one user with several canvas tabs) must not share a bucket.
    const headers = { "x-forwarded-for": "203.0.113.52" };
    let last: Response | undefined;
    for (let i = 0; i < EXEC_STATUS_ANON_IP_LIMIT + 1; i += 1) {
      last = await GET(createRequest(headers), {
        params: Promise.resolve({ executionId: EXECUTION_ID }),
      });
    }

    expect(last?.status).toBe(200);
  });
});
