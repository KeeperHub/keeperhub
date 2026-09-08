// Resolves an action's network-egress classification and the plan-gate that
// follows from it. Unlike ./registry (a pure, explicit lookup table), this
// module reads the live plugin registry, so it is plugin-aware - import it only
// where the plugin registry is already loaded (the workflow validator and the
// workflow-builder UI), not in edge/middleware.
//
// Gating rule: an action whose egress is "user-destination" (the user controls
// the destination host) is gated behind the catch-all "action.external-request"
// feature, unless an explicit feature already covers it. Everything else keeps
// its explicit gate (or none).

import type { EgressTier } from "@/plugins/registry";
import { findActionById, getIntegration } from "@/plugins/registry";
import { FEATURES, getFeatureForActionType } from "./registry";
import { getSystemActionEgress } from "./system-action-capabilities";
import type { FeatureDefinition } from "./types";

// "unknown" means the actionType resolves to neither a system action nor a
// registered plugin action - i.e. nothing the executor can dispatch.
export type ResolvedEgress = EgressTier | "unknown";

/**
 * Classify an action's network egress. Checks the system-action map first, then
 * resolves the action via the plugin registry (which also follows legacy action
 * aliases) and reads its per-action `egress` or the plugin-level default.
 */
export function getActionEgress(actionType: string): ResolvedEgress {
  const systemEgress = getSystemActionEgress(actionType);
  if (systemEgress) {
    return systemEgress;
  }

  const action = findActionById(actionType);
  if (!action) {
    return "unknown";
  }

  if (action.egress) {
    return action.egress;
  }

  const plugin = getIntegration(action.integration);
  return plugin?.egress ?? "unknown";
}

/**
 * The feature that gates an action, including the egress-derived gate. Returns
 * an explicit feature when one is mapped; otherwise the catch-all
 * "action.external-request" feature for user-destination actions; otherwise
 * undefined (ungated). Drop-in superset of getFeatureForActionType for the
 * gating-aware call sites (validator + workflow-builder UI).
 */
export function resolveActionFeature(
  actionType: string
): FeatureDefinition | undefined {
  const explicit = getFeatureForActionType(actionType);
  if (explicit) {
    return explicit;
  }

  if (getActionEgress(actionType) === "user-destination") {
    return FEATURES["action.external-request"];
  }

  return undefined;
}
