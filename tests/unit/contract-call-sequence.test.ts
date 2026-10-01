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

const mockSimulateCallSequence = vi.fn();
vi.mock("@/lib/execute/simulate-sequence", () => ({
  simulateCallSequence: (...args: unknown[]) =>
    mockSimulateCallSequence(...args),
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
const VAULT = "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca";
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
]);
const VAULT_ABI = JSON.stringify([
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
]);

const SEQUENCE = [
  {
    contractAddress: TOKEN,
    abi: ERC20_ABI,
    functionName: "approve",
    functionArgs: JSON.stringify([VAULT, "1000"]),
  },
  {
    contractAddress: VAULT,
    abi: VAULT_ABI,
    functionName: "deposit",
    functionArgs: JSON.stringify(["1000", VAULT]),
  },
];

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
  mockSimulateCallSequence.mockResolvedValue({
    success: true,
    status: "simulated",
    from: "0xaa0000000000000000000000000000000000aa00",
    atomic: false,
    mechanism: "eth_simulateV1",
    wouldRevert: false,
    results: [
      { success: true, status: "simulated", wouldRevert: false },
      { success: true, status: "simulated", wouldRevert: false },
    ],
  });
});

describe("contract-call with a call sequence", () => {
  it("simulates the sequence with each call's own ABI", async () => {
    const response = await call(
      post({ chainId: 8453, simulate: true, calls: SEQUENCE })
    );

    expect(response.status).toBe(200);
    expect(mockSimulateCallSequence).toHaveBeenCalledTimes(1);
    const input = mockSimulateCallSequence.mock.calls[0][0] as {
      network: string;
      calls: { contractAddress: string; abi: string; functionName: string }[];
    };
    expect(input.network).toBe("8453");
    expect(input.calls).toHaveLength(2);
    expect(input.calls[0]).toMatchObject({
      contractAddress: TOKEN,
      abi: ERC20_ABI,
      functionName: "approve",
    });
    expect(input.calls[1]).toMatchObject({
      contractAddress: VAULT,
      abi: VAULT_ABI,
      functionName: "deposit",
    });
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockSimulateContractCall).not.toHaveBeenCalled();
  });

  it("refuses to broadcast a sequence", async () => {
    const response = await call(post({ chainId: 8453, calls: SEQUENCE }));
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("calls");
    expect(body.error).toContain("simulate: true");
    expect(mockWriteContractCore).not.toHaveBeenCalled();
    expect(mockSimulateCallSequence).not.toHaveBeenCalled();
  });

  it("falls back to the top-level abi for a call that omits one", async () => {
    await call(
      post({
        chainId: 8453,
        simulate: true,
        abi: ERC20_ABI,
        calls: [
          {
            contractAddress: TOKEN,
            functionName: "approve",
            functionArgs: JSON.stringify([VAULT, "1"]),
          },
        ],
      })
    );

    const input = mockSimulateCallSequence.mock.calls[0][0] as {
      calls: { abi: string }[];
    };
    expect(input.calls[0].abi).toBe(ERC20_ABI);
  });

  it("fetches the explorer ABI for a call with no abi anywhere", async () => {
    mockResolveAbi.mockResolvedValue({ abi: VAULT_ABI, source: "explorer" });

    await call(
      post({
        chainId: 8453,
        simulate: true,
        calls: [
          {
            contractAddress: VAULT,
            functionName: "deposit",
            functionArgs: JSON.stringify(["1", VAULT]),
          },
        ],
      })
    );

    expect(mockResolveAbi).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress: VAULT, network: "8453" })
    );
    const input = mockSimulateCallSequence.mock.calls[0][0] as {
      calls: { abi: string }[];
    };
    expect(input.calls[0].abi).toBe(VAULT_ABI);
  });

  it("reports an unresolvable ABI against the call that needed it", async () => {
    mockResolveAbi.mockRejectedValue(new Error("contract not verified"));

    const response = await call(
      post({
        chainId: 8453,
        simulate: true,
        calls: [
          SEQUENCE[0],
          { contractAddress: VAULT, functionName: "deposit" },
        ],
      })
    );
    const body = (await response.json()) as { error: string; field?: string };

    expect(response.status).toBe(400);
    expect(body.field).toBe("calls[1].abi");
    expect(mockSimulateCallSequence).not.toHaveBeenCalled();
  });

  it("answers 400 when any call in the sequence would revert", async () => {
    mockSimulateCallSequence.mockResolvedValue({
      success: false,
      status: "simulated",
      atomic: false,
      mechanism: "eth_simulateV1",
      wouldRevert: true,
      results: [
        { success: true, status: "simulated", wouldRevert: false },
        {
          success: false,
          status: "simulated",
          failureKind: "revert",
          wouldRevert: true,
          revertReason: "ERC20: transfer amount exceeds allowance",
        },
      ],
    });

    const response = await call(
      post({ chainId: 8453, simulate: true, calls: SEQUENCE })
    );

    expect(response.status).toBe(400);
  });

  it("answers 503 when the node could not answer", async () => {
    mockSimulateCallSequence.mockResolvedValue({
      success: false,
      status: "simulated",
      atomic: false,
      mechanism: null,
      wouldRevert: false,
      results: [
        { success: false, status: "simulated", failureKind: "unavailable" },
      ],
    });

    const response = await call(
      post({ chainId: 8453, simulate: true, calls: [SEQUENCE[0]] })
    );

    expect(response.status).toBe(503);
  });

  it("validates the shape of every call before anything runs", async () => {
    const bad: [Record<string, unknown>, string][] = [
      [{ calls: "nope" }, "calls"],
      [{ calls: [] }, "calls"],
      [{ calls: [{ functionName: "approve" }] }, "calls[0].contractAddress"],
      [{ calls: [{ contractAddress: TOKEN }] }, "calls[0].functionName"],
      [
        {
          calls: [
            SEQUENCE[0],
            {
              contractAddress: VAULT,
              functionName: "deposit",
              functionArgs: 5,
            },
          ],
        },
        "calls[1].functionArgs",
      ],
    ];

    for (const [payload, field] of bad) {
      const response = await call(
        post({ chainId: 8453, simulate: true, ...payload })
      );
      const body = (await response.json()) as { field?: string };

      expect(response.status).toBe(400);
      expect(body.field).toBe(field);
    }
    expect(mockSimulateCallSequence).not.toHaveBeenCalled();
  });

  it("leaves a single-call request on the ordinary path", async () => {
    mockSimulateContractCall.mockResolvedValue({
      success: true,
      status: "simulated",
      wouldRevert: false,
    });

    await call(
      post({
        chainId: 8453,
        simulate: true,
        contractAddress: TOKEN,
        functionName: "approve",
        functionArgs: JSON.stringify([VAULT, "1"]),
        abi: ERC20_ABI,
      })
    );

    expect(mockSimulateContractCall).toHaveBeenCalledTimes(1);
    expect(mockSimulateCallSequence).not.toHaveBeenCalled();
  });
});
