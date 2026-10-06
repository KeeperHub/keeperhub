export const BPS_DENOMINATOR = 10_000;
/** 0.5%: the default floor below a quote for the swaps that apply one. */
export const DEFAULT_SLIPPAGE_BPS = 50;

/** The quote less `slippageBps`, in bigint so no precision is lost. */
export function applySlippageFloor(
  quotedOut: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS
): bigint {
  return (
    (quotedOut * BigInt(BPS_DENOMINATOR - slippageBps)) /
    BigInt(BPS_DENOMINATOR)
  );
}
