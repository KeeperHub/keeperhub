/**
 * The bundle send inside a nonce session: targets after the lock, refusals
 * before signing, one signed transaction per target at one nonce, the row
 * recorded before any builder hears of it, and the nonce confirmed, released
 * or left pending by what the chain shows.
 */
import { ethers } from "ethers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logs = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logSystemError: vi.fn(),
}));
vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    DATABASE: "database",
    WORKFLOW_ENGINE: "workflow_engine",
    EXTERNAL_SERVICE: "external_service",
  },
  logInfo: logs.logInfo,
  logWarn: vi.fn(),
  logUserError: vi.fn(),
  logSystemError: logs.logSystemError,
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
  // Per target block: a gas estimate, or an error to throw.
  simulations: new Map<number, bigint | Error>(),
  sendBundle: vi.fn(),
  recordBundle: vi.fn(),
  confirmNonce: vi.fn(),
  markNonceDropped: vi.fn(),
  getGasConfig: vi.fn(),
  priorityFeeLimit: vi.fn(),
}));

vi.mock("@/lib/web3/next-block-simulation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/web3/next-block-simulation")>();
  return {
    ...actual,
    simulateSendAtNextBlock: async (
      _manager: unknown,
      request: { options: { targetBlock?: number } }
    ) => {
      const block = request.options.targetBlock ?? 0;
      h.events.push(`simulate:${block}`);
      const answer = h.simulations.get(block);
      if (answer instanceof Error) {
        throw answer;
      }
      return { gasEstimate: answer ?? BigInt(50_000), simulation: {} };
    },
  };
});
vi.mock("@/lib/web3/gas-strategy", () => ({
  getGasStrategy: () => ({
    getGasConfig: h.getGasConfig,
    priorityFeeLimit: h.priorityFeeLimit,
  }),
}));
vi.mock("@/lib/web3/nonce-manager", () => ({
  getNonceManager: () => ({
    getNextNonce: (session: { currentNonce: number }) => {
      h.events.push("nonce");
      const nonce = session.currentNonce;
      session.currentNonce += 1;
      return nonce;
    },
    // Returns this step's hashes at the nonce: this send's unless a test adds earlier ones.
    recordBundle: async (...args: unknown[]) => {
      h.events.push("record");
      const earlier = await h.recordBundle(...args);
      return [
        ...(args[2] as { hashes: string[] }).hashes,
        ...((earlier as string[] | undefined) ?? []),
      ];
    },
    confirmNonce: async (...args: unknown[]) => {
      h.events.push("confirm");
      await h.confirmNonce(...args);
    },
    markNonceDropped: async (...args: unknown[]) => {
      h.events.push("dropped");
      await h.markNonceDropped(...args);
    },
  }),
}));
vi.mock("@/lib/web3/bundles/client", () => ({
  sendBundle: async (options: { targetBlock: number }) => {
    h.events.push(`send:${options.targetBlock}`);
    chain.sent = true;
    return await h.sendBundle(options);
  },
}));

import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { BUNDLE_PRE_RECORD_MS } from "@/lib/web3/bundles/bundle-history";
import type { BuilderAnswer } from "@/lib/web3/bundles/client";
import {
  BundleRecordError,
  BundleSigningError,
  sendBundleInSession,
} from "@/lib/web3/bundles/send-bundle";
import { NextBlockSimulationUnsupportedError } from "@/lib/web3/next-block-simulation";

type BundleSendInput = Parameters<typeof sendBundleInSession>[0];

const gwei = (value: string): bigint => ethers.parseUnits(value, "gwei");
const wallet = new ethers.Wallet(`0x${"11".repeat(32)}`);
const LATEST = 1000;
const NONCE = 42;

