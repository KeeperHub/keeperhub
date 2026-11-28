/**
 * Bundle and public, and Bundle with "Send publicly if still needed": the
 * public gate, the send check and record before the raw send, the raw send's
 * errors mapped once, the watch past the targets, the paid revert and every
 * condition of the fallback.
 */
import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    DATABASE: "database",
    WORKFLOW_ENGINE: "workflow_engine",
    EXTERNAL_SERVICE: "external_service",
  },
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logUserError: vi.fn(),
  logSystemError: vi.fn(),
  logSystemWarn: vi.fn(),
}));
vi.mock("@/keeperhub-executor/lib/broadcast-marker", () => ({
  markBroadcast: () => {
    h.events.push("marked");
  },
}));
vi.mock("@/lib/execute/native-balance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/execute/native-balance")>()),
  getNativeSymbol: async () => "ETH",
}));

const h = vi.hoisted(() => ({
  events: [] as string[],
  // The send check after the record (the public gate's and the fallback's): a pass, or an error.
  check: undefined as Error | undefined,
  checkGasLimits: [] as unknown[],
  sendBundle: vi.fn(),
  markPublicCopy: vi.fn(),
  markPublicCopyRefused: vi.fn(),
  markNonceDropped: vi.fn(),
  pendingPublicCopyHash: vi.fn(),
  rawSend: vi.fn(),
  getGasConfig: vi.fn(),
  // The blockTag of every eth_call.
  callTags: [] as unknown[],
  // Heads not yet read when the copy was marked.
  headsLeftAtMark: [] as number[],
}));

vi.mock("@/lib/web3/next-block-simulation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/next-block-simulation")>();
  return {
    ...actual,
    simulateSendAtNextBlock: async (
      _manager: unknown,
      request: { gasLimit?: bigint; options: { targetBlock?: number } }
    ) => {
      const block = request.options.targetBlock ?? 0;
      if (h.events.includes("record")) {
        h.events.push(`check:${block}`);
        h.checkGasLimits.push(request.gasLimit);
        if (h.check) {
          throw h.check;
        }
      }
      return { gasEstimate: BigInt(50_000), simulation: {} };
    },
  };
});
vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({
    getGasConfig: h.getGasConfig,
    priorityFeeLimit: async () => ethers.parseUnits("500", "gwei"),
  }),
}));
vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: (session: { currentNonce: number }) => {
      const nonce = session.currentNonce;
      session.currentNonce += 1;
      return nonce;
    },
    recordBundle: async (_session: unknown, _nonce: number, bundle: never) => {
      h.events.push("record");
      return (bundle as { hashes: string[] }).hashes;
    },
    confirmNonce: async () => {
      h.events.push("confirm");
    },
    markNonceDropped: async (...args: unknown[]) => {
      h.events.push(`dropped:${String(args[2])}`);
      await h.markNonceDropped(...args);
    },
    // Pushed once the record is written: the send must wait for it.
    markPublicCopy: async (...args: unknown[]) => {
      h.headsLeftAtMark.push(chain.heads?.length ?? 0);
      const marked = await h.markPublicCopy(...args);
      h.events.push("mark-public");
      return marked;
    },
    markPublicCopyRefused: async (...args: unknown[]) => {
      h.events.push("public-refused");
      await h.markPublicCopyRefused(...args);
    },
    pendingPublicCopyHash: (...args: unknown[]) =>
      h.pendingPublicCopyHash(...args),
  }),
}));
vi.mock("@/lib/web3/bundles/client", () => ({
  sendBundle: async (options: { targetBlock: number }) => {
    h.events.push(`send:${options.targetBlock}`);
    chain.sent = true;
    return await h.sendBundle(options);
  },
}));
vi.mock("@/lib/web3/submit-signed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/web3/submit-signed")>()),
  submitRawSignedWithFailover: async (signedHex: string) => {
    h.events.push("raw-send");
    return await h.rawSend(signedHex);
  },
}));

import {
  adaptPublicSendError,
  publicGateOpen,
} from "@/lib/web3/bundles/public-copy";
import {
  type BundleSendOutcome,
  sendBundleInSession,
} from "@/lib/web3/bundles/send-bundle";
import { OnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  NonceConflictError,
  PreBroadcastNetworkError,
} from "@/lib/web3/submit-signed";

type BundleSendInput = Parameters<typeof sendBundleInSession>[0];

const gwei = (value: string): bigint => ethers.parseUnits(value, "gwei");
const wallet = new ethers.Wallet(`0x${"11".repeat(32)}`);
const LATEST = 1000;
const NONCE = 42;
const LATEST_TIME = 1_800_000_000;
const blockTime = (number: number): number =>
  LATEST_TIME + 12 * (number - LATEST);
const OTHER_HASH = `0x${"ee".repeat(32)}`;

