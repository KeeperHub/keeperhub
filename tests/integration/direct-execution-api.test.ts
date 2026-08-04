import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks -- available to vi.mock factories which run before any imports
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  checkRateLimit: vi.fn(),
  checkAndReserveExecution: vi.fn(),
  enforceDirectExecutionConcurrency: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  redactInput: vi.fn(),
  transferFundsCore: vi.fn(),
  transferTokenCore: vi.fn(),
  readContractCore: vi.fn(),
  writeContractCore: vi.fn(),
  resolveAbi: vi.fn(),
  statusDbResult: [] as unknown[],
}));

vi.mock("server-only", () => ({}));

vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: mocks.checkAndReserveExecution,
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: mocks.enforceDirectExecutionConcurrency,
}));

vi.mock("@/app/api/execute/_lib/execution-service", async (importActual) => {
  const actual =
    await importActual<
      typeof import("@/app/api/execute/_lib/execution-service")
    >();
  return {
    ...actual,
    markRunning: mocks.markRunning,
    completeExecution: mocks.completeExecution,
    failExecution: mocks.failExecution,
    redactInput: mocks.redactInput,
  };
});

vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: mocks.transferFundsCore,
}));

vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: mocks.transferTokenCore,
}));

vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: mocks.readContractCore,
}));

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: mocks.writeContractCore,
}));

vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: mocks.resolveAbi,
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR:
    "Executions suspended due to unpaid overage invoice. Please update your payment method.",
}));

vi.mock("@/lib/utils", () => ({
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

// DB mock -- override global setup mock to support .limit() for the status route
vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(mocks.statusDbResult)),
        })),
      })),
    })),
    query: {
      workflows: { findFirst: vi.fn(), findMany: vi.fn() },
      workflowSchedules: { findFirst: vi.fn(), findMany: vi.fn() },
      workflowExecutions: { findFirst: vi.fn(), findMany: vi.fn() },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({ returning: vi.fn() })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn() })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Route imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { GET as statusGET } from "@/app/api/execute/[executionId]/status/route";
import { POST as checkAndExecutePOST } from "@/app/api/execute/check-and-execute/route";
import { POST as contractCallPOST } from "@/app/api/execute/contract-call/route";
import { POST as swapPOST } from "@/app/api/execute/swap/route";
import { POST as transferPOST } from "@/app/api/execute/transfer/route";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AUTH_CONTEXT = { organizationId: "org_test", apiKeyId: "key_test" };
const AUTH_HEADER = { Authorization: "Bearer kh_test123" };

const VIEW_ABI = JSON.stringify([
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
]);

