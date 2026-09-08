import "server-only";

import { getErrorMessage } from "@/lib/utils";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";

/**
 * Resolves the organization's Solana signer and address, mapping any
 * initialization failure into the `{ error }` result shape the Solana
 * write-step cores return. Shared by the Solana transaction step cores.
 */
export async function resolveWallet(
  organizationId: string
): Promise<
  { signer: SolanaTransactionSigner; address: string } | { error: string }
> {
  try {
    return await initializeSolanaWallet(organizationId);
  } catch (error) {
    return {
      error: `Failed to initialize Solana wallet: ${getErrorMessage(error)}`,
    };
  }
}
