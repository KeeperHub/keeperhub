/**
 * Prometheus Metrics Endpoint
 *
 * Exposes application metrics in Prometheus format for scraping.
 * Only available when METRICS_COLLECTOR=prometheus is set.
 *
 * Security: this endpoint is only enabled when explicitly configured, and it
 * answers only in-cluster callers. The ingress routes every path on
 * app.keeperhub.com to these pods, so the handler itself refuses requests that
 * arrived through the edge; see lib/metrics/scrape-guard.ts.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authorizeMetricsScrape } from "@/lib/metrics/scrape-guard";

/**
 * GET /api/metrics
 *
 * Returns metrics in Prometheus text format.
 * Returns 404 if Prometheus metrics are not enabled.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // Only expose metrics when Prometheus collector is explicitly enabled
  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const guard = await authorizeMetricsScrape(request);
  if (!guard.allowed) {
    return new NextResponse(guard.message, { status: guard.status });
  }

  try {
    // Dynamic import to avoid loading prom-client when not needed
    const { getPrometheusMetrics, getPrometheusContentType, updateDbMetrics } =
      await import("@/lib/metrics/prometheus-api");

    // Update DB-sourced metrics before collecting
    // This ensures workflow execution metrics are fresh from the database
    await updateDbMetrics();

    const metrics = await getPrometheusMetrics();
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
      "Failed to get metrics",
      error,
      { endpoint: "/api/metrics", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to collect metrics" },
      { status: 500 }
    );
  }
}
