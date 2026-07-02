/**
 * Minimal PagerDuty Events API v2 client (trigger-only).
 *
 * Used by post-deploy verification to page the owning client's PagerDuty
 * service when a managed/enterprise org regresses after a deploy. Routing keys
 * are per-client (see lib/orgs/managed-clients.ts) so each org's incident lands
 * on its own service.
 *
 * `dedupKey` collapses repeated triggers for the same (deploy, org, reason)
 * into a single incident across the verification poll loop, so a 5-minute
 * window does not open five incidents.
 */
import { ErrorCategory, logInfo, logSystemError } from "@/lib/logging";

const PAGERDUTY_ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";

/** Our internal P-levels mapped onto PagerDuty Events v2 severities. */
export type PagerDutySeverity = "critical" | "error" | "warning" | "info";

export type PagerDutyTrigger = {
  routingKey: string;
  dedupKey: string;
  summary: string;
  severity: PagerDutySeverity;
  source: string;
  customDetails?: Record<string, unknown>;
};

/**
 * Fire a trigger event. Returns true on a 2xx from PagerDuty. Never throws:
 * a paging failure must not break the verification request that called it.
 */
export async function triggerPagerDutyAlert(
  event: PagerDutyTrigger
): Promise<boolean> {
  try {
    const response = await fetch(PAGERDUTY_ENQUEUE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: event.routingKey,
        event_action: "trigger",
        dedup_key: event.dedupKey,
        payload: {
          summary: event.summary,
          severity: event.severity,
          source: event.source,
          custom_details: event.customDetails,
        },
      }),
    });

    if (!response.ok) {
      logSystemError(
        ErrorCategory.EXTERNAL_SERVICE,
        "[PagerDuty] Trigger rejected",
        new Error(`PagerDuty returned ${response.status}`),
        { dedup_key: event.dedupKey, status: String(response.status) }
      );
      return false;
    }

    logInfo("[PagerDuty] Triggered alert", {
      dedup_key: event.dedupKey,
      severity: event.severity,
    });
    return true;
  } catch (error) {
    logSystemError(
      ErrorCategory.EXTERNAL_SERVICE,
      "[PagerDuty] Failed to send trigger",
      error,
      { dedup_key: event.dedupKey }
    );
    return false;
  }
}
