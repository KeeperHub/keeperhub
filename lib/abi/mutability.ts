/**
 * Derive the stateMutability of a named function from an ABI JSON string.
 *
 * Fails closed: returns "nonpayable" on any parse/lookup failure so that
 * payable-gated UI (e.g. the payable value field) stays hidden when the
 * ABI is malformed or the function cannot be located. Server-side callers
 * should re-check mutability against the parsed ABI before sending native
 * value -- this helper is intended for UI gating and lightweight checks,
 * not as the sole authority on whether a transfer is safe.
 */
import { type AbiItem, findAbiFunction } from "@/lib/abi/utils";

export function deriveStateMutability(
  abiJson: string,
  funcKey: string
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(abiJson);
  } catch {
    return "nonpayable";
  }

  if (!Array.isArray(parsed)) {
    return "nonpayable";
  }

  const func = findAbiFunction(parsed as AbiItem[], funcKey);

  return typeof func?.stateMutability === "string"
    ? func.stateMutability
    : "nonpayable";
}
