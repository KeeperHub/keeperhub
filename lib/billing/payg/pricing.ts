import "server-only";

import { usdcDecimalToRaw } from "./usdc";

/**
 * Per-execution PAYG price in USDC 6-decimal raw units, read only from env
 * (`PAYG_EXECUTION_PRICE_USDC`, a decimal string). Returns 0n when unset or
 * malformed, which the caller treats as "not configured".
 */
export function getPaygExecutionPriceRaw(): bigint {
  return usdcDecimalToRaw(process.env.PAYG_EXECUTION_PRICE_USDC ?? "");
}