const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/execute${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getRequest(path: string): Request {
  return new Request(`http://localhost:3000/api/execute${path}`, {
    method: "GET",
    headers: { ...AUTH_HEADER },
  });
}

function setupPassingGuards(): void {
  mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
  mocks.checkRateLimit.mockReturnValue({ allowed: true });
  mocks.checkAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "exec_1",
  });
  mocks.enforceDirectExecutionConcurrency.mockResolvedValue(null);
  mocks.redactInput.mockImplementation(
    (input: Record<string, unknown>) => input
  );
  mocks.markRunning.mockResolvedValue(undefined);
  mocks.completeExecution.mockResolvedValue({ status: "completed" });
  mocks.failExecution.mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Direct Execution API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.statusDbResult = [];
  });

  // ==========================================================================
  // POST /api/execute/transfer
  // ==========================================================================
  describe("POST /api/execute/transfer", () => {
    const validBody = {
      network: "ethereum",
      recipientAddress: "0x1234567890123456789012345678901234567890",
      amount: "1.0",
    };

    it("returns 401 when auth fails", async () => {
      mocks.validateApiKey.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });

    it("returns 429 when rate limited with Retry-After header", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: false, retryAfter: 30 });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
      const data = await response.json();
      expect(data.error).toBe("Rate limit exceeded");
    });

    it("returns 400 for invalid JSON body", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: true });

      const request = new Request(
        "http://localhost:3000/api/execute/transfer",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...AUTH_HEADER },
          body: "not json",
        }
      );

      const response = await transferPOST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid JSON body");
    });

    it("returns 400 when required fields missing", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: true });

      const response = await transferPOST(
        postRequest("/transfer", { network: "ethereum" })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Missing required field");
      expect(data.field).toBe("recipientAddress");
    });

    it("returns 403 when spending cap exceeded", async () => {
      setupPassingGuards();
      mocks.checkAndReserveExecution.mockResolvedValue({
        allowed: false,
        reason: "Daily spending cap exceeded",
      });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Daily spending cap exceeded");
    });

    it("returns 202 for successful ETH transfer", async () => {
      setupPassingGuards();
      mocks.transferFundsCore.mockResolvedValue({
        success: true,
        transactionHash: "0xabc",
        transactionLink: "https://etherscan.io/tx/0xabc",
      });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.executionId).toBe("exec_1");
      expect(data.status).toBe("completed");
      expect(data.transactionHash).toBe("0xabc");
      expect(data.transactionLink).toBe("https://etherscan.io/tx/0xabc");
      expect(mocks.completeExecution).toHaveBeenCalledOnce();
      expect(mocks.transferFundsCore).toHaveBeenCalledWith(
        expect.objectContaining({
          network: "ethereum",
          recipientAddress: validBody.recipientAddress,
          amount: "1.0",
        })
      );
    });

    it("returns 202 for ERC-20 token transfer", async () => {
      setupPassingGuards();
      mocks.transferTokenCore.mockResolvedValue({
        success: true,
        transactionHash: "0xdef",
        transactionLink: "https://etherscan.io/tx/0xdef",
      });

      const bodyWithToken = {
        ...validBody,
        tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      };

      const response = await transferPOST(
        postRequest("/transfer", bodyWithToken)
      );

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.status).toBe("completed");
      expect(data.transactionHash).toBe("0xdef");
      expect(data.transactionLink).toBe("https://etherscan.io/tx/0xdef");
      expect(mocks.transferTokenCore).toHaveBeenCalledOnce();
      expect(mocks.transferFundsCore).not.toHaveBeenCalled();
    });

    it("charges the native amount (wei) against the value cap", async () => {
      setupPassingGuards();
      mocks.transferFundsCore.mockResolvedValue({
        success: true,
        transactionHash: "0xabc",
      });

      await transferPOST(postRequest("/transfer", validBody));

      expect(mocks.checkAndReserveExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "transfer",
          reserved: { kind: "evm", valueWei: "1000000000000000000" },
        })
      );
    });

    it("reserves 0 native value for an ERC-20 transfer", async () => {
      setupPassingGuards();
      mocks.transferTokenCore.mockResolvedValue({
        success: true,
        transactionHash: "0xdef",
      });

      await transferPOST(
        postRequest("/transfer", {
          ...validBody,
          tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        })
      );

      expect(mocks.checkAndReserveExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          reserved: { kind: "evm", valueWei: "0" },
        })
      );
    });

    it("returns 400 for an unparseable native amount before reserving", async () => {
      setupPassingGuards();

      const response = await transferPOST(
        postRequest("/transfer", { ...validBody, amount: "not-a-number" })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("amount");
      expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    });

    it("returns 429 when direct-execution concurrency is exceeded", async () => {
      setupPassingGuards();
      const { NextResponse } = await import("next/server");
      mocks.enforceDirectExecutionConcurrency.mockResolvedValue(
        NextResponse.json(
          { error: "Too many concurrent executions", running: 100, limit: 100 },
          { status: 429 }
        )
      );

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(429);
      expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    });

    it("returns 202 with failed status when transfer fails", async () => {
      setupPassingGuards();
      mocks.transferFundsCore.mockResolvedValue({
        success: false,
        error: "Insufficient funds",
      });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.status).toBe("failed");
      expect(data.transactionHash).toBeUndefined();
      expect(data.transactionLink).toBeUndefined();
      // A pre-broadcast failure has no transaction to reconcile, so the
      // finalizer is told there is no hash rather than being handed one.
      expect(mocks.failExecution).toHaveBeenCalledWith(
        "exec_1",
        "Insufficient funds",
        {
          transactionHash: undefined,
          chainId: undefined,
          sponsored: undefined,
        }
      );
    });

    it("records the hash and route when a broadcast transaction reverts", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: true });
      mocks.transferFundsCore.mockResolvedValue({
        success: false,
        error: "Transaction reverted: execution reverted (tx 0xdead)",
        transactionHash: "0xdead",
        chainId: 11_155_111,
        sponsored: true,
      });

      const response = await transferPOST(postRequest("/transfer", validBody));

      expect(response.status).toBe(202);
      expect(mocks.failExecution).toHaveBeenCalledWith(
        "exec_1",
        "Transaction reverted: execution reverted (tx 0xdead)",
        {
          transactionHash: "0xdead",
          chainId: 11_155_111,
          sponsored: true,
        }
      );
    });

    it("returns 400 for invalid tokenAddress format", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: true });

      const response = await transferPOST(
        postRequest("/transfer", { ...validBody, tokenAddress: "not-hex" })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid field type");
      expect(data.field).toBe("tokenAddress");
    });

    it("returns 400 for invalid tokenConfig type", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);
      mocks.checkRateLimit.mockReturnValue({ allowed: true });

      const response = await transferPOST(
        postRequest("/transfer", { ...validBody, tokenConfig: 12_345 })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid field type");
      expect(data.field).toBe("tokenConfig");
    });
  });

  // ==========================================================================
  // POST /api/execute/contract-call
  // ==========================================================================
  describe("POST /api/execute/contract-call", () => {
    const validReadBody = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      functionName: "balanceOf",
      abi: VIEW_ABI,
      functionArgs: JSON.stringify(["0xabc"]),
    };

    const validWriteBody = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      functionName: "transfer",
      abi: WRITE_ABI,
      functionArgs: JSON.stringify(["0xabc", "1000000"]),
    };

    it("returns 401 when auth fails", async () => {
      mocks.validateApiKey.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", validReadBody)
      );

      expect(response.status).toBe(401);
    });

    it("returns 400 when required fields missing", async () => {
      setupPassingGuards();

      const response = await contractCallPOST(
        postRequest("/contract-call", { network: "ethereum" })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("contractAddress");
    });

    it("returns 400 when ABI resolution fails", async () => {
      setupPassingGuards();
      mocks.resolveAbi.mockRejectedValue(new Error("Explorer returned 404"));

      const bodyNoAbi = {
        contractAddress: "0x1234567890123456789012345678901234567890",
        network: "ethereum",
        functionName: "balanceOf",
      };

      const response = await contractCallPOST(
        postRequest("/contract-call", bodyNoAbi)
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("abi");
      expect(data.error).toContain("Could not auto-fetch ABI");
    });

    it("returns 400 when function not found in ABI", async () => {
      setupPassingGuards();

      const body = { ...validReadBody, functionName: "nonExistent" };

      const response = await contractCallPOST(
        postRequest("/contract-call", body)
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("functionName");
      expect(data.error).toContain("not found in ABI");
    });

    it("returns 200 with result for view/pure call", async () => {
      setupPassingGuards();
      mocks.readContractCore.mockResolvedValue({
        success: true,
        result: "1000000",
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", validReadBody)
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.result).toBe("1000000");
      expect(mocks.checkAndReserveExecution).not.toHaveBeenCalled();
    });

    it("returns 202 for write call with execution record", async () => {
      setupPassingGuards();
      mocks.writeContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xwrite",
        transactionLink: "https://etherscan.io/tx/0xwrite",
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", validWriteBody)
      );

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.executionId).toBe("exec_1");
      expect(data.status).toBe("completed");
      expect(mocks.checkAndReserveExecution).toHaveBeenCalledOnce();
    });

    it("returns 403 when spending cap exceeded for write call", async () => {
      setupPassingGuards();
      mocks.checkAndReserveExecution.mockResolvedValue({
        allowed: false,
        reason: "Daily spending cap exceeded",
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", validWriteBody)
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Daily spending cap exceeded");
    });

    it("returns 400 with priorityFeeGwei field when value is non-numeric", async () => {
      setupPassingGuards();

      const response = await contractCallPOST(
        postRequest("/contract-call", {
          ...validReadBody,
          priorityFeeGwei: "abc",
        })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("priorityFeeGwei");
      expect(data.error).toBe("Invalid field value");
    });

    it("returns 400 with priorityFeeGwei field when value is empty string", async () => {
      setupPassingGuards();

      const response = await contractCallPOST(
        postRequest("/contract-call", {
          ...validReadBody,
          priorityFeeGwei: "",
        })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("priorityFeeGwei");
      expect(data.error).toBe("Invalid field type");
    });

    it("returns 400 with priorityFeeGwei field when value is non-positive", async () => {
      setupPassingGuards();

      const response = await contractCallPOST(
        postRequest("/contract-call", {
          ...validReadBody,
          priorityFeeGwei: "-1",
        })
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("priorityFeeGwei");
    });

    it("forwards priorityFeeGwei to writeContractCore for write calls", async () => {
      setupPassingGuards();
      mocks.writeContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xwrite",
        transactionLink: "https://etherscan.io/tx/0xwrite",
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", {
          ...validWriteBody,
          priorityFeeGwei: "5",
        })
      );

      expect(response.status).toBe(202);
      expect(mocks.writeContractCore).toHaveBeenCalledWith(
        expect.objectContaining({ priorityFeeGwei: "5" })
      );
    });

    it("forwards the `value` field to writeContractCore as ethValue for write calls", async () => {
      setupPassingGuards();
      mocks.writeContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xwrite",
        transactionLink: "https://etherscan.io/tx/0xwrite",
      });

      const response = await contractCallPOST(
        postRequest("/contract-call", {
          ...validWriteBody,
          value: "0.1",
        })
      );

      expect(response.status).toBe(202);
      expect(mocks.writeContractCore).toHaveBeenCalledWith(
        expect.objectContaining({ ethValue: "0.1" })
      );
    });
  });

  // ==========================================================================
  // POST /api/execute/check-and-execute
  // ==========================================================================
  describe("POST /api/execute/check-and-execute", () => {
    const validBody = {
      contractAddress: "0x1234567890123456789012345678901234567890",
      network: "ethereum",
      functionName: "balanceOf",
      abi: VIEW_ABI,
      functionArgs: JSON.stringify(["0xabc"]),
      condition: { operator: "gt", value: "1000" },
      action: {
        contractAddress: "0x1234567890123456789012345678901234567890",
        functionName: "transfer",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["0xabc", "500"]),
      },
    };

    it("returns 401 when auth fails", async () => {
      mocks.validateApiKey.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", validBody)
      );

      expect(response.status).toBe(401);
    });

    it("returns 400 when condition missing", async () => {
      setupPassingGuards();

      const { condition: _, ...bodyWithoutCondition } = validBody;

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", bodyWithoutCondition)
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("condition");
    });

    it("returns 400 when action missing", async () => {
      setupPassingGuards();

      const { action: _, ...bodyWithoutAction } = validBody;

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", bodyWithoutAction)
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("action");
    });

    it("returns 400 for invalid condition operator", async () => {
      setupPassingGuards();

      const body = {
        ...validBody,
        condition: { operator: "between", value: "1000" },
      };

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", body)
      );

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.field).toBe("condition.operator");
    });

    it("returns 200 with executed=false when condition not met", async () => {
      setupPassingGuards();
      mocks.readContractCore.mockResolvedValue({
        success: true,
        result: "500",
      });

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", validBody)
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.executed).toBe(false);
      expect(data.conditionResult.met).toBe(false);
      expect(data.conditionResult.observedValue).toBe("500");
      expect(mocks.writeContractCore).not.toHaveBeenCalled();
    });

    it("returns 202 with executed=true when condition met and write succeeds", async () => {
      setupPassingGuards();
      mocks.readContractCore.mockResolvedValue({
        success: true,
        result: "1500",
      });
      mocks.writeContractCore.mockResolvedValue({
        success: true,
        transactionHash: "0xcond",
        transactionLink: "https://etherscan.io/tx/0xcond",
      });

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", validBody)
      );

      expect(response.status).toBe(202);
      const data = await response.json();
      expect(data.executed).toBe(true);
      expect(data.conditionResult.met).toBe(true);
      expect(data.executionId).toBe("exec_1");
    });

    it("returns 403 when condition met but spending cap exceeded", async () => {
      setupPassingGuards();
      mocks.readContractCore.mockResolvedValue({
        success: true,
        result: "1500",
      });
      mocks.checkAndReserveExecution.mockResolvedValue({
        allowed: false,
        reason: "Daily spending cap exceeded",
      });

      const response = await checkAndExecutePOST(
        postRequest("/check-and-execute", validBody)
      );

      expect(response.status).toBe(403);
      const data = await response.json();
      expect(data.error).toBe("Daily spending cap exceeded");
    });
  });

  // ==========================================================================
  // GET /api/execute/{id}/status
  // ==========================================================================
  describe("GET /api/execute/{id}/status", () => {
    it("returns 401 when auth fails", async () => {
      mocks.validateApiKey.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });

      const response = await statusGET(getRequest("/exec_1/status"), {
        params: Promise.resolve({ executionId: "exec_1" }),
      });

      expect(response.status).toBe(401);
    });

    it("returns 404 when execution not found", async () => {
      setupPassingGuards();
      mocks.statusDbResult = [];

      const response = await statusGET(getRequest("/exec_missing/status"), {
        params: Promise.resolve({ executionId: "exec_missing" }),
      });

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe("Execution not found");
      // The request already consumed a rate-limit slot, so the 404 carries headers.
      expect(response.headers.get("X-RateLimit-Limit")).not.toBeNull();
    });

    it("returns 200 with full execution details", async () => {
      setupPassingGuards();
      const now = new Date();
      mocks.statusDbResult = [
        {
          id: "exec_1",
          organizationId: "org_test",
          apiKeyId: "key_test",
          type: "transfer",
          network: "ethereum",
          status: "completed",
          transactionHash: "0xabc",
          gasUsedWei: "441000000000000",
          gasPriceWei: "500000221",
          estimatedCostUsd: null,
          retryCount: 0,
          input: {},
          output: { transactionLink: "https://etherscan.io/tx/0xabc" },
          error: null,
          createdAt: now,
          completedAt: now,
        },
      ];

      const response = await statusGET(getRequest("/exec_1/status"), {
        params: Promise.resolve({ executionId: "exec_1" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.executionId).toBe("exec_1");
      expect(data.status).toBe("completed");
      expect(data.type).toBe("transfer");
      expect(data.transactionHash).toBe("0xabc");
      expect(data.transactionLink).toBe("https://etherscan.io/tx/0xabc");
      expect(data.sponsored).toBe(false);
      expect(data.createdAt).toBe(now.toISOString());
      expect(data.completedAt).toBe(now.toISOString());
    });

    it("returns sponsored: true for a gas-sponsored execution", async () => {
      setupPassingGuards();
      const now = new Date();
      mocks.statusDbResult = [
        {
          id: "exec_2",
          organizationId: "org_test",
          apiKeyId: "key_test",
          type: "transfer",
          network: "ethereum",
          status: "completed",
          transactionHash: "0xabc",
          gasUsedWei: "441000000000000",
          gasPriceWei: "500000221",
          estimatedCostUsd: null,
          retryCount: 0,
          input: {},
          output: {
            transactionLink: "https://etherscan.io/tx/0xabc",
            sponsored: true,
          },
          error: null,
          createdAt: now,
          completedAt: now,
        },
      ];

      const response = await statusGET(getRequest("/exec_2/status"), {
        params: Promise.resolve({ executionId: "exec_2" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.sponsored).toBe(true);
    });

    it("returns the per-hash on-chain verification receipts", async () => {
      setupPassingGuards();
      const now = new Date();
      mocks.statusDbResult = [
        {
          id: "exec_3",
          organizationId: "org_test",
          apiKeyId: "key_test",
          type: "contract-call",
          network: "11155111",
          status: "completed",
          transactionHash: "0xabc",
          receipts: [
            {
              hash: "0xabc",
              chainId: 11_155_111,
              verified: true,
              receiptStatus: "success",
              blockNumber: 11_413_447,
              gasUsed: "68115",
              verifiedAt: now.toISOString(),
            },
          ],
          gasUsedWei: "68115",
          gasPriceWei: "500000221",
          estimatedCostUsd: null,
          retryCount: 0,
          input: {},
          output: { transactionLink: "https://etherscan.io/tx/0xabc" },
          error: null,
          createdAt: now,
          completedAt: now,
        },
      ];

      const response = await statusGET(getRequest("/exec_3/status"), {
        params: Promise.resolve({ executionId: "exec_3" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.receipts).toHaveLength(1);
      expect(data.receipts[0]).toMatchObject({
        hash: "0xabc",
        chainId: 11_155_111,
        verified: true,
        receiptStatus: "success",
        blockNumber: 11_413_447,
      });
    });

    it("exposes the failing receipt on an execution demoted by reconciliation", async () => {
      // The demotion case is the one an operator actually needs: `status`
      // alone says the run failed, `receipts` says which hash failed and why.
      setupPassingGuards();
      const now = new Date();
      mocks.statusDbResult = [
        {
          id: "exec_4",
          organizationId: "org_test",
          apiKeyId: "key_test",
          type: "contract-call",
          network: "11155111",
          status: "failed",
          transactionHash: "0xdead",
          receipts: [
            {
              hash: "0xdead",
              chainId: 11_155_111,
              verified: false,
              receiptStatus: "reverted",
              blockNumber: 11_413_412,
              gasUsed: "43572",
              verifiedAt: now.toISOString(),
            },
          ],
          gasUsedWei: null,
          gasPriceWei: null,
          estimatedCostUsd: null,
          retryCount: 0,
          input: {},
          output: {},
          error:
            "On-chain verification failed for 1 transaction: 0xdead (reverted on-chain)",
          createdAt: now,
          completedAt: now,
        },
      ];

      const response = await statusGET(getRequest("/exec_4/status"), {
        params: Promise.resolve({ executionId: "exec_4" }),
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.status).toBe("failed");
      expect(data.receipts[0].verified).toBe(false);
      expect(data.receipts[0].receiptStatus).toBe("reverted");
    });

    it("route exports GET only -- non-GET methods are intentionally 405 (Next.js auto-handler)", async () => {
      // Locks in the route's GET-only design. If a future change adds POST
      // (e.g. to "fix" 405s reported from upstream), this test forces the
      // change to be deliberate. The 405s users see are not a server bug --
      // a non-GET request is reaching the route from somewhere upstream.
      const routeModule = await import(
        "@/app/api/execute/[executionId]/status/route"
      );

      expect(typeof routeModule.GET).toBe("function");
      expect(routeModule).not.toHaveProperty("POST");
      expect(routeModule).not.toHaveProperty("PUT");
      expect(routeModule).not.toHaveProperty("PATCH");
      expect(routeModule).not.toHaveProperty("DELETE");
    });
  });

  // ==========================================================================
  // POST /api/execute/swap
  // ==========================================================================
  describe("POST /api/execute/swap", () => {
    it("returns 501 not implemented with valid auth", async () => {
      mocks.validateApiKey.mockResolvedValue(AUTH_CONTEXT);

      const response = await swapPOST(
        postRequest("/swap", { fromToken: "ETH", toToken: "USDC" })
      );

      expect(response.status).toBe(501);
      const data = await response.json();
      expect(data.message).toBe("Coming soon");
    });

    it("returns 401 when auth fails", async () => {
      mocks.validateApiKey.mockResolvedValue({
        error: "Unauthorized",
        status: 401,
      });

      const response = await swapPOST(
        postRequest("/swap", { fromToken: "ETH" })
      );

      expect(response.status).toBe(401);
    });
  });
});
