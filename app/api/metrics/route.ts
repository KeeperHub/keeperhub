/**
 * Prometheus Metrics Endpoint
 *
 * Exposes application metrics in Prometheus format for scraping.
 * Only available when METRICS_COLLECTOR=prometheus is set.
 *
 * Security: This endpoint is only enabled when explicitly configured.
 * In production, it should only be accessible from within the cluster
 * (Prometheus scraper). The ingress should NOT expose /api/metrics publicly.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";

/**
 * GET /api/metrics
 *
 * Returns metrics in Prometheus text format.
 * Returns 404 if Prometheus metrics are not enabled.
 */
export async function GET(): Promise<NextResponse> {
  // Only expose metrics when Prometheus collector is explicitly enabled
  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
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