type Chain = {
  block: number;
  // Blocks move only once a bundle went out, one per block read.
  sent: boolean;
  stalled: boolean;
  minedCount: number;
  balance: bigint;
  receipts: Map<string, { status: number; blockNumber: number }>;
  callReverts: boolean;
  // The re-check eth_call fails without a revert (an RPC error).
  callFails: boolean;
  readsFail: boolean;
  // Reads that never answer (RPC failover stuck), after the bundle went out.
  readsHang: boolean;
  callHangs: boolean;
  // A second endpoint for the used-elsewhere re-read; null when there is none.
  fallback: {
    getTransactionReceipt: (hash: string) => Promise<unknown>;
    getBlockNumber: () => Promise<number>;
    getBlock: (block: number, prefetch: boolean) => Promise<unknown>;
  } | null;
  // Mines the first signed tx whose target equals the block once it is reached.
  mineAt?: number;
  // Mines a transaction that is not ours at this block.
  otherAt?: number;
  // The count moves at otherAt, but no block read shows the transaction (a lagging node).
  otherUnseen?: boolean;
  // Transactions from the wallet per block, as a block read with them returns.
  txs: Map<number, MinedTx[]>;
  // The latest block's base fee; 10 gwei when unset.
  baseFee?: bigint;
};

type MinedTx = { from: string; nonce: number; hash: string };

const OTHER_HASH = `0x${"ee".repeat(32)}`;

/** A block read with its transactions, from the mocked chain. */
const blockWithTxs = async (block: number) => ({
  number: block,
  prefetchedTransactions: chain.txs.get(block) ?? [],
});

let chain: Chain;
let signed: string[];

function manager() {
  const provider = {
    getBlock: async (tag?: unknown, prefetch?: boolean) =>
      prefetch
        ? await blockWithTxs(tag as number)
        : {
            number: chain.block,
            baseFeePerGas: chain.baseFee ?? gwei("10"),
            gasUsed: BigInt(15_000_000),
            gasLimit: BigInt(30_000_000),
          },
    getBlockNumber: async () => {
      if (chain.readsFail) {
        throw new Error("rpc down");
      }
      if (chain.readsHang && chain.sent) {
        return await new Promise<number>(() => undefined);
      }
      if (chain.sent && !chain.stalled) {
        chain.block += 1;
      }
      if (chain.mineAt !== undefined && chain.block === chain.mineAt) {
        const raw = signed[chain.mineAt - LATEST - 1];
        chain.receipts.set(ethers.keccak256(raw), {
          status: 1,
          blockNumber: chain.block,
        });
        chain.minedCount = NONCE + 1;
      }
      if (chain.otherAt !== undefined && chain.block === chain.otherAt) {
        chain.minedCount = NONCE + 1;
        if (!chain.otherUnseen) {
          chain.txs.set(chain.block, [
            { from: wallet.address, nonce: NONCE, hash: OTHER_HASH },
          ]);
        }
      }
      return chain.block;
    },
    getTransactionCount: async () => chain.minedCount,
    getBalance: async () => chain.balance,
    getTransactionReceipt: async (hash: string) => {
      const receipt = chain.receipts.get(hash);
      return receipt
        ? { ...receipt, gasUsed: BigInt(40_000), gasPrice: gwei("11") }
        : null;
    },
    call: async () => {
      if (chain.callHangs) {
        return await new Promise<string>(() => undefined);
      }
      if (chain.callReverts) {
        throw Object.assign(new Error("execution reverted"), {
          code: "CALL_EXCEPTION",
        });
      }
      if (chain.callFails) {
        throw new Error("request timeout");
      }
      return "0x";
    },
  };
  return {
    executeWithFailover: <T>(operation: (p: typeof provider) => Promise<T>) =>
      operation(provider),
    getFallbackProvider: () => chain.fallback,
  };
}

const signer = {
  provider: {},
  populateTransaction: async (tx: ethers.TransactionRequest) => tx,
  signTransaction: async (tx: ethers.TransactionRequest) => {
    h.events.push("sign");
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
    node: { id: "write-1", name: "Write", iterationIndex: 2 },
    progress: { sent: false },
    timing: { pollMs: 1, windowMs: 60_000 },
    ...overrides,
  };
}

