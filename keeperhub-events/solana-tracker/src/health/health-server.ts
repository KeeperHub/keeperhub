import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import type { Registry } from "prom-client";
import { logger } from "../../lib/utils/logger";
import { formatError } from "../format-error";
import type { ConnectionHealth } from "../ingest/solana-connection";
import type { LivenessSnapshot } from "../main";
import { STARTUP_GRACE_MS } from "../startup-grace";

/**
 * Three endpoints, three different questions, and keeping them separate is the
 * whole point of this file.
 *
 *   /livez   - is this process alive? Backs BOTH Kubernetes probes.
 *   /healthz - is every chain ingesting? Human and dashboard view only.
 *   /metrics - Prometheus exposition, the alerting signal.
 *
 * `/healthz` used to back the liveness probe. It returns 503 when any single
 * chain is degraded, so on 2026-09-09 a silent devnet endpoint restarted the
 * whole pod four times and took Solana mainnet ingestion down with it. Its
 * semantics are unchanged here - what changed is that no probe acts on it.
 */

const LIVEZ_MAX_SYNC_AGE_MS = 120_000;

export interface HealthResponseBody {
  status: "ok" | "degraded";
  chains: ConnectionHealth[];
}

export function buildHealthResponse(chains: ConnectionHealth[]): {
  status: 200 | 503;
  body: HealthResponseBody;
} {
  // Zero chains is healthy, and now means what it says: getAllHealth() reports
  // one entry per chain discovery expects, so an empty list is "no Solana
  // workflows exist" rather than "everything died and vanished".
  const allHealthy = chains.length === 0 || chains.every((c) => c.connected);
  return {
    status: allHealthy ? 200 : 503,
    body: { status: allHealthy ? "ok" : "degraded", chains },
  };
}

export interface LivenessResponseBody {
  status: "alive" | "starting" | "wedged";
  lastSyncStartedAt: number | null;
  lastSyncCompletedAt: number | null;
  ageMs: number;
}

/**
 * Process liveness, and nothing else. Never reads chain state.
 *
 * The signal is that the reconcile interval keeps *firing*, not that a pass
 * succeeds. A blocked event loop stops timers, so the stamp freezes and this
 * goes 503 - a true positive. A hung upstream does not stop timers, and the
 * interval does not wait for the previous pass, so the stamp keeps moving and
 * this stays 200 - no false positive, and no restart for someone else's outage.
 *
 * `now` is a parameter so this is testable without fake timers.
 */
export function buildLivenessResponse(
  snap: LivenessSnapshot,
  now: number = Date.now(),
): { status: 200 | 503; body: LivenessResponseBody } {
  // The health server binds before the first sync runs, and a cold start is a
  // serial loop of one RPC round-trip per watched program, so it can outlast
  // initialDelaySeconds. Answering 503 during startup would crash-loop the pod
  // on a slow upstream. It is still bounded: a process that never manages a
  // single pass does eventually fail.
  const startedAt = snap.lastSyncStartedAt;
  const starting = startedAt === null;
  const since = starting ? now - snap.processStartedAt : now - startedAt;
  const limit = starting ? STARTUP_GRACE_MS : LIVEZ_MAX_SYNC_AGE_MS;
  const ok = since <= limit;
  return {
    status: ok ? 200 : 503,
    body: {
      status: ok ? (starting ? "starting" : "alive") : "wedged",
      lastSyncStartedAt: snap.lastSyncStartedAt,
      lastSyncCompletedAt: snap.lastSyncCompletedAt,
      ageMs: since,
    },
  };
}

export interface HealthServerDeps {
  getHealth: () => ConnectionHealth[];
  getLiveness: () => LivenessSnapshot;
  /** Refreshes the metric series from current health, just before a scrape. */
  refreshMetrics: () => void;
  registry: Registry;
}

async function serveMetrics(
  registry: Registry,
  refreshMetrics: () => void,
  res: ServerResponse,
): Promise<void> {
  try {
    refreshMetrics();
    const body = await registry.metrics();
    res.writeHead(200, { "Content-Type": registry.contentType });
    res.end(body);
  } catch (err) {
    // Logged, never echoed: a collect() failure can carry an endpoint URL, and
    // this port is reachable from any pod in the namespace.
    logger.error(`[metrics] collection failed: ${formatError(err)}`);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("metrics collection failed");
  }
}

export function createHealthRequestHandler(
  deps: HealthServerDeps,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const pathOnly = (req.url ?? "").split("?")[0];
    switch (pathOnly) {
      case "/livez": {
        const { status, body } = buildLivenessResponse(deps.getLiveness());
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      case "/healthz": {
        const { status, body } = buildHealthResponse(deps.getHealth());
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      case "/metrics":
        void serveMetrics(deps.registry, deps.refreshMetrics, res);
        return;
      default:
        res.writeHead(404).end();
    }
  };
}

export interface HealthServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startHealthServer(
  deps: HealthServerDeps,
  port: number,
): Promise<HealthServerHandle> {
  const server = createServer(createHealthRequestHandler(deps));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  return {
    server,
    port: boundPort,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
