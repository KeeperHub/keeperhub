import { getChainName } from "@/lib/chain-utils";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";

const NETWORK_NAMES = SCAN_NETWORK_IDS.map((chainId) =>
  getChainName(String(chainId))
).join(", ");

/**
 * Pre-scan affordance that makes the multi-network fan-out explicit: users
 * were seeing results from several chains without ever being told the scan
 * spans them.
 */
export function ScanNetworkStrip(): React.ReactElement {
  return (
    <p className="mt-6 text-muted-foreground/70 text-xs">
      Scans {SCAN_NETWORK_IDS.length} networks: {NETWORK_NAMES}
    </p>
  );
}
