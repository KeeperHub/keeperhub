import { resolveGasLimitOverrides } from "@/lib/web3/gas-defaults";
import {
  isConfigValueSet,
  UNSPONSORED_ONLY_FIELD_KEYS,
} from "@/lib/web3/unsponsored-only-fields";
import type { ActionConfigFieldBase } from "@/plugins/registry";
import { wouldBeSponsored } from "./show-when";

export const SPONSORSHIP_GAS_SETTINGS_DOC_URL =
  "https://docs.keeperhub.com/wallet-management/gas#custom-gas-settings-and-sponsorship";

function hasValue(field: ActionConfigFieldBase, value: unknown): boolean {
  if (!isConfigValueSet(value)) {
    return false;
  }
  if (field.type === "gas-limit-multiplier") {
    return Object.keys(resolveGasLimitOverrides(String(value))).length > 0;
  }
  return true;
}

/**
 * Whether to warn that a set field is not applied because the node would be
 * sponsored. A node that also carries a fee setting pays its own gas, so the
 * value applies and there is nothing to warn about.
 */
export function isIgnoredWhileSponsored(
  field: ActionConfigFieldBase,
  config: Record<string, unknown>
): boolean {
  return (
    field.ignoredWhenSponsored === true &&
    hasValue(field, config[field.key]) &&
    wouldBeSponsored(config, "network") &&
    !UNSPONSORED_ONLY_FIELD_KEYS.some((key) => isConfigValueSet(config[key]))
  );
}
