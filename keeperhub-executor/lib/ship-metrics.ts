/**
 * POSTs counter deltas from an ephemeral workflow-runner pod to the
 * long-lived executor's /metrics/ingest endpoint.
 *
 * No-op when METRICS_COLLECTOR is not "prometheus" or
 * EXECUTOR_METRICS_INGEST_URL is unset. Fail-silent on network errors so
 * observability never blocks workflow completion.
 */

import { collectCounterDeltas, type IngestPayload } from "./metrics-shipping";

const SHIP_TIMEOUT_MS = 5000;
const TRAILING_SLASH = /\/$/;

export async function shipMetricsToExecutor(): Promise<void> {
  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return;
  }

  const ingestBase = process.env.EXECUTOR_METRICS_INGEST_URL;
  if (!ingestBase) {
    return;
  }

  let deltas: IngestPayload["deltas"];
  try {
    deltas = await collectCounterDeltas();
  } catch (error: unknown) {
    console.error("[ShipMetrics] Failed to collect deltas:", error);
    return;
  }

  if (deltas.length === 0) {
    return;
  }

  const url = `${ingestBase.replace(TRAILING_SLASH, "")}/metrics/ingest`;
  const token = process.env.METRICS_INGEST_TOKEN ?? "";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Token": token,
      },
      body: JSON.stringify({ deltas } satisfies IngestPayload),
      signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.error(
        `[ShipMetrics] Executor rejected ingest: ${response.status} ${response.statusText}`
      );
      return;
    }

    console.log(
      `[ShipMetrics] Shipped ${deltas.length} counter deltas to ${url}`
    );
  } catch (error: unknown) {
    console.error("[ShipMetrics] Error shipping deltas:", error);
  }
}
