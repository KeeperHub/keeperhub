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
 *
 * Security: answers in-cluster callers only; see lib/metrics/scrape-guard.ts.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authorizeMetricsScrape } from "@/lib/metrics/scrape-guard";

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.METRICS_DB_OFFLOADED === "true") {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const guard = await authorizeMetricsScrape(request);
  if (!guard.allowed) {
    return new NextResponse(guard.message, { status: guard.status });
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
