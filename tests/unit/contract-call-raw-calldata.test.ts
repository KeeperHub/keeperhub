import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mockValidateApiKey = vi.fn();
vi.mock("@/app/api/execute/_lib/auth", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockCheckRateLimit = vi.fn();
vi.mock("@/app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock("@/app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi
    .fn()
    .mockResolvedValue({ blocked: false, limitResult: null }),
  EXECUTION_LIMIT_ERROR: "Monthly execution limit exceeded",
  EXECUTION_DEBT_ERROR: "Executions suspended due to unpaid overage invoice.",
}));

vi.mock("@/app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/middleware/require-scope", () => ({
  requireScope: vi.fn().mockReturnValue(null),
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn().mockResolvedValue(undefined),
}));

const mockCheckAndReserveExecution = vi.fn();
vi.mock("@/app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: (...args: unknown[]) =>
    mockCheckAndReserveExecution(...args),
}));

vi.mock("@/app/api/execute/_lib/execution-service", () => ({
  markRunning: vi.fn().mockResolvedValue(undefined),
  completeExecution: vi.fn().mockResolvedValue({ status: "completed" }),
  failExecution: vi.fn().mockResolvedValue({ status: "failed" }),
  redactInput: (input: unknown) => input,
  withRejectedSignerOverride: (body: unknown) => body,
}));

const mockResolveAbi = vi.fn();
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: (...args: unknown[]) => mockResolveAbi(...args),
}));

const mockSimulateContractCall = vi.fn();
vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: (...args: unknown[]) =>
    mockSimulateContractCall(...args),
}));

const mockReadContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: (...args: unknown[]) => mockReadContractCore(...args),
}));

const mockWriteContractCore = vi.fn();
vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: (...args: unknown[]) => mockWriteContractCore(...args),
}));

vi.mock("@/lib/idempotency", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/idempotency")>();
  return {
    ...actual,
    beginIdempotentFromRequest: vi.fn().mockResolvedValue(null),
    withIdempotencyHeartbeat: (_idem: unknown, fn: () => unknown) => fn(),
    recordIdempotentResponse: (_idem: unknown, response: unknown) => response,
    idempotencyEarlyResponse: () => null,
  };
});

import { POST } from "@/app/api/execute/contract-call/route";

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SPENDER = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";
const ERC20_ABI = JSON.stringify([
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
]);
const iface = new ethers.Interface(JSON.parse(ERC20_ABI));

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/execute/contract-call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer kh_test",
    },
    body: JSON.stringify(body),
  });
}

const call = POST as (req: Request) => Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mockValidateApiKey.mockResolvedValue({
    organizationId: "org-1",
    apiKeyId: "key-1",
    scope: "mcp:write",
    credentialType: "api_key",
  });
  mockCheckRateLimit.mockReturnValue({ allowed: true });
  mockCheckAndReserveExecution.mockResolvedValue({
    allowed: true,
    executionId: "exec-1",
  });
  mockWriteContractCore.mockResolvedValue({
    success: true,
    transactionHash: "0xabc",
    transactionLink: "https://basescan.org/tx/0xabc",
    chainId: 8453,
  });
  mockSimulateContractCall.mockResolvedValue({
    success: true,
    status: "simulated",
    wouldRevert: false,
    gasEstimate: "46000",
  });
});

