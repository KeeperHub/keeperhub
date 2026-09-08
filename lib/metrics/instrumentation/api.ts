/**
 * API Metrics Instrumentation
 *
 * Helper functions to instrument API routes with golden signal metrics.
 */

import { getOrgIdentity } from "@/lib/db/org-helpers";
import { getMetricsCollector } from "../index";
import { LabelKeys, MetricNames } from "../types";

/**
 * Record webhook trigger metrics.
 *
 * When `organizationId` is supplied and the request is a failure, the org's
 * slug and display name are resolved via `getOrgIdentity` and attached as
 * labels on the emitted `api.errors.total` event. They show up in the console
 * JSON log (shipped to Loki) so operators can identify which organization
 * triggered a failure response. `org_id` and `org_name` are dropped from the
 * Prometheus counter via the metric allowlist to keep cardinality bounded;
 * `org_slug` is allowlisted and becomes a Prometheus label.
 *
 * The org lookup runs only on the failure path (after the latency metric is
 * already recorded) and only when an `organizationId` is supplied, so success
 * and pre-auth failure call sites pay no DB cost.
 */
export async function recordWebhookMetrics(options: {
  workflowId: string;
  executionId?: string;
  durationMs: number;
  statusCode: number;
  error?: string;
  organizationId?: string | null;
}): Promise<void> {
  const metrics = getMetricsCollector();
  const success = options.statusCode < 400;

  const labels: Record<string, string> = {
    [LabelKeys.STATUS_CODE]: String(options.statusCode),
    [LabelKeys.STATUS]: success ? "success" : "failure",
  };

  metrics.recordLatency(
    MetricNames.API_WEBHOOK_LATENCY,
    options.durationMs,
    labels
  );

  if (!success && options.error) {
    const errorLabels: Record<string, string> = {
      [LabelKeys.ENDPOINT]: "webhook",
      [LabelKeys.STATUS_CODE]: String(options.statusCode),
    };

    if (options.organizationId) {
      errorLabels[LabelKeys.ORG_ID] = options.organizationId;
      const { slug, name } = await getOrgIdentity(options.organizationId);
      if (slug) {
        errorLabels[LabelKeys.ORG_SLUG] = slug;
      }
      if (name) {
        errorLabels[LabelKeys.ORG_NAME] = name;
      }
    }

    metrics.recordError(
      MetricNames.API_ERRORS_TOTAL,
      { message: options.error },
      errorLabels
    );
  }
}

/**
 * Record status polling metrics
 */
export function recordStatusPollMetrics(options: {
  executionId: string;
  durationMs: number;
  statusCode: number;
  executionStatus?: string;
}): void {
  const metrics = getMetricsCollector();

  metrics.recordLatency(MetricNames.API_STATUS_LATENCY, options.durationMs, {
    [LabelKeys.STATUS_CODE]: String(options.statusCode),
    [LabelKeys.STATUS]: options.statusCode < 400 ? "success" : "failure",
    execution_status: options.executionStatus ?? "unknown",
  });
}
