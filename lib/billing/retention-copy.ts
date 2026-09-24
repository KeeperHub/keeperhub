import { PLANS } from "@/lib/billing/plans";

/**
 * Customer-facing wording for step-log retention. The purge deletes step logs
 * past an organization's plan window, and when a paid plan ends the
 * organization falls to the free window, so every screen that leads to a
 * shorter window says so. Kept apart from the components so the wording is
 * tested without rendering them.
 */

/** The window an organization falls back to once its paid plan ends. */
export const RETENTION_AFTER_PLAN_ENDS_DAYS =
  PLANS.free.features.logRetentionDays;

export function formatLogRetention(days: number): string {
  if (days >= 365) {
    return "1 year";
  }
  return `${days} days`;
}

/**
 * Shown in the plan-change dialog when the new plan keeps step logs for less
 * time than the current one. Null on an upgrade or an equal window.
 */
export function retentionDowngradeWarning(
  currentDays: number,
  newDays: number
): string | null {
  if (newDays >= currentDays) {
    return null;
  }
  return `Step logs older than ${formatLogRetention(newDays)} will be deleted after this change.`;
}

/** Completes a billing-status sentence about a paid plan that is ending. */
export function retentionAfterPlanEndsNotice(): string {
  return `step logs older than ${formatLogRetention(RETENTION_AFTER_PLAN_ENDS_DAYS)} are deleted`;
}
