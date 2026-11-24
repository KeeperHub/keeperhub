/**
 * Next-block simulation against a real node (local anvil).
 *
 * A time-locked contract is placed with anvil_setCode: `workable()` returns
 * block.timestamp >= unlock, and any other call reverts until then. Interval
 * mining is paused so the test controls every block's timestamp.
 *
 * Prerequisites: docker compose --profile test up -d test-anvil
 * (Foundry anvil on localhost:8546, chain-id 31337.)
 *
 * The adapter cases drive the real EVM adapter (the Write Contract send path:
 * next-block check, gas strategy, signing, broadcast, receipt) with only the
 * database and the nonce lock stubbed.
 *
 * Skipped when SKIP_INFRA_TESTS=true or when anvil is not reachable. Runs
 * with SAFE_FETCH_SHADOW so the SSRF guard lets the provider reach localhost.
 */

import { ethers } from "ethers";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));
// The gas strategy reads per-chain overrides from the database and falls
// back to its defaults when there are none.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    }),
  },
}));

import type { RpcProviderManager } from "@/lib/rpc/providers";
import type * as Adapter from "@/lib/web3/chain-adapter/evm";
import type * as NextBlock from "@/lib/web3/next-block-simulation";
import type { NonceSession } from "@/lib/web3/nonce-manager";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8546";
const CHAIN_ID = 31_337;
const SLOT = 12;
const ANVIL_PRIV_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TIMELOCK = "0x00000000000000000000000000000000000c0de1";
// workable() -> timestamp >= sload(0); anything else reverts until then.
const TIMELOCK_CODE =
  "0x60003560e01c6380bb2bac14601e576000544210601857005b60006000fd5b60005442101560005260206000f3";
const IFACE = new ethers.Interface([
  "function run()",
  "function workable() view returns (bool)",
]);

async function isAnvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "eth_chainId", id: 1 }),
      signal: AbortSignal.timeout(1000),
    });
    const body = (await response.json()) as { result?: string };
    return body.result === `0x${CHAIN_ID.toString(16)}`;
  } catch {
    return false;
  }
}

const skipForCi = process.env.SKIP_INFRA_TESTS === "true";
const shouldSkip = skipForCi || !(await isAnvilReachable());