type Chain = {
  block: number;
  sent: boolean;
  minedCount: number;
  receipts: Map<string, { status: number; blockNumber: number }>;
  // The call reverts (eth_call at any block).
  callReverts: boolean;
  // The next head reads (getBlock latest) before `block`: a number, or one with its own time.
  heads?: (number | { number: number; timestamp: number })[];
  // The base fee once the bundle went out; 10 gwei before.
  baseFeeAfterSend?: bigint;
  // A raw send mines its bytes this many blocks later, with this status.
  minePublic?: { after: number; status: number };
  // Scheduled: the hash to mine, and the block.
  publicMine?: { hash: string; at: number; status: number };
  relay: boolean;
  // The step's endpoints are the user's own RPC preference.
  userRpc?: boolean;
  txs: Map<number, { from: string; nonce: number; hash: string }[]>;
};

let chain: Chain;
let signed: string[];

function stubProvider() {
  return {
    getBlock: async (tag?: unknown, prefetch?: boolean) => {
      if (prefetch) {
        return {
          number: tag,
          prefetchedTransactions: chain.txs.get(tag as number) ?? [],
        };
      }
      const next = chain.heads?.shift() ?? chain.block;
      const number = typeof next === "number" ? next : next.number;
      return {
        number,
        timestamp: typeof next === "number" ? blockTime(next) : next.timestamp,
        parentHash: `0xparent${number - 1}`,
        baseFeePerGas:
          chain.sent && chain.baseFeeAfterSend
            ? chain.baseFeeAfterSend
            : gwei("10"),
        gasUsed: BigInt(15_000_000),
        gasLimit: BigInt(30_000_000),
      };
    },
    getBlockNumber: async () => {
      if (chain.sent) {
        chain.block += 1;
      }
      const mine = chain.publicMine;
      if (mine && chain.block >= mine.at) {
        chain.receipts.set(mine.hash, {
          status: mine.status,
          blockNumber: mine.at,
        });
        chain.minedCount = NONCE + 1;
        chain.publicMine = undefined;
      }
      return chain.block;
    },
    getTransactionCount: async () => chain.minedCount,
    getBalance: async () => ethers.parseEther("10"),
    getTransactionReceipt: async (hash: string) => {
      const receipt = chain.receipts.get(hash);
      return receipt
        ? { ...receipt, gasUsed: BigInt(40_000), gasPrice: gwei("11") }
        : null;
    },
    call: async (request: { blockTag?: unknown }) => {
      h.callTags.push(request.blockTag);
      if (chain.callReverts) {
        throw Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        });
      }
      return "0x";
    },
  };
}

function manager() {
  const provider = stubProvider();
  return {
    executeWithFailover: <T>(operation: (p: typeof provider) => Promise<T>) =>
      operation(provider),
    getFallbackProvider: () => null,
    hasPrivateRelayPrimary: () => chain.relay,
    usesUserRpc: () => chain.userRpc === true,
  };
}

const signer = {
  provider: {},
  populateTransaction: async (tx: ethers.TransactionRequest) => tx,
  signTransaction: async (tx: ethers.TransactionRequest) => {
    const raw = await wallet.signTransaction(tx);
    signed.push(raw);
    return raw;
  },
};

function input(overrides: Partial<BundleSendInput> = {}): BundleSendInput {
  return {
    session: {
      walletAddress: wallet.address,
      chainId: 1,
      executionId: "exec-1",
      currentNonce: NONCE,
      startedAt: new Date(),
    },
    signer: signer as unknown as ethers.Signer,
    rpcManager: manager() as unknown as BundleSendInput["rpcManager"],
    chainId: 1,
    call: { from: wallet.address, to: `0x${"cc".repeat(20)}`, data: "0x1234" },
    gas: {},
    blocks: 3,
    tipIncreasePercent: 20,
    builders: [{ name: "alpha", url: "https://alpha.example" }],
    unknownBuilders: [],
    searcher: wallet,
    workflowId: "wf-1",
    node: { id: "write-1", name: "Write" },
    progress: { sent: false },
    timing: { pollMs: 1, windowMs: 2000, slotMs: 100 },
    ...overrides,
  };
}

const bundleAndPublic = (overrides: Partial<BundleSendInput> = {}) =>
  input({ sendMode: "bundle-and-public", ...overrides });
const withFallback = (overrides: Partial<BundleSendInput> = {}) =>
  input({ sendMode: "bundle", fallback: "public", ...overrides });

const accept = () => [{ builder: "alpha", delivery: "accepted" }];
const refuse = () => [{ builder: "alpha", delivery: "refused", error: "nope" }];

