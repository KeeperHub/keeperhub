import { ethers, makeError } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: { NETWORK_RPC: "network_rpc" },
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));

import { type RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import {
  isNonceConflictError,
  isPreBroadcastNetworkError,
  NonceConflictError,
  PreBroadcastNetworkError,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

// ---------------------------------------------------------------------------
// Real signed-tx fixture, so expectedHash is derived the same way the helper
// derives it under test.
// ---------------------------------------------------------------------------

const TEST_PRIV_KEY = `0x${"1".repeat(64)}`;
const TEST_TX_REQUEST: ethers.TransactionRequest = {
  to: "0x000000000000000000000000000000000000dEaD",
  nonce: 42,
  value: BigInt(0),
  gasLimit: BigInt(21_000),
  maxFeePerGas: BigInt(10_000_000_000),
  maxPriorityFeePerGas: BigInt(1_000_000_000),
  chainId: 1,
  type: 2,
};

let SIGNED_HEX: string;
let EXPECTED_HASH: string;

beforeAll(async () => {
  const wallet = new ethers.Wallet(TEST_PRIV_KEY);
  SIGNED_HEX = await wallet.signTransaction(TEST_TX_REQUEST);
  const parsed = ethers.Transaction.from(SIGNED_HEX);
  if (!parsed.hash) {
    throw new Error("test fixture: failed to derive hash");
  }
  EXPECTED_HASH = parsed.hash;
});

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type ScenarioProvider = {
  broadcastTransaction?: ReturnType<typeof vi.fn>;
  getTransactionReceipt?: ReturnType<typeof vi.fn>;
  getTransaction?: ReturnType<typeof vi.fn>;
};

function makeMockSigner(populated?: ethers.TransactionLike<string>) {
  const populate = vi
    .fn()
    .mockResolvedValue(
      (populated ?? TEST_TX_REQUEST) as ethers.TransactionLike<string>
    );
  const sign = vi.fn().mockResolvedValue(SIGNED_HEX);
  return {
    signer: {
      populateTransaction: populate,
      signTransaction: sign,
    } as unknown as ethers.Signer,
    populate,
    sign,
  };
}

function makeMockRpcManager(provider: ScenarioProvider) {
  const executeWithFailover = vi
    .fn()
    .mockImplementation(
      async (
        op: (p: ethers.JsonRpcProvider) => Promise<unknown>,
        _opType: RpcOperationType
      ) => await op(provider as unknown as ethers.JsonRpcProvider)
    );
  return {
    rpcManager: { executeWithFailover } as unknown as RpcProviderManager,
    executeWithFailover,
  };
}

function makeMockTxResponse(hash: string): ethers.TransactionResponse {
  return { hash } as unknown as ethers.TransactionResponse;
}

function makeMockReceipt(hash: string): ethers.TransactionReceipt {
  return {
    hash,
    blockNumber: 1_000_000,
    status: 1,
  } as unknown as ethers.TransactionReceipt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("submitSignedTransactionWithFailover", () => {
  it("returns the response from the broadcasting provider on first-try success", async () => {
    const { signer, sign, populate } = makeMockSigner();
    const broadcastTransaction = vi
      .fn()
      .mockResolvedValue(makeMockTxResponse(EXPECTED_HASH));
    const { rpcManager, executeWithFailover } = makeMockRpcManager({
      broadcastTransaction,
    });

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(result.response.hash).toBe(EXPECTED_HASH);
    expect(result.preExistingReceipt).toBeUndefined();
    expect(populate).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledWith(SIGNED_HEX);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "write-broadcast"
    );
  });

  it("signs exactly once even when failover invokes the closure twice", async () => {
    const { signer, sign } = makeMockSigner();
    const broadcastTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce(makeMockTxResponse(EXPECTED_HASH));
    const executeWithFailover = vi
      .fn()
      .mockImplementation(
        async (op: (p: ethers.JsonRpcProvider) => Promise<unknown>) => {
          const provider = {
            broadcastTransaction,
          } as unknown as ethers.JsonRpcProvider;
          try {
            return await op(provider);
          } catch {
            return await op(provider);
          }
        }
      );
    const rpcManager = {
      executeWithFailover,
    } as unknown as RpcProviderManager;

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcastTransaction).toHaveBeenCalledTimes(2);
    expect(broadcastTransaction).toHaveBeenNthCalledWith(1, SIGNED_HEX);
    expect(broadcastTransaction).toHaveBeenNthCalledWith(2, SIGNED_HEX);
  });

  it("returns preExistingReceipt when broadcast fails but tx already mined", async () => {
    const { signer } = makeMockSigner();
    const receipt = makeMockReceipt(EXPECTED_HASH);
    const minedResponse = makeMockTxResponse(EXPECTED_HASH);
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(
        makeError("nonce has already been used", "NONCE_EXPIRED", {
          transaction: { from: "0x", to: "0x" },
        })
      ),
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransaction: vi.fn().mockResolvedValue(minedResponse),
    });

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(result.response).toBe(minedResponse);
    expect(result.preExistingReceipt).toBe(receipt);
  });

  it("returns success when broadcast fails but tx is in mempool", async () => {
    const { signer } = makeMockSigner();
    const pendingResponse = makeMockTxResponse(EXPECTED_HASH);
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi
        .fn()
        .mockRejectedValue(new Error("already known")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(pendingResponse),
    });

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(result.response).toBe(pendingResponse);
    expect(result.preExistingReceipt).toBeUndefined();
  });

  it("throws NonceConflictError when broadcast fails with REPLACEMENT_UNDERPRICED and no on-chain trace", async () => {
    const { signer } = makeMockSigner();
    const originalError = makeError(
      "replacement fee too low",
      "REPLACEMENT_UNDERPRICED",
      { transaction: { from: "0x", to: "0x" } }
    );
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "NonceConflictError",
      expectedHash: EXPECTED_HASH,
      nonce: 42,
      cause: originalError,
    });
  });

  it("throws NonceConflictError on geth 'already known' (ethers leaves this as SERVER_ERROR)", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error("already known");
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toBeInstanceOf(NonceConflictError);
  });

  it("tags a lone connection refusal as PreBroadcastNetworkError, preserving the cause", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error("ECONNREFUSED");
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    const thrown = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    ).then(
      () => undefined,
      (error: unknown) => error
    );

    expect(thrown).toBeInstanceOf(PreBroadcastNetworkError);
    expect(isPreBroadcastNetworkError(thrown)).toBe(true);
    // The tag wraps, it does not rewrite: log readers and message matchers
    // see the original text, and the cause chain keeps the raw error.
    expect((thrown as Error).message).toBe("ECONNREFUSED");
    expect((thrown as PreBroadcastNetworkError).cause).toBe(originalError);
  });

  it("preserves the deterministic hash when failover mixes timeout with connection refusal", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error(
      "RPC failed on both endpoints. Primary: request timed out. Fallback: ECONNREFUSED"
    );
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "OnChainPendingError",
      kind: "onchain-pending",
      transactionHash: EXPECTED_HASH,
    });
  });

  it("tags an all-refused failover round as PreBroadcastNetworkError", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error(
      "RPC failed on both endpoints. Primary: connection refused. Fallback: ECONNREFUSED"
    );
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "PreBroadcastNetworkError",
      kind: "pre-broadcast",
      cause: originalError,
    });
  });

  it("preserves the deterministic hash when a send reply is ambiguous", async () => {
    const { signer } = makeMockSigner();
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi
        .fn()
        .mockRejectedValue(new Error("request timed out")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "OnChainPendingError",
      kind: "onchain-pending",
      transactionHash: EXPECTED_HASH,
    });
  });

  it("does not invoke sign or any rpc call when populateTransaction throws", async () => {
    const populateError = new Error("populate boom");
    const populate = vi.fn().mockRejectedValue(populateError);
    const sign = vi.fn();
    const signer = {
      populateTransaction: populate,
      signTransaction: sign,
    } as unknown as ethers.Signer;
    const { rpcManager, executeWithFailover } = makeMockRpcManager({});

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "PreBroadcastNetworkError",
      kind: "pre-broadcast",
      cause: populateError,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("tags a signing failure as pre-broadcast and never calls rpc", async () => {
    const signError = new Error("wallet signing refused");
    const signer = {
      populateTransaction: vi.fn().mockResolvedValue(TEST_TX_REQUEST),
      signTransaction: vi.fn().mockRejectedValue(signError),
    } as unknown as ethers.Signer;
    const { rpcManager, executeWithFailover } = makeMockRpcManager({});
    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toMatchObject({
      name: "PreBroadcastNetworkError",
      kind: "pre-broadcast",
      cause: signError,
    });
    expect(executeWithFailover).not.toHaveBeenCalled();
  });

  it("derives expectedHash deterministically from the signed bytes", async () => {
    const { signer } = makeMockSigner();
    const originalError = makeError(
      "nonce has already been used",
      "NONCE_EXPIRED",
      { transaction: { from: "0x", to: "0x" } }
    );
    let observedHash: string | undefined;
    const getTransactionReceipt = vi.fn().mockImplementation((hash: string) => {
      observedHash = hash;
      return Promise.resolve(null);
    });
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt,
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toBeInstanceOf(NonceConflictError);
    expect(observedHash).toBe(EXPECTED_HASH);
  });

  it("nonce-conflict path probes on-chain even when error message is non-conflict-y", async () => {
    const { signer } = makeMockSigner();
    const receipt = makeMockReceipt(EXPECTED_HASH);
    const minedResponse = makeMockTxResponse(EXPECTED_HASH);
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
      getTransaction: vi.fn().mockResolvedValue(minedResponse),
    });

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.preExistingReceipt).toBe(receipt);
  });
});

