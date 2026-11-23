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
  const sponsored =
    isGasSponsorshipEnabled() &&
    resolveSponsorGas(config.sponsorGas) &&
    !isTrue(config.usePrivateMempool) &&
    evaluateShowWhen(
      { computed: "sponsorshipSupported", networkField: "network" },
      config
    );
  return sponsored ? field.sponsorshipConflict : undefined;
}
