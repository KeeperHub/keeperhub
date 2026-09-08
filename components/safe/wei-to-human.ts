const TRAILING_ZEROS_REGEX = /0+$/;
const TRAILING_DOT_REGEX = /\.$/;

/**
 * Convert a wei-denominated amount to its human form using the token's
 * declared decimals, dropping trailing zeros so "1.000000" renders as "1".
 * On unparseable input the raw string is returned unchanged.
 *
 * Same algorithm as lib/safe/format-allowance.ts formatTokenAmount, except
 * the fallback on unparseable input is the bare raw string rather than
 * "<wei> wei" -- the role dialogs feed the result back into editable amount
 * fields, where an appended unit would corrupt the value.
 */
export function weiToHuman(amountWei: string, decimals: number): string {
  try {
    const big = BigInt(amountWei);
    if (decimals === 0) {
      return big.toString();
    }
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = big / divisor;
    const fraction = big % divisor;
    if (fraction === BigInt(0)) {
      return whole.toString();
    }
    const fractionStr = fraction
      .toString()
      .padStart(decimals, "0")
      .replace(TRAILING_ZEROS_REGEX, "");
    if (fractionStr.length === 0) {
      return whole.toString();
    }
    return `${whole.toString()}.${fractionStr}`.replace(TRAILING_DOT_REGEX, "");
  } catch {
    return amountWei;
  }
}
