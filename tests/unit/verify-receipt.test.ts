import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const executeWithFailover = vi.fn();
const resolveRpcConfig = vi.fn();
const isSolanaChain = vi.fn(
  (chainId: number) => chainId === 101 || chainId === 103
);

vi.mock("@/lib/rpc/providers", () => ({
  // Regular function, not an arrow function: `new RpcProviderManager(...)` in
  // the module under test requires a constructible mock. Returning an object
  // from the constructor overrides the constructed `this`, which is how the
  // shared `executeWithFailover` spy gets attached to every instance.
  RpcProviderManager: vi.fn().mockImplementation(function RpcProviderManager() {
    return { executeWithFailover };
  }),
}));
vi.mock("@/lib/rpc/config-service", () => ({
  resolveRpcConfig: (...args: unknown[]) => resolveRpcConfig(...args),
}));
vi.mock("@/lib/rpc/provider-factory", () => ({
  isSolanaChain: (chainId: number) => isSolanaChain(chainId),
}));

import {
  describeVerificationFailure,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";

const EXECUTION_FAILURE_TOPIC = new ethers.Interface([
  "event ExecutionFailure(bytes32 txHash, uint256 payment)",
]).getEvent("ExecutionFailure")?.topicHash;
const EXECUTION_SUCCESS_TOPIC = new ethers.Interface([
  "event ExecutionSuccess(bytes32 txHash, uint256 payment)",
]).getEvent("ExecutionSuccess")?.topicHash;

function makeReceipt(
  status: number,
  logs: { topics: string[] }[] = []
): {
  status: number;
  blockNumber: number;
  gasUsed: bigint;
  logs: { topics: string[] }[];
} {
  return { status, blockNumber: 12_345, gasUsed: BigInt(21_000), logs };
}

const HASH = "0xabc123";
const CHAIN_ID = 1;

describe("verifyExecutionReceipts", () => {
  beforeEach(() => {
    executeWithFailover.mockReset();
    resolveRpcConfig.mockReset();
    resolveRpcConfig.mockResolvedValue({
      chainId: CHAIN_ID,
      chainName: "ethereum",
      primaryRpcUrl: "https://primary.example",
      fallbackRpcUrl: "https://fallback.example",
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("empty input returns allVerified true with no results", async () => {
    const result = await verifyExecutionReceipts([]);
    expect(result).toEqual({ allVerified: true, results: [] });
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("status 1 with no Safe logs verifies as success", async () => {
    executeWithFailover.mockResolvedValueOnce(makeReceipt(1));
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(true);
    expect(results[0]).toMatchObject({
      hash: HASH,
      chainId: CHAIN_ID,
      verified: true,
      status: "success",
      blockNumber: 12_345,
    });
  });

  it("status 0 verifies as reverted", async () => {
    executeWithFailover.mockResolvedValueOnce(makeReceipt(0));
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "reverted" });
  });

  it("status 1 with an ExecutionFailure log is safe_inner_failure even though the outer tx succeeded", async () => {
    executeWithFailover.mockResolvedValueOnce(
      makeReceipt(1, [{ topics: [EXECUTION_FAILURE_TOPIC as string] }])
    );
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({
      verified: false,
      status: "safe_inner_failure",
    });
  });

  it("status 1 with only an ExecutionSuccess log is still success (no false positive)", async () => {
    executeWithFailover.mockResolvedValueOnce(
      makeReceipt(1, [{ topics: [EXECUTION_SUCCESS_TOPIC as string] }])
    );
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("null receipt after retries verifies as not_found", async () => {
    executeWithFailover.mockResolvedValueOnce(null);
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("not_found");
  });

  it("provider throwing on every attempt verifies as timeout, fail-closed", async () => {
    executeWithFailover.mockRejectedValueOnce(new Error("RPC exhausted"));
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("timeout");
  });

  it("unresolvable chain (resolveRpcConfig returns null) fails closed as timeout", async () => {
    resolveRpcConfig.mockResolvedValueOnce(null);
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: 999 },
    ]);
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("timeout");
  });

  it("Solana chainIds pass through as verified/success without any RPC call", async () => {
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: 101 },
    ]);
    expect(allVerified).toBe(true);
    expect(results[0]).toMatchObject({ verified: true, status: "success" });
    expect(executeWithFailover).not.toHaveBeenCalled();
    expect(resolveRpcConfig).not.toHaveBeenCalled();
  });

  it("groups hashes by chainId, building one manager per distinct chain", async () => {
    const { RpcProviderManager } = await import("@/lib/rpc/providers");
    executeWithFailover.mockResolvedValue(makeReceipt(1));

    await verifyExecutionReceipts([
      { hash: "0x1", chainId: 1 },
      { hash: "0x2", chainId: 1 },
      { hash: "0x3", chainId: 137 },
    ]);

    // one construction per distinct chainId (2), not per hash (3)
    expect(RpcProviderManager).toHaveBeenCalledTimes(2);
    expect(executeWithFailover).toHaveBeenCalledTimes(3);
  });

  it("mixed results: allVerified is false when any hash fails, true only when all succeed", async () => {
    executeWithFailover
      .mockResolvedValueOnce(makeReceipt(1))
      .mockResolvedValueOnce(makeReceipt(0));
    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: "0x1", chainId: CHAIN_ID },
      { hash: "0x2", chainId: CHAIN_ID },
    ]);
    expect(allVerified).toBe(false);
    expect(results).toHaveLength(2);
  });
});

