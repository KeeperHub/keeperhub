/**
 * KeeperHub integration helpers
 * These helpers extend upstream functionality for KeeperHub-specific features
 */

import type { IntegrationType } from "@/lib/types/integration";
import { findActionById, getIntegration } from "@/plugins/registry";

/**
 * Check if an integration type requires credentials
 * Some integrations (like web3) don't require user credentials
 */
export function integrationRequiresCredentials(
  integrationType: IntegrationType | string | undefined
): boolean {
  if (!integrationType) {
    return false;
  }

  const plugin = getIntegration(integrationType as IntegrationType);
  return plugin?.requiresCredentials !== false;
}

/**
 * Check if an integration type has a connection form worth offering: either a
 * connection is required, or the plugin holds optional connection settings
 */
export function integrationOffersConnection(
  integrationType: IntegrationType | string | undefined
): boolean {
  if (!integrationType) {
    return false;
  }

  const plugin = getIntegration(integrationType as IntegrationType);
  return (
    plugin?.requiresCredentials !== false || plugin?.optionalConnection === true
  );
}

export type ConnectionMode = "required" | "optional" | "none";

/**
 * How an action relates to a connection: one must be chosen before it runs,
 * one may be chosen to override the plugin's defaults, or there is nothing to
 * connect
 */
export function actionConnectionMode(
  actionId: string | undefined
): ConnectionMode {
  if (actionRequiresCredentials(actionId)) {
    return "required";
  }

  const action = actionId ? findActionById(actionId) : undefined;
  if (!action) {
    return "none";
  }

  return getIntegration(action.integration)?.optionalConnection === true
    ? "optional"
    : "none";
}

/**
 * Check if a specific action requires credentials
 * Checks action-level requiresCredentials first, then falls back to plugin-level
 * This allows plugins with mixed read/write actions (e.g., web3) to have per-action control
 */
export function actionRequiresCredentials(
  actionId: string | undefined
): boolean {
  if (!actionId) {
    return false;
  }

  const action = findActionById(actionId);
  if (!action) {
    return false;
  }

  // Check action-level first
  if (action.requiresCredentials !== undefined) {
    return action.requiresCredentials;
  }

  // Fall back to plugin-level
  const plugin = getIntegration(action.integration);
  return plugin?.requiresCredentials !== false;
}
