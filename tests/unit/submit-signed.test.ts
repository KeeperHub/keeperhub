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
  logWarn: vi.fn(),
}));

import { type RpcOperationType, RpcProviderManager } from "@/lib/rpc/providers";
import { isDuplicateMessage } from "@/lib/web3/json-rpc-answer";
import { broadcastTransactionHash } from "@/lib/web3/onchain-revert";
import {
  isNonceConflictError,
  isPreBroadcastNetworkError,
  NonceConflictError,
  PreBroadcastNetworkError,
  type SendReport,
  sendReportFields,
  submitRawSignedWithFailover,
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
  /** eth_sendRawTransaction: resolves the hash the node answers with. */
  sendRawTransaction?: ReturnType<typeof vi.fn>;
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

// A public RPC with no extra broadcast URLs, as most chains are configured.
const NO_EXTRA_ROUTING = {
  getBroadcastRpcUrls: () => [],
  isPrivateRelayProvider: () => false,
  hasPrivateRelayPrimary: () => false,
};

// The provider calls the send makes: the raw send, then the response wrap.
function asProvider(scenario: ScenarioProvider): ethers.JsonRpcProvider {
  return {
    ...scenario,
    send: (method: string, params: unknown[]) =>
      method === "eth_sendRawTransaction"
        ? (scenario.sendRawTransaction as (hex: unknown) => unknown)(params[0])
        : Promise.reject(new Error(`unexpected ${method}`)),
    _wrapTransactionResponse: (tx: { hash: string }) =>
      makeMockTxResponse(tx.hash),
  } as unknown as ethers.JsonRpcProvider;
}

function makeMockRpcManager(scenario: ScenarioProvider) {
  const provider = asProvider(scenario);
  const executeWithFailover = vi
    .fn()
    .mockImplementation(
      async (
        op: (p: ethers.JsonRpcProvider) => Promise<unknown>,
        _opType: RpcOperationType
      ) => await op(provider)
    );
  return {
    rpcManager: {
      executeWithFailover,
      ...NO_EXTRA_ROUTING,
    } as unknown as RpcProviderManager,
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
    const sendRawTransaction = vi.fn().mockResolvedValue(EXPECTED_HASH);
    const { rpcManager, executeWithFailover } = makeMockRpcManager({
      sendRawTransaction,
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
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledWith(SIGNED_HEX);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "write-broadcast"
    );
  });

  it("signs exactly once even when failover invokes the closure twice", async () => {
    const { signer, sign } = makeMockSigner();
    const sendRawTransaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("primary down"))
      .mockResolvedValueOnce(EXPECTED_HASH);
    const executeWithFailover = vi
      .fn()
      .mockImplementation(
        async (op: (p: ethers.JsonRpcProvider) => Promise<unknown>) => {
          const provider = asProvider({ sendRawTransaction });
          try {
            return await op(provider);
          } catch {
            return await op(provider);
          }
        }
      );
    const rpcManager = {
      executeWithFailover,
      ...NO_EXTRA_ROUTING,
    } as unknown as RpcProviderManager;

    const result = await submitSignedTransactionWithFailover(
      signer,
      TEST_TX_REQUEST,
      rpcManager
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(sendRawTransaction).toHaveBeenNthCalledWith(1, SIGNED_HEX);
    expect(sendRawTransaction).toHaveBeenNthCalledWith(2, SIGNED_HEX);
  });

  it("returns preExistingReceipt when broadcast fails but tx already mined", async () => {
    const { signer } = makeMockSigner();
    const receipt = makeMockReceipt(EXPECTED_HASH);
    const minedResponse = makeMockTxResponse(EXPECTED_HASH);
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(
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
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("already known")),
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
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
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

  // geth/erigon/reth, Nethermind, anvil/Parity, Besu: each names our own hash.
  it.each([
    "already known",
    "AlreadyKnown",
    "transaction already imported",
    "Known transaction",
  ])(
    "keeps the hash as pending on a duplicate-hash reply (%s), never a nonce conflict",
    async (message) => {
      const { signer } = makeMockSigner();
      const { rpcManager } = makeMockRpcManager({
        sendRawTransaction: vi.fn().mockRejectedValue(new Error(message)),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
        getTransaction: vi.fn().mockResolvedValue(null),
      });
      const report: SendReport = {};

      const error = await submitSignedTransactionWithFailover(
        signer,
        TEST_TX_REQUEST,
        rpcManager,
        report
      ).catch((caught: unknown) => caught);

      expect(error).not.toBeInstanceOf(NonceConflictError);
      expect(broadcastTransactionHash(error)).toBe(EXPECTED_HASH);
      expect(sendReportFields(report)).toEqual({
        route: "public",
        included: false,
      });
    }
  );

  it("tags a lone connection refusal as PreBroadcastNetworkError, preserving the cause", async () => {
    const { signer } = makeMockSigner();
    const originalError = new Error("ECONNREFUSED");
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
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
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
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
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
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
      sendRawTransaction: vi
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
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
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
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("timeout")),
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

// The send half alone: already-signed bytes, no signer.
describe("submitRawSignedWithFailover", () => {
  it("sends the given bytes once and returns their hash when the node accepts them", async () => {
    const sendRawTransaction = vi.fn().mockResolvedValue(EXPECTED_HASH);
    const { rpcManager, executeWithFailover } = makeMockRpcManager({
      sendRawTransaction,
    });
    const report: SendReport = {};

    const result = await submitRawSignedWithFailover(
      SIGNED_HEX,
      rpcManager,
      report
    );

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(result.response.hash).toBe(EXPECTED_HASH);
    expect(result.preExistingReceipt).toBeUndefined();
    expect(result.broadcast?.broadcastAt).toEqual(expect.any(String));
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledWith(SIGNED_HEX);
    expect(executeWithFailover).toHaveBeenCalledWith(
      expect.any(Function),
      "write-broadcast"
    );
    expect(sendReportFields(report)).toEqual({
      route: "public",
      included: false,
    });
  });

  it("returns the pooled copy on an already known reply the node can show", async () => {
    const pendingResponse = makeMockTxResponse(EXPECTED_HASH);
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("already known")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(pendingResponse),
    });

    const result = await submitRawSignedWithFailover(SIGNED_HEX, rpcManager);

    expect(result.hash).toBe(EXPECTED_HASH);
    expect(result.response).toBe(pendingResponse);
  });

  it("keeps the hash as pending on an already known reply the node cannot show", async () => {
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(new Error("already known")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    const error = await submitRawSignedWithFailover(
      SIGNED_HEX,
      rpcManager
    ).catch((caught: unknown) => caught);

    expect(error).not.toBeInstanceOf(NonceConflictError);
    expect(broadcastTransactionHash(error)).toBe(EXPECTED_HASH);
  });

  it("throws PreBroadcastNetworkError when every endpoint refused the connection", async () => {
    const originalError = new Error(
      "RPC failed on both endpoints. Primary: connection refused. Fallback: ECONNREFUSED"
    );
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(originalError),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    const thrown = await submitRawSignedWithFailover(
      SIGNED_HEX,
      rpcManager
    ).catch((caught: unknown) => caught);

    expect(isPreBroadcastNetworkError(thrown)).toBe(true);
    expect((thrown as PreBroadcastNetworkError).cause).toBe(originalError);
    expect(broadcastTransactionHash(thrown)).toBeUndefined();
  });

  it("keeps the hash as pending when the send may have reached the node", async () => {
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi
        .fn()
        .mockRejectedValue(new Error("request timed out")),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });
    const report: SendReport = {};

    await expect(
      submitRawSignedWithFailover(SIGNED_HEX, rpcManager, report)
    ).rejects.toMatchObject({
      name: "OnChainPendingError",
      kind: "onchain-pending",
      transactionHash: EXPECTED_HASH,
    });
    expect(sendReportFields(report)).toEqual({
      route: "public",
      included: false,
    });
  });

  it("reads the nonce of a conflict from the signed bytes", async () => {
    const { rpcManager } = makeMockRpcManager({
      sendRawTransaction: vi.fn().mockRejectedValue(
        makeError("replacement fee too low", "REPLACEMENT_UNDERPRICED", {
          transaction: { from: "0x", to: "0x" },
        })
      ),
      getTransactionReceipt: vi.fn().mockResolvedValue(null),
      getTransaction: vi.fn().mockResolvedValue(null),
    });

    await expect(
      submitRawSignedWithFailover(SIGNED_HEX, rpcManager)
    ).rejects.toMatchObject({
      name: "NonceConflictError",
      expectedHash: EXPECTED_HASH,
      nonce: TEST_TX_REQUEST.nonce,
    });
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

  it.each([
    ["already known", true],
    ["AlreadyKnown", true],
    ["Known transaction: 0xabc", true],
    ["unknown transaction type", false],
    ["rlp: unknown transaction type", false],
  ])("reads %s as a duplicate-hash reply: %s", (msg, duplicate) => {
    expect(isDuplicateMessage(msg)).toBe(duplicate);
  });

  it("handles non-Error values without throwing", () => {
    expect(isNonceConflictError("nonce too low")).toBe(true);
    expect(isNonceConflictError(null)).toBe(false);
    expect(isNonceConflictError(undefined)).toBe(false);
    expect(isNonceConflictError({ message: "nonce too low" })).toBe(false);
  });

  it.each([
    "already known",
    "AlreadyKnown",
    "already imported",
    "known transaction",
  ])("does not read a duplicate-hash reply as a nonce conflict: %s", (msg) => {
    expect(isNonceConflictError(new Error(msg))).toBe(false);
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
