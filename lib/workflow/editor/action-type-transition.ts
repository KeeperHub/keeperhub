/**
 * Builds the next config when an action node's `actionType` changes.
 *
 * Switching action types leaves config keys from the previous action behind.
 * Those leftovers fail the save-time validator (UNKNOWN_FIELD) or surface as
 * spurious missing/invalid errors. This prunes the config down to the keys the
 * newly selected action accepts, drops `integrationId` (re-selected per action),
 * then seeds defaults for the new action's fields so showWhen conditions and
 * validation evaluate immediately. `_protocolMeta` is always refreshed since
 * stale metadata would call the wrong contract function at runtime.
 */
import {
  LEGACY_PRIVATE_MEMPOOL_KEY,
  resolveSendMode,
  SEND_MODE,
  SEND_MODE_KEY,
  sendModeUpdates,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { isKnownConfigKeyForAction } from "@/lib/workflow/validation/action-config";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

const PROTOCOL_META_KEY = "_protocolMeta";
// Send as's fallback switch (API only), reserved like the old flag.
const STRICT_KEY = "strict";

export function buildConfigForActionTypeChange(
  actionType: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "integrationId") {
      continue;
    }
    if (isKnownConfigKeyForAction(actionType, key)) {
      pruned[key] = value;
    }
  }

  // The old flag and `strict` are reserved keys: they go with Send as when the new action has none.
  if (!isKnownConfigKeyForAction(actionType, SEND_MODE_KEY)) {
    delete pruned[LEGACY_PRIVATE_MEMPOOL_KEY];
    delete pruned[STRICT_KEY];
  }

  // Send as a new step cannot use (e.g. Write Contract's private relay on
  // Batch Write Contract) goes back to Normal rather than failing every run.
  // The stored mode, so a chain list still loading cannot hide an old flag.
  const mode = resolveSendMode(pruned);
  if (mode !== SEND_MODE.TRANSACTION && unsupportedSendMode(actionType, mode)) {
    for (const [key, value] of sendModeUpdates(SEND_MODE.TRANSACTION)) {
      pruned[key] = value;
    }
  }

  const action = findActionById(actionType);
  if (!action?.configFields) {
    return pruned;
  }

  for (const field of flattenConfigFields(action.configFields)) {
    if (field.defaultValue === undefined) {
      continue;
    }
    const forceUpdate = field.key === PROTOCOL_META_KEY;
    if (forceUpdate || !(field.key in pruned)) {
      pruned[field.key] = field.defaultValue;
    }
  }

  return pruned;
}

/** The config transform for one field write: an action switch rebuilds the config. */
export function configTransformFor(
  key: string,
  value: unknown
): ((config: Record<string, unknown>) => Record<string, unknown>) | undefined {
  return key === "actionType" && typeof value === "string"
    ? (config) => buildConfigForActionTypeChange(value, config)
    : undefined;
}
