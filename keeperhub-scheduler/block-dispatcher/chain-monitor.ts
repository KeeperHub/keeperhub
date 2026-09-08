/**
 * Chain Monitor
 *
 * Monitors a single blockchain chain via ethers.js WebSocketProvider.
 * When a block matches a workflow's interval, enqueues a trigger to SQS.
 *
 * ethers v6 WebSocketProvider uses eth_subscribe ("newHeads") over the
 * WebSocket to receive block notifications (SocketBlockSubscriber, not
 * polling). A WebSocket-level ping/pong runs every 30s to verify the
 * connection is alive, and a no-block timeout forces reconnection if the
 * provider goes silent.
 */

import { ethers } from "ethers";
import { metrics } from "../lib/metrics.js";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../lib/phantom.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";
import { enqueueBlockTrigger } from "./sqs-enqueue.js";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const STALE_BLOCK_THRESHOLD_S = 120; // warn if block timestamp >2 min behind
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_BACKFILL_BLOCKS = 100;

// ---------------------------------------------------------------------------
// LIVENESS — single source of truth for all reconnect/teardown timing.
//
// Every threshold the monitor uses to decide "is this connection healthy"
// lives here. Each is overridable through one helper so tests can collapse
// minute-scale waits into milliseconds without touching the production code,
// and so ops can tune any value via env without code changes. Keep this the
// only place these numbers are defined.
//
// The three liveness signals this monitor exposes:
//
//   1. Transport keepalive       ping/pong       PONG_TIMEOUT_MS
//   2. Subscription delivery     block-advance   BLOCK_ADVANCE_TIMEOUT_MS
//   3. Reconciler backstop       isAlive() flips after RECONNECT_STUCK_TIMEOUT_MS
//                                or MONITOR_RECREATE_TIMEOUT_MS
//
// Plus two operational safety nets that are not user-facing liveness signals
// but live here for the same reason:
//
//   CONNECT_TIMEOUT_MS           bound on a single connect() attempt
//   DESTROY_PROVIDER_TIMEOUT_MS  bound on each ethers v6 teardown step
//   SOCKET_MAX_AGE_MS            proactive recycle of an apparently-healthy socket
//   PRIMARY_PROBE_*              fallback-to-primary recovery probe timing
// ---------------------------------------------------------------------------

const LIVENESS_DEFAULTS = {
  // How often we send a ws-level ping. Stays at 30s — short enough to detect a
  // half-open transport within a minute, long enough not to spam the upstream.
  PING_INTERVAL_MS: 30_000,
  // How long we wait for a pong before declaring the transport dead and forcing
  // a reconnect. Bumped from 5s to 30s per oncall ask: the previous 5s was
  // tight enough to false-positive on bursty CPU or GC pauses on the dispatcher
  // pod. handleDisconnect is idempotent so overlap with the 30s ping interval
  // is safe.
  PONG_TIMEOUT_MS: 30_000,
  // Subscription-level liveness. If lastProcessedBlock has not *advanced* in
  // this window, force a reconnect. Was NO_BLOCK_TIMEOUT_MS. Renamed to make
  // the rule explicit: it is about new-height delivery, not callback fire.
  // 60s is the floor that still tolerates Ethereum's 12s block time during
  // testnet variance (~5 missed blocks) while detecting silent subscriptions
  // on sub-2s chains (Polygon, Base, Avalanche, BSC) within tens of expected
  // blocks. Combined with SILENT_FAILOVER_THRESHOLD=2, this flips a chain
  // to fallback at 120s — the same moment the dashboard cell turns red and
  // the Block Dispatcher Chain Silent alert finishes its for=2m debounce.
  BLOCK_ADVANCE_TIMEOUT_MS: 60_000,
  // Reconciler-level recreate threshold. If a monitor reports not-alive for
  // longer than this gap of dead subscription, BlockMonitorService destroys
  // and recreates it. Was STALE_SUBSCRIPTION_MS. Same purpose.
  // Aligned with the dashboard red threshold (120s) so the reconciler's
  // backstop kicks in at the same moment the alert fires. By that point the
  // chain has already had its first 60s reconnect attempt and is about to
  // hit the SILENT_FAILOVER_THRESHOLD flip; the recreate is the next-tier
  // safety net for monitors that wedge during the flip itself.
  MONITOR_RECREATE_TIMEOUT_MS: 120_000,
  // Cap on how long isReconnecting=true is acceptable before the reconciler
  // treats the monitor as dead. The normal reconnect-with-backoff path (max
  // 10 attempts, max 30s each) completes well under this; only a hung
  // destroy/connect await can exceed it.
  RECONNECT_STUCK_TIMEOUT_MS: 5 * 60_000,
  // Bound on a single connect() attempt.
  CONNECT_TIMEOUT_MS: 15_000,
  // Bound on each ethers v6 teardown step (removeAllListeners, destroy).
  // ethers fires an internal eth_unsubscribe over the WSS during teardown;
  // on a half-open socket that promise can hang and block the reconnect loop
  // forever. Each step is bounded with this timeout.
  DESTROY_PROVIDER_TIMEOUT_MS: 3_000,
  // Proactive socket recycle: tear down and re-subscribe a socket that has
  // been continuously connected longer than this, even when blocks keep
  // arriving. Belt-and-suspenders against degraded-but-not-dead WSS state.
  SOCKET_MAX_AGE_MS: 60 * 60_000,
  // Primary recovery probe (used only while running on the fallback URL).
  PRIMARY_PROBE_INTERVAL_MS: 5 * 60_000,
  PRIMARY_PROBE_TIMEOUT_MS: 5_000,
  // After this many consecutive BLOCK_ADVANCE_TIMEOUT_MS firings on the same
  // URL, flip the URL preference (primary <-> fallback) on the next reconnect.
  // This catches half-open-subscription upstreams where the WSS connects and
  // request/response works but eth_subscribe never delivers newHeads — a
  // failure mode the existing connect-level fallback cannot detect because
  // getBlockNumber() succeeds on the broken URL. Reset to 0 on a real block
  // advance, so a recovered URL is fully trusted again.
  SILENT_FAILOVER_THRESHOLD: 2,
} as const;

