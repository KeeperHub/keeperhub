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
  SEND_MODE,
  sendModeUpdates,
  unsupportedSendMode,
} from "@/lib/web3/send-mode";
import { editorSendModeOn } from "@/lib/workflow/editor/send-mode-chains";
import { isKnownConfigKeyForAction } from "@/lib/workflow/validation/action-config";
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
    if (isKnownConfigKeyForAction(actionType, key)) {
      pruned[key] = value;
    }
  }

  // Send as a new step cannot use (e.g. Write Contract's private relay on
  // Batch Write Contract) goes back to Normal rather than failing every run.
  const mode = editorSendModeOn(pruned, "network");
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