const accept = (options: { targetBlock: number }): BuilderAnswer[] => [
  {
    builder: "alpha",
    delivery: "accepted",
    bundleHash: `0x${String(options.targetBlock).padStart(64, "0")}`,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.events = [];
  h.simulations = new Map();
  h.sendBundle.mockImplementation(accept);
  h.getGasConfig.mockResolvedValue({
    gasLimit: BigInt(60_000),
    maxFeePerGas: gwei("30"),
    maxPriorityFeePerGas: gwei("1"),
  });
  h.priorityFeeLimit.mockResolvedValue(gwei("500"));
  chain = {
    block: LATEST,
    sent: false,
    stalled: false,
    minedCount: NONCE,
    balance: ethers.parseEther("10"),
    receipts: new Map(),
    callReverts: false,
    callFails: false,
    readsFail: false,
    readsHang: false,
    callHangs: false,
    fallback: null,
    txs: new Map(),
  };
  signed = [];
});

const nothingSigned = (progress: { sent: boolean }): void => {
  expect(h.events).not.toContain("sign");
  expect(h.events).not.toContain("record");
  expect(h.events.some((e) => e.startsWith("send:"))).toBe(false);
  expect(progress.sent).toBe(false);
};

describe("sendBundleInSession", () => {
  it("lands at target 1: confirms the nonce with the mined hash", async () => {
    chain.mineAt = LATEST + 1;
    const progress = { sent: false };
    const outcome = await sendBundleInSession(input({ progress }));
    expect(outcome.kind).toBe("included");
    if (outcome.kind !== "included") {
      return;
    }
    expect(outcome.mined.hash).toBe(ethers.keccak256(signed[0]));
    expect(progress.sent).toBe(true);
    expect(h.confirmNonce).toHaveBeenCalledWith(
      expect.anything(),
      NONCE,
      outcome.mined.hash
    );
    expect(h.markNonceDropped).not.toHaveBeenCalled();
    expect(outcome.report).toEqual({
      targetBlocks: [1001, 1002, 1003],
      targetTipsGwei: ["1", "1.2", "1.44"],
      builders: [{ name: "alpha", accepted: true }],
    });
  });

  it("signs one transaction per target at one nonce, rising 1x, 1.2x, 1.44x", async () => {
    await sendBundleInSession(input());
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    expect(txs.map((tx) => tx.nonce)).toEqual([NONCE, NONCE, NONCE]);
    expect(txs.map((tx) => tx.maxPriorityFeePerGas)).toEqual([
      gwei("1"),
      gwei("1.2"),
      gwei("1.44"),
    ]);
    // No Max Fee set: the estimate's 29 gwei of base-fee room plus the 1.44 top tip.
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("30.44")])
    );
    expect(new Set(txs.map((tx) => tx.gasLimit))).toEqual(
      new Set([BigInt(60_000)])
    );
  });

  it("records the row with every hash before the first builder request, and marks the broadcast first", async () => {
    await sendBundleInSession(input());
    const record = h.events.indexOf("record");
    const marked = h.events.indexOf("marked");
    const firstSend = h.events.findIndex((e) => e.startsWith("send:"));
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(marked);
    expect(marked).toBeLessThan(firstSend);
    expect(h.events.indexOf("nonce")).toBeGreaterThan(
      h.events.lastIndexOf("simulate:1003")
    );
    expect(h.recordBundle).toHaveBeenCalledWith(expect.anything(), NONCE, {
      hashes: signed.map((raw) => ethers.keccak256(raw)),
      lastTargetBlock: 1003,
      workflowId: "wf-1",
      gasPrice: gwei("30.44").toString(),
      node: { id: "write-1", name: "Write", iterationIndex: 2 },
    });
  });

  it("with Max Fee set above the estimate, raises the cap up to it so the tips are paid", async () => {
    await sendBundleInSession(
      input({ gas: { maxFeeOverride: gwei("60") }, tipIncreasePercent: 100 })
    );
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    expect(txs.map((tx) => tx.maxPriorityFeePerGas)).toEqual([
      gwei("1"),
      gwei("2"),
      gwei("4"),
    ]);
    // 29 gwei of base-fee room plus the 4 gwei top tip, under the 60 gwei Max Fee.
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("33")])
    );
  });

  it("with Max Fee empty, holds the raised cap to the highest Max Fee a user may set", async () => {
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("9000"),
      maxPriorityFeePerGas: gwei("1000"),
    });
    h.priorityFeeLimit.mockResolvedValue(gwei("20000"));
    await sendBundleInSession(input({ tipIncreasePercent: 100 }));
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    expect(txs.map((tx) => tx.maxPriorityFeePerGas)).toEqual([
      gwei("1000"),
      gwei("2000"),
      gwei("4000"),
    ]);
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("10000")])
    );
  });

  it("stops the later tips at the chain's tip limit", async () => {
    h.priorityFeeLimit.mockResolvedValue(gwei("1.5"));
    await sendBundleInSession(input({ tipIncreasePercent: 100 }));
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    // Blocks 2 and 3 share the 1.5 gwei tip, so one transaction covers both.
    expect(txs.map((tx) => tx.maxPriorityFeePerGas)).toEqual([
      gwei("1"),
      gwei("1.5"),
    ]);
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("30.5")])
    );
  });

  it("with an estimate below the base fee ahead, raises the cap to the last target's base fee", async () => {
    // The base fee rose past the estimate: 8 gwei of room, but block 3 may reach 12.66.
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("9"),
      maxPriorityFeePerGas: gwei("1"),
    });
    const outcome = await sendBundleInSession(
      input({ gas: { maxFeeOverride: gwei("60") }, tipIncreasePercent: 0 })
    );
    expect(outcome.kind).not.toBe("refused");
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("12.65625") + gwei("1")])
    );
  });

  it("with Max Fee set below the raised cap, signs at that Max Fee", async () => {
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("13"),
      maxPriorityFeePerGas: gwei("1"),
    });
    await sendBundleInSession(
      input({ gas: { maxFeeOverride: gwei("13") }, tipIncreasePercent: 100 })
    );
    const txs = signed.map((raw) => ethers.Transaction.from(raw));
    expect(txs.map((tx) => tx.maxPriorityFeePerGas)).toEqual([
      gwei("1"),
      gwei("2"),
      gwei("4"),
    ]);
    expect(new Set(txs.map((tx) => tx.maxFeePerGas))).toEqual(
      new Set([gwei("13")])
    );
  });

  it("signs once when every tip is the same", async () => {
    await sendBundleInSession(input({ tipIncreasePercent: 0 }));
    expect(signed).toHaveLength(1);
    expect(h.recordBundle.mock.calls[0][2].hashes).toHaveLength(1);
  });

  it("uses the largest estimate over the targets that passed", async () => {
    h.simulations.set(1001, BigInt(30_000));
    h.simulations.set(1002, BigInt(90_000));
    await sendBundleInSession(input());
    expect(h.getGasConfig.mock.calls[0][1]).toBe(BigInt(90_000));
  });

  it("not picked: decided past the margin, releases the nonce", async () => {
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-picked",
    });
    // Decided only once a block past lastTarget + 2 showed the nonce unused.
    expect(chain.block).toBeGreaterThan(1005);
    // Marked decided, so a replay returns the same miss.
    expect(h.markNonceDropped).toHaveBeenCalledWith(
      expect.anything(),
      NONCE,
      "not-picked"
    );
    expect(h.confirmNonce).not.toHaveBeenCalled();
  });

  it("no longer needed: the call now reverts on the latest state", async () => {
    chain.callReverts = true;
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "no-longer-needed",
    });
  });

  it("a decided miss whose re-check fails is not-picked, never not-checked: the nonce is released", async () => {
    chain.callFails = true;
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-picked",
    });
    expect(h.markNonceDropped).toHaveBeenCalledWith(
      expect.anything(),
      NONCE,
      "not-picked"
    );
  });

  it("watches when builders gave no answers at all (no refusal to stop on)", async () => {
    h.sendBundle.mockResolvedValue([]);
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-picked",
    });
  });

  it("no builder accepted: releases the nonce and stops", async () => {
    h.sendBundle.mockResolvedValue([
      { builder: "alpha", delivery: "refused", error: "bad bundle" },
    ]);
    const outcome = await sendBundleInSession(
      input({ unknownBuilders: ["ghost"] })
    );
    expect(outcome.kind).toBe("no-builder-accepted");
    expect(h.markNonceDropped).toHaveBeenCalled();
    expect(outcome.report?.builders).toEqual([
      { name: "alpha", accepted: false, error: "bad bundle" },
      {
        name: "ghost",
        accepted: false,
        error: "not in this network's builder list",
      },
    ]);
  });

  it("keeps watching when a builder's answer is unknown", async () => {
    h.sendBundle.mockResolvedValue([
      { builder: "alpha", delivery: "unknown", error: "no answer in time" },
    ]);
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("not-included");
    expect(outcome.report?.builders).toEqual([
      { name: "alpha", accepted: null, error: "no answer in time" },
    ]);
  });

  it("reports each builder over every target: accepted wins, then unknown, then the first refusal", async () => {
    const byTarget: Record<number, BuilderAnswer[]> = {
      1001: [
        { builder: "a", delivery: "refused", error: "x" },
        { builder: "b", delivery: "refused", error: "first" },
        { builder: "c", delivery: "refused", error: "first" },
      ],
      1002: [
        { builder: "a", delivery: "accepted" },
        { builder: "b", delivery: "unknown", error: "timeout" },
        { builder: "c", delivery: "refused", error: "second" },
      ],
      1003: [],
    };
    h.sendBundle.mockImplementation(
      async (options: { targetBlock: number }) => byTarget[options.targetBlock]
    );
    const outcome = await sendBundleInSession(input());
    expect(outcome.report?.builders).toEqual([
      { name: "a", accepted: true },
      { name: "b", accepted: null, error: "timeout" },
      { name: "c", accepted: false, error: "first" },
    ]);
  });

  it("skips a reverting target and sends the rest", async () => {
    h.simulations.set(1001, new Error("execution reverted: too soon"));
    const outcome = await sendBundleInSession(input());
    expect(outcome.report).toMatchObject({
      targetBlocks: [1002, 1003],
      targetTipsGwei: ["1.2", "1.44"],
      bundleTargetsSkipped: [{ block: 1001, reason: "simulation-failed" }],
    });
  });

  it("throws the first simulation error when every target fails, before any nonce", async () => {
    const revert = new Error("execution reverted: closed");
    for (const block of [1001, 1002, 1003]) {
      h.simulations.set(block, revert);
    }
    const progress = { sent: false };
    await expect(sendBundleInSession(input({ progress }))).rejects.toBe(revert);
    expect(h.events).not.toContain("nonce");
    nothingSigned(progress);
  });

  it("rethrows an RPC that cannot simulate", async () => {
    h.simulations.set(
      1002,
      new NextBlockSimulationUnsupportedError("no overrides")
    );
    await expect(sendBundleInSession(input())).rejects.toBeInstanceOf(
      NextBlockSimulationUnsupportedError
    );
  });

  it("sends nothing when the base fee is above the highest fee cap, and blames the network", async () => {
    chain.baseFee = gwei("20000");
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("9000"),
      maxPriorityFeePerGas: gwei("1"),
    });
    const progress = { sent: false };
    const outcome = await sendBundleInSession(input({ progress }));
    expect(outcome).toMatchObject({ kind: "refused", errorClass: "external" });
    // The next base fee is exactly 20000 gwei (half-full parent).
    expect(outcome.kind === "refused" && outcome.error).toBe(
      "The fee cap of 10,000 gwei, the most a bundle step signs, is below the base fee the target blocks may reach (20,000 gwei), so nothing was sent. Run it again later."
    );
    expect(h.events).not.toContain("nonce");
    nothingSigned(progress);
  });

  it("blames the user's own Max Fee when it skips every target", async () => {
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("9"),
      maxPriorityFeePerGas: gwei("1"),
    });
    const outcome = await sendBundleInSession(
      input({ gas: { maxFeeOverride: gwei("9") } })
    );
    expect(outcome).toMatchObject({ kind: "refused", errorClass: "user" });
    expect(outcome.kind === "refused" && outcome.error).toBe(
      "Max fee 9 gwei is below the base fee the target blocks may reach (10 gwei), so nothing was sent. Raise the max fee or leave it empty."
    );
  });

  it("keeps the simulation error when some targets reverted and the rest were fee-skipped", async () => {
    const revert = new Error("execution reverted: closed");
    h.simulations.set(1001, revert);
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("9"),
      maxPriorityFeePerGas: gwei("1"),
    });
    await expect(
      sendBundleInSession(input({ gas: { maxFeeOverride: gwei("9") } }))
    ).rejects.toBe(revert);
  });

  it("refuses a wallet that cannot hold gasLimit x maxFee + value, before signing", async () => {
    const value = ethers.parseEther("1");
    // One wei short of 60k gas at the 30.44 gwei Max Fee plus the value.
    chain.balance = BigInt(60_000) * gwei("30.44") + value - BigInt(1);
    const progress = { sent: false };
    const outcome = await sendBundleInSession(
      input({ progress, call: { ...input().call, value } })
    );
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(outcome.kind === "refused" && outcome.error).toContain(
      "Insufficient ETH balance"
    );
    nothingSigned(progress);

    chain.balance += BigInt(1);
    expect(
      (await sendBundleInSession(input({ call: { ...input().call, value } })))
        .kind
    ).not.toBe("refused");
  });

  it("refuses a nonce behind a transaction still pending, before signing", async () => {
    chain.minedCount = NONCE - 1;
    const progress = { sent: false };
    const outcome = await sendBundleInSession(input({ progress }));
    expect(outcome).toMatchObject({ kind: "refused", errorClass: "external" });
    expect(outcome.kind === "refused" && outcome.error).toContain(
      "still waiting to be mined"
    );
    nothingSigned(progress);
  });

  it("refuses a nonce the chain already passed (a lagging node), before signing", async () => {
    chain.minedCount = NONCE + 1;
    const progress = { sent: false };
    const outcome = await sendBundleInSession(input({ progress }));
    expect(outcome).toMatchObject({ kind: "refused", errorClass: "external" });
    expect(outcome.kind === "refused" && outcome.error).toContain(
      "could not be read consistently"
    );
    nothingSigned(progress);
  });

  it("names a failed row write as such: nothing was sent", async () => {
    h.recordBundle.mockRejectedValueOnce(new Error("db down"));
    const progress = { sent: false };
    await expect(
      sendBundleInSession(input({ progress }))
    ).rejects.toBeInstanceOf(BundleRecordError);
    expect(h.events.some((e) => e.startsWith("send:"))).toBe(false);
    expect(progress.sent).toBe(false);
  });

  it("refuses a first tip of 0, before signing", async () => {
    h.getGasConfig.mockResolvedValue({
      gasLimit: BigInt(60_000),
      maxFeePerGas: gwei("30"),
      maxPriorityFeePerGas: BigInt(0),
    });
    const progress = { sent: false };
    const outcome = await sendBundleInSession(input({ progress }));
    expect(outcome).toMatchObject({ kind: "refused", errorClass: "user" });
    nothingSigned(progress);
  });

  it("moves a target mined while signing to the skipped list and never sends it", async () => {
    const slow = {
      ...signer,
      signTransaction: async (tx: ethers.TransactionRequest) => {
        chain.block = LATEST + 1;
        return await signer.signTransaction(tx);
      },
    };
    const outcome = await sendBundleInSession(
      input({ signer: slow as unknown as ethers.Signer })
    );
    expect(outcome.report).toMatchObject({
      targetBlocks: [1002, 1003],
      bundleTargetsSkipped: [{ block: 1001, reason: "target-passed" }],
    });
    expect(h.events).not.toContain("send:1001");
    expect(h.recordBundle.mock.calls[0][2].hashes).toHaveLength(2);
  });

  it("calls the nonce used elsewhere only after the receipt lag in blocks, and leaves the row", async () => {
    chain.otherAt = LATEST + 1;
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("used-elsewhere");
    expect(chain.block).toBeGreaterThanOrEqual(LATEST + 3);
    expect(h.confirmNonce).not.toHaveBeenCalled();
    expect(h.markNonceDropped).not.toHaveBeenCalled();
  });

  it("re-reads the receipts on the fallback before calling the nonce used elsewhere: a lagging index", async () => {
    chain.otherAt = LATEST + 1;
    const ours = (): string => ethers.keccak256(signed[0]);
    chain.fallback = {
      getTransactionReceipt: async (hash: string) =>
        hash === ours()
          ? {
              blockNumber: LATEST + 1,
              status: 1,
              gasUsed: BigInt(40_000),
              gasPrice: gwei("11"),
            }
          : null,
      getBlockNumber: async () => chain.block,
      getBlock: blockWithTxs,
    };
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("included");
    expect(h.confirmNonce).toHaveBeenCalledWith(
      expect.anything(),
      NONCE,
      ours()
    );
  });

  it("is not-checked with the row pending when the re-read cannot answer", async () => {
    chain.otherAt = LATEST + 1;
    chain.fallback = {
      getTransactionReceipt: async () => {
        throw new Error("fallback down");
      },
      getBlockNumber: async () => chain.block,
      getBlock: blockWithTxs,
    };
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(h.markNonceDropped).not.toHaveBeenCalled();
    expect(h.confirmNonce).not.toHaveBeenCalled();
  });

  it("is not-checked with the row pending when the count moved but no block shows the transaction that used the nonce", async () => {
    chain.otherAt = LATEST + 1;
    chain.otherUnseen = true;
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(h.markNonceDropped).not.toHaveBeenCalled();
    expect(h.confirmNonce).not.toHaveBeenCalled();
  });

  it("is not-checked with the row pending when the fallback does not have the blocks yet", async () => {
    chain.otherAt = LATEST + 1;
    chain.fallback = {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => LATEST,
      getBlock: async () => null,
    };
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
  });

  it("calls the nonce used elsewhere when the fallback finds another transaction at it and none of our receipts", async () => {
    chain.otherAt = LATEST + 1;
    chain.fallback = {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => chain.block,
      getBlock: blockWithTxs,
    };
    expect((await sendBundleInSession(input())).kind).toBe("used-elsewhere");
  });

  it("scans up from two blocks below the send's start and stops at the block that used the nonce", async () => {
    chain.otherAt = LATEST + 1;
    const read: number[] = [];
    chain.fallback = {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => chain.block,
      getBlock: async (block: number) => {
        read.push(block);
        return await blockWithTxs(block);
      },
    };
    expect((await sendBundleInSession(input())).kind).toBe("used-elsewhere");
    expect(chain.block).toBeGreaterThan(LATEST + 1);
    expect(read).toEqual([LATEST - 2, LATEST - 1, LATEST, LATEST + 1]);
  });

  it("is not-checked when the transaction at the nonce is ours but its receipt is not readable yet", async () => {
    chain.otherAt = LATEST + 1;
    chain.otherUnseen = true;
    // Our own hash at the nonce, with no receipt on any endpoint.
    chain.fallback = {
      getTransactionReceipt: async () => null,
      getBlockNumber: async () => chain.block,
      getBlock: async (block: number) => ({
        number: block,
        prefetchedTransactions:
          block === LATEST + 1
            ? [
                {
                  from: wallet.address.toLowerCase(),
                  nonce: NONCE,
                  hash: ethers
                    .keccak256(signed[0])
                    .toUpperCase()
                    .replace("0X", "0x"),
                },
              ]
            : [],
      }),
    };
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
  });

  it("counts an earlier send of this step at this nonce as its landing, not as used elsewhere", async () => {
    chain.otherAt = LATEST + 1;
    chain.otherUnseen = true;
    const earlier = `0x${"dd".repeat(32)}`;
    h.recordBundle.mockResolvedValueOnce([earlier]);
    chain.receipts.set(earlier, { status: 1, blockNumber: LATEST + 1 });
    chain.txs.set(LATEST + 1, [
      { from: wallet.address, nonce: NONCE, hash: earlier },
    ]);
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("included");
    if (outcome.kind !== "included") {
      return;
    }
    expect(outcome.mined.hash).toBe(earlier);
    expect(h.confirmNonce).toHaveBeenCalledWith(
      expect.anything(),
      NONCE,
      earlier
    );
  });

  it("refuses before signing once the work since the lock passed its budget: nothing sent", async () => {
    const progress = { sent: false };
    const outcome = await sendBundleInSession(
      input({
        progress,
        session: {
          ...input().session,
          startedAt: new Date(Date.now() - BUNDLE_PRE_RECORD_MS - 1),
        },
      })
    );
    expect(outcome).toMatchObject({
      kind: "refused",
      errorClass: ExecutionErrorType.EXTERNAL,
      error: expect.stringContaining("nothing was sent"),
    });
    nothingSigned(progress);
  });

  it("stops a read stuck under the lock at the pre-send budget: nothing sent", async () => {
    h.getGasConfig.mockReturnValue(new Promise(() => undefined));
    const progress = { sent: false };
    const started = Date.now();
    const outcome = await sendBundleInSession(
      input({
        progress,
        session: {
          ...input().session,
          startedAt: new Date(Date.now() - BUNDLE_PRE_RECORD_MS + 50),
        },
      })
    );
    expect(outcome).toMatchObject({ kind: "refused" });
    expect(Date.now() - started).toBeLessThan(1000);
    nothingSigned(progress);
  });

  it("ends the watch at the window when a read is stuck in failover: not-checked, row pending", async () => {
    chain.readsHang = true;
    const started = Date.now();
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 50 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.markNonceDropped).not.toHaveBeenCalled();
  });

  it("a decided miss whose re-check is stuck past the window is not-picked, nonce released", async () => {
    chain.callHangs = true;
    const started = Date.now();
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 300 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-picked",
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(h.markNonceDropped).toHaveBeenCalled();
  });

  it("is not-checked with the row pending when the chain stalls past the window", async () => {
    chain.stalled = true;
    const started = Date.now();
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 40 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(h.markNonceDropped).not.toHaveBeenCalled();
    expect(h.confirmNonce).not.toHaveBeenCalled();
  });

  it("is not-checked with the row pending when the chain cannot be read after sending", async () => {
    h.sendBundle.mockImplementation(
      async (options: { targetBlock: number }) => {
        chain.readsFail = true;
        return accept(options);
      }
    );
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 30 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(h.markNonceDropped).not.toHaveBeenCalled();
  });

  it("keeps a landing when confirming its nonce fails, and logs a system error", async () => {
    chain.mineAt = LATEST + 1;
    h.confirmNonce.mockRejectedValueOnce(new Error("db down"));
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("included");
    expect(logs.logSystemError).toHaveBeenCalled();
  });

  it("keeps a decided miss when releasing its nonce fails", async () => {
    h.markNonceDropped.mockRejectedValueOnce(new Error("db down"));
    const outcome = await sendBundleInSession(input());
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-picked",
    });
    expect(logs.logSystemError).toHaveBeenCalled();
  });

  it("watches the chain even when sending to the builders threw", async () => {
    chain.mineAt = LATEST + 2;
    h.sendBundle.mockImplementationOnce(() => {
      throw new Error("socket hang up");
    });
    const outcome = await sendBundleInSession(input());
    expect(outcome.kind).toBe("included");
    expect(logs.logSystemError).toHaveBeenCalled();
  });

  it("holds only until the chain passes the targets when something throws after the row was recorded", async () => {
    logs.logInfo.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 60_000 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    // Released at the first block past lastTarget + 2, long before the window.
    expect(chain.block).toBe(1006);
    expect(h.markNonceDropped).not.toHaveBeenCalled();
  });

  it("waits out the window, row pending, when something throws and the chain stalls", async () => {
    logs.logInfo.mockImplementationOnce(() => {
      throw new Error("unexpected");
    });
    chain.stalled = true;
    const started = Date.now();
    const outcome = await sendBundleInSession(
      input({ timing: { pollMs: 1, windowMs: 40 } })
    );
    expect(outcome).toMatchObject({
      kind: "not-included",
      reason: "not-checked",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(39);
    expect(h.markNonceDropped).not.toHaveBeenCalled();
  });

  it("names a signing failure as such, not a network error", async () => {
    const failing = {
      ...signer,
      signTransaction: async () => {
        throw new Error("turnkey timeout");
      },
    };
    await expect(
      sendBundleInSession(
        input({ signer: failing as unknown as ethers.Signer })
      )
    ).rejects.toBeInstanceOf(BundleSigningError);
  });
});
