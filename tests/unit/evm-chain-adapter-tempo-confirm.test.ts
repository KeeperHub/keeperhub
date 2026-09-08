import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// The receipt poll's only pause is lib/sleep, so counting what it sleeps and
// reading Date.now() off that counter walks the 60s deadline in a few real
// milliseconds.
const clock = vi.hoisted(() => ({ elapsedMs: 0 }));
vi.mock("@/lib/sleep", () => ({
  sleep: (ms: number) => {
    clock.elapsedMs += ms;
    return Promise.resolve();
  },
}));
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
} from "@/lib/web3/onchain-revert";

const FROM = "0x2c9F694183A4240B6431771F6c714a8106179dF5";
const TO = "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59";
const TX_HASH = "0xf00d";
const TEMPO_TESTNET = 42_431;
const SEPOLIA = 11_155_111;

function buildReceipt(): Record<string, unknown> {
  return {
    hash: TX_HASH,
    status: 1,
    gasUsed: BigInt(210_000),
    gasPrice: BigInt(1_000_000_000),
    blockNumber: 500,
  };
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

function createNonceManager(): unknown {
  return {
    getNextNonce: vi.fn().mockReturnValue(7),
    recordTransaction: vi.fn().mockResolvedValue(undefined),
    confirmTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

// An ethers TransactionResponse.wait() that throws the exact ethers v6 error a
// Tempo 0x76 tx triggers when wait() parses a full transaction or block.
function badDataWait(): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(
    Object.assign(new Error("invalid BigNumberish value (value=null)"), {
      code: "BAD_DATA",
    })
  );
}

type Harness = {
  adapter: EvmChainAdapter;
  signer: unknown;
  wait: ReturnType<typeof vi.fn>;
  getTransactionReceipt: ReturnType<typeof vi.fn>;
};

function createHarness(
  chainId: number,
  wait: ReturnType<typeof vi.fn>
): Harness {
  const getTransactionReceipt = vi.fn().mockResolvedValue(buildReceipt());
  const provider = {
    getNetwork: vi.fn().mockResolvedValue({ chainId: BigInt(chainId) }),
    call: vi.fn().mockResolvedValue("0x"),
    estimateGas: vi.fn().mockResolvedValue(BigInt(210_000)),
    getTransactionReceipt,
  };
  const txResponse = { hash: TX_HASH, provider, wait };
  const signer = {
    getAddress: vi.fn().mockResolvedValue(FROM),
    provider,
    sendTransaction: vi.fn().mockResolvedValue(txResponse),
  };
  const adapter = new EvmChainAdapter(
    chainId,
    createGasStrategy() as ConstructorParameters<typeof EvmChainAdapter>[1],
    createNonceManager() as ConstructorParameters<typeof EvmChainAdapter>[2]
  );
  return { adapter, signer, wait, getTransactionReceipt };
}

async function send(h: Harness): Promise<{ hash: string }> {
  return await h.adapter.sendTransaction(
    h.signer as unknown as Parameters<EvmChainAdapter["sendTransaction"]>[0],
    { to: TO, value: BigInt(1) },
    {} as Parameters<EvmChainAdapter["sendTransaction"]>[2],
    { gasOverrides: {} }
  );
}

describe("EvmChainAdapter Tempo confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("confirms a Tempo tx via receipt poll even when tx.wait() throws BAD_DATA", async () => {
    const h = createHarness(TEMPO_TESTNET, badDataWait());

    const result = await send(h);

    expect(result.hash).toBe(TX_HASH);
    expect(h.getTransactionReceipt).toHaveBeenCalledWith(TX_HASH);
    // The bug: relying on tx.wait() reports a mined Tempo tx as failed.
    expect(h.wait).not.toHaveBeenCalled();
  });

  it("still uses tx.wait() on a chain other than Tempo", async () => {
    const wait = vi.fn().mockResolvedValue(buildReceipt());
    const h = createHarness(SEPOLIA, wait);

    const result = await send(h);

    expect(result.hash).toBe(TX_HASH);
    expect(h.wait).toHaveBeenCalledTimes(1);
    expect(h.getTransactionReceipt).not.toHaveBeenCalled();
  });
});

describe("EvmChainAdapter unreadable receipt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the hash on the error when the receipt cannot be read", async () => {
    // wait() resolving null is the shape of "broadcast, outcome unknown": the
    // transaction is on the network, we just cannot see it yet.
    const h = createHarness(SEPOLIA, vi.fn().mockResolvedValue(null));

    const error = await send(h).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect(isOnChainPendingError(error)).toBe(true);
    // The regression this guards: a bare Error dropped the hash, so the
    // finalizer recorded a terminal failure for a transaction that exists
    // on-chain and nowhere in our data, and the reconciler -- which scans for
    // unconfirmed rows WITH a hash -- never revisited it.
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  it("leaves the message untouched for callers that only read it", async () => {
    const h = createHarness(SEPOLIA, vi.fn().mockResolvedValue(null));

    await expect(send(h)).rejects.toThrow(
      "Transaction sent but receipt not available"
    );
  });

  it("does not mistake a pre-broadcast failure for a broadcast one", async () => {
    // Nothing reached the chain, so no hash may be attached: recording one
    // would invent a transaction that does not exist.
    const h = createHarness(SEPOLIA, vi.fn());
    (
      h.signer as { sendTransaction: ReturnType<typeof vi.fn> }
    ).sendTransaction = vi
      .fn()
      .mockRejectedValue(new Error("insufficient funds"));

    const error = await send(h).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect(isOnChainPendingError(error)).toBe(false);
    expect(broadcastTransactionHash(error)).toBeUndefined();
  });
});

describe("EvmChainAdapter Tempo receipt-poll timeout", () => {
  let nowSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clock.elapsedMs = 0;
    const base = Date.now();
    nowSpy = vi
      .spyOn(Date, "now")
      .mockImplementation(() => base + clock.elapsedMs);
  });

  afterEach(() => {
    nowSpy?.mockRestore();
  });

  // Tempo is the one chain that polls precisely because wait() misbehaves
  // there, so it is the one chain whose broadcast-but-unread case never
  // reached the empty-receipt branch above. It needs its own carrier.
  it("keeps the hash on the error when the poll lapses before the chain answers", async () => {
    const h = createHarness(TEMPO_TESTNET, badDataWait());
    h.getTransactionReceipt.mockResolvedValue(null);

    const error = await send(h).then(
      () => undefined,
      (thrown: unknown) => thrown
    );

    expect(isOnChainPendingError(error)).toBe(true);
    expect(broadcastTransactionHash(error)).toBe(TX_HASH);
  });

  it("leaves the timeout message untouched for callers that only read it", async () => {
    const h = createHarness(TEMPO_TESTNET, badDataWait());
    h.getTransactionReceipt.mockResolvedValue(null);

    await expect(send(h)).rejects.toThrow(
      `Timed out waiting for Tempo transaction receipt (${TX_HASH})`
    );
  });
});