describe("RpcProviderManager write-broadcast retry evidence", () => {
  it("does not call an endpoint all-refused when an earlier retry timed out", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: "http://127.0.0.1:1",
        maxRetries: 3,
        timeoutMs: 50,
        chainName: "retry-history-test",
        chainId: 1,
      },
    });
    let attempt = 0;

    const thrown = await manager
      .executeWithFailover(async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("Timeout after 50ms");
        }
        throw new Error("ECONNREFUSED");
      }, "write-broadcast")
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(attempt).toBe(3);
    expect(thrown).toBeInstanceOf(Error);
    expect(
      (
        thrown as Error & {
          allAttemptsConnectionRefused?: boolean;
        }
      ).allAttemptsConnectionRefused
    ).toBe(false);
  });

  it("marks an endpoint all-refused only when every retry was refused", async () => {
    const manager = new RpcProviderManager({
      config: {
        primaryRpcUrl: "http://127.0.0.1:1",
        maxRetries: 3,
        timeoutMs: 50,
        chainName: "retry-history-test",
        chainId: 1,
      },
    });
    let attempt = 0;

    const thrown = await manager
      .executeWithFailover(async () => {
        attempt += 1;
        throw new Error("ECONNREFUSED");
      }, "write-broadcast")
      .then(
        () => undefined,
        (error: unknown) => error
      );

    expect(attempt).toBe(3);
    expect(
      (
        thrown as Error & {
          allAttemptsConnectionRefused?: boolean;
        }
      ).allAttemptsConnectionRefused
    ).toBe(true);
  });
});