type LivenessKey = keyof typeof LIVENESS_DEFAULTS;

// Read on every call so env overrides take effect even when set after module
// load (the test suite does this). One helper, one rule, applied uniformly.
function liveness(key: LivenessKey): number {
  const override = Number(process.env[key]);
  return override > 0 ? override : LIVENESS_DEFAULTS[key];
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }),
  ]);
}

type ChainMonitorConfig = {
  chain: ChainConfig;
  workflows: BlockWorkflow[];
};

// Decodes a `ws` library "message" event payload to a string for the KEEP-570
// raw-frame diagnostic. The ws library can deliver `data` as string, Buffer,
// Buffer[] (fragmented frames, when the high-water mark is reached mid-frame),
// or ArrayBuffer (when binaryType is "arraybuffer"). ethers v6 configures
// Buffer today, but a silent under-count if upstream changes that is exactly
// the regression the diagnostic exists to prevent. Returns null when the
// payload is none of those shapes; the caller still counts the frame but
// will not attempt to parse it for the subscription-push tally.
export function decodeWsFrame(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data) && data.every((d) => Buffer.isBuffer(d))) {
    return Buffer.concat(data).toString("utf8");
  }
  return null;
}

// Reduces a probe-failure error to a single short tag like "HTTP 429",
// "timeout", or a 60-char first-line slice. Keeps log lines compact —
// ethers errors can include long JSON-RPC payloads and ABI dumps otherwise.
function summarizeProbeError(error: unknown): string {
  const fullMessage = error instanceof Error ? error.message : String(error);
  const httpMatch = fullMessage.match(/Unexpected server response: (\d{3})/);
  if (httpMatch) {
    return `HTTP ${httpMatch[1]}`;
  }
  if (fullMessage.toLowerCase().includes("timeout")) {
    return "timeout";
  }
  return fullMessage.split("\n")[0].slice(0, 60);
}

export class ChainMonitor {
  private readonly chainId: number;
  private readonly chainName: string;
  private provider: ethers.WebSocketProvider | null = null;
  private workflows: BlockWorkflow[];
  private readonly primaryWss: string | null;
  private readonly fallbackWss: string | null;
  private isRunning = false;
  private isReconnecting = false;
  private isProcessing = false;
  private pendingBlock: number | null = null;
  private reconnectAttempts = 0;
  private lastProcessedBlock: number | null = null;
  // Wall-clock ms of the last time lastProcessedBlock *advanced*. Updated
  // only after dedup, so a stuck upstream replaying the same block(N) does
  // not falsify liveness. This was previously `lastBlockReceivedAt` and was
  // updated before dedup — that was the root cause of the silent 7-hour
  // outage where block-triggered workflows stopped without recovering.
  //
  // KEEP-570: also no longer reset by subscribeToBlocks on reconnect. A
  // monitor that keeps reconnecting but never gets a real block is exactly
  // the stuck state the reconciler needs to detect. The monitorBootAt field
  // covers the cold-start warmup window so a freshly-booted monitor isn't
  // reaped before its first block.
  private lastBlockAdvanceAt: number | null = null;
  // Wall-clock ms of when this monitor instance started running. Used by
  // isAlive() as the staleness baseline before the first real block arrives.
  // Replaces the previous behaviour of seeding lastBlockAdvanceAt on every
  // subscribe, which broke the reconciler's ability to detect monitors
  // stuck across many reconnect cycles.
  private monitorBootAt: number | null = null;
  private blocksReceived = 0;
  private blocksMatched = 0;
  private lastHeartbeat = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private noBlockTimer: ReturnType<typeof setTimeout> | null = null;
  private primaryProbeTimer: ReturnType<typeof setInterval> | null = null;
  private socketAgeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectingStartedAt: number | null = null;
  private currentUrlIndex = 0;
  private hasActiveSubscription = false;
  private wsCloseHandler: (() => void) | null = null;
  // Consecutive BLOCK_ADVANCE_TIMEOUT_MS firings on the same URL. Reset on a
  // real height advance in processBlockRange. When this hits
  // SILENT_FAILOVER_THRESHOLD, the next reconnect flips currentUrlIndex so the
  // monitor tries the other configured URL (primary <-> fallback).
  private silentReconnects = 0;
  // KEEP-570 diagnostic counters. These observe the raw ws socket independent
  // of ethers' subscription routing. They distinguish "subscription confirmed,
  // pushes routed, dedup discarded them" from "pushes never arrived" from
  // "pushes arrived but ethers never routed them". Reset in subscribeToBlocks.
  private wsFrameCount = 0;
  private subscriptionPushCount = 0;
  private lastWsFrameAt: number | null = null;
  private wsMessageHandler: ((data: unknown) => void) | null = null;

