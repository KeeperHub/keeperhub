import "server-only";

import type { PublicKey } from "@solana/web3.js";
import { parseNativeValueLamports } from "@/lib/execute/native-value";

export const MAX_SOL_REQUIRED_ERROR =
  "maxSol is required for this action: declare the maximum SOL the transaction may move so it can be charged against the organization's daily Solana value cap";

/**
 * Parses a required maxSol field into lamports for arbitrary instruction actions.
 */
export function parseRequiredMaxSolLamports(
  maxSol: string | undefined
): { lamports: bigint } | { error: string } {
  const declared = typeof maxSol === "string" ? maxSol.trim() : "";
  if (declared === "") {
    return { error: MAX_SOL_REQUIRED_ERROR };
  }
  const parsed = parseNativeValueLamports(declared);
  if (!parsed.ok) {
    return { error: parsed.error };
  }
  return { lamports: BigInt(parsed.valueWei) };
}

/**
 * Lamports the fee payer lost in a successful simulation (pre minus post).
 * Returns 0 when the payer's balance did not decrease.
 */
export function computeFeePayerLamportsOutflow(args: {
  feePayer: PublicKey;
  accountKeys: PublicKey[];
  preBalances: number[];
  postBalances: number[];
}): bigint {
  const index = args.accountKeys.findIndex((key) => key.equals(args.feePayer));
  if (index === -1) {
    throw new Error(
      "[Solana maxSol] Fee payer not found in simulation account list"
    );
  }

  const pre = BigInt(args.preBalances[index] ?? 0);
  const post = BigInt(args.postBalances[index] ?? 0);
  if (pre <= post) {
    return BigInt(0);
  }
  return pre - post;
}

/**
 * Rejects when the simulated outflow exceeds the declared maxSol ceiling.
 */
export function assertMaxSolLamportsOutflow(args: {
  outflowLamports: bigint;
  maxSolLamports: bigint;
}): void {
  if (args.outflowLamports > args.maxSolLamports) {
    throw new Error(
      `Transaction would move ${args.outflowLamports.toString()} lamports, exceeding declared maxSol ceiling of ${args.maxSolLamports.toString()}`
    );
  }
}
