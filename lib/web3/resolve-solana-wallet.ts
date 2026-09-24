import "server-only";

import { getErrorMessage } from "@/lib/utils";
import type { SolanaTransactionSigner } from "@/lib/web3/chain-adapter/types";
import { initializeSolanaWallet } from "@/lib/web3/wallet-helpers";

/**
 * Resolves the organization's Solana signer and address, mapping any
 * initialization failure into the `{ error }` result shape the Solana
 * write-step cores return. Shared by the Solana transaction step cores.
 *
 * `chainId` decides which chain a policy rule is judged against, so a caller
 * that knows it should say so rather than let the default stand for devnet.
 */
export async function resolveWallet(
  organizationId: string,
  chainId?: number
): Promise<
  { signer: SolanaTransactionSigner; address: string } | { error: string }
> {
  try {
    return await initializeSolanaWallet(organizationId, chainId);
  } catch (error) {
    return {
      error: `Failed to initialize Solana wallet: ${getErrorMessage(error)}`,
    };
  }
}
