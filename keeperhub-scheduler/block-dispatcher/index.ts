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
 *   KEEPERHUB_API_KEY      - Service API key for X-Service-Key authentication
 *   RECONCILE_INTERVAL_MS  - How often to refetch workflows (default: 30000)
 *   SQS_QUEUE_URL          - SQS queue URL
 *   AWS_REGION             - AWS region
 *   AWS_ENDPOINT_URL       - LocalStack endpoint (local dev only)
 *   HEALTH_PORT            - Health check server port (default: 3000)
 */

import express from "express";
import { fetchBlockWorkflows } from "./api-client.js";
import { ChainMonitor } from "./chain-monitor.js";
import {
  KEEPERHUB_URL,
  RECONCILE_INTERVAL_MS,
  SQS_QUEUE_URL,
} from "../lib/config.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";

class BlockMonitorService {
  private readonly monitors: Map<number, ChainMonitor> = new Map();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  async start(): Promise<void> {
    console.log(
      `[BlockMonitorService] Starting (reconcile every ${RECONCILE_INTERVAL_MS}ms)`
    );

    await this.reconcile();

    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((error: unknown) => {
        console.error(
          "[BlockMonitorService] Reconciliation error:",
          error instanceof Error ? error.message : error
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
      [...this.monitors.values()].map((monitor) => monitor.stop())
    );

    for (const result of stopResults) {
      if (result.status === "rejected") {
        console.error(
          "[BlockMonitorService] Error stopping monitor:",
          result.reason
        );
      }
    }

    this.monitors.clear();
    console.log("[BlockMonitorService] Stopped");
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
        .map(([id, { chain, workflows }]) => `${chain.name}(${id}): ${workflows.length} wf`)
        .join(", ");
      console.log(
        `[BlockMonitorService] Reconciled: ${this.monitors.size} chain(s) monitored [${chainNames}]`
      );
    } catch (error) {
      console.error(
        "[BlockMonitorService] Reconciliation failed:",
        error instanceof Error ? error.message : error
      );
    }
  }

  private async removeStaleMonitors(
    activeChainIds: Set<number>
  ): Promise<void> {
    for (const [chainId, monitor] of this.monitors) {
      if (!activeChainIds.has(chainId)) {
        console.log(
          `[BlockMonitorService] Stopping monitor for chain ${chainId} (no active workflows)`
        );
        await monitor.stop();
        this.monitors.delete(chainId);
      }
    }
  }

  private async syncActiveMonitors(
    grouped: Map<number, { chain: ChainConfig; workflows: BlockWorkflow[] }>
  ): Promise<void> {
    for (const [chainId, { chain, workflows }] of grouped) {
      const existing = this.monitors.get(chainId);

      if (!existing) {
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (existing.hasConfigChanged(chain)) {
        await existing.stop();
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (!existing.isAlive()) {
        console.warn(
          `[BlockMonitorService] Monitor for ${chain.name} (${chainId}) is dead, restarting`
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
    workflows: BlockWorkflow[]
  ): Promise<void> {
    console.log(
      `[BlockMonitorService] Starting monitor for ${chain.name} (${chainId}) with ${workflows.length} workflow(s), primaryWss=${chain.defaultPrimaryWss ? "configured" : "MISSING"}, fallbackWss=${chain.defaultFallbackWss ? "configured" : "MISSING"}`
    );
    const monitor = new ChainMonitor({ chain, workflows });
    this.monitors.set(chainId, monitor);
    try {
      await monitor.start();
    } catch (error) {
      console.error(
        `[BlockMonitorService] Failed to start monitor for ${chain.name}:`,
        error instanceof Error ? error.message : error
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
  console.error(`[BlockDispatcher] Unhandled rejection: ${message}`, stack);
});

// Uncaught sync exceptions indicate corrupted state; log and exit so the
// orchestrator restarts us cleanly rather than continuing in an unknown state.
process.on("uncaughtException", (error: Error) => {
  console.error(
    `[BlockDispatcher] Uncaught exception: ${error.message}`,
    error.stack ?? ""
  );
  process.exit(1);
});

// Main entry point
async function main(): Promise<void> {
  console.log("[BlockDispatcher] Starting block dispatcher...");
  console.log(`[BlockDispatcher] KeeperHub URL: ${KEEPERHUB_URL}`);
  console.log(`[BlockDispatcher] SQS Queue URL: ${SQS_QUEUE_URL}`);
  console.log(
    `[BlockDispatcher] Reconcile interval: ${RECONCILE_INTERVAL_MS}ms`
  );

  const service = new BlockMonitorService();

  // Start health check server
  const healthApp = express();
  const HEALTH_PORT = process.env.HEALTH_PORT || 3050;

  healthApp.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "block-dispatcher",
      timestamp: new Date().toISOString(),
    });
  });

  const healthServer = healthApp.listen(HEALTH_PORT, () => {
    console.log(
      `[BlockDispatcher] Health check server listening on port ${HEALTH_PORT}`
    );
  });

  // Shutdown handler
  const shutdownHandler = async () => {
    console.log("\n[BlockDispatcher] Shutting down...");
    await service.stop();
    healthServer.close(() => {
      console.log("[BlockDispatcher] Health server closed");
      process.exit(0);
    });
  };

  process.on("SIGINT", () => {
    shutdownHandler();
  });
  process.on("SIGTERM", () => {
    shutdownHandler();
  });

  // Start monitoring
  await service.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BlockDispatcher] Fatal startup error: ${message}`);
  process.exit(1);
});
