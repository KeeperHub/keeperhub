import { ethers } from "ethers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const executeWithFailover = vi.fn();
const fallbackGetTransactionReceipt = vi.fn();
const getFallbackProvider = vi.fn(() => ({
  getTransactionReceipt: fallbackGetTransactionReceipt,
}));
const isSolanaChain = vi.fn(
  (chainId: number) => chainId === 101 || chainId === 103
);

type SolanaConnectionMock = {
  getSignatureStatuses: ReturnType<typeof vi.fn>;
};
const getSignatureStatuses = vi.fn();
const solanaConnection: SolanaConnectionMock = { getSignatureStatuses };
const fallbackGetSignatureStatuses = vi.fn();
const solanaFallbackConnection: SolanaConnectionMock = {
  getSignatureStatuses: fallbackGetSignatureStatuses,
};
const getFallbackConnection = vi.fn(() => solanaFallbackConnection);
const solanaExecuteWithFailover =
  vi.fn<
    (
      operation: (connection: SolanaConnectionMock) => Promise<unknown>
    ) => Promise<unknown>
  >();

const { rpcEvm, rpcSolana, orgLoad } = vi.hoisted(() => ({
  rpcEvm: vi.fn(),
  rpcSolana: vi.fn(),
  orgLoad: vi.fn(),
}));

vi.mock("@/lib/rpc/engine", async () => ({
  ...(await vi.importActual("@/lib/rpc/engine/types")),
  ...(await vi.importActual("@/lib/rpc/engine/scope")),
  ...(await vi.importActual("@/lib/rpc/engine/route-error")),
  rpc: { evm: rpcEvm, solana: rpcSolana },
  orgRpcSource: { load: orgLoad },
}));
vi.mock("@/lib/rpc/solana-chains", () => ({
  isSolanaChain: (chainId: number) => isSolanaChain(chainId),
}));

import { RpcRouteError, RpcRouteErrorCode } from "@/lib/rpc/engine/route-error";
import { orgScope } from "@/lib/rpc/engine/scope";
import {
  describeVerificationFailure,
  verifyExecutionReceipts,
} from "@/lib/web3/verify-receipt";

const SCOPE = orgScope("org-1");

function useEngineManagers(): void {
  orgLoad.mockReset();
  orgLoad.mockResolvedValue({ policy: { ownRpcOnly: false }, configs: [] });
  rpcEvm.mockReset();
  rpcEvm.mockResolvedValue({
    manager: { executeWithFailover, getFallbackProvider },
  });
  rpcSolana.mockReset();
  rpcSolana.mockResolvedValue({
    manager: {
      executeWithFailover: solanaExecuteWithFailover,
      getFallbackConnection,
    },
  });
}

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

// One round, no waiting: the retry budget is wall-clock, so tests that expect
// the lookup to give up would otherwise sit through it.
const SINGLE_ROUND = { budgetMs: 0, retryDelayMs: 0 };
// Enough rounds to exercise the retry, still effectively instant.
const FAST_RETRY = { budgetMs: 200, retryDelayMs: 1 };