const hashOf = (raw: string): string => ethers.keccak256(raw);

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.check = undefined;
  h.checkGasLimits = [];
  h.callTags = [];
  h.headsLeftAtMark = [];
  h.sendBundle.mockImplementation(accept);
  h.markPublicCopy.mockResolvedValue(true);
  h.pendingPublicCopyHash.mockResolvedValue(undefined);
  h.rawSend.mockImplementation(async (raw: string) => {
    if (chain.minePublic) {
      chain.publicMine = {
        hash: hashOf(raw),
        at: chain.block + chain.minePublic.after,
        status: chain.minePublic.status,
      };
    }
    return { hash: hashOf(raw) };
  });
  h.getGasConfig.mockResolvedValue({
    gasLimit: BigInt(60_000),
    maxFeePerGas: gwei("30"),
    maxPriorityFeePerGas: gwei("1"),
  });
  chain = {
    block: LATEST,
    sent: false,
    minedCount: NONCE,
    receipts: new Map(),
    callReverts: false,
    relay: false,
    txs: new Map(),
  };
  signed = [];
});

function expectKind<K extends BundleSendOutcome["kind"]>(
  outcome: BundleSendOutcome,
  kind: K
): Extract<BundleSendOutcome, { kind: K }> {
  expect(outcome.kind).toBe(kind);
  return outcome as Extract<BundleSendOutcome, { kind: K }>;
}

describe("publicGateOpen", () => {
  const T1 = 1001;

  it("opens at the block before the first target, never earlier, without Not before", () => {
    expect(
      publicGateOpen({ number: T1 - 2, timestamp: 0 }, { firstTarget: T1 })
    ).toBe(false);
    expect(
      publicGateOpen({ number: T1 - 1, timestamp: 0 }, { firstTarget: T1 })
    ).toBe(true);
    expect(
      publicGateOpen({ number: T1 + 3, timestamp: 0 }, { firstTarget: T1 })
    ).toBe(true);
  });

  it("with Not before, also needs the next slot not to be before it", () => {
    const notBefore = blockTime(T1);
    const gate = { firstTarget: T1, notBefore, gapSeconds: 12 };
    expect(
      publicGateOpen({ number: T1 - 1, timestamp: blockTime(T1 - 1) }, gate)
    ).toBe(true);
    // At the right number, but its time leaves the next slot before Not before.
    expect(
      publicGateOpen({ number: T1 - 1, timestamp: blockTime(T1 - 1) - 1 }, gate)
    ).toBe(false);
    // No gap known: never open on Not before.
    expect(
      publicGateOpen(
        { number: T1 - 1, timestamp: blockTime(T1 - 1) },
        { firstTarget: T1, notBefore }
      )
    ).toBe(false);
  });

  it("after a missed slot opens by time, the number gate still holding", () => {
    const notBefore = blockTime(T1);
    const gate = { firstTarget: T1, notBefore, gapSeconds: 12 };
    // A slot missed before T1 - 2: its time is already past Not before, its number is not.
    expect(
      publicGateOpen({ number: T1 - 2, timestamp: blockTime(T1 - 1) }, gate)
    ).toBe(false);
    expect(
      publicGateOpen({ number: T1 - 1, timestamp: blockTime(T1) }, gate)
    ).toBe(true);
  });

  it("is never early by time: a reorg sibling of the head at T1 - 1 is a slot later", () => {
    const notBefore = blockTime(T1);
    const head = { number: T1 - 1, timestamp: blockTime(T1 - 1) };
    expect(
      publicGateOpen(head, { firstTarget: T1, notBefore, gapSeconds: 12 })
    ).toBe(true);
    // A proposer-boost sibling builds on the head's parent in the next slot:
    // block number T1 - 1 (early by number), time head + 12 (not early by time).
    const sibling = { number: T1 - 1, timestamp: head.timestamp + 12 };
    expect(sibling.number).toBeLessThan(T1);
    expect(sibling.timestamp).toBeGreaterThanOrEqual(notBefore);
  });
});

