import { formatUnits, parseUnits } from "ethers";
import type { SuggestionDescriptor } from "@/lib/scan/suggestions/types";

/**
 * confirmInputs keys that hold a numeric threshold in base units (a big
 * integer string) rather than an address or a placeholder. These are the only
 * fields the preview drawer renders as human-readable, editable amounts.
 */
const THRESHOLD_KEYS = new Set(["threshold", "gasThreshold", "alertThreshold"]);

/** Matches a base-unit integer (what the engine prefills for real thresholds). */
const BASE_UNIT_RE = /^\d+$/;

/** Trailing fractional zeros (and a dangling dot) to trim from display values. */
const TRAILING_ZEROS_RE = /\.?0+$/;

function nativeSymbol(chainId: number): string {
  if (chainId === 137) {
    return "POL";
  }
  if (chainId === 4217) {
    return "TEMPO";
  }
  return "ETH";
}

/**
 * True when a confirmInputs entry is an editable numeric threshold: one of the
 * known threshold keys AND a base-unit integer value. Placeholder strings
 * (e.g. the supply-only price-alert's "Balance threshold in token base units")
 * are not integers, so they stay read-only.
 */
export function isEditableThreshold(key: string, value: string): boolean {
  return THRESHOLD_KEYS.has(key) && BASE_UNIT_RE.test(value);
}

/**
 * Decimal scale for a threshold field. Health factor and native-gas amounts are
 * 1e18-scaled; a stablecoin alert threshold uses the token's own decimals
 * (carried on the descriptor for stablecoin suggestions, default 18).
 */
export function thresholdDecimals(
  key: string,
  descriptor: SuggestionDescriptor
): number {
  if (key === "alertThreshold") {
    return descriptor.decimals ?? 18;
  }
  return 18;
}

/** Label + unit suffix for a threshold field, shown next to the input. */
export function thresholdFieldMeta(
  key: string,
  descriptor: SuggestionDescriptor
): { label: string; unit: string } {
  switch (key) {
    case "threshold":
      return { label: "Alert when health factor drops below", unit: "" };
    case "gasThreshold":
      return {
        label: "Alert when balance drops below",
        unit: nativeSymbol(descriptor.chainId),
      };
    case "alertThreshold":
      return {
        label: "Alert when balance drops below",
        unit: descriptor.symbol ?? "",
      };
    default:
      return { label: key, unit: "" };
  }
}

/** Friendly label for a non-threshold (address) confirmInputs field. */
export function addressFieldLabel(key: string): string {
  switch (key) {
    case "walletAddress":
      return "Wallet address";
    case "tokenAddress":
      return "Token address";
    case "destinationAddress":
      return "Destination address";
    default:
      return key;
  }
}

/**
 * Convert a base-unit integer string to a human-readable decimal string for
 * display (e.g. "1380000000000000000" @ 18 → "1.38"). Trailing zeros are
 * trimmed. Returns the raw value unchanged if it cannot be formatted.
 */
export function formatThresholdForDisplay(
  baseUnits: string,
  decimals: number
): string {
  try {
    const formatted = formatUnits(BigInt(baseUnits), decimals);
    // Trim a trailing ".0" / superfluous zeros for a cleaner display.
    return formatted.includes(".")
      ? formatted.replace(TRAILING_ZEROS_RE, "")
      : formatted;
  } catch {
    return baseUnits;
  }
}

/**
 * Convert a human-readable decimal string back to a base-unit integer string
 * (e.g. "1.4" @ 18 → "1400000000000000000"). Returns null when the input is
 * not a valid non-negative number, so callers can reject the edit.
 */
export function parseThresholdToBaseUnits(
  human: string,
  decimals: number
): string | null {
  const trimmed = human.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const value = parseUnits(trimmed, decimals);
    if (value < BigInt(0)) {
      return null;
    }
    return value.toString();
  } catch {
    return null;
  }
}