/**
 * Gas-sponsored writes are a wrapped execution, not a direct send: Turnkey's
 * Gas Station delegates the org wallet via EIP-7702, and a relayer EOA calls
 * an executor contract which invokes the wallet. The hash an execution claims
 * is therefore the outer relayer transaction, and everything this module
 * concludes about a sponsored write is a statement about that outer receipt.
 *
 * That is safe only while the executor propagates an inner failure to the
 * outer status, which was confirmed against Sepolia: a sponsored write whose
 * inner call reverted produced an outer receipt with status 0. These tests pin
 * the consequence of that assumption. If the executor ever starts absorbing
 * inner failures and returning status 1 -- the shape Safe already has -- the
 * first test here keeps passing while production silently settles failed
 * writes as success, so treat it as a statement of what we rely on Turnkey
 * for, and not as proof that sponsorship is safe by construction.
 */
describe("sponsored (wrapped) executions", () => {
  beforeEach(() => {
    executeWithFailover.mockReset();
    resolveRpcConfig.mockReset();
    resolveRpcConfig.mockResolvedValue({
      chainId: CHAIN_ID,
      chainName: "ethereum",
      primaryRpcUrl: "https://primary.example",
      fallbackRpcUrl: "https://fallback.example",
    });
  });

  it("fails closed when the outer relayer transaction reverted", async () => {
    executeWithFailover.mockResolvedValueOnce(makeReceipt(0));

    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);

    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "reverted" });
  });

  it("verifies a sponsored write whose outer transaction succeeded", async () => {
    // Logs come from the target contract rather than the wallet, because the
    // executor invokes the delegated wallet which then calls the target. None
    // of them are Safe execution events, so nothing should be decoded here.
    executeWithFailover.mockResolvedValueOnce(
      makeReceipt(1, [
        {
          topics: [
            "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
          ],
        },
      ])
    );

    const { allVerified, results } = await verifyExecutionReceipts([
      { hash: HASH, chainId: CHAIN_ID },
    ]);

    expect(allVerified).toBe(true);
    expect(results[0]).toMatchObject({ verified: true, status: "success" });
  });
});

describe("describeVerificationFailure", () => {
  it("summarizes failed entries with hash and human-readable status", () => {
    const message = describeVerificationFailure([
      {
        hash: "0xdead",
        chainId: 1,
        verified: false,
        status: "reverted",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(message).toContain("0xdead");
    expect(message).toContain("reverted on-chain");
  });

  it("omits verified entries from the summary", () => {
    const message = describeVerificationFailure([
      {
        hash: "0xgood",
        chainId: 1,
        verified: true,
        status: "success",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hash: "0xbad",
        chainId: 1,
        verified: false,
        status: "not_found",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(message).not.toContain("0xgood");
    expect(message).toContain("0xbad");
    expect(message).toContain("receipt not found");
  });
});
