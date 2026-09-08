import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockFindFirst, mockFindMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
      workflowExecutionLogs: {
        findMany: (...args: unknown[]) => mockFindMany(...args),
      },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id" },
  workflowExecutionLogs: {
    executionId: "executionId",
    timestamp: "timestamp",
    deletedAt: "deletedAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  desc: () => ({}),
  and: () => ({}),
  isNull: () => ({}),
}));

vi.mock("@/lib/middleware/auth-helpers", () => ({
  getDualAuthContext: vi.fn().mockResolvedValue({
    userId: "user-fixture",
    organizationId: null,
    authMethod: "session",
  }),
}));

vi.mock("@/lib/workflow/access", () => ({
  getWorkflowAccess: vi.fn().mockResolvedValue({ hasFullAccess: true }),
}));

vi.mock("@/lib/utils/redact", () => ({
  redactSensitiveData: (data: unknown) => data,
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "database" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/executions/[executionId]/logs/route";

const FIXTURE_TIMESTAMP = new Date("2026-05-16T12:00:00.000Z");
const LARGE_OUTPUT = {
  payload: "X".repeat(400),
  nested: { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
};
const LONG_ERROR = `revert: ${"E".repeat(250)}`;

function makeLogRow(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "log-1",
    executionId: "exec-fixture",
    nodeId: "nodeA",
    nodeName: "Node A",
    nodeType: "web3/read-contract",
    status: "success" as const,
    input: { foo: "bar" },
    output: { ok: true },
    outputRaw: { ok: true },
    error: null,
    startedAt: FIXTURE_TIMESTAMP,
    completedAt: FIXTURE_TIMESTAMP,
    duration: "10",
    timestamp: FIXTURE_TIMESTAMP,
    iterationIndex: null,
    forEachNodeId: null,
    ...overrides,
  };
}

const FIXTURE_LOGS = [
  makeLogRow({ id: "log-1", nodeId: "nodeA", nodeName: "Node A" }),
  makeLogRow({
    id: "log-2",
    nodeId: "nodeB",
    nodeName: "Node B",
    output: LARGE_OUTPUT,
    outputRaw: LARGE_OUTPUT,
  }),
  makeLogRow({
    id: "log-3",
    nodeId: "nodeC",
    nodeName: "Node C",
    status: "error" as const,
    error: LONG_ERROR,
    output: null,
    outputRaw: null,
  }),
];

const FIXTURE_EXECUTION = {
  id: "exec-fixture",
  workflow: { id: "wf-fixture", userId: "user-fixture", organizationId: null },
};

function makeRequest(query = ""): Request {
  const url = query
    ? `https://test.local/api/workflows/executions/exec-fixture/logs?${query}`
    : "https://test.local/api/workflows/executions/exec-fixture/logs";
  return new Request(url, { method: "GET" });
}

async function callRoute(query = "") {
  const response = await GET(makeRequest(query), {
    params: Promise.resolve({ executionId: "exec-fixture" }),
  });
  const body = (await response.json()) as {
    execution: Record<string, unknown>;
    logs: Record<string, unknown>[];
  };
  return { status: response.status, body };
}

describe("get_execution_logs backward compat (TEST-03)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindFirst.mockResolvedValue(FIXTURE_EXECUTION);
    mockFindMany.mockResolvedValue(FIXTURE_LOGS);
  });

  describe("no-params byte-identical baseline", () => {
    it("returns the full envelope with every field on every log entry — byte-identical to pre-Phase-46", async () => {
      const { status, body } = await callRoute();

      expect(status).toBe(200);
      expect(body.execution).toEqual({
        id: "exec-fixture",
        workflow: {
          id: "wf-fixture",
          userId: "user-fixture",
          organizationId: null,
        },
      });
      expect(body.logs).toHaveLength(3);

      for (const log of body.logs) {
        expect(log).toHaveProperty("id");
        expect(log).toHaveProperty("nodeId");
        expect(log).toHaveProperty("nodeName");
        expect(log).toHaveProperty("nodeType");
        expect(log).toHaveProperty("status");
        expect(log).toHaveProperty("input");
        expect(log).toHaveProperty("output");
        expect(log).toHaveProperty("outputRaw");
        expect(log).toHaveProperty("error");
        expect(log).not.toHaveProperty("_truncated");
      }

      expect(body.logs[1].output).toEqual(LARGE_OUTPUT);
      expect(body.logs[1].outputRaw).toEqual(LARGE_OUTPUT);
      expect(body.logs[2].error).toBe(LONG_ERROR);
    });
  });

  describe("includeData=false", () => {
    it("strips input/output/outputRaw from every entry but preserves status, error, and identity fields", async () => {
      const { status, body } = await callRoute("includeData=false");

      expect(status).toBe(200);
      expect(body.logs).toHaveLength(3);

      for (const log of body.logs) {
        expect(log).not.toHaveProperty("input");
        expect(log).not.toHaveProperty("output");
        expect(log).not.toHaveProperty("outputRaw");
        expect(log).toHaveProperty("status");
        expect(log).toHaveProperty("error");
        expect(log).toHaveProperty("nodeId");
        expect(log).toHaveProperty("nodeName");
        expect(log).toHaveProperty("nodeType");
        expect(log).toHaveProperty("startedAt");
        expect(log).toHaveProperty("completedAt");
        expect(log).toHaveProperty("duration");
        expect(log).toHaveProperty("timestamp");
        expect(log).toHaveProperty("iterationIndex");
        expect(log).toHaveProperty("forEachNodeId");
      }

      expect(body.logs[2].error).toBe(LONG_ERROR);
    });
  });

  describe("nodeIds filter", () => {
    it("returns full input/output/outputRaw only for matching nodeIds; non-matching entries remain present with blobs stripped", async () => {
      const { status, body } = await callRoute("nodeIds=nodeA");

      expect(status).toBe(200);
      expect(body.logs).toHaveLength(3);

      const nodeAEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeA"
      );
      const nodeBEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeB"
      );
      const nodeCEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeC"
      );

      expect(nodeAEntry).toHaveProperty("input");
      expect(nodeAEntry).toHaveProperty("output");
      expect(nodeAEntry).toHaveProperty("outputRaw");
      expect(nodeAEntry?.output).toEqual({ ok: true });

      expect(nodeBEntry).not.toHaveProperty("input");
      expect(nodeBEntry).not.toHaveProperty("output");
      expect(nodeBEntry).not.toHaveProperty("outputRaw");
      expect(nodeBEntry).toHaveProperty("status");

      expect(nodeCEntry).not.toHaveProperty("input");
      expect(nodeCEntry).not.toHaveProperty("output");
      expect(nodeCEntry).not.toHaveProperty("outputRaw");
      expect(nodeCEntry).toHaveProperty("error");
      expect(nodeCEntry?.error).toBe(LONG_ERROR);
    });

    it("treats nodeIds with no value (empty string) as omitted — returns full data for all nodes", async () => {
      const { status, body } = await callRoute("nodeIds=");

      expect(status).toBe(200);
      expect(body.logs).toHaveLength(3);
      for (const log of body.logs) {
        expect(log).toHaveProperty("input");
        expect(log).toHaveProperty("output");
        expect(log).toHaveProperty("outputRaw");
      }
    });
  });

  describe("truncateData per-field truncation", () => {
    it("replaces oversized input/output/outputRaw with _truncated marker; small payloads pass through; error is NEVER truncated", async () => {
      const { status, body } = await callRoute("truncateData=50");

      expect(status).toBe(200);
      expect(body.logs).toHaveLength(3);

      const nodeAEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeA"
      );
      const nodeBEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeB"
      );
      const nodeCEntry = body.logs.find(
        (log: Record<string, unknown>) => log.nodeId === "nodeC"
      );

      expect(nodeAEntry?.input).toEqual({ foo: "bar" });
      expect(nodeAEntry?.output).toEqual({ ok: true });

      expect(nodeBEntry?.output).toMatchObject({
        _truncated: true,
        originalSize: expect.any(Number),
        preview: expect.any(String),
      });
      expect(
        (nodeBEntry?.output as Record<string, unknown>)?.preview as string
      ).toHaveLength(50);
      expect(
        (nodeBEntry?.output as Record<string, unknown>)?.originalSize as number
      ).toBeGreaterThan(50);
      expect(nodeBEntry?.outputRaw).toMatchObject({
        _truncated: true,
        originalSize: expect.any(Number),
        preview: expect.any(String),
      });

      expect(nodeCEntry?.error).toBe(LONG_ERROR);
      expect(
        ((nodeCEntry as { error: unknown }).error as string).length
      ).toBeGreaterThan(50);
    });
  });

  describe("includeData=false combined with truncateData", () => {
    it("strips blobs entirely; _truncated marker is never present", async () => {
      const { status, body } = await callRoute(
        "includeData=false&truncateData=50"
      );

      expect(status).toBe(200);
      for (const log of body.logs) {
        expect(log).not.toHaveProperty("input");
        expect(log).not.toHaveProperty("output");
        expect(log).not.toHaveProperty("outputRaw");
        expect(JSON.stringify(log)).not.toContain("_truncated");
      }
    });
  });
});
