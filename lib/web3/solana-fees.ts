import "server-only";

/**
 * Solana base transaction fee: 5000 lamports per signature.
 *
 * Reserved on top of the transfer amount in Solana balance preflights. Without
 * it a max-balance transfer passes preflight and then fails at inclusion for
 * not covering its own fee.
 *
 * This assumes a single signature, which holds for the transfers that use it:
 * the organization wallet is both fee payer and transfer authority, and
 * creating an associated token account needs no additional signer. A future
 * multi-signer path must multiply by the signature count.
 */
export const SOLANA_BASE_FEE_LAMPORTS = BigInt(5000);

/**
 * Rent-exempt minimum reserved for a new associated token account.
 * Covers TOKEN_PROGRAM (~2,039,280 lamports) and TOKEN-2022 ImmutableOwner
 * overhead. Used for org spend-cap reservation before an SPL transfer runs.
 *
 * The reservation is made without a chain read, so this is a fixed figure
 * rather than the mint's true rent, and a Token-2022 mint carrying enough
 * extensions can need more. transfer-spl-token-core reads the real rent once it
 * has the mint and refuses the transfer when it exceeds what was reserved, so
 * this is an enforced ceiling rather than an estimate that can be overspent.
 */
export const SOLANA_ATA_RENT_LAMPORTS = BigInt(2_100_000);

/** Worst-case SOL cost for an SPL transfer: base fee plus new ATA rent. */
export const SOLANA_SPL_MAX_FEE_LAMPORTS =
  SOLANA_BASE_FEE_LAMPORTS + SOLANA_ATA_RENT_LAMPORTS;

const MICRO_LAMPORTS_PER_LAMPORT = BigInt(1_000_000);

/**
 * Total lamport fee for a confirmed Solana transaction: base signature fee
 * plus the priority fee (compute units consumed x micro-lamports per CU).
 */
export function computeSolanaLamportFee(
  computeUnits: bigint,
  priorityFeeMicroLamports: bigint
): bigint {
  const priorityLamports =
    computeUnits > BigInt(0) && priorityFeeMicroLamports > BigInt(0)
      ? (computeUnits * priorityFeeMicroLamports) / MICRO_LAMPORTS_PER_LAMPORT
      : BigInt(0);
  return SOLANA_BASE_FEE_LAMPORTS + priorityLamports;
}
