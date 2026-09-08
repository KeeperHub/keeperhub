import "server-only";

import { eq } from "drizzle-orm";
import { ethers } from "ethers";
import { db } from "@/lib/db";
import { chains } from "@/lib/db/schema";

/**
 * Native-balance helpers shared by the broadcast preflight
 * (transfer-funds-core) and the read-only simulator (lib/execute/simulate).
 *
 * Both paths answer the same question — "does the funding address hold
 * enough native currency for this transfer?" — and both have to phrase the
 * answer for a caller who cannot see the chain. Keeping the wording in one
 * place stops the dry run and the broadcast from drifting apart.
 *
 * Scope: the question is about the transfer value only. Neither caller adds
 * gas to the requirement, so a wallet holding exactly `value` still cannot
 * pay `value + gas * price` and is not reported as short by either path.
 */

/** Machine-readable `code` for a native-currency shortfall. */
export const INSUFFICIENT_BALANCE_CODE = "insufficient_balance";

/**
 * The chain's native symbol ("ETH", "BNB", "POL"), read from the seeded
 * `chains` table.
 *
 * Falls back to the chain-agnostic "native" when the chain is unknown or the
 * lookup fails: this only ever runs on an error path, so a database blip must
 * degrade the message rather than replace the real failure with its own.
 */
export async function getNativeSymbol(chainId: number): Promise<string> {
  try {
    const chainRow = await db
      .select({ symbol: chains.symbol })
      .from(chains)
      .where(eq(chains.chainId, chainId))
      .limit(1);
    return chainRow[0]?.symbol ?? "native";
  } catch {
    return "native";
  }
}

export type NativeShortfall = {
  code: typeof INSUFFICIENT_BALANCE_CODE;
  /** Funding address' native balance, in wei. */
  balanceWei: string;
  /** Native value the transfer would move, in wei. */
  requiredWei: string;
  /** requiredWei - balanceWei, in wei. Always > 0. */
  shortfallWei: string;
  nativeSymbol: string;
  /** Human-readable message; safe to surface to an API caller verbatim. */
  message: string;
};

/**
 * Describe a native-balance shortfall.
 *
 * `holder` is optional so the broadcast preflight keeps its existing wording
 * byte-for-byte. When supplied (the simulator does), the message also names
 * the address to fund and how much it is short — the two things a headless
 * caller needs and cannot look up from an error string.
 */
export function describeNativeShortfall(input: {
  symbol: string;
  balance: bigint;
  required: bigint;
  holder?: string;
}): NativeShortfall {
  const shortfall = input.required - input.balance;
  const have = ethers.formatEther(input.balance);
  const need = ethers.formatEther(input.required);
  const base = `Insufficient ${input.symbol} balance. Have: ${have}, Need: ${need}`;
  const message = input.holder
    ? `${base}. Fund ${input.holder} with at least ${ethers.formatEther(shortfall)} ${input.symbol} on this chain and retry.`
    : base;

  return {
    code: INSUFFICIENT_BALANCE_CODE,
    balanceWei: input.balance.toString(),
    requiredWei: input.required.toString(),
    shortfallWei: shortfall.toString(),
    nativeSymbol: input.symbol,
    message,
  };
}