describe("verifyExecutionReceipts", () => {
  beforeEach(() => {
    executeWithFailover.mockReset();
    fallbackGetTransactionReceipt.mockReset();
    fallbackGetTransactionReceipt.mockResolvedValue(null);
    useEngineManagers();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("empty input returns allVerified true with no results", async () => {
    const result = await verifyExecutionReceipts([], SCOPE);
    expect(result).toEqual({ allVerified: true, results: [] });
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("status 1 with no Safe logs verifies as success", async () => {
    executeWithFailover.mockResolvedValueOnce(makeReceipt(1));
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );
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
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );
    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "reverted" });
  });

  it("status 1 with an ExecutionFailure log is safe_inner_failure even though the outer tx succeeded", async () => {
    executeWithFailover.mockResolvedValueOnce(
      makeReceipt(1, [{ topics: [EXECUTION_FAILURE_TOPIC as string] }])
    );
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );
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
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );
    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("null receipt after retries verifies as not_found", async () => {
    executeWithFailover.mockResolvedValue(null);
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("not_found");
  });

  it("provider throwing on every attempt verifies as timeout, fail-closed", async () => {
    executeWithFailover.mockRejectedValue(new Error("RPC exhausted"));
    fallbackGetTransactionReceipt.mockRejectedValue(new Error("RPC exhausted"));
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("timeout");
  });

  // The reported defect: a load-balanced RPC answered for a node that had not
  // yet seen the transaction, and one miss was taken as proof of failure.
  it("a receipt that is invisible on the first read is found on a later one", async () => {
    executeWithFailover
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(makeReceipt(1));

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE,
      FAST_RETRY
    );

    expect(allVerified).toBe(true);
    expect(results[0]).toMatchObject({ verified: true, status: "success" });
  });

  // A null answer is a successful call, so executeWithFailover never moves off
  // the primary. Without an explicit read the fallback endpoint is unreachable
  // for the one case it exists to cover.
  it("consults the fallback endpoint when the primary reports no receipt", async () => {
    executeWithFailover.mockResolvedValue(null);
    fallbackGetTransactionReceipt.mockResolvedValue(makeReceipt(1));

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(fallbackGetTransactionReceipt).toHaveBeenCalledWith(HASH);
    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("a reverted receipt is terminal and is not retried away", async () => {
    executeWithFailover.mockResolvedValue(makeReceipt(0));

    const { results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE,
      FAST_RETRY
    );

    expect(results[0].status).toBe("reverted");
    expect(executeWithFailover).toHaveBeenCalledTimes(1);
  });

  it("a chain the scope cannot route fails closed as timeout", async () => {
    rpcEvm.mockRejectedValueOnce(
      new RpcRouteError(RpcRouteErrorCode.CHAIN_UNAVAILABLE, 999)
    );
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: 999 }],
      SCOPE
    );
    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("timeout");
  });

  it("reads through another enabled config when the scope's route is not covered", async () => {
    orgLoad.mockResolvedValue({
      policy: { ownRpcOnly: true },
      configs: [
        { id: "cfg-off", enabled: false },
        { id: "cfg-pinned", enabled: true },
      ],
    });
    rpcEvm.mockRejectedValueOnce(
      new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, CHAIN_ID)
    );
    executeWithFailover.mockResolvedValue(makeReceipt(1));

    const { allVerified } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );

    expect(allVerified).toBe(true);
    expect(rpcEvm).toHaveBeenCalledTimes(2);
    expect(rpcEvm.mock.calls[1]?.[0]).toMatchObject({
      selection: { mode: "config", configId: "cfg-pinned" },
    });
  });

  it("groups hashes by chainId, building one manager per distinct chain", async () => {
    executeWithFailover.mockResolvedValue(makeReceipt(1));

    await verifyExecutionReceipts(
      [
        { hash: "0x1", chainId: 1 },
        { hash: "0x2", chainId: 1 },
        { hash: "0x3", chainId: 137 },
      ],
      SCOPE
    );

    // one manager per distinct chainId (2), not per hash (3)
    expect(rpcEvm).toHaveBeenCalledTimes(2);
    expect(executeWithFailover).toHaveBeenCalledTimes(3);
  });

  it("mixed results: allVerified is false when any hash fails, true only when all succeed", async () => {
    executeWithFailover
      .mockResolvedValueOnce(makeReceipt(1))
      .mockResolvedValueOnce(makeReceipt(0));
    const { allVerified, results } = await verifyExecutionReceipts(
      [
        { hash: "0x1", chainId: CHAIN_ID },
        { hash: "0x2", chainId: CHAIN_ID },
      ],
      SCOPE
    );
    expect(allVerified).toBe(false);
    expect(results).toHaveLength(2);
  });
});

const SOLANA_CHAIN_ID = 101;
const SOLANA_DEVNET_CHAIN_ID = 103;
const SIGNATURE =
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

type SignatureStatusMock = {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus: "processed" | "confirmed" | "finalized";
};

function makeSignatureStatus(
  confirmationStatus: SignatureStatusMock["confirmationStatus"],
  err: unknown = null
): SignatureStatusMock {
  return {
    slot: 250_000_000,
    confirmations: confirmationStatus === "finalized" ? null : 5,
    err,
    confirmationStatus,
  };
}