describe("Bundle and public", () => {
  it("sends the first target's signed bytes publicly, recorded before the send, after the bundles", async () => {
    chain.minePublic = { after: 1, status: 1 };
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "included"
    );
    expect(h.rawSend).toHaveBeenCalledWith(signed[0]);
    expect(outcome.mined.hash).toBe(hashOf(signed[0]));
    const marked = h.events.indexOf("mark-public");
    expect(marked).toBeGreaterThan(h.events.indexOf("send:1003"));
    expect(marked).toBeLessThan(h.events.indexOf("raw-send"));
    expect(h.markPublicCopy).toHaveBeenCalledWith(expect.anything(), NONCE, {
      hash: hashOf(signed[0]),
      kind: "with-bundle",
      via: "platform",
    });
    // The send check ran for the block after the head, with the signed gas limit.
    expect(h.events).toContain(`check:${LATEST + 1}`);
    expect(h.checkGasLimits).toEqual([BigInt(60_000)]);
    expect(outcome.report.publicCopy).toEqual({
      hash: hashOf(signed[0]),
      sentAtBlock: LATEST,
      accepted: true,
    });
    expect(outcome.paidRevert).toBeUndefined();
    expect(outcome.report.fallbackSent).toBeUndefined();
  });

  it("waits for the gate: no record or send before the head reaches the first target - 1", async () => {
    // Not before puts T1 two blocks out; the head reads 1000, 1000, then 1002.
    const notBefore = blockTime(LATEST + 3);
    chain.heads = [LATEST, LATEST, LATEST, LATEST, LATEST + 2];
    chain.minePublic = { after: 1, status: 1 };
    await sendBundleInSession(
      bundleAndPublic({ sendAhead: { notBefore, blocks: 2 } })
    );
    expect(h.rawSend).toHaveBeenCalledTimes(1);
    expect(h.events.filter((e) => e === "mark-public")).toHaveLength(1);
    expect(h.events).toContain(`check:${LATEST + 3}`);
  });

  it("is not sent when the gate stays shut to a slot before the window's end: bundle rules apply", async () => {
    const notBefore = blockTime(LATEST + 3);
    chain.heads = Array.from({ length: 10_000 }, () => LATEST);
    h.sendBundle.mockImplementation(refuse);
    const outcome = expectKind(
      await sendBundleInSession(
        bundleAndPublic({
          sendAhead: { notBefore, blocks: 2 },
          timing: { pollMs: 1, windowMs: 300, slotMs: 100 },
        })
      ),
      "no-builder-accepted"
    );
    expect(h.events).not.toContain("mark-public");
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(outcome.report.publicCopy).toEqual({
      hash: hashOf(signed[0]),
      accepted: false,
      error: "first allowed block not reached in the window",
    });
    expect(h.events).toContain("dropped:no-builder-accepted");
  });

  it("skips the copy when the call now reverts at the next block; the bundles still cover the step", async () => {
    h.check = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
    });
    const outcome = await sendBundleInSession(bundleAndPublic());
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events).not.toContain("mark-public");
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "no longer needed",
    });
    // The bundle watch decided the miss as plain Bundle does.
    expect(expectKind(outcome, "not-included").reason).toBe("not-picked");
  });

  it("still sends when the check cannot be read", async () => {
    h.check = new Error("request timeout");
    chain.minePublic = { after: 1, status: 1 };
    expectKind(await sendBundleInSession(bundleAndPublic()), "included");
    expect(h.rawSend).toHaveBeenCalledTimes(1);
  });

  it("never sends through a private relay", async () => {
    chain.relay = true;
    const outcome = await sendBundleInSession(bundleAndPublic());
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(outcome.report.publicCopy).toMatchObject({ accepted: false });
  });

  it("sends nothing when the copy cannot be recorded", async () => {
    h.markPublicCopy.mockResolvedValue(false);
    const outcome = await sendBundleInSession(bundleAndPublic());
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(outcome.report.publicCopy).toMatchObject({ accepted: false });
  });

  it("goes out with no builder accepting, and its result decides the step", async () => {
    h.sendBundle.mockImplementation(refuse);
    chain.minePublic = { after: 1, status: 1 };
    expectKind(await sendBundleInSession(bundleAndPublic()), "included");
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("no public RPC reached (every connection refused): marked refused, plain bundle rules", async () => {
    h.rawSend.mockRejectedValue(
      new PreBroadcastNetworkError("connect ECONNREFUSED", new Error("x"))
    );
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "not-included"
    );
    expect(h.events).toContain("public-refused");
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "no public RPC could be reached or every RPC rejected it",
    });
    expect(outcome.reason).toBe("not-picked");
    expect(h.events).toContain("dropped:not-picked");
  });

  it("refused, with no builder accepting either: no-builder-accepted, nonce dropped", async () => {
    h.sendBundle.mockImplementation(refuse);
    h.rawSend.mockRejectedValue(
      new PreBroadcastNetworkError("refused", new Error("x"))
    );
    expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "no-builder-accepted"
    );
    expect(h.events).toContain("dropped:no-builder-accepted");
  });

  it.each([
    [
      "pending with the hash",
      () => new OnChainPendingError({ message: "x", transactionHash: "0x1" }),
    ],
    [
      "an unclassified error",
      () => new Error("replacement transaction underpriced"),
    ],
  ])(
    "counts %s as out: pending at the window's end, never dropped",
    async (_name, error) => {
      h.rawSend.mockRejectedValue(error());
      const outcome = expectKind(
        await sendBundleInSession(bundleAndPublic()),
        "public-pending"
      );
      expect(outcome.hash).toBe(hashOf(signed[0]));
      expect(outcome.report.publicCopy?.accepted).toBeNull();
      expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
    }
  );

  it("bounds the send a slot before the window's end; a timeout is pending with the hash", async () => {
    h.rawSend.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const outcome = expectKind(
      await sendBundleInSession(
        bundleAndPublic({ timing: { pollMs: 1, windowMs: 600, slotMs: 200 } })
      ),
      "public-pending"
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(outcome.report.publicCopy?.accepted).toBeNull();
  });

  it("keeps watching past the targets once the copy is out, and lands later from the pool", async () => {
    chain.minePublic = { after: 20, status: 1 };
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "included"
    );
    expect(outcome.mined.blockNumber).toBeGreaterThan(1003 + 2);
  });

  it("a nonce conflict with our own copy mined is included, found among every step hash", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.receipts.set(hashOf(raw), { status: 1, blockNumber: LATEST + 1 });
      chain.minedCount = NONCE + 1;
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("nonce too low")
      );
    });
    expectKind(await sendBundleInSession(bundleAndPublic()), "included");
  });

  it("a nonce conflict with another transaction mined is used elsewhere", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.minedCount = NONCE + 1;
      chain.txs.set(LATEST, [
        { from: wallet.address, nonce: NONCE, hash: OTHER_HASH },
      ]);
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("nonce too low")
      );
    });
    expectKind(await sendBundleInSession(bundleAndPublic()), "used-elsewhere");
  });

  it("a nonce conflict with nothing found yet is not-checked, never pending on a copy no pool holds", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.minedCount = NONCE + 1;
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("nonce too low")
      );
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "not-included"
    );
    expect(outcome.reason).toBe("not-checked");
  });

  it("a mined revert of the copy is a paid revert", async () => {
    chain.minePublic = { after: 1, status: 0 };
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "included"
    );
    expect(outcome.mined.succeeded).toBe(false);
    expect(outcome.paidRevert).toEqual({ lostRace: false });
  });

  it("a mined revert whose call now reverts at its block is a lost race", async () => {
    chain.minePublic = { after: 1, status: 0 };
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.publicMine = {
        hash: hashOf(raw),
        at: chain.block + 1,
        status: 0,
      };
      // Someone made the call first in that block.
      chain.callReverts = true;
      return { hash: hashOf(raw) };
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "included"
    );
    expect(outcome.paidRevert).toEqual({ lostRace: true });
    // The re-check ran at the mined block, not latest.
    expect(h.callTags.at(-1)).toBe(outcome.mined.blockNumber);
  });
});

