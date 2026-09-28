/**
 * API-Process Metrics Endpoint
 *
 * Exposes only in-memory API-process metrics (histograms, counters).
 * These are per-pod and should be scraped from all pods.
 *
 * Security: answers in-cluster callers only; see lib/metrics/scrape-guard.ts.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import { authorizeMetricsScrape } from "@/lib/metrics/scrape-guard";

export async function GET(request: Request): Promise<NextResponse> {
  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
  }

  const guard = await authorizeMetricsScrape(request);
  if (!guard.allowed) {
    return new NextResponse(guard.message, { status: guard.status });
  }

  try {
    const { getApiProcessMetrics, getPrometheusContentType } = await import(
      "@/lib/metrics/prometheus-api"
    );

    const metrics = await getApiProcessMetrics();
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
      "Failed to get API metrics",
      error,
      { endpoint: "/api/metrics/api", operation: "get" }
    );
    return NextResponse.json(
      { error: "Failed to collect metrics" },
      { status: 500 }
    );
  }
}
