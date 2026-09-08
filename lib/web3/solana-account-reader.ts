import "server-only";

import { type AccountInfo, PublicKey } from "@solana/web3.js";
import { getChainIdFromNetwork } from "@/lib/rpc/network-utils";
import { isSolanaChain } from "@/lib/rpc/provider-factory";
import { getErrorMessage } from "@/lib/utils";
import { getChainAdapter } from "@/lib/web3/chain-adapter";
import type { SolanaChainAdapter } from "@/lib/web3/chain-adapter/solana";

export function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/**
 * Type guard shared by the Solana step cores and IDL helpers for validating
 * user-supplied JSON payloads before property access.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Resolves a network + base58 address into a Solana chain adapter and pubkey.
 * Shared by the read-solana-account and read-solana-program-anchor steps.
 */
export function resolveSolanaAccountAddress(
  network: string,
  address: string
):
  | { chainId: number; adapter: SolanaChainAdapter; pubkey: PublicKey }
  | { error: string } {
  let chainId: number;
  try {
    chainId = getChainIdFromNetwork(network);
  } catch (error) {
    return { error: getErrorMessage(error) };
  }

  if (!isSolanaChain(chainId)) {
    return { error: `Only supported on Solana networks, got: ${network}` };
  }

  const pubkey = parsePublicKey(address);
  if (!pubkey) {
    return { error: `Invalid Solana address: ${address}` };
  }

  return {
    chainId,
    adapter: getChainAdapter(chainId) as SolanaChainAdapter,
    pubkey,
  };
}

/**
 * Fetches raw account info via the chain's RPC failover. A null accountInfo
 * means the account does not exist - that is a valid outcome, not an error.
 */
export async function fetchSolanaAccountInfo(
  adapter: SolanaChainAdapter,
  pubkey: PublicKey
): Promise<{ accountInfo: AccountInfo<Buffer> | null } | { error: string }> {
  try {
    const accountInfo = await adapter.executeWithSolanaFailover(
      (connection) => connection.getAccountInfo(pubkey, "confirmed"),
      "read"
    );
    return { accountInfo };
  } catch (error) {
    return { error: `Failed to read account: ${getErrorMessage(error)}` };
  }
}