describe('Bundle with "Send publicly if still needed"', () => {
  it("on a real not-picked, sends the last target's signed bytes and lands", async () => {
    chain.minePublic = { after: 1, status: 1 };
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "included"
    );
    expect(h.rawSend).toHaveBeenCalledWith(signed.at(-1));
    expect(outcome.mined.hash).toBe(hashOf(signed.at(-1) as string));
    expect(outcome.report.fallbackSent).toBe(true);
    expect(h.markPublicCopy).toHaveBeenCalledWith(expect.anything(), NONCE, {
      hash: hashOf(signed.at(-1) as string),
      kind: "fallback",
      via: "platform",
    });
    // One send check, at the block after the head, with the signed gas limit.
    expect(h.events.filter((e) => e.startsWith("check:"))).toHaveLength(1);
    expect(h.checkGasLimits).toEqual([BigInt(60_000)]);
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("is not sent when the call now reverts: no-longer-needed, nonce dropped", async () => {
    h.check = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
    });
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "not-included"
    );
    expect(outcome.reason).toBe("no-longer-needed");
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "no-longer-needed",
    });
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events).toContain("dropped:no-longer-needed");
  });

  it("is not sent when the check cannot be read: not-checked (never not-picked), check-failed", async () => {
    h.check = new Error("request timeout");
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "not-included"
    );
    expect(outcome.reason).toBe("not-checked");
    expect(outcome.report.fallbackNotSentReason).toBe("check-failed");
    expect(h.rawSend).not.toHaveBeenCalled();
    // Dropped with no decided miss: a replay says not-checked too.
    expect(h.events).toContain("dropped:undefined");
  });

  it("is not sent with fewer than two slots of the window left", async () => {
    const outcome = expectKind(
      await sendBundleInSession(
        withFallback({ timing: { pollMs: 1, windowMs: 2000, slotMs: 1500 } })
      ),
      "not-included"
    );
    expect(outcome.report.fallbackNotSentReason).toBe("window-ending");
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("is not sent when its fee cap is below the next block's exact base fee", async () => {
    // Signed at 30.44 gwei; the base fee rose to 40 once the bundle went out.
    chain.baseFeeAfterSend = gwei("40");
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "not-included"
    );
    expect(outcome.report.fallbackNotSentReason).toBe("max-fee-below-base-fee");
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("is sent when the fee cap equals the next block's base fee", async () => {
    // A block exactly at target keeps the base fee: 30.44 gwei next.
    chain.baseFeeAfterSend = gwei("30.44");
    chain.minePublic = { after: 1, status: 1 };
    expectKind(await sendBundleInSession(withFallback()), "included");
    expect(h.rawSend).toHaveBeenCalledTimes(1);
  });

  it("is never sent when no builder accepted: the step fails as before", async () => {
    h.sendBundle.mockImplementation(refuse);
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "no-builder-accepted"
    );
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "no-builder-accepted",
    });
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("is never sent when the outcome stays undecided to the window's end", async () => {
    // The head never moves: the watch cannot decide.
    chain.block = LATEST;
    const stalled = manager();
    stalled.executeWithFailover = (<T>(
      operation: (p: ReturnType<typeof stubProvider>) => Promise<T>
    ) =>
      operation({
        ...stubProvider(),
        getBlockNumber: async () => LATEST,
      })) as typeof stalled.executeWithFailover;
    const outcome = expectKind(
      await sendBundleInSession(
        withFallback({
          rpcManager: stalled as unknown as BundleSendInput["rpcManager"],
          timing: { pollMs: 1, windowMs: 300, slotMs: 100 },
        })
      ),
      "not-included"
    );
    expect(outcome.reason).toBe("not-checked");
    expect(outcome.report.fallbackNotSentReason).toBe("not-checked");
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("no public RPC reached: fallback-refused, nonce dropped with that miss", async () => {
    h.rawSend.mockRejectedValue(
      new PreBroadcastNetworkError("connect ECONNREFUSED", new Error("x"))
    );
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "fallback-refused"
    );
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "refused",
      publicCopy: { accepted: false },
    });
    expect(h.events).toContain("public-refused");
    expect(h.events).toContain("dropped:fallback-refused");
  });

  it("sent and not mined by the window's end: pending with the fallback's hash", async () => {
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "public-pending"
    );
    expect(outcome.hash).toBe(hashOf(signed.at(-1) as string));
    expect(outcome.report.fallbackSent).toBe(true);
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("with Stop, nothing goes out and the miss is decided as before", async () => {
    const outcome = expectKind(
      await sendBundleInSession(input({ fallback: "stop" })),
      "not-included"
    );
    expect(outcome.reason).toBe("not-picked");
    expect(outcome.report.fallbackSent).toBeUndefined();
    expect(h.events.some((e) => e.startsWith("check:"))).toBe(false);
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("is ignored with Bundle and public", async () => {
    chain.minePublic = { after: 1, status: 1 };
    const outcome = await sendBundleInSession(
      bundleAndPublic({ fallback: "public" })
    );
    expect(h.rawSend).toHaveBeenCalledTimes(1);
    expect(h.rawSend).toHaveBeenCalledWith(signed[0]);
    expect(outcome.report.fallbackSent).toBeUndefined();
  });
});

describe("a stuck public copy", () => {
  it("names the public copy and its hash when a bundle cannot land behind it", async () => {
    chain.minedCount = NONCE - 1;
    h.pendingPublicCopyHash.mockResolvedValue("0xstuck");
    const outcome = expectKind(await sendBundleInSession(input()), "refused");
    expect(h.pendingPublicCopyHash).toHaveBeenCalledWith(
      wallet.address,
      1,
      NONCE - 1
    );
    expect(outcome.error).toBe(
      `A public copy of an earlier bundle from this wallet (transaction 0xstuck, nonce ${NONCE - 1}) is still waiting to be mined, and a bundle cannot land behind it, so nothing was sent. Run it again once that transaction is mined. While it is still in the public pool this can take up to a day: KeeperHub checks it every few minutes and stops waiting for it after a day.`
    );
  });

  it("keeps the plain message when no public copy is pending, or the lookup fails", async () => {
    chain.minedCount = NONCE - 1;
    h.pendingPublicCopyHash.mockRejectedValue(new Error("db down"));
    const outcome = expectKind(await sendBundleInSession(input()), "refused");
    expect(outcome.error).toContain(
      `An earlier transaction from this wallet (nonce ${NONCE - 1}) is still waiting`
    );
  });
});

describe("review round 1", () => {
  const insufficientFunds = (raw: string) =>
    new OnChainPendingError({
      message:
        "Transaction send outcome could not be determined (insufficient funds for gas * price + value)",
      transactionHash: hashOf(raw),
    });

  it("an insufficient-funds answer is pending with the hash on Bundle and public, never refused", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      throw insufficientFunds(raw);
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "public-pending"
    );
    expect(outcome.report.publicCopy?.accepted).toBeNull();
    expect(h.events).not.toContain("public-refused");
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("an insufficient-funds answer on the fallback is sent (fallbackSent true) and pending", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      throw insufficientFunds(raw);
    });
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "public-pending"
    );
    expect(outcome.report.fallbackSent).toBe(true);
    expect(outcome.hash).toBe(hashOf(signed.at(-1) as string));
  });

  it("Bundle and public: a nonce conflict marks the copy never sent, accepted false, and the watch decides", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.minedCount = NONCE + 1;
      chain.txs.set(LATEST, [
        { from: wallet.address, nonce: NONCE, hash: OTHER_HASH },
      ]);
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("replacement transaction underpriced")
      );
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "used-elsewhere"
    );
    expect(h.events).toContain("public-refused");
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "another transaction holds this nonce",
    });
  });

  it("Bundle and public: a nonce conflict with no builder accepting settles at once, without a watch", async () => {
    h.sendBundle.mockImplementation(refuse);
    // The other transaction is still pooled: nothing proves the nonce used yet.
    h.rawSend.mockImplementation(async (raw: string) => {
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("replacement transaction underpriced")
      );
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "not-included"
    );
    // A watch would have held the wallet past the targets and read the miss as not picked.
    expect(outcome.reason).toBe("not-checked");
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "another transaction holds this nonce",
    });
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("fallback: a nonce conflict is nonce-used, not sent", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      chain.minedCount = NONCE + 1;
      chain.txs.set(LATEST, [
        { from: wallet.address, nonce: NONCE, hash: OTHER_HASH },
      ]);
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("nonce too low")
      );
    });
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "used-elsewhere"
    );
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "nonce-used",
      publicCopy: {
        accepted: false,
        error: "another transaction holds this nonce",
      },
    });
    expect(h.events).toContain("public-refused");
  });

  it("fallback through a private relay: not sent (no-public-rpc), not-picked", async () => {
    chain.relay = true;
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "not-included"
    );
    expect(outcome.reason).toBe("not-picked");
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "no-public-rpc",
      publicCopy: {
        accepted: false,
        error: "this step sends through a private relay",
      },
    });
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events).toContain("dropped:not-picked");
  });

  it("fallback not recorded: no send, not-recorded, nonce dropped as not-picked", async () => {
    h.markPublicCopy.mockResolvedValue(false);
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "not-included"
    );
    expect(outcome.reason).toBe("not-picked");
    expect(outcome.report.fallbackNotSentReason).toBe("not-recorded");
    expect(h.rawSend).not.toHaveBeenCalled();
    expect(h.events).toContain("dropped:not-picked");
  });

  it("Bundle and public with no builder accepting and the call now reverting: Not landed no-longer-needed", async () => {
    h.sendBundle.mockImplementation(refuse);
    h.check = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "not-included"
    );
    expect(outcome.reason).toBe("no-longer-needed");
    expect(h.events).toContain("dropped:no-longer-needed");
    expect(h.rawSend).not.toHaveBeenCalled();
  });

  it("the gate reads Not before from the head's time: a head at T1 - 1 whose next slot is early sends nothing", async () => {
    const notBefore = blockTime(LATEST + 3);
    // T1 - 1 by number, but 5 s early by time: its next slot is before Not before.
    const early = { number: LATEST + 2, timestamp: blockTime(LATEST + 2) - 5 };
    chain.heads = [LATEST, LATEST, LATEST, LATEST, early, early, LATEST + 2];
    chain.minePublic = { after: 1, status: 1 };
    await sendBundleInSession(
      bundleAndPublic({ sendAhead: { notBefore, blocks: 2 } })
    );
    expect(h.rawSend).toHaveBeenCalledTimes(1);
    // Marked only after both early heads were read.
    expect(h.headsLeftAtMark).toEqual([0]);
  });
});

