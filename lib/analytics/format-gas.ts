// BigInt literals are unavailable at this project's ES2017 target, so the
// constants go through the BigInt() constructor.
const ZERO = BigInt(0);
const TWO = BigInt(2);
const TEN = BigInt(10);
const WEI_PER_ETH = TEN ** BigInt(18);
const MIN_DECIMALS = 4;
const MAX_DECIMALS = 8;
const SIGNIFICANT_UNITS = TEN;

export function parseWei(weiString: string | null | undefined): bigint | null {
  if (!weiString) {
    return null;
  }
  try {
    return BigInt(weiString);
  } catch {
    return null;
  }
}

/**
 * Smallest precision at which every non-zero figure in the group still renders
 * two significant digits, so sub-0.0001 dust does not collapse to "0.0000".
 */
export function gasDecimals(weiValues: (bigint | null)[]): number {
  let smallest: bigint | null = null;
  for (const value of weiValues) {
    if (
      value !== null &&
      value > ZERO &&
      (smallest === null || value < smallest)
    ) {
      smallest = value;
    }
  }
  if (smallest === null) {
    return MIN_DECIMALS;
  }
  let decimals = MIN_DECIMALS;
  while (
    decimals < MAX_DECIMALS &&
    smallest * TEN ** BigInt(decimals) < SIGNIFICANT_UNITS * WEI_PER_ETH
  ) {
    decimals += 1;
  }
  return decimals;
}

/** Wei rounded half-up to the display ulp, counted in units of 10^-decimals ETH. */
function toDisplayUnits(wei: bigint, decimals: number): bigint {
  const weiPerUnit = WEI_PER_ETH / TEN ** BigInt(decimals);
  return (wei + weiPerUnit / TWO) / weiPerUnit;
}

function renderUnits(units: bigint, decimals: number): string {
  const digits = units.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)} ETH`;
}

export function formatGasAsEth(
  weiString: string | null | undefined,
  decimals: number = MIN_DECIMALS
): string {
  const wei = parseWei(weiString);
  if (wei === null) {
    return "--";
  }
  if (wei === ZERO) {
    return "0 ETH";
  }
  return renderUnits(toDisplayUnits(wei, decimals), decimals);
}

export type GasSplit = {
  total: string;
  wallet: string;
  sponsored: string;
};

/**
 * Renders the headline total alongside its wallet/sponsored parts so the two
 * parts add up to exactly what the headline shows. Each figure rounds
 * independently to the same precision, which can leave the parts one ulp short
 * of or over the total; that residual is folded into the larger part, keeping
 * the headline the correctly-rounded sum.
 */
export function formatGasSplit(
  walletWeiString: string,
  sponsoredWeiString: string
): GasSplit {
  const wallet = parseWei(walletWeiString) ?? ZERO;
  const sponsored = parseWei(sponsoredWeiString) ?? ZERO;
  const total = wallet + sponsored;
  const decimals = gasDecimals([wallet, sponsored, total]);

  const totalUnits = toDisplayUnits(total, decimals);
  let walletUnits = toDisplayUnits(wallet, decimals);
  let sponsoredUnits = toDisplayUnits(sponsored, decimals);

  const residual = totalUnits - (walletUnits + sponsoredUnits);
  if (residual !== ZERO) {
    if (wallet >= sponsored) {
      walletUnits += residual;
    } else {
      sponsoredUnits += residual;
    }
  }

  return {
    total: total === ZERO ? "0 ETH" : renderUnits(totalUnits, decimals),
    wallet: wallet === ZERO ? "0 ETH" : renderUnits(walletUnits, decimals),
    sponsored:
      sponsored === ZERO ? "0 ETH" : renderUnits(sponsoredUnits, decimals),
  };
}
