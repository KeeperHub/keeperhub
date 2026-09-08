/**
 * DB-Sourced Metrics Endpoint
 *
 * Exposes only database-sourced gauge metrics. These are identical across pods,
 * so only one pod needs to be scraped for these metrics.
 *
 * TECH-6484: these gauges are now served by the dedicated
 * keeperhub-metrics-collector service. When METRICS_DB_OFFLOADED is set, this
 * route returns 404 so the heavy aggregate scan never runs on the
 * request-serving pods (the app's db-metrics ServiceMonitor is removed too).
 * The flag keeps the cutover reversible via config without a code revert.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(): Promise<NextResponse> {
  if (process.env.METRICS_DB_OFFLOADED === "true") {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
  }

  try {
    const { getDbMetrics, getPrometheusContentType, updateDbMetrics } =
      await import("@/lib/metrics/prometheus-api");

    await updateDbMetrics();

    const metrics = await getDbMetrics();
    const contentType = getPrometheusContentType();

    return new NextResponse(metrics, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.INFRASTRUCTURE,
      "Failed to get DB metrics",
      error,
      { endpoint: "/api/metrics/db", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to collect metrics" },
      { status: 500 }
    );
  }
}
