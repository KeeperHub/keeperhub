import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
// server-only is a no-op under Node/tsx; this reuses the app's metrics code
// verbatim so the exposed gauges are byte-for-byte identical to the former
// /api/metrics/db endpoint.
import {
  getDbMetrics,
  getPrometheusContentType,
  updateDbMetrics,
} from "../lib/metrics/prometheus-api";

/**
 * Build the metrics-collector HTTP server.
 *
 *   GET /metrics  refreshes the DB-sourced gauges (updateDbMetrics, which is
 *                 TTL- and pool-gated in lib/) and serves the dbRegistry.
 *   GET /health   liveness/readiness probe.
 *
 * Returned without listening so tests can bind an ephemeral port.
 */
export function buildServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "keeperhub-metrics-collector",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (req.url === "/metrics") {
      // serveMetrics owns all its error handling and never rejects.
      serveMetrics(res);
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

async function serveMetrics(res: ServerResponse): Promise<void> {
  try {
    await updateDbMetrics();
    const metrics = await getDbMetrics();
    res.writeHead(200, {
      "Content-Type": getPrometheusContentType(),
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(metrics);
  } catch (error) {
    console.error("[MetricsCollector] Failed to serve metrics:", error);
    res.writeHead(500);
    res.end("Failed to collect metrics");
  }
}
