import { beforeEach, describe, expect, it, vi } from "vitest";

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
