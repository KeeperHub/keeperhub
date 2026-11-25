/**
 * Block Monitor Service
 *
 * Keeps one ChainMonitor per chain that has active block workflows. A
 * reconcile loop refetches the workflows, starts and stops monitors, and
 * recreates a monitor whose config changed or that reports not alive.
 *
 * The service also keeps the last fully processed block per chain. Any new
 * monitor for that chain resumes from it, whether it replaces a dead monitor,
 * retries after a failed start, or runs under a new leader that was seeded
 * from the previous leader's progress.
 */

import { RECONCILE_INTERVAL_MS } from "../lib/config.js";
import { metrics } from "../lib/metrics.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";
import { fetchBlockWorkflows } from "./api-client.js";
import { ChainMonitor } from "./chain-monitor.js";
import { type HealthStatus, buildHealthStatus } from "./health.js";

export class BlockMonitorService {
  private readonly monitors: Map<number, ChainMonitor> = new Map();
  private readonly resumeBlocks: Map<number, number> = new Map();
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;

  /**
   * Start reconciling. `resumeFrom` is the progress handed over by the
   * previous leader; per chain the later of it and what this process already
   * knows wins, both being blocks a monitor fully processed.
   */
  async start(
    resumeFrom: ReadonlyMap<number, number> = new Map(),
  ): Promise<void> {
    // Reset the shutdown flag so the service is restartable: on failover the
    // same process may lose leadership (stop()) and later regain it (start()).
    this.isShuttingDown = false;

    for (const [chainId, block] of resumeFrom) {
      const known = this.resumeBlocks.get(chainId);
      if (known === undefined || block > known) {
        this.resumeBlocks.set(chainId, block);
      }
    }
    if (resumeFrom.size > 0) {
      console.log(
        `[BlockMonitorService] Seeded resume blocks for ${resumeFrom.size} chain(s): ${[
          ...resumeFrom,
        ]
          .map(([chainId, block]) => `${chainId}@${block}`)
          .join(", ")}`,
      );
    }

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

    this.captureProgress();
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

  /** Last fully processed block per chain, for handing over to a new leader. */
  getResumeBlocks(): ReadonlyMap<number, number> {
    this.captureProgress();
    return new Map(this.resumeBlocks);
  }

  getHealth(): {
    healthy: boolean;
    status: HealthStatus;
    monitors: ReturnType<ChainMonitor["getStatus"]>[];
  } {
    const monitors = [...this.monitors.values()].map((m) => m.getStatus());
    return { ...buildHealthStatus(monitors), monitors };
  }

  private async reconcile(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    try {
      const grouped = await fetchBlockWorkflows();
      const activeChainIds = new Set(grouped.keys());

      await this.removeStaleMonitors(activeChainIds);
      // A chain that comes back later must not backfill blocks it had no
      // workflows for.
      for (const chainId of this.resumeBlocks.keys()) {
        if (!activeChainIds.has(chainId)) {
          this.resumeBlocks.delete(chainId);
        }
      }
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

      // A replacement monitor resumes after the last block the old one fully
      // processed, so its first block backfills whatever the old one missed.
      if (!existing) {
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (existing.hasConfigChanged(chain)) {
        this.recordProgress(chainId, existing);
        await existing.stop();
        await this.startNewMonitor(chainId, chain, workflows);
      } else if (!existing.isAlive()) {
        const status = existing.getStatus();
        console.warn(
          `[BlockMonitorService] Monitor for ${chain.name} (${chainId}) is dead, restarting (lastBlock=${status.lastBlock}, blocksReceived=${status.blocksReceived}, hasSubscription=${status.hasSubscription}, reconnecting=${status.reconnecting})`,
        );
        this.recordProgress(chainId, existing);
        await existing.stop();
        this.monitors.delete(chainId);
        await this.startNewMonitor(chainId, chain, workflows);
      } else {
        existing.updateWorkflows(workflows);
      }
    }
  }

  private captureProgress(): void {
    for (const [chainId, monitor] of this.monitors) {
      this.recordProgress(chainId, monitor);
    }
  }

  private recordProgress(chainId: number, monitor: ChainMonitor): void {
    const { lastBlock } = monitor.getStatus();
    if (lastBlock !== null) {
      this.resumeBlocks.set(chainId, lastBlock);
    }
  }

  private async startNewMonitor(
    chainId: number,
    chain: ChainConfig,
    workflows: BlockWorkflow[],
  ): Promise<void> {
    // Kept across a failed start so the next attempt still backfills.
    const resumeFromBlock = this.resumeBlocks.get(chainId) ?? null;
    console.log(
      `[BlockMonitorService] Starting monitor for ${chain.name} (${chainId}) with ${workflows.length} workflow(s), resumeFromBlock=${resumeFromBlock ?? "none"}, primaryWss=${chain.defaultPrimaryWss ? "configured" : "MISSING"}, fallbackWss=${chain.defaultFallbackWss ? "configured" : "MISSING"}`,
    );
    const monitor = new ChainMonitor({ chain, workflows, resumeFromBlock });
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
