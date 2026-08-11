import "server-only";

import { ethers } from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "@/lib/explorer/proxy-detection";

/**
 * Reads the EIP-1967 implementation storage slot from a proxy contract and
 * returns the checksummed implementation address.
 *
 * Returns null when the slot is unset (zero address), indicating the contract
 * is not an EIP-1967 proxy.
 *
 * The `provider` parameter accepts any object with a `getStorage` method.
 * Standard usage: pass the result of `rpcManager.getProvider()`.
 *
 * Note: static ABIs are used in the hot scan path for known protocols (Aave
 * V3 Pool, Lido) — no block-explorer fetch in latency-sensitive code. This
 * helper is for correctness checks and the EIP-1967 unit test scaffold
 * (SCAN-07), not for per-request resolution during scanning.
 */
export async function resolveImplementationAddress(
  contractAddress: string,
  provider: { getStorage(address: string, slot: string): Promise<string> }
): Promise<string | null> {
  const storageValue = await provider.getStorage(
    contractAddress,
    EIP1967_IMPLEMENTATION_SLOT
  );

  const hexValue = storageValue.startsWith("0x")
    ? storageValue.slice(2)
    : storageValue;

  if (hexValue.length < 40) {
    return null;
  }

  try {
    // Storage is 32 bytes; the address occupies the last 20 bytes (40 hex chars).
    const address = ethers.getAddress(`0x${hexValue.slice(-40)}`);
    if (address && address !== ethers.ZeroAddress) {
      return address;
    }
  } catch {
    return null;
  }

  return null;
}
