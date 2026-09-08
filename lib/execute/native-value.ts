import "server-only";

import { ethers } from "ethers";

export type ReservedValue =
  | { ok: true; valueWei: string }
  | { ok: false; error: string };

/**
 * Native decimals by chain family. EVM natives are 18; SOL is 9 (1 SOL =
 * 1e9 lamports).
 */
export const EVM_NATIVE_DECIMALS = 18;
export const SOLANA_NATIVE_DECIMALS = 9;

/**
 * Native notional value (in wei) an execution will move, used by the per-org
 * daily spending cap. Parses a human-decimal ETH amount (e.g. "1.5") the same
 * way the web3 cores do (`ethers.parseEther`).
 *
 * An absent/empty amount reserves "0". Only native value is counted today;
 * ERC-20 token amounts are not yet priced into the cap, so token-only transfers
 * pass "0" directly rather than calling this.
 *
 * Malformed amounts return `{ ok: false }` so the caller can decide (the direct
 * routes reject with 400; the workflow wrapper reserves 0 and lets the core's
 * own validation surface the canonical error). Negative amounts are rejected
 * too: `ethers.parseEther("-5")` yields a negative BigInt (it does not throw),
 * and a negative reservation would lower the day's SUM and bank credit against
 * the cap.
 */
export function parseNativeValueWei(
  rawAmount: string | undefined | null
): ReservedValue {
  if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
    return { ok: true, valueWei: "0" };
  }

  let parsed: bigint;
  try {
    parsed = ethers.parseEther(rawAmount);
  } catch {
    return { ok: false, error: `Invalid value amount: ${rawAmount}` };
  }

  if (parsed < BigInt(0)) {
    return {
      ok: false,
      error: `Value amount must not be negative: ${rawAmount}`,
    };
  }

  return { ok: true, valueWei: parsed.toString() };
}

/**
 * Native notional value in LAMPORTS a Solana execution will move, used by the
 * per-org daily Solana cap (`organizationSpendCaps.dailySolanaValueCapLamports`).
 *
 * Parses a human-decimal SOL amount (e.g. "1.5") at SOL's true 9 decimals
 * rather than reusing `parseNativeValueWei`, whose `ethers.parseEther` is fixed
 * at 18. Charging SOL on an 18-decimal scale was only ever a workaround for
 * having a single wei-denominated cap; with a dedicated lamports cap the
 * accurate unit is both correct and safe.
 *
 * Mirrors `parseNativeValueWei`'s contract exactly: absent/empty reserves "0",
 * malformed returns `{ ok: false }` for the caller to decide, and negatives are
 * rejected (a negative reservation would lower the day's SUM and bank credit
 * against the cap).
 */
export function parseNativeValueLamports(
  rawAmount: string | undefined | null
): ReservedValue {
  if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
    return { ok: true, valueWei: "0" };
  }

  let parsed: bigint;
  try {
    parsed = ethers.parseUnits(rawAmount, SOLANA_NATIVE_DECIMALS);
  } catch {
    return { ok: false, error: `Invalid value amount: ${rawAmount}` };
  }

  if (parsed < BigInt(0)) {
    return {
      ok: false,
      error: `Value amount must not be negative: ${rawAmount}`,
    };
  }

  return { ok: true, valueWei: parsed.toString() };
}