describe.skipIf(shouldSkip)("next-block simulation (anvil E2E)", () => {
  let provider: ethers.JsonRpcProvider;
  let rpcManager: RpcProviderManager;
  let wallet: ethers.Wallet;
  let nextBlock: typeof NextBlock;
  let adapter: Adapter.EvmChainAdapter;

  // A raw request: ethers briefly caches getBlock("latest"), which returns the
  // block before one just mined.
  async function latestBlock(): Promise<{ number: number; timestamp: number }> {
    const raw = (await provider.send("eth_getBlockByNumber", [
      "latest",
      false,
    ])) as { number: string; timestamp: string };
    return { number: Number(raw.number), timestamp: Number(raw.timestamp) };
  }

  async function mineAt(timestamp: number): Promise<void> {
    await provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await provider.send("evm_mine", []);
  }

  // Mines a block SLOT seconds after latest, then locks until `unlockIn`
  // seconds after that new block.
  async function lockUntil(unlockIn: number): Promise<number> {
    const before = await latestBlock();
    if (!before) {
      throw new Error("no latest block");
    }
    await mineAt(before.timestamp + SLOT);
    const unlockAt = before.timestamp + SLOT + unlockIn;
    await provider.send("anvil_setStorageAt", [
      TIMELOCK,
      ethers.ZeroHash,
      ethers.zeroPadValue(ethers.toBeHex(unlockAt), 32),
    ]);
    return unlockAt;
  }

  beforeAll(async () => {
    vi.stubEnv("SAFE_FETCH_SHADOW", "true");
    const { getRpcProviderFromUrls } = await import(
      "@/lib/rpc/provider-factory"
    );
    nextBlock = await import("@/lib/web3/next-block-simulation");
    const { EvmChainAdapter } = await import("@/lib/web3/chain-adapter/evm");
    const { getGasStrategy } = await import("@/lib/web3/gas-strategy");
    // In-memory stand-in for the database-backed nonce lock.
    const nonceManager = {
      getNextNonce: (session: NonceSession): number => {
        const nonce = session.currentNonce;
        session.currentNonce += 1;
        return nonce;
      },
      recordTransaction: async (): Promise<void> => undefined,
      confirmTransaction: async (): Promise<void> => undefined,
    };
    adapter = new EvmChainAdapter(
      CHAIN_ID,
      getGasStrategy(),
      nonceManager as never
    );
    provider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
      staticNetwork: true,
    });
    rpcManager = await getRpcProviderFromUrls(
      ANVIL_URL,
      undefined,
      CHAIN_ID,
      "anvil-next-block"
    );
    wallet = new ethers.Wallet(ANVIL_PRIV_0, provider);
    await provider.send("evm_setIntervalMining", [0]);
    await provider.send("evm_setAutomine", [false]);
    await provider.send("anvil_setCode", [TIMELOCK, TIMELOCK_CODE]);
  });

  beforeEach(async () => {
    // A few SLOT-spaced blocks so the automatic offset has history.
    const latest = await latestBlock();
    let timestamp = latest?.timestamp ?? 0;
    for (let i = 0; i < 6; i += 1) {
      timestamp += SLOT;
      await mineAt(timestamp);
    }
  });

  // The compose anvil mines every second with automine off.
  afterAll(async () => {
    await provider.send("evm_setIntervalMining", [1]);
    provider.destroy();
    vi.unstubAllEnvs();
  });

  it("one block early: latest reverts, next-block passes and the tx lands in the next block", async () => {
    await lockUntil(SLOT - 5);
    const tx = {
      from: wallet.address,
      to: TIMELOCK,
      data: IFACE.encodeFunctionData("run"),
    };

    await expect(provider.call(tx)).rejects.toMatchObject({
      code: "CALL_EXCEPTION",
    });

    const result = await nextBlock.simulateSendAtNextBlock(rpcManager, {
      chainId: CHAIN_ID,
      tx,
      options: {},
    });
    const latest = await latestBlock();
    expect(result.simulation).toMatchObject({
      mode: "next-block",
      baseBlock: latest?.number,
      assumedBlockNumber: (latest?.number ?? 0) + 1,
      assumedTimestamp: (latest?.timestamp ?? 0) + SLOT,
      timestampOffsetSec: SLOT,
    });
    expect(["eth_estimateGas+blockOverrides", "eth_simulateV1"]).toContain(
      result.simulation.rpcMethod
    );
    const gasEstimate = result.gasEstimate;

    const sent = await wallet.sendTransaction({
      ...tx,
      gasLimit: (gasEstimate * BigInt(15)) / BigInt(10),
    });
    await mineAt((latest?.timestamp ?? 0) + SLOT);
    const receipt = await provider.getTransactionReceipt(sent.hash);
    expect(receipt?.status).toBe(1);
    expect(receipt?.blockNumber).toBe(result.simulation.assumedBlockNumber);

    // Estimated on the success path: within 10% of gas used, or at most the
    // ~27% pad above it when the gas came from eth_simulateV1.
    const used = Number(receipt?.gasUsed ?? 0);
    const ratio = Number(gasEstimate) / used;
    if (result.simulation.rpcMethod === "eth_simulateV1") {
      expect(ratio).toBeGreaterThanOrEqual(1);
      expect(ratio).toBeLessThanOrEqual(1.3);
    } else {
      expect(Math.abs(ratio - 1)).toBeLessThanOrEqual(0.1);
    }
  });

  it("two blocks early: both latest and next-block revert", async () => {
    await lockUntil(SLOT * 2 + 6);
    const tx = {
      from: wallet.address,
      to: TIMELOCK,
      data: IFACE.encodeFunctionData("run"),
    };

    await expect(provider.call(tx)).rejects.toMatchObject({
      code: "CALL_EXCEPTION",
    });
    await expect(
      nextBlock.simulateSendAtNextBlock(rpcManager, {
        chainId: CHAIN_ID,
        tx,
        options: {},
      })
    ).rejects.toMatchObject({ code: "CALL_EXCEPTION" });
  });

  it("a read says not yet at latest and yes at the next block", async () => {
    await lockUntil(SLOT - 5);
    const data = IFACE.encodeFunctionData("workable");

    const atLatest = await provider.call({ to: TIMELOCK, data });
    expect(IFACE.decodeFunctionResult("workable", atLatest)[0]).toBe(false);

    const { returnData } = await nextBlock.simulateCallAtNextBlock(rpcManager, {
      chainId: CHAIN_ID,
      tx: { to: TIMELOCK, data },
      options: {},
    });
    expect(IFACE.decodeFunctionResult("workable", returnData)[0]).toBe(true);
  });

  async function sessionFor(): Promise<NonceSession> {
    return {
      walletAddress: wallet.address,
      chainId: CHAIN_ID,
      executionId: "anvil-next-block",
      currentNonce: await provider.getTransactionCount(
        wallet.address,
        "pending"
      ),
      startedAt: new Date(),
    } as NonceSession;
  }

  function runCall(
    session: NonceSession
  ): ReturnType<Adapter.EvmChainAdapter["executeContractCall"]> {
    return adapter.executeContractCall(
      wallet,
      {
        contractAddress: TIMELOCK,
        abi: ["function run()"],
        functionKey: "run",
        args: [],
      },
      session,
      { gasOverrides: {}, rpcManager, simulation: {} }
    );
  }

  it("the Write Contract send path sends one block early and lands in the predicted block", async () => {
    await lockUntil(SLOT - 5);
    const latest = await latestBlock();
    const session = await sessionFor();
    const nonce = session.currentNonce;

    const sending = runCall(session);
    // Mine the next block once the transaction is in the pool.
    for (let i = 0; i < 100; i += 1) {
      if (
        (await provider.getTransactionCount(wallet.address, "pending")) > nonce
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await mineAt((latest?.timestamp ?? 0) + SLOT);
    const receipt = await sending;

    expect(receipt.blockNumber).toBe((latest?.number ?? 0) + 1);
    expect(receipt.simulation).toMatchObject({
      baseBlock: latest?.number,
      assumedBlockNumber: (latest?.number ?? 0) + 1,
      timestampOffsetSec: SLOT,
    });
    const onChain = await provider.getTransactionReceipt(receipt.hash);
    expect(onChain?.status).toBe(1);
  });

  it("the Write Contract send path sends nothing two blocks early", async () => {
    await lockUntil(SLOT * 2 + 6);
    const session = await sessionFor();
    const nonce = session.currentNonce;

    await expect(runCall(session)).rejects.toMatchObject({
      code: "CALL_EXCEPTION",
    });
    expect(await provider.getTransactionCount(wallet.address, "pending")).toBe(
      nonce
    );
  });
});
