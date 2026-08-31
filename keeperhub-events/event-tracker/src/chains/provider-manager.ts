import { ethers } from "ethers";
import { WebSocket } from "ws";
import { logger } from "../../lib/utils/logger";

/**
 * ChainProviderManager centralises WebSocket provider ownership and
 * block-based log delivery per chain. One provider and one
 * `eth_subscribe(newHeads)` subscription per chainId, regardless of how
 * many listeners are registered for that chain.
 *
 * Log delivery uses block subscription + batched `eth_getLogs` rather than
 * one `eth_subscribe(logs, ...)` per listener. This decouples RPC-side
 * subscription count from workflow count (provider subscription caps are
 * typically ~1000 per WSS).
 *
 * Request volume is driven by block rate, so a sub-second chain costs orders
 * of magnitude more than a 12 s one for the same subscriptions. Requests are
 * therefore rate limited rather than issued per block: each chain keeps a
 * high-water mark of the last block it has served, and a drain fetches
 * `(mark, head]` at most once per `GETLOGS_MIN_INTERVAL_MS`.
 *
 * Nothing branches on how fast a chain is. A chain whose blocks arrive
 * further apart than that interval always finds it already elapsed and
 * dispatches immediately - one request per block, as before - while a faster
 * one accumulates against the mark and is served in one ranged request. The
 * range is contiguous, so blocks the subscription never pushed are covered
 * too, and the mark survives a reconnect so a replacement connection resumes
 * rather than starting blind.
 *
 * Per-chain reconnect + heartbeat are owned here. Drop detection uses two
 * signals:
 *   - `provider.on("error")` for transport-level errors surfaced by ethers
 *   - An active heartbeat that pings `eth_blockNumber` every
 *     `HEARTBEAT_INTERVAL_MS` with a `HEARTBEAT_TIMEOUT_MS` cap
 *
 * A passive `websocket.on("close")` hook was considered but rejected: it
 * reaches into `(provider as any).websocket`, breaks between ethers
 * versions, and adds no detection we do not already get from the
 * heartbeat. Detection latency is bounded by heartbeat cadence, which is
 * tuneable via the constants below.
 *
 * On drop: fire registered `onDisconnect` handlers, then attempt reconnect
 * with exponential backoff. On exhaustion: call the injected
 * `onPermanentFailure` callback (defaults to `process.exit(1)` so K8s
 * restarts the pod - tests inject a no-op).
 */

// Address list cap on `eth_getLogs` varies by provider (Alchemy ~500,
// Infura ~1000). Chunk defensively; multiple calls per block are cheap.
export const GETLOGS_ADDRESS_BATCH = 500;

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
/**
 * Ceiling on the gap between delivered blocks before a subscribed chain's
 * connection is treated as dead. The heartbeat pings `eth_blockNumber`, a
 * request/response RPC call that stays healthy even when the `newHeads` push
 * subscription has silently stopped delivering blocks - so a stalled
 * subscription passes the heartbeat forever. Block-staleness is the only
 * signal that catches that state. Checked on each heartbeat tick, so
 * effective detection latency is this value plus up to one
 * HEARTBEAT_INTERVAL_MS. Defaults well above any supported chain's block
 * time so a slow-but-healthy chain is never reconnected for a normal
 * inter-block gap; overridable per-manager for tests.
 */
export const BLOCK_STALENESS_TIMEOUT_MS = 120_000;
/**
 * Floor on the derived staleness threshold for a batching chain. A chain
 * producing blocks every 100 ms would otherwise derive a 1 s threshold and
 * reconnect on any brief upstream hiccup. 30 s is ~300 blocks of slack there,
 * still three orders of magnitude tighter than the fixed default.
 */
export const BLOCK_STALENESS_FLOOR_MS = 30_000;
/**
 * Blocks of slack the derived staleness threshold allows.
 *
 * Chosen so that no chain running today changes: at 60 blocks, Base's 2 s
 * cadence derives 120 s and Ethereum's 12 s clamps to the same, which is what
 * both had before any of this existed. A 100 ms chain derives 6 s and takes
 * the 30 s floor instead. The value is live between those - a 1 s chain
 * derives 60 s - so tuning it has an effect rather than being absorbed by a
 * bound, which is what a multiplier of 10 was: every reachable cadence
 * produced a value below the floor, making the constant dead and the
 * documented `max(floor, interval x N)` rule unobservable.
 */
export const BLOCK_STALENESS_BLOCK_MULTIPLIER = 60;

/**
 * Minimum wall-clock gap between `eth_getLogs` requests for one chain.
 *
 * Request volume is driven by block rate, so a sub-second chain costs orders
 * of magnitude more than a 12 s one for the same subscriptions: at 100 ms a
 * chain issues 864,000 calls/day/address-batch against Base's 43,200. Rate
 * limiting the request rather than measuring the chain bounds that directly -
 * one call per second per chain, whatever the cadence.
 *
 * Nothing here is conditional on a chain being fast. A chain whose blocks
 * arrive further apart than this always finds the interval already elapsed
 * and dispatches immediately, so every chain supported today - 2 s at the
 * fastest - keeps one request per block and its current latency without a
 * threshold deciding anything. A 100 ms chain finds it has not, and its
 * blocks accumulate against the high-water mark until it has.
 *
 * The gap is well inside the 0-10 s jitter `EventListener` already applies
 * before forwarding a matched event, so it is not the binding term in
 * end-to-end trigger latency on any chain.
 */
export const GETLOGS_MIN_INTERVAL_MS = 1_000;
/**
 * Ceiling on the block span of a single request, so a wide gap - a long
 * reconnect, a slow drain, a chain that ran ahead - cannot produce one
 * oversized response or trip a provider's block-range limit. A remainder is
 * left for the next drain rather than dropped.
 */
export const GETLOGS_MAX_BLOCK_SPAN = 25;
/**
 * Ceiling on how far behind the head the mark may fall before the gap is
 * abandoned rather than walked.
 *
 * The mark survives a reconnect, which is what lets a drain recover blocks
 * the subscription missed while it was down. Left unbounded, a long outage on
 * a fast chain would queue hours of catch-up at one request per second and
 * starve current blocks behind history nobody is waiting for. Past this the
 * mark jumps to the head and the skip is logged, so the loss is recorded
 * rather than silent.
 */
export const GETLOGS_MAX_CATCHUP_BLOCKS = 5_000;
/**
 * How far back the mark may be rewound when a height is delivered a second
 * time.
 *
 * `newHeads` re-announcing a height the mark has already passed means the
 * chain reorganised: the logs at that height may not be the ones already
 * dispatched. Rewinding makes the next drain re-cover the range, and the
 * dedup layer drops whatever is unchanged - which is the behaviour dedup was
 * built for, its own header naming reorg replay alongside reconnects and pod
 * restarts.
 *
 * Bounded because a rewind is re-fetching: a stray very old height must not be
 * able to schedule thousands of blocks of re-reads. Anything deeper than this
 * is a chain failure rather than an ordinary reorg, and is logged instead.
 */
export const REORG_REWIND_MAX_BLOCKS = 32;
/** EWMA smoothing factor for the inter-block interval. */
const BLOCK_INTERVAL_EWMA_ALPHA = 0.2;
/**
 * Inter-block intervals required before the cadence estimate is trusted.
 */
export const BLOCK_INTERVAL_MIN_SAMPLES = 20;
/**
 * Wall-clock the samples must also span before the estimate is trusted.
 *
 * A sample count alone is not evidence of cadence. Twenty `newHeads` messages
 * drained back-to-back out of a socket buffer after an event-loop stall are
 * twenty samples milliseconds apart, and would read a 12 s chain as a 1 ms
 * one. Requiring the samples to cover real time as well makes that
 * impossible: a burst cannot manufacture a minute.
 */
export const BLOCK_INTERVAL_MIN_SPAN_MS = 60_000;
/**
 * Cadence of the per-chain `getlogs-stats` line.
 *
 * Batching is a cost change, so it has to be measurable to be worth
 * trusting, and nothing outside this process can measure it. The package
 * ships no prom-client, no OpenTelemetry and no `/metrics` route, and the
 * health server binds `HEALTH_PORT` (default 3001) while the deployment
 * declares only 3000, so an endpoint added here would not be reachable.
 * Aetherlay cannot stand in either: its
 * `aetherlay_endpoint_proxy_requests_total` increments once per WebSocket
 * *connection* and only per request on the HTTP path, so calls tunnelled
 * through a long-lived socket - which is every call this class makes -
 * never move it, on any cluster.
 *
 * That leaves the log stream. `logger` emits canonical single-line JSON
 * precisely so Loki can aggregate across the app and its satellites, so a
 * periodic line is the one channel that makes calls-per-day observable.
 *
 * The counters are packed as key=value inside `msg` rather than as JSON
 * fields, because the logger has no structured-field API. Querying them
 * therefore needs the inner parse as well:
 *
 *   {namespace="keeperhub"} |= "getlogs-stats"
 *     | json | line_format "{{.msg}}" | logfmt
 *
 * `| json` alone yields `msg` as one string, not the individual counters.
 */
