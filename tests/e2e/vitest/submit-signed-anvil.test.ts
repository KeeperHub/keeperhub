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

import { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getRpcProviderFromUrls } from "@/lib/rpc/provider-factory";
import type { RpcProviderManager } from "@/lib/rpc/providers";
import {
  NonceConflictError,
  submitSignedTransactionWithFailover,
} from "@/lib/web3/submit-signed";

const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8546";
// 127.0.0.1:1 is the IANA TCP port 0 reserved range -- guaranteed
// connection-refused, making it a deterministic "dead primary" target.
const DEAD_PRIMARY_URL = "http://127.0.0.1:1";
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
        DEAD_PRIMARY_URL,
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

    // Three failover rounds against the dead primary (broadcast + two
    // reconcile probes) burn the default retry budget before each falls
    // over to the live fallback, so this test needs a longer timeout
    // than the vitest default.
    it("throws NonceConflictError when re-using a consumed nonce with different bytes", {
      timeout: 90_000,
    }, async () => {
      // First broadcast at nonce N. After this lands, nonce N is consumed.
      const consumedNonce = await fallbackProvider.getTransactionCount(
        wallet.address,
        "pending"
      );
      const firstTx = await buildFundedTxRequest(
        ethers.parseEther("0.0005"),
        consumedNonce
      );
      const firstResult = await submitSignedTransactionWithFailover(
        wallet,
        firstTx,
        rpcManager
      );
      const firstReceipt = await fallbackProvider.waitForTransaction(
        firstResult.hash
      );
      expect(firstReceipt?.status).toBe(1);

      // Second broadcast at the SAME nonce but DIFFERENT value -> different
      // signature -> different hash. Anvil rejects with "nonce too low".
      // The helper's reconcile probes for OUR hash (not the first tx's),
      // finds neither receipt nor mempool entry, and throws.
      const secondTx = await buildFundedTxRequest(
        ethers.parseEther("0.0007"),
        consumedNonce
      );

      await expect(
        submitSignedTransactionWithFailover(wallet, secondTx, rpcManager)
      ).rejects.toBeInstanceOf(NonceConflictError);
    });
  }
);
