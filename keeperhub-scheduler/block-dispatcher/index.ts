/**
 * Block Dispatcher
 *
 * Monitors blockchain blocks via WebSocket and enqueues block-triggered
 * workflows to SQS. Runs as a standalone long-lived process.
 *
 * Usage:
 *   pnpm block-dispatcher
 *
 * Environment variables:
 *   KEEPERHUB_API_URL      - KeeperHub API URL (default: http://localhost:3000)
 *   INTERNAL_SERVICE_HMAC_SECRET - HMAC signing secret for internal service auth
 *   RECONCILE_INTERVAL_MS  - How often to refetch workflows (default: 30000)
 *   SQS_QUEUE_URL          - SQS queue URL
 *   AWS_REGION             - AWS region
 *   AWS_ENDPOINT_URL       - LocalStack endpoint (local dev only)
 *   HEALTH_PORT            - Health check server port (default: 3050)
 */

// Normalize all console.* output in this process to canonical JSON. Must be
// the first import so the patch installs before any module logs.
import "../log-facade.js";
import express from "express";
import {
  KEEPERHUB_URL,
  RECONCILE_INTERVAL_MS,
  SQS_QUEUE_URL,
} from "../lib/config.js";
import {
  type LeaderElectionHandle,
  runWithLeaderElection,
} from "../lib/leader-election.js";
import { metrics, registry } from "../lib/metrics.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";
import { fetchBlockWorkflows } from "./api-client.js";
import { ChainMonitor } from "./chain-monitor.js";

class BlockMonitorService {
  private readonly monitors: Map<number, ChainMonitor> = new Map();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    // Reset the shutdown flag so the service is restartable: on failover the
    // same process may lose leadership (stop()) and later regain it (start()).
    this.isShuttingDown = false;

    console.log(
      `[BlockMonitorService] Starting (reconcile every ${RECONCILE_INTERVAL_MS}ms)`,
    );

    await this.reconcile();

    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((error: unknown) => {
        console.error(
          "[BlockMonitorService] Reconciliation error:",
          error instanceof Error ? error.message : error,
        );
      });
    }, RECONCILE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    console.log("[BlockMonitorService] Stopping...");
    this.isShuttingDown = true;

    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }

    const stopResults = await Promise.allSettled(
      [...this.monitors.values()].map((monitor) => monitor.stop()),
    );

    for (const result of stopResults) {
      if (result.status === "rejected") {
        console.error(
          "[BlockMonitorService] Error stopping monitor:",
          result.reason,
        );
      }
    }

    this.monitors.clear();
    console.log("[BlockMonitorService] Stopped");
  }

  getHealth(): {
    healthy: boolean;
    monitors: ReturnType<ChainMonitor["getStatus"]>[];
  } {
    const monitors = [...this.monitors.values()].map((m) => m.getStatus());
    const healthy = monitors.length === 0 || monitors.every((m) => m.alive);
    return { healthy, monitors };
  }

  private async reconcile(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      const grouped = await fetchBlockWorkflows();
      const activeChainIds = new Set(grouped.keys());

      await this.removeStaleMonitors(activeChainIds);
      await this.syncActiveMonitors(grouped);

      const chainNames = [...grouped.entries()]
        .map(
          ([id, { chain, workflows }]) =>
            `${chain.name}(${id}): ${workflows.length} wf`,
        )
        .join(", ");
      metrics.setChainsMonitored(this.monitors.size);
      console.log(
        `[BlockMonitorService] Reconciled: ${this.monitors.size} chain(s) monitored [${chainNames}]`,
      );
    } catch (error) {
      console.error(
        "[BlockMonitorService] Reconciliation failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private async removeStaleMonitors(
    activeChainIds: Set<number>,
  ): Promise<void> {
    for (const [chainId, monitor] of this.monitors) {
      if (!activeChainIds.has(chainId)) {
        console.log(
          `[BlockMonitorService] Stopping monitor for chain ${chainId} (no active workflows)`,
        );
        await monitor.stop();
        this.monitors.delete(chainId);
      }
    }
  }

  private async syncActiveMonitors(
    grouped: Map<number, { chain: ChainConfig; workflows: BlockWorkflow[] }>,
  ): Promise<void> {
    for (const [chainId, { chain, workflows }] of grouped) {
      const existing = this.monitors.get(chainId);

      if (!existing) {
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (existing.hasConfigChanged(chain)) {
        await existing.stop();
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (!existing.isAlive()) {
        const status = existing.getStatus();
        console.warn(
          `[BlockMonitorService] Monitor for ${chain.name} (${chainId}) is dead, restarting (lastBlock=${status.lastBlock}, blocksReceived=${status.blocksReceived}, hasSubscription=${status.hasSubscription}, reconnecting=${status.reconnecting})`,
        );
        await existing.stop();
        this.monitors.delete(chainId);
        await this.startNewMonitor(chainId, chain, workflows);
      } else {
        existing.updateWorkflows(workflows);
      }
    }
  }

  private async startNewMonitor(
    chainId: number,
    chain: ChainConfig,
    workflows: BlockWorkflow[],
  ): Promise<void> {
    console.log(
      `[BlockMonitorService] Starting monitor for ${chain.name} (${chainId}) with ${workflows.length} workflow(s), primaryWss=${chain.defaultPrimaryWss ? "configured" : "MISSING"}, fallbackWss=${chain.defaultFallbackWss ? "configured" : "MISSING"}`,
    );
    const monitor = new ChainMonitor({ chain, workflows });
    this.monitors.set(chainId, monitor);
    try {
      await monitor.start();
    } catch (error) {
      console.error(
        `[BlockMonitorService] Failed to start monitor for ${chain.name}:`,
        error instanceof Error ? error.message : error,
      );
      this.monitors.delete(chainId);
    }
  }
}

// Ethers v6 WebSocketProvider teardown produces a detached eth_unsubscribe
// rejection when the socket dies mid-subscription; log and swallow so Node
// does not exit the process on transient RPC failures.
process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : "";
  metrics.recordUnhandledRejection();
  console.error(`[BlockDispatcher] Unhandled rejection: ${message}`, stack);
});

const RECOVERABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
]);

function isRecoverableNetworkError(error: Error): boolean {
  const message = error.message ?? "";
  const code = (error as Error & { code?: string }).code ?? "";

  if (RECOVERABLE_NETWORK_CODES.has(code)) {
    return true;
  }

  // ws library emits "Unexpected server response: <status>" on non-101
  // upgrade responses (HTTP 429 rate limits, 5xx, etc.). These should never
  // crash the dispatcher — the offending ChainMonitor will handle reconnect.
  if (message.includes("Unexpected server response")) {
    return true;
  }

  return false;
}

// Uncaught sync exceptions indicate corrupted state in the general case, BUT
// transient network/WebSocket errors (e.g. HTTP 429 on a WS upgrade) bubble
// up here because ethers v6 does not attach an 'error' listener on the
// underlying ws. Crashing the whole dispatcher on a single chain's rate limit
// takes down monitoring for every other chain in the pod. Classify and only
// exit on truly unknown errors.
process.on("uncaughtException", (error: Error) => {
  if (isRecoverableNetworkError(error)) {
    console.warn(
      `[BlockDispatcher] Recoverable network error (continuing): ${error.message}`,
    );
    return;
  }
  console.error(
    `[BlockDispatcher] Uncaught exception: ${error.message}`,
    error.stack ?? "",
  );
  process.exit(1);
});

// Main entry point
async function main(): Promise<void> {
  if (!process.env.INTERNAL_SERVICE_HMAC_SECRET) {
    throw new Error("INTERNAL_SERVICE_HMAC_SECRET is required");
  }
  console.log("[BlockDispatcher] Starting block dispatcher...");
  console.log(`[BlockDispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[BlockDispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);
  console.log(
    `[BlockDispatcher] Reconcile interval: ${RECONCILE_INTERVAL_MS}ms`,
  );

  const service = new BlockMonitorService();

  // Gate chain monitoring on leadership: with 2 replicas only the elected
  // leader opens WebSocket subscriptions and enqueues, otherwise every block
  // triggers once per replica (and doubles upstream RPC/WSS load). On losing
  // leadership the standby tears its monitors down via service.stop().
  const election: LeaderElectionHandle = runWithLeaderElection({
    leaseName: process.env.LEASE_NAME ?? "block-dispatcher-leader",
    onStartedLeading: async () => {
      console.log("[BlockDispatcher] Became leader — starting monitors");
      await service.start();
    },
    onStoppedLeading: async () => {
      console.log("[BlockDispatcher] Lost leadership — stopping monitors");
      await service.stop();
    },
  });

  // Start health check server
  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3050;

  healthApp.get("/health", (_req, res) => {
    const health = service.getHealth();
    const statusCode = health.healthy ? 200 : 503;
    res.status(statusCode).json({
      status: health.healthy ? "ok" : "degraded",
      service: "block-dispatcher",
      leader: election.isLeader(),
      timestamp: new Date().toISOString(),
      monitors: health.monitors,
    });
  });

  healthApp.get("/metrics", async (_req, res) => {
    try {
      res.set("Content-Type", registry.contentType);
      res.end(await registry.metrics());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).send(`Error collecting metrics: ${message}`);
    }
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[BlockDispatcher] Health check server listening on port ${HEALTH_PORT}`,
    );
  });

  // Shutdown handler
  let shuttingDown = false;
  const shutdownHandler = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log("\n[BlockDispatcher] Shutting down...");
    // Release the lease first so a standby can take over promptly, then tear
    // down our own monitors and close.
    await election.stop().catch(() => {
      // best-effort; the lease expires on its own if release fails
    });
    await service.stop();
    healthServer.close(() => {
      console.log("[BlockDispatcher] Health server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdownHandler());
  process.on("SIGTERM", () => shutdownHandler());
  process.on("SIGHUP", () => shutdownHandler());
  process.on("SIGUSR1", () => {
    console.warn(
      "[Security] SIGUSR1 received; inspector activation suppressed",
    );
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BlockDispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
