/**
 * API-Process Metrics Endpoint
 *
 * Exposes only in-memory API-process metrics (histograms, counters).
 * These are per-pod and should be scraped from all pods.
 */

import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";

export async function GET(): Promise<NextResponse> {
  if (process.env.METRICS_COLLECTOR !== "prometheus") {
    return new NextResponse("Not Found", { status: 404 });
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
