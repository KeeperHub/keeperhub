/**
 * E2E test for submitSignedTransactionWithFailover against a local anvil.
 *
 * Exercises the helper's two load-bearing properties end-to-end against a
 * real EVM:
 *
 *   1. Failover: a dead primary RPC is paired with a healthy anvil
 *      fallback. The same signed bytes broadcast on the fallback land
 *      on-chain. The signature (and therefore the hash) does NOT change
 *      between the failed primary attempt and the fallback attempt.
 *
 *   2. Nonce-conflict reconcile: re-broadcasting a different tx with a
 *      nonce that was already consumed yields a NonceConflictError after
 *      the helper's on-chain lookup confirms our hash is nowhere to be
 *      found.
 *
 * Prerequisites: docker compose --profile test up -d test-anvil
 * (Foundry anvil on localhost:8546, chain-id 31337.)
 *
 * Skipped when SKIP_INFRA_TESTS=true or when the anvil port is not
 * reachable, so CI without infra does not fail this file.
 */

import { type AddressInfo, createServer } from "node:net";
import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import { isOnChainPendingError } from "@/lib/web3/onchain-revert";
import {
  NonceConflictError,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8546";
// A port just freed: a deterministic ECONNREFUSED "dead primary". The RPC path
// follows no redirect, so the refusal means nothing was sent there.
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return `http://127.0.0.1:${port}`;
}
const CHAIN_ID = 31_337;

// First two anvil default accounts (deterministic mnemonic).
const ANVIL_PRIV_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDR_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

async function isAnvilReachable(): Promise<boolean> {
  try {
    const response = await fetch(ANVIL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        id: 1,
      }),
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { result?: string };
    return body.result === `0x${CHAIN_ID.toString(16)}`;
  } catch {
    return false;
  }
}

const skipForCi = process.env.SKIP_INFRA_TESTS === "true";
const anvilUp = skipForCi ? false : await isAnvilReachable();
const shouldSkip = skipForCi || !anvilUp;

describe.skipIf(shouldSkip)(
  "submitSignedTransactionWithFailover (anvil E2E)",
  () => {
    let rpcManager: RpcProviderManager;
    let fallbackProvider: ethers.JsonRpcProvider;
    let wallet: ethers.Wallet;

    beforeAll(async () => {
      rpcManager = await getRpcProviderFromUrls(
        await closedPortUrl(),
        ANVIL_URL,
        CHAIN_ID,
        "anvil-test"
      );
      // Wallet stays connected to the healthy fallback so the unrelated
      // populateTransaction-time chainId/network lookups never hit the
      // dead primary; the broadcast itself still goes through rpcManager.
      fallbackProvider = new ethers.JsonRpcProvider(ANVIL_URL, CHAIN_ID, {
        staticNetwork: true,
      });
      wallet = new ethers.Wallet(ANVIL_PRIV_0, fallbackProvider);
    });

    afterAll(() => {
      fallbackProvider.destroy();
    });

    async function buildFundedTxRequest(
      value: bigint,
      nonceOverride?: number
    ): Promise<ethers.TransactionRequest> {
      const nonce =
        nonceOverride ??
        (await fallbackProvider.getTransactionCount(wallet.address, "pending"));
      return {
        to: ANVIL_ADDR_1,
        value,
        nonce,
        gasLimit: BigInt(21_000),
        maxFeePerGas: ethers.parseUnits("2", "gwei"),
        maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
        chainId: CHAIN_ID,
        type: 2,
      };
    }

    it("falls over from a dead primary to a healthy fallback and lands the tx on-chain", {
      timeout: 30_000,
    }, async () => {
      const txRequest = await buildFundedTxRequest(ethers.parseEther("0.001"));
      // Capture the hash we expect *before* the helper runs, so we can
      // assert the signed bytes are byte-identical to what reached chain.
      const expectedHash = ethers.Transaction.from(
        await wallet.signTransaction(txRequest)
      ).hash;

      const result = await submitSignedTransactionWithFailover(
        wallet,
        txRequest,
        rpcManager
      );

      expect(result.hash).toBe(expectedHash);
      expect(result.preExistingReceipt).toBeUndefined();

      const receipt = await fallbackProvider.waitForTransaction(result.hash);
      expect(receipt).toBeTruthy();
      expect(receipt?.status).toBe(1);
      expect(receipt?.to?.toLowerCase()).toBe(ANVIL_ADDR_1.toLowerCase());
    });

    // Re-uses a consumed nonce with different bytes; anvil answers "nonce too low".
    async function sendOnConsumedNonce(
      manager: RpcProviderManager
    ): Promise<{ error: unknown; expectedHash: string }> {
      const consumedNonce = await fallbackProvider.getTransactionCount(
        wallet.address,
        "pending"
      );
      const firstTx = await buildFundedTxRequest(
        ethers.parseEther("0.0005"),
        consumedNonce
      );
      const first = await (await wallet.sendTransaction(firstTx)).wait();
      expect(first?.status).toBe(1);

      const secondTx = await buildFundedTxRequest(
        ethers.parseEther("0.0007"),
        consumedNonce
      );
      const expectedHash = ethers.keccak256(
        await wallet.signTransaction(secondTx)
      );
      try {
        await submitSignedTransactionWithFailover(wallet, secondTx, manager);
      } catch (error) {
        return { error, expectedHash };
      }
      throw new Error("expected the send to fail");
    }

    it("throws NonceConflictError when re-using a consumed nonce with different bytes", {
      timeout: 30_000,
    }, async () => {
      // A different signature means a different hash: the reconcile finds
      // neither receipt nor mempool entry for OUR hash and throws.
      const healthyOnly = await getRpcProviderFromUrls(
        ANVIL_URL,
        undefined,
        CHAIN_ID,
        "anvil-test-healthy"
      );
      const { error } = await sendOnConsumedNonce(healthyOnly);
      expect(error).toBeInstanceOf(NonceConflictError);
    });

    // The dead primary refused the connection, so it holds nothing: the real
    // conflict is reported. Each failover round first burns the retry budget
    // on the dead primary, hence the longer timeout.
    it("throws NonceConflictError on a nonce conflict after a dead primary", {
      timeout: 90_000,
    }, async () => {
      const { error } = await sendOnConsumedNonce(rpcManager);
      expect(error).toBeInstanceOf(NonceConflictError);
      expect(isOnChainPendingError(error)).toBe(false);
    });
  }
);
