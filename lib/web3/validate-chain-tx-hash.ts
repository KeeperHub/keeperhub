/**
 * Transaction hash/signature validation, split out of validate-chain-address
 * (which re-exports it, so callers keep their import path).
 *
 * validateChainAddress needs @solana/web3.js's PublicKey and ethers; this
 * check needs neither, only a base58 decode and a length. Keeping them apart
 * matters because the Workflow DevKit compiles lib/workflow/executor into a
 * workflow-function bundle where Node modules are forbidden, and the
 * executor's transaction-hash guard needs this check. bs58 and base-x
 * underneath it are pure ESM over Uint8Array with no Node builtins, so they
 * survive that bundler. Do not add an import here that would not.
 */
import bs58 from "bs58";
import { isSolanaChain } from "@/lib/rpc/solana-chains";

const EVM_TX_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const SOLANA_SIGNATURE_BYTE_LENGTH = 64;

/**
 * Validates a transaction hash/signature against the chain's format: a
 * 64-byte base58 signature for Solana, a 32-byte 0x-hex hash for EVM.
 */
export function validateChainTxHash(hash: string, chainId: number): boolean {
  if (isSolanaChain(chainId)) {
    try {
      return bs58.decode(hash).length === SOLANA_SIGNATURE_BYTE_LENGTH;
    } catch {
      return false;
    }
  }
  return EVM_TX_HASH_PATTERN.test(hash);
}
