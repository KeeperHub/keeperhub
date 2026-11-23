import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import {
  isGasSponsorshipEnabled,
  resolveSponsorGas,
} from "@/lib/web3/sponsorship-feature-flag";
import type {
  ActionConfigFieldBase,
  SponsorshipConflict,
} from "@/plugins/registry";
import { evaluateShowWhen } from "./show-when";

export const SPONSORSHIP_GAS_SETTINGS_DOC_URL =
  "https://docs.keeperhub.com/wallet-management/gas#custom-gas-settings-and-sponsorship";

function hasValue(field: ActionConfigFieldBase, value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  const text = String(value).trim();
  if (text === "") {
    return false;
  }
  if (field.type === "gas-limit-multiplier") {
    return Object.keys(resolveGasLimitOverrides(text)).length > 0;
  }
  return true;
}

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

// The fee settings a node can carry that take it off the sponsored route.
const SPONSORSHIP_SKIPPING_KEYS = ["priorityFeeGwei", "maxFeeGwei"] as const;

/**
 * The sponsorship conflict to warn about for a field, or undefined when the
 * node would not take the sponsored route anyway.
 */
export function sponsorshipConflictFor(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
): SponsorshipConflict | undefined {
  if (!(field.sponsorshipConflict && hasValue(field, config[field.key]))) {
    return;
  }
  // An explicit Safe sender is never sponsored. A "default" connection may
  // still resolve to a Safe through org policy, which the editor cannot see.
  const viaSafe = String(config.web3Connection ?? "").startsWith("safe:");
  const sponsored =
    isGasSponsorshipEnabled() &&
    resolveSponsorGas(config.sponsorGas) &&
    !isTrue(config.usePrivateMempool) &&
    !viaSafe &&
    evaluateShowWhen(
      { computed: "sponsorshipSupported", networkField: "network" },
      config
    );
  if (!sponsored) {
    return;
  }
  // A custom fee already sends the node unsponsored, where the gas limit
  // applies, so only the fee fields warn.
  if (
    field.sponsorshipConflict === "not-applied-when-sponsored" &&
    SPONSORSHIP_SKIPPING_KEYS.some((key) => isSet(config[key]))
  ) {
    return;
  }
  return field.sponsorshipConflict;
}
