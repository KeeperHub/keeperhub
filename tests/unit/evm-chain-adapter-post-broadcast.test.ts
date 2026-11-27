import { ethers, makeError } from "ethers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/sleep", () => ({ sleep: () => Promise.resolve() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/db/schema", () => ({ explorerConfigs: {} }));
vi.mock("drizzle-orm", () => ({ eq: () => ({}) }));
vi.mock("@/lib/explorer", () => ({
  getAddressUrl: () => "",
  getTransactionUrl: () => "",
}));

import { EvmChainAdapter } from "@/lib/web3/chain-adapter/evm";
import {
  broadcastTransactionHash,
  isOnChainPendingError,
  isOnChainRevertError,
} from "@/lib/web3/onchain-revert";
import { broadcastAttemptedOf } from "@/lib/web3/pre-send";
import type { SendReport } from "@/lib/web3/submit-signed";

const FROM = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
const TO = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const TX_HASH = "0xf00d";
const REPLACEMENT_HASH = "0xbeef";
const SEPOLIA = 11_155_111;

function buildReceipt(hash: string, status = 1): Record<string, unknown> {
  return {
    hash,
    status,
    gasUsed: BigInt(210_000),
    gasPrice: BigInt(1_000_000_000),
    blockNumber: 500,
  };
}

// The exact shape ethers v6 throws from wait() when the pending transaction is
// replaced: `cancelled` is set mechanically from `reason` in provider.ts, `hash`
// is the ORIGINAL transaction and `receipt` belongs to the REPLACEMENT.
function replacedError(
  reason: "repriced" | "replaced" | "cancelled",
  status = 1
): Error {
  return Object.assign(new Error("transaction was replaced"), {
    code: "TRANSACTION_REPLACED",
    reason,
    cancelled: reason === "replaced" || reason === "cancelled",
    hash: TX_HASH,
    receipt: buildReceipt(REPLACEMENT_HASH, status),
  });
}

function createGasStrategy(): unknown {
  return {
    getGasConfig: vi.fn().mockResolvedValue({
      gasLimit: BigInt(100_000),
      maxFeePerGas: BigInt(1_000_000_000),
      maxPriorityFeePerGas: BigInt(1_000_000),
    }),
  };
}

type MockNonceManager = {
  getNextNonce: ReturnType<typeof vi.fn>;
  recordTransaction: ReturnType<typeof vi.fn>;
  confirmTransaction: ReturnType<typeof vi.fn>;
};

function createNonceManager(): MockNonceManager {
  return {
    getNextNonce: vi.fn().mockReturnValue(7),
    recordTransaction: vi.fn().mockResolvedValue(undefined),
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

type Harness = {
  adapter: EvmChainAdapter;
  signer: unknown;
  wait: ReturnType<typeof vi.fn>;
  nonceManager: MockNonceManager;
};

function createHarness(wait: ReturnType<typeof vi.fn>): Harness {
  const provider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(SEPOLIA) }),
    call: vi.fn().mockResolvedValue("0x"),
    estimateGas: vi.fn().mockResolvedValue(BigInt(210_000)),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    getBlockNumber: vi.fn().mockResolvedValue(500),
    getBlock: vi
      .fn()
      .mockResolvedValue({ number: 500, gasLimit: BigInt(30_000_000) }),
  };
  const txResponse = { hash: TX_HASH, provider, wait };
  const signer = {
    getAddress: vi.fn().mockResolvedValue(FROM),
    provider,
    sendTransaction: vi.fn().mockResolvedValue(txResponse),
  };
  const nonceManager = createNonceManager();
  const adapter = new EvmChainAdapter(
    SEPOLIA,
    createGasStrategy() as ConstructorParameters<typeof EvmChainAdapter>[1],
    nonceManager as unknown as ConstructorParameters<typeof EvmChainAdapter>[2]
  );
  return { adapter, signer, wait, nonceManager };
}

async function send(h: Harness): Promise<{ hash: string }> {
  return await h.adapter.sendTransaction(
    h.signer as unknown as Parameters<EvmChainAdapter["sendTransaction"]>[0],
    { to: TO, value: BigInt(1) },
    {} as Parameters<EvmChainAdapter["sendTransaction"]>[2],
    { gasOverrides: {} }
  );
}

async function sendAndCatch(h: Harness): Promise<unknown> {
  try {
    await send(h);
  } catch (error) {
    return error;
  }
  throw new Error("expected sendTransaction to throw");
}

// #2177: every one of these arrives as a THROW out of tx.wait(), never as a null
// receipt. Before the fix each of them lost the hash, and the row was stamped
// terminally failed with transaction_hash null — outside the reconciler scan.
describe("EvmChainAdapter post-broadcast failures (non-Tempo)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the receipt when wait() resolves normally", async () => {
    const h = createHarness(vi.fn().mockResolvedValue(buildReceipt(TX_HASH)));

    const result = await send(h);

    expect(result.hash).toBe(TX_HASH);
    expect(h.nonceManager.confirmTransaction).toHaveBeenCalledWith(TX_HASH);
  });

  it("treats a repriced replacement as our own result, under the new hash", async () => {
    // reason "repriced" means same work, same nonce, higher fee. The
    // replacement's receipt IS the outcome of our transaction, so this must not
    // fail at all — and the hash worth recording is the one that landed.
    const h = createHarness(
      vi.fn().mockRejectedValue(replacedError("repriced"))
    );

    const result = await send(h);

    expect(result.hash).toBe(REPLACEMENT_HASH);
    // The nonce session only ever knew the original hash: that is what
    // recordTransaction was given, and confirmTransaction has to match it or
    // the session is never closed. So the two hashes diverge here by design -
    // the returned receipt is the replacement's, the session's is ours.
    expect(h.nonceManager.confirmTransaction).toHaveBeenCalledWith(TX_HASH);
    expect(h.nonceManager.confirmTransaction).not.toHaveBeenCalledWith(
      REPLACEMENT_HASH
    );
  });

  it("reports a repriced replacement that reverted as a revert, not a success", async () => {
    const h = createHarness(
      vi.fn().mockRejectedValue(replacedError("repriced", 0))
    );

    const error = await sendAndCatch(h);

    expect(isOnChainRevertError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(REPLACEMENT_HASH);
  });

  it.each(["cancelled", "replaced"] as const)(
    "settles a %s transaction terminally instead of leaving it pending",
    async (reason) => {
      // The nonce is spent by something else: our transaction was not executed
      // and never will be. Conclusive, not unknown. Routing it to pending would
      // create a row the reconciler can never close.
      const h = createHarness(vi.fn().mockRejectedValue(replacedError(reason)));

      const error = await sendAndCatch(h);

      expect(isOnChainPendingError(error)).toBe(false);
      expect(isOnChainRevertError(error)).toBe(true);
      expect(broadcastTransactionHash(error)).toBe(TX_HASH);
      expect((error as Error).message).toContain(reason);
    }
  );

  it("records our own hash on the error, never the replacement's", async () => {
    // The replacement is a transaction we did not send and it landed with
    // status 1. Recording its hash would have the finalizer verify a stranger's
    // receipt as a success and the reconciler settle this execution
    // `completed` - a failed write reported as done.
    const h = createHarness(
      vi.fn().mockRejectedValue(replacedError("replaced"))
    );

    const error = await sendAndCatch(h);

    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
    expect(broadcastTransactionHash(error)).not.toBe(REPLACEMENT_HASH);
    // Still readable in the record: the message names what took the nonce.
    expect((error as Error).message).toContain(REPLACEMENT_HASH);
  });

  it("defaults a replacement error with no `cancelled` flag to pending", async () => {
    // An unrecognised shape is not conclusive. Same trade as an unrecognised
    // code: pending costs a row the reconciler resolves, terminal re-creates
    // #2020.
    const h = createHarness(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("transaction was replaced"), {
          code: "TRANSACTION_REPLACED",
          reason: "replaced",
          hash: TX_HASH,
          receipt: buildReceipt(REPLACEMENT_HASH),
        })
      )
    );

    const error = await sendAndCatch(h);

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  it("keeps a detected revert on the revert path with its hash", async () => {
    const h = createHarness(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
          receipt: buildReceipt(TX_HASH, 0),
        })
      )
    );

    const error = await sendAndCatch(h);

    expect(isOnChainRevertError(error)).toBe(true);
    expect(isOnChainPendingError(error)).toBe(false);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  /**
   * KEEP-1281: unbounded, tx.wait() waits for as long as the step is allowed
   * to live. A transaction that never mines pinned the step until the reaper
   * swept it, and the reaper records no hash -- so the broadcast never
   * entered the reconciler's scan at all.
   */
  it("bounds the receipt wait rather than waiting for as long as the step may live", async () => {
    const h = createHarness(vi.fn().mockResolvedValue(buildReceipt(TX_HASH)));

    await send(h);

    const [confirms, timeoutMs] = h.wait.mock.calls[0] as [number, number];
    expect(confirms).toBe(1);
    // Above one primary-then-fallback failover round (186s): a receipt read
    // riding out a degraded primary must not be cut short by its own
    // deadline, or a transaction that was going to mine is reported as a
    // failed run and every step after it is skipped.
    expect(timeoutMs).toBeGreaterThan(186_000);
    // Below the reaper's 30-minute default, so the pending row is recorded
    // while the step is still ours to finalize.
    expect(timeoutMs).toBeLessThan(30 * 60 * 1000);
  });

  it("carries the hash when the bounded wait expires", async () => {
    const h = createHarness(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("wait for transaction timeout"), {
          code: "TIMEOUT",
        })
      )
    );

    const error = await sendAndCatch(h);

    // The deadline says we stopped looking, never that the transaction failed.
    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  it("carries the hash when the provider fails mid-wait", async () => {
    const h = createHarness(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("could not coalesce error"), {
          code: "SERVER_ERROR",
        })
      )
    );

    const error = await sendAndCatch(h);

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  it("defaults an unrecognised error code to pending, not terminal", async () => {
    // Deliberate: a future ethers code treated as terminal re-creates #2020 for
    // that code, while treating it as pending costs only a row the reconciler
    // resolves. Cheap in one direction, expensive in the other.
    const h = createHarness(
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("something new"), { code: "FUTURE_CODE" })
        )
    );

    const error = await sendAndCatch(h);

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });
});

