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

import type { LookupFunction } from "node:net";
import { ethers } from "ethers";
import { WebSocket } from "ws";
import { type ChainMetrics, metrics } from "../lib/metrics.js";
import {
  createPhantomExecution,
  failPhantomExecution,
} from "../lib/phantom.js";
import { RpcEndpointRole, RpcUsageCounter } from "../lib/rpc-route.js";
import type { BlockWorkflow, ChainConfig } from "../lib/types.js";
import { enqueueBlockTrigger } from "./sqs-enqueue.js";

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
const STALE_BLOCK_THRESHOLD_S = 120; // warn if block timestamp >2 min behind
const HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_BACKFILL_BLOCKS = 100;
const GET_BLOCK_ATTEMPTS = 2;
// Upper bound on headers kept from newHeads pushes. Entries are pruned as
// blocks are processed, so the cap only matters while processing lags.
const HEADER_CACHE_MAX_ENTRIES = 256;
const HEX_QUANTITY_PATTERN = /^0x[0-9a-fA-F]+$/;
const HEX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

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
//   GET_BLOCK_TIMEOUT_MS         bound on each fallback getBlock request
//   GET_BLOCK_RETRY_DELAY_MS     pause before the second getBlock attempt
//   GET_BLOCK_MAX_HOLD_ATTEMPTS  range attempts on an unfetched block before skipping it
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
  // Bound on each getBlock request, used only when no newHeads header is
  // cached for the block. ethers v6 never settles a request that was already
  // written to a socket that is then destroyed (recycle or upstream close).
  // Unbounded, such a request keeps isProcessing set forever and every later
  // block on every later socket is parked in pendingBlock.
  GET_BLOCK_TIMEOUT_MS: 5_000,
  // Pause before the second getBlock attempt, so a reconnect that caused the
  // first failure has a moment to install a new provider.
  GET_BLOCK_RETRY_DELAY_MS: 1_000,
  // Range attempts on a matched block whose data cannot be fetched before it
  // is skipped. Until then the monitor holds just before it and the next
  // pushed block retries it. Small so a hold resolves well within
  // MAX_BACKFILL_BLOCKS on fast chains, and later blocks are not held back.
  GET_BLOCK_MAX_HOLD_ATTEMPTS: 3,
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

export type MonitorLogger = Pick<Console, "log" | "warn" | "error">;

/** Counts RPC usage against the endpoint that served it. */
export type MonitorUsage = {
  record(role: RpcEndpointRole, counter: RpcUsageCounter): void;
};

function noop(): void {
  // intentionally does nothing
}

export const silentLogger: MonitorLogger = {
  log: noop,
  warn: noop,
  error: noop,
};

const noUsage: MonitorUsage = { record: noop };

type ChainMonitorConfig = {
  chain: ChainConfig;
  workflows: BlockWorkflow[];
  // Last block a previous monitor for this chain fully processed. When set,
  // the first block this monitor receives backfills the gap after it (up to
  // MAX_BACKFILL_BLOCKS) instead of starting fresh at that block.
  resumeFromBlock?: number | null;
  // Defaults suit KeeperHub's endpoints; organization routes inject silent ones.
  logger?: MonitorLogger;
  metrics?: ChainMetrics;
  usage?: MonitorUsage;
  // Organization routes dial their endpoints only at the app's vetted
  // addresses; undefined for a URL means ordinary DNS.
  lookupFor?: (url: string) => LookupFunction | undefined;
};

export type BlockHeader = {
  hash: string;
  timestamp: number;
  parentHash: string;
};