// Solana hashes are base58 signatures read through getSignatureStatuses. The
// adapter confirms at "confirmed", so that level and "finalized" verify; a
// lower level, a null entry, or a thrown read never does.
describe("Solana signatures", () => {
  beforeEach(() => {
    executeWithFailover.mockReset();
    fallbackGetTransactionReceipt.mockReset();
    fallbackGetTransactionReceipt.mockResolvedValue(null);
    useEngineManagers();
    getSignatureStatuses.mockReset();
    getSignatureStatuses.mockResolvedValue({ value: [null] });
    fallbackGetSignatureStatuses.mockReset();
    fallbackGetSignatureStatuses.mockResolvedValue({ value: [null] });
    getFallbackConnection.mockReset();
    getFallbackConnection.mockReturnValue(solanaFallbackConnection);
    solanaExecuteWithFailover.mockReset();
    solanaExecuteWithFailover.mockImplementation((operation) =>
      operation(solanaConnection)
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a confirmed signature with no error verifies as success", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("confirmed")],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE
    );

    expect(rpcSolana).toHaveBeenCalledWith(SCOPE, SOLANA_CHAIN_ID, {
      tuning: expect.any(Object),
    });
    expect(getSignatureStatuses).toHaveBeenCalledWith([SIGNATURE], {
      searchTransactionHistory: true,
    });
    expect(allVerified).toBe(true);
    expect(results[0]).toMatchObject({
      hash: SIGNATURE,
      chainId: SOLANA_CHAIN_ID,
      verified: true,
      status: "success",
    });
  });

  it("a finalized signature is at or above the adapter's commitment and verifies as success", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("finalized")],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE
    );

    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("a signature with an execution error verifies as reverted and is not retried away", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [
        makeSignatureStatus("confirmed", { InstructionError: [0, "Custom"] }),
      ],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      FAST_RETRY
    );

    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "reverted" });
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
  });

  it("a signature the cluster does not report verifies as not_found", async () => {
    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "not_found" });
  });

  it("a signature still at processed is below the adapter's commitment and is not verified", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("processed")],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "not_found" });
  });

  it("an RPC that throws on every attempt verifies as timeout, fail-closed", async () => {
    solanaExecuteWithFailover.mockRejectedValue(
      new Error("Solana RPC failed on both endpoints")
    );

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(allVerified).toBe(false);
    expect(results[0]).toMatchObject({ verified: false, status: "timeout" });
  });

  it("a signature invisible on the first read is found on a later one", async () => {
    getSignatureStatuses
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValue({ value: [makeSignatureStatus("confirmed")] });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      FAST_RETRY
    );

    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
    expect(getSignatureStatuses).toHaveBeenCalledTimes(3);
  });

  it("a Solana chain the scope cannot route fails closed as timeout", async () => {
    rpcSolana.mockRejectedValueOnce(
      new RpcRouteError(RpcRouteErrorCode.NOT_COVERED, SOLANA_CHAIN_ID)
    );

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE
    );

    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("timeout");
    expect(getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("both managers come from the caller's scope with the same retry budget", async () => {
    executeWithFailover.mockResolvedValue(makeReceipt(1));
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("confirmed")],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [
        { hash: HASH, chainId: CHAIN_ID },
        { hash: SIGNATURE, chainId: SOLANA_CHAIN_ID },
      ],
      SCOPE
    );

    const evmRequest = rpcEvm.mock.calls.at(-1);
    const solanaRequest = rpcSolana.mock.calls.at(-1);
    expect(evmRequest?.[0]).toBe(SCOPE);
    expect(evmRequest?.[1]).toBe(CHAIN_ID);
    expect(evmRequest?.[2]?.tuning).toBeDefined();
    expect(solanaRequest?.[0]).toBe(SCOPE);
    expect(solanaRequest?.[1]).toBe(SOLANA_CHAIN_ID);
    expect(solanaRequest?.[2]).toEqual(evmRequest?.[2]);
    expect(allVerified).toBe(true);
    expect(results.map((result) => result.hash)).toEqual([HASH, SIGNATURE]);
  });

  it("groups signatures by chainId, building one Solana manager per distinct chain", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("confirmed")],
    });

    await verifyExecutionReceipts(
      [
        { hash: SIGNATURE, chainId: SOLANA_CHAIN_ID },
        { hash: `${SIGNATURE.slice(0, -1)}X`, chainId: SOLANA_CHAIN_ID },
        { hash: SIGNATURE, chainId: SOLANA_DEVNET_CHAIN_ID },
      ],
      SCOPE
    );

    // one manager per distinct chainId (2), not per signature (3)
    expect(rpcSolana).toHaveBeenCalledTimes(2);
    expect(getSignatureStatuses).toHaveBeenCalledTimes(3);
  });

  // @solana/web3.js types confirmationStatus as optional, and a node or proxy
  // that omits it would otherwise never satisfy the commitment gate: every
  // Solana execution would sit unconfirmed until the reconciler called it
  // dropped. confirmations === null is the rooted signal that predates it.
  it("a rooted status with no confirmationStatus verifies as success", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [{ slot: 250_000_000, confirmations: null, err: null }],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("a not-yet-rooted status with no confirmationStatus is not verified", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [{ slot: 250_000_000, confirmations: 5, err: null }],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(allVerified).toBe(false);
    expect(results[0].status).toBe("not_found");
  });

  // A null entry is a valid JSON-RPC answer, so executeWithFailover treats it
  // as a successful call and never moves off the primary, which is exactly
  // the endpoint observed serving no transaction history at all.
  it("consults the fallback endpoint when the primary reports no status", async () => {
    fallbackGetSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("finalized")],
    });

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(fallbackGetSignatureStatuses).toHaveBeenCalledWith([SIGNATURE], {
      searchTransactionHistory: true,
    });
    expect(allVerified).toBe(true);
    expect(results[0].status).toBe("success");
  });

  it("does not read the fallback when the primary already answered", async () => {
    getSignatureStatuses.mockResolvedValue({
      value: [makeSignatureStatus("confirmed")],
    });

    await verifyExecutionReceipts(
      [{ hash: SIGNATURE, chainId: SOLANA_CHAIN_ID }],
      SCOPE,
      SINGLE_ROUND
    );

    expect(fallbackGetSignatureStatuses).not.toHaveBeenCalled();
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
    fallbackGetTransactionReceipt.mockReset();
    fallbackGetTransactionReceipt.mockResolvedValue(null);
    useEngineManagers();
  });

  it("fails closed when the outer relayer transaction reverted", async () => {
    executeWithFailover.mockResolvedValueOnce(makeReceipt(0));

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );

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

    const { allVerified, results } = await verifyExecutionReceipts(
      [{ hash: HASH, chainId: CHAIN_ID }],
      SCOPE
    );

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
