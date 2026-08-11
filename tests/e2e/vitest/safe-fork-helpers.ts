/**
 * Helpers shared by the orchestrator-on-anvil-fork tests.
 *
 * Connects to the `test-anvil-fork-mainnet` docker service (anvil
 * --fork-url Ethereum mainnet, localhost:8548) and exposes:
 *
 *   - `getFork()` - JsonRpcProvider + funded test wallet
 *   - `isForkReachable()` - skip-detection for environments without infra
 *   - `deployFreshSafe(wallet)` - raw Safe deployment via SafeProxyFactory
 *
 * Used only by the integration tests; nothing here ships to production.
 */

import { ethers } from "ethers";
import {
  buildCreateProxyCalldata,
  buildSetupCalldata,
  parseProxyCreationEvent,
} from "@/lib/safe/address";
import {
  getSafeContracts,
  getSafeSingletonForDeploy,
} from "@/lib/safe/contracts";

export const MAINNET_CHAIN_ID = 1;
// The local anvil mainnet fork. Deliberately not env-overridable with
// ANVIL_FORK_MAINNET_URL: in CI that secret is the live archive upstream,
// and pointing these write-heavy tests at it would probe (and attempt to
// transact against) real mainnet instead of the fork.
export const FORK_URL = "http://localhost:8548";

// Anvil's first deterministic account (mnemonic-derived). Used as the Safe
// owner across all fork tests so derivation is reproducible.
export const ANVIL_PRIV_0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export type ForkContext = {
  provider: ethers.JsonRpcProvider;
  wallet: ethers.Wallet;
  ownerAddress: string;
};

export function getFork(): ForkContext {
  const provider = new ethers.JsonRpcProvider(FORK_URL, MAINNET_CHAIN_ID, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(ANVIL_PRIV_0, provider);
  return {
    provider,
    wallet,
    ownerAddress: wallet.address,
  };
}

export async function isForkReachable(): Promise<boolean> {
  try {
    const response = await fetch(FORK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_chainId",
        id: 1,
      }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { result?: string };
    return body.result === `0x${MAINNET_CHAIN_ID.toString(16)}`;
  } catch {
    return false;
  }
}

/**
 * Deploy a fresh Safe owned by `wallet` (threshold = 1) on the fork.
 *
 * Uses the canonical Safe contracts on Ethereum mainnet (proxyFactory +
 * compatibilityFallbackHandler; code presence at the canonical CREATE2
 * addresses verified on a mainnet fork 2026-07-07) and the same calldata
 * builders the production deployer uses, so a successful deploy here
 * proves those builders agree with on-chain Safe v1.4.1 bytes.
 * `saltNonce` is randomised per call so consecutive tests get distinct
 * Safe addresses.
 */
export async function deployFreshSafe(
  wallet: ethers.Wallet
): Promise<{ safeAddress: string; saltNonce: bigint }> {
  const contracts = getSafeContracts(MAINNET_CHAIN_ID);
  const singleton = getSafeSingletonForDeploy(MAINNET_CHAIN_ID);
  const initializer = buildSetupCalldata({
    owners: [wallet.address],
    threshold: 1,
    fallbackHandler: contracts.compatibilityFallbackHandler,
  });
  // Random salt nonce so tests can deploy multiple distinct Safes in one
  // session without collisions; the production path uses a deterministic
  // org-derived salt but tests don't need reproducibility across runs.
  const saltNonce = BigInt(
    `0x${ethers.hexlify(ethers.randomBytes(16)).slice(2)}`
  );
  const calldata = buildCreateProxyCalldata({
    singleton,
    initializer,
    saltNonce,
  });

  const tx = await wallet.sendTransaction({
    to: contracts.proxyFactory,
    data: calldata,
    chainId: MAINNET_CHAIN_ID,
  });
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Safe deployment receipt missing");
  }
  const safeAddress = parseProxyCreationEvent(receipt, contracts.proxyFactory);
  return { safeAddress, saltNonce };
}