type TransactionOptionsArg = Parameters<EvmChainAdapter["sendTransaction"]>[3];

let SIGNED_HEX = "";
beforeAll(async () => {
  SIGNED_HEX = await new ethers.Wallet(`0x${"2".repeat(64)}`).signTransaction({
    to: TO,
    nonce: 7,
    gasLimit: BigInt(90_000),
    maxFeePerGas: BigInt(1_000_000_000),
    maxPriorityFeePerGas: BigInt(1_000_000),
    chainId: SEPOLIA,
    type: 2,
  });
});

describe("EvmChainAdapter send report and fixed gas limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function providerOf(h: Harness): {
    call: ReturnType<typeof vi.fn>;
    estimateGas: ReturnType<typeof vi.fn>;
    getBlock: ReturnType<typeof vi.fn>;
  } {
    return (h.signer as { provider: never }).provider;
  }

  async function sendWith(
    h: Harness,
    options: Parameters<EvmChainAdapter["sendTransaction"]>[3]
  ): Promise<unknown> {
    try {
      return await h.adapter.sendTransaction(
        h.signer as unknown as Parameters<
          EvmChainAdapter["sendTransaction"]
        >[0],
        { to: TO, value: BigInt(1) },
        {} as Parameters<EvmChainAdapter["sendTransaction"]>[2],
        options
      );
    } catch (error) {
      return error;
    }
  }

  // Production shape: the adapter sends through an rpcManager.
  function withManager(h: Harness): TransactionOptionsArg["rpcManager"] {
    const provider = (h.signer as { provider: Record<string, unknown> })
      .provider;
    // The node answers the raw send with the signed bytes' own hash.
    const send = provider.send as
      | ((method: string, params: unknown[]) => Promise<unknown>)
      | undefined;
    provider.send = (method: string, params: unknown[]) =>
      method === "eth_sendRawTransaction"
        ? Promise.resolve(ethers.Transaction.from(SIGNED_HEX).hash)
        : send?.(method, params);
    provider._wrapTransactionResponse = () => ({
      hash: TX_HASH,
      provider,
      wait: h.wait,
    });
    Object.assign(h.signer as object, {
      populateTransaction: (tx: unknown) => Promise.resolve(tx),
      signTransaction: () => Promise.resolve(SIGNED_HEX),
    });
    return {
      executeWithFailover: (op: (p: unknown) => unknown) => op(provider),
      getBroadcastRpcUrls: () => [],
      isPrivateRelayProvider: () => false,
      hasPrivateRelayPrimary: () => false,
      getProvider: () => provider,
    } as unknown as TransactionOptionsArg["rpcManager"];
  }

  it("skips eth_estimateGas with a fixed gas limit and runs eth_call under it", async () => {
    const h = createHarness(vi.fn().mockResolvedValue(buildReceipt(TX_HASH)));
    const sendReport: SendReport = {};

    const result = await sendWith(h, {
      gasOverrides: { gasLimitOverride: BigInt(90_000) },
      rpcManager: withManager(h),
      sendReport,
    });

    expect(result).toMatchObject({ hash: TX_HASH });
    expect(providerOf(h).call).toHaveBeenCalledWith(
      expect.objectContaining({ gasLimit: BigInt(90_000) })
    );
    expect(providerOf(h).estimateGas).not.toHaveBeenCalled();
    expect(sendReport).toEqual({ route: "public", included: true });
  });

  // A node error ethers reports on eth_call, with the node's own words.
  const nodeError = (message: string, data: string | null = null): Error =>
    makeError("missing revert data", "CALL_EXCEPTION", {
      action: "call",
      data,
      reason: null,
      transaction: { to: TO, data: "0x" },
      invocation: null,
      revert: null,
      info: { error: { code: -32_000, message } },
    });
  const outOfGas = (data: string | null = null): Error =>
    nodeError("out of gas", data);

  type CallTx = { gasLimit?: bigint; blockTag?: number };
  const TOO_LOW =
    "Gas Limit 20000 is too low for this call: the call fails under that limit and passes without one. Raise the Gas Limit or leave it empty.";

  it("names the Gas Limit when the call passes only without the cap", async () => {
    const h = createHarness(vi.fn());
    const capped = outOfGas();
    providerOf(h).call.mockImplementation((tx: CallTx) =>
      tx.gasLimit ? Promise.reject(capped) : Promise.resolve("0x")
    );

    const error = await sendWith(h, {
      gasOverrides: { gasLimitOverride: BigInt(20_000) },
      rpcManager: withManager(h),
    });

    expect(broadcastAttemptedOf(error, undefined, { kind: "unknown" })).toBe(
      false
    );
    expect((error as Error).message).toBe(TOO_LOW);
    expect((error as Error).cause).toBe(capped);
    // Capped, uncapped and capped again, all at one pinned block.
    expect(providerOf(h).call.mock.calls.map(([tx]) => tx.blockTag)).toEqual([
      500, 500, 500,
    ]);
  });

  it.each([
    // Decoded as everywhere else in the app (decodeRevertReason), and quoted.
    [
      "a decoded reason",
      outOfGas(
        ethers.concat([
          "0x08c379a0",
          ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["STF"]),
        ])
      ),
      ", reverting with Error(STF),",
    ],
    [
      "a decoded reason nested under .info.error",
      Object.assign(new Error("out of gas"), {
        code: "CALL_EXCEPTION",
        info: {
          error: {
            message: "out of gas",
            data: ethers.concat([
              "0x08c379a0",
              ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["STF"]),
            ]),
          },
        },
      }),
      ", reverting with Error(STF),",
    ],
    // Raw custom-error data with no ABI entry is not.
    ["undecodable data", outOfGas("0xdeadbeef"), ""],
    // Nor ethers' made-up "require(false)" for empty data.
    [
      "empty data",
      Object.assign(outOfGas("0x"), { reason: "require(false)" }),
      "",
    ],
  ])(
    "quotes the revert under the cap only when it is %s",
    async (_label, capped, quoted) => {
      const h = createHarness(vi.fn());
      providerOf(h).call.mockImplementation((tx: CallTx) =>
        tx.gasLimit ? Promise.reject(capped) : Promise.resolve("0x")
      );

      const error = await sendWith(h, {
        gasOverrides: { gasLimitOverride: BigInt(20_000) },
        rpcManager: withManager(h),
      });

      expect((error as Error).message).toBe(
        `Gas Limit 20000 is too low for this call: the call fails under that limit${quoted} and passes without one. Raise the Gas Limit or leave it empty.`
      );
    }
  );

  it.each([
    // Sepolia is an Ethereum L1 chain: 2^24 per transaction (EIP-7825).
    ["the 2^24 cap", BigInt(30_000_000), BigInt(20_000_000), "16777216"],
    ["the block gas limit", BigInt(10_000_000), BigInt(12_000_000), "10000000"],
  ])(
    "refuses a Gas Limit above %s before any call",
    async (_label, blockGasLimit, fixed, limit) => {
      const h = createHarness(vi.fn());
      providerOf(h).getBlock.mockResolvedValue({
        number: 500,
        gasLimit: blockGasLimit,
      });

      const error = await sendWith(h, {
        gasOverrides: { gasLimitOverride: fixed },
        rpcManager: withManager(h),
      });

      expect((error as Error).message).toBe(
        `Gas Limit ${fixed} is above the network's limit of ${limit}. Lower it or leave it empty.`
      );
      expect(broadcastAttemptedOf(error, undefined, { kind: "unknown" })).toBe(
        false
      );
      expect(providerOf(h).call).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["a rate limit", "your app's rate limit was reached"],
    ["an unknown answer", "transaction gas limit too high"],
  ])(
    "throws the node's own error for %s under the cap, not a Gas Limit verdict",
    async (_label, message) => {
      const h = createHarness(vi.fn());
      const refusal = nodeError(message);
      providerOf(h).call.mockImplementation((tx: CallTx) =>
        tx.gasLimit ? Promise.reject(refusal) : Promise.resolve("0x")
      );

      const error = await sendWith(h, {
        gasOverrides: { gasLimitOverride: BigInt(100_000) },
        rpcManager: withManager(h),
      });

      expect(error).toBe(refusal);
      expect(providerOf(h).call).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    "header not found",
    "block 0x1f4 not found",
    "requested block is beyond the current head",
  ])(
    "retries the pinned call at latest when the node says %s",
    async (message) => {
      const h = createHarness(vi.fn());
      const missingBlock = nodeError(message);
      providerOf(h).call.mockImplementation((tx: CallTx) => {
        if (tx.blockTag !== undefined && tx.gasLimit === undefined) {
          return Promise.reject(missingBlock);
        }
        return tx.gasLimit ? Promise.reject(outOfGas()) : Promise.resolve("0x");
      });

      const error = await sendWith(h, {
        gasOverrides: { gasLimitOverride: BigInt(20_000) },
        rpcManager: withManager(h),
      });

      // The uncapped call passed at latest, so the limit is still to blame.
      expect((error as Error).message).toBe(TOO_LOW);
    }
  );

  it("keeps a real revert's error when the call fails without the cap too", async () => {
    const h = createHarness(vi.fn());
    const revert = outOfGas("0x08c379a0");
    providerOf(h).call.mockRejectedValue(revert);

    const error = await sendWith(h, {
      gasOverrides: { gasLimitOverride: BigInt(20_000) },
      rpcManager: withManager(h),
    });

    expect(error).toBe(revert);
  });

  it("carries on after a one-off node error under the cap", async () => {
    const h = createHarness(vi.fn().mockResolvedValue(buildReceipt(TX_HASH)));
    providerOf(h)
      .call.mockRejectedValueOnce(outOfGas())
      .mockResolvedValue("0x");

    const result = await sendWith(h, {
      gasOverrides: { gasLimitOverride: BigInt(90_000) },
      rpcManager: withManager(h),
    });

    expect(result).toMatchObject({ hash: TX_HASH });
    expect(providerOf(h).call).toHaveBeenCalledTimes(3);
  });

  it("pins the text of a revert ethers detects while waiting", async () => {
    const reverted = { ...buildReceipt(TX_HASH, 0), gasUsed: BigInt(40_000) };
    const h = createHarness(
      vi.fn().mockRejectedValue(
        Object.assign(new Error("transaction execution reverted"), {
          code: "CALL_EXCEPTION",
          receipt: reverted,
        })
      )
    );

    const error = await sendWith(h, {
      gasOverrides: {},
      rpcManager: withManager(h),
    });

    expect((error as Error).message).toBe(
      `Transaction ${TX_HASH} reverted on-chain (execution reverted, status 0, block 500)`
    );
  });

  it("flags a likely out of gas when the revert used all its gas", async () => {
    // buildReceipt uses 210000 gas; the strategy gives the send 100000.
    const h = createHarness(
      vi.fn().mockResolvedValue(buildReceipt(TX_HASH, 0))
    );

    const error = await sendWith(h, {
      gasOverrides: {},
      rpcManager: withManager(h),
    });

    expect((error as Error).message).toBe(
      `Transaction ${TX_HASH} reverted on-chain (execution reverted, status 0, block 500); used all 100000 gas, likely out of gas`
    );
  });

  it("asks to raise the Gas Limit when that limit was the user's", async () => {
    const h = createHarness(
      vi.fn().mockResolvedValue(buildReceipt(TX_HASH, 0))
    );

    const error = await sendWith(h, {
      gasOverrides: { gasLimitOverride: BigInt(100_000) },
      rpcManager: withManager(h),
    });

    expect((error as Error).message).toMatch(
      /; used all 100000 gas, likely out of gas; raise the Gas Limit$/
    );
  });

  it("still estimates gas, with no cap on eth_call, without a fixed gas limit", async () => {
    const h = createHarness(vi.fn().mockResolvedValue(buildReceipt(TX_HASH)));

    await sendWith(h, { gasOverrides: {}, rpcManager: withManager(h) });

    expect(providerOf(h).call).toHaveBeenCalledWith(
      expect.not.objectContaining({ gasLimit: expect.anything() })
    );
    expect(providerOf(h).estimateGas).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a mined success", vi.fn().mockResolvedValue(buildReceipt(TX_HASH)), true],
    [
      "a status 0 receipt",
      vi.fn().mockResolvedValue(buildReceipt(TX_HASH, 0)),
      true,
    ],
    [
      "a detected revert",
      vi.fn().mockRejectedValue(
        Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
          receipt: buildReceipt(TX_HASH, 0),
        })
      ),
      true,
    ],
    [
      "a cancelled transaction",
      vi.fn().mockRejectedValue(replacedError("cancelled")),
      undefined,
    ],
    [
      "an expired wait",
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("timeout"), { code: "TIMEOUT" })
        ),
      undefined,
    ],
  ])("marks included for %s: %s", async (_label, wait, included) => {
    const h = createHarness(wait);
    const sendReport: { included?: boolean } = {};

    await sendWith(h, { gasOverrides: {}, sendReport });

    expect(sendReport.included).toBe(included);
  });
});