describe("where the public copy went", () => {
  it("records via user when the step sends through the user's own RPC", async () => {
    chain.userRpc = true;
    chain.minePublic = { after: 1, status: 1 };
    await sendBundleInSession(bundleAndPublic());
    expect(h.markPublicCopy).toHaveBeenCalledWith(expect.anything(), NONCE, {
      hash: hashOf(signed[0]),
      kind: "with-bundle",
      via: "user",
    });
  });
});

describe("review round 2", () => {
  // As submit-signed throws it when every attempt was a node's definite rejection and no node knows the hash.
  const rejected = (raw: string, message: string) =>
    new OnChainPendingError({
      message: `Transaction send outcome could not be determined (${message})`,
      transactionHash: hashOf(raw),
      notSent: { sendError: new Error(message) },
    });

  it("Bundle and public: a nonce held by another pooled transaction keeps watching; a builder's bundle can still land", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      // The builders include the second target's bundle a block later.
      chain.publicMine = {
        hash: hashOf(signed[1]),
        at: chain.block + 2,
        status: 1,
      };
      throw new NonceConflictError(
        hashOf(raw),
        NONCE,
        new Error("replacement transaction underpriced")
      );
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "included"
    );
    expect(outcome.mined.hash).toBe(hashOf(signed[1]));
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "another transaction holds this nonce",
    });
    expect(h.events).toContain("public-refused");
    expect(h.events.some((e) => e.startsWith("dropped"))).toBe(false);
  });

  it("Bundle and public: every RPC rejecting the copy for too little balance is refused, plain bundle rules", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      throw rejected(raw, "insufficient funds for gas * price + value");
    });
    const outcome = expectKind(
      await sendBundleInSession(bundleAndPublic()),
      "not-included"
    );
    expect(outcome.report.publicCopy).toMatchObject({
      accepted: false,
      error: "no public RPC could be reached or every RPC rejected it",
    });
    expect(h.events).toContain("public-refused");
  });

  it("fallback: every RPC rejecting the copy is fallback-refused, nonce dropped with that miss", async () => {
    h.rawSend.mockImplementation(async (raw: string) => {
      throw rejected(raw, "intrinsic gas too low");
    });
    const outcome = expectKind(
      await sendBundleInSession(withFallback()),
      "fallback-refused"
    );
    expect(outcome.report).toMatchObject({
      fallbackSent: false,
      fallbackNotSentReason: "refused",
    });
    expect(h.events).toContain("dropped:fallback-refused");
  });

  it("logs one capped warning, without URLs, when a send error counts as out", async () => {
    const { logWarn } = await import("@/lib/logging");
    h.rawSend.mockRejectedValue(
      new Error(`timeout at https://rpc.example/key/abc ${"x".repeat(400)}`)
    );
    expectKind(await sendBundleInSession(bundleAndPublic()), "public-pending");
    const warned = vi
      .mocked(logWarn)
      .mock.calls.filter(([message]) => message.includes("Public copy send"));
    expect(warned).toHaveLength(1);
    const labels = warned[0][1] as Record<string, string>;
    expect(labels.error).toBe("Error");
    expect(labels.message.length).toBeLessThanOrEqual(200);
    expect(labels.message).not.toContain("rpc.example");
  });
});

