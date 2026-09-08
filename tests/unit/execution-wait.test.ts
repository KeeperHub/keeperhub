import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockFindFirstExecution, mockFindFirstLog } = vi.hoisted(() => ({
  mockFindFirstExecution: vi.fn(),
  mockFindFirstLog: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      workflowExecutions: { findFirst: mockFindFirstExecution },
      workflowExecutionLogs: { findFirst: mockFindFirstLog },
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  workflowExecutions: { id: "id" },
  workflowExecutionLogs: {
    executionId: "execution_id",
    nodeId: "node_id",
    status: "status",
    completedAt: "completed_at",
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("waitForExecutionCompletion (KEEP-265)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null immediately when timeout <= 0", async () => {
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await waitForExecutionCompletion("exec-1", 0);
    expect(result).toBeNull();
    expect(mockFindFirstExecution).not.toHaveBeenCalled();
  });

  it("returns success result when execution is already terminal", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "success",
      output: { foo: "bar" },
      error: null,
    });
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await waitForExecutionCompletion("exec-1", 1000, 10);
    expect(result).toEqual({
      status: "success",
      output: { foo: "bar" },
      error: null,
    });
  });

  it("returns error result with error message when execution failed", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "error",
      output: null,
      error: "RPC down",
    });
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await waitForExecutionCompletion("exec-1", 1000, 10);
    expect(result?.status).toBe("error");
    expect(result?.error).toBe("RPC down");
  });

  it("returns null if execution row is missing", async () => {
    mockFindFirstExecution.mockResolvedValue(undefined);
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await waitForExecutionCompletion("exec-missing", 100, 10);
    expect(result).toBeNull();
  });

  it("polls until terminal status appears", async () => {
    mockFindFirstExecution
      .mockResolvedValueOnce({ status: "running", output: null, error: null })
      .mockResolvedValueOnce({ status: "running", output: null, error: null })
      .mockResolvedValueOnce({
        status: "success",
        output: { balance: "1.3286 ETH" },
        error: null,
      });
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await waitForExecutionCompletion("exec-2", 1000, 5);
    expect(result?.status).toBe("success");
    expect(mockFindFirstExecution).toHaveBeenCalledTimes(3);
  });

  it("returns null on timeout when never reaching terminal state", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "running",
      output: null,
      error: null,
    });
    const { waitForExecutionCompletion } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const start = Date.now();
    const result = await waitForExecutionCompletion("exec-3", 40, 10);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(30);
  });
});

describe("applyOutputMapping (KEEP-265)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns raw workflow output when outputMapping is null", async () => {
    const { applyOutputMapping } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await applyOutputMapping("exec-1", { balance: "1.5" }, null);
    expect(result).toEqual({ balance: "1.5" });
    expect(mockFindFirstLog).not.toHaveBeenCalled();
  });

  it("returns raw workflow output when outputMapping has no nodeId", async () => {
    const { applyOutputMapping } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await applyOutputMapping(
      "exec-1",
      { balance: "1.5" },
      { fields: ["balance"] }
    );
    expect(result).toEqual({ balance: "1.5" });
  });

  it("picks specific fields from the mapped node output", async () => {
    mockFindFirstLog.mockResolvedValue({
      output: {
        riskScore: 3,
        vulnerabilities: ["reentrancy"],
        internalDebug: "ignore-me",
      },
    });
    const { applyOutputMapping } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await applyOutputMapping("exec-1", null, {
      nodeId: "audit-1",
      fields: ["riskScore", "vulnerabilities"],
    });
    expect(result).toEqual({
      riskScore: 3,
      vulnerabilities: ["reentrancy"],
    });
  });

  it("returns full node output when nodeId is set but fields is not", async () => {
    mockFindFirstLog.mockResolvedValue({
      output: { a: 1, b: 2 },
    });
    const { applyOutputMapping } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await applyOutputMapping("exec-1", null, {
      nodeId: "audit-1",
    });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it("falls back to workflow output when the mapped node log is missing", async () => {
    mockFindFirstLog.mockResolvedValue(undefined);
    const { applyOutputMapping } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const result = await applyOutputMapping(
      "exec-1",
      { fallback: true },
      { nodeId: "missing-node" }
    );
    expect(result).toEqual({ fallback: true });
  });
});

describe("buildCallCompletionResponse (KEEP-265)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { status: 'running' } on timeout", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "running",
      output: null,
      error: null,
    });
    const { buildCallCompletionResponse } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const res = await buildCallCompletionResponse("exec-timeout", null, 30);
    expect(res).toEqual({ executionId: "exec-timeout", status: "running" });
  });

  it("returns mapped output on successful completion", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "success",
      output: { balance: "1.3286 ETH", _debug: "noise" },
      error: null,
    });
    mockFindFirstLog.mockResolvedValue({
      output: { balance: "1.3286 ETH", _debug: "noise" },
    });
    const { buildCallCompletionResponse } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const res = await buildCallCompletionResponse(
      "exec-success",
      { nodeId: "last", fields: ["balance"] },
      1000
    );
    expect(res).toEqual({
      executionId: "exec-success",
      status: "success",
      output: { balance: "1.3286 ETH" },
      // ERC-8004 feedback CTA appended to every successful response so the
      // calling LLM can prompt the user to rate the workflow. Hardcoded to
      // KeeperHub's own ERC-8004 agent (NFT 31875 on Ethereum mainnet).
      feedback: {
        prompt: expect.stringContaining("ERC-8004"),
        tool: "keeperhub-wallet:feedback",
        context: {
          executionId: "exec-success",
          agent: {
            registry: "erc-8004",
            chainId: 1,
            id: "31875",
            explorerUrl: "https://8004scan.io/agents/ethereum/31875",
          },
        },
      },
    });
  });

  it("returns error payload when execution fails within timeout", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "error",
      output: null,
      error: "RPC failed",
    });
    const { buildCallCompletionResponse } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const res = await buildCallCompletionResponse("exec-err", null, 1000);
    expect(res).toEqual({
      executionId: "exec-err",
      status: "error",
      error: "RPC failed",
    });
  });

  it("maps cancelled status to an error response", async () => {
    mockFindFirstExecution.mockResolvedValue({
      status: "cancelled",
      output: null,
      error: null,
    });
    const { buildCallCompletionResponse } = await import(
      "@/lib/payments/x402/execution-wait"
    );
    const res = await buildCallCompletionResponse("exec-cancel", null, 1000);
    expect(res).toEqual({
      executionId: "exec-cancel",
      status: "error",
      error: "Execution cancelled",
    });
  });
});
