import { FileCode2, Wallet } from "lucide-react";
import { DepegBanner } from "@/components/scan/depeg-banner";
import { PortfolioSnapshot } from "@/components/scan/portfolio-snapshot";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getChainName } from "@/lib/chain-utils";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";
import type {
  ProtocolPosition,
  StablecoinBalance,
  UnavailableChain,
} from "@/lib/scan/types";

/** "Ethereum, Arbitrum, Base, Optimism, Polygon and Tempo" */
const SCAN_NETWORK_NAMES = SCAN_NETWORK_IDS.map((chainId) =>
  getChainName(String(chainId))
).join(", ");

type ResultsHeaderProps = {
  addressKind?: "eoa" | "contract";
  contractChains?: number[];
  positions: ProtocolPosition[];
  unavailableChains: UnavailableChain[];
  stablecoins: StablecoinBalance[];
};

function addressKindLabel(
  addressKind: "eoa" | "contract",
  contractChains: number[]
): string {
  if (addressKind === "eoa") {
    return "Wallet (EOA)";
  }
  if (contractChains.length === 0) {
    return "Smart contract";
  }
  const chains = contractChains
    .map((chainId) => getChainName(String(chainId)))
    .join(", ");
  return `Smart contract on ${chains}`;
}

export function ResultsHeader({
  addressKind,
  contractChains,
  positions,
  unavailableChains,
  stablecoins,
}: ResultsHeaderProps): React.ReactElement {
  const depegSymbols = stablecoins
    .filter((s) => s.depegged)
    .map((s) => s.symbol);

  const scannedCount = Math.max(
    0,
    SCAN_NETWORK_IDS.length - unavailableChains.length
  );
  const KindIcon = addressKind === "contract" ? FileCode2 : Wallet;

  return (
    <>
      <div
        className="mb-4 flex flex-col items-start gap-2"
        data-testid="scan-address-summary"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {addressKind !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 font-medium text-foreground text-xs">
              <KindIcon aria-hidden="true" className="size-3.5" />
              {addressKindLabel(addressKind, contractChains ?? [])}
            </span>
          )}

          <PortfolioSnapshot positions={positions} stablecoins={stablecoins} />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-muted-foreground/70 text-xs underline decoration-dotted underline-offset-2">
              Scanned {scannedCount} of {SCAN_NETWORK_IDS.length} supported
              networks
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            KeeperHub scans the networks it supports: {SCAN_NETWORK_NAMES}.
            Networks the address is active on elsewhere are not covered.
          </TooltipContent>
        </Tooltip>
      </div>
      <DepegBanner symbols={depegSymbols} />
    </>
  );
}
