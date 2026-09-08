import "server-only";

import {
  type Mint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from "@solana/spl-token";
import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { getErrorMessage } from "@/lib/utils";

/** True for the legacy SPL Token program or Token-2022 (Token Extensions). */
export function isSolanaTokenProgram(programId: PublicKey): boolean {
  return (
    programId.equals(TOKEN_PROGRAM_ID) ||
    programId.equals(TOKEN_2022_PROGRAM_ID)
  );
}

/**
 * Parses an already-fetched mint account, resolving which token program owns
 * it (legacy SPL Token or Token-2022) so callers don't hardcode TOKEN_PROGRAM_ID
 * and silently reject Token-2022 mints (transfer-fee, confidential-transfer,
 * interest-bearing).
 *
 * Deliberately takes the account info rather than a Connection: the RPC read
 * and its failover/retry policy belong to the caller (some retry via a
 * SolanaChainAdapter's executeWithSolanaFailover, some don't), while parsing
 * a fetched account is synchronous and must never be retried - unpackMint
 * throwing means the data is malformed, not that the network blipped.
 */
export function parseSolanaMintAccount(
  mintPubkey: PublicKey,
  mintInfo: AccountInfo<Buffer>
): { mint: Mint; programId: PublicKey } | { error: string } {
  const programId = mintInfo.owner;
  if (!isSolanaTokenProgram(programId)) {
    return {
      error: `${mintPubkey.toBase58()} is not an SPL token mint (owned by ${programId.toBase58()})`,
    };
  }

  try {
    return { mint: unpackMint(mintPubkey, mintInfo, programId), programId };
  } catch (error) {
    return {
      error: `${mintPubkey.toBase58()} is not a valid SPL mint: ${getErrorMessage(error)}`,
    };
  }
}