  constructor(config: ChainMonitorConfig) {
    this.chainId = config.chain.chainId;
    this.chainName = config.chain.name;
    this.primaryWss = config.chain.defaultPrimaryWss;
    this.fallbackWss = config.chain.defaultFallbackWss;
    this.workflows = config.workflows;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.silentReconnects = 0;
    this.monitorBootAt = Date.now();
    metrics.setSilentReconnectsCurrent(this.chainName, 0);
    metrics.setWorkflowsTracked(this.chainName, this.workflows.length);

    try {
      await this.connect();
      await this.subscribeToBlocks();
      this.startPingPong();
      this.resetNoBlockTimer();
      this.startPrimaryProbe();
      metrics.setIsAlive(this.chainName, true);
    } catch (error) {
      this.isRunning = false;
      metrics.setIsAlive(this.chainName, false);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.isReconnecting = false;
    this.reconnectingStartedAt = null;
    this.silentReconnects = 0;
    this.stopTimers();
    await this.destroyProvider();
    // forgetChain() removes every per-chain gauge labelset, so the chain
    // disappears entirely from /metrics output. No need to flip individual
    // gauges to 0 first — that would leave residual labels behind. Counters
    // and histograms keep their cumulative history.
    metrics.forgetChain(this.chainName);
  }

  updateWorkflows(workflows: BlockWorkflow[]): void {
    this.workflows = workflows;
    metrics.setWorkflowsTracked(this.chainName, workflows.length);
  }

  hasConfigChanged(chain: ChainConfig): boolean {
    return (
      this.primaryWss !== chain.defaultPrimaryWss ||
      this.fallbackWss !== chain.defaultFallbackWss
    );
  }

  getChainId(): number {
    return this.chainId;
  }

  isAlive(): boolean {
    if (!this.isRunning) {
      return false;
    }
    if (this.isReconnecting) {
      // Normal reconnect-with-backoff (max ~3 min) is well under
      // RECONNECT_STUCK_TIMEOUT_MS. Anything longer indicates destroyProvider()
      // or connect() got hung mid-await, and the reconciler must intervene.
      if (
        this.reconnectingStartedAt !== null &&
        Date.now() - this.reconnectingStartedAt >
          liveness("RECONNECT_STUCK_TIMEOUT_MS")
      ) {
        return false;
      }
      return true;
    }
    if (!this.hasActiveSubscription) {
      return false;
    }
    // Subscription is set up, but the upstream WSS may have gone silent
    // (zombie subscription). Treat as not-alive once block height has not
    // advanced for MONITOR_RECREATE_TIMEOUT_MS so the BlockMonitorService
    // reconciler tears it down and starts a fresh monitor. The signal is
    // height-advance — not callback-fire — because a stuck upstream can
    // replay the same block(N) forever without us advancing.
    //
    // KEEP-570: staleness is measured from the last *real* height advance.
    // Before the first block ever arrives the baseline is monitorBootAt, so
    // a freshly-booted monitor isn't reaped during cold-start warmup. Once
    // the first block lands, lastBlockAdvanceAt takes over. This replaces
    // the previous logic where subscribeToBlocks reset lastBlockAdvanceAt
    // on every reconnect — that reset masked monitors stuck across many
    // silent-reconnect cycles, exactly the prod failure mode.
    const stalenessBaseline = this.lastBlockAdvanceAt ?? this.monitorBootAt;
    if (
      stalenessBaseline !== null &&
      Date.now() - stalenessBaseline > liveness("MONITOR_RECREATE_TIMEOUT_MS")
    ) {
      return false;
    }
    return true;
  }

  getStatus(): {
    chainId: number;
    chainName: string;
    alive: boolean;
    reconnecting: boolean;
    hasSubscription: boolean;
    lastBlock: number | null;
    blocksReceived: number;
    blocksMatched: number;
    workflows: number;
  } {
    return {
      chainId: this.chainId,
      chainName: this.chainName,
      alive: this.isAlive(),
      reconnecting: this.isReconnecting,
      hasSubscription: this.hasActiveSubscription,
      lastBlock: this.lastProcessedBlock,
      blocksReceived: this.blocksReceived,
      blocksMatched: this.blocksMatched,
      workflows: this.workflows.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Provider lifecycle
  // ---------------------------------------------------------------------------

  private async destroyProvider(): Promise<void> {
    this.hasActiveSubscription = false;

    if (this.provider) {
      // Remove the raw WebSocket close handler before destroying to prevent
      // stale handlers from firing handleDisconnect during teardown
      if (this.wsCloseHandler) {
        const ws = this.provider.websocket as unknown as {
          removeListener?: (
            event: string,
            cb: (data?: unknown) => void,
          ) => void;
        };
        ws?.removeListener?.("close", this.wsCloseHandler);
        this.wsCloseHandler = null;
      }
      // KEEP-570: detach the diagnostic message tap before destroying so it
      // does not retain a reference to the closed socket or fire on the
      // teardown frames ethers sends during eth_unsubscribe.
      if (this.wsMessageHandler) {
        const ws = this.provider.websocket as unknown as {
          removeListener?: (
            event: string,
            cb: (data?: unknown) => void,
          ) => void;
        };
        ws?.removeListener?.("message", this.wsMessageHandler);
        this.wsMessageHandler = null;
      }

      // ethers v6 removeAllListeners/destroy fire an internal eth_unsubscribe
      // over the WSS. On a half-open socket that promise can hang and block
      // the reconnect loop forever; bound both steps with a hard timeout.
      const destroyTimeoutMs = liveness("DESTROY_PROVIDER_TIMEOUT_MS");
      try {
        await withTimeout(
          this.provider.removeAllListeners(),
          destroyTimeoutMs,
          "removeAllListeners",
        );
      } catch (error) {
        console.warn(
          `[BlockMonitor:${this.chainName}] destroyProvider.removeAllListeners: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await withTimeout(this.provider.destroy(), destroyTimeoutMs, "destroy");
      } catch (error) {
        console.warn(
          `[BlockMonitor:${this.chainName}] destroyProvider.destroy: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.provider = null;
    }
  }

  private async connect(): Promise<void> {
    type Candidate = {
      url: string;
      index: 0 | 1;
      label: "primary" | "fallback";
    };
    const candidates: Candidate[] = [];
    if (this.primaryWss) {
      candidates.push({ url: this.primaryWss, index: 0, label: "primary" });
    }
    if (this.fallbackWss) {
      candidates.push({ url: this.fallbackWss, index: 1, label: "fallback" });
    }

    if (candidates.length === 0) {
      throw new Error(
        `No WSS URLs configured for chain ${this.chainName} (${this.chainId})`,
      );
    }

    // Honor currentUrlIndex as the starting preference. It is updated below
    // when we successfully connect, and also explicitly flipped by
    // maybeFlipUrlPreference() when SILENT_FAILOVER_THRESHOLD is reached on
    // the previous URL. The labels "primary"/"fallback" stay stable across
    // reorderings so logs always identify which physical URL is in use.
    const ordered =
      this.currentUrlIndex === 1 && candidates.length === 2
        ? [candidates[1], candidates[0]]
        : candidates;

    for (const [iterIdx, candidate] of ordered.entries()) {
      let provider: ethers.WebSocketProvider | null = null;
      try {
        provider = new ethers.WebSocketProvider(candidate.url);

        // ethers v6 WebSocketProvider does not attach an 'error' listener on
        // the underlying ws. Without one, an HTTP 429 (or any non-101 upgrade
        // response) makes ws emit 'error' on the socket which Node escalates
        // to uncaughtException, killing the entire dispatcher process.
        //
        // Attach our own listener so the error is consumed and surfaces as a
        // normal rejection of the connect race below, allowing the fallback
        // URL loop and reconnect-with-backoff to do their job.
        const wsErrorPromise = this.attachConnectErrorListener(provider);

        // NOTE: provider.ready is a synchronous boolean getter
        // (`get ready() { return this.#notReady == null; }`), NOT a Promise.
        // Awaiting it resolves immediately and tells us nothing about the ws.
        // To actually confirm the upgrade succeeded we issue a real network
        // call which internally waits for the underlying ws to be open via
        // `_waitUntilReady()`.
        const blockNumber = (await Promise.race([
          provider.getBlockNumber(),
          wsErrorPromise,
          new Promise<number>((_, reject) => {
            setTimeout(
              () => reject(new Error("Connection timeout")),
              liveness("CONNECT_TIMEOUT_MS"),
            );
          }),
        ])) as number;

        this.provider = provider;
        this.currentUrlIndex = candidate.index;
        metrics.setCurrentUrlIndex(this.chainName, candidate.index);
        console.log(
          `[BlockMonitor:${this.chainName}] Connected to ${candidate.label} WSS (block: ${blockNumber})`,
        );
        return;
      } catch (error) {
        // Destroy the provider if it was created but failed/timed out
        if (provider) {
          await provider.removeAllListeners();
          await provider.destroy().catch(() => {});
        }
        console.warn(
          `[BlockMonitor:${this.chainName}] Failed to connect to ${candidate.label} WSS:`,
          error instanceof Error ? error.message : error,
        );
        if (iterIdx === ordered.length - 1) {
          throw error;
        }
      }
    }

    throw new Error("Unreachable");
  }

  private attachConnectErrorListener(
    provider: ethers.WebSocketProvider,
  ): Promise<never> {
    const ws = provider.websocket as unknown as {
      on?: (event: string, cb: (err: Error) => void) => void;
    };

    return new Promise<never>((_, reject) => {
      ws?.on?.("error", (err: Error) => {
        const message = err?.message ?? String(err);
        console.warn(
          `[BlockMonitor:${this.chainName}] WebSocket error during connect: ${message}`,
        );
        reject(new Error(`WebSocket error: ${message}`));
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Block subscription
  // ---------------------------------------------------------------------------

  private async subscribeToBlocks(): Promise<void> {
    if (!this.provider) {
      return;
    }

    console.log(`[BlockMonitor:${this.chainName}] Subscribing to block events`);

    // ethers v6 provider.on() is async - it sends eth_subscribe over the
    // WebSocket and waits for the subscription ID. Must be awaited or the
    // subscription silently fails on reconnection.
    await this.provider.on("block", (blockNumber: number) => {
      this.onBlock(blockNumber).catch((error: unknown) => {
        console.error(
          `[BlockMonitor:${this.chainName}] Error processing block ${blockNumber}:`,
          error instanceof Error ? error.message : error,
        );
      });
    });

    this.hasActiveSubscription = true;
    // KEEP-570: do NOT seed lastBlockAdvanceAt here. Resetting it on every
    // subscribe falsified isAlive() across reconnects, so monitors that
    // re-subscribed every BLOCK_ADVANCE_TIMEOUT_MS without ever receiving
    // a real block looked permanently alive to the reconciler. The cold-
    // start warmup case is now handled by monitorBootAt in isAlive().
    const subscribedAt = Date.now();
    // KEEP-570 diagnostic: reset the per-subscription frame counters so the
    // noBlockTimer log shows what happened on THIS subscription, not the
    // cumulative since pod start.
    this.wsFrameCount = 0;
    this.subscriptionPushCount = 0;
    this.lastWsFrameAt = null;
    metrics.setHasActiveSubscription(this.chainName, true);
    metrics.setSubscribedAt(this.chainName, subscribedAt);
    // resetNoBlockTimer is called from start/reconnect, but seed it here too
    // for the same reason — the watchdog needs a baseline from the moment we
    // are subscribed, not from the previous run.
    this.resetNoBlockTimer();
    this.startSocketAgeTimer();
    console.log(`[BlockMonitor:${this.chainName}] Block subscription active`);

    // Handle WebSocket close for reconnection - store reference for cleanup
    const ws = this.provider.websocket as unknown as {
      on?: (event: string, cb: (data?: unknown) => void) => void;
    };
    if (ws?.on) {
      this.wsCloseHandler = (): void => {
        console.warn(`[BlockMonitor:${this.chainName}] WebSocket closed`);
        this.hasActiveSubscription = false;
        metrics.setHasActiveSubscription(this.chainName, false);
        metrics.recordWsClose(this.chainName, "upstream_close");
        this.handleDisconnect();
      };
      ws.on("close", this.wsCloseHandler);

      // KEEP-570 diagnostic: tap the raw ws below ethers' subscription
      // routing. Counts every incoming frame and decodes enough JSON to
      // identify eth_subscription pushes. Lets the noBlockTimer log
      // distinguish "no frames at all" from "frames arrived but ethers did
      // not route them to onBlock". The ws library's "message" event fires
      // alongside ethers' onmessage property handler, so this tap does not
      // intercept or shadow ethers' own message processing.
      this.wsMessageHandler = (data: unknown): void => {
        this.wsFrameCount++;
        this.lastWsFrameAt = Date.now();
        // The ws library can deliver a frame as string, Buffer, Buffer[]
        // (fragmented), or ArrayBuffer (when binaryType is set). ethers v6
        // configures Buffer today, but a quiet under-count if upstream
        // changes that is exactly the kind of regression this diagnostic
        // is supposed to prevent. Decode all four shapes; anything else
        // counts as a frame but is not parsed for the push counter.
        const text = decodeWsFrame(data);
        if (text === null) {
          return;
        }
        try {
          const parsed = JSON.parse(text) as { method?: string };
          if (parsed?.method === "eth_subscription") {
            this.subscriptionPushCount++;
          }
        } catch {
          // Non-JSON or partial frame; counted in wsFrameCount, ignored here.
        }
      };
      ws.on("message", this.wsMessageHandler);
    }
  }

  // ---------------------------------------------------------------------------
  // Block processing
  // ---------------------------------------------------------------------------

  private async onBlock(blockNumber: number): Promise<void> {
    // Deduplicate first — ethers may fire the same block from both polling
    // and newHeads, and a half-open upstream can replay block(N) forever.
    // Liveness MUST NOT be reset by repeated/old blocks; the no-block timer
    // and lastBlockAdvanceAt are updated downstream in processBlockRange,
    // only when lastProcessedBlock actually advances. (Root-cause fix for
    // the silent 7-hour outage on prod.)
    if (
      this.lastProcessedBlock !== null &&
      blockNumber <= this.lastProcessedBlock
    ) {
      return;
    }

    // Serialize processing — if already handling a block, queue the latest and return
    if (this.isProcessing) {
      this.pendingBlock = blockNumber;
      return;
    }

    this.isProcessing = true;
    try {
      await this.processBlockRange(blockNumber);
    } finally {
      this.isProcessing = false;
    }

    // Drain any block that arrived while we were processing
    while (this.pendingBlock !== null) {
      const next = this.pendingBlock;
      this.pendingBlock = null;

      if (this.lastProcessedBlock !== null && next <= this.lastProcessedBlock) {
        continue;
      }

      this.isProcessing = true;
      try {
        await this.processBlockRange(next);
      } finally {
        this.isProcessing = false;
      }
    }
  }

  private async processBlockRange(blockNumber: number): Promise<void> {
    if (this.lastProcessedBlock === null) {
      console.log(
        `[BlockMonitor:${this.chainName}] First block received: ${blockNumber}, tracking ${this.workflows.length} workflow(s): ${this.workflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`,
      );
    }

    const fromBlock =
      this.lastProcessedBlock !== null
        ? this.lastProcessedBlock + 1
        : blockNumber;

    const gap = blockNumber - fromBlock;

    if (gap > MAX_BACKFILL_BLOCKS) {
      console.warn(
        `[BlockMonitor:${this.chainName}] Gap too large (${gap} blocks), skipping backfill. Resuming from block ${blockNumber}`,
      );
    } else if (fromBlock < blockNumber) {
      console.log(
        `[BlockMonitor:${this.chainName}] Gap detected: last=${this.lastProcessedBlock}, received=${blockNumber}, backfilling ${gap} block(s)`,
      );

      for (let bn = fromBlock; bn < blockNumber; bn++) {
        await this.processBlockNumber(bn);
      }
    }

    await this.processBlockNumber(blockNumber);
    this.lastProcessedBlock = blockNumber;
    // Height genuinely advanced — refresh liveness AFTER the fact.
    const advancedAt = Date.now();
    this.lastBlockAdvanceAt = advancedAt;
    // Trust the current URL again: a real height advance means the
    // subscription is delivering. Without this reset, an old streak of silent
    // reconnects would still trigger a URL flip on the next disconnect.
    this.silentReconnects = 0;
    this.resetNoBlockTimer();
    this.blocksReceived++;
    metrics.recordBlockReceived(this.chainName);
    metrics.setLastProcessedBlock(this.chainName, blockNumber);
    metrics.setLastBlockAdvanceAt(this.chainName, advancedAt);
    metrics.setSilentReconnectsCurrent(this.chainName, 0);

    // Heartbeat log
    const now = Date.now();
    if (now - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      console.log(
        `[BlockMonitor:${this.chainName}] Heartbeat: block=${blockNumber}, received=${this.blocksReceived}, matched=${this.blocksMatched}, workflows=${this.workflows.length}`,
      );
      this.lastHeartbeat = now;
    }
  }

  private async processBlockNumber(blockNumber: number): Promise<void> {
    const matchingWorkflows = this.workflows.filter(
      (wf) => blockNumber > 0 && blockNumber % wf.blockInterval === 0,
    );

    if (matchingWorkflows.length === 0) {
      return;
    }

    // Fetch block data for the matched block
    const block = await this.getBlockData(blockNumber);
    if (!block) {
      return;
    }

    // Stale block warning + lag histogram
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lagSeconds = nowSeconds - block.timestamp;
    metrics.observeBlockLag(this.chainName, lagSeconds);
    if (lagSeconds > STALE_BLOCK_THRESHOLD_S) {
      console.warn(
        `[BlockMonitor:${this.chainName}] Block ${blockNumber} timestamp is ${lagSeconds}s behind wall clock`,
      );
    }

    this.blocksMatched++;
    metrics.recordBlockMatched(this.chainName);
    console.log(
      `[BlockMonitor:${this.chainName}] Block ${blockNumber} matched ${matchingWorkflows.length} workflow(s): ${matchingWorkflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`,
    );

    const results = await Promise.allSettled(
      matchingWorkflows.map((wf) =>
        this.enqueueWithPhantom(wf, blockNumber, block),
      ),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        metrics.recordSqsEnqueue(this.chainName, "error");
        console.error(
          `[BlockMonitor:${this.chainName}] Failed to enqueue workflow ${matchingWorkflows[index].id}:`,
          result.reason,
        );
      } else {
        metrics.recordSqsEnqueue(this.chainName, "success");
      }
    }
  }

  /**
   * KEEP-693: pre-create a phantom row (best-effort) then enqueue the block
   * trigger carrying its id. On enqueue failure, resolve the phantom to a coded
   * failure and re-throw so the caller's per-result error metric still fires.
   */
  private async enqueueWithPhantom(
    wf: BlockWorkflow,
    blockNumber: number,
    block: { hash: string; timestamp: number; parentHash: string },
  ): Promise<void> {
    // Stable per (workflow, chain, block) key. Two leaders that
    // overlap on failover, or both process the same block, collide on the
    // unique index so only one enqueue lands. The in-memory lastProcessedBlock
    // dedup only guards a single instance, so this is what covers 2 replicas.
    const dispatchKey = `block:${wf.id}:${this.chainId}:${blockNumber}`;
    const { executionId, alreadyExisted, refused } =
      await createPhantomExecution(wf.id, "block", wf.userId, dispatchKey);

    // Refused on plan grounds: the executor would refuse the same run. Skipping
    // here matters most on a fast chain, where enqueueing would otherwise cost
    // a message and an executor round-trip on every block, indefinitely.
    if (refused) {
      console.log(
        `[BlockMonitor:${this.chainName}] Skipping refused dispatch for ${dispatchKey} (${refused})`,
      );
      metrics.recordDispatchRefused(this.chainName, refused);
      return;
    }

    if (alreadyExisted) {
      console.log(
        `[BlockMonitor:${this.chainName}] Skipping duplicate dispatch for ${dispatchKey} (already enqueued)`,
      );
      return;
    }

    try {
      await enqueueBlockTrigger({
        executionId,
        workflowId: wf.id,
        userId: wf.userId,
        triggerType: "block",
        triggerData: {
          blockNumber,
          blockHash: block.hash,
          blockTimestamp: block.timestamp,
          parentHash: block.parentHash,
        },
      });
    } catch (error) {
      if (executionId) {
        const reason = error instanceof Error ? error.message : "send failed";
        await failPhantomExecution(
          executionId,
          "BS-0001",
          `Block trigger failed to dispatch: ${reason}`,
        );
      }
      throw error;
    }
  }

  private async getBlockData(blockNumber: number): Promise<{
    hash: string;
    timestamp: number;
    parentHash: string;
  } | null> {
    if (!this.provider) {
      return null;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const block = await this.provider.getBlock(blockNumber);
        if (block) {
          return {
            hash: block.hash ?? "",
            timestamp: block.timestamp,
            parentHash: block.parentHash,
          };
        }
      } catch (error) {
        if (attempt === 1) {
          console.warn(
            `[BlockMonitor:${this.chainName}] Failed to fetch block ${blockNumber} after 2 attempts:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // WebSocket ping/pong & no-block timeout
  // ---------------------------------------------------------------------------

  private startPingPong(): void {
    this.stopPingPong();

    const ws = this.provider?.websocket as unknown as {
      ping?: (data?: unknown) => void;
      on?: (event: string, cb: () => void) => void;
      readyState?: number;
    };

    if (!ws?.ping || !ws?.on) {
      console.warn(
        `[BlockMonitor:${this.chainName}] WebSocket does not support ping/pong, skipping keepalive`,
      );
      return;
    }

    // Listen for pong responses — clears the timeout each time
    ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    const pingIntervalMs = liveness("PING_INTERVAL_MS");
    const pongTimeoutMs = liveness("PONG_TIMEOUT_MS");

    this.pingTimer = setInterval(() => {
      if (!this.isRunning || ws.readyState !== 1) {
        return;
      }

      try {
        ws.ping!();
      } catch {
        console.warn(
          `[BlockMonitor:${this.chainName}] Failed to send ping, triggering reconnect`,
        );
        metrics.recordWsClose(this.chainName, "ping_send_failure");
        this.handleDisconnect();
        return;
      }

      // Idempotent: don't stack pong waits if one is already in flight.
      if (this.pongTimer) {
        return;
      }
      // If no pong arrives within timeout, the transport is dead.
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        console.warn(
          `[BlockMonitor:${this.chainName}] Pong timeout (${pongTimeoutMs}ms), triggering reconnect`,
        );
        metrics.recordWsClose(this.chainName, "pong_timeout");
        this.handleDisconnect();
      }, pongTimeoutMs);
    }, pingIntervalMs);

    console.log(
      `[BlockMonitor:${this.chainName}] Ping/pong keepalive started (interval=${pingIntervalMs}ms, timeout=${pongTimeoutMs}ms)`,
    );
  }

  private stopPingPong(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private resetNoBlockTimer(): void {
    this.stopNoBlockTimer();
    const timeoutMs = liveness("BLOCK_ADVANCE_TIMEOUT_MS");
    this.noBlockTimer = setTimeout(() => {
      if (this.isRunning) {
        // Count this as a silent reconnect on the current URL. Decision to
        // flip to the other URL is made by reconnectWithBackoff before its
        // next connect attempt, based on SILENT_FAILOVER_THRESHOLD.
        this.silentReconnects++;
        metrics.setSilentReconnectsCurrent(
          this.chainName,
          this.silentReconnects,
        );
        metrics.recordWsClose(this.chainName, "block_advance_timeout");
        // KEEP-570: enrich the silent-window warning with the raw ws frame
        // counters. The three load-bearing comparisons:
        //   wsFrameCount == 0  -> no frames at all (network or upstream silent)
        //   wsFrameCount > 0 && subscriptionPushCount == 0 -> only req/response
        //                       and keepalives, no newHeads pushes
        //   subscriptionPushCount > 0 && blocksReceived == 0 -> ethers received
        //                       pushes but did not route them to onBlock
        //                       (the ethers v6 sharp edge)
        const lastFrameAgoMs =
          this.lastWsFrameAt === null ? null : Date.now() - this.lastWsFrameAt;
        console.warn(
          `[BlockMonitor:${this.chainName}] Block height has not advanced in ${timeoutMs / 1000}s ` +
            `(silentReconnects=${this.silentReconnects}, wsFrames=${this.wsFrameCount}, ` +
            `subscriptionPushes=${this.subscriptionPushCount}, blocksReceived=${this.blocksReceived}, ` +
            `lastFrameAgo=${lastFrameAgoMs === null ? "never" : `${lastFrameAgoMs}ms`}), triggering reconnect`,
        );
        this.handleDisconnect();
      }
    }, timeoutMs);
  }

  private stopNoBlockTimer(): void {
    if (this.noBlockTimer) {
      clearTimeout(this.noBlockTimer);
      this.noBlockTimer = null;
    }
  }

  private stopTimers(): void {
    this.stopPingPong();
    this.stopNoBlockTimer();
    this.stopPrimaryProbe();
    this.stopSocketAgeTimer();
  }

  // ---------------------------------------------------------------------------
  // Periodic socket recycle
  //
  // Even when blocks keep arriving, a long-lived WSS can drift into a degraded
  // state (server-side rate limits, partial routing failures, half-open TCP).
  // Recycling on a fixed schedule guarantees we exercise the reconnect path
  // routinely so subtle staleness can't accumulate undetected.
  // ---------------------------------------------------------------------------

  private startSocketAgeTimer(): void {
    this.stopSocketAgeTimer();
    const maxAgeMs = liveness("SOCKET_MAX_AGE_MS");
    this.socketAgeTimer = setTimeout(() => {
      if (!this.isRunning || this.isReconnecting) {
        return;
      }
      console.log(
        `[BlockMonitor:${this.chainName}] Socket age exceeded ${Math.floor(maxAgeMs / 1000)}s, recycling`,
      );
      metrics.recordWsClose(this.chainName, "socket_age_recycle");
      this.handleDisconnect();
    }, maxAgeMs);
  }

  private stopSocketAgeTimer(): void {
    if (this.socketAgeTimer) {
      clearTimeout(this.socketAgeTimer);
      this.socketAgeTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Primary recovery probe
  //
  // When we are running on the fallback URL, periodically test the primary in a
  // throwaway provider. If it answers a getBlockNumber within the timeout, we
  // close the current (fallback) connection and let reconnectWithBackoff swap
  // back to primary. The fallback is kept active until the moment we trigger
  // the swap, so monitoring is never interrupted.
  // ---------------------------------------------------------------------------

  private startPrimaryProbe(): void {
    this.stopPrimaryProbe();

    if (this.currentUrlIndex === 0 || !this.primaryWss) {
      return;
    }

    this.primaryProbeTimer = setInterval(() => {
      this.probePrimary().catch(() => {
        // probePrimary handles its own logging; nothing to do here
      });
    }, liveness("PRIMARY_PROBE_INTERVAL_MS"));
  }

  private stopPrimaryProbe(): void {
    if (this.primaryProbeTimer) {
      clearInterval(this.primaryProbeTimer);
      this.primaryProbeTimer = null;
    }
  }

  private async probePrimary(): Promise<void> {
    if (!(this.isRunning && this.primaryWss) || this.currentUrlIndex === 0) {
      this.stopPrimaryProbe();
      return;
    }

    let probeProvider: ethers.WebSocketProvider | null = null;
    try {
      probeProvider = new ethers.WebSocketProvider(this.primaryWss);
      // Inline silent listener (not attachConnectErrorListener) so probe
      // failures produce only the single "Primary probe failed" line below.
      const ws = probeProvider.websocket as unknown as {
        on?: (event: string, cb: (err: Error) => void) => void;
      };
      const wsErrorPromise = new Promise<never>((_, reject) => {
        ws?.on?.("error", (err: Error) => {
          reject(new Error(err?.message ?? String(err)));
        });
      });

      await Promise.race([
        probeProvider.getBlockNumber(),
        wsErrorPromise,
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Primary probe timeout")),
            liveness("PRIMARY_PROBE_TIMEOUT_MS"),
          );
        }),
      ]);

      console.log(
        `[BlockMonitor:${this.chainName}] Primary recovered, switching back from fallback`,
      );
      await probeProvider.removeAllListeners();
      await probeProvider.destroy().catch(() => {
        // ignore cleanup errors
      });
      // Must set currentUrlIndex before handleDisconnect so reconnectWithBackoff
      // lands on primary. Without it, maybeFlipUrlPreference() returns early
      // (silentReconnects is 0 because the fallback is healthy), and connect()
      // silently stays on fallback while the metric records a flip that never
      // actually happens — causing the URL Flipped alert to re-fire every probe
      // interval.
      this.currentUrlIndex = 0;
      metrics.recordUrlFlip(this.chainName, "to_primary");
      metrics.recordWsClose(this.chainName, "primary_probe_recovered");
      this.handleDisconnect();
    } catch (error) {
      const reason = summarizeProbeError(error);
      console.warn(
        `[BlockMonitor:${this.chainName}] Primary probe failed: ${reason}`,
      );
      if (probeProvider) {
        await probeProvider.removeAllListeners();
        await probeProvider.destroy().catch(() => {
          // ignore cleanup errors
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reconnection (max attempts with exponential backoff)
  // ---------------------------------------------------------------------------

  private handleDisconnect(): void {
    if (!this.isRunning || this.isReconnecting) {
      return;
    }

    this.isReconnecting = true;
    this.reconnectingStartedAt = Date.now();
    metrics.setIsReconnecting(this.chainName, true);
    metrics.setHasActiveSubscription(this.chainName, false);
    this.stopTimers();

    this.reconnectWithBackoff().catch((error: unknown) => {
      console.error(
        `[BlockMonitor:${this.chainName}] Reconnect loop failed:`,
        error instanceof Error ? error.message : error,
      );
      this.isReconnecting = false;
      this.reconnectingStartedAt = null;
      metrics.setIsReconnecting(this.chainName, false);
    });
  }

  private async reconnectWithBackoff(): Promise<void> {
    const reconnectStartedAt = this.reconnectingStartedAt ?? Date.now();
    await this.destroyProvider();

    while (this.isRunning) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(
          `[BlockMonitor:${this.chainName}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, stopping monitor`,
        );
        this.isRunning = false;
        this.isReconnecting = false;
        this.reconnectingStartedAt = null;
        metrics.recordReconnect(this.chainName, "exhausted");
        metrics.setIsAlive(this.chainName, false);
        metrics.setIsReconnecting(this.chainName, false);
        return;
      }

      this.reconnectAttempts++;
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
        MAX_DELAY_MS,
      );

      console.log(
        `[BlockMonitor:${this.chainName}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`,
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });

      if (!this.isRunning) {
        return;
      }

      this.maybeFlipUrlPreference();

      try {
        await this.connect();
        await this.subscribeToBlocks();
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.reconnectingStartedAt = null;
        this.startPingPong();
        this.resetNoBlockTimer();
        this.startPrimaryProbe();
        metrics.recordReconnect(this.chainName, "success");
        metrics.observeReconnectDuration(
          this.chainName,
          Date.now() - reconnectStartedAt,
        );
        metrics.setIsReconnecting(this.chainName, false);
        metrics.setIsAlive(this.chainName, true);
        return;
      } catch (error) {
        console.warn(
          `[BlockMonitor:${this.chainName}] Reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} failed:`,
          error instanceof Error ? error.message : error,
        );
        // Clean up the provider if connect succeeded but subscribe failed
        await this.destroyProvider();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // URL preference flip
  //
  // Catches the half-open-subscription failure mode: the primary WSS accepts
  // the upgrade, getBlockNumber() returns, eth_subscribe is acknowledged, but
  // no newHeads notifications ever arrive. From connect()'s point of view the
  // URL is healthy, so the existing fallback path never fires. After
  // SILENT_FAILOVER_THRESHOLD consecutive BLOCK_ADVANCE_TIMEOUT_MS firings on
  // the same URL, swap the URL preference so the next reconnect lands on the
  // other configured endpoint. Reset the counter on flip; if the new URL is
  // also silent, the counter will rebuild and the monitor will alternate
  // until one of them recovers. The existing primaryProbeTimer handles
  // swapping back to primary when it recovers.
  // ---------------------------------------------------------------------------

  private maybeFlipUrlPreference(): void {
    const threshold = liveness("SILENT_FAILOVER_THRESHOLD");
    if (this.silentReconnects < threshold) {
      return;
    }
    if (!(this.primaryWss && this.fallbackWss)) {
      return;
    }
    const previousLabel = this.currentUrlIndex === 0 ? "primary" : "fallback";
    const nextLabel = this.currentUrlIndex === 0 ? "fallback" : "primary";
    const nextIndex: 0 | 1 = this.currentUrlIndex === 0 ? 1 : 0;
    this.currentUrlIndex = nextIndex;
    this.silentReconnects = 0;
    metrics.setSilentReconnectsCurrent(this.chainName, 0);
    metrics.recordUrlFlip(
      this.chainName,
      nextIndex === 1 ? "to_fallback" : "to_primary",
    );
    metrics.recordWsClose(this.chainName, "silent_failover");
    console.warn(
      `[BlockMonitor:${this.chainName}] Silent-reconnect threshold (${threshold}) reached on ${previousLabel}, flipping URL preference to ${nextLabel}`,
    );
  }
}
