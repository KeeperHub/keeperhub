import { ethers, makeError } from "ethers";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import {
  isNonceConflictError,
  NonceConflictError,
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

  it("re-throws original error when broadcast fails with non-conflict error and no on-chain trace", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error("ECONNREFUSED");
    const { rpcManager } = makeMockRpcManager({
      broadcastTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitSignedTransactionWithFailover(signer, TEST_TX_REQUEST, rpcManager)
    ).rejects.toBe(originalError);
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
    ).rejects.toBe(populateError);
    expect(sign).not.toHaveBeenCalled();
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