export const STATS_LOG_INTERVAL_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
/**
 * Cap on `eth_subscribe(["newHeads"])` round-trip during the probe in
 * `probeSubscriptionSupport`. An upstream that accepts the WS handshake
 * but never answers the JSON-RPC frame (silent backend, broken proxy) would
 * otherwise block `createProvider` forever. 10 s matches the heartbeat
 * timeout in `startHeartbeat` so the two reachability gates fail at the
 * same scale.
 */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * Cap on the WS handshake + first RPC round-trip during `openProvider`.
 * `getBlockNumber()` internally calls ethers' `_waitUntilReady()`, which
 * resolves on socket open but never rejects on socket failure - so a host
 * that DNS-fails or refuses the TCP connect would otherwise hang the
 * connect attempt indefinitely. Matches `PROBE_TIMEOUT_MS` so both
 * connect-time reachability gates fail at the same scale.
 */
const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Cap on an `eth_getLogs` round-trip in `processBlockRange`. A request
 * already written to the socket has no other timeout: ethers does not
 * reject it on its own, and a heartbeat on the same socket can keep
 * passing while this specific request never answers.
 *
 * Deliberately looser than the 10 s connect and probe gates. Those bound a
 * handshake and a single trivial frame; this bounds a real query over up to
 * `GETLOGS_MAX_BLOCK_SPAN` blocks and `GETLOGS_ADDRESS_BATCH` addresses,
 * which on a busy chain or a loaded upstream can legitimately take many
 * seconds. Sizing it to match the connect gate would turn slow-but-working
 * queries into permanent failures, and a range that never succeeds never
 * advances the mark.
 */
export const GETLOGS_TIMEOUT_MS = 30_000;
/**
 * Consecutive `eth_getLogs` timeouts on one connection before the chain is
 * reconnected. A single timeout is a slow upstream and worth retrying in
 * place; a run of them is a socket that will not serve this call again, and
 * no other check in this class notices - the heartbeat is a different
 * request and still answers, and blocks keep arriving so the staleness
 * watchdog never fires. Without this the chain retries into the void until
 * the gap crosses `GETLOGS_MAX_CATCHUP_BLOCKS` and its events are dropped.
 */
export const GETLOGS_TIMEOUT_RECONNECT_THRESHOLD = 3;

/** Marks the timeout branch of the `eth_getLogs` race, for escalation. */
class GetLogsTimeoutError extends Error {}

export type LogHandler = (log: ethers.Log) => void | Promise<void>;
export type Unsubscribe = () => void;

export type ProviderFactory = (wssUrl: string) => ethers.WebSocketProvider;

export type DisconnectReason =
  | "provider_error"
  | "heartbeat_failure"
  | "heartbeat_timeout"
  | "block_staleness"
  | "getlogs_timeout";

export interface DisconnectEvent {
  chainId: number;
  reason: DisconnectReason;
  message: string;
}

export type DisconnectHandler = (ev: DisconnectEvent) => void | Promise<void>;

/**
 * Reduce an RPC URL to what an operator needs and nothing more.
 *
 * The configured URLs carry credentials at runtime. `chain-config` stores
 * `${DRPC_API_KEY}` as a placeholder, but the deploy workflow substitutes the
 * real key into the value before writing it to SSM, so the string this process
 * holds is a live secret for 19 of 22 chains.
 *
 * Only scheme and host survive. That is the whole diagnostic purpose - which
 * upstream is serving, and therefore whether failover has kicked in - while
 * the chain is already identified by `chainId`, so nothing is lost by dropping
 * the path. Fails closed: a URL that will not parse is replaced entirely
 * rather than passed through on the assumption it holds no secret.
 *
 * The host is kept deliberately, and that is an assumption rather than a
 * guarantee: a provider that puts the token in the subdomain - QuickNode and
 * Chainstack both do - would survive this untouched. No configured upstream
 * does today (checked across both env files: no userinfo, no query strings, no
 * host-borne credentials), and the host is what makes failover diagnosable, so
 * it stays. Revisit when an upstream of that shape is added.
 */
export function redactRpcUrl(url: string | null): string | null {
  if (url === null) {
    return null;
  }
  try {
    const parsed = new URL(url);
    const hasMore = parsed.pathname !== "/" || parsed.search !== "";
    return `${parsed.protocol}//${parsed.host}${hasMore ? "/[redacted]" : ""}`;
  } catch {
    return "[redacted]";
  }
}

export interface ChainHealth {
  chainId: number;
  /**
   * The URL the live provider was opened against, or the configured
   * primary if no provider is currently connected. Equals the configured
   * fallback when the most recent successful (re)connect landed on it;
   * resets to the configured primary during a mid-reconnect window
   * because `reconnect()` clears `activeWssUrl` before re-attempting.
   *
   * Scheme and host only - see `redactRpcUrl`. The configured value carries a
   * live credential at runtime.
   */
  wssUrl: string;
  /**
   * Configured fallback URL, or null if none. Surfaced so operators can
   * see whether failover capacity exists for this chain. Scheme and host
   * only, for the same reason as `wssUrl`.
   */
  fallbackWssUrl: string | null;
  connected: boolean;
  reconnecting: boolean;
  lastBlockAt: number | null;
  subscriberCount: number;
  /**
   * Smoothed inter-block interval in milliseconds, or null before the
   * current connection has observed enough intervals to estimate one.
   * Per connection, like the estimate that drives batching.
   */
  blockIntervalMs: number | null;
  /**
   * How many blocks the head is ahead of the last block served, or null
   * before the first block arrives. Zero on a chain keeping up; a persistently
   * positive value means requests are being rate limited behind the head.
   */
  blocksBehindHead: number | null;
  /**
   * Cumulative `eth_getLogs` calls issued for this chain since the entry was
   * created, across reconnects. Named to match `getLogsCallsTotal` on the
   * `getlogs-stats` line, which is its source: the line's `getLogsCalls` is
   * the per-interval count, a different quantity, and giving the two the same
   * name invited reading a rate as a counter.
   */
  getLogsCallsTotal: number;
  /**
   * If the most recent `createProvider` attempt rejected, the error
   * message captured at rejection time. Cleared on the next successful
   * provider creation. Surfaces probe failures and other setup errors
   * through `/healthz` so an operator can see *why* a chain is
   * disconnected, not just that it is.
   */
  lastCreateError: string | null;
}

export interface SubscribeOptions {
  chainId: number;
  wssUrl: string;
  /**
   * Optional secondary URL tried when the primary fails at provider
   * creation or reconnect. See `ChainEntry.fallbackWssUrl`.
   */
  fallbackWssUrl?: string;
  address: string;
  topic0: string;
  handler: LogHandler;
}

export interface ChainProviderManagerOptions {
  factory?: ProviderFactory;
  onPermanentFailure?: (chainId: number) => void;
  /**
   * Override the block-staleness ceiling (defaults to
   * BLOCK_STALENESS_TIMEOUT_MS). Tests set a small value to exercise the
   * watchdog without advancing timers past the production threshold.
   */
  blockStalenessTimeoutMs?: number;
}

interface Subscriber {
  address: string; // normalized to lowercase
  topic0: string; // 0x-prefixed, lowercase
  handler: LogHandler;
}

