/**
 * Integration tests that the simulate flag on /api/execute/* short-
 * circuits the route BEFORE reserve/broadcast.
 *
 * The simulate cores themselves are unit-tested in
 * tests/unit/execute-simulate.test.ts. Here we only care that:
 *
 *   - body.simulate === true (strict boolean) routes to the simulator
 *   - any non-boolean simulate value is rejected with 400 before any
 *     reserve / broadcast happens
 *   - checkAndReserveExecution is NOT called on the simulate path
 *   - markRunning is NOT called on the simulate path
 *   - the broadcast cores (writeContractCore, transferFundsCore,
 *     transferTokenCore) are NOT called
 *   - the route returns the simulate response shape
 *
 * Run with: pnpm vitest tests/integration/execute-simulate-route.test.ts
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const FROM_ADDRESS = "0xaa0000000000000000000000000000000000aa00";

// Spies referenced inside vi.mock factories must be hoisted; otherwise
// they're undefined at the point Vitest re-orders the mocks to the top.
const spies = vi.hoisted(() => ({
  checkAndReserveExecution: vi.fn(),
  markRunning: vi.fn(),
  completeExecution: vi.fn(),
  failExecution: vi.fn(),
  writeContractCore: vi.fn(),
  transferFundsCore: vi.fn(),
  transferTokenCore: vi.fn(),
  readContractCore: vi.fn(),
  simulateContractCallMock: vi.fn(),
  simulateNativeTransferMock: vi.fn(),
  simulateTokenTransferMock: vi.fn(),
}));

// --- common mocks shared across routes ------------------------------------

vi.mock("../../app/api/execute/_lib/auth", () => ({
  validateApiKey: vi.fn(() =>
    Promise.resolve({ organizationId: "org_test", apiKeyId: "key_test" })
  ),
}));

vi.mock("@/lib/billing/execution-guard", () => ({
  enforceExecutionLimit: vi.fn(() => Promise.resolve({ blocked: false })),
}));

vi.mock("@/lib/db/org-helpers", () => ({
  enterApiExecuteErrorContext: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../app/api/execute/_lib/rate-limit", () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
}));

vi.mock("../../app/api/execute/_lib/wallet-check", () => ({
  requireWallet: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../../app/api/execute/_lib/spending-cap", () => ({
  checkAndReserveExecution: spies.checkAndReserveExecution,
}));

vi.mock("../../app/api/execute/_lib/concurrency-limit", () => ({
  enforceDirectExecutionConcurrency: vi.fn().mockResolvedValue(null),
}));

vi.mock(
  "../../app/api/execute/_lib/execution-service",
  async (importActual) => {
    const actual =
      await importActual<
        typeof import("../../app/api/execute/_lib/execution-service")
      >();
    return {
      ...actual,
      markRunning: spies.markRunning,
      completeExecution: spies.completeExecution,
      failExecution: spies.failExecution,
      redactInput: (x: unknown) => x,
    };
  }
);

vi.mock("@/plugins/web3/steps/write-contract-core", () => ({
  writeContractCore: spies.writeContractCore,
}));
vi.mock("@/plugins/web3/steps/transfer-funds-core", () => ({
  transferFundsCore: spies.transferFundsCore,
}));
vi.mock("@/plugins/web3/steps/transfer-token-core", () => ({
  transferTokenCore: spies.transferTokenCore,
}));
vi.mock("@/plugins/web3/steps/read-contract-core", () => ({
  readContractCore: spies.readContractCore,
}));

vi.mock("@/lib/execute/simulate", () => ({
  simulateContractCall: spies.simulateContractCallMock,
  simulateNativeTransfer: spies.simulateNativeTransferMock,
  simulateTokenTransfer: spies.simulateTokenTransferMock,
}));

// Validation: pass through so we can exercise the simulate path.
vi.mock("../../app/api/execute/_lib/validate", () => ({
  validateContractCallInput: () => ({ valid: true }),
  validateTransferInput: () => ({ valid: true }),
  validateTokenFields: () => ({ valid: true }),
  validateCheckAndExecuteInput: () => ({ valid: true }),
}));

// ABI cache: not used in the simulate path of contract-call (caller
// supplies abi inline) but the route imports it at top of module.
vi.mock("@/lib/abi/cache", () => ({
  resolveAbi: vi.fn(() => Promise.resolve({ abi: "[]" })),
}));

vi.mock("@/lib/abi/utils", () => ({
  findAbiFunction: (_abi: unknown, name: string) => {
    if (name === "setValue") {
      return { name, type: "function", stateMutability: "nonpayable" };
    }
    if (name === "balanceOf") {
      return {
        name,
        type: "function",
        stateMutability: "view",
        outputs: [{ name: "", type: "uint256" }],
      };
    }
    return;
  },
}));

vi.mock("../../app/api/execute/_lib/condition", () => ({
  evaluateCondition: () => ({ met: true }),
}));

import { POST as checkAndExecutePOST } from "@/app/api/execute/check-and-execute/route";
// Routes imported after mocks.
import { POST as contractCallPOST } from "@/app/api/execute/contract-call/route";
import { POST as transferPOST } from "@/app/api/execute/transfer/route";

const WRITE_ABI = JSON.stringify([
  {
    type: "function",
    name: "setValue",
    inputs: [{ name: "v", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
]);

const HAPPY_SIMULATE = {
  success: true,
  status: "simulated" as const,
  from: FROM_ADDRESS,
  to: "0xbb0000000000000000000000000000000000bb00",
  value: "0",
  gasEstimate: "42000",
  simulatedReturnValue: null,
  wouldRevert: false as const,
};

function jsonRequest(url: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const {
  checkAndReserveExecution,
  markRunning,
  completeExecution,
  failExecution,
  writeContractCore,
  transferFundsCore,
  transferTokenCore,
  readContractCore,
  simulateContractCallMock,
  simulateNativeTransferMock,
  simulateTokenTransferMock,
} = spies;

function resetSpies(): void {
  checkAndReserveExecution.mockReset();
  markRunning.mockReset();
  completeExecution.mockReset();
  completeExecution.mockResolvedValue({ status: "completed" });
  failExecution.mockReset();
  writeContractCore.mockReset();
  transferFundsCore.mockReset();
  transferTokenCore.mockReset();
  readContractCore.mockReset();
  simulateContractCallMock.mockReset();
  simulateNativeTransferMock.mockReset();
  simulateTokenTransferMock.mockReset();
}

describe("/api/execute/contract-call simulate", () => {
  it("simulate=true (body) routes to the simulator and skips reserve + broadcast", async () => {
    resetSpies();
    simulateContractCallMock.mockResolvedValueOnce(HAPPY_SIMULATE);

    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
        simulate: true,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("simulated");

    expect(simulateContractCallMock).toHaveBeenCalledTimes(1);
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(writeContractCore).not.toHaveBeenCalled();
  });

  it("rejects simulate as a string (must be strict boolean)", async () => {
    resetSpies();
    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
        // Common mistake: stringly-typed flag. Must NOT silently
        // fall through to a real broadcast.
        simulate: "true" as unknown as boolean,
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("simulate");
    expect(simulateContractCallMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(writeContractCore).not.toHaveBeenCalled();
  });

  it("rejects truthy non-boolean simulate values (e.g. 1)", async () => {
    resetSpies();
    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
        simulate: 1 as unknown as boolean,
      })
    );
    expect(res.status).toBe(400);
    expect(writeContractCore).not.toHaveBeenCalled();
  });

  it("query-string simulate is ignored (one shape per input)", async () => {
    resetSpies();
    // Without body.simulate, the query string must NOT be honoured —
    // there is exactly one way to ask for a dry-run.
    writeContractCore.mockResolvedValueOnce({
      success: true,
      transactionHash: "0xabc",
      transactionLink: null,
      gasUsed: "21000",
      effectiveGasPrice: "1",
    });
    checkAndReserveExecution.mockResolvedValueOnce({
      allowed: true,
      executionId: "exec_1",
    });

    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call?simulate=true", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
      })
    );

    expect(res.status).toBe(202);
    expect(simulateContractCallMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecution).toHaveBeenCalledTimes(1);
    expect(writeContractCore).toHaveBeenCalledTimes(1);
  });

  it("returns HTTP 400 when the simulator reports a revert", async () => {
    resetSpies();
    simulateContractCallMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "0",
      wouldRevert: true,
      revertReason: "Insufficient balance",
      error: "Insufficient balance",
    });

    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
        simulate: true,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.wouldRevert).toBe(true);
    expect(body.revertReason).toBe("Insufficient balance");
  });
  it("returns HTTP 503 when contract simulation is unavailable", async () => {
    resetSpies();
    simulateContractCallMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "0",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const res = await contractCallPOST(
      jsonRequest("/api/execute/contract-call", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        network: "1",
        functionName: "setValue",
        abi: WRITE_ABI,
        functionArgs: JSON.stringify(["1"]),
        simulate: true,
      })
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.failureKind).toBe("unavailable");
    expect(body.wouldRevert).toBe(false);
    expect(body.revertReason).toBeUndefined();

    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(writeContractCore).not.toHaveBeenCalled();
  });
});

describe("/api/execute/transfer simulate", () => {
  it("simulate=true routes a native transfer to simulateNativeTransfer", async () => {
    resetSpies();
    simulateNativeTransferMock.mockResolvedValueOnce(HAPPY_SIMULATE);

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "0.1",
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(200);
    expect(simulateNativeTransferMock).toHaveBeenCalledTimes(1);
    expect(simulateTokenTransferMock).not.toHaveBeenCalled();
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(transferFundsCore).not.toHaveBeenCalled();
  });

  it("returns HTTP 503 when native transfer simulation is unavailable", async () => {
    resetSpies();
    simulateNativeTransferMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xcc0000000000000000000000000000000000cc00",
      value: "100000000000000000",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "0.1",
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.failureKind).toBe("unavailable");
    expect(body.wouldRevert).toBe(false);
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(transferFundsCore).not.toHaveBeenCalled();
  });

  it("carries the insufficient_balance fields across the HTTP boundary", async () => {
    resetSpies();
    // The route spreads the simulate result into NextResponse.json, so the
    // machine-readable attribution fields have to survive serialisation —
    // that is the whole point of a headless caller branching on `code`.
    const undecodable = `0x1234abcd${"00".repeat(32)}`;
    simulateNativeTransferMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xcc0000000000000000000000000000000000cc00",
      value: "100000000000000000",
      failureKind: "validation",
      wouldRevert: true,
      revertReason: "Insufficient ETH balance. Have: 0.0, Need: 0.1.",
      error: "Insufficient ETH balance. Have: 0.0, Need: 0.1.",
      code: "insufficient_balance",
      balanceWei: "0",
      requiredWei: "100000000000000000",
      shortfallWei: "100000000000000000",
      nativeSymbol: "ETH",
      originalError: "execution reverted (unknown custom error)",
      undecodedRevertData: undecodable,
    });

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "0.1",
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.failureKind).toBe("validation");
    expect(body.code).toBe("insufficient_balance");
    expect(body.balanceWei).toBe("0");
    expect(body.requiredWei).toBe("100000000000000000");
    expect(body.shortfallWei).toBe("100000000000000000");
    expect(body.nativeSymbol).toBe("ETH");
    expect(body.originalError).toBe(
      "execution reverted (unknown custom error)"
    );
    expect(body.undecodedRevertData).toBe(undecodable);
    expect(transferFundsCore).not.toHaveBeenCalled();
  });

  it("simulate=true routes a token transfer to simulateTokenTransfer", async () => {
    resetSpies();
    simulateTokenTransferMock.mockResolvedValueOnce(HAPPY_SIMULATE);

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "100",
        tokenAddress: "0xbb0000000000000000000000000000000000bb00",
        decimals: 6,
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(200);
    expect(simulateTokenTransferMock).toHaveBeenCalledTimes(1);
    expect(simulateNativeTransferMock).not.toHaveBeenCalled();
    expect(transferTokenCore).not.toHaveBeenCalled();
  });

  it("returns HTTP 503 when token transfer simulation is unavailable", async () => {
    resetSpies();
    simulateTokenTransferMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "0",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "100",
        tokenAddress: "0xbb0000000000000000000000000000000000bb00",
        decimals: 6,
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.failureKind).toBe("unavailable");
    expect(body.wouldRevert).toBe(false);
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(transferTokenCore).not.toHaveBeenCalled();
  });

  it("passes tokenConfig + decimals through to simulateTokenTransfer (no preflight 400)", async () => {
    resetSpies();
    simulateTokenTransferMock.mockResolvedValueOnce(HAPPY_SIMULATE);

    const res = await transferPOST(
      jsonRequest("/api/execute/transfer", {
        recipientAddress: "0xcc0000000000000000000000000000000000cc00",
        amount: "100",
        // tokenConfig without customToken.address: the route hands this
        // off to simulateTokenTransfer, which uses parseTokenAddress
        // (the same helper the broadcast path uses) to resolve the
        // address. The route does not 400 on shape alone.
        tokenConfig: JSON.stringify({ supportedTokenId: "usdc-mainnet" }),
        chainId: 1,
        simulate: true,
      })
    );

    expect(res.status).toBe(200);
    expect(simulateTokenTransferMock).toHaveBeenCalledTimes(1);
    const call = simulateTokenTransferMock.mock.calls[0]?.[0] as {
      tokenConfig?: unknown;
      decimals?: number;
    };
    expect(call.tokenConfig).toBeDefined();
    expect(call.decimals).toBeUndefined();
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(transferTokenCore).not.toHaveBeenCalled();
  });
});

describe("/api/execute/check-and-execute simulate", () => {
  it("evaluates the condition (read), then simulates the action instead of broadcasting", async () => {
    resetSpies();
    readContractCore.mockResolvedValueOnce({
      success: true,
      result: BigInt(100),
    });
    simulateContractCallMock.mockResolvedValueOnce(HAPPY_SIMULATE);

    const res = await checkAndExecutePOST(
      jsonRequest("/api/execute/check-and-execute", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        functionName: "balanceOf",
        functionArgs: JSON.stringify([FROM_ADDRESS]),
        abi: JSON.stringify([
          {
            type: "function",
            name: "balanceOf",
            inputs: [{ name: "", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
          },
        ]),
        chainId: 1,
        condition: {},
        action: {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          functionName: "setValue",
          functionArgs: JSON.stringify(["1"]),
          abi: WRITE_ABI,
        },
        simulate: true,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executed).toBe(true);
    expect(body.status).toBe("simulated");

    expect(readContractCore).toHaveBeenCalledTimes(1);
    expect(simulateContractCallMock).toHaveBeenCalledTimes(1);
    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(writeContractCore).not.toHaveBeenCalled();
  });

  it("returns executed=false when conditional simulation is unavailable", async () => {
    resetSpies();
    readContractCore.mockResolvedValueOnce({
      success: true,
      result: BigInt(100),
    });
    simulateContractCallMock.mockResolvedValueOnce({
      success: false,
      status: "simulated",
      from: FROM_ADDRESS,
      to: "0xbb0000000000000000000000000000000000bb00",
      value: "0",
      failureKind: "unavailable",
      wouldRevert: false,
      error: "Simulation unavailable: RPC timeout",
    });

    const res = await checkAndExecutePOST(
      jsonRequest("/api/execute/check-and-execute", {
        contractAddress: "0xbb0000000000000000000000000000000000bb00",
        functionName: "balanceOf",
        functionArgs: JSON.stringify([FROM_ADDRESS]),
        abi: JSON.stringify([
          {
            type: "function",
            name: "balanceOf",
            inputs: [{ name: "", type: "address" }],
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
          },
        ]),
        chainId: 1,
        condition: {},
        action: {
          contractAddress: "0xbb0000000000000000000000000000000000bb00",
          functionName: "setValue",
          functionArgs: JSON.stringify(["1"]),
          abi: WRITE_ABI,
        },
        simulate: true,
      })
    );

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.executed).toBe(false);
    expect(body.failureKind).toBe("unavailable");
    expect(body.wouldRevert).toBe(false);

    expect(checkAndReserveExecution).not.toHaveBeenCalled();
    expect(writeContractCore).not.toHaveBeenCalled();
  });
});