// Extracts the fields a block trigger needs from a newHeads push result.
// Returns null unless number, hash, parentHash and timestamp are all present
// and well-formed, so a provider that sends a partial header falls back to
// getBlock. Hashes pass through unchanged, as ethers' getBlock returns them.
export function parseNewHeadsHeader(
  result: unknown,
): { blockNumber: number; header: BlockHeader } | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const { number, hash, parentHash, timestamp } = result as Record<
    string,
    unknown
  >;
  if (
    !(
      typeof number === "string" &&
      HEX_QUANTITY_PATTERN.test(number) &&
      typeof timestamp === "string" &&
      HEX_QUANTITY_PATTERN.test(timestamp) &&
      typeof hash === "string" &&
      HEX_HASH_PATTERN.test(hash) &&
      typeof parentHash === "string" &&
      HEX_HASH_PATTERN.test(parentHash)
    )
  ) {
    return null;
  }
  const blockNumber = Number.parseInt(number, 16);
  const blockTimestamp = Number.parseInt(timestamp, 16);
  if (
    !(Number.isSafeInteger(blockNumber) && Number.isSafeInteger(blockTimestamp))
  ) {
    return null;
  }
  return {
    blockNumber,
    header: { hash, timestamp: blockTimestamp, parentHash },
  };
}

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
  // Headers from newHeads pushes, keyed by block number. The raw frame tap
  // fills it, so it also holds blocks that pendingBlock coalesced away.
  // getBlockData reads it first and needs no RPC call on a hit. Kept across
  // reconnects (a header stays valid), pruned as blocks are processed, and
  // cleared on stop().
  private readonly headerCache: Map<number, BlockHeader> = new Map();
  // Matched block that could not be fetched and is retried on the next push,
  // and how many range attempts have failed on it.
  private heldBlock: number | null = null;
  private heldBlockAttempts = 0;
  private readonly log: MonitorLogger;
  private readonly metrics: ChainMetrics;
  private readonly usage: MonitorUsage;
  private readonly lookupFor: ChainMonitorConfig["lookupFor"];

  constructor(config: ChainMonitorConfig) {
    this.log = config.logger ?? console;
    this.metrics = config.metrics ?? metrics;
    this.usage = config.usage ?? noUsage;
    this.lookupFor = config.lookupFor;
    this.chainId = config.chain.chainId;
    this.chainName = config.chain.name;
    this.primaryWss = config.chain.defaultPrimaryWss;
    this.fallbackWss = config.chain.defaultFallbackWss;
    this.workflows = config.workflows;
    this.lastProcessedBlock = config.resumeFromBlock ?? null;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.silentReconnects = 0;
    this.monitorBootAt = Date.now();
    this.metrics.setSilentReconnectsCurrent(this.chainName, 0);
    this.metrics.setWorkflowsTracked(this.chainName, this.workflows.length);
    if (this.lastProcessedBlock !== null) {
      this.log.log(
        `[BlockMonitor:${this.chainName}] Resuming after block ${this.lastProcessedBlock}, the first block received backfills the gap`,
      );
    }

    try {
      await this.connect();
      await this.subscribeToBlocks();
      this.startPingPong();
      this.resetNoBlockTimer();
      this.startPrimaryProbe();
      this.metrics.setIsAlive(this.chainName, true);
    } catch (error) {
      this.isRunning = false;
      this.metrics.setIsAlive(this.chainName, false);
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
    this.headerCache.clear();
    this.heldBlock = null;
    this.heldBlockAttempts = 0;
    // forgetChain() removes every per-chain gauge labelset, so the chain
    // disappears entirely from /metrics output. No need to flip individual
    // gauges to 0 first — that would leave residual labels behind. Counters
    // and histograms keep their cumulative history.
    this.metrics.forgetChain(this.chainName);
  }

  updateWorkflows(workflows: BlockWorkflow[]): void {
    this.workflows = workflows;
    this.metrics.setWorkflowsTracked(this.chainName, workflows.length);
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

  private currentRole(): RpcEndpointRole {
    return this.currentUrlIndex === 1
      ? RpcEndpointRole.FALLBACK
      : RpcEndpointRole.PRIMARY;
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
        this.log.warn(
          `[BlockMonitor:${this.chainName}] destroyProvider.removeAllListeners: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        await withTimeout(this.provider.destroy(), destroyTimeoutMs, "destroy");
      } catch (error) {
        this.log.warn(
          `[BlockMonitor:${this.chainName}] destroyProvider.destroy: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.provider = null;
    }
  }

  private openProvider(url: string): ethers.WebSocketProvider {
    const lookup = this.lookupFor?.(url);
    return lookup
      ? new ethers.WebSocketProvider(() => new WebSocket(url, { lookup }))
      : new ethers.WebSocketProvider(url);
  }

  private async connect(): Promise<void> {
    type Candidate = {
      url: string;
      index: 0 | 1;
      label: RpcEndpointRole;
    };
    const candidates: Candidate[] = [];
    if (this.primaryWss) {
      candidates.push({
        url: this.primaryWss,
        index: 0,
        label: RpcEndpointRole.PRIMARY,
      });
    }
    if (this.fallbackWss) {
      candidates.push({
        url: this.fallbackWss,
        index: 1,
        label: RpcEndpointRole.FALLBACK,
      });
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
        provider = this.openProvider(candidate.url);

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
        this.usage.record(candidate.label, RpcUsageCounter.REQUESTS);
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
        this.usage.record(candidate.label, RpcUsageCounter.WS_CONNECTS);
        this.metrics.setCurrentUrlIndex(this.chainName, candidate.index);
        this.log.log(
          `[BlockMonitor:${this.chainName}] Connected to ${candidate.label} WSS (block: ${blockNumber})`,
        );
        return;
      } catch (error) {
        this.usage.record(candidate.label, RpcUsageCounter.ERRORS);
        // Destroy the provider if it was created but failed/timed out
        if (provider) {
          await provider.removeAllListeners();
          await provider.destroy().catch(() => {});
        }
        this.log.warn(
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
        this.log.warn(
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

    this.log.log(
      `[BlockMonitor:${this.chainName}] Subscribing to block events`,
    );

    // ethers v6 provider.on() is async - it sends eth_subscribe over the
    // WebSocket and waits for the subscription ID. Must be awaited or the
    // subscription silently fails on reconnection.
    this.usage.record(this.currentRole(), RpcUsageCounter.REQUESTS);
    try {
      await this.provider.on("block", (blockNumber: number) => {
        this.onBlock(blockNumber).catch((error: unknown) => {
          this.log.error(
            `[BlockMonitor:${this.chainName}] Error processing block ${blockNumber}:`,
            error instanceof Error ? error.message : error,
          );
        });
      });
    } catch (error) {
      this.usage.record(this.currentRole(), RpcUsageCounter.ERRORS);
      throw error;
    }

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
    this.metrics.setHasActiveSubscription(this.chainName, true);
    this.metrics.setSubscribedAt(this.chainName, subscribedAt);
    // resetNoBlockTimer is called from start/reconnect, but seed it here too
    // for the same reason — the watchdog needs a baseline from the moment we
    // are subscribed, not from the previous run.
    this.resetNoBlockTimer();
    this.startSocketAgeTimer();
    this.log.log(`[BlockMonitor:${this.chainName}] Block subscription active`);

    // Handle WebSocket close for reconnection - store reference for cleanup
    const ws = this.provider.websocket as unknown as {
      on?: (event: string, cb: (data?: unknown) => void) => void;
    };
    if (ws?.on) {
      this.wsCloseHandler = (): void => {
        this.log.warn(`[BlockMonitor:${this.chainName}] WebSocket closed`);
        this.hasActiveSubscription = false;
        this.metrics.setHasActiveSubscription(this.chainName, false);
        this.metrics.recordWsClose(this.chainName, "upstream_close");
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
      //
      // The tap also feeds headerCache. ethers' "block" event carries only
      // the block number and drops the rest of the newHeads header, so this
      // is the only place the header is visible.
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
          const parsed = JSON.parse(text) as {
            method?: string;
            params?: { result?: unknown };
          };
          if (parsed?.method === "eth_subscription") {
            this.subscriptionPushCount++;
            this.cacheHeader(parsed.params?.result);
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
      this.log.log(
        `[BlockMonitor:${this.chainName}] First block received: ${blockNumber}, tracking ${this.workflows.length} workflow(s): ${this.workflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`,
      );
    }

    let fromBlock =
      this.lastProcessedBlock !== null
        ? this.lastProcessedBlock + 1
        : blockNumber;

    const gap = blockNumber - fromBlock;

    if (gap > MAX_BACKFILL_BLOCKS) {
      this.log.warn(
        `[BlockMonitor:${this.chainName}] Gap too large (${gap} blocks), skipping backfill. Resuming from block ${blockNumber}`,
      );
      fromBlock = blockNumber;
    } else if (fromBlock < blockNumber) {
      this.log.log(
        `[BlockMonitor:${this.chainName}] Gap detected: last=${this.lastProcessedBlock}, received=${blockNumber}, backfilling ${gap} block(s)`,
      );
    }

    for (let bn = fromBlock; bn <= blockNumber; bn++) {
      // A stopped monitor (reaped by the reconciler, leadership lost, or
      // reconnects exhausted) must not keep dispatching from work that was
      // still queued when it stopped.
      if (!this.isRunning) {
        return;
      }
      const handled = await this.processBlockNumber(bn);
      // Stopped while this block was in flight: leave state and metrics alone,
      // stop() already removed this chain's gauges.
      if (!this.isRunning) {
        return;
      }
      if (!handled && this.holdBlock(bn)) {
        return;
      }
      this.recordBlockAdvance(bn);
    }

    this.blocksReceived++;
    this.usage.record(this.currentRole(), RpcUsageCounter.EVENTS_RECEIVED);
    this.metrics.recordBlockReceived(this.chainName);

    // Heartbeat log
    const now = Date.now();
    if (now - this.lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      this.log.log(
        `[BlockMonitor:${this.chainName}] Heartbeat: block=${blockNumber}, received=${this.blocksReceived}, matched=${this.blocksMatched}, workflows=${this.workflows.length}`,
      );
      this.lastHeartbeat = now;
    }
  }

  // A real height advance, backfilled or pushed: refresh liveness after it.
  private recordBlockAdvance(blockNumber: number): void {
    this.lastProcessedBlock = blockNumber;
    if (this.heldBlock !== null && blockNumber >= this.heldBlock) {
      this.heldBlock = null;
      this.heldBlockAttempts = 0;
    }
    this.pruneHeaderCache(blockNumber);
    const advancedAt = Date.now();
    this.lastBlockAdvanceAt = advancedAt;
    // Trust the current URL again: a real height advance means the
    // subscription is delivering. Without this reset, an old streak of silent
    // reconnects would still trigger a URL flip on the next disconnect.
    this.silentReconnects = 0;
    this.resetNoBlockTimer();
    this.metrics.setLastProcessedBlock(this.chainName, blockNumber);
    this.metrics.setLastBlockAdvanceAt(this.chainName, advancedAt);
    this.metrics.setSilentReconnectsCurrent(this.chainName, 0);
  }

  // Returns true while an unfetched block is held for a retry on the next
  // push, false once its attempts are used up and it is skipped.
  private holdBlock(blockNumber: number): boolean {
    if (this.heldBlock !== blockNumber) {
      this.heldBlock = blockNumber;
      this.heldBlockAttempts = 0;
    }
    // A failure while the socket is being replaced says nothing about the
    // block itself, so it holds the block without using up an attempt.
    if (this.provider !== null && !this.isReconnecting) {
      this.heldBlockAttempts++;
    }
    const maxAttempts = liveness("GET_BLOCK_MAX_HOLD_ATTEMPTS");
    if (this.heldBlockAttempts < maxAttempts) {
      this.lastProcessedBlock = blockNumber - 1;
      this.log.warn(
        `[BlockMonitor:${this.chainName}] Holding at block ${blockNumber - 1}, block ${blockNumber} could not be fetched (attempt ${this.heldBlockAttempts}/${maxAttempts}), retrying on the next block received`,
      );
      return true;
    }
    const workflowIds = this.matchingWorkflowsFor(blockNumber).map(
      (wf) => wf.id,
    );
    this.log.error(
      `[BlockMonitor:${this.chainName}] Skipping block ${blockNumber} permanently after ${this.heldBlockAttempts} failed fetch attempts, not dispatched for workflow(s): ${workflowIds.join(", ")}`,
    );
    this.heldBlock = null;
    this.heldBlockAttempts = 0;
    return false;
  }

  private matchingWorkflowsFor(blockNumber: number): BlockWorkflow[] {
    return this.workflows.filter(
      (wf) => blockNumber > 0 && blockNumber % wf.blockInterval === 0,
    );
  }

  // Returns false when the block was not handled: a matched block whose data
  // could not be fetched, or the monitor stopped while fetching it.
  private async processBlockNumber(blockNumber: number): Promise<boolean> {
    const matchingWorkflows = this.matchingWorkflowsFor(blockNumber);

    if (matchingWorkflows.length === 0) {
      return true;
    }

    // Fetch block data for the matched block
    const block = await this.getBlockData(blockNumber);
    // A fallback getBlock can settle after the monitor was stopped.
    if (!(block && this.isRunning)) {
      return false;
    }

    // Stale block warning + lag histogram
    const nowSeconds = Math.floor(Date.now() / 1000);
    const lagSeconds = nowSeconds - block.timestamp;
    this.metrics.observeBlockLag(this.chainName, lagSeconds);
    if (lagSeconds > STALE_BLOCK_THRESHOLD_S) {
      this.log.warn(
        `[BlockMonitor:${this.chainName}] Block ${blockNumber} timestamp is ${lagSeconds}s behind wall clock`,
      );
    }

    this.blocksMatched++;
    this.metrics.recordBlockMatched(this.chainName);
    this.log.log(
      `[BlockMonitor:${this.chainName}] Block ${blockNumber} matched ${matchingWorkflows.length} workflow(s): ${matchingWorkflows.map((wf) => `${wf.id}(interval=${wf.blockInterval})`).join(", ")}`,
    );

    const results = await Promise.allSettled(
      matchingWorkflows.map((wf) =>
        this.enqueueWithPhantom(wf, blockNumber, block),
      ),
    );

    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        this.metrics.recordSqsEnqueue(this.chainName, "error");
        this.log.error(
          `[BlockMonitor:${this.chainName}] Failed to enqueue workflow ${matchingWorkflows[index].id}:`,
          result.reason,
        );
      } else {
        this.metrics.recordSqsEnqueue(this.chainName, "success");
      }
    }
    return true;
  }

  /**
   * KEEP-693: pre-create a phantom row (best-effort) then enqueue the block
   * trigger carrying its id. On enqueue failure, resolve the phantom to a coded
   * failure and re-throw so the caller's per-result error metric still fires.
   */
  private async enqueueWithPhantom(
    wf: BlockWorkflow,
    blockNumber: number,
    block: BlockHeader,
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
      this.log.log(
        `[BlockMonitor:${this.chainName}] Skipping refused dispatch for ${dispatchKey} (${refused})`,
      );
      this.metrics.recordDispatchRefused(this.chainName, refused);
      return;
    }

    if (alreadyExisted) {
      this.log.log(
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

  private cacheHeader(result: unknown): void {
    const parsed = parseNewHeadsHeader(result);
    if (!parsed) {
      return;
    }
    if (
      this.lastProcessedBlock !== null &&
      parsed.blockNumber <= this.lastProcessedBlock
    ) {
      return;
    }
    // A reorg can push a second header for the same height; the newest wins.
    this.headerCache.set(parsed.blockNumber, parsed.header);
    if (this.headerCache.size > HEADER_CACHE_MAX_ENTRIES) {
      // Map iterates in insertion order, so the first key is the oldest.
      const oldest = this.headerCache.keys().next().value;
      if (oldest !== undefined) {
        this.headerCache.delete(oldest);
      }
    }
  }

  private pruneHeaderCache(processedUpTo: number): void {
    for (const cachedBlock of this.headerCache.keys()) {
      if (cachedBlock <= processedUpTo) {
        this.headerCache.delete(cachedBlock);
      }
    }
  }

  private async getBlockData(blockNumber: number): Promise<BlockHeader | null> {
    const cached = this.headerCache.get(blockNumber);
    if (cached) {
      return cached;
    }

    // No pushed header for this block (for example it was mined while the
    // socket was down, or the provider sends partial headers): fetch it.
    const timeoutMs = liveness("GET_BLOCK_TIMEOUT_MS");
    let failure = "no connected provider";
    for (let attempt = 0; attempt < GET_BLOCK_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, liveness("GET_BLOCK_RETRY_DELAY_MS"));
        });
        if (!this.isRunning) {
          return null;
        }
      }
      // Read the provider per attempt: a reconnect between attempts replaces
      // it, and it is null while the reconnect is in progress.
      const provider = this.provider;
      if (!provider) {
        failure = "no connected provider";
        continue;
      }
      const role = this.currentRole();
      this.usage.record(role, RpcUsageCounter.REQUESTS);
      try {
        const block = await withTimeout(
          provider.getBlock(blockNumber),
          timeoutMs,
          "getBlock",
        );
        if (block) {
          return {
            hash: block.hash ?? "",
            timestamp: block.timestamp,
            parentHash: block.parentHash,
          };
        }
        failure = "getBlock returned null";
      } catch (error) {
        this.usage.record(role, RpcUsageCounter.ERRORS);
        failure = error instanceof Error ? error.message : String(error);
      }
    }

    this.log.warn(
      `[BlockMonitor:${this.chainName}] Failed to fetch block ${blockNumber} after ${GET_BLOCK_ATTEMPTS} attempts:`,
      failure,
    );
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
      this.log.warn(
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
        this.log.warn(
          `[BlockMonitor:${this.chainName}] Failed to send ping, triggering reconnect`,
        );
        this.metrics.recordWsClose(this.chainName, "ping_send_failure");
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
        this.log.warn(
          `[BlockMonitor:${this.chainName}] Pong timeout (${pongTimeoutMs}ms), triggering reconnect`,
        );
        this.metrics.recordWsClose(this.chainName, "pong_timeout");
        this.handleDisconnect();
      }, pongTimeoutMs);
    }, pingIntervalMs);

    this.log.log(
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
        this.metrics.setSilentReconnectsCurrent(
          this.chainName,
          this.silentReconnects,
        );
        this.metrics.recordWsClose(this.chainName, "block_advance_timeout");
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
        this.log.warn(
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
      this.log.log(
        `[BlockMonitor:${this.chainName}] Socket age exceeded ${Math.floor(maxAgeMs / 1000)}s, recycling`,
      );
      this.metrics.recordWsClose(this.chainName, "socket_age_recycle");
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
      probeProvider = this.openProvider(this.primaryWss);
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

      this.usage.record(RpcEndpointRole.PRIMARY, RpcUsageCounter.REQUESTS);
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

      this.log.log(
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
      this.metrics.recordUrlFlip(this.chainName, "to_primary");
      this.metrics.recordWsClose(this.chainName, "primary_probe_recovered");
      this.handleDisconnect();
    } catch (error) {
      this.usage.record(RpcEndpointRole.PRIMARY, RpcUsageCounter.ERRORS);
      const reason = summarizeProbeError(error);
      this.log.warn(
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
    this.metrics.setIsReconnecting(this.chainName, true);
    this.metrics.setHasActiveSubscription(this.chainName, false);
    this.stopTimers();

    this.reconnectWithBackoff().catch((error: unknown) => {
      this.log.error(
        `[BlockMonitor:${this.chainName}] Reconnect loop failed:`,
        error instanceof Error ? error.message : error,
      );
      this.isReconnecting = false;
      this.reconnectingStartedAt = null;
      this.metrics.setIsReconnecting(this.chainName, false);
    });
  }

  private async reconnectWithBackoff(): Promise<void> {
    const reconnectStartedAt = this.reconnectingStartedAt ?? Date.now();
    await this.destroyProvider();

    while (this.isRunning) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        this.log.error(
          `[BlockMonitor:${this.chainName}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, stopping monitor`,
        );
        this.isRunning = false;
        this.isReconnecting = false;
        this.reconnectingStartedAt = null;
        this.metrics.recordReconnect(this.chainName, "exhausted");
        this.metrics.setIsAlive(this.chainName, false);
        this.metrics.setIsReconnecting(this.chainName, false);
        return;
      }

      this.reconnectAttempts++;
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
        MAX_DELAY_MS,
      );

      this.log.log(
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
        this.usage.record(this.currentRole(), RpcUsageCounter.WS_RECONNECTS);
        this.reconnectAttempts = 0;
        this.isReconnecting = false;
        this.reconnectingStartedAt = null;
        this.startPingPong();
        this.resetNoBlockTimer();
        this.startPrimaryProbe();
        this.metrics.recordReconnect(this.chainName, "success");
        this.metrics.observeReconnectDuration(
          this.chainName,
          Date.now() - reconnectStartedAt,
        );
        this.metrics.setIsReconnecting(this.chainName, false);
        this.metrics.setIsAlive(this.chainName, true);
        return;
      } catch (error) {
        this.log.warn(
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
    const previousLabel = this.currentRole();
    const nextLabel =
      this.currentUrlIndex === 0
        ? RpcEndpointRole.FALLBACK
        : RpcEndpointRole.PRIMARY;
    const nextIndex: 0 | 1 = this.currentUrlIndex === 0 ? 1 : 0;
    this.currentUrlIndex = nextIndex;
    this.silentReconnects = 0;
    this.metrics.setSilentReconnectsCurrent(this.chainName, 0);
    this.metrics.recordUrlFlip(
      this.chainName,
      nextIndex === 1 ? "to_fallback" : "to_primary",
    );
    this.metrics.recordWsClose(this.chainName, "silent_failover");
    this.log.warn(
      `[BlockMonitor:${this.chainName}] Silent-reconnect threshold (${threshold}) reached on ${previousLabel}, flipping URL preference to ${nextLabel}`,
    );
  }
}
