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
