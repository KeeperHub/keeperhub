import { PublicKey } from "@solana/web3.js";
import { ethers } from "ethers";
import { isSolanaChain } from "@/lib/rpc/provider-factory";

// Lives in a leaf module with no @solana/web3.js or ethers import so bundles
// that forbid Node modules can reach it; re-exported here so callers of this
// module do not move.
export { validateChainTxHash } from "./validate-chain-tx-hash";

/**
 * Validates an address against the format the chain actually uses: base58
 * for Solana, 0x-hex for EVM. A chain-agnostic address check rejects valid
 * input from the "other" family, so callers must resolve chainId before
 * validating - see check-balance.ts for the reference pattern this mirrors.
 */
export function validateChainAddress(
  address: string,
  chainId: number
): boolean {
  if (isSolanaChain(chainId)) {
    try {
      // Throws on non-base58 / wrong-length input.
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }
  return ethers.isAddress(address);
}

/**
 * Guard for actions that only understand EVM (ABI-decoded logs/calls have no
 * Solana equivalent). Returns a ready-to-return failure result for a Solana
 * chainId, or null when the chain is fine - shared so the guard condition and
 * message live in one place instead of being copy-pasted per action.
 */
export function evmOnlyGuard(
  chainId: number
): { success: false; error: string } | null {
  return isSolanaChain(chainId)
    ? { success: false, error: "Solana is not supported for this action yet" }
    : null;
}