describe("adaptPublicSendError", () => {
  const flagged = (message: string, sendError: unknown = new Error(message)) =>
    new OnChainPendingError({
      message: `Transaction send outcome could not be determined (${message})`,
      transactionHash: OTHER_HASH,
      notSent: { sendError },
    });

  it.each([
    ["insufficient funds", "insufficient funds for gas * price + value"],
    ["intrinsic gas too low", "intrinsic gas too low: have 0, want 21000"],
    ["an invalid sender", "invalid sender"],
  ])("a flagged definite rejection (%s) is refused", (_name, message) => {
    expect(adaptPublicSendError(flagged(message))).toBe("refused");
  });

  it("reads ethers' INSUFFICIENT_FUNDS code on the flagged error's answer", () => {
    const answer = Object.assign(new Error("node said no"), {
      code: "INSUFFICIENT_FUNDS",
    });
    expect(adaptPublicSendError(flagged("node said no", answer))).toBe(
      "refused"
    );
  });

  it("is out without the flag, or with the flag and no definite rejection", () => {
    expect(
      adaptPublicSendError(
        new OnChainPendingError({
          message:
            "Transaction send outcome could not be determined (insufficient funds)",
          transactionHash: OTHER_HASH,
        })
      )
    ).toBe("out");
    expect(adaptPublicSendError(flagged("nonce gap"))).toBe("out");
  });

  it("maps each throw of the raw send once", () => {
    expect(
      adaptPublicSendError(
        new PreBroadcastNetworkError("connect ECONNREFUSED", new Error("x"))
      )
    ).toBe("refused");
    expect(
      adaptPublicSendError(
        new NonceConflictError(OTHER_HASH, NONCE, new Error("nonce too low"))
      )
    ).toBe("nonce-used");
    // Pending with the hash, a node's rejection or a timeout: it may be in a pool.
    expect(
      adaptPublicSendError(
        new OnChainPendingError({ message: "x", transactionHash: OTHER_HASH })
      )
    ).toBe("out");
    expect(adaptPublicSendError(new Error("insufficient funds"))).toBe("out");
    expect(adaptPublicSendError("timeout")).toBe("out");
  });

  it("never reads a pending error as a used nonce, whatever its name", () => {
    const pending = new OnChainPendingError({
      message: "x",
      transactionHash: OTHER_HASH,
    });
    Object.defineProperty(pending, "name", { value: "NonceConflictError" });
    expect(adaptPublicSendError(pending)).toBe("out");
  });
});
