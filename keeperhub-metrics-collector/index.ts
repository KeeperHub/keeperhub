/**
 * keeperhub-metrics-collector
 *
 * Single-replica service that serves the DB-sourced Prometheus gauges that used
 * to live on /api/metrics/db on the common app pods. It reuses the app's
 * metrics code verbatim (updateDbMetrics refreshes the dbRegistry from Postgres,
 * getDbMetrics serializes it), so the exposed gauge families are identical.
 * Running it as its own single-replica deployment keeps the heavy aggregate
 * scan off the request-serving pods and makes the scrape deterministic.
 *
 * Env:
 *   PORT          HTTP port for /metrics and /health (default 9090)
 *   DATABASE_URL  Postgres connection (consumed by lib/db)
 */
// Normalize all console.* output in this process to canonical JSON. Must be
// the first import so the patch installs before any module logs.
import "./log-facade";
import type { Server } from "node:http";
import { buildServer } from "./server";

const PORT = Number.parseInt(process.env.PORT ?? "9090", 10) || 9090;

const server: Server = buildServer();

server.listen(PORT, () => {
  console.log(
    `[MetricsCollector] serving /metrics and /health on port ${PORT}`
  );
});

function shutdown(signal: string): void {
  console.log(`[MetricsCollector] received ${signal}, shutting down`);
  server.close(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
