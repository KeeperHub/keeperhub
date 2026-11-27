/**
 * GET /api/workflows/executions/[executionId]/logs names the organization RPC
 * config that served each step, looked up within the run's organization.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockResolveAuthorizedExecution, mockFindMany, mockSelectWhere } =
  vi.hoisted(() => ({
    mockResolveAuthorizedExecution: vi.fn(),
    mockFindMany: vi.fn(),
    mockSelectWhere: vi.fn(),
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
    select: () => ({ from: () => ({ where: mockSelectWhere }) }),
  },
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: { DATABASE: "DATABASE" },
  logSystemError: vi.fn(),
}));

import { GET } from "@/app/api/workflows/executions/[executionId]/logs/route";

const EXECUTION_ID = "exec_1";

type StepRpc = {
  rpcOrigin: string | null;
  rpcConfigId: string | null;
  rpcEndpoints?: unknown[] | null;
};

function step(id: string, rpc: StepRpc): Record<string, unknown> {
  return {
    id,
    executionId: EXECUTION_ID,
    nodeId: id,
    nodeName: "Read balance",
    nodeType: "web3/check-balance",
    status: "success",
    input: {},
    output: {},
    outputRaw: {},
    error: null,
    timestamp: new Date("2026-09-23T00:03:07Z"),
    rpcFailedOver: false,
    rpcEndpoints: null,
    ...rpc,
  };
}

type Body = {
  logs: Array<{
    id: string;
    rpcConfigName: string | null;
    rpcEndpoints: Array<{ configId: string | null; configName: string | null }>;
  }>;
};

async function call(): Promise<Body> {
  const response = await GET(
    new Request(
      `http://localhost:3000/api/workflows/executions/${EXECUTION_ID}/logs`
    ),
    { params: Promise.resolve({ executionId: EXECUTION_ID }) }
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

function nameOf(body: Body, id: string): string | null | undefined {
  return body.logs.find((log) => log.id === id)?.rpcConfigName;
}

describe("GET /api/workflows/executions/[executionId]/logs rpc endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveAuthorizedExecution.mockResolvedValue({
      ok: true,
      execution: {
        id: EXECUTION_ID,
        status: "success",
        error: null,
        workflow: { organizationId: "org_1" },
      },
      auth: { userId: "user_1" },
    });
  });

  it("names the config for org steps and leaves the others unnamed", async () => {
    mockFindMany.mockResolvedValue([
      step("own", { rpcOrigin: "org", rpcConfigId: "cfg_1" }),
      step("removed", { rpcOrigin: "org", rpcConfigId: "cfg_gone" }),
      step("platform", { rpcOrigin: "platform", rpcConfigId: null }),
      step("no-rpc", { rpcOrigin: null, rpcConfigId: null }),
    ]);
    mockSelectWhere.mockResolvedValue([{ id: "cfg_1", name: "Mainnet main" }]);

    const body = await call();

    expect(mockSelectWhere).toHaveBeenCalledTimes(1);
    expect(nameOf(body, "own")).toBe("Mainnet main");
    expect(nameOf(body, "removed")).toBeNull();
    expect(nameOf(body, "platform")).toBeNull();
    expect(nameOf(body, "no-rpc")).toBeNull();
  });

  it("names every endpoint a step reached, the busiest first", async () => {
    mockFindMany.mockResolvedValue([
      step("mixed", {
        rpcOrigin: "org",
        rpcConfigId: "cfg_1",
        rpcEndpoints: [
          {
            origin: "platform",
            configId: null,
            position: "fallback",
            requests: 1,
            errors: 0,
          },
          {
            origin: "org",
            configId: "cfg_1",
            position: "primary",
            requests: 4,
            errors: 1,
          },
        ],
      }),
    ]);
    mockSelectWhere.mockResolvedValue([{ id: "cfg_1", name: "Mainnet main" }]);

    const body = await call();

    expect(body.logs[0]?.rpcEndpoints).toEqual([
      expect.objectContaining({
        configId: "cfg_1",
        configName: "Mainnet main",
      }),
      expect.objectContaining({ configId: null, configName: null }),
    ]);
  });

  it("skips the lookup when no step was served by an org config", async () => {
    mockFindMany.mockResolvedValue([
      step("platform", { rpcOrigin: "platform", rpcConfigId: null }),
    ]);

    const body = await call();

    expect(mockSelectWhere).not.toHaveBeenCalled();
    expect(nameOf(body, "platform")).toBeNull();
  });
});