describe("contract-call with raw calldata", () => {
  const approveData = iface.encodeFunctionData("approve", [
    SPENDER,
    BigInt("5000000"),
  ]);

  it("decodes data against the supplied ABI and executes the typed call", async () => {
    const response = await call(
      post({
        chainId: 8453,
        contractAddress: TOKEN,
        data: approveData,
        abi: ERC20_ABI,
      })
    );

    expect(response.status).toBe(202);
    expect(mockWriteContractCore).toHaveBeenCalledTimes(1);
    const input = mockWriteContractCore.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(input.abiFunction).toBe("approve(address,uint256)");
    expect(input.functionArgs).toBe(JSON.stringify([SPENDER, "5000000"]));
    expect(input.abi).toBe(ERC20_ABI);
    expect(input.contractAddress).toBe(TOKEN);
  });

  it("uses the explorer ABI when the body carries none", async () => {
    mockResolveAbi.mockResolvedValue({ abi: ERC20_ABI, source: "explorer" });

    const response = await call(
      post({ chainId: 8453, contractAddress: TOKEN, data: approveData })
    );

    expect(response.status).toBe(202);
    expect(mockResolveAbi).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: TOKEN, network: "8453" })
    );
    expect(mockWriteContractCore.mock.calls[0][0]).toMatchObject({
      abiFunction: "approve(address,uint256)",
    });
  });

  it("dry-runs raw calldata through the same simulate path", async () => {
    const response = await call(
      post({
        chainId: 8453,
        contractAddress: TOKEN,
        data: approveData,
        abi: ERC20_ABI,
        simulate: true,
      })
    );

    expect(response.status).toBe(200);
    expect(mockSimulateContractCall).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "approve(address,uint256)",
        functionArgs: JSON.stringify([SPENDER, "5000000"]),
      })
    );
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("routes a decoded view function to the read path", async () => {
    mockReadContractCore.mockResolvedValue({
      success: true,
      result: "150000000",
    });
    const data = iface.encodeFunctionData("balanceOf", [SPENDER]);

    const response = await call(
      post({ chainId: 8453, contractAddress: TOKEN, data, abi: ERC20_ABI })
    );

    expect(response.status).toBe(200);
    expect(mockReadContractCore).toHaveBeenCalledTimes(1);
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("refuses a selector the ABI does not contain before any execution", async () => {
    const response = await call(
      post({
        chainId: 8453,
        contractAddress: TOKEN,
        data: `0xdeadbeef${"00".repeat(64)}`,
        abi: ERC20_ABI,
      })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("data");
    expect(body.error).toContain("0xdeadbeef is not in the ABI");
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockSimulateContractCall).not.toHaveBeenCalled();
  });

  it("reports an unresolvable ABI on the abi field", async () => {
    mockResolveAbi.mockRejectedValue(new Error("contract not verified"));

    const response = await call(
      post({ chainId: 8453, contractAddress: TOKEN, data: approveData })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("abi");
    expect(body.error).toContain("contract not verified");
  });

  it("still validates the rest of the body before decoding", async () => {
    const response = await call(
      post({ contractAddress: TOKEN, data: approveData, abi: ERC20_ABI })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("chainId");
    expect(mockResolveAbi).not.toHaveBeenCalled();
  });

  it("refuses data next to functionName before anything executes", async () => {
    const response = await call(
      post({
        chainId: 8453,
        contractAddress: TOKEN,
        functionName: "approve",
        functionArgs: JSON.stringify([SPENDER, "1"]),
        abi: ERC20_ABI,
        data: approveData,
      })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("data");
    expect(body.error).toBe("Conflicting field values");
    expect(mockResolveAbi).not.toHaveBeenCalled();
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockSimulateContractCall).not.toHaveBeenCalled();
  });

  it("refuses malformed data in the schema, before the ABI is resolved", async () => {
    for (const data of ["0x095ea7b", "095ea7b3", "0x095ea7", 12_345]) {
      const response = await call(
        post({ chainId: 8453, contractAddress: TOKEN, data, abi: ERC20_ABI })
      );
      const body = (await response.json()) as { field?: string };

      expect(response.status).toBe(400);
      expect(body.field).toBe("data");
    }
    expect(mockResolveAbi).not.toHaveBeenCalled();
    expect(mockWriteContractCore).not.toHaveBeenCalled();
  });

  it("refuses calldata carrying bytes the decode does not represent", async () => {
    const response = await call(
      post({
        chainId: 8453,
        contractAddress: TOKEN,
        data: `${approveData}deadbeef`,
        abi: ERC20_ABI,
      })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("data");
    expect(body.error).toContain("canonical encoding");
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockSimulateContractCall).not.toHaveBeenCalled();
  });
});
