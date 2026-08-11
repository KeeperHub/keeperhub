/**
 * Global event-based organization refetch system
 *
 * This allows any part of the app to trigger a refetch of organization data
 * without having direct access to the React hooks.
 */

import { ErrorCategory, logSystemError } from "@/lib/logging";

type RefetchCallback = () => void;

const refetchCallbacks: Set<RefetchCallback> = new Set();

/**
 * Register a refetch callback (called from React hooks)
 */
export function registerOrganizationRefetch(
  callback: RefetchCallback
): () => void {
  refetchCallbacks.add(callback);

  // Return cleanup function
  return () => {
    refetchCallbacks.delete(callback);
  };
}

/**
 * Trigger all registered refetch callbacks
 * Call this after signup, signin, or any action that changes organization state
 */
export function refetchOrganizations(): void {
  console.log(
    `[refetchOrganizations] Triggering ${refetchCallbacks.size} refetch callbacks`
  );
  for (const callback of refetchCallbacks) {
    try {
      callback();
    } catch (error) {
      logSystemError(
        ErrorCategory.UNKNOWN,
        "[refetchOrganizations] Error in callback",
        error
      );
    }
  }
}
