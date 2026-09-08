import { truncateAddress } from "@/lib/address-utils";
import { getChainName } from "@/lib/chain-utils";
import { SCAN_NETWORK_IDS } from "@/lib/scan/networks";
import type { SuggestionDescriptor } from "./types";

/** 0.01 native token, in wei — matches the engine's gas-balance prefill. */
const GAS_THRESHOLD_WEI = "10000000000000000";

const RISK_NOTE_READ_ONLY =
  "Read-only monitoring. This workflow never moves funds or requests token approvals.";

/**
 * Networks offered as baseline gas monitors. A subset of SCAN_NETWORK_IDS —
 * the highest-traffic chains — so the empty state stays a short, scannable row
 * rather than one card per network.
 */
const BASELINE_GAS_CHAINS = SCAN_NETWORK_IDS.slice(0, 3);

/**
 * Suggestions that are useful for an address with no detected DeFi positions.
 *
 * A gas-balance monitor needs nothing but the address itself — no holdings, no
 * token data — so it is valid for any wallet or contract. Rendering these on
 * the empty state turns a "nothing found" dead end into a set of one-click
 * monitors the visitor can actually deploy. The descriptors carry the same
 * `gas-balance-<chainId>` shape the engine emits, so they flow through the
 * existing preview drawer and factory unchanged.
 */
export function buildBaselineSuggestions(
  address: string
): SuggestionDescriptor[] {
  const shortAddr = truncateAddress(address);
  return BASELINE_GAS_CHAINS.map((chainId) => ({
    id: `gas-balance-${chainId}`,
    name: "Native Token Balance Alert",
    description:
      `Get alerted if ${shortAddr} runs low on native tokens on ${getChainName(String(chainId))}, ` +
      "so scheduled and manual transactions keep working.",
    category: "alert",
    chainId,
    readOrWrite: "read",
    confirmInputs: {
      walletAddress: address,
      gasThreshold: GAS_THRESHOLD_WEI,
    },
    riskNote: RISK_NOTE_READ_ONLY,
    usdValue: null,
  }));
}
