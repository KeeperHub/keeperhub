/**
 * GET /api/workflows/executions/[executionId]/logs bounds every step payload
 * at the database, so an oversized step arrives as a truncated marker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveAuthorizedExecution, mockFindMany } = vi.hoisted(() => ({
  mockResolveAuthorizedExecution: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/workflow/execution-access", () => ({
  resolveAuthorizedExecution: (...args: unknown[]) =>
    mockResolveAuthorizedExecution(...args),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutionLogs: { findMany: mockFindMany },
    },
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/executions/[executionId]/logs/route";

const EXECUTION_ID = "exec_1";
const MARKER = {
  _truncated: true,
  originalSize: 156_321_346,
  preview: '{"results":[{"id":"',
};

function call(query = ""): Promise<Response> {
  return GET(
    new Request(
      `http://localhost:3000/api/workflows/executions/${EXECUTION_ID}/logs${query}`
    ),
    { params: Promise.resolve({ executionId: EXECUTION_ID }) }
  );
}

describe("GET /api/workflows/executions/[executionId]/logs bounded payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthorizedExecution.mockResolvedValue({
      ok: true,
      execution: { id: EXECUTION_ID, status: "system_error", error: null },
      auth: { userId: "user_1" },
    });
    mockFindMany.mockResolvedValue([
      {
        id: "log_1",
        executionId: EXECUTION_ID,
        nodeId: "n1",
        nodeName: "Get latest 3 execution details",
        nodeType: "HTTP Request",
        status: "success",
        input: { endpoint: "https://example.com" },
        output: MARKER,
        outputRaw: MARKER,
        error: null,
        timestamp: new Date("2026-09-23T00:03:07Z"),
      },
    ]);
  });

  it("excludes the raw payload columns and selects the bounded forms", async () => {
    await call();
    const [args] = mockFindMany.mock.calls[0] as [Record<string, unknown>];
    expect(args.columns).toEqual({
      input: false,
      output: false,
      outputRaw: false,
    });
    expect(Object.keys(args.extras as object).sort()).toEqual([
      "input",
      "output",
      "outputRaw",
    ]);
  });

  it("passes a truncated marker through redaction untouched", async () => {
    const response = await call();
    const body = (await response.json()) as {
      logs: Array<{ output: unknown; outputRaw: unknown; input: unknown }>;
    };
    expect(response.status).toBe(200);
    expect(body.logs[0]?.output).toEqual(MARKER);
    expect(body.logs[0]?.outputRaw).toEqual(MARKER);
    expect(body.logs[0]?.input).toEqual({ endpoint: "https://example.com" });
  });

  it("keeps the marker under an explicit truncateData cap", async () => {
    const response = await call("?truncateData=64");
    const body = (await response.json()) as {
      logs: Array<{ output: unknown }>;
    };
    expect(body.logs[0]?.output).toEqual(MARKER);
  });
});
