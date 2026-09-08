import { getChainName } from "@/lib/chain-utils";
import type { ProtocolPosition, StablecoinBalance } from "@/lib/scan/types";

type PortfolioSnapshotProps = {
  positions: ProtocolPosition[];
  stablecoins: StablecoinBalance[];
};

/** One aggregated holding line item: a symbol summed across chains. */
type Holding = {
  symbol: string;
  usdValue: number | null;
  /** Human-unit token amount, summed across chains. */
  amount: number;
  chainIds: Set<number>;
};

/** Max holdings spelled out before collapsing into "+N more". */
const MAX_HOLDINGS = 4;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const wholeAmountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const smallAmountFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 4,
});

function formatAmount(amount: number): string {
  return amount >= 1
    ? wholeAmountFormatter.format(amount)
    : smallAmountFormatter.format(amount);
}

function toHumanUnits(amount: string, decimals: number): number {
  const value = Number(amount) / 10 ** decimals;
  return Number.isFinite(value) ? value : 0;
}

function accumulate(
  holdings: Map<string, Holding>,
  symbol: string,
  usdValue: number | null,
  amount: number,
  chainId: number
): void {
  const existing = holdings.get(symbol) ?? {
    symbol,
    usdValue: null,
    amount: 0,
    chainIds: new Set<number>(),
  };
  existing.amount += amount;
  if (usdValue !== null) {
    existing.usdValue = (existing.usdValue ?? 0) + usdValue;
  }
  existing.chainIds.add(chainId);
  holdings.set(symbol, existing);
}

/**
 * Aggregate stablecoin balances and supplied position assets into per-symbol
 * holdings, largest USD value first (unpriced holdings sort last).
 */
function buildHoldings(
  positions: ProtocolPosition[],
  stablecoins: StablecoinBalance[]
): Holding[] {
  const holdings = new Map<string, Holding>();

  for (const coin of stablecoins) {
    accumulate(
      holdings,
      coin.symbol,
      coin.usdValue,
      toHumanUnits(coin.amount, coin.decimals),
      coin.chainId
    );
  }
  for (const position of positions) {
    for (const asset of position.suppliedAssets) {
      accumulate(
        holdings,
        asset.symbol,
        asset.usdValue,
        toHumanUnits(asset.amount, asset.decimals),
        position.chainId
      );
    }
  }

  return [...holdings.values()]
    .filter((h) => h.amount > 0 || (h.usdValue ?? 0) > 0)
    .sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));
}

/** "$51.5M USDC on Ethereum" / "12 stETH" — chain named only when unambiguous. */
function holdingLabel(holding: Holding): string {
  const value =
    holding.usdValue !== null && holding.usdValue >= 0.01
      ? `${usdFormatter.format(holding.usdValue)} ${holding.symbol}`
      : `${formatAmount(holding.amount)} ${holding.symbol}`;
  if (holding.chainIds.size === 1) {
    const [chainId] = holding.chainIds;
    return `${value} on ${getChainName(String(chainId))}`;
  }
  return value;
}

/**
 * One-line holdings summary rendered between the results header and the
 * suggestions grid, e.g. "Holding: $51.5M USDC on Ethereum, 12 stETH ·
 * 3 positions across 2 networks".
 */
export function PortfolioSnapshot({
  positions,
  stablecoins,
}: PortfolioSnapshotProps): React.ReactElement | null {
  const holdings = buildHoldings(positions, stablecoins);
  if (holdings.length === 0) {
    return null;
  }

  const shown = holdings.slice(0, MAX_HOLDINGS);
  const hiddenCount = holdings.length - shown.length;

  const networkCount = new Set([
    ...positions.map((p) => p.chainId),
    ...stablecoins.map((s) => s.chainId),
  ]).size;
  const positionCount = positions.length;

  const networksLabel = `${networkCount} network${networkCount === 1 ? "" : "s"}`;
  let tail = "";
  if (positionCount > 0) {
    tail = `${positionCount} position${positionCount === 1 ? "" : "s"} across ${networksLabel}`;
  } else if (networkCount > 1) {
    tail = networksLabel;
  }

  return (
    <p
      className="text-muted-foreground text-sm"
      data-testid="scan-portfolio-snapshot"
    >
      Holding:{" "}
      <span className="font-medium text-foreground">
        {shown.map(holdingLabel).join(", ")}
        {hiddenCount > 0 ? `, +${hiddenCount} more` : ""}
      </span>
      {tail ? ` · ${tail}` : ""}
    </p>
  );
}