interface ChainEntry {
  chainId: number;
  /**
   * Configured primary URL; immutable once the entry is created. Each
   * (re)connect attempt tries this first.
   */
  wssUrl: string;
  /**
   * Configured fallback URL, immutable once the entry is created. Tried
   * only when the primary attempt fails (factory throws, the connect
   * race in `openProvider` rejects, or the `eth_subscribe` probe
   * rejects). Reconnects always start over from primary so a primary
   * that recovers is preferred.
   */
  fallbackWssUrl: string | null;
  /**
   * Which URL the live provider was created from. Equal to `wssUrl` on
   * the common path, equal to `fallbackWssUrl` when the primary failed
   * at the last (re)connect, null when no provider is live.
   */
  activeWssUrl: string | null;
  provider: ethers.WebSocketProvider | null;
  readyPromise: Promise<ethers.WebSocketProvider> | null;
  /**
   * Live while a reconnect loop is running. Callers awaiting a provider
   * (`getOrCreateProvider`) must wait on this first so they do not fire a
   * second `createProvider` that races with the reconnect's own factory
   * call and produces two parallel providers on the same chain.
   */
  reconnectPromise: Promise<void> | null;
  subscribers: Set<Subscriber>;
  blockListener: ((blockNumber: number) => Promise<void>) | null;
  errorListener: ((err: Error) => void) | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  isReconnecting: boolean;
  lastBlockAt: number | null;
  /**
   * When the current block listener was attached. Baseline for the
   * block-staleness watchdog before the first block arrives, so a
   * connection that never delivers a single block (subscription that
   * silently failed to establish) is still caught. Null while no block
   * listener is attached.
   */
  blockListenerAttachedAt: number | null;
  /**
   * Arrival time of the previous block, used only to measure inter-block
   * intervals. Distinct from `lastBlockAt`, which survives a reconnect as the
   * staleness baseline: folding the downtime gap into the cadence estimate
   * would read a fast chain as slow. Reset on every block-listener attach.
   */
  lastBlockIntervalAt: number | null;
  /**
   * EWMA of inter-block arrival intervals in ms, or null before the first
   * interval is observed. Used only to size the block-staleness threshold -
   * dispatch does not consult it, so a wrong estimate cannot change which
   * logs are fetched.
   */
  blockIntervalEwmaMs: number | null;
  /** Intervals folded into `blockIntervalEwmaMs` since the last attach. */
  blockIntervalSamples: number;
  /** When the first interval since the last attach was recorded. */
  blockIntervalFirstSampleAt: number | null;
  /**
   * Highest block whose logs have been fetched and dispatched. The drain
   * queries forward from here, so it is the one piece of state that decides
   * what is owed. Survives a reconnect: a replacement connection resumes
   * where the old one stopped rather than starting blind.
   */
  lastProcessedBlock: number | null;
  /** Highest block number the subscription has reported. */
  headBlock: number | null;
  /** When the last `eth_getLogs` request for this chain was issued. */
  lastRequestAt: number | null;
  /** Armed when blocks are owed but the minimum interval has not elapsed. */
  catchUpTimer: ReturnType<typeof setTimeout> | null;
  /**
   * True while a drain is in flight. Blocks keep arriving during a request,
   * and each one calls `drain`; without this they would issue overlapping
   * requests for overlapping ranges.
   */
  draining: boolean;
  /**
   * The `to` of the range the in-flight drain is serving, or null when no
   * drain is in flight. Its `eth_getLogs` was issued before anything
   * announced since, so every height up to here is already spoken for by a
   * request that cannot contain a later reorg - which is what makes it, and
   * not the mark alone, the boundary `rewindForReorg` measures against.
   */
  drainingTo: number | null;
  /**
   * Lowest `blockNumber - 1` a re-announcement has asked the mark to rewind
   * to, or null when nothing is pending. Recorded rather than applied on the
   * spot: a drain in flight commits its own `to` when it finishes, so a mark
   * moved backwards underneath it is overwritten and the re-fetch is lost.
   * The next drain applies this, taking whichever of the two is lower.
   */
  pendingRewindTo: number | null;
  /**
   * Consecutive `eth_getLogs` timeouts on the current connection, reset by
   * any range that returns and by every fresh connection. A socket that
   * answers heartbeat pings but never answers `eth_getLogs` passes every
   * other liveness check this class has, so the timeout has to escalate on
   * its own or the chain retries into the void forever.
   */
  consecutiveGetLogsTimeouts: number;
  /**
   * Populated when `createProvider` rejects (most often the
   * subscription probe). Cleared on the next successful creation.
   * Surfaced through `getAllHealth` for `/healthz` consumers.
   */
  lastCreateError: string | null;
  disconnectHandlers: Set<DisconnectHandler>;
  stats: ChainStats;
}

/**
 * Per-chain request counters behind the `getlogs-stats` line. Everything
 * except `getLogsCallsTotal` is reset once reported, so a line describes the
 * interval it covers rather than needing two lines differenced.
 *
 * None of it resets on reconnect. The cadence estimate is per connection
 * because a new socket may be a different upstream; cost is per chain.
 *
 * `blocksCovered / ranges` is the ratio the rate limiting exists to move, and
 * it is self-comparing: a chain dispatching one request per block reports
 * exactly 1, a rate-limited chain reports the average blocks served per
 * request. That matters because there is no historical baseline for this
 * quantity to compare a later reading against - nothing has ever counted it.
 *
 * Read it against `ranges`, not `getLogsCalls`. `getLogsCalls` counts one per
 * address chunk, so a chain with more than `GETLOGS_ADDRESS_BATCH` subscribed
 * addresses issues several calls per range and the blocks-per-call figure
 * halves for a reason that has nothing to do with coalescing. `getLogsCalls`
 * is the cost number - it is what a provider bills - and `ranges` is the
 * denominator that isolates the behaviour.
 */
interface ChainStats {
  getLogsCalls: number;
  getLogsErrors: number;
  blocksCovered: number;
  ranges: number;
  logsDispatched: number;
  /** Blocks abandoned by the catch-up bound rather than fetched. */
  blocksSkipped: number;
  /** Times a re-announced height rewound the mark. */
  reorgRewinds: number;
  /** Times a re-announced height was too deep to rewind to, so was dropped. */
  reorgRewindsRefused: number;
  getLogsCallsTotal: number;
}

function newChainStats(): ChainStats {
  return {
    getLogsCalls: 0,
    getLogsErrors: 0,
    blocksCovered: 0,
    ranges: 0,
    logsDispatched: 0,
    blocksSkipped: 0,
    reorgRewinds: 0,
    reorgRewindsRefused: 0,
    getLogsCallsTotal: 0,
  };
}

/**
 * Wrap socket construction so we can attach an EventEmitter-style `error`
 * listener synchronously, before ethers' WebSocketProvider has had a
 * chance to assign its own `onerror`. Without this, an early ws-layer
 * error (DNS NXDOMAIN, ECONNREFUSED, non-WS server returning HTTP 200)
 * fires on a listenerless EventEmitter, gets re-thrown synchronously,
 * escapes openProvider's try/catch as `uncaughtException`, and `index.ts`
 * exits the pod - which would crashloop the whole event-tracker on a
 * misconfigured WSS URL even when a healthy fallback is configured.
 *
 * The listener is a no-op: actual error propagation happens through
 * `attachConnectErrorListener` (a second listener attached in
 * `openProvider`), which rejects the connect race that walks to the
 * fallback URL. We just need *some* error listener to be on the ws by
 * the time the connection attempt resolves so the EventEmitter does not
 * re-throw synchronously.
 */
const defaultFactory: ProviderFactory = (wssUrl) =>
  new ethers.WebSocketProvider(() => {
    const socket = new WebSocket(wssUrl);
    socket.on("error", () => {
      // intentionally empty - see comment on defaultFactory
    });
    return socket;
  });

const defaultOnPermanentFailure = (chainId: number): void => {
  logger.error(
    `[ChainProviderManager] chain=${chainId} permanent failure after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts; exiting process for K8s restart`,
  );
  process.exit(1);
};

/**
 * Returns a Promise<never> that rejects when the provider's underlying ws
 * emits "error". The no-op listener in `defaultFactory` exists only to
 * keep the EventEmitter happy and prevent uncaughtException; this listener
 * does the actual error propagation that `openProvider`'s race needs to
 * walk to the fallback URL instead of hanging on `getBlockNumber()`.
 *
 * Cast through unknown because ethers does not expose `.websocket` in its
 * public type even though it is the documented hook for direct ws access.
 * A factory that returns a provider without a usable `.websocket` (e.g. a
 * test mock) leaves this promise pending, so the race falls back to the
 * timeout - acceptable for tests, and the connect path is exercised by
 * the integration tests in `provider-manager-bad-url.test.ts`.
 */
const attachConnectErrorListener = (
  provider: ethers.WebSocketProvider,
): Promise<never> => {
  const ws = provider.websocket as unknown as {
    on?: (event: string, cb: (err: Error) => void) => void;
  };
  return new Promise<never>((_, reject) => {
    ws?.on?.("error", (err: Error) => {
      const message = err?.message ?? String(err);
      reject(new Error(`WebSocket error: ${message}`));
    });
  });
};

export class ChainProviderManager {
  private readonly chains = new Map<number, ChainEntry>();
  private readonly factory: ProviderFactory;
  private readonly onPermanentFailure: (chainId: number) => void;
  /**
   * Explicit override for the block-staleness threshold. Null means derive it
   * per chain; tests set a small value to exercise the watchdog.
   */
  private readonly blockStalenessTimeoutOverrideMs: number | null;
  /**
   * Manager-wide timer for the periodic per-chain counter line. Started with
   * the first block listener and cleared by `destroy`, which the shutdown
   * path calls. Not unref'd, matching every other timer in this class.
   */
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private isDestroyed = false;
  // Wake-up signal for in-flight reconnect sleeps: `destroy()` resolves
  // this promise, racing any pending backoff sleep so the reconnect loop
  // checks `isDestroyed` and bails promptly instead of waiting out its
  // full delay. Without this, `destroy()` hangs when tests switch from
  // fake to real timers with a fake-timer sleep still pending.
  private readonly destroyed: {
    promise: Promise<void>;
    resolve: () => void;
  };

  constructor(opts: ChainProviderManagerOptions = {}) {
    this.factory = opts.factory ?? defaultFactory;
    this.onPermanentFailure =
      opts.onPermanentFailure ?? defaultOnPermanentFailure;
    this.blockStalenessTimeoutOverrideMs = opts.blockStalenessTimeoutMs ?? null;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.destroyed = { promise, resolve };
  }

  async getOrCreateProvider(
    chainId: number,
    wssUrl: string,
    fallbackWssUrl?: string,
  ): Promise<ethers.WebSocketProvider> {
    const entry = this.ensureEntry(chainId, wssUrl, fallbackWssUrl);

    // If a reconnect loop is live, wait for it to settle before checking
    // the provider. Without this, a new subscriber arriving while the
    // old provider has been torn down but the new one is not yet
    // assigned races the reconnect's factory call and produces a second
    // orphaned provider.
    if (entry.reconnectPromise) {
      await entry.reconnectPromise;
    }

    if (entry.provider) {
      return entry.provider;
    }

    // Two concurrent callers must receive the same provider instance, not
    // race to create separate ones.
    if (!entry.readyPromise) {
      const created = this.createProvider(entry);
      entry.readyPromise = created;
      // Clear the cached promise on rejection so the next caller (the
      // reconciler runs every 30s in main.ts:70) retries from scratch.
      // Without this a transient probe failure or RPC hiccup permanently
      // disables the chain until pod restart - the same rejected promise
      // would be returned to every subsequent getOrCreateProvider call.
      // The check guards against clobbering a fresh attempt that another
      // caller may have already kicked off.
      created.catch((err: unknown) => {
        entry.lastCreateError =
          err instanceof Error ? err.message : String(err);
        if (entry.readyPromise === created) {
          entry.readyPromise = null;
        }
      });
    }
    return entry.readyPromise;
  }

