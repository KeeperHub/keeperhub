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
