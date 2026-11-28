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
 * `web3Connection` survives only onto an action that reads it, and a Safe one
 * only onto an action that can send from a Safe.
 */
import { isKnownConfigKeyForAction } from "@/lib/workflow/validation/action-config";
import {
  actionTakesSafeSender,
  isSafeWeb3Connection,
  WEB3_CONNECTION_KEY,
} from "@/lib/workflow/web3-connection";
import { findActionById, flattenConfigFields } from "@/plugins/registry";

const PROTOCOL_META_KEY = "_protocolMeta";

export function buildConfigForActionTypeChange(
  actionType: string,
  config: Record<string, unknown>
): Record<string, unknown> {
  const pruned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === "integrationId") {
      continue;
    }
    if (
      key === WEB3_CONNECTION_KEY &&
      isSafeWeb3Connection(value) &&
      !actionTakesSafeSender(actionType)
    ) {
      continue;
    }
    if (isKnownConfigKeyForAction(actionType, key)) {
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