  async subscribeToLogs(opts: SubscribeOptions): Promise<Unsubscribe> {
    const entry = this.ensureEntry(
      opts.chainId,
      opts.wssUrl,
      opts.fallbackWssUrl,
    );
    await this.getOrCreateProvider(
      opts.chainId,
      opts.wssUrl,
      opts.fallbackWssUrl,
    );

    const subscriber: Subscriber = {
      address: opts.address.toLowerCase(),
      topic0: opts.topic0.toLowerCase(),
      handler: opts.handler,
    };
    entry.subscribers.add(subscriber);

    // Block listener and heartbeat are lifecycle-tied to subscribers:
    // attach on the first, detach on the last. Heartbeat on an idle
    // provider is wasted RPC calls, so creating a provider via bare
    // `getOrCreateProvider` without subscribing leaves it silent until
    // the first subscribe. Key off `!entry.blockListener` rather than
    // "was this the first subscriber" so that a fresh provider created
    // after a permanent-failure + test-injected no-op + resubscribe
    // still gets wired up correctly.
    if (!entry.blockListener) {
      this.attachBlockListener(entry);
      this.startHeartbeat(entry);
    }

    return () => {
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size === 0) {
        this.detachBlockListener(entry);
        this.stopHeartbeat(entry);
      }
    };
  }

  /**
   * Register a handler that fires when the manager detects a transport
   * drop for `chainId`. Fires once per drop, before reconnect begins.
   * Throws if no ChainEntry exists yet for the chain (call
   * `subscribeToLogs` or `getOrCreateProvider` first).
   */
  onDisconnect(chainId: number, handler: DisconnectHandler): Unsubscribe {
    const entry = this.chains.get(chainId);
    if (!entry) {
      throw new Error(
        `onDisconnect: no entry for chainId ${chainId}; call subscribeToLogs or getOrCreateProvider first`,
      );
    }
    entry.disconnectHandlers.add(handler);
    return () => {
      entry.disconnectHandlers.delete(handler);
    };
  }

  /**
   * True iff a provider instance has been created for `chainId`. Intended
   * for tests that need to assert the shared-provider invariant
   * (N listeners on chain X share one provider).
   */
  hasProvider(chainId: number): boolean {
    return this.chains.get(chainId)?.provider != null;
  }

  /**
   * Number of active subscribers for `chainId`. Returns 0 for an unknown
   * chain. Used by tests to assert that multiple listeners on the same
   * chain multiplex through one ChainEntry (the demux path).
   */
  subscriberCount(chainId: number): number {
    return this.chains.get(chainId)?.subscribers.size ?? 0;
  }

  /**
   * Returns true iff the manager has an active provider for `chainId`
   * and is not currently reconnecting. Deliberately asymmetric with the
   * `/healthz` endpoint's "no chains registered = 200 OK" rule: per-chain
   * `isHealthy` answers *"do I affirmatively know this chain is up"* (so
   * unknown chains return false), while `/healthz` answers *"is the
   * system degraded"* (so zero chains is not a degradation).
   */
  isHealthy(chainId: number): boolean {
    const entry = this.chains.get(chainId);
    if (!entry) {
      return false;
    }
    return entry.provider != null && !entry.isReconnecting;
  }

  getHealth(chainId: number): ChainHealth | null {
    const entry = this.chains.get(chainId);
    if (!entry) {
      return null;
    }
    return this.toHealth(entry);
  }

  getAllHealth(): ChainHealth[] {
    const out: ChainHealth[] = [];
    for (const entry of this.chains.values()) {
      out.push(this.toHealth(entry));
    }
    return out;
  }

  private toHealth(entry: ChainEntry): ChainHealth {
    return {
      chainId: entry.chainId,
      // Active URL when a provider is live, primary otherwise. Lets
      // operators see whether failover kicked in without exposing a
      // stale "active" value when nothing is connected.
      // Redacted here rather than at serialisation: every consumer of
      // getAllHealth() then gets the safe value, and a future caller cannot
      // reach a credential by reading the field directly.
      wssUrl: redactRpcUrl(entry.activeWssUrl ?? entry.wssUrl) ?? "[redacted]",
      fallbackWssUrl: redactRpcUrl(entry.fallbackWssUrl),
      connected: entry.provider != null && !entry.isReconnecting,
      reconnecting: entry.isReconnecting,
      lastBlockAt: entry.lastBlockAt,
      subscriberCount: entry.subscribers.size,
      blockIntervalMs: entry.blockIntervalEwmaMs,
      blocksBehindHead:
        entry.headBlock !== null && entry.lastProcessedBlock !== null
          ? Math.max(0, entry.headBlock - entry.lastProcessedBlock)
          : null,
      getLogsCallsTotal: entry.stats.getLogsCallsTotal,
      lastCreateError: entry.lastCreateError,
    };
  }

  async destroy(): Promise<void> {
    this.isDestroyed = true;
    this.stopStatsTimer();
    // Wake every reconnect loop that is currently sleeping. The loop
    // resumes, checks `isDestroyed`, and bails via its `finally`.
    this.destroyed.resolve();
    const errors: unknown[] = [];
    for (const entry of this.chains.values()) {
      // Wait for any in-flight reconnect loop to settle before tearing
      // the entry down. The loop observes `isDestroyed` at its next
      // check and bails; `reconnectPromise` is the .catch-wrapped form
      // so it never rejects. Without this await, destroy() could
      // resolve while the loop is still running its teardown code,
      // leading to observable races in tests.
      if (entry.reconnectPromise) {
        await entry.reconnectPromise;
      }
      this.stopHeartbeat(entry);
      this.detachBlockListener(entry);
      this.detachErrorListener(entry);
      if (entry.provider) {
        try {
          await entry.provider.destroy();
        } catch (err) {
          errors.push(err);
        }
      }
      entry.subscribers.clear();
      entry.disconnectHandlers.clear();
      entry.provider = null;
      entry.activeWssUrl = null;
      entry.readyPromise = null;
    }
    this.chains.clear();
    if (errors.length > 0) {
      logger.warn(
        `[ChainProviderManager] ${errors.length} provider destroy errors: ${errors
          .map(String)
          .join("; ")}`,
      );
    }
  }

  private ensureEntry(
    chainId: number,
    wssUrl: string,
    fallbackWssUrl?: string,
  ): ChainEntry {
    const fallback = fallbackWssUrl ?? null;
    const existing = this.chains.get(chainId);
    if (existing) {
      // Identity is the (primary, fallback) tuple. Two callers must agree
      // on both; otherwise the second caller would silently inherit the
      // first caller's failover behaviour.
      if (existing.wssUrl !== wssUrl || existing.fallbackWssUrl !== fallback) {
        throw new Error(
          `chainId ${chainId} already registered with wssUrl=${redactRpcUrl(existing.wssUrl)} fallbackWssUrl=${redactRpcUrl(existing.fallbackWssUrl)}; refusing to reuse for wssUrl=${redactRpcUrl(wssUrl)} fallbackWssUrl=${redactRpcUrl(fallback)}`,
        );
      }
      return existing;
    }
    const entry: ChainEntry = {
      chainId,
      wssUrl,
      fallbackWssUrl: fallback,
      activeWssUrl: null,
      provider: null,
      readyPromise: null,
      reconnectPromise: null,
      subscribers: new Set(),
      blockListener: null,
      errorListener: null,
      heartbeatTimer: null,
      isReconnecting: false,
      lastBlockAt: null,
      blockListenerAttachedAt: null,
      lastBlockIntervalAt: null,
      blockIntervalEwmaMs: null,
      blockIntervalSamples: 0,
      blockIntervalFirstSampleAt: null,
      lastProcessedBlock: null,
      headBlock: null,
      lastRequestAt: null,
      catchUpTimer: null,
      draining: false,
      drainingTo: null,
      pendingRewindTo: null,
      consecutiveGetLogsTimeouts: 0,
      lastCreateError: null,
      disconnectHandlers: new Set(),
      stats: newChainStats(),
    };
    this.chains.set(chainId, entry);
    return entry;
  }

  /**
   * Ordered list of URLs to try at (re)connect time: primary first,
   * fallback (if configured) second. Returned fresh on every call so a
   * caller can iterate without mutating entry state.
   */
  private candidateUrls(entry: ChainEntry): string[] {
    return entry.fallbackWssUrl
      ? [entry.wssUrl, entry.fallbackWssUrl]
      : [entry.wssUrl];
  }

  /**
   * Walk the candidate URL list in order, returning the first
   * `(provider, urlUsed)` pair that satisfies factory + ready + probe.
   * On failure of one URL the partially-constructed provider is
   * destroyed best-effort before moving on, so we do not leak sockets
   * across attempts. If every URL fails, throws an aggregate error
   * containing each URL's failure message.
   */
  private async openProvider(
    entry: ChainEntry,
  ): Promise<{ provider: ethers.WebSocketProvider; urlUsed: string }> {
    const urls = this.candidateUrls(entry);
    const failures: string[] = [];
    for (const url of urls) {
      let provider: ethers.WebSocketProvider | null = null;
      try {
        provider = this.factory(url);
        // Confirm the ws upgrade actually completed. `provider.ready` in
        // ethers v6 is a synchronous boolean getter, not a Promise, so
        // awaiting it tells us nothing. `getBlockNumber()` internally
        // calls `_waitUntilReady()` which waits for socket open but
        // never rejects on socket failure - so race it against an
        // explicit ws-error listener and a connect timeout, matching
        // PR #988 in keeperhub-scheduler/block-dispatcher/chain-monitor.ts.
        const wsErrorPromise = attachConnectErrorListener(provider);
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`),
              ),
            CONNECT_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([
            provider.getBlockNumber(),
            wsErrorPromise,
            timeoutPromise,
          ]);
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
        await this.probeSubscriptionSupport(provider, entry, url);
        return { provider, urlUsed: url };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Redacted here, not at the reader. This string is stored on
        // `lastCreateError` and served in the /healthz body, logged by the
        // reconnect loop, and embedded in the stack the listener registry
        // prints - so a raw URL here leaks through every one of them.
        failures.push(`${redactRpcUrl(url)}: ${message}`);
        if (provider) {
          try {
            await provider.destroy();
          } catch {
            // Best-effort: socket may already be gone (probe failure
            // already destroys), and we are about to throw or move on.
          }
        }
      }
    }
    throw new Error(
      `chain ${entry.chainId}: all ${urls.length} WSS URL(s) failed:\n  ${failures.join("\n  ")}`,
    );
  }

  private async createProvider(
    entry: ChainEntry,
  ): Promise<ethers.WebSocketProvider> {
    const { provider, urlUsed } = await this.openProvider(entry);
    entry.provider = provider;
    entry.activeWssUrl = urlUsed;
    if (urlUsed !== entry.wssUrl) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} primary failed; running on fallback ${redactRpcUrl(urlUsed)}`,
      );
    }
    // Clear the prior failure marker now that we have a working provider.
    // Without this, a chain that recovered after a probe failure would
    // still report `lastCreateError` indefinitely.
    entry.lastCreateError = null;
    this.attachErrorListener(entry);
    // Heartbeat is subscriber-scoped (started on first subscribe, stopped
    // on last unsubscribe) to avoid wasted pings on an idle chain.
    return provider;
  }

  /**
   * Confirm the connected RPC accepts `eth_subscribe`. Once the manager
   * calls `provider.on("block", ...)`, ethers' SocketSubscriber.start()
   * fires `eth_subscribe(["newHeads"])` and stores the resulting promise
   * on a private field with no `.catch`. An RPC that rejects subscriptions
   * (-32601 method not available, common on lightweight or HTTP-only RPCs
   * accidentally pasted into the WSS column) lets the rejection escape to
   * `process.unhandledRejection`, which crashes the pod.
   *
   * Probing here moves the failure into an awaited path: the rejection
   * propagates out of `createProvider`, gets caught by `registry.add`,
   * and the listener is logged-and-skipped instead of taking down every
   * other listener in the pod.
   *
   * On success we immediately `eth_unsubscribe` so the upcoming
   * `provider.on("block", ...)` opens a fresh subscription that ethers
   * actually routes messages through. An unsubscribe failure is
   * non-fatal: the orphaned subscription is cleaned up when the provider
   * is destroyed (next reconnect or shutdown).
   */
  private async probeSubscriptionSupport(
    provider: ethers.WebSocketProvider,
    entry: ChainEntry,
    urlUsed: string,
  ): Promise<void> {
    let filterId: unknown;
    try {
      // Race the RPC call against an explicit timeout. ethers does not
      // give us an externally controllable timeout on `provider.send`,
      // and an upstream that accepts the WS handshake but never answers
      // the JSON-RPC frame would otherwise hang createProvider for the
      // life of the socket. The Node 20 native timer doesn't need clearing
      // because the race winner discards the loser's result, but we still
      // clear it explicitly so the timeout doesn't keep the event loop
      // alive after a fast probe.
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                `eth_subscribe probe timed out after ${PROBE_TIMEOUT_MS}ms`,
              ),
            ),
          PROBE_TIMEOUT_MS,
        );
      });
      try {
        filterId = await Promise.race([
          provider.send("eth_subscribe", ["newHeads"]),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `chain ${entry.chainId} (${urlUsed}): RPC does not support eth_subscribe: ${message}`,
      );
    }
    try {
      await provider.send("eth_unsubscribe", [filterId]);
    } catch (err) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} probe eth_unsubscribe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private attachBlockListener(entry: ChainEntry): void {
    if (!entry.provider) {
      throw new Error(
        `attachBlockListener: provider not initialized for chain ${entry.chainId}`,
      );
    }
    const listener = async (blockNumber: number): Promise<void> => {
      const now = Date.now();
      this.recordBlockInterval(entry, now);
      entry.lastBlockAt = now;
      if (entry.headBlock === null || blockNumber > entry.headBlock) {
        entry.headBlock = blockNumber;
      } else {
        this.rewindForReorg(entry, blockNumber);
      }
      await this.drain(entry);
    };
    entry.blockListener = listener;
    // Baseline for the block-staleness watchdog: until the first block
    // arrives, staleness is measured from attach time so a subscription that
    // never delivers a block is still caught.
    entry.blockListenerAttachedAt = Date.now();
    // A fresh connection re-measures cadence: the replacement may be a
    // different upstream, and the downtime gap is not an inter-block
    // interval. `lastProcessedBlock` deliberately does NOT reset - what is
    // owed is a property of the chain, not of the socket that was serving it.
    entry.lastBlockIntervalAt = null;
    entry.blockIntervalEwmaMs = null;
    entry.blockIntervalSamples = 0;
    entry.blockIntervalFirstSampleAt = null;
    // Per connection, like the cadence estimate above: a run of timeouts is
    // evidence about one socket, and this is a different one. `entry` is
    // shared though, so a request stranded by the old connection settles
    // after the swap and counts against the replacement. It takes a full run
    // to matter and any served range clears it.
    entry.consecutiveGetLogsTimeouts = 0;
    entry.provider.on("block", listener);
    this.startStatsTimer();
  }

  private detachBlockListener(entry: ChainEntry): void {
    entry.blockListenerAttachedAt = null;
    // The timer must not fire against a provider that is being torn down.
    // Nothing is lost by dropping it: the timer only ever schedules another
    // drain, and `lastProcessedBlock` still records exactly what is owed, so
    // whatever this connection did not serve the next one starts from.
    this.stopCatchUpTimer(entry);
    if (!(entry.provider && entry.blockListener)) {
      entry.blockListener = null;
      return;
    }
    entry.provider.off("block", entry.blockListener);
    entry.blockListener = null;
  }

  /**
   * Fold this block's arrival into the chain's inter-block interval estimate.
   * The first block after an attach establishes the baseline only - there is
   * no prior arrival on this connection to measure against.
   *
   * This drives the staleness threshold and nothing else. Dispatch does not
   * consult it, so an estimate that is wrong - or never settles - cannot
   * change which logs are fetched or when.
   */
  private recordBlockInterval(entry: ChainEntry, now: number): void {
    const previous = entry.lastBlockIntervalAt;
    entry.lastBlockIntervalAt = now;
    if (previous === null) {
      return;
    }
    const interval = now - previous;
    // A duplicate or out-of-order push can report a non-positive gap; it
    // carries no cadence information, so it is not a sample.
    if (interval <= 0) {
      return;
    }
    if (entry.blockIntervalFirstSampleAt === null) {
      entry.blockIntervalFirstSampleAt = now;
    }
    entry.blockIntervalEwmaMs =
      entry.blockIntervalEwmaMs === null
        ? interval
        : BLOCK_INTERVAL_EWMA_ALPHA * interval +
          (1 - BLOCK_INTERVAL_EWMA_ALPHA) * entry.blockIntervalEwmaMs;
    entry.blockIntervalSamples += 1;
  }

  /**
   * Whether the cadence estimate can be trusted, which needs both enough
   * samples and enough elapsed time. The time condition is what makes a burst
   * harmless: twenty messages drained out of a socket buffer are twenty
   * samples, but they cannot span a minute.
   */
  private hasSettledCadence(entry: ChainEntry): boolean {
    if (
      entry.blockIntervalEwmaMs === null ||
      entry.blockIntervalFirstSampleAt === null ||
      entry.blockIntervalSamples < BLOCK_INTERVAL_MIN_SAMPLES
    ) {
      return false;
    }
    // The span the samples cover, not the time since the first one. Measuring
    // to `Date.now()` would let silence supply the span: a burst of twenty
    // millisecond-apart samples followed by a quiet minute would read as
    // settled, and the quiet minute is exactly when the threshold it produced
    // gets used.
    const lastSampleAt = entry.lastBlockIntervalAt ?? 0;
    return (
      lastSampleAt - entry.blockIntervalFirstSampleAt >=
      BLOCK_INTERVAL_MIN_SPAN_MS
    );
  }

  /**
   * Fetch and dispatch everything owed between the high-water mark and the
   * head, subject to one request per `GETLOGS_MIN_INTERVAL_MS` per chain.
   *
   * Called on every block. On a chain slower than the interval the gap has
   * always already elapsed, so this is one immediate request per block - the
   * historical behaviour, with no threshold deciding it. On a faster chain the
   * interval has not elapsed, the head runs ahead of the mark, and the next
   * drain serves the accumulated range in one request.
   *
   * The range is contiguous from the mark, so blocks the subscription never
   * pushed are covered too, and the dedup layer absorbs anything redelivered
   * as a result.
   */
  private async drain(entry: ChainEntry): Promise<void> {
    if (
      entry.draining ||
      entry.isReconnecting ||
      this.isDestroyed ||
      !entry.provider ||
      entry.subscribers.size === 0 ||
      entry.headBlock === null
    ) {
      return;
    }

    // The first block on a chain establishes the mark rather than triggering a
    // backfill: history before the first subscriber is not owed to anyone.
    if (entry.lastProcessedBlock === null) {
      entry.lastProcessedBlock = entry.headBlock - 1;
    }

    // Apply anything a re-announcement asked for while the mark was held by a
    // drain. Taken as a minimum, not an assignment: the drain that finished
    // in the meantime may have advanced the mark past the rewind, and a
    // rewind that is already behind the mark must not push it forward.
    const pendingRewindTo = entry.pendingRewindTo;
    if (pendingRewindTo !== null) {
      entry.pendingRewindTo = null;
      entry.lastProcessedBlock = Math.min(
        entry.lastProcessedBlock,
        pendingRewindTo,
      );
    }

    const behind = entry.headBlock - entry.lastProcessedBlock;
    if (behind <= 0) {
      return;
    }
    if (behind > GETLOGS_MAX_CATCHUP_BLOCKS) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} ${behind} blocks behind head; skipping to ${entry.headBlock} without fetching logs for the gap`,
      );
      // Counted, not only logged: a chain that repeatedly falls behind and
      // skips is otherwise indistinguishable in aggregation from one keeping
      // up, and skipping is the one path here that loses events on purpose.
      entry.stats.blocksSkipped += behind - 1;
      entry.lastProcessedBlock = entry.headBlock - 1;
    }

    const waitMs =
      entry.lastRequestAt === null
        ? 0
        : GETLOGS_MIN_INTERVAL_MS - (Date.now() - entry.lastRequestAt);
    if (waitMs > 0) {
      this.armCatchUp(entry, waitMs);
      return;
    }

    const from = entry.lastProcessedBlock + 1;
    const to = Math.min(entry.headBlock, from + GETLOGS_MAX_BLOCK_SPAN - 1);

    // `draining` is held for the whole drain, dispatch included, and is
    // released only here. Nothing else clears it - a reconnect must not,
    // because releasing a drain that already has its logs and is part way
    // through dispatching them lets the replacement re-fetch the same
    // unadvanced range and dispatch those logs a second time, concurrently.
    // Dedup cannot absorb that: `isProcessed`/`markProcessed` is a
    // check-then-set with the listener's jitter sleep before the check, so
    // two concurrent dispatches of one log both see "not processed".
    // The `eth_getLogs` timeout below bounds the fetch, so a stranded request
    // cannot hold `draining`. Dispatch is not bounded, so a handler that never
    // settles still can.
    entry.draining = true;
    entry.drainingTo = to;
    try {
      entry.lastRequestAt = Date.now();
      // The mark advances only on success. A failed range stays owed, so the
      // next drain re-queries it instead of losing every event in it.
      if (await this.processBlockRange(entry, from, to)) {
        entry.lastProcessedBlock = to;
      }
    } finally {
      entry.draining = false;
      entry.drainingTo = null;
    }

    // More owed than one request could take, the head moved while the request
    // was in flight, the range failed and is still owed, or a re-announcement
    // arrived during the request. The last of those is why the mark alone is
    // not the condition: this drain just advanced it to `to`, so a rewind
    // recorded underneath it would otherwise wait for the next block - which
    // on a chain that has gone quiet may be a long way off.
    if (
      entry.headBlock !== null &&
      entry.lastProcessedBlock !== null &&
      (entry.lastProcessedBlock < entry.headBlock ||
        entry.pendingRewindTo !== null)
    ) {
      this.armCatchUp(entry, GETLOGS_MIN_INTERVAL_MS);
    }
  }

  /**
   * Re-announcement of a height already covered: the chain reorganised and
   * the logs dispatched for that height may no longer be the ones on chain.
   * Record a rewind so the next drain re-covers from there.
   *
   * Serving each height once and never again would silently drop the replaced
   * logs - a per-block loop re-fetched every push, and dedup existed to
   * suppress the duplicates that produced. Re-covering restores that, with the
   * duplicates still going to dedup and the depth bounded.
   *
   * "Covered" is the mark *or* the end of the range a drain is part way
   * through, whichever is higher. A height inside an in-flight range is not
   * owed in any useful sense: that request went out before this announcement,
   * so it carries the pre-reorg logs, and its commit moves the mark past the
   * height without anything ever fetching the replacement.
   */
  private rewindForReorg(entry: ChainEntry, blockNumber: number): void {
    const mark = entry.lastProcessedBlock;
    if (mark === null) {
      return;
    }
    const covered =
      entry.drainingTo === null ? mark : Math.max(mark, entry.drainingTo);
    if (blockNumber > covered) {
      // Nothing has requested it yet, so the next drain fetches it post-reorg
      // on its own.
      return;
    }
    const depth = covered - blockNumber + 1;
    if (depth > REORG_REWIND_MAX_BLOCKS) {
      // Counted for the same reason as `blocksSkipped`: this is the other
      // path that drops events on purpose, and a chain sitting in it - an
      // upstream announcing heights far below what has been served - would
      // otherwise be indistinguishable in aggregation from a healthy one.
      // Logged once per stats interval rather than per block, since that
      // chain re-announces on every block and the counter carries the rest.
      entry.stats.reorgRewindsRefused += 1;
      if (entry.stats.reorgRewindsRefused === 1) {
        logger.warn(
          `[ChainProviderManager] chain=${entry.chainId} block=${blockNumber} re-announced ${depth} blocks below the mark; deeper than REORG_REWIND_MAX_BLOCKS, not re-fetching`,
        );
      }
      return;
    }
    entry.stats.reorgRewinds += 1;
    entry.pendingRewindTo =
      entry.pendingRewindTo === null
        ? blockNumber - 1
        : Math.min(entry.pendingRewindTo, blockNumber - 1);
  }

  /** Schedule the next drain. Idempotent: an armed timer is left alone. */
  private armCatchUp(entry: ChainEntry, delayMs: number): void {
    if (entry.catchUpTimer || this.isDestroyed) {
      return;
    }
    entry.catchUpTimer = setTimeout(() => {
      entry.catchUpTimer = null;
      void this.drain(entry);
    }, delayMs);
  }

  private stopCatchUpTimer(entry: ChainEntry): void {
    if (entry.catchUpTimer) {
      clearTimeout(entry.catchUpTimer);
      entry.catchUpTimer = null;
    }
  }

  private attachErrorListener(entry: ChainEntry): void {
    if (!entry.provider) {
      return;
    }
    const listener = (err: Error): void => {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} provider error: ${err.message}`,
      );
      this.triggerReconnect(entry, "provider_error", err.message);
    };
    entry.errorListener = listener;
    entry.provider.on("error", listener);
  }

  private detachErrorListener(entry: ChainEntry): void {
    if (!(entry.provider && entry.errorListener)) {
      entry.errorListener = null;
      return;
    }
    entry.provider.off("error", entry.errorListener);
    entry.errorListener = null;
  }

  private startHeartbeat(entry: ChainEntry): void {
    this.stopHeartbeat(entry);
    entry.heartbeatTimer = setInterval(() => {
      void this.runHeartbeat(entry);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(entry: ChainEntry): void {
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
  }

  private async runHeartbeat(entry: ChainEntry): Promise<void> {
    if (this.isDestroyed || entry.isReconnecting || !entry.provider) {
      return;
    }
    try {
      await Promise.race([
        entry.provider.send("eth_blockNumber", []),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("heartbeat timeout")),
            HEARTBEAT_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason: DisconnectReason =
        message === "heartbeat timeout"
          ? "heartbeat_timeout"
          : "heartbeat_failure";
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} heartbeat failed: ${message}`,
      );
      this.triggerReconnect(entry, reason, message);
      return;
    }

    // The heartbeat succeeded, so the RPC is answering. That does not prove
    // the newHeads subscription is still delivering blocks - a silently
    // dropped subscription passes the heartbeat forever. Block-staleness is
    // the only signal that catches it.
    this.checkBlockStaleness(entry);
  }

  /**
   * Block-staleness threshold for one chain.
   *
   * The fixed default is slack measured in wall-clock, not in blocks: 120 s is
   * ten blocks on Ethereum but 1.2 million on a 100 ms chain, where a dead
   * subscription would go unnoticed far longer in the terms that matter. Only
   * a chain fast enough to be batching derives its own threshold, so every
   * chain dispatching per block keeps the historical value exactly and this
   * cannot introduce reconnect churn on a chain that behaves today.
   */
  private stalenessTimeoutFor(entry: ChainEntry): number {
    if (this.blockStalenessTimeoutOverrideMs !== null) {
      return this.blockStalenessTimeoutOverrideMs;
    }
    const ewma = entry.blockIntervalEwmaMs;
    if (ewma === null || !this.hasSettledCadence(entry)) {
      return BLOCK_STALENESS_TIMEOUT_MS;
    }
    // Clamped at both ends: never tighter than the floor, so no chain is
    // reconnected over an ordinary upstream hiccup, and never looser than the
    // historical default, so no chain gains slack it did not have. Both
    // bounds bind for real chains - a 100 ms chain takes the floor, a 12 s
    // chain takes the default - and the multiplier decides everything
    // between.
    return Math.min(
      BLOCK_STALENESS_TIMEOUT_MS,
      Math.max(
        BLOCK_STALENESS_FLOOR_MS,
        ewma * BLOCK_STALENESS_BLOCK_MULTIPLIER,
      ),
    );
  }

  /**
   * Reconnect a chain whose connection is answering the heartbeat but has
   * stopped delivering blocks past its staleness threshold. Runs on each
   * heartbeat tick (after a successful ping) so it inherits the heartbeat's
   * subscriber-scoped lifecycle. Measures staleness from the last delivered
   * block, or - before any block has arrived - from when the block listener
   * attached, so a subscription that never delivers is also caught.
   */
  private checkBlockStaleness(entry: ChainEntry): void {
    if (this.isDestroyed || entry.isReconnecting || !entry.provider) {
      return;
    }
    // Blocks are only expected while a subscriber (and thus a block
    // listener) is attached; an idle provider is legitimately silent.
    if (entry.subscribers.size === 0) {
      return;
    }
    // Measure from the most recent of the last delivered block and the
    // current block-listener attach time. After a reconnect, lastBlockAt
    // still holds the pre-drop timestamp, so folding in the fresh attach
    // time gives the new connection a full window to deliver its first
    // block instead of tripping again immediately. Real timestamps are
    // always > 0, so 0 means neither is set.
    const reference = Math.max(
      entry.lastBlockAt ?? 0,
      entry.blockListenerAttachedAt ?? 0,
    );
    if (reference === 0) {
      return;
    }
    const age = Date.now() - reference;
    const timeout = this.stalenessTimeoutFor(entry);
    if (age <= timeout) {
      return;
    }
    logger.warn(
      `[ChainProviderManager] chain=${entry.chainId} no block for ${age}ms while heartbeat passing; treating subscription as dead and reconnecting`,
    );
    this.triggerReconnect(
      entry,
      "block_staleness",
      `no block received for ${age}ms while heartbeat passing`,
    );
  }

  private triggerReconnect(
    entry: ChainEntry,
    reason: DisconnectReason,
    message: string,
  ): void {
    if (this.isDestroyed || entry.isReconnecting) {
      return;
    }
    entry.isReconnecting = true;
    this.stopHeartbeat(entry);
    // Disarm the pending drain. `drain` also refuses to run while
    // `isReconnecting`, so a block arriving during the backoff cannot re-arm
    // it either - the guard is on the work, not just on the timer. Nothing is
    // lost: `lastProcessedBlock` still records what is owed, and the
    // replacement connection serves it.
    this.stopCatchUpTimer(entry);

    // Publish the reconnect promise on the entry BEFORE any `await`
    // yields. `getOrCreateProvider` awaits this to avoid creating a
    // second parallel provider while the reconnect is replacing the
    // first. State is cleared inside `reconnectLoop`'s `finally` so it
    // happens synchronously with the promise settling - a follow-up
    // error on the newly-attached provider will see
    // `isReconnecting === false` by the time the prior loop has
    // resolved, rather than racing an outer `.finally`.
    // `.catch` so the stored promise never rejects: any bug surfaces
    // via the logger, not via an await that callers have to handle.
    entry.reconnectPromise = this.reconnectLoop(entry, reason, message).catch(
      (err) => {
        logger.error(
          `[ChainProviderManager] chain=${entry.chainId} reconnect loop crashed: ${String(err)}`,
        );
      },
    );
  }

  private async reconnectLoop(
    entry: ChainEntry,
    reason: DisconnectReason,
    message: string,
  ): Promise<void> {
    try {
      // Fire disconnect handlers in parallel before the backoff begins.
      // Sequential await here lets one slow handler delay reconnect
      // start by its latency; Promise.all matches the dispatchLog pattern.
      await Promise.all(
        [...entry.disconnectHandlers].map(async (handler) => {
          try {
            await handler({ chainId: entry.chainId, reason, message });
          } catch (err) {
            logger.warn(
              `[ChainProviderManager] chain=${entry.chainId} disconnect handler threw: ${String(err)}`,
            );
          }
        }),
      );

      let delay = INITIAL_RECONNECT_DELAY_MS;
      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (this.isDestroyed) {
          return;
        }
        // Race the backoff sleep against the destroy signal so the loop
        // wakes up immediately on teardown. The isDestroyed check after
        // the race handles both paths: timer elapsed (normal) or
        // destroy resolved (early).
        await Promise.race([sleep(delay), this.destroyed.promise]);
        if (this.isDestroyed) {
          return;
        }
        try {
          await this.reconnect(entry);
          logger.log(
            `[ChainProviderManager] chain=${entry.chainId} reconnected on attempt ${attempt}`,
          );
          return;
        } catch (err) {
          logger.warn(
            `[ChainProviderManager] chain=${entry.chainId} reconnect attempt ${attempt} failed: ${String(err)}`,
          );
          // Surface the most recent attempt error through /healthz so an
          // operator can see *why* the chain is stuck reconnecting, not
          // just that it is. Cleared on the next successful reconnect.
          entry.lastCreateError =
            err instanceof Error ? err.message : String(err);
          delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        }
      }

      logger.error(
        `[ChainProviderManager] chain=${entry.chainId} exhausted ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
      );
      this.onPermanentFailure(entry.chainId);
    } finally {
      // Clear synchronously with the async function's return. By the
      // time the caller awaits the stored `reconnectPromise` and
      // unblocks, `isReconnecting` is already false - no window where a
      // fresh error on the new provider gets silently dropped.
      entry.reconnectPromise = null;
      entry.isReconnecting = false;
      // Only now can a drain run. Anything owed from before the drop still is
      // - `lastProcessedBlock` survives a reconnect - so schedule the
      // catch-up here rather than inside `reconnect()`, where the flag is
      // still set. Scheduled rather than awaited: a drain dispatches to
      // handlers that may each sleep seconds of jitter, and awaiting it would
      // hold the chain reconnecting long after the socket was healthy.
      if (!this.isDestroyed && entry.provider && entry.subscribers.size > 0) {
        this.armCatchUp(entry, GETLOGS_MIN_INTERVAL_MS);
      }
    }
  }

  private async reconnect(entry: ChainEntry): Promise<void> {
    if (this.isDestroyed) {
      return;
    }
    // `draining` is deliberately left alone. A drain in flight here is
    // either waiting on `eth_getLogs` - bounded by `GETLOGS_TIMEOUT_MS`, so
    // it releases the flag on its own - or already dispatching, and forcing
    // it open there would let this replacement re-fetch and re-dispatch the
    // same logs concurrently with it. The drain also captures its provider,
    // so it cannot issue anything against the connection built below.
    // Tear down the old provider (best-effort) and unhook listeners so
    // the old provider cannot trigger another reconnect while we are
    // building the new one.
    if (entry.provider) {
      this.detachBlockListener(entry);
      this.detachErrorListener(entry);
      try {
        await entry.provider.destroy();
      } catch {
        // ignore
      }
    }
    entry.provider = null;
    entry.activeWssUrl = null;
    entry.readyPromise = null;

    if (this.isDestroyed) {
      return;
    }

    // Re-create using the same primary-then-fallback walk as
    // createProvider. Each (re)connect tries primary first so a primary
    // that recovers is preferred. Any throw here propagates to the loop
    // which handles backoff.
    const { provider, urlUsed } = await this.openProvider(entry);

    // Destroy may have run while we were waiting for `ready` / probe. If
    // so, the entry we are about to populate is no longer in
    // `this.chains` and attaching listeners would leak a provider that
    // never gets destroyed by the second pass.
    if (this.isDestroyed) {
      try {
        await provider.destroy();
      } catch {
        // ignore
      }
      return;
    }

    entry.provider = provider;
    entry.activeWssUrl = urlUsed;
    if (urlUsed !== entry.wssUrl) {
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} reconnected on fallback ${redactRpcUrl(urlUsed)}`,
      );
    }
    // Successful reconnect clears any prior failure marker so /healthz
    // stops reporting a stale error on a now-healthy chain.
    entry.lastCreateError = null;

    this.attachErrorListener(entry);
    // Block listener and heartbeat only if this chain has subscribers.
    // Both are subscriber-scoped; if every subscriber unsubscribed
    // during the reconnect, the new provider stays quiet until someone
    // subscribes again.
    if (entry.subscribers.size > 0) {
      this.attachBlockListener(entry);
      this.startHeartbeat(entry);
      // The catch-up for anything owed from before the drop is armed by
      // `reconnectLoop` once `isReconnecting` clears, not here: `drain`
      // refuses to run while that flag is set, so a timer armed at this point
      // would fire into a guard and the work would be dropped.
    }
  }

  /**
   * Fetch and dispatch the logs in `[fromBlock, toBlock]`.
   *
   * Returns whether the whole range was served. A range spanning more than
   * `GETLOGS_ADDRESS_BATCH` addresses takes several requests, and a failure in
   * any of them means the range is incomplete - so nothing from it is
   * dispatched and the caller leaves the high-water mark where it was, which
   * makes the next drain re-query it. Dispatching the chunks that did return
   * would deliver a partial view of the range and then never fetch the rest.
   */
  private async processBlockRange(
    entry: ChainEntry,
    fromBlock: number,
    toBlock: number,
  ): Promise<boolean> {
    const subscribers = [...entry.subscribers];
    // Captured once. A multi-chunk range spans several awaits, and
    // `entry.provider` can be replaced (or nulled) by a reconnect during
    // any of them - re-reading it would issue the remaining chunks against
    // a connection this range does not belong to, or throw a TypeError that
    // the catch below would report as an ordinary getLogs failure.
    const provider = entry.provider;
    if (subscribers.length === 0 || !provider) {
      return false;
    }

    const { addresses, topic0s } = this.collectFilter(subscribers);
    const fromHex = `0x${fromBlock.toString(16)}`;
    const toHex = `0x${toBlock.toString(16)}`;
    try {
      const logs: ethers.Log[] = [];
      for (let i = 0; i < addresses.length; i += GETLOGS_ADDRESS_BATCH) {
        // A reconnect between chunks means this range is being served by a
        // socket that is already gone. Stop rather than bill more requests
        // against it; the mark has not moved, so the range is still owed.
        if (entry.provider !== provider) {
          return false;
        }
        const chunk = addresses.slice(i, i + GETLOGS_ADDRESS_BATCH);
        // Counted at the call rather than the range: one range over more
        // than GETLOGS_ADDRESS_BATCH addresses is still several requests,
        // and requests are the quantity the provider bills.
        entry.stats.getLogsCalls += 1;
        entry.stats.getLogsCallsTotal += 1;
        // Raced against an explicit timeout for the same reason as the
        // probe in `probeSubscriptionSupport`: ethers gives no externally
        // controllable timeout on `provider.send`, and a request already
        // written to a socket that is then destroyed is never settled by
        // ethers at all. This race is what guarantees a drain always
        // finishes, which is in turn what lets `draining` be owned by the
        // drain alone.
        let timeoutHandle: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () =>
              reject(
                new GetLogsTimeoutError(
                  `eth_getLogs timed out after ${GETLOGS_TIMEOUT_MS}ms`,
                ),
              ),
            GETLOGS_TIMEOUT_MS,
          );
        });
        let batch: ethers.Log[];
        try {
          batch = (await Promise.race([
            provider.send("eth_getLogs", [
              {
                fromBlock: fromHex,
                toBlock: toHex,
                address: chunk,
                topics: [topic0s],
              },
            ]),
            timeoutPromise,
          ])) as ethers.Log[];
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
        logs.push(...batch);
      }

      for (const log of logs) {
        await this.dispatchLog(entry, log);
      }
      // Counted only once every request for the range returned. A throw
      // leaves the range out of `blocksCovered` entirely, so a failing chain
      // cannot report blocks it never fetched logs for - which would make
      // the blocks-per-range ratio look most efficient exactly when the chain
      // is least working. The calls themselves are counted at issue, since a
      // request that fails was still made and still billed.
      entry.stats.ranges += 1;
      entry.stats.blocksCovered += toBlock - fromBlock + 1;
      entry.stats.logsDispatched += logs.length;
      // The connection served a range, so whatever timeouts preceded it were
      // a slow upstream rather than a socket that stopped answering.
      entry.consecutiveGetLogsTimeouts = 0;
      return true;
    } catch (err) {
      entry.stats.getLogsErrors += 1;
      const range =
        fromBlock === toBlock
          ? `block=${fromBlock}`
          : `blocks=${fromBlock}-${toBlock}`;
      logger.warn(
        `[ChainProviderManager] chain=${entry.chainId} ${range} getLogs failed, will retry: ${String(err)}`,
      );
      if (err instanceof GetLogsTimeoutError) {
        entry.consecutiveGetLogsTimeouts += 1;
        if (
          entry.consecutiveGetLogsTimeouts >=
          GETLOGS_TIMEOUT_RECONNECT_THRESHOLD
        ) {
          // Replace the socket rather than keep retrying against one that
          // has stopped serving this call. Safe to call from here: the
          // reconnect loop yields at its first await, so this drain still
          // returns and releases `draining` before any teardown runs.
          this.triggerReconnect(
            entry,
            "getlogs_timeout",
            `${entry.consecutiveGetLogsTimeouts} consecutive eth_getLogs timeouts`,
          );
        }
      } else {
        // Only an unbroken run of timeouts indicates a socket that will not
        // serve this call again; an ordinary rejection means it answered.
        entry.consecutiveGetLogsTimeouts = 0;
      }
      return false;
    }
  }

  private startStatsTimer(): void {
    if (this.statsTimer || this.isDestroyed) {
      return;
    }
    // Not unref'd, matching every other timer in this class: `destroy`
    // clears it, and `unref` is not on `setInterval`'s return type under
    // every lib configuration this package compiles against.
    this.statsTimer = setInterval(() => {
      this.logStats();
    }, STATS_LOG_INTERVAL_MS);
  }

  private stopStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  /**
   * Emit one line per chain that issued a request this interval, then reset
   * the per-interval counters. Chains that did nothing stay silent so an idle
   * tracker does not emit a line per chain per minute forever.
   */
  private logStats(): void {
    for (const entry of this.chains.values()) {
      const stats = entry.stats;
      if (
        stats.getLogsCalls === 0 &&
        stats.getLogsErrors === 0 &&
        stats.blocksSkipped === 0 &&
        stats.reorgRewindsRefused === 0
      ) {
        continue;
      }
      const interval =
        entry.blockIntervalEwmaMs === null
          ? "null"
          : String(Math.round(entry.blockIntervalEwmaMs));
      const behind =
        entry.headBlock !== null && entry.lastProcessedBlock !== null
          ? Math.max(0, entry.headBlock - entry.lastProcessedBlock)
          : 0;
      logger.log(
        `[ChainProviderManager] getlogs-stats chain=${entry.chainId} blockIntervalMs=${interval} minRequestIntervalMs=${GETLOGS_MIN_INTERVAL_MS} statsIntervalMs=${STATS_LOG_INTERVAL_MS} getLogsCalls=${stats.getLogsCalls} getLogsErrors=${stats.getLogsErrors} blocksCovered=${stats.blocksCovered} ranges=${stats.ranges} blocksSkipped=${stats.blocksSkipped} reorgRewinds=${stats.reorgRewinds} reorgRewindsRefused=${stats.reorgRewindsRefused} blocksBehindHead=${behind} logsDispatched=${stats.logsDispatched} getLogsCallsTotal=${stats.getLogsCallsTotal}`,
      );
      stats.getLogsCalls = 0;
      stats.getLogsErrors = 0;
      stats.blocksCovered = 0;
      stats.ranges = 0;
      stats.logsDispatched = 0;
      stats.blocksSkipped = 0;
      stats.reorgRewinds = 0;
      stats.reorgRewindsRefused = 0;
    }
  }

  private collectFilter(subscribers: Subscriber[]): {
    addresses: string[];
    topic0s: string[];
  } {
    const addressSet = new Set<string>();
    const topicSet = new Set<string>();
    for (const sub of subscribers) {
      addressSet.add(sub.address);
      topicSet.add(sub.topic0);
    }
    return {
      addresses: [...addressSet],
      topic0s: [...topicSet],
    };
  }

  private async dispatchLog(entry: ChainEntry, log: ethers.Log): Promise<void> {
    const logAddr = log.address?.toLowerCase();
    const logTopic0 = log.topics?.[0]?.toLowerCase();
    if (!(logAddr && logTopic0)) {
      return;
    }
    // Fire all matching handlers concurrently. Sequential `await` here would
    // let a slow handler (e.g. one applying the EventListener jitter sleep)
    // stall dispatch to every other subscriber on the same log, compounding
    // latency linearly with listener count. Each handler's errors are
    // isolated so one rejection does not abort the others.
    const matching: Subscriber[] = [];
    for (const sub of entry.subscribers) {
      if (sub.address === logAddr && sub.topic0 === logTopic0) {
        matching.push(sub);
      }
    }
    await Promise.all(
      matching.map(async (sub) => {
        try {
          await sub.handler(log);
        } catch (err) {
          logger.warn(
            `[ChainProviderManager] chain=${entry.chainId} subscriber handler threw: ${String(err)}`,
          );
        }
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const chainProviderManager = new ChainProviderManager();
