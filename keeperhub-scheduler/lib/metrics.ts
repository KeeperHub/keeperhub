/**
 * Block dispatcher metrics (Prometheus).
 *
 * One process-wide Registry, exposed by block-dispatcher/index.ts at /metrics.
 * ChainMonitor calls the small `record*` / `set*` helpers in this file at
 * each lifecycle point — no business logic depends on prom-client.
 *
 * Naming follows the repo convention `keeperhub_<area>_<thing>_<unit>` (see
 * lib/metrics/METRICS_REFERENCE.md and lib/metrics/collectors/prometheus.ts).
 *
 * Two gauges are computed at scrape time via prom-client `collect()` callbacks
 * so they always reflect the latest value without us emitting on every block:
 *   - keeperhub_block_dispatcher_seconds_since_last_block
 *   - keeperhub_block_dispatcher_socket_age_seconds
 *
 * The Registry intentionally does NOT include default Node.js process
 * metrics. The block-dispatcher's interesting signals are chain-specific.
 */

import { Counter, Gauge, Histogram, Registry } from "prom-client";

// One registry for the whole process. block-dispatcher/index.ts wires the
// `/metrics` endpoint to this.
export const registry = new Registry();

const PREFIX = "keeperhub_block_dispatcher";

// ---------------------------------------------------------------------------
// Gauges — current state, may go up and down
// ---------------------------------------------------------------------------

// Tracked per chain via the callback functions registered through
// registerChainLivenessCallbacks() below. Two values that change every second
// (seconds_since_last_block, socket_age_seconds) are computed at scrape time
// from the same data so they never go stale between ticks.
type ChainLivenessSnapshot = {
  lastBlockAdvanceAt: number | null;
  subscribedAt: number | null;
};

const livenessSnapshotByChain = new Map<string, ChainLivenessSnapshot>();

function readSnapshot(chain: string): ChainLivenessSnapshot {
  let snap = livenessSnapshotByChain.get(chain);
  if (!snap) {
    snap = { lastBlockAdvanceAt: null, subscribedAt: null };
    livenessSnapshotByChain.set(chain, snap);
  }
  return snap;
}

export const secondsSinceLastBlock = new Gauge({
  name: `${PREFIX}_seconds_since_last_block`,
  help: "Wall-clock seconds since lastProcessedBlock last advanced on this chain. THE primary alert signal — fires high when newHeads stops flowing even though the WSS appears alive. Computed at scrape time.",
  labelNames: ["chain"] as const,
  registers: [registry],
  collect() {
    for (const [chain, snap] of livenessSnapshotByChain) {
      if (snap.lastBlockAdvanceAt === null) {
        this.set({ chain }, 0);
      } else {
        this.set({ chain }, (Date.now() - snap.lastBlockAdvanceAt) / 1000);
      }
    }
  },
});

export const socketAgeSeconds = new Gauge({
  name: `${PREFIX}_socket_age_seconds`,
  help: "Wall-clock seconds since the current WSS subscription was established on this chain. Resets to 0 on every reconnect. Used to verify SOCKET_MAX_AGE_MS recycle behaviour and to spot abnormally short-lived sockets. Computed at scrape time.",
  labelNames: ["chain"] as const,
  registers: [registry],
  collect() {
    for (const [chain, snap] of livenessSnapshotByChain) {
      if (snap.subscribedAt === null) {
        this.set({ chain }, 0);
      } else {
        this.set({ chain }, (Date.now() - snap.subscribedAt) / 1000);
      }
    }
  },
});

