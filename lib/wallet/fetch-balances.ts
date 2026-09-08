/**
 * Helpers for formatting wallet balances. Live RPC fetching used to happen
 * here; balance fetching now lives server-side in `/api/user/wallet/balances`
 * so provider URLs (and embedded API keys) never reach the browser.
 */

const MAX_DISPLAY_BALANCE = BigInt("1000000000000"); // 1 trillion
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const BIGINT_FIVE = BigInt(5);
const BIGINT_TEN = BigInt(10);

/**
 * Format a BigInt wei value to a decimal string with proper precision.
 * Handles arbitrarily large values without JavaScript Number precision loss.
 *
 * @param weiValue - The balance in wei as BigInt
 * @param decimals - Number of decimals (18 for ETH, varies for tokens)
 * @param displayDecimals - Number of decimal places to show in output (default 6)
 * @returns Formatted balance string, or "0.000000" for testnet mock balances
 */
export function formatWeiToBalance(
  weiValue: bigint,
  decimals: number,
  displayDecimals = 6
): string {
  if (weiValue === BIGINT_ZERO) {
    return `0.${"0".repeat(displayDecimals)}`;
  }

  const divisor = BIGINT_TEN ** BigInt(decimals);
  const wholePart = weiValue / divisor;

  // Testnet mock balances (unrealistically large values) are not meaningful
  if (wholePart > MAX_DISPLAY_BALANCE) {
    return `0.${"0".repeat(displayDecimals)}`;
  }

  const remainder = weiValue % divisor;
  const scaleFactor = BIGINT_TEN ** BigInt(displayDecimals + 1);
  const scaledFraction = (remainder * scaleFactor) / divisor;

  const roundedFraction = (scaledFraction + BIGINT_FIVE) / BIGINT_TEN;

  const maxFraction = BIGINT_TEN ** BigInt(displayDecimals);
  let finalWhole = wholePart;
  let finalFraction = roundedFraction;

  if (finalFraction >= maxFraction) {
    finalWhole += BIGINT_ONE;
    finalFraction = BIGINT_ZERO;
  }

  const fractionStr = finalFraction.toString().padStart(displayDecimals, "0");

  return `${finalWhole}.${fractionStr}`;
}