describe("isNonceConflictError", () => {
  it("matches ethers NONCE_EXPIRED code", () => {
    const err = makeError("nonce has already been used", "NONCE_EXPIRED", {
      transaction: { from: "0x", to: "0x" },
    });
    expect(isNonceConflictError(err)).toBe(true);
  });

  it("matches ethers REPLACEMENT_UNDERPRICED code", () => {
    const err = makeError(
      "replacement fee too low",
      "REPLACEMENT_UNDERPRICED",
      {
        transaction: { from: "0x", to: "0x" },
      }
    );
    expect(isNonceConflictError(err)).toBe(true);
  });

  it.each([
    "already known",
    "Already known",
    "RPC error: ALREADY KNOWN",
    "known transaction",
    "nonce too low",
    "nonce is too low",
    "nonce has already been used",
    "replacement transaction underpriced",
    "replacement underpriced",
    "replacement fee too low",
    // executeWithFailover-style wrapped messages (both endpoints failed)
    "RPC failed on both endpoints. Primary: connection refused. Fallback: nonce has already been used",
    "RPC failed on both endpoints. Primary: timeout. Fallback: replacement fee too low",
  ])("matches conflict-message by substring: %s", (msg) => {
    expect(isNonceConflictError(new Error(msg))).toBe(true);
  });

  it.each([
    "ECONNREFUSED",
    "timeout",
    "internal server error",
    "invalid signature",
    "intrinsic gas too low",
    "execution reverted",
  ])("does not match unrelated error: %s", (msg) => {
    expect(isNonceConflictError(new Error(msg))).toBe(false);
  });

  it("handles non-Error values without throwing", () => {
    expect(isNonceConflictError("already known")).toBe(true);
    expect(isNonceConflictError(null)).toBe(false);
    expect(isNonceConflictError(undefined)).toBe(false);
    expect(isNonceConflictError({ message: "already known" })).toBe(false);
  });

  it("matches CALL_EXCEPTION etc. as false (sanity)", () => {
    const err = makeError("execution reverted", "CALL_EXCEPTION", {
      action: "estimateGas",
      data: null,
      reason: null,
      transaction: { from: "0x", to: "0x", data: "0x" },
      invocation: null,
      revert: null,
    });
    expect(isNonceConflictError(err)).toBe(false);
  });
});

describe("isPreBroadcastNetworkError", () => {
  it("recognises the tagged error and nothing else", () => {
    const tagged = new PreBroadcastNetworkError("ECONNREFUSED", new Error("x"));
    expect(isPreBroadcastNetworkError(tagged)).toBe(true);

    // The whole point of the tag: identical TEXT without the marker is not
    // evidence. A refused receipt poll or bookkeeping insert reads exactly
    // like this, and text-matching it is what let a live transaction look
    // safe to retry.
    expect(isPreBroadcastNetworkError(new Error("ECONNREFUSED"))).toBe(false);
    expect(
      isPreBroadcastNetworkError(
        new Error(
          "RPC failed on both endpoints. Primary: connection refused. Fallback: ECONNREFUSED"
        )
      )
    ).toBe(false);
    expect(isPreBroadcastNetworkError("ECONNREFUSED")).toBe(false);
    expect(isPreBroadcastNetworkError(undefined)).toBe(false);
  });
});