export const isAlive = new Gauge({
  name: `${PREFIX}_is_alive`,
  help: "Per-chain alive flag (0 or 1) mirroring ChainMonitor.isAlive(). Reflects: isRunning && hasActiveSubscription && not stuck-reconnecting && not block-advance-stale.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const isReconnecting = new Gauge({
  name: `${PREFIX}_is_reconnecting`,
  help: "1 when the chain monitor is mid reconnect-with-backoff, 0 otherwise.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const hasActiveSubscription = new Gauge({
  name: `${PREFIX}_has_active_subscription`,
  help: "1 when eth_subscribe('newHeads') has completed and we are awaiting block callbacks. 0 during teardown, reconnect, or before initial subscribe.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const currentUrlIndex = new Gauge({
  name: `${PREFIX}_current_url_index`,
  help: "Which configured URL the chain monitor is connected to: 0=primary, 1=fallback. Useful for spotting silent failovers triggered by SILENT_FAILOVER_THRESHOLD.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const silentReconnectsCurrent = new Gauge({
  name: `${PREFIX}_silent_reconnects_current`,
  help: "Consecutive BLOCK_ADVANCE_TIMEOUT_MS firings on the current URL with no block advance in between. Resets to 0 on a real height advance or on a URL flip. Early warning signal: >=1 means the upstream is flaky.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const lastProcessedBlock = new Gauge({
  name: `${PREFIX}_last_processed_block`,
  help: "The highest block number this monitor has processed on the chain. Combined with the block timestamp, this is the canonical 'how far behind chain tip are we' signal.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const workflowsTracked = new Gauge({
  name: `${PREFIX}_workflows_tracked`,
  help: "Number of block-trigger workflows the monitor is currently tracking on this chain.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const chainsMonitored = new Gauge({
  name: `${PREFIX}_chains_monitored`,
  help: "Total number of chains the pod is currently monitoring across all ChainMonitor instances.",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Counters — monotonic, only ever increase
// ---------------------------------------------------------------------------

export const blocksReceivedTotal = new Counter({
  name: `${PREFIX}_blocks_received_total`,
  help: "Total blocks processed (height-advance, after dedup) per chain. rate() gives the block delivery rate; flatline means the subscription went silent.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const blocksMatchedTotal = new Counter({
  name: `${PREFIX}_blocks_matched_total`,
  help: "Total blocks that matched at least one workflow's blockInterval per chain. workflow_id intentionally omitted to keep cardinality bounded — use enqueue logs for per-workflow breakdown.",
  labelNames: ["chain"] as const,
  registers: [registry],
});

export const wsClosesTotal = new Counter({
  name: `${PREFIX}_ws_closes_total`,
  help: "WebSocket connection closures per chain by trigger reason. reason: upstream_close (server-initiated), pong_timeout, block_advance_timeout, socket_age_recycle, silent_failover, ping_send_failure, primary_probe_recovered, config_changed.",
  labelNames: ["chain", "reason"] as const,
  registers: [registry],
});

export const reconnectsTotal = new Counter({
  name: `${PREFIX}_reconnects_total`,
  help: "Reconnect attempts that completed per chain. outcome: success (connect + subscribe both succeeded) or exhausted (hit MAX_RECONNECT_ATTEMPTS without recovery, monitor stopped).",
  labelNames: ["chain", "outcome"] as const,
  registers: [registry],
});

export const urlFlipsTotal = new Counter({
  name: `${PREFIX}_url_flips_total`,
  help: "Auto-failover URL flips per chain (KEEP-557). direction: to_fallback when silent reconnects trigger the swap, to_primary when the primary-recovery probe brings us back.",
  labelNames: ["chain", "direction"] as const,
  registers: [registry],
});

export const sqsEnqueueTotal = new Counter({
  name: `${PREFIX}_sqs_enqueue_total`,
  help: "Workflow trigger enqueue attempts per chain. outcome: success or error. error rate climbing indicates an SQS / IAM / network issue downstream of the dispatcher.",
  labelNames: ["chain", "outcome"] as const,
  registers: [registry],
});

export const dispatchRefusedTotal = new Counter({
  name: `${PREFIX}_dispatch_refused_total`,
  help: "Block triggers refused at admission (over plan limit or gated action) and skipped without enqueueing, per chain. Not an error: the block matched, the org may not run it.",
  labelNames: ["chain", "reason"] as const,
  registers: [registry],
});

export const unhandledRejectionsTotal = new Counter({
  name: `${PREFIX}_unhandled_rejections_total`,
  help: "Process-level unhandled promise rejections absorbed by the dispatcher's safety-net handler. The most common source is ethers v6 destroyProvider eth_unsubscribe cancellation during reconnect. A sustained increase is fine for those; anything else warrants log investigation.",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Histograms — distributions
// ---------------------------------------------------------------------------

export const reconnectDurationMs = new Histogram({
  name: `${PREFIX}_reconnect_duration_ms`,
  help: "Time from handleDisconnect() to next 'Block subscription active' per chain, in milliseconds. p50/p95/p99 tell you how fast recovery is in practice.",
  labelNames: ["chain"] as const,
  buckets: [100, 500, 1000, 2000, 5000, 10000, 30000, 60000, 120000],
  registers: [registry],
});

export const blockLagSeconds = new Histogram({
  name: `${PREFIX}_block_lag_seconds`,
  help: "How old the block was when we received it (wall_clock - block.timestamp), per chain. p95 > 30s on a fast chain like Ethereum is a sign of upstream lag, even if blocks are technically arriving.",
  labelNames: ["chain"] as const,
  buckets: [1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// API: small helpers ChainMonitor calls at lifecycle points
//
// All take a `chain` (human-readable chain name, e.g. "Ethereum Mainnet") so
// each metric line is keyed by chain name. The reconciler logs already use
// this naming.
// ---------------------------------------------------------------------------

export const metrics = {
  // Liveness callbacks: ChainMonitor pokes these snapshots whenever the
  // underlying ms values change; collect() in the gauges above reads them.
  setLastBlockAdvanceAt(chain: string, atMs: number | null): void {
    readSnapshot(chain).lastBlockAdvanceAt = atMs;
  },
  setSubscribedAt(chain: string, atMs: number | null): void {
    readSnapshot(chain).subscribedAt = atMs;
  },
  // Remove every per-chain gauge labelset so a chain that is no longer
  // monitored disappears entirely from /metrics output. Without this, the
  // gauges would retain the last-set value of each label combination forever
  // (prom-client's default behaviour), causing alerts to fire indefinitely
  // for chains we are no longer monitoring. Counters and histograms are not
  // reset — their cumulative history is more useful than empty post-stop.
  forgetChain(chain: string): void {
    livenessSnapshotByChain.delete(chain);
    secondsSinceLastBlock.remove({ chain });
    socketAgeSeconds.remove({ chain });
    isAlive.remove({ chain });
    isReconnecting.remove({ chain });
    hasActiveSubscription.remove({ chain });
    currentUrlIndex.remove({ chain });
    silentReconnectsCurrent.remove({ chain });
    lastProcessedBlock.remove({ chain });
    workflowsTracked.remove({ chain });
  },

  // Discrete gauges (called when ChainMonitor flips a boolean / counter).
  setIsAlive(chain: string, value: boolean): void {
    isAlive.set({ chain }, value ? 1 : 0);
  },
  setIsReconnecting(chain: string, value: boolean): void {
    isReconnecting.set({ chain }, value ? 1 : 0);
  },
  setHasActiveSubscription(chain: string, value: boolean): void {
    hasActiveSubscription.set({ chain }, value ? 1 : 0);
  },
  setCurrentUrlIndex(chain: string, index: 0 | 1): void {
    currentUrlIndex.set({ chain }, index);
  },
  setSilentReconnectsCurrent(chain: string, value: number): void {
    silentReconnectsCurrent.set({ chain }, value);
  },
  setLastProcessedBlock(chain: string, blockNumber: number): void {
    lastProcessedBlock.set({ chain }, blockNumber);
  },
  setWorkflowsTracked(chain: string, value: number): void {
    workflowsTracked.set({ chain }, value);
  },
  setChainsMonitored(value: number): void {
    chainsMonitored.set(value);
  },

  // Counters
  recordBlockReceived(chain: string): void {
    blocksReceivedTotal.inc({ chain });
  },
  recordBlockMatched(chain: string): void {
    blocksMatchedTotal.inc({ chain });
  },
  recordWsClose(chain: string, reason: string): void {
    wsClosesTotal.inc({ chain, reason });
  },
  recordReconnect(chain: string, outcome: "success" | "exhausted"): void {
    reconnectsTotal.inc({ chain, outcome });
  },
  recordUrlFlip(chain: string, direction: "to_fallback" | "to_primary"): void {
    urlFlipsTotal.inc({ chain, direction });
  },
  recordSqsEnqueue(chain: string, outcome: "success" | "error"): void {
    sqsEnqueueTotal.inc({ chain, outcome });
  },
  recordDispatchRefused(chain: string, reason: string): void {
    dispatchRefusedTotal.inc({ chain, reason });
  },
  recordUnhandledRejection(): void {
    unhandledRejectionsTotal.inc();
  },

  // Histograms
  observeReconnectDuration(chain: string, durationMs: number): void {
    reconnectDurationMs.observe({ chain }, durationMs);
  },
  observeBlockLag(chain: string, lagSeconds: number): void {
    blockLagSeconds.observe({ chain }, lagSeconds);
  },

  // For tests: forget all state without resetting the Registry singleton.
  // The Registry itself is process-global and cannot be replaced; tests use
  // this to clear snapshots and zero out per-chain gauges between cases.
  resetForTests(): void {
    livenessSnapshotByChain.clear();
    registry.resetMetrics();
  },
};
